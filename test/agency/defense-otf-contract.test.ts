/**
 * The defense flow rolls through upstream's OTF actions. These tests pin down that the OTFs it
 * builds parse into the action types upstream's performAction() dispatches on.
 */
import { parselink } from '../../lib/parselink.js'
import { defenseOtf, quoteOtfName } from '../../module/agency/defense/rules.js'
import { DamageTable } from '../../module/damage/damage-tables.js'

beforeAll(() => {
  globalThis.GURPS = {} as any
  // @ts-ignore
  globalThis.game = { i18n: { localize: (str: string) => str } }
  GURPS.DamageTables = new DamageTable()
})

describe('defense OTFs parse into upstream actions', () => {
  it('Dodge is the attribute roll the sheets use', () => {
    expect(parselink(defenseOtf('dodge')).action).toMatchObject({ type: 'attribute', path: 'currentdodge' })
  })

  it('parries and blocks name the weapon, mode included', () => {
    expect(parselink(defenseOtf('parry', 'Broadsword (Swung)')).action).toMatchObject({
      type: 'weapon-parry',
      name: 'Broadsword (Swung)',
    })
    expect(parselink(defenseOtf('block', 'Medium Shield')).action).toMatchObject({
      type: 'weapon-block',
      name: 'Medium Shield',
    })
  })

  it('Acrobatics falls back to its DX-6 default', () => {
    const action = parselink(`Sk:${quoteOtfName('Acrobatics')} | DX-6`).action as any
    expect(action).toMatchObject({ type: 'skill-spell', name: 'Acrobatics' })
    expect(action.next).toMatchObject({ type: 'attribute', attrkey: 'DX' })
  })

  it('stun recovery rolls HT or IQ', () => {
    expect(parselink('HT').action).toMatchObject({ type: 'attribute', attrkey: 'HT' })
    expect(parselink('IQ').action).toMatchObject({ type: 'attribute', attrkey: 'IQ' })
  })

  it('weapon damage text is a damage action that can carry a hit location', () => {
    expect(parselink('2d+1 cut').action).toMatchObject({ type: 'damage', formula: '2d+1', damagetype: 'cut' })
    expect(parselink('sw+2 cut').action).toMatchObject({ type: 'deriveddamage' })
  })

  it('the follow-on damage OTF is an attack damage action', () => {
    expect(parselink('@abc@D:"Broadsword (Swung)"').action).toMatchObject({
      type: 'attackdamage',
      name: 'Broadsword (Swung)',
      sourceId: 'abc',
    })
  })
})
