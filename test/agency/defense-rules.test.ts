import {
  availableToggles,
  classifyAttack,
  deceptivePenalty,
  defenseAvailability,
  defenseModifiers,
  defenseOtf,
  distributeAttack,
  distributeHits,
  hitsAfterDefense,
  listDefenseWeapons,
  maneuverDefenseRule,
  parseHitLocation,
  type DefenseSituation,
  type ModifierContext,
} from '../../module/agency/defense/rules.js'
import type { AttackProfile } from '../../module/agency/defense/types.js'

const MELEE: AttackProfile = { kind: 'melee', thrown: false, firearm: false }
const BOW: AttackProfile = { kind: 'ranged', thrown: false, firearm: false }
const PISTOL: AttackProfile = { kind: 'ranged', thrown: false, firearm: true }
const KNIFE_THROWN: AttackProfile = { kind: 'ranged', thrown: true, firearm: false }

const broadsword = { name: 'Broadsword', mode: 'Swung', damage: '2d+1 cut', reach: '1', parry: '9', block: 'No' }
const glock = { name: 'Glock 17', mode: '', damage: '2d+2 pi', acc: '2', rof: '3', rcl: '2', range: '160/1800' }
const longbow = { name: 'Longbow', mode: '', damage: '1d+3 imp', acc: '3', rof: '1', rcl: '', range: '150/200' }
const spear = { name: 'Spear', mode: 'Thrown', damage: '1d+3 imp', acc: '2', rof: '1', rcl: '' }

describe('classifyAttack', () => {
  it('reads melee and ranged from the OTF prefix upstream writes', () => {
    expect(classifyAttack('[@abc@M:"Broadsword (Swung)"]', broadsword)).toEqual(MELEE)
    expect(classifyAttack('[@abc@R:"Glock 17"]', glock)).toEqual(PISTOL)
  })

  it('works without the actor id', () => {
    expect(classifyAttack('[M:"Broadsword (Swung)"]', broadsword)?.kind).toBe('melee')
  })

  it('falls back to the weapon shape for A: rolls and sheet rolls', () => {
    expect(classifyAttack('[@abc@A:"Glock 17"]', glock)?.kind).toBe('ranged')
    expect(classifyAttack('', broadsword)?.kind).toBe('melee')
  })

  it('is not an attack when the roll is a skill or a defense', () => {
    expect(classifyAttack('[@abc@S:"Stealth"]', { name: 'Stealth', level: 12 })).toBeNull()
    expect(classifyAttack('[@abc@P:"Broadsword (Swung)"]', undefined)).toBeNull()
    expect(classifyAttack('[@abc@Dodge]', undefined)).toBeNull()
  })

  it('treats a numeric Rcl as a firearm or beam, and bows as muscle-powered', () => {
    expect(classifyAttack('[R:"Longbow"]', longbow)).toEqual(BOW)
    expect(classifyAttack('[R:"Glock 17"]', glock)?.firearm).toBe(true)
  })

  it('spots thrown weapons by name or mode', () => {
    expect(classifyAttack('[R:"Spear (Thrown)"]', spear)).toEqual(KNIFE_THROWN)
    expect(
      classifyAttack('[R:"Throwing Knife"]', { name: 'Throwing Knife', damage: '1d-1 imp', acc: '0' })?.thrown
    ).toBe(true)
  })
})

describe('maneuverDefenseRule', () => {
  it('uses upstream maneuver defense flags', () => {
    expect(maneuverDefenseRule('allout_attack', 'none')).toBe('none')
    expect(maneuverDefenseRule('move_and_attack', 'dodge-block')).toBe('dodge-block')
    expect(maneuverDefenseRule('attack', 'any')).toBe('any')
    expect(maneuverDefenseRule('attack', undefined)).toBe('any')
  })

  it('limits Committed Aim to dodging, as upstream TokenActions does', () => {
    expect(maneuverDefenseRule('committed_aim', 'any')).toBe('dodge')
  })
})

describe('defenseAvailability', () => {
  const base: DefenseSituation = {
    attack: MELEE,
    isCritical: false,
    maneuverRule: 'any',
    cantSee: false,
    hasParry: true,
    hasBlock: true,
  }

  it('allows every defense the defender has against melee', () => {
    expect(defenseAvailability(base)).toMatchObject({ noDefense: null, dodge: true, parry: true, block: true })
  })

  it('needs a weapon to parry and a shield to block', () => {
    expect(defenseAvailability({ ...base, hasParry: false, hasBlock: false })).toMatchObject({
      dodge: true,
      parry: false,
      block: false,
    })
  })

  it('gives no defense against a critical hit', () => {
    expect(defenseAvailability({ ...base, isCritical: true })).toMatchObject({ noDefense: 'critical', dodge: false })
  })

  it('gives no defense to an All-Out Attacker', () => {
    expect(defenseAvailability({ ...base, maneuverRule: 'none' })).toMatchObject({
      noDefense: 'maneuver',
      dodge: false,
    })
  })

  it('forbids parrying ranged attacks but allows blocking arrows', () => {
    const result = defenseAvailability({ ...base, attack: BOW })
    expect(result).toMatchObject({ dodge: true, parry: false, block: true })
    expect(result.notes).toContain('noParryRanged')
  })

  it('allows parrying thrown weapons', () => {
    const result = defenseAvailability({ ...base, attack: KNIFE_THROWN })
    expect(result).toMatchObject({ parry: true, block: true })
    expect(result.notes).toContain('parryThrown')
  })

  it('forbids blocking bullets', () => {
    expect(defenseAvailability({ ...base, attack: PISTOL })).toMatchObject({ dodge: true, parry: false, block: false })
  })

  it('gives no defense against a ranged attack the defender cannot see', () => {
    expect(defenseAvailability({ ...base, attack: BOW, cantSee: true }).noDefense).toBe('cantSee')
  })

  it('still lets a blind defender defend in melee (the -4 is a modifier)', () => {
    expect(defenseAvailability({ ...base, cantSee: true })).toMatchObject({ noDefense: null, dodge: true })
  })

  it('applies Move and Attack and Committed Aim restrictions', () => {
    expect(defenseAvailability({ ...base, maneuverRule: 'dodge-block' })).toMatchObject({
      dodge: true,
      parry: false,
      block: true,
    })
    expect(defenseAvailability({ ...base, maneuverRule: 'dodge' })).toMatchObject({
      dodge: true,
      parry: false,
      block: false,
    })
  })
})

describe('availableToggles', () => {
  it('offers Retreat against melee and Dodge and Drop against ranged attacks', () => {
    expect(availableToggles(MELEE, false)).toMatchObject({ retreat: true, dodgeAndDrop: false })
    expect(availableToggles(BOW, false)).toMatchObject({ retreat: false, dodgeAndDrop: true })
  })

  it('does not let a stunned defender retreat', () => {
    expect(availableToggles(MELEE, true).retreat).toBe(false)
  })
})

describe('defenseModifiers', () => {
  const ctx: ModifierContext = {
    attack: MELEE,
    defense: 'dodge',
    fencing: false,
    stunned: false,
    cantSee: false,
    deceptivePenalty: 0,
    maneuver: 'attack',
    includeManeuverAndStatus: false,
  }
  const keys = (mods: { key: string }[]) => mods.map(m => m.key.split('.').pop())

  it('adds nothing without options', () => {
    expect(defenseModifiers(ctx, {})).toEqual([])
  })

  it('gives the retreat bonus that matches the defense (B377)', () => {
    expect(defenseModifiers(ctx, { retreat: true })).toEqual([{ mod: 3, key: 'GURPS.modifiers_.dodgeRetreat' }])
    expect(defenseModifiers({ ...ctx, defense: 'parry' }, { retreat: true })[0]).toMatchObject({ mod: 1 })
    expect(defenseModifiers({ ...ctx, defense: 'parry', fencing: true }, { retreat: true })[0]).toMatchObject({
      mod: 3,
      key: 'GURPS.modifiers_.fencingRetreat',
    })
    expect(defenseModifiers({ ...ctx, defense: 'block' }, { retreat: true })[0]).toMatchObject({ mod: 1 })
  })

  it('ignores Retreat when stunned or against ranged attacks', () => {
    expect(defenseModifiers({ ...ctx, stunned: true }, { retreat: true })).toEqual([])
    expect(defenseModifiers({ ...ctx, attack: BOW }, { retreat: true })).toEqual([])
  })

  it('gives Dodge and Drop only against ranged attacks', () => {
    expect(defenseModifiers({ ...ctx, attack: BOW }, { dodgeAndDrop: true })).toEqual([
      { mod: 3, key: 'GURPS.modifiers_.dodgeAndDrop' },
    ])
    expect(defenseModifiers(ctx, { dodgeAndDrop: true })).toEqual([])
  })

  it('turns the Acrobatics roll into +2 or -2 to Dodge', () => {
    expect(defenseModifiers({ ...ctx, acrobaticResult: 'success' }, { acrobatic: true })[0].mod).toBe(2)
    expect(defenseModifiers({ ...ctx, acrobaticResult: 'failure' }, { acrobatic: true })[0].mod).toBe(-2)
  })

  it('charges 1 FP for Feverish Defense through the upstream *Cost tag', () => {
    expect(defenseModifiers(ctx, { feverish: true })).toEqual([
      { mod: 2, key: 'GURPS.modifiers_.feverishDefense', suffix: ' *Cost 1FP' },
    ])
  })

  it('applies side attacks, deceptive attacks and thrown-weapon parries', () => {
    expect(defenseModifiers(ctx, { side: true })).toEqual([{ mod: -2, key: 'GURPS.modifiers_.defenseSide' }])
    expect(defenseModifiers({ ...ctx, deceptivePenalty: 2 }, {})).toEqual([
      { mod: -2, key: 'GURPS.modifiers_.deceptiveDefense' },
    ])
    expect(defenseModifiers({ ...ctx, defense: 'parry', attack: KNIFE_THROWN }, {})).toEqual([
      { mod: -1, key: 'GURPS.agency.defense.mod.parryThrown' },
    ])
  })

  it('leaves maneuver and status modifiers to upstream tagged modifiers by default', () => {
    expect(defenseModifiers({ ...ctx, maneuver: 'aod_dodge', stunned: true, cantSee: true }, {})).toEqual([])
  })

  it('adds maneuver and status modifiers when upstream will not', () => {
    const full = { ...ctx, includeManeuverAndStatus: true }
    expect(keys(defenseModifiers({ ...full, maneuver: 'aod_dodge' }, {}))).toEqual(['aodIncreased'])
    expect(defenseModifiers({ ...full, maneuver: 'aod_dodge', defense: 'parry' }, {})).toEqual([])
    expect(keys(defenseModifiers({ ...full, maneuver: 'allout_defense', defense: 'block' }, {}))).toEqual([
      'aodIncreased',
    ])
    expect(keys(defenseModifiers({ ...full, stunned: true, cantSee: true }, {}))).toEqual(['stunned', 'cantSee'])
    expect(defenseModifiers({ ...full, attack: BOW, cantSee: true }, {})).toEqual([])
    expect(defenseModifiers({ ...full, maneuver: 'committed_aim' }, {})[0].mod).toBe(-2)
  })
})

describe('hitsAfterDefense', () => {
  it('stops a single hit with any successful defense', () => {
    expect(hitsAfterDefense(1, { type: 'dodge', success: true, margin: 0 })).toBe(0)
    expect(hitsAfterDefense(1, { type: 'parry', success: true, margin: 5 })).toBe(0)
    expect(hitsAfterDefense(1, { type: 'block', success: false, margin: -1 })).toBe(1)
    expect(hitsAfterDefense(1, { type: 'none', success: false, margin: 0 })).toBe(1)
  })

  it('dodges one rapid-fire hit plus one per point of success (B375)', () => {
    expect(hitsAfterDefense(5, { type: 'dodge', success: true, margin: 0 })).toBe(4)
    expect(hitsAfterDefense(5, { type: 'dodge', success: true, margin: 2 })).toBe(2)
    expect(hitsAfterDefense(5, { type: 'dodge', success: true, margin: 9 })).toBe(0)
  })

  it('parries or blocks only one hit of rapid fire', () => {
    expect(hitsAfterDefense(3, { type: 'block', success: true, margin: 4 })).toBe(2)
  })

  it('never stops critical hits', () => {
    expect(hitsAfterDefense(5, { type: 'dodge', success: true, margin: 9 }, 2)).toBe(2)
    expect(hitsAfterDefense(5, { type: 'dodge', success: true, margin: 1 }, 2)).toBe(3)
    expect(hitsAfterDefense(2, { type: 'dodge', success: true, margin: 4 }, 2)).toBe(2)
    expect(hitsAfterDefense(4, { type: 'dodge', success: false, margin: -1 }, 1)).toBe(4)
  })
})

describe('distributeHits / distributeAttack', () => {
  it('attacks every target once with a single hit', () => {
    expect(distributeHits(1, 3)).toEqual([1, 1, 1])
  })

  it('splits rapid-fire hits in target order', () => {
    expect(distributeHits(5, 2)).toEqual([3, 2])
    expect(distributeHits(2, 3)).toEqual([1, 1, 0])
  })

  it('hands out critical hits in target order, within each share', () => {
    expect(distributeAttack(5, 3, 2)).toEqual([
      { hits: 3, critical: 2 },
      { hits: 2, critical: 1 },
    ])
    expect(distributeAttack(3, 9, 1)).toEqual([{ hits: 3, critical: 3 }])
    expect(distributeAttack(1, 1, 2)).toEqual([
      { hits: 1, critical: 1 },
      { hits: 1, critical: 1 },
    ])
    expect(distributeAttack(4, 0, 2)).toEqual([
      { hits: 2, critical: 0 },
      { hits: 2, critical: 0 },
    ])
  })
})

describe('parseHitLocation', () => {
  const locations = { Skull: 'Skull', Torso: 'Torso', Vitals: 'Vitals', Schädel: 'Skull' }

  it('reads the location from upstream hit location modifiers', () => {
    expect(parseHitLocation([{ modint: -7, desc: 'to hit Skull' }], 'to hit', locations)).toBe('Skull')
    expect(parseHitLocation([{ modint: -3, desc: 'to hit Vitals [Imp/pi only]' }], 'to hit', locations)).toBe('Vitals')
  })

  it('maps localized names back to upstream keys', () => {
    expect(parseHitLocation([{ modint: -7, desc: 'treffen Schädel' }], 'treffen', locations)).toBe('Skull')
  })

  it('ignores other to-hit modifiers and returns null without a location', () => {
    expect(parseHitLocation([{ modint: 4, desc: 'to hit (AoA: Determined)' }], 'to hit', locations)).toBeNull()
    expect(parseHitLocation([], 'to hit', locations)).toBeNull()
    expect(parseHitLocation(undefined, 'to hit', locations)).toBeNull()
  })

  it('takes the last location when several were added', () => {
    const mods = [
      { modint: -7, desc: 'to hit Skull' },
      { modint: -3, desc: 'to hit Vitals' },
    ]
    expect(parseHitLocation(mods, 'to hit', locations)).toBe('Vitals')
  })
})

describe('deceptivePenalty', () => {
  const label = 'to hit (Deceptive Attack)'

  it('is -1 to defend per -2 to hit (B369)', () => {
    expect(deceptivePenalty([{ modint: -2, desc: label }], label)).toBe(1)
    expect(deceptivePenalty([{ mod: '-4', desc: label }], label)).toBe(2)
    expect(deceptivePenalty([{ modint: -3, desc: label }], label)).toBe(1)
  })

  it('is zero without a deceptive attack', () => {
    expect(deceptivePenalty([{ modint: -2, desc: 'to hit (Rapid Strike)' }], label)).toBe(0)
    expect(deceptivePenalty(null, label)).toBe(0)
  })
})

describe('listDefenseWeapons', () => {
  const melee = {
    '00000': { name: 'Broadsword', mode: 'Swung', parry: '9', block: '' },
    '00001': { name: 'Broadsword', mode: 'Thrust', parry: '9', block: '' },
    '00002': { name: 'Rapier', mode: '', parry: '11F', block: '' },
    '00003': { name: 'Medium Shield', mode: 'Bash', parry: 'No', block: '10' },
    '00004': { name: 'Kick', mode: '', parry: '-', block: '' },
    '00005': {
      name: 'Container',
      contains: { '00000': { name: 'Knife', mode: 'Swung', parry: '7', block: '' } },
    },
  }

  it('lists usable parries best first, with fencing weapons marked', () => {
    expect(listDefenseWeapons(melee, 'parry')).toEqual([
      { name: 'Rapier', value: 11, fencing: true },
      { name: 'Broadsword (Swung)', value: 9, fencing: false },
      { name: 'Broadsword (Thrust)', value: 9, fencing: false },
      { name: 'Knife (Swung)', value: 7, fencing: false },
    ])
  })

  it('lists blocks', () => {
    expect(listDefenseWeapons(melee, 'block')).toEqual([{ name: 'Medium Shield (Bash)', value: 10, fencing: false }])
  })

  it('copes with a missing melee list', () => {
    expect(listDefenseWeapons(undefined, 'parry')).toEqual([])
  })
})

describe('defenseOtf', () => {
  it('builds the OTFs upstream rolls defenses with', () => {
    expect(defenseOtf('dodge')).toBe('Dodge')
    expect(defenseOtf('parry', 'Broadsword (Swung)')).toBe('P:"Broadsword (Swung)"')
    expect(defenseOtf('block', 'Medium Shield')).toBe('B:"Medium Shield"')
    expect(defenseOtf('parry', 'The "Sword"')).toBe(`P:'The "Sword"'`)
  })
})
