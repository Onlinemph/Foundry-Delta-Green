/**
 * The hit-location card. After the defense card's "Roll damage", the damage of every hit gets its own
 * location (GUHL, or the actor's own table), the target's cover is checked, and one card lists the
 * hits: number, location path, cover result, damage, an Apply button per hit, and Apply all.
 *
 * Apply opens upstream's Apply Damage dialog for that hit (its location and GUHL detail on the
 * damage entry; dialog.ts puts them on the calculator). Apply all runs each hit through the same
 * dialog and calculator without showing it (ApplyDamageDialog.resolveInjury), so the wound feature's
 * interception sees every hit.
 */
import ApplyDamageDialog from '../../damage/applydamage.js'
import type { AttackContext, TokenRef } from '../defense/types.ts'
import {
  activeGMId,
  gmIds,
  playerOwnerIds,
  renderTemplate,
  resolveActor,
  resolveTokenDoc,
  unique,
} from '../defense/foundry-helpers.ts'
import { emitSocket, onSocket } from '../defense/socket.ts'
import { FLAG_ROOT, FLAG_SCOPE } from '../settings.ts'
import {
  L,
  cardView,
  chooseAim,
  coverHpAfter,
  effectiveFacing,
  markApplied,
  pendingHits,
  resolveHits,
  withFacing,
  type HitCardFlag,
  type HitEntry,
} from './card.ts'
import { normalizeCover } from './cover.ts'
import type { HitRequest } from './dialog.ts'
import { parseAttackType } from './engine.ts'
import { bodyInfo, facingBetween, liveRoller, locationLabel, t, torsoWhere, type AnyActor } from './foundry.ts'
import { defaultLocation, guhlEnabled, onlyGMsOpenADD, torsoCap } from './settings.ts'
import type { Facing } from './types.ts'

export const CARD_TEMPLATE = 'systems/gurps/templates/agency/hitloc-card.hbs'
const FLAG_KEY = `${FLAG_ROOT}.hitloc`
export const COVER_FLAG = `${FLAG_ROOT}.cover`

export function getHitCard(message: any): HitCardFlag | null {
  const card = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY)
  return card?.kind === 'hitloc-card' ? (card as HitCardFlag) : null
}

/** Can this user apply damage to the defender (upstream's "only GMs open Apply Damage" setting)? */
function canApply(actor: AnyActor | null): boolean {
  if (game.user?.isGM) return true
  return !!actor?.isOwner && !onlyGMsOpenADD()
}

async function renderCard(card: HitCardFlag): Promise<string> {
  return renderTemplate(
    CARD_TEMPLATE,
    cardView(card, t, {
      torsoCap: torsoCap(),
      canApply: true,
      canEditFacing: true,
      aimLabel: card.aimName ? locationLabel(card.aimName) : '',
    })
  )
}

function cleanEntry(entry: any): Record<string, unknown> {
  const { roll: _roll, token: _token, agencyHit: _hit, ...rest } = foundry.utils.deepClone(entry ?? {})
  return rest
}

/* ---------------------------------------- */
/*  Posting                                  */
/* ---------------------------------------- */

export interface DamageRolledData {
  attack: AttackContext
  target: TokenRef
  payload: any[]
}

/**
 * Handler for 'gurpsAgencyDamageRolled' (the defense card's damage step). Returns false when this
 * feature takes over (posts the hit card), so the defense card doesn't also open Apply Damage.
 */
export function onDamageRolled(data: DamageRolledData): boolean {
  if (!data?.payload?.length || !data.target) return true
  const actor = resolveTokenDoc(data.target)?.actor ?? resolveActor(data.target)
  if (!actor) return true
  postHitCard(data, actor).catch(err => console.error('GURPS | Agency | hit-location card failed', err))
  return false
}

async function postHitCard({ attack, target, payload }: DamageRolledData, actor: AnyActor): Promise<void> {
  const targetDoc = resolveTokenDoc(target)
  const attackerDoc = resolveTokenDoc(attack.attacker)
  const info = bodyInfo(actor)
  const { aim, called, known } = chooseAim(attack.hitLocation, defaultLocation())
  const system = guhlEnabled() && info.guhl && known ? 'guhl' : 'standard'
  const first = payload[0] ?? {}
  const attackType = parseAttackType(first.damageType, first.damageModifier)
  const armorDivisor = Number(first.armorDivisor) || 0
  const facingAuto: Facing = facingBetween(attackerDoc, targetDoc)
  const cover = normalizeCover(targetDoc?.getFlag?.(FLAG_SCOPE, COVER_FLAG))

  const hits = resolveHits({
    system,
    aim,
    aimName: attack.hitLocation,
    called,
    attack: attackType,
    facing: facingAuto,
    damages: payload.map(entry => Number(entry?.damage) || 0),
    dice: [],
    coverDice: [],
    fresh: liveRoller(),
    body: info,
    cover,
    armorDivisor,
  })

  const typeText = String(first.damageType ?? '') + (first.damageModifier ? ` ${first.damageModifier}` : '')
  const card: HitCardFlag = {
    kind: 'hitloc-card',
    attacker: attack.attacker,
    target,
    userId: game.user!.id,
    weapon: attack.weapon,
    damageText: `${first.dice ?? attack.damage ?? ''} ${typeText}`.trim(),
    attack: attackType,
    armorDivisor,
    aimName: attack.hitLocation,
    aim,
    called,
    system,
    facingAuto,
    facingOverride: null,
    cover,
    hits,
    entries: payload.map(cleanEntry),
  }

  const attacker = resolveActor(attack.attacker)
  const speaker = (ChatMessage as any).getSpeaker({ actor: attacker, token: attackerDoc })
  await (ChatMessage as any).create({
    content: await renderCard(card),
    whisper: unique([...playerOwnerIds(actor), ...gmIds(), game.user!.id, attack.userId]),
    speaker,
    flags: { [FLAG_SCOPE]: { [FLAG_ROOT]: { hitloc: card } } },
  })

  const hp = coverHpAfter(card)
  if (hp !== null && hp !== cover?.hp) await setCoverHp(target, hp)
}

/* ---------------------------------------- */
/*  Cover HP and card updates                */
/* ---------------------------------------- */

async function writeCoverHp(target: TokenRef, hp: number): Promise<void> {
  const doc = resolveTokenDoc(target)
  if (!doc) return
  await doc.update({ [`flags.${FLAG_SCOPE}.${COVER_FLAG}.hp`]: hp })
}

/** Update the cover's HP here if allowed, else on the active GM's client. */
async function setCoverHp(target: TokenRef, hp: number): Promise<void> {
  const doc = resolveTokenDoc(target)
  if (game.user?.isGM || doc?.isOwner) return writeCoverHp(target, hp)
  const gm = activeGMId()
  if (gm) emitSocket('hitlocCoverHp', gm, { target, hp })
  else ui.notifications?.warn(t(`${L}.warn.coverHpNoGM`))
}

async function writeCard(message: any, card: HitCardFlag): Promise<void> {
  await message.update({ content: await renderCard(card), [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: card })
}

const queues = new Map<string, Promise<void>>()

/** Serialize card updates per message (several Apply clicks in a row). */
function queueUpdate(messageId: string, update: (card: HitCardFlag) => HitCardFlag): Promise<void> {
  const previous = queues.get(messageId) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      const message = (game.messages as any)?.get(messageId)
      const card = getHitCard(message)
      if (!message || !card) return
      const updated = update(card)
      if (updated !== card) await writeCard(message, updated)
    })
    .catch(err => console.error('GURPS | Agency | hit-location card update failed', err))
  queues.set(messageId, next)
  return next
}

/** Mark hits applied: on this client if it may update the message, else on the active GM's. */
async function recordApplied(message: any, indexes: number[]): Promise<void> {
  if (!indexes.length) return
  const mayUpdate = game.user?.isGM || message.author?.id === game.user?.id
  if (mayUpdate) return queueUpdate(message.id, card => markApplied(card, indexes))
  const gm = activeGMId()
  if (gm) emitSocket('hitlocApplied', gm, { messageId: message.id, indexes })
}

export function registerHitCardSocket(): void {
  onSocket('hitlocApplied', async (data: { messageId: string; indexes: number[] }) => {
    if (game.user?.isGM) await queueUpdate(data.messageId, card => markApplied(card, data.indexes))
  })
  onSocket('hitlocCoverHp', async (data: { target: TokenRef; hp: number }) => {
    if (game.user?.isGM) await writeCoverHp(data.target, data.hp)
  })
}

/* ---------------------------------------- */
/*  Applying hits                            */
/* ---------------------------------------- */

/** The damage entry for one hit: its damage after cover, its location, and the resolved hit. */
function damageEntry(card: HitCardFlag, hit: HitEntry, actor: AnyActor): Record<string, unknown> {
  const info = bodyInfo(actor)
  const request: HitRequest = {
    result: hit.result,
    where: hit.where,
    facing: effectiveFacing(card),
    cover: hit.cover,
  }
  const entry: Record<string, unknown> = {
    ...foundry.utils.deepClone(card.entries[hit.index] ?? card.entries[0] ?? {}),
    damage: hit.finalDamage,
    hitlocation: hit.where ?? torsoWhere(info) ?? hit.result.upstream,
    agencyHit: request,
  }
  const doc = resolveTokenDoc(card.target)
  if (doc?.object) entry.token = doc.object
  return entry
}

function targetActor(card: HitCardFlag): AnyActor | null {
  return resolveTokenDoc(card.target)?.actor ?? resolveActor(card.target)
}

async function applyHit(message: any, index: number): Promise<void> {
  const card = getHitCard(message)
  const hit = card?.hits[index]
  const actor = card ? targetActor(card) : null
  if (!card || !hit || !actor) return void ui.notifications?.warn(t(`${L}.warn.noTarget`))
  if (!canApply(actor)) return void ui.notifications?.warn(game.i18n!.localize('GURPS.invalidUserForDamageWarning'))

  const dialog: any = new (ApplyDamageDialog as any)(actor, [damageEntry(card, hit, actor)])
  // Mark the hit applied once the dialog actually applies it (either Apply button, any number of times).
  const original = dialog.resolveInjury.bind(dialog)
  let marked = false
  dialog.resolveInjury = async (...args: any[]) => {
    const result = await original(...args)
    if (!marked) {
      marked = true
      await recordApplied(message, [index])
    }
    return result
  }
  dialog.render(true)
}

async function applyAll(message: any): Promise<void> {
  const card = getHitCard(message)
  const actor = card ? targetActor(card) : null
  if (!card || !actor) return void ui.notifications?.warn(t(`${L}.warn.noTarget`))
  if (!canApply(actor)) return void ui.notifications?.warn(game.i18n!.localize('GURPS.invalidUserForDamageWarning'))

  const done: number[] = []
  for (const hit of pendingHits(card)) {
    const dialog: any = new (ApplyDamageDialog as any)(actor, [damageEntry(card, hit, actor)])
    // A fourth argument marks this as the calculator path, so the wound feature reads uncapped injury.
    await dialog.resolveInjury(true, dialog._calculator.pointsToApply, false, '')
    done.push(hit.index)
  }
  await recordApplied(message, done)
}

async function setFacing(message: any, value: string): Promise<void> {
  if (!game.user?.isGM) return
  const facing: Facing | null = value === 'front' || value === 'side' || value === 'rear' ? value : null
  await queueUpdate(message.id, card => {
    const actor = targetActor(card)
    if (!actor || card.hits.some(hit => hit.applied)) return card
    return withFacing(card, facing, bodyInfo(actor), liveRoller())
  })
}

/* ---------------------------------------- */
/*  Displaying a card                        */
/* ---------------------------------------- */

const busy = new Set<string>()

/** renderChatMessageHTML: per-viewer controls (Apply buttons, the GM's facing override). */
export function decorateHitCard(message: any, html: HTMLElement, card: HitCardFlag): void {
  const root = html.querySelector<HTMLElement>('[data-agency-card="hitloc"]')
  if (!root) return

  const mayApply = canApply(targetActor(card))
  root.querySelectorAll<HTMLElement>('[data-agency-role="apply"]').forEach(el => {
    if (!mayApply) el.remove()
  })
  root.querySelectorAll<HTMLElement>('[data-agency-role="gm"]').forEach(el => {
    if (!game.user?.isGM) el.remove()
  })

  const guard = (fn: () => Promise<void>) => async (event: Event) => {
    event.preventDefault()
    if (busy.has(message.id)) return
    busy.add(message.id)
    try {
      await fn()
    } catch (err) {
      console.error('GURPS | Agency | hit-location card', err)
    } finally {
      busy.delete(message.id)
    }
  }

  root.querySelectorAll<HTMLButtonElement>('[data-agency-action="apply"]').forEach(button =>
    button.addEventListener(
      'click',
      guard(() => applyHit(message, Number(button.dataset.hit)))
    )
  )
  root.querySelector<HTMLButtonElement>('[data-agency-action="apply-all"]')?.addEventListener(
    'click',
    guard(() => applyAll(message))
  )
  const select = root.querySelector<HTMLSelectElement>('select[name="agency-facing"]')
  select?.addEventListener('change', event => {
    const value = select.value
    void guard(() => setFacing(message, value))(event)
  })
}
