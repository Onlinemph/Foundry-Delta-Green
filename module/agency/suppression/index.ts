/**
 * Agency feature: NPCs pinned by fire (GURPS Tactical Shooting p. 21). See rules.ts.
 *
 * - A ranged attack marks its targets as under fire; on a miss, tokens within a few yards of a target
 *   are marked too. Marks are kept on the combat (only the GM writes; players send a socket message).
 * - At the start of a marked NPC's turn the GM's client rolls Will-2 (Combat Reflexes or Unfazeable
 *   exempt). Failure sets the Pinned status for that turn and posts a card to the GM.
 * - Optional: PCs roll too, and are told the penalty for leaving cover.
 */
import { onSocket, emitSocket } from '../defense/socket.ts'
import { isIncapacitated } from '../defense/flow.ts'
import { measureYards, tokenCenter } from '../explosions/scene.ts'
import { flattenList, isRangedWeapon } from '../firearms/ammo.ts'
import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import { isExempt, leaveCoverPenalty, resolvePin, underFire, type Placed } from './rules.ts'

const L = 'GURPS.agency.suppression'
const FLAG = 'agency.underFire'
export const PINNED_STATUS = 'agency-pinned'

const i18n = (key: string, data?: Record<string, unknown>) =>
  data ? game.i18n!.format(`${L}.${key}`, data as any) : game.i18n!.localize(`${L}.${key}`)

export function init(): void {
  registerAgencySetting('suppression', {
    name: `${L}.settings.enabled.name`,
    hint: `${L}.settings.enabled.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })
  registerAgencySetting('suppression-radius', {
    name: `${L}.settings.radius.name`,
    hint: `${L}.settings.radius.hint`,
    scope: 'world',
    config: true,
    type: Number,
    default: 2,
  })
  registerAgencySetting('suppression-pcs', {
    name: `${L}.settings.pcs.name`,
    hint: `${L}.settings.pcs.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  })

  onSocket('suppressionMark', async (data: any) => {
    if (game.user?.isGM) await markUnderFire(data?.combatId, data?.tokenIds)
  })
  ;(Hooks as any).on('gurpsAgencyRollComplete', (ctx: any) => {
    void onRangedAttack(ctx).catch(err => console.error('GURPS | Agency | suppression: marking failed', err))
  })
  ;(Hooks as any).on('gurpsAgencyTurnStart', (data: any) => {
    void onTurnStart(data).catch(err => console.error('GURPS | Agency | suppression: turn start failed', err))
  })
  ;(Hooks as any).on('gurpsAgencyTurnEnd', (data: any) => {
    void setPinned(data?.actor, false).catch(err => console.error('GURPS | Agency | suppression: turn end failed', err))
  })
}

export function ready(): void {
  const list = (CONFIG as any).statusEffects as any[] | undefined
  if (list && !list.some(s => s.id === PINNED_STATUS))
    list.push({ id: PINNED_STATUS, name: `${L}.status`, img: 'icons/svg/terror.svg', order: 1995 })
}

const enabled = () => !!getAgencySetting<boolean>('suppression')

// ---------------------------------------------------------------------------------------------
// Marking

async function onRangedAttack(ctx: any): Promise<void> {
  if (!enabled() || !ctx?.isTargeted || !isRangedWeapon(ctx.optionalArgs?.obj)) return
  const combat = game.combat as any
  if (!combat?.started) return
  const shooterId: string | null = ctx.speaker?.token ?? null
  const targets: any[] = Array.from((game.user as any)?.targets ?? []).filter((t: any) => t.id !== shooterId)
  if (!targets.length) return

  const scene = canvas?.scene
  const place = (t: any): Placed => {
    const c = tokenCenter(t.document ?? t)
    return { id: t.id, x: c.x, y: c.y }
  }
  const others: Placed[] = Array.from((scene as any)?.tokens ?? [])
    .filter((d: any) => d.actor)
    .map((d: any) => place(d))
  const ids = underFire(targets.map(place), others, {
    missed: !!ctx.failure,
    radius: Number(getAgencySetting<number>('suppression-radius')) || 0,
    shooterId,
    yards: (a, b) => measureYards(a, b, scene),
  })
  if (!ids.length) return
  if (game.user?.isGM) await markUnderFire(combat.id, ids)
  else {
    const gm = (game.users as any)?.activeGM
    if (gm) emitSocket('suppressionMark', gm.id, { combatId: combat.id, tokenIds: ids })
  }
}

async function markUnderFire(combatId: string, tokenIds: string[]): Promise<void> {
  const combat = (game.combats as any)?.get(combatId)
  if (!combat || !Array.isArray(tokenIds) || !tokenIds.length) return
  const current: string[] = combat.getFlag('gurps', FLAG) ?? []
  const next = [...new Set([...current, ...tokenIds.map(String)])]
  if (next.length !== current.length) await combat.setFlag('gurps', FLAG, next)
}

// ---------------------------------------------------------------------------------------------
// The Will roll

async function setPinned(actor: any, active: boolean): Promise<void> {
  if (!actor || !game.user?.isGM) return
  const has = actor.statuses?.has?.(PINNED_STATUS)
  if (!!has === active) return
  await actor.toggleStatusEffect(PINNED_STATUS, { active })
}

async function onTurnStart(data: any): Promise<void> {
  const { combat, combatant, actor, token } = data ?? {}
  if (!game.user?.isGM || !combat || !actor) return
  await setPinned(actor, false)
  if (!enabled()) return

  const tokenId: string | undefined = token?.id ?? combatant?.tokenId
  const marked: string[] = combat.getFlag('gurps', FLAG) ?? []
  if (!tokenId || !marked.includes(tokenId)) return
  await combat.setFlag(
    'gurps',
    FLAG,
    marked.filter(id => id !== tokenId)
  )

  const npc = !actor.hasPlayerOwner
  if (!npc && !getAgencySetting<boolean>('suppression-pcs')) return
  if (isIncapacitated(actor.statuses ?? [])) return
  const traits = flattenList<any>(actor.system?.ads, '').map(e => String(e.value?.name ?? ''))
  if (isExempt(traits)) return

  const will = Number(actor.system?.attributes?.WILL?.value) || 10
  const roll = await (Roll as any).create('3d6').evaluate()
  const outcome = resolvePin(will, Number(roll.total))

  const result = outcome.success
    ? i18n('card.steady', { name: actor.name, margin: outcome.margin })
    : npc
      ? i18n('card.pinned', { name: actor.name, margin: -outcome.margin })
      : i18n('card.pcPinned', { name: actor.name, penalty: leaveCoverPenalty(outcome) })
  const content = `<div class="agency-chat-card agency-suppression-card">
    <header class="agency-panel-header">${i18n('card.title')}${
      outcome.success ? '' : ` <span class="agency-stamp">${i18n('card.stamp')}</span>`
    }</header>
    <p>${i18n('card.roll', { target: outcome.target, roll: outcome.roll })}</p>
    <p>${result}</p>
  </div>`
  const gmIds = (ChatMessage as any).getWhisperRecipients('GM').map((u: any) => u.id)
  const owners = npc
    ? []
    : (game.users as any).filter((u: any) => !u.isGM && actor.testUserPermission(u, 'OWNER')).map((u: any) => u.id)
  await (ChatMessage as any).create({
    speaker: (ChatMessage as any).getSpeaker({ actor }),
    content,
    rolls: [roll],
    whisper: [...new Set([...gmIds, ...owners])],
    sound: (CONFIG as any).sounds?.dice,
  })
  if (!outcome.success && npc) await setPinned(actor, true)
}
