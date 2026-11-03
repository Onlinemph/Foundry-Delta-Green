/**
 * Cool Under Fire (GURPS Tactical Shooting p. 34): Fright Checks on the turn after traumatic events.
 * Rules in cuf-rules.ts. Events are collected on the combat (GM writes; players send a socket
 * message), then resolved at the start of the character's next turn:
 * - NPCs: the GM's client rolls; failure stuns them.
 * - PCs: their owners get a card with a Fright Check button that runs the SAN check (Fright Check
 *   failures cost SAN), with every automated modifier filled in.
 */
import { calculateRoFModifier } from '../../combat/utilities.ts'
import { isIncapacitated } from '../defense/flow.ts'
import { emitSocket, onSocket } from '../defense/socket.ts'
import { radii } from '../explosions/resolve.ts'
import { flattenList, isRangedWeapon } from '../firearms/ammo.ts'
import { frightTraitMods } from '../sanity/commands.ts'
import { sanityEnabled } from '../sanity/data.ts'
import { performSanCheck } from '../sanity/roll.ts'
import { parseSanLoss } from '../sanity/rules.ts'
import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import { severityRank } from '../wounds/severity.ts'
import {
  casualtyPenaltyFromHP,
  casualtyPenaltyFromSeverity,
  cufTraitMods,
  frightTarget,
  HEAT_OF_BATTLE,
  isNearMiss,
  isSilenced,
  mergePending,
  worstTrigger,
  type CufMod,
  type Pending,
  type Trigger,
} from './cuf-rules.ts'

const L = 'GURPS.agency.suppression.cuf'
const FLAG = 'agency.coolUnderFire'
const BURST_HOOK = 'gurpsAgencyBurstResolved'
const WOUNDED_HOOK = 'gurpsAgencyWounded'

const i18n = (key: string, data?: Record<string, unknown>) =>
  data ? game.i18n!.format(`${L}.${key}`, data as any) : game.i18n!.localize(`${L}.${key}`)

const SAN_DEFAULTS: Record<Trigger, string> = { nearMiss: '0/1', blast: '0/1d4', wounded: '0/1d4', allyDown: '1/1d4' }

export function initCoolUnderFire(): void {
  for (const [key, def] of [
    ['cool-under-fire', true],
    ['cuf-npcs', true],
    ['cuf-pcs', true],
  ] as const)
    registerAgencySetting(key, {
      name: `${L}.settings.${key}.name`,
      hint: `${L}.settings.${key}.hint`,
      scope: 'world',
      config: true,
      type: Boolean,
      default: def,
    })
  for (const trigger of Object.keys(SAN_DEFAULTS) as Trigger[])
    registerAgencySetting(`cuf-san-${trigger}`, {
      name: `${L}.settings.san.${trigger}`,
      hint: `${L}.settings.san.hint`,
      scope: 'world',
      config: true,
      type: String,
      default: SAN_DEFAULTS[trigger],
    })

  onSocket('cufMark', async (data: any) => {
    if (isActiveGM()) await mark(data?.combatId, data?.tokenIds, data?.pending)
  })
  ;(Hooks as any).on('gurpsAgencyRollComplete', (ctx: any) => run('near miss', () => onAttack(ctx)))
  ;(Hooks as any).on(BURST_HOOK, (data: any) => run('burst', () => onBurst(data)))
  ;(Hooks as any).on(WOUNDED_HOOK, (data: any) =>
    run('wounded', () => onWounded(data?.actor, casualtyPenaltyFromSeverity(worstSeverity(data?.severities))))
  )
  Hooks.on('preUpdateActor' as any, (actor: any, changes: any, _options: any, userId: string) =>
    run('hp', () => onHPChange(actor, changes, userId))
  )
  Hooks.on('createChatMessage' as any, (message: any) => run('blast', () => onBlast(message)))
  Hooks.on('createActiveEffect' as any, (effect: any) => run('ally down', () => onStatus(effect)))
  ;(Hooks as any).on('gurpsAgencyTurnStart', (data: any) => run('turn start', () => onTurnStart(data)))
  Hooks.on('renderChatMessageHTML' as any, (message: any, html: HTMLElement) => decorateCard(message, html))
}

function run(what: string, task: () => Promise<void> | void): void {
  Promise.resolve()
    .then(task)
    .catch(err => console.error(`GURPS | Agency | Cool Under Fire (${what}) failed`, err))
}

const enabled = () => !!getAgencySetting<boolean>('cool-under-fire')
const isActiveGM = () => !!game.user?.isGM && ((game.users as any)?.activeGM?.id ?? game.user.id) === game.user.id
const startedCombat = () => {
  const combat = game.combat as any
  return combat?.started ? combat : null
}
const heat = (): CufMod => ({ key: 'heat', mod: HEAT_OF_BATTLE })

function worstSeverity(severities: unknown): string | null {
  const list = (Array.isArray(severities) ? severities : []).filter(Boolean) as any[]
  return list.reduce(
    (worst: any, s: any) => (worst === null || severityRank(s) > severityRank(worst) ? s : worst),
    null
  )
}

// ---------------------------------------------------------------------------------------------
// Collecting events

async function send(tokenIds: string[], pending: Pending): Promise<void> {
  const combat = startedCombat()
  if (!enabled() || !combat || !tokenIds.length) return
  if (isActiveGM()) return mark(combat.id, tokenIds, pending)
  const gm = (game.users as any)?.activeGM
  if (gm) emitSocket('cufMark', gm.id, { combatId: combat.id, tokenIds, pending })
}

async function mark(combatId: string, tokenIds: string[], pending: Pending): Promise<void> {
  const combat = (game.combats as any)?.get(combatId)
  if (!combat || !Array.isArray(tokenIds) || !pending?.triggers) return
  const all: Record<string, Pending> = foundry.utils.deepClone(combat.getFlag('gurps', FLAG) ?? {})
  for (const id of tokenIds) all[id] = mergePending(all[id], pending)
  await combat.setFlag('gurps', FLAG, all)
}

function attackMods(weapon: any, shots: number, targetDoc: any): CufMod[] {
  const mods: CufMod[] = [heat()]
  const covered = !!(GURPS as any).agency?.hitloc?.coveredLocations?.(targetDoc?.actor, targetDoc)
  const bonus = shots > 1 ? calculateRoFModifier(shots) : 0
  // Safely behind cover: no penalty for the volume of fire.
  if (bonus > 0 && !covered) mods.push({ key: 'rof', mod: -bonus })
  mods.push({ key: 'silenced', mod: isSilenced(`${weapon?.name ?? ''} ${weapon?.notes ?? ''}`) ? 1 : 0 })
  return mods
}

function targetDocs(shooterTokenId: string | null): any[] {
  return Array.from((game.user as any)?.targets ?? [])
    .filter((t: any) => t.id !== shooterTokenId && t.actor)
    .map((t: any) => t.document ?? t)
}

async function onAttack(ctx: any): Promise<void> {
  if (!enabled() || !startedCombat() || !ctx?.isTargeted || ctx.optionalArgs?.agencyShooting?.burst) return
  const chat = ctx.chatdata ?? {}
  if (!isNearMiss(Number(chat.margin), !!ctx.failure, !!chat.isCritFailure)) return
  const weapon = ctx.optionalArgs?.obj
  const shots = isRangedWeapon(weapon) ? Number(ctx.optionalArgs?.shots) || 1 : 1
  for (const doc of targetDocs(ctx.speaker?.token ?? null))
    await send([doc.id], { triggers: ['nearMiss'], mods: attackMods(weapon, shots, doc) })
}

/** Progressive Recoil bursts (module/agency/shooting): any shot that missed by 1 or 2. */
async function onBurst(data: any): Promise<void> {
  if (!enabled() || !startedCombat()) return
  const near = (data?.shots ?? []).some((s: any) =>
    isNearMiss(Number(s.margin), s.outcome !== 'hit' && s.outcome !== 'critical', s.outcome === 'fumble')
  )
  if (!near) return
  const scene = canvas?.scene as any
  for (const id of (data?.targetIds ?? []) as string[]) {
    const doc = scene?.tokens?.get(id)
    if (doc?.actor)
      await send([id], { triggers: ['nearMiss'], mods: attackMods(data?.weapon, Number(data?.shotsFired) || 1, doc) })
  }
}

async function onWounded(actor: any, casualty: number): Promise<void> {
  if (!enabled() || !actor) return
  const ids = (actor.getActiveTokens?.(false, true) ?? []).map((d: any) => d.id)
  const mods: CufMod[] = [heat()]
  if (casualty) mods.push({ key: 'casualty', mod: casualty })
  await send(ids, { triggers: ['wounded'], mods })
}

/** Standard damage model: HP loss is a wound. (Under the house wound rules the wound hook covers it.) */
async function onHPChange(actor: any, changes: any, userId: string): Promise<void> {
  if (userId !== game.user?.id) return
  if (getAgencySetting<string>('damage-model') === 'rfh') return
  const next = foundry.utils.getProperty(changes, 'system.HP.value')
  const current = Number(actor?.system?.HP?.value)
  if (typeof next !== 'number' || !(next < current)) return
  await onWounded(actor, casualtyPenaltyFromHP(next, Number(actor.system?.HP?.max) || 10))
}

async function onBlast(message: any): Promise<void> {
  if (!enabled() || !isActiveGM()) return
  const flag = message?.flags?.gurps?.agency?.explosion
  if (flag?.kind !== 'blast' || !flag.state?.setup) return
  const radius = radii(flag.state.setup).blast
  const ids: string[] = (flag.state.rows ?? [])
    .filter((row: any) => Number(row.facts?.distance) <= radius + 1e-9)
    .map((row: any) => String(row.facts.id))
  await send(ids, { triggers: ['blast'], mods: [heat()] })
}

/** Someone just went unconscious or died: every ally who can see them checks. */
async function onStatus(effect: any): Promise<void> {
  if (!enabled() || !isActiveGM()) return
  const statuses: Set<string> = effect?.statuses ?? new Set()
  if (!statuses.has('unconscious') && !statuses.has('dead')) return
  const victim = effect.parent
  if (!(victim instanceof Actor)) return
  const scene = canvas?.scene as any
  const victimDocs: any[] = (victim.getActiveTokens?.(false, true) ?? []).filter((d: any) => d.parent === scene)
  if (!victimDocs.length) return

  const casualty = Math.min(-1, victimCasualty(victim))
  const allies = new Set<string>()
  for (const v of victimDocs)
    for (const doc of Array.from(scene?.tokens ?? []) as any[]) {
      if (!doc.actor || doc.id === v.id || doc.disposition !== v.disposition) continue
      if (isIncapacitated(doc.actor.statuses ?? [])) continue
      if (canSee(doc, v)) allies.add(doc.id)
    }
  await send([...allies], { triggers: ['allyDown'], mods: [heat(), { key: 'casualty', mod: casualty }] })
}

function victimCasualty(actor: any): number {
  const wounds: any[] = actor.getFlag?.('gurps', 'agency.wounds')?.wounds ?? []
  const fromWounds = casualtyPenaltyFromSeverity(worstSeverity(wounds.map(w => w?.severity)))
  const fromHP = casualtyPenaltyFromHP(Number(actor.system?.HP?.value), Number(actor.system?.HP?.max) || 10)
  return Math.min(fromWounds, fromHP)
}

function canSee(fromDoc: any, toDoc: any): boolean {
  try {
    const center = (d: any) => d.object?.center ?? { x: d.x, y: d.y }
    const backend = (CONFIG as any).Canvas?.polygonBackends?.sight
    if (!backend?.testCollision) return true
    return !backend.testCollision(center(fromDoc), center(toDoc), { type: 'sight', mode: 'any' })
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------------------------
// Resolving at turn start

function modLabel(m: CufMod): string {
  return i18n(`mod.${m.key}`)
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`
}

function traitNames(actor: any): string[] {
  return flattenList<any>(actor?.system?.ads, '').map(e => String(e.value?.name ?? ''))
}

function soldierWillBased(actor: any): number | null {
  const soldier = flattenList<any>(actor?.system?.skills, '').find(e => /^soldier\b/i.test(String(e.value?.name ?? '')))
  const level = Number(soldier?.value?.level)
  if (!Number.isFinite(level) || level <= 0) return null
  const iq = Number(actor.system?.attributes?.IQ?.value) || 10
  const will = Number(actor.system?.attributes?.WILL?.value) || 10
  return level - iq + will
}

async function onTurnStart(data: any): Promise<void> {
  const { combat, combatant, actor, token } = data ?? {}
  if (!isActiveGM() || !combat || !actor) return
  const tokenId: string | undefined = token?.id ?? combatant?.tokenId
  const all: Record<string, Pending> = combat.getFlag('gurps', FLAG) ?? {}
  const pending = tokenId ? all[tokenId] : undefined
  if (!tokenId || !pending) return
  const rest = foundry.utils.deepClone(all)
  delete rest[tokenId]
  await combat.unsetFlag('gurps', FLAG)
  if (Object.keys(rest).length) await combat.setFlag('gurps', FLAG, rest)

  if (!enabled() || isIncapacitated(actor.statuses ?? [])) return
  const npc = !actor.hasPlayerOwner
  if (npc ? !getAgencySetting<boolean>('cuf-npcs') : !getAgencySetting<boolean>('cuf-pcs')) return

  const mods = [
    ...pending.mods.filter(m => m.mod !== 0).map(m => ({ mod: m.mod, desc: modLabel(m) })),
    ...cufTraitMods(traitNames(actor)).map(m => ({ mod: m.mod, desc: m.label })),
  ]
  const trigger = worstTrigger(pending.triggers) ?? 'nearMiss'
  const reasons = pending.triggers.map(t => i18n(`trigger.${t}`)).join(', ')
  if (npc) await rollForNpc(actor, mods, reasons)
  else await postPcCard(actor, mods, reasons, trigger)
}

async function rollForNpc(actor: any, mods: { mod: number; desc: string }[], reasons: string): Promise<void> {
  const all = [...frightTraitMods(actor), ...mods]
  const base = parseInt(actor.system?.frightcheck || actor.system?.attributes?.WILL?.value, 10) || 10
  const target = frightTarget(
    base,
    soldierWillBased(actor),
    all.map(m => m.mod)
  )
  const roll = await (Roll as any).create('3d6').evaluate()
  const total = Number(roll.total)
  const success = total <= 4 || (total < 17 && total <= target)
  const content = await card(actor.name, reasons, all, target, total, success, null)
  await (ChatMessage as any).create({
    speaker: (ChatMessage as any).getSpeaker({ actor }),
    content,
    rolls: [roll],
    whisper: (ChatMessage as any).getWhisperRecipients('GM').map((u: any) => u.id),
    sound: (CONFIG as any).sounds?.dice,
  })
  if (!success) await actor.toggleStatusEffect('stun', { active: true })
}

async function postPcCard(
  actor: any,
  mods: { mod: number; desc: string }[],
  reasons: string,
  trigger: Trigger
): Promise<void> {
  const loss = String(getAgencySetting<string>(`cuf-san-${trigger}`) ?? SAN_DEFAULTS[trigger])
  const owners = (game.users as any).filter((u: any) => actor.testUserPermission(u, 'OWNER')).map((u: any) => u.id)
  await (ChatMessage as any).create({
    speaker: (ChatMessage as any).getSpeaker({ actor }),
    content: await card(actor.name, reasons, mods, null, null, null, loss),
    whisper: owners,
    flags: { gurps: { agency: { coolUnderFire: { actorUuid: actor.uuid, mods, loss, reasons } } } },
  })
}

async function card(
  name: string,
  reasons: string,
  mods: { mod: number; desc: string }[],
  target: number | null,
  roll: number | null,
  success: boolean | null,
  loss: string | null,
  npc = true
): Promise<string> {
  const rows = mods.map(m => `<li>${signed(m.mod)} ${foundry.utils.escapeHTML(m.desc)}</li>`).join('')
  const result =
    success === null
      ? ''
      : `<p>${i18n('card.roll', { target: target ?? 0, roll: roll ?? 0 })} ${
          success ? i18n('card.steady', { name }) : i18n(npc ? 'card.npcStunned' : 'card.pcFailed', { name })
        }</p>`
  const button =
    loss === null
      ? ''
      : `<p>${i18n('card.pcPrompt', { loss })}</p><button type="button" class="agency-btn" data-agency-cuf="roll"><i class="fa-solid fa-dice"></i> ${i18n('card.button')}</button>`
  return `<div class="agency-chat-card agency-cuf-card">
    <header class="agency-panel-header">${i18n('card.title')}${
      success === false ? ` <span class="agency-stamp">${i18n('card.stamp')}</span>` : ''
    }</header>
    <p>${i18n('card.why', { name, reasons })}</p>
    <ul class="agency-cuf-mods">${rows}</ul>
    <p class="hint">${i18n('card.gmMods')}</p>
    ${result}${button}
  </div>`
}

function decorateCard(message: any, html: HTMLElement): void {
  const data = message?.flags?.gurps?.agency?.coolUnderFire
  const button = html?.querySelector<HTMLButtonElement>('[data-agency-cuf="roll"]')
  if (!data || !button) return
  button.addEventListener('click', async event => {
    event.preventDefault()
    button.disabled = true
    const actor: any = await fromUuid(data.actorUuid)
    if (!actor?.isOwner) return void ui.notifications?.warn(i18n('warn.notOwner'))
    const traitMods = frightTraitMods(actor)
    const loss = parseSanLoss(String(data.loss))
    if (sanityEnabled() && loss) {
      await performSanCheck(actor, {
        loss,
        category: 'violence',
        source: data.reasons,
        frightMods: [...traitMods, ...(data.mods ?? [])],
      })
      return
    }
    // SAN off: a plain Fright Check with the same modifiers.
    const all = [...traitMods, ...(data.mods ?? [])]
    const base = parseInt(actor.system?.frightcheck || actor.system?.attributes?.WILL?.value, 10) || 10
    const target = frightTarget(
      base,
      soldierWillBased(actor),
      all.map((m: any) => Number(m.mod) || 0)
    )
    const roll = await (Roll as any).create('3d6').evaluate()
    const total = Number(roll.total)
    const success = total <= 4 || (total < 17 && total <= target)
    await (ChatMessage as any).create({
      speaker: (ChatMessage as any).getSpeaker({ actor }),
      content: await card(actor.name, data.reasons, all, target, total, success, null, false),
      rolls: [roll],
      sound: (CONFIG as any).sounds?.dice,
    })
  })
}
