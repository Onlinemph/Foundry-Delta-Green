/**
 * Multi-tap text entry ("T9" as players remember it): press 2 once for a, twice for b, three times
 * for c, four for 2. A different key, or a pause longer than the timeout, commits the letter.
 * '#' cycles the input mode (Abc sentence case, abc, ABC, 123); '0' is space; '*' cycles symbols;
 * holding a key types its digit. Pure: the caller passes the clock in.
 */

export type T9Mode = 'Abc' | 'abc' | 'ABC' | '123'
export const T9_MODES: readonly T9Mode[] = ['Abc', 'abc', 'ABC', '123']

/** Letters per key, lower case; the key's digit comes last. */
export const T9_KEYS: Readonly<Record<string, string>> = {
  '1': ".,?!'-@:/1",
  '2': 'abc2',
  '3': 'def3',
  '4': 'ghi4',
  '5': 'jkl5',
  '6': 'mno6',
  '7': 'pqrs7',
  '8': 'tuv8',
  '9': 'wxyz9',
  '0': ' 0',
  '*': '*+-=/%&$#()',
}

export const T9_TIMEOUT_MS = 1000

export interface T9Pending {
  key: string
  index: number
  at: number
}

export interface T9State {
  text: string
  pending: T9Pending | null
  mode: T9Mode
  max: number
}

export function t9Init(text = '', mode: T9Mode = 'Abc', max = 160): T9State {
  return { text: text.slice(0, max), pending: null, mode, max }
}

/** Upper case here? Sentence case capitalises at the start and after . ! ? and a space. */
export function capitalizeNext(text: string, mode: T9Mode): boolean {
  if (mode === 'ABC') return true
  if (mode !== 'Abc') return false
  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed) return true
  return /[.!?]$/.test(trimmed) && /\s$/.test(text)
}

function pendingChar(state: T9State): string {
  const p = state.pending
  if (!p) return ''
  const set = T9_KEYS[p.key] ?? ''
  const ch = set[p.index % set.length] ?? ''
  return capitalizeNext(state.text, state.mode) ? ch.toUpperCase() : ch
}

function append(state: T9State, ch: string): T9State {
  if (!ch || state.text.length >= state.max) return { ...state, pending: null }
  return { ...state, text: state.text + ch, pending: null }
}

/** Commit the letter being cycled, if any. */
export function t9Commit(state: T9State): T9State {
  return state.pending ? append(state, pendingChar(state)) : state
}

/** Commit if the pause since the last press reached the timeout. */
export function t9Tick(state: T9State, now: number, timeout = T9_TIMEOUT_MS): T9State {
  return state.pending && now - state.pending.at >= timeout ? t9Commit(state) : state
}

export function t9Press(state: T9State, key: string, now: number, timeout = T9_TIMEOUT_MS): T9State {
  if (key === '#') return t9CycleMode(state)
  const set = T9_KEYS[key]
  if (!set) return state
  if (state.mode === '123' && /\d/.test(key)) return append(t9Commit(state), key)
  const p = state.pending
  if (p && p.key === key && now - p.at < timeout) {
    return { ...state, pending: { key, index: (p.index + 1) % set.length, at: now } }
  }
  const committed = t9Commit(state)
  if (committed.text.length >= committed.max) return committed
  return { ...committed, pending: { key, index: 0, at: now } }
}

/** A held key types its digit (or '*'). */
export function t9LongPress(state: T9State, key: string): T9State {
  if (!T9_KEYS[key]) return state
  return append({ ...state, pending: null }, key)
}

/** Text typed on a real keyboard goes straight in. */
export function t9Insert(state: T9State, text: string): T9State {
  let next = t9Commit(state)
  for (const ch of text) next = append(next, ch)
  return next
}

export function t9Backspace(state: T9State): T9State {
  if (state.pending) return { ...state, pending: null }
  return { ...state, text: state.text.slice(0, -1) }
}

export function t9Clear(state: T9State): T9State {
  return { ...state, text: '', pending: null }
}

export function t9CycleMode(state: T9State): T9State {
  const committed = t9Commit(state)
  const i = T9_MODES.indexOf(committed.mode)
  return { ...committed, mode: T9_MODES[(i + 1) % T9_MODES.length] }
}

/** For display: committed text plus the letter still cycling (shown highlighted). */
export function t9View(state: T9State): { text: string; pending: string; remaining: number } {
  const pending = pendingChar(state)
  return { text: state.text, pending, remaining: state.max - state.text.length - (pending ? 1 : 0) }
}

/** Everything typed, pending letter included. */
export function t9Value(state: T9State): string {
  return t9Commit(state).text
}

export function isT9Empty(state: T9State): boolean {
  return !state.text && !state.pending
}
