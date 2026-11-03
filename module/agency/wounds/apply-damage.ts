/**
 * Hand-off from the Apply Damage dialog (module/damage/applydamage.js, resolveInjury): when Revised
 * Fractional Health is the damage model, HP damage records wounds and fatigue-type damage costs FP by the
 * severity table, instead of subtracting points.
 */
import {
  assessWound,
  bleedInterval,
  fatigueForSeverity,
  largeAreaLocations,
  mergeShock,
  mergeStunChecks,
  severityFromInjury,
  type Assessment,
  type BleedingState,
  type Effect,
  type InjuryTolerance,
  type WoundInput,
  type WoundsState,
} from './engine.ts'
import {
  actorTraits,
  format,
  inEmergency,
  isRFH,
  localize,
  maxHP,
  readState,
  trackMinorBleeding,
  worldTime,
  writeState,
} from './config.ts'
import { applyEffectStatuses, applyShock, shockClock, syncDerived, syncPain, type ShockOutcome } from './effects.ts'
import { ownerWhisper, postCard, type CardCheck, type CardData, type CardEntry } from './chat.ts'
import { registerSocketHandler, runWith } from './socket.ts'

const K = 'GURPS.agency.wounds'

interface ApplyDamageDialogLike {
  _calculator: any
  actor: any
  close(): unknown
}

export interface InjuryHandoff {
  keepOpen: boolean
  /** The injury upstream would subtract (the sum over all damage rolls, or the raw number in the simple dialog). */
  injury: number
  publicly: boolean
  /** True when called from "Apply Injury" (the calculator's results), false from the simple dialog. */
  fromCalculator: boolean
}

function newId(): string {
  return foundry.utils.randomID()
}

function injuryToleranceFrom(calculator: any): InjuryTolerance | null {
  if (!calculator?.isInjuryTolerance) return null
  switch (calculator.injuryToleranceType) {
    case 'unliving':
      return 'unliving'
    case 'homogenous':
    case 'homogeneous':
      return 'homogeneous'
    case 'diffuse':
      return 'diffuse'
    default:
      return null
  }
}

/**
 * Injury for one damage roll under RFH. Progressive Limb Trauma replaces crippling, so the B-rules cap on
 * limb injury (no more than needed to cripple) does not apply; and RFH caps Injury Tolerance (Diffuse) at a
 * Minor wound, so the B380 cap of 1-2 HP is undone here and the wound severity is capped instead.
 */
export function rfhInjury(calculator: any): number {
  const parent = calculator._parent
  if (parent?.isInjuryTolerance && parent.injuryToleranceType === 'diffuse') {
    let injury = Math.floor(calculator.penetratingDamage * parent.totalWoundingModifier)
    const reduction = parent._damageReductionLevel
    if (reduction !== null && reduction !== undefined && reduction != 0)
      injury = Math.max(1, Math.floor(injury / reduction))
    if (injury > 0) return injury
  }
  return Number(calculator.unmodifiedPointsToApply) || 0
}

function woundInputs(calculator: any, actor: any, handoff: InjuryHandoff): WoundInput[] {
  const common = {
    maxHP: maxHP(actor),
    damageType: String(calculator.damageType ?? ''),
    emergency: inEmergency(actor),
    created: worldTime(),
    trackMinorBleeding: trackMinorBleeding(),
    areaAttack: !!calculator.isExplosion || calculator.hitLocation === 'Large-Area',
  }

  if (!handoff.fromCalculator)
    return [
      {
        ...common,
        id: newId(),
        injury: handoff.injury,
        location: String(calculator.hitLocation ?? ''),
        role: calculator.hitLocationRole,
      },
    ]

  const calculators: any[] = calculator.calculators ?? []

  // Large-area injury: the damage is applied to every hit location, each protected by its own DR.
  if (calculator.hitLocation === 'Large-Area') {
    const entries: any[] = actor.hitLocationsWithDR ?? []
    const locations = largeAreaLocations(entries.map(e => ({ where: e.where, roll: e.rollText })))
    const inputs: WoundInput[] = []
    const original = calculator.hitLocation
    try {
      for (const where of locations) {
        calculator.hitLocation = where
        const role = calculator.hitLocationRole
        for (const c of calculators)
          inputs.push({ ...common, id: newId(), injury: rfhInjury(c), location: where, role, largeArea: true })
      }
    } finally {
      calculator.hitLocation = original
    }
    return inputs
  }

  return calculators.map(c => ({
    ...common,
    id: newId(),
    injury: rfhInjury(c),
    location: String(calculator.hitLocation ?? ''),
    role: calculator.hitLocationRole,
  }))
}

/**
 * Called first thing in ApplyDamageDialog.resolveInjury. Returns true when it handled the damage
 * (upstream must then do nothing), false to let upstream subtract points as usual.
 */
export async function handleAgencyInjury(dialog: ApplyDamageDialogLike, handoff: InjuryHandoff): Promise<boolean> {
  if (!isRFH()) return false
  const calculator = dialog._calculator
  const actor = dialog.actor
  if (!calculator || !actor) return false

  const fatigue = calculator.damageType === 'fat'
  if (!fatigue && calculator.resourceType !== 'HP') return false

  const injuryTolerance = injuryToleranceFrom(calculator)
  if (fatigue) {
    const injuries = handoff.fromCalculator
      ? ((calculator.calculators ?? []) as any[]).map(c => Number(c.unmodifiedPointsToApply) || 0)
      : [handoff.injury]
    await runWith('fatigueDamage', { actorUuid: actor.uuid, injuries, publicly: handoff.publicly }, actor.isOwner)
  } else {
    const inputs = woundInputs(calculator, actor, handoff)
    await runWith(
      'recordWounds',
      { actorUuid: actor.uuid, inputs, publicly: handoff.publicly, injuryTolerance },
      actor.isOwner
    )
  }
  if (!handoff.keepOpen) dialog.close()
  return true
}

/* ------------------------------------------------------------------ */
/* Recording wounds (owner or GM)                                     */
/* ------------------------------------------------------------------ */

export function bleedingText(bleeding: BleedingState): string {
  if (bleeding.special) return localize(`${K}.bleed.${bleeding.special}`)
  if (!bleeding.severity || bleedInterval(bleeding) === null) return ''
  return localize(`${K}.bleed.every.${bleeding.severity}`)
}

function effectText(effect: Effect): string | null {
  switch (effect.type) {
    case 'dead':
      return localize(`${K}.dead.${effect.reason}`)
    case 'bleed':
      return format(`${K}.card.organBleeding`, { rate: localize(`${K}.bleed.${effect.rate}`) })
    case 'paralysis':
      return localize(`${K}.card.organParalysis`)
    default:
      return null
  }
}

function entryFor(assessment: Assessment, state: WoundsState): CardEntry {
  const details: string[] = []
  const severityLabel = assessment.severity ? localize(`${K}.severity.${assessment.severity}`) : ''
  const injury = assessment.injury ?? ''
  let text: string
  switch (assessment.skipReason) {
    case 'belowScratch':
      text = format(`${K}.card.ignored`, { location: assessment.location, injury })
      break
    case 'reducedAway':
      text = format(`${K}.card.reducedAway`, { location: assessment.location, injury })
      break
    case 'dismembered':
      text = format(`${K}.card.limbGone`, { location: assessment.location })
      break
    default:
      text = format(`${K}.card.wound`, {
        severity: severityLabel,
        location: assessment.location,
        type: assessment.damageType,
        injury,
      })
  }
  if (assessment.skipReason === 'crushingScratch' || assessment.skipReason === 'crushingMinor')
    details.push(localize(`${K}.card.${assessment.skipReason}`))
  if (assessment.largeAreaReduction && assessment.severity)
    details.push(format(`${K}.card.largeArea`, { n: assessment.largeAreaReduction }))
  if (assessment.cappedByDiffuse) details.push(localize(`${K}.card.diffuse`))
  const wound = state.wounds.find(w => w.id === assessment.id)
  if (wound) {
    const bleeding = bleedingText(wound.bleeding)
    if (bleeding) details.push(format(`${K}.card.bleeding`, { rate: bleeding }))
  }
  for (const effect of assessment.effects) {
    const t = effectText(effect)
    if (t) details.push(t)
  }
  for (const note of assessment.notes) details.push(localize(note))
  return { severity: assessment.severity, text, details }
}

function shockLine(shock: number, outcome: ShockOutcome | null): string | null {
  if (shock <= 0 || !outcome) return null
  const data = { n: shock, effective: outcome.effective }
  if (outcome.when === 'notInCombat') return format(`${K}.card.shockNoTurn`, data)
  const when = outcome.when === 'nextTurn' ? 'Next' : 'Now'
  if (outcome.effective <= 0) return format(`${K}.card.shockAbsorbed`, data)
  if (outcome.effective < shock) return format(`${K}.card.shock${when}Pain`, data)
  return format(`${K}.card.shock${when}`, data)
}

export interface RecordWoundsPayload {
  actorUuid: string
  inputs: WoundInput[]
  publicly: boolean
  injuryTolerance?: InjuryTolerance | null
}

export async function recordWoundsOp(payload: RecordWoundsPayload): Promise<void> {
  const actor: any = await fromUuid(payload.actorUuid)
  if (!actor) return
  const traits = actorTraits(actor, payload.injuryTolerance ?? undefined)
  const before = readState(actor)
  let state = before
  const assessments: Assessment[] = []
  for (const input of payload.inputs) {
    const result = assessWound(state, input, traits)
    state = result.state
    assessments.push(result.assessment)
  }

  const shock = Math.max(0, ...assessments.map(a => a.shock))
  if (shock > 0) {
    const clock = shockClock()
    state = { ...state, shock: mergeShock(state.shock, shock, clock.combatId, clock.round) }
  }

  await writeState(actor, state)
  for (const assessment of assessments) await applyEffectStatuses(actor, assessment.effects)
  await syncPain(actor, before.pain, state.pain, traits)
  await syncDerived(actor, before, state)
  const shockOutcome = shock > 0 ? await applyShock(actor, state, traits) : null

  // A large-area injury touches every location; only list the ones that did something.
  const largeArea = payload.inputs.some(i => i.largeArea)
  const shown = largeArea ? assessments.filter(a => a.severity) : assessments
  const lines: string[] = []
  if (largeArea && shown.length < assessments.length)
    lines.push(format(`${K}.card.largeAreaUnhurt`, { n: assessments.length - shown.length }))
  const shockText = shockLine(state.shock?.amount ?? shock, shockOutcome)
  if (shockText) lines.push(shockText)

  const checks: CardCheck[] = mergeStunChecks(assessments.flatMap(a => a.checks)).map(c => ({
    ...c,
    source: 'wound' as const,
  }))

  const card: CardData = {
    actorUuid: actor.uuid,
    actorName: actor.name,
    title: localize(`${K}.card.woundTitle`),
    entries: shown.map(a => entryFor(a, state)),
    lines,
    checks,
    results: [],
    whisper: payload.publicly ? null : ownerWhisper(actor),
    injuryTolerance: payload.injuryTolerance ?? null,
  }
  await postCard(actor, card)
}

export async function fatigueDamageOp(payload: {
  actorUuid: string
  injuries: number[]
  publicly: boolean
}): Promise<void> {
  const actor: any = await fromUuid(payload.actorUuid)
  if (!actor) return
  const hp = maxHP(actor)
  let total = 0
  const entries: CardEntry[] = payload.injuries.map(injury => {
    const severity = severityFromInjury(injury, hp)
    const fp = fatigueForSeverity(severity)
    total += fp
    return {
      severity,
      text: format(`${K}.card.fatigueHit`, {
        severity: severity ? localize(`${K}.severity.${severity}`) : localize(`${K}.card.none`),
        injury,
        fp,
      }),
      details: [],
    }
  })
  if (total > 0) await actor.update({ 'system.FP.value': Number(actor.system.FP.value) - total })
  await postCard(actor, {
    actorUuid: actor.uuid,
    actorName: actor.name,
    title: localize(`${K}.card.fatigueTitle`),
    entries,
    lines: [format(`${K}.card.fatigueTotal`, { fp: total })],
    checks: [],
    results: [],
    whisper: payload.publicly ? null : ownerWhisper(actor),
    injuryTolerance: null,
  })
}

export function registerDamageHandlers(): void {
  registerSocketHandler('recordWounds', recordWoundsOp)
  registerSocketHandler('fatigueDamage', fatigueDamageOp)
}
