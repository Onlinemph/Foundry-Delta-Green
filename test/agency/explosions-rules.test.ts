import {
  averageDamage,
  maxDamage,
  roll3d6,
  rollDamage,
  scriptedRng,
  seededRng,
} from '../../module/agency/explosions/dice.ts'
import { parseExplosive } from '../../module/agency/explosions/parse.ts'
import {
  afflictionRoll,
  AREA_ATTACK_BONUS,
  blastArmorDivisor,
  blastRadius,
  bodyCoverDR,
  canDive,
  canSmother,
  catchingFire,
  chargeDice,
  collateralDamage,
  collateralDivisor,
  contactDamage,
  diceFromCount,
  diveEffect,
  effectiveCoverDR,
  fragmentAttack,
  fragmentRadius,
  fragmentsAfterDive,
  INTERNAL_EXPLOSION,
  knockback,
  largeAreaDR,
  largeAreaInjury,
  postureModifier,
  poundsForDamage,
  rangePenalty,
  scatter,
  successRoll,
  throughCover,
  wallCoverDR,
} from '../../module/agency/explosions/rules.ts'
import {
  afflictionBonus,
  EXPLOSIVES,
  findExplosive,
  matchSpecials,
  parseWeight,
  summarizeSpecials,
} from '../../module/agency/explosions/specials.ts'

const c = (text: string) => parseExplosive(text)!.components[0]

describe('dice', () => {
  test('seeded rolls repeat', () => {
    const a = seededRng(42)
    const b = seededRng(42)
    expect([roll3d6(a), roll3d6(a), roll3d6(a)]).toEqual([roll3d6(b), roll3d6(b), roll3d6(b)])
  })

  test('scripted faces', () => {
    expect(roll3d6(scriptedRng([1, 2, 3]))).toBe(6)
    expect(rollDamage({ dice: 2, adds: 1, multiplier: 1 }, scriptedRng([6, 6])).total).toBe(13)
  })

  test('multiplier applies after adds: 6d×2 rolled 21 does 42 (B378)', () => {
    expect(rollDamage({ dice: 6, adds: 0, multiplier: 2 }, scriptedRng([6, 5, 4, 3, 2, 1])).total).toBe(42)
  })

  test('minimum damage (B378): crushing 0, others 1', () => {
    expect(rollDamage({ dice: 1, adds: -4, multiplier: 1 }, scriptedRng([1]), 'cr').total).toBe(0)
    expect(rollDamage({ dice: 1, adds: -4, multiplier: 1 }, scriptedRng([1]), 'cut').total).toBe(1)
  })

  test('max and average', () => {
    expect(maxDamage({ dice: 4, adds: 2, multiplier: 1 })).toBe(26)
    expect(maxDamage({ dice: 6, adds: 0, multiplier: 2 })).toBe(72)
    expect(averageDamage({ dice: 2, adds: 0, multiplier: 1 })).toBe(7)
  })

  test('d6 faces stay in 1..6 over many rolls', () => {
    const rng = seededRng(7)
    for (let i = 0; i < 2000; i++) {
      const r = roll3d6(rng)
      expect(r).toBeGreaterThanOrEqual(3)
      expect(r).toBeLessThanOrEqual(18)
    }
  })
})

describe('radii (B414)', () => {
  test('collateral reaches 2 × dice yards; 6d×2 reaches 24 yards (B414 example)', () => {
    expect(blastRadius(c('6d×2 cr ex'))).toBe(24)
    expect(blastRadius(c('4d+2 cr ex'))).toBe(8)
    expect(blastRadius(c('2d+2 pi'))).toBe(0)
  })

  test('fragments reach 5 × dice yards; [2d] reaches 10 yards (B414 example)', () => {
    expect(fragmentRadius(c('4d cr ex [2d]').fragments)).toBe(10)
    expect(fragmentRadius(c('8d [1d-4] cr ex').fragments)).toBe(5)
    expect(fragmentRadius(null)).toBe(0)
  })
})

describe('collateral damage (B414)', () => {
  test('divide by 3 × yards, rounding down', () => {
    expect(collateralDamage(20, 2)).toEqual({ damage: 3, divisor: 6 })
    expect(collateralDamage(20, 7)).toEqual({ damage: 0, divisor: 21 })
  })

  test('the target struck takes it as is', () => {
    expect(collateralDamage(20, 0, { struck: true })).toEqual({ damage: 20, divisor: 1 })
  })

  test('the blast hex counts as 1 yard (interpretation)', () => {
    expect(collateralDivisor(0)).toBe(3)
    expect(collateralDamage(20, 0)).toEqual({ damage: 6, divisor: 3 })
  })

  test('environments (B415, HT170, HT187)', () => {
    expect(collateralDivisor(2, 'thermobaric')).toBe(4)
    expect(collateralDivisor(2, 'underwater')).toBe(2)
    expect(collateralDivisor(2, 'vacuum')).toBe(20)
  })

  test('enclosed spaces double it, or ×1.5 with doors and windows (HT181)', () => {
    expect(collateralDamage(30, 2, { enclosed: 2 }).damage).toBe(10)
    expect(collateralDamage(30, 2, { enclosed: 1.5 }).damage).toBe(7)
    expect(collateralDamage(30, 0, { struck: true, enclosed: 2 }).damage).toBe(60)
  })

  test("the explosive's armor divisor only applies to the target it strikes (B414)", () => {
    const heat = c('6d×3(10) cr ex')
    expect(blastArmorDivisor(heat, true)).toBe(10)
    expect(blastArmorDivisor(heat, false)).toBe(0)
    expect(blastArmorDivisor(c('4d cr ex'), true)).toBe(0)
  })

  test('contact explosions do maximum damage; the rest get torso DR + HP as cover (B415)', () => {
    expect(contactDamage({ dice: 4, adds: 1, multiplier: 1 })).toBe(25)
    expect(bodyCoverDR(12, 11)).toBe(23)
  })

  test('internal explosions ignore DR and hit the vitals ×3 (B415)', () => {
    expect(INTERNAL_EXPLOSION).toEqual({ ignoresDR: true, location: 'Vitals', woundingModifier: 3 })
  })
})

describe('Size and Speed/Range Table (B550)', () => {
  test.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, -1],
    [4, -2],
    [5, -2],
    [6, -3],
    [7, -3],
    [8, -4],
    [10, -4],
    [11, -5],
    [15, -5],
    [20, -6],
    [21, -7],
    [30, -7],
    [50, -8],
    [70, -9],
    [100, -10],
    [150, -11],
    [200, -12],
    [1000, -16],
  ])('%p yards -> %p', (yards, penalty) => expect(rangePenalty(yards)).toBe(penalty))
})

describe('fragments (B414)', () => {
  test('posture: every non-standing posture is -2 (B551); airbursts ignore it (B415)', () => {
    expect(postureModifier('standing')).toBe(0)
    expect(postureModifier('down')).toBe(-2)
    expect(postureModifier('down', true)).toBe(0)
  })

  test('skill 15 + range + posture + SM; one extra hit per 3 points of success', () => {
    const attack = fragmentAttack({ yards: 5, posture: 'standing', sizeModifier: 0, roll: 6 })
    expect(attack.effective).toBe(13)
    expect(attack.margin).toBe(7)
    expect(attack.hits).toBe(3)
    expect(attack.success).toBe(true)
  })

  test('a prone small target far away', () => {
    const attack = fragmentAttack({ yards: 10, posture: 'down', sizeModifier: -1, roll: 9 })
    expect(attack.effective).toBe(8)
    expect(attack.hits).toBe(0)
  })

  test('exactly making it is one hit', () => {
    expect(fragmentAttack({ yards: 3, posture: 'standing', sizeModifier: 0, roll: 14 }).hits).toBe(1)
  })

  test('17+ always misses; 3-4 always hit (B556)', () => {
    expect(fragmentAttack({ yards: 1, posture: 'standing', sizeModifier: 0, roll: 17 }).hits).toBe(0)
    const crit = fragmentAttack({ yards: 100, posture: 'down', sizeModifier: 0, roll: 4 })
    expect(crit.success).toBe(true)
    expect(crit.critical).toBe(true)
    expect(crit.hits).toBe(1)
  })

  test('the target struck is hit automatically', () => {
    const attack = fragmentAttack({ yards: 0, posture: 'standing', sizeModifier: 0, struck: true, roll: null })
    expect(attack).toMatchObject({ automatic: true, hits: 1 })
  })

  test('successRoll: 5 is critical at 15, 6 at 16', () => {
    expect(successRoll(5, 15).critical).toBe(true)
    expect(successRoll(5, 14).critical).toBe(false)
    expect(successRoll(6, 16).critical).toBe(true)
    expect(successRoll(16, 18).success).toBe(true)
  })
})

describe('diving for cover (B377, B414)', () => {
  test('anyone caught may dive, except the target struck', () => {
    expect(canDive({ struck: false, inBlast: true, inFragments: false })).toBe(true)
    expect(canDive({ struck: false, inBlast: false, inFragments: true })).toBe(true)
    expect(canDive({ struck: true, inBlast: true, inFragments: true })).toBe(false)
    expect(canDive({ struck: false, inBlast: false, inFragments: false })).toBe(false)
  })

  test('success: a step farther, stops 1 + margin fragments, reaches cover a step away, prone', () => {
    expect(diveEffect({ success: true, margin: 2, coverStep: true })).toEqual({
      extraYards: 1,
      fragmentsStopped: 3,
      reachedCover: true,
      prone: true,
    })
  })

  test('failure: the blast hits first, then you drop prone', () => {
    expect(diveEffect({ success: false, margin: -3 })).toEqual({
      extraYards: 0,
      fragmentsStopped: 0,
      reachedCover: false,
      prone: true,
    })
    expect(diveEffect(null).prone).toBe(false)
  })

  test('critical fragment hits stay', () => {
    const effect = diveEffect({ success: true, margin: 5 })
    expect(fragmentsAfterDive(3, false, effect)).toBe(0)
    expect(fragmentsAfterDive(3, true, effect)).toBe(3)
    expect(fragmentsAfterDive(4, false, diveEffect({ success: true, margin: 0 }))).toBe(3)
  })

  test('smothering needs to be within a step', () => {
    expect(canSmother(1, false)).toBe(true)
    expect(canSmother(2, false)).toBe(false)
    expect(canSmother(0, true)).toBe(false)
  })
})

describe('cover (B407-408)', () => {
  test('cover DR, with an armor divisor applied to it', () => {
    expect(effectiveCoverDR(12)).toBe(12)
    expect(effectiveCoverDR(12, 2)).toBe(6)
    expect(effectiveCoverDR(12, 0.5)).toBe(24)
    expect(effectiveCoverDR(12, -1)).toBe(0)
    expect(effectiveCoverDR(0, 2)).toBe(0)
  })

  test('damage through cover', () => {
    expect(throughCover(10, 6)).toBe(4)
    expect(throughCover(5, 6)).toBe(0)
    expect(throughCover(7, 6, 0.2)).toBe(0)
  })

  test('walls add up; airbursts ignore them (B415)', () => {
    expect(wallCoverDR([6, 6])).toBe(12)
    expect(wallCoverDR([6, 6], true)).toBe(0)
    expect(wallCoverDR([])).toBe(0)
  })
})

describe('large-area injury (B400)', () => {
  test('average of torso DR and the least protected exposed location, rounding up', () => {
    expect(largeAreaDR(12, [12, 2, 4])).toBe(7)
    expect(largeAreaDR(0, [])).toBe(0)
    expect(largeAreaDR(5, [5])).toBe(5)
  })

  test('treated as a torso hit', () => {
    expect(largeAreaInjury({ damage: 10, effectiveDR: 4, type: 'cr' })).toEqual({ penetrating: 6, injury: 6, dr: 4 })
    expect(largeAreaInjury({ damage: 10, effectiveDR: 4, type: 'cut' })).toEqual({ penetrating: 6, injury: 9, dr: 4 })
    expect(largeAreaInjury({ damage: 10, effectiveDR: 8, type: 'cr', armorDivisor: 2 }).dr).toBe(4)
  })
})

describe('knockback (B378)', () => {
  test('one yard per full ST-2 of crushing damage', () => {
    expect(knockback({ damage: 16, type: 'cr', st: 10, hp: 10 })).toEqual({ yards: 2, rollModifier: -1 })
    expect(knockback({ damage: 7, type: 'cr', st: 10, hp: 10 })).toBeNull()
  })

  test('ST 3 or less: a yard per point; no ST: use HP', () => {
    expect(knockback({ damage: 4, type: 'cr', st: 2, hp: 5 })!.yards).toBe(4)
    expect(knockback({ damage: 20, type: 'cr', st: null, hp: 12 })!.yards).toBe(2)
  })

  test('dkb doubles, nkb cancels, cutting and burning blasts do none', () => {
    expect(knockback({ damage: 8, type: 'cr', st: 10, hp: 10, modifiers: ['dkb'] })!.yards).toBe(2)
    expect(knockback({ damage: 80, type: 'cr', st: 10, hp: 10, modifiers: ['nkb'] })).toBeNull()
    expect(knockback({ damage: 80, type: 'burn', st: 10, hp: 10 })).toBeNull()
  })
})

describe('scatter (B414)', () => {
  test('miss by the margin of failure, at most half the distance (round up)', () => {
    expect(scatter({ marginOfFailure: 3, distanceToTarget: 20, directionRoll: 1 })).toEqual({
      yards: 3,
      direction: 1,
      degrees: 0,
    })
    expect(scatter({ marginOfFailure: 9, distanceToTarget: 7, directionRoll: 4 })).toEqual({
      yards: 4,
      direction: 4,
      degrees: 180,
    })
  })

  test("a dodge uses the defender's margin of success", () => {
    expect(scatter({ marginOfFailure: 9, dodgeMargin: 2, distanceToTarget: 20, directionRoll: 2 }).yards).toBe(2)
  })

  test('flying/underwater or unseen Artillery/Dropping: the square of the margin', () => {
    expect(scatter({ marginOfFailure: 3, distanceToTarget: 100, squared: true, directionRoll: 6 })).toEqual({
      yards: 9,
      direction: 6,
      degrees: 300,
    })
  })

  test('direction roll is clamped to 1-6', () => {
    expect(scatter({ marginOfFailure: 1, distanceToTarget: 10, directionRoll: 9 }).direction).toBe(6)
  })

  test('attacking an area is +4 (B414)', () => expect(AREA_ATTACK_BONUS).toBe(4))
})

describe('afflictions and fire', () => {
  test('stun grenade: HT-5, +5 per protected sense (HT193)', () => {
    expect(afflictionRoll({ ht: 11, htModifier: -5, bonus: 0, roll: 7 })).toMatchObject({
      target: 6,
      roll: 7,
      success: false,
    })
    expect(afflictionRoll({ ht: 11, htModifier: -5, bonus: 10, roll: 14 })).toMatchObject({ target: 16, success: true })
  })

  test('catching fire (B434)', () => {
    expect(catchingFire(2)).toBe('none')
    expect(catchingFire(3)).toBe('partial')
    expect(catchingFire(10)).toBe('all')
  })
})

describe('how big a blast (B415, HT182-186)', () => {
  test('a pound of TNT is 6d×2', () => {
    expect(chargeDice(1, 1)).toBeCloseTo(12)
    expect(diceFromCount(chargeDice(1, 1))).toEqual({ dice: 6, adds: 0, multiplier: 2 })
  })

  test("the book's examples", () => {
    // 0.5-lb stick of 80% dynamite: 9d+1 (HT185)
    expect(diceFromCount(chargeDice(0.5, 1.2))).toEqual({ dice: 9, adds: 1, multiplier: 1 })
    // 4 oz of nitroglycerin: 7d+1 (HT184)
    expect(diceFromCount(chargeDice(0.25, 1.5))).toEqual({ dice: 7, adds: 1, multiplier: 1 })
    // 0.25-lb block of plastique: 7d (HT186)
    expect(diceFromCount(chargeDice(0.25, 1.4))).toEqual({ dice: 7, adds: 0, multiplier: 1 })
    // 0.1-lb blob of extrudable explosive: 4d+2 (HT187)
    expect(diceFromCount(chargeDice(0.1, 1.4))).toEqual({ dice: 4, adds: 2, multiplier: 1 })
    // 0.1-lb of foam explosive: 4d (HT187)
    expect(diceFromCount(chargeDice(0.1, 1.1))).toEqual({ dice: 4, adds: 0, multiplier: 1 })
    // 0.9-lb aerosol can of foam: 6d×2 (HT187)
    expect(diceFromCount(chargeDice(0.9, 1.1))).toEqual({ dice: 6, adds: 0, multiplier: 2 })
  })

  test('big charges keep the right total', () => {
    const expr = diceFromCount(chargeDice(12000, 1))
    expect(Math.abs(expr.dice * expr.multiplier - chargeDice(12000, 1))).toBeLessThan(expr.dice)
  })

  test('how much explosive: 6d×8 of dynamite (REF 0.8 in B415) takes 20 lbs (B415 example)', () => {
    expect(poundsForDamage(8, 0.8)).toBe(20)
    expect(poundsForDamage(2)).toBe(1)
  })

  test('tiny amounts still roll something', () => {
    expect(diceFromCount(0.5)).toEqual({ dice: 1, adds: -2, multiplier: 1 })
    expect(diceFromCount(0)).toEqual({ dice: 0, adds: 0, multiplier: 1 })
  })
})

describe('specials data', () => {
  test('stun grenade by name or by "HT-5 aff" damage (HT193)', () => {
    const byName = matchSpecials({ name: 'Schermuly Stun Grenade', damage: '' })
    expect(byName.ids).toContain('stun')
    expect(byName.affliction).toMatchObject({ htModifier: -5, radius: 10, status: 'stun', recovery: -5 })
    expect(byName.smoke?.radius).toBe(10)
    const byDamage = matchSpecials({
      name: 'Grenade',
      damage: 'HT-5 aff (10 yd.)',
      spec: parseExplosive('HT-5 aff (10 yd.)'),
    })
    expect(byDamage.ids).toContain('stun')
    expect(matchSpecials({ name: 'M84 Flashbang' }).ids).toContain('stun')
    expect(matchSpecials({ name: 'flash-bang' }).ids).toContain('stun')
  })

  test('smoke takes the radius from the damage text (HT192)', () => {
    const m = matchSpecials({ name: 'AN-M8', damage: 'Smoke (7 yd.)', spec: parseExplosive('Smoke (7 yd.)') })
    expect(m.smoke).toEqual({ radius: 7, seconds: 80 })
    const named = matchSpecials({
      name: 'M18 Smoke Grenade',
      damage: 'Smoke (7 yd.)',
      spec: parseExplosive('Smoke (7 yd.)'),
    })
    expect(named.smoke).toEqual({ radius: 7, seconds: 80 })
  })

  test('white phosphorus: hot fragments and a 5-yard cloud (HT193)', () => {
    const m = matchSpecials({
      name: 'M34 WP',
      damage: '2d [1d(0.2)] burn ex',
      spec: parseExplosive('2d [1d(0.2)] burn ex'),
    })
    expect(m.hotFragments).toBe(true)
    expect(m.smoke?.radius).toBe(5)
  })

  test('thermobaric divides by 2 × yards; airbursts ignore posture', () => {
    expect(matchSpecials({ name: '40mm Thermobaric' }).environment).toBe('thermobaric')
    expect(matchSpecials({ name: '20mm HE-AB' }).airburst).toBe(true)
    expect(matchSpecials({ name: 'M67' }).environment).toBe('normal')
    expect(matchSpecials({ name: 'M67' }).ids).toEqual([])
  })

  test('protection bonuses come from trait names; the summary is JSON-safe', () => {
    const m = matchSpecials({ name: 'Flashbang' })
    expect(afflictionBonus(m, ['Protected Hearing', 'Protected Vision (Sunglasses)'])).toBe(10)
    expect(afflictionBonus(m, ['Hard of Hearing'])).toBe(0)
    const summary = summarizeSpecials(m)
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary)
    expect(summary.affliction).toEqual({ htModifier: -5, radius: 10, status: 'stun', recovery: -5 })
  })

  test('tear gas', () => {
    expect(matchSpecials({ name: '40mm Tear Gas' }).gas).toEqual({ radius: 7, seconds: 25 })
  })

  test('explosives and weights', () => {
    expect(findExplosive('C4')?.ref).toBe(1.4)
    expect(findExplosive('  semtex ')?.ref).toBe(1.4)
    expect(findExplosive('unobtainium')).toBeUndefined()
    expect(EXPLOSIVES.every(e => e.ref > 0)).toBe(true)
    expect(parseWeight('2lb')).toBe(2)
    expect(parseWeight('1.25 lbs')).toBe(1.25)
    expect(parseWeight('4 oz')).toBe(0.25)
    expect(parseWeight('1kg')).toBeCloseTo(2.2046)
    expect(parseWeight('heavy')).toBeNull()
  })
})
