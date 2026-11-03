/**
 * Explosion rules from GURPS Basic Set: Campaigns and High-Tech, as pure functions.
 * Page references: Bnnn = Basic Set, HTnnn = High-Tech, TSnn = Tactical Shooting.
 * No Foundry globals here; tested in test/agency/explosions-rules.test.ts.
 */
import { diceCount, IGNORES_DR, type DamageComponent, type DiceExpr, type FragSpec } from './parse.ts'

/* ------------------------------------------------------------------ */
/* Radii                                                               */
/* ------------------------------------------------------------------ */

/** B414: an explosion does collateral damage to everything within (2 × dice of damage) yards. */
export function blastRadius(component: Pick<DamageComponent, 'explosive' | 'dice' | 'multiplier'>): number {
  return component.explosive ? 2 * component.dice * component.multiplier : 0
}

/** B414: fragments reach (5 × dice of fragmentation damage) yards. */
export function fragmentRadius(frag: FragSpec | null | undefined): number {
  return frag ? 5 * diceCount(frag) : 0
}

/* ------------------------------------------------------------------ */
/* Collateral damage                                                   */
/* ------------------------------------------------------------------ */

/**
 * Environment of the blast (the yards multiplier of the collateral divisor):
 * - normal: 3 × yards (B414)
 * - thermobaric / fuel-air: 2 × yards (HT170, HT187, after Explosion on B104)
 * - underwater: 1 × yards (B415, Explosions in Other Environments)
 * - vacuum: 10 × yards (B415)
 */
export type BlastEnvironment = 'normal' | 'thermobaric' | 'underwater' | 'vacuum'

export const PER_YARD: Record<BlastEnvironment, number> = {
  normal: 3,
  thermobaric: 2,
  underwater: 1,
  vacuum: 10,
}

/**
 * The collateral divisor for someone `yards` from the center. Interpretation: B414 gives no rule for
 * someone in the blast's own hex who wasn't struck, so distances under 1 yard count as 1 yard.
 */
export function collateralDivisor(yards: number, environment: BlastEnvironment = 'normal'): number {
  return PER_YARD[environment] * Math.max(1, yards)
}

/**
 * B414: the target struck takes the listed damage as is; everyone else in the blast takes it divided
 * by (3 × yards), rounding down. HT181 Explosions in Enclosed Spaces: everyone in a contained blast takes
 * double damage, or 1.5× if doors and windows blow out (`enclosed` = 1, 1.5 or 2).
 */
export function collateralDamage(
  rolled: number,
  yards: number,
  opts: { struck?: boolean; environment?: BlastEnvironment; enclosed?: number } = {}
): { damage: number; divisor: number } {
  const enclosed = opts.enclosed && opts.enclosed > 0 ? opts.enclosed : 1
  if (opts.struck) return { damage: Math.floor(rolled * enclosed), divisor: 1 }
  const divisor = collateralDivisor(yards, opts.environment)
  return { damage: Math.floor(Math.floor(rolled / divisor) * enclosed), divisor }
}

/**
 * B414: an explosive's armor divisor applies only to the target it actually strikes; everyone else
 * gets full DR against the blast, and fragments never get it. Returns the divisor for the calculator
 * (0 = none).
 */
export function blastArmorDivisor(component: Pick<DamageComponent, 'armorDivisor'>, struck: boolean): number {
  return struck && component.armorDivisor !== 1 ? component.armorDivisor : 0
}

/** B415 Contact Explosions: the person on the explosive takes maximum damage; DR protects normally. */
export function contactDamage(expr: DiceExpr): number {
  return Math.max(0, expr.dice * 6 + expr.adds) * expr.multiplier
}

/** B415: everyone else gets the smotherer's torso DR + HP as cover DR. */
export function bodyCoverDR(torsoDR: number, hp: number): number {
  return Math.max(0, Math.floor(torsoDR)) + Math.max(0, Math.floor(hp))
}

/** B415 Internal Explosions: DR has no effect, and the blast is a vitals hit with a ×3 wounding modifier. */
export const INTERNAL_EXPLOSION = { ignoresDR: true, location: 'Vitals', woundingModifier: 3 } as const

/* ------------------------------------------------------------------ */
/* Fragmentation                                                       */
/* ------------------------------------------------------------------ */

/** B414: fragments attack at skill 15. */
export const FRAGMENT_SKILL = 15

const SSR_STEPS = [2, 3, 5, 7, 10, 15]

/**
 * Range penalty from the Size and Speed/Range Table (B550): 0 to 2 yards, -1 at 3, -2 at 5, -3 at 7,
 * -4 at 10, -5 at 15, -6 at 20 ... (the sequence repeats ×10 every six steps). Use the smallest
 * entry that covers the distance.
 */
export function rangePenalty(yards: number): number {
  if (!(yards > 2)) return 0
  for (let step = 1; step < 200; step++) {
    const decade = Math.floor(step / 6)
    const limit = SSR_STEPS[step % 6] * 10 ** decade
    if (yards <= limit + 1e-9) return -step
  }
  return -200
}

export type Posture = 'standing' | 'down'

/**
 * B551 Posture Table: crouching, kneeling, crawling, sitting and lying down are all -2 to be hit by a
 * ranged attack. B415 Airbursts: posture modifiers don't apply.
 */
export function postureModifier(posture: Posture, airburst = false): number {
  return posture === 'standing' || airburst ? 0 : -2
}

/** Success-roll outcome (B556 Critical Success and Failure): 3-4 always succeed critically, 5 at skill 15+, 6 at 16+; 17-18 fail. */
export function successRoll(roll: number, target: number): { success: boolean; critical: boolean; margin: number } {
  const margin = target - roll
  const critical = roll <= 4 || (roll === 5 && target >= 15) || (roll === 6 && target >= 16)
  const success = critical || (roll <= 16 && margin >= 0)
  return { success, critical, margin }
}

export interface FragmentAttack {
  skill: number
  rangeModifier: number
  postureModifier: number
  sizeModifier: number
  effective: number
  roll: number | null
  margin: number
  success: boolean
  critical: boolean
  /** Fragments that hit before any dive for cover. */
  hits: number
  automatic: boolean
}

/**
 * B414: fragments attack everyone in the area at skill 15 with only three modifiers: the range modifier
 * for the distance from the center, the target's posture, and its Size Modifier. One extra fragment hits
 * per full 3 points of success. A target the explosive actually struck is hit automatically.
 */
export function fragmentAttack(opts: {
  yards: number
  posture: Posture
  sizeModifier: number
  airburst?: boolean
  struck?: boolean
  roll: number | null
}): FragmentAttack {
  const rangeModifier = rangePenalty(opts.yards)
  const postureMod = postureModifier(opts.posture, opts.airburst)
  const sizeModifier = Math.trunc(opts.sizeModifier || 0)
  const effective = FRAGMENT_SKILL + rangeModifier + postureMod + sizeModifier
  const base = {
    skill: FRAGMENT_SKILL,
    rangeModifier,
    postureModifier: postureMod,
    sizeModifier,
    effective,
  }
  if (opts.struck) return { ...base, roll: null, margin: 0, success: true, critical: false, hits: 1, automatic: true }
  if (opts.roll === null)
    return { ...base, roll: null, margin: 0, success: false, critical: false, hits: 0, automatic: false }
  const result = successRoll(opts.roll, effective)
  const hits = result.success ? 1 + Math.floor(Math.max(0, result.margin) / 3) : 0
  return { ...base, roll: opts.roll, ...result, hits, automatic: false }
}

/* ------------------------------------------------------------------ */
/* Diving for cover                                                    */
/* ------------------------------------------------------------------ */

/**
 * B414/B377: anyone caught in a blast may dodge and drop (Dodge +3, ending prone) to dive for cover.
 * The target the explosive struck already had its defense against the attack, so it can't.
 */
export function canDive(opts: { struck: boolean; inBlast: boolean; inFragments: boolean }): boolean {
  return !opts.struck && (opts.inBlast || opts.inFragments)
}

/** B377: Dodge and Drop is +3 to Dodge. */
export const DODGE_AND_DROP_BONUS = 3

export interface DiveEffect {
  /** B377: success puts you a step farther from the blast. */
  extraYards: number
  /**
   * B414 calls diving away the only active defense against fragments. Interpretation: like a dodge
   * against rapid fire (B375), a success stops one fragment plus one per point of margin. Critical
   * fragment hits can't be defended (B556).
   */
  fragmentsStopped: number
  /** B377 Diving for Cover: with cover a step away, success means you reach it. */
  reachedCover: boolean
  /** B377: dodge and drop leaves you prone, success or failure. */
  prone: boolean
}

export function diveEffect(dive: { success: boolean; margin: number; coverStep?: boolean } | null): DiveEffect {
  if (!dive) return { extraYards: 0, fragmentsStopped: 0, reachedCover: false, prone: false }
  if (!dive.success) return { extraYards: 0, fragmentsStopped: 0, reachedCover: false, prone: true }
  return {
    extraYards: 1,
    fragmentsStopped: 1 + Math.max(0, Math.trunc(dive.margin)),
    reachedCover: !!dive.coverStep,
    prone: true,
  }
}

/** Fragment hits left after a dive (critical hits always stay). */
export function fragmentsAfterDive(hits: number, critical: boolean, effect: DiveEffect): number {
  if (critical) return hits
  return Math.max(0, hits - effect.fragmentsStopped)
}

/**
 * B377 Sacrificial Dodge and Drop: someone no more than a step away can throw himself on the explosive.
 * Success makes it a contact explosion (B415).
 */
export function canSmother(yards: number, struck: boolean): boolean {
  return !struck && yards <= 1
}

/* ------------------------------------------------------------------ */
/* Cover                                                               */
/* ------------------------------------------------------------------ */

/**
 * B408 Shooting Through Cover: cover adds its cover DR against the attack; apply any armor divisor to it.
 * B414: an explosive's own armor divisor doesn't apply to the blast on bystanders, or to fragments.
 */
export function effectiveCoverDR(coverDR: number, armorDivisor = 1): number {
  if (!(coverDR > 0)) return 0
  if (armorDivisor === IGNORES_DR) return 0
  if (!(armorDivisor > 0) || armorDivisor === 1) return coverDR
  return Math.floor(coverDR / armorDivisor)
}

/** Damage left after passing through cover (B408). */
export function throughCover(damage: number, coverDR: number, armorDivisor = 1): number {
  return Math.max(0, damage - effectiveCoverDR(coverDR, armorDivisor))
}

/**
 * Cover DR from walls between the blast and a target: the sum over every wall crossed. B415 Airbursts:
 * only overhead cover protects, so walls don't count.
 */
export function wallCoverDR(wallDRs: number[], airburst = false): number {
  if (airburst) return 0
  return wallDRs.reduce((sum, dr) => sum + Math.max(0, Number(dr) || 0), 0)
}

/* ------------------------------------------------------------------ */
/* Large-area injury                                                   */
/* ------------------------------------------------------------------ */

/**
 * B400 Large-Area Injury: effective DR is the average of torso DR and the DR of the least protected
 * location exposed to the attack, rounding up. Locations behind cover aren't exposed.
 */
export function largeAreaDR(torsoDR: number, exposedDRs: number[]): number {
  const lowest = exposedDRs.length ? Math.min(...exposedDRs, torsoDR) : torsoDR
  return Math.ceil((torsoDR + lowest) / 2)
}

const TORSO_WOUNDING: Record<string, number> = {
  cr: 1,
  burn: 1,
  cut: 1.5,
  imp: 2,
  'pi-': 0.5,
  pi: 1,
  'pi+': 1.5,
  'pi++': 2,
  cor: 1,
  tox: 1,
  fat: 1,
}

/**
 * B400: large-area injury is treated as a torso hit (no hit-location modifiers). Gives the injury a
 * standard-rules victim would take, for the card's preview.
 */
export function largeAreaInjury(opts: { damage: number; effectiveDR: number; type: string; armorDivisor?: number }): {
  penetrating: number
  injury: number
  dr: number
} {
  const divisor =
    opts.armorDivisor === IGNORES_DR ? IGNORES_DR : opts.armorDivisor && opts.armorDivisor > 0 ? opts.armorDivisor : 1
  const dr = divisor === IGNORES_DR ? 0 : divisor === 1 ? opts.effectiveDR : Math.floor(opts.effectiveDR / divisor)
  const penetrating = Math.max(0, opts.damage - dr)
  const injury = Math.floor(penetrating * (TORSO_WOUNDING[opts.type] ?? 1))
  return { penetrating, injury, dr }
}

/* ------------------------------------------------------------------ */
/* Knockback                                                           */
/* ------------------------------------------------------------------ */

export interface Knockback {
  yards: number
  /** B378: the DX (or Acrobatics/Judo) roll to stay standing is at -1 per yard after the first. */
  rollModifier: number
}

/**
 * B378 Knockback: crushing damage knocks the target one yard away (from the blast, for an explosion)
 * per full multiple of ST-2 in basic damage, whether or not it penetrates DR; ST 3 or less means one yard
 * per point; with no ST (or not resisting) use HP. Double knockback (dkb) doubles it; nkb has none.
 */
export function knockback(opts: {
  damage: number
  type: string
  st: number | null
  hp: number
  modifiers?: string[]
}): Knockback | null {
  const mods = opts.modifiers ?? []
  if (mods.includes('nkb')) return null
  if (opts.type !== 'cr' && opts.type !== 'kb') return null
  if (!(opts.damage > 0)) return null
  const score = opts.st && opts.st > 0 ? opts.st : opts.hp
  const per = score <= 3 ? 1 : score - 2
  let yards = Math.floor(opts.damage / per)
  if (mods.includes('dkb')) yards *= 2
  if (yards <= 0) return null
  return { yards, rollModifier: -(yards - 1) }
}

/* ------------------------------------------------------------------ */
/* Scatter                                                             */
/* ------------------------------------------------------------------ */

export interface Scatter {
  yards: number
  /** 1-6 on 1d: 1 is the attacker's facing, each step 60° clockwise (B414). */
  direction: number
  /** Degrees clockwise from the attacker's facing. */
  degrees: number
}

/**
 * B414 Scatter: a missed area/explosive attack lands yards away equal to the margin of failure, at most
 * half the distance to the target (round up). If the target dodged, use his margin of success instead
 * (interpretation: the same half-distance cap applies). If the target was flying or underwater, or the
 * attacker used Artillery or Dropping on a target he can't see, the miss is the square of the margin of
 * failure (not for a dodge). Direction: 1d, 1 = the attacker's facing, 60° clockwise per step.
 */
export function scatter(opts: {
  marginOfFailure?: number
  dodgeMargin?: number
  distanceToTarget: number
  squared?: boolean
  directionRoll: number
}): Scatter {
  const direction = Math.min(6, Math.max(1, Math.trunc(opts.directionRoll) || 1))
  const cap = Math.ceil(Math.max(0, opts.distanceToTarget) / 2)
  let yards: number
  if (opts.dodgeMargin !== undefined) yards = Math.max(0, Math.trunc(opts.dodgeMargin))
  else {
    const mof = Math.max(0, Math.trunc(opts.marginOfFailure ?? 0))
    yards = opts.squared ? mof * mof : mof
  }
  yards = Math.min(yards, cap)
  return { yards, direction, degrees: (direction - 1) * 60 }
}

/** B414 Attacking an Area: +4 to hit an area of ground; no defense roll, but anyone in it may dive. */
export const AREA_ATTACK_BONUS = 4

/* ------------------------------------------------------------------ */
/* Afflictions and burning                                              */
/* ------------------------------------------------------------------ */

/**
 * A resistance roll against an area affliction: HT + modifier + bonuses (e.g. +5 each for Protected
 * Hearing and Protected Vision against a stun grenade, HT193). Success avoids the effect.
 */
export function afflictionRoll(opts: { ht: number; htModifier: number; bonus: number; roll: number }) {
  const target = opts.ht + opts.htModifier + opts.bonus
  return { target, roll: opts.roll, ...successRoll(opts.roll, target) }
}

/**
 * B434 Catching Fire: one hit of at least 3 points of basic burning damage ignites part of the victim's
 * clothing (1d-4 burn per second, -2 DX); 10+ ignites all of it (1d-1 per second, -3 DX).
 */
export function catchingFire(basicBurn: number): 'none' | 'partial' | 'all' {
  if (basicBurn >= 10) return 'all'
  if (basicBurn >= 3) return 'partial'
  return 'none'
}

/* ------------------------------------------------------------------ */
/* How big a blast (B415, HT182-186)                                    */
/* ------------------------------------------------------------------ */

/** B415 How Big a Blast?: damage is 6d × sqrt(lbs × 4 × REF), returned as a number of dice. */
export function chargeDice(pounds: number, ref: number): number {
  if (!(pounds > 0) || !(ref > 0)) return 0
  return 6 * Math.sqrt(pounds * 4 * ref)
}

/** B415 How Much Explosive?: 6d×n takes (n×n)/4 lbs of TNT; divide by the explosive's REF. */
export function poundsForDamage(multiple: number, ref = 1): number {
  if (!(multiple > 0) || !(ref > 0)) return 0
  return (multiple * multiple) / 4 / ref
}

/**
 * Express a dice count as book-style damage. Up to 11 dice: "Nd+adds" (each leftover fraction of a die
 * is worth 3.5 points, B269; 0.9 die or more rounds up to a whole die). Larger: "Nd×M" with N from 4-7,
 * choosing the closest total (ties prefer 6d, the book's usual base).
 */
export function diceFromCount(count: number): DiceExpr {
  if (!(count > 0)) return { dice: 0, adds: 0, multiplier: 1 }
  if (count < 11.5) {
    let dice = Math.floor(count)
    const frac = count - dice
    let adds = 0
    if (frac >= 0.9) dice += 1
    else adds = Math.round(frac * 3.5)
    if (dice === 0) return { dice: 1, adds: Math.round(count * 3.5) - 4, multiplier: 1 }
    return { dice, adds, multiplier: 1 }
  }
  let best: DiceExpr = { dice: 6, adds: 0, multiplier: Math.max(2, Math.round(count / 6)) }
  let bestError = Math.abs(best.dice * best.multiplier - count)
  for (const dice of [5, 4, 7]) {
    const multiplier = Math.max(2, Math.round(count / dice))
    const error = Math.abs(dice * multiplier - count)
    if (error < bestError - 1e-9) {
      best = { dice, adds: 0, multiplier }
      bestError = error
    }
  }
  return best
}
