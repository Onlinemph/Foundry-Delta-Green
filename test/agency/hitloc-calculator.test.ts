/**
 * The hit-location result on upstream's real CompositeDamageCalculator: GUHL multipliers through
 * additionalWoundModifier, the AGENCY injury cap and crippling threshold fields, and the detail
 * left on calculator.agencyHitLocation. Upstream's settings module is mocked (it pulls in sheets).
 */
import { jest } from '@jest/globals'

jest.unstable_mockModule('../../lib/miscellaneous-settings.js', () => ({
  SYSTEM_NAME: 'gurps',
  SETTING_BLUNT_TRAUMA: 'blunt',
  SETTING_LOCATION_MODIFIERS: 'location',
  SETTING_APPLY_DIVISOR: 'divisor',
  SETTING_BODY_HITS: 'bodyhits',
  SETTING_DEFAULT_LOCATION: 'default-hitlocation',
  SETTING_ONLY_GMS_OPEN_ADD: 'only-gms',
}))
jest.unstable_mockModule('../../module/token-actions.js', () => ({ TokenActions: class {} }))

const { CompositeDamageCalculator } = await import('../../module/damage/damagecalculator.js')
const { DamageTable } = await import('../../module/damage/damage-tables.js')
const { HitLocationEntry } = await import('../../module/actor/actor-components.js')
const { HitLocation } = await import('../../module/hitlocation/hitlocation.js')
const { applyToCalculator } = await import('../../module/agency/hitloc/dialog.ts')
const { resolveHit } = await import('../../module/agency/hitloc/engine.ts')

type AnyRecord = Record<string, any>

const g = globalThis as any
g.game.i18n.format = (key: string, data: AnyRecord) => `${key}${JSON.stringify(data)}`
g.GURPS.DamageTables = new DamageTable()
HitLocation.init()

const LOCATIONS: [string, number, string][] = [
  ['Eye', 0, '-'],
  ['Skull', 2, '3-4'],
  ['Face', 0, '5'],
  ['Right Leg', 2, '6-7'],
  ['Right Arm', 2, '8'],
  ['Torso', 6, '9-10'],
  ['Groin', 6, '11'],
  ['Left Arm', 2, '12'],
  ['Left Leg', 2, '13-14'],
  ['Hand', 0, '15'],
  ['Foot', 1, '16'],
  ['Neck', 0, '17-18'],
  ['Vitals', 6, '-'],
]

function defender(hp = 12, ads: AnyRecord = {}): AnyRecord {
  return {
    name: 'Cultist',
    system: {
      HP: { max: hp, value: hp },
      FP: { max: 10, value: 10 },
      ads,
      attributes: { ST: { value: 10 } },
      hitlocations: Object.fromEntries(LOCATIONS.map(([where, dr], i) => [`0000${i}`, { where, dr }])),
      additionalresources: { bodyplan: 'humanoid', tracker: {} },
    },
    get hitLocationsWithDR() {
      return LOCATIONS.map(([where, dr, roll]) => new HitLocationEntry(where, dr, roll))
    },
    _hitLocationRolls: HitLocation.getHitLocationRolls('humanoid'),
    defaultHitLocation: 'Torso',
  }
}

function setup(damage: number, damageType: string, hp = 12, ads: AnyRecord = {}) {
  const actor = defender(hp, ads)
  const calc: any = new CompositeDamageCalculator(actor, [
    { attacker: 'a1', damage, damageType, damageModifier: '', armorDivisor: 0, hitlocation: 'Torso' },
  ])
  calc.useLocationModifiers = true
  calc.viewId = 0
  return { actor, calc, dialog: { _calculator: calc, actor } }
}

const fixed =
  (values: Record<string, number>) =>
  (key: string): number => {
    if (!(key in values)) throw new Error(`unexpected roll '${key}'`)
    return values[key]
  }

function guhl(target: string, type: string, values: Record<string, number> = {}, facing = 'front') {
  return resolveHit({ target } as any, {
    attack: { type: type as any, tightBeam: false },
    facing: facing as any,
    roll: fixed(values),
  })
}

describe('GUHL on the damage calculator', () => {
  test('neck vein: cut x2.5 through the additional wounding modifier', () => {
    const { calc, dialog } = setup(10, 'cut')
    const detail = applyToCalculator(dialog, {
      result: guhl('neckVein', 'cut'),
      where: 'Neck',
      facing: 'front',
      cover: null,
    })
    expect(calc.hitLocation).toBe('Neck')
    expect(calc.additionalWoundModifier).toBe(0.5)
    expect(calc.totalWoundingModifier).toBe(2.5)
    expect(calc.injury).toBe(25) // 10 penetrating x 2.5, neck DR 0
    expect(detail).toMatchObject({
      version: 1,
      system: 'guhl',
      where: 'Neck',
      upstreamLocation: 'Neck',
      part: 'neckVein',
      sub: 'vein',
      woundingMultiplier: 2.5,
      bleedModifier: -4,
      bleedFast: true,
      calledShot: 'neckVein',
    })
    expect(calc.agencyHitLocation).toBe(detail)
  })

  test('the chest injury cap (AGENCY field in pointsToApply)', () => {
    const { calc, dialog } = setup(60, 'cut', 12)
    applyToCalculator(dialog, {
      result: guhl('chest', 'cut', { sub: 3 }),
      where: 'Torso',
      facing: 'front',
      cover: null,
    })
    expect(calc.agencyInjuryCap).toBe(24)
    expect(calc.injury).toBe(81) // (60 - 6) x 1.5
    expect(calc.pointsToApply).toBe(24)
  })

  test('limb vein: no crippling, no limb injury limit (AGENCY crippling threshold)', () => {
    const { calc, dialog } = setup(20, 'cut', 12)
    applyToCalculator(dialog, {
      result: guhl('limbVein', 'cut', { limb: 5, side: 4 }),
      where: 'Left Leg',
      facing: 'front',
      cover: null,
    })
    expect(calc.agencyCripplingThreshold).toBe(Infinity)
    expect(calc.totalWoundingModifier).toBe(2)
    expect(calc.pointsToApply).toBe(36) // (20 - 2) x 2, not capped at HP/2 + 1
    expect(calc.effects.find((e: AnyRecord) => e.type === 'crippling')).toBeUndefined()
  })

  test('a plain leg hit keeps the limb cap', () => {
    const { calc, dialog } = setup(20, 'cut', 12)
    applyToCalculator(dialog, {
      result: guhl('leg', 'cut', { side: 5, sub: 2 }, 'front'),
      where: 'Left Leg',
      facing: 'front',
      cover: null,
    })
    expect(calc.agencyCripplingThreshold).toBeNull()
    expect(calc.pointsToApply).toBe(7) // HP/2 + 1
  })

  test('knee joint: crippled over HP/3', () => {
    const { calc, dialog } = setup(7, 'cr', 12)
    applyToCalculator(dialog, {
      result: guhl('limbJoint', 'cr', { limb: 5, side: 1 }),
      where: 'Right Leg',
      facing: 'front',
      cover: null,
    })
    expect(calc.cripplingThreshold).toBe(4)
    expect(calc.pointsToApply).toBe(5) // 5 penetrating, cap floor(4 + 1)
    expect(calc.effects.find((e: AnyRecord) => e.type === 'crippling')).toBeTruthy()
  })

  test('spine: +3 DR as an override, from behind', () => {
    const { calc, dialog } = setup(12, 'cut')
    applyToCalculator(dialog, { result: guhl('spine', 'cut', {}, 'rear'), where: 'Torso', facing: 'rear', cover: null })
    expect(calc.userEnteredDR).toBe(9)
    expect(calc.injury).toBe(4) // (12 - 9) x 1.5
  })

  test('armor gap: innate DR only', () => {
    const { calc, dialog } = setup(5, 'cr', 12, { a: { name: 'Damage Resistance 1', notes: '', contains: {} } })
    applyToCalculator(dialog, { result: guhl('codpiece', 'cr'), where: 'Groin', facing: 'front', cover: null })
    expect(calc.userEnteredDR).toBe(1)
    expect(calc.injury).toBe(4)
  })

  test('the sub-table replaces upstream\'s "body hits" vitals roll', () => {
    const { calc, dialog } = setup(5, 'pi')
    applyToCalculator(dialog, { result: guhl('chest', 'pi', { sub: 3 }), where: 'Torso', facing: 'front', cover: null })
    expect(calc._hitLocationAdjusted).toBe(true)
  })

  test('picking another location by hand takes the GUHL settings back', () => {
    const { calc, dialog } = setup(10, 'cut')
    applyToCalculator(dialog, { result: guhl('neckVein', 'cut'), where: 'Neck', facing: 'front', cover: null })
    calc.hitLocation = 'Neck'
    expect(calc.agencyHitLocation).not.toBeNull()
    calc.hitLocation = 'Torso'
    expect(calc.hitLocation).toBe('Torso')
    expect(calc.agencyHitLocation).toBeNull()
    expect(calc.additionalWoundModifier).toBe(0)
    expect(calc.userEnteredDR).toBeNull()
    expect(calc.agencyInjuryCap).toBeNull()
  })

  test('a hand-entered modifier survives a location change', () => {
    const { calc, dialog } = setup(10, 'cut')
    applyToCalculator(dialog, { result: guhl('neckVein', 'cut'), where: 'Neck', facing: 'front', cover: null })
    calc.additionalWoundModifier = 1
    calc.hitLocation = 'Skull'
    expect(calc.additionalWoundModifier).toBe(1)
  })

  test('without a body-plan name it falls back to the torso', () => {
    const { calc, dialog } = setup(4, 'cr')
    const detail = applyToCalculator(dialog, { result: guhl('jaw', 'cr'), where: null, facing: 'front', cover: null })
    expect(calc.hitLocation).toBe('Face')
    expect(detail?.where).toBe('Face')
  })
})
