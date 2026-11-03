/**
 * Mapping hit-location results onto the defender's body plan (actor.system.hitlocations, usually
 * imported from GCS), and upstream's own random roll for body plans GUHL doesn't cover.
 * Pure functions: callers pass the actor's location names and table.
 */
import { zoneOf } from './engine.ts'
import type { Aim, HitResult, Region, Roller, Side } from './types.ts'

/** One row of the actor's hit-location table (HitLocationEntry: where + roll numbers). */
export interface BodyLocation {
  where: string
  roll: number[]
}

const PLURALS: Record<string, string> = { Arm: 'Arms', Leg: 'Legs', Hand: 'Hands', Foot: 'Feet', Eye: 'Eyes' }
const ALIASES: Record<string, string[]> = { Skull: ['Brain'] }

const cap = (side: Side) => (side === 'left' ? 'Left' : 'Right')

/** Location names to look for, most specific first: "Left Arm", "Arm (Left)", "Arm", "Arms". */
export function bodyCandidates(bodyKeys: string[], side: Side | null): string[] {
  const out: string[] = []
  for (const key of bodyKeys) {
    if (side) out.push(`${cap(side)} ${key}`, `${key} (${cap(side)})`)
    out.push(key)
    if (PLURALS[key]) out.push(PLURALS[key])
    out.push(...(ALIASES[key] ?? []))
  }
  return [...new Set(out)]
}

/**
 * The actor's own name for a hit: the first candidate the body plan has (case-insensitive), also
 * trying each candidate's localized name. Null when the body plan has none of them.
 */
export function mapToBody(
  hit: Pick<HitResult, 'bodyKeys' | 'side'>,
  wheres: string[],
  localize?: (name: string) => string
): string | null {
  const byName = new Map<string, string>()
  for (const where of wheres) byName.set(where.trim().toLowerCase(), where)
  for (const candidate of bodyCandidates(hit.bodyKeys, hit.side)) {
    const exact = byName.get(candidate.toLowerCase())
    if (exact) return exact
    const localized = localize?.(candidate)
    if (localized) {
      const found = byName.get(localized.trim().toLowerCase())
      if (found) return found
    }
  }
  return null
}

const GUHL_PLANS = ['humanoid', 'humanoid expanded', 'winged humanoid']

/**
 * Can GUHL land on this body? Humanoid body plans (or an unnamed plan) that have a torso, both arms
 * and both legs. Everything else uses upstream's random roll on the actor's own table.
 */
export function isGuhlBody(bodyplan: string | null | undefined, wheres: string[]): boolean {
  const plan = String(bodyplan ?? '')
    .trim()
    .toLowerCase()
  if (plan && !GUHL_PLANS.includes(plan)) return false
  const has = (keys: string[], side: Side | null = null) => mapToBody({ bodyKeys: keys, side }, wheres) !== null
  return (
    has(['Torso', 'Chest']) &&
    has(['Arm'], 'left') &&
    has(['Arm'], 'right') &&
    has(['Leg'], 'left') &&
    has(['Leg'], 'right')
  )
}

/** Upstream's random hit location: the table entry whose roll numbers include the 3d6 total. */
export function rollOnBodyTable(table: BodyLocation[], total: number): string | null {
  return table.find(entry => entry.roll.includes(total))?.where ?? null
}

/** Rough body region of an upstream location name (for cover zones on non-GUHL body plans). */
export function regionOfWhere(where: string): Region {
  const w = where.toLowerCase()
  if (/skull|brain/.test(w)) return 'skull'
  if (/eye|face|jaw|nose|ear/.test(w)) return 'face'
  if (/neck/.test(w)) return 'neck'
  if (/groin|abdomen|pelvis|digestive|tail/.test(w)) return 'abdomen'
  if (/hand|fin\b|extremit/.test(w)) return 'hand'
  if (/foot|feet/.test(w)) return 'foot'
  if (/arm|wing/.test(w)) return 'arm'
  if (/leg/.test(w)) return 'leg'
  return 'chest'
}

export function sideOfWhere(where: string): Side | null {
  if (/^left\b|\(left\)/i.test(where)) return 'left'
  if (/^right\b|\(right\)/i.test(where)) return 'right'
  return null
}

/** Upstream canonical name of an actor location: "Left Arm" -> "Arm", "Legs" -> "Leg", "Torso*" -> "Torso". */
export function canonicalWhere(where: string): string {
  let name = where
    .replace(/\*+$/, '')
    .replace(/^(left|right)\s+/i, '')
    .replace(/\s*\((left|right)\)$/i, '')
    .trim()
  const singular = Object.entries(PLURALS).find(([, plural]) => plural.toLowerCase() === name.toLowerCase())
  if (singular) name = singular[0]
  return name
}

/**
 * Resolve a hit on the actor's own (upstream) table: a random 3d6 roll, or the called location when
 * the body plan has it (a called name it doesn't have, such as GUHL's "Spine" on a quadruped, lands
 * on the torso). Used for non-humanoid body plans and when the world uses standard hit locations.
 */
export function resolveStandard(aim: Aim, aimName: string | null, table: BodyLocation[], roll: Roller): HitResult {
  const rolls: HitResult['rolls'] = []
  const wheres = table.map(entry => entry.where)
  let where: string | null = null

  if (aim.target !== 'random') {
    const wanted = String(aimName ?? '')
      .trim()
      .toLowerCase()
    if (wanted) where = wheres.find(w => w.trim().toLowerCase() === wanted) ?? null
    where ??= mapToBody({ bodyKeys: ['Torso', 'Chest'], side: null }, wheres)
  }
  if (!where) {
    const total = roll('main', 3)
    rolls.push({ key: 'main', dice: 3, value: total })
    where = rollOnBodyTable(table, total) ?? wheres[0] ?? 'Torso'
  }

  const region = regionOfWhere(where)
  const side = sideOfWhere(where)
  return {
    system: 'standard',
    aim,
    row: null,
    region,
    part: null,
    sub: null,
    side,
    path: [{ raw: where }],
    upstream: canonicalWhere(where),
    bodyKeys: [where],
    zone: zoneOf(region, side),
    multiplier: null,
    extraDR: 0,
    naturalDR: 0,
    armorGap: false,
    halveDR: false,
    injuryCap: false,
    crippleDivisor: null,
    bleedModifier: 0,
    bleedFast: false,
    notes: [],
    rolls,
    invalid: null,
  }
}

/* ---------------------------------------- */
/*  Innate DR (armor gaps)                   */
/* ---------------------------------------- */

export interface TraitLike {
  name?: string
  level?: number | string | null
}

/**
 * Innate DR from Damage Resistance traits ("Damage Resistance 2", or name + level). Armor gaps
 * ignore armor but not this. Limitations (partial, limited) aren't read: the GM can override DR.
 */
export function innateDR(traits: TraitLike[]): number {
  let total = 0
  for (const trait of traits) {
    const name = String(trait.name ?? '').trim()
    const match = name.match(/^damage resistance\b\s*(\d+)?/i)
    if (!match) continue
    const level = Number(trait.level)
    const value = Number.isFinite(level) && level > 0 ? level : Number(match[1] ?? 0)
    if (Number.isFinite(value) && value > 0) total += value
  }
  return total
}
