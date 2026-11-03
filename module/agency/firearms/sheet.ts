/**
 * Rounds display + reload button on actor sheets, injected on render (no template edits):
 *  - Full (GCS) sheet and the sheets sharing its ranged partial: inside each row's Shots cell.
 *    Rows are identified by the data-key on the row's Usage cell (system.ranged.<key>).
 *  - Modern / NPC modern sheets: in the name cell of each ranged attack row.
 *    Rows are identified by the data-key on the row's edit action.
 * Click the reload icon to reload; right-click the badge for the per-weapon ammo dialog.
 */
import { getAgencySetting } from '../settings.ts'
import { findThrownItem, weaponLabel } from './ammo.ts'
import { L10N, SETTING_THROWN, SETTING_TRACKING } from './constants.ts'
import { asAmmoActor } from './firing.ts'
import { ammoSource, configureWeapon, escapeHtml, reloadWeapon, spareText } from './reload.ts'
import { formatRounds, fullLoad, isTracked } from './shots.ts'
import { allEquipment, findViewByPath, type AmmoActor, type WeaponView } from './state.ts'

const localize = (key: string) => game.i18n?.localize(`${L10N}.${key}`) ?? key
const format = (key: string, data: Record<string, unknown>) =>
  game.i18n?.format(`${L10N}.${key}`, data as Record<string, string>) ?? key

function rootElement(html: unknown): HTMLElement | undefined {
  if (html instanceof HTMLElement) return html
  const first = (html as ArrayLike<unknown> | undefined)?.[0]
  return first instanceof HTMLElement ? first : undefined
}

export function onRenderActorSheet(app: { actor?: unknown }, html: unknown): void {
  try {
    if (!getAgencySetting<boolean>(SETTING_TRACKING)) return
    const actor = asAmmoActor(app?.actor)
    const root = rootElement(html)
    if (!actor || !root || !actor.isOwner) return

    // Full (GCS) sheet: the Shots cell follows the Usage cell in the same grid row.
    for (const usage of root.querySelectorAll<HTMLElement>('#ranged .usage[data-key^="system.ranged."]')) {
      let cell = usage.nextElementSibling
      while (cell && !cell.classList.contains('shots') && !cell.classList.contains('itemmenu'))
        cell = cell.nextElementSibling
      if (!cell?.classList.contains('shots')) continue
      const widget = buildWidget(actor, usage.dataset.key!)
      if (!widget) continue
      cell.classList.add('agency-ammo-cell')
      cell.append(widget)
    }

    // Modern sheets.
    for (const row of root.querySelectorAll<HTMLElement>('.ms-ranged-attacks .ms-attack-row')) {
      const path = row.querySelector<HTMLElement>('[data-action="edit-ranged"][data-key]')?.dataset.key
      const nameCell = row.querySelector<HTMLElement>('.ms-attack-name')
      if (!path || !nameCell) continue
      const widget = buildWidget(actor, path)
      if (!widget) continue
      nameCell.classList.add('agency-ammo-host')
      nameCell.append(widget)
    }
  } catch (err) {
    console.error('GURPS | Agency firearms: could not draw ammunition on the sheet', err)
  }
}

function buildWidget(actor: AmmoActor, path: string): HTMLElement | null {
  const view = findViewByPath(actor, path)
  if (!view) return null
  if (isTracked(view.spec)) return roundsWidget(actor, view)
  if (view.spec.thrown && getAgencySetting<boolean>(SETTING_THROWN)) return thrownWidget(actor, view)
  return null
}

function roundsWidget(actor: AmmoActor, view: WeaponView): HTMLElement {
  const full = fullLoad(view.spec)
  const badge = document.createElement('span')
  badge.className = 'agency-ammo agency-badge'
  if (view.loaded <= 0) badge.classList.add('agency-ammo-empty')
  else if (view.loaded <= full / 4) badge.classList.add('agency-ammo-low')
  badge.dataset.agencyAmmo = view.id

  const spare = spareText(ammoSource(actor, view))
  badge.dataset.tooltipHtml = [weaponLabel(view.weapon), spare, localize('configureHint')]
    .filter(Boolean)
    .map(escapeHtml)
    .join('<br>')

  const count = document.createElement('span')
  count.className = 'agency-ammo-count'
  count.textContent = formatRounds(view.loaded, view.spec)
  badge.append(count)

  const reload = document.createElement('a')
  reload.className = 'agency-ammo-reload'
  reload.setAttribute('role', 'button')
  reload.setAttribute('aria-label', localize('reload'))
  reload.dataset.tooltipText =
    view.spec.reloadSeconds > 0
      ? format(view.spec.individual ? 'reloadOneTooltip' : 'reloadTooltip', { seconds: view.spec.reloadSeconds })
      : localize('reload')
  reload.innerHTML = '<i class="fa-solid fa-rotate-right"></i>'
  if (view.loaded >= full) reload.classList.add('agency-ammo-full')
  badge.append(reload)

  const path = view.path
  const fresh = () => findViewByPath(actor, path)

  reload.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    const current = fresh()
    if (current) void reloadWeapon(actor, current)
  })
  // Keep the sheet's own row handlers (roll, expand, drag) away from the badge.
  badge.addEventListener('click', event => event.stopPropagation())
  badge.addEventListener('dblclick', event => event.stopPropagation())
  badge.addEventListener('contextmenu', event => {
    event.preventDefault()
    event.stopPropagation()
    const current = fresh()
    if (current) void configureWeapon(actor, current)
  })
  return badge
}

function thrownWidget(actor: AmmoActor, view: WeaponView): HTMLElement | null {
  const item = findThrownItem(allEquipment(actor), view.weapon)
  if (!item) return null
  const badge = document.createElement('span')
  badge.className = 'agency-ammo agency-badge'
  if (item.count <= 0) badge.classList.add('agency-ammo-empty')
  badge.dataset.tooltipText = format('thrownTooltip', { item: item.name, count: item.count })
  badge.textContent = `×${item.count}`
  return badge
}
