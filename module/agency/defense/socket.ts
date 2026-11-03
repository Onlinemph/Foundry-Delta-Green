/**
 * A second listener on upstream's 'system.gurps' socket channel. Upstream's handler (module/gurps.js)
 * only reacts to the message types it knows, so ours are namespaced 'agencyDefense.*' and every
 * message names the one user that should act on it.
 */
const CHANNEL = 'system.gurps'
const PREFIX = 'agencyDefense.'

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

/** Socket messages never reach the sender, so callers handle the "it's me" case themselves. */
export function emitSocket(type: string, toUserId: string, data: unknown): void {
  ;(game as any).socket?.emit(CHANNEL, { type: PREFIX + type, toUserId, data })
}
