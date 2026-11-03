import { formatRounds, fullLoad, isTracked, parseShots, type ShotsSpec } from '../../module/agency/firearms/shots.js'

const tracked = (capacity: number, chambered: number, reloadSeconds: number, individual = false): ShotsSpec => ({
  capacity,
  chambered,
  reloadSeconds,
  individual,
  thrown: false,
  untracked: false,
})

const untracked: ShotsSpec = {
  capacity: 0,
  chambered: 0,
  reloadSeconds: 0,
  individual: false,
  thrown: false,
  untracked: true,
}

describe('parseShots', () => {
  describe('magazines, cylinders and belts', () => {
    test.each([
      ['17+1(3)', tracked(17, 1, 3)],
      ['30(3)', tracked(30, 0, 3)],
      ['100(5)', tracked(100, 0, 5)],
      ['200(5)', tracked(200, 0, 5)],
      ['1(2)', tracked(1, 0, 2)],
      ['1(20)', tracked(1, 0, 20)],
      ['30+1(3)', tracked(30, 1, 3)],
      ['6(3)', tracked(6, 0, 3)],
    ])('%s', (text, expected) => {
      expect(parseShots(text)).toEqual(expected)
    })
  })

  describe('individually loaded', () => {
    test.each([
      ['8(3i)', tracked(8, 0, 3, true)],
      ['5(2i)', tracked(5, 0, 2, true)],
      ['2(2i)', tracked(2, 0, 2, true)],
      ['1(3i)', tracked(1, 0, 3, true)],
      ['5+1(3i)', tracked(5, 1, 3, true)],
      ['6(1i)', tracked(6, 0, 1, true)],
    ])('%s', (text, expected) => {
      expect(parseShots(text)).toEqual(expected)
    })
  })

  describe('thrown', () => {
    test('T(1) is thrown, not counted as rounds', () => {
      expect(parseShots('T(1)')).toEqual({ ...untracked, thrown: true, reloadSeconds: 1 })
    })

    test('lower-case t(2)', () => {
      expect(parseShots('t(2)')).toEqual({ ...untracked, thrown: true, reloadSeconds: 2 })
    })

    test('bare T', () => {
      expect(parseShots('T')).toEqual({ ...untracked, thrown: true })
    })

    test('T(F): a non-numeric time is ignored', () => {
      expect(parseShots('T(F)')).toEqual({ ...untracked, thrown: true })
    })
  })

  describe('nothing to track', () => {
    test.each([
      ['', 'blank'],
      ['   ', 'whitespace'],
      ['Sp', 'special'],
      ['sp', 'special, lower case'],
      ['FP', 'fatigue'],
      ['1FP', 'fatigue with a number'],
      ['2 FP', 'fatigue with a space'],
      ['-', 'dash'],
      ['–', 'en dash'],
      ['0', 'zero'],
      ['0(3)', 'zero with a reload time'],
      ['∞', 'infinity'],
      ['N/A', 'text'],
    ])('%s (%s)', text => {
      const spec = parseShots(text)
      expect(spec.untracked).toBe(true)
      expect(spec.thrown).toBe(false)
      expect(isTracked(spec)).toBe(false)
    })

    test.each([[null], [undefined], [0], [{}]])('non-string %p', value => {
      expect(parseShots(value).untracked).toBe(true)
    })
  })

  describe('alternatives use the first load', () => {
    test('4(3i)/6(3i)', () => {
      expect(parseShots('4(3i)/6(3i)')).toEqual(tracked(4, 0, 3, true))
    })

    test('30(3)/100(5)', () => {
      expect(parseShots('30(3)/100(5)')).toEqual(tracked(30, 0, 3))
    })

    test('20/C(3): the reload time comes from later in the string', () => {
      expect(parseShots('20/C(3)')).toEqual(tracked(20, 0, 3))
    })
  })

  describe('tolerates formatting noise', () => {
    test.each([
      [' 17+1(3) ', tracked(17, 1, 3)],
      ['17 + 1 (3)', tracked(17, 1, 3)],
      ['8 (3 i)', tracked(8, 0, 3, true)],
      ['8(3I)', tracked(8, 0, 3, true)],
      ['30(3)*', tracked(30, 0, 3)],
      ['30(3)†', tracked(30, 0, 3)],
      ['1(2.5)', tracked(1, 0, 2.5)],
      ['1(2,5)', tracked(1, 0, 2.5)],
    ])('%p', (text, expected) => {
      expect(parseShots(text)).toEqual(expected)
    })

    test('a count without a reload time is tracked, time unknown', () => {
      expect(parseShots('20')).toEqual(tracked(20, 0, 0))
    })

    test('numbers are accepted', () => {
      expect(parseShots(30)).toEqual(tracked(30, 0, 0))
    })
  })

  test('returns a fresh object each time', () => {
    const a = parseShots('')
    a.capacity = 99
    expect(parseShots('').capacity).toBe(0)
  })
})

describe('fullLoad / formatRounds', () => {
  test('chamber counts toward a full load', () => {
    expect(fullLoad(parseShots('17+1(3)'))).toBe(18)
    expect(fullLoad(parseShots('30(3)'))).toBe(30)
    expect(fullLoad(parseShots('T(1)'))).toBe(0)
    expect(fullLoad(parseShots('Sp'))).toBe(0)
  })

  test.each([
    [14, '17+1(3)', '14/17+1'],
    [18, '17+1(3)', '18/17+1'],
    [0, '17+1(3)', '0/17+1'],
    [5, '8(3i)', '5/8'],
    [1, '1(2)', '1/1'],
    [-3, '30(3)', '0/30'],
    [2.7, '30(3)', '2/30'],
    [3, 'Sp', ''],
    [3, 'T(1)', ''],
  ])('%d of %s => %p', (loaded, shots, expected) => {
    expect(formatRounds(loaded, parseShots(shots))).toBe(expected)
  })
})
