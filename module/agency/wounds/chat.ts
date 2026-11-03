/**
 * Chat cards: one per wound event (or fatigue event), listing what happened and a Roll button for each
 * HT check it calls for. Anyone may click a button; the dice are rolled on their client, and the result is
 * applied by a client allowed to update the actor and the card (the GM's, via the socket, if need be).
 */
import {
  checkTarget,
  resolveCheck,
  resolveFatigueCheck,
  resolveRoll,
  sumModifiers,
  type CheckSpec,
  type Effect,
  type FatigueCheckSpec,
  type FatigueThreshold,
  type InjuryTolerance,
  type Modifier,
  type RollOutcome,
  type Severity,
  type WoundsState,
} from './engine.ts'
import { actorTraits, format, htOf, localize, readState, signed, worldTime, writeState } from './config.ts'
import { applyEffectStatuses, applyShock, shockPending, syncDerived, syncPain } from './effects.ts'
import { registerSocketHandler, runWith } from './socket.ts'
import { Foundry } from '../../utilities/foundry-compat.ts'

const K = 'GURPS.agency.wounds'
const CARD_FLAG = 'agency.woundsCard'
const CARD_TEMPLATE = 'systems/gurps/templates/agency/wounds-card.hbs'

export type CardCheck =
  | (CheckSpec & { source: 'wound' })
  | { source: 'fatigue'; id: string; kind: 'fatigue'; threshold: FatigueThreshold; spec: FatigueCheckSpec }
  | { source: 'act'; id: string; kind: 'act'; modifiers: Modifier[] }

export interface CardResult {
  checkId: string
  total: number
  target: number
  success: boolean
  text: string
  roller: string
}

export interface CardEntry {
  severity: Severity | null
  text: string
  details: string[]
}

export interface CardData {
  actorUuid: string
  actorName: string
  title: string
  entries: CardEntry[]
  lines: string[]
  checks: CardCheck[]
  results: CardResult[]
  whisper: string[] | null
  /** Injury Tolerance chosen in the damage dialog, if it differs from the actor's traits. */
  injuryTolerance: InjuryTolerance | null
}

export function escapeHTML(text: unknown): string {
  return String(text ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

export function checkLabel(check: CardCheck): string {
  switch (check.kind) {
    case 'stun':
      return localize(check.knockdown ? `${K}.check.knockdown` : `${K}.check.stun`)
    case 'limbMajor':
    case 'limbCritical':
      return format(`${K}.check.${check.kind}`, { limb: check.limbKey ?? check.location })
    case 'fatigue':
      return format(`${K}.check.fatigue`, { multiple: check.threshold.multiple })
    default:
      return localize(`${K}.check.${check.kind}`)
  }
}

function modifiersOf(check: CardCheck): Modifier[] {
  if (check.source === 'fatigue') return check.spec.modifiers
  return check.modifiers
}

export function targetFor(check: CardCheck, ht: number): number {
  if (check.source === 'wound') return checkTarget(check, ht)
  return ht + sumModifiers(modifiersOf(check))
}

export function targetText(check: CardCheck, ht: number): string {
  const parts = [`${localize('GURPS.attributesHT')} ${ht}`]
  for (const m of modifiersOf(check)) parts.push(`${signed(m.value)} ${localize(m.label)}`)
  let text = `${parts.join(' ')} = ${targetFor(check, ht)}`
  const extra: Modifier[] = []
  if (check.source === 'wound') extra.push(...check.unconsciousBonus)
  if (check.source === 'fatigue') extra.push(...check.spec.unconsciousBonus, ...check.spec.deathBonus)
  if (extra.length) text += ` (${extra.map(m => `${signed(m.value)} ${localize(m.label)}`).join(', ')})`
  return text
}

async function renderCard(card: CardData, ht: number): Promise<string> {
  const results = new Map(card.results.map(r => [r.checkId, r]))
  const worst = card.entries
    .map(e => e.severity)
    .filter((s): s is Severity => !!s)
    .sort((a, b) => SEVERITY_ORDER.indexOf(b) - SEVERITY_ORDER.indexOf(a))[0]
  const view = {
    actorName: card.actorName,
    title: card.title,
    worst: worst ? { key: worst, label: localize(`${K}.severity.${worst}`) } : null,
    entries: card.entries.map(e => ({
      ...e,
      severityLabel: e.severity ? localize(`${K}.severity.${e.severity}`) : '',
    })),
    lines: card.lines,
    rollLabel: localize(`${K}.card.roll`),
    checks: card.checks.map(check => {
      const result = results.get(check.id)
      return {
        id: check.id,
        label: checkLabel(check),
        targetText: targetText(check, ht),
        resolved: !!result,
        success: !!result?.success,
        resultText: result
          ? `${format(`${K}.card.rolled`, { total: result.total, target: result.target })}: ${result.text}`
          : '',
      }
    }),
  }
  return foundry.applications.handlebars.renderTemplate(CARD_TEMPLATE, view)
}

const SEVERITY_ORDER: Severity[] = [
  'scratch',
  'minor',
  'moderate',
  'major',
  'critical',
  'massive',
  'gawdawful',
  'destroyed',
]

/** Owners and GMs; null means public. */
export function ownerWhisper(actor: any): string[] {
  const users = ((game as any).users?.contents ?? []) as any[]
  return users.filter(u => u.isGM || actor?.testUserPermission?.(u, 'OWNER')).map(u => u.id)
}

export async function postCard(actor: any, card: CardData): Promise<void> {
  const content = await renderCard(card, htOf(actor))
  const data: Record<string, unknown> = {
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: { gurps: { agency: { woundsCard: card } } },
  }
  if (card.whisper) data.whisper = card.whisper
  await ChatMessage.create(data as any)
}

/** A short chat message carrying the dice, so Dice So Nice and the roll sound fire as for any roll. */
export async function postRollMessage(
  actor: any,
  roll: any,
  label: string,
  detail: string,
  outcome: RollOutcome,
  whisper: string[] | null
): Promise<void> {
  const verdict = outcome.success
    ? format(outcome.critSuccess ? `${K}.card.critSuccess` : `${K}.card.success`, { margin: outcome.margin })
    : format(outcome.critFailure ? `${K}.card.critFailure` : `${K}.card.failure`, { margin: -outcome.margin })
  const content = `<div class="agency-chat-card agency-wounds-roll">
  <div><strong>${escapeHTML(actor?.name)}</strong>: ${escapeHTML(label)}</div>
  <div class="agency-wounds-target">${escapeHTML(detail)}</div>
  <div class="agency-wounds-result ${outcome.success ? 'success' : 'failure'}">${escapeHTML(
    format(`${K}.card.rolled`, { total: outcome.total, target: outcome.target })
  )}: ${escapeHTML(verdict)}</div>
</div>`
  await createRollMessage(actor, [roll], content, whisper)
}

/**
 * Post rolls. A whispered card keeps its rolls whispered to the same people; otherwise the user's
 * roll mode applies, as for upstream rolls (module/dierolls/dieroll.js).
 */
export async function createRollMessage(
  actor: any,
  rolls: any[],
  content: string,
  whisper: string[] | null
): Promise<void> {
  const data: Record<string, unknown> = {
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    rolls,
    sound: (CONFIG as any).sounds?.dice,
  }
  let options: Record<string, unknown> = {}
  if (whisper) data.whisper = whisper
  else {
    try {
      const mode = Foundry.getMessageMode()
      options = Foundry.applyMessageMode({}, mode)
      ;(ChatMessage as any).applyRollMode?.(data, mode.value)
    } catch {
      // Public roll.
    }
  }
  await ChatMessage.create(data as any, options as any)
}

export async function roll3d6(): Promise<any> {
  const roll = new Roll('3d6')
  await roll.evaluate()
  return roll
}

/* ------------------------------------------------------------------ */
/* Clicking a check                                                   */
/* ------------------------------------------------------------------ */

function cardOf(message: any): CardData | null {
  const card = message?.getFlag?.('gurps', CARD_FLAG)
  return card && Array.isArray(card.checks) ? (card as CardData) : null
}

const inFlight = new Set<string>()

async function onCheckClick(message: any, checkId: string, button: HTMLButtonElement): Promise<void> {
  const card = cardOf(message)
  const check = card?.checks.find(c => c.id === checkId)
  const key = `${message.id}:${checkId}`
  if (!card || !check || card.results.some(r => r.checkId === checkId) || inFlight.has(key)) return
  inFlight.add(key)
  button.disabled = true
  try {
    const actor: any = await fromUuid(card.actorUuid)
    if (!actor) return
    const ht = htOf(actor)
    const target = targetFor(check, ht)
    const roll = await roll3d6()
    await postRollMessage(
      actor,
      roll,
      checkLabel(check),
      targetText(check, ht),
      resolveRoll(roll.total, target),
      card.whisper
    )
    const game_ = game as any
    const mayRunHere = game_.user.isGM || (actor.isOwner && (message.isAuthor || !game_.users.activeGM))
    await runWith(
      'resolveCheck',
      { messageId: message.id, checkId, total: roll.total, roller: game_.user.name },
      mayRunHere
    )
  } finally {
    inFlight.delete(key)
  }
}

export function onRenderChatMessage(message: any, html: HTMLElement | any): void {
  // Foundry passes an HTMLElement; older hooks pass jQuery.
  const root: HTMLElement | undefined = typeof html?.querySelectorAll === 'function' ? html : html?.[0]
  if (!root || !cardOf(message)) return
  root.querySelectorAll<HTMLButtonElement>('[data-agency-wounds-check]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault()
      void onCheckClick(message, button.dataset.agencyWoundsCheck ?? '', button)
    })
  })
}

/* ------------------------------------------------------------------ */
/* Resolving a check (owner or GM)                                    */
/* ------------------------------------------------------------------ */

function woundResultText(key: string, effects: readonly Effect[], check: CardCheck): string {
  const pain = effects.find(e => e.type === 'pain') as Extract<Effect, { type: 'pain' }> | undefined
  return format(key, { minutes: pain?.minutes ?? 0, limb: (check as any).limbKey ?? '' })
}

export async function resolveCheckOp(payload: {
  messageId: string
  checkId: string
  total: number
  roller: string
}): Promise<void> {
  const message = (game as any).messages?.get(payload.messageId)
  const card = cardOf(message)
  if (!card || card.results.some(r => r.checkId === payload.checkId)) return
  const check = card.checks.find(c => c.id === payload.checkId)
  if (!check) return
  const actor: any = await fromUuid(card.actorUuid)
  if (!actor) return

  const traits = actorTraits(actor, card.injuryTolerance)
  const ht = htOf(actor)
  const before = readState(actor)
  let after: WoundsState = before
  let effects: Effect[] = []
  let text = ''
  let roll: RollOutcome
  let doNothing = false

  if (check.source === 'wound') {
    const resolved = resolveCheck(before, check, payload.total, ht, worldTime())
    after = resolved.state
    effects = resolved.resolution.effects
    roll = resolved.resolution.roll
    text = woundResultText(resolved.resolution.result, effects, check)
  } else if (check.source === 'fatigue') {
    const resolved = resolveFatigueCheck(payload.total, ht, check.spec)
    roll = resolved.unconsciousRoll
    if (resolved.dead) effects = [{ type: 'dead', reason: 'fatigue' }]
    else if (resolved.unconscious) effects = [{ type: 'unconscious' }, { type: 'prone' }]
    text = localize(
      resolved.dead ? `${K}.result.dead` : resolved.unconscious ? `${K}.result.collapses` : `${K}.result.staysUp`
    )
  } else {
    roll = resolveRoll(payload.total, targetFor(check, ht))
    doNothing = !roll.success
    text = localize(roll.success ? `${K}.result.acts` : `${K}.result.doNothing`)
  }

  if (after !== before) await writeState(actor, after)
  await applyEffectStatuses(actor, effects)
  if (effects.some(e => e.type === 'pain')) {
    await syncPain(actor, before.pain, after.pain, traits)
    // Pain does not stack with shock: re-apply any shock still waiting for the next turn.
    if (shockPending(after)) await applyShock(actor, after, traits)
  }
  if (after !== before) await syncDerived(actor, before, after)
  if (doNothing) await actor.replaceManeuver?.('do_nothing')

  card.results.push({
    checkId: check.id,
    total: payload.total,
    target: roll.target,
    success: roll.success,
    text,
    roller: payload.roller,
  })
  const game_ = game as any
  if (game_.user.isGM || message.isAuthor)
    await message.update({ content: await renderCard(card, ht), [`flags.gurps.${CARD_FLAG}`]: card })
}

export function registerChatHandlers(): void {
  registerSocketHandler('resolveCheck', resolveCheckOp)
}
