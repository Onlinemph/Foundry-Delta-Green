import { jest } from '@jest/globals'
import { chooseWeapon } from '../../module/agency/firearms/chat-command.js'
import { FIRE_MARK } from '../../module/agency/firearms/constants.js'
import {
  adjustRoFModifier,
  lastFiredId,
  onPreRoll,
  onRollComplete,
  type RollModifier,
} from '../../module/agency/firearms/firing.js'
import { reloadWeapon } from '../../module/agency/firearms/reload.js'
import { weaponViews } from '../../module/agency/firearms/state.js'

/* ---------------------------------------- */
/*  Foundry stand-ins                       */
/* ---------------------------------------- */

const settings: Record<string, unknown> = {}
const warn = jest.fn()
const info = jest.fn()
const addModifier = jest.fn((mod: number, label: string, list: RollModifier[]) => {
  list.push({ mod: `${mod >= 0 ? '+' : ''}${mod}`, modint: mod, desc: label })
})

const format = (key: string, data?: Record<string, unknown>) =>
  `${key}:${Object.entries(data ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`
const rof = (shots: number) => format('GURPS.combat.rof.bonusLabel', { shots })

const g = globalThis as any
g.game.settings = { get: (_ns: string, key: string) => settings[key] }
g.game.i18n.format = format
g.ui = { notifications: { warn, info } }
g.GURPS.ModifierBucket = { addModifier }
const createMessage = jest.fn(async (_data: { content: string }) => undefined)
g.ChatMessage = { create: createMessage, getSpeaker: () => ({ alias: 'Shooter' }) }

function setPath(target: any, path: string, value: unknown) {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = node[part] ??= {}
  node[parts.at(-1)!] = value
}

type FakeActor = ReturnType<typeof makeActor>

function makeActor({ ranged = {}, equipment = {}, weapons = {} }: Record<string, any> = {}) {
  const actor = {
    id: 'a1',
    uuid: `Actor.${Math.random()}`,
    name: 'Shooter',
    isOwner: true,
    flags: { gurps: { agency: { firearms: { weapons } } } } as Record<string, any>,
    system: { ranged, equipment },
    /** Resolve to let an in-flight update land. */
    hold: null as null | Promise<void>,
    update: jest.fn(async (data: Record<string, unknown>) => {
      if (actor.hold) await actor.hold
      for (const [key, value] of Object.entries(data)) setPath(actor, key, value)
    }),
    updateEqtCount: jest.fn(async (path: string, count: number) => setPath(actor, `${path}.count`, count)),
  }
  return actor
}

const glock = { name: 'Glock 17', mode: 'Shooting', shots: '17+1(3)', rof: '3', rcl: '2' }
const smg = { name: 'MP5', mode: '', shots: '30(3)', rof: '13', rcl: '2' }
const knife = { name: 'Throwing Knife', mode: 'Thrown', shots: 'T(1)', rof: '1' }
const sword = { name: 'Sword', mode: 'Swung', reach: '1', parry: '0' }

function loaded(actor: FakeActor, weapon: object): number {
  return weaponViews(actor).find(v => v.weapon === weapon)!.loaded
}

function attack(actor: FakeActor, weapon: object, shots?: number, targetmods: RollModifier[] = []) {
  const optionalArgs: Record<string, any> = { obj: weapon, shots }
  const result = onPreRoll({ actor, optionalArgs, action: { type: 'attack' }, targetmods })
  return { result, optionalArgs, targetmods, complete: () => onRollComplete({ actor, optionalArgs }) }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  Object.assign(settings, { 'agency-ammo-tracking': true, 'agency-ammo-empty': 'block', 'agency-ammo-thrown': false })
  jest.clearAllMocks()
})

/* ---------------------------------------- */

describe('gurpsAgencyPreRoll', () => {
  test('a weapon never fired starts full and loses the rounds fired, hit or miss', async () => {
    const actor = makeActor({ ranged: { '00000': glock } })
    const roll = attack(actor, glock, 3)
    expect(roll.result).toBeUndefined()
    expect(roll.optionalArgs[FIRE_MARK]).toMatchObject({ kind: 'rounds', shots: 3 })

    roll.complete()
    await flush()
    expect(loaded(actor, glock)).toBe(15)
    expect(roll.optionalArgs[FIRE_MARK]).toBeUndefined()
  })

  test('RoF 1: one round', async () => {
    const actor = makeActor({ ranged: { '00000': { ...glock, rof: '1' } } })
    const weapon = actor.system.ranged['00000']
    attack(actor, weapon).complete()
    await flush()
    expect(loaded(actor, weapon)).toBe(17)
  })

  test('empty weapon: the roll is cancelled with a click', () => {
    const actor = makeActor({ ranged: { '00000': glock } })
    const id = weaponViews(actor)[0].id
    actor.flags.gurps.agency.firearms.weapons[id] = { loaded: 0 }

    const roll = attack(actor, glock, 1)
    expect(roll.result).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GURPS.agency.firearms.click:weapon=Glock 17 (Shooting)'))
    expect(roll.optionalArgs[FIRE_MARK]).toBeUndefined()
  })

  test("empty weapon with 'warn': rolls anyway and spends nothing", async () => {
    settings['agency-ammo-empty'] = 'warn'
    const actor = makeActor({ ranged: { '00000': glock } })
    const id = weaponViews(actor)[0].id
    actor.flags.gurps.agency.firearms.weapons[id] = { loaded: 0 }

    const roll = attack(actor, glock, 1)
    expect(roll.result).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    roll.complete()
    await flush()
    expect(actor.update).not.toHaveBeenCalled()
  })

  test('asking for more shots than loaded fires what is left and fixes the RoF bonus', async () => {
    const actor = makeActor({ ranged: { '00000': smg } })
    const id = weaponViews(actor)[0].id
    actor.flags.gurps.agency.firearms.weapons[id] = { loaded: 6 }
    // Upstream added +3 for 13 shots.
    const targetmods: RollModifier[] = [
      { mod: '+3', modint: 3, desc: rof(13) },
      { mod: '-2', modint: -2, desc: 'range' },
    ]

    const roll = attack(actor, smg, 13, targetmods)
    expect(roll.result).toBeUndefined()
    expect(roll.optionalArgs.shots).toBe(6)
    expect(targetmods).toEqual([
      { mod: '-2', modint: -2, desc: 'range' },
      { mod: '+1', modint: 1, desc: rof(6) },
    ])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GURPS.agency.firearms.capped:'))

    roll.complete()
    await flush()
    expect(loaded(actor, smg)).toBe(0)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('GURPS.agency.firearms.nowEmpty'))
  })

  test('capping to a shot count with no RoF bonus just drops the bonus', () => {
    const actor = makeActor({ ranged: { '00000': smg } })
    actor.flags.gurps.agency.firearms.weapons[weaponViews(actor)[0].id] = { loaded: 2 }
    const targetmods: RollModifier[] = [{ mod: '+3', modint: 3, desc: rof(13) }]
    attack(actor, smg, 13, targetmods)
    expect(targetmods).toEqual([])
  })

  test('without targetmods the shots are still capped, with a warning to fix RoF by hand', () => {
    const actor = makeActor({ ranged: { '00000': smg } })
    actor.flags.gurps.agency.firearms.weapons[weaponViews(actor)[0].id] = { loaded: 2 }
    const optionalArgs: Record<string, any> = { obj: smg, shots: 13 }
    onPreRoll({ actor, optionalArgs, action: { type: 'attack' } })
    expect(optionalArgs.shots).toBe(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rofNotAdjusted'))
  })

  test('quick successive shots each see the rounds already fired', async () => {
    const actor = makeActor({ ranged: { '00000': glock } })
    actor.flags.gurps.agency.firearms.weapons[weaponViews(actor)[0].id] = { loaded: 1 }
    let release!: () => void
    actor.hold = new Promise(resolve => (release = resolve))

    attack(actor, glock, 1).complete()
    // The update is still in flight, but the round is gone.
    expect(loaded(actor, glock)).toBe(0)
    expect(attack(actor, glock, 1).result).toBe(false)

    release()
    await flush()
    expect(loaded(actor, glock)).toBe(0)
    expect(actor.update).toHaveBeenCalledTimes(1)
  })

  test('remembers the weapon fired last', async () => {
    const actor = makeActor({ ranged: { '00000': glock, '00001': smg } })
    attack(actor, smg, 1).complete()
    await flush()
    expect(lastFiredId(actor)).toBe(weaponViews(actor)[1].id)
  })

  describe('ignored', () => {
    test('when tracking is off', () => {
      settings['agency-ammo-tracking'] = false
      const actor = makeActor({ ranged: { '00000': glock } })
      const roll = attack(actor, glock, 3)
      expect(roll.optionalArgs[FIRE_MARK]).toBeUndefined()
    })

    test('for anything but attacks', () => {
      const actor = makeActor({ ranged: { '00000': glock } })
      const optionalArgs: Record<string, any> = { obj: glock }
      expect(onPreRoll({ actor, optionalArgs, action: { type: 'skill-spell' } })).toBeUndefined()
      expect(onPreRoll({ actor, optionalArgs, action: null })).toBeUndefined()
      expect(optionalArgs[FIRE_MARK]).toBeUndefined()
    })

    test('for melee attacks', () => {
      const actor = makeActor({ ranged: {} })
      expect(attack(actor, sword).optionalArgs[FIRE_MARK]).toBeUndefined()
    })

    test('for weapons with untracked Shots', () => {
      const laser = { name: 'Laser', shots: 'FP', rof: '1' }
      const actor = makeActor({ ranged: { '00000': laser } })
      expect(attack(actor, laser).optionalArgs[FIRE_MARK]).toBeUndefined()
    })

    test('when the roller is not an actor', () => {
      const optionalArgs: Record<string, any> = { obj: glock }
      expect(onPreRoll({ actor: { name: 'a user' }, optionalArgs, action: { type: 'attack' } })).toBeUndefined()
      expect(optionalArgs[FIRE_MARK]).toBeUndefined()
    })

    test('roll complete without a pre-roll mark', async () => {
      const actor = makeActor({ ranged: { '00000': glock } })
      onRollComplete({ actor, optionalArgs: { obj: glock, shots: 3 } })
      await flush()
      expect(actor.update).not.toHaveBeenCalled()
    })
  })

  describe('thrown weapons', () => {
    const equipment = { carried: { '00000': { name: 'Throwing Knife', count: 2 } } }

    test('untouched unless the setting is on', () => {
      const actor = makeActor({ ranged: { '00000': knife }, equipment })
      expect(attack(actor, knife).optionalArgs[FIRE_MARK]).toBeUndefined()
    })

    test('use up the equipment they come from', async () => {
      settings['agency-ammo-thrown'] = true
      const actor = makeActor({ ranged: { '00000': knife }, equipment: structuredClone(equipment) })
      attack(actor, knife).complete()
      await flush()
      expect(actor.updateEqtCount).toHaveBeenCalledWith('system.equipment.carried.00000', 1)
      attack(actor, knife).complete()
      await flush()
      expect(actor.system.equipment.carried['00000'].count).toBe(0)

      expect(attack(actor, knife).result).toBe(false)
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('GURPS.agency.firearms.noneToThrow'))
    })

    test('without matching equipment they are not tracked', () => {
      settings['agency-ammo-thrown'] = true
      const actor = makeActor({ ranged: { '00000': knife } })
      expect(attack(actor, knife).optionalArgs[FIRE_MARK]).toBeUndefined()
    })
  })
})

describe('adjustRoFModifier', () => {
  test('swaps the bonus', () => {
    const list: RollModifier[] = [{ mod: '+4', modint: 4, desc: rof(20) }]
    expect(adjustRoFModifier(list, 20, 9, rof, addModifier)).toBe(true)
    expect(list).toEqual([{ mod: '+2', modint: 2, desc: rof(9) }])
  })

  test('nothing to do below RoF 5', () => {
    const list: RollModifier[] = []
    expect(adjustRoFModifier(list, 3, 2, rof, addModifier)).toBe(true)
    expect(list).toEqual([])
  })

  test('leaves the list alone when the bonus cannot be found', () => {
    const list: RollModifier[] = [{ mod: '+4', modint: 4, desc: 'something else' }]
    expect(adjustRoFModifier(list, 20, 9, rof, addModifier)).toBe(false)
    expect(list).toEqual([{ mod: '+4', modint: 4, desc: 'something else' }])
  })

  test('no list', () => {
    expect(adjustRoFModifier(undefined, 20, 9, rof, addModifier)).toBe(false)
  })
})

describe('chooseWeapon (/reload)', () => {
  const m16 = { name: 'M16A2', mode: 'Rifle', shots: '30(3)', rof: '12' }
  const m203 = { name: 'M16A2', mode: 'M203', shots: '1(3)', rof: '1' }

  function views(state: Record<number, number> = {}) {
    const actor = makeActor({ ranged: { '00000': glock, '00001': m16, '00002': m203 } })
    const list = weaponViews(actor)
    for (const [index, value] of Object.entries(state))
      actor.flags.gurps.agency.firearms.weapons[list[Number(index)].id] = { loaded: value }
    return weaponViews(actor)
  }

  test('by name', () => {
    expect(chooseWeapon(views(), 'glock', undefined).view?.weapon).toBe(glock)
  })

  test('by name (usage)', () => {
    expect(chooseWeapon(views(), 'M16A2 (M203)', undefined).view?.weapon).toBe(m203)
  })

  test('a name shared by two usages picks the one that needs rounds', () => {
    expect(chooseWeapon(views({ 1: 10 }), 'M16A2', undefined).view?.weapon).toBe(m16)
  })

  test('a name shared by two usages, both needing rounds, is ambiguous', () => {
    const choice = chooseWeapon(views({ 1: 10, 2: 0 }), 'M16A2', undefined)
    expect(choice.reason).toBe('ambiguous')
    expect(choice.candidates).toHaveLength(2)
  })

  test('no match', () => {
    expect(chooseWeapon(views(), 'Barrett', undefined).reason).toBe('noMatch')
  })

  test('bare /reload: the only weapon that is not full', () => {
    expect(chooseWeapon(views({ 2: 0 }), '', undefined).view?.weapon).toBe(m203)
  })

  test('bare /reload: the weapon fired last', () => {
    const list = views({ 0: 3, 1: 10 })
    expect(chooseWeapon(list, '', list[1].id).view?.weapon).toBe(m16)
    expect(chooseWeapon(list, '', undefined).reason).toBe('ambiguous')
  })

  test('bare /reload: everything full', () => {
    expect(chooseWeapon(views(), '', undefined).reason).toBe('allFull')
  })
})

describe('reloadWeapon', () => {
  const rifle = { name: 'AK-47', mode: '', shots: '30(3)', rof: '10', ammo: 0 }
  const revolver = { name: 'Colt Python', mode: '', shots: '6(3i)', rof: '3', ammo: '.357 rounds' }

  function setup(weapon: object, state: Record<string, unknown>, carried: Record<string, unknown> = {}) {
    const actor = makeActor({ ranged: { '00000': weapon }, equipment: { carried } })
    actor.flags.gurps.agency.firearms.weapons[weaponViews(actor)[0].id] = state
    return actor
  }
  const view = (actor: FakeActor) => weaponViews(actor)[0]
  const lastCard = () => (createMessage.mock.calls.at(-1)?.[0] as { content: string }).content

  test('swaps in a magazine from the configured item and says how long it takes', async () => {
    const actor = setup(
      rifle,
      { loaded: 4, ammoItem: 'AK magazine' },
      { '00000': { name: 'AK Magazine (30)', count: 3 } }
    )
    expect(await reloadWeapon(actor, view(actor))).toBe(true)
    expect(view(actor).loaded).toBe(30)
    expect(actor.updateEqtCount).toHaveBeenCalledWith('system.equipment.carried.00000', 2)
    expect(lastCard()).toContain('GURPS.agency.firearms.chat.reload:weapon=AK-47,rounds=30/30')
    expect(lastCard()).toContain('GURPS.agency.firearms.chat.oldMagazine:count=4')
    expect(lastCard()).toContain('GURPS.agency.firearms.chat.time:seconds=3')
  })

  test('refuses when the configured item is used up', async () => {
    const actor = setup(rifle, { loaded: 0, ammoItem: 'AK Magazine' }, { '00000': { name: 'AK Magazine', count: 0 } })
    expect(await reloadWeapon(actor, view(actor))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GURPS.agency.firearms.noAmmo'))
    expect(actor.update).not.toHaveBeenCalled()
  })

  test('refuses when the configured item is not carried at all', async () => {
    const actor = setup(rifle, { loaded: 0, ammoItem: 'AK Magazine' })
    expect(await reloadWeapon(actor, view(actor))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GURPS.agency.firearms.notCarried'))
  })

  test('without an ammo item, reloads are free', async () => {
    const actor = setup(rifle, { loaded: 0 })
    expect(await reloadWeapon(actor, view(actor))).toBe(true)
    expect(view(actor).loaded).toBe(30)
    expect(actor.updateEqtCount).not.toHaveBeenCalled()
  })

  test('a full weapon is not reloaded', async () => {
    const actor = setup(rifle, {})
    expect(await reloadWeapon(actor, view(actor))).toBe(false)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('GURPS.agency.firearms.full'))
    expect(createMessage).not.toHaveBeenCalled()
  })

  test("individual loading: a round per click from the Ammo field's item, even on a double click", async () => {
    const actor = setup(revolver, { loaded: 0 }, { '00000': { name: '.357 Rounds', count: 10 } })
    await Promise.all([reloadWeapon(actor, view(actor)), reloadWeapon(actor, view(actor))])
    expect(view(actor).loaded).toBe(2)
    expect(actor.system.equipment.carried['00000'].count).toBe(8)
    expect(lastCard()).toContain('GURPS.agency.firearms.chat.loadOne:weapon=Colt Python,rounds=2/6')
  })

  test('weapon names are escaped in the chat card', async () => {
    const actor = setup({ ...rifle, name: '<b>AK</b>' }, { loaded: 0 })
    await reloadWeapon(actor, view(actor))
    expect(lastCard()).not.toContain('<b>AK</b>')
    expect(lastCard()).toContain('&lt;b&gt;AK&lt;/b&gt;')
  })
})
