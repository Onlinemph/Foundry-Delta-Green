import { jest } from '@jest/globals'

// Modules below pull in upstream settings, which load sheets and combat; keep them out of the test.
jest.unstable_mockModule('../../lib/miscellaneous-settings.js', () => ({ SYSTEM_NAME: 'gurps' }))

const { defenseAvailability } = await import('../../module/agency/defense/rules.ts')
const { isIncapacitated } = await import('../../module/agency/defense/flow.ts')
const { matchSpecials } = await import('../../module/agency/explosions/specials.ts')

const ranged = { kind: 'ranged', thrown: false, firearm: true } as any

describe('integration fixes', () => {
  test('unconscious or dead characters get no active defense', () => {
    expect(isIncapacitated(['unconscious'])).toBe(true)
    expect(isIncapacitated(['dead'])).toBe(true)
    expect(isIncapacitated(['stun', 'prone'])).toBe(false)
    const situation = { attack: ranged, isCritical: false, maneuverRule: 'any', cantSee: false, hasParry: true, hasBlock: true }
    expect(defenseAvailability({ ...situation, incapacitated: true } as any).noDefense).toBe('incapacitated')
    expect(defenseAvailability(situation as any).noDefense).toBeNull()
  })

  test('a stun baton or stun gun is not a stun grenade', () => {
    const none = (name: string) => matchSpecials({ name, damage: '1d-3 cr', notes: '', spec: null } as any)
    expect(none('Stun Baton').affliction).toBeFalsy()
    expect(none('Stun Gun').affliction).toBeFalsy()
    expect(none('Stun Grenade').affliction).toBeTruthy()
    expect(none('Flashbang').affliction).toBeTruthy()
  })
})

describe('wounds read the hit-location injury cap', () => {
  test('chest injury over the cap is lost', async () => {
    jest.unstable_mockModule('../../module/token-actions.js', () => ({ TokenActions: class {} }))
    const { rfhInjury } = await import('../../module/agency/wounds/apply-damage.ts')
    expect(rfhInjury({ _parent: { agencyInjuryCap: 20 }, unmodifiedPointsToApply: 50 })).toBe(20)
    expect(rfhInjury({ _parent: { agencyInjuryCap: null }, unmodifiedPointsToApply: 50 })).toBe(50)
    expect(rfhInjury({ _parent: {}, unmodifiedPointsToApply: 7 })).toBe(7)
  })
})
