import { jest } from '@jest/globals'

// hitloc/settings.ts imports upstream's settings module, which pulls in sheets and combat.
jest.unstable_mockModule('../../lib/miscellaneous-settings.js', () => ({ SYSTEM_NAME: 'gurps' }))

const { coveredLocations, zoneOfWhere } = await import('../../module/agency/hitloc/api.ts')

const actor = {
  hitLocationsWithDR: [
    'Eye',
    'Skull',
    'Face',
    'Neck',
    'Left Arm',
    'Right Arm',
    'Torso',
    'Vitals',
    'Groin',
    'Hand',
    'Left Leg',
    'Right Leg',
    'Foot',
  ].map(where => ({ where, dr: 0 })),
}

const tokenWith = (cover: unknown) => ({ flags: { gurps: { agency: { cover } } } })

describe('hitloc API: covered locations for other features', () => {
  test('no cover flag or preset none gives null', () => {
    expect(coveredLocations(actor, tokenWith(undefined))).toBeNull()
    expect(coveredLocations(actor, tokenWith({ preset: 'none', dr: 6 }))).toBeNull()
  })

  test('low wall covers the legs and feet and carries its DR', () => {
    const result = coveredLocations(actor, tokenWith({ preset: 'lowWall', dr: 8 }))
    expect(result?.dr).toBe(8)
    expect(result?.locations).toEqual(expect.arrayContaining(['Left Leg', 'Right Leg']))
    expect(result?.locations).not.toContain('Skull')
    expect(result?.locations).not.toContain('Neck')
  })

  test('full cover covers everything', () => {
    const result = coveredLocations(actor, tokenWith({ preset: 'full', dr: 4 }))
    expect(result?.locations).toHaveLength(actor.hitLocationsWithDR.length)
  })

  test('custom zones: only fully covered parts count', () => {
    const result = coveredLocations(
      actor,
      tokenWith({ preset: 'custom', zones: { legL: 'covered', legR: 'half' }, dr: 3 })
    )
    expect(result?.locations).toEqual(['Left Leg'])
  })

  test('zones for sided and unsided locations', () => {
    expect(zoneOfWhere('Left Arm')).toBe('armL')
    expect(zoneOfWhere('Right Leg')).toBe('legR')
    expect(zoneOfWhere('Skull')).toBe('skull')
    expect(zoneOfWhere('Torso')).toBe('chest')
  })
})
