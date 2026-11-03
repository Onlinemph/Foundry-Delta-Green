/**
 * Bleeding, bandaging, stabilizing and surgery under Revised Fractional Health.
 */
import { resolveRoll, type RollOutcome } from './rolls.ts'
import { BLEEDING, atLeast, severityRank, shiftSeverity, type Severity } from './severity.ts'
import type { BleedingState, SpecialBleed, WoundRecord } from './types.ts'

export const NOT_BLEEDING: BleedingState = Object.freeze({
  severity: null,
  special: null,
  consecutive: 0,
  successes: 0,
})

export interface BleedingOptions {
  /** Track bleeding from Minor wounds and Scratches (the rules allow ignoring it for simplicity). */
  trackMinor: boolean
  hemophilia: boolean
}

/** Bites bleed as cutting wounds even when they do crushing damage. */
function isCutting(damageType: string): boolean {
  return damageType === 'cut' || damageType === 'bite'
}

function isCrushing(damageType: string): boolean {
  return damageType === 'cr'
}

/** Bleeding from Minor wounds and Scratches is ignored unless the table opts in or the victim is a hemophiliac. */
function tracksMinor(options: BleedingOptions): boolean {
  return options.trackMinor || options.hemophilia
}

/**
 * How a freshly taken wound bleeds. Scratches bleed only from cutting damage; Minor wounds bleed from
 * anything but crushing; Moderate and worse always bleed. Destroyed bodies don't need tracking.
 */
export function initialBleeding(severity: Severity, damageType: string, options: BleedingOptions): BleedingState {
  if (severity === 'destroyed') return { ...NOT_BLEEDING }
  if (severity === 'scratch' && (!isCutting(damageType) || !tracksMinor(options))) return { ...NOT_BLEEDING }
  if (severity === 'minor' && (isCrushing(damageType) || !tracksMinor(options))) return { ...NOT_BLEEDING }
  return { severity, special: null, consecutive: 0, successes: 0 }
}

export function isBleeding(bleeding: BleedingState | null | undefined): boolean {
  return !!bleeding && (bleeding.severity !== null || bleeding.special !== null)
}

/** Seconds per FP lost; null when not bleeding. */
export function bleedInterval(bleeding: BleedingState): number | null {
  if (bleeding.special === '2fp-per-second') return 0.5
  if (bleeding.special === '1fp-per-second') return 1
  if (!bleeding.severity) return null
  const seconds = BLEEDING[bleeding.severity]?.seconds ?? null
  return seconds !== null && bleeding.fast ? seconds / 2 : seconds
}

/** HT modifier for the roll to avoid losing FP to this wound's bleeding this interval. */
export function bleedingModifier(severity: Severity): number {
  return BLEEDING[severity]?.modifier ?? -5
}

/** A bleeding check is possible for table-rate bleeding only; fixed-rate bleeding needs stabilizing or surgery. */
export function canRollBleeding(bleeding: BleedingState): boolean {
  return bleeding.severity !== null && bleeding.special === null
}

/** Slow the bleeding one level; slowing below a Scratch, or into the Minor range we don't track, stops it. */
export function slowBleeding(bleeding: BleedingState, options: BleedingOptions): BleedingState {
  if (!bleeding.severity) return { ...bleeding }
  const next = shiftSeverity(bleeding.severity, -1)
  if (!next || (!atLeast(next, 'moderate') && !tracksMinor(options)))
    return { ...NOT_BLEEDING, special: bleeding.special }
  return { ...bleeding, severity: next, consecutive: 0, successes: 0 }
}

export interface BleedingCheckResult {
  bleeding: BleedingState
  roll: RollOutcome
  fpLost: number
  slowed: boolean
  stopped: boolean
}

/**
 * One bleeding interval for one wound. Roll HT + Hard to Kill + the table modifier:
 * - success: no FP lost this interval; a critical success, or two successes in a row, slows the bleeding a level.
 * - Minor wounds and Scratches: any success means no FP; any two successes stop the bleeding.
 * - failure: lose 1 FP. A hemophiliac always fails.
 */
export function resolveBleedingCheck(
  bleeding: BleedingState,
  total: number,
  target: number,
  options: BleedingOptions
): BleedingCheckResult {
  const raw = resolveRoll(total, target)
  const roll: RollOutcome = options.hemophilia ? { ...raw, success: false, critSuccess: false } : raw
  if (!canRollBleeding(bleeding)) return { bleeding: { ...bleeding }, roll, fpLost: 0, slowed: false, stopped: false }

  if (!roll.success) {
    return { bleeding: { ...bleeding, consecutive: 0 }, roll, fpLost: 1, slowed: false, stopped: false }
  }

  const severity = bleeding.severity as Severity
  if (severityRank(severity) <= severityRank('minor')) {
    const successes = bleeding.successes + 1
    if (successes >= 2) return { bleeding: { ...NOT_BLEEDING }, roll, fpLost: 0, slowed: false, stopped: true }
    return {
      bleeding: { ...bleeding, successes, consecutive: bleeding.consecutive + 1 },
      roll,
      fpLost: 0,
      slowed: false,
      stopped: false,
    }
  }

  const consecutive = bleeding.consecutive + 1
  if (roll.critSuccess || consecutive >= 2) {
    const slowedBleeding = slowBleeding(bleeding, options)
    return {
      bleeding: slowedBleeding,
      roll,
      fpLost: 0,
      slowed: true,
      stopped: !isBleeding(slowedBleeding),
    }
  }
  return {
    bleeding: { ...bleeding, consecutive, successes: bleeding.successes + 1 },
    roll,
    fpLost: 0,
    slowed: false,
    stopped: false,
  }
}

export type Treatment = 'bandage' | 'stabilize' | 'surgery'

/** Bandaging and stabilizing get one attempt per wound; surgery can be retried. Stabilizing is the second First Aid roll. */
export function canTreat(wound: WoundRecord, treatment: Treatment): boolean {
  if (!isBleeding(wound.bleeding)) return false
  switch (treatment) {
    case 'bandage':
      return !wound.bandageAttempted
    case 'stabilize':
      return wound.bandageAttempted && !wound.stabilizeAttempted
    case 'surgery':
      return true
  }
}

/**
 * Apply a First Aid (bandage, stabilize) or Surgery result.
 * - bandage: on a success the wound bleeds one level lower.
 * - stabilize, surgery: on a success the wound stops bleeding, fixed-rate bleeding included.
 */
export function applyTreatment(
  wound: WoundRecord,
  treatment: Treatment,
  success: boolean,
  options: BleedingOptions
): WoundRecord {
  const result: WoundRecord = { ...wound, bleeding: { ...wound.bleeding } }
  switch (treatment) {
    case 'bandage':
      result.bandageAttempted = true
      if (success) {
        result.bandaged = true
        result.bleeding = slowBleeding(wound.bleeding, options)
      }
      break
    case 'stabilize':
      result.stabilizeAttempted = true
      if (success) {
        result.stabilized = true
        result.bleeding = { ...NOT_BLEEDING }
      }
      break
    case 'surgery':
      if (success) result.bleeding = { ...NOT_BLEEDING }
      break
  }
  return result
}

/** Dismembered limbs bleed as if Massive wounds. */
export function dismemberedBleeding(): BleedingState {
  return { severity: 'massive', special: null, consecutive: 0, successes: 0 }
}

export function specialBleeding(current: BleedingState, rate: SpecialBleed): BleedingState {
  // Keep the faster of two fixed rates.
  if (current.special === '2fp-per-second') return { ...current }
  return { ...current, special: rate }
}

/** Daily HT roll to recover FP lost to bleeding: 1 FP on a success, 2 on a critical success. */
export function bloodRecovery(roll: RollOutcome, bleedingFP: number): number {
  const recovered = roll.critSuccess ? 2 : roll.success ? 1 : 0
  return Math.max(0, Math.min(recovered, bleedingFP))
}
