/**
 * The burner flip phone's firmware: a stack of screens driven by key presses. burnerKey() is a pure
 * reducer (UI state + key + snapshot -> UI state + effects); burner-draw.ts paints the top screen.
 *
 * Keys: '0'-'9', '*', '#', 'up', 'down', 'left', 'right', 'ok', 'softL', 'softR', 'call', 'end',
 * plus 'back' (Esc: one screen back), 'clear' (Backspace), 'tick' (multi-tap timeout),
 * 'char:x' (a character typed on a real keyboard) and 'long:5' (a held keypad key).
 */
import { calcInit, calcInput, type CalcInput, type CalcOp, type CalcState } from '../calculator.ts'
import { normalizeNumber } from '../numbers.ts'
import { t9Backspace, t9Init, t9Insert, t9LongPress, t9Press, t9Tick, t9Value, isT9Empty, type T9State } from '../t9.ts'
import { buildThreads, recentCalls, type RecentCall, type ThreadSummary } from '../threads.ts'
import { randomId, type Contact, type Note, type Photo, type PhotoRef } from '../types.ts'
import { sortedContacts, sortedNotes, type Effect, type PhoneSnapshot } from './model.ts'

export type MenuId = 'messages' | 'names' | 'calls' | 'camera' | 'photos' | 'torch' | 'memo' | 'clock' | 'calc'
export const BURNER_MENU: MenuId[] = [
  'messages',
  'names',
  'calls',
  'camera',
  'photos',
  'torch',
  'memo',
  'clock',
  'calc',
]

export interface OptItem {
  label: string
  act: string
  arg?: string
}

export type Route =
  | { s: 'idle' }
  | { s: 'menu'; sel: number }
  | { s: 'threads'; sel: number }
  | { s: 'thread'; key: string; scroll: number }
  | { s: 'compose'; to: string | null; t9: T9State; photo: PhotoRef | null }
  | { s: 'pickTo'; sel: number; purpose: 'compose' | 'photo'; photo?: PhotoRef }
  | { s: 'number'; value: string; purpose: 'to' | 'contact' }
  | { s: 'names'; sel: number }
  | { s: 'contact'; id: string; sel: number }
  | { s: 'editContact'; id: string | null; field: 0 | 1; name: T9State; number: string }
  | { s: 'calls'; sel: number }
  | { s: 'dial'; value: string }
  | { s: 'camera' }
  | { s: 'photos'; sel: number }
  | { s: 'photo'; id: string }
  | { s: 'caption'; id: string; t9: T9State }
  | { s: 'torch' }
  | { s: 'memos'; sel: number }
  | { s: 'memo'; id: string | null; t9: T9State }
  | { s: 'clock' }
  | { s: 'calc'; calc: CalcState }
  | { s: 'opts'; title: string; items: OptItem[]; sel: number }
  | { s: 'confirm'; text: string; act: string; arg?: string }

export interface BurnerUI {
  stack: Route[]
  notice: { text: string; data?: Record<string, string | number>; until: number } | null
  /** Camera flash until (ms). */
  flashUntil: number
  /** Subtitle being typed during a call. */
  say: T9State
}

export function burnerInit(): BurnerUI {
  return { stack: [{ s: 'idle' }], notice: null, flashUntil: 0, say: t9Init('', 'Abc', 120) }
}

export interface BurnerResult {
  ui: BurnerUI
  effects: Effect[]
}

export const top = (ui: BurnerUI): Route => ui.stack[ui.stack.length - 1] ?? { s: 'idle' }

const DIGITS = /^[0-9*#]$/

// ---------------------------------------------------------------------------------------------
// Lists shared with the renderer

export function threadRows(snap: PhoneSnapshot): ThreadSummary[] {
  return buildThreads(snap.messages, { id: snap.device.id, number: snap.device.number }, snap.record.read)
}

export function contactRows(snap: PhoneSnapshot): Contact[] {
  return sortedContacts(snap.record.contacts)
}

export function callRows(snap: PhoneSnapshot): RecentCall[] {
  return recentCalls(snap.messages, { id: snap.device.id, number: snap.device.number })
}

export function photoRows(snap: PhoneSnapshot): Photo[] {
  return [...snap.record.gallery].reverse()
}

export function memoRows(snap: PhoneSnapshot): Note[] {
  return sortedNotes(snap.record.notes)
}

/** Lines in a list screen, including the "new" row where there is one. */
export function listLength(route: Route, snap: PhoneSnapshot): number {
  switch (route.s) {
    case 'threads':
      return threadRows(snap).length + 1
    case 'names':
      return contactRows(snap).length + 1
    case 'pickTo':
      return contactRows(snap).length + 1
    case 'calls':
      return callRows(snap).length
    case 'photos':
      return photoRows(snap).length
    case 'memos':
      return memoRows(snap).length + 1
    case 'contact':
      return CONTACT_OPTS.length
    case 'opts':
      return route.items.length
    default:
      return 0
  }
}

export const CONTACT_OPTS = ['opt.call', 'opt.message', 'opt.edit', 'opt.delete'] as const

// ---------------------------------------------------------------------------------------------
// Helpers

const replaceTop = (ui: BurnerUI, route: Route): BurnerUI => ({ ...ui, stack: [...ui.stack.slice(0, -1), route] })
const push = (ui: BurnerUI, route: Route): BurnerUI => ({ ...ui, stack: [...ui.stack, route] })
const pop = (ui: BurnerUI): BurnerUI => (ui.stack.length > 1 ? { ...ui, stack: ui.stack.slice(0, -1) } : ui)
const home = (ui: BurnerUI): BurnerUI => ({ ...ui, stack: [{ s: 'idle' }] })
const notice = (ui: BurnerUI, text: string, now: number, data?: Record<string, string | number>): BurnerUI => ({
  ...ui,
  notice: { text, data, until: now + 1600 },
})

function move(sel: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (sel + delta + length) % length
}

/** Typing into a T9 field: returns the new field or null if the key isn't for typing. */
function typeKey(t9: T9State, key: string, now: number): T9State | null {
  if (key.startsWith('char:')) return t9Insert(t9, key.slice(5))
  if (key.startsWith('long:')) return t9LongPress(t9, key.slice(5))
  if (DIGITS.test(key)) return t9Press(t9, key, now)
  if (key === 'tick') return t9Tick(t9, now)
  return null
}

function digitKey(key: string): string | null {
  if (DIGITS.test(key)) return key
  if (key.startsWith('char:') && DIGITS.test(key.slice(5))) return key.slice(5)
  if (key.startsWith('long:')) return key.slice(5)
  return null
}

function openMenu(ui: BurnerUI, id: MenuId, snap: PhoneSnapshot): BurnerResult {
  const effects: Effect[] = []
  let route: Route
  switch (id) {
    case 'messages':
      route = { s: 'threads', sel: 0 }
      break
    case 'names':
      route = { s: 'names', sel: 0 }
      break
    case 'calls':
      route = { s: 'calls', sel: 0 }
      if (!snap.inspect) effects.push({ t: 'callsSeen' })
      break
    case 'camera':
      route = { s: 'camera' }
      effects.push({ t: 'preview' })
      break
    case 'photos':
      route = { s: 'photos', sel: 0 }
      break
    case 'torch':
      route = { s: 'torch' }
      break
    case 'memo':
      route = { s: 'memos', sel: 0 }
      break
    case 'clock':
      route = { s: 'clock' }
      break
    case 'calc':
      route = { s: 'calc', calc: calcInit() }
      break
  }
  return { ui: push(ui, route), effects }
}

function openThread(ui: BurnerUI, key: string, snap: PhoneSnapshot): BurnerResult {
  return { ui: push(ui, { s: 'thread', key, scroll: 0 }), effects: snap.inspect ? [] : [{ t: 'markRead', key }] }
}

/** Put a chosen number into the screen below (compose or contact editor). */
function deliverNumber(ui: BurnerUI, number: string): BurnerUI {
  const below = top(ui)
  if (below.s === 'compose') return replaceTop(ui, { ...below, to: number })
  if (below.s === 'editContact') return replaceTop(ui, { ...below, number })
  return ui
}

function send(ui: BurnerUI, route: Extract<Route, { s: 'compose' }>, now: number): BurnerResult {
  const text = t9Value(route.t9).trim()
  if (!route.to) return { ui: push(ui, { s: 'pickTo', sel: 0, purpose: 'compose' }), effects: [] }
  if (!text && !route.photo) return { ui: notice(ui, 'notice.empty', now), effects: [] }
  const after = replaceTop(ui, { s: 'thread', key: route.to, scroll: 0 })
  return {
    ui: notice(after, 'notice.sending', now),
    effects: [{ t: 'send', to: route.to, text, photo: route.photo }],
  }
}

// ---------------------------------------------------------------------------------------------
// Option menus

function runOpt(ui: BurnerUI, act: string, arg: string | undefined, snap: PhoneSnapshot, now: number): BurnerResult {
  const none = (next: BurnerUI): BurnerResult => ({ ui: next, effects: [] })
  switch (act) {
    case 'call':
      return { ui: pop(ui), effects: arg ? [{ t: 'call', to: arg }] : [] }
    case 'message': {
      const base = pop(ui)
      return none(push(base, { s: 'compose', to: arg ?? null, t9: t9Init(), photo: null }))
    }
    case 'editContact': {
      const c = snap.record.contacts.find(x => x.id === arg)
      if (!c) return none(pop(ui))
      return none(
        replaceTop(ui, { s: 'editContact', id: c.id, field: 0, name: t9Init(c.name, 'Abc', 24), number: c.number })
      )
    }
    case 'saveNumber':
      return none(
        replaceTop(ui, { s: 'editContact', id: null, field: 0, name: t9Init('', 'Abc', 24), number: arg ?? '' })
      )
    case 'askDeleteContact':
      return none(replaceTop(ui, { s: 'confirm', text: 'confirm.deleteContact', act: 'deleteContact', arg }))
    case 'deleteContact':
      return { ui: notice(pop(ui), 'notice.deleted', now), effects: arg ? [{ t: 'deleteContact', id: arg }] : [] }
    case 'send': {
      const below = ui.stack[ui.stack.length - 2]
      if (below?.s !== 'compose') return none(pop(ui))
      return send(pop(ui), below, now)
    }
    case 'addPhoto': {
      const base = pop(ui)
      return none(push(base, { s: 'photos', sel: 0 }))
    }
    case 'removePhoto': {
      const base = pop(ui)
      const c = top(base)
      return none(c.s === 'compose' ? replaceTop(base, { ...c, photo: null }) : base)
    }
    case 'discard': {
      // Drop the options menu and the editor under it.
      return none(pop(pop(ui)))
    }
    case 'sendPhoto': {
      const photo = snap.record.gallery.find(p => p.id === arg)
      if (!photo) return none(pop(ui))
      return none(replaceTop(ui, { s: 'pickTo', sel: 0, purpose: 'photo', photo: toRef(photo) }))
    }
    case 'caption': {
      const photo = snap.record.gallery.find(p => p.id === arg)
      return none(replaceTop(ui, { s: 'caption', id: arg ?? '', t9: t9Init(photo?.caption ?? '', 'Abc', 60) }))
    }
    case 'askDeletePhoto':
      return none(replaceTop(ui, { s: 'confirm', text: 'confirm.deletePhoto', act: 'deletePhoto', arg }))
    case 'deletePhoto': {
      let next = pop(ui)
      if (top(next).s === 'photo') next = pop(next)
      return { ui: notice(next, 'notice.deleted', now), effects: arg ? [{ t: 'deletePhoto', id: arg }] : [] }
    }
    case 'saveMemo': {
      const below = ui.stack[ui.stack.length - 2]
      if (below?.s !== 'memo') return none(pop(ui))
      return saveMemo(pop(ui), below, snap, now)
    }
    case 'askDeleteMemo':
      return none(replaceTop(ui, { s: 'confirm', text: 'confirm.deleteMemo', act: 'deleteMemo', arg }))
    case 'deleteMemo': {
      let next = pop(ui)
      if (top(next).s === 'memo') next = pop(next)
      return { ui: notice(next, 'notice.deleted', now), effects: arg ? [{ t: 'deleteNote', id: arg }] : [] }
    }
    case 'saveIncoming': {
      const msg = snap.messages.find(m => m.id === arg)
      return {
        ui: notice(pop(ui), 'notice.saved', now),
        effects: msg?.photo ? [{ t: 'savePhoto', photo: msg.photo }] : [],
      }
    }
    default:
      return none(pop(ui))
  }
}

const toRef = (p: Photo): PhotoRef => ({ src: p.src, w: p.w, h: p.h, caption: p.caption })

function saveMemo(ui: BurnerUI, route: Extract<Route, { s: 'memo' }>, snap: PhoneSnapshot, now: number): BurnerResult {
  const text = t9Value(route.t9)
  const next = notice(pop(ui), 'notice.saved', now)
  if (!text.trim() && !route.id) return { ui: pop(ui), effects: [] }
  const note: Note = { id: route.id ?? randomId(), text, updated: snap.clock.worldTime }
  return { ui: next, effects: [{ t: 'saveNote', note }] }
}

// ---------------------------------------------------------------------------------------------
// Calls

function callKey(ui: BurnerUI, key: string, snap: PhoneSnapshot, now: number): BurnerResult {
  const call = snap.call!
  const none = (next: BurnerUI): BurnerResult => ({ ui: next, effects: [] })
  if (call.phase === 'ended') return key === 'tick' ? none(ui) : { ui, effects: [{ t: 'dismissCall' }] }
  if (call.phase === 'incoming') {
    if (key === 'call' || key === 'ok' || key === 'softL') return { ui, effects: [{ t: 'answer' }] }
    if (key === 'end' || key === 'softR' || key === 'back') return { ui, effects: [{ t: 'decline' }] }
    return none(ui)
  }
  if (call.phase === 'dialing') {
    if (key === 'end' || key === 'softR' || key === 'back') return { ui, effects: [{ t: 'hangup' }] }
    return none(ui)
  }
  // Active
  if (key === 'end') return { ui: { ...ui, say: t9Init('', 'Abc', 120) }, effects: [{ t: 'hangup' }] }
  if (key === 'softL') return { ui, effects: [{ t: 'mute', muted: !call.muted }] }
  if (key === 'ok' || key === 'call') {
    const text = t9Value(ui.say).trim()
    if (!text) return none(ui)
    return { ui: { ...ui, say: t9Init('', 'Abc', 120) }, effects: [{ t: 'say', text }] }
  }
  if (key === 'softR' || key === 'clear') {
    if (isT9Empty(ui.say)) return key === 'softR' ? { ui, effects: [{ t: 'hangup' }] } : none(ui)
    return none({ ...ui, say: t9Backspace(ui.say) })
  }
  if (key === 'back') return none({ ...ui, say: t9Init('', 'Abc', 120) })
  const typed = typeKey(ui.say, key, now)
  return typed
    ? { ui: { ...ui, say: typed }, effects: DIGITS.test(key) ? [{ t: 'sound', name: 'click' }] : [] }
    : none(ui)
}

// ---------------------------------------------------------------------------------------------
// The reducer

export function burnerKey(ui0: BurnerUI, key: string, snap: PhoneSnapshot, now: number = Date.now()): BurnerResult {
  let ui = ui0
  if (ui.notice && now >= ui.notice.until) ui = { ...ui, notice: null }
  if (snap.call) return callKey(ui, key, snap, now)
  // A key press dismisses a notice and does nothing else.
  if (ui.notice && key !== 'tick') return { ui: { ...ui, notice: null }, effects: [] }

  const none = (next: BurnerUI): BurnerResult => ({ ui: next, effects: [] })
  const route = top(ui)
  const len = listLength(route, snap)

  if (key === 'end') return none(home(ui))
  if (key === 'back' && route.s !== 'idle') return none(pop(ui))

  switch (route.s) {
    case 'idle': {
      if (key === 'softL' || key === 'ok') return none(push(ui, { s: 'menu', sel: 0 }))
      if (key === 'softR' || key === 'down') return none(push(ui, { s: 'names', sel: 0 }))
      if (key === 'up') return none(push(ui, { s: 'threads', sel: 0 }))
      if (key === 'left') return openMenu(ui, 'camera', snap)
      if (key === 'right') return { ui, effects: [{ t: 'torch' }] }
      if (key === 'call') return openMenu(ui, 'calls', snap)
      const d = digitKey(key)
      if (d) return { ui: push(ui, { s: 'dial', value: d }), effects: [{ t: 'sound', name: 'dtmf', key: d }] }
      return none(ui)
    }

    case 'menu': {
      const cols = 3
      const n = BURNER_MENU.length
      const moves: Record<string, number> = { left: -1, right: 1, up: -cols, down: cols }
      if (key in moves) return none(replaceTop(ui, { ...route, sel: (route.sel + moves[key] + n) % n }))
      const d = digitKey(key)
      if (d && /[1-9]/.test(d)) return openMenu(ui, BURNER_MENU[Number(d) - 1], snap)
      if (key === 'ok' || key === 'softL') return openMenu(ui, BURNER_MENU[route.sel], snap)
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'threads': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      const rows = threadRows(snap)
      if (key === 'ok' || key === 'softL') {
        if (route.sel === 0)
          return none(
            push(push(ui, { s: 'compose', to: null, t9: t9Init(), photo: null }), {
              s: 'pickTo',
              sel: 0,
              purpose: 'compose',
            })
          )
        const row = rows[route.sel - 1]
        return row ? openThread(ui, row.key, snap) : none(ui)
      }
      if (key === 'call') {
        const row = rows[route.sel - 1]
        return row ? { ui, effects: [{ t: 'call', to: row.key }] } : none(ui)
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'thread': {
      if (key === 'up') return none(replaceTop(ui, { ...route, scroll: route.scroll + 1 }))
      if (key === 'down') return none(replaceTop(ui, { ...route, scroll: Math.max(0, route.scroll - 1) }))
      if (key === 'softL' || key === 'ok')
        return none(push(ui, { s: 'compose', to: route.key, t9: t9Init(), photo: null }))
      if (key === 'call') return { ui, effects: [{ t: 'call', to: route.key }] }
      if (key === 'right') {
        // Save the newest photo someone sent in this thread.
        const msg = [...snap.messages].reverse().find(m => m.photo && m.from.number === route.key)
        return msg && snap.device.owner === 'agent' && !snap.inspect
          ? none(
              push(ui, {
                s: 'opts',
                title: 'opt.photoTitle',
                items: [{ label: 'opt.savePhoto', act: 'saveIncoming', arg: msg.id }],
                sel: 0,
              })
            )
          : none(ui)
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'compose': {
      if (key === 'softL') return send(ui, route, now)
      if (key === 'ok') {
        const items: OptItem[] = [
          { label: 'opt.send', act: 'send' },
          route.photo ? { label: 'opt.removePhoto', act: 'removePhoto' } : { label: 'opt.addPhoto', act: 'addPhoto' },
          { label: 'opt.discard', act: 'discard' },
        ]
        return none(push(ui, { s: 'opts', title: 'opt.title', items, sel: 0 }))
      }
      if (key === 'softR' || key === 'clear') {
        if (isT9Empty(route.t9)) return key === 'softR' ? none(pop(ui)) : none(ui)
        return none(replaceTop(ui, { ...route, t9: t9Backspace(route.t9) }))
      }
      const typed = typeKey(route.t9, key, now)
      if (typed)
        return {
          ui: replaceTop(ui, { ...route, t9: typed }),
          effects: DIGITS.test(key) ? [{ t: 'sound', name: 'click' }] : [],
        }
      return none(ui)
    }

    case 'pickTo': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      if (key === 'ok' || key === 'softL') {
        if (route.sel === 0) {
          if (route.purpose === 'photo') {
            const compose: Route = { s: 'compose', to: null, t9: t9Init(), photo: route.photo ?? null }
            return none(push(replaceTop(ui, compose), { s: 'number', value: '', purpose: 'to' }))
          }
          return none(replaceTop(ui, { s: 'number', value: '', purpose: 'to' }))
        }
        const c = contactRows(snap)[route.sel - 1]
        if (!c) return none(ui)
        if (route.purpose === 'photo')
          return none(replaceTop(ui, { s: 'compose', to: c.number, t9: t9Init(), photo: route.photo ?? null }))
        return none(deliverNumber(pop(ui), c.number))
      }
      if (key === 'softR') {
        const next = pop(ui)
        const below = top(next)
        // Backing out of "To:" on a brand-new empty message drops the message too.
        if (below.s === 'compose' && !below.to && isT9Empty(below.t9)) return none(pop(next))
        return none(next)
      }
      return none(ui)
    }

    case 'number': {
      const d = digitKey(key)
      if (d && /\d/.test(d)) {
        if (route.value.length >= 15) return none(ui)
        return {
          ui: replaceTop(ui, { ...route, value: route.value + d }),
          effects: [{ t: 'sound', name: 'dtmf', key: d }],
        }
      }
      if (key === 'softR' || key === 'clear') {
        if (!route.value) return key === 'softR' ? none(pop(ui)) : none(ui)
        return none(replaceTop(ui, { ...route, value: route.value.slice(0, -1) }))
      }
      if (key === 'ok' || key === 'softL') {
        const number = normalizeNumber(route.value, snap.device.number.slice(0, 3))
        if (!number) return none(notice(ui, 'notice.badNumber', now))
        return none(deliverNumber(pop(ui), number))
      }
      return none(ui)
    }

    case 'names': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      const rows = contactRows(snap)
      if (key === 'ok' || key === 'softL') {
        if (route.sel === 0)
          return none(push(ui, { s: 'editContact', id: null, field: 0, name: t9Init('', 'Abc', 24), number: '' }))
        const c = rows[route.sel - 1]
        return c ? none(push(ui, { s: 'contact', id: c.id, sel: 0 })) : none(ui)
      }
      if (key === 'call') {
        const c = rows[route.sel - 1]
        return c ? { ui, effects: [{ t: 'call', to: c.number }] } : none(ui)
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'contact': {
      const c = snap.record.contacts.find(x => x.id === route.id)
      if (!c) return none(pop(ui))
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      if (key === 'call') return { ui: pop(ui), effects: [{ t: 'call', to: c.number }] }
      if (key === 'ok' || key === 'softL') {
        const opt = CONTACT_OPTS[route.sel]
        if (opt === 'opt.call') return runOpt(ui, 'call', c.number, snap, now)
        if (opt === 'opt.message') return runOpt(ui, 'message', c.number, snap, now)
        if (opt === 'opt.edit') return runOpt(ui, 'editContact', c.id, snap, now)
        return runOpt(ui, 'askDeleteContact', c.id, snap, now)
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'editContact': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, field: route.field === 0 ? 1 : 0, name: t9Tick(route.name, Infinity) }))
      if (key === 'softL') {
        const name = t9Value(route.name).trim()
        const number = normalizeNumber(route.number, snap.device.number.slice(0, 3))
        if (!name) return none(notice(ui, 'notice.needName', now))
        if (!number) return none(notice(ui, 'notice.badNumber', now))
        const contact: Contact = { id: route.id ?? randomId(), name, number }
        return { ui: notice(pop(ui), 'notice.saved', now), effects: [{ t: 'saveContact', contact }] }
      }
      if (route.field === 0) {
        if (key === 'softR' || key === 'clear') {
          if (isT9Empty(route.name)) return key === 'softR' ? none(pop(ui)) : none(ui)
          return none(replaceTop(ui, { ...route, name: t9Backspace(route.name) }))
        }
        if (key === 'ok') return none(replaceTop(ui, { ...route, field: 1, name: t9Tick(route.name, Infinity) }))
        const typed = typeKey(route.name, key, now)
        return typed ? none(replaceTop(ui, { ...route, name: typed })) : none(ui)
      }
      const d = digitKey(key)
      if (d && /\d/.test(d)) return none(replaceTop(ui, { ...route, number: (route.number + d).slice(0, 15) }))
      if (key === 'softR' || key === 'clear') {
        if (!route.number) return key === 'softR' ? none(pop(ui)) : none(ui)
        return none(replaceTop(ui, { ...route, number: route.number.slice(0, -1) }))
      }
      if (key === 'ok') return burnerKey(ui, 'softL', snap, now)
      return none(ui)
    }

    case 'calls': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      const row = callRows(snap)[route.sel]
      if (key === 'ok' || key === 'call') return row ? { ui, effects: [{ t: 'call', to: row.key }] } : none(ui)
      if (key === 'softL' && row) {
        const known = snap.record.contacts.some(c => c.number === row.key)
        const items: OptItem[] = [
          { label: 'opt.call', act: 'call', arg: row.key },
          { label: 'opt.message', act: 'message', arg: row.key },
          ...(known ? [] : [{ label: 'opt.saveNumber', act: 'saveNumber', arg: row.key }]),
        ]
        return none(push(ui, { s: 'opts', title: 'opt.title', items, sel: 0 }))
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'dial': {
      const d = digitKey(key)
      if (d) {
        if (route.value.length >= 15) return none(ui)
        return {
          ui: replaceTop(ui, { ...route, value: route.value + d }),
          effects: [{ t: 'sound', name: 'dtmf', key: d }],
        }
      }
      if (key === 'softR' || key === 'clear') {
        if (route.value.length <= 1) return none(pop(ui))
        return none(replaceTop(ui, { ...route, value: route.value.slice(0, -1) }))
      }
      if (key === 'call' || key === 'ok') {
        const number = normalizeNumber(route.value, snap.device.number.slice(0, 3))
        if (!number) return none(notice(ui, 'notice.badNumber', now))
        return { ui: home(ui), effects: [{ t: 'call', to: number }] }
      }
      if (key === 'softL') {
        const number = normalizeNumber(route.value, snap.device.number.slice(0, 3)) ?? route.value
        return none(replaceTop(ui, { s: 'editContact', id: null, field: 0, name: t9Init('', 'Abc', 24), number }))
      }
      return none(ui)
    }

    case 'camera': {
      if (key === 'ok' || key === 'call') {
        return { ui: { ...ui, flashUntil: now + 260 }, effects: [{ t: 'takePhoto' }] }
      }
      if (key === 'up' || key === 'down') return { ui, effects: [{ t: 'preview' }] }
      if (key === 'softL') return none(push(ui, { s: 'photos', sel: 0 }))
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'photos': {
      const n = Math.max(1, len)
      const moves: Record<string, number> = { left: -1, right: 1, up: -3, down: 3 }
      if (key in moves)
        return none(replaceTop(ui, { ...route, sel: Math.min(n - 1, Math.max(0, route.sel + moves[key])) }))
      const photo = photoRows(snap)[route.sel]
      if ((key === 'ok' || key === 'softL') && photo) {
        // Picking a photo for a message being written?
        const below = ui.stack[ui.stack.length - 2]
        if (below?.s === 'compose') return none(replaceTop(pop(ui), { ...below, photo: toRef(photo) }))
        return none(push(ui, { s: 'photo', id: photo.id }))
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'photo': {
      const rows = photoRows(snap)
      const i = rows.findIndex(p => p.id === route.id)
      if (i < 0) return none(pop(ui))
      if (key === 'left' || key === 'right') {
        const next = rows[move(i, key === 'left' ? -1 : 1, rows.length)]
        return none(replaceTop(ui, { s: 'photo', id: next.id }))
      }
      if (key === 'ok' || key === 'softL') {
        const items: OptItem[] = [
          { label: 'opt.send', act: 'sendPhoto', arg: route.id },
          { label: 'opt.caption', act: 'caption', arg: route.id },
          { label: 'opt.delete', act: 'askDeletePhoto', arg: route.id },
        ]
        return none(push(ui, { s: 'opts', title: 'opt.title', items, sel: 0 }))
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'caption': {
      if (key === 'softL' || key === 'ok') {
        const caption = t9Value(route.t9).trim()
        return { ui: notice(pop(ui), 'notice.saved', now), effects: [{ t: 'caption', id: route.id, caption }] }
      }
      if (key === 'softR' || key === 'clear') {
        if (isT9Empty(route.t9)) return key === 'softR' ? none(pop(ui)) : none(ui)
        return none(replaceTop(ui, { ...route, t9: t9Backspace(route.t9) }))
      }
      const typed = typeKey(route.t9, key, now)
      return typed ? none(replaceTop(ui, { ...route, t9: typed })) : none(ui)
    }

    case 'torch':
      if (key === 'ok' || key === 'softL') return { ui, effects: [{ t: 'torch' }] }
      if (key === 'softR') return none(pop(ui))
      return none(ui)

    case 'memos': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      if (key === 'ok' || key === 'softL') {
        if (route.sel === 0) return none(push(ui, { s: 'memo', id: null, t9: t9Init('', 'Abc', 400) }))
        const note = memoRows(snap)[route.sel - 1]
        return note ? none(push(ui, { s: 'memo', id: note.id, t9: t9Init(note.text, 'abc', 400) })) : none(ui)
      }
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'memo': {
      if (key === 'softL') return saveMemo(ui, route, snap, now)
      if (key === 'ok') {
        const items: OptItem[] = [{ label: 'opt.save', act: 'saveMemo' }]
        if (route.id) items.push({ label: 'opt.delete', act: 'askDeleteMemo', arg: route.id })
        items.push({ label: 'opt.discard', act: 'discard' })
        return none(push(ui, { s: 'opts', title: 'opt.title', items, sel: 0 }))
      }
      if (key === 'softR' || key === 'clear') {
        if (isT9Empty(route.t9)) return key === 'softR' ? none(pop(ui)) : none(ui)
        return none(replaceTop(ui, { ...route, t9: t9Backspace(route.t9) }))
      }
      const typed = typeKey(route.t9, key, now)
      return typed
        ? {
            ui: replaceTop(ui, { ...route, t9: typed }),
            effects: DIGITS.test(key) ? [{ t: 'sound', name: 'click' }] : [],
          }
        : none(ui)
    }

    case 'clock':
      if (key === 'ok' || key === 'softL') return { ui, effects: [{ t: 'prefs', h24: !snap.record.prefs.h24 }] }
      if (key === 'softR') return none(pop(ui))
      return none(ui)

    case 'calc': {
      const input = calcFromKey(key, route.calc)
      if (input === 'exit') return none(pop(ui))
      if (input)
        return {
          ui: replaceTop(ui, { ...route, calc: calcInput(route.calc, input) }),
          effects: [{ t: 'sound', name: 'click' }],
        }
      return none(ui)
    }

    case 'opts': {
      if (key === 'up' || key === 'down')
        return none(replaceTop(ui, { ...route, sel: move(route.sel, key === 'up' ? -1 : 1, len) }))
      const d = digitKey(key)
      const pick = d && /[1-9]/.test(d) ? Number(d) - 1 : key === 'ok' || key === 'softL' ? route.sel : -1
      const item = route.items[pick]
      if (item) return runOpt(ui, item.act, item.arg, snap, now)
      if (key === 'softR') return none(pop(ui))
      return none(ui)
    }

    case 'confirm':
      if (key === 'ok' || key === 'softL') return runOpt(ui, route.act, route.arg, snap, now)
      if (key === 'softR') return none(pop(ui))
      return none(ui)
  }
}

/** Calculator on a keypad: digits, '#' = point, '*' cycles + − × ÷, arrows pick an operator, OK = equals. */
export function calcFromKey(key: string, calc: CalcState): CalcInput | 'exit' | null {
  const k = key.startsWith('char:') ? key.slice(5) : key
  if (/^[0-9]$/.test(k)) return k as CalcInput
  const ops: CalcOp[] = ['+', '-', '*', '/']
  switch (k) {
    case '#':
    case '.':
    case ',':
      return '.'
    case '*': {
      if (key === 'char:*') return '*'
      // Pressing * again right after an operator cycles it.
      if (calc.fresh && calc.op) return ops[(ops.indexOf(calc.op) + 1) % ops.length]
      return '+'
    }
    case '+':
    case '-':
    case '/':
      return k as CalcOp
    case 'x':
      return '*'
    case 'up':
      return '+'
    case 'down':
      return '-'
    case 'left':
      return '*'
    case 'right':
      return '/'
    case 'ok':
    case 'call':
    case '=':
      return '='
    case 'softL':
      return 'C'
    case 'clear':
      return 'back'
    case 'softR':
      return calc.display === '0' && calc.op === null ? 'exit' : 'back'
    default:
      return null
  }
}
