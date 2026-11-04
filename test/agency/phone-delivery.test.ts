import {
  agentHasSignal,
  catchUp,
  initialDelivery,
  nextDelivery,
  sceneHasSignal,
  signalBars,
  type PendingItem,
} from '../../module/agency/phone/delivery.ts'
import type { Endpoint } from '../../module/agency/phone/types.ts'

const A: Endpoint = { number: '2025550143', device: 'a1:smartphone' }
const B: Endpoint = { number: '2025550158', device: 'b1:burner' }
const NPC: Endpoint = { number: '2025550100', device: 'npc:x' }

describe('signal', () => {
  test('no token anywhere means signal', () => {
    expect(agentHasSignal([], () => false, 's1')).toBe(true)
  })

  test('the active scene decides when a token is there', () => {
    const signal = (id: string) => id !== 'cellar'
    expect(agentHasSignal(['cellar', 'street'], signal, 'cellar')).toBe(false)
    expect(agentHasSignal(['cellar', 'street'], signal, 'street')).toBe(true)
  })

  test('otherwise any scene with signal will do', () => {
    expect(agentHasSignal(['cellar', 'street'], id => id === 'street', 'elsewhere')).toBe(true)
    expect(agentHasSignal(['cellar'], () => false, null)).toBe(false)
  })

  test('scene flag: missing means on', () => {
    expect(sceneHasSignal(undefined)).toBe(true)
    expect(sceneHasSignal(true)).toBe(true)
    expect(sceneHasSignal(false)).toBe(false)
  })

  test('bars', () => {
    expect(signalBars(false)).toBe(0)
    expect([3, 4]).toContain(signalBars(true, 'scene'))
  })
})

describe('delivery state machine', () => {
  test('initial state', () => {
    expect(initialDelivery(true, true)).toBe('delivered')
    expect(initialDelivery(true, false)).toBe('held')
    expect(initialDelivery(false, true)).toBe('outbox')
    expect(initialDelivery(false, false)).toBe('outbox')
  })

  test('outbox waits for the sender, then goes to held or delivered', () => {
    expect(nextDelivery('outbox', false, true)).toBe('outbox')
    expect(nextDelivery('outbox', true, false)).toBe('held')
    expect(nextDelivery('outbox', true, true)).toBe('delivered')
  })

  test('held waits for the recipient only; delivered never moves back', () => {
    expect(nextDelivery('held', false, false)).toBe('held')
    expect(nextDelivery('held', false, true)).toBe('delivered')
    expect(nextDelivery('delivered', false, false)).toBe('delivered')
  })

  test('catch-up reports only changes, and calls ignore the caller', () => {
    const items: PendingItem[] = [
      { id: '1', type: 'sms', state: 'outbox', from: A, to: B },
      { id: '2', type: 'sms', state: 'held', from: NPC, to: A },
      { id: '3', type: 'call', state: 'held', from: B, to: A },
      { id: '4', type: 'sms', state: 'delivered', from: A, to: NPC },
      { id: '5', type: 'sms', state: 'outbox', from: B, to: NPC },
    ]
    // A just walked out of the dead zone; B is still in it.
    const signal = (ep: Endpoint) => ep.device !== B.device
    expect(catchUp(items, signal)).toEqual([
      { id: '1', state: 'held' },
      { id: '2', state: 'delivered' },
      { id: '3', state: 'delivered' },
    ])
    // Then B gets signal too.
    const all = catchUp(
      [
        { id: '1', type: 'sms', state: 'held', from: A, to: B },
        { id: '5', type: 'sms', state: 'outbox', from: B, to: NPC },
      ],
      () => true
    )
    expect(all).toEqual([
      { id: '1', state: 'delivered' },
      { id: '5', state: 'delivered' },
    ])
  })

  test('catch-up asks about each endpoint once', () => {
    let calls = 0
    const items: PendingItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      type: 'sms',
      state: 'held',
      from: NPC,
      to: A,
    }))
    catchUp(items, () => {
      calls++
      return false
    })
    // Once for the sender, once for the recipient, not once per message.
    expect(calls).toBe(2)
  })
})
