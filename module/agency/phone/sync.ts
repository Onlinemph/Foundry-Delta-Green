/**
 * Keeping phones in step with the world (Foundry hooks):
 *  - the active GM's client moves held / outbox messages forward when signal changes (tokens enter or
 *    leave scenes, a scene's signal is toggled, the active scene changes), and issues smartphones to
 *    player characters that should have one;
 *  - every client notices texts and missed calls that just arrived for its devices (toast, buzz, ping)
 *    and refreshes open phones.
 */
import { catchUp } from './delivery.ts'
import { formatNumber } from './numbers.ts'
import { autoSmartphone, L } from './settings.ts'
import {
  allAgentDevices,
  canOpen,
  deviceLabel,
  endpointHasSignal,
  messageFlag,
  needsSmartphone,
  provisionSmartphones,
  recordOf,
  toPhoneMsg,
} from './store.ts'
import { direction } from './threads.ts'
import type { DeviceId, PhoneMsg } from './types.ts'
import { npcIdentities } from './settings.ts'
import { FLAG_ROOT, FLAG_SCOPE } from '../settings.ts'

type Listener = () => void
const listeners = new Set<Listener>()
/** Something phone-related changed: open windows and the launcher re-render. */
export function onPhoneChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
let pending = false
export function phoneChanged(): void {
  if (pending) return
  pending = true
  queueMicrotask(() => {
    pending = false
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        console.error('GURPS | Agency | phone refresh', err)
      }
    }
  })
}

type Arrival = (deviceId: DeviceId, msg: PhoneMsg) => void
let arrivalHandler: Arrival = () => {}
export function onArrival(fn: Arrival): void {
  arrivalHandler = fn
}

const isActiveGM = () => !!(game.users as any)?.activeGM?.isSelf

// ---------------------------------------------------------------------------------------------
// GM: delivery catch-up

/** Exported for tests; normally runs debounced from hooks. */
export async function runCatchUp(): Promise<void> {
  if (!isActiveGM()) return
  const items = ((game.messages as any)?.contents ?? [])
    .map((m: any) => ({ m, flag: messageFlag(m) }))
    .filter((x: any) => x.flag && x.flag.state !== 'delivered')
  if (!items.length) return
  const changes = catchUp(
    items.map((x: any) => ({ id: x.m.id, type: x.flag.type, state: x.flag.state, from: x.flag.from, to: x.flag.to })),
    endpointHasSignal
  )
  if (!changes.length) return
  const path = `flags.${FLAG_SCOPE}.${FLAG_ROOT}.phone`
  const now = Date.now()
  const updates = changes.map(c => ({
    _id: c.id,
    [`${path}.state`]: c.state,
    ...(c.state === 'delivered' ? { [`${path}.deliveredTs`]: now } : {}),
  }))
  await (ChatMessage as any).updateDocuments(updates)
}

const debounce = (fn: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
  }
}

const scheduleCatchUp = debounce(() => {
  runCatchUp().catch(err => console.error('GURPS | Agency | phone delivery catch-up failed', err))
}, 400)

const scheduleProvision = debounce(() => {
  if (!isActiveGM() || !autoSmartphone()) return
  const actors = ((game.actors as any)?.contents ?? []).filter(needsSmartphone)
  provisionSmartphones(actors).catch(err => console.error('GURPS | Agency | phone: issuing smartphones failed', err))
}, 800)

// ---------------------------------------------------------------------------------------------
// Everyone: arrivals

/** Devices on this client that a message arrived at. GMs get NPC identities and unheld numbers. */
function receivingDevices(msg: PhoneMsg): DeviceId[] {
  const out: DeviceId[] = []
  if (game.user?.isGM) {
    for (const n of npcIdentities()) {
      const id = `npc:${n.id}`
      if (direction(msg, { id, number: n.number }) === 'in') out.push(id)
    }
    // A number nobody holds: the GM hears about it too.
    if (!out.length && !msg.to.device && !npcIdentities().some(n => n.number === msg.to.number))
      out.push(`num:${msg.to.number}`)
    return out
  }
  for (const d of allAgentDevices()) {
    if (!canOpen(d.id)) continue
    if (direction(msg, { id: d.id, number: d.record.number }) === 'in') out.push(d.id)
  }
  return out
}

function arrived(message: any): void {
  const msg = toPhoneMsg(message)
  if (!msg || msg.state !== 'delivered') return
  if (msg.type === 'call' && msg.outcome !== 'missed') return
  for (const id of receivingDevices(msg)) arrivalHandler(id, msg)
}

/** Toast text for an arrival. */
export function arrivalText(deviceId: DeviceId, msg: PhoneMsg): string {
  const record = recordOf(deviceId)
  const who =
    record?.contacts.find(c => c.number === msg.from.number)?.name ??
    (game.user?.isGM && msg.from.device ? deviceLabel(msg.from.device) : formatNumber(msg.from.number))
  const i18n = game.i18n as any
  const device = deviceLabel(deviceId)
  return msg.type === 'call'
    ? i18n.format(`${L}.toast.missed`, { device, who })
    : i18n.format(`${L}.toast.text`, { device, who })
}

export function initSync(): void {
  Hooks.on('createChatMessage' as any, (message: any) => {
    if (!messageFlag(message)) return
    phoneChanged()
    // The author's own outgoing message isn't an arrival (but a self-text to a second phone is).
    arrived(message)
    if (messageFlag(message)!.state !== 'delivered') scheduleCatchUp()
  })
  Hooks.on('updateChatMessage' as any, (message: any, changes: any) => {
    if (!messageFlag(message)) return
    phoneChanged()
    const state = changes?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.phone?.state
    if (state === 'delivered') arrived(message)
  })
  Hooks.on('deleteChatMessage' as any, (message: any) => {
    if (messageFlag(message)) phoneChanged()
  })
  Hooks.on('updateActor' as any, (actor: any, changes: any) => {
    if (changes?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.phone !== undefined) phoneChanged()
    if (changes?.ownership !== undefined) {
      phoneChanged()
      scheduleProvision()
    }
    void actor
  })
  Hooks.on('createActor' as any, () => scheduleProvision())
  Hooks.on('updateUser' as any, () => phoneChanged())
  for (const hook of ['createToken', 'deleteToken']) {
    Hooks.on(hook as any, () => {
      phoneChanged()
      scheduleCatchUp()
    })
  }
  Hooks.on('updateToken' as any, (_token: any, changes: any) => {
    if ('x' in (changes ?? {}) || 'y' in (changes ?? {}) || 'light' in (changes ?? {}) || changes?.flags) phoneChanged()
  })
  Hooks.on('updateScene' as any, (_scene: any, changes: any) => {
    if (changes?.flags !== undefined || 'active' in (changes ?? {}) || changes?.background !== undefined) {
      phoneChanged()
      scheduleCatchUp()
    }
  })
  Hooks.on('canvasReady' as any, () => phoneChanged())
  Hooks.on('updateWorldTime' as any, () => phoneChanged())
}

export function readySync(): void {
  scheduleCatchUp()
  scheduleProvision()
}
