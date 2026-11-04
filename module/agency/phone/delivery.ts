/**
 * Mobile signal and message delivery.
 *
 * Signal: an agent has signal when its token stands on a scene with signal. Tokens on several scenes:
 * the active scene decides if one of them is there, otherwise any scene with signal will do. No token
 * anywhere: signal (the agent is "off screen", somewhere normal). NPC identities and unheld numbers
 * always have signal; the GM decides what happens to them.
 *
 * Delivery of a text (or of a missed-call notice):
 *   sender without signal            -> outbox     (sender sees "Sending...")
 *   sender ok, recipient no signal   -> held       (sent, not on the recipient's phone yet)
 *   both ok                          -> delivered
 * Pending items move forward when signal changes; the active GM's client runs catchUp() when tokens
 * change scene or a scene's signal is toggled. States never move backwards.
 */
import type { DeliveryState, Endpoint } from './types.ts'

export function initialDelivery(senderSignal: boolean, recipientSignal: boolean): DeliveryState {
  if (!senderSignal) return 'outbox'
  return recipientSignal ? 'delivered' : 'held'
}

export function nextDelivery(state: DeliveryState, senderSignal: boolean, recipientSignal: boolean): DeliveryState {
  if (state === 'delivered') return state
  if (state === 'outbox' && !senderSignal) return 'outbox'
  return recipientSignal ? 'delivered' : 'held'
}

export interface PendingItem {
  id: string
  type: 'sms' | 'call'
  state: DeliveryState
  from: Endpoint
  to: Endpoint
}

/**
 * The state changes due now. Missed-call notices only wait on the recipient (the caller obviously had
 * signal to place the call).
 */
export function catchUp(
  items: PendingItem[],
  hasSignal: (ep: Endpoint) => boolean
): { id: string; state: DeliveryState }[] {
  const changes: { id: string; state: DeliveryState }[] = []
  const cache = new Map<string, boolean>()
  const signal = (ep: Endpoint) => {
    const key = ep.device ?? `num:${ep.number}`
    if (!cache.has(key)) cache.set(key, hasSignal(ep))
    return cache.get(key)!
  }
  for (const item of items) {
    if (item.state === 'delivered') continue
    const sender = item.type === 'call' ? true : signal(item.from)
    const next = nextDelivery(item.state, sender, signal(item.to))
    if (next !== item.state) changes.push({ id: item.id, state: next })
  }
  return changes
}

/**
 * Does an agent have signal?
 * @param tokenScenes ids of scenes holding one of the agent's tokens (duplicates fine)
 * @param sceneSignal signal setting of a scene
 * @param activeSceneId the scene the GM has active
 */
export function agentHasSignal(
  tokenScenes: string[],
  sceneSignal: (sceneId: string) => boolean,
  activeSceneId: string | null
): boolean {
  if (!tokenScenes.length) return true
  if (activeSceneId && tokenScenes.includes(activeSceneId)) return sceneSignal(activeSceneId)
  return tokenScenes.some(id => sceneSignal(id))
}

/** Scene flag -> signal (missing means on). */
export function sceneHasSignal(flag: unknown): boolean {
  return flag !== false
}

/** Bars to draw: 0 = no service; otherwise a steady 3-4 with a little variety per scene. */
export function signalBars(hasSignal: boolean, seed = ''): number {
  if (!hasSignal) return 0
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 3 === 0 ? 3 : 4
}
