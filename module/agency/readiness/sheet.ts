/**
 * Readiness icon on each weapon row, injected on render (no template edits), as the firearms rounds
 * badge is:
 *  - Full (GCS) sheet and the sheets sharing its melee / ranged partials: at the start of the name cell
 *    (.meleedraggable / .rangeddraggable carry the row's data-key).
 *  - Modern / NPC modern sheets: at the start of the name cell; the row's data-key sits on its edit action.
 * Click: next state (ready, holstered, slung, stowed, dropped). Right-click: the weapon's carry state and
 * Fast-Draw specialty. Only weapons that come from equipment get an icon.
 */
import { escapeHtml } from '../firearms/reload.ts'
import { READY_STATES, WEAPON_SPECIALTIES, nextState, type ReadyState } from './rules.ts'
import { format, localize, stateLabel } from './actions.ts'
import {
  asReadinessActor,
  readinessEnabled,
  readyViews,
  saveSettings,
  setState,
  viewById,
  type ReadinessActor,
  type ReadyView,
} from './state.ts'

const CONFIG_TEMPLATE = 'systems/gurps/templates/agency/readiness-config.hbs'

export const STATE_ICONS: Record<ReadyState, string> = {
  ready: 'fa-hand-back-fist',
  holstered: 'fa-circle-down',
  slung: 'fa-arrows-up-down',
  stowed: 'fa-suitcase',
  dropped: 'fa-arrow-down-long',
}

function rootElement(html: unknown): HTMLElement | undefined {
  if (html instanceof HTMLElement) return html
  const first = (html as ArrayLike<unknown> | undefined)?.[0]
  return first instanceof HTMLElement ? first : undefined
}

export function onRenderActorSheet(app: { actor?: unknown }, html: unknown): void {
  try {
    if (!readinessEnabled()) return
    const actor = asReadinessActor(app?.actor)
    const root = rootElement(html)
    if (!actor || !root) return
    const views = readyViews(actor)
    if (!views.length) return
    const byPath = new Map<string, ReadyView>()
    for (const view of views) for (const entry of view.weapon.entries) byPath.set(entry.path, view)

    // Full (GCS) sheet.
    for (const row of root.querySelectorAll<HTMLElement>(
      '#melee .meleedraggable[data-key^="system.melee."], #ranged .rangeddraggable[data-key^="system.ranged."]'
    )) {
      const view = byPath.get(row.dataset.key!)
      const host = row.querySelector<HTMLElement>('.gga-desc-text') ?? row.querySelector<HTMLElement>('.desc')
      if (!view || !host) continue
      host.prepend(buildIcon(actor, view))
    }

    // Modern sheets.
    for (const row of root.querySelectorAll<HTMLElement>(
      '.ms-melee-attacks .ms-attack-row, .ms-ranged-attacks .ms-attack-row'
    )) {
      const path = row.querySelector<HTMLElement>(
        '[data-action="edit-melee"][data-key], [data-action="edit-ranged"][data-key]'
      )?.dataset.key
      const view = path ? byPath.get(path) : undefined
      const host = row.querySelector<HTMLElement>('.ms-attack-name')
      if (!view || !host) continue
      host.classList.add('agency-ready-host')
      host.prepend(buildIcon(actor, view))
    }
  } catch (err) {
    console.error('GURPS | Agency readiness: could not draw readiness icons', err)
  }
}

function buildIcon(actor: ReadinessActor, view: ReadyView): HTMLElement {
  const icon = document.createElement('a')
  icon.className = `agency-ready agency-ready--${view.state}`
  icon.dataset.agencyReady = view.weapon.id
  icon.setAttribute('role', 'button')
  icon.setAttribute('aria-label', `${view.weapon.name}: ${stateLabel(view.state)}`)
  icon.innerHTML = `<i class="fa-solid ${STATE_ICONS[view.state]}"></i>`
  const lines = [
    `<strong>${escapeHtml(view.weapon.name)}</strong>: ${escapeHtml(stateLabel(view.state))}`,
    escapeHtml(format('tooltip.carry', { state: stateLabel(view.carry) })),
    escapeHtml(
      view.specialty ? format('tooltip.fastDraw', { specialty: view.specialty }) : localize('tooltip.noFastDraw')
    ),
  ]
  if (actor.isOwner) lines.push(escapeHtml(localize('tooltip.hint')))
  icon.dataset.tooltipHtml = lines.join('<br>')

  // Keep the sheet's own row handlers (roll, edit, drag) away from the icon.
  for (const type of ['dblclick', 'mousedown', 'dragstart'])
    icon.addEventListener(type, event => event.stopPropagation())
  icon.setAttribute('draggable', 'false')
  if (!actor.isOwner) {
    icon.classList.add('is-readonly')
    icon.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
    })
    return icon
  }

  icon.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    const current = viewById(actor, view.weapon.id)
    if (current) void setState(actor, current.weapon.id, nextState(current.state))
  })
  icon.addEventListener('contextmenu', event => {
    event.preventDefault()
    event.stopPropagation()
    const current = viewById(actor, view.weapon.id)
    if (current) void configureReadiness(actor, current)
  })
  return icon
}

/** Right-click dialog: state now, default carry state, Fast-Draw specialty. */
export async function configureReadiness(actor: ReadinessActor, view: ReadyView): Promise<void> {
  const states = Object.fromEntries(READY_STATES.map(s => [s, stateLabel(s)]))
  const content = await foundry.applications.handlebars.renderTemplate(CONFIG_TEMPLATE, {
    weapon: view.weapon.name,
    state: view.state,
    states,
    carry: view.stored.carry ?? '',
    carryStates: {
      '': format('config.auto', { value: stateLabel(view.carry) }),
      ...Object.fromEntries(READY_STATES.filter(s => s !== 'dropped').map(s => [s, stateLabel(s)])),
    },
    fastDraw: view.stored.fastDraw ?? '',
    specialties: {
      '': format('config.auto', { value: view.specialty ?? localize('config.none') }),
      ...Object.fromEntries(WEAPON_SPECIALTIES.map(s => [s, s])),
      none: localize('config.none'),
    },
  })
  const result = (await (foundry.applications.api.DialogV2 as any).prompt({
    window: { title: format('config.title', { weapon: view.weapon.name }), icon: 'fa-solid fa-hand-back-fist' },
    classes: ['agency-readiness-dialog'],
    content,
    rejectClose: false,
    ok: {
      label: localize('config.save'),
      callback: (_event: Event, button: HTMLButtonElement) => {
        const elements = button.form!.elements as any
        return {
          state: String(elements.state?.value ?? ''),
          carry: String(elements.carry?.value ?? ''),
          fastDraw: String(elements.fastDraw?.value ?? ''),
        }
      },
    },
  })) as { state: string; carry: string; fastDraw: string } | null
  if (!result) return
  await saveSettings(actor, view.weapon.id, {
    state: (READY_STATES as readonly string[]).includes(result.state) ? (result.state as ReadyState) : view.state,
    carry: (result.carry || undefined) as ReadyState | undefined,
    fastDraw: (result.fastDraw || undefined) as any,
  })
}
