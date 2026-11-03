/**
 * Test harness for the GCS importer (module/actor/actor-importer.js).
 *
 * Foundry can't run under jest, so this file stands in for the parts of it the importer touches:
 * game.settings / i18n / user, ui.notifications, renderTemplate, ChatMessage, DialogV2, foundry.utils,
 * GURPS.put / DamageTables, and an actor whose update() applies Foundry-style dotted-key updates
 * (including '-=' deletions and v14 _replace / _del markers) to plain JSON data.
 *
 * Usage, at the top of a test file (the module mocks have to be registered before the importer loads):
 *
 *   installImporterModuleMocks()
 *   const { ActorImporter } = await loadImporter()
 */
import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = join(here, 'fixtures')

type Json = Record<string, any>

/** Stub the UI modules lib/miscellaneous-settings.js imports; they pull in the whole sheet/combat stack. */
export function installImporterModuleMocks(): void {
  jest.unstable_mockModule('../../module/actor/actor-sheet.js', () => ({ ItemImageSettings: class {} }))
  jest.unstable_mockModule('../../module/actor/effect-modifier-popout.js', () => ({ TaggedModifierSettings: class {} }))
  jest.unstable_mockModule('../../module/modifier-bucket/select-journals.js', () => ({ default: class {} }))
  jest.unstable_mockModule('../../module/token/quick-roll-settings.js', () => ({ QuickRollSettings: class {} }))
}

export async function loadImporter() {
  const importer = await import('../../module/actor/actor-importer.js')
  const hitlocations = await import('../../module/hitlocation/hitlocation.js')
  const { DamageTable } = await import('../../module/damage/damage-tables.js')
  hitlocations.HitLocation.init()
  installGlobals()
  ;(globalThis as any).GURPS.DamageTables = new DamageTable()
  return importer
}

// ---------------------------------------------------------------------------------------------------------------
// Globals

export interface Captured {
  notifications: { level: string; message: string }[]
  chat: Json[]
  errors: string[]
  dialogs: string[]
}

export const captured: Captured = { notifications: [], chat: [], errors: [], dialogs: [] }

/** Current values returned by game.settings.get('gurps', key). */
export const settings: Record<string, unknown> = {}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'use-foundry-items': false,
  ignore_import_name: false,
  import_hp_fp: 2,
  import_bodyplan: 2,
  'overwrite-portraitsk': false,
  'use-browser-importer': false,
  'automatically-set-ignoreqty': false,
  'agency-import-preserve': true,
}

/** What DialogV2.wait resolves to (the HP/FP and body plan prompts). */
export const dialog = { answer: true as unknown }

const REPLACE = Symbol('replace')
const DEL = Symbol('del')

export function resetHarness(overrides: Record<string, unknown> = {}, generation = 13): void {
  for (const key of Object.keys(settings)) delete settings[key]
  Object.assign(settings, DEFAULT_SETTINGS, overrides)
  captured.notifications.length = 0
  captured.chat.length = 0
  captured.errors.length = 0
  captured.dialogs.length = 0
  dialog.answer = true
  ;(globalThis as any).game.release = { generation }
}

function installGlobals(): void {
  const g = globalThis as any
  g.game.settings = {
    get: (_ns: string, key: string) => settings[key],
    set: async (_ns: string, key: string, value: unknown) => (settings[key] = value),
    register: () => undefined,
  }
  g.game.i18n = {
    localize: (key: string) => key,
    format: (key: string, data: Json = {}) => `${key} ${JSON.stringify(data)}`,
  }
  g.game.user = { id: 'user1', isGM: true, hasPermission: () => true }
  g.game.release = { generation: 13 }
  g.game.system = { version: 'test' }
  g.game.items = { get: () => undefined }

  const note = (level: string) => (message: unknown) => {
    captured.notifications.push({ level, message: String(message) })
  }
  g.ui = { notifications: { error: note('error'), warn: note('warn'), info: note('info') } }
  g.renderTemplate = async (_path: string, data: Json) => JSON.stringify(data)
  g.ChatMessage = { create: async (data: Json) => captured.chat.push(data) }

  class DialogV2 {
    options: Json
    constructor(options: Json) {
      this.options = options
      captured.dialogs.push(String(options?.window?.title ?? ''))
    }
    async render() {
      return this
    }
    async close() {
      return this
    }
    static async wait(options: Json) {
      captured.dialogs.push(String(options?.window?.title ?? ''))
      return dialog.answer
    }
  }
  g.foundry.applications.api.DialogV2 = DialogV2

  g.foundry.utils = {
    getProperty,
    setProperty,
    randomID: (n = 16) =>
      Math.random()
        .toString(36)
        .slice(2, 2 + n)
        .padEnd(n, '0'),
    duplicate: (o: unknown) => JSON.parse(JSON.stringify(o)),
    deepClone: (o: unknown) => structuredClone(o),
    mergeObject: (a: Json, b: Json) => mergeInto(a, b),
  }

  g._replace = (value: unknown) => ({ [REPLACE]: true, value })
  g._del = DEL

  const zeroFill = (n: number) => String(n).padStart(5, '0')
  g.GURPS = {
    ...(g.GURPS ?? {}),
    SYSTEM_NAME: 'gurps',
    USER_GUIDE_URL: '',
    genkey: zeroFill,
    put(obj: Json, value: unknown, index = -1) {
      if (index === -1) {
        index = 0
        while (Object.prototype.hasOwnProperty.call(obj, zeroFill(index))) index++
      }
      const key = zeroFill(index)
      obj[key] = value
      return key
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Foundry-ish data helpers

export function getProperty(object: any, key: string | undefined): any {
  if (!key || object == null) return undefined
  if (key in object) return object[key]
  let target = object
  for (const part of key.split('.')) {
    if (target == null || typeof target !== 'object') return undefined
    target = target[part]
  }
  return target
}

export function setProperty(object: Json, key: string, value: unknown): void {
  const parts = key.split('.')
  const last = parts.pop()!
  let target = object
  for (const part of parts) {
    if (target[part] == null || typeof target[part] !== 'object') target[part] = {}
    target = target[part]
  }
  target[last] = value
}

const isPlainObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** JSON round trip: what Foundry actually persists (class instances become plain objects, undefined drops out). */
export function toStored<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function mergeInto(target: Json, source: Json): Json {
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('-=')) {
      delete target[key.slice(2)]
      continue
    }
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value)
    else target[key] = value
  }
  return target
}

/** Apply one Foundry update object (dotted keys, '-=' deletions, v14 markers) to a document's data. */
export function applyUpdate(doc: Json, data: Json): void {
  for (const [key, raw] of Object.entries(data)) {
    const parts = key.split('.')
    const last = parts.pop()!
    let parent = doc
    for (const part of parts) {
      if (!isPlainObject(parent[part])) parent[part] = {}
      parent = parent[part]
    }
    if (last.startsWith('-=')) {
      delete parent[last.slice(2)]
    } else if (raw === DEL) {
      delete parent[last]
    } else if (isPlainObject(raw) && (raw as any)[REPLACE]) {
      parent[last] = toStored((raw as any).value)
    } else {
      const value = toStored(raw)
      if (isPlainObject(value) && isPlainObject(parent[last])) mergeInto(parent[last], value)
      else parent[last] = value
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Actor

const templateJson = JSON.parse(readFileSync(join(here, '../../template.json'), 'utf8'))

export function blankActorSystem(): Json {
  return structuredClone(templateJson.Actor.templates.base)
}

const ITEM_SYS_KEYS: Record<string, string> = {
  equipment: 'eqt',
  feature: 'fea',
  skill: 'ski',
  spell: 'spl',
  meleeAtk: 'mel',
  rangedAtk: 'rng',
}
const ACTOR_COMPONENT_KEYS: Record<string, string> = {
  equipment: 'equipment',
  feature: 'ads',
  skill: 'skills',
  spell: 'spells',
  meleeAtk: 'melee',
  rangedAtk: 'ranged',
}

export class MockItem {
  _id: string
  id: string
  type: string
  name: string
  img: string
  system: Json
  constructor(data: Json) {
    this._id = data._id ?? `item${Math.random().toString(36).slice(2, 10)}`
    this.id = this._id
    this.type = data.type
    this.name = data.name
    this.img = data.img ?? ''
    this.system = toStored(data.system ?? {})
  }
  get itemSysKey() {
    return ITEM_SYS_KEYS[this.type]
  }
  get actorComponentKey() {
    return ACTOR_COMPONENT_KEYS[this.type]
  }
  getItemInfo() {
    return { id: this._id, img: this.img, name: this.name, system: toStored(this.system) }
  }
}

class MockItems extends Array<MockItem> {
  get(id: string) {
    return this.find(i => i._id === id)
  }
  get contents() {
    return [...this]
  }
}

export interface UpdateCall {
  data: Json
  options?: Json
}

export class MockActor {
  name: string
  system: Json
  flags: Json
  items: MockItems = new MockItems()
  img = ''
  prototypeToken: Json = { name: '' }
  ignoreRender = false
  /** Every update the importer sent, in order. */
  updates: UpdateCall[] = []
  postImportCalls = 0

  constructor(name = 'Test Actor', system: Json = blankActorSystem(), flags: Json = {}) {
    this.name = name
    this.system = system
    this.flags = flags
  }

  /** The importer's main commit: the update(s) carrying system.lastImport (two calls on v13: deletes, then adds). */
  get lastCommit(): Json {
    const idx = this.updates.findLastIndex(u => 'system.lastImport' in u.data)
    if (idx < 0) return {}
    const commit = { ...this.updates[idx].data }
    const prev = this.updates[idx - 1]
    if (prev && Object.keys(prev.data).every(k => k.includes('-='))) Object.assign(commit, prev.data)
    return commit
  }

  async update(data: Json, options?: Json) {
    this.updates.push({ data, options })
    const doc: Json = {
      name: this.name,
      system: this.system,
      flags: this.flags,
      img: this.img,
      prototypeToken: this.prototypeToken,
    }
    applyUpdate(doc, data)
    this.name = doc.name
    this.system = doc.system
    this.flags = doc.flags
    this.img = doc.img
    this.prototypeToken = doc.prototypeToken
    return this
  }

  async internalUpdate(data: Json, context?: Json) {
    return this.update(data, { ...(context ?? {}), render: false })
  }

  async postImport() {
    this.postImportCalls++
  }
  _forceRender() {}
  async refreshDR() {}
  async _addItemAdditions() {}

  async createEmbeddedDocuments(_type: string, data: Json[]) {
    const created = data.map(d => new MockItem(d))
    this.items.push(...created)
    return created
  }
  async updateEmbeddedDocuments(_type: string, updates: Json[]) {
    const result: MockItem[] = []
    for (const u of updates) {
      const item = this.items.get(u._id)
      if (!item) continue
      const { _id, ...rest } = u
      applyUpdate(item as unknown as Json, rest)
      result.push(item)
    }
    return result
  }
  async deleteEmbeddedDocuments(_type: string, ids: string[]) {
    for (const id of ids) {
      const idx = this.items.findIndex(i => i._id === id)
      if (idx >= 0) this.items.splice(idx, 1)
    }
    return ids
  }

  _findEqtkeyForId(key: string, id: unknown): string | undefined {
    let found: string | undefined
    for (const list of ['carried', 'other']) {
      walk(this.system.equipment?.[list], (e, k) => {
        if (!found && e[key] == id) found = `system.equipment.${list}.${k}`
      })
      if (found) break
    }
    return found
  }

  _findSysKeyForId(key: string, id: unknown, sysKey: string): string | undefined {
    let found: string | undefined
    walk(this.system[sysKey], (e, k) => {
      if (e[key] === id) found = `system.${sysKey}.${k}`
    })
    return found
  }
}

/** recurselist() from lib/utilities.js, for test-side lookups. */
export function walk(
  list: Json | undefined,
  fn: (e: Json, key: string, depth: number) => void,
  prefix = '',
  depth = 0
) {
  if (!list) return
  for (const [key, value] of Object.entries(list)) {
    fn(value, prefix + key, depth)
    walk(value?.contains, fn, `${prefix}${key}.contains.`, depth + 1)
    walk(value?.collapsed, fn, `${prefix}${key}.collapsed.`, depth + 1)
  }
}

/** Every entry in a contains-tree, depth first. */
export function flatten(list: Json | undefined): Json[] {
  const out: Json[] = []
  walk(list, e => out.push(e))
  return out
}

/** The first entry in a contains-tree matching pred (any, for terse test assertions; undefined if none). */
export function findEntry(list: Json | undefined, pred: (e: Json) => boolean): any {
  return flatten(list).find(pred)
}

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/**
 * Run importActorFromGCS against the actor, collecting console noise into captured.errors
 * (the importer reports caught exceptions with console.log(err.stack)).
 */
export async function runImport(ImporterClass: any, actor: MockActor, json: string, filename = 'fixture.gcs') {
  const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && /^\w*Error\b|\n\s+at /.test(first)) captured.errors.push(first)
  })
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const importer = new ImporterClass(actor)
    const result = await importer.importActorFromGCS(json, filename, `/data/${filename}`, true)
    return { result, importer }
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }
}
