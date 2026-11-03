/**
 * Only the GM and an actor's owners can update it (and only the GM or its author can update a chat
 * message). When someone else clicks a button, the work is sent over the system socket
 * ('system.gurps', the channel module/gurps.js already uses) to the active GM's client.
 */
const SOCKET = 'system.gurps'
const TYPE = 'agencyWounds'

type Handler = (payload: any) => Promise<void>

const handlers = new Map<string, Handler>()

export function registerSocketHandler(op: string, handler: Handler): void {
  handlers.set(op, handler)
}

export function initSocket(): void {
  ;(game as any).socket?.on(SOCKET, async (message: any) => {
    if (message?.type !== TYPE) return
    if (!(game as any).users?.activeGM?.isSelf) return
    const handler = handlers.get(message.op)
    if (!handler) return
    try {
      await handler(message.payload)
    } catch (error) {
      console.error(`GURPS | Agency wounds: socket op ${message.op} failed`, error)
    }
  })
}

async function runLocally(op: string, payload: unknown): Promise<void> {
  const handler = handlers.get(op)
  if (!handler) throw new Error(`Agency wounds: no handler for ${op}`)
  await handler(payload)
}

/** Run on this client if it may, otherwise on the active GM's client. */
export async function runWith(op: string, payload: unknown, mayRunHere: boolean): Promise<void> {
  if (mayRunHere || (game as any).user?.isGM) return runLocally(op, payload)
  if (!(game as any).users?.activeGM) {
    ui.notifications?.warn((game as any).i18n.localize('GURPS.agency.wounds.noGM'))
    return
  }
  ;(game as any).socket.emit(SOCKET, { type: TYPE, op, payload })
}
