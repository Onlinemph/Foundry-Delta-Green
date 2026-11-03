/**
 * "Miss by 1 hits X": a called shot that fails by exactly 1 still hits, at the location the chart
 * names (spine, nose, jaw, ear, neck -> chest; neck vein -> neck; limb vein/joint -> a limb;
 * extremity joint -> an extremity). The hit goes through the defense feature's promptDefense(), so
 * the target still gets a defense and the damage step works as for any hit.
 */
import { localize } from '../defense/foundry-helpers.ts'
import { classifyAttack, parseHitLocation } from '../defense/rules.ts'
import { L } from './card.ts'
import { missByOneName } from './engine.ts'
import { locationLabel } from './foundry.ts'
import { hitLocationNames } from './picker.ts'
import { guhlEnabled } from './settings.ts'

/** Handler for 'gurpsAgencyRollComplete' on the attacker's client. */
export async function onRollComplete(data: any): Promise<void> {
  if (!guhlEnabled() || !data?.isTargeted || !data.failure) return
  if (data.optionalArgs?.agencyHandled) return
  const chat = data.chatdata ?? {}
  if (chat.isCritFailure) return
  const obj = data.optionalArgs?.obj
  const profile = classifyAttack(data.chatthing ?? '', obj)
  if (!profile || !(data.actor instanceof Actor)) return

  const aimName = parseHitLocation(chat.targetmods, localize('GURPS.modifierToHit'), hitLocationNames())
  const name = missByOneName(Number(chat.margin), true, !!chat.seventeen, aimName)
  if (!name) return

  const speaker = data.speaker ?? {}
  const targets = (Array.from((game.user as any)?.targets ?? []) as any[]).filter(
    token => token?.actor && token.id !== speaker.token
  )
  const defense = (GURPS as any).agency?.defense
  if (!targets.length || typeof defense?.promptDefense !== 'function') return

  ui.notifications?.info(localize(`${L}.info.missByOne`, { from: locationLabel(aimName!), to: locationLabel(name) }))
  const scene = speaker.scene ? (game.scenes as any)?.get(speaker.scene) : canvas?.scene
  await defense.promptDefense({
    attacker: data.actor,
    attackerToken: speaker.token ? scene?.tokens?.get(speaker.token) : null,
    targets,
    weapon: obj,
    isRanged: profile.kind === 'ranged',
    hits: 1,
    criticalHits: 0,
    hitLocation: name,
  })
}
