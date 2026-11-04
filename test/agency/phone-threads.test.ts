import {
  buildThreads,
  callsSeenMarker,
  direction,
  missedCalls,
  readMarker,
  recentCalls,
  snippet,
  threadMessages,
  unreadTotal,
} from '../../module/agency/phone/threads.ts'
import type { DeliveryState, DeviceKey, Endpoint, PhoneMsg } from '../../module/agency/phone/types.ts'

const MARA: DeviceKey = { id: 'mara:smartphone', number: '2025550143' }
const TOM: DeviceKey = { id: 'tom:smartphone', number: '2025550158' }
const HANDLER = '2025550100'
const ep = (k: DeviceKey): Endpoint => ({ number: k.number, device: k.id })

let ts = 0
function sms(
  from: Endpoint,
  to: Endpoint,
  text: string,
  state: DeliveryState = 'delivered',
  extra: Partial<PhoneMsg> = {}
): PhoneMsg {
  ts += 10
  return {
    v: 1,
    id: `m${ts}`,
    ts,
    type: 'sms',
    from,
    to,
    state,
    sentAt: ts,
    deliveredTs: state === 'delivered' ? ts : 0,
    text,
    ...extra,
  }
}
function call(
  from: Endpoint,
  to: Endpoint,
  outcome: 'answered' | 'missed' | 'declined',
  duration = 0,
  state: DeliveryState = 'delivered'
): PhoneMsg {
  ts += 10
  return {
    v: 1,
    id: `c${ts}`,
    ts,
    type: 'call',
    from,
    to,
    state,
    sentAt: ts,
    deliveredTs: state === 'delivered' ? ts : 0,
    outcome,
    duration,
  }
}

describe('threads', () => {
  const handler: Endpoint = { number: HANDLER, device: 'npc:h' }
  const msgs = [
    sms(handler, ep(MARA), 'Package is in room 14.'),
    sms(ep(MARA), handler, 'Copy.'),
    sms(ep(TOM), ep(MARA), 'You up?'),
    sms(handler, ep(MARA), 'Photograph the plates.'),
    sms(ep(MARA), ep(TOM), 'Yes. Radio is weird.', 'held'), // Tom is in a dead zone
    sms(ep(MARA), handler, 'On it', 'outbox'), // Mara is in a dead zone
  ]

  test('one thread per counterpart, newest first, keyed by number', () => {
    const threads = buildThreads(msgs, MARA)
    expect(threads.map(t => t.key)).toEqual([HANDLER, TOM.number])
    expect(threads[0].count).toBe(4)
    expect(threads[0].sending).toBe(true)
    expect(threads[0].lastDir).toBe('out')
  })

  test('held messages: the sender sees them, the recipient does not (yet)', () => {
    expect(threadMessages(msgs, MARA, TOM.number).map(x => x.msg.text)).toEqual(['You up?', 'Yes. Radio is weird.'])
    expect(threadMessages(msgs, TOM, MARA.number).map(x => x.msg.text)).toEqual(['You up?'])
  })

  test('unread counts and read markers', () => {
    expect(unreadTotal(msgs, MARA)).toBe(3)
    const marker = readMarker(msgs, MARA, HANDLER)
    const read = { [HANDLER]: marker }
    expect(unreadTotal(msgs, MARA, read)).toBe(1)
    expect(buildThreads(msgs, MARA, read).find(t => t.key === HANDLER)!.unread).toBe(0)
    // Outgoing messages never count.
    expect(unreadTotal(msgs, TOM)).toBe(0)
  })

  test('a message delivered later is unread even if the thread was opened while it was held', () => {
    const held = sms(ep(TOM), ep(MARA), 'later', 'held')
    const read = { [TOM.number]: readMarker([...msgs, held], MARA, TOM.number) }
    expect(unreadTotal([held], MARA, read)).toBe(0)
    const delivered = { ...held, state: 'delivered' as const, deliveredTs: 999_999 }
    expect(unreadTotal([delivered], MARA, read)).toBe(1)
  })

  test('numbers nobody held: an NPC identity created later sees its texts', () => {
    const toUnknown = sms(ep(MARA), { number: '3125550199' }, 'Who is this?')
    const npc: DeviceKey = { id: 'npc:new', number: '3125550199' }
    expect(direction(toUnknown, npc)).toBe('in')
    expect(direction(toUnknown, MARA)).toBe('out')
    // An identity holding the number of a message addressed to another device does not.
    expect(direction(sms(ep(MARA), ep(TOM), 'x'), { id: 'npc:z', number: TOM.number })).toBeNull()
  })

  test('snippets', () => {
    expect(snippet(sms(handler, ep(MARA), 'a   b\n c'), 'Photo')).toBe('a b c')
    expect(snippet(sms(handler, ep(MARA), '', 'delivered', { photo: { src: 'x.jpg', w: 4, h: 3 } }), 'Photo')).toBe(
      'Photo'
    )
    expect(snippet(sms(handler, ep(MARA), 'x'.repeat(100)), 'Photo', 10)).toBe('xxxxxxxxx…')
  })
})

describe('call log', () => {
  const handler: Endpoint = { number: HANDLER, device: 'npc:h' }
  const log = [
    call(ep(MARA), handler, 'answered', 252),
    call(ep(TOM), ep(MARA), 'missed'),
    call(handler, ep(MARA), 'declined'),
    call(ep(TOM), ep(MARA), 'missed', 0, 'held'), // Mara had no signal: she hears about it later
    sms(handler, ep(MARA), 'not a call'),
  ]

  test('recents, newest first, with direction and duration', () => {
    const recents = recentCalls(log, MARA)
    expect(recents.map(r => [r.dir, r.outcome, r.missed])).toEqual([
      ['in', 'declined', true],
      ['in', 'missed', true],
      ['out', 'answered', false],
    ])
    expect(recents[2].duration).toBe(252)
    expect(recentCalls(log, TOM).map(r => r.dir)).toEqual(['out', 'out'])
  })

  test('missed-call badge clears when Recents is seen', () => {
    expect(missedCalls(log, MARA, 0)).toBe(2)
    expect(missedCalls(log, MARA, callsSeenMarker(log, MARA))).toBe(0)
  })
})
