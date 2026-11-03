/**
 * Importing current GCS (5.x, file "version": 5) characters with the upstream importer plus the AGENCY fixes.
 *
 * Fixtures (test/agency/fixtures):
 *  - heavy-vespid.gcs: built from gcs_master_library content (Basic Set traits and equipment, the "Hexapod, Winged"
 *    body type) in the current GCS format, with the calc blocks filled in by hand. Nested containers four deep,
 *    melee/ranged weapons whose resolved (calc) values differ from the raw ones, trait and equipment modifiers,
 *    disabled traits/skills/equipment, conditional modifiers, custom pools, notes in containers, techniques, spells
 *    with several colleges, a ritual magic spell, a container that reduces its contents' weight.
 *  - library-*.gcs: characters from gcs_master_library (trimmed of page layout/portraits), as written by GCS.
 * gcs_master_library (github.com/richardwilkes/gcs_master_library) is MPL-2.0; the fixtures derived from it are too.
 */
import {
  captured,
  dialog,
  findEntry,
  flatten,
  installImporterModuleMocks,
  loadImporter,
  MockActor,
  readFixture,
  resetHarness,
  runImport,
} from './gcs-harness.js'

installImporterModuleMocks()

let ActorImporter: any

beforeAll(async () => {
  ;({ ActorImporter } = await loadImporter())
})

beforeEach(() => resetHarness())

async function importFixture(name: string, actor = new MockActor()) {
  const { result } = await runImport(ActorImporter, actor, readFixture(name), name)
  return { actor, result, s: actor.system }
}

const named = (list: any, name: string) => findEntry(list, e => e.name === name)
const carried = (s: any) => s.equipment.carried
const allEquipment = (s: any) => [...flatten(s.equipment.carried), ...flatten(s.equipment.other)]

describe('heavy GCS 5 fixture', () => {
  let s: any
  let actor: MockActor

  beforeAll(async () => {
    resetHarness()
    ;({ actor, s } = await importFixture('heavy-vespid.gcs'))
    expect(captured.errors).toEqual([])
    expect(captured.notifications.filter(n => n.level !== 'info')).toEqual([])
  })

  test('profile, attributes and derived values', () => {
    expect(actor.name).toBe("Zix'ara Venn")
    expect(s.attributes.ST.import).toBe(11)
    expect(s.attributes.DX.import).toBe(13)
    expect(s.attributes.IQ.import).toBe(12)
    expect(s.attributes.HT.import).toBe(11)
    expect(s.attributes.WILL.import).toBe(13)
    expect(s.attributes.PER.import).toBe(12)
    expect(s.HP).toMatchObject({ max: 13, value: 9 })
    expect(s.FP).toMatchObject({ max: 11, value: 7 })
    expect(s.basicspeed.value).toBe('6.25')
    expect(s.basicmove.value).toBe('6')
    expect(s.thrust).toBe('1d-1')
    expect(s.swing).toBe('1d+1')
    expect(s.frightcheck).toBe(15)
    expect(s.traits.sizemod).toBe('+1') // attribute_bonus "sm" on a trait inside the ancestry container
    expect(s.traits.race).toBe('Vespid') // the ancestry container (was always '')
    expect(s.liftingmoving.basiclift).toBe('24 lb')
  })

  test('encumbrance comes from the carried weight (calc.extended_weight)', () => {
    // 39.9 lb carried with BL 24 lb is Light. GCS 5 has no 'weight' field, so upstream summed 0 and said None.
    const current = Object.values(s.encumbrance as Record<string, any>).find(e => e.current)
    expect(current.level).toBe(1)
    expect(s.currentmove).toBe(4)
    expect(s.currentdodge).toBe(9)
  })

  test('point totals are split the way GCS splits them', () => {
    expect(s.totalpoints).toEqual({
      attributes: 148,
      ads: 88, // includes the alternative-abilities container as one trait
      disads: -10, // the disabled Berserk counts nothing
      quirks: -1,
      race: 30, // ancestry container (upstream only knew 'race')
      skills: 17, // the disabled Savoir-Faire counts nothing
      spells: 4,
      total: 300,
      unspent: 24,
    })
  })

  test('traits: levels, modifiers with notes, self-control, disabled, containers', () => {
    expect(named(s.ads, 'Magery 2').notes).toBe('One College (Fire)') // modifier local_notes were dropped
    expect(named(s.ads, 'Burning Attack 3').notes).toBe('Accurate 1')
    expect(named(s.ads, 'Bad Temper').cr).toBe(12)
    const berserk = named(s.ads, 'Berserk')
    expect(berserk.disabled).toBe(true)
    expect(berserk.notes).toMatch(/^\[GURPS\.agency\.import\.disabled\]/)
    const vespid = named(s.ads, 'Vespid')
    expect(Object.values(vespid.contains).map((t: any) => t.name)).toEqual([
      'Flight',
      'Extra Legs (4 Legs)',
      'Large Frame',
      'Bad Grip 1',
    ])
    expect(named(s.ads, 'Danger Sense').checkotf).toBe('Per Danger Sense') // vtt_notes OTF
    expect(named(s.ads, 'Chitin Polish').notes).toBe('Keeps the carapace gleaming') // userdesc
  })

  test('skills and techniques with levels, in nested containers', () => {
    expect(named(s.skills, 'Broadsword')).toMatchObject({ import: 14, relativelevel: 'DX+1', points: 4, type: 'SKILL' })
    expect(named(s.skills, 'Guns/TL7 (Pistol)')).toMatchObject({ import: 13 })
    expect(named(s.skills, 'Feint (Broadsword)')).toMatchObject({ type: 'TECHNIQUE', import: 15, relativelevel: '+1' })
    expect(named(s.skills, 'Disarming (Shield (Buckler))')).toMatchObject({ type: 'TECHNIQUE', import: 12 })
    const unarmed = named(named(s.skills, 'Combat').contains, 'Unarmed')
    expect(Object.keys(unarmed.contains)).toHaveLength(3)
    expect(named(s.skills, 'Stealth').notes).toBe('Silent while hovering')
    expect(named(s.skills, 'Savoir-Faire (High Society)').disabled).toBe(true)
  })

  test('spells: colleges as text, ritual magic, containers', () => {
    expect(named(s.spells, 'Shape Fire')).toMatchObject({ college: 'Fire, Movement', difficulty: 'IQ/H', import: 13 })
    expect(named(s.spells, 'Ignite Fire').college).toBe('Fire') // an array upstream; cleanTags() calls .split on it
    expect(named(s.spells, 'Light')).toMatchObject({
      college: 'Light and Darkness',
      difficulty: 'H',
      import: 10,
      points: 0,
    })
    expect(Object.keys(named(s.spells, 'Fire College').contains)).toHaveLength(3)
  })

  test('equipment tree: four levels of containers with counts, costs and weights', () => {
    const backpack = named(carried(s), 'Backpack, Frame')
    expect(backpack).toMatchObject({ count: 1, cost: 100, weight: 10, costsum: 1192, weightsum: 19.4 })
    const pouch = named(backpack.contains, 'Pouch, Small')
    const purse = named(pouch.contains, 'Coin Purse')
    const compartment = named(purse.contains, 'Hidden Compartment')
    expect(named(compartment.contains, 'Folded Map')).toMatchObject({ count: 1, notes: 'Route to the hive' })
    expect(purse).toMatchObject({ weight: 0.1, weightsum: 0.9, costsum: 45 }) // no float noise (was 0.0999...)
    // quantity 0: GCS's extended value/weight are 0, which upstream divided back into a per-piece 0
    expect(named(purse.contains, 'Gold Ring')).toMatchObject({ count: 0, cost: 100, weight: 0.05, costsum: 0 })
    expect(named(backpack.contains, "Traveler's Rations")).toMatchObject({
      count: 6,
      cost: 2,
      weight: 0.5,
      weightsum: 3,
    })
    // A container that halves its contents' weight: its own weight absorbs the reduction so the totals match GCS.
    expect(named(backpack.contains, 'Bag of Holding')).toMatchObject({ weight: -1.5, weightsum: 3.5 })
    expect(named(carried(s), 'Broadsword')).toMatchObject({
      cost: 2000,
      weight: 3,
      equipped: true,
      notes: 'Fine Quality',
    })
    expect(named(carried(s), 'Auto Pistol, 9mm').notes).toBe('Scope (+2 Acc)')
    expect(named(carried(s), 'Longbow').categories).toBe('Missile Weapon, UsesAmmoType:Arrow') // 'tags' in GCS 5
    expect(named(carried(s), 'First Aid Kit')).toMatchObject({ uses: 7, maxuses: 10, duringotf: '/hp +1d' })
    expect(named(carried(s), 'Torch')).toMatchObject({ count: 2, equipped: false })
    expect(named(carried(s), 'Cursed Amulet').disabled).toBe(true)
    const saddlebags = named(s.equipment.other, 'Saddlebags')
    expect(saddlebags).toMatchObject({ carried: false, weightsum: 17, costsum: 130 })
    expect(named(s.equipment.other, 'Arrows')).toMatchObject({ count: 50, weightsum: 5 })
    for (const e of allEquipment(s))
      expect(e.parentuuid === '' || allEquipment(s).some(p => p.uuid === e.parentuuid)).toBe(true)
  })

  test('melee attacks use the resolved calc values', () => {
    const melee = Object.values(s.melee as Record<string, any>)
    const swung = melee.find(m => m.name === 'Broadsword' && m.mode === 'Swung')
    expect(swung).toMatchObject({ import: '14', damage: '1d+2 cut', reach: '1', parry: '11', st: '10' })
    expect(melee.find(m => m.name === 'Small Shield')).toMatchObject({ damage: '1d-1 cr', block: '10' })
    // parry "No" is only in the raw field (calc omits values equal to raw); upstream read calc only and lost it
    expect(melee.find(m => m.name === 'Toxic Attack')).toMatchObject({ reach: 'C', parry: 'No', damage: '2d tox' })
    // unequipped torch and the disabled trait's/equipment's weapons don't appear
    expect(melee.map(m => m.name)).not.toContain('Torch')
    expect(melee).toHaveLength(4)
  })

  test('ranged attacks: accuracy, range, RoF, shots, bulk, recoil', () => {
    const ranged = Object.values(s.ranged as Record<string, any>)
    const pistol = ranged.find(r => r.name === 'Auto Pistol, 9mm')
    expect(pistol).toMatchObject({
      acc: '2',
      rof: '3',
      shots: '8+1(3)',
      bulk: '-2',
      rcl: '2',
      range: '150/1,850',
      damage: '2d+2 pi',
    })
    expect(pistol.notes).toContain('+2') // scope: calc accuracy "2+2"
    const bow = ranged.find(r => r.name === 'Longbow')
    expect(bow).toMatchObject({ range: '165/220', acc: '3', shots: '1(2)', bulk: '-8', st: '11†' })
    expect(ranged.find(r => r.name === 'Burning Attack')).toMatchObject({ acc: '4' }) // Accurate modifier, from calc
    expect(ranged.find(r => r.name === 'Fireball')).toMatchObject({ damage: '2d burn', range: '25/50' })
  })

  test('hit locations of a non-humanoid body with DR', () => {
    expect(s.additionalresources.bodyplan).toBe('hexapodWinged') // "Hexapod, Winged" (heuristic picked quadrupedWinged)
    const locs = Object.values(s.hitlocations as Record<string, any>)
    expect(locs.map(l => l.where)).toEqual([
      'Eye',
      'Skull',
      'Neck',
      'Face',
      'Foreleg',
      'Torso',
      'Mid Leg',
      'Wing',
      'Hind Leg',
      'Mid Leg*',
      'Foot',
      'Vitals',
    ])
    const torso = locs.find(l => l.where === 'Torso')
    expect(torso).toMatchObject({ import: '3', roll: '9-10' })
    expect(torso.split).toEqual({ cr: 4, fire: 5 }) // 'fire' was written to an 'undefined' key
    expect(locs.find(l => l.where === 'Skull')).toMatchObject({ import: '2', roll: '3-4' })
    expect(locs.find(l => l.where === 'Mid Leg')).toMatchObject({ roll: '11', import: '0' })
  })

  test('reactions and conditional modifiers skip disabled sources', () => {
    expect(Object.values(s.reactions as Record<string, any>).map(r => [r.modifier, r.situation])).toEqual([
      ['1', 'from others'],
    ])
    const conditional = Object.values(s.conditionalmods as Record<string, any>).map(r => r.situation)
    expect(conditional).toContain('to Dodge, Parry & Block against attacks from the front or shield side')
    expect(conditional).toHaveLength(3)
  })

  test('notes: containers and resolved script text', () => {
    const log = findEntry(s.notes, n => n.notes === 'Session Log')
    expect(Object.values(log.contains).map((n: any) => n.notes)).toEqual([
      'Session 1: found the ruined hive.',
      'Session 2: bargained with the fire spirit.',
    ])
    expect(findEntry(s.notes, n => n.notes.startsWith('Current HP'))!.notes).toBe('Current HP: 13')
  })

  test('custom GCS pools become resource trackers', () => {
    const trackers = Object.values(s.additionalresources.tracker as Record<string, any>)
    expect(trackers.map(t => [t.alias, t.name, t.max, t.value])).toEqual([
      ['mp', 'Mana Points', 15, 10],
      ['er', 'Energy Reserve', 6, 4],
    ])
  })

  test('the commit nests no deeper than Foundry allows', () => {
    const depth = (o: unknown): number =>
      o && typeof o === 'object' ? 1 + Math.max(0, ...Object.values(o as object).map(depth)) : 0
    expect(depth(actor.lastCommit)).toBeLessThan(100)
  })
})

describe('library characters (written by GCS)', () => {
  test.each(['library-wizard-scholar.gcs', 'library-sora.gcs', 'library-dragon.gcs', 'library-rudolf-vautour.gcs'])(
    '%s imports without errors',
    async name => {
      const { result } = await importFixture(name)
      expect(result).toBe(true)
      expect(captured.errors).toEqual([])
      expect(captured.chat).toEqual([])
    }
  )

  test('dragon: SM reach and skill parry come from calc, avian body, Magicka pool', async () => {
    const { s } = await importFixture('library-dragon.gcs')
    const melee = Object.values(s.melee as Record<string, any>)
    expect(melee.find(m => m.name === 'Fangs')).toMatchObject({ reach: 'C,1-3' }) // raw 'C'
    expect(melee.find(m => m.mode === 'Slash')).toMatchObject({ reach: 'C,1-4', parry: '12' })
    expect(s.additionalresources.bodyplan).toBe('avian')
    expect(s.traits.race).toBe('Dragon')
    expect(s.totalpoints.race).toBe(94)
    expect(Object.values(s.additionalresources.tracker as Record<string, any>)[0]).toMatchObject({
      alias: 'mp',
      max: 15,
    })
  })

  test('rudolf: weights with thousands separators and scripted weights', async () => {
    const { s } = await importFixture('library-rudolf-vautour.gcs')
    // "1,900 lb" parsed as 2 upstream, leaving the horse at -322.516 lb
    expect(named(s.equipment.other, 'Heavy Warhorse')).toMatchObject({ weight: 1900, weightsum: 2224.516, cost: 5714 })
    expect(named(s.equipment.other, "Rider & Rider's Gear")).toMatchObject({ weight: 264.266 })
    const ranged = Object.values(s.ranged as Record<string, any>)
    expect(ranged.find(r => r.name === 'Crossbow')).toMatchObject({ range: '280/350' })
  })

  test('wizard: carrying exactly Basic Lift is no encumbrance', async () => {
    const { s } = await importFixture('library-wizard-scholar.gcs')
    // 20 lb carried, BL 20 lb: no level was 'current' upstream, so Move was 0
    expect(s.currentmove).toBe(6)
    expect(named(s.spells, 'Concussion').college).toBe('Air, Sound')
    expect(named(s.ads, 'Natural Attacks').disabled).toBe(true)
    expect(s.totalpoints.attributes).toBe(169) // the 'attributes' trait container counts toward attributes
  })

  test('sora: techniques named after their default skill', async () => {
    const { s } = await importFixture('library-sora.gcs')
    expect(named(s.skills, 'Arm Lock (Judo)')).toMatchObject({ type: 'TECHNIQUE', import: 17 })
  })
})

describe('error handling', () => {
  test('a file that is not JSON reports the error instead of throwing', async () => {
    const actor = new MockActor()
    const { result } = await runImport(ActorImporter, actor, '{ not json', 'broken.gcs')
    expect(result).toBe(false)
    expect(captured.notifications.map(n => n.message).join()).toContain('GURPS.importNoJSONDetected')
    expect(actor.updates).toEqual([])
  })

  test('a file without calc data reports it instead of throwing a ReferenceError', async () => {
    const json = JSON.parse(readFixture('heavy-vespid.gcs'))
    delete json.calc
    const { result } = await runImport(ActorImporter, new MockActor(), JSON.stringify(json))
    expect(result).toBe(false)
    expect(captured.notifications.map(n => n.message).join()).toContain('GURPS.importOldGCSFile')
    expect(captured.chat).toHaveLength(1)
  })

  test('a file without settings (no body type) still imports', async () => {
    const json = JSON.parse(readFixture('heavy-vespid.gcs'))
    delete json.settings
    const actor = new MockActor()
    const { result } = await runImport(ActorImporter, actor, JSON.stringify(json))
    expect(result).toBe(true)
    expect(captured.errors).toEqual([])
  })
})

describe('Foundry v14 update operators', () => {
  test('traits are stored as plain data (importSizeFromGCS no longer edits the _replace() wrapper)', async () => {
    resetHarness({}, 14)
    const { s } = await importFixture('heavy-vespid.gcs')
    expect(s.traits.sizemod).toBe('+1')
    expect(s.traits.race).toBe('Vespid')
    expect(Object.keys(s.traits)).not.toContain('value')
    expect(Object.keys(named(s.ads, 'Vespid').contains)).toHaveLength(4)
  })
})

describe('current HP/FP on re-import (setting import_hp_fp)', () => {
  async function reimportWithHp(option: number) {
    resetHarness({ import_hp_fp: option })
    const { actor } = await importFixture('heavy-vespid.gcs')
    await actor.update({ 'system.HP.value': 3, 'system.FP.value': 2 })
    await runImport(ActorImporter, actor, readFixture('heavy-vespid.gcs'))
    return actor.system
  }

  test('0 = use the file', async () => {
    expect((await reimportWithHp(0)).HP.value).toBe(9)
  })

  test('1 = ignore the file (was swapped with 0)', async () => {
    const s = await reimportWithHp(1)
    expect([s.HP.value, s.FP.value]).toEqual([3, 2])
  })

  test('2 = ask', async () => {
    resetHarness({ import_hp_fp: 2 })
    const { actor } = await importFixture('heavy-vespid.gcs')
    await actor.update({ 'system.HP.value': 3 })
    dialog.answer = true // "save" current
    await runImport(ActorImporter, actor, readFixture('heavy-vespid.gcs'))
    expect(captured.dialogs).toContain('GURPS.importOverwriteHpFp')
    expect(actor.system.HP.value).toBe(3)
  })
})
