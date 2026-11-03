import {
  carriedAcc,
  carryOverApplies,
  effectiveRcl,
  guessWeaponClass,
  gunslingerAcc,
  gunslingerHalvedPenalty,
  hitsAfterDodge,
  outcomeOf,
  parseRcl,
  planBurst,
  recoilPenalties,
  resolveBurst,
  roundHalfUp,
} from '../../module/agency/shooting/engine.ts'

describe('parseRcl', () => {
  test.each([
    ['2', 2],
    ['1.75', 1.75],
    ['2.3', 2.3],
    [3, 3],
    ['1/2', 0.5],
    ['0', 0.5],
    ['0.25', 0.5],
    ['.5', 0.5],
    ['2 ', 2],
  ])('%p -> %p', (input, expected) => expect(parseRcl(input)).toBeCloseTo(expected as number))

  test.each([[''], [null], [undefined], ['-'], ['abc']])('%p -> null', input => expect(parseRcl(input)).toBeNull())
})

describe('roundHalfUp', () => {
  test('rounds .5 up and survives float error', () => {
    expect(roundHalfUp(4.6000000000000005)).toBe(5)
    expect(roundHalfUp(2.5)).toBe(3)
    expect(roundHalfUp(2.3)).toBe(2)
    expect(roundHalfUp(1.5)).toBe(2)
  })
})

describe('effectiveRcl (bracing)', () => {
  test('doc examples: Rcl 2 -> 1, Rcl 3 -> 2, Rcl 1 -> 1', () => {
    expect(effectiveRcl(2, true)).toBe(1)
    expect(effectiveRcl(3, true)).toBe(2)
    expect(effectiveRcl(1, true)).toBe(1)
  })
  test('unbraced keeps the base Rcl', () => expect(effectiveRcl(2.3, false)).toBe(2.3))
  test('fractional Rcl braced rounds half up', () => {
    expect(effectiveRcl(2.3, true)).toBe(1) // 1.15
    expect(effectiveRcl(2.5, true)).toBe(1) // 1.25
    expect(effectiveRcl(3.5, true)).toBe(2) // 1.75
  })
})

describe('recoilPenalties', () => {
  test('cumulative: shot n is -(n-1) x Rcl', () => {
    expect(recoilPenalties(4, 2, false)).toEqual([0, -2, -4, -6])
  })
  test('natural Rcl 1 is a flat -1 after the first shot', () => {
    expect(recoilPenalties(5, 1, false)).toEqual([0, -1, -1, -1, -1])
  })
  test('natural Rcl 1 braced still uses the flat rule', () => {
    expect(recoilPenalties(3, 1, true)).toEqual([0, -1, -1])
  })
  test('braced down to Rcl 1 stays cumulative', () => {
    expect(recoilPenalties(4, 2, true)).toEqual([0, -1, -2, -3])
  })
  test('fractional Rcl rounds each cumulative penalty to nearest', () => {
    // Rcl 2.3: 2.3 -> 2, 4.6 -> 5, 6.9 -> 7
    expect(recoilPenalties(4, 2.3, false)).toEqual([0, -2, -5, -7])
    // Rcl 1.75: 1.75 -> 2, 3.5 -> 4, 5.25 -> 5
    expect(recoilPenalties(4, 1.75, false)).toEqual([0, -2, -4, -5])
  })
  test('single shot has no penalty; zero shots is empty', () => {
    expect(recoilPenalties(1, 3, false)).toEqual([0])
    expect(recoilPenalties(0, 3, false)).toEqual([])
  })
})

describe('planBurst', () => {
  test('aim on the first shot only; bracing Acc on every shot', () => {
    const plan = planBurst({ baseTarget: 12, aimBonus: 3, braceAcc: 1, braced: true, rcl: 2, shots: 3 })
    expect(plan.map(s => s.target)).toEqual([16, 12, 11])
  })
  test('unbraced ignores the bracing bonus', () => {
    const plan = planBurst({ baseTarget: 12, aimBonus: 2, braceAcc: 1, braced: false, rcl: 3, shots: 3 })
    expect(plan.map(s => s.target)).toEqual([14, 9, 6])
  })
})

describe('outcomeOf', () => {
  test.each([
    [3, 5, 'critical'],
    [4, 3, 'critical'],
    [5, 15, 'critical'],
    [5, 14, 'hit'],
    [6, 16, 'critical'],
    [6, 15, 'hit'],
    [10, 10, 'hit'],
    [11, 10, 'miss'],
    [17, 16, 'miss'],
    [17, 15, 'fumble'],
    [18, 20, 'fumble'],
    [16, 6, 'fumble'],
    [15, 6, 'miss'],
  ])('roll %p vs %p -> %p', (roll, target, expected) => expect(outcomeOf(roll, target)).toBe(expected))
})

describe('resolveBurst and dodging', () => {
  const plan = planBurst({ baseTarget: 12, aimBonus: 0, braceAcc: 1, braced: false, rcl: 2, shots: 4 })
  // targets 12, 10, 8, 6
  test('each successful roll is one hit; crits counted separately', () => {
    const result = resolveBurst(plan, [3, 9, 9, 7])
    expect(result.shots.map(s => s.outcome)).toEqual(['critical', 'hit', 'miss', 'miss'])
    expect(result.hits).toBe(2)
    expect(result.criticalHits).toBe(1)
    expect(result.dodgeableHits).toBe(1)
  })
  test('dodge stops 1 + margin hits, never critical ones', () => {
    const result = { criticalHits: 1, dodgeableHits: 4 }
    expect(hitsAfterDodge(result, null)).toBe(5)
    expect(hitsAfterDodge(result, -1)).toBe(5)
    expect(hitsAfterDodge(result, 0)).toBe(4)
    expect(hitsAfterDodge(result, 2)).toBe(2)
    expect(hitsAfterDodge(result, 10)).toBe(1)
  })
  test('throws when given too few rolls', () => expect(() => resolveBurst(plan, [10])).toThrow())
})

describe('aim carry-over', () => {
  test('single shot keeps half (round down), braced keeps all, bursts keep nothing', () => {
    expect(carriedAcc(1, 5, false)).toBe(2)
    expect(carriedAcc(1, 5, true)).toBe(5)
    expect(carriedAcc(3, 5, true)).toBe(0)
    expect(carriedAcc(1, 0, false)).toBe(0)
  })
  test('applies only to the same weapon and target, through the next round', () => {
    const carry = { weaponKey: 'w1', targetId: 't1', acc: 2, round: 3 }
    expect(carryOverApplies(carry, 'w1', 't1', 4)).toBe(true)
    expect(carryOverApplies(carry, 'w1', 't1', 5)).toBe(false)
    expect(carryOverApplies(carry, 'w2', 't1', 4)).toBe(false)
    expect(carryOverApplies(carry, 'w1', 't2', 4)).toBe(false)
    expect(carryOverApplies(carry, 'w1', null, 4)).toBe(false)
    expect(carryOverApplies({ ...carry, round: null }, 'w1', 't1', null)).toBe(true)
  })
})

describe('Gunslinger', () => {
  test('pistols get full Acc, long arms and auto-pistols half rounded up', () => {
    expect(gunslingerAcc('pistol', 2)).toBe(2)
    expect(gunslingerAcc('autopistol', 3)).toBe(2)
    expect(gunslingerAcc('longarm', 5)).toBe(3)
    expect(gunslingerAcc('longarm', 0)).toBe(0)
  })
  test('halved penalties round in the shooter favour', () => {
    expect(gunslingerHalvedPenalty(-3)).toBe(-1)
    expect(gunslingerHalvedPenalty(-4)).toBe(-2)
    expect(gunslingerHalvedPenalty(-1)).toBe(0)
    expect(gunslingerHalvedPenalty(2)).toBe(2)
  })
  test('weapon class guess from name and bulk', () => {
    expect(guessWeaponClass({ name: 'Glock 17', bulk: '-2', rof: '3' })).toBe('pistol')
    expect(guessWeaponClass({ name: 'Glock 18C', bulk: '-2', rof: '20' })).toBe('autopistol')
    expect(guessWeaponClass({ name: 'M4 Carbine', bulk: '-3', rof: '15' })).toBe('longarm')
    expect(guessWeaponClass({ name: 'Remington 870 Shotgun', bulk: '-5' })).toBe('longarm')
    expect(guessWeaponClass({ name: 'Revolver, .38', bulk: '-2', rof: '1' })).toBe('pistol')
    expect(guessWeaponClass({ name: 'Mystery gun' })).toBe('longarm')
  })
})
