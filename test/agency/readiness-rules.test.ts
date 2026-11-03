import {
  ammoFastDrawEffect,
  attackGate,
  canFastDrawFrom,
  combatStartChanges,
  currentState,
  defaultCarryState,
  fastDrawEffect,
  fastDrawModifier,
  fastDrawOutcome,
  fastDrawSpecialty,
  findFastDrawSkill,
  gunslingerApplies,
  holsterState,
  matchEquipment,
  nextState,
  physicalWeapons,
  readyParries,
  readinessId,
  type AttackEntry,
  type EquipmentRef,
  type PhysicalWeapon,
} from '../../module/agency/readiness/rules.js'

const equipment: EquipmentRef[] = [
  { path: 'system.equipment.carried.00000', name: 'Glock 17', originalName: 'Glock 17' },
  { path: 'system.equipment.carried.00001', name: 'Remington 870', originalName: 'Remington 870' },
  { path: 'system.equipment.carried.00002', name: 'Combat Knife' },
  { path: 'system.equipment.carried.00003', name: 'My Old Sword', originalName: 'Broadsword' },
  { path: 'system.equipment.carried.00004', name: 'Riot Shield' },
  { path: 'system.equipment.carried.00005', name: 'Spear' },
  { path: 'system.equipment.carried.00006', name: 'Baton', itemid: 'item-baton' },
  { path: 'system.equipment.other.00000', name: 'Frag Grenade' },
]

const entry = (kind: 'melee' | 'ranged', key: string, value: AttackEntry['value']): AttackEntry => ({
  kind,
  path: `system.${kind}.${key}`,
  value,
})

const entries: AttackEntry[] = [
  entry('melee', '00000', { name: 'Natural Attacks', mode: 'Punch', reach: 'C', parry: '0' }),
  entry('melee', '00001', { name: 'Natural Attacks', mode: 'Kick', reach: 'C,1', parry: 'No' }),
  entry('melee', '00002', { name: 'Combat Knife', mode: 'Swung', reach: 'C,1', parry: '-1' }),
  entry('melee', '00003', { name: 'Combat Knife', mode: 'Thrust', reach: 'C', parry: '-1' }),
  entry('melee', '00004', { name: 'Broadsword', mode: 'Swung', reach: '1', parry: '0' }),
  entry('melee', '00005', { name: 'Riot Shield', mode: 'Shield Bash', reach: '1', parry: 'No', block: '+2' }),
  entry('melee', '00006', { name: 'Spear', mode: 'Thrust', reach: '1,2*', parry: '0' }),
  entry('melee', '00007', { name: 'Remington 870', mode: 'Butt stroke', reach: '1', parry: '0' }),
  entry('melee', '00008', { name: 'Baton - Swung', mode: 'Swung', fromItem: 'item-baton', reach: '1', parry: '0' }),
  entry('melee', '00009', { name: 'Claws - Slash', mode: 'Slash', fromItem: 'item-trait', reach: 'C', parry: '0' }),
  entry('melee', '00010', { name: 'Karate', mode: 'Punch', reach: 'C', parry: '0' }),
  entry('ranged', '00000', { name: 'Glock 17', mode: 'Semi', shots: '17+1(3)', bulk: '-2', rof: '3' }),
  entry('ranged', '00001', { name: 'Glock 17', mode: 'Burst', shots: '17+1(3)', bulk: '-2', rof: '3' }),
  entry('ranged', '00002', { name: 'Remington 870', mode: 'Buckshot', shots: '4+1(3i)', bulk: '-5', rof: '3x9' }),
  entry('ranged', '00003', { name: 'Combat Knife', mode: 'Thrown', shots: 'T(1)' }),
  entry('ranged', '00004', { name: 'Frag Grenade', mode: 'Thrown', shots: 'T(1)' }),
]

const weapons = physicalWeapons(entries, equipment)
const byName = (name: string): PhysicalWeapon => weapons.find(w => w.name === name)!

describe('which attacks come from equipment', () => {
  test('natural attacks, trait attacks and skills are left out', () => {
    expect(matchEquipment({ name: 'Natural Attacks', mode: 'Punch' }, equipment)).toBeUndefined()
    expect(matchEquipment({ name: 'Karate', mode: 'Punch' }, equipment)).toBeUndefined()
    // Foundry-items mode: a parent item that isn't equipment (a trait) means natural.
    expect(matchEquipment({ name: 'Claws - Slash', mode: 'Slash', fromItem: 'item-trait' }, equipment)).toBeUndefined()
  })

  test('equipment weapons are found by name, original name, item id or equipment path', () => {
    expect(matchEquipment({ name: 'Glock 17', mode: 'Semi' }, equipment)?.path).toBe('system.equipment.carried.00000')
    expect(matchEquipment({ name: 'Broadsword' }, equipment)?.name).toBe('My Old Sword')
    expect(matchEquipment({ name: 'Baton - Swung', mode: 'Swung', fromItem: 'item-baton' }, equipment)?.name).toBe(
      'Baton'
    )
    expect(matchEquipment({ name: 'Whatever', eqtkey: 'system.equipment.carried.00005' }, equipment)?.name).toBe(
      'Spear'
    )
    expect(matchEquipment({ name: 'combat knife' }, equipment)?.name).toBe('Combat Knife')
  })

  test('every entry of one item is one weapon (shots and butt stroke, thrust and throw)', () => {
    expect(weapons.map(w => w.name).sort()).toEqual(
      [
        'Baton',
        'Combat Knife',
        'Frag Grenade',
        'Glock 17',
        'My Old Sword',
        'Remington 870',
        'Riot Shield',
        'Spear',
      ].sort()
    )
    expect(byName('Remington 870').entries.map(e => e.kind)).toEqual(['melee', 'ranged'])
    expect(byName('Combat Knife').entries).toHaveLength(3)
    expect(byName('Glock 17').id).toBe(readinessId('eqt:glock 17'))
    expect(byName('Glock 17').id).toMatch(/^r[0-9a-z]+$/)
  })
})

describe('carry state and Fast-Draw specialty', () => {
  test('pistols and knives holstered, long arms slung, shields ready', () => {
    expect(defaultCarryState(byName('Glock 17'))).toBe('holstered')
    expect(defaultCarryState(byName('Combat Knife'))).toBe('holstered')
    expect(defaultCarryState(byName('Remington 870'))).toBe('slung')
    expect(defaultCarryState(byName('Riot Shield'))).toBe('ready')
    expect(defaultCarryState(byName('Spear'))).toBe('slung')
    expect(defaultCarryState(byName('My Old Sword'))).toBe('holstered')
    expect(defaultCarryState(byName('Frag Grenade'))).toBe('holstered')
  })

  test('a carry state set by hand, or the gun class picked in the fire dialog, wins', () => {
    expect(defaultCarryState(byName('Glock 17'), 'stowed')).toBe('stowed')
    expect(defaultCarryState(byName('Glock 17'), undefined, 'longarm')).toBe('slung')
    // 'dropped' is not a way to carry something.
    expect(defaultCarryState(byName('Glock 17'), 'dropped')).toBe('holstered')
  })

  test('specialties', () => {
    expect(fastDrawSpecialty(byName('Glock 17'))).toBe('Pistol')
    expect(fastDrawSpecialty(byName('Remington 870'))).toBe('Long Arm')
    expect(fastDrawSpecialty(byName('Combat Knife'))).toBe('Knife')
    expect(fastDrawSpecialty(byName('My Old Sword'))).toBe('Sword')
    expect(fastDrawSpecialty(byName('Spear'))).toBeNull()
    expect(fastDrawSpecialty(byName('Baton'))).toBeNull()
    expect(fastDrawSpecialty(byName('Riot Shield'))).toBeNull()
    expect(fastDrawSpecialty(byName('Glock 17'), 'none')).toBeNull()
    expect(fastDrawSpecialty(byName('Baton'), 'Knife')).toBe('Knife')
  })

  test('two-handed swords, force swords and bows', () => {
    const one = (name: string, kind: 'melee' | 'ranged' = 'melee', extra = {}): PhysicalWeapon =>
      physicalWeapons([entry(kind, '0', { name, ...extra })], [{ path: 'e', name }])[0]
    expect(fastDrawSpecialty(one('Claymore'))).toBe('Two-Handed Sword')
    expect(defaultCarryState(one('Claymore'))).toBe('slung')
    expect(fastDrawSpecialty(one('Katana'))).toBe('Sword')
    expect(fastDrawSpecialty(one('Lightsaber'))).toBe('Force Sword')
    const bow = one('Longbow', 'ranged', { shots: '1(2)', bulk: '-8' })
    expect(fastDrawSpecialty(bow)).toBeNull()
    expect(defaultCarryState(bow)).toBe('slung')
  })
})

describe('states', () => {
  test('stored state, else carry state', () => {
    expect(currentState(undefined, 'holstered')).toBe('holstered')
    expect(currentState({ state: 'ready' }, 'holstered')).toBe('ready')
    expect(currentState({ state: 'nonsense' as any }, 'slung')).toBe('slung')
  })

  test('clicking cycles through every state', () => {
    expect(['ready', 'holstered', 'slung', 'stowed', 'dropped'].map(s => nextState(s as any))).toEqual([
      'holstered',
      'slung',
      'stowed',
      'dropped',
      'ready',
    ])
  })

  test('/holster puts a weapon in its carry state; a shield goes on the back', () => {
    expect(holsterState('holstered')).toBe('holstered')
    expect(holsterState('slung')).toBe('slung')
    expect(holsterState('ready')).toBe('slung')
  })
})

describe('attacking with an unready weapon', () => {
  test('ready: go ahead; out of combat: just draw it; in combat: ask', () => {
    expect(attackGate('ready', true)).toBe('proceed')
    expect(attackGate('holstered', false)).toBe('auto-ready')
    expect(attackGate('dropped', false)).toBe('auto-ready')
    expect(attackGate('slung', true)).toBe('prompt')
  })

  test('Fast-Draw only from a holster or sling', () => {
    expect(canFastDrawFrom('holstered')).toBe(true)
    expect(canFastDrawFrom('slung')).toBe(true)
    expect(canFastDrawFrom('stowed')).toBe(false)
    expect(canFastDrawFrom('dropped')).toBe(false)
  })

  test('B194 outcomes', () => {
    expect(fastDrawOutcome({ failure: false })).toBe('success')
    expect(fastDrawOutcome({ failure: true })).toBe('failure')
    expect(fastDrawOutcome({ failure: true, isCritFailure: true })).toBe('critical-failure')
    expect(fastDrawEffect('success')).toEqual({ state: 'ready', attack: true, turnSpent: false })
    expect(fastDrawEffect('failure')).toEqual({ state: 'ready', attack: false, turnSpent: true })
    expect(fastDrawEffect('critical-failure')).toEqual({ state: 'dropped', attack: false, turnSpent: true })
  })

  test('Fast-Draw (Ammo): a second off, or the magazine dropped', () => {
    expect(ammoFastDrawEffect('success')).toEqual({ secondsSaved: 1, reload: true })
    expect(ammoFastDrawEffect('failure')).toEqual({ secondsSaved: 0, reload: true })
    expect(ammoFastDrawEffect('critical-failure')).toEqual({ secondsSaved: 0, reload: false })
  })

  test('finding the skill: specialty, TL, spelling; no default', () => {
    const skills = [
      { name: 'Fast-Draw (Pistol)', level: 13 },
      { name: 'Fast-Draw (Pistol)', level: 14 },
      { name: 'Fast Draw (Longarm)', level: '12' },
      { name: 'Fast-Draw/TL8 (Ammo)', level: 11 },
      { name: 'Fast-Draw (Two-Handed Sword)', level: 10 },
      { name: 'Guns (Pistol)', level: 15 },
    ]
    expect(findFastDrawSkill(skills, 'Pistol')).toEqual({ name: 'Fast-Draw (Pistol)', level: 14 })
    expect(findFastDrawSkill(skills, 'Long Arm')?.level).toBe(12)
    expect(findFastDrawSkill(skills, 'Ammo')?.name).toBe('Fast-Draw/TL8 (Ammo)')
    // "(Sword)" doesn't match "(Two-Handed Sword)".
    expect(findFastDrawSkill(skills, 'Sword')).toBeNull()
    expect(findFastDrawSkill(skills, 'Knife')).toBeNull()
  })

  test('Gunslinger halves Fast-Draw penalties for guns, in the shooter’s favour', () => {
    expect(fastDrawModifier(-3, true)).toBe(-1)
    expect(fastDrawModifier(-4, true)).toBe(-2)
    expect(fastDrawModifier(-1, true)).toBe(0)
    expect(fastDrawModifier(-3, false)).toBe(-3)
    expect(fastDrawModifier(2, true)).toBe(2)
    expect(fastDrawModifier(NaN, true)).toBe(0)
    expect(gunslingerApplies('Pistol')).toBe(true)
    expect(gunslingerApplies('Ammo')).toBe(true)
    expect(gunslingerApplies('Knife')).toBe(false)
  })
})

describe('combat start', () => {
  const list = [
    { id: 'a', state: 'ready' as const, carry: 'holstered' as const },
    { id: 'b', state: 'slung' as const, carry: 'slung' as const },
    { id: 'c', state: 'dropped' as const, carry: 'slung' as const },
  ]
  test('keep: nothing changes', () => {
    expect(combatStartChanges(list, 'keep')).toEqual({})
  })
  test('carry: every weapon back to its carry state', () => {
    expect(combatStartChanges(list, 'carry')).toEqual({ a: 'holstered', c: 'slung' })
  })
})

describe('parries need a ready weapon', () => {
  const parries = [
    { name: 'Natural Attacks (Punch)', value: 9 },
    { name: 'Combat Knife (Swung)', value: 8 },
    { name: 'Broadsword (Swung)', value: 10 },
    { name: 'Karate (Punch)', value: 11 },
  ]
  const melee = entries.filter(e => e.kind === 'melee')

  test('unarmed parries stay; weapon parries only when ready', () => {
    const ready = new Set(['Combat Knife'])
    const kept = readyParries(parries, melee, weapons, w => (ready.has(w.name) ? 'ready' : 'holstered'))
    expect(kept.map(p => p.name)).toEqual(['Natural Attacks (Punch)', 'Combat Knife (Swung)', 'Karate (Punch)'])
  })

  test('a parry from somewhere unknown is kept', () => {
    expect(readyParries([{ name: 'Mystery (Block)' }], melee, weapons, () => 'dropped')).toHaveLength(1)
  })
})
