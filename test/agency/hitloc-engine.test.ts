import {
  aimFromName,
  calledShotPenalty,
  calledShotProblem,
  guhlMultiplier,
  missByOne,
  missByOneName,
  parseAttackType,
  replayRoller,
  resolveHit,
  sequenceRoller,
  typeMatches,
  uniformRoller,
  zoneOf,
} from '../../module/agency/hitloc/engine.ts'
import {
  MAIN_TABLE,
  PICKER_ENTRIES,
  ROW_TARGETS,
  SPECIAL_TARGETS,
  TARGET_NAMES,
  aroundCoveragePenalty,
  mainRow,
  pectoralsPenalty,
} from '../../module/agency/hitloc/tables.ts'
import type {
  AttackType,
  DamageType,
  Facing,
  HitResult,
  Part,
  Roller,
  TargetId,
} from '../../module/agency/hitloc/types.ts'

const A = (type: DamageType, tightBeam = false): AttackType => ({ type, tightBeam })
const TB = A('burn', true)

/** A roller that answers by key, and fails the test if the engine asks for a die it shouldn't. */
function dice(values: Record<string, number>): Roller {
  return key => {
    if (!(key in values)) throw new Error(`unexpected roll '${key}'`)
    return values[key]
  }
}

function hit(
  target: TargetId,
  values: Record<string, number>,
  attack = A('cr'),
  facing: Facing = 'front',
  side?: 'left' | 'right'
): HitResult {
  return resolveHit({ target, side: side ?? null }, { attack, facing, roll: dice(values) })
}

const random = (values: Record<string, number>, attack = A('cr'), facing: Facing = 'front') =>
  hit('random', values, attack, facing)

/** Path segment keys, with side when present: "leg:left > thigh > veinArtery". */
const path = (r: HitResult) => r.path.map(s => (s.side ? `${s.key}:${s.side}` : s.key)).join(' > ')

/* ---------------------------------------- */

describe('main table (3d6)', () => {
  test.each([
    [3, 'skull'],
    [4, 'skull'],
    [5, 'face'],
    [6, 'legRight'],
    [7, 'legRight'],
    [8, 'armRight'],
    [9, 'chest'],
    [10, 'chest'],
    [11, 'abdomen'],
    [12, 'armLeft'],
    [13, 'legLeft'],
    [14, 'legLeft'],
    [15, 'hand'],
    [16, 'foot'],
    [17, 'neck'],
    [18, 'neck'],
  ])('%i -> %s', (roll, row) => expect(mainRow(roll)).toBe(row))

  test('clamps out-of-range totals', () => {
    expect(mainRow(1)).toBe('skull')
    expect(mainRow(25)).toBe('neck')
  })

  test('covers 3-18 with no gaps or overlaps', () => {
    const covered = MAIN_TABLE.flatMap(e => Array.from({ length: e.to - e.from + 1 }, (_, i) => e.from + i))
    expect(covered).toEqual(Array.from({ length: 16 }, (_, i) => i + 3))
  })

  // A neutral sub-table die (5) leaves every location as itself.
  test.each([
    [3, 'skull', 'skull', 'Skull', 'skull', null],
    [5, 'face > cheek', 'face', 'Face', 'face', null],
    [6, 'leg:right > thigh', 'leg', 'Leg', 'legR', 'right'],
    [8, 'arm:right > upperArm', 'arm', 'Arm', 'armR', 'right'],
    [9, 'chest', 'chest', 'Torso', 'chest', null],
    [11, 'abdomen > pelvis', 'pelvis', 'Torso', 'abdomen', null],
    [12, 'arm:left > upperArm', 'arm', 'Arm', 'armL', 'left'],
    [13, 'leg:left > thigh', 'leg', 'Leg', 'legL', 'left'],
    [17, 'neck', 'neck', 'Neck', 'neck', null],
  ])('roll %i -> %s', (main, expectedPath, part, upstream, zone, side) => {
    const values: Record<string, number> = { main }
    if (main !== 3) values.sub = 5
    const r = random(values)
    expect(path(r)).toBe(expectedPath)
    expect(r.part).toBe(part)
    expect(r.upstream).toBe(upstream)
    expect(r.zone).toBe(zone)
    expect(r.side).toBe(side)
    expect(r.system).toBe('guhl')
  })

  test('skull has no sub-table roll', () => {
    const r = random({ main: 4 })
    expect(r.rolls).toEqual([{ key: 'main', dice: 3, value: 4 }])
    expect(r.naturalDR).toBe(2)
    expect(r.extraDR).toBe(0)
  })

  test.each([
    [15, 2, 'hand:right', 'handR', 'right'],
    [15, 4, 'hand:left', 'handL', 'left'],
    [16, 3, 'foot:right', 'footR', 'right'],
    [16, 6, 'foot:left', 'footL', 'left'],
  ])('roll %i with side die %i -> %s (1-3 right, 4-6 left)', (main, side, expectedPath, zone, s) => {
    const r = random({ main, side, sub: 4 })
    expect(path(r)).toBe(expectedPath)
    expect(r.zone).toBe(zone)
    expect(r.side).toBe(s)
    expect(r.rolls.map(x => x.key)).toEqual(['main', 'side', 'sub'])
  })
})

describe('sub-table A: the face', () => {
  test('1: jaw', () => {
    const r = random({ main: 5, sub: 1 })
    expect(path(r)).toBe('face > jaw')
    expect(r.part).toBe('jaw')
    expect(r.upstream).toBe('Face')
    expect(r.bodyKeys).toEqual(['Jaw', 'Face'])
    expect(r.notes).toContain('armorCheekGuards')
  })

  test.each([[A('imp')], [A('pi-')], [A('pi')], [A('pi+')], [A('pi++')], [TB]])(
    '2: nose, %p goes on to the skull',
    attack => {
      const r = random({ main: 5, sub: 2 }, attack)
      expect(path(r)).toBe('face > nose > skull')
      expect(r.part).toBe('skull')
      expect(r.upstream).toBe('Skull')
      expect(r.zone).toBe('face')
      expect(r.multiplier).toBe(4)
      expect(r.notes).toEqual(expect.arrayContaining(['armorNasal', 'noseToSkull']))
    }
  )

  test.each([[A('cr')], [A('cut')], [A('burn')], [A('cor')], [A('tox')]])('2: nose stays the nose for %p', attack => {
    const r = random({ main: 5, sub: 2 }, attack)
    expect(path(r)).toBe('face > nose')
    expect(r.part).toBe('nose')
  })

  test('3: ear for cutting', () => {
    const r = random({ main: 5, sub: 3 }, A('cut'))
    expect(path(r)).toBe('face > ear')
    expect(r.part).toBe('ear')
    expect(r.notes).toContain('earCripple')
  })

  test('3: other damage types treat the ear as face', () => {
    const r = random({ main: 5, sub: 3 }, A('imp'))
    expect(path(r)).toBe('face > ear')
    expect(r.part).toBe('face')
    expect(r.notes).toContain('earAsFace')
  })

  test.each([4, 5])('%i: cheek (face)', sub => {
    const r = random({ main: 5, sub })
    expect(path(r)).toBe('face > cheek')
    expect(r.part).toBe('face')
  })

  test.each([[A('imp')], [A('pi')], [TB]])('6: eyes for %p', attack => {
    const r = random({ main: 5, sub: 6 }, attack)
    expect(path(r)).toBe('face > eyes')
    expect(r.part).toBe('eye')
    expect(r.upstream).toBe('Eye')
    expect(r.multiplier).toBe(4)
    expect(r.bleedFast).toBe(true)
  })

  test.each([[A('cr')], [A('cut')], [A('burn')]])('6: interpretation, %p only reaches the face', attack => {
    const r = random({ main: 5, sub: 6 }, attack)
    expect(r.part).toBe('face')
    expect(r.notes).toContain('eyesAsFace')
  })
})

describe('sub-table B: the leg', () => {
  test.each([1, 2, 3])('%i: shin', sub => {
    const r = random({ main: 13, sub })
    expect(path(r)).toBe('leg:left > shin')
    expect(r.part).toBe('leg')
  })

  test('4: knee is a joint for crushing', () => {
    const r = random({ main: 6, sub: 4 }, A('cr'))
    expect(path(r)).toBe('leg:right > knee > joint')
    expect(r.part).toBe('limbJoint')
    expect(r.upstream).toBe('Leg')
    expect(r.crippleDivisor).toBe(3)
  })

  test.each([[A('cut')], [A('imp')], [A('pi')], [TB]])('4: knee is just the leg for %p', attack => {
    const r = random({ main: 6, sub: 4 }, attack)
    expect(path(r)).toBe('leg:right > knee')
    expect(r.part).toBe('leg')
  })

  test('5: thigh', () => expect(path(random({ main: 7, sub: 5 }))).toBe('leg:right > thigh'))

  test.each([[A('cut')], [A('imp')], [TB]])('6: thigh vein/artery for %p', attack => {
    const r = random({ main: 14, sub: 6 }, attack)
    expect(path(r)).toBe('leg:left > thigh > veinArtery')
    expect(r.part).toBe('limbVein')
    expect(r.crippleDivisor).toBe(0)
    expect(r.bleedFast).toBe(true)
  })

  test.each([[A('cr')], [A('pi')], [A('pi+')], [A('burn')]])('6: as printed, %p hits the thigh only', attack => {
    const r = random({ main: 14, sub: 6 }, attack)
    expect(path(r)).toBe('leg:left > thigh')
    expect(r.part).toBe('leg')
  })
})

describe('sub-table C: the arm', () => {
  test.each([1, 2, 3])('%i: forearm', sub => expect(path(random({ main: 8, sub }))).toBe('arm:right > forearm'))

  test('4: elbow joint for crushing', () => {
    const r = random({ main: 12, sub: 4 }, A('cr'))
    expect(path(r)).toBe('arm:left > elbow > joint')
    expect(r.part).toBe('limbJoint')
    expect(r.upstream).toBe('Arm')
  })

  test('4: elbow is the arm for cutting', () => {
    const r = random({ main: 12, sub: 4 }, A('cut'))
    expect(path(r)).toBe('arm:left > elbow')
    expect(r.part).toBe('arm')
  })

  test('5: upper arm', () => expect(path(random({ main: 8, sub: 5 }))).toBe('arm:right > upperArm'))

  test.each([[A('cut')], [A('imp')], [TB]])('6: shoulder vein/artery for %p', attack => {
    const r = random({ main: 8, sub: 6 }, attack)
    expect(path(r)).toBe('arm:right > shoulder > veinArtery')
    expect(r.part).toBe('limbVein')
  })

  test('6: shoulder for crushing', () => {
    const r = random({ main: 8, sub: 6 }, A('cr'))
    expect(path(r)).toBe('arm:right > shoulder')
    expect(r.part).toBe('arm')
  })
})

describe('sub-table D: the chest', () => {
  test.each([[A('cr')], [A('imp')], [A('pi-')], [A('pi++')], [TB]])('1: vitals for %p', attack => {
    const r = random({ main: 9, sub: 1 }, attack)
    expect(path(r)).toBe('chest > vitals')
    expect(r.part).toBe('vitals')
    expect(r.upstream).toBe('Vitals')
    expect(r.zone).toBe('chest')
    expect(r.injuryCap).toBe(false)
  })

  test('1: spine for cutting from the rear', () => {
    const r = random({ main: 10, sub: 1 }, A('cut'), 'rear')
    expect(path(r)).toBe('chest > spine')
    expect(r.part).toBe('spine')
    expect(r.upstream).toBe('Torso')
    expect(r.bodyKeys).toEqual(['Spine', 'Torso'])
    expect(r.extraDR).toBe(3)
    expect(r.injuryCap).toBe(true)
  })

  test.each<[DamageType, Facing]>([
    ['cut', 'front'],
    ['cut', 'side'],
    ['burn', 'rear'],
    ['cor', 'rear'],
    ['tox', 'front'],
  ])('1: %s from the %s is the chest', (type, facing) => {
    const r = random({ main: 9, sub: 1 }, A(type), facing)
    expect(path(r)).toBe('chest')
    expect(r.part).toBe('chest')
  })

  test.each([2, 3, 4, 5, 6])('%i: chest', sub => {
    const r = random({ main: 9, sub }, A('imp'), 'rear')
    expect(path(r)).toBe('chest')
    expect(r.injuryCap).toBe(true)
    expect(r.notes).toContain('torsoCap')
  })
})

describe('sub-table E: the abdomen', () => {
  test.each([[A('cr')], [A('imp')], [A('pi')], [TB]])('1: vitals for %p', attack => {
    const r = random({ main: 11, sub: 1 }, attack)
    expect(path(r)).toBe('abdomen > vitals')
    expect(r.part).toBe('vitals')
    expect(r.zone).toBe('abdomen')
  })

  test.each([[A('cut')], [A('burn')], [A('cor')]])('1: abdomen for %p', attack => {
    const r = random({ main: 11, sub: 1 }, attack)
    expect(path(r)).toBe('abdomen')
    expect(r.part).toBe('abdomen')
    expect(r.upstream).toBe('Torso')
    expect(r.bodyKeys).toEqual(['Abdomen', 'Torso'])
  })

  test.each([2, 3, 4])('%i: digestive tract', sub => {
    const r = random({ main: 11, sub })
    expect(path(r)).toBe('abdomen > digestive')
    expect(r.part).toBe('digestive')
    expect(r.notes).toEqual(expect.arrayContaining(['torsoCap', 'digestiveMajor']))
  })

  test('5: pelvis', () => expect(random({ main: 11, sub: 5 }).part).toBe('pelvis'))

  test('6: groin', () => {
    const r = random({ main: 11, sub: 6 })
    expect(path(r)).toBe('abdomen > groin')
    expect(r.upstream).toBe('Groin')
    expect(r.notes).toContain('groinShock')
  })
})

describe('sub-table F: the extremity', () => {
  test.each([[A('cr')], [A('cut')], [A('pi-')], [A('pi')], [TB]])('1: joint for %p', attack => {
    const r = random({ main: 15, side: 1, sub: 1 }, attack)
    expect(path(r)).toBe('hand:right > joint')
    expect(r.part).toBe('extremityJoint')
    expect(r.upstream).toBe('Hand')
    expect(r.crippleDivisor).toBe(4)
  })

  test.each([[A('imp')], [A('burn')], [A('cor')]])('1: just the extremity for %p', attack => {
    const r = random({ main: 16, side: 5, sub: 1 }, attack)
    expect(path(r)).toBe('foot:left')
    expect(r.part).toBe('foot')
  })

  test.each([2, 3, 4, 5, 6])('%i: extremity', sub => {
    const r = random({ main: 16, side: 1, sub })
    expect(r.part).toBe('foot')
    expect(r.notes).toContain('extremityCripple')
  })
})

describe('sub-table G: the neck', () => {
  test.each([[A('cut')], [A('imp')], [A('pi-')], [A('pi+')], [TB]])('1: vein/artery for %p', attack => {
    const r = random({ main: 17, sub: 1 }, attack, 'rear')
    expect(path(r)).toBe('neck > veinArtery')
    expect(r.part).toBe('neckVein')
    expect(r.upstream).toBe('Neck')
  })

  test('1: crushing from the rear hits the spine', () => {
    const r = random({ main: 18, sub: 1 }, A('cr'), 'rear')
    expect(path(r)).toBe('neck > spine')
    expect(r.part).toBe('spine')
    expect(r.upstream).toBe('Neck')
    expect(r.bodyKeys).toEqual(['Neck'])
    expect(r.zone).toBe('neck')
    expect(r.extraDR).toBe(3)
  })

  test.each<[DamageType, Facing]>([
    ['cr', 'front'],
    ['cr', 'side'],
    ['cor', 'rear'],
    ['burn', 'front'],
    ['tox', 'rear'],
  ])('1: %s from the %s is the neck', (type, facing) => {
    const r = random({ main: 17, sub: 1 }, A(type), facing)
    expect(path(r)).toBe('neck')
    expect(r.part).toBe('neck')
  })

  test.each([2, 3, 4, 5, 6])('%i: neck', sub => {
    const r = random({ main: 17, sub }, A('cut'), 'rear')
    expect(path(r)).toBe('neck')
    expect(r.bleedModifier).toBe(-2)
    expect(r.bleedFast).toBe(true)
  })
})

/* ---------------------------------------- */

describe('wounding multipliers', () => {
  const types: DamageType[] = ['cr', 'cut', 'imp', 'pi-', 'pi', 'pi+', 'pi++', 'burn', 'cor', 'tox']
  // cr, cut, imp, pi-, pi, pi+, pi++, burn, cor, tox
  const table: Record<Part, number[]> = {
    skull: [4, 4, 4, 4, 4, 4, 4, 4, 4, 1],
    eye: [4, 4, 4, 4, 4, 4, 4, 4, 4, 1],
    face: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1.5, 1],
    jaw: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1.5, 1],
    nose: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1.5, 1],
    ear: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1.5, 1],
    neck: [1.5, 2, 2, 0.5, 1, 1.5, 2, 1, 1.5, 1],
    neckVein: [2, 2.5, 2, 0.5, 1, 1.5, 2, 1, 2, 1],
    spine: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1, 1],
    chest: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1, 1],
    vitals: [1, 1.5, 3, 3, 3, 3, 3, 1, 1, 1],
    heart: [1, 1.5, 3, 3, 3, 3, 3, 1, 1, 1],
    abdomen: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1, 1],
    digestive: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1, 1],
    pelvis: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1, 1],
    groin: [1, 1.5, 2, 0.5, 1, 1.5, 2, 1, 1, 1],
    arm: [1, 1.5, 1, 0.5, 1, 1, 1, 1, 1, 1],
    leg: [1, 1.5, 1, 0.5, 1, 1, 1, 1, 1, 1],
    limbJoint: [1, 1.5, 1, 0.5, 1, 1, 1, 1, 1, 1],
    limbVein: [1.5, 2, 2, 0.5, 1, 1.5, 2, 1, 1.5, 1],
    hand: [1, 1.5, 1, 0.5, 1, 1, 1, 1, 1, 1],
    foot: [1, 1.5, 1, 0.5, 1, 1, 1, 1, 1, 1],
    extremityJoint: [1, 1.5, 1, 0.5, 1, 1, 1, 1, 1, 1],
  }

  for (const [part, expected] of Object.entries(table) as [Part, number[]][]) {
    test(`${part}`, () => expect(types.map(type => guhlMultiplier(part, A(type)))).toEqual(expected))
  }

  test('tight-beam burning: x2 on the vitals, otherwise as burning', () => {
    expect(guhlMultiplier('vitals', TB)).toBe(2)
    expect(guhlMultiplier('heart', TB)).toBe(2)
    expect(guhlMultiplier('chest', TB)).toBe(1)
    expect(guhlMultiplier('skull', TB)).toBe(4)
  })

  test('damage the chart has no opinion on (fatigue, generic) gives null', () => {
    expect(guhlMultiplier('skull', A('other'))).toBeNull()
    expect(guhlMultiplier('vitals', A('other'))).toBeNull()
  })
})

describe('bleeding, caps and crippling', () => {
  test.each<[TargetId, DamageType, number, boolean]>([
    ['neckVein', 'cut', -4, true],
    ['neckVein', 'imp', -3, true],
    ['vitals', 'pi', -4, true],
    ['heart', 'imp', -4, true],
    ['eye', 'pi', 0, true],
    ['groin', 'cr', 0, false],
    ['digestive', 'cut', 0, false],
  ])('%s with %s: bleed %i, fast %p', (target, type, modifier, fast) => {
    const r = hit(target, {}, A(type))
    expect(r.bleedModifier).toBe(modifier)
    expect(r.bleedFast).toBe(fast)
    expect(r.notes.includes('bleedFast')).toBe(fast)
  })

  test('limb vein bleeds at -4 for cutting, -3 otherwise', () => {
    expect(hit('limbVein', { limb: 1, side: 1 }, A('cut')).bleedModifier).toBe(-4)
    expect(hit('limbVein', { limb: 1, side: 1 }, A('pi')).bleedModifier).toBe(-3)
  })

  test('skull bleeds every 30 s; toxic skips the shock note', () => {
    const r = hit('skull', {}, A('cr'))
    expect(r.bleedFast).toBe(true)
    expect(r.notes).toEqual(expect.arrayContaining(['skullShock', 'skullDR', 'bleedFast']))
    expect(hit('skull', {}, A('tox')).notes).not.toContain('skullShock')
  })

  test('eye notes: toxic only cripples', () => {
    expect(hit('eye', {}, A('pi')).notes).toEqual(expect.arrayContaining(['eyeCripple', 'eyeSkull']))
    // Toxic can't target the eye: it falls back to the face.
    expect(hit('eye', { sub: 4 }, A('tox')).invalid).toEqual({ reason: 'type', target: 'eye' })
  })

  test('crushing: windpipe on the neck, knockdown on the vitals', () => {
    expect(hit('neck', { sub: 3 }, A('cr')).notes).toContain('neckWindpipe')
    expect(hit('neck', { sub: 3 }, A('cut')).notes).not.toContain('neckWindpipe')
    expect(hit('vitals', {}, A('cr')).notes).toContain('vitalsCrush')
    expect(hit('vitals', {}, A('pi')).notes).not.toContain('vitalsCrush')
  })

  test.each<[TargetId, Record<string, number>, boolean]>([
    ['chest', { sub: 3 }, true],
    ['abdomen', { sub: 5 }, true],
    ['digestive', {}, true],
    ['pelvis', {}, true],
    ['groin', {}, true],
    ['spine', {}, true],
    ['vitals', {}, false],
    ['neck', { sub: 3 }, false],
    ['skull', {}, false],
  ])('%s: torso injury cap %p', (target, values, capped) => {
    expect(hit(target, values, A('pi'), 'rear').injuryCap).toBe(capped)
  })
})

/* ---------------------------------------- */

describe('called shots', () => {
  test.each<[TargetId, number, number]>([
    ['skull', -7, -5],
    ['face', -5, -7],
    ['neck', -5, -5],
    ['chest', 0, 0],
    ['abdomen', -1, -1],
    ['arm', -2, -2],
    ['leg', -2, -2],
    ['hand', -4, -4],
    ['foot', -4, -4],
    ['insideThigh', -8, -11],
    ['random', 0, 0],
  ])('%s: %i from the front, %i from behind', (target, front, rear) => {
    expect(calledShotPenalty(target, { facing: 'front' })).toBe(front)
    expect(calledShotPenalty(target, { facing: 'rear' })).toBe(rear)
  })

  test('conditional penalties: shield, helmet, unarmed', () => {
    expect(calledShotPenalty('arm', { shield: true })).toBe(-4)
    expect(calledShotPenalty('hand', { shield: true })).toBe(-8)
    expect(calledShotPenalty('eye')).toBe(-9)
    expect(calledShotPenalty('eye', { helmet: true })).toBe(-10)
    expect(calledShotPenalty('openPalm')).toBe(-8)
    expect(calledShotPenalty('openPalm', { unarmed: true })).toBe(-6)
  })

  test.each<[TargetId, number]>([
    ['chinksTorso', -8],
    ['chinksOther', -10],
    ['ear', -7],
    ['nose', -7],
    ['jaw', -6],
    ['spine', -8],
    ['neckVein', -8],
    ['limbVein', -5],
    ['limbJoint', -5],
    ['extremityJoint', -7],
    ['vitals', -3],
    ['heart', -5],
    ['digestive', -3],
    ['pelvis', -3],
    ['groin', -3],
    ['armpit', -8],
    ['backOfKnee', -8],
    ['eyeslits', -10],
    ['codpiece', -8],
    ['insideElbow', -8],
    ['neckGap', -8],
  ])('%s: %i', (target, penalty) => expect(calledShotPenalty(target)).toBe(penalty))

  test.each<[TargetId, DamageType, Facing, 'type' | 'facing' | null]>([
    ['eye', 'pi', 'front', null],
    ['eye', 'cr', 'front', 'type'],
    ['eye', 'cut', 'front', 'type'],
    ['nose', 'cr', 'front', null],
    ['nose', 'cr', 'side', 'facing'],
    ['jaw', 'cut', 'rear', 'facing'],
    ['spine', 'cut', 'rear', null],
    ['spine', 'cut', 'front', 'facing'],
    ['spine', 'cor', 'rear', 'type'],
    ['spine', 'tox', 'rear', 'type'],
    ['neckVein', 'cut', 'front', null],
    ['neckVein', 'cr', 'front', 'type'],
    ['limbVein', 'pi-', 'front', null],
    ['limbVein', 'cr', 'front', 'type'],
    ['limbJoint', 'cr', 'front', null],
    ['limbJoint', 'imp', 'front', 'type'],
    ['extremityJoint', 'imp', 'front', 'type'],
    ['vitals', 'cr', 'front', null],
    ['vitals', 'cut', 'front', 'type'],
    ['heart', 'burn', 'front', 'type'],
    ['armpit', 'imp', 'front', null],
    ['armpit', 'pi', 'front', 'type'],
    ['eyeslits', 'pi++', 'front', null],
    ['eyeslits', 'cr', 'front', 'type'],
    ['groin', 'tox', 'rear', null],
    ['skull', 'tox', 'rear', null],
  ])('%s with %s from the %s: %p', (target, type, facing, problem) => {
    expect(calledShotProblem(target, A(type), facing)).toBe(problem)
  })

  test('tight-beam burning counts as "burn (tb)"', () => {
    expect(calledShotProblem('eye', TB, 'front')).toBeNull()
    expect(calledShotProblem('eye', A('burn'), 'front')).toBe('type')
    expect(typeMatches(TB, ['tb'])).toBe(true)
    expect(typeMatches(A('burn'), ['tb'])).toBe(false)
    expect(typeMatches(A('pi+'), ['pi*'])).toBe(true)
    expect(typeMatches(A('cut'), ['pi*', 'tb'])).toBe(false)
  })

  test.each<[TargetId, TargetId | null]>([
    ['ear', 'chest'],
    ['nose', 'chest'],
    ['jaw', 'chest'],
    ['spine', 'chest'],
    ['neck', 'chest'],
    ['neckVein', 'neck'],
    ['limbVein', 'limb'],
    ['limbJoint', 'limb'],
    ['extremityJoint', 'extremity'],
    ['vitals', null],
    ['skull', null],
    ['random', null],
  ])('miss by 1: %s -> %p', (target, to) => expect(missByOne(target)).toBe(to))

  test('miss by 1 names for the defense prompt', () => {
    expect(missByOneName(-1, true, false, 'Spine')).toBe('Torso')
    expect(missByOneName(-1, true, false, 'Neck Vein/Artery')).toBe('Neck')
    expect(missByOneName(-1, true, false, 'Limb Joint')).toBe('Limb')
    expect(missByOneName(-1, true, false, 'Extremity Joint')).toBe('Extremity')
    expect(missByOneName(-1, true, false, 'Ear')).toBe('Torso')
    expect(missByOneName(-2, true, false, 'Spine')).toBeNull()
    expect(missByOneName(-1, true, true, 'Spine')).toBeNull()
    expect(missByOneName(-1, false, false, 'Spine')).toBeNull()
    expect(missByOneName(-1, true, false, 'Vitals')).toBeNull()
    expect(missByOneName(-1, true, false, null)).toBeNull()
  })
})

describe('resolving called shots', () => {
  test('eye', () => {
    const r = hit('eye', {}, A('pi'))
    expect(path(r)).toBe('face > eyes')
    expect(r.part).toBe('eye')
    expect(r.invalid).toBeNull()
    expect(r.rolls).toEqual([])
  })

  test('eye with crushing falls back to the face (sub-table A)', () => {
    const r = hit('eye', { sub: 1 }, A('cr'))
    expect(r.invalid).toEqual({ reason: 'type', target: 'eye' })
    expect(path(r)).toBe('face > jaw')
    expect(r.notes[0]).toBe('invalidType')
  })

  test('ear: cutting hits the ear, anything else the face', () => {
    expect(hit('ear', {}, A('cut')).part).toBe('ear')
    const crush = hit('ear', {}, A('cr'))
    expect(crush.part).toBe('face')
    expect(crush.notes).toContain('earAsFace')
    expect(crush.invalid).toBeNull()
  })

  test('nose: crushing hits the nose, a bullet the skull', () => {
    expect(hit('nose', {}, A('cr')).part).toBe('nose')
    expect(hit('nose', {}, A('cut')).notes).toContain('noseCut')
    expect(hit('nose', {}, A('cr')).notes).toContain('noseCrush')
    const shot = hit('nose', {}, A('pi'))
    expect(shot.part).toBe('skull')
    expect(path(shot)).toBe('face > nose > skull')
  })

  test('nose from behind is not allowed: a face hit', () => {
    const r = hit('nose', { sub: 4 }, A('cr'), 'rear')
    expect(r.invalid).toEqual({ reason: 'facing', target: 'nose' })
    expect(path(r)).toBe('face > cheek')
    expect(r.notes[0]).toBe('invalidFacing')
  })

  test('jaw', () => expect(hit('jaw', {}, A('cr')).notes).toContain('jawShock'))

  test('spine from behind; from the front it is a chest hit', () => {
    const r = hit('spine', {}, A('pi'), 'rear')
    expect(r.part).toBe('spine')
    expect(r.extraDR).toBe(3)
    expect(r.notes).toEqual(expect.arrayContaining(['spineShock', 'spineCripple', 'spineDR']))
    const front = hit('spine', { sub: 3 }, A('pi'), 'front')
    expect(front.part).toBe('chest')
    expect(front.invalid).toEqual({ reason: 'facing', target: 'spine' })
  })

  test('neck vein/artery', () => {
    const r = hit('neckVein', {}, A('cut'))
    expect(path(r)).toBe('neck > veinArtery')
    expect(r.multiplier).toBe(2.5)
  })

  test.each([
    [1, 2, 'arm:right > shoulder > veinArtery', 'armR'],
    [3, 6, 'arm:left > shoulder > veinArtery', 'armL'],
    [4, 1, 'leg:right > thigh > veinArtery', 'legR'],
    [6, 4, 'leg:left > thigh > veinArtery', 'legL'],
  ])('limb vein: limb die %i, side die %i -> %s', (limb, side, expected, zone) => {
    const r = hit('limbVein', { limb, side }, A('cut'))
    expect(path(r)).toBe(expected)
    expect(r.zone).toBe(zone)
  })

  test('a named side skips the side roll', () => {
    const r = hit('limbVein', { limb: 5 }, A('imp'), 'front', 'left')
    expect(path(r)).toBe('leg:left > thigh > veinArtery')
    expect(r.rolls.map(x => x.key)).toEqual(['limb'])
  })

  test('limb joint: elbow or knee', () => {
    expect(path(hit('limbJoint', { limb: 2, side: 2 }, A('cr')))).toBe('arm:right > elbow > joint')
    expect(path(hit('limbJoint', { limb: 5, side: 5 }, A('cut')))).toBe('leg:left > knee > joint')
  })

  test('extremity joint: hand or foot', () => {
    expect(path(hit('extremityJoint', { extremity: 3, side: 4 }, A('cr')))).toBe('hand:left > joint')
    const foot = hit('extremityJoint', { extremity: 4, side: 1 }, A('cr'))
    expect(path(foot)).toBe('foot:right > joint')
    expect(foot.part).toBe('extremityJoint')
    expect(foot.upstream).toBe('Foot')
  })

  test('limb joint with impaling falls back to a random limb', () => {
    const r = hit('limbJoint', { limb: 1, side: 1, sub: 4 }, A('imp'))
    expect(r.invalid).toEqual({ reason: 'type', target: 'limbJoint' })
    expect(path(r)).toBe('arm:right > elbow')
  })

  test.each<[TargetId, string, Part]>([
    ['vitals', 'chest > vitals', 'vitals'],
    ['heart', 'chest > heart', 'heart'],
    ['digestive', 'abdomen > digestive', 'digestive'],
    ['pelvis', 'abdomen > pelvis', 'pelvis'],
    ['groin', 'abdomen > groin', 'groin'],
  ])('%s', (target, expected, part) => {
    const r = hit(target, {}, A('imp'))
    expect(path(r)).toBe(expected)
    expect(r.part).toBe(part)
  })

  test('heart is special for some characters', () => expect(hit('heart', {}, A('imp')).notes).toContain('heartSpecial'))

  test('vitals with cutting is a chest hit (sub-table D)', () => {
    const r = hit('vitals', { sub: 1 }, A('cut'), 'front')
    expect(r.part).toBe('chest')
    expect(r.invalid?.reason).toBe('type')
  })

  test('chinks in the torso: chest with sub-table, DR halved', () => {
    const r = hit('chinksTorso', { sub: 1 }, A('imp'))
    expect(path(r)).toBe('target.chinksTorso > chest > vitals')
    expect(r.halveDR).toBe(true)
    expect(r.armorGap).toBe(false)
    expect(r.notes).toContain('chinks')
  })

  test('chinks elsewhere: re-rolls torso results', () => {
    const r = hit('chinksOther', { main: 10, main2: 11, main3: 4 }, A('cut'))
    expect(path(r)).toBe('target.chinksOther > skull')
    expect(r.halveDR).toBe(true)
    expect(r.rolls.map(x => x.key)).toEqual(['main', 'main2', 'main3'])
  })

  test('chinks elsewhere: a limb on the first roll', () => {
    const r = hit('chinksOther', { main: 13, sub: 2 }, A('cut'))
    expect(path(r)).toBe('target.chinksOther > leg:left > shin')
  })

  test('armpit: an impaling armor gap over the vitals', () => {
    const r = hit('armpit', {}, A('imp'))
    expect(path(r)).toBe('target.armpit > chest > vitals')
    expect(r.armorGap).toBe(true)
    expect(r.notes).toEqual(expect.arrayContaining(['armorGap', 'armpitCritical']))
  })

  test('armpit with piercing is not allowed: a chest hit, no gap', () => {
    const r = hit('armpit', { sub: 2 }, A('pi'))
    expect(r.armorGap).toBe(false)
    expect(path(r)).toBe('chest')
    expect(r.notes).not.toContain('armorGap')
  })

  test('back of knee: a joint for joint damage types, else the leg', () => {
    const joint = hit('backOfKnee', { side: 2 }, A('cut'))
    expect(path(joint)).toBe('target.backOfKnee > leg:right > knee > joint')
    expect(joint.part).toBe('limbJoint')
    expect(joint.armorGap).toBe(true)
    const leg = hit('backOfKnee', { side: 5 }, A('imp'))
    expect(path(leg)).toBe('target.backOfKnee > leg:left > knee')
    expect(leg.part).toBe('leg')
  })

  test('inside elbow', () => {
    expect(hit('insideElbow', { side: 1 }, A('cr')).part).toBe('limbJoint')
    expect(hit('insideElbow', { side: 1 }, A('imp')).part).toBe('arm')
  })

  test('inside thigh: the optional vein rule for cut, imp, pi, tb burn', () => {
    const vein = hit('insideThigh', { side: 1 }, A('pi'))
    expect(vein.part).toBe('limbVein')
    expect(vein.notes).toContain('insideThighVein')
    expect(hit('insideThigh', { side: 1 }, A('cr')).part).toBe('leg')
  })

  test('eyeslits', () => {
    const r = hit('eyeslits', {}, A('pi'))
    expect(r.part).toBe('eye')
    expect(r.armorGap).toBe(true)
  })

  test('codpiece', () => {
    const r = hit('codpiece', {}, A('cr'))
    expect(r.part).toBe('groin')
    expect(r.armorGap).toBe(true)
  })

  test('neck gap rolls sub-table G', () => {
    const r = hit('neckGap', { sub: 1 }, A('cut'))
    expect(path(r)).toBe('target.neckGap > neck > veinArtery')
    expect(r.armorGap).toBe(true)
  })

  test('open palm rolls sub-table F', () => {
    const r = hit('openPalm', { side: 6, sub: 1 }, A('cr'))
    expect(path(r)).toBe('target.openPalm > hand:left > joint')
  })

  test('limb and extremity (miss-by-1 destinations) roll the limb, side and sub-table', () => {
    expect(path(hit('limb', { limb: 5, side: 2, sub: 5 }))).toBe('leg:right > thigh')
    expect(path(hit('extremity', { extremity: 2, side: 4, sub: 3 }))).toBe('hand:left')
  })

  test('main locations as called shots still roll their sub-table', () => {
    expect(path(hit('chest', { sub: 1 }, A('pi')))).toBe('chest > vitals')
    expect(path(hit('arm', { sub: 6 }, A('cut'), 'front', 'left'))).toBe('arm:left > shoulder > veinArtery')
    expect(path(hit('arm', { side: 4, sub: 2 }))).toBe('arm:left > forearm')
    expect(path(hit('leg', { side: 1, sub: 4 }, A('cr')))).toBe('leg:right > knee > joint')
    expect(path(hit('hand', { sub: 2 }, A('cr'), 'front', 'right'))).toBe('hand:right')
    expect(path(hit('foot', { side: 3, sub: 2 }))).toBe('foot:right')
    expect(path(hit('face', { sub: 6 }, A('imp')))).toBe('face > eyes')
    expect(path(hit('neck', { sub: 1 }, A('cr'), 'rear'))).toBe('neck > spine')
    expect(path(hit('abdomen', { sub: 6 }))).toBe('abdomen > groin')
    expect(hit('skull', {}).rolls).toEqual([])
  })
})

/* ---------------------------------------- */

describe('names and damage types', () => {
  test.each<[string, TargetId, string | null]>([
    ['Left Arm', 'arm', 'left'],
    ['right leg', 'leg', 'right'],
    ['Skull, from behind', 'skull', null],
    ['Brain', 'skull', null],
    ['Eyes', 'eye', null],
    ['Vitals, Heart', 'heart', null],
    ['Torso', 'chest', null],
    ['Neck (armor gap)', 'neckGap', null],
    ['Inside Thigh, from behind', 'insideThigh', null],
    ['Random', 'random', null],
    ['  spine ', 'spine', null],
  ])('%p -> %s', (name, target, side) => expect(aimFromName(name)).toEqual({ target, side }))

  test.each([['Tail'], ['Wing'], [''], [null], [undefined]])('%p is unknown', name =>
    expect(aimFromName(name)).toBeNull()
  )

  test('every picker entry and target name resolves', () => {
    for (const entry of PICKER_ENTRIES) expect(aimFromName(entry.name)).not.toBeNull()
    for (const name of Object.keys(TARGET_NAMES)) expect(aimFromName(name)).not.toBeNull()
  })

  test('every called-shot target has data', () => {
    const targets = new Set(Object.values(TARGET_NAMES).map(a => a.target))
    for (const target of targets) {
      if (target === 'random') continue
      expect(target in ROW_TARGETS || target in SPECIAL_TARGETS).toBe(true)
    }
  })

  test.each([
    ['cr', null, 'cr', false],
    ['crushing', null, 'cr', false],
    ['pi+', null, 'pi+', false],
    ['Large Piercing', null, 'pi+', false],
    ['burn', 'tbb', 'burn', true],
    ['burn', 'tb', 'burn', true],
    ['burn', 'ex', 'burn', false],
    ['cut', 'tbb', 'cut', false],
    ['fat', null, 'other', false],
    ['dmg', null, 'other', false],
    [undefined, undefined, 'other', false],
  ])('parseAttackType(%p, %p)', (type, modifier, expected, tb) => {
    expect(parseAttackType(type, modifier)).toEqual({ type: expected, tightBeam: tb })
  })

  test('zones', () => {
    expect(zoneOf('arm', 'left')).toBe('armL')
    expect(zoneOf('foot', null)).toBe('footR')
    expect(zoneOf('neck', 'left')).toBe('neck')
  })
})

describe('dice', () => {
  test('uniformRoller maps [0, 1) to 1-6 per die', () => {
    expect(uniformRoller(() => 0)('main', 3)).toBe(3)
    expect(uniformRoller(() => 0.9999)('main', 3)).toBe(18)
    expect(uniformRoller(() => 0.5)('sub', 1)).toBe(4)
  })

  test('replayRoller records new keys and replays known ones', () => {
    const record: Record<string, number> = { main: 9 }
    const roll = replayRoller(record, sequenceRoller([2, 6]))
    expect(roll('main', 3)).toBe(9)
    expect(roll('sub', 1)).toBe(2)
    expect(roll('sub', 1)).toBe(2)
    expect(roll('side', 1)).toBe(6)
    expect(record).toEqual({ main: 9, sub: 2, side: 6 })
  })

  test('sequenceRoller runs out', () => {
    const roll = sequenceRoller([1])
    roll('a', 1)
    expect(() => roll('b', 1)).toThrow()
  })

  test('a resolution records the dice it used', () => {
    const r = random({ main: 9, sub: 1 }, A('pi'))
    expect(r.rolls).toEqual([
      { key: 'main', dice: 3, value: 9 },
      { key: 'sub', dice: 1, value: 1 },
    ])
  })
})

describe('H and I: striking around partial armor', () => {
  test.each([
    [0, 0],
    [1, -1],
    [2, -1],
    [3, -2],
    [4, -2],
    [5, -3],
    [6, null],
  ])('pectorals %i/6 -> %p', (sixths, penalty) => expect(pectoralsPenalty(sixths)).toBe(penalty))

  test.each([
    [0, 0],
    [1, -1],
    [2, -1],
    [3, -2],
    [4, -3],
    [5, null],
  ])('other coverage %i/6 -> %p', (sixths, penalty) => expect(aroundCoveragePenalty(sixths)).toBe(penalty))
})
