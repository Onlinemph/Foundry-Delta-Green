// AGENCY: the Effect Modifiers window crashed ("usermods is not iterable") as soon as a newly created character's
// token was selected, because new actors start with an empty system.conditions.
import { jest } from '@jest/globals'

// the popout's imports pull in sheets, combat and settings; none of them matter to getData
jest.unstable_mockModule('../../lib/miscellaneous-settings.js', () => ({ SYSTEM_NAME: 'gurps' }))
jest.unstable_mockModule('../../module/combat/index.js', () => ({ Combat: {} }))
jest.unstable_mockModule('../../module/gurps-wiring.js', () => ({ default: {} }))
jest.unstable_mockModule('../../module/token-actions.js', () => ({ TokenActions: {} }))
jest.unstable_mockModule('../../module/utilities/gurpslink.js', () => ({ gurpslink: (s: string) => s }))

const { EffectModifierPopout } = await import('../../module/actor/effect-modifier-popout.js')

describe('EffectModifierPopout.getData', () => {
  const saved: Record<string, unknown> = {}

  beforeAll(() => {
    const g = global as any
    saved.user = g.game.user
    saved.utils = g.foundry.utils
    g.game.user = { targets: new Set() }
    g.foundry.utils = {
      ...g.foundry.utils,
      mergeObject: (a: object, b: object) => ({ ...a, ...b }),
      getProperty: (obj: any, path: string) => path.split('.').reduce((o, k) => o?.[k], obj),
    }
    // the jest Application mock has no getData; Foundry's returns the window's base data
    ;(Object.getPrototypeOf(EffectModifierPopout.prototype) as any).getData = () => ({})
  })

  afterAll(() => {
    const g = global as any
    g.game.user = saved.user
    g.foundry.utils = saved.utils
    delete (Object.getPrototypeOf(EffectModifierPopout.prototype) as any).getData
  })

  const tokenFor = (conditions: object) => ({ name: 'Agent', actor: { system: { conditions }, items: new Map() } })

  test('a new character with no user modifiers yet', () => {
    const popout = new EffectModifierPopout(tokenFor({ self: { modifiers: [] }, target: { modifiers: [] } }), () => {})
    const data = (popout as any).getData({})
    expect(data.selfmodifiers).toEqual([])
    expect(data.selected).toBe('Agent')
  })

  test('user modifiers still show when present', () => {
    const popout = new EffectModifierPopout(
      tokenFor({ self: { modifiers: [] }, target: { modifiers: [] }, usermods: ['+1 bonus #hit'] }),
      () => {}
    )
    const data = (popout as any).getData({})
    expect(data.selfmodifiers).toHaveLength(1)
  })
})
