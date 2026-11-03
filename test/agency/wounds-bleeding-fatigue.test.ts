import {
  NOT_BLEEDING,
  applyTreatment,
  bleedInterval,
  bleedingModifier,
  bloodRecovery,
  canRollBleeding,
  canTreat,
  initialBleeding,
  resolveBleedingCheck,
  slowBleeding,
} from '../../module/agency/wounds/bleeding.js'
import {
  actCheckModifiers,
  fatigueBreakpoints,
  fatigueCheckSpec,
  fatigueChecksCrossed,
  fatigueCondition,
  fatigueForSeverity,
  reachedZeroFP,
  resolveFatigueCheck,
} from '../../module/agency/wounds/fatigue.js'
import { bleedingModifiers, emptyState, assessWound, NO_TRAITS } from '../../module/agency/wounds/engine.js'
import { resolveRoll } from '../../module/agency/wounds/rolls.js'
import type { BleedingState, WoundRecord } from '../../module/agency/wounds/types.js'

const options = { trackMinor: false, hemophilia: false }
const tracked = { trackMinor: true, hemophilia: false }

function bleeding(severity: BleedingState['severity'], extra: Partial<BleedingState> = {}): BleedingState {
  return { ...NOT_BLEEDING, severity, ...extra }
}

describe('bleeding table', () => {
  test.each([
    ['scratch', 86400, 1],
    ['minor', 21600, 0],
    ['moderate', 3600, -1],
    ['major', 600, -2],
    ['critical', 120, -3],
    ['massive', 30, -4],
    ['gawdawful', 5, -5],
  ] as const)('%p bleeds 1 FP every %p seconds, HT%p', (severity, seconds, modifier) => {
    expect(bleedInterval(bleeding(severity))).toBe(seconds)
    expect(bleedingModifier(severity)).toBe(modifier)
  })

  it('handles fixed-rate bleeding', () => {
    expect(bleedInterval(bleeding(null, { special: '2fp-per-second' }))).toBe(0.5)
    expect(bleedInterval(bleeding(null, { special: '1fp-per-second' }))).toBe(1)
    expect(bleedInterval(NOT_BLEEDING)).toBeNull()
    expect(canRollBleeding(bleeding('major', { special: '1fp-per-second' }))).toBe(false)
  })

  it('adds Hard to Kill to the bleeding roll', () => {
    expect(bleedingModifiers('major', { ...NO_TRAITS, hardToKill: 2 }).map(m => m.value)).toEqual([-2, 2])
    expect(bleedingModifiers('minor', NO_TRAITS)).toEqual([])
  })
})

describe('initialBleeding', () => {
  it('only bleeds Scratches from cutting damage (and bites)', () => {
    expect(initialBleeding('scratch', 'cut', tracked).severity).toBe('scratch')
    expect(initialBleeding('scratch', 'bite', tracked).severity).toBe('scratch')
    expect(initialBleeding('scratch', 'imp', tracked).severity).toBeNull()
  })

  it('only bleeds Minor wounds from non-crushing damage', () => {
    expect(initialBleeding('minor', 'imp', tracked).severity).toBe('minor')
    expect(initialBleeding('minor', 'cr', tracked).severity).toBeNull()
  })

  it('ignores Minor and Scratch bleeding unless tracked or hemophiliac', () => {
    expect(initialBleeding('minor', 'imp', options).severity).toBeNull()
    expect(initialBleeding('minor', 'imp', { trackMinor: false, hemophilia: true }).severity).toBe('minor')
  })

  it('bleeds Moderate and worse wounds of any type', () => {
    expect(initialBleeding('moderate', 'cr', options).severity).toBe('moderate')
    expect(initialBleeding('gawdawful', 'burn', options).severity).toBe('gawdawful')
    expect(initialBleeding('destroyed', 'cut', options).severity).toBeNull()
  })
})

describe('resolveBleedingCheck', () => {
  it('costs 1 FP on a failure and resets the run of successes', () => {
    const r = resolveBleedingCheck(bleeding('major', { consecutive: 1 }), 12, 10, options)
    expect(r.fpLost).toBe(1)
    expect(r.bleeding).toMatchObject({ severity: 'major', consecutive: 0 })
  })

  it('slows the bleeding after two successes in a row', () => {
    const first = resolveBleedingCheck(bleeding('major'), 9, 10, options)
    expect(first).toMatchObject({ fpLost: 0, slowed: false })
    expect(first.bleeding.consecutive).toBe(1)
    const second = resolveBleedingCheck(first.bleeding, 10, 10, options)
    expect(second).toMatchObject({ fpLost: 0, slowed: true, stopped: false })
    expect(second.bleeding).toMatchObject({ severity: 'moderate', consecutive: 0 })
  })

  it('slows the bleeding at once on a critical success', () => {
    const r = resolveBleedingCheck(bleeding('critical'), 4, 10, options)
    expect(r.slowed).toBe(true)
    expect(r.bleeding.severity).toBe('major')
  })

  it('stops untracked bleeding once it slows below Moderate', () => {
    const r = resolveBleedingCheck(bleeding('moderate', { consecutive: 1 }), 8, 10, options)
    expect(r.stopped).toBe(true)
    expect(r.bleeding.severity).toBeNull()
    const kept = resolveBleedingCheck(bleeding('moderate', { consecutive: 1 }), 8, 10, tracked)
    expect(kept.bleeding.severity).toBe('minor')
  })

  it('stops Minor and Scratch bleeding after any two successes', () => {
    const first = resolveBleedingCheck(bleeding('minor'), 9, 10, tracked)
    expect(first).toMatchObject({ fpLost: 0, stopped: false })
    const failure = resolveBleedingCheck(first.bleeding, 15, 10, tracked)
    expect(failure.fpLost).toBe(1)
    const second = resolveBleedingCheck(failure.bleeding, 9, 10, tracked)
    expect(second.stopped).toBe(true)
    expect(second.bleeding.severity).toBeNull()
  })

  it('always fails a hemophiliac', () => {
    const r = resolveBleedingCheck(bleeding('major'), 3, 10, { trackMinor: false, hemophilia: true })
    expect(r.roll.success).toBe(false)
    expect(r.fpLost).toBe(1)
  })

  it('does nothing for fixed-rate bleeding', () => {
    const r = resolveBleedingCheck(bleeding(null, { special: '2fp-per-second' }), 3, 10, options)
    expect(r.fpLost).toBe(0)
    expect(r.bleeding.special).toBe('2fp-per-second')
  })

  it('slows bleeding one level at a time', () => {
    expect(slowBleeding(bleeding('gawdawful'), options).severity).toBe('massive')
    expect(slowBleeding(bleeding('scratch'), tracked).severity).toBeNull()
  })
})

describe('bandage, stabilize, surgery', () => {
  function wound(): WoundRecord {
    const r = assessWound(
      emptyState(),
      { id: 'x', injury: 10, maxHP: 10, location: 'Torso', damageType: 'cut', emergency: true, created: 0 },
      NO_TRAITS
    )
    return r.state.wounds[0]
  }

  it('allows one bandage attempt, then one stabilize attempt', () => {
    const w = wound()
    expect(canTreat(w, 'bandage')).toBe(true)
    expect(canTreat(w, 'stabilize')).toBe(false)
    const failed = applyTreatment(w, 'bandage', false, options)
    expect(failed).toMatchObject({ bandageAttempted: true, bandaged: false })
    expect(failed.bleeding.severity).toBe('critical')
    expect(canTreat(failed, 'bandage')).toBe(false)
    expect(canTreat(failed, 'stabilize')).toBe(true)
    const stabilized = applyTreatment(failed, 'stabilize', true, options)
    expect(stabilized).toMatchObject({ stabilizeAttempted: true, stabilized: true })
    expect(stabilized.bleeding.severity).toBeNull()
    expect(canTreat(stabilized, 'stabilize')).toBe(false)
    expect(canTreat(stabilized, 'surgery')).toBe(false)
  })

  it('makes a bandaged wound bleed one level lower', () => {
    expect(applyTreatment(wound(), 'bandage', true, options).bleeding.severity).toBe('major')
  })

  it('stops any bleeding, fixed-rate included, with successful surgery', () => {
    const w = { ...wound(), bleeding: bleeding('critical', { special: '2fp-per-second' }) }
    expect(applyTreatment(w, 'surgery', false, options).bleeding.special).toBe('2fp-per-second')
    expect(applyTreatment(w, 'surgery', true, options).bleeding).toEqual(NOT_BLEEDING)
  })

  it('recovers blood FP: 1 on a success, 2 on a critical success, never more than was lost', () => {
    expect(bloodRecovery(resolveRoll(12, 10), 5)).toBe(0)
    expect(bloodRecovery(resolveRoll(9, 10), 5)).toBe(1)
    expect(bloodRecovery(resolveRoll(4, 10), 5)).toBe(2)
    expect(bloodRecovery(resolveRoll(4, 10), 1)).toBe(1)
  })
})

describe('fatigue', () => {
  test.each([
    ['scratch', 0],
    ['minor', 1],
    ['moderate', 2],
    ['major', 5],
    ['critical', 10],
    ['massive', 20],
    ['gawdawful', 40],
    ['destroyed', 80],
  ] as const)('fatigue-type %p costs %p FP', (severity, fp) => {
    expect(fatigueForSeverity(severity)).toBe(fp)
  })

  it('calls for a check at -1 x FP and every further 1/2 FP, at -5 per extra -1 x FP', () => {
    expect(fatigueChecksCrossed(5, -10, 10)).toEqual([{ threshold: -10, multiple: 1, modifier: 0 }])
    expect(fatigueChecksCrossed(5, -9, 10)).toEqual([])
    expect(fatigueChecksCrossed(-10, -15, 10)).toEqual([{ threshold: -15, multiple: 1.5, modifier: 0 }])
    expect(fatigueChecksCrossed(0, -20, 10).map(t => [t.threshold, t.modifier])).toEqual([
      [-10, 0],
      [-15, 0],
      [-20, -5],
    ])
    expect(fatigueChecksCrossed(-20, -30, 10).map(t => [t.threshold, t.modifier])).toEqual([
      [-25, -5],
      [-30, -10],
    ])
    expect(fatigueChecksCrossed(-11, -12, 10)).toEqual([])
    expect(fatigueChecksCrossed(-12, -5, 10)).toEqual([])
    expect(fatigueChecksCrossed(5, -10, 0)).toEqual([])
  })

  it('handles fractional half-FP thresholds', () => {
    expect(fatigueChecksCrossed(0, -16, 11).map(t => t.threshold)).toEqual([-11])
    expect(fatigueChecksCrossed(0, -17, 11).map(t => t.threshold)).toEqual([-11, -16.5])
    expect(fatigueChecksCrossed(-16, -17, 11).map(t => t.threshold)).toEqual([-16.5])
  })

  it('notices reaching 0 FP', () => {
    expect(reachedZeroFP(1, 0)).toBe(true)
    expect(reachedZeroFP(0, -1)).toBe(false)
    expect(reachedZeroFP(3, 1)).toBe(false)
  })

  it('judges one roll for unconsciousness (Hard to Subdue) and death (Hard to Kill)', () => {
    const plain = fatigueCheckSpec({ threshold: -10, multiple: 1, modifier: 0 }, NO_TRAITS)
    expect(resolveFatigueCheck(10, 10, plain)).toMatchObject({ unconscious: false, dead: false })
    expect(resolveFatigueCheck(11, 10, plain)).toMatchObject({ unconscious: true, dead: false })
    expect(resolveFatigueCheck(15, 10, plain)).toMatchObject({ unconscious: true, dead: true })

    const tough = fatigueCheckSpec(
      { threshold: -10, multiple: 1, modifier: 0 },
      { ...NO_TRAITS, hardToSubdue: 3, hardToKill: 2 }
    )
    expect(resolveFatigueCheck(12, 10, tough)).toMatchObject({ unconscious: false, dead: false })
    expect(resolveFatigueCheck(15, 10, tough)).toMatchObject({ unconscious: true, dead: false })
    expect(resolveFatigueCheck(17, 10, tough)).toMatchObject({ unconscious: true, dead: true })

    const deep = fatigueCheckSpec({ threshold: -20, multiple: 2, modifier: -5 }, NO_TRAITS)
    expect(deep.modifiers.map(m => m.value)).toEqual([-5])
    expect(resolveFatigueCheck(10, 10, deep)).toMatchObject({ unconscious: true, dead: true })
  })

  it('adds Hard to Subdue to the roll to act at 0 FP', () => {
    expect(actCheckModifiers({ ...NO_TRAITS, hardToSubdue: 2 }).map(m => m.value)).toEqual([2])
    expect(actCheckModifiers(NO_TRAITS)).toEqual([])
  })

  it('describes the FP condition under RFH', () => {
    expect(fatigueCondition(10, 10).key).toBe('normal')
    expect(fatigueCondition(3, 10).key).toBe('tired')
    expect(fatigueCondition(4, 10).key).toBe('normal')
    expect(fatigueCondition(0, 10).key).toBe('actRoll')
    expect(fatigueCondition(-9, 10).key).toBe('actRoll')
    expect(fatigueCondition(-10, 10).key).toBe('checks')
  })

  it('lists FP breakpoints', () => {
    expect(fatigueBreakpoints(11).map(b => b.breakpoint)).toEqual([3, 0, -11, -17, -22, -28, -33])
    expect(fatigueBreakpoints(10).map(b => b.modifier)).toEqual([0, 0, 0, 0, -5, -5, -10])
  })
})
