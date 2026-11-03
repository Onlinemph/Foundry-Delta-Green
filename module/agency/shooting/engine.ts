/**
 * Shooting house rules engine: Progressive Recoil System (per-shot rolls with cumulative recoil)
 * plus EUFC fractional Rcl, aim carry-over and Gunslinger. See docs/agency/shooting-rules.md.
 *
 * Pure functions only; Foundry integration lives in index.ts.
 */

/** Smallest Rcl any weapon can have under EUFC. */
export const MIN_RCL = 0.5

/** Round half up for non-negative numbers, tolerant of float error (2.3 * 2 = 4.6000000000000005). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5 + 1e-9)
}

/**
 * Parse an Rcl value: "2", "1.75", "2.3", 2, "1/2" (a fraction), "" (none).
 * Returns null when the weapon has no usable Rcl (melee, thrown, blank).
 * EUFC: values below 0.5 count as 0.5.
 */
export function parseRcl(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.max(MIN_RCL, value) : null
  const text = String(value).trim()
  if (!text) return null
  const fraction = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (fraction) {
    const result = Number(fraction[1]) / Number(fraction[2])
    return Number.isFinite(result) && result > 0 ? Math.max(MIN_RCL, result) : null
  }
  const number = text.match(/^(\d+(?:\.\d+)?|\.\d+)/)
  if (!number) return null
  const result = Number(number[1])
  if (!Number.isFinite(result)) return null
  if (result === 0) return MIN_RCL
  return Math.max(MIN_RCL, result)
}

/** True for weapons whose *natural* Rcl is exactly 1 (flat -1 per extra shot). */
export function isNaturalRcl1(rcl: number): boolean {
  return Math.abs(rcl - 1) < 1e-9
}

/** Rcl used for the cumulative penalty: halved and rounded half up when braced. */
export function effectiveRcl(rcl: number, braced: boolean): number {
  if (!braced) return rcl
  return Math.max(1, roundHalfUp(rcl / 2))
}

/**
 * Recoil penalty for each shot of a burst (index 0 = first shot, always 0).
 * Penalties are returned as non-positive integers.
 */
export function recoilPenalties(shots: number, rcl: number, braced: boolean): number[] {
  const count = Math.max(0, Math.floor(shots))
  const result: number[] = []
  const natural1 = isNaturalRcl1(rcl)
  const eff = effectiveRcl(rcl, braced)
  for (let i = 0; i < count; i++) {
    if (i === 0) result.push(0)
    else if (natural1) result.push(-1)
    else result.push(-roundHalfUp(i * eff))
  }
  return result.map(p => (p === 0 ? 0 : p)) // avoid -0
}

export type BurstInput = {
  /** Effective skill with every modifier except aim bonuses and the bracing Acc bonus. */
  baseTarget: number
  /** Aim-derived bonuses (Aim maneuver, carried-over Acc, Gunslinger Acc). First shot only. */
  aimBonus: number
  /** Bracing Acc bonus (usually +1). Applies to every shot when braced. */
  braceAcc: number
  braced: boolean
  rcl: number
  shots: number
}

export type PlannedShot = {
  shot: number
  target: number
  recoil: number
  aim: number
  brace: number
}

/** Target number for each shot in a Progressive Recoil burst. */
export function planBurst(input: BurstInput): PlannedShot[] {
  const brace = input.braced ? input.braceAcc : 0
  return recoilPenalties(input.shots, input.rcl, input.braced).map((recoil, i) => {
    const aim = i === 0 ? input.aimBonus : 0
    return { shot: i + 1, target: input.baseTarget + aim + brace + recoil, recoil, aim, brace }
  })
}

export type ShotOutcome = 'critical' | 'hit' | 'miss' | 'fumble'

/** GURPS success roll outcome (B347-348). */
export function outcomeOf(roll: number, target: number): ShotOutcome {
  const critSuccess = roll <= 4 || (roll === 5 && target >= 15) || (roll === 6 && target >= 16)
  if (critSuccess) return 'critical'
  const critFailure = roll === 18 || (roll === 17 && target <= 15) || roll - target >= 10
  if (critFailure) return 'fumble'
  if (roll >= 17) return 'miss'
  return roll <= target ? 'hit' : 'miss'
}

export type ResolvedShot = PlannedShot & { roll: number; outcome: ShotOutcome; margin: number }

export type BurstResult = {
  shots: ResolvedShot[]
  /** Every successful shot, critical or not. */
  hits: number
  /** Successful shots that were critical: these can't be dodged. */
  criticalHits: number
  /** Hits a Dodge can still negate. */
  dodgeableHits: number
  fumbles: number
}

export function resolveBurst(plan: PlannedShot[], rolls: number[]): BurstResult {
  if (rolls.length < plan.length) throw new Error(`Need ${plan.length} rolls, got ${rolls.length}`)
  const shots = plan.map((p, i) => {
    const roll = rolls[i]
    return { ...p, roll, outcome: outcomeOf(roll, p.target), margin: p.target - roll }
  })
  const criticalHits = shots.filter(s => s.outcome === 'critical').length
  const hits = criticalHits + shots.filter(s => s.outcome === 'hit').length
  return {
    shots,
    hits,
    criticalHits,
    dodgeableHits: hits - criticalHits,
    fumbles: shots.filter(s => s.outcome === 'fumble').length,
  }
}

/**
 * Hits that get through a Dodge (B375): a successful Dodge stops 1 hit plus 1 per point of margin;
 * critical hits can't be dodged.
 */
export function hitsAfterDodge(result: Pick<BurstResult, 'criticalHits' | 'dodgeableHits'>, dodgeMargin: number | null) {
  const dodged = dodgeMargin === null || dodgeMargin < 0 ? 0 : Math.min(result.dodgeableHits, 1 + dodgeMargin)
  return result.criticalHits + result.dodgeableHits - dodged
}

// ---------------------------------------------------------------------------------------------
// EUFC: aim carry-over

export type CarryOver = { weaponKey: string; targetId: string; acc: number; round: number | null }

/**
 * Acc kept for the next turn after firing. Only single shots carry over: half the Acc bonus used
 * (round down), or all of it when braced or on a bipod. Bursts carry nothing.
 */
export function carriedAcc(shotsFired: number, accUsed: number, braced: boolean): number {
  if (shotsFired !== 1 || accUsed <= 0) return 0
  return braced ? accUsed : Math.floor(accUsed / 2)
}

/** Whether a stored carry-over still applies to this attack. */
export function carryOverApplies(
  carry: CarryOver | null | undefined,
  weaponKey: string,
  targetId: string | null,
  currentRound: number | null
): boolean {
  if (!carry || carry.acc <= 0) return false
  if (carry.weaponKey !== weaponKey || !targetId || carry.targetId !== targetId) return false
  // In combat it lasts until the end of the shooter's next turn (one round later).
  if (carry.round !== null && currentRound !== null && currentRound > carry.round + 1) return false
  return true
}

// ---------------------------------------------------------------------------------------------
// EUFC: Gunslinger

export type WeaponClass = 'pistol' | 'autopistol' | 'longarm'

/**
 * Guess a weapon's class from its stats when the user hasn't set one.
 * GURPS Bulk: handguns -1/-2, SMGs and carbines -3/-4, rifles and MGs -4 to -6.
 */
export function guessWeaponClass(weapon: { bulk?: unknown; rof?: unknown; name?: unknown }): WeaponClass {
  const name = String(weapon.name ?? '').toLowerCase()
  if (/\b(rifle|carbine|shotgun|smg|submachine|machine ?gun|lmg|mg\b)/.test(name)) return 'longarm'
  const bulk = Number(String(weapon.bulk ?? '').replace(/[^\d.-]/g, ''))
  const rof = parseInt(String(weapon.rof ?? '1'), 10) || 1
  if (Number.isFinite(bulk) && bulk !== 0 && bulk <= -3) return 'longarm'
  if (/\b(pistol|revolver|handgun|derringer)\b/.test(name) || (Number.isFinite(bulk) && bulk >= -2 && bulk !== 0)) {
    return rof > 3 ? 'autopistol' : 'pistol'
  }
  return 'longarm'
}

/** Acc a Gunslinger gets without aiming: full for pistols, half (round up) for long arms and auto-pistols. */
export function gunslingerAcc(weaponClass: WeaponClass, baseAcc: number): number {
  if (!Number.isFinite(baseAcc) || baseAcc <= 0) return 0
  return weaponClass === 'pistol' ? baseAcc : Math.ceil(baseAcc / 2)
}

/** Gunslinger halves the penalty of fast-firing techniques and Fast-Draw, rounding in the shooter's favour. */
export function gunslingerHalvedPenalty(penalty: number): number {
  if (penalty >= 0) return penalty
  const halved = Math.floor(-penalty / 2)
  return halved === 0 ? 0 : -halved
}
