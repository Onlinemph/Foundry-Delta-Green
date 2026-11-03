/**
 * Revised Fractional Health engine.
 *
 * Pure functions only: given the stored wound state, a new injury and the victim's traits, work out the
 * wound, its shock, the HT checks it calls for and any automatic results; given a check and a 3d6 total,
 * work out what happens. The Foundry glue (apply-damage.ts, effects.ts, chat.ts, sheet.ts) applies the
 * results to actors. The rules are in docs/agency/revised-fractional-health.md.
 */
import {
  NOT_BLEEDING,
  dismemberedBleeding,
  initialBleeding,
  isBleeding,
  bleedingModifier,
  specialBleeding,
} from './bleeding.ts'
import {
  classifyLocation,
  isHeadOrTorso,
  isHeadOrVitals,
  isLimbOrExtremity,
  largeAreaReduction,
  type LocationCategory,
  type LocationInfo,
} from './locations.ts'
import { marginOfFailure, resolveRoll, sumModifiers, type Modifier, type RollOutcome } from './rolls.ts'
import {
  BREAK,
  IMPAIRMENT,
  SHOCK,
  STUN,
  atLeast,
  isPainLevel,
  isSeverity,
  painRank,
  severityFromInjury,
  severityRank,
  shiftSeverity,
  worse,
  type PainLevel,
  type Severity,
} from './severity.ts'
import { hasHighPainThreshold, hasNoVitals, ignoresShockAndStun, type Traits } from './traits.ts'
import {
  STATE_VERSION,
  type BleedingState,
  type LimbState,
  type PainState,
  type ShockState,
  type SpecialBleed,
  type WoundRecord,
  type WoundsState,
} from './types.ts'

export * from './severity.ts'
export * from './locations.ts'
export * from './traits.ts'
export * from './rolls.ts'
export * from './bleeding.ts'
export * from './fatigue.ts'
export * from './types.ts'

const K = 'GURPS.agency.wounds'

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

export function emptyState(): WoundsState {
  return {
    version: STATE_VERSION,
    wounds: [],
    limbs: [],
    pain: null,
    impairmentTaken: null,
    shock: null,
    bleedingFP: 0,
  }
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeBleeding(raw: any): BleedingState {
  if (!raw || typeof raw !== 'object') return { ...NOT_BLEEDING }
  return {
    severity: isSeverity(raw.severity) ? raw.severity : null,
    special: raw.special === '2fp-per-second' || raw.special === '1fp-per-second' ? raw.special : null,
    consecutive: num(raw.consecutive),
    successes: num(raw.successes),
  }
}

function normalizeWound(raw: any): WoundRecord | null {
  if (!raw || typeof raw !== 'object' || !isSeverity(raw.severity)) return null
  const info = classifyLocation(String(raw.location ?? ''))
  return {
    id: String(raw.id ?? ''),
    severity: raw.severity,
    originalSeverity: isSeverity(raw.originalSeverity) ? raw.originalSeverity : raw.severity,
    location: String(raw.location ?? ''),
    category: (raw.category as LocationCategory) ?? info.category,
    limbKey: raw.limbKey ?? info.limbKey,
    leg: raw.leg === undefined ? info.leg : !!raw.leg,
    damageType: String(raw.damageType ?? ''),
    injury: num(raw.injury),
    created: num(raw.created),
    bleeding: normalizeBleeding(raw.bleeding),
    bandageAttempted: !!raw.bandageAttempted,
    bandaged: !!raw.bandaged,
    stabilizeAttempted: !!raw.stabilizeAttempted,
    stabilized: !!raw.stabilized,
    limbPenalty: !!raw.limbPenalty,
    paralysis: !!raw.paralysis,
    note: String(raw.note ?? ''),
  }
}

/** Read whatever is stored in the flag (possibly nothing, possibly an older shape) as a full state. */
export function normalizeState(raw: unknown): WoundsState {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  const r = raw as any
  const wounds = Array.isArray(r.wounds) ? r.wounds : Object.values(r.wounds ?? {})
  state.wounds = wounds.map(normalizeWound).filter((w: WoundRecord | null): w is WoundRecord => !!w && !!w.id)
  const limbs = Array.isArray(r.limbs) ? r.limbs : Object.values(r.limbs ?? {})
  state.limbs = limbs
    .filter((l: any) => l && typeof l.key === 'string' && l.key)
    .map((l: any) => ({ key: l.key, leg: !!l.leg, crippled: !!l.crippled, dismembered: !!l.dismembered }))
  if (r.pain && isPainLevel(r.pain.level))
    state.pain = {
      level: r.pain.level,
      expiresAt: r.pain.expiresAt === null || r.pain.expiresAt === undefined ? null : num(r.pain.expiresAt),
      halfMove: !!r.pain.halfMove,
    }
  state.impairmentTaken = isSeverity(r.impairmentTaken) ? r.impairmentTaken : null
  if (r.shock && num(r.shock.amount) > 0)
    state.shock = { amount: num(r.shock.amount), combatId: r.shock.combatId ?? null, round: num(r.shock.round) }
  state.bleedingFP = Math.max(0, num(r.bleedingFP))
  return state
}

function cloneState(state: WoundsState): WoundsState {
  return {
    ...state,
    wounds: state.wounds.map(w => ({ ...w, bleeding: { ...w.bleeding } })),
    limbs: state.limbs.map(l => ({ ...l })),
    pain: state.pain ? { ...state.pain } : null,
    shock: state.shock ? { ...state.shock } : null,
  }
}

export function findLimb(state: WoundsState, key: string | null | undefined): LimbState | null {
  if (!key) return null
  return state.limbs.find(l => l.key === key) ?? null
}

export function setLimb(state: WoundsState, key: string, patch: Partial<LimbState>): WoundsState {
  const next = cloneState(state)
  const existing = next.limbs.find(l => l.key === key)
  if (existing) Object.assign(existing, patch)
  else next.limbs.push({ key, leg: false, crippled: false, dismembered: false, ...patch })
  if (patch.dismembered) next.limbs.find(l => l.key === key)!.crippled = true
  return next
}

export function upsertWound(state: WoundsState, wound: WoundRecord): WoundsState {
  const next = cloneState(state)
  const index = next.wounds.findIndex(w => w.id === wound.id)
  if (index >= 0) next.wounds[index] = { ...wound, bleeding: { ...wound.bleeding } }
  else next.wounds.push({ ...wound, bleeding: { ...wound.bleeding } })
  return next
}

export function removeWound(state: WoundsState, id: string): WoundsState {
  const next = cloneState(state)
  next.wounds = next.wounds.filter(w => w.id !== id)
  if (next.wounds.length === 0) next.impairmentTaken = null
  return next
}

/** Major or worse wounds currently on a limb: each one makes the next Progressive Limb Trauma check harder. */
export function limbTraumaCount(state: WoundsState, limbKey: string): number {
  return state.wounds.filter(w => w.limbKey === limbKey && atLeast(w.severity, 'major')).length
}

/* ------------------------------------------------------------------ */
/* Pain and shock                                                     */
/* ------------------------------------------------------------------ */

/** Size of the pain penalty; High Pain Threshold halves it. Agony has no number and outweighs any shock. */
export function painMagnitude(level: PainLevel, highPainThreshold: boolean): number {
  const base = { moderate: 2, severe: 4, terrible: 6, agony: Number.POSITIVE_INFINITY }[level]
  return highPainThreshold && Number.isFinite(base) ? base / 2 : base
}

/**
 * The upstream status effect (module/effects/effects.js) that carries this pain's penalty.
 * With High Pain Threshold the halved penalties map onto upstream's -1, -2 and -3 pain statuses.
 */
export function painStatusId(level: PainLevel, highPainThreshold: boolean): string {
  if (level === 'agony') return 'agony'
  if (highPainThreshold) return { moderate: 'mild_pain', severe: 'moderate_pain', terrible: 'moderate_pain2' }[level]
  return { moderate: 'moderate_pain', severe: 'severe_pain', terrible: 'terrible_pain' }[level]
}

export const PAIN_STATUS_IDS = [
  'mild_pain',
  'moderate_pain',
  'moderate_pain2',
  'severe_pain',
  'severe_pain2',
  'terrible_pain',
  'agony',
]

export function activePain(state: WoundsState, now: number): PainState | null {
  const pain = state.pain
  if (!pain) return null
  if (pain.expiresAt !== null && pain.expiresAt <= now) return null
  return pain
}

/**
 * Combine a new bout of pain with the current one: the worse level wins; at the same level the later
 * expiry wins. Half Move and Dodge sticks if either bout came from a Major or worse wound.
 */
export function mergePain(
  current: PainState | null,
  incoming: { level: PainLevel; minutes: number | null; halfMove: boolean },
  now: number
): PainState {
  const fresh: PainState = {
    level: incoming.level,
    expiresAt: incoming.minutes === null ? null : now + Math.max(1, incoming.minutes) * 60,
    halfMove: incoming.halfMove,
  }
  if (!current || (current.expiresAt !== null && current.expiresAt <= now)) return fresh
  const halfMove = current.halfMove || fresh.halfMove
  if (painRank(fresh.level) > painRank(current.level)) return { ...fresh, halfMove }
  if (painRank(fresh.level) < painRank(current.level)) return { ...current, halfMove }
  const expiresAt =
    current.expiresAt === null || fresh.expiresAt === null ? null : Math.max(current.expiresAt, fresh.expiresAt)
  return { level: current.level, expiresAt, halfMove }
}

/**
 * Pain does not stack with shock: only the larger counts. Pain already carries its own penalty, so the
 * shock status only needs to add whatever the shock exceeds the pain by.
 */
export function effectiveShock(shock: number, pain: PainState | null, highPainThreshold: boolean): number {
  if (shock <= 0) return 0
  const magnitude = pain ? painMagnitude(pain.level, highPainThreshold) : 0
  return shock > magnitude ? Math.round(shock - magnitude) : 0
}

/** Several wounds in one turn: the victim suffers the worst shock, not the sum. */
export function mergeShock(
  current: ShockState | null,
  amount: number,
  combatId: string | null,
  round: number
): ShockState {
  if (current && current.combatId === combatId && current.round === round)
    return { ...current, amount: Math.max(current.amount, amount) }
  return { amount, combatId, round }
}

/**
 * Once out of combat for a minute adrenaline wears off and the victim automatically suffers the pain
 * of their worst wound (Moderate or worse), until it heals or the GM clears it.
 */
export function lingeringPain(state: WoundsState): { level: PainLevel; minutes: null; halfMove: boolean } | null {
  let worst: Severity | null = null
  for (const wound of state.wounds) worst = worse(worst, wound.severity)
  const row = worst ? IMPAIRMENT[worst] : undefined
  if (!row) return null
  return { level: row.pain, minutes: null, halfMove: row.halfMove }
}

/* ------------------------------------------------------------------ */
/* Assessing a new wound                                              */
/* ------------------------------------------------------------------ */

export type CheckKind = 'stun' | 'impairment' | 'limbMajor' | 'limbCritical' | 'vitals' | 'brain' | 'neck' | 'break'

export interface CheckSpec {
  id: string
  kind: CheckKind
  woundId: string | null
  severity: Severity
  location: string
  /** HT modifiers; the target is HT + their sum. */
  modifiers: Modifier[]
  /** Stun check: failure also knocks the victim down (head/vitals, or Major and worse). */
  knockdown: boolean
  /** Stun check: failure by 5 or more knocks the victim out. */
  unconsciousOnFailBy5: boolean
  /** Hard to Subdue: counts only against the unconsciousness part of the stun check. */
  unconsciousBonus: Modifier[]
  /** Impairment check: the pain a failure causes, and whether it halves Move and Dodge. */
  pain: PainLevel | null
  halfMove: boolean
  limbKey: string | null
  leg: boolean
}

export type DeathReason = 'destroyed' | 'headDestroyed' | 'decapitated' | 'brain' | 'fragile' | 'fatigue'

export type Effect =
  | { type: 'stun' }
  | { type: 'prone' }
  | { type: 'unconscious' }
  | { type: 'incapacitated' }
  | { type: 'dead'; reason: DeathReason }
  | { type: 'pain'; level: PainLevel; minutes: number | null; halfMove: boolean }
  | { type: 'crippled'; limbKey: string; leg: boolean }
  | { type: 'dismembered'; limbKey: string; leg: boolean; woundId: string | null }
  | { type: 'limbPenalty'; woundId: string }
  | { type: 'bleed'; woundId: string | null; rate: SpecialBleed }
  | { type: 'paralysis'; woundId: string | null }

export interface WoundInput {
  id: string
  /** Injury after DR and wounding modifiers. Ignored when `severity` is given. */
  injury: number | null
  /** Record a wound of this severity directly (GM entry). */
  severity?: Severity | null
  maxHP: number
  location: string
  /** Hit location role from the body plan ('limb', 'extremity', 'chest', 'groin'). */
  role?: string | null
  damageType: string
  /** Large-area injury (B400): severity is reduced for the head, limbs and extremities. */
  largeArea?: boolean
  /** Area effect, cone or explosion: Injury Tolerance (Diffuse) does not cap the wound at Minor. */
  areaAttack?: boolean
  /** In an emergency (combat). Outside one the impairment roll is at -3. */
  emergency: boolean
  created: number
  trackMinorBleeding?: boolean
}

export type SkipReason = 'belowScratch' | 'reducedAway' | 'crushingScratch' | 'crushingMinor' | 'dismembered' | null

export interface Assessment {
  id: string
  location: string
  category: LocationCategory
  damageType: string
  injury: number | null
  baseSeverity: Severity | null
  severity: Severity | null
  largeAreaReduction: number
  cappedByDiffuse: boolean
  recorded: boolean
  skipReason: SkipReason
  shock: number
  checks: CheckSpec[]
  effects: Effect[]
  /** Localization keys for things worth telling the table. */
  notes: string[]
}

export interface RandomSource {
  /** Uniform in [0, 1); used for "GM's option, or roll randomly". */
  random?: () => number
}

function locationFor(input: WoundInput, traits: Traits): LocationInfo {
  const info = classifyLocation(input.location, input.role)
  if (!hasNoVitals(traits)) return info
  // Homogeneous and diffuse bodies have no vitals or brain: treat those hits as torso and face hits.
  return {
    ...info,
    category: info.category === 'vitals' ? 'torso' : info.category,
    brain: false,
  }
}

function newCheck(
  input: WoundInput,
  info: LocationInfo,
  severity: Severity,
  woundId: string | null,
  kind: CheckKind,
  modifiers: Modifier[],
  extra: Partial<CheckSpec> = {}
): CheckSpec {
  return {
    id: `${input.id}:${kind}`,
    kind,
    woundId,
    severity,
    location: info.where,
    modifiers: modifiers.filter(m => m.value !== 0),
    knockdown: false,
    unconsciousOnFailBy5: false,
    unconsciousBonus: [],
    pain: null,
    halfMove: false,
    limbKey: info.limbKey,
    leg: info.leg,
    ...extra,
  }
}

function hardToSubdue(traits: Traits): Modifier[] {
  return traits.hardToSubdue ? [{ value: traits.hardToSubdue, label: `${K}.mod.hardToSubdue` }] : []
}

function hardToKill(traits: Traits): Modifier[] {
  return traits.hardToKill ? [{ value: traits.hardToKill, label: `${K}.mod.hardToKill` }] : []
}

/**
 * Work out a new wound: its severity, whether it is recorded, its shock, the HT checks it calls for
 * and any automatic results. Returns the state with the wound recorded and automatic results applied.
 */
export function assessWound(
  state: WoundsState,
  input: WoundInput,
  traits: Traits,
  options: RandomSource = {}
): { state: WoundsState; assessment: Assessment } {
  const random = options.random ?? Math.random
  const info = locationFor(input, traits)
  const assessment: Assessment = {
    id: input.id,
    location: info.where,
    category: info.category,
    damageType: input.damageType,
    injury: input.injury,
    baseSeverity: null,
    severity: null,
    largeAreaReduction: 0,
    cappedByDiffuse: false,
    recorded: false,
    skipReason: null,
    shock: 0,
    checks: [],
    effects: [],
    notes: [],
  }

  // A dismembered limb can take no further damage.
  if (isLimbOrExtremity(info) && findLimb(state, info.limbKey)?.dismembered) {
    assessment.skipReason = 'dismembered'
    return { state, assessment }
  }

  const base = input.severity ?? severityFromInjury(input.injury ?? 0, input.maxHP)
  assessment.baseSeverity = base
  if (!base) {
    assessment.skipReason = 'belowScratch'
    return { state, assessment }
  }

  let severity: Severity | null = base
  if (input.largeArea) {
    assessment.largeAreaReduction = largeAreaReduction(info)
    severity = shiftSeverity(base, -assessment.largeAreaReduction)
  }
  if (!severity) {
    assessment.skipReason = 'reducedAway'
    return { state, assessment }
  }
  if (
    traits.injuryTolerance === 'diffuse' &&
    !input.areaAttack &&
    !input.largeArea &&
    severityRank(severity) > severityRank('minor')
  ) {
    severity = 'minor'
    assessment.cappedByDiffuse = true
  }
  assessment.severity = severity

  // Crushing Scratches, and Minor wounds from crushing (blunt) attacks, are not recorded. Their shock still counts.
  const crushingSkip = input.damageType === 'cr' && (severity === 'scratch' || severity === 'minor')
  if (crushingSkip) assessment.skipReason = severity === 'scratch' ? 'crushingScratch' : 'crushingMinor'
  assessment.recorded = !crushingSkip
  const woundId = assessment.recorded ? input.id : null

  let next = cloneState(state)
  const unfeeling = ignoresShockAndStun(traits)
  assessment.shock = unfeeling || severity === 'destroyed' ? 0 : SHOCK[severity]
  if (unfeeling) assessment.notes.push(`${K}.note.injuryTolerance`)

  const checks: CheckSpec[] = []
  const effects: Effect[] = []

  if (severity === 'destroyed') {
    effects.push({ type: 'dead', reason: 'destroyed' })
  } else {
    // Stunning (and knockdown for blows to the head or vitals, and for Major and worse wounds).
    const stun = STUN[severity]
    if (stun && !unfeeling) {
      const headOrVitals = isHeadOrVitals(info)
      const knockdown = headOrVitals || atLeast(severity, 'major')
      checks.push(
        newCheck(
          input,
          info,
          severity,
          woundId,
          'stun',
          [
            {
              value: headOrVitals ? stun.headOrVitals : stun.normal,
              label: headOrVitals ? `${K}.mod.stunHeadVitals` : `${K}.mod.stun`,
            },
          ],
          {
            knockdown,
            unconsciousOnFailBy5: headOrVitals || atLeast(severity, 'major'),
            unconsciousBonus: hardToSubdue(traits),
          }
        )
      )
    }

    // Impairment: only for a wound worse than any already rolled for, or any Critical or worse wound.
    const impairment = IMPAIRMENT[severity]
    const taken = next.impairmentTaken
    if (
      impairment &&
      !unfeeling &&
      (taken === null || severityRank(severity) > severityRank(taken) || atLeast(severity, 'critical'))
    ) {
      checks.push(
        newCheck(
          input,
          info,
          severity,
          woundId,
          'impairment',
          [
            { value: impairment.modifier, label: `${K}.mod.impairment` },
            ...(input.emergency ? [] : [{ value: -3, label: `${K}.mod.notEmergency` }]),
            ...(hasHighPainThreshold(traits) ? [{ value: 2, label: `${K}.mod.highPainThreshold` }] : []),
            ...hardToSubdue(traits),
          ],
          { pain: impairment.pain, halfMove: impairment.halfMove }
        )
      )
      next.impairmentTaken = worse(taken, severity)
    } else if (impairment && !unfeeling) {
      assessment.notes.push(`${K}.note.noNewImpairment`)
    }

    // Progressive Limb Trauma replaces automatic crippling and dismemberment.
    if (isLimbOrExtremity(info) && info.limbKey && atLeast(severity, 'major')) {
      const previous = limbTraumaCount(next, info.limbKey)
      if (severity === 'major') {
        checks.push(
          newCheck(input, info, severity, woundId, 'limbMajor', [
            { value: -2, label: `${K}.mod.limbMajor` },
            { value: -2 * previous, label: `${K}.mod.previousLimbWounds` },
          ])
        )
      } else {
        const crippled = !!findLimb(next, info.limbKey)?.crippled
        checks.push(
          newCheck(input, info, severity, woundId, 'limbCritical', [
            { value: -5, label: `${K}.mod.limbCritical` },
            { value: -3 * previous, label: `${K}.mod.previousLimbWounds` },
            { value: crippled ? -3 : 0, label: `${K}.mod.alreadyCrippled` },
          ])
        )
      }
    }

    // Critical wounds to the vitals, brain and neck.
    if (severity === 'critical') {
      if (info.category === 'vitals')
        checks.push(newCheck(input, info, severity, woundId, 'vitals', [{ value: -2, label: `${K}.mod.vitals` }]))
      if (info.brain)
        checks.push(
          newCheck(input, info, severity, woundId, 'brain', [
            { value: -3, label: `${K}.mod.brain` },
            ...hardToKill(traits),
          ])
        )
      if (info.category === 'neck')
        checks.push(
          newCheck(input, info, severity, woundId, 'neck', [
            { value: info.vein ? -5 : -3, label: info.vein ? `${K}.mod.neckVein` : `${K}.mod.neck` },
          ])
        )
    }

    // Massive and Gawdawful: the head is destroyed outright, a vital organ is destroyed, and the body may break.
    if (atLeast(severity, 'massive')) {
      if (info.category === 'head' || info.category === 'neck') effects.push({ type: 'dead', reason: 'headDestroyed' })
      else if (info.category === 'vitals')
        effects.push(
          random() < 0.5 ? { type: 'bleed', woundId, rate: '2fp-per-second' } : { type: 'paralysis', woundId }
        )
      checks.push(
        newCheck(input, info, severity, woundId, 'break', [{ value: BREAK[severity] ?? -5, label: `${K}.mod.break` }])
      )
    }

    // Three Critical (or worse) cutting wounds to the neck: decapitation.
    if (info.category === 'neck' && input.damageType === 'cut' && atLeast(severity, 'critical')) {
      const previous = next.wounds.filter(
        w => w.category === 'neck' && w.damageType === 'cut' && atLeast(w.severity, 'critical')
      ).length
      if (previous + 1 >= 3) effects.push({ type: 'dead', reason: 'decapitated' })
    }

    if (traits.fragileUnnatural && atLeast(severity, 'critical') && isHeadOrTorso(info))
      effects.push({ type: 'dead', reason: 'fragile' })

    if (severity === 'gawdawful') assessment.notes.push(`${K}.note.gawdawful`)
  }

  // Death makes every other roll moot.
  assessment.effects = effects
  assessment.checks = effects.some(e => e.type === 'dead') ? [] : checks

  if (assessment.recorded) next.wounds.push(newWoundRecord(input, severity, traits))

  next = applyEffects(next, effects, input.created)
  return { state: next, assessment }
}

/** A fresh wound record (also used when the GM records a wound by hand, without consequences). */
export function newWoundRecord(input: WoundInput, severity: Severity, traits: Traits): WoundRecord {
  const info = locationFor(input, traits)
  return {
    id: input.id,
    severity,
    originalSeverity: severity,
    location: info.where,
    category: info.category,
    limbKey: info.limbKey,
    leg: info.leg,
    damageType: input.damageType,
    injury: input.injury ?? 0,
    created: input.created,
    bleeding: initialBleeding(severity, input.damageType, {
      trackMinor: !!input.trackMinorBleeding,
      hemophilia: traits.hemophilia,
    }),
    bandageAttempted: false,
    bandaged: false,
    stabilizeAttempted: false,
    stabilized: false,
    limbPenalty: false,
    paralysis: false,
    note: '',
  }
}

/**
 * Several wounds from one application of damage (rapid fire, a large-area injury) call for one stun roll,
 * not one per wound: keep the hardest stun check, with knockdown and unconsciousness if any wound called
 * for them. Other checks are kept as they are.
 */
export function mergeStunChecks(checks: readonly CheckSpec[]): CheckSpec[] {
  const stuns = checks.filter(c => c.kind === 'stun')
  if (stuns.length <= 1) return [...checks]
  const hardest = stuns.reduce((a, b) => (sumModifiers(b.modifiers) < sumModifiers(a.modifiers) ? b : a))
  const merged: CheckSpec = {
    ...hardest,
    knockdown: stuns.some(c => c.knockdown),
    unconsciousOnFailBy5: stuns.some(c => c.unconsciousOnFailBy5),
  }
  const result: CheckSpec[] = []
  let placed = false
  for (const check of checks) {
    if (check.kind !== 'stun') result.push(check)
    else if (!placed) {
      result.push(merged)
      placed = true
    }
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Resolving checks                                                   */
/* ------------------------------------------------------------------ */

export interface CheckResolution {
  roll: RollOutcome
  /** Stun checks: the same dice judged with Hard to Subdue for the unconsciousness part. */
  unconsciousRoll: RollOutcome | null
  effects: Effect[]
  /** Localization key summarizing the result. */
  result: string
}

export function checkTarget(check: CheckSpec, ht: number): number {
  return ht + sumModifiers(check.modifiers)
}

/** Resolve a check from a 3d6 total and apply its results to the state. */
export function resolveCheck(
  state: WoundsState,
  check: CheckSpec,
  total: number,
  ht: number,
  worldTime: number,
  options: RandomSource = {}
): { state: WoundsState; resolution: CheckResolution } {
  const random = options.random ?? Math.random
  const roll = resolveRoll(total, checkTarget(check, ht))
  const failedBy = marginOfFailure(roll)
  const effects: Effect[] = []
  let unconsciousRoll: RollOutcome | null = null
  let result = `${K}.result.passed`

  switch (check.kind) {
    case 'stun': {
      if (roll.success) {
        result = `${K}.result.stunResisted`
        break
      }
      if (check.unconsciousOnFailBy5) {
        unconsciousRoll = resolveRoll(total, roll.target + sumModifiers(check.unconsciousBonus))
        if (marginOfFailure(unconsciousRoll) >= 5) {
          effects.push({ type: 'unconscious' }, { type: 'prone' })
          result = `${K}.result.knockedOut`
          break
        }
      }
      effects.push({ type: 'stun' })
      if (check.knockdown) effects.push({ type: 'prone' })
      result = check.knockdown ? `${K}.result.knockedDown` : `${K}.result.stunned`
      break
    }
    case 'impairment': {
      if (roll.success || !check.pain) {
        result = `${K}.result.noPain`
        break
      }
      const level: PainLevel = failedBy >= 5 ? 'agony' : check.pain
      effects.push({ type: 'pain', level, minutes: Math.max(1, failedBy), halfMove: check.halfMove })
      result = `${K}.result.pain.${level}`
      break
    }
    case 'limbMajor': {
      if (!check.limbKey) break
      if (roll.success) {
        if (check.woundId) effects.push({ type: 'limbPenalty', woundId: check.woundId })
        result = `${K}.result.limbHolds`
      } else {
        effects.push({ type: 'crippled', limbKey: check.limbKey, leg: check.leg })
        result = `${K}.result.crippled`
      }
      break
    }
    case 'limbCritical': {
      if (!check.limbKey) break
      if (roll.success) {
        effects.push({ type: 'crippled', limbKey: check.limbKey, leg: check.leg })
        result = `${K}.result.crippledNotLost`
      } else {
        effects.push({ type: 'dismembered', limbKey: check.limbKey, leg: check.leg, woundId: check.woundId })
        result = `${K}.result.dismembered`
      }
      break
    }
    case 'vitals': {
      if (roll.success) break
      if (random() < 0.5) {
        effects.push({ type: 'bleed', woundId: check.woundId, rate: '2fp-per-second' })
        result = `${K}.result.vitalsBleeding`
      } else {
        effects.push({ type: 'paralysis', woundId: check.woundId })
        result = `${K}.result.paralysis`
      }
      break
    }
    case 'brain': {
      if (roll.success) break
      effects.push({ type: 'dead', reason: 'brain' })
      result = `${K}.result.dead`
      break
    }
    case 'neck': {
      if (roll.success) break
      if (random() < 0.5) {
        effects.push({ type: 'paralysis', woundId: check.woundId })
        result = `${K}.result.paralysis`
      } else {
        effects.push({ type: 'bleed', woundId: check.woundId, rate: '1fp-per-second' })
        result = `${K}.result.neckBleeding`
      }
      break
    }
    case 'break': {
      if (roll.success) break
      effects.push({ type: 'incapacitated' }, { type: 'bleed', woundId: check.woundId, rate: '2fp-per-second' })
      result = `${K}.result.broken`
      break
    }
  }

  return {
    state: applyEffects(state, effects, worldTime),
    resolution: { roll, unconsciousRoll, effects, result },
  }
}

/** Fold the state-changing results (limbs, pain, wound details) into the state. Statuses are the glue's job. */
export function applyEffects(state: WoundsState, effects: readonly Effect[], worldTime: number): WoundsState {
  let next = cloneState(state)
  const wound = (id: string | null) => (id ? next.wounds.find(w => w.id === id) : undefined)
  for (const effect of effects) {
    switch (effect.type) {
      case 'crippled':
        next = setLimb(next, effect.limbKey, { crippled: true, leg: effect.leg })
        break
      case 'dismembered': {
        next = setLimb(next, effect.limbKey, { crippled: true, dismembered: true, leg: effect.leg })
        const w = wound(effect.woundId)
        if (w) w.bleeding = { ...dismemberedBleeding(), special: w.bleeding.special }
        break
      }
      case 'limbPenalty': {
        const w = wound(effect.woundId)
        if (w) w.limbPenalty = true
        break
      }
      case 'bleed': {
        const w = wound(effect.woundId)
        if (w) w.bleeding = specialBleeding(w.bleeding, effect.rate)
        break
      }
      case 'paralysis': {
        const w = wound(effect.woundId)
        if (w) w.paralysis = true
        break
      }
      case 'pain':
        next.pain = mergePain(next.pain, effect, worldTime)
        break
    }
  }
  return next
}

/* ------------------------------------------------------------------ */
/* What the wounds add up to                                          */
/* ------------------------------------------------------------------ */

export interface DerivedStatus {
  worst: Severity | null
  count: number
  pain: PainState | null
  /** Half Move and Dodge: impaired by a Major+ wound, a Major+ wound or crippled/lost leg, or any Gawdawful wound. */
  halfMoveDodge: boolean
  /** -1 DX per Gawdawful wound. */
  gawdawful: number
  bleeding: boolean
  /** Limb key -> number of wounds giving -1 to tasks with that limb. */
  limbPenalties: Record<string, number>
}

export function deriveStatus(state: WoundsState, now: number): DerivedStatus {
  let worst: Severity | null = null
  let gawdawful = 0
  const limbPenalties: Record<string, number> = {}
  for (const w of state.wounds) {
    worst = worse(worst, w.severity)
    if (w.severity === 'gawdawful') gawdawful++
    if (w.limbPenalty && w.limbKey) limbPenalties[w.limbKey] = (limbPenalties[w.limbKey] ?? 0) + 1
  }
  const pain = activePain(state, now)
  const halfMoveDodge =
    !!pain?.halfMove ||
    gawdawful > 0 ||
    state.limbs.some(l => l.leg && (l.crippled || l.dismembered)) ||
    state.wounds.some(w => w.leg && atLeast(w.severity, 'major'))
  return {
    worst,
    count: state.wounds.length,
    pain,
    halfMoveDodge,
    gawdawful,
    bleeding: state.wounds.some(w => isBleeding(w.bleeding)),
    limbPenalties,
  }
}

/* ------------------------------------------------------------------ */
/* Bleeding checks and recovery                                       */
/* ------------------------------------------------------------------ */

/** HT modifiers for a wound's bleeding roll: the table modifier plus Hard to Kill. */
export function bleedingModifiers(severity: Severity, traits: Traits): Modifier[] {
  return [{ value: bleedingModifier(severity), label: `${K}.mod.bleeding` }, ...hardToKill(traits)].filter(
    m => m.value !== 0
  )
}

export interface RecoveryOptions {
  /** Without sufficient rest, food and water: -4. */
  noRest: boolean
  /** Under the care of a competent healer: +1. */
  underCare: boolean
  /** Rapid Healing: +5, as for any HT roll to recover (B79). */
  rapidHealing: boolean
}

export function recoveryModifiers(options: RecoveryOptions): Modifier[] {
  const result: Modifier[] = []
  if (options.noRest) result.push({ value: -4, label: `${K}.mod.noRest` })
  if (options.underCare) result.push({ value: 1, label: `${K}.mod.underCare` })
  if (options.rapidHealing) result.push({ value: 5, label: `${K}.mod.rapidHealing` })
  return result
}

/**
 * Weekly recovery: each wound whose HT roll succeeded drops one severity level; a Scratch that heals is gone.
 * The -1 limb penalty from Progressive Limb Trauma ends once the wound is below Major. Crippling stays
 * until the GM clears it.
 */
export function applyRecovery(
  state: WoundsState,
  results: readonly { woundId: string; success: boolean }[]
): { state: WoundsState; healed: string[]; improved: string[] } {
  let next = cloneState(state)
  const healed: string[] = []
  const improved: string[] = []
  for (const { woundId, success } of results) {
    if (!success) continue
    const wound = next.wounds.find(w => w.id === woundId)
    if (!wound) continue
    const lower = shiftSeverity(wound.severity, -1)
    if (!lower) {
      next = removeWound(next, woundId)
      healed.push(woundId)
      continue
    }
    wound.severity = lower
    if (!atLeast(lower, 'major')) wound.limbPenalty = false
    if (wound.bleeding.severity && severityRank(wound.bleeding.severity) > severityRank(lower))
      wound.bleeding = { ...wound.bleeding, severity: lower, consecutive: 0 }
    improved.push(woundId)
  }
  // Lingering pain (no expiry: adrenaline has worn off) follows the worst wound as it heals.
  if (next.pain && next.pain.expiresAt === null) {
    const lingering = lingeringPain(next)
    next.pain = lingering ? { level: lingering.level, expiresAt: null, halfMove: lingering.halfMove } : null
  }
  return { state: next, healed, improved }
}
