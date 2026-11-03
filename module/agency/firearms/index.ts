/**
 * Agency feature: firearms and ammunition tracking.
 *
 * Parses each ranged weapon's Shots ("17+1(3)", "8(3i)", "T(1)"...), keeps rounds loaded per weapon in
 * flags.gurps.agency.firearms, spends them on attacks (gurpsAgencyPreRoll / gurpsAgencyRollComplete),
 * and reloads from the sheet (rounds badge + reload icon) or the /reload and /ammo chat commands.
 *
 * init() runs in the system 'init' hook (register settings, hooks, partials).
 * ready() runs in the system 'ready' hook.
 */
import { ChatProcessors } from '../../chat.js'
import { AgencyHooks } from '../index.ts'
import { registerAgencySetting } from '../settings.ts'
import { AmmoChatProcessor, ReloadChatProcessor } from './chat-command.ts'
import { L10N, SETTING_EMPTY, SETTING_THROWN, SETTING_TRACKING } from './constants.ts'
import { onPreRoll, onRollComplete } from './firing.ts'
import { onRenderActorSheet } from './sheet.ts'

function rerenderActorSheets(): void {
  for (const app of Object.values(ui.windows ?? {})) {
    const sheet = app as { actor?: unknown; render?: (force?: boolean) => unknown }
    if (sheet?.actor && typeof sheet.render === 'function') sheet.render(false)
  }
}

function registerSettings(): void {
  registerAgencySetting(SETTING_TRACKING, {
    name: `${L10N}.settings.tracking.name`,
    hint: `${L10N}.settings.tracking.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: rerenderActorSheets,
  })

  registerAgencySetting(SETTING_EMPTY, {
    name: `${L10N}.settings.empty.name`,
    hint: `${L10N}.settings.empty.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: {
      block: `${L10N}.settings.empty.block`,
      warn: `${L10N}.settings.empty.warn`,
    },
    default: 'block',
  })

  registerAgencySetting(SETTING_THROWN, {
    name: `${L10N}.settings.thrown.name`,
    hint: `${L10N}.settings.thrown.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    onChange: rerenderActorSheets,
  })
}

export function init(): void {
  registerSettings()

  Hooks.on(AgencyHooks.PRE_ROLL as any, onPreRoll as any)
  Hooks.on(AgencyHooks.ROLL_COMPLETE as any, onRollComplete as any)
  Hooks.on('renderActorSheet' as any, onRenderActorSheet as any)

  ChatProcessors.registerProcessor(new ReloadChatProcessor())
  ChatProcessors.registerProcessor(new AmmoChatProcessor())
}

export function ready(): void {}
