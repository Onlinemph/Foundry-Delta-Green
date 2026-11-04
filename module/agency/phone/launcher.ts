/**
 * The floating phone button. Players: shown when they own an agent with a device; unread badge;
 * buzzes on arrivals; opens the phone (or a picker when there are several). GMs: opens the Handler
 * console, with a badge for texts to NPC numbers. Draggable; the position is remembered per client.
 */
import { buzzWindow, openPhone, phoneWindow, t } from './app.ts'
import { formatNumber } from './numbers.ts'
import { launcherOn, launcherPosition, npcIdentities, phoneEnabled, saveLauncherPosition } from './settings.ts'
import { playBuzz, playPing } from './sounds.ts'
import { myDevices, unlistedNumbers, unreadFor } from './store.ts'
import { arrivalText, onPhoneChange } from './sync.ts'
import type { DeviceId, PhoneMsg } from './types.ts'

const ID = 'agency-phone-launcher'
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
const PICKER = 'agency-phone-picker'

let openConsole: () => void = () => {}
export function setConsoleOpener(fn: () => void): void {
  openConsole = fn
}

function badgeCount(): number {
  if (game.user?.isGM) {
    return npcIdentities().reduce((n, npc) => n + unreadFor(`npc:${npc.id}`), 0) + unlistedNumbers().length
  }
  return myDevices().reduce((n, d) => n + unreadFor(d.id), 0)
}

function element(): HTMLElement | null {
  return document.getElementById(ID)
}

export function renderLauncher(): void {
  const show = phoneEnabled() && launcherOn() && (game.user?.isGM || myDevices().length > 0)
  let el = element()
  if (!show) {
    el?.remove()
    return
  }
  if (!el) el = create()
  const count = badgeCount()
  const badge = el.querySelector('.aph-launcher-badge') as HTMLElement
  badge.textContent = count ? String(count > 99 ? '99+' : count) : ''
}

function create(): HTMLElement {
  const el = document.createElement('div')
  el.id = ID
  el.className = game.user?.isGM ? 'is-gm' : ''
  el.setAttribute('role', 'button')
  el.setAttribute('tabindex', '0')
  const label = game.user?.isGM ? t('console.open') : t('openPhone')
  el.setAttribute('aria-label', label)
  el.dataset.tooltip = label
  el.innerHTML = `<i class="fa-solid ${game.user?.isGM ? 'fa-user-secret' : 'fa-mobile-screen-button'}"></i><span class="aph-launcher-badge"></span>`
  const pos = launcherPosition()
  if (typeof pos.left === 'number' && typeof pos.top === 'number') {
    el.style.left = `${Math.min(window.innerWidth - 50, Math.max(0, pos.left))}px`
    el.style.top = `${Math.min(window.innerHeight - 50, Math.max(0, pos.top))}px`
    el.style.bottom = 'auto'
  }
  let start: { x: number; y: number; left: number; top: number } | null = null
  let moved = false
  el.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return
    const rect = el.getBoundingClientRect()
    start = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top }
    moved = false
    el.setPointerCapture(ev.pointerId)
  })
  el.addEventListener('pointermove', ev => {
    if (!start) return
    const dx = ev.clientX - start.x
    const dy = ev.clientY - start.y
    if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return
    moved = true
    el.style.left = `${start.left + dx}px`
    el.style.top = `${start.top + dy}px`
    el.style.bottom = 'auto'
  })
  el.addEventListener('pointerup', () => {
    if (!start) return
    start = null
    if (moved) {
      const rect = el.getBoundingClientRect()
      void saveLauncherPosition({ left: Math.round(rect.left), top: Math.round(rect.top) })
      return
    }
    activate(el)
  })
  el.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      activate(el)
    }
  })
  document.body.appendChild(el)
  return el
}

function activate(anchor: HTMLElement): void {
  if (game.user?.isGM) {
    openConsole()
    return
  }
  openFromPicker(anchor)
}

/** Open the user's phone; with several, show a picker next to `anchor` (or centred). */
export function openFromPicker(anchor?: HTMLElement | null, filter?: (id: DeviceId) => boolean): void {
  const devices = myDevices().filter(d => !filter || filter(d.id))
  if (!devices.length) {
    ui.notifications?.warn(t('noPhone'))
    return
  }
  if (devices.length === 1) {
    openPhone(devices[0].id, { focus: true })
    return
  }
  document.getElementById(PICKER)?.remove()
  const picker = document.createElement('div')
  picker.id = PICKER
  picker.innerHTML = devices
    .map(d => {
      const unread = unreadFor(d.id)
      const icon = d.kind === 'burner' ? 'fa-mobile-retro' : 'fa-mobile-screen-button'
      return `<button type="button" data-device="${d.id}"><i class="fa-solid ${icon}"></i><span><b>${esc(d.actor.name)}</b><span>${t(d.kind === 'burner' ? 'burner' : 'smartphone')} · ${formatNumber(d.record.number)}</span></span>${unread ? `<em>${unread}</em>` : ''}</button>`
    })
    .join('')
  document.body.appendChild(picker)
  const rect = anchor?.getBoundingClientRect()
  const pr = picker.getBoundingClientRect()
  const left = rect ? Math.min(window.innerWidth - pr.width - 8, rect.left) : (window.innerWidth - pr.width) / 2
  const top = rect ? Math.max(8, rect.top - pr.height - 8) : (window.innerHeight - pr.height) / 2
  picker.style.left = `${Math.max(8, left)}px`
  picker.style.top = `${top}px`
  const close = (ev: Event) => {
    if (picker.contains(ev.target as Node)) return
    picker.remove()
    document.removeEventListener('pointerdown', close, true)
  }
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0)
  picker.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest('[data-device]') as HTMLElement | null
    if (!btn) return
    picker.remove()
    document.removeEventListener('pointerdown', close, true)
    openPhone(btn.dataset.device!, { focus: true })
  })
}

/** A text or missed call just arrived on one of this user's devices. */
export function notifyArrival(id: DeviceId, msg: PhoneMsg | null, text?: string): void {
  const el = element()
  if (el) {
    el.classList.remove('is-buzzing')
    void el.offsetWidth
    el.classList.add('is-buzzing')
  }
  const visible = buzzWindow(id)
  if (msg) {
    playBuzz(0.5)
    setTimeout(() => playPing(), 120)
    // No toast when the phone is open on that conversation.
    const app = phoneWindow(id)
    const onThread = visible && app && (app.smart.thread === msg.from.number || app.skin === 'burner')
    if (!onThread) ui.notifications?.info(text ?? arrivalText(id, msg))
  } else if (text) ui.notifications?.info(text)
  renderLauncher()
}

export function initLauncher(): void {
  onPhoneChange(() => renderLauncher())
  window.addEventListener('resize', () => {
    const el = element()
    if (!el || el.style.bottom !== 'auto') return
    const rect = el.getBoundingClientRect()
    el.style.left = `${Math.min(window.innerWidth - 50, rect.left)}px`
    el.style.top = `${Math.min(window.innerHeight - 50, rect.top)}px`
  })
  renderLauncher()
}
