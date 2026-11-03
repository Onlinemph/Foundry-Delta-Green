import {
  NO_TRAITS,
  activePain,
  applyEffects,
  applyRecovery,
  assessWound,
  checkTarget,
  deriveStatus,
  effectiveShock,
  emptyState,
  lingeringPain,
  mergePain,
  mergeStunChecks,
  mergeShock,
  normalizeState,
  painMagnitude,
  painStatusId,
  recoveryModifiers,
  removeWound,
  resolveCheck,
  setLimb,
  type CheckSpec,
  type Traits,
  type WoundInput,
  type WoundsState,
} from '../../module/agency/wounds/engine.js'

const NOW = 1000

let counter = 0
function input(overrides: Partial<WoundInput> = {}): WoundInput {
  counter++
  return {
    id: `w${counter}`,
    injury: 5,
    maxHP: 10,
    location: 'Torso',
    role: 'chest',
    damageType: 'cut',
    emergency: true,
    created: NOW,
    ...overrides,
  }
}

function traits(overrides: Partial<Traits> = {}): Traits {
  return { ...NO_TRAITS, ...overrides }
}

function assess(i: Partial<WoundInput>, t: Partial<Traits> = {}, state: WoundsState = emptyState(), random = 0.25) {
  return assessWound(state, input(i), traits(t), { random: () => random })
}

function check(result: ReturnType<typeof assess>, kind: string): CheckSpec {
  const found = result.assessment.checks.find(c => c.kind === kind)
  if (!found) throw new Error(`no ${kind} check in ${result.assessment.checks.map(c => c.kind).join(',')}`)
  return found
}

function mods(c: CheckSpec): number[] {
  return c.modifiers.map(m => m.value)
}

describe('assessWound: severity, recording and shock', () => {
  it('ignores injury below 1/16 HP', () => {
    const r = assess({ injury: 1, maxHP: 20 })
    expect(r.assessment.severity).toBeNull()
    expect(r.assessment.skipReason).toBe('belowScratch')
    expect(r.assessment.shock).toBe(0)
    expect(r.state.wounds).toHaveLength(0)
  })

  it('records a cutting Scratch with -1 shock and no checks', () => {
    const r = assess({ injury: 1 })
    expect(r.assessment.severity).toBe('scratch')
    expect(r.assessment.recorded).toBe(true)
    expect(r.assessment.shock).toBe(1)
    expect(r.assessment.checks).toEqual([])
    expect(r.state.wounds[0]).toMatchObject({ severity: 'scratch', location: 'Torso', category: 'torso' })
  })

  it('does not record a crushing Scratch, but the shock stands', () => {
    const r = assess({ injury: 1, damageType: 'cr' })
    expect(r.assessment.recorded).toBe(false)
    expect(r.assessment.skipReason).toBe('crushingScratch')
    expect(r.assessment.shock).toBe(1)
    expect(r.state.wounds).toHaveLength(0)
  })

  it('does not record a crushing Minor wound, but shock and stunning stand', () => {
    const r = assess({ injury: 2, damageType: 'cr' })
    expect(r.assessment.severity).toBe('minor')
    expect(r.assessment.recorded).toBe(false)
    expect(r.assessment.skipReason).toBe('crushingMinor')
    expect(r.assessment.shock).toBe(2)
    expect(check(r, 'stun').woundId).toBeNull()
    expect(r.state.wounds).toHaveLength(0)
  })

  it('records crushing Moderate wounds', () => {
    expect(assess({ injury: 3, damageType: 'cr' }).assessment.recorded).toBe(true)
  })

  test.each([
    [1, 'scratch', 1],
    [2, 'minor', 2],
    [3, 'moderate', 3],
    [5, 'major', 4],
    [10, 'critical', 5],
    [20, 'massive', 6],
    [40, 'gawdawful', 7],
  ])('injury %p on 10 HP is %p with shock %p', (injury, severity, shock) => {
    const r = assess({ injury })
    expect(r.assessment.severity).toBe(severity)
    expect(r.assessment.shock).toBe(shock)
  })

  it('kills outright at 8 x HP', () => {
    const r = assess({ injury: 80 })
    expect(r.assessment.severity).toBe('destroyed')
    expect(r.assessment.effects).toEqual([{ type: 'dead', reason: 'destroyed' }])
    expect(r.assessment.checks).toEqual([])
    expect(r.state.wounds[0].severity).toBe('destroyed')
  })

  it('records a GM-entered severity without injury', () => {
    const r = assess({ injury: null, severity: 'major' })
    expect(r.assessment.severity).toBe('major')
    expect(r.state.wounds[0].injury).toBe(0)
  })
})

describe('assessWound: stunning and knockdown', () => {
  test.each([
    // injury on 10 HP, location, role, stun modifier, knockdown, unconscious on failure by 5
    [2, 'Torso', 'chest', 0, false, false],
    [2, 'Skull', null, -1, true, true],
    [3, 'Torso', 'chest', -1, false, false],
    [3, 'Vitals', null, -2, true, true],
    [5, 'Torso', 'chest', -2, true, true],
    [5, 'Face', null, -5, true, true],
    [10, 'Torso', 'chest', -3, true, true],
    [10, 'Vitals', null, -6, true, true],
    [20, 'Groin', 'groin', -4, true, true],
    [20, 'Vitals', null, -7, true, true],
    [40, 'Torso', 'chest', -5, true, true],
    [40, 'Vitals', null, -8, true, true],
  ])('injury %p to %p', (injury, location, role, modifier, knockdown, unconscious) => {
    const stun = check(assess({ injury, location, role }), 'stun')
    expect(stun.modifiers.reduce((s, m) => s + m.value, 0)).toBe(modifier)
    expect(stun.knockdown).toBe(knockdown)
    expect(stun.unconsciousOnFailBy5).toBe(unconscious)
  })

  it('has no stun check for a Scratch', () => {
    expect(assess({ injury: 1 }).assessment.checks.some(c => c.kind === 'stun')).toBe(false)
  })

  it('lets Hard to Subdue help against unconsciousness only', () => {
    const stun = check(assess({ injury: 5 }, { hardToSubdue: 2 }), 'stun')
    expect(mods(stun)).toEqual([-2])
    expect(stun.unconsciousBonus.map(m => m.value)).toEqual([2])
  })
})

describe('assessWound: impairment', () => {
  test.each([
    [3, 0, 'moderate', false],
    [5, -1, 'severe', true],
    [10, -2, 'terrible', true],
    [20, -3, 'terrible', true],
    [40, -4, 'agony', true],
  ])('injury %p calls for HT%p, failure brings %p pain', (injury, modifier, pain, halfMove) => {
    const c = check(assess({ injury }), 'impairment')
    expect(c.modifiers.reduce((s, m) => s + m.value, 0)).toBe(modifier)
    expect(c.pain).toBe(pain)
    expect(c.halfMove).toBe(halfMove)
  })

  it('is at -3 outside an emergency', () => {
    expect(mods(check(assess({ injury: 3, emergency: false }), 'impairment'))).toEqual([-3])
  })

  it('adds +2 for High Pain Threshold and Hard to Subdue levels', () => {
    expect(mods(check(assess({ injury: 5 }, { highPainThreshold: true, hardToSubdue: 3 }), 'impairment'))).toEqual([
      -1, 2, 3,
    ])
  })

  it('is not rolled for Minor wounds and Scratches', () => {
    expect(assess({ injury: 2 }).assessment.checks.map(c => c.kind)).toEqual(['stun'])
  })

  it('is only re-rolled for a worse wound, or for any Critical or worse wound', () => {
    let state = emptyState()
    const major = assess({ injury: 5 }, {}, state)
    expect(major.state.impairmentTaken).toBe('major')
    state = major.state

    const moderate = assess({ injury: 3 }, {}, state)
    expect(moderate.assessment.checks.some(c => c.kind === 'impairment')).toBe(false)
    expect(moderate.assessment.notes).toContain('GURPS.agency.wounds.note.noNewImpairment')

    const anotherMajor = assess({ injury: 6 }, {}, moderate.state)
    expect(anotherMajor.assessment.checks.some(c => c.kind === 'impairment')).toBe(false)

    const critical = assess({ injury: 10 }, {}, anotherMajor.state)
    expect(critical.assessment.checks.some(c => c.kind === 'impairment')).toBe(true)
    expect(critical.state.impairmentTaken).toBe('critical')

    const anotherCritical = assess({ injury: 12 }, {}, critical.state)
    expect(anotherCritical.assessment.checks.some(c => c.kind === 'impairment')).toBe(true)
  })
})

describe('assessWound: Injury Tolerance and Fragile', () => {
  it('spares the unliving shock, stunning and impairment', () => {
    const r = assess({ injury: 5 }, { injuryTolerance: 'unliving' })
    expect(r.assessment.shock).toBe(0)
    expect(r.assessment.checks).toEqual([])
    expect(r.assessment.notes).toContain('GURPS.agency.wounds.note.injuryTolerance')
  })

  it('still checks an unliving limb for trauma', () => {
    const r = assess({ injury: 5, location: 'Left Arm', role: 'limb' }, { injuryTolerance: 'unliving' })
    expect(r.assessment.checks.map(c => c.kind)).toEqual(['limbMajor'])
  })

  it('caps a single diffuse blow at Minor', () => {
    const r = assess({ injury: 10 }, { injuryTolerance: 'diffuse' })
    expect(r.assessment.baseSeverity).toBe('critical')
    expect(r.assessment.severity).toBe('minor')
    expect(r.assessment.cappedByDiffuse).toBe(true)
  })

  it('does not cap diffuse injury from an area attack', () => {
    expect(assess({ injury: 10, areaAttack: true }, { injuryTolerance: 'diffuse' }).assessment.severity).toBe(
      'critical'
    )
  })

  it('gives homogeneous bodies no vitals or brain', () => {
    const vitals = assess({ injury: 10, location: 'Vitals', role: null }, { injuryTolerance: 'homogeneous' })
    expect(vitals.assessment.category).toBe('torso')
    expect(vitals.assessment.checks.some(c => c.kind === 'vitals')).toBe(false)
    const skull = assess({ injury: 10, location: 'Skull', role: null }, { injuryTolerance: 'homogeneous' })
    expect(skull.assessment.checks.some(c => c.kind === 'brain')).toBe(false)
  })

  it('kills Fragile (Unnatural) at the first Critical wound to the head or torso', () => {
    expect(assess({ injury: 10 }, { fragileUnnatural: true }).assessment.effects).toContainEqual({
      type: 'dead',
      reason: 'fragile',
    })
    expect(
      assess({ injury: 10, location: 'Right Arm', role: 'limb' }, { fragileUnnatural: true }).assessment.effects
    ).toEqual([])
    expect(assess({ injury: 5 }, { fragileUnnatural: true }).assessment.effects).toEqual([])
  })
})

describe('assessWound: large-area injury', () => {
  test.each([
    ['Skull', null, 3, 'minor'],
    ['Left Arm', 'limb', 5, 'moderate'],
    ['Right Leg', 'limb', 3, 'minor'],
    ['Hand', 'extremity', 5, 'minor'],
    ['Foot', 'extremity', 10, 'moderate'],
    ['Torso', 'chest', 3, 'moderate'],
    ['Neck', null, 3, 'moderate'],
  ])('%p takes a smaller wound', (location, role, injury, severity) => {
    expect(assess({ injury, location, role, largeArea: true }).assessment.severity).toBe(severity)
  })

  it('drops a wound reduced below a Scratch', () => {
    const r = assess({ injury: 2, location: 'Hand', role: 'extremity', largeArea: true })
    expect(r.assessment.severity).toBeNull()
    expect(r.assessment.skipReason).toBe('reducedAway')
    expect(r.state.wounds).toHaveLength(0)
  })
})

describe('assessWound: Progressive Limb Trauma', () => {
  const arm = { location: 'Right Arm', role: 'limb' }

  it('calls for HT-2 on a first Major wound to a limb', () => {
    expect(mods(check(assess({ injury: 5, ...arm }), 'limbMajor'))).toEqual([-2])
  })

  it('applies to extremities too', () => {
    expect(check(assess({ injury: 5, location: 'Hand', role: 'extremity' }), 'limbMajor').limbKey).toBe('Hand')
  })

  it('stacks -2 per earlier Major or Critical wound on the same limb', () => {
    const first = assess({ injury: 5, ...arm })
    const second = assess({ injury: 5, ...arm }, {}, first.state)
    expect(mods(check(second, 'limbMajor'))).toEqual([-2, -2])
    const third = assess({ injury: 6, ...arm }, {}, second.state)
    expect(mods(check(third, 'limbMajor'))).toEqual([-2, -4])
    // A Major wound to the other arm does not count.
    const other = assess({ injury: 5, location: 'Left Arm', role: 'limb' }, {}, third.state)
    expect(mods(check(other, 'limbMajor'))).toEqual([-2])
  })

  it('does not count Moderate wounds', () => {
    const moderate = assess({ injury: 3, ...arm })
    expect(mods(check(assess({ injury: 5, ...arm }, {}, moderate.state), 'limbMajor'))).toEqual([-2])
  })

  it('calls for HT-5, -3 per earlier wound and -3 more if crippled, on a Critical wound', () => {
    const first = assess({ injury: 5, ...arm })
    const second = assess({ injury: 5, ...arm }, {}, first.state)
    const crippled = setLimb(second.state, 'Right Arm', { crippled: true })
    expect(mods(check(assess({ injury: 10, ...arm }, {}, crippled), 'limbCritical'))).toEqual([-5, -6, -3])
    expect(mods(check(assess({ injury: 10, ...arm }), 'limbCritical'))).toEqual([-5])
  })

  it('lets a dismembered limb take no further damage', () => {
    const state = setLimb(emptyState(), 'Right Arm', { dismembered: true })
    const r = assess({ injury: 5, ...arm }, {}, state)
    expect(r.assessment.skipReason).toBe('dismembered')
    expect(r.assessment.shock).toBe(0)
    expect(r.state.wounds).toHaveLength(0)
  })
})

describe('assessWound: special locations', () => {
  it('checks the vitals at HT-2 on a Critical wound', () => {
    expect(mods(check(assess({ injury: 10, location: 'Vitals', role: null }), 'vitals'))).toEqual([-2])
  })

  it('checks the brain at HT-3 (Hard to Kill helps) on a Critical wound', () => {
    expect(mods(check(assess({ injury: 10, location: 'Skull', role: null }), 'brain'))).toEqual([-3])
    expect(mods(check(assess({ injury: 10, location: 'Eye', role: null }, { hardToKill: 2 }), 'brain'))).toEqual([
      -3, 2,
    ])
    expect(assess({ injury: 10, location: 'Face', role: null }).assessment.checks.some(c => c.kind === 'brain')).toBe(
      false
    )
  })

  it('checks the neck at HT-3, or HT-5 for the veins', () => {
    expect(mods(check(assess({ injury: 10, location: 'Neck', role: null }), 'neck'))).toEqual([-3])
    expect(mods(check(assess({ injury: 10, location: 'Neck Vein/Artery', role: null }), 'neck'))).toEqual([-5])
  })

  it('has no special check for Major wounds', () => {
    const kinds = assess({ injury: 5, location: 'Vitals', role: null }).assessment.checks.map(c => c.kind)
    expect(kinds).toEqual(['stun', 'impairment'])
  })

  it('decapitates on the third Critical cutting wound to the neck', () => {
    const one = assess({ injury: 10, location: 'Neck', role: null })
    const two = assess({ injury: 10, location: 'Neck', role: null }, {}, one.state)
    expect(two.assessment.effects).toEqual([])
    const three = assess({ injury: 12, location: 'Neck', role: null }, {}, two.state)
    expect(three.assessment.effects).toContainEqual({ type: 'dead', reason: 'decapitated' })
    expect(three.assessment.checks).toEqual([])
    const crushing = assess({ injury: 12, location: 'Neck', role: null, damageType: 'cr' }, {}, two.state)
    expect(crushing.assessment.effects).toEqual([])
  })

  it('destroys the head or severs the neck at Massive and worse', () => {
    for (const location of ['Skull', 'Face', 'Eye', 'Neck']) {
      const r = assess({ injury: 20, location, role: null })
      expect(r.assessment.effects).toEqual([{ type: 'dead', reason: 'headDestroyed' }])
      expect(r.assessment.checks).toEqual([])
    }
  })

  it('destroys a vital organ at Massive and worse: bleeding or paralysis', () => {
    const bleeding = assess({ injury: 20, location: 'Vitals', role: null }, {}, emptyState(), 0.1)
    expect(bleeding.assessment.effects).toEqual([
      { type: 'bleed', woundId: bleeding.assessment.id, rate: '2fp-per-second' },
    ])
    expect(bleeding.state.wounds[0].bleeding.special).toBe('2fp-per-second')
    const paralysis = assess({ injury: 20, location: 'Vitals', role: null }, {}, emptyState(), 0.9)
    expect(paralysis.assessment.effects).toEqual([{ type: 'paralysis', woundId: paralysis.assessment.id }])
    expect(paralysis.state.wounds[0].paralysis).toBe(true)
  })

  it('calls for the break check at HT-3 (Massive) and HT-5 (Gawdawful)', () => {
    expect(mods(check(assess({ injury: 20 }), 'break'))).toEqual([-3])
    expect(mods(check(assess({ injury: 40 }), 'break'))).toEqual([-5])
    expect(assess({ injury: 40 }).assessment.notes).toContain('GURPS.agency.wounds.note.gawdawful')
  })

  it('lists checks in a stable order', () => {
    const r = assess({ injury: 10, location: 'Left Leg', role: 'limb' })
    expect(r.assessment.checks.map(c => c.kind)).toEqual(['stun', 'impairment', 'limbCritical'])
    const massiveLeg = assess({ injury: 20, location: 'Left Leg', role: 'limb' })
    expect(massiveLeg.assessment.checks.map(c => c.kind)).toEqual(['stun', 'impairment', 'limbCritical', 'break'])
  })
})

describe('assessWound: bleeding', () => {
  it('starts Moderate and worse wounds bleeding at their own severity', () => {
    expect(assess({ injury: 3 }).state.wounds[0].bleeding.severity).toBe('moderate')
    expect(assess({ injury: 10, damageType: 'cr' }).state.wounds[0].bleeding.severity).toBe('critical')
  })

  it('ignores Minor and Scratch bleeding unless tracked or hemophiliac', () => {
    expect(assess({ injury: 2 }).state.wounds[0].bleeding.severity).toBeNull()
    expect(assess({ injury: 2, trackMinorBleeding: true }).state.wounds[0].bleeding.severity).toBe('minor')
    expect(assess({ injury: 1 }, { hemophilia: true }).state.wounds[0].bleeding.severity).toBe('scratch')
    expect(
      assess({ injury: 1, damageType: 'imp', trackMinorBleeding: true }).state.wounds[0].bleeding.severity
    ).toBeNull()
  })
})

describe('mergeStunChecks', () => {
  it('keeps one stun check per application of damage: the hardest, with any knockdown', () => {
    const body = assess({ injury: 3 }).assessment.checks
    const head = assess({ injury: 2, location: 'Skull', role: null }).assessment.checks
    const major = assess({ injury: 6 }).assessment.checks
    const merged = mergeStunChecks([...body, ...head, ...major])
    const stuns = merged.filter(c => c.kind === 'stun')
    expect(stuns).toHaveLength(1)
    expect(mods(stuns[0])).toEqual([-2])
    expect(stuns[0].knockdown).toBe(true)
    expect(stuns[0].unconsciousOnFailBy5).toBe(true)
    expect(merged.map(c => c.kind)).toEqual(['stun', 'impairment', 'impairment'])
    expect(merged[0].id).toBe(major[0].id)
  })

  it('leaves a single stun check alone', () => {
    const checks = assess({ injury: 5 }).assessment.checks
    expect(mergeStunChecks(checks)).toEqual(checks)
  })
})

describe('resolveCheck', () => {
  const HT = 10

  it('stuns and knocks down on a failed Major-wound stun check, and knocks out on failure by 5', () => {
    const r = assess({ injury: 5 })
    const stun = check(r, 'stun')
    expect(checkTarget(stun, HT)).toBe(8)
    expect(resolveCheck(r.state, stun, 8, HT, NOW).resolution.effects).toEqual([])
    expect(resolveCheck(r.state, stun, 9, HT, NOW).resolution.effects).toEqual([{ type: 'stun' }, { type: 'prone' }])
    expect(resolveCheck(r.state, stun, 12, HT, NOW).resolution.effects).toEqual([{ type: 'stun' }, { type: 'prone' }])
    const out = resolveCheck(r.state, stun, 13, HT, NOW).resolution
    expect(out.effects).toEqual([{ type: 'unconscious' }, { type: 'prone' }])
    expect(out.result).toBe('GURPS.agency.wounds.result.knockedOut')
  })

  it('lets Hard to Subdue keep the victim conscious', () => {
    const r = assess({ injury: 5 }, { hardToSubdue: 2 })
    expect(resolveCheck(r.state, check(r, 'stun'), 13, HT, NOW).resolution.effects).toEqual([
      { type: 'stun' },
      { type: 'prone' },
    ])
  })

  it('only stuns on a failed body Minor-wound check, however badly', () => {
    const r = assess({ injury: 2 })
    expect(resolveCheck(r.state, check(r, 'stun'), 16, HT, NOW).resolution.effects).toEqual([{ type: 'stun' }])
  })

  it('brings pain for minutes equal to the margin of failure, agony at failure by 5', () => {
    const r = assess({ injury: 3 })
    const imp = check(r, 'impairment')
    expect(resolveCheck(r.state, imp, 10, HT, NOW).resolution.effects).toEqual([])
    const moderate = resolveCheck(r.state, imp, 12, HT, NOW)
    expect(moderate.resolution.effects).toEqual([{ type: 'pain', level: 'moderate', minutes: 2, halfMove: false }])
    expect(moderate.state.pain).toEqual({ level: 'moderate', expiresAt: NOW + 120, halfMove: false })
    const agony = resolveCheck(r.state, imp, 15, HT, NOW)
    expect(agony.resolution.effects).toEqual([{ type: 'pain', level: 'agony', minutes: 5, halfMove: false }])
    expect(agony.resolution.result).toBe('GURPS.agency.wounds.result.pain.agony')
  })

  it('halves Move and Dodge when impaired by a Major wound', () => {
    const r = assess({ injury: 5 })
    const out = resolveCheck(r.state, check(r, 'impairment'), 12, HT, NOW)
    expect(out.state.pain).toMatchObject({ level: 'severe', halfMove: true })
    expect(deriveStatus(out.state, NOW).halfMoveDodge).toBe(true)
    expect(deriveStatus(out.state, NOW + 3 * 60 + 1).halfMoveDodge).toBe(false)
  })

  it('cripples a limb on a failed Major check, and gives -1 with it on a success', () => {
    const r = assess({ injury: 5, location: 'Right Arm', role: 'limb' })
    const limb = check(r, 'limbMajor')
    const pass = resolveCheck(r.state, limb, 8, HT, NOW)
    expect(pass.state.wounds[0].limbPenalty).toBe(true)
    expect(deriveStatus(pass.state, NOW).limbPenalties).toEqual({ 'Right Arm': 1 })
    const fail = resolveCheck(r.state, limb, 9, HT, NOW)
    expect(fail.state.limbs).toEqual([{ key: 'Right Arm', leg: false, crippled: true, dismembered: false }])
  })

  it('cripples a limb on a passed Critical check and takes it off on a failure', () => {
    const r = assess({ injury: 10, location: 'Left Leg', role: 'limb' })
    const limb = check(r, 'limbCritical')
    const pass = resolveCheck(r.state, limb, 5, HT, NOW)
    expect(pass.state.limbs).toEqual([{ key: 'Left Leg', leg: true, crippled: true, dismembered: false }])
    expect(deriveStatus(pass.state, NOW).halfMoveDodge).toBe(true)
    const fail = resolveCheck(r.state, limb, 6, HT, NOW)
    expect(fail.state.limbs[0]).toMatchObject({ crippled: true, dismembered: true })
    expect(fail.state.wounds[0].bleeding.severity).toBe('massive')
    expect(fail.resolution.result).toBe('GURPS.agency.wounds.result.dismembered')
  })

  it('resolves the vitals, brain, neck and break checks', () => {
    const vitals = assess({ injury: 10, location: 'Vitals', role: null })
    expect(
      resolveCheck(vitals.state, check(vitals, 'vitals'), 9, HT, NOW, { random: () => 0.2 }).state.wounds[0].bleeding
        .special
    ).toBe('2fp-per-second')
    expect(
      resolveCheck(vitals.state, check(vitals, 'vitals'), 9, HT, NOW, { random: () => 0.7 }).state.wounds[0].paralysis
    ).toBe(true)
    expect(resolveCheck(vitals.state, check(vitals, 'vitals'), 8, HT, NOW).resolution.effects).toEqual([])

    const brain = assess({ injury: 10, location: 'Skull', role: null })
    expect(resolveCheck(brain.state, check(brain, 'brain'), 8, HT, NOW).resolution.effects).toEqual([
      { type: 'dead', reason: 'brain' },
    ])
    expect(resolveCheck(brain.state, check(brain, 'brain'), 7, HT, NOW).resolution.effects).toEqual([])

    const neck = assess({ injury: 10, location: 'Neck', role: null })
    expect(
      resolveCheck(neck.state, check(neck, 'neck'), 8, HT, NOW, { random: () => 0.7 }).state.wounds[0].bleeding.special
    ).toBe('1fp-per-second')

    const massive = assess({ injury: 20 })
    const broken = resolveCheck(massive.state, check(massive, 'break'), 8, HT, NOW)
    expect(broken.resolution.effects).toEqual([
      { type: 'incapacitated' },
      { type: 'bleed', woundId: massive.assessment.id, rate: '2fp-per-second' },
    ])
    expect(resolveCheck(massive.state, check(massive, 'break'), 7, HT, NOW).resolution.effects).toEqual([])
  })

  it('counts 3 and 4 as successes even against a hopeless target', () => {
    const r = assess({ injury: 10, location: 'Right Arm', role: 'limb' })
    const limb = check(r, 'limbCritical')
    expect(resolveCheck(r.state, limb, 4, 3, NOW).resolution.roll.success).toBe(true)
    expect(resolveCheck(r.state, limb, 5, 3, NOW).resolution.roll.success).toBe(false)
  })
})

describe('pain and shock', () => {
  it('maps pain to upstream statuses, halved by High Pain Threshold', () => {
    expect(painStatusId('moderate', false)).toBe('moderate_pain')
    expect(painStatusId('severe', false)).toBe('severe_pain')
    expect(painStatusId('terrible', false)).toBe('terrible_pain')
    expect(painStatusId('agony', false)).toBe('agony')
    expect(painStatusId('moderate', true)).toBe('mild_pain')
    expect(painStatusId('severe', true)).toBe('moderate_pain')
    expect(painStatusId('terrible', true)).toBe('moderate_pain2')
    expect(painStatusId('agony', true)).toBe('agony')
    expect(painMagnitude('terrible', true)).toBe(3)
    expect(painMagnitude('agony', true)).toBe(Number.POSITIVE_INFINITY)
  })

  it('does not stack pain with shock: only the excess shock is added', () => {
    const pain = { level: 'moderate' as const, expiresAt: null, halfMove: false }
    expect(effectiveShock(5, null, false)).toBe(5)
    expect(effectiveShock(5, pain, false)).toBe(3)
    expect(effectiveShock(2, pain, false)).toBe(0)
    expect(effectiveShock(1, pain, false)).toBe(0)
    expect(effectiveShock(3, pain, true)).toBe(2)
    expect(effectiveShock(7, { ...pain, level: 'agony' }, false)).toBe(0)
  })

  it('takes the worst shock of a turn, not the sum', () => {
    const first = mergeShock(null, 2, 'c1', 3)
    expect(mergeShock(first, 4, 'c1', 3).amount).toBe(4)
    expect(mergeShock(mergeShock(first, 4, 'c1', 3), 1, 'c1', 3).amount).toBe(4)
    expect(mergeShock(first, 1, 'c1', 4)).toEqual({ amount: 1, combatId: 'c1', round: 4 })
  })

  it('keeps the worse pain, and the later expiry at the same level', () => {
    const moderate = mergePain(null, { level: 'moderate', minutes: 3, halfMove: false }, NOW)
    expect(mergePain(moderate, { level: 'moderate', minutes: 5, halfMove: false }, NOW).expiresAt).toBe(NOW + 300)
    expect(mergePain(moderate, { level: 'moderate', minutes: 1, halfMove: false }, NOW).expiresAt).toBe(NOW + 180)
    expect(mergePain(moderate, { level: 'terrible', minutes: 1, halfMove: true }, NOW)).toEqual({
      level: 'terrible',
      expiresAt: NOW + 60,
      halfMove: true,
    })
    const agony = mergePain(null, { level: 'agony', minutes: 6, halfMove: false }, NOW)
    expect(mergePain(agony, { level: 'severe', minutes: 9, halfMove: true }, NOW)).toEqual({
      level: 'agony',
      expiresAt: NOW + 360,
      halfMove: true,
    })
    // Expired pain is simply replaced.
    expect(mergePain(agony, { level: 'moderate', minutes: 1, halfMove: false }, NOW + 1000).level).toBe('moderate')
    expect(activePain({ ...emptyState(), pain: agony }, NOW + 360)).toBeNull()
  })

  it('brings lingering pain from the worst wound once adrenaline wears off', () => {
    expect(lingeringPain(emptyState())).toBeNull()
    expect(lingeringPain(assess({ injury: 2 }).state)).toBeNull()
    expect(lingeringPain(assess({ injury: 3 }).state)).toEqual({ level: 'moderate', minutes: null, halfMove: false })
    const state = assess({ injury: 10 }, {}, assess({ injury: 3 }).state).state
    expect(lingeringPain(state)).toEqual({ level: 'terrible', minutes: null, halfMove: true })
    const withPain = applyEffects(state, [{ type: 'pain', level: 'terrible', minutes: null, halfMove: true }], NOW)
    expect(activePain(withPain, NOW + 1e9)).toMatchObject({ level: 'terrible', expiresAt: null })
  })
})

describe('deriveStatus', () => {
  it('summarizes the worst wound and Gawdawful penalties', () => {
    const one = assess({ injury: 3 })
    const two = assess({ injury: 40 }, {}, one.state)
    const three = assess({ injury: 45 }, {}, two.state)
    const status = deriveStatus(three.state, NOW)
    expect(status.worst).toBe('gawdawful')
    expect(status.count).toBe(3)
    expect(status.gawdawful).toBe(2)
    expect(status.halfMoveDodge).toBe(true)
    expect(status.bleeding).toBe(true)
  })

  it('halves Move and Dodge for a Major wound to a leg', () => {
    expect(deriveStatus(assess({ injury: 5, location: 'Right Leg', role: 'limb' }).state, NOW).halfMoveDodge).toBe(true)
    expect(deriveStatus(assess({ injury: 5, location: 'Right Arm', role: 'limb' }).state, NOW).halfMoveDodge).toBe(
      false
    )
    expect(deriveStatus(assess({ injury: 3, location: 'Right Leg', role: 'limb' }).state, NOW).halfMoveDodge).toBe(
      false
    )
  })

  it('reports an empty state', () => {
    expect(deriveStatus(emptyState(), NOW)).toEqual({
      worst: null,
      count: 0,
      pain: null,
      halfMoveDodge: false,
      gawdawful: 0,
      bleeding: false,
      limbPenalties: {},
    })
  })
})

describe('weekly recovery', () => {
  it('lowers each wound that passes by one level and heals Scratches', () => {
    let state = assess({ injury: 1 }).state
    state = assess({ injury: 5, location: 'Right Arm', role: 'limb' }, {}, state).state
    const [scratch, major] = state.wounds
    state = applyEffects(state, [{ type: 'limbPenalty', woundId: major.id }], NOW)
    const out = applyRecovery(state, [
      { woundId: scratch.id, success: true },
      { woundId: major.id, success: true },
    ])
    expect(out.healed).toEqual([scratch.id])
    expect(out.improved).toEqual([major.id])
    expect(out.state.wounds).toHaveLength(1)
    expect(out.state.wounds[0]).toMatchObject({ severity: 'moderate', originalSeverity: 'major', limbPenalty: false })
    expect(out.state.wounds[0].bleeding.severity).toBe('moderate')
  })

  it('leaves wounds that fail alone, and forgets impairment once all wounds heal', () => {
    const state = assess({ injury: 3 }).state
    const id = state.wounds[0].id
    expect(applyRecovery(state, [{ woundId: id, success: false }]).state.wounds[0].severity).toBe('moderate')
    expect(removeWound(state, id).impairmentTaken).toBeNull()
  })

  it('eases lingering pain as the worst wound heals, but leaves timed pain alone', () => {
    const state = assess({ injury: 5 }).state
    const id = state.wounds[0].id
    const lingering = applyEffects(state, [{ type: 'pain', level: 'severe', minutes: null, halfMove: true }], NOW)
    const week1 = applyRecovery(lingering, [{ woundId: id, success: true }]).state
    expect(week1.pain).toEqual({ level: 'moderate', expiresAt: null, halfMove: false })
    const week2 = applyRecovery(week1, [{ woundId: id, success: true }]).state
    expect(week2.pain).toBeNull()
    const timed = applyEffects(state, [{ type: 'pain', level: 'severe', minutes: 3, halfMove: true }], NOW)
    expect(applyRecovery(timed, [{ woundId: id, success: true }]).state.pain).toEqual(timed.pain)
  })

  it('applies the recovery modifiers', () => {
    expect(recoveryModifiers({ noRest: true, underCare: true, rapidHealing: false }).map(m => m.value)).toEqual([-4, 1])
    expect(recoveryModifiers({ noRest: false, underCare: false, rapidHealing: true }).map(m => m.value)).toEqual([5])
  })
})

describe('normalizeState', () => {
  it('reads nothing as an empty state', () => {
    expect(normalizeState(undefined)).toEqual(emptyState())
    expect(normalizeState('junk')).toEqual(emptyState())
  })

  it('fills in missing fields and drops broken records', () => {
    const state = normalizeState({
      wounds: [
        { id: 'a', severity: 'major', location: 'Left Leg' },
        { id: 'b', severity: 'nonsense' },
        { severity: 'minor' },
      ],
      limbs: { x: { key: 'Left Leg', crippled: true } },
      pain: { level: 'severe', expiresAt: 50 },
      impairmentTaken: 'major',
      bleedingFP: '3',
    })
    expect(state.wounds).toHaveLength(1)
    expect(state.wounds[0]).toMatchObject({
      id: 'a',
      severity: 'major',
      originalSeverity: 'major',
      category: 'limb',
      limbKey: 'Left Leg',
      leg: true,
      bleeding: { severity: null, special: null, consecutive: 0, successes: 0 },
    })
    expect(state.limbs).toEqual([{ key: 'Left Leg', leg: false, crippled: true, dismembered: false }])
    expect(state.pain).toEqual({ level: 'severe', expiresAt: 50, halfMove: false })
    expect(state.impairmentTaken).toBe('major')
    expect(state.bleedingFP).toBe(3)
  })

  it('round-trips through JSON', () => {
    const state = assess({ injury: 10, location: 'Left Leg', role: 'limb' }).state
    expect(normalizeState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })
})
