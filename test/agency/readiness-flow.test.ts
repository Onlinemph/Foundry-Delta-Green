import { jest } from '@jest/globals'
import {
  beforeAttack,
  onCombatStart,
  onDefenseWeapons,
  onManeuverPicked,
  reloadGate,
} from '../../module/agency/readiness/actions.js'
import { matchReadyViews } from '../../module/agency/readiness/chat-command.js'
import { readyViews } from '../../module/agency/readiness/state.js'
import { weaponViews } from '../../module/agency/firearms/state.js'

/* ---------------------------------------- */
/*  Foundry stand-ins                       */
/* ---------------------------------------- */

const g = globalThis as any
const settings: Record<string, unknown> = {}
const warn = jest.fn()
const info = jest.fn()
g.game.settings = { get: (_ns: string, key: string) => settings[key] }
g.game.i18n.format = (key: string, data?: Record<string, unknown>) =>
  `${key}:${Object.entries(data ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`
g.ui = { notifications: { warn, info }, combat: { render: jest.fn() } }
const createMessage = jest.fn(async (_data: { content: string }) => undefined)
g.ChatMessage = { create: createMessage, getSpeaker: () => ({ alias: 'Agent' }) }

const hooks = new Map<number, { name: string; fn: (data: any) => unknown }>()
let hookId = 0
g.Hooks = {
  on: (name: string, fn: (data: any) => unknown) => (hooks.set(++hookId, { name, fn }), hookId),
  off: (_name: string, id: number) => hooks.delete(id),
  callAll: (name: string, data: unknown) => {
    for (const hook of [...hooks.values()]) if (hook.name === name) hook.fn(data)
    return true
  },
}

const wait = jest.fn(async (_options: any): Promise<unknown> => null)
const prompt = jest.fn(async (_options: any): Promise<unknown> => null)
g.foundry.applications.handlebars = { renderTemplate: jest.fn(async () => '') }
g.foundry.applications.api.DialogV2 = { wait, prompt }

/** The modifier bucket, as far as the Fast-Draw roll uses it. */
const stack = {
  modifierList: [] as { modint: number; desc: string }[],
  reset(list: { modint: number; desc: string }[] = []) {
    this.modifierList = list
  },
}
const bucketAtRoll: { modint: number; desc: string }[][] = []
g.GURPS.ModifierBucket = {
  modifierStack: stack,
  addModifier: jest.fn((mod: number, desc: string) => stack.modifierList.push({ modint: Number(mod), desc })),
  refresh: jest.fn(),
}
g.GURPS.parselink = (otf: string) => ({ action: { type: 'skill-spell', otf } })

/** Next skill roll's result. */
let nextRoll: { failure: boolean; isCritFailure?: boolean } | null = { failure: false }
const performAction = jest.fn(async (action: any, actor: any) => {
  bucketAtRoll.push([...stack.modifierList])
  stack.reset([])
  if (!nextRoll) return false
  for (const hook of [...hooks.values()])
    if (hook.name === 'gurpsAgencyRollComplete')
      hook.fn({
        isTargeted: true,
        actor,
        failure: nextRoll.failure,
        chatdata: { margin: nextRoll.failure ? -2 : 3, isCritFailure: !!nextRoll.isCritFailure },
      })
  return !nextRoll.failure
})
g.GURPS.performAction = performAction

function setPath(target: any, path: string, value: unknown) {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = node[part] ??= {}
  const last = parts.at(-1)!
  if (last.startsWith('-=')) delete node[last.slice(2)]
  else node[last] = value
}

const glockSemi = { name: 'Glock 17', mode: 'Semi', shots: '17+1(3)', bulk: '-2', rof: '3', level: 14 }
const knife = { name: 'Combat Knife', mode: 'Thrust', reach: 'C', parry: '-1', level: 12 }
const punch = { name: 'Natural Attacks', mode: 'Punch', reach: 'C', parry: '0', level: 12 }

function makeActor(skills: Record<string, any> = {}, ads: Record<string, any> = {}) {
  const actor: any = {
    id: 'a1',
    uuid: 'Actor.a1',
    name: 'Agent',
    isOwner: true,
    isToken: false,
    flags: { gurps: { agency: {} } },
    system: {
      melee: { '00000': punch, '00001': knife },
      ranged: { '00000': glockSemi },
      equipment: {
        carried: {
          '00000': { name: 'Glock 17', count: 1 },
          '00001': { name: 'Combat Knife', count: 1 },
          '00002': { name: 'Glock Magazine', count: 3 },
        },
      },
      skills,
      ads,
      conditions: { maneuver: 'attack' },
    },
    update: jest.fn(async (data: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(data)) setPath(actor, key, value)
    }),
  }
  return actor
}

const setManeuver = jest.fn(async (name: string) => undefined)
function startCombat(actor: any, { turn = true } = {}) {
  const combatant = { actor, actorId: actor.id, token: { object: { setManeuver, drawEffects: jest.fn() } } }
  g.game.combat = { started: true, combatants: [combatant], combatant: turn ? combatant : { actor: {}, actorId: 'x' } }
}

const stateOf = (actor: any, name: string) => readyViews(actor).find(v => v.weapon.name === name)!.state
const lastCard = () => (createMessage.mock.calls.at(-1)?.[0] as { content: string }).content

beforeEach(() => {
  Object.assign(settings, {
    'agency-readiness': true,
    'agency-readiness-combat-start': 'keep',
    'agency-gunslinger': true,
    'agency-ammo-tracking': true,
  })
  jest.clearAllMocks()
  g.game.combat = null
  nextRoll = { failure: false }
  stack.reset([])
  bucketAtRoll.length = 0
})

/* ---------------------------------------- */

describe('attacking with an unready weapon', () => {
  test('natural attacks and ready weapons go ahead untouched', async () => {
    const actor = makeActor()
    startCombat(actor)
    expect(await beforeAttack({ actor, att: punch })).toBeUndefined()
    actor.flags.gurps.agency.readiness = { weapons: { [readyViews(actor)[0].weapon.id]: { state: 'ready' } } }
    expect(await beforeAttack({ actor, att: readyViews(actor)[0].weapon.entries[0].value })).toBeUndefined()
    expect(wait).not.toHaveBeenCalled()
  })

  test('out of combat the weapon is simply drawn', async () => {
    const actor = makeActor()
    expect(stateOf(actor, 'Glock 17')).toBe('holstered')
    expect(await beforeAttack({ actor, att: glockSemi })).toBeUndefined()
    expect(stateOf(actor, 'Glock 17')).toBe('ready')
    expect(wait).not.toHaveBeenCalled()
  })

  test('Ready: the attack is cancelled, the weapon readied, the Ready maneuver set', async () => {
    const actor = makeActor()
    startCombat(actor)
    wait.mockResolvedValueOnce({ kind: 'ready', modifier: 0 })
    expect(await beforeAttack({ actor, att: glockSemi })).toBe(false)
    expect(stateOf(actor, 'Glock 17')).toBe('ready')
    expect(setManeuver).toHaveBeenCalledWith('ready')
    expect(lastCard()).toContain('note.readyManeuver')
  })

  test('Fast-Draw success: ready, and the attack goes ahead with its own modifiers', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Pistol)', level: 13 } })
    startCombat(actor)
    stack.reset([{ modint: -3, desc: 'range' }])
    wait.mockResolvedValueOnce({ kind: 'fastdraw', modifier: -2 })
    expect(await beforeAttack({ actor, att: glockSemi })).toBeUndefined()
    expect(stateOf(actor, 'Glock 17')).toBe('ready')
    expect(setManeuver).not.toHaveBeenCalled()
    // The Fast-Draw roll saw only its own modifier; the attack's range penalty is back in the bucket.
    expect(bucketAtRoll[0]).toEqual([{ modint: -2, desc: 'GURPS.agency.readiness.mod.situation' }])
    expect(stack.modifierList).toEqual([{ modint: -3, desc: 'range' }])
    expect(performAction.mock.calls[0][0]).toMatchObject({ otf: 'Sk:"Fast-Draw (Pistol)"' })
  })

  test('Gunslinger halves the Fast-Draw penalty', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Pistol)', level: 13 } }, { '00000': { name: 'Gunslinger' } })
    startCombat(actor)
    wait.mockResolvedValueOnce({ kind: 'fastdraw', modifier: -3 })
    await beforeAttack({ actor, att: glockSemi })
    expect(bucketAtRoll[0]).toEqual([{ modint: -1, desc: 'GURPS.agency.readiness.mod.situation' }])
    expect(lastCard()).toContain('note.gunslinger:from=-3,to=-1')
  })

  test('Fast-Draw failure: ready, but the turn is spent', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Pistol)', level: 13 } })
    startCombat(actor)
    nextRoll = { failure: true }
    wait.mockResolvedValueOnce({ kind: 'fastdraw', modifier: 0 })
    expect(await beforeAttack({ actor, att: glockSemi })).toBe(false)
    expect(stateOf(actor, 'Glock 17')).toBe('ready')
    expect(setManeuver).toHaveBeenCalledWith('ready')
  })

  test('Fast-Draw critical failure: dropped', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Pistol)', level: 13 } })
    startCombat(actor)
    nextRoll = { failure: true, isCritFailure: true }
    wait.mockResolvedValueOnce({ kind: 'fastdraw', modifier: 0 })
    expect(await beforeAttack({ actor, att: glockSemi })).toBe(false)
    expect(stateOf(actor, 'Glock 17')).toBe('dropped')
    expect(lastCard()).toContain('note.fastDraw.critical-failure')
  })

  test('cancelling the prompt cancels the attack and changes nothing', async () => {
    const actor = makeActor()
    startCombat(actor)
    wait.mockResolvedValueOnce(null)
    expect(await beforeAttack({ actor, att: glockSemi })).toBe(false)
    expect(stateOf(actor, 'Glock 17')).toBe('holstered')
    expect(actor.update).not.toHaveBeenCalled()
  })

  test('off-turn (after a Wait), Ready leaves the maneuver alone', async () => {
    const actor = makeActor()
    startCombat(actor, { turn: false })
    wait.mockResolvedValueOnce({ kind: 'ready', modifier: 0 })
    expect(await beforeAttack({ actor, att: glockSemi })).toBe(false)
    expect(setManeuver).not.toHaveBeenCalled()
    expect(lastCard()).toContain('note.ready:')
  })

  test('the setting turns it all off', async () => {
    settings['agency-readiness'] = false
    const actor = makeActor()
    startCombat(actor)
    expect(await beforeAttack({ actor, att: glockSemi })).toBeUndefined()
    expect(wait).not.toHaveBeenCalled()
  })
})

describe('reloading', () => {
  const firearmView = (actor: any) => weaponViews(actor)[0]
  const gunReady = (actor: any) => {
    const id = readyViews(actor).find(v => v.weapon.name === 'Glock 17')!.weapon.id
    actor.flags.gurps.agency.readiness = { weapons: { [id]: { state: 'ready' } } }
  }

  test('in combat a holstered gun cannot be reloaded', async () => {
    const actor = makeActor()
    startCombat(actor)
    expect(await reloadGate({ actor, view: firearmView(actor), inCombat: true })).toEqual({ proceed: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reloadNotReady'))
  })

  test('out of combat it is drawn first', async () => {
    const actor = makeActor()
    const result = await reloadGate({ actor, view: firearmView(actor), inCombat: false })
    expect(result.proceed).toBe(true)
    expect(stateOf(actor, 'Glock 17')).toBe('ready')
  })

  test('Fast-Draw (Ammo) success takes a second off', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Ammo)', level: 12 } })
    gunReady(actor)
    startCombat(actor)
    const result = await reloadGate({ actor, view: firearmView(actor), inCombat: true })
    expect(result).toMatchObject({ proceed: true, secondsSaved: 1 })
    expect(result.notes?.[0]).toContain('note.ammo.success')
  })

  test('Fast-Draw (Ammo) critical failure: no reload', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Ammo)', level: 12 } })
    gunReady(actor)
    startCombat(actor)
    nextRoll = { failure: true, isCritFailure: true }
    expect(await reloadGate({ actor, view: firearmView(actor), inCombat: true })).toMatchObject({ proceed: false })
  })

  test('no roll without the skill or outside combat', async () => {
    const actor = makeActor({ '00000': { name: 'Fast-Draw (Ammo)', level: 12 } })
    gunReady(actor)
    expect(await reloadGate({ actor, view: firearmView(actor), inCombat: false })).toEqual({ proceed: true, notes: [] })
    expect(performAction).not.toHaveBeenCalled()
  })
})

describe('defense and turn flow', () => {
  test('parry choices: the knife only once it is ready, the punch always', () => {
    const actor = makeActor()
    const data = {
      actor,
      type: 'parry',
      weapons: [
        { name: 'Natural Attacks (Punch)', value: 9, fencing: false },
        { name: 'Combat Knife (Thrust)', value: 8, fencing: false },
      ],
    }
    onDefenseWeapons(data)
    expect(data.weapons.map(w => w.name)).toEqual(['Natural Attacks (Punch)'])

    const knifeId = readyViews(actor).find(v => v.weapon.name === 'Combat Knife')!.weapon.id
    actor.flags.gurps.agency.readiness = { weapons: { [knifeId]: { state: 'ready' } } }
    const again = { ...data, weapons: [...data.weapons, { name: 'Combat Knife (Thrust)', value: 8, fencing: false }] }
    onDefenseWeapons(again)
    expect(again.weapons.map(w => w.name)).toContain('Combat Knife (Thrust)')
  })

  test('blocks are left alone', () => {
    const data = { actor: makeActor(), type: 'block', weapons: [{ name: 'Combat Knife (Thrust)' }] }
    onDefenseWeapons(data)
    expect(data.weapons).toHaveLength(1)
  })

  test('combat start: back to carry state when the setting says so', async () => {
    const actor = makeActor()
    const ids = Object.fromEntries(readyViews(actor).map(v => [v.weapon.name, v.weapon.id]))
    actor.flags.gurps.agency.readiness = { weapons: { [ids['Glock 17']]: { state: 'ready' } } }
    await onCombatStart({ combatants: [{ actor }] })
    expect(stateOf(actor, 'Glock 17')).toBe('ready')
    settings['agency-readiness-combat-start'] = 'carry'
    await onCombatStart({ combatants: [{ actor }] })
    expect(stateOf(actor, 'Glock 17')).toBe('holstered')
  })

  test('Ready from the turn card asks which weapon', async () => {
    const actor = makeActor()
    const knifeId = readyViews(actor).find(v => v.weapon.name === 'Combat Knife')!.weapon.id
    prompt.mockResolvedValueOnce(knifeId)
    await onManeuverPicked({ actor, maneuver: 'ready' })
    expect(stateOf(actor, 'Combat Knife')).toBe('ready')
    expect(stateOf(actor, 'Glock 17')).toBe('holstered')

    prompt.mockClear()
    await onManeuverPicked({ actor, maneuver: 'aim' })
    expect(prompt).not.toHaveBeenCalled()
  })
})

describe('/ready and /holster lookup', () => {
  test('by equipment name, attack name or "name (usage)"', () => {
    const views = readyViews(makeActor())
    expect(matchReadyViews(views, 'glock').map(v => v.weapon.name)).toEqual(['Glock 17'])
    expect(matchReadyViews(views, 'Combat Knife (Thrust)').map(v => v.weapon.name)).toEqual(['Combat Knife'])
    expect(matchReadyViews(views, 'punch')).toEqual([])
  })
})
