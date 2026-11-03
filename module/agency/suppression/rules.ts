/**
 * Pinned by fire (GURPS Tactical Shooting p. 21, "Fire and Movement"): anyone under fire makes a
 * Will-2 roll each turn unless he has Combat Reflexes or Unfazeable. On a failure he stays behind
 * cover; he may still act in ways that don't expose him (move further behind cover, communicate,
 * reload). That's absolute for NPCs. A PC may leave cover, but all his rolls that turn are at minus
 * the margin of failure.
 *
 * Pure functions only; Foundry glue is in index.ts.
 */

/** Will penalty for the roll. */
export const WILL_PENALTY = -2

const EXEMPT = /^\s*(combat reflexes|unfazeable)\b/i

/** Combat Reflexes or Unfazeable: never pinned. */
export function isExempt(traitNames: Iterable<string>): boolean {
  for (const name of traitNames) if (EXEMPT.test(String(name))) return true
  return false
}

export type PinOutcome = {
  target: number
  roll: number
  /** Positive: succeeded by; negative: failed by. */
  margin: number
  success: boolean
  critical: boolean
}

/** GURPS success roll against Will-2 (B347-348: 3-4 always succeed, 17-18 always fail). */
export function resolvePin(will: number, roll: number): PinOutcome {
  const target = will + WILL_PENALTY
  const critSuccess = roll <= 4 || (roll === 5 && target >= 15) || (roll === 6 && target >= 16)
  const critFailure = roll === 18 || (roll === 17 && target <= 15) || roll - target >= 10
  const success = critSuccess || (!critFailure && roll < 17 && roll <= target)
  return { target, roll, margin: target - roll, success, critical: critSuccess || critFailure }
}

/** Penalty a PC takes on every roll for leaving cover after failing (the margin of failure). */
export function leaveCoverPenalty(outcome: PinOutcome): number {
  return outcome.success ? 0 : Math.min(-1, outcome.margin)
}

export type Placed = { id: string; x: number; y: number }

/**
 * Tokens under fire from one ranged attack: every target, plus, when the attack missed, any other
 * token within `radius` yards of a target (the rounds went somewhere). The shooter is never included.
 */
export function underFire(
  targets: Placed[],
  others: Placed[],
  opts: { missed: boolean; radius: number; shooterId: string | null; yards: (a: Placed, b: Placed) => number }
): string[] {
  const ids = new Set(targets.map(t => t.id))
  if (opts.missed && opts.radius > 0) {
    for (const other of others) {
      if (ids.has(other.id) || other.id === opts.shooterId) continue
      if (targets.some(t => opts.yards(t, other) <= opts.radius)) ids.add(other.id)
    }
  }
  if (opts.shooterId) ids.delete(opts.shooterId)
  return [...ids]
}
