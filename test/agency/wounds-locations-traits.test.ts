import {
  classifyLocation,
  isHeadOrTorso,
  largeAreaLocations,
  largeAreaReduction,
  limbKeyFor,
} from '../../module/agency/wounds/locations.js'
import { detectTraits, flattenTraits, traitLevel } from '../../module/agency/wounds/traits.js'

describe('classifyLocation', () => {
  test.each([
    // where, role, category, brain, vein, leg, limbKey
    ['Skull', null, 'head', true, false, false, null],
    ['Skull, from behind', null, 'head', true, false, false, null],
    ['Brain', null, 'head', true, false, false, null],
    ['Eye', null, 'head', true, false, false, null],
    ['Eyes', null, 'head', true, false, false, null],
    ['Face', null, 'head', false, false, false, null],
    ['Face, from behind', null, 'head', false, false, false, null],
    ['Jaw', null, 'head', false, false, false, null],
    ['Nose', null, 'head', false, false, false, null],
    ['Neck', null, 'neck', false, false, false, null],
    ['Neck Vein/Artery', null, 'neck', false, true, false, null],
    ['Vitals', null, 'vitals', false, false, false, null],
    ['Vitals, Heart', null, 'vitals', false, false, false, null],
    ['Torso', 'chest', 'torso', false, false, false, null],
    ['Torso', null, 'torso', false, false, false, null],
    ['Torso*', null, 'torso', false, false, false, null],
    ['Chest', null, 'torso', false, false, false, null],
    ['Chinks in Torso', null, 'torso', false, false, false, null],
    ['Groin', 'groin', 'groin', false, false, false, null],
    ['Right Arm', 'limb', 'limb', false, false, false, 'Right Arm'],
    ['Left Leg', 'limb', 'limb', false, false, true, 'Left Leg'],
    ['Right Arm, holding shield', null, 'limb', false, false, false, 'Right Arm'],
    ['Arm, holding shield', null, 'limb', false, false, false, 'Arm'],
    ['Foreleg', 'limb', 'limb', false, false, true, 'Foreleg'],
    ['Hind Leg', 'limb', 'limb', false, false, true, 'Hind Leg'],
    ['Mid Leg*', 'limb', 'limb', false, false, true, 'Mid Leg'],
    ['Leg 3-4', 'limb', 'limb', false, false, true, 'Leg 3-4'],
    ['Arm 1-2', 'limb', 'limb', false, false, false, 'Arm 1-2'],
    ['Wing', 'limb', 'limb', false, false, false, 'Wing'],
    ['Tail', 'limb', 'limb', false, false, false, 'Tail'],
    ['Tail', 'extremity', 'extremity', false, false, false, 'Tail'],
    ['Tail', null, 'extremity', false, false, false, 'Tail'],
    ['Hand', 'extremity', 'extremity', false, false, false, 'Hand'],
    ['Foot', 'extremity', 'extremity', false, false, false, 'Foot'],
    ['Feet', null, 'extremity', false, false, false, 'Feet'],
    ['Fin*', 'extremity', 'extremity', false, false, false, 'Fin'],
    ['Leg', null, 'limb', false, false, true, 'Leg'],
    ['Limb Vein/Artery', null, 'limb', false, true, false, 'Limb Vein/Artery'],
    ['Chinks in Other', null, 'other', false, false, false, null],
  ])('%p (role %p) -> %p', (where, role, category, brain, vein, leg, limbKey) => {
    const info = classifyLocation(where as string, role as string | null)
    expect(info.category).toBe(category)
    expect(info.brain).toBe(brain)
    expect(info.vein).toBe(vein)
    expect(info.leg).toBe(leg)
    expect(info.limbKey).toBe(limbKey)
  })

  it('reduces large-area injury by location', () => {
    expect(largeAreaReduction(classifyLocation('Skull'))).toBe(1)
    expect(largeAreaReduction(classifyLocation('Face'))).toBe(1)
    expect(largeAreaReduction(classifyLocation('Left Arm', 'limb'))).toBe(1)
    expect(largeAreaReduction(classifyLocation('Right Leg', 'limb'))).toBe(1)
    expect(largeAreaReduction(classifyLocation('Hand', 'extremity'))).toBe(2)
    expect(largeAreaReduction(classifyLocation('Foot', 'extremity'))).toBe(2)
    expect(largeAreaReduction(classifyLocation('Torso', 'chest'))).toBe(0)
    expect(largeAreaReduction(classifyLocation('Neck'))).toBe(0)
    expect(largeAreaReduction(classifyLocation('Groin', 'groin'))).toBe(0)
  })

  it('knows the head and torso for Fragile (Unnatural)', () => {
    expect(isHeadOrTorso(classifyLocation('Skull'))).toBe(true)
    expect(isHeadOrTorso(classifyLocation('Vitals'))).toBe(true)
    expect(isHeadOrTorso(classifyLocation('Torso'))).toBe(true)
    expect(isHeadOrTorso(classifyLocation('Right Arm', 'limb'))).toBe(false)
    expect(isHeadOrTorso(classifyLocation('Hand', 'extremity'))).toBe(false)
  })

  it('lists the surface locations a large-area injury hits', () => {
    const humanoid = [
      { where: 'Eye', roll: '-' },
      { where: 'Skull', roll: '3-4' },
      { where: 'Face', roll: '5' },
      { where: 'Right Leg', roll: '6-7' },
      { where: 'Right Arm', roll: '8' },
      { where: 'Torso', roll: '9-10' },
      { where: 'Groin', roll: '11' },
      { where: 'Left Arm', roll: '12' },
      { where: 'Left Leg', roll: '13-14' },
      { where: 'Hand', roll: '15' },
      { where: 'Foot', roll: '16' },
      { where: 'Neck', roll: '17-18' },
      { where: 'Vitals', roll: '-' },
    ]
    expect(largeAreaLocations(humanoid)).toEqual([
      'Skull',
      'Face',
      'Right Leg',
      'Right Arm',
      'Torso',
      'Groin',
      'Left Arm',
      'Left Leg',
      'Hand',
      'Foot',
      'Neck',
    ])
    expect(
      largeAreaLocations([
        { where: 'Torso', roll: '9-12' },
        { where: 'Torso*', roll: '15-16' },
        { where: 'Vitals', roll: '3' },
      ])
    ).toEqual(['Torso'])
  })

  it('normalizes limb keys', () => {
    expect(limbKeyFor('Left Arm, holding shield')).toBe('Left Arm')
    expect(limbKeyFor('Tail**')).toBe('Tail')
  })
})

describe('detectTraits', () => {
  it('finds nothing in an empty list', () => {
    expect(detectTraits(undefined)).toMatchObject({ highPainThreshold: false, injuryTolerance: null, hardToSubdue: 0 })
  })

  it('reads leveled traits from the level or the name', () => {
    expect(traitLevel({ name: 'Hard to Subdue 3' })).toBe(3)
    expect(traitLevel({ name: 'Hard to Kill', level: 2 })).toBe(2)
    expect(traitLevel({ name: 'Hard to Kill' })).toBe(1)
    const traits = detectTraits({
      a: { name: 'Hard to Subdue 2', level: 2 },
      b: { name: 'Hard to Kill 4' },
      c: { name: 'High Pain Threshold' },
    })
    expect(traits).toMatchObject({ hardToSubdue: 2, hardToKill: 4, highPainThreshold: true })
  })

  it('finds traits inside containers', () => {
    const ads = { x: { name: 'Template', contains: { y: { name: 'Hemophilia' }, z: { name: 'Rapid Healing' } } } }
    expect(flattenTraits(ads)).toHaveLength(3)
    expect(detectTraits(ads)).toMatchObject({ hemophilia: true, rapidHealing: true })
  })

  test.each([
    [{ name: 'Injury Tolerance (Unliving)' }, 'unliving'],
    [{ name: 'Unliving' }, 'unliving'],
    [{ name: 'Injury Tolerance', notes: 'Unliving' }, 'unliving'],
    [{ name: 'Injury Tolerance (Homogenous)' }, 'homogeneous'],
    [{ name: 'Injury Tolerance', notes: 'Homogeneous; No Blood' }, 'homogeneous'],
    [{ name: 'Diffuse' }, 'diffuse'],
    [{ name: 'Injury Tolerance', notes: 'Diffuse' }, 'diffuse'],
    [{ name: 'Injury Tolerance (Damage Reduction 2)' }, null],
  ])('Injury Tolerance from %p', (trait, expected) => {
    expect(detectTraits([trait]).injuryTolerance).toBe(expected)
  })

  it('keeps the strongest Injury Tolerance', () => {
    expect(detectTraits([{ name: 'Diffuse' }, { name: 'Unliving' }]).injuryTolerance).toBe('diffuse')
  })

  it('finds Fragile (Unnatural) but not other Fragile', () => {
    expect(detectTraits([{ name: 'Fragile (Unnatural)' }]).fragileUnnatural).toBe(true)
    expect(detectTraits([{ name: 'Fragile', notes: 'Unnatural' }]).fragileUnnatural).toBe(true)
    expect(detectTraits([{ name: 'Fragile (Brittle)' }]).fragileUnnatural).toBe(false)
  })
})
