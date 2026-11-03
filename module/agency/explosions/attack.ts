/**
 * Explosive ranged attacks (thrown grenades, grenade launchers, rockets...).
 *
 * Before the roll (chained onto the ranged-attack hook upstream's attack() calls, see index.ts):
 *   - one targeted token: throw it at the token (they may dodge), at the ground under it, or at a
 *     clicked spot; no target: click a spot. Attacking an area is +4 (B414) plus the range modifier to
 *     the spot (unless one is already in the modifier bucket).
 * After the roll ('gurpsAgencyRollComplete'):
 *   - area attack: a hit goes off on the spot; a miss scatters (B414).
 *   - token: a critical hit strikes (no defense, B556); a hit asks the target to dodge (prompts.ts);
 *     a miss scatters from the target.
 */
import { tokenRef } from '../defense/foundry-helpers.ts'
import { facing, explosiveTextFor, defaultExplodeOptions, type Point } from './command-parse.ts'
import { rollD6 } from './dice.ts'
import { localize } from './i18n.ts'
import { isExplosiveSpec, parseExplosive } from './parse.ts'
import { radii } from './resolve.ts'
import { AREA_ATTACK_BONUS, rangePenalty, scatter } from './rules.ts'
import { explosionsEnabled, scatterEnabled } from './settings.ts'
import { foundryRng, measureYards, pickPoint, scatterPoint, tokenCenter } from './scene.ts'
import { matchSpecials, summarizeSpecials } from './specials.ts'
import type { BlastRequest } from './types.ts'
import { newBlastId, requestDetonation } from './detonate.ts'
import { postIncoming } from './prompts.ts'

/** Attached to optionalArgs so the roll-complete hook knows what was planned. */
export interface ExplosiveMark {
  mode: 'token' | 'area'
  sceneId: string
  point: Point
  targetTokenId: string | null
  attackerTokenId: string | null
  label: string
  damage: string
  weaponName: string
  notes: string
}

type AttackArgs = { actor: any; action: any; att: any; opt: any; targetmods: any[]; event?: any }

function weaponLabel(att: any): string {
  const name = String(att?.name ?? '')
  return att?.mode ? `${name} (${att.mode})` : name
}

/** The explosive text of a weapon, or null when it doesn't explode. */
export function explosiveText(att: any): string | null {
  const text = explosiveTextFor(att?.damage, att?.notes)
  const spec = parseExplosive(text)
  if (isExplosiveSpec(spec)) return text
  // A special munition with no damage string we understand ("Special", "Smoke"): go by the name.
  const special = matchSpecials({ name: att?.name, damage: text, notes: att?.notes, spec })
  if (special.smoke) return `Smoke (${special.smoke.radius} yd.)`
  if (special.affliction) return `HT${special.affliction.htModifier} aff (${special.affliction.radius} yd.)`
  return null
}

function attackerToken(actor: any): any {
  const tokens: any[] = actor?.getActiveTokens?.(true) ?? []
  const controlled = tokens.find(t => t.controlled)
  return (controlled ?? tokens[0])?.document ?? null
}

type Choice = 'token' | 'ground' | 'spot'

async function chooseTarget(weapon: string, targetName: string): Promise<Choice | null> {
  const result = await (foundry.applications.api.DialogV2 as any).wait({
    window: { title: localize('attack.title', { weapon }), icon: 'fa-solid fa-bomb' },
    classes: ['agency-boom-dialog'],
    content: `<p>${localize('attack.question', { name: targetName })}</p>`,
    rejectClose: false,
    buttons: [
      {
        action: 'token',
        label: localize('attack.atToken', { name: targetName }),
        icon: 'fa-solid fa-user',
        default: true,
      },
      { action: 'ground', label: localize('attack.atGround'), icon: 'fa-solid fa-crosshairs' },
      { action: 'spot', label: localize('attack.atSpot'), icon: 'fa-solid fa-location-dot' },
    ],
  })
  return result === 'token' || result === 'ground' || result === 'spot' ? result : null
}

/** Upstream's range modifiers all mention range: "for range" (ruler), "for range/speed N yds", "Close range"... */
function hasRangeModifier(targetmods: any[]): boolean {
  const bucket: any[] = (GURPS.ModifierBucket as any)?.modifierStack?.modifierList ?? []
  return [...bucket, ...targetmods].some(m => /\brange\b/i.test(String(m?.desc ?? '')))
}

/** Range penalty to the spot, as upstream's ruler would give it (its range strategy), else B550. */
function rangeModifierTo(yards: number): number {
  const ranges: any[] = (GURPS as any).rangeObject?.ranges ?? []
  for (const band of ranges) if (band.max === Infinity || yards <= band.max) return Number(band.penalty) || 0
  return rangePenalty(yards)
}

/**
 * Returns false to cancel the attack, undefined to carry on. Marks optionalArgs so the defense feature
 * leaves the attack to us (agencyHandled) and our roll-complete handler picks it up.
 */
export async function beforeExplosiveAttack(args: AttackArgs): Promise<false | undefined> {
  if (!explosionsEnabled() || !args.actor || !args.att || !canvas?.scene) return undefined
  const text = explosiveText(args.att)
  if (!text) return undefined

  const spec = parseExplosive(text)
  const reach = spec
    ? radii({
        spec,
        specials: summarizeSpecials(matchSpecials({ name: args.att.name, damage: text, notes: args.att.notes, spec })),
      })
    : null
  const label = weaponLabel(args.att)
  const attackerDoc = attackerToken(args.actor)
  const targets: any[] = Array.from((game.user as any)?.targets ?? []).filter(
    (t: any) => t?.document?.id !== attackerDoc?.id
  )

  let choice: Choice = 'spot'
  if (targets.length === 1) {
    const picked = await chooseTarget(label, targets[0].name)
    if (!picked) return false
    choice = picked
  } else if (targets.length > 1) ui.notifications?.info(localize('attack.manyTargets'))

  let point: Point
  if (choice === 'spot') {
    const picked = await pickPoint({
      radii: [reach?.blast ?? 0, reach?.fragments ?? 0, reach?.affliction ?? 0, reach?.smoke ?? 0],
      hint: localize('attack.pickHint', { weapon: label }),
    })
    if (!picked) return false
    point = picked
  } else point = tokenCenter(targets[0])

  const area = choice !== 'token'
  const add = (mod: number, desc: string) => (GURPS.ModifierBucket as any).addModifier(mod, desc, args.targetmods)
  if (area) {
    add(AREA_ATTACK_BONUS, localize('attack.areaMod'))
    if (attackerDoc && !hasRangeModifier(args.targetmods)) {
      const yards = measureYards(tokenCenter(attackerDoc), point)
      const mod = rangeModifierTo(yards)
      if (mod) add(mod, localize('attack.rangeMod', { yards }))
    }
  }

  args.opt.agencyBoom = {
    mode: area ? 'area' : 'token',
    sceneId: canvas.scene.id!,
    point,
    targetTokenId: area ? null : targets[0].document.id,
    attackerTokenId: attackerDoc?.id ?? null,
    label,
    damage: text,
    weaponName: String(args.att.name ?? ''),
    notes: String(args.att.notes ?? ''),
  } satisfies ExplosiveMark
  // The defense feature leaves explosive attacks to us.
  args.opt.agencyHandled = true
  return undefined
}

function baseRequest(ctx: any, mark: ExplosiveMark, center: Point): BlastRequest {
  const scene = (game.scenes as any)?.get(mark.sceneId)
  const attackerDoc = mark.attackerTokenId ? scene?.tokens?.get(mark.attackerTokenId) : null
  return {
    id: newBlastId(),
    sceneId: mark.sceneId,
    center,
    label: mark.label,
    damage: mark.damage,
    weaponName: mark.weaponName,
    notes: mark.notes,
    attacker: tokenRef(attackerDoc, ctx.actor),
    struckTokenId: null,
    options: defaultExplodeOptions(),
    scatter: null,
    contactTokenId: null,
    internalTokenId: null,
    userId: game.user!.id,
  }
}

/** Handler for 'gurpsAgencyRollComplete' on the attacker's client. */
export async function onRollComplete(ctx: any): Promise<void> {
  const mark = ctx?.optionalArgs?.agencyBoom as ExplosiveMark | undefined
  if (!mark || !ctx.isTargeted) return
  delete ctx.optionalArgs.agencyBoom
  const chat = ctx.chatdata ?? {}
  const scene = (game.scenes as any)?.get(mark.sceneId)
  const attackerDoc = mark.attackerTokenId ? scene?.tokens?.get(mark.attackerTokenId) : null
  const attackerAt = attackerDoc ? tokenCenter(attackerDoc) : null
  const targetDoc = mark.targetTokenId ? scene?.tokens?.get(mark.targetTokenId) : null
  const aim = targetDoc ? tokenCenter(targetDoc) : mark.point

  // Rapid fire (B373): further hits are noted on the GM's card; set them off with /explode.
  const hits = Number(chat.rofrcl) || 1
  const extraHits = !ctx.failure && hits > 1 ? hits - 1 : 0

  if (!ctx.failure) {
    if (mark.mode === 'area' || !targetDoc) return requestDetonation({ ...baseRequest(ctx, mark, aim), extraHits })
    const request = { ...baseRequest(ctx, mark, aim), struckTokenId: targetDoc.id, extraHits }
    // A critical hit can't be defended (B556): it strikes.
    if (chat.isCritSuccess) return requestDetonation(request)
    return postIncoming(request, tokenRef(targetDoc, targetDoc.actor), attackerAt)
  }

  // A miss lands somewhere else (B414 Scatter).
  if (!scatterEnabled()) {
    const point = await pickPoint({ radii: [], hint: localize('attack.pickLanding', { weapon: mark.label }) })
    if (point) await requestDetonation(baseRequest(ctx, mark, point))
    return
  }
  const marginOfFailure = Math.abs(Math.min(0, Number(chat.margin) || 0))
  const s = scatter({
    marginOfFailure,
    distanceToTarget: attackerAt ? measureYards(attackerAt, aim) : marginOfFailure * 2,
    directionRoll: rollD6(foundryRng()),
  })
  const center = s.yards > 0 ? scatterPoint(aim, attackerAt ? facing(attackerAt, aim) : 0, s.degrees, s.yards) : aim
  await requestDetonation({
    ...baseRequest(ctx, mark, center),
    scatter: { yards: s.yards, direction: s.direction, from: aim, dodged: false },
  })
}
