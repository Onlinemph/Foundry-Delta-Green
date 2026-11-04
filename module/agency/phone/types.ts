/**
 * Data model for the Agency phone. Plain JSON everywhere: these shapes live in actor flags, a world
 * setting and ChatMessage flags, and travel over the socket.
 *
 * Where things live:
 *  - Per-device private data (number, contacts, notes, gallery, read markers, prefs):
 *    actor flags, flags.gurps.agency.phone.{smartphone|burner} (PhoneFlags / DeviceRecord).
 *  - NPC identities the GM texts and calls as: world setting 'agency-phone-npcs' (NpcIdentity[]).
 *  - Texts and call-log entries: ChatMessage documents whispered to the users involved plus GMs, with
 *    the payload in flags.gurps.agency.phone (MessageFlag). Hidden from the chat log.
 *  - Scene signal and map settings: scene flags, flags.gurps.agency.phone (SceneFlags).
 *  - Flashlight state and the light it replaced: token flags, flags.gurps.agency.phone.flashlight.
 */

export type DeviceKind = 'smartphone' | 'burner'

/**
 * A device address that survives flags and sockets:
 *   '<actorId>:smartphone' | '<actorId>:burner'   an agent's device
 *   'npc:<identityId>'                            an NPC identity the GM operates
 *   'num:<digits>'                                a number nobody holds (texts go to the GM)
 */
export type DeviceId = string

export interface Contact {
  id: string
  name: string
  number: string
}

export interface Note {
  id: string
  text: string
  /** In-game time (seconds of world time) of the last edit. */
  updated: number
}

export interface Photo {
  id: string
  /** A path under the world's data folder, or a data: URL when the user may not upload files. */
  src: string
  caption: string
  /** In-game time (world seconds) the photo was taken or received. */
  taken: number
  w: number
  h: number
  origin: 'camera' | 'message' | 'handler'
  /** Bytes counted against the device's inline-storage budget (0 for uploaded files). */
  bytes: number
  /** Set on photos the handler pushed, until the owner has seen them. */
  fresh?: boolean
}

export interface DevicePrefs {
  /** 24-hour clock. */
  h24: boolean
}

export interface DeviceRecord {
  /** Ten digits, e.g. '2025550143'. */
  number: string
  contacts: Contact[]
  notes: Note[]
  gallery: Photo[]
  /** Thread key (counterpart number) -> deliveredTs of the newest message the owner has seen. */
  read: Record<string, number>
  /** deliveredTs of the newest missed call the owner has seen in Recents. */
  callsSeen: number
  prefs: DevicePrefs
}

/** flags.gurps.agency.phone on an actor. */
export interface PhoneFlags {
  smartphone?: DeviceRecord | null
  burner?: DeviceRecord | null
  /** The GM took the auto-issued smartphone away; don't issue it again. */
  noAutoSmartphone?: boolean
}

export interface NpcIdentity {
  id: string
  name: string
  number: string
  img: string
  read: Record<string, number>
  callsSeen: number
}

export interface Endpoint {
  number: string
  /** The device that held the number when the message was sent; absent for numbers nobody holds. */
  device?: DeviceId
}

/**
 * outbox: the sender had no signal; waits on the sender's phone ("Sending...").
 * held: left the sender, but the recipient has no signal; the recipient doesn't see it yet.
 * delivered: on the recipient's phone.
 */
export type DeliveryState = 'outbox' | 'held' | 'delivered'

export interface PhotoRef {
  src: string
  w: number
  h: number
  caption?: string
}

export type CallOutcome = 'answered' | 'missed' | 'declined'

/** flags.gurps.agency.phone on a ChatMessage. */
export interface MessageFlag {
  v: 1
  type: 'sms' | 'call'
  from: Endpoint
  to: Endpoint
  state: DeliveryState
  /** In-game time (world seconds) when sent / when the call started. */
  sentAt: number
  /** Date.now() on the client that delivered it; 0 until delivered. Only compared with other deliveredTs values. */
  deliveredTs: number
  text?: string
  photo?: PhotoRef
  outcome?: CallOutcome
  /** Call length in seconds (answered calls). */
  duration?: number
}

/** A phone message as the UI sees it: the flag plus the ChatMessage's id and timestamp. */
export interface PhoneMsg extends MessageFlag {
  id: string
  /** ChatMessage timestamp (ms). Orders messages. */
  ts: number
}

/** The device a view is for. */
export interface DeviceKey {
  id: DeviceId
  number: string
}

export type MapMode = 'off' | 'background' | 'custom'

/** flags.gurps.agency.phone on a scene. */
export interface SceneFlags {
  /** Mobile signal on this scene. Absent means on. */
  signal?: boolean
  map?: MapMode
  mapImage?: string
}

export function emptyDevice(number: string): DeviceRecord {
  return { number, contacts: [], notes: [], gallery: [], read: {}, callsSeen: 0, prefs: { h24: false } }
}

/** Fill gaps in a stored device record (older or hand-edited flags). */
export function normalizeDevice(raw: unknown): DeviceRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<DeviceRecord>
  if (typeof r.number !== 'string' || !r.number) return null
  return {
    number: r.number,
    contacts: Array.isArray(r.contacts) ? r.contacts.filter(c => c && typeof c.number === 'string') : [],
    notes: Array.isArray(r.notes) ? r.notes.filter(n => n && typeof n.text === 'string') : [],
    gallery: Array.isArray(r.gallery) ? r.gallery.filter(p => p && typeof p.src === 'string') : [],
    read: r.read && typeof r.read === 'object' ? { ...r.read } : {},
    callsSeen: Number(r.callsSeen) || 0,
    prefs: { h24: !!r.prefs?.h24 },
  }
}

export function deviceIdFor(actorId: string, kind: DeviceKind): DeviceId {
  return `${actorId}:${kind}`
}

export function parseDeviceId(
  id: DeviceId
):
  | { type: 'actor'; actorId: string; kind: DeviceKind }
  | { type: 'npc'; npcId: string }
  | { type: 'num'; number: string }
  | null {
  const [head, tail] = String(id).split(':')
  if (!head || !tail) return null
  if (head === 'npc') return { type: 'npc', npcId: tail }
  if (head === 'num') return { type: 'num', number: tail }
  if (tail === 'smartphone' || tail === 'burner') return { type: 'actor', actorId: head, kind: tail }
  return null
}

/** Short random id (not crypto; ids only need to be unique within one device's lists). */
export function randomId(rng: () => number = Math.random): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 10; i++) id += chars[Math.floor(rng() * chars.length)]
  return id
}
