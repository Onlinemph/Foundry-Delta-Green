import {
  ammoFieldName,
  currentLoaded,
  equipmentEntries,
  findAmmoItem,
  findThrownItem,
  flattenList,
  isRangedWeapon,
  matchWeapons,
  planFire,
  planReload,
  requestedShots,
  resolveUnit,
  weaponId,
  weaponKey,
  weaponLabel,
  type EquipmentEntry,
  type RangedLike,
} from '../../module/agency/firearms/ammo.js'
import { parseShots } from '../../module/agency/firearms/shots.js'

const glock = parseShots('17+1(3)')
const rifle = parseShots('30(3)')
const shotgun = parseShots('5+1(2i)')
const revolver = parseShots('6(3i)')
const bow = parseShots('1(2)')

describe('weapon identity', () => {
  test('uses the GCS uuid when there is one, with the usage', () => {
    expect(weaponKey({ name: 'Glock 17', mode: 'Shooting', uuid: 'abc' })).toBe('uuid:abc|Shooting')
  })

  test('falls back to the import id', () => {
    expect(weaponKey({ name: 'Glock 17', importid: 'imp1' })).toBe('uuid:imp1|')
  })

  test('falls back to name + usage', () => {
    expect(weaponKey({ name: ' Glock 17 ', mode: ' Shooting ', uuid: '' })).toBe('name:Glock 17|Shooting')
    expect(weaponKey({ name: 'Glock 17' })).toBe('name:Glock 17|')
  })

  test('different usages are different weapons', () => {
    expect(weaponKey({ name: 'M16', mode: 'Rifle' })).not.toBe(weaponKey({ name: 'M16', mode: 'M203' }))
  })

  test('ids are flag-safe and stable', () => {
    const id = weaponId('name:S&W M&P .45|Shooting')
    expect(id).toMatch(/^w[0-9a-z]+$/)
    expect(weaponId('name:S&W M&P .45|Shooting')).toBe(id)
    expect(weaponId('name:S&W M&P .45|Bash')).not.toBe(id)
  })

  test('label', () => {
    expect(weaponLabel({ name: 'Glock 17', mode: 'Shooting' })).toBe('Glock 17 (Shooting)')
    expect(weaponLabel({ name: 'Glock 17' })).toBe('Glock 17')
  })

  test('ranged vs melee attack objects', () => {
    expect(isRangedWeapon({ name: 'Glock', shots: '17+1(3)', rof: '3' })).toBe(true)
    expect(isRangedWeapon({ name: 'Knife', reach: 'C,1', parry: '0' })).toBe(false)
    expect(isRangedWeapon(undefined)).toBe(false)
    expect(isRangedWeapon('Glock')).toBe(false)
  })
})

describe('flattenList', () => {
  test('walks contains and collapsed, building data paths', () => {
    const list: Record<string, RangedLike> = {
      '00000': { name: 'A', contains: { '00000': { name: 'A1' } } },
      '00001': { name: 'B', collapsed: { '00000': { name: 'B1' } } },
    }
    expect(flattenList(list, 'system.ranged.').map(e => [e.path, e.value.name])).toEqual([
      ['system.ranged.00000', 'A'],
      ['system.ranged.00000.contains.00000', 'A1'],
      ['system.ranged.00001', 'B'],
      ['system.ranged.00001.collapsed.00000', 'B1'],
    ])
  })

  test('tolerates missing lists', () => {
    expect(flattenList(undefined, 'x.')).toEqual([])
    expect(flattenList(null, 'x.')).toEqual([])
  })
})

describe('currentLoaded', () => {
  test('a weapon never seen is full', () => {
    expect(currentLoaded(undefined, glock)).toBe(18)
    expect(currentLoaded({}, rifle)).toBe(30)
  })

  test('reads the stored rounds', () => {
    expect(currentLoaded({ loaded: 4 }, glock)).toBe(4)
    expect(currentLoaded({ loaded: 0 }, glock)).toBe(0)
  })

  test('clamps to the capacity (Shots changed on re-import)', () => {
    expect(currentLoaded({ loaded: 30 }, glock)).toBe(18)
    expect(currentLoaded({ loaded: -2 }, glock)).toBe(0)
  })

  test('subtracts rounds fired but not yet saved', () => {
    expect(currentLoaded({ loaded: 10 }, glock, 3)).toBe(7)
    expect(currentLoaded(undefined, glock, 20)).toBe(0)
  })
})

describe('requestedShots', () => {
  test.each([
    [undefined, 1],
    [null, 1],
    [0, 1],
    [-2, 1],
    [NaN, 1],
    ['5', 5],
    [3, 3],
    [2.9, 2],
  ])('%p => %d', (shots, expected) => {
    expect(requestedShots(shots)).toBe(expected)
  })
})

describe('planFire', () => {
  test('fires what was asked for when there is enough', () => {
    expect(planFire(10, 3, 'block')).toEqual({ proceed: true, empty: false, shots: 3, capped: false })
  })

  test('fires exactly what is left', () => {
    expect(planFire(3, 3, 'block')).toEqual({ proceed: true, empty: false, shots: 3, capped: false })
  })

  test('fires what is left when asked for more', () => {
    expect(planFire(2, 10, 'block')).toEqual({ proceed: true, empty: false, shots: 2, capped: true })
  })

  test('empty: blocked', () => {
    expect(planFire(0, 1, 'block')).toEqual({ proceed: false, empty: true, shots: 0, capped: false })
  })

  test('empty: warned, rolls anyway, spends nothing', () => {
    expect(planFire(0, 3, 'warn')).toEqual({ proceed: true, empty: true, shots: 0, capped: false })
  })

  test('a missing shot count means one shot', () => {
    expect(planFire(5, NaN, 'block').shots).toBe(1)
  })
})

describe('resolveUnit', () => {
  test('configured unit wins', () => {
    expect(resolveUnit('rounds', glock)).toBe('rounds')
    expect(resolveUnit('magazines', revolver)).toBe('magazines')
  })

  test('automatic: magazines for magazine weapons, rounds for individual loading and single shots', () => {
    expect(resolveUnit('', glock)).toBe('magazines')
    expect(resolveUnit(undefined, rifle)).toBe('magazines')
    expect(resolveUnit('', revolver)).toBe('rounds')
    expect(resolveUnit('', bow)).toBe('rounds')
  })
})

describe('planReload', () => {
  describe('magazine weapons', () => {
    test('from empty: a fresh magazine, nothing chambered', () => {
      expect(planReload(glock, 0, 'magazines', null)).toEqual({
        ok: true,
        newLoaded: 17,
        added: 17,
        itemUsed: 0,
        leftInOldMagazine: 0,
        seconds: 3,
      })
    })

    test('tactical reload keeps the chambered round', () => {
      expect(planReload(glock, 5, 'magazines', null)).toMatchObject({
        ok: true,
        newLoaded: 18,
        added: 13,
        leftInOldMagazine: 4,
      })
    })

    test('17 of 17+1 (reloaded from empty) can still top up to 18', () => {
      expect(planReload(glock, 17, 'magazines', null)).toMatchObject({ ok: true, newLoaded: 18, leftInOldMagazine: 16 })
    })

    test('no chamber: partial magazine is swapped out', () => {
      expect(planReload(rifle, 12, 'magazines', null)).toMatchObject({ ok: true, newLoaded: 30, leftInOldMagazine: 12 })
    })

    test('full: refused', () => {
      expect(planReload(glock, 18, 'magazines', null)).toMatchObject({ ok: false, reason: 'full', newLoaded: 18 })
      expect(planReload(rifle, 30, 'magazines', 3)).toMatchObject({ ok: false, reason: 'full', itemUsed: 0 })
    })

    test('uses one magazine from the ammo item', () => {
      expect(planReload(rifle, 0, 'magazines', 3)).toMatchObject({ ok: true, newLoaded: 30, itemUsed: 1 })
    })

    test('no magazines left: refused', () => {
      expect(planReload(rifle, 0, 'magazines', 0)).toMatchObject({ ok: false, reason: 'no-ammo', newLoaded: 0 })
    })

    test('topped up from loose rounds: nothing lost', () => {
      expect(planReload(rifle, 12, 'rounds', 100)).toMatchObject({
        ok: true,
        newLoaded: 30,
        added: 18,
        itemUsed: 18,
        leftInOldMagazine: 0,
      })
    })

    test('loose rounds running short load what there is', () => {
      expect(planReload(rifle, 12, 'rounds', 5)).toMatchObject({ ok: true, newLoaded: 17, added: 5, itemUsed: 5 })
    })

    test('no loose rounds: refused', () => {
      expect(planReload(rifle, 12, 'rounds', 0)).toMatchObject({ ok: false, reason: 'no-ammo' })
    })
  })

  describe('individually loaded weapons', () => {
    test('one round per reload', () => {
      expect(planReload(revolver, 2, 'rounds', null)).toEqual({
        ok: true,
        newLoaded: 3,
        added: 1,
        itemUsed: 0,
        leftInOldMagazine: 0,
        seconds: 3,
      })
    })

    test('uses one round from the ammo item', () => {
      expect(planReload(revolver, 0, 'rounds', 12)).toMatchObject({ ok: true, newLoaded: 1, itemUsed: 1 })
    })

    test('a tube plus chamber loads up to capacity + 1', () => {
      expect(planReload(shotgun, 5, 'rounds', null)).toMatchObject({ ok: true, newLoaded: 6 })
      expect(planReload(shotgun, 6, 'rounds', null)).toMatchObject({ ok: false, reason: 'full' })
    })

    test('no rounds left: refused', () => {
      expect(planReload(revolver, 0, 'rounds', 0)).toMatchObject({ ok: false, reason: 'no-ammo' })
    })
  })

  test('single shot bow takes one arrow', () => {
    expect(planReload(bow, 0, 'rounds', 20)).toMatchObject({ ok: true, newLoaded: 1, itemUsed: 1, seconds: 2 })
  })

  test('untracked weapons are refused', () => {
    expect(planReload(parseShots('Sp'), 0, 'rounds', null)).toMatchObject({ ok: false, reason: 'untracked' })
    expect(planReload(parseShots('T(1)'), 0, 'rounds', null)).toMatchObject({ ok: false, reason: 'untracked' })
  })

  test('a stored value above capacity counts as full', () => {
    expect(planReload(rifle, 45, 'magazines', null)).toMatchObject({ ok: false, reason: 'full', newLoaded: 30 })
  })
})

describe('ammo items', () => {
  const carried = {
    '00000': {
      name: 'Backpack',
      count: 1,
      contains: {
        '00000': { name: '9mm Magazine (17)', count: 0 },
        '00001': { name: '9mm Magazine (17)', count: 2 },
        '00002': { name: 'Arrows', count: '12' },
      },
    },
    '00001': { name: '5.56mm Magazine', count: 4 },
    '00002': { name: 'Shotgun Shells', count: 'lots' },
  }
  const entries = equipmentEntries(carried, 'system.equipment.carried.')

  test('flattens equipment with paths and numeric counts', () => {
    expect(entries.map(e => [e.path, e.name, e.count])).toEqual([
      ['system.equipment.carried.00000', 'Backpack', 1],
      ['system.equipment.carried.00000.contains.00000', '9mm Magazine (17)', 0],
      ['system.equipment.carried.00000.contains.00001', '9mm Magazine (17)', 2],
      ['system.equipment.carried.00000.contains.00002', 'Arrows', 12],
      ['system.equipment.carried.00001', '5.56mm Magazine', 4],
      ['system.equipment.carried.00002', 'Shotgun Shells', 0],
    ])
  })

  test('exact match, ignoring case and spacing', () => {
    expect(findAmmoItem(entries, '  arrows ')?.path).toBe('system.equipment.carried.00000.contains.00002')
  })

  test('prefers an entry with some left', () => {
    expect(findAmmoItem(entries, '9mm Magazine (17)')?.count).toBe(2)
  })

  test('prefix, then substring', () => {
    expect(findAmmoItem(entries, '5.56')?.name).toBe('5.56mm Magazine')
    expect(findAmmoItem(entries, 'shells')?.name).toBe('Shotgun Shells')
  })

  test('exact beats prefix', () => {
    const list: EquipmentEntry[] = [
      { path: 'a', name: 'Arrows, bodkin', count: 5 },
      { path: 'b', name: 'Arrows', count: 5 },
    ]
    expect(findAmmoItem(list, 'Arrows')?.path).toBe('b')
  })

  test('no match / no name', () => {
    expect(findAmmoItem(entries, 'Plasma cell')).toBeUndefined()
    expect(findAmmoItem(entries, '')).toBeUndefined()
  })

  test('the Ammo field: GCS stores 0, GCA stores a name', () => {
    expect(ammoFieldName(0)).toBe('')
    expect(ammoFieldName('0')).toBe('')
    expect(ammoFieldName('')).toBe('')
    expect(ammoFieldName(undefined)).toBe('')
    expect(ammoFieldName(' 9mm Magazine ')).toBe('9mm Magazine')
  })
})

describe('findThrownItem', () => {
  const entries: EquipmentEntry[] = [
    { path: 'system.equipment.carried.00000', name: 'Throwing Knife', count: 3 },
    { path: 'system.equipment.carried.00001', name: 'Spear', count: 1, itemid: 'item1' },
  ]

  test('by name', () => {
    expect(findThrownItem(entries, { name: 'Throwing Knife', mode: 'Thrown' })?.count).toBe(3)
  })

  test('by original name', () => {
    expect(findThrownItem(entries, { name: 'Knife (custom)', originalName: 'throwing knife' })?.count).toBe(3)
  })

  test('Foundry items: by item id, then by the name before " - mode"', () => {
    expect(findThrownItem(entries, { name: 'Pointy - Thrown', fromItem: 'item1' })?.name).toBe('Spear')
    expect(findThrownItem(entries, { name: 'Throwing Knife - Thrown', fromItem: 'other' })?.count).toBe(3)
  })

  test('nothing matching', () => {
    expect(findThrownItem(entries, { name: 'Rock' })).toBeUndefined()
  })
})

describe('matchWeapons', () => {
  const weapons = flattenList<RangedLike>(
    {
      '00000': { name: 'Glock 17', mode: 'Shooting' },
      '00001': { name: 'M16A2', mode: 'Rifle' },
      '00002': { name: 'M16A2', mode: 'M203' },
      '00003': { name: 'Glock 18', mode: '' },
    },
    'system.ranged.'
  )
  const names = (query: string) => matchWeapons(weapons, query).map(w => weaponLabel(w.value))

  test('exact name (mode)', () => {
    expect(names('m16a2 (m203)')).toEqual(['M16A2 (M203)'])
  })

  test('exact name beats prefix', () => {
    expect(names('Glock 17')).toEqual(['Glock 17 (Shooting)'])
  })

  test('prefix', () => {
    expect(names('glock')).toEqual(['Glock 17 (Shooting)', 'Glock 18'])
  })

  test('name shared by two usages', () => {
    expect(names('M16A2')).toEqual(['M16A2 (Rifle)', 'M16A2 (M203)'])
  })

  test('substring', () => {
    expect(names('203')).toEqual(['M16A2 (M203)'])
  })

  test('nothing', () => {
    expect(names('Barrett')).toEqual([])
    expect(names('')).toEqual([])
  })
})
