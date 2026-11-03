/**
 * Agency feature: explosions, automated (docs/agency/explosions.md).
 *
 * - Attacking with a weapon whose damage explodes (thrown grenades, grenade launchers, rockets):
 *   pick a token or a spot, roll, scatter on a miss, the target may dodge a direct hit (attack.ts).
 * - The active GM's client sets it off: templates, every token in reach by grid distance, walls as
 *   cover, per-target dice, one summary card with Apply buttons, dive-for-cover prompts (detonate.ts,
 *   card.ts, prompts.ts).
 * - /explode for IEDs, set charges and special munitions (command.ts).
 * Rules are pure functions (parse.ts, rules.ts, resolve.ts, specials.ts), tested in test/agency/explosions-*.
 *
 * Upstream hook points: the ranged-attack hook upstream's attack() calls before the RoF prompt
 * (GURPS.agency.shooting.beforeRangedAttack) is chained at runtime so no upstream file changes;
 * 'gurpsAgencyRollComplete' for the result.
 */
import { isRangedWeapon } from '../firearms/ammo.ts'
import { ChatProcessors } from '../../chat.js'
import { AgencyHooks } from '../index.ts'
import { beforeExplosiveAttack, onRollComplete } from './attack.ts'
import { decorateBlastCard, getExplosionFlag, onBlastEventMessage } from './card.ts'
import { ExplodeChatProcessor } from './command.ts'
import { detonate } from './detonate.ts'
import { decoratePrompt, onIncomingResult } from './prompts.ts'
import { registerExplosionSettings } from './settings.ts'
import { listenSocket, onSocket } from './socket.ts'
import * as parse from './parse.ts'
import * as rules from './rules.ts'

/**
 * Put our targeting step in front of whatever handles 'before a ranged attack' (the shooting feature's
 * fire dialog). Upstream calls GURPS.agency.shooting.beforeRangedAttack(args) and cancels on false.
 */
function chainBeforeRangedAttack(): void {
  const g = GURPS as any
  g.agency ??= {}
  g.agency.shooting ??= {}
  const previous = g.agency.shooting.beforeRangedAttack
  if (previous?.agencyExplosions) return
  const chained = async (args: any) => {
    // Melee attacks (a stun baton, a rifle butt) are never thrown or fired as explosives.
    const ranged = isRangedWeapon(args?.att) && !(args?.action?.isMelee && !args?.action?.isRanged)
    if (!ranged) return typeof previous === 'function' ? previous(args) : undefined
    const ours = await beforeExplosiveAttack(args)
    if (ours === false) return false
    // An explosive with RoF 2+ (automatic grenade launchers) skips the shooting feature's per-shot
    // burst, which would post a defense card per hit on top of the explosion; upstream's RoF prompt applies.
    if (args?.opt?.agencyBoom && (parseInt(String(args.att?.rof ?? '1'), 10) || 1) > 1) return undefined
    return typeof previous === 'function' ? previous(args) : undefined
  }
  chained.agencyExplosions = true
  g.agency.shooting.beforeRangedAttack = chained
}

export function init(): void {
  registerExplosionSettings()

  const g = GURPS as any
  g.agency ??= {}
  g.agency.explosions = { detonate, parse: parse.parseExplosive, rules }

  Hooks.on(AgencyHooks.ROLL_COMPLETE as any, (ctx: any) => {
    onRollComplete(ctx).catch(err => console.error('GURPS | Agency | explosions: roll-complete failed', err))
  })

  Hooks.on('renderChatMessageHTML' as any, (message: any, html: HTMLElement) => {
    if (!(html instanceof HTMLElement)) return
    const flag = getExplosionFlag(message)
    if (!flag) return
    if (flag.kind === 'blast') decorateBlastCard(message, html, flag)
    else decoratePrompt(message, html)
  })

  ChatProcessors.registerProcessor(new ExplodeChatProcessor())
}

export function ready(): void {
  // After every feature's init(), so the shooting feature's hook is already in place.
  chainBeforeRangedAttack()

  listenSocket()
  // Messages are addressed to the active GM; with no GM online, toGM() runs these on the sender.
  onSocket('detonate', detonate)
  onSocket('blastEvent', onBlastEventMessage)
  onSocket('incoming', onIncomingResult)
}
