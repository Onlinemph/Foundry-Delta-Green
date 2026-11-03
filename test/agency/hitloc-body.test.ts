import {
  bodyCandidates,
  canonicalWhere,
  innateDR,
  isGuhlBody,
  mapToBody,
  regionOfWhere,
  resolveStandard,
  rollOnBodyTable,
  type BodyLocation,
} from '../../module/agency/hitloc/body.ts'
import { resolveHit } from '../../module/agency/hitloc/engine.ts'
import type { Roller } from '../../module/agency/hitloc/types.ts'

const dice =
  (values: Record<string, number>): Roller =>
  key => {
    if (!(key in values)) throw new Error(`unexpected roll '${key}'`)
    return values[key]
  }

/** A GCS humanoid as upstream imports it ("Arm" is split into Right Arm / Left Arm). */
const GCS_HUMANOID = [
  'Eye',
  'Skull',
  'Face',
  'Right Leg',
  'Right Arm',
  'Torso',
  'Groin',
  'Left Arm',
  'Left Leg',
  'Hand',
  'Foot',
  'Neck',
  'Vitals',
]

const HUMANOID_TABLE: BodyLocation[] = [
  { where: 'Eye', roll: [] },
  { where: 'Skull', roll: [3, 4] },
  { where: 'Face', roll: [5] },
  { where: 'Right Leg', roll: [6, 7] },
  { where: 'Right Arm', roll: [8] },
  { where: 'Torso', roll: [9, 10] },
  { where: 'Groin', roll: [11] },
  { where: 'Left Arm', roll: [12] },
  { where: 'Left Leg', roll: [13, 14] },
  { where: 'Hand', roll: [15] },
  { where: 'Foot', roll: [16] },
  { where: 'Neck', roll: [17, 18] },
  { where: 'Vitals', roll: [] },
]

const QUADRUPED_TABLE: BodyLocation[] = [
  { where: 'Eye', roll: [] },
  { where: 'Skull', roll: [3, 4] },
  { where: 'Face', roll: [5] },
  { where: 'Neck', roll: [6] },
  { where: 'Foreleg', roll: [7, 8] },
  { where: 'Torso', roll: [9, 10, 11] },
  { where: 'Groin', roll: [12] },
  { where: 'Hind Leg', roll: [13, 14] },
  { where: 'Foot', roll: [15, 16] },
  { where: 'Tail', roll: [17, 18] },
  { where: 'Vitals', roll: [] },
]

describe('body-plan names', () => {
  test('candidates: side first, then generic and plural', () => {
    expect(bodyCandidates(['Arm'], 'left')).toEqual(['Left Arm', 'Arm (Left)', 'Arm', 'Arms'])
    expect(bodyCandidates(['Foot'], 'right')).toEqual(['Right Foot', 'Foot (Right)', 'Foot', 'Feet'])
    expect(bodyCandidates(['Skull'], null)).toEqual(['Skull', 'Brain'])
    expect(bodyCandidates(['Spine', 'Torso'], null)).toEqual(['Spine', 'Torso'])
  })

  test.each<[string[], 'left' | 'right' | null, string[], string | null]>([
    [['Arm'], 'left', GCS_HUMANOID, 'Left Arm'],
    [['Leg'], 'right', GCS_HUMANOID, 'Right Leg'],
    [['Hand'], 'left', GCS_HUMANOID, 'Hand'],
    [['Eye', 'Face'], null, GCS_HUMANOID, 'Eye'],
    [['Spine', 'Torso'], null, GCS_HUMANOID, 'Torso'],
    [['Abdomen', 'Torso'], null, GCS_HUMANOID, 'Torso'],
    [['Abdomen', 'Torso'], null, [...GCS_HUMANOID, 'Abdomen'], 'Abdomen'],
    [['Vitals, Heart', 'Heart', 'Vitals', 'Torso'], null, GCS_HUMANOID, 'Vitals'],
    [['Arm'], 'left', ['Arm', 'Torso'], 'Arm'],
    [['Arm'], 'right', ['Arms', 'Torso'], 'Arms'],
    [['Eye', 'Face'], null, ['Eyes', 'Face'], 'Eyes'],
    [['Eye', 'Face'], null, ['Skull', 'Face'], 'Face'],
    [['Skull'], null, ['Brain', 'Torso'], 'Brain'],
    [['Leg'], 'left', ['left leg'], 'left leg'],
    [['Neck'], null, ['Torso'], null],
  ])('%p (%s) on %p -> %p', (bodyKeys, side, wheres, expected) => {
    expect(mapToBody({ bodyKeys, side }, wheres)).toBe(expected)
  })

  test('matches translated names', () => {
    const pt: Record<string, string> = { Torso: 'Tronco', 'Left Arm': 'Braço Esquerdo' }
    const localize = (name: string) => pt[name] ?? name
    expect(mapToBody({ bodyKeys: ['Torso'], side: null }, ['Tronco', 'Braço Esquerdo'], localize)).toBe('Tronco')
    expect(mapToBody({ bodyKeys: ['Arm'], side: 'left' }, ['Tronco', 'Braço Esquerdo'], localize)).toBe(
      'Braço Esquerdo'
    )
  })

  test('engine results map onto a GCS humanoid', () => {
    const cases: [Record<string, number>, string][] = [
      [{ main: 14, sub: 6 }, 'Left Leg'],
      [{ main: 8, sub: 4 }, 'Right Arm'],
      [{ main: 15, side: 6, sub: 2 }, 'Hand'],
      [{ main: 11, sub: 6 }, 'Groin'],
      [{ main: 11, sub: 3 }, 'Torso'],
      [{ main: 9, sub: 1 }, 'Vitals'],
      [{ main: 5, sub: 6 }, 'Eye'],
      [{ main: 5, sub: 1 }, 'Face'],
      [{ main: 17, sub: 1 }, 'Neck'],
    ]
    for (const [values, where] of cases) {
      const r = resolveHit(
        { target: 'random' },
        { attack: { type: 'pi', tightBeam: false }, facing: 'front', roll: dice(values) }
      )
      expect(mapToBody(r, GCS_HUMANOID)).toBe(where)
    }
  })
})

describe('which bodies take GUHL', () => {
  test.each<[string | null, string[], boolean]>([
    ['humanoid', GCS_HUMANOID, true],
    ['Humanoid', GCS_HUMANOID, true],
    ['humanoid expanded', [...GCS_HUMANOID, 'Chest'], true],
    ['winged humanoid', [...GCS_HUMANOID, 'Wing'], true],
    ['', GCS_HUMANOID, true],
    [null, ['Skull', 'Torso', 'Arm', 'Leg'], true],
    ['quadruped', QUADRUPED_TABLE.map(e => e.where), false],
    ['tailed humanoid', [...GCS_HUMANOID, 'Tail'], false],
    ['', QUADRUPED_TABLE.map(e => e.where), false],
    ['humanoid', ['Skull', 'Torso', 'Left Arm', 'Left Leg', 'Right Leg'], false],
    ['', [], false],
  ])('%p with %p -> %p', (plan, wheres, expected) => expect(isGuhlBody(plan, wheres)).toBe(expected))
})

describe("upstream's own table", () => {
  test('rollOnBodyTable', () => {
    expect(rollOnBodyTable(QUADRUPED_TABLE, 11)).toBe('Torso')
    expect(rollOnBodyTable(QUADRUPED_TABLE, 17)).toBe('Tail')
    expect(rollOnBodyTable(QUADRUPED_TABLE, 2)).toBeNull()
  })

  test('random: 3d6 on the actor table', () => {
    const r = resolveStandard({ target: 'random' }, null, QUADRUPED_TABLE, dice({ main: 7 }))
    expect(r.system).toBe('standard')
    expect(r.path).toEqual([{ raw: 'Foreleg' }])
    expect(r.bodyKeys).toEqual(['Foreleg'])
    expect(r.upstream).toBe('Foreleg')
    expect(r.region).toBe('leg')
    expect(r.multiplier).toBeNull()
    expect(r.rolls).toEqual([{ key: 'main', dice: 3, value: 7 }])
  })

  test('a called location the body has', () => {
    const r = resolveStandard({ target: 'skull' }, 'Skull', QUADRUPED_TABLE, dice({}))
    expect(r.bodyKeys).toEqual(['Skull'])
    expect(r.zone).toBe('skull')
    expect(r.rolls).toEqual([])
  })

  test('a called name the body lacks lands on the torso', () => {
    expect(resolveStandard({ target: 'spine' }, 'Spine', QUADRUPED_TABLE, dice({})).bodyKeys).toEqual(['Torso'])
  })

  test('the default torso', () => {
    expect(resolveStandard({ target: 'chest' }, null, HUMANOID_TABLE, dice({})).bodyKeys).toEqual(['Torso'])
  })

  test('sides and zones from names', () => {
    const r = resolveStandard({ target: 'random' }, null, HUMANOID_TABLE, dice({ main: 12 }))
    expect(r.bodyKeys).toEqual(['Left Arm'])
    expect(r.side).toBe('left')
    expect(r.zone).toBe('armL')
    expect(r.upstream).toBe('Arm')
  })

  test('an empty roll table falls back', () => {
    expect(resolveStandard({ target: 'random' }, null, [], dice({ main: 10 })).bodyKeys).toEqual(['Torso'])
  })

  test.each([
    ['Skull', 'skull'],
    ['Brain', 'skull'],
    ['Eye', 'face'],
    ['Neck', 'neck'],
    ['Torso', 'chest'],
    ['Vitals', 'chest'],
    ['Groin', 'abdomen'],
    ['Tail', 'abdomen'],
    ['Wing', 'arm'],
    ['Hind Leg', 'leg'],
    ['Foreleg', 'leg'],
    ['Foot', 'foot'],
    ['Fin', 'hand'],
    ['Extremity', 'hand'],
    ['Arm 1-2', 'arm'],
  ])('region of %s: %s', (where, region) => expect(regionOfWhere(where)).toBe(region))

  test.each([
    ['Left Arm', 'Arm'],
    ['Right Leg', 'Leg'],
    ['Arms', 'Arm'],
    ['Feet', 'Foot'],
    ['Torso*', 'Torso'],
    ['Arm (Left)', 'Arm'],
    ['Skull', 'Skull'],
  ])('canonical %s -> %s', (where, name) => expect(canonicalWhere(where)).toBe(name))
})

describe('innate DR', () => {
  test.each([
    [[{ name: 'Damage Resistance 2' }], 2],
    [[{ name: 'Damage Resistance', level: 3 }], 3],
    [[{ name: 'Damage Resistance', level: '4' }], 4],
    [[{ name: 'damage resistance 1 (Tough Skin)' }, { name: 'Damage Resistance', level: 2 }], 3],
    [[{ name: 'Combat Reflexes' }, { name: 'High Pain Threshold' }], 0],
    [[{ name: 'Damage Resistance' }], 0],
    [[], 0],
  ])('%p -> %i', (traits, dr) => expect(innateDR(traits)).toBe(dr))
})
