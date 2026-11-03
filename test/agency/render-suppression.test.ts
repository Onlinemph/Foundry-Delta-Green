import { RenderSuppression } from '../../module/agency/sync/render-suppression.ts'

describe('RenderSuppression', () => {
  let clock: number
  let flushes: number
  let gate: RenderSuppression
  beforeEach(() => {
    clock = 1000
    flushes = 0
    gate = new RenderSuppression(() => flushes++, () => clock, 15_000)
  })

  test('renders requested while suppressed run once suppression ends', () => {
    gate.set(true)
    gate.markPending()
    gate.markPending()
    expect(flushes).toBe(0)
    gate.set(false)
    expect(flushes).toBe(1)
  })

  test('no flush when nothing was requested', () => {
    gate.set(true)
    gate.set(false)
    expect(flushes).toBe(0)
  })

  test('a flag left on lapses after the stale window and flushes pending renders', () => {
    gate.set(true)
    gate.markPending()
    clock += 14_000
    expect(gate.active).toBe(true)
    clock += 2_000
    expect(gate.active).toBe(false)
    expect(flushes).toBe(1)
  })

  test('nested set(true) does not extend the stale window', () => {
    gate.set(true)
    clock += 10_000
    gate.set(true)
    clock += 6_000
    expect(gate.active).toBe(false)
  })

  test('save/restore pattern (calculateDerivedValues) keeps an outer suppression', () => {
    gate.set(true) // outer multi-step update
    const saved = gate.active
    gate.set(true)
    gate.set(saved)
    expect(gate.active).toBe(true)
    gate.markPending()
    gate.set(false)
    expect(flushes).toBe(1)
  })
})
