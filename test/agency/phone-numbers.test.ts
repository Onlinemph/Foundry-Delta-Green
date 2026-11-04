import {
  AREA_CODES,
  formatNumber,
  formatPartial,
  generateNumber,
  isFictional,
  normalizeNumber,
  validateNumber,
} from '../../module/agency/phone/numbers.ts'
import { prng } from '../../module/agency/phone/photos.ts'

describe('phone numbers', () => {
  test('generated numbers are always in the 555-0100..0199 fiction block', () => {
    const rng = prng(42)
    for (let i = 0; i < 200; i++) {
      const n = generateNumber([], rng, '202')!
      expect(isFictional(n)).toBe(true)
      expect(n.startsWith('202')).toBe(true)
    }
  })

  test('generated numbers never repeat a taken one', () => {
    const rng = prng(7)
    const taken: string[] = []
    for (let i = 0; i < 100; i++) {
      const n = generateNumber(taken, rng, '312')!
      expect(taken).not.toContain(n)
      taken.push(n)
    }
    // All 100 lines of 312 are used now: the next spills into another area code.
    expect(new Set(taken).size).toBe(100)
    const next = generateNumber(taken, rng, '312')!
    expect(next.startsWith('312')).toBe(false)
    expect(isFictional(next)).toBe(true)
  })

  test('null once every listed area code is full', () => {
    const all = ['202', '212'].flatMap(a =>
      Array.from({ length: 100 }, (_, i) => `${a}55501${String(i).padStart(2, '0')}`)
    )
    expect(generateNumber(all, prng(1), '202', ['202', '212'])).toBeNull()
    expect(AREA_CODES.length).toBeGreaterThan(5)
  })

  test('deterministic with a seeded rng', () => {
    expect(generateNumber([], prng(3), undefined)).toBe(generateNumber([], prng(3), undefined))
  })

  test('normalising what people dial', () => {
    expect(normalizeNumber('555-0143', '202')).toBe('2025550143')
    expect(normalizeNumber('(312) 555-0199')).toBe('3125550199')
    expect(normalizeNumber('1 312 555 0199')).toBe('3125550199')
    expect(normalizeNumber('+1-312-555-0199')).toBe('3125550199')
    expect(normalizeNumber('911')).toBeNull()
    expect(normalizeNumber('')).toBeNull()
    expect(normalizeNumber('5550143', 'bad')).toBe('2025550143')
  })

  test('formatting', () => {
    expect(formatNumber('2025550143')).toBe('(202) 555-0143')
    expect(formatNumber('2025550143', 'dash')).toBe('202-555-0143')
    expect(formatNumber('123')).toBe('123')
    expect(formatPartial('202')).toBe('202')
    expect(formatPartial('5550177')).toBe('555-0177')
    expect(formatPartial('20255501')).toBe('202-555-01')
  })

  test('isFictional only accepts 555-01xx', () => {
    expect(isFictional('2025550100')).toBe(true)
    expect(isFictional('2025550199')).toBe(true)
    expect(isFictional('2025550200')).toBe(false)
    expect(isFictional('2025551234')).toBe(false)
  })

  test('validating a number the GM types', () => {
    const taken = ['2025550143', '2025550100']
    expect(validateNumber('555-0143', taken, '202')).toEqual({ ok: false, error: 'taken', number: '2025550143' })
    expect(validateNumber('555-0143', taken, '202', '2025550143')).toEqual({
      ok: true,
      number: '2025550143',
      fictional: true,
    })
    expect(validateNumber('12', taken)).toEqual({ ok: false, error: 'format' })
    expect(validateNumber('202-867-5309', taken)).toEqual({ ok: true, number: '2028675309', fictional: false })
  })
})
