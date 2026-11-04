/**
 * Foundry-facing data access for the phone: devices in actor flags, NPC identities in a world setting,
 * texts and call-log entries as ChatMessages.
 *
 * Privacy. A phone ChatMessage is whispered to the players who own the agents involved plus the GMs,
 * so other players' clients don't show it (and Foundry keeps it from their chat log). The device data
 * in actor flags is only offered through the phone UI to the actor's owners and the GM.
 */
import { FLAG_ROOT, FLAG_SCOPE } from '../settings.ts'
import { agentHasSignal, initialDelivery, sceneHasSignal, signalBars } from './delivery.ts'
import { dotPosition, mapMode, mapSource } from './maps.ts'
import { formatNumber, generateNumber } from './numbers.ts'
import { canStore, dataUrlBytes, INLINE_ATTACHMENT_MAX, storageUsed } from './photos.ts'
import { areaCode, campaignStart, carrierName, npcIdentities, saveNpcIdentities } from './settings.ts'
import { callsSeenMarker, direction, readMarker } from './threads.ts'
import {
  deviceIdFor,
  emptyDevice,
  normalizeDevice,
  parseDeviceId,
  randomId,
  type CallOutcome,
  type Contact,
  type DeviceId,
  type DeviceKey,
  type DeviceKind,
  type DeviceRecord,
  type Endpoint,
  type MessageFlag,
  type NpcIdentity,
  type Note,
  type PhoneFlags,
  type PhoneMsg,
  type Photo,
  type PhotoRef,
} from './types.ts'
import type { MapInfo, PhoneSnapshot, SmartApp } from './ui/model.ts'
import type { CallState } from './call-state.ts'

type AnyActor = any
type AnyScene = any

const OWNER = 3
export const FLAG_KEY = `${FLAG_ROOT}.phone`
const ACTOR_PATH = `flags.${FLAG_SCOPE}.${FLAG_KEY}`

export class PhoneError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

// ---------------------------------------------------------------------------------------------
// Devices

export function phoneFlags(actor: AnyActor): PhoneFlags {
  return (actor?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.phone ?? {}) as PhoneFlags
}

export function deviceRecord(actor: AnyActor, kind: DeviceKind): DeviceRecord | null {
  return normalizeDevice(phoneFlags(actor)[kind])
}

export interface AgentDevice {
  id: DeviceId
  actor: AnyActor
  kind: DeviceKind
  record: DeviceRecord
}

export function actorDevices(actor: AnyActor): AgentDevice[] {
  const out: AgentDevice[] = []
  for (const kind of ['smartphone', 'burner'] as DeviceKind[]) {
    const record = deviceRecord(actor, kind)
    if (record) out.push({ id: deviceIdFor(actor.id, kind), actor, kind, record })
  }
  return out
}

export function allAgentDevices(): AgentDevice[] {
  return ((game.actors as any)?.contents ?? []).flatMap((a: AnyActor) => actorDevices(a))
}

export function takenNumbers(): string[] {
  return [...allAgentDevices().map(d => d.record.number), ...npcIdentities().map(n => n.number)]
}

export function actorOf(id: DeviceId): AnyActor | null {
  const p = parseDeviceId(id)
  return p?.type === 'actor' ? ((game.actors as any)?.get(p.actorId) ?? null) : null
}

export function npcOf(id: DeviceId): NpcIdentity | null {
  const p = parseDeviceId(id)
  return p?.type === 'npc' ? (npcIdentities().find(n => n.id === p.npcId) ?? null) : null
}

/** Number and id of a device, or null if it no longer exists. */
export function deviceKey(id: DeviceId): DeviceKey | null {
  const p = parseDeviceId(id)
  if (!p) return null
  if (p.type === 'actor') {
    const record = deviceRecord(actorOf(id), p.kind)
    return record ? { id, number: record.number } : null
  }
  if (p.type === 'npc') {
    const npc = npcOf(id)
    return npc ? { id, number: npc.number } : null
  }
  return { id, number: p.number }
}

/** Who holds this number now: an agent's device, an NPC identity, or nobody. */
export function resolveNumber(number: string): Endpoint {
  const agent = allAgentDevices().find(d => d.record.number === number)
  if (agent) return { number, device: agent.id }
  const npc = npcIdentities().find(n => n.number === number)
  if (npc) return { number, device: `npc:${npc.id}` }
  return { number }
}

export function endpointFor(id: DeviceId): Endpoint {
  const key = deviceKey(id)
  if (!key) throw new PhoneError('noDevice')
  return { number: key.number, device: id }
}

/** "Mara Quinn", "Mara Quinn (burner)", "Handler". */
export function deviceLabel(id: DeviceId): string {
  const p = parseDeviceId(id)
  if (!p) return '?'
  if (p.type === 'actor') {
    const name = actorOf(id)?.name ?? '?'
    return p.kind === 'burner' ? `${name} (${game.i18n!.localize('GURPS.agency.phone.burner')})` : name
  }
  if (p.type === 'npc') return npcOf(id)?.name || formatNumber(npcOf(id)?.number ?? '')
  return formatNumber(p.number)
}

/** Players (not GMs) who own the actor. */
function playerOwners(actor: AnyActor): any[] {
  if (!actor) return []
  return ((game.users as any)?.contents ?? []).filter((u: any) => !u.isGM && actor.testUserPermission?.(u, OWNER))
}

function gms(): any[] {
  return ((game.users as any)?.contents ?? []).filter((u: any) => u.isGM)
}

/** Users who answer this device: its actor's player owners, or the GMs for NPC numbers. */
export function deviceUsers(ep: Endpoint): any[] {
  if (ep.device) {
    const p = parseDeviceId(ep.device)
    if (p?.type === 'actor') return playerOwners(actorOf(ep.device))
  }
  return gms()
}

export function whisperFor(a: Endpoint, b: Endpoint): string[] {
  const ids = new Set<string>(gms().map(u => u.id))
  for (const ep of [a, b]) {
    if (!ep.device) continue
    const p = parseDeviceId(ep.device)
    if (p?.type === 'actor') for (const u of playerOwners(actorOf(ep.device))) ids.add(u.id)
  }
  return [...ids]
}

/** May this user open the device at all? Players: devices of agents they own. GMs: anything. */
export function canOpen(id: DeviceId): boolean {
  if (game.user?.isGM) return !!deviceKey(id)
  const p = parseDeviceId(id)
  if (p?.type !== 'actor') return false
  const actor = actorOf(id)
  return !!actor && actor.testUserPermission?.(game.user, OWNER) && !!deviceRecord(actor, p.kind)
}

/** Devices this (non-GM) user can pick up. */
export function myDevices(): AgentDevice[] {
  if (!game.user) return []
  return allAgentDevices().filter(d => d.actor.testUserPermission?.(game.user, OWNER))
}

/** The GM reading a phone that belongs to a player's agent. */
export function isInspect(id: DeviceId): boolean {
  if (!game.user?.isGM) return false
  const actor = actorOf(id)
  return !!actor && playerOwners(actor).length > 0
}

const updateOptions = { render: false }

async function writeDevice(id: DeviceId, patch: Partial<DeviceRecord>): Promise<void> {
  const p = parseDeviceId(id)
  if (p?.type === 'actor') {
    const actor = actorOf(id)
    const current = deviceRecord(actor, p.kind)
    if (!actor || !current) throw new PhoneError('noDevice')
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) data[`${ACTOR_PATH}.${p.kind}.${k}`] = v
    await actor.update(data, updateOptions)
    return
  }
  if (p?.type === 'npc') {
    // NPC identities only keep read markers.
    const list = npcIdentities()
    const npc = list.find(n => n.id === p.npcId)
    if (!npc) return
    if (patch.read) npc.read = { ...npc.read, ...patch.read }
    if (patch.callsSeen !== undefined) npc.callsSeen = patch.callsSeen
    await saveNpcIdentities(list)
  }
}

export function recordOf(id: DeviceId): DeviceRecord | null {
  const p = parseDeviceId(id)
  if (!p) return null
  if (p.type === 'actor') return deviceRecord(actorOf(id), p.kind)
  const key = deviceKey(id)
  if (!key) return null
  const npc = npcOf(id)
  return { ...emptyDevice(key.number), read: npc?.read ?? {}, callsSeen: npc?.callsSeen ?? 0, prefs: { h24: false } }
}

export async function saveContact(id: DeviceId, contact: Contact): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  const contacts = record.contacts.filter(c => c.id !== contact.id && c.number !== contact.number)
  contacts.push({ id: contact.id, name: contact.name.slice(0, 40), number: contact.number })
  await writeDevice(id, { contacts })
}

export async function deleteContact(id: DeviceId, contactId: string): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  await writeDevice(id, { contacts: record.contacts.filter(c => c.id !== contactId) })
}

export async function saveNote(id: DeviceId, note: Note): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  const notes = record.notes.filter(n => n.id !== note.id)
  notes.push({ id: note.id, text: note.text.slice(0, 4000), updated: note.updated })
  await writeDevice(id, { notes })
}

export async function deleteNote(id: DeviceId, noteId: string): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  await writeDevice(id, { notes: record.notes.filter(n => n.id !== noteId) })
}

export async function addPhoto(id: DeviceId, photo: Omit<Photo, 'id'>): Promise<Photo> {
  const record = recordOf(id)
  if (!record) throw new PhoneError('noDevice')
  const check = canStore(record.gallery, photo.bytes)
  if (!check.ok) throw new PhoneError('storageFull')
  const full: Photo = { id: randomId(), ...photo }
  await writeDevice(id, { gallery: [...record.gallery, full] })
  return full
}

export async function updatePhoto(id: DeviceId, photoId: string, patch: Partial<Photo>): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  await writeDevice(id, { gallery: record.gallery.map(p => (p.id === photoId ? { ...p, ...patch } : p)) })
}

export async function deletePhoto(id: DeviceId, photoId: string): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  await writeDevice(id, { gallery: record.gallery.filter(p => p.id !== photoId) })
}

/** Clear the "new" dot on photos the handler pushed. */
export async function clearFreshPhotos(id: DeviceId): Promise<void> {
  const record = recordOf(id)
  if (!record?.gallery.some(p => p.fresh)) return
  await writeDevice(id, { gallery: record.gallery.map(p => ({ ...p, fresh: false })) })
}

export async function savePhotoFromMessage(id: DeviceId, ref: PhotoRef): Promise<void> {
  const record = recordOf(id)
  if (!record || record.gallery.some(p => p.src === ref.src)) return
  await addPhoto(id, {
    src: ref.src,
    caption: ref.caption ?? '',
    taken: Number((game.time as any)?.worldTime) || 0,
    w: ref.w,
    h: ref.h,
    origin: 'message',
    bytes: dataUrlBytes(ref.src),
  })
}

export async function setPrefs(id: DeviceId, prefs: Partial<DeviceRecord['prefs']>): Promise<void> {
  const record = recordOf(id)
  if (!record) return
  await writeDevice(id, { prefs: { ...record.prefs, ...prefs } })
}

export async function markRead(id: DeviceId, key: string): Promise<void> {
  const record = recordOf(id)
  const me = deviceKey(id)
  if (!record || !me) return
  const marker = readMarker(phoneMessages(), me, key)
  if (marker <= (record.read[key] ?? 0)) return
  await writeDevice(id, { read: { ...record.read, [key]: marker } })
}

export async function markCallsSeen(id: DeviceId): Promise<void> {
  const record = recordOf(id)
  const me = deviceKey(id)
  if (!record || !me) return
  const marker = callsSeenMarker(phoneMessages(), me)
  if (marker <= record.callsSeen) return
  await writeDevice(id, { callsSeen: marker })
}

// ---- Issuing (GM)

export async function issueDevice(actor: AnyActor, kind: DeviceKind, number?: string): Promise<string> {
  const taken = takenNumbers()
  const fresh = number ?? generateNumber(taken, Math.random, kind === 'smartphone' ? areaCode() : undefined)
  if (!fresh) throw new PhoneError('noNumbers')
  const data: Record<string, unknown> = { [`${ACTOR_PATH}.${kind}`]: emptyDevice(fresh) }
  if (kind === 'smartphone') data[`${ACTOR_PATH}.noAutoSmartphone`] = false
  await actor.update(data, updateOptions)
  return fresh
}

export async function revokeDevice(actor: AnyActor, kind: DeviceKind): Promise<void> {
  const data: Record<string, unknown> = { [`${ACTOR_PATH}.${kind}`]: null }
  if (kind === 'smartphone') data[`${ACTOR_PATH}.noAutoSmartphone`] = true
  await actor.update(data, updateOptions)
}

export async function setDeviceNumber(actor: AnyActor, kind: DeviceKind, number: string): Promise<void> {
  await actor.update({ [`${ACTOR_PATH}.${kind}.number`]: number }, updateOptions)
}

/** Player characters get a smartphone unless the GM took it away. Active GM only. */
export function needsSmartphone(actor: AnyActor): boolean {
  if (!actor || actor.type !== 'character' || !actor.hasPlayerOwner) return false
  const flags = phoneFlags(actor)
  return !normalizeDevice(flags.smartphone) && !flags.noAutoSmartphone
}

export async function provisionSmartphones(actors: AnyActor[]): Promise<number> {
  let n = 0
  for (const actor of actors) {
    if (!needsSmartphone(actor)) continue
    await issueDevice(actor, 'smartphone')
    n++
  }
  return n
}

// ---- NPC identities (GM)

export async function upsertNpc(npc: Partial<NpcIdentity> & { name: string; number: string }): Promise<NpcIdentity> {
  const list = npcIdentities()
  const existing = npc.id ? list.find(n => n.id === npc.id) : undefined
  if (existing) {
    Object.assign(existing, { name: npc.name, number: npc.number, img: npc.img ?? existing.img })
    await saveNpcIdentities(list)
    return existing
  }
  const created: NpcIdentity = {
    id: randomId(),
    name: npc.name,
    number: npc.number,
    img: npc.img ?? '',
    read: {},
    callsSeen: 0,
  }
  await saveNpcIdentities([...list, created])
  return created
}

export async function deleteNpc(npcId: string): Promise<void> {
  await saveNpcIdentities(npcIdentities().filter(n => n.id !== npcId))
}

/** Numbers with messages or calls that nobody holds (the GM's "unlisted" inbox). */
export function unlistedNumbers(): { number: string; count: number }[] {
  const held = new Set(takenNumbers())
  const counts = new Map<string, number>()
  for (const msg of phoneMessages()) {
    for (const ep of [msg.from, msg.to]) {
      if (ep.device || held.has(ep.number)) continue
      counts.set(ep.number, (counts.get(ep.number) ?? 0) + 1)
    }
  }
  return [...counts.entries()].map(([number, count]) => ({ number, count }))
}

// ---------------------------------------------------------------------------------------------
// Signal

export function sceneFlags(scene: AnyScene): { signal?: boolean; map?: string; mapImage?: string; mapLabel?: string } {
  return scene?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.phone ?? {}
}

export function sceneSignal(scene: AnyScene): boolean {
  return sceneHasSignal(sceneFlags(scene).signal)
}

/** Scenes holding a token of this actor. */
export function tokenScenes(actorId: string): AnyScene[] {
  return ((game.scenes as any)?.contents ?? []).filter((s: AnyScene) =>
    s.tokens?.some?.((t: any) => t.actorId === actorId)
  )
}

/** The scene the agent is "on": the active scene if a token is there, else the one being viewed, else any. */
export function agentScene(actorId: string): AnyScene | null {
  const scenes = tokenScenes(actorId)
  const active = (game.scenes as any)?.active
  return (
    scenes.find(s => s.id === active?.id) ?? scenes.find(s => s.id === (canvas as any)?.scene?.id) ?? scenes[0] ?? null
  )
}

export function endpointHasSignal(ep: Endpoint): boolean {
  const p = ep.device ? parseDeviceId(ep.device) : null
  if (p?.type !== 'actor') return true
  const scenes = tokenScenes(p.actorId)
  const byId = new Map(scenes.map(s => [s.id, s]))
  return agentHasSignal(
    scenes.map(s => s.id),
    id => sceneSignal(byId.get(id)),
    (game.scenes as any)?.active?.id ?? null
  )
}

export function deviceHasSignal(id: DeviceId): boolean {
  return endpointHasSignal({ number: '', device: id })
}

// ---------------------------------------------------------------------------------------------
// Messages

export function messageFlag(message: any): MessageFlag | null {
  const f = message?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.phone
  if (!f || f.v !== 1 || (f.type !== 'sms' && f.type !== 'call') || !f.from?.number || !f.to?.number) return null
  return f as MessageFlag
}

export function toPhoneMsg(message: any): PhoneMsg | null {
  const flag = messageFlag(message)
  if (!flag) return null
  return { ...flag, id: message.id, ts: Number(message.timestamp) || 0 }
}

export function phoneMessages(): PhoneMsg[] {
  const out: PhoneMsg[] = []
  for (const m of (game.messages as any)?.contents ?? []) {
    const msg = toPhoneMsg(m)
    if (msg) out.push(msg)
  }
  return out
}

const worldTime = () => Number((game.time as any)?.worldTime) || 0

async function createPhoneMessage(flag: MessageFlag): Promise<void> {
  const STYLES = (CONST as any).CHAT_MESSAGE_STYLES
  await (ChatMessage as any).create(
    {
      content: '<span class="agency-phone-stub"></span>',
      whisper: whisperFor(flag.from, flag.to),
      speaker: { alias: game.i18n!.localize('GURPS.agency.phone.apps.phone') },
      style: STYLES?.OTHER ?? 0,
      flags: { [FLAG_SCOPE]: { [FLAG_ROOT]: { phone: flag } } },
    },
    { chatBubble: false }
  )
}

export async function sendText(
  fromId: DeviceId,
  toNumber: string,
  text: string,
  photo?: PhotoRef | null
): Promise<MessageFlag> {
  const from = endpointFor(fromId)
  const to = resolveNumber(toNumber)
  if (photo && dataUrlBytes(photo.src) > INLINE_ATTACHMENT_MAX) throw new PhoneError('tooBig')
  const state = initialDelivery(deviceHasSignal(fromId), endpointHasSignal(to))
  const flag: MessageFlag = {
    v: 1,
    type: 'sms',
    from,
    to,
    state,
    sentAt: worldTime(),
    deliveredTs: state === 'delivered' ? Date.now() : 0,
    text: text.slice(0, 480),
    ...(photo ? { photo: { src: photo.src, w: photo.w, h: photo.h, caption: photo.caption ?? '' } } : {}),
  }
  await createPhoneMessage(flag)
  return flag
}

export async function logCall(call: CallState, outcome: CallOutcome, opts: { held?: boolean } = {}): Promise<void> {
  const from = { number: call.localNumber, device: call.local }
  const flag: MessageFlag = {
    v: 1,
    type: 'call',
    from,
    to: call.remote,
    state: opts.held ? 'held' : 'delivered',
    sentAt: Math.max(
      0,
      worldTime() - (call.startedAt && call.endedAt ? Math.floor((call.endedAt - call.startedAt) / 1000) : 0)
    ),
    deliveredTs: opts.held ? 0 : Date.now(),
    outcome,
    duration: call.startedAt && call.endedAt ? Math.round((call.endedAt - call.startedAt) / 1000) : 0,
  }
  await createPhoneMessage(flag)
}

// ---------------------------------------------------------------------------------------------
// Snapshot for a phone window

const SMART_APPS: SmartApp[] = ['messages', 'phone', 'camera', 'photos', 'maps', 'flashlight', 'notes', 'clock', 'calc']
const NPC_APPS: SmartApp[] = ['messages', 'phone', 'clock', 'calc']

/** Number -> name the GM sees on NPC phones: every agent device and identity. */
function directoryNames(): { names: Record<string, string>; avatars: Record<string, string> } {
  const names: Record<string, string> = {}
  const avatars: Record<string, string> = {}
  for (const d of allAgentDevices()) {
    names[d.record.number] = deviceLabel(d.id)
    if (d.actor.img) avatars[d.record.number] = d.actor.img
  }
  for (const n of npcIdentities()) {
    names[n.number] = n.name || formatNumber(n.number)
    if (n.img) avatars[n.number] = n.img
  }
  return { names, avatars }
}

export function mapInfo(actor: AnyActor): MapInfo {
  const scene = agentScene(actor.id)
  const none = (place = ''): MapInfo => ({ src: null, dot: null, aspect: 1, place })
  if (!scene) return none()
  const flags = sceneFlags(scene)
  const place = String(flags.mapLabel || scene.navName || '')
  const src = mapSource(mapMode(flags.map), scene.background?.src, flags.mapImage)
  if (!src) return none(place)
  const dims = scene.dimensions ?? {}
  const rect = {
    x: dims.sceneX ?? 0,
    y: dims.sceneY ?? 0,
    width: dims.sceneWidth ?? scene.width ?? 0,
    height: dims.sceneHeight ?? scene.height ?? 0,
  }
  const token = scene.tokens?.find?.((t: any) => t.actorId === actor.id)
  const size = dims.size ?? scene.grid?.size ?? 100
  const center = token
    ? { x: token.x + ((token.width ?? 1) * size) / 2, y: token.y + ((token.height ?? 1) * size) / 2 }
    : null
  return {
    src,
    dot: center ? dotPosition(center, rect) : null,
    aspect: rect.height > 0 ? rect.width / rect.height : 1,
    place,
  }
}

export interface SnapshotExtras {
  inspect: boolean
  call: CallState | null
  preview: string | null | 'none'
  flashlight: boolean
}

export function buildSnapshot(id: DeviceId, extras: SnapshotExtras): PhoneSnapshot | null {
  const p = parseDeviceId(id)
  const key = deviceKey(id)
  const record = recordOf(id)
  if (!p || !key || !record) return null
  const all = phoneMessages()
  const messages = all.filter(m => direction(m, key) !== null)
  const signal = deviceHasSignal(id)
  let snapDevice: PhoneSnapshot['device']
  let names: Record<string, string> = {}
  let avatars: Record<string, string> = {}
  let map: MapInfo | null = null
  let apps: SmartApp[]
  if (p.type === 'actor') {
    const actor = actorOf(id)
    snapDevice = { id, skin: p.kind, owner: 'agent', number: key.number, name: actor?.name ?? '?', img: actor?.img }
    for (const c of record.contacts) names[c.number] = c.name
    if (p.kind === 'smartphone') map = mapInfo(actor)
    apps = SMART_APPS
  } else {
    const npc = npcOf(id)
    snapDevice = {
      id,
      skin: 'smartphone',
      owner: 'npc',
      number: key.number,
      name: npc?.name || formatNumber(key.number),
      img: npc?.img,
    }
    ;({ names, avatars } = directoryNames())
    apps = NPC_APPS
  }
  const sceneId = p.type === 'actor' ? (agentScene(p.actorId)?.id ?? '') : ''
  return {
    device: snapDevice,
    record,
    messages,
    names,
    avatars,
    clock: { start: campaignStart(), worldTime: worldTime(), lang: (game.i18n as any)?.lang ?? 'en' },
    signal,
    bars: signalBars(signal, sceneId),
    carrier: carrierName(),
    flashlight: extras.flashlight,
    map,
    call: extras.call,
    inspect: extras.inspect,
    apps,
    preview: extras.preview,
    storage: storageUsed(record.gallery),
    now: Date.now(),
  }
}

export function unreadFor(id: DeviceId): number {
  const key = deviceKey(id)
  const record = recordOf(id)
  if (!key || !record) return 0
  const msgs = phoneMessages()
  let n = 0
  for (const m of msgs) {
    if (direction(m, key) !== 'in' || m.state !== 'delivered') continue
    if (m.type === 'sms' && m.deliveredTs > (record.read[m.from.number] ?? 0)) n++
    if (m.type === 'call' && m.outcome !== 'answered' && m.deliveredTs > record.callsSeen) n++
  }
  return n
}
