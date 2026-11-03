import { bleedInterval } from '../../module/agency/wounds/bleeding.ts'
import { bleedingModifiers, newWoundRecord } from '../../module/agency/wounds/engine.ts'

const traits: any = {
  highPainThreshold: false,
  hardToSubdue: 0,
  hardToKill: 0,
  hemophilia: false,
  injuryTolerance: null,
  fragileUnnatural: false,
  rapidHealing: false,
}

const input: any = {
  id: 'w1',
  injury: 6,
  maxHP: 10,
  location: 'Neck',
  role: null,
  damageType: 'cut',
  emergency: true,
  created: 0,
}

describe('GUHL bleeding detail on wounds', () => {
  test('location bleed penalty is added to bleeding rolls', () => {
    const plain = bleedingModifiers('major', traits).reduce((s, m) => s + m.value, 0)
    const withLocation = bleedingModifiers('major', traits, -3).reduce((s, m) => s + m.value, 0)
    expect(withLocation).toBe(plain - 3)
  })

  test('zero location modifier adds no row', () => {
    expect(bleedingModifiers('major', traits, 0)).toEqual(bleedingModifiers('major', traits))
  })

  test('fast bleeding halves the interval', () => {
    const normal = bleedInterval({ severity: 'major', special: null, consecutive: 0, successes: 0 })
    const fast = bleedInterval({ severity: 'major', special: null, consecutive: 0, successes: 0, fast: true })
    expect(normal).not.toBeNull()
    expect(fast).toBe((normal as number) / 2)
  })

  test('new wound records keep the hit-location bleeding detail', () => {
    const record = newWoundRecord({ ...input, bleedModifier: -2, bleedFast: true }, 'major', traits)
    expect(record.bleedModifier).toBe(-2)
    expect(record.bleeding.fast).toBe(true)
  })

  test('without hit-location detail the record is unchanged', () => {
    const record = newWoundRecord(input, 'major', traits)
    expect(record.bleedModifier).toBeUndefined()
    expect(record.bleeding.fast).toBeUndefined()
  })
})
