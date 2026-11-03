/**
 * Agency feature: sanity
 *
 * Delta Green-style SAN, Breaking Points, Bonds and adaptation, fed by GURPS Fright Checks.
 * Data lives in actor.system.sanity (template.json) so it can be a token bar and survives GCS
 * re-import; the most recent loss (for projecting onto a Bond) is in flags.gurps.agency.sanity.lastLoss.
 *
 * init() runs in the system 'init' hook (register settings, hooks, partials).
 * ready() runs in the system 'ready' hook.
 */
import { registerAgencyPartials } from '../index.ts'
import { onRenderChatMessage } from './chat-card.ts'
import { registerSanCommands } from './commands.ts'
import { registerSanitySettings } from './data.ts'
import { onPreUpdateActor, onRenderActorSheet, panelContext } from './sheet.ts'

export function init(): void {
  registerSanitySettings()
  registerAgencyPartials({
    'agency-sanity-fc-fields': 'systems/gurps/templates/agency/sanity-fc-fields.hbs',
  })
  Handlebars.registerHelper('agencySanityPanel', (actor: any) => panelContext(actor))
  registerSanCommands()

  Hooks.on('renderActorSheet' as any, onRenderActorSheet as any)
  Hooks.on('preUpdateActor', onPreUpdateActor as any)
  Hooks.on('renderChatMessageHTML' as any, onRenderChatMessage as any)
}

export function ready(): void {}
