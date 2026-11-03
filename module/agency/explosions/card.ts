/**
 * The GM's explosion card: one row per token caught, with distance, cover, blast damage after the
 * divisor, fragment hits, knockback and special effects; buttons to apply one row or all of them.
 * Damage goes through upstream's ApplyDamageDialog / DamageCalculator without opening it ("Large-Area"
 * for the blast, the rolled location for each fragment), so the wounds feature's Revised Fractional
 * Health still decides what each hit does.
 *
 * The card lives in flags.gurps.agency.explosion; only the GM's client updates it (applyBlastEvent).
 */
import { isRFH } from '../wounds/config.ts'
import { gmIds, resolveActor } from '../defense/foundry-helpers.ts'
import { formatComponent, formatSpec } from './parse.ts'
import { deriveRow, radii, type DerivedRow, type RowState } from './resolve.ts'
import { reduceBlast } from './reducer.ts'
import { knockbackMoves } from './settings.ts'
import { findSpecial } from './specials.ts'
import { pixelsPerYard, removeTemplates, sceneOf, stopAtWalls, tokenCenter } from './scene.ts'
import { pushAway, facing } from './command-parse.ts'
import { localize } from './i18n.ts'
import { toGM } from './socket.ts'
import type { BlastCardFlag, BlastEvent, ExplosionFlag } from './types.ts'

export const TEMPLATES = {
  card: 'systems/gurps/templates/agency/explosion-card.hbs',
  prompt: 'systems/gurps/templates/agency/explosion-prompt.hbs',
}

const FLAG = 'agency.explosion'

export function getExplosionFlag(message: any): ExplosionFlag | null {
  const flag = message?.getFlag?.('gurps', FLAG) ?? foundry.utils.getProperty(message ?? {}, `flags.gurps.${FLAG}`)
  return flag?.kind ? (flag as ExplosionFlag) : null
}

async function render(path: string, data: object): Promise<string> {
  return (foundry.applications as any).handlebars.renderTemplate(path, data)
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

function typeLabel(type: string): string {
  return type || 'dmg'
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? String(n) : '±0'
}

function coverText(d: DerivedRow, row: RowState, flag: BlastCardFlag): string {
  switch (d.coverSource) {
    case 'wall':
      return localize('row.coverWall', { n: row.facts.walls })
    case 'dive':
      return localize('row.coverDive')
    case 'body': {
      const shield = flag.state.contactId ?? flag.state.internalId
      const name = flag.state.rows.find(r => r.facts.id === shield)?.facts.name ?? '?'
      return localize('row.coverBody', { name })
    }
    case 'manual':
      return localize('row.coverManual')
    default:
      return ''
  }
}

/** The cover's source, with the total when a dive or a body adds to what the input shows. */
function coverNote(d: DerivedRow, row: RowState, flag: BlastCardFlag): string {
  const text = coverText(d, row, flag)
  const base = row.coverOverride ?? row.facts.wallDR
  return d.coverDR !== base ? localize('row.coverTotal', { dr: d.coverDR, source: text }) : text
}

function blastLines(d: DerivedRow, row: RowState): string[] {
  return d.blast.map(b => {
    const type = typeLabel(b.type)
    let text: string
    switch (b.kind) {
      case 'contact':
        text = localize('row.blastContact', { damage: b.damage, type })
        break
      case 'internal':
        text = localize('row.blastInternal', { damage: b.damage, type })
        break
      case 'struck':
        text = localize('row.blastStruck', {
          damage: b.damage,
          type,
          divisor: b.armorDivisor > 0 ? ` (${b.armorDivisor})` : b.armorDivisor < 0 ? ' (∞)' : '',
        })
        break
      case 'direct':
        text = localize('row.blastDirect', { damage: b.damage, type })
        break
      default:
        text = localize('row.blastCollateral', { rolled: b.rolled, divisor: b.divisor, damage: b.damage, type })
        if (b.applied !== b.damage) text += ` ${localize('row.throughCover', { applied: b.applied })}`
    }
    if (b.location === 'Large-Area' && b.applied > 0 && row.facts.largeAreaDR !== undefined)
      text += ` ${localize('row.largeAreaDR', { dr: row.facts.largeAreaDR })}`
    if (b.fire !== 'none') text += ` · ${localize(`row.fire.${b.fire}`)}`
    return text
  })
}

function fragmentLines(d: DerivedRow): { attack: string; hits: string[] } | null {
  const f = d.fragments
  if (!f) return null
  let attack: string
  if (f.automatic) attack = localize('row.fragAuto')
  else {
    const mods = [`${localize('row.range')} ${signed(f.rangeModifier)}`]
    if (f.postureModifier) mods.push(`${localize('row.posture')} ${signed(f.postureModifier)}`)
    if (f.sizeModifier) mods.push(`SM ${signed(f.sizeModifier)}`)
    attack = localize('row.fragAttack', {
      effective: f.effective,
      mods: mods.join(', '),
      roll: f.roll ?? '-',
      result: f.hits > 0 ? localize('row.fragHits', { n: f.hits }) : localize('row.fragMiss'),
    })
    if (f.critical) attack += ` ${localize('row.critical')}`
  }
  if (f.stopped > 0) attack += ` · ${localize('row.fragStopped', { n: f.stopped })}`
  const hits = f.hitList.map(h => {
    const where = h.location ? localize('row.at', { location: h.location }) : ''
    let text =
      `${h.damage} ${h.type}${h.armorDivisor !== 1 ? ` (${h.armorDivisor < 0 ? '∞' : h.armorDivisor})` : ''} ${where}`.trim()
    if (h.coveredBy !== 'none') text += ` ${localize('row.throughCover', { applied: h.applied })}`
    return text
  })
  return { attack, hits }
}

function diveView(row: RowState, d: DerivedRow): { text: string; cls: string; pending: boolean } {
  const dive = row.dive
  switch (dive.status) {
    case 'pending':
      return { text: localize('dive.pending'), cls: 'is-pending', pending: true }
    case 'success':
      return {
        text: dive.smother
          ? localize('dive.smother', { margin: dive.margin })
          : localize('dive.success', { margin: dive.margin }) + (dive.coverStep ? ` ${localize('dive.toCover')}` : ''),
        cls: 'is-good',
        pending: false,
      }
    case 'failure':
      return { text: localize('dive.failure', { margin: Math.abs(dive.margin) }), cls: 'is-bad', pending: false }
    case 'declined':
      return { text: localize('dive.declined'), cls: '', pending: false }
    default:
      return { text: d.canDive ? localize('dive.none') : '', cls: '', pending: false }
  }
}

export function blastView(flag: BlastCardFlag): Record<string, unknown> {
  const { request, state } = flag
  const r = radii(state.setup)
  const rows = state.rows.map(row => {
    const d = deriveRow(state, row)
    const meta = flag.meta[row.facts.id]
    const frag = fragmentLines(d)
    const notes: string[] = []
    if (d.knockback)
      notes.push(
        localize('row.knockback', {
          yards: d.knockback.yards,
          mod: d.knockback.rollModifier ? signed(d.knockback.rollModifier) : '',
        })
      )
    if (d.affliction) {
      const aff = state.setup.specials.affliction
      notes.push(
        localize(d.affliction.success ? 'row.stunResisted' : 'row.stunned', {
          target: d.affliction.target,
          roll: d.affliction.roll,
          recovery: aff ? `HT${signed(aff.recovery)}` : 'HT',
        })
      )
    }
    if (d.hotFragments) notes.push(localize('row.hotFragments'))
    const dive = diveView(row, d)
    return {
      id: row.facts.id,
      name: row.facts.name,
      img: meta?.img ?? '',
      npc: !!meta?.npc,
      struck: d.struck,
      contact: d.contact,
      internal: d.internal,
      distance: d.struck ? localize('row.struck') : localize('row.distance', { yards: d.distance }),
      moved: d.effectiveDistance !== d.distance ? localize('row.moved', { yards: d.effectiveDistance }) : '',
      coverDR: d.coverDR,
      coverBase: row.coverOverride ?? row.facts.wallDR,
      coverText: coverNote(d, row, flag),
      coverEditable: !d.struck && !d.contact && !d.internal,
      blast: blastLines(d, row),
      fragAttack: frag?.attack ?? '',
      fragHits: frag?.hits ?? [],
      notes,
      dive,
      canGMDive: dive.pending,
      canSmother: d.canSmother && dive.pending,
      applied: row.applied,
      hasEffect: d.hasEffect,
      outside: !d.inBlast && !d.inFragments && !d.inAffliction,
    }
  })

  const specials: string[] = []
  const s = state.setup.specials
  const named = s.ids.map(id => `${localize(`special.${id}`)} (${findSpecial(id)?.ref ?? ''})`)
  if (named.length) specials.push(named.join(', '))
  if (state.setup.spec.components.some(c => c.explosive)) specials.push(localize('card.incendiary'))
  if (s.affliction)
    specials.push(
      localize('card.affliction', { modifier: signed(s.affliction.htModifier), radius: s.affliction.radius })
    )
  if (s.smoke)
    specials.push(
      localize('card.smoke', {
        radius: s.smoke.radius,
        seconds: s.smoke.seconds ? localize('card.seconds', { n: s.smoke.seconds }) : '',
      })
    )
  if (s.gas) specials.push(localize('card.gas', { radius: s.gas.radius }))
  if (state.setup.environment !== 'normal') specials.push(localize(`card.environment.${state.setup.environment}`))
  if (state.setup.airburst) specials.push(localize('card.airburst'))
  const struckRow = state.rows.find(row => row.facts.struck && row.facts.id === request.struckTokenId)

  let where = ''
  if (request.scatter)
    where = request.scatter.dodged
      ? localize('card.dodged', { yards: request.scatter.yards, direction: request.scatter.direction })
      : localize('card.scattered', { yards: request.scatter.yards, direction: request.scatter.direction })
  else if (struckRow) where = localize('card.struck', { name: struckRow.facts.name })
  if (state.contactId)
    where = localize('card.contact', { name: state.rows.find(x => x.facts.id === state.contactId)?.facts.name ?? '?' })
  if (state.internalId)
    where = localize('card.internal', {
      name: state.rows.find(x => x.facts.id === state.internalId)?.facts.name ?? '?',
    })

  if (request.extraHits) specials.push(localize('card.extraHits', { n: request.extraHits }))
  const pendingApply = rows.some(x => !x.applied && x.hasEffect)
  return {
    label: request.label,
    damage: formatSpec(state.setup.spec),
    components: state.setup.spec.components.length > 1 ? state.setup.spec.components.map(formatComponent) : [],
    attacker: request.attacker?.name ?? '',
    where,
    radii: localize('card.radii', { blast: r.blast, fragments: r.fragments }),
    specials,
    enclosed: [
      { value: 1, label: localize('card.enclosed.open'), selected: state.setup.enclosed === 1 },
      { value: 1.5, label: localize('card.enclosed.vented'), selected: state.setup.enclosed === 1.5 },
      { value: 2, label: localize('card.enclosed.sealed'), selected: state.setup.enclosed === 2 },
    ],
    rows,
    none: rows.length === 0,
    pendingApply,
    allApplied: rows.length > 0 && !pendingApply,
    hasTemplates: flag.templateIds.length > 0,
  }
}

export async function renderBlastCard(flag: BlastCardFlag): Promise<string> {
  return render(TEMPLATES.card, blastView(flag))
}

export async function postBlastCard(flag: BlastCardFlag): Promise<any> {
  const content = await renderBlastCard(flag)
  return (ChatMessage as any).create({
    content,
    whisper: gmIds(),
    speaker: { alias: localize('card.speaker') },
    flags: { gurps: { agency: { explosion: flag } } },
  })
}

/* ------------------------------------------------------------------ */
/* Events (GM side)                                                    */
/* ------------------------------------------------------------------ */

const queues = new Map<string, Promise<void>>()

/** Apply an event to a GM card. Runs on the GM's client; serialized per message. */
export function applyBlastEvent(messageId: string, event: BlastEvent): Promise<void> {
  const previous = queues.get(messageId) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      const message = (game.messages as any)?.get(messageId)
      const flag = getExplosionFlag(message)
      if (!message || flag?.kind !== 'blast') return
      const updated = reduceBlast(flag, event)
      if (updated === flag) return
      const content = await renderBlastCard(updated)
      await message.update({ content, [`flags.gurps.${FLAG}`]: updated })
      if (event.kind === 'dive') await updatePrompt(updated, event.tokenId)
      // Prompts still waiting when the GM applies are too late.
      if (event.kind === 'applied') for (const id of event.tokenIds) await updatePrompt(updated, id)
    })
    .catch(err => console.error('GURPS | Agency | explosion card update failed', err))
  queues.set(messageId, next)
  return next
}

/** Send a card event to the GM (or apply it here when this user is the GM). */
export async function submitBlastEvent(messageId: string, event: BlastEvent): Promise<void> {
  await toGM('blastEvent', { messageId, event })
}

/** Mirror a dive result onto the player's prompt card (the GM posted it, so the GM updates it). */
async function updatePrompt(flag: BlastCardFlag, tokenId: string): Promise<void> {
  const promptId = flag.prompts[tokenId]
  const message = promptId ? (game.messages as any)?.get(promptId) : null
  const prompt = getExplosionFlag(message)
  const row = flag.state.rows.find(r => r.facts.id === tokenId)
  if (!message || prompt?.kind !== 'dive-prompt' || !row) return
  const next = {
    ...prompt,
    status: row.dive.status,
    margin: row.dive.margin,
    coverStep: row.dive.coverStep,
    smother: row.dive.smother,
  }
  const { renderPrompt } = await import('./prompts.ts')
  await message.update({ content: await renderPrompt(next), [`flags.gurps.${FLAG}`]: next })
}

/* ------------------------------------------------------------------ */
/* Applying damage                                                     */
/* ------------------------------------------------------------------ */

interface Hit {
  damage: number
  type: string
  armorDivisor: number
  location: string
  modifier: string
  dice: string
  ignoresDR?: boolean
  woundingModifier?: number | null
  /** Large-area DR over the parts not behind the token's cover (B400), for the standard damage model. */
  largeAreaDR?: number | null
}

/**
 * One hit through upstream's Apply Damage dialog, without showing it: build the calculator from a
 * damage payload, set the location ("Large-Area" for a blast, B400), then resolve the injury.
 */
async function applyHit(actor: any, tokenDoc: any, attackerId: string | null, hit: Hit): Promise<void> {
  const { default: ApplyDamageDialog } = (await import('../../damage/applydamage.js')) as any
  const entries: any[] = actor.hitLocationsWithDR ?? []
  const known = (where: string) => entries.some(e => e.where === where)
  const area = hit.location === 'Large-Area'
  // A location the actor's table has, so the dialog doesn't fall back to a random one.
  const base =
    !area && hit.location && known(hit.location)
      ? hit.location
      : known('Torso')
        ? 'Torso'
        : (entries[0]?.where ?? 'Torso')
  const payload = {
    attacker: attackerId ?? actor.id,
    dice: hit.dice,
    damage: hit.damage,
    damageType: hit.type,
    damageModifier: hit.modifier,
    armorDivisor: hit.armorDivisor,
    // Large-Area up front, so the hit-location feature doesn't roll (and announce) a torso sub-location.
    hitlocation: area ? 'Large-Area' : base,
    token: tokenDoc?.object ?? null,
  }
  const dialog: any = new ApplyDamageDialog(actor, [payload])
  const calc = dialog._calculator
  if (area) calc.hitLocation = 'Large-Area'
  // Under RFH the wound feature takes each location's own DR (and skips covered ones), so leave DR alone.
  if (area && typeof hit.largeAreaDR === 'number' && !isRFH()) calc.userEnteredDR = hit.largeAreaDR
  if (hit.ignoresDR) {
    // DR is ignored, so the location needn't be in the actor's table (its DR is never looked up).
    calc.userEnteredDR = 0
    if (hit.location) calc.hitLocation = hit.location
  }
  if (hit.woundingModifier) calc.additionalWoundModifier = hit.woundingModifier - (Number(calc.woundingModifier) || 1)
  await dialog.resolveInjury(true, calc.pointsToApply, true, '')
}

async function moveForKnockback(flag: BlastCardFlag, tokenDoc: any, yards: number): Promise<void> {
  const object = tokenDoc?.object
  if (!object || canvas?.scene?.id !== tokenDoc.parent?.id) return
  const from = tokenCenter(tokenDoc)
  const attackerDoc = flag.request.attacker?.tokenId
    ? tokenDoc.parent?.tokens?.get(flag.request.attacker.tokenId)
    : null
  const fallback = attackerDoc ? facing(tokenCenter(attackerDoc), flag.request.center) : 0
  const wanted = pushAway(flag.request.center, from, yards, pixelsPerYard(), fallback)
  const to = stopAtWalls(from, wanted)
  const size = Number(canvas?.grid?.size ?? 100)
  await tokenDoc.update({ x: to.x - (tokenDoc.width * size) / 2, y: to.y - (tokenDoc.height * size) / 2 })
}

async function applyRow(flag: BlastCardFlag, row: RowState): Promise<boolean> {
  const scene = sceneOf(flag.request.sceneId)
  const tokenDoc = scene?.tokens?.get(row.facts.id)
  const actor =
    tokenDoc?.actor ??
    (flag.meta[row.facts.id]?.actorId ? (game.actors as any)?.get(flag.meta[row.facts.id].actorId) : null)
  if (!actor) return false
  const d = deriveRow(flag.state, row)
  const attackerId = flag.request.attacker ? (resolveActor(flag.request.attacker)?.id ?? null) : null
  const spec = flag.state.setup.spec

  for (const b of d.blast) {
    if (!(b.applied > 0)) continue
    await applyHit(actor, tokenDoc, attackerId, {
      damage: b.applied,
      type: b.type,
      armorDivisor: b.armorDivisor,
      location: b.kind === 'direct' ? '' : b.location,
      modifier: b.kind === 'direct' ? '' : 'ex',
      dice: formatComponent(spec.components[b.componentIndex]),
      ignoresDR: b.ignoresDR,
      woundingModifier: b.woundingModifier,
      largeAreaDR: b.location === 'Large-Area' ? row.facts.largeAreaDR : null,
    })
  }
  for (const h of d.fragments?.hitList ?? []) {
    if (!(h.applied > 0)) continue
    await applyHit(actor, tokenDoc, attackerId, {
      damage: h.applied,
      type: h.type,
      armorDivisor: h.armorDivisor === 1 ? 0 : h.armorDivisor,
      location: h.location,
      modifier: '',
      dice: localize('row.fragment'),
    })
  }
  const status = flag.state.setup.specials.affliction?.status
  if (d.affliction && !d.affliction.success && status) {
    try {
      await actor.toggleStatusEffect(status, { active: true })
    } catch (err) {
      console.warn('GURPS | Agency | explosions: could not set status', err)
    }
  }
  if (d.knockback && knockbackMoves()) await moveForKnockback(flag, tokenDoc, d.knockback.yards)
  return true
}

const applying = new Set<string>()

/** GM: apply the listed rows (all rows with something to apply when ids is null). */
export async function applyRows(message: any, ids: string[] | null): Promise<void> {
  if (!game.user?.isGM || applying.has(message.id)) return
  const flag = getExplosionFlag(message)
  if (flag?.kind !== 'blast') return
  applying.add(message.id)
  try {
    const rows = flag.state.rows.filter(
      row => !row.applied && (ids ? ids.includes(row.facts.id) : deriveRow(flag.state, row).hasEffect)
    )
    const done: string[] = []
    for (const row of rows) if (await applyRow(flag, row)) done.push(row.facts.id)
    if (done.length) await applyBlastEvent(message.id, { kind: 'applied', tokenIds: done })
  } finally {
    applying.delete(message.id)
  }
}

/* ------------------------------------------------------------------ */
/* Card controls (GM)                                                  */
/* ------------------------------------------------------------------ */

export function decorateBlastCard(message: any, html: HTMLElement, flag: BlastCardFlag): void {
  const root = html.querySelector<HTMLElement>('[data-agency-card="explosion"]')
  if (!root) return
  if (!game.user?.isGM) {
    root.querySelectorAll('[data-boom-gm]').forEach(el => el.remove())
    return
  }
  const on = (selector: string, type: string, handler: (el: HTMLElement, event: Event) => unknown) =>
    root.querySelectorAll<HTMLElement>(selector).forEach(el =>
      el.addEventListener(type, event => {
        event.preventDefault()
        Promise.resolve(handler(el, event)).catch(err => console.error('GURPS | Agency | explosion card', err))
      })
    )

  on('[data-boom-action="apply"]', 'click', el => applyRows(message, [el.dataset.token!]))
  on('[data-boom-action="apply-all"]', 'click', () => applyRows(message, null))
  on('[data-boom-action="cover"]', 'change', el => {
    const raw = (el as HTMLInputElement).value.trim()
    return applyBlastEvent(message.id, {
      kind: 'cover',
      tokenId: el.dataset.token!,
      dr: raw === '' ? null : Number(raw),
    })
  })
  on('[data-boom-action="enclosed"]', 'change', el =>
    applyBlastEvent(message.id, { kind: 'enclosed', value: Number((el as HTMLSelectElement).value) || 1 })
  )
  on('[data-boom-action="templates"]', 'click', async () => {
    await removeTemplates(flag.request.sceneId, flag.templateIds)
    await applyBlastEvent(message.id, { kind: 'templates', ids: [] })
  })
  on('[data-boom-action="gm-stay"]', 'click', el =>
    applyBlastEvent(message.id, {
      kind: 'dive',
      tokenId: el.dataset.token!,
      status: 'declined',
      margin: 0,
      coverStep: false,
      smother: false,
    })
  )
  on('[data-boom-action="gm-dive"]', 'click', async (el, event) => {
    const { diveFor } = await import('./prompts.ts')
    const tokenId = el.dataset.token!
    const coverStep = !!root.querySelector<HTMLInputElement>(`input[data-boom-cover-step="${tokenId}"]`)?.checked
    await diveFor(message.id, flag, tokenId, { coverStep, smother: el.dataset.smother === 'true', event })
  })
}

/** For the socket: anyone may send card events; a GM applies them. */
export function onBlastEventMessage(data: { messageId: string; event: BlastEvent }): Promise<void> | void {
  if (!game.user?.isGM) return
  return applyBlastEvent(data.messageId, data.event)
}
