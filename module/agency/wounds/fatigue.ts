/**
 * Fatigue under Revised Fractional Health:
 * - FP loss never causes HP of injury.
 * - At 0 or lower FP, an HT roll (+ Hard to Subdue) to do anything but talk or rest; failure means Do Nothing.
 * - FP can fall below -1 x FP. An HT roll at -1 x FP and every further 1/2 FP: failure is unconsciousness,
 *   failure by 5+ is death, at -5 per additional -1 x FP. Hard to Subdue helps against unconsciousness,
 *   Hard to Kill against death.
 */
import { resolveRoll, type Modifier, type RollOutcome } from './rolls.ts'
import { FATIGUE_FOR_SEVERITY, type Severity } from './severity.ts'
import type { Traits } from './traits.ts'

export function fatigueForSeverity(severity: Severity | null): number {
  return severity ? FATIGUE_FOR_SEVERITY[severity] : 0
}

export interface FatigueThreshold {
  /** FP value at which the check is due (e.g. -10 for -1 x 10 FP, -15 for -1.5 x 10 FP). */
  threshold: number
  /** The threshold as a multiple of max FP (1, 1.5, 2, ...). */
  multiple: number
  /** -5 per full -1 x FP beyond the first. */
  modifier: number
}

export function fatigueThreshold(step: number, maxFP: number): FatigueThreshold {
  const multiple = 1 + step / 2
  // `|| 0` turns -0 into 0.
  return { threshold: -multiple * maxFP, multiple, modifier: -5 * (Math.floor(multiple) - 1) || 0 }
}

/**
 * The HT checks a drop from `oldFP` to `newFP` calls for: one for each of -1 x FP, -1.5 x FP, -2 x FP ...
 * that the drop reaches. Thresholds can be fractional (max FP 11: -16.5), reached once FP is at or below them.
 */
export function fatigueChecksCrossed(oldFP: number, newFP: number, maxFP: number): FatigueThreshold[] {
  if (!(maxFP > 0) || !(newFP < oldFP)) return []
  const result: FatigueThreshold[] = []
  for (let step = 0; step < 1000; step++) {
    const t = fatigueThreshold(step, maxFP)
    if (t.threshold < newFP) break
    if (oldFP > t.threshold) result.push(t)
  }
  return result
}

/** True when this drop takes the character to 0 FP or below for the first time. */
export function reachedZeroFP(oldFP: number, newFP: number): boolean {
  return oldFP > 0 && newFP <= 0
}

export interface FatigueCheckSpec {
  modifiers: Modifier[]
  /** Hard to Subdue: counts only against falling unconscious. */
  unconsciousBonus: Modifier[]
  /** Hard to Kill: counts only against dying. */
  deathBonus: Modifier[]
}

export function fatigueCheckSpec(threshold: FatigueThreshold, traits: Traits): FatigueCheckSpec {
  const modifiers: Modifier[] = []
  if (threshold.modifier) modifiers.push({ value: threshold.modifier, label: 'GURPS.agency.wounds.mod.beyondFP' })
  return {
    modifiers,
    unconsciousBonus: traits.hardToSubdue
      ? [{ value: traits.hardToSubdue, label: 'GURPS.agency.wounds.mod.hardToSubdue' }]
      : [],
    deathBonus: traits.hardToKill ? [{ value: traits.hardToKill, label: 'GURPS.agency.wounds.mod.hardToKill' }] : [],
  }
}

export interface FatigueCheckResult {
  unconsciousRoll: RollOutcome
  deathRoll: RollOutcome
  unconscious: boolean
  dead: boolean
}

/** One 3d6 roll judged twice: against HT + mods + Hard to Subdue for unconsciousness, + Hard to Kill for death. */
export function resolveFatigueCheck(total: number, base: number, spec: FatigueCheckSpec): FatigueCheckResult {
  const mods = spec.modifiers.reduce((s, m) => s + m.value, 0)
  const unconsciousRoll = resolveRoll(total, base + mods + spec.unconsciousBonus.reduce((s, m) => s + m.value, 0))
  const deathRoll = resolveRoll(total, base + mods + spec.deathBonus.reduce((s, m) => s + m.value, 0))
  const dead = !deathRoll.success && -deathRoll.margin >= 5
  return { unconsciousRoll, deathRoll, unconscious: dead || !unconsciousRoll.success, dead }
}

/** At 0 or less FP: HT (+ Hard to Subdue) to act this turn. */
export function actCheckModifiers(traits: Traits): Modifier[] {
  return traits.hardToSubdue ? [{ value: traits.hardToSubdue, label: 'GURPS.agency.wounds.mod.hardToSubdue' }] : []
}

export interface FatigueCondition {
  key: 'normal' | 'tired' | 'actRoll' | 'checks'
  label: string
  style: string
}

/**
 * The FP condition shown on the sheet when RFH is on. Upstream shows "unconscious" at -1 x FP; under
 * RFH that is only where the HT checks start.
 */
export function fatigueCondition(value: number, maxFP: number): FatigueCondition {
  if (value <= -maxFP && maxFP > 0) return { key: 'checks', label: 'GURPS.agency.wounds.fp.checks', style: 'check' }
  if (value <= 0) return { key: 'actRoll', label: 'GURPS.agency.wounds.fp.actRoll', style: 'collapse' }
  if (value <= Math.ceil(maxFP / 3) - 1) return { key: 'tired', label: 'GURPS.status.tired', style: 'tired' }
  return { key: 'normal', label: 'GURPS.normal', style: 'normal' }
}

/** Breakpoints for the FP tooltip: tired, HT to act at 0, then the HT checks at -1, -1.5, -2, -2.5 and -3 x FP. */
export function fatigueBreakpoints(maxFP: number): { breakpoint: number; label: string; modifier: number }[] {
  const result = [
    { breakpoint: Math.ceil(maxFP / 3) - 1, label: 'GURPS.status.tired', modifier: 0 },
    { breakpoint: 0, label: 'GURPS.agency.wounds.fp.actRoll', modifier: 0 },
  ]
  for (let step = 0; step <= 4; step++) {
    const t = fatigueThreshold(step, maxFP)
    // The highest whole FP value at which the check is due (-16.5 is reached at -17).
    result.push({ breakpoint: Math.floor(t.threshold), label: 'GURPS.agency.wounds.fp.check', modifier: t.modifier })
  }
  return result
}
