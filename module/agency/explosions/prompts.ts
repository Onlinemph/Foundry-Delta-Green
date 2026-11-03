/**
 * Prompts to the players whose characters are caught:
 * - "Dive for cover" (B377/B414): Dodge and Drop at +3, or a sacrificial dive onto the explosive when
 *   within a step (B377, contact explosion B415). Results go to the GM's card.
 * - "Incoming!" for a direct hit on a token: the target may Dodge (or Dodge and Drop). A success sends
 *   the explosive off by the defender's margin of success (B414 Scatter); a failure means it struck him.
 * The rolls go through upstream's Dodge action (performAndCapture), with the defense feature's modifiers.
 */
import { isStunned } from '../defense/flow.ts'
import {
  canControl,
  currentManeuver,
  gmIds,
  inActiveCombat,
  parseOtf,
  performAndCapture,
  playerOwnerIds,
  resolveTokenDoc,
  unique,
  type RollResult,
} from '../defense/foundry-helpers.ts'
import { defenseModifiers } from '../defense/rules.ts'
import { getExplosionFlag, submitBlastEvent, TEMPLATES } from './card.ts'
import { facing } from './command-parse.ts'
import { rollD6 } from './dice.ts'
import { localize } from './i18n.ts'
import { scatter } from './rules.ts'
import { foundryRng, measureYards, scatterPoint, sceneOf, tokenCenter } from './scene.ts'
import { toGM } from './socket.ts'
import type { BlastCardFlag, BlastRequest, DivePromptFlag, IncomingFlag, TokenRef } from './types.ts'
import { deriveRow } from './resolve.ts'

const FLAG = 'agency.explosion'

async function render(path: string, data: object): Promise<string> {
  return (foundry.applications as any).handlebars.renderTemplate(path, data)
}

/* ------------------------------------------------------------------ */
/* Rolling a dodge                                                     */
/* ------------------------------------------------------------------ */

/** Upstream's 'use-tagged-modifiers' setting (lib/miscellaneous-settings.js; not imported, it pulls in the sheets). */
function taggedModifiersAutoAdd(): boolean {
  try {
    return !!(game.settings as any).get('gurps', 'use-tagged-modifiers')?.autoAdd
  } catch {
    return false
  }
}

/**
 * Roll the actor's Dodge through upstream's action, with Dodge and Drop's +3 when `drop` (B377) and the
 * defense feature's stun / maneuver modifiers. Returns null if nothing was rolled.
 */
export async function rollDodge(
  actor: any,
  tokenDoc: any,
  drop: boolean,
  event: Event | null
): Promise<RollResult | null> {
  const mods = defenseModifiers(
    {
      attack: { kind: 'ranged', thrown: true, firearm: false },
      defense: 'dodge',
      fencing: false,
      stunned: isStunned(actor.statuses ?? []),
      cantSee: false,
      deceptivePenalty: 0,
      maneuver: inActiveCombat(tokenDoc) ? currentManeuver(actor) : 'do_nothing',
      includeManeuverAndStatus: !taggedModifiersAutoAdd(),
    },
    { dodgeAndDrop: drop }
  )
  const action = parseOtf('Dodge')
  if (!action) return null
  const stack = (GURPS.ModifierBucket as any).modifierStack
  const saved = [...(stack?.modifierList ?? [])]
  const i18n = game.i18n as any
  for (const mod of mods) GURPS.ModifierBucket.addModifier(String(mod.mod), i18n.localize(mod.key) + (mod.suffix ?? ''))
  const result = await performAndCapture(action, actor, event)
  if (!result) {
    stack?.reset(saved)
    GURPS.ModifierBucket.refresh()
  }
  return result
}

/** B377: dodge and drop leaves you prone, whether or not it worked. */
async function goProne(actor: any): Promise<void> {
  try {
    if (!actor?.statuses?.has?.('prone')) await actor.toggleStatusEffect('prone', { active: true })
  } catch (err) {
    console.warn('GURPS | Agency | explosions: could not set prone', err)
  }
}

/* ------------------------------------------------------------------ */
/* Dive for cover                                                      */
/* ------------------------------------------------------------------ */

export async function renderPrompt(flag: DivePromptFlag | IncomingFlag): Promise<string> {
  if (flag.kind === 'dive-prompt') {
    const result =
      flag.status === 'success'
        ? flag.smother
          ? localize('dive.smother', { margin: flag.margin })
          : localize('dive.success', { margin: flag.margin }) + (flag.coverStep ? ` ${localize('dive.toCover')}` : '')
        : flag.status === 'failure'
          ? localize('dive.failure', { margin: Math.abs(flag.margin) })
          : flag.status === 'declined'
            ? localize('dive.declined')
            : flag.status === 'none'
              ? localize('dive.tooLate')
              : ''
    return render(TEMPLATES.prompt, {
      dive: true,
      title: localize('prompt.title'),
      body: localize('prompt.body', { label: flag.label, yards: flag.distance, name: flag.name }),
      awaiting: flag.status === 'pending',
      canSmother: flag.canSmother,
      result,
      good: flag.status === 'success',
      bad: flag.status === 'failure',
    })
  }
  const result =
    flag.status === 'dodged'
      ? localize('incoming.dodged', { margin: flag.margin })
      : flag.status === 'struck'
        ? localize('incoming.struck')
        : ''
  return render(TEMPLATES.prompt, {
    incoming: true,
    title: localize('incoming.title'),
    body: localize('incoming.body', {
      attacker: flag.request.attacker?.name ?? '?',
      label: flag.request.label,
      name: flag.target.name,
    }),
    awaiting: flag.status === 'awaiting',
    result,
    good: flag.status === 'dodged',
    bad: flag.status === 'struck',
  })
}

/** GM: whisper a dive prompt to the players of every character caught who may dive. */
export async function postDivePrompts(message: any, flag: BlastCardFlag): Promise<void> {
  const scene = sceneOf(flag.request.sceneId)
  const prompts: Record<string, string> = {}
  for (const row of flag.state.rows) {
    if (row.dive.status !== 'pending' || flag.meta[row.facts.id]?.npc) continue
    const tokenDoc = scene?.tokens?.get(row.facts.id)
    const owners = playerOwnerIds(tokenDoc?.actor)
    if (!owners.length) continue
    const d = deriveRow(flag.state, row)
    const prompt: DivePromptFlag = {
      kind: 'dive-prompt',
      blastMessageId: message.id,
      sceneId: flag.request.sceneId,
      tokenId: row.facts.id,
      actorId: tokenDoc?.actor?.id ?? null,
      name: row.facts.name,
      label: flag.request.label,
      distance: row.facts.distance,
      canSmother: d.canSmother,
      status: 'pending',
      margin: 0,
      coverStep: false,
      smother: false,
    }
    const created = await (ChatMessage as any).create({
      content: await renderPrompt(prompt),
      whisper: unique([...owners, ...gmIds()]),
      speaker: { alias: localize('card.speaker') },
      flags: { gurps: { agency: { explosion: prompt } } },
    })
    if (created) prompts[row.facts.id] = created.id
  }
  if (Object.keys(prompts).length) await message.update({ [`flags.gurps.${FLAG}.prompts`]: prompts })
}

/**
 * Roll a dive for the token on this client (its player, or the GM for an NPC) and report it to the
 * GM's card. `smother`: a sacrificial dodge and drop onto the explosive (B377).
 */
export async function diveFor(
  blastMessageId: string,
  flag: BlastCardFlag | null,
  tokenId: string,
  opts: { coverStep: boolean; smother: boolean; event: Event | null; sceneId?: string }
): Promise<void> {
  const scene = sceneOf(flag?.request.sceneId ?? opts.sceneId)
  const tokenDoc = scene?.tokens?.get(tokenId)
  const actor = tokenDoc?.actor
  if (!actor) return void ui.notifications?.warn(localize('warn.noActor'))
  const result = await rollDodge(actor, tokenDoc, true, opts.event)
  if (!result) return
  await goProne(actor)
  await submitBlastEvent(blastMessageId, {
    kind: 'dive',
    tokenId,
    status: result.failure ? 'failure' : 'success',
    margin: result.margin,
    coverStep: !opts.smother && opts.coverStep,
    smother: opts.smother,
  })
}

const busy = new Set<string>()

function decorateDivePrompt(message: any, html: HTMLElement, flag: DivePromptFlag): void {
  const root = html.querySelector<HTMLElement>('[data-agency-card="explosion-prompt"]')
  const controls = root?.querySelector<HTMLElement>('[data-boom-controls]')
  if (!root || !controls) return
  const tokenDoc = sceneOf(flag.sceneId)?.tokens?.get(flag.tokenId)
  if (flag.status !== 'pending' || !canControl(tokenDoc?.actor)) {
    controls.remove()
    return
  }
  const click = (action: string, handler: (event: Event) => Promise<void>) =>
    controls.querySelector<HTMLButtonElement>(`[data-boom-action="${action}"]`)?.addEventListener('click', event => {
      event.preventDefault()
      if (busy.has(message.id)) return
      busy.add(message.id)
      controls.classList.add('is-busy')
      handler(event)
        .catch(err => console.error('GURPS | Agency | dive prompt', err))
        .finally(() => {
          busy.delete(message.id)
          controls.classList.remove('is-busy')
        })
    })
  const coverStep = () => !!controls.querySelector<HTMLInputElement>('input[name="coverStep"]')?.checked
  click('dive', event =>
    diveFor(flag.blastMessageId, null, flag.tokenId, {
      coverStep: coverStep(),
      smother: false,
      event,
      sceneId: flag.sceneId,
    })
  )
  click('smother', event =>
    diveFor(flag.blastMessageId, null, flag.tokenId, { coverStep: false, smother: true, event, sceneId: flag.sceneId })
  )
  click('stay', () =>
    submitBlastEvent(flag.blastMessageId, {
      kind: 'dive',
      tokenId: flag.tokenId,
      status: 'declined',
      margin: 0,
      coverStep: false,
      smother: false,
    })
  )
}

/* ------------------------------------------------------------------ */
/* Incoming (direct hit on a token)                                    */
/* ------------------------------------------------------------------ */

export async function postIncoming(
  request: BlastRequest,
  target: TokenRef,
  attackerCenter: IncomingFlag['attackerCenter']
): Promise<void> {
  const tokenDoc = resolveTokenDoc(target)
  const flag: IncomingFlag = {
    kind: 'incoming',
    request,
    target,
    attackerCenter,
    status: 'awaiting',
    margin: 0,
    dropped: false,
  }
  await (ChatMessage as any).create({
    content: await renderPrompt(flag),
    whisper: unique([...playerOwnerIds(tokenDoc?.actor), ...gmIds(), game.user?.id]),
    speaker: { alias: localize('card.speaker') },
    flags: { gurps: { agency: { explosion: flag } } },
  })
}

function decorateIncoming(message: any, html: HTMLElement, flag: IncomingFlag): void {
  const root = html.querySelector<HTMLElement>('[data-agency-card="explosion-prompt"]')
  const controls = root?.querySelector<HTMLElement>('[data-boom-controls]')
  if (!root || !controls) return
  const tokenDoc = resolveTokenDoc(flag.target)
  if (flag.status !== 'awaiting' || !canControl(tokenDoc?.actor)) {
    controls.remove()
    return
  }
  const run = (handler: (event: Event) => Promise<void>) => (event: Event) => {
    event.preventDefault()
    if (busy.has(message.id)) return
    busy.add(message.id)
    controls.classList.add('is-busy')
    handler(event)
      .catch(err => console.error('GURPS | Agency | incoming prompt', err))
      .finally(() => {
        busy.delete(message.id)
        controls.classList.remove('is-busy')
      })
  }
  const dodge = (drop: boolean) => async (event: Event) => {
    const actor = tokenDoc?.actor
    if (!actor) return
    const result = await rollDodge(actor, tokenDoc, drop, event)
    if (!result) return
    if (drop) await goProne(actor)
    await toGM('incoming', { messageId: message.id, dodged: !result.failure, margin: result.margin, dropped: drop })
  }
  controls.querySelector('[data-boom-action="dodge"]')?.addEventListener('click', run(dodge(false)))
  controls.querySelector('[data-boom-action="dodge-drop"]')?.addEventListener('click', run(dodge(true)))
  controls.querySelector('[data-boom-action="no-defense"]')?.addEventListener(
    'click',
    run(() => toGM('incoming', { messageId: message.id, dodged: false, margin: 0, dropped: false }).then(() => {}))
  )
}

/**
 * GM: the defender answered. B414: a dodge sends the explosive off by the defender's margin of
 * success, in a direction rolled on 1d from the attacker's facing; otherwise it struck him.
 */
export async function onIncomingResult(data: {
  messageId: string
  dodged: boolean
  margin: number
  dropped: boolean
}): Promise<void> {
  const message = (game.messages as any)?.get(data.messageId)
  const flag = getExplosionFlag(message)
  if (!message || flag?.kind !== 'incoming' || flag.status !== 'awaiting') return
  const next: IncomingFlag = {
    ...flag,
    status: data.dodged ? 'dodged' : 'struck',
    margin: data.margin,
    dropped: data.dropped,
  }
  try {
    await message.update({ content: await renderPrompt(next), [`flags.gurps.${FLAG}`]: next })
  } catch (err) {
    // Only the author or a GM may update it; with no GM online the explosion still goes off.
    console.warn('GURPS | Agency | explosions: could not update the incoming card', err)
  }

  let request = flag.request
  if (data.dodged) {
    const scene = sceneOf(request.sceneId)
    const targetDoc = resolveTokenDoc(flag.target)
    const from = targetDoc ? tokenCenter(targetDoc) : request.center
    const attackerAt = flag.attackerCenter ?? from
    const s = scatter({
      dodgeMargin: data.margin,
      distanceToTarget: flag.attackerCenter ? measureYards(attackerAt, from, scene) : 1000,
      directionRoll: rollD6(foundryRng()),
    })
    request = {
      ...request,
      struckTokenId: null,
      center: s.yards > 0 ? scatterPoint(from, facing(attackerAt, from), s.degrees, s.yards) : from,
      scatter: { yards: s.yards, direction: s.direction, from, dodged: true },
    }
  }
  const { detonate } = await import('./detonate.ts')
  await detonate(request)
}

/* ------------------------------------------------------------------ */
/* Rendering hook                                                      */
/* ------------------------------------------------------------------ */

export function decoratePrompt(message: any, html: HTMLElement): void {
  const flag = getExplosionFlag(message)
  if (flag?.kind === 'dive-prompt') decorateDivePrompt(message, html, flag)
  else if (flag?.kind === 'incoming') decorateIncoming(message, html, flag)
}
