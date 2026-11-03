/**
 * Drives the Foundry glue of the wounds feature against small fakes of the Foundry API: an actor that
 * stores updates and statuses, chat messages, fixed dice, the real Handlebars templates and the real
 * language file (so a missing translation key shows up as a raw "GURPS.agency..." string).
 */
import { readFileSync } from 'node:fs'
import Handlebars from 'handlebars'

const lang = JSON.parse(readFileSync('lang/agency/en-wounds.json', 'utf8'))
const upstreamKeys: Record<string, string> = {
  'GURPS.attributesHT': 'HT',
  'GURPS.status.tired': 'Tired',
  'GURPS.normal': 'Normal',
  'EFFECT.StatusUnconscious': 'Unconscious',
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
  if (upstreamKeys[key]) return upstreamKeys[key]
  const value = getProperty(lang, key)
  return typeof value === 'string' ? value : key
}

function format(key: string, data: Record<string, unknown>): string {
  return localize(key).replace(/\{(\w+)\}/g, (_, k) => String(data[k] ?? `{${k}}`))
}

const settings = new Map<string, unknown>([['gurps.agency-damage-model', 'rfh']])
let diceQueue: number[] = []
const messages = new Map<string, FakeMessage>()
let messageCount = 0

class FakeMessage {
  id: string
  content = ''
  flags: any = {}
  whisper?: string[]
  rolls?: any[]
  isAuthor = true
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

class FakeEffect {
  constructor(
    public data: any,
    private owner: FakeActor
  ) {
    Object.assign(this, data)
  }
  get name() {
    return this.data.name
  }
  getFlag(scope: string, key: string) {
    return getProperty(this.data.flags?.[scope], key)
  }
  async update(data: any) {
    Object.assign(this.data, data)
  }
  async delete() {
    this.owner.effects = this.owner.effects.filter(e => e !== this)
  }
}

class FakeActor {
  uuid = 'Actor.bob'
  id = 'bob'
  name = 'Bob'
  isOwner = true
  flags: any = {}
  statuses = new Set<string>()
  effects: FakeEffect[] = []
  replaced: string[] = []
  system: any = {
    HP: { max: 10, value: 10, points: 0 },
    FP: { max: 10, value: 10 },
    attributes: { HT: { value: 10 } },
    ads: {},
    hitlocations: {
      a: { where: 'Torso', roll: '9-10' },
      b: { where: 'Right Arm', roll: '8' },
      c: { where: 'Hand', roll: '15' },
    },
  }
  _hitLocationRolls: any = { 'Right Arm': { role: 'limb' }, Hand: { role: 'extremity' }, Torso: { role: 'chest' } }
  hitLocationsWithDR = [
    { where: 'Skull', rollText: '3-4' },
    { where: 'Torso', rollText: '9-10' },
    { where: 'Right Arm', rollText: '8' },
    { where: 'Hand', rollText: '15' },
    { where: 'Vitals', rollText: '-' },
  ]
  async update(data: Record<string, any>) {
    for (const [k, v] of Object.entries(data)) setProperty(this, k, v)
  }
  async toggleStatusEffect(id: string, { active }: { active: boolean }) {
    if (active) this.statuses.add(id)
    else this.statuses.delete(id)
  }
  async createEmbeddedDocuments(_type: string, docs: any[]) {
    for (const d of docs) this.effects.push(new FakeEffect(d, this))
  }
  testUserPermission() {
    return true
  }
  async replaceManeuver(m: string) {
    this.replaced.push(m)
  }
}

let actor: FakeActor

const upstreamStatuses = () => [
  { id: 'stun' },
  { id: 'prone' },
  { id: 'disabled' },
  { id: 'dead' },
  { id: 'bleed' },
  { id: 'mild_pain' },
  { id: 'moderate_pain' },
  { id: 'moderate_pain2' },
  { id: 'severe_pain' },
  { id: 'terrible_pain' },
  { id: 'agony' },
  { id: 'shock1' },
  { id: 'shock2' },
  { id: 'shock3' },
  {
    id: 'shock4',
    img: 'shock4.webp',
    name: 'GURPS.shock4',
    duration: { rounds: 1 },
    changes: [{ key: 'system.conditions.self.modifiers', value: 'GURPS.modifierStatusShock4 #shock4 #dx @combatmod' }],
  },
]

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
  g.game.settings = { get: (ns: string, key: string) => settings.get(`${ns}.${key}`) }
  g.game.user = { id: 'u1', isGM: true, name: 'GM' }
  g.game.users = { activeGM: { isSelf: true }, contents: [{ id: 'u1', isGM: true }] }
  g.game.time = { worldTime: 1000 }
  g.game.messages = messages
  g.game.combat = null
  g.game.actors = { contents: [] }
  g.CONFIG = { statusEffects: upstreamStatuses(), sounds: { dice: 'dice.wav' } }
  g.ChatMessage = {
    create: async (data: any) => {
      const m = new FakeMessage(data)
      messages.set(m.id, m)
      return m
    },
    getSpeaker: () => ({}),
  }
  g.Roll = class {
    total = 0
    async evaluate() {
      this.total = diceQueue.shift() ?? 10
      return this
    }
  }
  g.fromUuid = async () => actor
  g.ui = { notifications: { warn: () => {}, info: () => {} } }
  g.canvas = { tokens: { placeables: [], controlled: [] } }
  Handlebars.registerHelper('localize', (key: string) => localize(key))
})

beforeEach(() => {
  actor = new FakeActor()
  messages.clear()
  diceQueue = []
  settings.set('gurps.agency-damage-model', 'rfh')
  settings.delete('gurps.add-shock-at-turn')
  ;(globalThis as any).game.time.worldTime = 1000
  ;(globalThis as any).CONFIG.statusEffects = upstreamStatuses()
})

async function load() {
  const effects = await import('../../module/agency/wounds/effects.js')
  const applyDamage = await import('../../module/agency/wounds/apply-damage.js')
  const chat = await import('../../module/agency/wounds/chat.js')
  const hooks = await import('../../module/agency/wounds/hooks.js')
  const sheet = await import('../../module/agency/wounds/sheet.js')
  const config = await import('../../module/agency/wounds/config.js')
  effects.registerStatuses()
  applyDamage.registerDamageHandlers()
  chat.registerChatHandlers()
  return { effects, applyDamage, chat, hooks, sheet, config }
}

function lastMessage(): FakeMessage {
  return [...messages.values()].pop() as FakeMessage
}

function cardMessage(): FakeMessage {
  return [...messages.values()].filter(m => m.flags?.gurps?.agency?.woundsCard).pop() as FakeMessage
}

function expectTranslated(html: string) {
  expect(html).not.toMatch(/GURPS\.agency/)
  expect(html).not.toMatch(/\{\w+\}/)
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    injury: 5,
    maxHP: 10,
    location: 'Right Arm',
    role: 'limb',
    damageType: 'cut',
    emergency: true,
    created: 1000,
    ...overrides,
  }
}

describe('registerStatuses', () => {
  it('adds shock 5-7, unconscious, half Move and the wound indicators', async () => {
    await load()
    const ids = (globalThis as any).CONFIG.statusEffects.map((s: any) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining(['shock5', 'shock6', 'shock7', 'unconscious', 'agency-halfmove', 'agency-wound-major'])
    )
    const shock6 = (globalThis as any).CONFIG.statusEffects.find((s: any) => s.id === 'shock6')
    expect(shock6.changes[0].value).toBe('-6 to IQ/DX checks (Shock 6) #shock6 #dx @combatmod')
    expect(shock6.name).toBe('Shock 6')
    expect(shock6.duration).toEqual({ rounds: 1 })
  })
})

describe('recording wounds', () => {
  it('records a Major arm wound, sets indicators, and posts a card with its checks', async () => {
    const { applyDamage, config } = await load()
    await applyDamage.recordWoundsOp({ actorUuid: actor.uuid, inputs: [input()], publicly: true })

    const state = config.readState(actor)
    expect(state.wounds).toHaveLength(1)
    expect(state.wounds[0]).toMatchObject({ severity: 'major', location: 'Right Arm', limbKey: 'Right Arm' })
    expect(state.shock?.amount).toBe(4)
    expect([...actor.statuses].sort()).toEqual(['agency-wound-major', 'bleed'])

    const message = cardMessage()
    expect(message.whisper).toBeUndefined()
    const card = message.flags.gurps.agency.woundsCard
    expect(card.checks.map((c: any) => c.kind)).toEqual(['stun', 'impairment', 'limbMajor'])
    expectTranslated(message.content)
    expect(message.content).toContain('Knockdown &amp; stun')
    expect(message.content).toContain('Major wound: Right Arm (cut, 5 injury)')
    expect(message.content).toContain('Bleeding: 1 FP per 10 minutes')
    expect(message.content).toContain('Shock -4 on the next turn (not in combat, so not applied)')
    expect(message.content).toContain('HT 10 \u22122 wound &#x3D; 8')
  })

  it('whispers to owners and GMs when applied secretly', async () => {
    const { applyDamage } = await load()
    await applyDamage.recordWoundsOp({ actorUuid: actor.uuid, inputs: [input()], publicly: false })
    expect(cardMessage().whisper).toEqual(['u1'])
  })

  it('applies shock immediately when upstream is set to add shock immediately, less any pain', async () => {
    const { applyDamage, config } = await load()
    settings.set('gurps.add-shock-at-turn', 'Immediately')
    await config.writeState(actor, {
      ...config.readState(actor),
      pain: { level: 'moderate', expiresAt: 5000, halfMove: false },
    })
    await applyDamage.recordWoundsOp({
      actorUuid: actor.uuid,
      inputs: [input({ injury: 10, location: 'Torso', role: 'chest' })],
      publicly: true,
    })
    expect(actor.statuses.has('shock3')).toBe(true)
    expect(cardMessage().content).toContain('Shock -5 (applied now; only -3 more than the current pain)')
  })

  it('kills outright and rolls nothing for a Massive head wound', async () => {
    const { applyDamage } = await load()
    await applyDamage.recordWoundsOp({
      actorUuid: actor.uuid,
      inputs: [input({ injury: 20, location: 'Skull', role: null })],
      publicly: true,
    })
    expect(actor.statuses.has('dead')).toBe(true)
    const message = cardMessage()
    expect(message.flags.gurps.agency.woundsCard.checks).toEqual([])
    expect(message.content).toContain('Head destroyed: dead')
    expectTranslated(message.content)
  })

  it('merges stun checks from several wounds in one application', async () => {
    const { applyDamage } = await load()
    await applyDamage.recordWoundsOp({
      actorUuid: actor.uuid,
      inputs: [
        input({ injury: 2, location: 'Torso', role: 'chest' }),
        input({ injury: 5, location: 'Torso', role: 'chest' }),
      ],
      publicly: true,
    })
    const kinds = cardMessage().flags.gurps.agency.woundsCard.checks.map((c: any) => c.kind)
    expect(kinds.filter((k: string) => k === 'stun')).toHaveLength(1)
  })
})

describe('resolving checks from the card', () => {
  async function woundCard() {
    const mods = await load()
    await mods.applyDamage.recordWoundsOp({ actorUuid: actor.uuid, inputs: [input()], publicly: true })
    const message = cardMessage()
    const card = message.flags.gurps.agency.woundsCard
    const checkId = (kind: string) => card.checks.find((c: any) => c.kind === kind).id
    return { ...mods, message, checkId }
  }

  it('knocks the victim out on a stun check failed by 5', async () => {
    const { chat, message, checkId } = await woundCard()
    await chat.resolveCheckOp({ messageId: message.id, checkId: checkId('stun'), total: 13, roller: 'GM' })
    expect(actor.statuses.has('unconscious')).toBe(true)
    expect(actor.statuses.has('prone')).toBe(true)
    expect(message.content).toContain('Rolled 13 vs 8: Knocked unconscious')
    expect(message.content).not.toContain(`data-agency-wounds-check='${checkId('stun')}'`)
    expectTranslated(message.content)
  })

  it('ignores a second resolution of the same check', async () => {
    const { chat, message, checkId } = await woundCard()
    await chat.resolveCheckOp({ messageId: message.id, checkId: checkId('stun'), total: 9, roller: 'GM' })
    await chat.resolveCheckOp({ messageId: message.id, checkId: checkId('stun'), total: 18, roller: 'GM' })
    expect(actor.statuses.has('unconscious')).toBe(false)
    expect(message.flags.gurps.agency.woundsCard.results).toHaveLength(1)
  })

  it('puts the victim in pain, halves Move and Dodge, and lets the pain wear off', async () => {
    const { chat, hooks, config, message, checkId } = await woundCard()
    await chat.resolveCheckOp({ messageId: message.id, checkId: checkId('impairment'), total: 12, roller: 'GM' })
    expect(actor.statuses.has('severe_pain')).toBe(true)
    expect(actor.statuses.has('agency-halfmove')).toBe(true)
    expect(config.readState(actor).pain).toEqual({ level: 'severe', expiresAt: 1000 + 3 * 60, halfMove: true })
    expect(message.content).toContain('Severe Pain for 3 min, half Move and Dodge')
    ;(globalThis as any).game.actors.contents = [actor]
    await hooks.onUpdateWorldTime(1000 + 179)
    expect(actor.statuses.has('severe_pain')).toBe(true)
    await hooks.onUpdateWorldTime(1000 + 180)
    expect(actor.statuses.has('severe_pain')).toBe(false)
    expect(config.readState(actor).pain).toBeNull()
    // The Major wound is to an arm, so nothing else halves Move.
    expect(actor.statuses.has('agency-halfmove')).toBe(false)
  })

  it('uses the High Pain Threshold pain status', async () => {
    actor.system.ads = { x: { name: 'High Pain Threshold' } }
    const { chat, message, checkId } = await woundCard()
    expect(message.content).toContain('+2 High Pain Threshold')
    await chat.resolveCheckOp({ messageId: message.id, checkId: checkId('impairment'), total: 13, roller: 'GM' })
    expect(actor.statuses.has('moderate_pain')).toBe(true)
  })

  it('cripples the limb on a failed trauma check', async () => {
    const { chat, config, message, checkId } = await woundCard()
    await chat.resolveCheckOp({ messageId: message.id, checkId: checkId('limbMajor'), total: 9, roller: 'GM' })
    expect(config.readState(actor).limbs).toEqual([
      { key: 'Right Arm', leg: false, crippled: true, dismembered: false },
    ])
    expect(message.content).toContain('Right Arm is crippled')
  })

  it('rolls dice and asks the GM when a non-owner clicks', async () => {
    const { chat, message, checkId } = await woundCard()
    const g = globalThis as any
    const emitted: any[] = []
    g.game.socket = { emit: (_: string, data: any) => emitted.push(data) }
    g.game.user = { id: 'u2', isGM: false, name: 'Player' }
    actor.isOwner = false
    diceQueue = [11]
    const listeners: Record<string, () => void> = {}
    const button: any = {
      dataset: { agencyWoundsCheck: checkId('stun') },
      disabled: false,
      addEventListener: (_: string, fn: any) => (listeners.click = () => fn({ preventDefault() {} })),
    }
    const root: any = { querySelectorAll: () => [button] }
    chat.onRenderChatMessage(message, [root])
    listeners.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    g.game.user = { id: 'u1', isGM: true, name: 'GM' }

    expect(button.disabled).toBe(true)
    const roll = lastMessage()
    expect(roll.rolls).toHaveLength(1)
    expect(roll.content).toContain('Rolled 11 vs 8: failed by 3')
    expect(emitted).toEqual([
      {
        type: 'agencyWounds',
        op: 'resolveCheck',
        payload: { messageId: message.id, checkId: checkId('stun'), total: 11, roller: 'Player' },
      },
    ])
    expect(actor.statuses.has('stun')).toBe(false)
  })
})

describe('apply damage hand-off', () => {
  function calculator(overrides: Record<string, unknown> = {}) {
    const injuries: Record<string, number> = { Skull: 1, Torso: 3, 'Right Arm': 3, Hand: 3 }
    const calc: any = {
      damageType: 'cut',
      resourceType: 'HP',
      hitLocation: 'Right Arm',
      get hitLocationRole() {
        return actor._hitLocationRolls[this.hitLocation]?.role ?? null
      },
      isExplosion: false,
      isInjuryTolerance: false,
      ...overrides,
    }
    calc.calculators = [
      {
        _parent: calc,
        // Upstream caps limb injury at HP/2 + 1 for crippling; RFH uses the uncapped value.
        get unmodifiedPointsToApply() {
          return calc.hitLocation === 'Large-Area' ? 0 : (injuries[calc.hitLocation] ?? 12)
        },
        pointsToApply: 6,
      },
    ]
    return calc
  }

  function dialog(calc: any) {
    return {
      _calculator: calc,
      actor,
      closed: false,
      close() {
        this.closed = true
      },
    }
  }

  it('leaves standard damage to upstream', async () => {
    const { applyDamage } = await load()
    settings.set('gurps.agency-damage-model', 'standard')
    expect(
      await applyDamage.handleAgencyInjury(dialog(calculator()), {
        keepOpen: false,
        injury: 6,
        publicly: true,
        fromCalculator: true,
      })
    ).toBe(false)
  })

  it('leaves damage to other resources to upstream', async () => {
    const { applyDamage } = await load()
    expect(
      await applyDamage.handleAgencyInjury(dialog(calculator({ resourceType: 'FP' })), {
        keepOpen: false,
        injury: 6,
        publicly: true,
        fromCalculator: true,
      })
    ).toBe(false)
  })

  it('records an uncapped wound and closes the dialog', async () => {
    const { applyDamage, config } = await load()
    const d = dialog(calculator({ hitLocation: 'Torso' }))
    // Torso injury 3 on 10 HP: Moderate.
    expect(
      await applyDamage.handleAgencyInjury(d, { keepOpen: false, injury: 3, publicly: true, fromCalculator: true })
    ).toBe(true)
    expect(d.closed).toBe(true)
    expect(config.readState(actor).wounds.map(w => w.severity)).toEqual(['moderate'])
  })

  it('does not cap limb injury the way upstream crippling does', async () => {
    const { applyDamage, config } = await load()
    const calc = calculator({ hitLocation: 'Right Arm' })
    calc.calculators[0] = { _parent: calc, unmodifiedPointsToApply: 12, pointsToApply: 6 }
    await applyDamage.handleAgencyInjury(dialog(calc), {
      keepOpen: true,
      injury: 6,
      publicly: true,
      fromCalculator: true,
    })
    expect(config.readState(actor).wounds[0].severity).toBe('critical')
  })

  it('applies a large-area injury to every surface location, with reductions', async () => {
    const { applyDamage, config } = await load()
    const calc = calculator({ hitLocation: 'Large-Area' })
    await applyDamage.handleAgencyInjury(dialog(calc), {
      keepOpen: true,
      injury: 3,
      publicly: true,
      fromCalculator: true,
    })
    expect(calc.hitLocation).toBe('Large-Area')
    const wounds = config.readState(actor).wounds.map(w => `${w.location}:${w.severity}`)
    // Skull 1 (Scratch, -1 -> gone), Torso 3 (Moderate), Right Arm 3 (Moderate -1 -> Minor), Hand 3 (Moderate -2 -> Scratch).
    expect(wounds).toEqual(['Torso:moderate', 'Right Arm:minor', 'Hand:scratch'])
    expect(cardMessage().content).toContain('1 other location(s) unhurt')
  })

  it('undoes the B380 diffuse cap so RFH can cap the wound at Minor instead', async () => {
    const { applyDamage } = await load()
    const parent = {
      isInjuryTolerance: true,
      injuryToleranceType: 'diffuse',
      totalWoundingModifier: 1.5,
      _damageReductionLevel: null,
    }
    expect(applyDamage.rfhInjury({ _parent: parent, penetratingDamage: 8, unmodifiedPointsToApply: 2 })).toBe(12)
    expect(
      applyDamage.rfhInjury({
        _parent: { ...parent, _damageReductionLevel: 2 },
        penetratingDamage: 8,
        unmodifiedPointsToApply: 2,
      })
    ).toBe(6)
    expect(applyDamage.rfhInjury({ _parent: parent, penetratingDamage: 0, unmodifiedPointsToApply: 1 })).toBe(1)
    expect(
      applyDamage.rfhInjury({ _parent: { isInjuryTolerance: false }, penetratingDamage: 8, unmodifiedPointsToApply: 9 })
    ).toBe(9)
  })

  it('turns fatigue-type damage into FP by severity', async () => {
    const { applyDamage, config } = await load()
    const calc = calculator({ damageType: 'fat', resourceType: 'FP', hitLocation: 'Torso' })
    await applyDamage.handleAgencyInjury(dialog(calc), {
      keepOpen: true,
      injury: 3,
      publicly: true,
      fromCalculator: true,
    })
    expect(actor.system.FP.value).toBe(8)
    expect(config.readState(actor).wounds).toEqual([])
    expect(cardMessage().content).toContain('Moderate: 3 injury costs 2 FP')
  })
})

describe('fatigue', () => {
  it('calls for the HT check at -1 x FP and resolves it', async () => {
    const { hooks, chat } = await load()
    const options: any = {}
    hooks.onPreUpdateActor(actor, { 'system.FP.value': -10 }, options)
    await actor.update({ 'system.FP.value': -10 })
    await hooks.onUpdateActor(actor, { system: { FP: { value: -10 } } }, options, 'u1')
    const message = cardMessage()
    const card = message.flags.gurps.agency.woundsCard
    expect(card.checks.map((c: any) => c.kind)).toEqual(['fatigue'])
    expectTranslated(message.content)
    expect(message.content).toContain('Exhaustion at -1 x FP')
    await chat.resolveCheckOp({ messageId: message.id, checkId: card.checks[0].id, total: 12, roller: 'GM' })
    expect(actor.statuses.has('unconscious')).toBe(true)
    expect(actor.statuses.has('dead')).toBe(false)
  })

  it('asks for an HT roll to act at the start of a turn at 0 FP', async () => {
    const { hooks, chat } = await load()
    actor.system.FP.value = 0
    const combat = { id: 'c1', round: 2, turn: 0 }
    await hooks.onTurnStart(combat, { id: 'x', actor })
    await hooks.onTurnStart(combat, { id: 'x', actor })
    const cards = [...messages.values()].filter(m => m.flags?.gurps?.agency?.woundsCard)
    expect(cards).toHaveLength(1)
    const card = cards[0].flags.gurps.agency.woundsCard
    await chat.resolveCheckOp({ messageId: cards[0].id, checkId: card.checks[0].id, total: 11, roller: 'GM' })
    expect(actor.replaced).toEqual(['do_nothing'])
  })

  it('shows RFH FP conditions on the sheet trackers', async () => {
    const { hooks } = await load()
    Handlebars.registerHelper('hpFpCondition', () => 'upstream')
    Handlebars.registerHelper('hpFpBreakpoints', () => 'upstream')
    hooks.overrideFatigueHelpers()
    const template = Handlebars.compile(
      "{{hpFpCondition 'FP' fp 'label'}}|{{hpFpCondition 'HP' fp 'label'}}|{{#hpFpBreakpoints 'FP' fp}}[{{breakpoint}} {{label}} {{style}}]{{/hpFpBreakpoints}}"
    )
    expect(template({ fp: { value: -10, max: 10 } })).toBe(
      'GURPS.agency.wounds.fp.checks|upstream|[3 Tired ][0 HT to act ][-10 HT check selected][-15 HT check ][-20 HT check (\u22125) ][-25 HT check (\u22125) ][-30 HT check (\u221210) ]'
    )
    settings.set('gurps.agency-damage-model', 'standard')
    expect(template({ fp: { value: -10, max: 10 } })).toBe('upstream|upstream|upstream')
  })
})

describe('sheet panel and summary', () => {
  it('renders the panel and the GCS summary from the agencyWounds helper', async () => {
    const { applyDamage, sheet } = await load()
    sheet.registerHelpers()
    await applyDamage.recordWoundsOp({
      actorUuid: actor.uuid,
      inputs: [input(), input({ injury: 3, location: 'Torso', role: 'chest' })],
      publicly: true,
    })
    const panel = Handlebars.compile(readFileSync('templates/agency/wounds-panel.hbs', 'utf8'))({ actor })
    expectTranslated(panel)
    expect(panel).toContain('data-agency-wounds-panel')
    expect(panel).toContain('Right Arm')
    expect(panel).toContain("data-wounds-action='bleed'")
    expect(panel).toContain("data-wounds-action='bandage'")
    expect(panel).not.toContain("data-wounds-action='stabilize'")
    expect(panel).toContain("data-wounds-action='edit'")
    expect(panel).toContain('next trauma check -1 wound(s)')

    const summary = Handlebars.compile(readFileSync('templates/agency/wounds-summary.hbs', 'utf8'))({ actor })
    expectTranslated(summary)
    expect(summary).toContain('agency-sev-major')
    expect(summary).toContain('2 wound(s)')
  })

  it('renders nothing when the standard damage model is on', async () => {
    const { sheet } = await load()
    sheet.registerHelpers()
    settings.set('gurps.agency-damage-model', 'standard')
    const panel = Handlebars.compile(readFileSync('templates/agency/wounds-panel.hbs', 'utf8'))({ actor })
    expect(panel.trim()).toBe('')
  })

  it('hides treatment buttons from non-owners', async () => {
    const { sheet } = await load()
    sheet.registerHelpers()
    actor.isOwner = false
    ;(globalThis as any).game.user = { id: 'u2', isGM: false, name: 'Player' }
    const view: any = sheet.woundsView({ actor })
    ;(globalThis as any).game.user = { id: 'u1', isGM: true, name: 'GM' }
    expect(view.canAct).toBe(false)
    expect(view.isGM).toBe(false)
  })
})
