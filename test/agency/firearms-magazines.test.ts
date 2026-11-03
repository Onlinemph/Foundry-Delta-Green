import { jest } from '@jest/globals'
import {
  configuredAmmoNames,
  feedKey,
  gunName,
  magazineChoices,
  mergeLegacyStates,
  planLoad,
  planMagazineSwap,
  quickReloadChoice,
  weaponId,
  weaponKey,
  type EquipmentEntry,
  type MagazineChoice,
  type PartialMagazine,
} from '../../module/agency/firearms/ammo.js'
import { onPreRoll, onRollComplete } from '../../module/agency/firearms/firing.js'
import { choicesFor, registerReloadGate, reloadWeapon } from '../../module/agency/firearms/reload.js'
import { parseShots } from '../../module/agency/firearms/shots.js'
import { feedViews, weaponViews } from '../../module/agency/firearms/state.js'

/* ---------------------------------------- */
/*  Pure rules                              */
/* ---------------------------------------- */

const glock = parseShots('17+1(3)')
const shotgun = parseShots('5+1(2i)')

describe('one gun, one magazine', () => {
  test('usages of the same gun with the same Shots share a feed', () => {
    const semi = { name: 'Glock 18', mode: 'Semi', shots: '17+1(3)' }
    const auto = { name: 'Glock 18', mode: 'Auto', shots: '17+1(3)' }
    expect(feedKey(semi, glock)).toBe(feedKey(auto, glock))
    expect(feedKey(semi, glock)).toBe('gun:glock 18|17+1')
  })

  test('different Shots are different feeds (rifle and underbarrel launcher on one item)', () => {
    const rifle = { name: 'M16A2/M203', mode: 'Rifle', shots: '30+1(3)' }
    const launcher = { name: 'M16A2/M203', mode: 'M203', shots: '1(3)' }
    expect(feedKey(rifle, parseShots(rifle.shots))).not.toBe(feedKey(launcher, parseShots(launcher.shots)))
  })

  test('different names are different guns', () => {
    expect(feedKey({ name: 'M16A2' }, parseShots('30(3)'))).not.toBe(feedKey({ name: 'M203' }, parseShots('30(3)')))
  })

  test('a usage marked separate keeps its per-usage key', () => {
    const weapon = { name: 'Glock 18', mode: 'Auto', shots: '17+1(3)' }
    expect(feedKey(weapon, glock, true)).toBe(weaponKey(weapon))
  })

  test('untracked weapons keep their per-usage key', () => {
    const laser = { name: 'Laser', mode: 'Beam', shots: 'FP' }
    expect(feedKey(laser, parseShots('FP'))).toBe(weaponKey(laser))
  })

  test('Foundry-items mode names ("<item> - <usage>") group by the item', () => {
    expect(gunName({ name: 'Glock 18 - Semi', mode: 'Semi' })).toBe('Glock 18')
    expect(gunName({ name: 'Glock 18', mode: 'Semi' })).toBe('Glock 18')
    expect(gunName({ name: 'Semi', mode: 'Semi' })).toBe('Semi')
    expect(feedKey({ name: 'Glock 18 - Semi', mode: 'Semi' }, glock)).toBe(
      feedKey({ name: 'Glock 18 - Auto', mode: 'Auto' }, glock)
    )
  })

  test('older per-usage states merge: lowest count, every ammo item, first unit', () => {
    expect(
      mergeLegacyStates([
        { loaded: 12, ammoItem: 'Glock Mag' },
        { loaded: 7, ammoItems: ['Glock Mag (33)'], ammoUnit: 'magazines' },
        {},
      ])
    ).toEqual({ loaded: 7, ammoItems: ['Glock Mag', 'Glock Mag (33)'], ammoUnit: 'magazines' })
    expect(mergeLegacyStates([{}, {}])).toEqual({})
  })

  test('configured names: list first, then the older single item, no duplicates', () => {
    expect(configuredAmmoNames({ ammoItems: ['A', ' a ', 'B', ''], ammoItem: 'C' })).toEqual(['A', 'B', 'C'])
    expect(configuredAmmoNames(undefined)).toEqual([])
  })
})

describe('planMagazineSwap', () => {
  test('a chambered round stays when the gun was not fired dry', () => {
    expect(planMagazineSwap(glock, 6, 17)).toEqual({ newLoaded: 18, kept: 1, ejected: 5 })
  })

  test('fired dry: the new magazine has to be chambered', () => {
    expect(planMagazineSwap(glock, 0, 17)).toEqual({ newLoaded: 17, kept: 0, ejected: 0 })
  })

  test('a partial magazine', () => {
    expect(planMagazineSwap(glock, 3, 9)).toEqual({ newLoaded: 10, kept: 1, ejected: 2 })
  })

  test('never above full', () => {
    expect(planMagazineSwap(glock, 18, 33).newLoaded).toBe(18)
  })
})

const carried: EquipmentEntry[] = [
  { path: 'c.0', name: 'Glock Magazine', count: 2 },
  { path: 'c.1', name: 'Glock Magazine (33)', count: 1 },
  { path: 'c.2', name: '9mm Rounds', count: 50 },
  { path: 'c.3', name: 'Rope', count: 1 },
]
const partials: PartialMagazine[] = [
  { id: 'p1', item: 'Glock Magazine', rounds: 5, capacity: 17, feed: 'wX' },
  { id: 'p2', item: 'Glock Magazine', rounds: 12, capacity: 17, feed: 'wX' },
  { id: 'p3', item: 'Glock Magazine', rounds: 5, capacity: 17, feed: 'wY' },
  { id: 'p4', item: 'AK Magazine', rounds: 20, capacity: 30, feed: 'wZ' },
  { id: 'p5', item: '', rounds: 3, capacity: 17, feed: 'wX' },
]

describe('magazineChoices', () => {
  const choices = magazineChoices({
    spec: glock,
    unit: 'magazines',
    feedId: 'wX',
    names: ['Glock Magazine'],
    carried,
    partials,
    magazine: 'Glock Magazine',
  })

  test('items in the best tier, then partials grouped by rounds, fullest first', () => {
    expect(choices.map(c => [c.kind, c.name, c.rounds, c.count])).toEqual([
      ['item', 'Glock Magazine', 17, 2],
      ['partial', 'Glock Magazine', 12, 1],
      ['partial', 'Glock Magazine', 5, 2],
      // Ejected from this gun even though the item name is gone.
      ['partial', '', 3, 1],
    ])
    expect(choices[0].current).toBe(true)
    expect(choices[2].partialIds).toEqual(['p1', 'p3'])
  })

  test('several names: each one lists its own items', () => {
    const list = magazineChoices({
      spec: glock,
      unit: 'magazines',
      feedId: 'w?',
      names: ['Glock Magazine (33)', 'Glock'],
      carried,
      partials: [],
    })
    expect(list.map(c => c.path)).toEqual(['c.1', 'c.0'])
  })

  test('loose rounds: the count is the rounds, and no partial magazines', () => {
    const list = magazineChoices({
      spec: shotgun,
      unit: 'rounds',
      feedId: 'wX',
      names: ['9mm'],
      carried,
      partials,
    })
    expect(list).toEqual([expect.objectContaining({ kind: 'item', name: '9mm Rounds', rounds: 50, count: 50 })])
  })
})

describe('planLoad', () => {
  const item = (count: number): MagazineChoice => ({
    id: 'item:c.0',
    kind: 'item',
    name: 'Glock Magazine',
    rounds: 17,
    capacity: 17,
    count,
    path: 'c.0',
    current: false,
  })
  const partial = (rounds: number): MagazineChoice => ({
    id: `partial:glock magazine|${rounds}`,
    kind: 'partial',
    name: 'Glock Magazine',
    rounds,
    capacity: 17,
    count: 1,
    partialIds: ['p'],
    current: false,
  })
  const base = { spec: glock, unit: 'magazines' as const, tracked: true }

  test('quick reload: a full magazine first', () => {
    const plan = planLoad({ ...base, loaded: 4, choices: [item(1), partial(12)] })
    expect(plan).toMatchObject({ ok: true, newLoaded: 18, itemUsed: 1, ejected: 3 })
    expect(plan.choice?.kind).toBe('item')
  })

  test('quick reload: no full magazine left, the fullest partial worth swapping', () => {
    expect(planLoad({ ...base, loaded: 4, choices: [item(0), partial(12)] })).toMatchObject({
      ok: true,
      newLoaded: 13,
      itemUsed: 0,
      ejected: 3,
    })
    // 6 left in the magazine: a 5-round partial isn't worth it.
    expect(planLoad({ ...base, loaded: 7, choices: [item(0), partial(5)] })).toMatchObject({
      ok: false,
      reason: 'no-ammo',
    })
  })

  test('quick reload refuses a full gun; a pick from the dialog swaps anyway', () => {
    expect(planLoad({ ...base, loaded: 18, choices: [item(1)] }).reason).toBe('full')
    expect(planLoad({ ...base, loaded: 18, choices: [item(1)], choiceId: 'item:c.0' })).toMatchObject({
      ok: true,
      newLoaded: 18,
      ejected: 17,
    })
  })

  test('a pick that is gone', () => {
    expect(planLoad({ ...base, loaded: 3, choices: [item(0)], choiceId: 'item:c.0' }).reason).toBe('gone')
    expect(planLoad({ ...base, loaded: 3, choices: [], choiceId: 'item:c.9' }).reason).toBe('gone')
  })

  test('nothing tracked: free reloads', () => {
    expect(planLoad({ ...base, tracked: false, loaded: 0, choices: [] })).toMatchObject({
      ok: true,
      choice: undefined,
      newLoaded: 17,
      itemUsed: 0,
    })
  })

  test('loose rounds top up', () => {
    const rounds: MagazineChoice = { ...item(3), rounds: 3, kind: 'item' }
    expect(planLoad({ ...base, unit: 'rounds', loaded: 10, choices: [rounds] })).toMatchObject({
      ok: true,
      newLoaded: 13,
      itemUsed: 3,
      ejected: 0,
    })
  })

  test('quickReloadChoice skips empty items', () => {
    expect(quickReloadChoice([item(0), { ...item(2), id: 'item:c.1' }], glock, 0)?.id).toBe('item:c.1')
  })
})

/* ---------------------------------------- */
/*  With a fake actor                       */
/* ---------------------------------------- */

const settings: Record<string, unknown> = {}
const warn = jest.fn()
const info = jest.fn()
const g = globalThis as any
g.game.settings = { get: (_ns: string, key: string) => settings[key] }
g.game.i18n.format = (key: string, data?: Record<string, unknown>) =>
  `${key}:${Object.entries(data ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`
g.ui = { notifications: { warn, info } }
g.GURPS.ModifierBucket = { addModifier: jest.fn() }
const createMessage = jest.fn(async (_data: { content: string }) => undefined)
g.ChatMessage = { create: createMessage, getSpeaker: () => ({ alias: 'Shooter' }) }

function setPath(target: any, path: string, value: unknown) {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) node = node[part] ??= {}
  const last = parts.at(-1)!
  if (last.startsWith('-=')) delete node[last.slice(2)]
  else node[last] = value
}

function makeActor({
  ranged = {} as Record<string, any>,
  carried = {} as Record<string, any>,
  weapons = {} as Record<string, any>,
  partials = [] as PartialMagazine[],
} = {}) {
  const actor = {
    id: 'a1',
    uuid: `Actor.${Math.random()}`,
    name: 'Shooter',
    isOwner: true,
    flags: { gurps: { agency: { firearms: { weapons, partials } } } } as Record<string, any>,
    system: { ranged, equipment: { carried } },
    update: jest.fn(async (data: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(data)) setPath(actor, key, value)
    }),
    updateEqtCount: jest.fn(async (path: string, count: number) => setPath(actor, `${path}.count`, count)),
  }
  return actor
}

const semi = { name: 'Glock 18', mode: 'Semi', shots: '17+1(3)', rof: '3', ammo: 0 }
const auto = { name: 'Glock 18', mode: 'Auto', shots: '17+1(3)', rof: '20', ammo: 0 }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const lastCard = () => (createMessage.mock.calls.at(-1)?.[0] as { content: string }).content

function fire(actor: any, weapon: object, shots: number) {
  const optionalArgs: Record<string, any> = { obj: weapon, shots }
  onPreRoll({ actor, optionalArgs, action: { type: 'attack' }, targetmods: [] })
  onRollComplete({ actor, optionalArgs })
}

beforeEach(() => {
  Object.assign(settings, { 'agency-ammo-tracking': true, 'agency-ammo-empty': 'block', 'agency-ammo-thrown': false })
  jest.clearAllMocks()
})

describe('shared magazine', () => {
  test('shots in either usage come out of one magazine', async () => {
    const actor = makeActor({ ranged: { '00000': semi, '00001': auto } })
    fire(actor, semi, 2)
    await flush()
    fire(actor, auto, 5)
    await flush()
    const [a, b] = weaponViews(actor)
    expect(a.id).toBe(b.id)
    expect(a.loaded).toBe(11)
    expect(b.loaded).toBe(11)
    expect(a.modes).toBe(2)
    expect(a.label).toBe('Glock 18')
    expect(feedViews(actor)).toHaveLength(1)
  })

  test('per-usage counts from before are merged (lowest) and replaced on the next write', async () => {
    const semiId = weaponId(weaponKey(semi))
    const autoId = weaponId(weaponKey(auto))
    const actor = makeActor({
      ranged: { '00000': semi, '00001': auto },
      weapons: { [semiId]: { loaded: 12, ammoItem: 'Glock Magazine' }, [autoId]: { loaded: 4 } },
    })
    const view = weaponViews(actor)[0]
    expect(view.loaded).toBe(4)
    expect(view.legacyIds.sort()).toEqual([semiId, autoId].sort())

    fire(actor, semi, 1)
    await flush()
    const weapons = actor.flags.gurps.agency.firearms.weapons
    expect(Object.keys(weapons)).toEqual([view.id])
    expect(weapons[view.id]).toMatchObject({ loaded: 3, ammoItems: ['Glock Magazine'] })
  })

  test('a usage marked separate keeps its own count', async () => {
    const autoId = weaponId(weaponKey(auto))
    const actor = makeActor({
      ranged: { '00000': semi, '00001': auto },
      weapons: { [autoId]: { separate: true, loaded: 30 } },
    })
    fire(actor, semi, 2)
    await flush()
    const [a, b] = weaponViews(actor)
    expect(a.id).not.toBe(b.id)
    expect(a.loaded).toBe(16)
    expect(b.loaded).toBe(18)
    expect(b.label).toBe('Glock 18 (Auto)')
  })
})

describe('reloading with partial magazines', () => {
  const carriedMags = () => ({
    '00000': { name: 'Glock Magazine', count: 2 },
    '00001': { name: 'Glock Magazine (HP)', count: 1 },
  })
  const configured = (loaded: number, extra: object = {}) => {
    const actor = makeActor({ ranged: { '00000': semi }, carried: carriedMags() })
    const id = weaponViews(actor)[0].id
    actor.flags.gurps.agency.firearms.weapons[id] = {
      loaded,
      ammoItems: ['Glock Magazine', 'Glock Magazine (HP)'],
      magazine: 'Glock Magazine',
      ...extra,
    }
    return actor
  }
  const view = (actor: any) => weaponViews(actor)[0]
  const partialsOf = (actor: any): PartialMagazine[] => actor.flags.gurps.agency.firearms.partials

  test('quick reload: the ejected magazine is kept with its rounds, a full one is used up', async () => {
    const actor = configured(6)
    expect(await reloadWeapon(actor, view(actor))).toBe(true)
    expect(view(actor).loaded).toBe(18)
    expect(actor.system.equipment.carried['00000'].count).toBe(1)
    expect(partialsOf(actor)).toEqual([
      expect.objectContaining({ item: 'Glock Magazine', rounds: 5, capacity: 17, feed: view(actor).id }),
    ])
    expect(lastCard()).toContain('chat.partialKept:item=Glock Magazine,count=5')
  })

  test('the change dialog lists items for every configured name and the partials', () => {
    const actor = configured(6, {})
    actor.flags.gurps.agency.firearms.partials = [
      { id: 'p1', item: 'Glock Magazine', rounds: 9, capacity: 17, feed: 'other' },
    ]
    expect(choicesFor(actor, view(actor)).map(c => `${c.kind}:${c.name}:${c.rounds}x${c.count}`)).toEqual([
      'item:Glock Magazine:17x2',
      'item:Glock Magazine (HP):17x1',
      'partial:Glock Magazine:9x1',
    ])
  })

  test('loading a partial removes its record and names the magazine loaded', async () => {
    const actor = configured(3)
    actor.flags.gurps.agency.firearms.partials = [
      { id: 'p1', item: 'Glock Magazine', rounds: 9, capacity: 17, feed: 'other' },
    ]
    const pick = choicesFor(actor, view(actor)).find(c => c.kind === 'partial')!
    expect(await reloadWeapon(actor, view(actor), pick.id)).toBe(true)
    expect(view(actor).loaded).toBe(10)
    expect(view(actor).state.magazine).toBe('Glock Magazine')
    // The 2 rounds ejected become a partial; the 9-round one is gone.
    expect(partialsOf(actor).map(p => p.rounds)).toEqual([2])
    expect(actor.updateEqtCount).not.toHaveBeenCalled()
  })

  test('swapping a full magazine for another kind puts the full one back with the others', async () => {
    const actor = configured(18)
    const pick = choicesFor(actor, view(actor)).find(c => c.name === 'Glock Magazine (HP)')!
    expect(await reloadWeapon(actor, view(actor), pick.id)).toBe(true)
    expect(view(actor).loaded).toBe(18)
    expect(view(actor).state.magazine).toBe('Glock Magazine (HP)')
    expect(actor.system.equipment.carried['00001'].count).toBe(0)
    expect(actor.system.equipment.carried['00000'].count).toBe(3)
    expect(partialsOf(actor)).toEqual([])
    expect(lastCard()).toContain('chat.returned:item=Glock Magazine,count=3')
  })

  test('no full magazines left: the quick reload takes the fullest partial', async () => {
    const actor = configured(2)
    actor.system.equipment.carried['00000'].count = 0
    actor.system.equipment.carried['00001'].count = 0
    actor.flags.gurps.agency.firearms.partials = [
      { id: 'p1', item: 'Glock Magazine', rounds: 4, capacity: 17, feed: 'x' },
      { id: 'p2', item: 'Glock Magazine', rounds: 11, capacity: 17, feed: 'x' },
    ]
    expect(await reloadWeapon(actor, view(actor))).toBe(true)
    expect(view(actor).loaded).toBe(12)
    // p2 (11 rounds) went in; the 1 round ejected is a new partial; p1 stays.
    expect(partialsOf(actor).map(p => p.rounds)).toEqual([4, 1])
    expect(partialsOf(actor)[0].id).toBe('p1')
  })

  test('free reloads keep no partials', async () => {
    const actor = makeActor({ ranged: { '00000': semi } })
    actor.flags.gurps.agency.firearms.weapons[view(actor).id] = { loaded: 6 }
    expect(await reloadWeapon(actor, view(actor))).toBe(true)
    expect(partialsOf(actor)).toEqual([])
    expect(lastCard()).toContain('chat.oldMagazine:count=5')
  })
})

describe('reload gates', () => {
  let answer: { proceed: boolean; secondsSaved?: number; notes?: string[] } = { proceed: true }
  const gate = jest.fn(async () => answer)
  registerReloadGate(gate)

  test('a gate can stop a reload and say why on a card', async () => {
    answer = { proceed: false, notes: ['not ready'] }
    const actor = makeActor({ ranged: { '00000': semi } })
    actor.flags.gurps.agency.firearms.weapons[weaponViews(actor)[0].id] = { loaded: 0 }
    expect(await reloadWeapon(actor, weaponViews(actor)[0])).toBe(false)
    expect(weaponViews(actor)[0].loaded).toBe(0)
    expect(lastCard()).toContain('not ready')
  })

  test('a gate can take time off and add a line', async () => {
    answer = { proceed: true, secondsSaved: 1, notes: ['Fast-Draw (Ammo): -1 s'] }
    const actor = makeActor({ ranged: { '00000': semi } })
    actor.flags.gurps.agency.firearms.weapons[weaponViews(actor)[0].id] = { loaded: 0 }
    expect(await reloadWeapon(actor, weaponViews(actor)[0])).toBe(true)
    expect(lastCard()).toContain('chat.time:seconds=2')
    expect(lastCard()).toContain('Fast-Draw (Ammo): -1 s')
  })

  test('gates are not asked when there is nothing to reload', async () => {
    answer = { proceed: true }
    gate.mockClear()
    const actor = makeActor({ ranged: { '00000': semi } })
    expect(await reloadWeapon(actor, weaponViews(actor)[0])).toBe(false)
    expect(gate).not.toHaveBeenCalled()
  })
})
