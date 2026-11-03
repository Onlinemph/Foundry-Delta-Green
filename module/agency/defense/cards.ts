/**
 * Posting and updating the feature's chat cards.
 *
 * Only a message's author or a GM may update it, and the user clicking a card is often neither
 * (a defender on the attacker's card). Card changes are therefore expressed as events and applied
 * by one client chosen by chooseCardExecutor(): this one, the active GM, or the card's author; with
 * none of those online a new card with the new state is posted instead.
 */
import { FLAG_ROOT, FLAG_SCOPE } from '../settings.ts'
import { chooseCardExecutor, reduceCard } from './flow.ts'
import { activeGMId, activeUserIds } from './foundry-helpers.ts'
import { emitSocket, onSocket } from './socket.ts'
import type { AgencyCardFlag, CardEvent } from './types.ts'
import { renderCard } from './views.ts'

const FLAG_KEY = `${FLAG_ROOT}.defense`

export function getCard(message: any): AgencyCardFlag | null {
  const card = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY)
  return card?.kind === 'defense-card' || card?.kind === 'turn-card' ? (card as AgencyCardFlag) : null
}

export async function postCard(card: AgencyCardFlag, whisper: string[], speaker?: object): Promise<any> {
  const content = await renderCard(card)
  return (ChatMessage as any).create({
    content,
    whisper,
    ...(speaker ? { speaker } : {}),
    flags: { [FLAG_SCOPE]: { [FLAG_ROOT]: { defense: card } } },
  })
}

/** Apply an event to a card from any client, routing it to a client allowed to update the card. */
export async function submitCardEvent(message: any, event: CardEvent): Promise<void> {
  const executor = chooseCardExecutor({
    selfId: game.user!.id,
    selfIsGM: !!game.user!.isGM,
    authorId: message.author?.id ?? null,
    activeGMId: activeGMId(),
    activeUserIds: activeUserIds(),
  })

  if (executor.kind === 'self') return applyCardEvent(message.id, event)
  if (executor.kind === 'remote') return emitSocket('cardEvent', executor.userId, { messageId: message.id, event })

  // Nobody online can update this card: post its next state as a new card.
  const card = getCard(message)
  if (!card) return
  const next = reduceCard(card, event)
  if (next !== card) await postCard(next, message.whisper ?? [], message.speaker)
}

const queues = new Map<string, Promise<void>>()

/** Executor side: serialize events per message so two quick clicks can't overwrite each other. */
export function applyCardEvent(messageId: string, event: CardEvent): Promise<void> {
  const previous = queues.get(messageId) ?? Promise.resolve()
  const next = previous
    .then(() => updateCard(messageId, event))
    .catch(err => console.error('GURPS | Agency | card update failed', err))
  queues.set(messageId, next)
  return next
}

async function updateCard(messageId: string, event: CardEvent): Promise<void> {
  const message = (game.messages as any)?.get(messageId)
  const card = getCard(message)
  if (!message || !card) return
  const next = reduceCard(card, event)
  if (next === card) return
  const content = await renderCard(next)
  await message.update({ content, [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: next })
}

export function registerCardSocket(): void {
  onSocket('cardEvent', (data: { messageId: string; event: CardEvent }) => applyCardEvent(data.messageId, data.event))
}
