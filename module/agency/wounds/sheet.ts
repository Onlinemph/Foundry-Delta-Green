/**
 * The wounds panel on actor sheets (templates/agency/wounds-panel.hbs), the worst-wound summary that
 * replaces the HP tracker on the Full (GCS) sheet (templates/agency/wounds-summary.hbs), and the panel's
 * buttons. The data comes from the `agencyWounds` Handlebars helper, so the sheets' getData() is untouched.
 */
import {
  SEVERITIES,
  activePain,
  applyRecovery,
  applyTreatment,
  atLeast,
  bleedingModifiers,
  bloodRecovery,
  canRollBleeding,
  canTreat,
  classifyLocation,
  deriveStatus,
  emptyState,
  hasHighPainThreshold,
  isLimbOrExtremity,
  isSeverity,
  limbTraumaCount,
  lingeringPain,
  mergePain,
  newWoundRecord,
  painMagnitude,
  recoveryModifiers,
  removeWound,
  resolveBleedingCheck,
  resolveRoll,
  setLimb,
  severityThresholds,
  sumModifiers,
  treatmentPenalty,
  upsertWound,
  type Modifier,
  type Severity,
  type SpecialBleed,
  type Treatment,
  type WoundRecord,
  type WoundsState,
} from './engine.ts'
import {
  FLAG_KEY,
  actorTraits,
  format,
  htOf,
  inEmergency,
  isRFH,
  localize,
  maxHP,
  readState,
  signed,
  trackMinorBleeding,
  worldTime,
} from './config.ts'
import { clearPainStatuses, currentShock, syncDerived, syncPain } from './effects.ts'
import { bleedingText, recordWoundsOp } from './apply-damage.ts'
import { createRollMessage, escapeHTML, postRollMessage, roll3d6 } from './chat.ts'

const K = 'GURPS.agency.wounds'
const DAMAGE_TYPES = ['cut', 'imp', 'pi-', 'pi', 'pi+', 'pi++', 'cr', 'burn', 'cor', 'tox', 'bite', 'dmg']

/* ------------------------------------------------------------------ */
/* View model                                                         */
/* ------------------------------------------------------------------ */

function actorFrom(context: any): any | null {
  if (!context) return null
  if (context.documentName === 'Actor') return context
  return context.actor ?? context.document ?? context.data?.root?.actor ?? null
}

function severityLabel(severity: Severity | null): string {
  return severity ? localize(`${K}.severity.${severity}`) : ''
}

function painLabel(level: string, hpt: boolean): string {
  const magnitude = painMagnitude(level as any, hpt)
  const name = localize(`${K}.pain.${level}`)
  return Number.isFinite(magnitude) ? `${name} (−${magnitude})` : name
}

function remainingText(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return localize(`${K}.panel.untilCleared`)
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60))
  return format(`${K}.panel.minutesLeft`, { minutes })
}

function woundRow(wound: WoundRecord) {
  const flags: string[] = []
  if (wound.severity !== wound.originalSeverity)
    flags.push(format(`${K}.panel.was`, { severity: severityLabel(wound.originalSeverity) }))
  if (wound.bandaged) flags.push(localize(`${K}.panel.bandaged`))
  else if (wound.bandageAttempted) flags.push(localize(`${K}.panel.bandageFailed`))
  if (wound.stabilized) flags.push(localize(`${K}.panel.stabilized`))
  if (wound.limbPenalty) flags.push(localize(`${K}.panel.limbPenalty`))
  if (wound.paralysis) flags.push(localize(`${K}.panel.paralysis`))
  if (wound.note) flags.push(wound.note)
  const bleeding = bleedingText(wound.bleeding)
  return {
    id: wound.id,
    severity: wound.severity,
    severityLabel: severityLabel(wound.severity),
    location: wound.location,
    damageType: wound.damageType,
    injury: wound.injury,
    flags,
    bleedingText: bleeding || '—',
    bleeding: !!bleeding,
    canBleed: canRollBleeding(wound.bleeding),
    canBandage: canTreat(wound, 'bandage'),
    canStabilize: canTreat(wound, 'stabilize'),
    canSurgery: canTreat(wound, 'surgery'),
  }
}

function limbRows(state: WoundsState, penalties: Record<string, number>) {
  const keys = new Set<string>(state.limbs.filter(l => l.crippled || l.dismembered).map(l => l.key))
  for (const w of state.wounds) if (w.limbKey && atLeast(w.severity, 'major')) keys.add(w.limbKey)
  return [...keys].map(key => {
    const limb = state.limbs.find(l => l.key === key)
    const trauma = limbTraumaCount(state, key)
    const status = limb?.dismembered
      ? localize(`${K}.limb.dismembered`)
      : limb?.crippled
        ? localize(`${K}.limb.crippled`)
        : localize(`${K}.limb.functional`)
    return {
      key,
      status,
      crippled: !!limb?.crippled,
      dismembered: !!limb?.dismembered,
      penalty: penalties[key] ? format(`${K}.limb.penalty`, { n: penalties[key] }) : '',
      trauma: trauma ? format(`${K}.limb.trauma`, { n: trauma }) : '',
    }
  })
}

/** Everything the panel and the summary need. Exposed as the `agencyWounds` Handlebars helper. */
export function woundsView(context: any): Record<string, unknown> {
  const actor = actorFrom(context)
  if (!isRFH() || !actor) return { enabled: false }
  const state = readState(actor)
  const now = worldTime()
  const derived = deriveStatus(state, now)
  const traits = actorTraits(actor)
  const hpt = hasHighPainThreshold(traits)
  const hp = maxHP(actor)
  const shock = currentShock(actor)
  const pain = derived.pain
  const summaryParts: string[] = []
  if (derived.count) summaryParts.push(format(`${K}.summary.count`, { n: derived.count }))
  if (pain) summaryParts.push(painLabel(pain.level, hpt))
  if (derived.bleeding) summaryParts.push(localize(`${K}.summary.bleeding`))
  return {
    enabled: true,
    actorUuid: actor.uuid,
    isGM: !!(game as any).user?.isGM,
    canAct: !!actor.isOwner,
    worst: derived.worst ? { key: derived.worst, label: severityLabel(derived.worst) } : null,
    worstKey: derived.worst ?? 'none',
    worstLabel: derived.worst ? severityLabel(derived.worst) : localize(`${K}.summary.unhurt`),
    summaryText: summaryParts.join(' · '),
    maxHP: hp,
    hpPoints: actor.system?.HP?.points ?? '',
    thresholds: severityThresholds(hp).map(t => ({ injury: t.injury, label: severityLabel(t.severity) })),
    count: derived.count,
    wounds: state.wounds.map(woundRow),
    limbs: limbRows(state, derived.limbPenalties),
    pain: pain ? { label: painLabel(pain.level, hpt), title: remainingText(pain.expiresAt, now) } : null,
    shock: shock ? format(`${K}.panel.shock`, { n: shock }) : null,
    halfMove: derived.halfMoveDodge,
    gawdawful: derived.gawdawful ? format(`${K}.panel.gawdawful`, { n: derived.gawdawful }) : null,
    bleedingFP: state.bleedingFP,
    bleedingFPText: state.bleedingFP ? format(`${K}.panel.bleedingFP`, { n: state.bleedingFP }) : '',
  }
}

export function registerHelpers(): void {
  Handlebars.registerHelper('agencyWounds', (context: any) => woundsView(context))
  Handlebars.registerHelper('agencyRfh', () => isRFH())
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                            */
/* ------------------------------------------------------------------ */

async function prompt<T>(title: string, content: string, read: (form: HTMLFormElement) => T): Promise<T | null> {
  try {
    const result = await (foundry.applications.api.DialogV2 as any).prompt({
      window: { title },
      content,
      rejectClose: false,
      ok: {
        label: localize(`${K}.dialog.ok`),
        callback: (_event: Event, button: HTMLButtonElement) => read(button.form as HTMLFormElement),
      },
    })
    return (result ?? null) as T | null
  } catch {
    return null
  }
}

async function confirm(title: string, content: string): Promise<boolean> {
  try {
    return !!(await (foundry.applications.api.DialogV2 as any).confirm({
      window: { title },
      content,
      rejectClose: false,
    }))
  } catch {
    return false
  }
}

function field(form: HTMLFormElement, name: string): any {
  return form.elements.namedItem(name) as any
}

function options(values: readonly string[], selected: string, label: (v: string) => string): string {
  return values
    .map(v => `<option value="${escapeHTML(v)}"${v === selected ? ' selected' : ''}>${escapeHTML(label(v))}</option>`)
    .join('')
}

/* ------------------------------------------------------------------ */
/* Panel actions                                                      */
/* ------------------------------------------------------------------ */

function modifierText(ht: number, modifiers: Modifier[]): string {
  const parts = [`${localize('GURPS.attributesHT')} ${ht}`]
  for (const m of modifiers) parts.push(`${signed(m.value)} ${localize(m.label)}`)
  return `${parts.join(' ')} = ${ht + sumModifiers(modifiers)}`
}

async function commit(actor: any, before: WoundsState, after: WoundsState, extra: Record<string, unknown> = {}) {
  await actor.update({ [`flags.gurps.${FLAG_KEY}`]: after, ...extra })
  await syncDerived(actor, before, after)
}

async function bleedingCheck(actor: any, woundId: string): Promise<void> {
  const before = readState(actor)
  const wound = before.wounds.find(w => w.id === woundId)
  if (!wound || !canRollBleeding(wound.bleeding) || !wound.bleeding.severity) return
  const traits = actorTraits(actor)
  const ht = htOf(actor)
  const modifiers = bleedingModifiers(wound.bleeding.severity, traits)
  const roll = await roll3d6()
  const result = resolveBleedingCheck(wound.bleeding, roll.total, ht + sumModifiers(modifiers), {
    trackMinor: trackMinorBleeding(),
    hemophilia: traits.hemophilia,
  })
  const after = upsertWound(before, { ...wound, bleeding: result.bleeding })
  after.bleedingFP += result.fpLost
  const extra = result.fpLost ? { 'system.FP.value': Number(actor.system?.FP?.value) - result.fpLost } : {}
  await commit(actor, before, after, extra)
  const outcome = result.stopped
    ? localize(`${K}.bleed.stopped`)
    : result.slowed
      ? format(`${K}.bleed.slowed`, { severity: severityLabel(result.bleeding.severity) })
      : result.fpLost
        ? localize(`${K}.bleed.lost`)
        : localize(`${K}.bleed.held`)
  await postRollMessage(
    actor,
    roll,
    format(`${K}.bleed.check`, { location: wound.location }),
    `${modifierText(ht, modifiers)} — ${outcome}`,
    result.roll,
    null
  )
}

/** Prefill the healer's skill: a selected token or the last actor used (other than the patient), else the patient. */
function healerSkill(patient: any, skill: string): number {
  const others = [(canvas as any)?.tokens?.controlled?.[0]?.actor, (globalThis as any).GURPS?.LastActor].filter(
    a => !!a && a !== patient
  )
  for (const actor of [...others, patient]) {
    const level = Number(actor?.findSkill?.(skill)?.level)
    if (Number.isFinite(level) && level > 0) return level
  }
  return 10
}

async function treat(actor: any, woundId: string, treatment: Treatment): Promise<void> {
  const before = readState(actor)
  const wound = before.wounds.find(w => w.id === woundId)
  if (!wound || !canTreat(wound, treatment)) return
  const skillName = treatment === 'surgery' ? 'Surgery' : 'First Aid'
  const penalty = treatmentPenalty(wound.severity)
  const skill = await prompt(
    localize(`${K}.treat.${treatment}`),
    `<p>${escapeHTML(format(`${K}.treat.help.${treatment}`, { location: wound.location }))}</p>
     <div class="form-group"><label>${escapeHTML(format(`${K}.treat.skill`, { skill: skillName }))}</label>
     <input type="number" name="skill" value="${healerSkill(actor, skillName)}" autofocus></div>
     ${penalty ? `<p>${escapeHTML(format(`${K}.treat.penalty`, { penalty: signed(penalty), severity: severityLabel(wound.severity) }))}</p>` : ''}`,
    form => Number(field(form, 'skill')?.value)
  )
  if (skill === null || !Number.isFinite(skill)) return
  const roll = await roll3d6()
  const outcome = resolveRoll(roll.total, skill + penalty)
  const treated = applyTreatment(wound, treatment, outcome.success, {
    trackMinor: trackMinorBleeding(),
    hemophilia: actorTraits(actor).hemophilia,
  })
  const after = upsertWound(before, treated)
  await commit(actor, before, after)
  const text = outcome.success ? localize(`${K}.treat.done.${treatment}`) : localize(`${K}.treat.failed`)
  await postRollMessage(
    actor,
    roll,
    format(`${K}.treat.label.${treatment}`, { location: wound.location }),
    `${skillName} ${skill}${penalty ? ` ${signed(penalty)}` : ''} = ${skill + penalty} — ${text}`,
    outcome,
    null
  )
}

async function weeklyRecovery(actor: any): Promise<void> {
  const before = readState(actor)
  if (!before.wounds.length) return
  const traits = actorTraits(actor)
  const choice = await prompt(
    localize(`${K}.recovery.title`),
    `<p>${escapeHTML(localize(`${K}.recovery.help`))}</p>
     <div class="form-group"><label><input type="checkbox" name="noRest"> ${escapeHTML(localize(`${K}.mod.noRest`))} (−4)</label></div>
     <div class="form-group"><label><input type="checkbox" name="underCare"> ${escapeHTML(localize(`${K}.mod.underCare`))} (+1)</label></div>
     ${traits.rapidHealing ? `<p>${escapeHTML(localize(`${K}.mod.rapidHealing`))} (+5)</p>` : ''}`,
    form => ({ noRest: !!field(form, 'noRest')?.checked, underCare: !!field(form, 'underCare')?.checked })
  )
  if (!choice) return
  const modifiers = recoveryModifiers({ ...choice, rapidHealing: traits.rapidHealing })
  const ht = htOf(actor)
  const target = ht + sumModifiers(modifiers)
  const rolls: any[] = []
  const results: { woundId: string; success: boolean }[] = []
  const rows: string[] = []
  for (const wound of before.wounds) {
    const roll = await roll3d6()
    rolls.push(roll)
    const outcome = resolveRoll(roll.total, target)
    results.push({ woundId: wound.id, success: outcome.success })
    const lower = SEVERITIES[SEVERITIES.indexOf(wound.severity) - 1]
    const text = outcome.success
      ? lower
        ? format(`${K}.recovery.improved`, { severity: severityLabel(lower) })
        : localize(`${K}.recovery.healed`)
      : localize(`${K}.recovery.unchanged`)
    rows.push(
      `<tr><td>${escapeHTML(severityLabel(wound.severity))}, ${escapeHTML(wound.location)}</td><td>${roll.total}</td><td class="${
        outcome.success ? 'success' : 'failure'
      }">${escapeHTML(text)}</td></tr>`
    )
  }
  const { state: after } = applyRecovery(before, results)
  await commit(actor, before, after)
  await syncPain(actor, before.pain, after.pain, traits)
  await createRollMessage(
    actor,
    rolls,
    `<div class="agency-chat-card agency-wounds-card">
      <header class="agency-chat-card-header"><strong>${escapeHTML(actor.name)}</strong> ${escapeHTML(localize(`${K}.recovery.title`))}</header>
      <div class="agency-wounds-target">${escapeHTML(modifierText(ht, modifiers))}</div>
      <table class="agency-table">${rows.join('')}</table></div>`,
    null
  )
}

async function bloodRecoveryAction(actor: any): Promise<void> {
  const before = readState(actor)
  if (before.bleedingFP <= 0) return
  const traits = actorTraits(actor)
  const modifiers: Modifier[] = traits.rapidHealing ? [{ value: 5, label: `${K}.mod.rapidHealing` }] : []
  const ht = htOf(actor)
  const roll = await roll3d6()
  const outcome = resolveRoll(roll.total, ht + sumModifiers(modifiers))
  const recovered = bloodRecovery(outcome, before.bleedingFP)
  const after: WoundsState = { ...before, bleedingFP: before.bleedingFP - recovered }
  const fp = actor.system?.FP
  const extra = recovered ? { 'system.FP.value': Math.min(Number(fp?.max), Number(fp?.value) + recovered) } : {}
  await commit(actor, before, after, extra)
  await postRollMessage(
    actor,
    roll,
    localize(`${K}.blood.title`),
    `${modifierText(ht, modifiers)} — ${format(`${K}.blood.recovered`, { n: recovered })}`,
    outcome,
    null
  )
}

/* ------------------------------------------------------------------ */
/* GM actions                                                         */
/* ------------------------------------------------------------------ */

function hitLocationNames(actor: any): string[] {
  const names = Object.values(actor.system?.hitlocations ?? {}).map((l: any) => String(l.where ?? ''))
  return [...new Set(names.filter(n => !!n))]
}

function roleFor(actor: any, where: string): string | null {
  return actor._hitLocationRolls?.[where]?.role ?? null
}

async function woundDialog(actor: any, wound: WoundRecord | null): Promise<Record<string, any> | null> {
  const locations = hitLocationNames(actor)
  const severities = SEVERITIES.filter(s => s !== 'destroyed')
  const bleedOptions = ['', ...severities]
  const specials = ['', '1fp-per-second', '2fp-per-second']
  const w = wound
  const checkbox = (name: string, checked: boolean, label: string) =>
    `<div class="form-group"><label><input type="checkbox" name="${name}"${checked ? ' checked' : ''}> ${escapeHTML(localize(label))}</label></div>`
  const content = `
    <div class="form-group"><label>${escapeHTML(localize(`${K}.edit.severity`))}</label>
      <select name="severity">${options(severities, w?.severity ?? 'moderate', v => severityLabel(v as Severity))}</select></div>
    <div class="form-group"><label>${escapeHTML(localize(`${K}.edit.location`))}</label>
      <input type="text" name="location" list="agency-wounds-locations" value="${escapeHTML(w?.location ?? 'Torso')}">
      <datalist id="agency-wounds-locations">${options(locations, '', v => v)}</datalist></div>
    <div class="form-group"><label>${escapeHTML(localize(`${K}.edit.damageType`))}</label>
      <select name="damageType">${options(DAMAGE_TYPES, w?.damageType ?? 'cut', v => v)}</select></div>
    ${
      w
        ? `<div class="form-group"><label>${escapeHTML(localize(`${K}.edit.bleeding`))}</label>
            <select name="bleeding">${options(bleedOptions, w.bleeding.severity ?? '', v => (v ? severityLabel(v as Severity) : localize(`${K}.edit.none`)))}</select></div>
           <div class="form-group"><label>${escapeHTML(localize(`${K}.edit.special`))}</label>
            <select name="special">${options(specials, w.bleeding.special ?? '', v => (v ? localize(`${K}.bleed.${v}`) : localize(`${K}.edit.none`)))}</select></div>
           ${checkbox('bandaged', w.bandaged, `${K}.panel.bandaged`)}
           ${checkbox('stabilized', w.stabilized, `${K}.panel.stabilized`)}
           ${checkbox('limbPenalty', w.limbPenalty, `${K}.panel.limbPenalty`)}
           ${checkbox('paralysis', w.paralysis, `${K}.panel.paralysis`)}
           <div class="form-group"><label>${escapeHTML(localize(`${K}.edit.note`))}</label>
            <input type="text" name="note" value="${escapeHTML(w.note)}"></div>`
        : checkbox('consequences', true, `${K}.edit.consequences`)
    }`
  return prompt(localize(w ? `${K}.edit.title` : `${K}.edit.addTitle`), content, form => {
    const read = (name: string) => field(form, name)
    return {
      severity: read('severity')?.value,
      location: String(read('location')?.value ?? '').trim(),
      damageType: read('damageType')?.value,
      bleeding: read('bleeding')?.value,
      special: read('special')?.value,
      bandaged: !!read('bandaged')?.checked,
      stabilized: !!read('stabilized')?.checked,
      limbPenalty: !!read('limbPenalty')?.checked,
      paralysis: !!read('paralysis')?.checked,
      note: String(read('note')?.value ?? ''),
      consequences: !!read('consequences')?.checked,
    }
  })
}

async function addWound(actor: any): Promise<void> {
  const data = await woundDialog(actor, null)
  if (!data || !isSeverity(data.severity) || !data.location) return
  const input = {
    id: foundry.utils.randomID(),
    injury: null,
    severity: data.severity as Severity,
    maxHP: maxHP(actor),
    location: data.location,
    role: roleFor(actor, data.location),
    damageType: data.damageType,
    emergency: inEmergency(actor),
    created: worldTime(),
    trackMinorBleeding: trackMinorBleeding(),
  }
  if (data.consequences) {
    await recordWoundsOp({ actorUuid: actor.uuid, inputs: [input], publicly: false })
    return
  }
  const before = readState(actor)
  await commit(actor, before, upsertWound(before, newWoundRecord(input, input.severity, actorTraits(actor))))
}

async function editWound(actor: any, woundId: string): Promise<void> {
  const before = readState(actor)
  const wound = before.wounds.find(w => w.id === woundId)
  if (!wound) return
  const data = await woundDialog(actor, wound)
  if (!data || !isSeverity(data.severity)) return
  const location = data.location || wound.location
  const info = classifyLocation(location, roleFor(actor, location))
  const updated: WoundRecord = {
    ...wound,
    severity: data.severity,
    location,
    category: info.category,
    limbKey: info.limbKey,
    leg: info.leg,
    damageType: data.damageType || wound.damageType,
    bleeding: {
      ...wound.bleeding,
      severity: isSeverity(data.bleeding) ? data.bleeding : null,
      special: (data.special || null) as SpecialBleed | null,
    },
    bandaged: data.bandaged,
    bandageAttempted: wound.bandageAttempted || data.bandaged,
    stabilized: data.stabilized,
    stabilizeAttempted: wound.stabilizeAttempted || data.stabilized,
    limbPenalty: data.limbPenalty,
    paralysis: data.paralysis,
    note: data.note,
  }
  await commit(actor, before, upsertWound(before, updated))
}

async function deleteWound(actor: any, woundId: string): Promise<void> {
  const before = readState(actor)
  const wound = before.wounds.find(w => w.id === woundId)
  if (!wound) return
  const ok = await confirm(
    localize(`${K}.edit.removeTitle`),
    `<p>${escapeHTML(format(`${K}.edit.removeConfirm`, { severity: severityLabel(wound.severity), location: wound.location }))}</p>`
  )
  if (ok) await commit(actor, before, removeWound(before, woundId))
}

async function limbDialog(actor: any, key?: string): Promise<void> {
  const before = readState(actor)
  const limbs = hitLocationNames(actor)
    .map(where => classifyLocation(where, roleFor(actor, where)))
    .filter(info => isLimbOrExtremity(info) && info.limbKey)
  const keys = [...new Set([...limbs.map(l => l.limbKey as string), ...before.limbs.map(l => l.key)])]
  if (!keys.length) return
  const current = key ?? keys[0]
  const limb = before.limbs.find(l => l.key === current)
  const data = await prompt(
    localize(`${K}.limb.title`),
    `<div class="form-group"><label>${escapeHTML(localize(`${K}.limb.limb`))}</label>
       <select name="key">${options(keys, current, v => v)}</select></div>
     <div class="form-group"><label><input type="checkbox" name="crippled"${limb?.crippled ? ' checked' : ''}> ${escapeHTML(localize(`${K}.limb.crippled`))}</label></div>
     <div class="form-group"><label><input type="checkbox" name="dismembered"${limb?.dismembered ? ' checked' : ''}> ${escapeHTML(localize(`${K}.limb.dismembered`))}</label></div>`,
    form => ({
      key: String(field(form, 'key')?.value ?? ''),
      crippled: !!field(form, 'crippled')?.checked,
      dismembered: !!field(form, 'dismembered')?.checked,
    })
  )
  if (!data?.key) return
  const leg = limbs.find(l => l.limbKey === data.key)?.leg ?? before.limbs.find(l => l.key === data.key)?.leg ?? false
  let after = setLimb(before, data.key, {
    crippled: data.crippled || data.dismembered,
    dismembered: data.dismembered,
    leg,
  })
  if (!data.crippled && !data.dismembered) after = { ...after, limbs: after.limbs.filter(l => l.key !== data.key) }
  await commit(actor, before, after)
}

async function clearPain(actor: any): Promise<void> {
  const before = readState(actor)
  if (!before.pain) return
  const after = { ...before, pain: null }
  await commit(actor, before, after)
  await clearPainStatuses(actor, before.pain, actorTraits(actor))
}

async function adrenalineWearsOff(actor: any): Promise<void> {
  const before = readState(actor)
  const pain = lingeringPain(before)
  if (!pain) {
    ui.notifications?.info(localize(`${K}.panel.noLingeringPain`))
    return
  }
  const after = { ...before, pain: mergePain(activePain(before, worldTime()), pain, worldTime()) }
  await commit(actor, before, after)
  const traits = actorTraits(actor)
  await syncPain(actor, before.pain, after.pain, traits)
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="agency-chat-card agency-wounds-card">${escapeHTML(
      format(`${K}.panel.adrenalineChat`, {
        name: actor.name,
        pain: painLabel(pain.level, hasHighPainThreshold(traits)),
      })
    )}</div>`,
  } as any)
}

async function resetAll(actor: any): Promise<void> {
  const ok = await confirm(localize(`${K}.edit.resetTitle`), `<p>${escapeHTML(localize(`${K}.edit.resetConfirm`))}</p>`)
  if (!ok) return
  const before = readState(actor)
  await clearPainStatuses(actor, before.pain, actorTraits(actor))
  await commit(actor, before, emptyState())
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

async function runPanelAction(actor: any, action: string, woundId: string, dataset: DOMStringMap): Promise<void> {
  const gm = !!(game as any).user?.isGM
  if (!actor?.isOwner) return
  switch (action) {
    case 'bleed':
      return bleedingCheck(actor, woundId)
    case 'bandage':
    case 'stabilize':
    case 'surgery':
      return treat(actor, woundId, action)
    case 'recovery':
      return weeklyRecovery(actor)
    case 'blood':
      return bloodRecoveryAction(actor)
  }
  if (!gm) return
  switch (action) {
    case 'add':
      return addWound(actor)
    case 'edit':
      return editWound(actor, woundId)
    case 'remove':
      return deleteWound(actor, woundId)
    case 'limb':
      return limbDialog(actor, dataset.limb)
    case 'clear-pain':
      return clearPain(actor)
    case 'adrenaline':
      return adrenalineWearsOff(actor)
    case 'reset':
      return resetAll(actor)
  }
}

export function onRenderActorSheet(app: any, html: any): void {
  if (!isRFH()) return
  // AppV1 sheets pass jQuery; AppV2 would pass an HTMLElement.
  const root: HTMLElement | undefined = typeof html?.querySelectorAll === 'function' ? html : html?.[0]
  const actor = app?.actor
  if (!root || !actor) return
  root.querySelectorAll<HTMLElement>('[data-agency-wounds-panel] [data-wounds-action]').forEach(element => {
    element.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const woundId = element.closest<HTMLElement>('[data-wound-id]')?.dataset.woundId ?? ''
      void runPanelAction(actor, element.dataset.woundsAction ?? '', woundId, element.dataset)
    })
  })
}
