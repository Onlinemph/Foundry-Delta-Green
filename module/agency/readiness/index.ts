/**
 * Agency feature: weapon readiness.
 *
 * Each weapon that comes from equipment (not Punch, Kick or a trait's natural attack) is ready,
 * holstered, slung, stowed or dropped (flags.gurps.agency.readiness). In combat, attacking with an
 * unready weapon asks for a Ready maneuver or a Fast-Draw roll; outside combat it is simply drawn.
 * Reloading needs the gun in hand, and Fast-Draw (Ammo) takes a second off. A parry needs a ready
 * weapon. The sheets show a clickable state icon per weapon row; /ready and /holster work from chat.
 *
 * Upstream hook point: GURPS.agency.readiness.beforeAttack() is called from attack() in module/gurps.js
 * before the shooting feature's fire dialog. The defense feature fires gurpsAgencyDefenseWeapons (parry
 * choices) and gurpsAgencyManeuverPicked (turn card); the firearms feature takes a reload gate.
 */
import { ChatProcessors } from '../../chat.js'
import { DEFENSE_WEAPONS_HOOK, MANEUVER_PICKED_HOOK } from '../defense/foundry-helpers.ts'
import { registerReloadGate } from '../firearms/reload.ts'
import { registerAgencySetting } from '../settings.ts'
import { beforeAttack, onCombatStart, onDefenseWeapons, onManeuverPicked, readyWeapon, reloadGate } from './actions.ts'
import { HolsterChatProcessor, ReadyChatProcessor } from './chat-command.ts'
import { onRenderActorSheet } from './sheet.ts'
import { L10N, SETTING_COMBAT_START, SETTING_ENABLED } from './state.ts'

function rerenderActorSheets(): void {
  for (const app of Object.values(ui.windows ?? {})) {
    const sheet = app as { actor?: unknown; render?: (force?: boolean) => unknown }
    if (sheet?.actor && typeof sheet.render === 'function') sheet.render(false)
  }
}

function registerSettings(): void {
  registerAgencySetting(SETTING_ENABLED, {
    name: `${L10N}.settings.enabled.name`,
    hint: `${L10N}.settings.enabled.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: rerenderActorSheets,
  })
  registerAgencySetting(SETTING_COMBAT_START, {
    name: `${L10N}.settings.combatStart.name`,
    hint: `${L10N}.settings.combatStart.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: {
      keep: `${L10N}.settings.combatStart.keep`,
      carry: `${L10N}.settings.combatStart.carry`,
    },
    default: 'keep',
  })
}

export function init(): void {
  registerSettings()

  const g = GURPS as any
  g.agency ??= {}
  g.agency.readiness = { beforeAttack, readyWeapon }

  registerReloadGate(reloadGate)
  Hooks.on('renderActorSheet' as any, onRenderActorSheet as any)
  Hooks.on(DEFENSE_WEAPONS_HOOK as any, onDefenseWeapons as any)
  Hooks.on(
    MANEUVER_PICKED_HOOK as any,
    ((data: any) => {
      void onManeuverPicked(data).catch(err => console.error('GURPS | Agency readiness: Ready pick failed', err))
    }) as any
  )
  Hooks.on(
    'combatStart' as any,
    ((combat: any) => {
      void onCombatStart(combat).catch(err => console.error('GURPS | Agency readiness: combat start failed', err))
    }) as any
  )

  ChatProcessors.registerProcessor(new ReadyChatProcessor())
  ChatProcessors.registerProcessor(new HolsterChatProcessor())
}

export function ready(): void {}
