/**
 * Agency sanity: pure game logic (no Foundry globals), so it can be unit tested.
 *
 * Delta Green's SAN rules adapted to GURPS:
 *  - POW maps to Will. Starting SAN = Will × multiplier (default 5), Breaking Point = SAN − Will.
 *  - Max SAN = 99 − Unnatural.
 *  - SAN loss notation "success/failure", e.g. "0/1d6", "1/1d4+1", "1d6/1d20".
 *  - SAN at or below the Breaking Point: gain a disorder, Breaking Point resets to SAN − Will.
 *  - Losing 5+ SAN from one roll: temporary insanity.
 *  - Projecting onto a Bond: reduce the loss by 1d4, the Bond loses the 1d4.
 *  - Violence/Helplessness adaptation: 3 losses from the category and the character is adapted
 *    (no further loss from it); on adapting every Bond loses 1.
 */

export const SAN_CEILING = 99
export const ADAPTATION_BOXES = 3
export const TEMPORARY_INSANITY_LOSS = 5
export const DEFAULT_SAN_MULTIPLIER = 5
/** GURPS Rule of 14: a Fright Check target can never exceed 13 (B360). */
export const FRIGHT_CHECK_CAP = 13

export const SAN_CATEGORIES = ['none', 'violence', 'helplessness', 'unnatural'] as const
export type SanCategory = (typeof SAN_CATEGORIES)[number]
export type AdaptableCategory = 'violence' | 'helplessness'
export const ADAPTABLE_CATEGORIES: readonly AdaptableCategory[] = ['violence', 'helplessness']

export interface Bond {
  id: string
  name: string
  score: number
}

export interface Disorder {
  id: string
  name: string
}

export type Adaptation = Record<AdaptableCategory, number>

/** Shape of actor.system.sanity (see template.json). */
export interface SanityData {
  value: number
  max: number
  breakingPoint: number
  unnatural: number
  initialized: boolean
  bonds: Bond[]
  disorders: Disorder[]
  adaptation: Adaptation
}

/** One side of a SAN loss notation: NdS+M, or a constant when dice is 0. */
export interface LossExpr {
  dice: number
  sides: number
  mod: number
}

export interface SanLoss {
  success: LossExpr
  failure: LossExpr
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? Math.round(n) : fallback
}

export function clampInt(value: unknown, min: number, max: number): number {
  return Math.min(max, Math.max(min, toInt(value, min)))
}

function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  // Foundry turns arrays into {0: …, 1: …} if someone updates an index path; accept both.
  if (value && typeof value === 'object') return Object.values(value)
  return []
}

export function isAdaptable(category: SanCategory): category is AdaptableCategory {
  return category === 'violence' || category === 'helplessness'
}

// ---------------------------------------------------------------------------------------------
// Data normalisation and initialisation
// ---------------------------------------------------------------------------------------------

export function defaultSanity(): SanityData {
  return {
    value: 0,
    max: SAN_CEILING,
    breakingPoint: 0,
    unnatural: 0,
    initialized: false,
    bonds: [],
    disorders: [],
    adaptation: { violence: 0, helplessness: 0 },
  }
}

/** Coerce whatever is stored in system.sanity into a well-formed SanityData (never throws). */
export function normalizeSanity(raw: unknown): SanityData {
  const base = defaultSanity()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, any>
  const unnatural = clampInt(r.unnatural ?? 0, 0, SAN_CEILING)
  const max = clampInt(r.max ?? SAN_CEILING - unnatural, 0, SAN_CEILING)
  return {
    value: clampInt(r.value ?? 0, 0, SAN_CEILING),
    max,
    breakingPoint: clampInt(r.breakingPoint ?? 0, 0, SAN_CEILING),
    unnatural,
    initialized: !!r.initialized,
    bonds: toList(r.bonds)
      .filter(b => b && typeof b === 'object')
      .map((b: any, i) => ({
        id: String(b.id || `bond${i}`),
        name: String(b.name ?? ''),
        score: Math.max(0, toInt(b.score, 0)),
      })),
    disorders: toList(r.disorders)
      .filter(d => d !== null && d !== undefined)
      .map((d: any, i) =>
        typeof d === 'object'
          ? { id: String(d.id || `disorder${i}`), name: String(d.name ?? '') }
          : { id: `disorder${i}`, name: String(d) }
      ),
    adaptation: {
      violence: clampInt(r.adaptation?.violence ?? 0, 0, ADAPTATION_BOXES),
      helplessness: clampInt(r.adaptation?.helplessness ?? 0, 0, ADAPTATION_BOXES),
    },
  }
}

export function cloneSanity(s: SanityData): SanityData {
  return {
    ...s,
    bonds: s.bonds.map(b => ({ ...b })),
    disorders: s.disorders.map(d => ({ ...d })),
    adaptation: { ...s.adaptation },
  }
}

export function maxSanity(unnatural: number): number {
  return clampInt(SAN_CEILING - clampInt(unnatural, 0, SAN_CEILING), 0, SAN_CEILING)
}

export function startingSanity(will: number, multiplier: number, unnatural = 0): number {
  const mult = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : DEFAULT_SAN_MULTIPLIER
  return clampInt(toInt(will, 10) * mult, 0, maxSanity(unnatural))
}

/** Breaking Point after a reset: current SAN − Will, never below 0. */
export function nextBreakingPoint(san: number, will: number): number {
  return Math.max(0, toInt(san) - toInt(will))
}

/**
 * Fill in SAN for an actor that has never had it set (template defaults are value 0 / BP 0).
 * Values someone already entered (e.g. via the token bar) are kept.
 */
export function initialSanity(current: SanityData, will: number, multiplier: number): SanityData {
  const s = cloneSanity(current)
  const ceiling = maxSanity(s.unnatural)
  s.max = s.max > 0 ? Math.min(s.max, ceiling) : ceiling
  s.value = s.value > 0 ? Math.min(s.value, s.max) : Math.min(startingSanity(will, multiplier, s.unnatural), s.max)
  s.breakingPoint = s.breakingPoint > 0 ? s.breakingPoint : nextBreakingPoint(s.value, will)
  s.initialized = true
  return s
}

export function bondStartingScore(will: number, setting: number): number {
  const fixed = toInt(setting, 0)
  return Math.max(0, fixed > 0 ? fixed : toInt(will, 10))
}

// ---------------------------------------------------------------------------------------------
// SAN loss notation
// ---------------------------------------------------------------------------------------------

const LOSS_EXPR = /^(?:(\d*)d(\d+)(?:([+-])(\d+))?|(\d+))$/i

export function parseLossExpr(text: string): LossExpr | null {
  const t = String(text ?? '')
    .replace(/[−–]/g, '-')
    .replace(/\s+/g, '')
  const m = t.match(LOSS_EXPR)
  if (!m) return null
  if (m[5] !== undefined) {
    const mod = parseInt(m[5], 10)
    return mod > 1000 ? null : { dice: 0, sides: 0, mod }
  }
  const dice = m[1] === '' ? 1 : parseInt(m[1], 10)
  const sides = parseInt(m[2], 10)
  if (dice < 1 || dice > 100 || sides < 1 || sides > 1000) return null
  const mod = m[3] ? (m[3] === '-' ? -1 : 1) * parseInt(m[4], 10) : 0
  return { dice, sides, mod }
}

/** Parse "success/failure" SAN loss notation such as "0/1d6", "1/1d4+1" or "1d6/1d20". */
export function parseSanLoss(text: string): SanLoss | null {
  const parts = String(text ?? '').split('/')
  if (parts.length !== 2) return null
  const success = parseLossExpr(parts[0])
  const failure = parseLossExpr(parts[1])
  if (!success || !failure) return null
  return { success, failure }
}

export function formatLossExpr(e: LossExpr): string {
  if (e.dice === 0) return String(e.mod)
  const mod = e.mod > 0 ? `+${e.mod}` : e.mod < 0 ? `${e.mod}` : ''
  return `${e.dice}d${e.sides}${mod}`
}

export function formatSanLoss(loss: SanLoss): string {
  return `${formatLossExpr(loss.success)}/${formatLossExpr(loss.failure)}`
}

export function isConstant(e: LossExpr): boolean {
  return e.dice === 0
}

export function lossRange(e: LossExpr): { min: number; max: number } {
  return { min: Math.max(0, e.dice + e.mod), max: Math.max(0, e.dice * e.sides + e.mod) }
}

/** Roll a loss expression with an injectable die roller (returns 1..sides). Never negative. */
export function rollLossExpr(e: LossExpr, rollDie: (sides: number) => number): number {
  let total = e.mod
  for (let i = 0; i < e.dice; i++) total += rollDie(e.sides)
  return Math.max(0, total)
}

/** Accepts full names or any prefix: v/violence, h/helplessness, u/unnatural, n/none. Blank → none. */
export function parseCategory(text: string | undefined | null): SanCategory | null {
  const t = String(text ?? '')
    .trim()
    .toLowerCase()
  if (!t || t === '-') return 'none'
  for (const c of SAN_CATEGORIES) if (c.startsWith(t)) return c
  return null
}

export type SanRequest = { loss: SanLoss; category: SanCategory; source: string }

/**
 * Arguments of the chat command: "/san <loss> [category] [description…]".
 * The second word is a category only if it is one (or a prefix of one); otherwise it starts the description.
 */
export function parseSanCommand(args: string): SanRequest | { error: 'notation'; text: string } {
  const words = String(args ?? '')
    .trim()
    .split(/\s+/)
    .filter(w => w)
  const text = words.shift() ?? ''
  const loss = parseSanLoss(text)
  if (!loss) return { error: 'notation', text }
  let category: SanCategory = 'none'
  if (words.length) {
    const c = parseCategory(words[0])
    if (c) {
      category = c
      words.shift()
    }
  }
  return { loss, category, source: words.join(' ') }
}

/** OTF body (after any "override text" and "!"): "SAN 0/1d4", "SAN 1/1d6 violence", "SAN: 0/1 u". */
export const SAN_OTF_REGEX = /^SAN:?\s+(?<loss>\S+)(?:\s+(?<category>[A-Za-z]+))?\s*$/i

export function parseSanOtf(text: string): { loss: SanLoss; category: SanCategory } | null {
  const m = String(text ?? '')
    .trim()
    .match(SAN_OTF_REGEX)
  if (!m) return null
  const loss = parseSanLoss(m.groups!.loss)
  const category = parseCategory(m.groups!.category)
  return loss && category ? { loss, category } : null
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** 3d6 Fright Check: 3–4 always succeed, 17–18 always fail, otherwise roll ≤ target. */
export function frightCheckSucceeds(roll: number, target: number): boolean {
  if (roll <= 4) return true
  if (roll >= 17) return false
  return roll <= target
}

export function frightCheckTarget(
  base: number,
  mods: { mod: number }[]
): { total: number; target: number; ruleOf14: boolean } {
  const total = toInt(base, 10) + mods.reduce((a, m) => a + toInt(m.mod), 0)
  return { total, target: Math.min(total, FRIGHT_CHECK_CAP), ruleOf14: total > FRIGHT_CHECK_CAP }
}

/** Delta Green SAN roll: d100 ≤ current SAN. 01 always succeeds, 100 always fails. */
export function percentileSucceeds(roll: number, san: number): boolean {
  if (roll <= 1) return true
  if (roll >= 100) return false
  return roll <= san
}

// ---------------------------------------------------------------------------------------------
// Applying a loss
// ---------------------------------------------------------------------------------------------

export interface BondChange {
  id: string
  name: string
  before: number
  after: number
}

export interface SanLossOutcome {
  state: SanityData
  /** Loss rolled before adaptation and the floor at 0 SAN. */
  rolled: number
  /** SAN actually removed. */
  lost: number
  before: number
  after: number
  /** Already adapted to this category: no loss. */
  adaptedImmune: boolean
  temporaryInsanity: boolean
  breakingPoint: boolean
  bpBefore: number
  bpAfter: number
  permanentInsanity: boolean
  adaptation: { category: AdaptableCategory; before: number; after: number; becameAdapted: boolean } | null
  bondsReduced: BondChange[]
}

export function isAdapted(state: SanityData, category: SanCategory): boolean {
  return isAdaptable(category) && state.adaptation[category] >= ADAPTATION_BOXES
}

export function applySanLoss(
  state: SanityData,
  input: { rolled: number; category: SanCategory; will: number }
): SanLossOutcome {
  const s = cloneSanity(state)
  const before = s.value
  const bpBefore = s.breakingPoint
  const rolled = Math.max(0, toInt(input.rolled))
  const adaptedImmune = isAdapted(s, input.category)
  const lost = adaptedImmune ? 0 : Math.min(rolled, before)
  s.value = before - lost

  let adaptation: SanLossOutcome['adaptation'] = null
  let bondsReduced: BondChange[] = []
  if (isAdaptable(input.category) && !adaptedImmune && lost > 0) {
    const a0 = s.adaptation[input.category]
    const a1 = Math.min(ADAPTATION_BOXES, a0 + 1)
    s.adaptation[input.category] = a1
    const becameAdapted = a1 >= ADAPTATION_BOXES
    adaptation = { category: input.category, before: a0, after: a1, becameAdapted }
    if (becameAdapted) {
      const result = reduceAllBonds(s.bonds, 1)
      s.bonds = result.bonds
      bondsReduced = result.changes
    }
  }

  const breakingPoint = lost > 0 && s.value <= bpBefore
  if (breakingPoint) s.breakingPoint = nextBreakingPoint(s.value, input.will)

  return {
    state: s,
    rolled,
    lost,
    before,
    after: s.value,
    adaptedImmune,
    temporaryInsanity: lost >= TEMPORARY_INSANITY_LOSS,
    breakingPoint,
    bpBefore,
    bpAfter: s.breakingPoint,
    permanentInsanity: lost > 0 && s.value === 0,
    adaptation,
    bondsReduced,
  }
}

export function reduceAllBonds(bonds: Bond[], amount: number): { bonds: Bond[]; changes: BondChange[] } {
  const changes: BondChange[] = []
  const next = bonds.map(b => {
    const after = Math.max(0, b.score - amount)
    if (after !== b.score) changes.push({ id: b.id, name: b.name, before: b.score, after })
    return { ...b, score: after }
  })
  return { bonds: next, changes }
}

// ---------------------------------------------------------------------------------------------
// Projection onto a Bond
// ---------------------------------------------------------------------------------------------

/** Remembered on the actor so the most recent loss can be projected onto a Bond once. */
export interface LastLoss {
  id: string
  amount: number
  category: SanCategory
  projected: boolean
  breakingPoint: boolean
  bpBefore: number
  bpAfter: number
}

export function lastLossFrom(outcome: SanLossOutcome, id: string, category: SanCategory): LastLoss {
  return {
    id,
    amount: outcome.lost,
    category,
    projected: false,
    breakingPoint: outcome.breakingPoint,
    bpBefore: outcome.bpBefore,
    bpAfter: outcome.bpAfter,
  }
}

export type ProjectionFailure = 'nothing-to-project' | 'already-projected' | 'no-bond' | 'bond-broken'

export type ProjectionResult =
  | { ok: false; reason: ProjectionFailure }
  | {
      ok: true
      state: SanityData
      lastLoss: LastLoss
      roll: number
      refund: number
      remaining: number
      bond: BondChange
      bpReverted: boolean
      temporaryInsanityAverted: boolean
    }

/**
 * Project the most recent SAN loss onto a Bond: SAN goes back up by the 1d4 roll (at most the loss),
 * the Bond loses the full 1d4. If the projection lifts SAN back above the old Breaking Point, the
 * Breaking Point reset that loss caused is undone.
 */
export function projectOntoBond(state: SanityData, last: LastLoss, bondId: string, d4: number): ProjectionResult {
  if (!last || last.amount <= 0) return { ok: false, reason: 'nothing-to-project' }
  if (last.projected) return { ok: false, reason: 'already-projected' }
  const bond = state.bonds.find(b => b.id === bondId)
  if (!bond) return { ok: false, reason: 'no-bond' }
  if (bond.score <= 0) return { ok: false, reason: 'bond-broken' }

  const s = cloneSanity(state)
  const roll = Math.max(0, toInt(d4))
  const refund = Math.min(roll, last.amount)
  s.value = Math.min(s.max, s.value + refund)
  const target = s.bonds.find(b => b.id === bondId)!
  const bondChange = { id: target.id, name: target.name, before: target.score, after: Math.max(0, target.score - roll) }
  target.score = bondChange.after

  const remaining = last.amount - refund
  let bpReverted = false
  if (last.breakingPoint && s.breakingPoint === last.bpAfter && s.value > last.bpBefore) {
    s.breakingPoint = last.bpBefore
    bpReverted = true
  }

  return {
    ok: true,
    state: s,
    lastLoss: { ...last, projected: true, amount: remaining },
    roll,
    refund,
    remaining,
    bond: bondChange,
    bpReverted,
    temporaryInsanityAverted: last.amount >= TEMPORARY_INSANITY_LOSS && remaining < TEMPORARY_INSANITY_LOSS,
  }
}

// ---------------------------------------------------------------------------------------------
// Keeping value / max / unnatural consistent on any update
// ---------------------------------------------------------------------------------------------

export interface SanityPatch {
  value?: number
  max?: number
  breakingPoint?: number
  unnatural?: number
}

/**
 * Given the stored sanity and the numeric fields an update is about to change, return the full set of
 * corrected fields to write. Unnatural changes move max by the same amount (an Unnatural increase
 * reduces max SAN immediately); max never exceeds 99 − Unnatural; current SAN is clamped to [0, max].
 */
export function reconcileSanityChange(current: SanityData, patch: SanityPatch): SanityPatch {
  const out: SanityPatch = {}
  let unnatural = current.unnatural
  let max = current.max

  if (patch.unnatural !== undefined) {
    unnatural = clampInt(patch.unnatural, 0, SAN_CEILING)
    out.unnatural = unnatural
    if (patch.max === undefined) {
      max = current.max - (unnatural - current.unnatural)
      out.max = clampInt(max, 0, maxSanity(unnatural))
      max = out.max
    }
  }
  if (patch.max !== undefined) {
    max = clampInt(patch.max, 0, maxSanity(unnatural))
    out.max = max
  }
  if (patch.value !== undefined || out.max !== undefined) {
    const v = patch.value !== undefined ? patch.value : current.value
    const clamped = clampInt(v, 0, max)
    if (patch.value !== undefined || clamped !== current.value) out.value = clamped
  }
  if (patch.breakingPoint !== undefined) out.breakingPoint = clampInt(patch.breakingPoint, 0, SAN_CEILING)
  return out
}

// ---------------------------------------------------------------------------------------------
// Sheet list editing
// ---------------------------------------------------------------------------------------------

/** Clicking box `index` (0-based) of a row whose first `count` boxes are checked. */
export function toggleAdaptation(count: number, index: number): number {
  const c = clampInt(count, 0, ADAPTATION_BOXES)
  const i = clampInt(index, 0, ADAPTATION_BOXES - 1)
  return i < c ? i : i + 1
}

export function updateById<T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] {
  return list.map(item => (item.id === id ? { ...item, ...patch, id: item.id } : item))
}

export function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter(item => item.id !== id)
}

export function atBreakingPoint(s: SanityData): boolean {
  return s.initialized && s.value <= s.breakingPoint
}
