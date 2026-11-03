import {
  diceCount,
  formatComponent,
  formatDice,
  formatSpec,
  isExplosiveSpec,
  normalizeText,
  parseComponent,
  parseDice,
  parseExplosive,
} from '../../module/agency/explosions/parse.ts'

const primary = (text: string) => parseExplosive(text)!.components[0]

describe('parseDice', () => {
  test.each([
    ['4d', { dice: 4, adds: 0, multiplier: 1, armorDivisor: 1 }],
    ['4d+2', { dice: 4, adds: 2, multiplier: 1, armorDivisor: 1 }],
    ['1d-2', { dice: 1, adds: -2, multiplier: 1, armorDivisor: 1 }],
    ['1d−2', { dice: 1, adds: -2, multiplier: 1, armorDivisor: 1 }],
    ['6dx2', { dice: 6, adds: 0, multiplier: 2, armorDivisor: 1 }],
    ['6d×2', { dice: 6, adds: 0, multiplier: 2, armorDivisor: 1 }],
    ['6d*2', { dice: 6, adds: 0, multiplier: 2, armorDivisor: 1 }],
    ['6d x 220', { dice: 6, adds: 0, multiplier: 220, armorDivisor: 1 }],
    ['6d×3(10)', { dice: 6, adds: 0, multiplier: 3, armorDivisor: 10 }],
    ['6d(10)x3', { dice: 6, adds: 0, multiplier: 3, armorDivisor: 10 }],
    ['5d(10)', { dice: 5, adds: 0, multiplier: 1, armorDivisor: 10 }],
    ['1d(0.2)', { dice: 1, adds: 0, multiplier: 1, armorDivisor: 0.2 }],
    ['1d (0.5)', { dice: 1, adds: 0, multiplier: 1, armorDivisor: 0.5 }],
    ['2d6+1', { dice: 2, adds: 1, multiplier: 1, armorDivisor: 1 }],
    ['4d + 1', { dice: 4, adds: 1, multiplier: 1, armorDivisor: 1 }],
    ['3', { dice: 0, adds: 3, multiplier: 1, armorDivisor: 1 }],
  ])('%p', (text, expected) => expect(parseDice(text)).toEqual(expected))

  test('not dice', () => {
    expect(parseDice('cr ex')).toBeNull()
    expect(parseDice('')).toBeNull()
    expect(parseDice('Special')).toBeNull()
  })
})

describe('parseExplosive: the formats the task names', () => {
  test('"4d cr ex [2d]" -- fragments after the type, untyped (cutting, B414)', () => {
    const c = primary('4d cr ex [2d]')
    expect(c).toMatchObject({ dice: 4, adds: 0, multiplier: 1, type: 'cr', explosive: true })
    expect(c.fragments).toEqual({ dice: 2, adds: 0, multiplier: 1, armorDivisor: 1, type: 'cut', typed: false })
  })

  test('"6dx2 cr ex"', () => {
    expect(primary('6dx2 cr ex')).toMatchObject({
      dice: 6,
      multiplier: 2,
      type: 'cr',
      explosive: true,
      fragments: null,
    })
  })

  test('"3d cr ex sur" keeps the surge modifier', () => {
    expect(primary('3d cr ex sur')).toMatchObject({ dice: 3, type: 'cr', explosive: true, modifiers: ['sur'] })
  })

  test('"4d+2 cr ex linked burn": a linked burning component with the same dice that spreads with the blast', () => {
    const spec = parseExplosive('4d+2 cr ex linked burn')!
    expect(spec.components).toHaveLength(2)
    expect(spec.components[0]).toMatchObject({ dice: 4, adds: 2, type: 'cr', explosive: true })
    expect(spec.components[1]).toMatchObject({ dice: 4, adds: 2, type: 'burn', explosive: true, inheritedDice: true })
  })

  test('fragments written after a linked type belong to the blast: "4d+2 cr ex linked burn [2d]"', () => {
    const spec = parseExplosive('4d+2 cr ex linked burn [2d]')!
    expect(spec.components[0].fragments).toMatchObject({ dice: 2, type: 'cut', typed: false })
    expect(spec.components[1]).toMatchObject({ dice: 4, adds: 2, type: 'burn', explosive: true, fragments: null })
  })

  test('"5d(10) cr inc ex"', () => {
    expect(primary('5d(10) cr inc ex')).toMatchObject({
      dice: 5,
      armorDivisor: 10,
      type: 'cr',
      explosive: true,
      modifiers: ['inc'],
    })
  })

  test('"[3d] cut": fragments only, no blast', () => {
    const spec = parseExplosive('[3d] cut')!
    const c = spec.components[0]
    expect(c.dice).toBe(0)
    expect(c.explosive).toBe(false)
    expect(c.type).toBe('')
    expect(c.fragments).toEqual({ dice: 3, adds: 0, multiplier: 1, armorDivisor: 1, type: 'cut', typed: true })
    expect(isExplosiveSpec(spec)).toBe(true)
  })
})

describe('parseExplosive: book and GCS spellings', () => {
  test('book style: fragments between dice and type (HT192 M67 "9d [2d] cr ex")', () => {
    const c = primary('9d [2d] cr ex')
    expect(c).toMatchObject({ dice: 9, type: 'cr', explosive: true })
    expect(c.fragments).toMatchObject({ dice: 2, type: 'cut' })
  })

  test('GCS style: "4d+1 cr ex [2d cut]"', () => {
    const c = primary('4d+1 cr ex [2d cut]')
    expect(c).toMatchObject({ dice: 4, adds: 1, type: 'cr', explosive: true })
    expect(c.fragments).toMatchObject({ dice: 2, type: 'cut', typed: true })
  })

  test('fragments with adds and their own type: "1d+1 [1d-1 cr] cr ex" (Stingball, HT192)', () => {
    const c = primary('1d+1 [1d-1 cr] cr ex')
    expect(c.fragments).toEqual({ dice: 1, adds: -1, multiplier: 1, armorDivisor: 1, type: 'cr', typed: true })
  })

  test('"3d-1 [1d+1] cr ex" (ARGES-style adds on both)', () => {
    const c = primary('3d-1 [1d+1] cr ex')
    expect(c).toMatchObject({ dice: 3, adds: -1 })
    expect(c.fragments).toMatchObject({ dice: 1, adds: 1, type: 'cut' })
  })

  test('hot fragments: "2d [1d(0.2)] burn ex" (M34 WP, HT192) burn, not cut (B415)', () => {
    const c = primary('2d [1d(0.2)] burn ex')
    expect(c).toMatchObject({ dice: 2, type: 'burn', explosive: true })
    expect(c.fragments).toMatchObject({ dice: 1, armorDivisor: 0.2, type: 'burn', typed: false })
  })

  test('an ordinary frag casing on a burning explosion still cuts', () => {
    expect(primary('3d [2d] burn ex').fragments).toMatchObject({ type: 'cut' })
  })

  test('large multipliers: "6d×220 cr ex" (HT187)', () => {
    const c = primary('6d×220 cr ex')
    expect(c).toMatchObject({ dice: 6, multiplier: 220 })
    expect(diceCount(c)).toBe(1320)
  })

  test('"7d(10) cr ex with 6d [2d] cr ex linked" (TL8 40mm HEDP, HT143)', () => {
    const spec = parseExplosive('7d(10) cr ex with 6d [2d] cr ex linked')!
    expect(spec.components).toHaveLength(2)
    expect(spec.components[0]).toMatchObject({
      dice: 7,
      armorDivisor: 10,
      type: 'cr',
      explosive: true,
      fragments: null,
    })
    expect(spec.components[1]).toMatchObject({ dice: 6, armorDivisor: 1, type: 'cr', explosive: true })
    expect(spec.components[1].fragments).toMatchObject({ dice: 2, type: 'cut' })
  })

  test('a kinetic shell with a linked explosion: "6d×5(0.5) pi++ with 6d [5d+2] cr ex linked" (HT)', () => {
    const spec = parseExplosive('6d×5(0.5) pi++ with 6d [5d+2] cr ex linked')!
    expect(spec.components[0]).toMatchObject({
      dice: 6,
      multiplier: 5,
      armorDivisor: 0.5,
      type: 'pi++',
      explosive: false,
    })
    expect(spec.components[1].fragments).toMatchObject({ dice: 5, adds: 2 })
  })

  test('book shorthand without a primary type takes the linked type: "4d(10) with 1d [1d] cr ex linked" (HT144)', () => {
    const spec = parseExplosive('4d(10) with 1d [1d] cr ex linked')!
    expect(spec.components[0]).toMatchObject({ dice: 4, armorDivisor: 10, type: 'cr', explosive: true })
    expect(spec.components[1]).toMatchObject({ dice: 1, type: 'cr', explosive: true })
  })

  test('a linked affliction on the next line: Stingball "... cr ex\\nlinked HT-5 aff (10 yd.)"', () => {
    const spec = parseExplosive('1d+1 [1d-1 cr] cr ex\nlinked HT-5 aff (10 yd.)')!
    expect(spec.components).toHaveLength(2)
    expect(spec.components[1]).toMatchObject({ affliction: { htModifier: -5 }, radius: 10, type: 'aff', dice: 0 })
  })

  test('notes text "with 6d [2d] cr ex linked" on its own', () => {
    const spec = parseExplosive('with 6d [2d] cr ex linked')!
    expect(spec.components).toHaveLength(1)
    expect(spec.components[0]).toMatchObject({ dice: 6, explosive: true })
  })

  test('an area affliction: "HT-5 aff (10 yd.)" (Schermuly stun grenade, HT192)', () => {
    const spec = parseExplosive('HT-5 aff (10 yd.)')!
    expect(spec.components[0]).toMatchObject({ affliction: { htModifier: -5 }, radius: 10 })
    expect(isExplosiveSpec(spec)).toBe(true)
  })

  test('"HT aff" without a modifier', () => {
    expect(primary('HT aff (5 yards)')).toMatchObject({ affliction: { htModifier: 0 }, radius: 5 })
  })

  test('smoke: "Smoke (7 yd.)" (AN-M8, HT192)', () => {
    const spec = parseExplosive('Smoke (7 yd.)')!
    expect(spec.components[0]).toMatchObject({ smoke: true, radius: 7, dice: 0 })
    expect(isExplosiveSpec(spec)).toBe(true)
  })

  test('long type names and odd spacing', () => {
    expect(primary('  3d   crushing  explosive ')).toMatchObject({ dice: 3, type: 'cr', explosive: true })
    expect(primary('2d burning ex')).toMatchObject({ type: 'burn', explosive: true })
  })

  test('dkb / nkb are kept as modifiers', () => {
    expect(primary('3d cr ex dkb').modifiers).toEqual(['dkb'])
  })

  test('"1d-2 cr ex" (blasting cap, HT187)', () => {
    expect(primary('1d-2 cr ex')).toMatchObject({ dice: 1, adds: -2, type: 'cr', explosive: true })
  })

  test('a flat amount: "2 burn ex"', () => {
    expect(primary('2 burn ex')).toMatchObject({ dice: 0, adds: 2, type: 'burn', explosive: true })
  })

  test('trailing punctuation is ignored', () => {
    expect(primary('8d+2 cr ex.')).toMatchObject({ dice: 8, adds: 2, explosive: true })
  })
})

describe('parseExplosive: things that are not explosions', () => {
  test.each([[''], ['Special'], ['see notes'], ['cr ex'], ['  ']])('%p -> null', text =>
    expect(parseExplosive(text)).toBeNull()
  )

  test('plain weapon damage parses but is not explosive', () => {
    const spec = parseExplosive('2d+2 pi')
    expect(spec).not.toBeNull()
    expect(isExplosiveSpec(spec)).toBe(false)
    expect(isExplosiveSpec(parseExplosive('1d+1(0.5) cr dkb'))).toBe(false)
  })

  test('isExplosiveSpec(null) is false', () => expect(isExplosiveSpec(null)).toBe(false))
})

describe('formatting', () => {
  test('formatDice', () => {
    expect(formatDice({ dice: 4, adds: 2, multiplier: 1 })).toBe('4d+2')
    expect(formatDice({ dice: 1, adds: -2, multiplier: 1 })).toBe('1d-2')
    expect(formatDice({ dice: 6, adds: 0, multiplier: 2 })).toBe('6d×2')
    expect(formatDice({ dice: 0, adds: 3, multiplier: 1 })).toBe('3')
  })

  test('round trips in book style', () => {
    expect(formatComponent(primary('4d+1 cr ex [2d cut]'))).toBe('4d+1 [2d cut] cr ex')
    expect(formatComponent(primary('9d [2d] cr ex'))).toBe('9d [2d] cr ex')
    expect(formatComponent(primary('5d(10) cr inc ex'))).toBe('5d(10) cr inc ex')
    expect(formatComponent(primary('HT-5 aff (10 yd.)'))).toBe('HT-5 aff (10 yd.)')
    expect(formatSpec(parseExplosive('7d(10) cr ex with 6d [2d] cr ex linked')!)).toBe(
      '7d(10) cr ex with 6d [2d] cr ex linked'
    )
  })

  test('normalizeText', () => expect(normalizeText(' 6d×2   cr  –ex ')).toBe('6dx2 cr -ex'))
})

describe('parseComponent edge cases', () => {
  test('fragments with a multiplier', () => {
    expect(parseComponent('[6dx2] cut').fragments).toMatchObject({ dice: 6, multiplier: 2, type: 'cut' })
  })
  test('unknown words become modifiers, noise is dropped', () => {
    expect(parseComponent('Dmg 3d cr ex rad').modifiers).toEqual(['rad'])
  })
})
