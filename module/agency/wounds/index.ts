/**
 * Agency feature: wounds (Revised Fractional Health).
 * init() runs in the system 'init' hook (register settings, hooks, partials).
 * ready() runs in the system 'ready' hook.
 *
 * Rules: docs/agency/revised-fractional-health.md. Pure rules code lives in engine.ts and its helpers;
 * everything that touches Foundry is in the other files of this folder.
 */
import { registerAgencyPartials } from '../index.ts'
import { registerChatHandlers, onRenderChatMessage } from './chat.ts'
import { registerWoundSettings } from './config.ts'
import { registerStatuses } from './effects.ts'
import { registerDamageHandlers } from './apply-damage.ts'
import {
  onCombatTurnChange,
  onPreUpdateActor,
  onTurnStart,
  onUpdateActor,
  onUpdateWorldTime,
  overrideFatigueHelpers,
} from './hooks.ts'
import { onRenderActorSheet, registerHelpers } from './sheet.ts'
import { initSocket } from './socket.ts'

export { handleAgencyInjury } from './apply-damage.ts'

export function init(): void {
  registerWoundSettings()
  registerAgencyPartials({ 'agency-wounds-summary': 'systems/gurps/templates/agency/wounds-summary.hbs' })
  registerHelpers()

  Hooks.on('renderActorSheet', onRenderActorSheet as any)
  Hooks.on('renderChatMessageHTML', onRenderChatMessage as any)
  Hooks.on('preUpdateActor', onPreUpdateActor as any)
  Hooks.on('updateActor', onUpdateActor as any)
}

export function ready(): void {
  registerStatuses()
  overrideFatigueHelpers()

  initSocket()
  registerDamageHandlers()
  registerChatHandlers()

  Hooks.on('updateWorldTime', onUpdateWorldTime as any)
  Hooks.on('combatTurnChange', onCombatTurnChange as any)
  // Fired by the defense feature when a combatant's turn starts; de-duplicated against combatTurnChange.
  Hooks.on(
    'gurpsAgencyTurnStart' as any,
    ((data: { combat: any; combatant: any }) => void onTurnStart(data?.combat, data?.combatant)) as any
  )
}
