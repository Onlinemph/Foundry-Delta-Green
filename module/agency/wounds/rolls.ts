/**
 * 3d6 success rolls (B347-348), kept pure so check outcomes can be tested with fixed dice.
 */

export interface Modifier {
  value: number
  /** Localization key (or plain text) describing the modifier. */
  label: string
}

export interface RollOutcome {
  total: number
  target: number
  /** target - total: positive or zero is a margin of success, negative a margin of failure. */
  margin: number
  success: boolean
  critSuccess: boolean
  critFailure: boolean
}

export function sumModifiers(modifiers: readonly Modifier[] | undefined): number {
  return (modifiers ?? []).reduce((sum, m) => sum + m.value, 0)
}

/**
 * Resolve a 3d6 roll against an effective target.
 *
 * 3-4 always succeed (critically), as do 5 against 15+ and 6 against 16+. 17-18 always fail; 18, 17
 * against 15 or less, and any roll 10 or more over the target are critical failures.
 */
export function resolveRoll(total: number, target: number): RollOutcome {
  const critSuccess = total <= 4 || (total === 5 && target >= 15) || (total === 6 && target >= 16)
  const critFailure = total >= 18 || (total === 17 && target <= 15) || total - target >= 10
  const success = critSuccess || (total <= target && total < 17)
  return { total, target, margin: target - total, success, critSuccess, critFailure }
}

/** How badly a roll failed (0 on a success). */
export function marginOfFailure(outcome: RollOutcome): number {
  return outcome.success ? 0 : Math.max(0, -outcome.margin)
}
