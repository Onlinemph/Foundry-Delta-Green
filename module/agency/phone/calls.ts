/**
 * Real-time calls over the system socket (module/agency/defense/socket.ts, addressed to one user).
 *
 * The caller's client runs the call: it rings every online user who answers the number (the players
 * who own the agent, or the GMs for NPC numbers), times out after 30 s, tells the others when one
 * answers, and writes the call-log entry when the call ends. Either side can hang up, mute, and type
 * subtitle lines that both screens show (the voices are on the table's own voice chat).
 *
 * Each side keeps its own CallState (call-state.ts); this file turns socket messages into events.
 */
import { emitSocket, onSocket } from '../defense/socket.ts'
import { callReduce, logOutcome, newCall, RING_TIMEOUT_MS, type CallEnd, type CallState } from './call-state.ts'
import { phoneChanged } from './sync.ts'
import { playBeep, playError, startRingback, startRingtone, startVibrate } from './sounds.ts'
import {
  canOpen,
  deviceHasSignal,
  deviceKey,
  deviceUsers,
  endpointFor,
  endpointHasSignal,
  logCall,
  resolveNumber,
  upsertNpc,
} from './store.ts'
import { npcIdentities } from './settings.ts'
import { formatNumber } from './numbers.ts'
import { randomId, type DeviceId, type Endpoint } from './types.ts'

const T = {
  ring: 'phone.ring',
  answer: 'phone.answer',
  decline: 'phone.decline',
  cancel: 'phone.cancel',
  end: 'phone.end',
  say: 'phone.say',
  mute: 'phone.mute',
  busy: 'phone.busy',
} as const

interface Side {
  state: CallState
  /** Caller: the users being rung. */
  ringing: string[]
  timer: ReturnType<typeof setTimeout> | null
  stopSound: (() => void) | null
  logged: boolean
}

/** Keyed `${role}:${id}` so a user on both ends of a call (two agents) keeps both sides. */
const sides = new Map<string, Side>()
const keyOf = (role: 'caller' | 'callee', id: string) => `${role}:${id}`

type OpenDevice = (id: DeviceId, opts?: { focus?: boolean }) => void
type Notify = (id: DeviceId, text: string) => void
let openDevice: OpenDevice = () => {}
let notifyIncoming: Notify = () => {}

export function configureCalls(open: OpenDevice, notify: Notify): void {
  openDevice = open
  notifyIncoming = notify
}

const me = () => game.user?.id ?? ''

/** Socket send that also reaches this client when it is the addressee. */
function send(type: string, userId: string, data: unknown): void {
  if (!userId) return
  if (userId === me()) {
    queueMicrotask(() => handlers[type]?.(data))
    return
  }
  emitSocket(type, userId, data)
}

/** The call on screen for a device: live, or ended in the last few seconds. */
export function callFor(device: DeviceId): CallState | null {
  let best: CallState | null = null
  for (const side of sides.values()) {
    if (side.state.local !== device) continue
    if (!best || side.state.createdAt > best.createdAt) best = side.state
  }
  return best
}

export function liveCall(device: DeviceId): CallState | null {
  const c = callFor(device)
  return c && c.phase !== 'ended' ? c : null
}

function update(side: Side, next: CallState): void {
  side.state = next
  phoneChanged()
}

function stopSound(side: Side): void {
  side.stopSound?.()
  side.stopSound = null
}

function finish(side: Side, reason: CallEnd): void {
  if (side.timer) clearTimeout(side.timer)
  side.timer = null
  stopSound(side)
  const was = side.state.phase
  update(side, callReduce(side.state, { t: 'end', at: Date.now(), reason }))
  if (was === 'active') playBeep(false)
  // Drop the ended call from screens after a moment.
  const key = keyOf(side.state.role, side.state.id)
  setTimeout(() => {
    if (sides.get(key) === side) {
      sides.delete(key)
      phoneChanged()
    }
  }, 2600)
}

/** Caller only: write the call log once. */
async function log(side: Side, held = false): Promise<void> {
  if (side.logged || side.state.role !== 'caller') return
  side.logged = true
  try {
    await logCall(side.state, logOutcome(side.state), { held })
  } catch (err) {
    console.error('GURPS | Agency | phone: call log failed', err)
  }
}

export function dismiss(device: DeviceId): void {
  for (const [key, side] of sides) {
    if (side.state.local === device && side.state.phase === 'ended') sides.delete(key)
  }
  phoneChanged()
}

// ---------------------------------------------------------------------------------------------
// Caller

export async function dial(from: DeviceId, toNumber: string): Promise<void> {
  if (liveCall(from)) return
  const local = deviceKey(from)
  if (!local) return
  const remote = resolveNumber(toNumber)
  const id = randomId()
  const side: Side = {
    state: newCall({ id, role: 'caller', local: from, localNumber: local.number, remote, at: Date.now() }),
    ringing: [],
    timer: null,
    stopSound: null,
    logged: false,
  }
  sides.set(keyOf('caller', id), side)
  phoneChanged()

  if (!deviceHasSignal(from)) {
    playError()
    finish(side, 'noService')
    return
  }
  if (remote.device === from || toNumber === local.number) {
    side.timer = setTimeout(() => finish(side, 'busy'), 1200)
    return
  }
  if (!endpointHasSignal(remote)) {
    // Straight to voicemail, as it were: a missed call the agent sees once back in coverage.
    side.timer = setTimeout(() => {
      playError()
      finish(side, 'unavailable')
      void log(side, true)
    }, 2500)
    return
  }
  const targets = deviceUsers(remote)
    .filter((u: any) => u.active)
    .map((u: any) => u.id as string)
  side.ringing = targets
  side.stopSound = startRingback()
  for (const userId of targets) send(T.ring, userId, { id, from: endpointFor(from), to: remote, callerUser: me() })
  side.timer = setTimeout(() => {
    for (const userId of side.ringing) send(T.cancel, userId, { id, reason: 'missed' })
    finish(side, 'missed')
    void log(side)
  }, RING_TIMEOUT_MS)
}

function callerSide(id: string): Side | null {
  return sides.get(keyOf('caller', id)) ?? null
}

function calleeSide(id: string): Side | null {
  return sides.get(keyOf('callee', id)) ?? null
}

// ---------------------------------------------------------------------------------------------
// Actions from a phone (either side)

export function answer(device: DeviceId): void {
  const call = liveCall(device)
  if (!call || call.role !== 'callee' || call.phase !== 'incoming') return
  const side = calleeSide(call.id)!
  stopSound(side)
  if (side.timer) clearTimeout(side.timer)
  side.timer = null
  update(side, callReduce(side.state, { t: 'answered', at: Date.now() }))
  playBeep(true)
  send(T.answer, call.peerUserId ?? '', { id: call.id, user: me() })
}

export function decline(device: DeviceId): void {
  const call = liveCall(device)
  if (!call || call.role !== 'callee') return
  const side = calleeSide(call.id)!
  send(T.decline, call.peerUserId ?? '', { id: call.id, user: me() })
  finish(side, 'declined')
}

export function hangup(device: DeviceId): void {
  const call = liveCall(device)
  if (!call) return
  const side = sides.get(keyOf(call.role, call.id))!
  if (call.role === 'callee' && call.phase === 'incoming') return decline(device)
  if (call.role === 'caller' && call.phase === 'dialing') {
    for (const userId of side.ringing) send(T.cancel, userId, { id: call.id, reason: 'cancelled' })
    finish(side, 'cancelled')
    void log(side)
    return
  }
  send(T.end, call.peerUserId ?? '', { id: call.id, role: call.role })
  finish(side, 'hangup')
  void log(side)
}

export function say(device: DeviceId, text: string): void {
  const call = liveCall(device)
  if (!call || call.phase !== 'active') return
  const side = sides.get(keyOf(call.role, call.id))!
  const at = Date.now()
  update(side, callReduce(side.state, { t: 'say', who: 'me', text, at }))
  send(T.say, call.peerUserId ?? '', { id: call.id, role: call.role, text })
}

export function mute(device: DeviceId, muted: boolean): void {
  const call = liveCall(device)
  if (!call || call.phase !== 'active') return
  const side = sides.get(keyOf(call.role, call.id))!
  update(side, callReduce(side.state, { t: 'mute', who: 'me', muted }))
  send(T.mute, call.peerUserId ?? '', { id: call.id, role: call.role, muted })
}

// ---------------------------------------------------------------------------------------------
// Socket handlers

const other = (role: unknown) => (role === 'caller' ? 'callee' : 'caller')

const handlers: Record<string, (data: any) => void | Promise<void>> = {
  // Callee: the phone rings.
  [T.ring]: async (data: any) => {
    if (!data?.id || !data?.to?.number) return
    let local: DeviceId | undefined = data.to.device
    if (!local && game.user?.isGM) {
      // A number nobody holds: the GM picks up as a new NPC identity for it.
      const existing = npcIdentities().find(n => n.number === data.to.number)
      const npc = existing ?? (await upsertNpc({ name: formatNumber(data.to.number), number: data.to.number }))
      local = `npc:${npc.id}`
    }
    if (!local || !canOpen(local)) return
    if (liveCall(local)) {
      send(T.busy, data.callerUser, { id: data.id, user: me() })
      return
    }
    const key = deviceKey(local)
    const side: Side = {
      state: newCall({
        id: data.id,
        role: 'callee',
        local,
        localNumber: key?.number ?? data.to.number,
        remote: data.from as Endpoint,
        at: Date.now(),
        peerUserId: data.callerUser,
      }),
      ringing: [],
      timer: null,
      stopSound: null,
      logged: false,
    }
    sides.set(keyOf('callee', data.id), side)
    const ring = startRingtone()
    const buzz = startVibrate()
    side.stopSound = () => {
      ring()
      buzz()
    }
    // Clean up if the caller vanishes without a cancel.
    side.timer = setTimeout(() => finish(side, 'missed'), RING_TIMEOUT_MS + 5000)
    openDevice(local, { focus: true })
    notifyIncoming(local, '')
    phoneChanged()
  },

  // Caller: someone picked up.
  [T.answer]: (data: any) => {
    const side = callerSide(data?.id)
    if (!side || side.state.phase !== 'dialing') {
      // Too late (cancelled or answered elsewhere): tell that user it's over.
      send(T.cancel, data?.user, { id: data?.id, reason: 'taken' })
      return
    }
    if (side.timer) clearTimeout(side.timer)
    side.timer = null
    stopSound(side)
    for (const userId of side.ringing)
      if (userId !== data.user) send(T.cancel, userId, { id: data.id, reason: 'taken' })
    side.ringing = [data.user]
    update(side, callReduce(side.state, { t: 'answered', at: Date.now(), peerUserId: data.user }))
    playBeep(true)
  },

  [T.decline]: (data: any) => {
    const side = callerSide(data?.id)
    if (!side || side.state.phase !== 'dialing') return
    for (const userId of side.ringing)
      if (userId !== data.user) send(T.cancel, userId, { id: data.id, reason: 'declined' })
    finish(side, 'declined')
    void log(side)
  },

  [T.busy]: (data: any) => {
    const side = callerSide(data?.id)
    if (!side || side.state.phase !== 'dialing') return
    side.ringing = side.ringing.filter(u => u !== data.user)
    if (side.ringing.length) return
    finish(side, 'busy')
    void log(side)
  },

  // Callee: the caller gave up, or another user answered.
  [T.cancel]: (data: any) => {
    const side = calleeSide(data?.id)
    if (!side || side.state.phase === 'ended') return
    finish(side, (data.reason as CallEnd) ?? 'cancelled')
  },

  [T.end]: (data: any) => {
    const side = sides.get(keyOf(other(data?.role), data?.id))
    if (!side || side.state.phase === 'ended') return
    finish(side, 'hangup')
    void log(side)
  },

  [T.say]: (data: any) => {
    const side = sides.get(keyOf(other(data?.role), data?.id))
    if (!side) return
    update(side, callReduce(side.state, { t: 'say', who: 'them', text: String(data.text ?? ''), at: Date.now() }))
  },

  [T.mute]: (data: any) => {
    const side = sides.get(keyOf(other(data?.role), data?.id))
    if (!side) return
    update(side, callReduce(side.state, { t: 'mute', who: 'them', muted: !!data.muted }))
  },
}

export function initCalls(): void {
  for (const [type, handler] of Object.entries(handlers)) onSocket(type, handler)
  // The other end closed Foundry mid-call.
  Hooks.on('userConnected' as any, (user: any, connected: boolean) => {
    if (connected) return
    for (const side of sides.values()) {
      const s = side.state
      if (s.phase === 'active' && s.peerUserId === user.id) {
        finish(side, 'hangup')
        void log(side)
      } else if (s.role === 'caller' && s.phase === 'dialing') {
        side.ringing = side.ringing.filter(u => u !== user.id)
      } else if (s.role === 'callee' && s.phase === 'incoming' && s.peerUserId === user.id) {
        finish(side, 'cancelled')
      }
    }
  })
}
