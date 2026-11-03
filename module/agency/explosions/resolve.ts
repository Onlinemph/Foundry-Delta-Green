/**
 * One explosion, target by target. Dice are rolled once, at detonation (rollTarget), and kept on the
 * GM's card; everything shown or applied is derived from those rolls (deriveRow), so a dive result,
 * a smothered grenade or a cover edit only re-derives, never re-rolls.
 * Pure; tested in test/agency/explosions-resolve.test.ts.
 */
import { maxDamage, roll3d6, rollDamage, type Rng } from './dice.ts'
import type { DamageComponent, ExplosiveSpec, FragSpec } from './parse.ts'
import {
  afflictionRoll,
  blastArmorDivisor,
  blastRadius,
  bodyCoverDR,
  canDive,
  canSmother,
  catchingFire,
  collateralDamage,
  diveEffect,
  fragmentAttack,
  fragmentRadius,
  fragmentsAfterDive,
  INTERNAL_EXPLOSION,
  knockback,
  throughCover,
  type BlastEnvironment,
  type FragmentAttack,
  type Knockback,
  type Posture,
} from './rules.ts'
import type { SpecialSummary } from './specials.ts'

export interface BlastSetup {
  spec: ExplosiveSpec
  environment: BlastEnvironment
  /** HT181: 1 (open), 1.5 (enclosed, doors/windows blow out), 2 (contained). */
  enclosed: number
  airburst: boolean
  specials: SpecialSummary
  /** Cover DR for someone who dives into cover a step away (B377). */
  diveCoverDR: number
}

export interface Radii {
  blast: number
  fragments: number
  affliction: number
  smoke: number
  gas: number
  /** Everything a target can be caught by. */
  max: number
}

export function radii(setup: Pick<BlastSetup, 'spec' | 'specials'>): Radii {
  const blast = Math.max(0, ...setup.spec.components.map(c => blastRadius(c)))
  const fragments = Math.max(0, ...setup.spec.components.map(c => fragmentRadius(c.fragments)))
  const affliction = setup.specials.affliction?.radius ?? 0
  const smoke = setup.specials.smoke?.radius ?? 0
  const gas = setup.specials.gas?.radius ?? 0
  return { blast, fragments, affliction, smoke, gas, max: Math.max(blast, fragments, affliction) }
}

/** The fragment spec with the longest reach, if any component has fragments. */
export function mainFragments(spec: ExplosiveSpec): FragSpec | null {
  let best: FragSpec | null = null
  for (const c of spec.components)
    if (c.fragments && (!best || fragmentRadius(c.fragments) > fragmentRadius(best))) best = c.fragments
  return best
}

/** Measured at detonation; doesn't change afterwards. */
export interface TargetFacts {
  id: string
  name: string
  /** Yards from the center (grid distance). */
  distance: number
  struck: boolean
  posture: Posture
  sizeModifier: number
  st: number | null
  hp: number
  ht: number
  torsoDR: number
  /** Sum of the cover DR of walls between the blast and the target (0 when walls don't count). */
  wallDR: number
  walls: number
  /** Bonus to resist an area affliction (Protected Hearing / Vision...). */
  afflictionBonus: number
  /** Partial cover on the token (body parts behind cover), from the hit-location feature's token flag. */
  partialCover?: { locations: string[]; dr: number } | null
  /** B400 effective DR against a large-area injury (for the card; the calculator works it out itself). */
  largeAreaDR?: number
}

export interface TargetRolls {
  /** Rolled damage per component (index-aligned with spec.components); 0 when not rolled. */
  blast: number[]
  fragRoll: number | null
  /** One damage roll per fragment that hit (before any dive). */
  fragDamage: number[]
  /** Hit location per fragment (filled in by the caller when it has to ask the actor). */
  fragLocations: string[]
  afflictionRoll: number | null
}

export type DiveStatus = 'none' | 'pending' | 'success' | 'failure' | 'declined'

export interface DiveState {
  status: DiveStatus
  margin: number
  coverStep: boolean
  /** A sacrificial dodge and drop onto the explosive (B377). */
  smother: boolean
}

export interface RowState {
  facts: TargetFacts
  rolls: TargetRolls
  dive: DiveState
  /** Cover DR the GM typed in (replaces the walls' DR). */
  coverOverride: number | null
  applied: boolean
}

export interface BlastState {
  setup: BlastSetup
  rows: RowState[]
  /** Token id of whoever smothered the explosive (B415 contact explosion). */
  contactId: string | null
  /** Token id of the host of an internal explosion (B415). */
  internalId: string | null
}

export function noDive(): DiveState {
  return { status: 'none', margin: 0, coverStep: false, smother: false }
}

function inRadius(yards: number, radius: number): boolean {
  return radius > 0 && yards <= radius + 1e-9
}

/** Damage a component can do to this target at all: explosive collateral in range, or anything to the target struck. */
function componentReaches(c: DamageComponent, yards: number, struck: boolean): boolean {
  if (c.dice <= 0 && c.adds === 0) return false
  if (c.affliction || c.smoke) return false
  if (struck) return true
  return c.explosive && inRadius(yards, blastRadius(c))
}

/**
 * Roll everything for one target. B414: damage is rolled for each target individually; pass
 * `shared` (per-component totals) to reuse one roll for several NPCs, as B414 allows the GM.
 * `locate` picks a hit location per fragment; leave it out to fill locations in later.
 */
export function rollTarget(
  setup: BlastSetup,
  facts: TargetFacts,
  rng: Rng,
  opts: { shared?: number[] | null; locate?: (rng: Rng, damageType: string) => string } = {}
): TargetRolls {
  const blast = setup.spec.components.map((c, i) => {
    if (!componentReaches(c, facts.distance, facts.struck)) return 0
    if (opts.shared && opts.shared[i] !== undefined && !facts.struck) return opts.shared[i]
    return rollDamage(c, rng, c.type).total
  })

  const frag = mainFragments(setup.spec)
  let fragRoll: number | null = null
  const fragDamage: number[] = []
  const fragLocations: string[] = []
  if (frag && (facts.struck || inRadius(facts.distance, fragmentRadius(frag)))) {
    fragRoll = facts.struck ? null : roll3d6(rng)
    const attack = fragmentAttack({
      yards: facts.distance,
      posture: facts.posture,
      sizeModifier: facts.sizeModifier,
      airburst: setup.airburst,
      struck: facts.struck,
      roll: fragRoll,
    })
    for (let i = 0; i < attack.hits; i++) {
      fragDamage.push(rollDamage(frag, rng, frag.type).total)
      fragLocations.push(opts.locate ? opts.locate(rng, frag.type) : '')
    }
  }

  const aff = setup.specials.affliction
  // Interpretation: an area affliction doesn't reach someone behind a wall.
  const afflictionRollValue = aff && inRadius(facts.distance, aff.radius) && facts.walls === 0 ? roll3d6(rng) : null

  return { blast, fragRoll, fragDamage, fragLocations, afflictionRoll: afflictionRollValue }
}

export interface BlastEntry {
  componentIndex: number
  type: string
  modifiers: string[]
  rolled: number
  /** 1 for the target struck, contact and internal blasts. */
  divisor: number
  /** After the divisor and enclosed-space multiplier, before cover. */
  damage: number
  /** What goes to the damage calculator (after cover). */
  applied: number
  /** For the calculator: 0 = none. */
  armorDivisor: number
  /** 'Large-Area' for blasts (B400), or a location for a direct non-explosive hit or an internal blast. */
  location: string
  kind: 'struck' | 'collateral' | 'contact' | 'internal' | 'direct'
  /** Internal explosions: DR has no effect, ×3 wounding (B415). */
  ignoresDR: boolean
  woundingModifier: number | null
  fire: 'none' | 'partial' | 'all'
}

export interface FragmentHit {
  damage: number
  /** After cover. */
  applied: number
  location: string
  coveredBy: 'none' | 'cover' | 'partial'
  type: string
  armorDivisor: number
}

export interface DerivedRow {
  id: string
  name: string
  distance: number
  effectiveDistance: number
  struck: boolean
  inBlast: boolean
  inFragments: boolean
  inAffliction: boolean
  canDive: boolean
  canSmother: boolean
  coverDR: number
  coverSource: 'none' | 'wall' | 'manual' | 'dive' | 'body'
  blast: BlastEntry[]
  fragments: (FragmentAttack & { stopped: number; hitList: FragmentHit[] }) | null
  knockback: Knockback | null
  affliction: { target: number; roll: number; success: boolean; margin: number; critical: boolean } | null
  contact: boolean
  internal: boolean
  hotFragments: boolean
  /** Anything at all to apply. */
  hasEffect: boolean
}

export function deriveRow(state: BlastState, row: RowState): DerivedRow {
  const { setup } = state
  const facts = row.facts
  const dive =
    row.dive.status === 'success' || row.dive.status === 'failure'
      ? diveEffect({ success: row.dive.status === 'success', margin: row.dive.margin, coverStep: row.dive.coverStep })
      : diveEffect(null)

  const contact = state.contactId === facts.id
  const internal = state.internalId === facts.id
  const shield = state.contactId ?? state.internalId
  const shieldRow = shield && shield !== facts.id ? state.rows.find(x => x.facts.id === shield) : undefined
  const body = shieldRow ? bodyCoverDR(shieldRow.facts.torsoDR, shieldRow.facts.hp) : 0

  // A smothering dive doesn't move you away from the blast: you're on it.
  const extra = contact ? 0 : dive.extraYards
  const effectiveDistance = facts.distance + extra

  let coverDR = row.coverOverride ?? facts.wallDR
  let coverSource: DerivedRow['coverSource'] =
    row.coverOverride !== null ? 'manual' : facts.wallDR > 0 ? 'wall' : 'none'
  if (dive.reachedCover && !contact && setup.diveCoverDR > coverDR) {
    coverDR = setup.diveCoverDR
    coverSource = 'dive'
  }
  if (body > 0) {
    coverDR += body
    if (coverSource === 'none') coverSource = 'body'
  }
  if (facts.struck || contact || internal) {
    coverDR = 0
    coverSource = 'none'
  }

  const blast: BlastEntry[] = []
  setup.spec.components.forEach((c, i) => {
    const rolled = row.rolls.blast[i] ?? 0
    const base = {
      componentIndex: i,
      type: c.type || 'cr',
      modifiers: c.modifiers,
      woundingModifier: null as number | null,
      ignoresDR: false,
    }
    if (contact) {
      if (!c.explosive) return
      const damage = maxDamage(c)
      blast.push({
        ...base,
        rolled: damage,
        divisor: 1,
        damage,
        applied: damage,
        armorDivisor: 0,
        location: 'Large-Area',
        kind: 'contact',
        fire: c.type === 'burn' ? catchingFire(damage) : 'none',
      })
      return
    }
    if (!rolled) return
    if (internal) {
      if (!c.explosive) return
      blast.push({
        ...base,
        rolled,
        divisor: 1,
        damage: rolled,
        applied: rolled,
        armorDivisor: 0,
        location: INTERNAL_EXPLOSION.location,
        kind: 'internal',
        ignoresDR: true,
        woundingModifier: INTERNAL_EXPLOSION.woundingModifier,
        fire: 'none',
      })
      return
    }
    if (facts.struck) {
      const { damage } = collateralDamage(rolled, 0, { struck: true, enclosed: c.explosive ? setup.enclosed : 1 })
      blast.push({
        ...base,
        rolled,
        divisor: 1,
        damage,
        applied: damage,
        armorDivisor: blastArmorDivisor(c, true),
        location: c.explosive ? 'Large-Area' : '',
        kind: c.explosive ? 'struck' : 'direct',
        fire: c.type === 'burn' ? catchingFire(damage) : 'none',
      })
      return
    }
    if (!c.explosive || !inRadius(effectiveDistance, blastRadius(c))) return
    const { damage, divisor } = collateralDamage(rolled, effectiveDistance, {
      environment: setup.environment,
      enclosed: setup.enclosed,
    })
    const applied = throughCover(damage, coverDR)
    blast.push({
      ...base,
      rolled,
      divisor,
      damage,
      applied,
      armorDivisor: 0,
      location: 'Large-Area',
      kind: 'collateral',
      fire: c.type === 'burn' ? catchingFire(applied) : 'none',
    })
  })

  const frag = mainFragments(setup.spec)
  let fragments: DerivedRow['fragments'] = null
  if (frag && !contact && !internal && (facts.struck || inRadius(facts.distance, fragmentRadius(frag)))) {
    const attack = fragmentAttack({
      yards: facts.distance,
      posture: facts.posture,
      sizeModifier: facts.sizeModifier,
      airburst: setup.airburst,
      struck: facts.struck,
      roll: row.rolls.fragRoll,
    })
    const rolledHits = row.rolls.fragDamage.length
    const remaining = fragmentsAfterDive(rolledHits, attack.critical || attack.automatic, dive)
    const hitList: FragmentHit[] = row.rolls.fragDamage.slice(0, remaining).map((damage, i) => {
      const location = row.rolls.fragLocations[i] ?? ''
      // B414: a fragment whose location is behind cover hits the cover.
      if (coverDR > 0)
        return {
          damage,
          applied: throughCover(damage, coverDR, frag.armorDivisor),
          location,
          coveredBy: 'cover',
          type: frag.type,
          armorDivisor: frag.armorDivisor,
        }
      const partial = facts.partialCover
      if (partial && partial.locations.includes(location))
        return {
          damage,
          applied: throughCover(damage, partial.dr, frag.armorDivisor),
          location,
          coveredBy: 'partial',
          type: frag.type,
          armorDivisor: frag.armorDivisor,
        }
      return { damage, applied: damage, location, coveredBy: 'none', type: frag.type, armorDivisor: frag.armorDivisor }
    })
    fragments = { ...attack, hits: rolledHits, stopped: rolledHits - remaining, hitList }
  }

  // B378: crushing blast damage knocks the target away from the center (not someone lying on it, or its host).
  let kb: Knockback | null = null
  if (!contact && !internal) {
    let yards = 0
    for (const entry of blast) {
      const result = knockback({
        damage: entry.applied,
        type: entry.type,
        st: facts.st,
        hp: facts.hp,
        modifiers: entry.modifiers,
      })
      if (result) yards += result.yards
    }
    if (yards > 0) kb = { yards, rollModifier: -(yards - 1) }
  }

  const aff = setup.specials.affliction
  const affliction =
    aff && row.rolls.afflictionRoll !== null
      ? afflictionRoll({
          ht: facts.ht,
          htModifier: aff.htModifier,
          bonus: facts.afflictionBonus,
          roll: row.rolls.afflictionRoll,
        })
      : null

  const inBlast =
    facts.struck || setup.spec.components.some(c => c.explosive && inRadius(facts.distance, blastRadius(c)))
  const inFragments = !!frag && (facts.struck || inRadius(facts.distance, fragmentRadius(frag)))
  const inAffliction = !!aff && inRadius(facts.distance, aff.radius)
  const hasEffect =
    blast.some(b => b.applied > 0) ||
    !!fragments?.hitList.some(h => h.applied > 0) ||
    (!!affliction && !affliction.success) ||
    !!kb

  return {
    id: facts.id,
    name: facts.name,
    distance: facts.distance,
    effectiveDistance,
    struck: facts.struck,
    inBlast,
    inFragments,
    inAffliction,
    canDive: !internal && !contact && canDive({ struck: facts.struck, inBlast, inFragments }),
    canSmother:
      !internal &&
      !state.contactId &&
      canSmother(facts.distance, facts.struck) &&
      setup.spec.components.some(c => c.explosive),
    coverDR,
    coverSource,
    blast,
    fragments,
    knockback: kb,
    affliction,
    contact,
    internal,
    hotFragments: setup.specials.hotFragments && !!fragments?.hitList.length,
    hasEffect,
  }
}

/** Record a dive result. A successful smothering dive makes the explosion a contact explosion (B415); the first one wins. */
export function recordDive(
  state: BlastState,
  id: string,
  result: { status: DiveStatus; margin?: number; coverStep?: boolean; smother?: boolean }
): BlastState {
  const rows = state.rows.map(row =>
    row.facts.id === id
      ? {
          ...row,
          dive: {
            status: result.status,
            margin: result.margin ?? 0,
            coverStep: !!result.coverStep,
            smother: !!result.smother,
          },
        }
      : row
  )
  const contactId = state.contactId ?? (result.status === 'success' && result.smother ? id : null)
  return { ...state, rows, contactId }
}

/** Upstream's random hit location: the 3d6 total against the actor's hit-location table (B552). */
export function locationFor(entries: { where: string; roll?: number[] }[], total: number): string | null {
  return entries.find(e => Array.isArray(e.roll) && e.roll.includes(total))?.where ?? null
}

/**
 * B400 Random Hit Location: a random attack from directly above treats "feet" as "hands" and "legs" as
 * "arms". Used for airburst fragments.
 */
export function fromAbove(location: string): string {
  return location
    .replace(/\bFoot\b/g, 'Hand')
    .replace(/\bFeet\b/g, 'Hands')
    .replace(/\bLegs?\b/g, m => (m === 'Legs' ? 'Arms' : 'Arm'))
}
