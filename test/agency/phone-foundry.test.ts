/**
 * The phone's Foundry glue (store.ts, sync.ts) against small fakes: actors with owners and flags,
 * scenes with tokens and signal flags, chat messages, users and world settings.
 */
import { readFileSync } from 'node:fs'
import * as store from '../../module/agency/phone/store.ts'
import { runCatchUp } from '../../module/agency/phone/sync.ts'
import { isFictional } from '../../module/agency/phone/numbers.ts'
import { emptyDevice } from '../../module/agency/phone/types.ts'

const lang = JSON.parse(readFileSync('lang/agency/en-phone.json', 'utf8'))
const getProperty = (o: any, path: string) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o)
function setProperty(o: any, path: string, value: any) {
  const keys = path.split('.')
  let x = o
  for (const k of keys.slice(0, -1)) x = x[k] ??= {}
  x[keys[keys.length - 1]] = value
}

class FakeUser {
  constructor(
    public id: string,
    public isGM = false,
    public active = true
  ) {}
}
const gm = new FakeUser('gm', true)
const p1 = new FakeUser('p1')
const p2 = new FakeUser('p2')
const p3 = new FakeUser('p3')

class FakeActor {
  flags: any = {}
  img = 'icons/agent.webp'
  updates: any[] = []
  constructor(
    public id: string,
    public name: string,
    public owners: string[],
    public type = 'character'
  ) {}
  get hasPlayerOwner() {
    return this.owners.length > 0
  }
  testUserPermission(user: FakeUser, level: number) {
    return level <= 3 && (user.isGM || this.owners.includes(user.id))
  }
  async update(data: Record<string, any>, options?: any) {
    this.updates.push({ data, options })
    for (const [k, v] of Object.entries(data)) setProperty(this, k, v)
  }
}

class FakeScene {
  flags: any = {}
  tokens: any[] = []
  background = { src: 'maps/motel.webp' }
  dimensions = { sceneX: 100, sceneY: 100, sceneWidth: 2000, sceneHeight: 1000, size: 100 }
  constructor(
    public id: string,
    public name: string,
    signal = true
  ) {
    if (!signal) this.flags = { gurps: { agency: { phone: { signal: false } } } }
  }
  place(actorId: string, x = 1050, y = 550) {
    this.tokens.push({ actorId, x, y, width: 1, height: 1 })
    return this
  }
}

let messageCount = 0
class FakeMessage {
  id = `msg${++messageCount}`
  timestamp = 1000 + messageCount
  constructor(public data: any) {
    Object.assign(this, data)
  }
}

const mara = new FakeActor('mara', 'Mara Quinn', ['p1'])
const tom = new FakeActor('tom', 'Tom Reyes', ['p2'])
const npcActor = new FakeActor('goon', 'Goon', [], 'enemy')
mara.flags = {
  gurps: {
    agency: {
      phone: {
        smartphone: { ...emptyDevice('2025550143'), contacts: [{ id: 'c', name: 'Tom', number: '2025550158' }] },
      },
    },
  },
}
tom.flags = {
  gurps: { agency: { phone: { smartphone: emptyDevice('2025550158'), burner: emptyDevice('7025550161') } } },
}
const street = new FakeScene('street', 'Route 9')
const cellar = new FakeScene('cellar', 'Cellar', false)
let npcs: any[] = [{ id: 'h', name: 'Handler', number: '2025550100', img: '', read: {}, callsSeen: 0 }]
const messages: FakeMessage[] = []
const updateDocuments: any[] = []

beforeAll(() => {
  const g = globalThis as any
  const coll = (items: any[]) => ({
    get contents() {
      return items
    },
    get: (id: string) => items.find(i => i.id === id),
    filter: (f: any) => items.filter(f),
  })
  g.game = {
    ...g.game,
    user: p1,
    users: { contents: [gm, p1, p2, p3], activeGM: { isSelf: true } },
    actors: coll([mara, tom, npcActor]),
    scenes: { ...coll([street, cellar]), active: street },
    messages: coll(messages),
    time: { worldTime: 3600 },
    i18n: {
      lang: 'en',
      localize: (k: string) => getProperty(lang, k) ?? k,
      format: (k: string, d: any) =>
        String(getProperty(lang, k) ?? k).replace(/\{(\w+)\}/g, (_: string, x: string) => String(d[x])),
    },
    settings: {
      get: (_ns: string, key: string) => (key === 'agency-phone-npcs' ? npcs : undefined),
      set: async (_ns: string, key: string, value: any) => {
        if (key === 'agency-phone-npcs') npcs = value
      },
    },
  }
  g.CONST = { CHAT_MESSAGE_STYLES: { OTHER: 0 } }
  g.ChatMessage = {
    create: async (data: any) => {
      const m = new FakeMessage(data)
      messages.push(m)
      return m
    },
    updateDocuments: async (updates: any[]) => {
      updateDocuments.push(...updates)
      for (const u of updates) {
        const m = messages.find(x => x.id === u._id)!
        for (const [k, v] of Object.entries(u)) if (k !== '_id') setProperty(m, k, v)
      }
    },
  }
  g.canvas = { scene: street }
})

beforeEach(() => {
  messages.length = 0
  street.tokens = []
  cellar.tokens = []
  ;(globalThis as any).game.user = p1
  ;(globalThis as any).game.scenes.active = street
})

const flag = (m: any) => m.flags.gurps.agency.phone

describe('phone store', () => {
  test('a text between agents is whispered to both owners and the GMs, never to bystanders', async () => {
    street.place('mara').place('tom')
    await store.sendText('mara:smartphone', '2025550158', 'You up?')
    const m: any = messages[0]
    expect(m.whisper.sort()).toEqual(['gm', 'p1', 'p2'])
    expect(m.whisper).not.toContain('p3')
    expect(flag(m)).toMatchObject({ type: 'sms', state: 'delivered', text: 'You up?', sentAt: 3600 })
    expect(flag(m).to).toEqual({ number: '2025550158', device: 'tom:smartphone' })
    expect(m.content).not.toContain('You up?')
  })

  test('texts to a number nobody holds go to the GM only', async () => {
    await store.sendText('mara:smartphone', '3125550199', 'Who is this?')
    const m: any = messages[0]
    expect(m.whisper.sort()).toEqual(['gm', 'p1'])
    expect(flag(m).to).toEqual({ number: '3125550199' })
    expect(store.unlistedNumbers()).toEqual([{ number: '3125550199', count: 1 }])
  })

  test('numbers resolve to agents, NPC identities, or nobody', () => {
    expect(store.resolveNumber('7025550161')).toEqual({ number: '7025550161', device: 'tom:burner' })
    expect(store.resolveNumber('2025550100')).toEqual({ number: '2025550100', device: 'npc:h' })
    expect(store.resolveNumber('2025550111')).toEqual({ number: '2025550111' })
  })

  test('no signal: outbox for the sender, held for the recipient, then delivered by the GM catch-up', async () => {
    cellar.place('mara')
    ;(globalThis as any).game.scenes.active = cellar
    await store.sendText('mara:smartphone', '2025550100', 'can you hear me')
    expect(flag(messages[0]).state).toBe('outbox')
    ;(globalThis as any).game.scenes.active = street
    cellar.tokens = []
    street.place('mara').place('tom')
    cellar.place('tom')
    ;(globalThis as any).game.scenes.active = cellar
    await store.sendText('mara:smartphone', '2025550158', 'hello?')
    expect(flag(messages[1]).state).toBe('held')
    // Everyone walks out into the street.
    cellar.tokens = []
    ;(globalThis as any).game.scenes.active = street
    await runCatchUp()
    expect(flag(messages[0]).state).toBe('delivered')
    expect(flag(messages[1]).state).toBe('delivered')
    expect(flag(messages[1]).deliveredTs).toBeGreaterThan(0)
  })

  test('agents with no token anywhere have signal', () => {
    expect(store.deviceHasSignal('mara:smartphone')).toBe(true)
    cellar.place('mara')
    expect(store.deviceHasSignal('mara:smartphone')).toBe(false)
  })

  test('who may open which phone', () => {
    expect(store.canOpen('mara:smartphone')).toBe(true)
    expect(store.canOpen('tom:smartphone')).toBe(false)
    expect(store.canOpen('npc:h')).toBe(false)
    ;(globalThis as any).game.user = gm
    expect(store.canOpen('tom:burner')).toBe(true)
    expect(store.canOpen('npc:h')).toBe(true)
    expect(store.isInspect('tom:burner')).toBe(true)
  })

  test('snapshot: contacts name numbers; the map shows only when the scene allows it', () => {
    street.place('mara', 1050, 550)
    let snap = store.buildSnapshot('mara:smartphone', { inspect: false, call: null, preview: null, flashlight: false })!
    expect(snap.names).toEqual({ '2025550158': 'Tom' })
    expect(snap.map).toEqual({ src: null, dot: null, aspect: 1, place: '' })
    street.flags = { gurps: { agency: { phone: { map: 'background', mapLabel: 'Route 9' } } } }
    snap = store.buildSnapshot('mara:smartphone', { inspect: false, call: null, preview: null, flashlight: false })!
    expect(snap.map).toEqual({ src: 'maps/motel.webp', dot: { u: 0.5, v: 0.5 }, aspect: 2, place: 'Route 9' })
    street.flags = {}
  })

  test('the GM sees the whole directory on NPC phones', () => {
    ;(globalThis as any).game.user = gm
    const snap = store.buildSnapshot('npc:h', { inspect: false, call: null, preview: null, flashlight: false })!
    expect(snap.device).toMatchObject({ owner: 'npc', skin: 'smartphone', name: 'Handler' })
    expect(snap.names['7025550161']).toBe('Tom Reyes (burner)')
    expect(snap.apps).not.toContain('camera')
  })

  test('reading a thread stores a read marker without re-rendering sheets', async () => {
    street.place('mara').place('tom')
    ;(globalThis as any).game.user = p2
    await store.sendText('tom:smartphone', '2025550143', 'ping')
    ;(globalThis as any).game.user = p1
    expect(store.unreadFor('mara:smartphone')).toBe(1)
    await store.markRead('mara:smartphone', '2025550158')
    expect(store.unreadFor('mara:smartphone')).toBe(0)
    expect(mara.updates[mara.updates.length - 1].options).toEqual({ render: false })
  })

  test('player characters are issued a fictional smartphone number; NPCs and refused ones are not', async () => {
    const newbie = new FakeActor('new', 'New Agent', ['p3'])
    const refused = new FakeActor('ref', 'Refused', ['p3'])
    refused.flags = { gurps: { agency: { phone: { noAutoSmartphone: true } } } }
    expect(store.needsSmartphone(newbie)).toBe(true)
    expect(store.needsSmartphone(refused)).toBe(false)
    expect(store.needsSmartphone(npcActor)).toBe(false)
    expect(store.needsSmartphone(mara)).toBe(false)
    expect(await store.provisionSmartphones([newbie, refused, npcActor])).toBe(1)
    const number = newbie.flags.gurps.agency.phone.smartphone.number
    expect(isFictional(number)).toBe(true)
    expect(store.takenNumbers()).not.toContain(number) // newbie isn't in game.actors in this fake
    await store.revokeDevice(newbie, 'smartphone')
    expect(newbie.flags.gurps.agency.phone).toMatchObject({ smartphone: null, noAutoSmartphone: true })
  })

  test('call log entries name both ends and the duration', async () => {
    await store.logCall(
      {
        id: 'c',
        role: 'caller',
        local: 'mara:smartphone',
        localNumber: '2025550143',
        remote: { number: '2025550100', device: 'npc:h' },
        phase: 'ended',
        createdAt: 0,
        startedAt: 1000,
        endedAt: 43_000,
        end: 'hangup',
        muted: false,
        remoteMuted: false,
        lines: [],
        peerUserId: 'gm',
      },
      'answered'
    )
    expect(flag(messages[0])).toMatchObject({ type: 'call', outcome: 'answered', duration: 42, state: 'delivered' })
    expect((messages[0] as any).whisper.sort()).toEqual(['gm', 'p1'])
  })
})
