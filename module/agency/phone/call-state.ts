/**
 * One call as one client sees it. The socket layer (calls.ts) turns messages into events; this
 * reducer decides the screen. Pure.
 *
 *   caller: dialing --answered--> active --ended--> ended
 *              \--declined/timeout/cancelled/busy/unavailable--> ended
 *   callee: incoming --answered--> active --ended--> ended
 *              \--declined/cancelled/taken/timeout--> ended
 */
import type { DeviceId, Endpoint } from './types.ts'

export type CallPhase = 'dialing' | 'incoming' | 'active' | 'ended'
export type CallEnd =
  | 'hangup' // someone hung up an active call
  | 'declined'
  | 'missed' // nobody answered in time
  | 'cancelled' // caller gave up while it rang
  | 'taken' // another user answered this device
  | 'busy'
  | 'unavailable' // callee has no signal / nobody to ring
  | 'noService' // caller has no signal

export interface CallLine {
  who: 'me' | 'them'
  text: string
  at: number
}

export interface CallState {
  id: string
  role: 'caller' | 'callee'
  /** This client's side of the call. */
  local: DeviceId
  localNumber: string
  remote: Endpoint
  phase: CallPhase
  /** ms, client clock. */
  createdAt: number
  startedAt: number
  endedAt: number
  end: CallEnd | null
  muted: boolean
  remoteMuted: boolean
  lines: CallLine[]
  /** The user on the other end once answered (for socket messages). */
  peerUserId: string | null
}

export type CallEvent =
  | { t: 'answered'; at: number; peerUserId?: string | null }
  | { t: 'end'; at: number; reason: CallEnd }
  | { t: 'say'; who: 'me' | 'them'; text: string; at: number }
  | { t: 'mute'; who: 'me' | 'them'; muted: boolean }

export const RING_TIMEOUT_MS = 30_000
export const MAX_LINE = 120
export const MAX_LINES = 40

export function newCall(init: {
  id: string
  role: 'caller' | 'callee'
  local: DeviceId
  localNumber: string
  remote: Endpoint
  at: number
  peerUserId?: string | null
}): CallState {
  return {
    id: init.id,
    role: init.role,
    local: init.local,
    localNumber: init.localNumber,
    remote: init.remote,
    phase: init.role === 'caller' ? 'dialing' : 'incoming',
    createdAt: init.at,
    startedAt: 0,
    endedAt: 0,
    end: null,
    muted: false,
    remoteMuted: false,
    lines: [],
    peerUserId: init.peerUserId ?? null,
  }
}

export function callReduce(state: CallState, ev: CallEvent): CallState {
  if (state.phase === 'ended') return state
  switch (ev.t) {
    case 'answered':
      if (state.phase === 'active') return state
      return { ...state, phase: 'active', startedAt: ev.at, peerUserId: ev.peerUserId ?? state.peerUserId }
    case 'end': {
      // An active call can only end by hanging up (or the line dropping).
      const reason: CallEnd = state.phase === 'active' ? 'hangup' : ev.reason
      return { ...state, phase: 'ended', endedAt: ev.at, end: reason }
    }
    case 'say': {
      if (state.phase !== 'active') return state
      const text = ev.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE)
      if (!text) return state
      return { ...state, lines: [...state.lines, { who: ev.who, text, at: ev.at }].slice(-MAX_LINES) }
    }
    case 'mute':
      if (state.phase !== 'active') return state
      return ev.who === 'me' ? { ...state, muted: ev.muted } : { ...state, remoteMuted: ev.muted }
  }
}

/** Seconds on the call clock. */
export function callElapsed(state: CallState, now: number): number {
  if (!state.startedAt) return 0
  const end = state.phase === 'ended' ? state.endedAt : now
  return Math.max(0, Math.floor((end - state.startedAt) / 1000))
}

/** Outcome for the call log, from the caller's side. */
export function logOutcome(state: CallState): 'answered' | 'missed' | 'declined' {
  if (state.startedAt) return 'answered'
  return state.end === 'declined' ? 'declined' : 'missed'
}

/** Is the ring overdue? */
export function ringExpired(state: CallState, now: number, timeout = RING_TIMEOUT_MS): boolean {
  return state.phase !== 'active' && state.phase !== 'ended' && now - state.createdAt >= timeout
}
