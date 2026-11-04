/**
 * What a phone window shows, as plain data (PhoneSnapshot), and what the device asks the outside
 * world to do (Effect). The window controller (app.ts) builds snapshots from Foundry data and runs
 * effects; the reducers and views in this folder never touch Foundry, so they can be tested and
 * rendered to static HTML for screenshots.
 */
import type { CallState } from '../call-state.ts'
import type { MapGeometry } from '../maps.ts'
import type { Contact, DeviceId, DeviceRecord, Note, PhoneMsg, PhotoRef } from '../types.ts'

export type DeviceSkin = 'smartphone' | 'burner'

/** Smartphone screen size in CSS px (before the user's phone-size setting). */
export const SMART_SCREEN = { w: 318, h: 690 }

export type SmartApp = 'messages' | 'phone' | 'camera' | 'photos' | 'maps' | 'flashlight' | 'notes' | 'clock' | 'calc'

export interface MapInfo {
  /** Image to show, or null for "No map data". */
  src: string | null
  /** Agent position on the map (fractions), or null when not on this map. */
  dot: { u: number; v: number } | null
  /** Width / height of the map image (scene rectangle). */
  aspect: number
  /** Label in the search pill (scene navigation name). */
  place: string
}

export interface PhoneSnapshot {
  device: {
    id: DeviceId
    skin: DeviceSkin
    /** 'npc' devices are the GM's NPC identities (and unheld numbers). */
    owner: 'agent' | 'npc'
    number: string
    /** Agent or NPC name. */
    name: string
    img?: string
  }
  record: DeviceRecord
  /** Every phone message this device may see (the views filter by direction). */
  messages: PhoneMsg[]
  /** Number -> display name (the device's contacts; for the GM's NPC phones, the whole directory). */
  names: Record<string, string>
  /** Number -> portrait (NPC phones only). */
  avatars: Record<string, string>
  clock: { start: string; worldTime: number; lang: string }
  signal: boolean
  bars: number
  carrier: string
  flashlight: boolean
  map: MapInfo | null
  call: CallState | null
  /** The GM reading an agent's phone: nothing is marked read. */
  inspect: boolean
  /** Apps on the home screen (NPC phones have fewer). */
  apps: SmartApp[]
  /** Camera viewfinder image (data URL) or null; 'none' when the agent isn't on the viewed scene. */
  preview: string | null | 'none'
  /** Inline photo storage used, percent. */
  storage: number
  /** Date.now() at snapshot time (call timers). */
  now: number
}

export type Effect =
  | { t: 'send'; to: string; text: string; photo?: PhotoRef | null }
  | { t: 'call'; to: string }
  | { t: 'answer' }
  | { t: 'decline' }
  | { t: 'hangup' }
  | { t: 'say'; text: string }
  | { t: 'mute'; muted: boolean }
  | { t: 'dismissCall' }
  | { t: 'saveContact'; contact: Contact }
  | { t: 'deleteContact'; id: string }
  | { t: 'saveNote'; note: Note }
  | { t: 'deleteNote'; id: string }
  | { t: 'takePhoto' }
  | { t: 'preview' }
  | { t: 'deletePhoto'; id: string }
  | { t: 'caption'; id: string; caption: string }
  | { t: 'savePhoto'; photo: PhotoRef }
  | { t: 'pickImage' }
  | { t: 'torch' }
  | { t: 'markRead'; key: string }
  | { t: 'callsSeen' }
  | { t: 'prefs'; h24: boolean }
  | { t: 'sound'; name: SoundName; key?: string }
  | { t: 'lock' }

export type SoundName = 'click' | 'dtmf' | 'shutter' | 'ping' | 'tick' | 'error'

/** Translate a key under GURPS.agency.phone. */
export type Translate = (key: string, data?: Record<string, string | number>) => string

export function nameFor(snap: PhoneSnapshot, number: string, fallback: (n: string) => string): string {
  return snap.names[number] || fallback(number)
}

export function contactByNumber(contacts: Contact[], number: string): Contact | undefined {
  return contacts.find(c => c.number === number)
}

export function sortedContacts(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function sortedNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.updated - a.updated)
}

/** First line of a note, for lists. */
export function noteTitle(note: Note, untitled: string): string {
  const line = note.text.split('\n').find(l => l.trim())
  return line ? line.trim() : untitled
}

export function mapGeometry(snap: PhoneSnapshot): MapGeometry {
  return { vw: SMART_SCREEN.w, vh: SMART_SCREEN.h, aspect: snap.map?.aspect || 1 }
}
