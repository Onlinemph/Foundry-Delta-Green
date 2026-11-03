/**
 * Chat commands for the selected character (GURPS.LastActor):
 *   /ready             list weapons and how they are carried (whispered to you)
 *   /ready <weapon>    ready a weapon (in combat: the Ready / Fast-Draw choice)
 *   /holster [<weapon>] put a weapon away in its carry state; no name: every weapon in hand
 * Weapons are matched by equipment name or attack name, exact first, then start, then anywhere.
 */
import ChatProcessor from '../../chat/chat-processor.js'
import { escapeHtml } from '../firearms/reload.ts'
import {
  format,
  isActorsTurn,
  isInCombat,
  localize,
  postNote,
  readyWeapon,
  stateLabel,
  takeReadyManeuver,
} from './actions.ts'
import { holsterState, type ReadyState } from './rules.ts'
import {
  asReadinessActor,
  readinessEnabled,
  readyViews,
  setStates,
  type ReadinessActor,
  type ReadyView,
} from './state.ts'

const normalize = (text: unknown) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** Weapons matching a query: exact, then prefix, then substring, on the equipment name or any attack's name / "name (usage)". */
export function matchReadyViews(views: ReadyView[], query: string): ReadyView[] {
  const wanted = normalize(query)
  if (!wanted) return []
  const labels = (v: ReadyView) => [
    normalize(v.weapon.name),
    ...v.weapon.entries.flatMap(e => [
      normalize(e.value.name),
      normalize(e.value.mode ? `${e.value.name} (${e.value.mode})` : e.value.name),
    ]),
  ]
  const tiers = [(l: string) => l === wanted, (l: string) => l.startsWith(wanted), (l: string) => l.includes(wanted)]
  for (const test of tiers) {
    const hits = views.filter(v => labels(v).some(test))
    if (hits.length) return hits
  }
  return []
}

function selectedActor(): ReadinessActor | undefined {
  const actor = asReadinessActor((GURPS as any).LastActor)
  if (!actor) ui.notifications?.warn(game.i18n?.localize('GURPS.chatYouMustHaveACharacterSelected') ?? '')
  return actor
}

function describe(view: ReadyView): string {
  return `<b>${escapeHtml(view.weapon.name)}</b>: ${escapeHtml(stateLabel(view.state))}`
}

abstract class ReadinessProcessor extends ChatProcessor {
  protected query = ''

  /** Common checks; returns the actor and its weapons, or undefined after explaining why not. */
  protected start(): { actor: ReadinessActor; views: ReadyView[] } | undefined {
    if (!readinessEnabled()) {
      ui.notifications?.warn(localize('off'))
      return undefined
    }
    const actor = selectedActor()
    if (!actor) return undefined
    const views = readyViews(actor)
    if (!views.length) {
      this.priv(format('chat.noWeapons', { actor: escapeHtml(actor.name) }))
      return undefined
    }
    return { actor, views }
  }

  protected pick(views: ReadyView[], wanted: ReadyView[]): ReadyView | undefined {
    if (wanted.length === 1) return wanted[0]
    this.priv(wanted.length ? format('chat.ambiguous', {}) : format('chat.noMatch', { name: escapeHtml(this.query) }))
    for (const view of wanted.length ? wanted : views) this.priv(describe(view))
    return undefined
  }
}

export class ReadyChatProcessor extends ReadinessProcessor {
  override help() {
    return '/ready [&lt;weapon&gt;]'
  }

  override matches(line: string) {
    const match = line.match(/^\/ready(?:\s+(.*))?$/i)
    this.query = match?.[1]?.trim() ?? ''
    return !!match
  }

  override async process(_line: string) {
    const found = this.start()
    if (!found) return false
    const { actor, views } = found
    if (!this.query) {
      this.priv(format('chat.header', { actor: escapeHtml(actor.name) }))
      for (const view of views) this.priv(describe(view))
      return true
    }
    const view = this.pick(views, matchReadyViews(views, this.query))
    if (!view) return false
    return readyWeapon(actor, view)
  }
}

export class HolsterChatProcessor extends ReadinessProcessor {
  override help() {
    return '/holster [&lt;weapon&gt;]'
  }

  override matches(line: string) {
    const match = line.match(/^\/holster(?:\s+(.*))?$/i)
    this.query = match?.[1]?.trim() ?? ''
    return !!match
  }

  override async process(_line: string) {
    const found = this.start()
    if (!found) return false
    const { actor, views } = found
    let targets: ReadyView[]
    if (this.query) {
      const view = this.pick(views, matchReadyViews(views, this.query))
      if (!view) return false
      targets = [view]
    } else {
      targets = views.filter(v => v.state === 'ready' && holsterState(v.carry) !== v.state)
      if (!targets.length) {
        this.priv(format('chat.nothingInHand', { actor: escapeHtml(actor.name) }))
        return false
      }
    }

    const changes: Record<string, ReadyState> = {}
    for (const view of targets) changes[view.weapon.id] = holsterState(view.carry)
    await setStates(actor, changes)
    // Putting a weapon away is a Ready maneuver in combat (B383).
    const maneuver = isInCombat(actor) && isActorsTurn(actor) ? await takeReadyManeuver(actor) : false
    await postNote(
      actor,
      targets.map(v =>
        format(maneuver ? 'note.holsterManeuver' : 'note.holster', {
          weapon: escapeHtml(v.weapon.name),
          state: escapeHtml(stateLabel(changes[v.weapon.id])),
        })
      )
    )
    return true
  }
}
