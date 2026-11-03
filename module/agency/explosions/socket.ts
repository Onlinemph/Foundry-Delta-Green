/**
 * A listener on upstream's 'system.gurps' socket channel, like the defense feature's: our message
 * types are namespaced 'agencyBoom.*' and each names the one user that should act on it.
 */
import { activeGMId } from '../defense/foundry-helpers.ts'

const CHANNEL = 'system.gurps'
const PREFIX = 'agencyBoom.'

type Handler = (data: any) => unknown
const handlers = new Map<string, Handler>()

export function onSocket(type: string, handler: Handler): void {
  handlers.set(PREFIX + type, handler)
}

export function listenSocket(): void {
  const socket = (game as any).socket
  if (!socket) return
  socket.on(CHANNEL, (message: any) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith(PREFIX)) return
    if (message.toUserId && message.toUserId !== game.user?.id) return
    const handler = handlers.get(message.type)
    if (!handler) return
    Promise.resolve(handler(message.data)).catch(err => console.error(`GURPS | Agency | socket ${message.type}`, err))
  })
}

/**
 * Run a handler on the active GM's client: here if this user is a GM, over the socket otherwise.
 * With no GM online it runs here (best effort) and returns false.
 */
export async function toGM(type: string, data: unknown): Promise<boolean> {
  if (game.user?.isGM) {
    await handlers.get(PREFIX + type)?.(data)
    return true
  }
  const gm = activeGMId()
  if (gm) {
    ;(game as any).socket?.emit(CHANNEL, { type: PREFIX + type, toUserId: gm, data })
    return true
  }
  await handlers.get(PREFIX + type)?.(data)
  return false
}
