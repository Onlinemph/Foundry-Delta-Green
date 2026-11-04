/**
 * Smartphone UI state and its reducer. Elements in the view carry data-action (and data-arg); the
 * controller passes those here with the values of the screen's inputs, and runs the effects that
 * come back.
 */
import { calcInit, calcInput, type CalcInput, type CalcState } from '../calculator.ts'
import { centredView, zoomAt, type MapView } from '../maps.ts'
import { normalizeNumber } from '../numbers.ts'
import { randomId, type PhotoRef } from '../types.ts'
import { mapGeometry, type Effect, type PhoneSnapshot, type SmartApp } from './model.ts'

export type PhoneTab = 'keypad' | 'contacts' | 'recents'

export interface SmartUI {
  locked: boolean
  app: SmartApp | 'home'
  /** Messages: open thread (counterpart number), or '' for the new-message screen. */
  thread: string | null
  drafts: Record<string, string>
  attach: PhotoRef | null
  /** Messages: choosing a photo from the gallery to attach. */
  picking: boolean
  phoneTab: PhoneTab
  dial: string
  /** Contact being edited ('' id = new). */
  contact: { id: string; name: string; number: string } | null
  /** Photos: full view. */
  photo: string | null
  /** Photos: choosing who to send a photo to. */
  sendPhoto: string | null
  /** Notes: note being edited. */
  note: string | null
  calc: CalcState
  map: MapView | null
  /** Counter bumped on each shot; the view replays the shutter animation when it changes. */
  shutter: number
  /** Subtitle being typed in a call. */
  say: string
  error: string | null
}

export function smartInit(): SmartUI {
  return {
    locked: true,
    app: 'home',
    thread: null,
    drafts: {},
    attach: null,
    picking: false,
    phoneTab: 'keypad',
    dial: '',
    contact: null,
    photo: null,
    sendPhoto: null,
    note: null,
    calc: calcInit(),
    map: null,
    shutter: 0,
    say: '',
    error: null,
  }
}

export interface SmartResult {
  ui: SmartUI
  effects: Effect[]
}

const DTMF = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'])

function goHome(ui: SmartUI): SmartUI {
  return {
    ...ui,
    app: 'home',
    thread: null,
    picking: false,
    contact: null,
    photo: null,
    sendPhoto: null,
    note: null,
    error: null,
  }
}

function openThread(ui: SmartUI, key: string, snap: PhoneSnapshot): SmartResult {
  const effects: Effect[] = snap.inspect ? [] : [{ t: 'markRead', key }]
  return { ui: { ...ui, locked: false, app: 'messages', thread: key, picking: false, error: null }, effects }
}

/**
 * @param form values of named inputs on the current screen
 */
export function smartAction(
  ui: SmartUI,
  action: string,
  arg: string,
  form: Record<string, string>,
  snap: PhoneSnapshot,
  now: number = Date.now()
): SmartResult {
  const none = (next: SmartUI): SmartResult => ({ ui: next, effects: [] })
  const area = snap.device.number.slice(0, 3)

  switch (action) {
    // ---- Frame
    case 'unlock':
      return none({ ...ui, locked: false })
    case 'lock':
      return { ui: { ...goHome(ui), locked: true }, effects: [{ t: 'lock' }] }
    case 'home':
      return none(goHome(ui))
    case 'open': {
      const app = arg as SmartApp
      if (app === 'flashlight') return { ui: { ...ui, locked: ui.locked }, effects: [{ t: 'torch' }] }
      if (!snap.apps.includes(app)) return none(ui)
      const next: SmartUI = { ...goHome(ui), locked: false, app }
      const effects: Effect[] = []
      if (app === 'camera') effects.push({ t: 'preview' })
      if (app === 'phone' && next.phoneTab === 'recents' && !snap.inspect) effects.push({ t: 'callsSeen' })
      return { ui: next, effects }
    }
    case 'back':
      return none(back(ui))
    case 'dismissError':
      return none({ ...ui, error: null })

    // ---- Messages
    case 'thread':
      return openThread(ui, arg, snap)
    case 'compose':
      return none({ ...ui, app: 'messages', thread: '', picking: false, attach: null })
    case 'composeTo': {
      const number = normalizeNumber(arg || form.to, area)
      if (!number) return none({ ...ui, error: 'badNumber' })
      return openThread(ui, number, snap)
    }
    case 'draft':
      return none(ui.thread ? { ...ui, drafts: { ...ui.drafts, [ui.thread]: form.text ?? '' } } : ui)
    case 'send': {
      const key = ui.thread
      const text = (form.text ?? '').trim()
      if (!key || (!text && !ui.attach)) return none(ui)
      const drafts = { ...ui.drafts }
      delete drafts[key]
      return {
        ui: { ...ui, drafts, attach: null },
        effects: [{ t: 'send', to: key, text, photo: ui.attach }],
      }
    }
    case 'attach':
      return none({ ...ui, picking: true })
    case 'attachPick': {
      const photo = snap.record.gallery.find(p => p.id === arg)
      if (!photo) return none({ ...ui, picking: false })
      return none({ ...ui, picking: false, attach: { src: photo.src, w: photo.w, h: photo.h, caption: photo.caption } })
    }
    case 'attachFile':
      // GM's NPC phones attach any image through Foundry's file picker.
      return { ui: { ...ui, picking: false }, effects: [{ t: 'pickImage' }] }
    case 'attachClear':
      return none({ ...ui, attach: null, picking: false })
    case 'saveIncoming': {
      const msg = snap.messages.find(m => m.id === arg)
      if (!msg?.photo) return none(ui)
      return { ui, effects: [{ t: 'savePhoto', photo: msg.photo }] }
    }

    // ---- Phone
    case 'tab': {
      const tab = arg as PhoneTab
      const effects: Effect[] = tab === 'recents' && !snap.inspect ? [{ t: 'callsSeen' }] : []
      return { ui: { ...ui, locked: false, app: 'phone', phoneTab: tab, contact: null }, effects }
    }
    case 'key': {
      if (!DTMF.has(arg) || ui.dial.length >= 15) return none(ui)
      return { ui: { ...ui, dial: ui.dial + arg }, effects: [{ t: 'sound', name: 'dtmf', key: arg }] }
    }
    case 'del':
      return none({ ...ui, dial: ui.dial.slice(0, -1) })
    case 'dial': {
      const number = normalizeNumber(ui.dial, area)
      if (!number) return { ui: { ...ui, error: ui.dial ? 'badNumber' : null }, effects: [] }
      return { ui: { ...ui, dial: '' }, effects: [{ t: 'call', to: number }] }
    }
    case 'callNumber':
      return { ui, effects: [{ t: 'call', to: arg }] }
    case 'textNumber':
      return openThread({ ...ui, contact: null }, arg, snap)
    case 'contactNew':
      return none({ ...ui, app: 'phone', phoneTab: 'contacts', contact: { id: '', name: '', number: arg || '' } })
    case 'contactEdit': {
      const c = snap.record.contacts.find(x => x.id === arg)
      return none(c ? { ...ui, contact: { ...c } } : ui)
    }
    case 'contactSave': {
      const name = (form.name ?? '').trim()
      const number = normalizeNumber(form.number, area)
      if (!name || !number) return none({ ...ui, error: !name ? 'needName' : 'badNumber' })
      const id = ui.contact?.id || randomId()
      return {
        ui: { ...ui, contact: null, error: null },
        effects: [{ t: 'saveContact', contact: { id, name, number } }],
      }
    }
    case 'contactDelete':
      return { ui: { ...ui, contact: null }, effects: [{ t: 'deleteContact', id: arg || ui.contact?.id || '' }] }

    // ---- Calls
    case 'answer':
      return { ui, effects: [{ t: 'answer' }] }
    case 'decline':
      return { ui, effects: [{ t: 'decline' }] }
    case 'hangup':
      return { ui: { ...ui, say: '' }, effects: [{ t: 'hangup' }] }
    case 'mute':
      return { ui, effects: [{ t: 'mute', muted: !snap.call?.muted }] }
    case 'say': {
      const text = (form.say ?? '').trim()
      if (!text) return none(ui)
      return { ui: { ...ui, say: '' }, effects: [{ t: 'say', text }] }
    }
    case 'dismissCall':
      return { ui, effects: [{ t: 'dismissCall' }] }

    // ---- Camera & photos
    case 'shutter':
      return { ui: { ...ui, shutter: ui.shutter + 1 }, effects: [{ t: 'takePhoto' }] }
    case 'refreshPreview':
      return { ui, effects: [{ t: 'preview' }] }
    case 'photo':
      return none({ ...ui, app: 'photos', photo: arg, sendPhoto: null })
    case 'photoDelete': {
      const id = arg || ui.photo
      if (!id) return none(ui)
      return { ui: { ...ui, photo: null }, effects: [{ t: 'deletePhoto', id }] }
    }
    case 'photoCaption': {
      const id = ui.photo
      if (!id) return none(ui)
      return { ui, effects: [{ t: 'caption', id, caption: (form.caption ?? '').trim().slice(0, 140) }] }
    }
    case 'photoSend':
      return none({ ...ui, sendPhoto: arg || ui.photo })
    case 'sendPhotoTo': {
      const photo = snap.record.gallery.find(p => p.id === ui.sendPhoto)
      const number = normalizeNumber(arg || form.to, area)
      if (!photo || !number) return none({ ...ui, error: number ? null : 'badNumber' })
      const next = openThread({ ...ui, sendPhoto: null, photo: null }, number, snap)
      return { ...next, ui: { ...next.ui, attach: { src: photo.src, w: photo.w, h: photo.h, caption: photo.caption } } }
    }

    // ---- Notes
    case 'noteNew': {
      const id = randomId()
      return {
        ui: { ...ui, note: id },
        effects: [{ t: 'saveNote', note: { id, text: '', updated: snap.clock.worldTime } }],
      }
    }
    case 'note':
      return none({ ...ui, note: arg })
    case 'noteInput': {
      if (!ui.note) return none(ui)
      return {
        ui,
        effects: [{ t: 'saveNote', note: { id: ui.note, text: form.note ?? '', updated: snap.clock.worldTime } }],
      }
    }
    case 'noteDelete': {
      const id = arg || ui.note
      if (!id) return none(ui)
      return { ui: { ...ui, note: null }, effects: [{ t: 'deleteNote', id }] }
    }

    // ---- Clock, calculator
    case 'h24':
      return { ui, effects: [{ t: 'prefs', h24: !snap.record.prefs.h24 }] }
    case 'calc':
      return { ui: { ...ui, calc: calcInput(ui.calc, arg as CalcInput) }, effects: [{ t: 'sound', name: 'tick' }] }

    // ---- Maps (pan by drag is handled by the controller; these are the buttons)
    case 'mapRecentre':
      return none({ ...ui, map: null })
    case 'mapZoom': {
      const g = mapGeometry(snap)
      const view = ui.map ?? centredView(g, snap.map?.dot ?? null)
      return none({ ...ui, map: zoomAt(view, g, arg === 'out' ? 1 / 1.5 : 1.5) })
    }

    default:
      void now
      return none(ui)
  }
}

export function back(ui: SmartUI): SmartUI {
  if (ui.error) return { ...ui, error: null }
  switch (ui.app) {
    case 'messages':
      if (ui.picking) return { ...ui, picking: false }
      if (ui.thread !== null) return { ...ui, thread: null, attach: null }
      break
    case 'phone':
      if (ui.contact) return { ...ui, contact: null }
      break
    case 'photos':
      if (ui.sendPhoto) return { ...ui, sendPhoto: null }
      if (ui.photo) return { ...ui, photo: null }
      break
    case 'notes':
      if (ui.note) return { ...ui, note: null }
      break
  }
  return goHome(ui)
}

/** Keys typed on a real keyboard while the calculator is open. */
export function calcKey(key: string): CalcInput | null {
  if (/^[0-9]$/.test(key)) return key as CalcInput
  const map: Record<string, CalcInput> = {
    '.': '.',
    ',': '.',
    '+': '+',
    '-': '-',
    '*': '*',
    x: '*',
    '/': '/',
    '=': '=',
    Enter: '=',
    Backspace: 'back',
    Delete: 'C',
    '%': '%',
  }
  return map[key] ?? null
}
