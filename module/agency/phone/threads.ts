/**
 * Turning the flat list of phone messages into what one device shows: conversation threads (one per
 * counterpart number), the messages in a thread, unread counts, and the call log.
 *
 * A message belongs to a device by device id when it carries one, else by number (numbers nobody
 * held when the message was sent: an NPC identity created later still sees its texts).
 * Outgoing messages are always visible to their sender; incoming ones only once delivered.
 */
import type { CallOutcome, DeviceKey, Endpoint, PhoneMsg } from './types.ts'

export function endpointIs(ep: Endpoint, me: DeviceKey): boolean {
  if (ep.device) return ep.device === me.id
  return !!ep.number && ep.number === me.number
}

export type Direction = 'out' | 'in'

export function direction(msg: PhoneMsg, me: DeviceKey): Direction | null {
  // A device texting its own number sees the message once, as outgoing.
  if (endpointIs(msg.from, me)) return 'out'
  if (endpointIs(msg.to, me)) return 'in'
  return null
}

export function visibleTo(msg: PhoneMsg, dir: Direction | null): boolean {
  if (dir === 'out') return true
  return dir === 'in' && msg.state === 'delivered'
}

export function counterpart(msg: PhoneMsg, dir: Direction): Endpoint {
  return dir === 'out' ? msg.to : msg.from
}

const byTs = (a: PhoneMsg, b: PhoneMsg) => a.ts - b.ts || a.id.localeCompare(b.id)

/** The messages this device can see, oldest first, with their direction. */
export function deviceMessages(
  msgs: PhoneMsg[],
  me: DeviceKey,
  type?: 'sms' | 'call'
): { msg: PhoneMsg; dir: Direction }[] {
  const out: { msg: PhoneMsg; dir: Direction }[] = []
  for (const msg of [...msgs].sort(byTs)) {
    if (type && msg.type !== type) continue
    const dir = direction(msg, me)
    if (dir && visibleTo(msg, dir)) out.push({ msg, dir })
  }
  return out
}

export interface ThreadSummary {
  /** Counterpart number. */
  key: string
  last: PhoneMsg
  lastDir: Direction
  unread: number
  count: number
  /** Any of my messages still in the outbox. */
  sending: boolean
}

export function isUnread(msg: PhoneMsg, dir: Direction, read: Record<string, number>, key: string): boolean {
  return dir === 'in' && msg.state === 'delivered' && msg.deliveredTs > (read[key] ?? 0)
}

/** One summary per counterpart, newest conversation first. */
export function buildThreads(msgs: PhoneMsg[], me: DeviceKey, read: Record<string, number> = {}): ThreadSummary[] {
  const threads = new Map<string, ThreadSummary>()
  for (const { msg, dir } of deviceMessages(msgs, me, 'sms')) {
    const key = counterpart(msg, dir).number
    const t = threads.get(key) ?? { key, last: msg, lastDir: dir, unread: 0, count: 0, sending: false }
    t.last = msg
    t.lastDir = dir
    t.count++
    if (isUnread(msg, dir, read, key)) t.unread++
    if (dir === 'out' && msg.state === 'outbox') t.sending = true
    threads.set(key, t)
  }
  return [...threads.values()].sort((a, b) => byTs(b.last, a.last))
}

export function threadMessages(msgs: PhoneMsg[], me: DeviceKey, key: string): { msg: PhoneMsg; dir: Direction }[] {
  return deviceMessages(msgs, me, 'sms').filter(({ msg, dir }) => counterpart(msg, dir).number === key)
}

/** The read marker to store after the owner looked at a thread: newest deliveredTs in it. */
export function readMarker(msgs: PhoneMsg[], me: DeviceKey, key: string): number {
  let max = 0
  for (const { msg, dir } of threadMessages(msgs, me, key)) if (dir === 'in') max = Math.max(max, msg.deliveredTs)
  return max
}

export function unreadTotal(msgs: PhoneMsg[], me: DeviceKey, read: Record<string, number> = {}): number {
  return buildThreads(msgs, me, read).reduce((n, t) => n + t.unread, 0)
}

export interface RecentCall {
  id: string
  key: string
  dir: Direction
  outcome: CallOutcome
  /** Missed or declined incoming call. */
  missed: boolean
  duration: number
  sentAt: number
  deliveredTs: number
}

/** Call log, newest first. */
export function recentCalls(msgs: PhoneMsg[], me: DeviceKey): RecentCall[] {
  return deviceMessages(msgs, me, 'call')
    .map(({ msg, dir }) => {
      const outcome: CallOutcome = msg.outcome ?? 'missed'
      return {
        id: msg.id,
        key: counterpart(msg, dir).number,
        dir,
        outcome,
        missed: dir === 'in' && outcome !== 'answered',
        duration: msg.duration ?? 0,
        sentAt: msg.sentAt,
        deliveredTs: msg.deliveredTs,
      }
    })
    .reverse()
}

export function missedCalls(msgs: PhoneMsg[], me: DeviceKey, seen: number): number {
  return recentCalls(msgs, me).filter(c => c.missed && c.deliveredTs > seen).length
}

export function callsSeenMarker(msgs: PhoneMsg[], me: DeviceKey): number {
  return recentCalls(msgs, me).reduce((max, c) => (c.missed ? Math.max(max, c.deliveredTs) : max), 0)
}

/** Text shown in a thread list for the last message. */
export function snippet(msg: PhoneMsg, photoLabel: string, max = 60): string {
  const text = (msg.text ?? '').replace(/\s+/g, ' ').trim()
  const base = text || (msg.photo ? photoLabel : '')
  return base.length > max ? base.slice(0, max - 1) + '…' : base
}
