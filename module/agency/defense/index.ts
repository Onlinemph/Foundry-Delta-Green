/**
 * Agency feature: defense prompts and turn flow.
 *
 * - Defense prompts (defense-card.ts): a successful attack on targeted tokens posts a defense card
 *   per target; the defender rolls through upstream's actions; a hit gets a one-click damage roll that
 *   opens upstream's Apply Damage dialog on the target. Features that work out hits themselves
 *   (per-shot rapid fire) call promptDefense() instead and mark their roll optionalArgs.agencyHandled.
 * - Turn flow (turn-flow.ts): maneuver prompt, stun recovery, and the gurpsAgencyTurnStart /
 *   gurpsAgencyTurnEnd hooks other features use.
 * Rules and state transitions are pure functions in rules.ts and flow.ts.
 *
 * init() runs in the system 'init' hook; ready() in the system 'ready' hook.
 */
import { registerCardSocket, getCard } from './cards.ts'
import { decorateDefenseCard, onRollComplete, promptDefense, registerDefenseSocket } from './defense-card.ts'
import { ROLL_COMPLETE_HOOK } from './foundry-helpers.ts'
import { registerDefenseSettings } from './settings.ts'
import { listenSocket } from './socket.ts'
import { decorateTurnCard, onCombatTurnChange, onDeleteCombat } from './turn-flow.ts'

export { promptDefense } from './defense-card.ts'
export type { PromptDefenseArgs } from './defense-card.ts'
export type { TurnHookData } from './turn-flow.ts'

export function init(): void {
  registerDefenseSettings()

  // For non-TS code (and other features that would rather not import us): GURPS.agency.defense.promptDefense.
  const gurps = GURPS as any
  gurps.agency = gurps.agency ?? {}
  gurps.agency.defense = { ...(gurps.agency.defense ?? {}), promptDefense }

  Hooks.on(ROLL_COMPLETE_HOOK as any, (data: any) => {
    onRollComplete(data).catch(err => console.error('GURPS | Agency | defense prompt failed', err))
  })

  Hooks.on('renderChatMessageHTML' as any, (message: any, html: HTMLElement) => {
    const card = getCard(message)
    if (!card || !(html instanceof HTMLElement)) return
    if (card.kind === 'defense-card')
      decorateDefenseCard(message, html, card).catch(err => console.error('GURPS | Agency | defense card', err))
    else decorateTurnCard(message, html, card)
  })
}

export function ready(): void {
  registerCardSocket()
  registerDefenseSocket()
  listenSocket()

  Hooks.on('combatTurnChange' as any, onCombatTurnChange)
  Hooks.on('deleteCombat' as any, onDeleteCombat)
}
