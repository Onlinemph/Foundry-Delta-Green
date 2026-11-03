/**
 * Agency feature: theme ("dossier" look).
 *
 * The look itself is pure CSS (styles/agency/_theme.scss and styles/agency/dossier/*). Every themed rule is
 * scoped under `body.agency-theme`, so this module only has to:
 *  - register the client setting 'agency-theme' (Boolean, default true),
 *  - keep the `agency-theme` class on <body> in sync with it,
 *  - swap the system's pause logo for the dossier pause stamp while the theme is on,
 *  - widen GCS-style actor sheets once, on first open, when typewriter type makes their content overflow.
 *
 * The component kit classes (.agency-panel, .agency-stamp, ...) work with the theme off too; see _theme.scss.
 */
import { getAgencySetting, registerAgencySetting } from '../settings.ts'

/** Setting key (stored as 'gurps.agency-theme'). */
export const THEME_SETTING = 'theme'

/** Class on <body> that switches the dossier styles on. */
export const THEME_BODY_CLASS = 'agency-theme'

/** Class put on the pause <img> while it shows the dossier stamp. */
export const PAUSE_STAMP_CLASS = 'agency-pause-stamp'

export const PAUSE_STAMP_SRC = 'systems/gurps/assets/agency/pause-stamp.svg'

/** Called at the end of upstream's updatePauseImage() in module/gurps.js (AGENCY edit). */
export const PAUSE_IMAGE_HOOK = 'gurpsAgencyPauseImage'

/** Last pause image source the system chose, so turning the theme off can put it back. */
let upstreamPauseSrc: string | null = null

type HookFn = (...args: unknown[]) => unknown

/** Hooks.on for hook names fvtt-types doesn't know about (custom and v1 render hooks). */
function onHook(hook: string, fn: HookFn): void {
  ;(Hooks as unknown as { on(hook: string, fn: HookFn): number }).on(hook, fn)
}

export function isThemeEnabled(): boolean {
  try {
    return Boolean(getAgencySetting<boolean>(THEME_SETTING))
  } catch {
    // Setting not registered yet (or settings unavailable): fall back to the default.
    return true
  }
}

/** Add or remove the theme class. Exported for tests and for other features that preview the theme. */
export function applyThemeClass(enabled: boolean, root: HTMLElement = document.body): void {
  root.classList.toggle(THEME_BODY_CLASS, enabled)
}

/**
 * Point the pause image at the dossier stamp (theme on) or back at the system logo (theme off).
 * Sizing and animation come from CSS (`body.agency-theme #pause img.agency-pause-stamp`).
 */
export function applyPauseStamp(img: HTMLImageElement | null, enabled: boolean, fallbackSrc?: string | null): void {
  if (!img) return
  if (enabled) {
    if (img.getAttribute('src') !== PAUSE_STAMP_SRC) img.src = PAUSE_STAMP_SRC
    img.classList.add(PAUSE_STAMP_CLASS)
    img.alt = game.i18n?.localize?.('GURPS.agency.theme.pauseAlt') ?? ''
  } else {
    img.classList.remove(PAUSE_STAMP_CLASS)
    if (fallbackSrc && img.getAttribute('src') === PAUSE_STAMP_SRC) img.src = fallbackSrc
  }
}

function onPauseImage(...args: unknown[]): void {
  const [img, src] = args as [HTMLImageElement | null, string | undefined]
  if (typeof src === 'string' && src !== PAUSE_STAMP_SRC) upstreamPauseSrc = src
  applyPauseStamp(img, isThemeEnabled(), upstreamPauseSrc)
}

/** Largest automatic widening (px); anything bigger is a layout problem the user should see, not hide. */
export const MAX_SHEET_WIDENING = 160

/**
 * How much wider (px) a sheet must be so its content stops scrolling sideways, or 0 if it fits or the overflow is
 * implausibly large. Pure, for tests.
 */
export function sheetWidening(scrollWidth: number, clientWidth: number): number {
  const overflow = Math.ceil(scrollWidth - clientWidth)
  return overflow > 0 && overflow <= MAX_SHEET_WIDENING ? overflow + 6 : 0
}

interface PositionedApp {
  element?: unknown
  position?: { width?: unknown }
  setPosition?(position: { width: number }): unknown
}

const fittedSheets = new WeakSet<object>()

function appElement(app: PositionedApp): HTMLElement | null {
  const el = app.element
  if (el instanceof HTMLElement) return el
  const first = (el as { 0?: unknown } | undefined)?.[0] // Application v1: jQuery
  return first instanceof HTMLElement ? first : null
}

/**
 * Courier is wider than upstream's Roboto, so the dense GCS-style sheets (Full, Reduced, Tabbed, Editor, Combat)
 * can overflow their default window widths. Widen each sheet once, on its first render, by exactly the overflow.
 */
async function fitSheetWidth(...args: unknown[]): Promise<void> {
  const app = args[0] as PositionedApp | undefined
  if (!app || typeof app !== 'object' || fittedSheets.has(app) || !isThemeEnabled()) return
  fittedSheets.add(app)
  const el = appElement(app)
  if (!el?.classList.contains('gurps') || el.classList.contains('modern-sheet')) return
  if (!el.querySelector('.gurpsactorsheet')) return
  await document.fonts?.ready
  const content = el.querySelector<HTMLElement>('.window-content')
  const width = Number(app.position?.width)
  if (!content || !Number.isFinite(width)) return
  const extra = sheetWidening(content.scrollWidth, content.clientWidth)
  if (extra) app.setPosition?.({ width: width + extra })
}

function onThemeChange(value: unknown): void {
  const enabled = Boolean(value)
  applyThemeClass(enabled)
  applyPauseStamp(document.querySelector<HTMLImageElement>('#pause img'), enabled, upstreamPauseSrc)
}

export function init(): void {
  registerAgencySetting(THEME_SETTING, {
    name: 'GURPS.agency.theme.setting.name',
    hint: 'GURPS.agency.theme.setting.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: onThemeChange,
  })

  applyThemeClass(isThemeEnabled())
  onHook(PAUSE_IMAGE_HOOK, onPauseImage)
  onHook('renderActorSheet', fitSheetWidth)
}

export function ready(): void {
  // Re-assert after everything else has run its ready hooks (some modules rewrite <body> classes).
  applyThemeClass(isThemeEnabled())
}
