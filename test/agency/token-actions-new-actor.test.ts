// AGENCY: starting combat with a newly created character threw ("Cannot read properties of undefined (reading
// 'filter')") from TokenActions, because new actors start with an empty system.conditions and no usermods list.
import { jest } from '@jest/globals'

// token-actions only needs these for constants; none of them matter to the modifier bookkeeping tested here
jest.unstable_mockModule('../../lib/miscellaneous-settings.js', () => ({
  SYSTEM_NAME: 'gurps',
  SETTING_USE_TAGGED_MODIFIERS: 'useTaggedModifiers',
}))
jest.unstable_mockModule('../../lib/utilities.js', () => ({ recurselist: () => {} }))
jest.unstable_mockModule('../../module/combat/maneuver.js', () => ({
  default: { getManeuver: () => ({ label: 'Do Nothing', flags: { gurps: { move: 'none' } } }) },
  MOVE_FULL: 'full',
  MOVE_HALF: 'half',
  MOVE_NONE: 'none',
  MOVE_ONE: 'one',
  MOVE_ONETHIRD: 'onethird',
  MOVE_STEP: 'step',
  MOVE_TWO_STEPS: 'twosteps',
  MOVE_TWOTHIRDS: 'twothirds',
}))

const { TokenActions } = await import('../../module/token-actions.js')

describe('TokenActions with a character that has no user modifiers yet', () => {
  const saved: Record<string, unknown> = {}

  beforeAll(() => {
    const g = global as any
    saved.user = g.game.user
    saved.settings = g.game.settings
    saved.utils = g.foundry.utils
    g.game.user = { isGM: true }
    g.game.settings = { get: () => ({ combatTempTag: '#temp' }) }
    g.foundry.utils = {
      ...g.foundry.utils,
      getProperty: (obj: any, path: string) => path.split('.').reduce((o, k) => o?.[k], obj),
    }
  })

  afterAll(() => {
    const g = global as any
    g.game.user = saved.user
    g.game.settings = saved.settings
    g.foundry.utils = saved.utils
  })

  const actionsFor = (conditions: object) => {
    const actor = { system: { conditions }, update: jest.fn(async (_: object) => {}) }
    const actions = new TokenActions({ actor }) as any
    actions.lastManeuvers = { 0: { maneuver: 'do_nothing' } }
    return { actions, actor }
  }

  test('clearing maneuver modifiers when combat starts', async () => {
    const { actions, actor } = actionsFor({})
    await actions.removeManeuverModifiers()
    expect(actor.update).toHaveBeenCalledWith({ 'system.conditions.usermods': [] })
  })

  test('adding maneuver modifiers on a new turn', async () => {
    const { actions, actor } = actionsFor({})
    actions.toHitBonus = 2
    await actions.addModifiers()
    const mods = (actor.update.mock.calls[0][0] as any)['system.conditions.usermods']
    expect(mods).toHaveLength(1)
    expect(mods[0]).toContain('#maneuver')
  })

  test('removing combat-only temporary modifiers', async () => {
    const { actions, actor } = actionsFor({})
    await actions.removeCombatTempMods()
    expect(actor.update).toHaveBeenCalledWith({ 'system.conditions.usermods': [] })
  })

  test('existing modifiers are still kept or dropped as before', async () => {
    const { actions, actor } = actionsFor({ usermods: ['+1 keep #hit', '+2 old #maneuver', '-1 temp #temp'] })
    await actions.removeManeuverModifiers()
    expect(actor.update).toHaveBeenLastCalledWith({ 'system.conditions.usermods': ['+1 keep #hit', '-1 temp #temp'] })
    await actions.removeCombatTempMods()
    expect(actor.update).toHaveBeenLastCalledWith({ 'system.conditions.usermods': ['+1 keep #hit', '+2 old #maneuver'] })
  })
})
