import { scriptedRng, seededRng } from '../../module/agency/explosions/dice.ts'
import { parseExplosive } from '../../module/agency/explosions/parse.ts'
import {
  deriveRow,
  noDive,
  radii,
  recordDive,
  rollTarget,
  type BlastSetup,
  type BlastState,
  type RowState,
  type TargetFacts,
} from '../../module/agency/explosions/resolve.ts'
import { matchSpecials, summarizeSpecials } from '../../module/agency/explosions/specials.ts'

function setup(damage: string, name = 'Grenade', extra: Partial<BlastSetup> = {}): BlastSetup {
  const spec = parseExplosive(damage)!
  const specials = summarizeSpecials(matchSpecials({ name, damage, spec }))
  return {
    spec,
    environment: specials.environment,
    enclosed: 1,
    airburst: specials.airburst,
    specials,
    diveCoverDR: 6,
    ...extra,
  }
}

function facts(id: string, distance: number, extra: Partial<TargetFacts> = {}): TargetFacts {
  return {
    id,
    name: id.toUpperCase(),
    distance,
    struck: false,
    posture: 'standing',
    sizeModifier: 0,
    st: 10,
    hp: 10,
    ht: 10,
    torsoDR: 0,
    wallDR: 0,
    walls: 0,
    afflictionBonus: 0,
    ...extra,
  }
}

function row(f: TargetFacts, rolls: Partial<RowState['rolls']> = {}): RowState {
  return {
    facts: f,
    rolls: { blast: [], fragRoll: null, fragDamage: [], fragLocations: [], afflictionRoll: null, ...rolls },
    dive: noDive(),
    coverOverride: null,
    applied: false,
  }
}

function state(s: BlastSetup, rows: RowState[]): BlastState {
  return { setup: s, rows, contactId: null, internalId: null }
}

describe('radii', () => {
  test('M67-style 9d [2d]: blast 18, fragments 10', () => {
    expect(radii(setup('9d [2d] cr ex'))).toMatchObject({ blast: 18, fragments: 10, max: 18 })
  })
  test('stun grenade: 10-yard affliction, smoke', () => {
    expect(radii(setup('HT-5 aff (10 yd.)', 'Stun Grenade'))).toMatchObject({
      blast: 0,
      affliction: 10,
      smoke: 10,
      max: 10,
    })
  })
  test('linked explosions use the widest', () => {
    expect(radii(setup('7d(10) cr ex with 6d [2d] cr ex linked'))).toMatchObject({ blast: 14, fragments: 10 })
  })
})

describe('rollTarget', () => {
  const s = setup('4d [2d] cr ex')

  test('within the blast and fragment radii: rolls blast, 3d6 for fragments, damage per hit', () => {
    // blast 4d: 6,6,6,6 = 24; fragment roll 1+1+2 = 4 (critical) -> skill 15-2 = 13, margin 9 -> 4 hits
    const rng = scriptedRng([6, 6, 6, 6, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6])
    const rolls = rollTarget(s, facts('a', 4), rng, { locate: () => 'Torso' })
    expect(rolls.blast).toEqual([24])
    expect(rolls.fragRoll).toBe(4)
    expect(rolls.fragDamage).toEqual([6, 8, 10, 12])
    expect(rolls.fragLocations).toEqual(['Torso', 'Torso', 'Torso', 'Torso'])
  })

  test('outside the blast radius: no blast roll; inside fragment radius still rolls fragments', () => {
    const rolls = rollTarget(s, facts('b', 9), scriptedRng([6, 6, 6]))
    expect(rolls.blast).toEqual([0])
    expect(rolls.fragRoll).toBe(18)
    expect(rolls.fragDamage).toEqual([])
  })

  test('outside everything: nothing', () => {
    expect(rollTarget(s, facts('c', 30), seededRng(1))).toEqual({
      blast: [0],
      fragRoll: null,
      fragDamage: [],
      fragLocations: [],
      afflictionRoll: null,
    })
  })

  test('the target struck: no fragment roll, one automatic hit', () => {
    const rolls = rollTarget(s, facts('d', 0, { struck: true }), scriptedRng([3, 3, 3, 3, 2, 2]))
    expect(rolls.blast).toEqual([12])
    expect(rolls.fragRoll).toBeNull()
    expect(rolls.fragDamage).toEqual([4])
  })

  test('a shared roll for NPCs (B414 lets the GM use one roll)', () => {
    const rolls = rollTarget(s, facts('e', 3), scriptedRng([6, 6, 6]), { shared: [11] })
    expect(rolls.blast).toEqual([11])
  })

  test('a direct-hit-only kinetic component is only rolled for the target struck', () => {
    const shell = setup('6d×5(0.5) pi++ with 6d [5d+2] cr ex linked')
    expect(rollTarget(shell, facts('x', 3), seededRng(3)).blast[0]).toBe(0)
    expect(rollTarget(shell, facts('y', 0, { struck: true }), seededRng(3)).blast[0]).toBeGreaterThan(0)
  })

  test('stun affliction: rolled inside the radius, not behind a wall', () => {
    const stun = setup('HT-5 aff (10 yd.)', 'Stun Grenade')
    expect(rollTarget(stun, facts('s', 5), scriptedRng([2, 2, 2])).afflictionRoll).toBe(6)
    expect(rollTarget(stun, facts('t', 5, { walls: 1, wallDR: 6 }), seededRng(1)).afflictionRoll).toBeNull()
    expect(rollTarget(stun, facts('u', 11), seededRng(1)).afflictionRoll).toBeNull()
  })
})

describe('deriveRow', () => {
  const s = setup('4d [2d] cr ex')

  test('collateral: divided by 3 × yards; fragments listed with locations', () => {
    const r = row(facts('a', 2), { blast: [21], fragRoll: 8, fragDamage: [5, 7], fragLocations: ['Torso', 'Skull'] })
    const d = deriveRow(state(s, [r]), r)
    expect(d.blast).toHaveLength(1)
    expect(d.blast[0]).toMatchObject({
      rolled: 21,
      divisor: 6,
      damage: 3,
      applied: 3,
      location: 'Large-Area',
      kind: 'collateral',
      armorDivisor: 0,
    })
    expect(d.fragments?.hitList.map(h => [h.applied, h.location])).toEqual([
      [5, 'Torso'],
      [7, 'Skull'],
    ])
    expect(d.canDive).toBe(true)
    expect(d.hasEffect).toBe(true)
  })

  test('the target struck takes full damage with the armor divisor, Large-Area (B400, B414)', () => {
    const heat = setup('6d(10) cr ex')
    const r = row(facts('t', 0, { struck: true }), { blast: [20] })
    const d = deriveRow(state(heat, [r]), r)
    expect(d.blast[0]).toMatchObject({
      damage: 20,
      divisor: 1,
      armorDivisor: 10,
      kind: 'struck',
      location: 'Large-Area',
    })
    expect(d.canDive).toBe(false)
  })

  test('walls are cover: blast and every fragment lose the cover DR (B408, B414)', () => {
    const r = row(facts('w', 1, { wallDR: 6, walls: 1 }), {
      blast: [24],
      fragRoll: 5,
      fragDamage: [8, 4],
      fragLocations: ['Torso', 'Arm'],
    })
    const d = deriveRow(state(s, [r]), r)
    expect(d.coverDR).toBe(6)
    expect(d.coverSource).toBe('wall')
    expect(d.blast[0]).toMatchObject({ damage: 8, applied: 2 })
    expect(d.fragments?.hitList.map(h => [h.applied, h.coveredBy])).toEqual([
      [2, 'cover'],
      [0, 'cover'],
    ])
  })

  test('the GM can override cover DR', () => {
    const r = { ...row(facts('w', 1, { wallDR: 6, walls: 1 }), { blast: [24] }), coverOverride: 0 }
    const d = deriveRow(state(s, [r]), r)
    expect(d.coverDR).toBe(0)
    expect(d.coverSource).toBe('manual')
    expect(d.blast[0].applied).toBe(8)
  })

  test('partial cover stops fragments on covered locations only', () => {
    const r = row(facts('p', 3, { partialCover: { locations: ['Leg'], dr: 10 } }), {
      blast: [0],
      fragRoll: 5,
      fragDamage: [6, 6],
      fragLocations: ['Leg', 'Torso'],
    })
    const d = deriveRow(state(s, [r]), r)
    expect(d.fragments?.hitList.map(h => [h.applied, h.coveredBy])).toEqual([
      [0, 'partial'],
      [6, 'none'],
    ])
  })

  test('a successful dive: a step farther for the blast, 1 + margin fragments stopped', () => {
    const base = row(facts('d', 2), {
      blast: [24],
      fragRoll: 7,
      fragDamage: [3, 4, 5],
      fragLocations: ['Torso', 'Torso', 'Torso'],
    })
    const st = recordDive(state(s, [base]), 'd', { status: 'success', margin: 1 })
    const d = deriveRow(st, st.rows[0])
    expect(d.effectiveDistance).toBe(3)
    expect(d.blast[0]).toMatchObject({ divisor: 9, damage: 2 })
    expect(d.fragments?.stopped).toBe(2)
    expect(d.fragments?.hitList).toHaveLength(1)
  })

  test('a dive can take you out of the blast radius', () => {
    const r = row(facts('e', 8), { blast: [20] })
    const st = recordDive(state(s, [r]), 'e', { status: 'success', margin: 0 })
    expect(deriveRow(st, st.rows[0]).blast).toEqual([])
  })

  test('a failed dive changes nothing for the damage', () => {
    const r = row(facts('f', 2), { blast: [24] })
    const st = recordDive(state(s, [r]), 'f', { status: 'failure', margin: -2 })
    expect(deriveRow(st, st.rows[0]).blast[0].damage).toBe(4)
  })

  test('diving into cover a step away uses the dive cover DR', () => {
    const r = row(facts('g', 2), { blast: [24], fragRoll: 3, fragDamage: [9, 9, 9, 9, 9], fragLocations: [] })
    const st = recordDive(state(s, [r]), 'g', { status: 'success', margin: 0, coverStep: true })
    const d = deriveRow(st, st.rows[0])
    expect(d.coverSource).toBe('dive')
    expect(d.coverDR).toBe(6)
    // critical fragment roll (3): no hits stopped, but all hit the cover
    expect(d.fragments?.stopped).toBe(0)
    expect(d.fragments?.hitList.every(h => h.coveredBy === 'cover' && h.applied === 3)).toBe(true)
  })

  test('smothering the grenade: maximum damage for the hero, his torso DR + HP shields the rest (B377, B415)', () => {
    const hero = row(facts('hero', 1, { torsoDR: 4, hp: 12 }), {
      blast: [14],
      fragRoll: 10,
      fragDamage: [6],
      fragLocations: ['Torso'],
    })
    const friend = row(facts('friend', 2), { blast: [14], fragRoll: 9, fragDamage: [20], fragLocations: ['Torso'] })
    const st = recordDive(state(s, [hero, friend]), 'hero', { status: 'success', margin: 0, smother: true })
    expect(st.contactId).toBe('hero')
    const h = deriveRow(st, st.rows[0])
    expect(h.contact).toBe(true)
    expect(h.blast[0]).toMatchObject({ damage: 24, kind: 'contact', location: 'Large-Area' })
    expect(h.fragments).toBeNull()
    expect(h.knockback).toBeNull()
    const f = deriveRow(st, st.rows[1])
    expect(f.coverDR).toBe(16)
    expect(f.coverSource).toBe('body')
    expect(f.blast[0].applied).toBe(0)
    expect(f.fragments?.hitList[0]).toMatchObject({ applied: 4, coveredBy: 'cover' })
  })

  test('the first smothering success wins', () => {
    const a = row(facts('a', 1))
    const b = row(facts('b', 1))
    let st = recordDive(state(s, [a, b]), 'a', { status: 'success', smother: true })
    st = recordDive(st, 'b', { status: 'success', smother: true })
    expect(st.contactId).toBe('a')
  })

  test('internal explosion: full damage to the vitals, DR ignored, ×3 (B415)', () => {
    const host = row(facts('host', 0), { blast: [15] })
    const st = { ...state(s, [host]), internalId: 'host' }
    const d = deriveRow(st, host)
    expect(d.blast[0]).toMatchObject({
      kind: 'internal',
      location: 'Vitals',
      ignoresDR: true,
      woundingModifier: 3,
      applied: 15,
    })
    expect(d.canDive).toBe(false)
  })

  test('knockback from the blast (B378)', () => {
    const big = setup('6d×2 cr ex')
    const r = row(facts('k', 1, { st: 10 }), { blast: [48] })
    expect(deriveRow(state(big, [r]), r).knockback).toEqual({ yards: 2, rollModifier: -1 })
  })

  test('linked burning damage: separate entries, catching fire (B434)', () => {
    const inc = setup('4d+2 cr ex linked burn')
    const r = row(facts('i', 1), { blast: [20, 18] })
    const d = deriveRow(state(inc, [r]), r)
    expect(d.blast.map(b => [b.type, b.applied, b.fire])).toEqual([
      ['cr', 6, 'none'],
      ['burn', 6, 'partial'],
    ])
  })

  test('enclosed space doubles (HT181)', () => {
    const room = setup('4d cr ex', 'Grenade', { enclosed: 2 })
    const r = row(facts('r', 2), { blast: [21] })
    expect(deriveRow(state(room, [r]), r).blast[0].damage).toBe(6)
  })

  test('thermobaric divides by 2 × yards (HT170)', () => {
    const tb = setup('8d cr ex', '40mm Thermobaric')
    const r = row(facts('t', 2), { blast: [28] })
    expect(deriveRow(state(tb, [r]), r).blast[0]).toMatchObject({ divisor: 4, damage: 7 })
  })

  test('stun grenade: failed HT-5 roll with protection bonuses', () => {
    const stun = setup('HT-5 aff (10 yd.)', 'Stun Grenade')
    const failed = row(facts('a', 3, { ht: 12 }), { afflictionRoll: 9 })
    const resisted = row(facts('b', 3, { ht: 12, afflictionBonus: 5 }), { afflictionRoll: 9 })
    const st = state(stun, [failed, resisted])
    expect(deriveRow(st, failed).affliction).toMatchObject({ target: 7, success: false })
    expect(deriveRow(st, failed).hasEffect).toBe(true)
    expect(deriveRow(st, resisted).affliction).toMatchObject({ target: 12, success: true })
    expect(deriveRow(st, resisted).hasEffect).toBe(false)
    expect(deriveRow(st, failed).canDive).toBe(false)
  })

  test('hot fragments are flagged (B415)', () => {
    const wp = setup('2d [1d(0.2)] burn ex', 'M34 WP')
    const r = row(facts('w', 3), { blast: [7], fragRoll: 6, fragDamage: [2], fragLocations: ['Torso'] })
    const d = deriveRow(state(wp, [r]), r)
    expect(d.hotFragments).toBe(true)
    expect(d.fragments?.hitList[0]).toMatchObject({ type: 'burn', armorDivisor: 0.2 })
  })
})

describe('a whole grenade, seeded', () => {
  test('every target derived from one seed is stable', () => {
    const s = setup('9d [2d] cr ex', 'M67')
    const targets = [
      facts('a', 0, { struck: true }),
      facts('b', 2),
      facts('c', 6, { posture: 'down' }),
      facts('d', 12),
      facts('e', 25),
    ]
    const rng = seededRng(2026)
    const rows = targets.map(t => row(t, rollTarget(s, t, rng, { locate: () => 'Torso' })))
    const st = state(s, rows)
    const derived = rows.map(r => deriveRow(st, r))
    // Same seed, same result.
    const rng2 = seededRng(2026)
    const rows2 = targets.map(t => row(t, rollTarget(s, t, rng2, { locate: () => 'Torso' })))
    expect(rows2.map(r => r.rolls)).toEqual(rows.map(r => r.rolls))
    expect(derived[0].struck).toBe(true)
    expect(derived[0].fragments?.hitList).toHaveLength(1)
    // 12 yards: inside the 18-yard blast, outside the 10-yard fragment radius.
    expect(derived[3].inBlast).toBe(true)
    expect(derived[3].inFragments).toBe(false)
    expect(derived[3].blast[0].divisor).toBe(36)
    expect(derived[4].hasEffect).toBe(false)
    expect(derived[4].inBlast).toBe(false)
  })
})

describe('GM card events (reduceBlast)', () => {
  // Imported lazily so this file's other tests don't depend on it.
  const flagFor = (rows: RowState[]) =>
    ({
      kind: 'blast',
      request: {} as any,
      state: state(setup('4d [2d] cr ex'), rows),
      templateIds: ['t1'],
      meta: {},
      prompts: {},
    }) as any

  test('a dive answer is recorded once; later answers and answers after Apply are ignored', async () => {
    const { reduceBlast } = await import('../../module/agency/explosions/reducer.ts')
    const pending = { ...row(facts('a', 2)), dive: { ...noDive(), status: 'pending' as const } }
    let flag = flagFor([pending])
    flag = reduceBlast(flag, {
      kind: 'dive',
      tokenId: 'a',
      status: 'success',
      margin: 1,
      coverStep: true,
      smother: false,
    })
    expect(flag.state.rows[0].dive).toEqual({ status: 'success', margin: 1, coverStep: true, smother: false })
    const again = reduceBlast(flag, {
      kind: 'dive',
      tokenId: 'a',
      status: 'failure',
      margin: -1,
      coverStep: false,
      smother: false,
    })
    expect(again).toBe(flag)
    const applied = reduceBlast(flagFor([{ ...pending, applied: true }]), {
      kind: 'dive',
      tokenId: 'a',
      status: 'success',
      margin: 0,
      coverStep: false,
      smother: false,
    })
    expect(applied.state.rows[0].dive.status).toBe('pending')
  })

  test('cover override, cleared with null', async () => {
    const { reduceBlast } = await import('../../module/agency/explosions/reducer.ts')
    let flag = reduceBlast(flagFor([row(facts('a', 2))]), { kind: 'cover', tokenId: 'a', dr: 7.6 })
    expect(flag.state.rows[0].coverOverride).toBe(7)
    flag = reduceBlast(flag, { kind: 'cover', tokenId: 'a', dr: -3 })
    expect(flag.state.rows[0].coverOverride).toBe(0)
    flag = reduceBlast(flag, { kind: 'cover', tokenId: 'a', dr: null })
    expect(flag.state.rows[0].coverOverride).toBeNull()
  })

  test('Apply marks rows applied and closes their pending dives', async () => {
    const { reduceBlast } = await import('../../module/agency/explosions/reducer.ts')
    const pending = { ...row(facts('a', 2)), dive: { ...noDive(), status: 'pending' as const } }
    const flag = reduceBlast(flagFor([pending, row(facts('b', 3))]), { kind: 'applied', tokenIds: ['a'] })
    expect(flag.state.rows.map((r: RowState) => [r.applied, r.dive.status])).toEqual([
      [true, 'none'],
      [false, 'none'],
    ])
  })

  test('enclosed space and templates', async () => {
    const { reduceBlast } = await import('../../module/agency/explosions/reducer.ts')
    let flag = reduceBlast(flagFor([]), { kind: 'enclosed', value: 2 })
    expect(flag.state.setup.enclosed).toBe(2)
    flag = reduceBlast(flag, { kind: 'templates', ids: [] })
    expect(flag.templateIds).toEqual([])
  })
})
