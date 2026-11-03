/**
 * Revised Fractional Health: wound severity bands and the per-severity tables.
 *
 * Everything here is pure data or pure functions so it can be unit tested without Foundry.
 * The house rules live in docs/agency/revised-fractional-health.md.
 */

export const SEVERITIES = [
  'scratch',
  'minor',
  'moderate',
  'major',
  'critical',
  'massive',
  'gawdawful',
  'destroyed',
] as const

export type Severity = (typeof SEVERITIES)[number]

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)
}

/** 0 for a Scratch up to 7 for Destroyed. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

export function atLeast(severity: Severity | null | undefined, min: Severity): boolean {
  return !!severity && severityRank(severity) >= severityRank(min)
}

export function worse(a: Severity | null | undefined, b: Severity | null | undefined): Severity | null {
  if (!a) return b ?? null
  if (!b) return a
  return severityRank(a) >= severityRank(b) ? a : b
}

/**
 * Move a severity up or down the ladder. Going below a Scratch returns null (the wound is gone or ignored);
 * going above Destroyed stays at Destroyed.
 */
export function shiftSeverity(severity: Severity, delta: number): Severity | null {
  const rank = severityRank(severity) + delta
  if (rank < 0) return null
  return SEVERITIES[Math.min(rank, SEVERITIES.length - 1)]
}

/**
 * Lower edge of each band as a fraction of max HP, written numerator/denominator so the comparison
 * `injury * denominator >= maxHP * numerator` stays exact for any integer HP.
 *
 * Each band is "this fraction or more, but less than the next one". The house rules word the two
 * top bands loosely ("over 4 x HP but not over 8 x HP" against "2 x HP or more but less than 4 x HP"
 * and "8 x HP or more"), which would leave exactly 4 x HP in no band; we use the "or more" reading
 * everywhere, so exactly 4 x HP is Gawdawful and exactly 8 x HP is Destroyed.
 *
 * Exactly 1/16 HP is a Scratch: the rules say to ignore damage *less than* 1/16 HP.
 */
const LOWER_EDGES: ReadonlyArray<readonly [Severity, number, number]> = [
  ['destroyed', 8, 1],
  ['gawdawful', 4, 1],
  ['massive', 2, 1],
  ['critical', 1, 1],
  ['major', 1, 2],
  ['moderate', 1, 4],
  ['minor', 1, 8],
  ['scratch', 1, 16],
]

/** Max HP below 1 is treated as 1 so that a 0-HP thing is not destroyed by every point of injury. */
export function effectiveMaxHP(maxHP: number): number {
  return Number.isFinite(maxHP) && maxHP >= 1 ? maxHP : 1
}

/**
 * The wound severity for an amount of injury (after DR and wounding multipliers).
 * Returns null when the injury is below 1/16 of max HP, which the rules say to ignore.
 */
export function severityFromInjury(injury: number, maxHP: number): Severity | null {
  if (!Number.isFinite(injury) || injury <= 0) return null
  const hp = effectiveMaxHP(maxHP)
  for (const [severity, numerator, denominator] of LOWER_EDGES) {
    if (injury * denominator >= hp * numerator) return severity
  }
  return null
}

/**
 * The smallest whole number of injury points that reaches each band, for tooltips.
 * Bands that whole points skip entirely (possible with very small HP) are left out.
 */
export function severityThresholds(maxHP: number): { severity: Severity; injury: number }[] {
  const hp = effectiveMaxHP(maxHP)
  const result: { severity: Severity; injury: number }[] = []
  for (const [severity, numerator, denominator] of [...LOWER_EDGES].reverse()) {
    const injury = Math.max(1, Math.ceil((hp * numerator) / denominator))
    if (severityFromInjury(injury, hp) === severity) result.push({ severity, injury })
  }
  return result
}

/** Shock penalty to DX and IQ on the victim's next turn. */
export const SHOCK: Record<Severity, number> = {
  scratch: 1,
  minor: 2,
  moderate: 3,
  major: 4,
  critical: 5,
  massive: 6,
  gawdawful: 7,
  destroyed: 0,
}

/** HT modifier to avoid stunning, for ordinary hits and for hits to the head or vitals. */
export const STUN: Partial<Record<Severity, { normal: number; headOrVitals: number }>> = {
  minor: { normal: 0, headOrVitals: -1 },
  moderate: { normal: -1, headOrVitals: -2 },
  major: { normal: -2, headOrVitals: -5 },
  critical: { normal: -3, headOrVitals: -6 },
  massive: { normal: -4, headOrVitals: -7 },
  gawdawful: { normal: -5, headOrVitals: -8 },
}

export type PainLevel = 'moderate' | 'severe' | 'terrible' | 'agony'

export const PAIN_LEVELS: readonly PainLevel[] = ['moderate', 'severe', 'terrible', 'agony']

export function isPainLevel(value: unknown): value is PainLevel {
  return typeof value === 'string' && (PAIN_LEVELS as readonly string[]).includes(value)
}

export function painRank(level: PainLevel): number {
  return PAIN_LEVELS.indexOf(level)
}

/** Impairment roll modifier and the pain condition a failed roll causes. Major and worse also halve Move and Dodge. */
export const IMPAIRMENT: Partial<Record<Severity, { modifier: number; pain: PainLevel; halfMove: boolean }>> = {
  moderate: { modifier: 0, pain: 'moderate', halfMove: false },
  major: { modifier: -1, pain: 'severe', halfMove: true },
  critical: { modifier: -2, pain: 'terrible', halfMove: true },
  massive: { modifier: -3, pain: 'terrible', halfMove: true },
  gawdawful: { modifier: -4, pain: 'agony', halfMove: true },
}

/** HT modifier for the "break" check on Massive and Gawdawful wounds. */
export const BREAK: Partial<Record<Severity, number>> = {
  massive: -3,
  gawdawful: -5,
}

/** FP lost to fatigue-type damage, by the severity the damage would have caused. */
export const FATIGUE_FOR_SEVERITY: Record<Severity, number> = {
  scratch: 0,
  minor: 1,
  moderate: 2,
  major: 5,
  critical: 10,
  massive: 20,
  gawdawful: 40,
  destroyed: 80,
}

/** Bleeding: 1 FP lost every `seconds`, and the HT modifier to avoid it. */
export const BLEEDING: Partial<Record<Severity, { seconds: number; modifier: number }>> = {
  scratch: { seconds: 86400, modifier: 1 },
  minor: { seconds: 6 * 3600, modifier: 0 },
  moderate: { seconds: 3600, modifier: -1 },
  major: { seconds: 600, modifier: -2 },
  critical: { seconds: 120, modifier: -3 },
  massive: { seconds: 30, modifier: -4 },
  gawdawful: { seconds: 5, modifier: -5 },
}

/** First Aid (bandage, stabilize) and Surgery penalties by wound severity. */
export function treatmentPenalty(severity: Severity): number {
  switch (severity) {
    case 'critical':
      return -2
    case 'massive':
      return -4
    case 'gawdawful':
    case 'destroyed':
      return -6
    default:
      return 0
  }
}

/** How often a competent healer may roll to help recovery, by TL (in days). */
export function healerRollIntervalDays(tl: number): number {
  if (tl <= 3) return 30
  if (tl === 4) return 21
  if (tl === 5) return 14
  if (tl <= 8) return 7
  if (tl === 9) return 3
  if (tl === 10) return 2
  if (tl === 11) return 1
  return 0.5
}
