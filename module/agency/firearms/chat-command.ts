/**
 * Chat commands for the selected character (GURPS.LastActor, as the upstream commands use):
 *   /reload                   reload the weapon fired last, or the only one that isn't full
 *   /reload <weapon>          reload a weapon by name, "name (usage)" or the start of either
 *   /reload change [<weapon>] choose which carried magazine (or partial magazine) to load
 *                             (also /reload -c); without a name, the weapon fired last
 *   /ammo                     list rounds loaded and spare ammunition (whispered to you)
 * All work in OtF buttons and macros: ["Reload"/reload Glock].
 */
import ChatProcessor from '../../chat/chat-processor.js'
import { getAgencySetting } from '../settings.ts'
import { matchWeapons } from './ammo.ts'
import { L10N, SETTING_TRACKING } from './constants.ts'
import { asAmmoActor, lastFiredId } from './firing.ts'
import { changeMagazine, escapeHtml, loadedText, reloadWeapon, spareSummary } from './reload.ts'
import { formatRounds, fullLoad, isTracked } from './shots.ts'
import { feedViews, weaponViews, type AmmoActor, type WeaponView } from './state.ts'

const localize = (key: string) => game.i18n?.localize(key) ?? key
const format = (key: string, data: Record<string, unknown>) =>
  game.i18n?.format(`${L10N}.${key}`, data as Record<string, string>) ?? key

function selectedActor(): AmmoActor | undefined {
  const actor = asAmmoActor((GURPS as any).LastActor)
  if (!actor) ui.notifications?.warn(localize('GURPS.chatYouMustHaveACharacterSelected'))
  return actor
}

function trackingOff(): boolean {
  if (getAgencySetting<boolean>(SETTING_TRACKING)) return false
  ui.notifications?.warn(localize(`${L10N}.trackingOff`))
  return true
}

function trackedViews(actor: AmmoActor): WeaponView[] {
  return weaponViews(actor).filter(v => isTracked(v.spec))
}

function describe(actor: AmmoActor, view: WeaponView): string {
  const extra = [loadedText(view), spareSummary(actor, view)].filter(Boolean).join('; ')
  return `<b>${escapeHtml(view.label)}</b>: ${formatRounds(view.loaded, view.spec)}${extra ? ` (${escapeHtml(extra)})` : ''}`
}

/** One view per feed, keeping the order of first appearance. */
function uniqueFeeds(views: WeaponView[]): WeaponView[] {
  const seen = new Set<string>()
  return views.filter(v => (seen.has(v.id) ? false : (seen.add(v.id), true)))
}

/**
 * Pick the weapon a /reload means, or explain why it can't. Usages sharing a magazine count once.
 * `anyLoad`: also consider full weapons (changing magazines works on a full gun).
 */
export function chooseWeapon(
  views: WeaponView[],
  query: string,
  lastFired: string | undefined,
  anyLoad = false
): { view?: WeaponView; reason?: 'noMatch' | 'ambiguous' | 'allFull'; candidates: WeaponView[] } {
  if (query) {
    const hits = matchWeapons(
      views.map(v => ({ path: v.path, value: v.weapon })),
      query
    )
    const matched = uniqueFeeds(views.filter(v => hits.some(h => h.path === v.path)))
    if (matched.length === 0) return { reason: 'noMatch', candidates: uniqueFeeds(views) }
    if (matched.length === 1) return { view: matched[0], candidates: matched }
    // Several modes of one weapon share a name: prefer one that needs rounds.
    const needing = matched.filter(v => v.loaded < fullLoad(v.spec))
    if (needing.length === 1) return { view: needing[0], candidates: matched }
    return { reason: 'ambiguous', candidates: matched }
  }

  const notFull = uniqueFeeds(views.filter(v => anyLoad || v.loaded < fullLoad(v.spec)))
  const last = notFull.find(v => v.id === lastFired)
  if (last) return { view: last, candidates: [last] }
  if (notFull.length === 0) return { reason: 'allFull', candidates: uniqueFeeds(views) }
  if (notFull.length === 1) return { view: notFull[0], candidates: notFull }
  return { reason: 'ambiguous', candidates: notFull }
}

export class ReloadChatProcessor extends ChatProcessor {
  private query = ''
  private change = false

  override help() {
    return '/reload [change] [&lt;weapon&gt;]'
  }

  override matches(line: string) {
    const match = line.match(/^\/reload(?:\s+(.*))?$/i)
    let query = match?.[1]?.trim() ?? ''
    const change = query.match(/^(?:change|-c)(?:\s+(.*))?$/i)
    if (change) query = change[1]?.trim() ?? ''
    this.change = !!change
    this.query = query
    return !!match
  }

  override async process(_line: string) {
    if (trackingOff()) return false
    const actor = selectedActor()
    if (!actor) return false

    const views = trackedViews(actor)
    if (views.length === 0) {
      this.priv(format('chat.noTracked', { actor: escapeHtml(actor.name) }))
      return false
    }

    const choice = chooseWeapon(views, this.query, lastFiredId(actor), this.change)
    if (choice.view) return this.change ? changeMagazine(actor, choice.view) : reloadWeapon(actor, choice.view)

    if (choice.reason === 'noMatch') this.priv(format('chat.noMatch', { name: escapeHtml(this.query) }))
    else if (choice.reason === 'allFull') this.priv(format('chat.allFull', { actor: escapeHtml(actor.name) }))
    else this.priv(format('chat.ambiguous', {}))
    for (const view of choice.candidates) this.priv(describe(actor, view))
    return false
  }
}

export class AmmoChatProcessor extends ChatProcessor {
  override help() {
    return '/ammo'
  }

  override matches(line: string) {
    return /^\/ammo\s*$/i.test(line)
  }

  override async process(_line: string) {
    if (trackingOff()) return false
    const actor = selectedActor()
    if (!actor) return false
    const views = feedViews(actor).filter(v => isTracked(v.spec))
    if (views.length === 0) {
      this.priv(format('chat.noTracked', { actor: escapeHtml(actor.name) }))
      return false
    }
    this.priv(format('chat.ammoHeader', { actor: escapeHtml(actor.name) }))
    for (const view of views) this.priv(describe(actor, view))
    return true
  }
}
