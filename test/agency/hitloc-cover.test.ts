import {
  COVER_PRESETS,
  COVER_ZONES,
  coverIsActive,
  coverZones,
  effectiveCoverDR,
  normalizeCover,
  presetZones,
  resolveCoverHit,
  type CoverData,
  type CoverPreset,
} from '../../module/agency/hitloc/cover.ts'
import type { CoverZone, Roller } from '../../module/agency/hitloc/types.ts'

const covered = (preset: CoverPreset) =>
  Object.entries(presetZones(preset))
    .filter(([, state]) => state === 'covered')
    .map(([zone]) => zone)
    .sort()
const half = (preset: CoverPreset) =>
  Object.entries(presetZones(preset))
    .filter(([, state]) => state === 'half')
    .map(([zone]) => zone)
    .sort()

const noDice: Roller = key => {
  throw new Error(`unexpected roll '${key}'`)
}
const die =
  (value: number): Roller =>
  () =>
    value

const wall = (extra: Partial<CoverData> = {}): CoverData => ({
  preset: 'lowWall',
  dr: 8,
  hp: null,
  hpMax: null,
  material: 'Brick',
  ...extra,
})

describe('cover presets', () => {
  test('none covers nothing', () => expect(covered('none')).toEqual([]))

  test('low wall: legs, feet, groin and abdomen', () =>
    expect(covered('lowWall')).toEqual(['abdomen', 'footL', 'footR', 'legL', 'legR']))

  test('chest-high: everything below the neck', () =>
    expect(covered('chestHigh')).toEqual(
      ['abdomen', 'armL', 'armR', 'chest', 'footL', 'footR', 'handL', 'handR', 'legL', 'legR'].sort()
    ))

  test('firing over cover: only skull, face, neck, arms and hands exposed', () => {
    expect(covered('overCover')).toEqual(['abdomen', 'chest', 'footL', 'footR', 'legL', 'legR'])
    const exposed = Object.entries(presetZones('overCover'))
      .filter(([, s]) => s === 'exposed')
      .map(([z]) => z)
      .sort()
    expect(exposed).toEqual(['armL', 'armR', 'face', 'handL', 'handR', 'neck', 'skull'])
  })

  test("corners: that side's limbs, half the torso", () => {
    expect(covered('cornerLeft')).toEqual(['armL', 'footL', 'handL', 'legL'])
    expect(half('cornerLeft')).toEqual(['abdomen', 'chest'])
    expect(covered('cornerRight')).toEqual(['armR', 'footR', 'handR', 'legR'])
    expect(half('cornerRight')).toEqual(['abdomen', 'chest'])
  })

  test('full: everything', () => expect(covered('full')).toEqual([...COVER_ZONES].sort()))

  test('custom zones', () => {
    const zones = coverZones({ ...wall(), preset: 'custom', zones: { skull: 'covered', chest: 'half' } })
    expect(zones.skull).toBe('covered')
    expect(zones.chest).toBe('half')
    expect(zones.armL).toBe('exposed')
  })

  test('every preset is listed', () => expect(COVER_PRESETS).toContain('custom'))
})

describe('normalizeCover', () => {
  test('no cover', () => {
    expect(normalizeCover(null)).toBeNull()
    expect(normalizeCover({ preset: 'none', dr: 5 })).toBeNull()
    expect(normalizeCover({ preset: 'bogus' })).toBeNull()
    expect(normalizeCover('lowWall')).toBeNull()
  })

  test('form values', () => {
    expect(normalizeCover({ preset: 'lowWall', dr: '12', hp: '', hpMax: '40', material: ' Brick ' })).toEqual({
      preset: 'lowWall',
      dr: 12,
      hp: 40,
      hpMax: 40,
      material: 'Brick',
    })
  })

  test('untracked HP, bad DR', () => {
    expect(normalizeCover({ preset: 'full', dr: -3, hp: '', hpMax: '' })).toEqual({
      preset: 'full',
      dr: 0,
      hp: null,
      hpMax: null,
      material: '',
    })
  })

  test('custom keeps only real zone states', () => {
    const cover = normalizeCover({
      preset: 'custom',
      dr: 4,
      zones: { skull: 'covered', face: 'exposed', chest: 'half', legL: 'nonsense', bogus: 'covered' },
    })
    expect(cover?.zones).toEqual({ skull: 'covered', chest: 'half' })
  })

  test('active: has covered zones and HP left', () => {
    expect(coverIsActive(null)).toBe(false)
    expect(coverIsActive(wall())).toBe(true)
    expect(coverIsActive(wall({ hp: 0, hpMax: 20 }))).toBe(false)
    expect(coverIsActive(wall({ preset: 'custom', zones: {} }))).toBe(false)
  })
})

describe('cover DR vs armor divisors', () => {
  test.each([
    [10, 0, 10],
    [10, 1, 10],
    [10, 2, 5],
    [10, 3, 3],
    [10, -1, 0],
    [10, 0.5, 20],
    [0, 0.5, 1],
  ])('DR %i, divisor %p -> %i', (dr, divisor, expected) => expect(effectiveCoverDR(dr, divisor)).toBe(expected))
})

describe('a hit against cover', () => {
  const base = { hp: null, called: false, damage: 12, armorDivisor: 0, roll: noDice }

  test('no cover, or an exposed zone: everything goes through', () => {
    expect(resolveCoverHit({ ...base, cover: null, zone: 'chest' }).through).toBe(12)
    const exposed = resolveCoverHit({ ...base, cover: wall(), zone: 'chest' })
    expect(exposed.hitsCover).toBe(false)
    expect(exposed.through).toBe(12)
    expect(exposed.state).toBe('exposed')
  })

  test('a covered zone: the cover takes it, the rest continues', () => {
    const r = resolveCoverHit({ ...base, cover: wall(), zone: 'legL' })
    expect(r).toMatchObject({ hitsCover: true, coverDR: 8, absorbed: 8, through: 4, destroyed: false })
  })

  test('stopped entirely', () => {
    const r = resolveCoverHit({ ...base, damage: 6, cover: wall(), zone: 'footR' })
    expect(r).toMatchObject({ hitsCover: true, absorbed: 6, through: 0 })
  })

  test('armor divisor applies to cover', () => {
    const r = resolveCoverHit({ ...base, armorDivisor: 2, cover: wall(), zone: 'abdomen' })
    expect(r).toMatchObject({ coverDR: 4, through: 8 })
  })

  test('cover HP drops by what penetrates; at 0 it is destroyed', () => {
    const first = resolveCoverHit({ ...base, cover: wall({ hp: 6, hpMax: 10 }), hp: 6, zone: 'legL' })
    expect(first).toMatchObject({ hpBefore: 6, hpAfter: 2, destroyed: false })
    const second = resolveCoverHit({ ...base, cover: wall({ hp: 6, hpMax: 10 }), hp: 2, zone: 'legL' })
    expect(second).toMatchObject({ hpBefore: 2, hpAfter: -2, destroyed: true, through: 4 })
    const third = resolveCoverHit({ ...base, cover: wall({ hp: 6, hpMax: 10 }), hp: -2, zone: 'legL' })
    expect(third).toMatchObject({ hitsCover: false, through: 12 })
  })

  test('a hit that does not penetrate leaves the HP alone', () => {
    const r = resolveCoverHit({ ...base, damage: 5, cover: wall({ hp: 10, hpMax: 10 }), hp: 10, zone: 'legL' })
    expect(r).toMatchObject({ through: 0, hpAfter: 10 })
  })

  test.each([
    [1, true],
    [3, true],
    [4, false],
    [6, false],
  ])('half cover, random hit, 1d6 = %i: hits cover %p', (value, hits) => {
    const r = resolveCoverHit({ ...base, cover: wall({ preset: 'cornerLeft' }), zone: 'chest', roll: die(value) })
    expect(r.roll).toBe(value)
    expect(r.hitsCover).toBe(hits)
  })

  test('half cover, called shot: aimed at the exposed half', () => {
    const r = resolveCoverHit({ ...base, called: true, cover: wall({ preset: 'cornerLeft' }), zone: 'chest' })
    expect(r).toMatchObject({ hitsCover: false, roll: null, through: 12 })
  })

  test('a called shot at a covered part hits the cover', () => {
    const r = resolveCoverHit({ ...base, called: true, cover: wall({ preset: 'full' }), zone: 'skull' as CoverZone })
    expect(r.hitsCover).toBe(true)
  })
})
