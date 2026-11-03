/**
 * Upstream's Apply Damage dialog (module/damage/applydamage.js) with GUHL hit locations.
 *
 * Two AGENCY hooks in the dialog call in here:
 * - configureDialog(dialog, damageData), from the constructor: a damage entry from the hit card
 *   carries its resolved hit (entry.agencyHit); any other entry with a known location name (or the
 *   default Torso) is resolved on the GUHL tables now, sub-table included.
 * - randomizeHitLocation(dialog), from _randomizeHitLocation: a Random location (upstream's default
 *   setting, or the dialog's Random button) rolls the GUHL main table instead of the actor's table.
 *   Returns false for body plans GUHL doesn't cover, and upstream rolls as usual.
 *
 * The result goes on the calculator: hitLocation, additionalWoundModifier (GUHL minus upstream),
 * userEnteredDR (extra DR, chinks, armor gaps), agencyInjuryCap, agencyCripplingThreshold, and
 * agencyHitLocation (the detail other features read; see AgencyHitLocation).
 */
import { gmIds, playerOwnerIds, renderTemplate, unique } from '../defense/foundry-helpers.ts'
import { mapToBody } from './body.ts'
import { calculatorConfig, type CalculatorConfig } from './calc.ts'
import { L, noteTexts, pathText, summaryText } from './card.ts'
import type { CoverOutcome } from './cover.ts'
import { aimFromName, parseAttackType, resolveHit } from './engine.ts'
import {
  actorInnateDR,
  bodyInfo,
  facingBetween,
  liveRoller,
  locationDR,
  locationRole,
  t,
  tokenDocOf,
  torsoWhere,
  type AnyActor,
} from './foundry.ts'
import { guhlEnabled, torsoCap } from './settings.ts'
import type { Facing, HitResult, Part, Side, TargetId } from './types.ts'

export const NOTE_TEMPLATE = 'systems/gurps/templates/agency/hitloc-note.hbs'

/** What the hit card puts on a damage entry (entry.agencyHit) for the dialog to apply. */
export interface HitRequest {
  result: HitResult
  /** The defender's location name, if the body plan has one. */
  where: string | null
  facing: Facing
  cover: CoverOutcome | null
}

/**
 * GUHL detail on the damage calculator (calculator.agencyHitLocation), for the wound feature and
 * anything else reading a resolved hit. Plain data.
 */
export interface AgencyHitLocation {
  version: 1
  /** 'guhl': GUHL tables; 'standard': the actor's own (upstream) table. */
  system: 'guhl' | 'standard'
  /** Display path, localized: "Leg (Left) › Thigh › Vein/Artery". */
  path: string
  /** The actor's location name in use (calculator.hitLocation). Stale if they differ. */
  where: string
  /** Upstream canonical name: Skull, Eye, Face, Neck, Torso, Vitals, Groin, Arm, Leg, Hand, Foot. */
  upstreamLocation: string
  side: Side | null
  /** GUHL rules location (skull, eye, face, jaw, nose, ear, neck, neckVein, spine, chest, vitals, heart,
   *  abdomen, digestive, pelvis, groin, arm, leg, limbJoint, limbVein, hand, foot, extremityJoint). */
  part: Part | null
  /** Sub-location: jaw, nose, ear, cheek, eye, shin, knee, thigh, forearm, elbow, upperArm, shoulder,
   *  vitals, heart, spine, digestive, pelvis, groin, joint, vein. */
  sub: string | null
  /** GUHL wounding multiplier for this damage type (null: not GUHL's business, e.g. fatigue). */
  woundingMultiplier: number | null
  extraDR: number
  armorGap: boolean
  halveDR: boolean
  /** Injury cap in HP (chest/abdomen), or null. */
  injuryCap: number | null
  /** Crippling threshold override in HP (Infinity: can't be crippled), or null. */
  cripplingThreshold: number | null
  /** Modifier to bleeding rolls (neck -2, vein/artery -3 or -4 cut, vitals -4). */
  bleedModifier: number
  /** Bleeding rolls every 30 seconds instead of every minute. */
  bleedFast: boolean
  /** Localized notes, and their ids (GURPS.agency.hitloc.note.<id>). */
  notes: string[]
  noteIds: string[]
  /** Called-shot target id, or null for a random / default-location hit. */
  calledShot: TargetId | null
  facing: Facing
  /** What the target's cover did to this hit, when it came from the hit card. */
  cover: CoverOutcome | null
  /** The full engine result. */
  result: HitResult
}

const NO_CONFIG: CalculatorConfig = {
  additionalWoundModifier: 0,
  userEnteredDR: null,
  injuryCap: null,
  cripplingThreshold: null,
}

/** The calculator's location changed by hand: take back what GUHL set. */
function clearGuhl(calc: any): void {
  const applied: CalculatorConfig | undefined = calc.__agencyConfig
  if (applied) {
    if (calc.additionalWoundModifier === applied.additionalWoundModifier) calc.additionalWoundModifier = 0
    if (calc.userEnteredDR === applied.userEnteredDR) calc.userEnteredDR = null
  }
  calc.agencyInjuryCap = null
  calc.agencyCripplingThreshold = null
  calc.agencyHitLocation = null
  calc.__agencyConfig = undefined
}

/** Watch the calculator's hitLocation setter (the dialog's location radio buttons). */
function watchLocation(calc: any): void {
  if (calc.__agencyWatched) return
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(calc), 'hitLocation')
  Object.defineProperty(calc, 'hitLocation', {
    configurable: true,
    enumerable: false,
    get() {
      return descriptor?.get ? descriptor.get.call(this) : this._hitLocation
    },
    set(value: string) {
      if (this.agencyHitLocation && value !== this.agencyHitLocation.where) clearGuhl(this)
      if (descriptor?.set) descriptor.set.call(this, value)
      else this._hitLocation = value
    },
  })
  calc.__agencyWatched = true
}

function calledTarget(result: HitResult): TargetId | null {
  return result.aim.target === 'random' ? null : result.aim.target
}

/** Put a resolved hit on the dialog's calculator. */
export function applyToCalculator(dialog: any, request: HitRequest): AgencyHitLocation | null {
  const calc = dialog?._calculator
  const actor: AnyActor = dialog?.actor
  if (!calc || !actor) return null
  const { result } = request
  const info = bodyInfo(actor)

  const where =
    request.where ??
    (result.system === 'guhl' ? mapToBody(result, info.wheres, info.localize) : null) ??
    torsoWhere(info) ??
    String(calc._hitLocation)

  const attack = parseAttackType(calc.damageType, calc.damageModifier)
  const hpMax = Number(actor.system?.HP?.max) || 0
  const config =
    result.system === 'guhl'
      ? calculatorConfig({
          result,
          attack,
          where,
          role: locationRole(actor, where),
          useLocationModifiers: !!calc.useLocationModifiers,
          injuryTolerance: calc.isInjuryTolerance ? (calc.injuryToleranceType ?? null) : null,
          locationDR: locationDR(actor, where, calc.damageType),
          innateDR: actorInnateDR(actor),
          hpMax,
          torsoCap: torsoCap(),
        })
      : NO_CONFIG

  watchLocation(calc)
  calc._hitLocation = where
  // GUHL's sub-tables replace upstream's "body hits" vitals roll.
  if (result.system === 'guhl') calc._hitLocationAdjusted = true
  calc.additionalWoundModifier = config.additionalWoundModifier
  calc.userEnteredDR = config.userEnteredDR
  calc.agencyInjuryCap = config.injuryCap
  calc.agencyCripplingThreshold = config.cripplingThreshold
  calc.__agencyConfig = config

  const cap = torsoCap()
  const detail: AgencyHitLocation = {
    version: 1,
    system: result.system,
    path: pathText(result.path, t),
    where,
    upstreamLocation: result.upstream,
    side: result.side,
    part: result.part,
    sub: result.sub,
    woundingMultiplier: result.multiplier,
    extraDR: result.extraDR,
    armorGap: result.armorGap,
    halveDR: result.halveDR,
    injuryCap: config.injuryCap,
    cripplingThreshold: config.cripplingThreshold,
    bleedModifier: result.bleedModifier,
    bleedFast: result.bleedFast,
    notes: noteTexts(result, t, cap),
    noteIds: result.notes.filter(id => id !== 'torsoCap' || cap !== 'none'),
    calledShot: calledTarget(result),
    facing: request.facing,
    cover: request.cover,
    result,
  }
  calc.agencyHitLocation = detail
  return detail
}

/** Attacker's arc for a dialog: attacker token from the damage's attacker, target from the drop. */
function dialogFacing(dialog: any): Facing {
  const calc = dialog._calculator
  const attacker = (game.actors as any)?.get(calc?.attacker)
  const attackerDoc =
    (canvas as any)?.tokens?.placeables?.find((tk: any) => tk.actor?.id === attacker?.id)?.document ??
    tokenDocOf(attacker)
  const targetDoc = calc?._defenderToken?.document ?? tokenDocOf(dialog.actor)
  return facingBetween(attackerDoc, targetDoc)
}

/** A small chat note for a hit resolved inside the dialog (the dice are rolled there, not on a card). */
async function postNote(dialog: any, detail: AgencyHitLocation): Promise<void> {
  const actor = dialog.actor
  const result = detail.result
  const content = await renderTemplate(NOTE_TEMPLATE, {
    title: t(`${L}.roll.title`, { name: dialog.targetTokenName ?? actor?.name ?? '' }),
    path: detail.path,
    summary: summaryText(result, parseAttackType(dialog._calculator.damageType, dialog._calculator.damageModifier), t),
    notes: detail.notes,
    dice: result.rolls.map(r => `${r.dice}d6 ${r.value}`).join(' · '),
    facing: t(`${L}.card.facing`, { facing: t(`${L}.facing.${detail.facing}`) }),
  })
  await (ChatMessage as any).create({
    content,
    whisper: unique([...playerOwnerIds(actor), ...gmIds(), game.user!.id]),
  })
}

/** AGENCY hook from ApplyDamageDialog's constructor. */
export function configureDialog(dialog: any, damageData: any[]): void {
  try {
    const entry = Array.isArray(damageData) ? damageData[0] : damageData
    if (entry?.agencyHit) {
      applyToCalculator(dialog, entry.agencyHit as HitRequest)
      return
    }
    if (!guhlEnabled()) return
    const info = bodyInfo(dialog.actor)
    if (!info.guhl) return

    const calc = dialog._calculator
    const name = entry?.hitlocation ? String(entry.hitlocation) : String(calc?.hitLocation ?? '')
    if (!name || name === 'Random' || name === 'Large-Area') return
    const aim = aimFromName(name)
    if (!aim) return

    const facing = dialogFacing(dialog)
    const attack = parseAttackType(calc.damageType, calc.damageModifier)
    const result = resolveHit(aim, { attack, facing, roll: liveRoller() })
    const detail = applyToCalculator(dialog, {
      result,
      where: mapToBody(result, info.wheres, info.localize),
      facing,
      cover: null,
    })
    if (detail && result.rolls.length) void postNote(dialog, detail).catch(err => console.error(err))
  } catch (err) {
    console.error('GURPS | Agency | hit locations: could not configure Apply Damage', err)
  }
}

/** AGENCY hook from ApplyDamageDialog._randomizeHitLocation: true when GUHL rolled the location. */
export function randomizeHitLocation(dialog: any): boolean {
  try {
    if (!guhlEnabled()) return false
    const info = bodyInfo(dialog.actor)
    if (!info.guhl) return false
    const calc = dialog._calculator
    const facing = dialogFacing(dialog)
    const attack = parseAttackType(calc.damageType, calc.damageModifier)
    const result = resolveHit({ target: 'random' }, { attack, facing, roll: liveRoller() })
    const detail = applyToCalculator(dialog, {
      result,
      where: mapToBody(result, info.wheres, info.localize),
      facing,
      cover: null,
    })
    if (!detail) return false
    void postNote(dialog, detail).catch(err => console.error(err))
    return true
  } catch (err) {
    console.error('GURPS | Agency | hit locations: random roll failed, using upstream', err)
    return false
  }
}

/** renderApplyDamageDialog: show the GUHL path and notes above the dialog. */
export function decorateDialog(app: any, html: any): void {
  const detail: AgencyHitLocation | null = app?._calculator?.agencyHitLocation ?? null
  const element: HTMLElement | null = html instanceof HTMLElement ? html : (html?.[0] ?? null)
  if (!detail || !element || detail.where !== app._calculator.hitLocation) return
  const root = element.matches?.('.gga-app') ? element : (element.querySelector?.('.gga-app') ?? element)
  root.querySelector(':scope > .agency-hitloc-banner')?.remove()

  const banner = document.createElement('div')
  banner.className = 'agency-hitloc-banner'
  const path = document.createElement('div')
  path.className = 'agency-hitloc-banner__path'
  const badge = document.createElement('span')
  badge.className = 'agency-badge'
  badge.textContent = t(`${L}.card.system.${detail.system}`)
  path.append(badge, ` ${detail.path}`)
  banner.append(path)

  const summary = summaryText(
    detail.result,
    parseAttackType(app._calculator.damageType, app._calculator.damageModifier),
    t
  )
  if (summary) {
    const line = document.createElement('div')
    line.className = 'agency-hitloc-banner__summary'
    line.textContent = summary
    banner.append(line)
  }
  if (detail.notes.length) {
    const list = document.createElement('ul')
    list.className = 'agency-hitloc-banner__notes'
    for (const note of detail.notes) {
      const item = document.createElement('li')
      item.textContent = note
      list.append(item)
    }
    banner.append(list)
  }
  root.prepend(banner)
}
