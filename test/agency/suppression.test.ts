import { isExempt, leaveCoverPenalty, resolvePin, underFire } from '../../module/agency/suppression/rules.ts'

describe('pinned by fire (Tactical Shooting p. 21)', () => {
  test('Combat Reflexes and Unfazeable are immune', () => {
    expect(isExempt(['Combat Reflexes'])).toBe(true)
    expect(isExempt(['Unfazeable'])).toBe(true)
    expect(isExempt(['Fearlessness 2', 'High Pain Threshold'])).toBe(false)
  })

  test('rolls against Will-2', () => {
    const steady = resolvePin(12, 10)
    expect(steady.target).toBe(10)
    expect(steady.success).toBe(true)
    const pinned = resolvePin(12, 13)
    expect(pinned.success).toBe(false)
    expect(pinned.margin).toBe(-3)
  })

  test('3-4 always succeed, 17-18 always fail', () => {
    expect(resolvePin(5, 4).success).toBe(true)
    expect(resolvePin(20, 17).success).toBe(false)
    expect(resolvePin(20, 18).success).toBe(false)
  })

  test('a PC leaving cover takes the margin of failure as a penalty', () => {
    expect(leaveCoverPenalty(resolvePin(12, 13))).toBe(-3)
    expect(leaveCoverPenalty(resolvePin(12, 9))).toBe(0)
  })

  const at = (id: string, x: number) => ({ id, x, y: 0 })
  const yards = (a: { x: number }, b: { x: number }) => Math.abs(a.x - b.x)

  test('targets are always under fire; the shooter never is', () => {
    expect(underFire([at('t', 10)], [at('s', 0)], { missed: false, radius: 2, shooterId: 's', yards })).toEqual(['t'])
  })

  test('a miss also puts tokens near the target under fire', () => {
    const others = [at('near', 11), at('far', 20), at('t', 10), at('s', 0)]
    expect(underFire([at('t', 10)], others, { missed: true, radius: 2, shooterId: 's', yards }).sort()).toEqual([
      'near',
      't',
    ])
    expect(underFire([at('t', 10)], others, { missed: false, radius: 2, shooterId: 's', yards })).toEqual(['t'])
    expect(underFire([at('t', 10)], others, { missed: true, radius: 0, shooterId: 's', yards })).toEqual(['t'])
  })
})
