import {
  calculatorConfig,
  upstreamMultiplier,
  type CalculatorInput,
  type LocationRole,
} from '../../module/agency/hitloc/calc.ts'
import { resolveHit } from '../../module/agency/hitloc/engine.ts'
import type { AttackType, DamageType, Facing, HitResult, Roller, TargetId } from '../../module/agency/hitloc/types.ts'

const A = (type: DamageType, tightBeam = false): AttackType => ({ type, tightBeam })
const dice =
  (values: Record<string, number>): Roller =>
  key => {
    if (!(key in values)) throw new Error(`unexpected roll '${key}'`)
    return values[key]
  }
const hit = (target: TargetId, attack: AttackType, values: Record<string, number> = {}, facing: Facing = 'rear') =>
  resolveHit({ target }, { attack, facing, roll: dice(values) })

function config(result: HitResult, attack: AttackType, where: string, extra: Partial<CalculatorInput> = {}) {
  return calculatorConfig({
    result,
    attack,
    where,
    role: null,
    useLocationModifiers: true,
    injuryTolerance: null,
    locationDR: 0,
    innateDR: 0,
    hpMax: 12,
    torsoCap: '2',
    ...extra,
  })
}

describe("upstream's location multipliers", () => {
  test.each<[string, LocationRole, DamageType, boolean, number]>([
    ['Vitals', 'chest', 'pi', false, 3],
    ['Vitals', 'chest', 'burn', true, 2],
    ['Vitals', 'chest', 'cr', false, 1],
    ['Skull', null, 'cr', false, 4],
    ['Skull', null, 'tox', false, 1],
    ['Eye', null, 'pi', false, 4],
    ['Eyes', null, 'pi', false, 1],
    ['Face', null, 'cor', false, 1.5],
    ['Neck', null, 'cut', false, 2],
    ['Neck', null, 'cr', false, 1.5],
    ['Left Arm', 'limb', 'imp', false, 1],
    ['Hand', 'extremity', 'pi++', false, 1],
    ['Hand', 'extremity', 'cut', false, 1.5],
    ['Arm', null, 'imp', false, 2],
    ['Torso', 'chest', 'pi+', false, 1.5],
  ])('%s (%s), %s: x%p', (where, role, type, tb, expected) => {
    expect(upstreamMultiplier(where, role, A(type, tb), true)).toBe(expected)
  })

  test('without location modifiers, the plain table', () => {
    expect(upstreamMultiplier('Skull', null, A('cr'), false)).toBe(1)
    expect(upstreamMultiplier('Neck', null, A('cut'), false)).toBe(1.5)
  })
})

describe('additional wounding modifier (GUHL minus upstream)', () => {
  test('neck vein, cutting: 2.5 vs 2', () => {
    expect(config(hit('neckVein', A('cut')), A('cut'), 'Neck').additionalWoundModifier).toBe(0.5)
  })

  test('neck vein, crushing would be 2 vs 1.5', () => {
    // Crushing can't target the vein; the random G1 result for cr from the rear is the spine.
    const r = hit('random', A('cut'), { main: 17, sub: 1 })
    expect(r.part).toBe('neckVein')
    const asCrush = { ...r, multiplier: 2 }
    expect(config(asCrush, A('cr'), 'Neck').additionalWoundModifier).toBe(0.5)
  })

  test('limb vein, cutting on a limb: 2 vs 1.5', () => {
    const r = hit('limbVein', A('cut'), { limb: 5, side: 4 })
    expect(config(r, A('cut'), 'Left Leg', { role: 'limb' }).additionalWoundModifier).toBe(0.5)
  })

  test('limb vein, impaling: no limb cap, 2 vs 1', () => {
    const r = hit('limbVein', A('imp'), { limb: 5, side: 4 })
    expect(config(r, A('imp'), 'Left Leg', { role: 'limb' }).additionalWoundModifier).toBe(1)
  })

  test('arm on a body plan without limb roles: GUHL 1 vs upstream 2', () => {
    const r = hit('arm', A('imp'), { side: 1, sub: 2 })
    expect(config(r, A('imp'), 'Arm').additionalWoundModifier).toBe(-1)
    expect(config(r, A('imp'), 'Right Arm', { role: 'limb' }).additionalWoundModifier).toBe(0)
  })

  test('eye on a GCA "Eyes" location: x4 vs x1', () => {
    expect(config(hit('eye', A('pi')), A('pi'), 'Eyes').additionalWoundModifier).toBe(3)
    expect(config(hit('eye', A('pi')), A('pi'), 'Eye').additionalWoundModifier).toBe(0)
  })

  test('nose shot into the skull, upstream knows the skull', () => {
    expect(config(hit('nose', A('pi'), {}, 'front'), A('pi'), 'Skull').additionalWoundModifier).toBe(0)
  })

  test('tight-beam vitals mapped to the torso: x2 vs x1', () => {
    const tb = A('burn', true)
    expect(config(hit('vitals', tb), tb, 'Torso').additionalWoundModifier).toBe(1)
    expect(config(hit('vitals', tb), tb, 'Vitals').additionalWoundModifier).toBe(0)
  })

  test('upstream location modifiers off: GUHL still applies its own', () => {
    expect(
      config(hit('neck', A('cut'), { sub: 2 }), A('cut'), 'Neck', { useLocationModifiers: false })
        .additionalWoundModifier
    ).toBe(0.5)
  })

  test('Homogenous and Diffuse ignore location modifiers', () => {
    const r = hit('neckVein', A('cut'))
    expect(config(r, A('cut'), 'Neck', { injuryTolerance: 'homogenous' }).additionalWoundModifier).toBe(0)
    expect(config(r, A('cut'), 'Neck', { injuryTolerance: 'diffuse' }).additionalWoundModifier).toBe(0)
  })

  test('Unliving caps impaling and piercing on both sides', () => {
    const vein = hit('limbVein', A('imp'), { limb: 5, side: 4 })
    expect(
      config(vein, A('imp'), 'Left Leg', { role: 'limb', injuryTolerance: 'unliving' }).additionalWoundModifier
    ).toBe(0)
    const cut = hit('neckVein', A('cut'))
    expect(config(cut, A('cut'), 'Neck', { injuryTolerance: 'unliving' }).additionalWoundModifier).toBe(0.5)
    // Vitals are exempt on both sides.
    expect(
      config(hit('vitals', A('pi')), A('pi'), 'Vitals', { injuryTolerance: 'unliving' }).additionalWoundModifier
    ).toBe(0)
  })

  test('damage GUHL has no multiplier for leaves upstream alone', () => {
    expect(config(hit('skull', A('other')), A('other'), 'Skull').additionalWoundModifier).toBe(0)
  })
})

describe('DR', () => {
  test('spine: location DR + 3', () => {
    expect(config(hit('spine', A('cut')), A('cut'), 'Torso', { locationDR: 5 }).userEnteredDR).toBe(8)
  })

  test('chinks: half DR, rounded down', () => {
    expect(config(hit('chinksTorso', A('cut'), { sub: 3 }), A('cut'), 'Torso', { locationDR: 7 }).userEnteredDR).toBe(3)
  })

  test('armor gap: innate DR only', () => {
    expect(config(hit('codpiece', A('cr')), A('cr'), 'Groin', { locationDR: 12, innateDR: 2 }).userEnteredDR).toBe(2)
  })

  test('a plain hit keeps the location DR', () => {
    expect(config(hit('skull', A('cr')), A('cr'), 'Skull', { locationDR: 6 }).userEnteredDR).toBeNull()
  })
})

describe('injury cap and crippling', () => {
  test.each([
    ['2', 24],
    ['1', 12],
    ['none', null],
  ] as const)('chest with cap %s: %p HP', (cap, expected) => {
    expect(config(hit('chest', A('cut'), { sub: 3 }), A('cut'), 'Torso', { torsoCap: cap }).injuryCap).toBe(expected)
  })

  test('vitals and limbs have no torso cap', () => {
    expect(config(hit('vitals', A('pi')), A('pi'), 'Vitals').injuryCap).toBeNull()
    expect(config(hit('leg', A('cut'), { side: 1, sub: 2 }), A('cut'), 'Right Leg').injuryCap).toBeNull()
  })

  test('crippling thresholds: limb joint HP/3, extremity joint HP/4, vein never', () => {
    expect(config(hit('limbJoint', A('cr'), { limb: 1, side: 1 }), A('cr'), 'Right Arm').cripplingThreshold).toBe(4)
    expect(config(hit('extremityJoint', A('cr'), { extremity: 1, side: 1 }), A('cr'), 'Hand').cripplingThreshold).toBe(
      3
    )
    expect(config(hit('limbVein', A('cut'), { limb: 1, side: 1 }), A('cut'), 'Right Arm').cripplingThreshold).toBe(
      Infinity
    )
    expect(config(hit('arm', A('cut'), { side: 1, sub: 2 }), A('cut'), 'Right Arm').cripplingThreshold).toBeNull()
  })
})
