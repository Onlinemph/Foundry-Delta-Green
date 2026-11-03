import {
  casualtyPenaltyFromHP,
  casualtyPenaltyFromSeverity,
  cufTraitMods,
  frightTarget,
  isNearMiss,
  isSilenced,
  mergePending,
  worstTrigger,
} from '../../module/agency/suppression/cuf-rules.ts'

describe('Cool Under Fire (Tactical Shooting p. 34)', () => {
  test('a near miss is a miss by 1 or 2, never a critical failure', () => {
    expect(isNearMiss(-1, true, false)).toBe(true)
    expect(isNearMiss(-2, true, false)).toBe(true)
    expect(isNearMiss(-3, true, false)).toBe(false)
    expect(isNearMiss(0, false, false)).toBe(false)
    expect(isNearMiss(-1, true, true)).toBe(false)
  })

  test('casualty penalty: -1 at 0 HP, -2 at -HP', () => {
    expect(casualtyPenaltyFromHP(5, 10)).toBe(0)
    expect(casualtyPenaltyFromHP(0, 10)).toBe(-1)
    expect(casualtyPenaltyFromHP(-9, 10)).toBe(-1)
    expect(casualtyPenaltyFromHP(-10, 10)).toBe(-2)
    expect(casualtyPenaltyFromHP(-25, 10)).toBe(-3)
  })

  test('casualty penalty from house-rule wound severity', () => {
    expect(casualtyPenaltyFromSeverity('major')).toBe(0)
    expect(casualtyPenaltyFromSeverity('critical')).toBe(-1)
    expect(casualtyPenaltyFromSeverity('massive')).toBe(-2)
    expect(casualtyPenaltyFromSeverity(null)).toBe(0)
  })

  test('silenced weapons', () => {
    expect(isSilenced('MP5SD (suppressed)')).toBe(true)
    expect(isSilenced('Pistol with silencer')).toBe(true)
    expect(isSilenced('Glock 17')).toBe(false)
  })

  test('merging events keeps every trigger and the worst value of each modifier', () => {
    const merged = mergePending(
      { triggers: ['nearMiss'], mods: [{ key: 'heat', mod: 5 }, { key: 'silenced', mod: 1 }, { key: 'rof', mod: -1 }] },
      { triggers: ['wounded'], mods: [{ key: 'heat', mod: 5 }, { key: 'silenced', mod: 0 }, { key: 'rof', mod: -3 }] }
    )
    expect(merged.triggers).toEqual(['nearMiss', 'wounded'])
    const mod = (key: string) => merged.mods.find(m => m.key === key)?.mod
    expect(mod('heat')).toBe(5)
    expect(mod('silenced')).toBe(0)
    expect(mod('rof')).toBe(-3)
  })

  test('the worst trigger decides the SAN loss', () => {
    expect(worstTrigger(['nearMiss', 'allyDown', 'blast'])).toBe('allyDown')
    expect(worstTrigger([])).toBeNull()
  })

  test('Bloodlust and Callous', () => {
    expect(cufTraitMods(['Bloodlust (12)', 'Callous'])).toEqual([
      { label: 'Bloodlust', mod: 2 },
      { label: 'Callous', mod: 1 },
    ])
  })

  test('Will-based Soldier can replace Will; Rule of 14 caps the target at 13', () => {
    expect(frightTarget(10, null, [5, -2])).toBe(13)
    expect(frightTarget(10, 12, [-1])).toBe(11)
    expect(frightTarget(12, 9, [])).toBe(12)
    expect(frightTarget(10, null, [-3])).toBe(7)
  })
})
