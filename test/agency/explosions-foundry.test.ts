/**
 * Drives the explosion feature's Foundry glue against small fakes: a scene with tokens, chat messages,
 * the real Handlebars templates and the real language file (so a missing translation key shows up as a
 * raw "GURPS.agency..." string), and a stand-in for upstream's ApplyDamageDialog that records what the
 * damage calculator would be asked to apply.
 */
import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import Handlebars from 'handlebars'
import { seededRng } from '../../module/agency/explosions/dice.ts'

const lang = JSON.parse(readFileSync('lang/agency/en-explosions.json', 'utf8'))
const upstream: Record<string, string> = {
  'GURPS.modifiers_.dodgeAndDrop': 'to Dodge (Dodge and Drop)',
}

function getProperty(object: any, path: string): any {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), object)
}
function setProperty(object: any, path: string, value: any): void {
  const keys = path.split('.')
  let o = object
  for (const k of keys.slice(0, -1)) o = o[k] ??= {}
  o[keys[keys.length - 1]] = value
}
function localize(key: string): string {
  if (upstream[key]) return upstream[key]
  const value = getProperty(lang, key)
  return typeof value === 'string' ? value : key
}
function format(key: string, data: Record<string, unknown>): string {
  return localize(key).replace(/\{(\w+)\}/g, (_, k) => String(data[k] ?? `{${k}}`))
}

/* ---------------- fakes ---------------- */

const messages = new Map<string, FakeMessage>()
let messageCount = 0
class FakeMessage {
  id: string
  content = ''
  flags: any = {}
  whisper?: string[]
  constructor(data: any) {
    Object.assign(this, data)
    this.id = `m${++messageCount}`
  }
  getFlag(scope: string, key: string) {
    return getProperty(this.flags?.[scope], key)
  }
  async update(data: Record<string, any>) {
    for (const [k, v] of Object.entries(data)) setProperty(this, k, v)
  }
}

class FakeActor {
  statuses = new Set<string>()
  system: any
  hitLocationsWithDR = [
    { where: 'Skull', roll: [3, 4], dr: 2 },
    { where: 'Face', roll: [5], dr: 0 },
    { where: 'Right Leg', roll: [6, 7], dr: 0 },
    { where: 'Right Arm', roll: [8], dr: 0 },
    { where: 'Torso', roll: [9, 10], dr: 12 },
    { where: 'Groin', roll: [11], dr: 12 },
    { where: 'Left Arm', roll: [12], dr: 0 },
    { where: 'Left Leg', roll: [13, 14], dr: 0 },
    { where: 'Hand', roll: [15], dr: 0 },
    { where: 'Foot', roll: [16], dr: 0 },
    { where: 'Neck', roll: [17, 18], dr: 0 },
  ]
  constructor(
    public id: string,
    public name: string,
    public owners: string[],
    extra: any = {}
  ) {
    this.system = {
      attributes: { ST: { value: 10 }, HT: { value: 11 } },
      HP: { max: 11 },
      traits: { sizemod: 0 },
      ads: extra.ads ?? {},
    }
  }
  testUserPermission(user: any) {
    return this.owners.includes(user.id)
  }
  async toggleStatusEffect(id: string, { active }: { active: boolean }) {
    if (active) this.statuses.add(id)
    else this.statuses.delete(id)
  }
}

class FakeToken {
  parent: any
  texture = { src: 'token.webp' }
  updates: any[] = []
  flags: any = {}
  constructor(
    public id: string,
    public name: string,
    public actor: FakeActor,
    public x: number,
    public y: number,
    public width = 1,
    public height = 1
  ) {}
  getFlag(scope: string, key: string) {
    return getProperty(this.flags?.[scope], key)
  }
  async update(data: any) {
    this.updates.push(data)
    Object.assign(this, data)
  }
}

const templates: any[] = []
function makeScene(tokens: FakeToken[]) {
  const scene: any = {
    id: 'scene1',
    name: 'Warehouse',
    grid: { size: 100, distance: 1, units: 'yd' },
    tokens: Object.assign(tokens, { get: (id: string) => tokens.find(t => t.id === id) }),
    templates: { get: (id: string) => templates.find(t => t.id === id) },
    createEmbeddedDocuments: async (_type: string, data: any[]) => {
      const created = data.map((d, i) => ({ ...d, id: `t${templates.length + i + 1}` }))
      templates.push(...created)
      return created
    },
    deleteEmbeddedDocuments: async (_type: string, ids: string[]) => {
      for (const id of ids)
        templates.splice(
          templates.findIndex(t => t.id === id),
          1
        )
    },
  }
  for (const t of tokens) t.parent = scene
  return scene
}

/* ---------------- ApplyDamageDialog stand-in ---------------- */

const applied: any[] = []
class FakeDialog {
  _calculator: any
  constructor(
    public actor: any,
    data: any[]
  ) {
    const payload = data[0]
    this._calculator = {
      hitLocation: payload.hitlocation,
      woundingModifier: payload.hitlocation === 'Vitals' ? 1 : 1,
      additionalWoundModifier: 0,
      userEnteredDR: null,
      get pointsToApply() {
        return payload.damage
      },
      payload,
    }
  }
  async resolveInjury(keepOpen: boolean, injury: number, publicly: boolean, results: any) {
    applied.push({
      actor: this.actor.name,
      location: this._calculator.hitLocation,
      damage: this._calculator.payload.damage,
      type: this._calculator.payload.damageType,
      modifier: this._calculator.payload.damageModifier,
      armorDivisor: this._calculator.payload.armorDivisor,
      userEnteredDR: this._calculator.userEnteredDR,
      additional: this._calculator.additionalWoundModifier,
      keepOpen,
      injury,
      publicly,
      fromCalculator: results !== null,
    })
  }
}
jest.unstable_mockModule('../../module/damage/applydamage.js', () => ({ default: FakeDialog }))

/* ---------------- globals ---------------- */

const hitlocCalls: any[] = []

beforeAll(() => {
  const g = globalThis as any
  g.Handlebars = Handlebars
  g.foundry.utils = {
    getProperty,
    setProperty,
    deepClone: (o: any) => JSON.parse(JSON.stringify(o)),
    randomID: () => Math.random().toString(36).slice(2, 12),
  }
  g.foundry.applications.handlebars = {
    renderTemplate: async (path: string, data: any) =>
      Handlebars.compile(readFileSync(path.replace('systems/gurps/', ''), 'utf8'))(data),
  }
  g.game.i18n = { localize, format }
  g.game.settings = { get: () => undefined }
  g.game.user = { id: 'gm', isGM: true, name: 'GM', targets: new Set() }
  g.game.users = {
    activeGM: { id: 'gm' },
    contents: [
      { id: 'gm', isGM: true, active: true },
      { id: 'p1', isGM: false, active: true },
    ],
  }
  g.game.messages = messages
  g.game.actors = { get: () => null }
  g.game.combats = { active: null }
  g.ChatMessage = {
    create: async (data: any) => {
      const m = new FakeMessage(data)
      messages.set(m.id, m)
      return m
    },
    getSpeaker: () => ({}),
  }
  g.CONFIG = { Dice: { randomUniform: seededRng(1234) } }
  g.ui = { notifications: { warn: jest.fn(), info: jest.fn() } }
  g.canvas = { scene: null, grid: null }
  g.GURPS.agency = {
    hitloc: {
      // The hit-location feature's roller, as this feature calls it.
      rollLocation: async (args: any) => {
        hitlocCalls.push(args)
        return { location: 'Torso' }
      },
    },
  }
  Handlebars.registerHelper('localize', (key: string, options: any) =>
    options?.hash && Object.keys(options.hash).length ? format(key, options.hash) : localize(key)
  )
})

beforeEach(() => {
  messages.clear()
  templates.length = 0
  applied.length = 0
  hitlocCalls.length = 0
})

function rawKeys(html: string): string[] {
  return html.match(/GURPS\.agency\.[a-zA-Z.]+/g) ?? []
}

function request(over: any = {}) {
  return {
    id: 'blast1',
    sceneId: 'scene1',
    center: { x: 550, y: 550 },
    label: 'M67',
    damage: '9d [2d] cr ex',
    weaponName: 'M67',
    notes: '',
    attacker: { sceneId: 'scene1', tokenId: 'thrower', actorId: 'a-thrower', name: 'Thrower' },
    struckTokenId: null,
    options: { environment: 'normal', enclosed: 1, airburst: false, contact: false, internal: false, atTarget: false },
    scatter: null,
    contactTokenId: null,
    internalTokenId: null,
    userId: 'gm',
    ...over,
  }
}

describe('detonate on a scene', () => {
  test('finds tokens by distance, rolls them, places templates, posts the GM card and player prompts', async () => {
    const hero = new FakeActor('a-hero', 'Hero', ['p1'])
    const goon = new FakeActor('a-goon', 'Goon', [])
    const far = new FakeActor('a-far', 'Far', [])
    const thrower = new FakeActor('a-thrower', 'Thrower', ['p1'])
    const tokens = [
      new FakeToken('hero', 'Hero', hero, 600, 500), // 1 yd from (550,550)
      new FakeToken('goon', 'Goon', goon, 800, 500), // 3 yd
      new FakeToken('far', 'Far', far, 5000, 500), // 45 yd: out of reach
      new FakeToken('thrower', 'Thrower', thrower, 1500, 500), // 10 yd: in the blast (18)
    ]
    const scene = makeScene(tokens)
    ;(globalThis as any).game.scenes = { get: (id: string) => (id === 'scene1' ? scene : null) }

    const { detonate } = await import('../../module/agency/explosions/detonate.ts')
    await detonate(request() as any)

    // Templates: blast 18 yd, fragments 10 yd.
    expect(templates.map(t => [t.t, t.distance])).toEqual([
      ['circle', 18],
      ['circle', 10],
    ])

    const all = [...messages.values()]
    const card = all.find(m => m.flags.gurps.agency.explosion.kind === 'blast')!
    expect(card.whisper).toEqual(['gm'])
    const flag = card.flags.gurps.agency.explosion
    expect(flag.state.rows.map((r: any) => [r.facts.id, r.facts.distance])).toEqual([
      ['hero', 1],
      ['goon', 3],
      ['thrower', 10],
    ])
    // Players are prompted; the NPC is the GM's call. Everyone caught starts "pending".
    expect(flag.state.rows.every((r: any) => r.dive.status === 'pending')).toBe(true)
    const prompts = all.filter(m => m.flags.gurps.agency.explosion.kind === 'dive-prompt')
    expect(prompts.map(m => m.flags.gurps.agency.explosion.tokenId).sort()).toEqual(['hero', 'thrower'])
    expect(prompts[0].whisper).toEqual(['p1', 'gm'])
    expect(Object.keys(card.flags.gurps.agency.explosion.prompts).sort()).toEqual(['hero', 'thrower'])
    // The hero is within a step: he may smother it.
    const heroPrompt = prompts.find(m => m.flags.gurps.agency.explosion.tokenId === 'hero')!
    expect(heroPrompt.flags.gurps.agency.explosion.canSmother).toBe(true)

    expect(rawKeys(card.content)).toEqual([])
    expect(card.content).toContain('Hero')
    // B400: torso DR 12, least protected location DR 0 -> 6.
    expect(flag.state.rows[0].facts.largeAreaDR).toBe(6)
    expect(card.content).toContain('vs DR 6')
    expect(card.content).toContain('data-boom-action="apply-all"'.replace(/"/g, "'"))
    for (const p of prompts) expect(rawKeys(p.content)).toEqual([])

    // Fragment locations come from the hit-location feature when it's loaded.
    const fragHits = flag.state.rows.reduce((n: number, r: any) => n + r.rolls.fragDamage.length, 0)
    expect(hitlocCalls).toHaveLength(fragHits)
    for (const call of hitlocCalls) {
      expect(call).toMatchObject({ damageType: 'cut', source: 'fragment', fromAbove: false })
      expect(call.actor).toBeInstanceOf(FakeActor)
      expect(call.token).toBeInstanceOf(FakeToken)
    }
  })

  test('a dive result updates the card and the player prompt; Apply goes through the calculator', async () => {
    const hero = new FakeActor('a-hero', 'Hero', ['p1'])
    const goon = new FakeActor('a-goon', 'Goon', [])
    const tokens = [new FakeToken('hero', 'Hero', hero, 600, 500), new FakeToken('goon', 'Goon', goon, 750, 500)]
    const scene = makeScene(tokens)
    ;(globalThis as any).game.scenes = { get: () => scene }
    const { detonate } = await import('../../module/agency/explosions/detonate.ts')
    const { applyBlastEvent, applyRows } = await import('../../module/agency/explosions/card.ts')
    const { deriveRow } = await import('../../module/agency/explosions/resolve.ts')

    await detonate(request({ damage: '6d×2 cr ex [2d]' }) as any)
    const card = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'blast')!
    const prompt = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'dive-prompt')!

    await applyBlastEvent(card.id, {
      kind: 'dive',
      tokenId: 'hero',
      status: 'success',
      margin: 2,
      coverStep: false,
      smother: true,
    })
    const flag = card.flags.gurps.agency.explosion
    expect(flag.state.contactId).toBe('hero')
    expect(prompt.flags.gurps.agency.explosion.status).toBe('success')
    expect(prompt.content).toContain('Threw self on it')
    expect(rawKeys(card.content)).toEqual([])

    // The goon is shielded by the hero's torso DR 12 + HP 11 = 23.
    const goonRow = flag.state.rows.find((r: any) => r.facts.id === 'goon')
    expect(deriveRow(flag.state, goonRow).coverDR).toBe(23)

    await applyRows(card, null)
    // The hero takes maximum blast damage (72) as a large-area injury, DR normal (B415).
    expect(applied.find(a => a.actor === 'Hero')).toMatchObject({
      location: 'Large-Area',
      damage: 72,
      type: 'cr',
      modifier: 'ex',
      armorDivisor: 0,
      keepOpen: true,
      fromCalculator: true,
    })
    expect(card.flags.gurps.agency.explosion.state.rows.find((r: any) => r.facts.id === 'hero').applied).toBe(true)
    expect(card.content).toContain('APPLIED')
  })

  test('stun grenade: HT rolls, status applied on Apply, no damage', async () => {
    const a = new FakeActor('a1', 'Alice', [], { ads: { x: { name: 'Protected Hearing' } } })
    const b = new FakeActor('a2', 'Bob', [])
    const tokens = [new FakeToken('alice', 'Alice', a, 600, 500), new FakeToken('bob', 'Bob', b, 700, 500)]
    const scene = makeScene(tokens)
    ;(globalThis as any).game.scenes = { get: () => scene }
    const { detonate } = await import('../../module/agency/explosions/detonate.ts')
    const { applyRows } = await import('../../module/agency/explosions/card.ts')
    const { deriveRow } = await import('../../module/agency/explosions/resolve.ts')

    await detonate(request({ label: 'Flashbang', weaponName: 'Flashbang', damage: 'HT-5 aff (10 yd.)' }) as any)
    const card = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'blast')!
    const flag = card.flags.gurps.agency.explosion
    expect(templates.map(t => t.distance)).toEqual([10])
    const alice = flag.state.rows.find((r: any) => r.facts.id === 'alice')
    expect(alice.facts.afflictionBonus).toBe(5)
    expect(deriveRow(flag.state, alice).affliction?.target).toBe(11)
    expect(rawKeys(card.content)).toEqual([])
    // Nobody may dive from a stun grenade's flash.
    expect(flag.state.rows.every((r: any) => r.dive.status === 'none')).toBe(true)

    await applyRows(card, null)
    expect(applied).toEqual([])
    const failed = flag.state.rows
      .filter((r: any) => !deriveRow(flag.state, r).affliction?.success)
      .map((r: any) => r.facts.id)
    for (const id of failed) expect(tokens.find(t => t.id === id)!.actor.statuses.has('stun')).toBe(true)
  })

  test('internal explosion: vitals, DR ignored, ×3', async () => {
    const host = new FakeActor('a-host', 'Host', [])
    const tokens = [new FakeToken('host', 'Host', host, 500, 500)]
    const scene = makeScene(tokens)
    ;(globalThis as any).game.scenes = { get: () => scene }
    const { detonate } = await import('../../module/agency/explosions/detonate.ts')
    const { applyRows } = await import('../../module/agency/explosions/card.ts')
    await detonate(request({ damage: '3d cr ex', internalTokenId: 'host', center: { x: 550, y: 550 } }) as any)
    const card = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'blast')!
    await applyRows(card, null)
    expect(applied[0]).toMatchObject({ location: 'Vitals', userEnteredDR: 0, additional: 2 })
  })

  test('not an explosion: warns and does nothing', async () => {
    const scene = makeScene([])
    ;(globalThis as any).game.scenes = { get: () => scene }
    const { detonate } = await import('../../module/agency/explosions/detonate.ts')
    await detonate(request({ damage: '2d+1 cut' }) as any)
    expect(messages.size).toBe(0)
  })
})

describe('prompts render', () => {
  test('incoming card, before and after', async () => {
    const { renderPrompt } = await import('../../module/agency/explosions/prompts.ts')
    const base = {
      kind: 'incoming' as const,
      request: request() as any,
      target: { sceneId: 'scene1', tokenId: 'hero', actorId: 'a', name: 'Hero' },
      attackerCenter: { x: 0, y: 0 },
      status: 'awaiting' as const,
      margin: 0,
      dropped: false,
    }
    const awaiting = await renderPrompt(base)
    expect(rawKeys(awaiting)).toEqual([])
    expect(awaiting).toContain("data-boom-action='dodge-drop'")
    const dodged = await renderPrompt({ ...base, status: 'dodged', margin: 3 })
    expect(dodged).toContain('Dodged by 3')
    expect(dodged).not.toContain('data-boom-controls')
  })
})

describe('explosive attacks', () => {
  function setupAttack(choice: string) {
    const thrower = new FakeActor('a-thrower', 'Thrower', ['p1']) as any
    const target = new FakeActor('a-target', 'Target', [])
    const throwerDoc = new FakeToken('thrower', 'Thrower', thrower, 0, 0)
    const targetDoc = new FakeToken('target', 'Target', target, 1000, 0) // 10 yd east
    const scene = makeScene([throwerDoc, targetDoc])
    const g = globalThis as any
    g.game.scenes = { get: () => scene }
    g.canvas = { scene, grid: null }
    thrower.getActiveTokens = () => [{ controlled: true, document: throwerDoc }]
    g.game.user.targets = new Set([{ id: 'target', name: 'Target', document: targetDoc, center: { x: 1050, y: 50 } }])
    g.foundry.applications.api.DialogV2 = { wait: async () => choice }
    g.GURPS.ModifierBucket = {
      addModifier: (mod: number, desc: string, list: any[]) => list.push({ mod, desc }),
      modifierStack: { modifierList: [] },
    }
    return { thrower, scene }
  }

  const grenade = { name: 'M67', damage: '9d [2d] cr ex', notes: '' }

  test('not explosive: left alone', async () => {
    setupAttack('token')
    const { beforeExplosiveAttack } = await import('../../module/agency/explosions/attack.ts')
    const opt: any = {}
    expect(
      await beforeExplosiveAttack({
        actor: {},
        action: {},
        att: { name: 'Glock', damage: '2d+2 pi' },
        opt,
        targetmods: [],
      })
    ).toBeUndefined()
    expect(opt.agencyBoom).toBeUndefined()
  })

  test('at the token: no area bonus; the defense feature is told to stay out', async () => {
    const { thrower } = setupAttack('token')
    const { beforeExplosiveAttack } = await import('../../module/agency/explosions/attack.ts')
    const opt: any = {}
    const targetmods: any[] = []
    expect(await beforeExplosiveAttack({ actor: thrower, action: {}, att: grenade, opt, targetmods })).toBeUndefined()
    expect(opt.agencyHandled).toBe(true)
    expect(opt.agencyBoom).toMatchObject({
      mode: 'token',
      targetTokenId: 'target',
      attackerTokenId: 'thrower',
      damage: '9d [2d] cr ex',
    })
    expect(targetmods).toEqual([])
  })

  test('at the ground: +4 (B414) and the range modifier to the spot (10 yd: -4, B550)', async () => {
    const { thrower } = setupAttack('ground')
    const { beforeExplosiveAttack } = await import('../../module/agency/explosions/attack.ts')
    const opt: any = {}
    const targetmods: any[] = []
    await beforeExplosiveAttack({ actor: thrower, action: {}, att: grenade, opt, targetmods })
    expect(opt.agencyBoom).toMatchObject({ mode: 'area', targetTokenId: null, point: { x: 1050, y: 50 } })
    expect(targetmods).toEqual([
      { mod: 4, desc: 'Attacking an area (B414)' },
      { mod: -4, desc: 'for range 10 yds' },
    ])
  })

  test('cancelling the choice cancels the attack', async () => {
    const { thrower } = setupAttack(null as any)
    const { beforeExplosiveAttack } = await import('../../module/agency/explosions/attack.ts')
    expect(await beforeExplosiveAttack({ actor: thrower, action: {}, att: grenade, opt: {}, targetmods: [] })).toBe(
      false
    )
  })

  async function rollWith(mode: 'token' | 'area', chat: any, failure: boolean) {
    const { thrower } = setupAttack(mode === 'token' ? 'token' : 'ground')
    const { beforeExplosiveAttack, onRollComplete } = await import('../../module/agency/explosions/attack.ts')
    const { onSocket } = await import('../../module/agency/explosions/socket.ts')
    const requests: any[] = []
    onSocket('detonate', (r: any) => requests.push(r))
    const opt: any = {}
    await beforeExplosiveAttack({ actor: thrower, action: {}, att: grenade, opt, targetmods: [] })
    await onRollComplete({ actor: thrower, optionalArgs: opt, isTargeted: true, failure, chatdata: chat })
    return requests
  }

  test('area hit: goes off on the spot', async () => {
    const requests = await rollWith('area', { margin: 2 }, false)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ center: { x: 1050, y: 50 }, struckTokenId: null, scatter: null, label: 'M67' })
  })

  test('area miss: scatters by the margin of failure, capped at half the distance (B414)', async () => {
    const requests = await rollWith('area', { margin: -9 }, true)
    expect(requests).toHaveLength(1)
    const r = requests[0]
    expect(r.scatter.yards).toBe(5) // half of 10 yd
    expect(Math.round(Math.hypot(r.center.x - 1050, r.center.y - 50))).toBe(500)
    expect(r.scatter.direction).toBeGreaterThanOrEqual(1)
    expect(r.scatter.direction).toBeLessThanOrEqual(6)
  })

  test('token hit: the target gets an Incoming card instead of an explosion', async () => {
    const requests = await rollWith('token', { margin: 3 }, false)
    expect(requests).toHaveLength(0)
    const card = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'incoming')!
    expect(card.flags.gurps.agency.explosion.request.struckTokenId).toBe('target')
    expect(rawKeys(card.content)).toEqual([])
  })

  test('token critical hit: strikes with no defense (B556)', async () => {
    const requests = await rollWith('token', { margin: 6, isCritSuccess: true }, false)
    expect(requests[0]).toMatchObject({ struckTokenId: 'target' })
  })

  test('the target dodges: it lands away by his margin of success', async () => {
    await rollWith('token', { margin: 3 }, false)
    const card = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'incoming')!
    const { onIncomingResult } = await import('../../module/agency/explosions/prompts.ts')
    await onIncomingResult({ messageId: card.id, dodged: true, margin: 2, dropped: true })
    const updated = card.flags.gurps.agency.explosion
    expect(updated.status).toBe('dodged')
    const blast = [...messages.values()].find(m => m.flags.gurps.agency.explosion.kind === 'blast')!
    const req = blast.flags.gurps.agency.explosion.request
    expect(req.struckTokenId).toBeNull()
    expect(req.scatter).toMatchObject({ yards: 2, dodged: true })
  })
})
