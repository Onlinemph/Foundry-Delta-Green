/**
 * One phone window per device: a frameless ApplicationV2 that draws the device and runs it.
 * The reducers (ui/smart.ts, ui/burner.ts) decide what the device does; this class feeds them clicks
 * and keys, renders, and carries out their effects against Foundry (store, calls, camera, flashlight).
 */
import * as calls from './calls.ts'
import { capture, storeImage } from './camera.ts'
import { isFlashlightOn, toggleFlashlight } from './flashlight.ts'
import { MAP_MAX_ZOOM, centredView, layerPlacement, panBy, zoomAt } from './maps.ts'
import { L, phoneScale } from './settings.ts'
import { playClick, playDtmf, playPing, playShutter, playTick, playError } from './sounds.ts'
import * as store from './store.ts'
import { onPhoneChange } from './sync.ts'
import { T9_TIMEOUT_MS } from './t9.ts'
import { readMarker } from './threads.ts'
import { parseDeviceId, type DeviceId } from './types.ts'
import { burnerInit, burnerKey, top, type BurnerUI } from './ui/burner.ts'
import { drawBurner, renderBurnerChassis } from './ui/burner-draw.ts'
import { Lcd, LCD_H, LCD_W } from './ui/lcd.ts'
import { blitLcd, createImageLevels } from './ui/lcd-images.ts'
import { mapGeometry, type Effect, type PhoneSnapshot, type Translate } from './ui/model.ts'
import { calcKey, smartAction, smartInit, type SmartUI } from './ui/smart.ts'
import { liveText, renderSmartChassis, renderSmartScreen } from './ui/smart-view.ts'

export const t: Translate = (key, data) => {
  const i18n = game.i18n as any
  return data ? i18n.format(`${L}.${key}`, data) : i18n.localize(`${L}.${key}`)
}

const apps = new Map<DeviceId, PhoneApp>()

export function openPhone(id: DeviceId, opts: { focus?: boolean } = {}): PhoneApp | null {
  if (!store.canOpen(id)) return null
  let app = apps.get(id)
  if (!app) {
    app = new PhoneApp(id)
    apps.set(id, app)
  }
  if (!app.rendered) void app.render({ force: true })
  else {
    app.refresh()
    if (opts.focus) app.bringToFront?.()
  }
  return app
}

export function phoneWindow(id: DeviceId): PhoneApp | undefined {
  return apps.get(id)
}

/** Buzz an open phone (incoming text or call). */
export function buzzWindow(id: DeviceId): boolean {
  const app = apps.get(id)
  const el = app?.rendered ? (app.element?.querySelector('.aph-device') as HTMLElement | null) : null
  if (!el) return false
  el.classList.remove('is-buzzing')
  void el.offsetWidth
  el.classList.add('is-buzzing')
  return true
}

const BURNER_KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'ok',
  Backspace: 'clear',
  Escape: 'back',
  PageUp: 'softL',
  PageDown: 'softR',
  Home: 'call',
  End: 'end',
}

/** Burner screens where typed characters are text, not keypad presses. */
const TEXT_ROUTES = new Set(['compose', 'editContact', 'caption', 'memo'])

const LONG_PRESS_MS = 600

const AppV2 = foundry.applications.api.ApplicationV2 as any

export class PhoneApp extends AppV2 {
  static DEFAULT_OPTIONS = {
    classes: ['agency-phone-window'],
    window: { frame: false, positioned: true },
    position: { width: 'auto', height: 'auto' },
  }

  readonly deviceId: DeviceId
  readonly skin: 'smartphone' | 'burner'
  readonly inspect: boolean
  smart: SmartUI = smartInit()
  burner: BurnerUI = burnerInit()
  preview: string | null | 'none' = null
  private snap: PhoneSnapshot | null = null
  private unsubscribe: (() => void) | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private t9Timer: ReturnType<typeof setTimeout> | null = null
  private noteTimer: ReturnType<typeof setTimeout> | null = null
  private levels = createImageLevels(() => this.paintBurner())
  private pressed: { key: string; at: number; el: HTMLElement } | null = null
  private screenSig = ''
  private lastShutter = 0
  private busy = false

  constructor(deviceId: DeviceId) {
    const p = parseDeviceId(deviceId)
    const index = apps.size
    super({
      id: `agency-phone-${deviceId.replace(/[^a-zA-Z0-9-]/g, '-')}`,
      position: {
        left: Math.max(20, window.innerWidth - 760 - index * 30),
        top: 40 + index * 30,
      },
    })
    this.deviceId = deviceId
    this.skin = p?.type === 'actor' ? p.kind : 'smartphone'
    this.inspect = store.isInspect(deviceId)
    if (p?.type !== 'actor') this.smart.locked = false
  }

  get title(): string {
    return store.deviceLabel(this.deviceId)
  }

  // ---- ApplicationV2

  async _renderHTML(): Promise<HTMLElement> {
    this.snap = this.snapshot()
    const wrap = document.createElement('div')
    if (!this.snap) {
      wrap.innerHTML = `<div class="aph-device"></div>`
      return wrap.firstElementChild as HTMLElement
    }
    wrap.innerHTML =
      this.skin === 'burner'
        ? renderBurnerChassis(this.snap, t, phoneScale())
        : renderSmartChassis(this.snap, t, phoneScale())
    return wrap.firstElementChild as HTMLElement
  }

  _replaceHTML(result: HTMLElement, content: HTMLElement): void {
    content.replaceChildren(result)
  }

  _onFirstRender(context: unknown, options: unknown): void {
    super._onFirstRender?.(context, options)
    const root = this.element as HTMLElement
    root.addEventListener('click', ev => this.onClick(ev))
    root.addEventListener('submit', ev => this.onSubmit(ev))
    root.addEventListener('input', ev => this.onInput(ev))
    root.addEventListener('keydown', ev => this.onKeyDown(ev))
    root.addEventListener('pointerdown', ev => this.onPointerDown(ev))
    root.addEventListener('pointerup', ev => this.onPointerUp(ev))
    root.addEventListener('pointercancel', () => this.releaseKey())
    root.addEventListener('wheel', ev => this.onWheel(ev), { passive: false })
    this.unsubscribe = onPhoneChange(() => this.refresh())
    this.ticker = setInterval(() => this.tick(), this.skin === 'burner' ? 250 : 1000)
  }

  _onRender(context: unknown, options: unknown): void {
    super._onRender?.(context, options)
    this.refresh()
    ;(this.element?.querySelector('.aph-device') as HTMLElement | null)?.focus({ preventScroll: true })
  }

  async _preClose(options: unknown): Promise<void> {
    await super._preClose?.(options)
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.ticker) clearInterval(this.ticker)
    if (this.t9Timer) clearTimeout(this.t9Timer)
    if (this.noteTimer) {
      clearTimeout(this.noteTimer)
      this.flushNote()
    }
    this.ticker = null
    this.t9Timer = null
    // The instance stays in `apps`: reopening re-renders it where the user left off.
    this.screenSig = ''
  }

  // ---- Data

  snapshot(): PhoneSnapshot | null {
    const actor = store.actorOf(this.deviceId)
    return store.buildSnapshot(this.deviceId, {
      inspect: this.inspect,
      call: calls.callFor(this.deviceId),
      preview: this.preview,
      flashlight: actor ? isFlashlightOn(actor) : false,
    })
  }

  refresh(): void {
    if (!this.rendered || !this.element) return
    const snap = this.snapshot()
    if (!snap) {
      // The device was revoked.
      apps.delete(this.deviceId)
      void this.close()
      return
    }
    this.snap = snap
    this.readVisibleThread()
    if (this.skin === 'burner') this.paintBurner()
    else this.renderSmart()
  }

  /** A text arriving in the conversation on screen is read at once. */
  private readVisibleThread(): void {
    if (this.inspect || !this.snap) return
    const route = top(this.burner)
    const key =
      this.skin === 'burner'
        ? route.s === 'thread'
          ? route.key
          : null
        : !this.smart.locked && this.smart.app === 'messages'
          ? this.smart.thread
          : null
    if (!key) return
    const me = { id: this.snap.device.id, number: this.snap.device.number }
    if (readMarker(this.snap.messages, me, key) > (this.snap.record.read[key] ?? 0))
      void store.markRead(this.deviceId, key)
  }

  private tick(): void {
    if (!this.snap) return
    // World time and call timers move without a data change.
    this.snap = {
      ...this.snap,
      clock: { ...this.snap.clock, worldTime: Number((game.time as any)?.worldTime) || 0 },
      now: Date.now(),
    }
    if (this.skin === 'burner') {
      this.paintBurner()
      return
    }
    for (const el of this.element.querySelectorAll('[data-live]') as NodeListOf<HTMLElement>) {
      const text = liveText(el.dataset.live!, this.snap, Date.now())
      if (el.textContent !== text) el.textContent = text
    }
  }

  // ---- Smartphone rendering

  private renderSmart(): void {
    const screen = this.element.querySelector('[data-screen]') as HTMLElement | null
    if (!screen || !this.snap) return
    // Keep focus, caret and scroll positions across re-renders.
    const active = document.activeElement as HTMLInputElement | null
    const focusName = active && screen.contains(active) && active.name ? active.name : null
    const caret = focusName ? [active!.selectionStart, active!.selectionEnd] : null
    const scrolls = new Map<string, { top: number; atBottom: boolean }>()
    for (const el of screen.querySelectorAll('[data-scroll]') as NodeListOf<HTMLElement>)
      scrolls.set(el.dataset.scroll!, {
        top: el.scrollTop,
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 30,
      })
    // Typed text that isn't in state yet (thread drafts are; other inputs aren't).
    const values = new Map<string, string>()
    for (const el of screen.querySelectorAll('input[name], textarea[name]') as NodeListOf<HTMLInputElement>)
      values.set(el.name, el.value)

    const sig = this.screenSignature()
    const newScreen = sig !== this.screenSig
    this.screenSig = sig
    screen.innerHTML = renderSmartScreen(this.smart, this.snap, t)

    // Replay entry animations only when the screen changes, not on every data refresh.
    screen.classList.toggle('is-entering', newScreen)
    if (newScreen) setTimeout(() => screen.classList.remove('is-entering'), 450)
    if (this.smart.shutter !== this.lastShutter) {
      this.lastShutter = this.smart.shutter
      screen.querySelector('.aph-cam-flash')?.classList.add('is-firing')
    }
    if (!newScreen) {
      // Inputs whose value lives in UI state (drafts, the subtitle line) render from it.
      for (const el of screen.querySelectorAll(
        'input[name]:not([data-draft]):not([data-bind]), textarea[name]'
      ) as NodeListOf<HTMLInputElement>) {
        const v = values.get(el.name)
        if (v !== undefined) el.value = v
      }
    }
    for (const el of screen.querySelectorAll('[data-scroll]') as NodeListOf<HTMLElement>) {
      const prev = scrolls.get(el.dataset.scroll!)
      const stick = el.dataset.stick === 'bottom'
      if (stick && (newScreen || !prev || prev.atBottom)) {
        el.scrollTop = el.scrollHeight
        for (const img of el.querySelectorAll('img'))
          img.addEventListener('load', () => (el.scrollTop = el.scrollHeight), { once: true })
      } else if (prev && !newScreen) el.scrollTop = prev.top
    }
    if (focusName && !newScreen) {
      const el = screen.querySelector(`[name="${focusName}"]`) as HTMLInputElement | null
      el?.focus({ preventScroll: true })
      if (el && caret && caret[0] !== null) el.setSelectionRange?.(caret[0], caret[1])
    } else if (newScreen && !this.smart.locked) {
      ;(screen.querySelector('[data-focus]') as HTMLElement | null)?.focus({ preventScroll: true })
    }
  }

  private screenSignature(): string {
    const u = this.smart
    const call = this.snap?.call ? `${this.snap.call.id}:${this.snap.call.phase}` : ''
    return [
      u.locked,
      u.app,
      u.thread,
      u.phoneTab,
      u.contact?.id ?? (u.contact ? 'new' : ''),
      u.photo,
      u.sendPhoto,
      u.note,
      u.picking,
      call,
    ].join('|')
  }

  // ---- Burner rendering

  private paintBurner(): void {
    const canvas = this.element?.querySelector('[data-lcd]') as HTMLCanvasElement | null
    if (!canvas || !this.snap) return
    const lcd = new Lcd(LCD_W, LCD_H)
    drawBurner(lcd, this.burner, { ...this.snap, now: Date.now() }, t, Date.now(), this.levels)
    blitLcd(canvas, lcd.toRGBA(), LCD_W, LCD_H)
  }

  private burnerPress(key: string): void {
    if (!this.snap) return
    const now = Date.now()
    const { ui, effects } = burnerKey(this.burner, key, this.snap, now)
    this.burner = ui
    if (key !== 'tick') {
      // Commit a cycling multi-tap letter after the pause.
      if (this.t9Timer) clearTimeout(this.t9Timer)
      this.t9Timer = setTimeout(() => {
        this.t9Timer = null
        this.burnerPress('tick')
      }, T9_TIMEOUT_MS + 30)
    }
    if (key !== 'tick' && !effects.some(e => e.t === 'sound')) playClick()
    this.paintBurner()
    void this.run(effects)
  }

  // ---- Input

  private onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement
    if (target.closest('[data-win="close"]')) {
      void this.close()
      return
    }
    const key = target.closest('[data-key]') as HTMLElement | null
    if (key) {
      // Pointer presses are handled on pointerup (long press); keyboard "clicks" have detail 0.
      if (ev.detail === 0) this.burnerPress(key.dataset.key!)
      return
    }
    const actionEl = target.closest('[data-action]') as HTMLElement | null
    if (!actionEl || this.skin !== 'smartphone') return
    if (actionEl.closest('[data-map]') && this.dragged) return
    ev.preventDefault()
    this.smartDo(actionEl.dataset.action!, actionEl.dataset.arg ?? '', this.formValues(actionEl))
  }

  private onSubmit(ev: SubmitEvent): void {
    ev.preventDefault()
    const form = ev.target as HTMLFormElement
    const action = form.dataset.submit
    if (!action) return
    this.smartDo(action, '', this.formValues(form))
  }

  private formValues(el: HTMLElement): Record<string, string> {
    const scope = el.closest('form') ?? el.closest('[data-screen]') ?? this.element
    const values: Record<string, string> = {}
    for (const input of scope.querySelectorAll('input[name], textarea[name]') as NodeListOf<HTMLInputElement>)
      values[input.name] = input.value
    return values
  }

  private onInput(ev: Event): void {
    const el = ev.target as HTMLInputElement
    if (el.matches('[data-draft]') && this.smart.thread) {
      this.smart = { ...this.smart, drafts: { ...this.smart.drafts, [this.smart.thread]: el.value } }
    } else if (el.dataset.bind === 'say') {
      this.smart = { ...this.smart, say: el.value }
    } else if (el.matches('[data-note]')) {
      if (this.noteTimer) clearTimeout(this.noteTimer)
      this.noteTimer = setTimeout(() => this.flushNote(), 700)
    }
  }

  private flushNote(): void {
    this.noteTimer = null
    const el = this.element?.querySelector('[data-note]') as HTMLTextAreaElement | null
    if (!el || !this.smart.note || !this.snap) return
    const current = this.snap.record.notes.find(n => n.id === this.smart.note)
    if (current?.text === el.value) return
    void this.run(smartAction(this.smart, 'noteInput', '', { note: el.value }, this.snap).effects)
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return
    const target = ev.target as HTMLElement
    const inField = target.matches('input, textarea')
    if (this.skin === 'burner') {
      const route = top(this.burner).s
      const typing = TEXT_ROUTES.has(route) || this.snap?.call?.phase === 'active'
      let key = BURNER_KEYS[ev.key]
      if (!key && ev.key.length === 1) key = typing ? `char:${ev.key}` : /^[0-9*#]$/.test(ev.key) ? ev.key : ''
      if (!key) return
      ev.preventDefault()
      ev.stopPropagation()
      this.flashKey(key)
      this.burnerPress(key)
      return
    }
    // Smartphone: the keyboard types into fields; Escape goes back; the calculator takes keys.
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      ev.preventDefault()
      if (inField) target.blur()
      if (this.smart.app === 'notes') this.flushNote()
      this.smartDo('back', '', {})
      return
    }
    if (!inField && this.smart.app === 'calc' && !this.smart.locked) {
      const input = calcKey(ev.key)
      if (input) {
        ev.preventDefault()
        this.smartDo('calc', input, {})
      }
    } else if (!inField && this.smart.locked && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault()
      this.smartDo('unlock', '', {})
    }
  }

  /** Show which on-screen key a keyboard key pressed. */
  private flashKey(key: string): void {
    const base = key.startsWith('char:') ? key.slice(5) : key
    const el = this.element.querySelector(`[data-key="${CSS.escape(base)}"]`) as HTMLElement | null
    if (!el) return
    el.classList.add('is-down')
    setTimeout(() => el.classList.remove('is-down'), 120)
  }

  // Burner keys: long press for digits; map drag for the smartphone.
  private dragged = false
  private drag: { x: number; y: number; id: number } | null = null

  private onPointerDown(ev: PointerEvent): void {
    this.bringToFront?.()
    const target = ev.target as HTMLElement
    const key = target.closest('[data-key]') as HTMLElement | null
    if (key && ev.button === 0) {
      this.pressed = { key: key.dataset.key!, at: Date.now(), el: key }
      key.classList.add('is-down')
      key.setPointerCapture?.(ev.pointerId)
      return
    }
    const map = target.closest('[data-map]') as HTMLElement | null
    if (map && !target.closest('button') && ev.button === 0) {
      this.dragged = false
      this.drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }
      map.setPointerCapture(ev.pointerId)
      const move = (e: PointerEvent) => this.onMapMove(e)
      const up = () => {
        map.removeEventListener('pointermove', move)
        this.drag = null
      }
      map.addEventListener('pointermove', move)
      map.addEventListener('pointerup', up, { once: true })
      map.addEventListener('pointercancel', up, { once: true })
      return
    }
    // Drag the window by the device body (not the screen or its controls).
    if (
      target.closest('[data-drag]') &&
      !target.closest('button, input, textarea, [data-action], .aph-smart-glass, [data-key]') &&
      ev.button === 0
    ) {
      this.startWindowDrag(ev)
    }
  }

  private onPointerUp(_ev: PointerEvent): void {
    const pressed = this.pressed
    this.releaseKey()
    if (!pressed) return
    const held = Date.now() - pressed.at
    const k = pressed.key
    if (held >= LONG_PRESS_MS && /^[0-9*#]$/.test(k)) this.burnerPress(`long:${k}`)
    else if (held >= LONG_PRESS_MS && k === 'softR') this.burnerPress('end')
    else this.burnerPress(k)
  }

  private releaseKey(): void {
    this.pressed?.el.classList.remove('is-down')
    this.pressed = null
  }

  private startWindowDrag(ev: PointerEvent): void {
    const startX = ev.clientX
    const startY = ev.clientY
    const pos = { left: this.position?.left ?? 0, top: this.position?.top ?? 0 }
    const el = ev.target as HTMLElement
    el.setPointerCapture?.(ev.pointerId)
    const move = (e: PointerEvent) =>
      this.setPosition({ left: pos.left + e.clientX - startX, top: pos.top + e.clientY - startY })
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  private onMapMove(ev: PointerEvent): void {
    if (!this.drag || !this.snap?.map?.src) return
    const scale = phoneScale()
    const dx = (ev.clientX - this.drag.x) / scale
    const dy = (ev.clientY - this.drag.y) / scale
    if (Math.abs(dx) + Math.abs(dy) < 2) return
    this.dragged = true
    this.drag.x = ev.clientX
    this.drag.y = ev.clientY
    const g = mapGeometry(this.snap)
    const view = this.smart.map ?? centredView(g, this.snap.map.dot)
    this.smart = { ...this.smart, map: panBy(view, g, dx, dy) }
    this.placeMap()
    setTimeout(() => (this.dragged = false), 0)
  }

  private onWheel(ev: WheelEvent): void {
    const map = (ev.target as HTMLElement).closest('[data-map]') as HTMLElement | null
    if (!map || !this.snap?.map?.src) return
    ev.preventDefault()
    const rect = map.getBoundingClientRect()
    const scale = phoneScale()
    const g = mapGeometry(this.snap)
    const view = this.smart.map ?? centredView(g, this.snap.map.dot)
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15
    const next = zoomAt(view, g, factor, (ev.clientX - rect.left) / scale, (ev.clientY - rect.top) / scale)
    if (next.zoom > MAP_MAX_ZOOM) return
    this.smart = { ...this.smart, map: next }
    this.placeMap()
  }

  /** Move the map layer without re-rendering the screen. */
  private placeMap(): void {
    const layer = this.element.querySelector('[data-map-layer]') as HTMLElement | null
    if (!layer || !this.snap || !this.smart.map) return
    const place = layerPlacement(this.smart.map, mapGeometry(this.snap))
    layer.style.left = `${place.left.toFixed(1)}px`
    layer.style.top = `${place.top.toFixed(1)}px`
    layer.style.width = `${place.w.toFixed(1)}px`
    layer.style.height = `${place.h.toFixed(1)}px`
  }

  // ---- Smartphone actions

  smartDo(action: string, arg: string, form: Record<string, string>): void {
    if (!this.snap) return
    if (action === 'note' || action === 'back' || action === 'home') this.flushNote()
    const { ui, effects } = smartAction(this.smart, action, arg, form, this.snap)
    this.smart = ui
    if (action !== 'key' && action !== 'calc' && !effects.some(e => e.t === 'sound')) playTick()
    if (action === 'open' && arg === 'photos' && !this.inspect) void store.clearFreshPhotos(this.deviceId)
    this.renderSmart()
    void this.run(effects)
  }

  // ---- Effects

  private async run(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      try {
        await this.runOne(effect)
      } catch (err: any) {
        const code = err instanceof store.PhoneError ? err.code : 'generic'
        if (code === 'generic') console.error('GURPS | Agency | phone', err)
        this.showError(code)
      }
    }
  }

  private showError(code: string): void {
    playError()
    const known = ['badNumber', 'needName', 'noToken', 'storageFull', 'noService', 'tooBig']
    if (this.skin === 'smartphone') {
      this.smart = { ...this.smart, error: known.includes(code) ? code : 'noService' }
      this.renderSmart()
    } else {
      this.burner = {
        ...this.burner,
        notice: { text: `notice.${known.includes(code) ? code : 'noService'}`, until: Date.now() + 1800 },
      }
      this.paintBurner()
    }
  }

  private async runOne(e: Effect): Promise<void> {
    const id = this.deviceId
    const actor = store.actorOf(id)
    switch (e.t) {
      case 'send':
        await store.sendText(id, e.to, e.text, e.photo)
        if (this.skin === 'smartphone') playTick()
        return
      case 'call':
        await calls.dial(id, e.to)
        return
      case 'answer':
        return calls.answer(id)
      case 'decline':
        return calls.decline(id)
      case 'hangup':
        return calls.hangup(id)
      case 'say':
        return calls.say(id, e.text)
      case 'mute':
        return calls.mute(id, e.muted)
      case 'dismissCall':
        return calls.dismiss(id)
      case 'saveContact':
        return store.saveContact(id, e.contact)
      case 'deleteContact':
        return store.deleteContact(id, e.id)
      case 'saveNote':
        return store.saveNote(id, e.note)
      case 'deleteNote':
        return store.deleteNote(id, e.id)
      case 'takePhoto':
        return this.takePhoto()
      case 'preview':
        return this.takePreview()
      case 'deletePhoto':
        return store.deletePhoto(id, e.id)
      case 'caption':
        return store.updatePhoto(id, e.id, { caption: e.caption })
      case 'savePhoto':
        await store.savePhotoFromMessage(id, e.photo)
        ui.notifications?.info(t('toast.saved'))
        return
      case 'pickImage':
        return this.pickImage()
      case 'torch': {
        if (!actor) return
        const result = await toggleFlashlight(actor)
        if (result === 'noToken') throw new store.PhoneError('noToken')
        playClick()
        return
      }
      case 'markRead':
        return store.markRead(id, e.key)
      case 'callsSeen':
        return store.markCallsSeen(id)
      case 'prefs':
        return store.setPrefs(id, { h24: e.h24 })
      case 'sound':
        if (e.name === 'dtmf' && e.key) playDtmf(e.key)
        else if (e.name === 'click') playClick()
        else if (e.name === 'tick') playTick()
        else if (e.name === 'ping') playPing()
        else if (e.name === 'shutter') playShutter()
        return
      case 'lock':
        return
    }
  }

  private async takePreview(): Promise<void> {
    const actor = store.actorOf(this.deviceId)
    if (!actor) {
      this.preview = 'none'
      return this.refresh()
    }
    const shot = capture(actor, this.skin, { width: 400, height: 300 })
    this.preview = 'canvas' in shot ? shot.canvas.toDataURL('image/jpeg', 0.7) : 'none'
    this.refresh()
  }

  private async takePhoto(): Promise<void> {
    const actor = store.actorOf(this.deviceId)
    if (!actor || this.busy) return
    this.busy = true
    try {
      playShutter()
      const shot = capture(
        actor,
        this.skin,
        this.skin === 'burner' ? { width: 320, height: 240 } : { width: 1024, height: 768 }
      )
      if (!('canvas' in shot)) throw new store.PhoneError('noToken')
      const record = store.recordOf(this.deviceId)
      if (!record) return
      const stored = await storeImage(shot.canvas, this.skin, actor.id)
      await store.addPhoto(this.deviceId, {
        src: stored.src,
        caption: '',
        taken: Number((game.time as any)?.worldTime) || 0,
        w: stored.w,
        h: stored.h,
        origin: 'camera',
        bytes: stored.bytes,
      })
      this.preview = shot.canvas.toDataURL('image/jpeg', 0.6)
    } finally {
      this.busy = false
    }
  }

  /** NPC phones (GM): attach any image through Foundry's file picker. */
  private async pickImage(): Promise<void> {
    const FP = (foundry.applications as any)?.apps?.FilePicker?.implementation ?? (globalThis as any).FilePicker
    if (!FP) return
    const picker = new FP({
      type: 'image',
      callback: (path: string) => {
        const img = new Image()
        img.onload = () => {
          this.smart = { ...this.smart, attach: { src: path, w: img.naturalWidth, h: img.naturalHeight } }
          this.renderSmart()
        }
        img.onerror = () => {
          this.smart = { ...this.smart, attach: { src: path, w: 4, h: 3 } }
          this.renderSmart()
        }
        img.src = path
      },
    })
    picker.render?.(true)
  }
}
