import { parselink } from '../../lib/parselink.js'
import { DamageTable } from '../../module/damage/damage-tables.js'
import { registerSanOtfParser, SAN_ACTION } from '../../module/agency/sanity/otf.ts'

beforeAll(() => {
  globalThis.GURPS = {} as any
  // @ts-ignore
  globalThis.game = { i18n: { localize: (s: string) => s } }
  GURPS.DamageTables = new DamageTable() as any
  registerSanOtfParser()
  registerSanOtfParser() // idempotent
})

describe('[SAN …] OTF', () => {
  test('with override text and category', () => {
    const result = parselink('"Sees the body" SAN 0/1d4 violence')
    expect(result.action).toMatchObject({
      type: SAN_ACTION,
      loss: '0/1d4',
      category: 'violence',
      desc: 'Sees the body',
      orig: 'SAN 0/1d4 violence',
    })
    expect(result.text).toContain('gurpslink')
    expect(result.text).toContain('Sees the body')
  })

  test('without a category', () => {
    expect(parselink('SAN 1d6/1d20').action).toMatchObject({ type: SAN_ACTION, loss: '1d6/1d20', category: 'none' })
  })

  test('blind roll prefix is kept', () => {
    expect(parselink('!SAN 1/1d4+1 u').action).toMatchObject({
      type: SAN_ACTION,
      category: 'unnatural',
      blindroll: true,
    })
  })

  test('does not capture other OTFs', () => {
    expect(parselink('SAN 1d6').action?.type).not.toBe(SAN_ACTION)
    expect(parselink('S:Sanitation').action?.type).not.toBe(SAN_ACTION)
    expect(parselink('2d+1 cut').action?.type).toBe('damage')
    expect(parselink('+2 bonus').action?.type).toBe('modifier')
  })
})
