/**
 * Re-importing a GCS character keeps what was changed in Foundry (world setting 'agency-import-preserve', default
 * on), while changes made in GCS still come through. See module/agency/import/preserve.ts.
 */
import {
  captured,
  findEntry,
  flatten,
  getProperty,
  installImporterModuleMocks,
  loadImporter,
  MockActor,
  MockItem,
  readFixture,
  resetHarness,
  runImport,
  walk,
} from './gcs-harness.js'

installImporterModuleMocks()

let ActorImporter: any

beforeAll(async () => {
  ;({ ActorImporter } = await loadImporter())
})

beforeEach(() => resetHarness())

type Json = Record<string, any>

const FIXTURE = 'heavy-vespid.gcs'
const gcsFile = (): Json => JSON.parse(readFixture(FIXTURE))

function gcsNode(nodes: Json[], id: string): Json {
  for (const n of nodes ?? []) {
    if (n.id === id) return n
    const found = n.children && gcsNode(n.children, id)
    if (found) return found
  }
  return undefined as any
}

async function importJson(actor: MockActor, json: Json) {
  const { result } = await runImport(ActorImporter, actor, JSON.stringify(json), 'vespid.gcs')
  expect(result).toBe(true)
  expect(captured.errors).toEqual([])
  return actor.system
}

/** Dotted path of the first entry in system.<list> matching pred. */
function pathOf(actor: MockActor, list: string, pred: (e: Json) => boolean): string {
  let found: string | undefined
  walk(getProperty(actor, `system.${list}`), (e, key) => {
    if (!found && pred(e)) found = `system.${list}.${key}`
  })
  if (!found) throw new Error(`no entry in ${list}`)
  return found
}
const byName = (name: string) => (e: Json) => e.name === name
const at = (actor: MockActor, path: string) => getProperty(actor, path)

function removeAt(actor: MockActor, path: string): Json {
  const parent = at(actor, path.slice(0, path.lastIndexOf('.')))
  const key = path.slice(path.lastIndexOf('.') + 1)
  const entry = parent[key]
  delete parent[key]
  return entry
}

function putInto(container: Json, entry: Json) {
  ;(globalThis as any).GURPS.put(container, entry)
}

const named = (list: Json, name: string) => findEntry(list, e => e.name === name)
const userEquipment = (name: string, uuid: string, parentuuid = '', extra: Json = {}) => ({
  name,
  uuid,
  parentuuid,
  save: true,
  count: 1,
  cost: 0,
  weight: 0.1,
  carried: true,
  equipped: true,
  contains: {},
  collapsed: {},
  ...extra,
})

const AGENCY_FLAGS = {
  gurps: { agency: { wounds: { injuries: [3, 5] }, sanity: { episodes: 2 } } },
  core: { sheetClass: 'x' },
}
const SANITY = { value: 42, max: 60, notes: 'kept by the sanity feature' }

/** Import the fixture, then make the edits a player would make in Foundry. */
async function importAndEdit(actor = new MockActor()) {
  actor.flags = structuredClone(AGENCY_FLAGS)
  actor.system.sanity = structuredClone(SANITY)
  await importJson(actor, gcsFile())
  const s = actor.system

  // Play state on equipment
  at(actor, pathOf(actor, 'equipment.carried', byName("Traveler's Rations"))).count = 4
  at(actor, pathOf(actor, 'equipment.carried', byName('First Aid Kit'))).uses = 5
  at(actor, pathOf(actor, 'equipment.carried', byName('Longbow'))).equipped = false
  // Torch moved to Other Equipment; rope moved from the backpack into the pouch
  const torch = removeAt(actor, pathOf(actor, 'equipment.carried', byName('Torch')))
  putInto(s.equipment.other, { ...torch, carried: false })
  const rope = removeAt(actor, pathOf(actor, 'equipment.carried', byName('Rope, 3/8", 10 yards')))
  const pouch = at(actor, pathOf(actor, 'equipment.carried', byName('Pouch, Small')))
  putInto(pouch.contains, { ...rope, parentuuid: pouch.uuid })

  // Text added to GCS notes and names, notes rewritten, OTFs and other Foundry-only fields
  at(actor, pathOf(actor, 'skills', byName('Stealth'))).notes += ' (practice nightly)'
  at(actor, pathOf(actor, 'ads', byName('Danger Sense'))).name = 'Danger Sense (spidey)'
  at(actor, pathOf(actor, 'ads', byName('Magery 2'))).notes = 'Fire only, learned from mother'
  Object.assign(at(actor, pathOf(actor, 'skills', byName('Broadsword'))), {
    checkotf: 'Broadsword-2',
    modifierTags: 'melee, sword',
  })
  const swung = Object.values(s.melee as Json).find((m: any) => m.name === 'Broadsword' && m.mode === 'Swung')
  Object.assign(swung, { duringotf: '/anim slash', addToQuickRoll: true, consumeAction: false })
  Object.assign(
    Object.values(s.ranged as Json).find((r: any) => r.name === 'Longbow'),
    { ammo: 12 }
  )
  Object.values(s.reactions as Json)[0].modifierTags = 'reaction'

  // Entries added in Foundry
  putInto(s.ads, { name: 'Lucky Charm', notes: 'Foundry only', points: 0, uuid: '', parentuuid: '', contains: {} })
  putInto(at(actor, pathOf(actor, 'skills', byName('Combat'))).contains, {
    name: 'Hive Navigation',
    import: 12,
    type: 'SKILL',
    uuid: '',
    parentuuid: '',
    contains: {},
  })
  putInto(s.spells, { name: 'Sense Danger', import: 11, uuid: '', parentuuid: '', contains: {} })
  putInto(pouch.contains, userEquipment('Hive Token', 'GGAhivetoken0001', pouch.uuid))
  putInto(s.equipment.carried, {
    ...userEquipment('Loot Sack', 'GGAlootsack00001'),
    contains: { '00000': userEquipment('Ruby', 'GGAruby000000001', 'GGAlootsack00001', { cost: 500 }) },
  })
  putInto(s.notes, { notes: 'GM: owes the Duke', save: true, uuid: '', parentuuid: '', contains: {} })
  const log = at(
    actor,
    pathOf(actor, 'notes', e => e.notes === 'Session Log')
  )
  putInto(log.contains, { notes: 'Session 3: added in Foundry', save: true, uuid: '', parentuuid: '', contains: {} })
  putInto(s.melee, { name: 'Wing Buffet', mode: 'Swing', damage: '1d-1 cr', import: '13', uuid: '', notes: '' })
  putInto(s.ranged, { name: 'Spit', mode: '', damage: '1d tox', acc: '1', import: '12', uuid: '', notes: '' })
  putInto(s.reactions, { modifier: '+2', situation: 'from hive members' })
  putInto(s.additionalresources.tracker, { name: 'Ammo', alias: 'ammo', max: 20, value: 7 })

  // Resource pool spent in play
  Object.values(s.additionalresources.tracker as Json).find((t: any) => t.alias === 'mp').value = 6
  return actor
}

/** The same character after a session of changes in GCS. */
function editedInGcs(): Json {
  const g = gcsFile()
  Object.assign(gcsNode(g.skills, 'sAgencyFix0000019'), { points: 8, calc: { level: 15, rsl: 'DX+2' } })
  g.traits.push({
    id: 'tAgencyFix0000099',
    name: 'Fearlessness',
    levels: 2,
    points_per_level: 2,
    can_level: true,
    calc: { points: 4, level: 2 },
  })
  g.traits = g.traits.filter((t: Json) => t.name !== 'Bad Temper')
  const sword = gcsNode(g.equipment, 'eT91Kw-sURBn7M7Li')
  Object.assign(sword.calc, { value: 2400, extended_value: 2400 })
  sword.weapons[0].calc.damage = '1d+3 cut'
  Object.assign(gcsNode(g.other_equipment, 'eAgencyFix0000055'), {
    quantity: 40,
    calc: { value: 2, extended_value: 80, weight: '0.1 lb', extended_weight: '4 lb' },
  })
  Object.assign(gcsNode(g.equipment, 'eAgencyFix0000049'), { quantity: 8 })
  gcsNode(g.equipment, 'enuElHkbotKsmNZFf').equipped = false
  gcsNode(g.equipment, 'eAgencyFix0000045').quantity = 2
  gcsNode(g.skills, 'sAgencyFix0000027').local_notes = 'Silent while hovering or crawling'
  gcsNode(g.notes, 'nAgencyFix0000058').markdown = 'Session 1: found the ruined hive and its queen.'
  const purse = gcsNode(g.equipment, 'EAgencyFix0000044')
  purse.children = purse.children.filter((c: Json) => c.description !== 'Hidden Compartment')
  gcsNode(g.equipment, 'EAgencyFix0000051').children.push({
    id: 'eAgencyFix0000098',
    description: 'Grappling Hook',
    quantity: 1,
    base_value: '20',
    base_weight: '2 lb',
    calc: { value: 20, extended_value: 20, weight: '2 lb', extended_weight: '2 lb' },
  })
  Object.assign(g.attributes.find((a: Json) => a.attr_id === 'mp').calc, { value: 16, current: 16 })
  return g
}

describe('re-import keeps Foundry edits (agency-import-preserve on)', () => {
  let actor: MockActor
  let s: Json

  beforeAll(async () => {
    resetHarness()
    actor = await importAndEdit()
    actor.updates = []
    s = await importJson(actor, editedInGcs())
  })

  test('equipment play state: count, uses, equipped', () => {
    expect(named(s.equipment.carried, "Traveler's Rations").count).toBe(4) // also changed in GCS (8): Foundry's edit wins
    expect(named(s.equipment.carried, 'First Aid Kit').uses).toBe(5)
    expect(named(s.equipment.carried, 'Longbow').equipped).toBe(false)
  })

  test('equipment moved in Foundry stays where it was put', () => {
    expect(named(s.equipment.other, 'Torch')).toMatchObject({ carried: false, count: 2 })
    expect(named(s.equipment.carried, 'Torch')).toBeUndefined()
    const pouch = named(s.equipment.carried, 'Pouch, Small')
    expect(named(pouch.contains, 'Rope, 3/8", 10 yards')).toBeDefined()
    const backpackTop = Object.values(named(s.equipment.carried, 'Backpack, Frame').contains).map((e: any) => e.name)
    expect(backpackTop).not.toContain('Rope, 3/8", 10 yards')
  })

  test('notes and names: additions re-applied to the new GCS text, rewrites kept', () => {
    expect(named(s.skills, 'Stealth').notes).toBe('Silent while hovering or crawling (practice nightly)')
    expect(named(s.ads, 'Danger Sense (spidey)')).toBeDefined()
    expect(named(s.ads, 'Magery 2').notes).toBe('Fire only, learned from mother')
  })

  test('OTFs and other Foundry-only fields survive', () => {
    expect(named(s.skills, 'Broadsword')).toMatchObject({ checkotf: 'Broadsword-2', modifierTags: 'melee, sword' })
    const swung = Object.values(s.melee as Json).find((m: any) => m.name === 'Broadsword' && m.mode === 'Swung')
    expect(swung).toMatchObject({ duringotf: '/anim slash', addToQuickRoll: true, consumeAction: false })
    expect(Object.values(s.ranged as Json).find((r: any) => r.name === 'Longbow').ammo).toBe(12)
    expect(named(s.ads, 'Danger Sense (spidey)').checkotf).toBe('Per Danger Sense') // OTF from GCS vtt_notes
    expect(named(s.equipment.carried, 'First Aid Kit').duringotf).toBe('/hp +1d')
    expect(Object.values(s.reactions as Json).find((r: any) => r.situation === 'from others').modifierTags).toBe(
      'reaction'
    )
  })

  test('entries added in Foundry are kept, inside their containers', () => {
    expect(named(s.ads, 'Lucky Charm')).toMatchObject({ notes: 'Foundry only' })
    expect(named(named(s.skills, 'Combat').contains, 'Hive Navigation')).toMatchObject({ import: 12 })
    expect(named(s.spells, 'Sense Danger')).toBeDefined()
    expect(named(named(s.equipment.carried, 'Pouch, Small').contains, 'Hive Token')).toBeDefined()
    const sack = named(s.equipment.carried, 'Loot Sack')
    expect(named(sack.contains, 'Ruby')).toMatchObject({ cost: 500 })
    expect(sack.costsum).toBe(500)
    expect(findEntry(s.notes, n => n.notes === 'GM: owes the Duke')).toBeDefined()
    const log = findEntry(s.notes, n => n.notes === 'Session Log')
    expect(Object.values(log.contains).map((n: any) => n.notes)).toContain('Session 3: added in Foundry')
    expect(Object.values(s.melee as Json).map((m: any) => m.name)).toContain('Wing Buffet')
    expect(Object.values(s.ranged as Json).map((m: any) => m.name)).toContain('Spit')
    expect(Object.values(s.reactions as Json).map((r: any) => r.situation)).toContain('from hive members')
    expect(Object.values(s.additionalresources.tracker as Json).map((t: any) => t.alias)).toContain('ammo')
  })

  test('changes made in GCS come through', () => {
    expect(named(s.skills, 'Broadsword')).toMatchObject({ import: 15, points: 8, relativelevel: 'DX+2' })
    expect(named(s.ads, 'Fearlessness 2')).toBeDefined()
    expect(named(s.ads, 'Bad Temper')).toBeUndefined()
    expect(named(s.equipment.carried, 'Broadsword').cost).toBe(2400)
    const swung = Object.values(s.melee as Json).find((m: any) => m.name === 'Broadsword' && m.mode === 'Swung')
    expect(swung.damage).toBe('1d+3 cut')
    expect(named(s.equipment.other, 'Arrows')).toMatchObject({ count: 40, weightsum: 4 })
    expect(named(s.equipment.carried, 'Small Shield').equipped).toBe(false)
    expect(named(s.equipment.carried, 'Lockpicks').count).toBe(2)
    expect(findEntry(s.notes, n => n.notes.startsWith('Session 1'))!.notes).toBe(
      'Session 1: found the ruined hive and its queen.'
    )
    expect(named(s.equipment.carried, 'Hidden Compartment')).toBeUndefined()
    expect(named(s.equipment.carried, 'Folded Map')).toBeUndefined()
    expect(named(named(s.equipment.carried, 'Backpack, Frame').contains, 'Grappling Hook')).toBeDefined()
    const mana = Object.values(s.additionalresources.tracker as Json).find((t: any) => t.alias === 'mp')
    expect(mana).toMatchObject({ max: 16, value: 6 }) // new maximum from GCS, mana spent in Foundry kept
  })

  test('nothing is duplicated', () => {
    for (const list of ['ads', 'skills', 'spells', 'notes', 'melee', 'ranged', 'reactions']) {
      const all = flatten(s[list]).map(e => `${e.name ?? e.notes ?? e.situation}|${e.mode ?? ''}`)
      expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([])
    }
    const equipment = [...flatten(s.equipment.carried), ...flatten(s.equipment.other)].map(e => e.uuid)
    expect(new Set(equipment).size).toBe(equipment.length)
  })

  test('flags.* and system.sanity are untouched', () => {
    expect(actor.flags).toEqual(AGENCY_FLAGS)
    expect(actor.system.sanity).toEqual(SANITY)
    const keys = actor.updates.flatMap(u => Object.keys(u.data))
    expect(keys.filter(k => /^flags|^-=flags|^system\.(-=)?sanity|^system$|^-=system$|^system\.-=$/.test(k))).toEqual(
      []
    )
    for (const u of actor.updates) {
      expect(u.data.flags).toBeUndefined()
      expect(u.data.system?.sanity).toBeUndefined()
    }
  })

  test('importing the same file again changes nothing', async () => {
    const before = structuredClone(actor.system)
    await importJson(actor, editedInGcs())
    for (const key of [
      'ads',
      'skills',
      'spells',
      'notes',
      'equipment',
      'melee',
      'ranged',
      'reactions',
      'conditionalmods',
      'hitlocations',
    ]) {
      expect(actor.system[key]).toEqual(before[key])
    }
    expect(actor.system.additionalresources.tracker).toEqual(before.additionalresources.tracker)
  })
})

describe('re-import edge cases', () => {
  test('GCS regenerated every id (e.g. converting an older file): entries matched by name, no duplicates', async () => {
    const actor = await importAndEdit()
    const counts = (s: Json) => ['ads', 'skills', 'spells', 'notes'].map(k => flatten(s[k]).length)
    const before = counts(actor.system)
    const beforeEquipment =
      flatten(actor.system.equipment.carried).length + flatten(actor.system.equipment.other).length
    const text = readFixture(FIXTURE).replace(/"id": "(\w)AgencyFix(\d{7})"/g, '"id": "$1Regenerated$2x"')
    const s = await importJson(actor, JSON.parse(text))
    expect(counts(s)).toEqual(before)
    expect(flatten(s.equipment.carried).length + flatten(s.equipment.other).length).toBe(beforeEquipment)
    expect(named(s.equipment.carried, "Traveler's Rations")).toMatchObject({ count: 4, uuid: 'eRegenerated0000049x' })
    expect(named(s.equipment.other, 'Torch')).toBeDefined()
    expect(named(s.skills, 'Stealth').notes).toBe('Silent while hovering (practice nightly)')
    expect(named(named(s.equipment.carried, 'Pouch, Small').contains, 'Hive Token')).toBeDefined()
    expect(named(named(s.skills, 'Combat').contains, 'Hive Navigation')).toBeDefined()
  })

  test('setting off: GCS overwrites as upstream does', async () => {
    const actor = await importAndEdit()
    resetHarness({ 'agency-import-preserve': false })
    const s = await importJson(actor, gcsFile())
    expect(named(s.equipment.carried, "Traveler's Rations").count).toBe(6)
    expect(named(s.ads, 'Lucky Charm')).toBeUndefined()
    expect(named(s.skills, 'Hive Navigation')).toBeUndefined()
    expect(Object.values(s.melee as Json).map((m: any) => m.name)).not.toContain('Wing Buffet')
    expect(flatten(s.equipment.carried).some(e => e.name === 'Hive Token')).toBe(true) // upstream keeps 'save'd equipment
  })

  test('actor imported before this feature (no baselines): upstream data is matched and user rows kept', async () => {
    const actor = new MockActor()
    resetHarness({ 'agency-import-preserve': false })
    await importJson(actor, gcsFile())
    resetHarness()
    at(actor, pathOf(actor, 'equipment.carried', byName("Traveler's Rations"))).count = 4
    at(actor, pathOf(actor, 'skills', byName('Stealth'))).notes += ' (practice nightly)'
    putInto(actor.system.ads, { name: 'Lucky Charm', points: 0, uuid: '', parentuuid: '', contains: {} })
    const s = await importJson(actor, gcsFile())
    expect(named(s.equipment.carried, "Traveler's Rations").count).toBe(4) // differs from originalCount
    expect(named(s.skills, 'Stealth').notes).toBe('Silent while hovering (practice nightly)')
    expect(named(s.ads, 'Lucky Charm')).toBeDefined()
    expect(flatten(s.ads).length).toBe(19)
    expect(named(s.ads, 'Combat Reflexes').agencyImport).toBeDefined() // baselines recorded from now on
  })

  test('equipment dropped onto the actor as a Foundry Item survives re-import', async () => {
    const actor = new MockActor()
    await importJson(actor, gcsFile())
    const item = new MockItem({
      _id: 'droppedItem00001',
      type: 'equipment',
      name: 'Healing Potion',
      system: { eqt: { name: 'Healing Potion', count: 2 }, globalid: 'Item.abc' },
    })
    actor.items.push(item)
    putInto(
      actor.system.equipment.carried,
      userEquipment('Healing Potion', 'GGApotion0000001', '', { itemid: item._id, count: 2 })
    )
    putInto(actor.system.melee, {
      name: 'Healing Potion',
      mode: 'Thrown',
      itemid: item._id,
      eqtkey: 'system.equipment.carried.00008',
      uuid: 'melee-0-droppedItem00001',
    })

    const s = await importJson(actor, gcsFile())
    expect(actor.items.get('droppedItem00001')).toBeDefined()
    expect(named(s.equipment.carried, 'Healing Potion')).toMatchObject({ itemid: 'droppedItem00001', count: 2 })
    // Item-generated rows are left to postImport, which re-adds them from the Item
    expect(Object.values(s.melee as Json).some((m: any) => m.itemid)).toBe(false)
    expect(actor.postImportCalls).toBe(2)
  })

  test("'Use Foundry Items' mode: edits kept, no duplicate Items", async () => {
    resetHarness({ 'use-foundry-items': true })
    const actor = new MockActor()
    await importJson(actor, gcsFile())
    const itemCount = actor.items.length
    expect(itemCount).toBeGreaterThan(40)
    const rations = at(actor, pathOf(actor, 'equipment.carried', byName("Traveler's Rations")))
    rations.count = 4
    actor.items.get(rations.itemid)!.system.eqt.count = 4
    putInto(actor.system.skills, { name: 'Hive Navigation', import: 12, uuid: '', parentuuid: '', contains: {} })
    const s = await importJson(actor, gcsFile())
    expect(actor.items.length).toBe(itemCount)
    expect(named(s.equipment.carried, "Traveler's Rations")).toMatchObject({ count: 4, itemid: rations.itemid })
    expect(named(s.skills, 'Hive Navigation')).toBeDefined()
  })

  test('upstream (setting off) deletes such Items during the trait import', async () => {
    const actor = new MockActor()
    resetHarness({ 'agency-import-preserve': false })
    await importJson(actor, gcsFile())
    actor.items.push(
      new MockItem({ _id: 'droppedItem00001', type: 'equipment', name: 'Healing Potion', system: { eqt: {} } })
    )
    putInto(
      actor.system.equipment.carried,
      userEquipment('Healing Potion', 'GGApotion0000001', '', { itemid: 'droppedItem00001' })
    )
    await importJson(actor, gcsFile())
    expect(actor.items.get('droppedItem00001')).toBeUndefined()
  })
})
