/**
 * Smartphone rendering: HTML strings from (SmartUI, PhoneSnapshot). The chassis is rendered once; the
 * screen ([data-screen]) is re-rendered on every change. Elements with data-live are refreshed every
 * second by the controller (clock, call timer) without re-rendering the screen.
 *
 * Original design: a graphite slab with a pill-shaped camera island; no real brand's look.
 */
import { callElapsed } from '../call-state.ts'
import { calcPendingLine } from '../calculator.ts'
import { clockText, formatClock, formatDateLong, formatDuration, gameTime, relativeStamp } from '../clock.ts'
import { centredView, layerPlacement } from '../maps.ts'
import { formatNumber, formatPartial } from '../numbers.ts'
import { buildThreads, missedCalls, recentCalls, snippet, threadMessages } from '../threads.ts'
import type { PhoneMsg } from '../types.ts'
import {
  mapGeometry,
  noteTitle,
  sortedContacts,
  sortedNotes,
  type PhoneSnapshot,
  type SmartApp,
  type Translate,
} from './model.ts'
import type { SmartUI } from './smart.ts'

export const esc = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

/** Quote a URL for a CSS url() inside a style attribute. */
const cssUrl = (src: string) => `url(&quot;${esc(src).replace(/\(/g, '%28').replace(/\)/g, '%29')}&quot;)`

interface AppMeta {
  icon: string
  label: string
}

const APP_META: Record<SmartApp, AppMeta> = {
  messages: { icon: 'fa-comment', label: 'apps.messages' },
  phone: { icon: 'fa-phone', label: 'apps.phone' },
  camera: { icon: 'fa-camera', label: 'apps.camera' },
  photos: { icon: 'fa-images', label: 'apps.photos' },
  maps: { icon: 'fa-map-location-dot', label: 'apps.maps' },
  flashlight: { icon: 'fa-lightbulb', label: 'apps.flashlight' },
  notes: { icon: 'fa-note-sticky', label: 'apps.notes' },
  clock: { icon: 'fa-clock', label: 'apps.clock' },
  calc: { icon: 'fa-calculator', label: 'apps.calc' },
}

const DOCK: SmartApp[] = ['phone', 'messages', 'camera', 'photos']

interface Ctx {
  ui: SmartUI
  snap: PhoneSnapshot
  t: Translate
  h24: boolean
}

const fmt = (n: string) => formatNumber(n, 'paren')
const nameOf = (c: Ctx, n: string) => c.snap.names[n] || fmt(n)

function initials(name: string): string {
  if (/^[\d()\s+-]+$/.test(name)) return ''
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Stable hue per number, for avatar colours. */
function hue(seed: string): number {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

function avatar(c: Ctx, number: string, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const img = c.snap.avatars[number]
  if (img) return `<span class="aph-avatar aph-avatar--${size}" style="background-image:${cssUrl(img)}"></span>`
  const name = c.snap.names[number] ?? ''
  const ini = initials(name)
  const style = `--aph-hue:${hue(number)}`
  return ini
    ? `<span class="aph-avatar aph-avatar--${size}" style="${style}">${esc(ini)}</span>`
    : `<span class="aph-avatar aph-avatar--${size} aph-avatar--unknown" style="${style}"><i class="fa-solid fa-user"></i></span>`
}

// ---------------------------------------------------------------------------------------------
// Live values (refreshed every second by the controller)

export function liveText(key: string, snap: PhoneSnapshot, now: number): string {
  const t = gameTime(snap.clock.start, snap.clock.worldTime)
  const h24 = snap.record.prefs.h24
  switch (key) {
    case 'status':
      return formatClock(t, h24).time
    case 'big':
      return formatClock(t, h24).time
    case 'suffix':
      return formatClock(t, h24).suffix
    case 'hour':
      return formatClock(t, h24).time.split(':')[0].padStart(2, '0')
    case 'minute':
      return formatClock(t, h24).time.split(':')[1] ?? ''
    case 'seconds':
      return String(t.second).padStart(2, '0')
    case 'date':
      return formatDateLong(t, snap.clock.lang)
    case 'timer':
      return snap.call ? formatDuration(callElapsed(snap.call, now)) : ''
    default:
      return ''
  }
}

const live = (c: Ctx, key: string, cls = '') =>
  `<span class="${cls}" data-live="${key}">${esc(liveText(key, c.snap, c.snap.now))}</span>`

// ---------------------------------------------------------------------------------------------
// Chassis

export function renderSmartChassis(snap: PhoneSnapshot, t: Translate, scale = 1): string {
  const inspect = snap.inspect
    ? `<div class="aph-inspect"><i class="fa-solid fa-user-secret"></i> ${esc(t('inspect', { name: snap.device.name }))}</div>`
    : ''
  const npc = snap.device.owner === 'npc' ? ' aph-smart--npc' : ''
  return `<div class="aph-device aph-smart${npc}" data-skin="smartphone" tabindex="0" style="--aph-scale:${scale}">
  <div class="aph-chrome">
    <span class="aph-chrome-label">${esc(snap.device.name)}</span>
    <button type="button" class="aph-win-btn" data-win="close" data-tooltip="${esc(t('putAway'))}" aria-label="${esc(t('putAway'))}"><i class="fa-solid fa-xmark"></i></button>
  </div>
  ${inspect}
  <div class="aph-smart-body" data-drag>
    <span class="aph-side aph-side--power" data-action="lock" data-tooltip="${esc(t('sideButton'))}"></span>
    <span class="aph-side aph-side--vol-up"></span>
    <span class="aph-side aph-side--vol-down"></span>
    <span class="aph-earpiece"></span>
    <div class="aph-smart-glass">
      <div class="aph-smart-screen" data-screen>${renderSmartScreen(smartCtxDefaults(snap), snap, t)}</div>
    </div>
  </div>
</div>`
}

function smartCtxDefaults(snap: PhoneSnapshot): SmartUI {
  // Chassis renders before the controller has state; the controller re-renders the screen right away.
  return {
    locked: snap.device.owner !== 'npc',
    app: 'home',
    thread: null,
    drafts: {},
    attach: null,
    picking: false,
    phoneTab: 'keypad',
    dial: '',
    contact: null,
    photo: null,
    sendPhoto: null,
    note: null,
    calc: { display: '0', acc: null, op: null, fresh: true, error: false, last: null },
    map: null,
    shutter: 0,
    say: '',
    error: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Screen

export function renderSmartScreen(ui: SmartUI, snap: PhoneSnapshot, t: Translate): string {
  const c: Ctx = { ui, snap, t, h24: snap.record.prefs.h24 }
  const call = snap.call
  let body: string
  let tone: 'light' | 'dark' = 'dark'
  let homebar = true
  if (call && (call.phase !== 'ended' || snap.now - call.endedAt < 2500)) {
    body = callScreen(c)
  } else if (ui.locked) {
    body = lockScreen(c)
  } else {
    switch (ui.app) {
      case 'home':
        body = homeScreen(c)
        break
      case 'messages':
        body = messagesApp(c)
        break
      case 'phone':
        body = phoneApp(c)
        break
      case 'camera':
        body = cameraApp(c)
        break
      case 'photos':
        body = photosApp(c)
        break
      case 'maps':
        body = mapsApp(c)
        break
      case 'notes':
        body = notesApp(c)
        tone = 'light'
        break
      case 'clock':
        body = clockApp(c)
        break
      case 'calc':
        body = calcApp(c)
        break
      default:
        body = homeScreen(c)
    }
  }
  if (ui.locked && !call) homebar = true
  const error = ui.error
    ? `<div class="aph-toast" data-action="dismissError"><i class="fa-solid fa-circle-exclamation"></i> ${esc(t(`error.${ui.error}`))}</div>`
    : ''
  return `${statusBar(c, tone)}${body}${error}${homebar ? `<div class="aph-homebar" data-action="home" aria-label="${esc(t('home'))}"></div>` : ''}`
}

function statusBar(c: Ctx, tone: 'light' | 'dark'): string {
  const { snap, t } = c
  const bars = Array.from({ length: 4 }, (_, i) => `<i class="${i < snap.bars ? 'on' : ''}"></i>`).join('')
  const signal = snap.signal
    ? `<span class="aph-bars" aria-label="${esc(t('signal'))}">${bars}</span>`
    : `<span class="aph-nosvc" aria-label="${esc(t('noService'))}"><i></i><i></i><i></i><i></i><b class="fa-solid fa-xmark"></b></span>`
  const torch = snap.flashlight ? '<i class="fa-solid fa-lightbulb aph-status-torch"></i>' : ''
  return `<div class="aph-status aph-status--${tone}">
  <span class="aph-status-time">${live(c, 'status')}</span>
  <span class="aph-punch"><i class="aph-lens"></i></span>
  <span class="aph-status-right">${torch}${signal}<span class="aph-battery"><i></i></span></span>
</div>`
}

// ---- Lock screen

function lockScreen(c: Ctx): string {
  const { snap, t } = c
  const me = { id: snap.device.id, number: snap.device.number }
  const threads = buildThreads(snap.messages, me, snap.record.read).filter(th => th.unread > 0)
  const notifs: string[] = []
  const missedList = recentCalls(snap.messages, me).filter(r => r.missed && r.deliveredTs > snap.record.callsSeen)
  for (const th of threads.slice(0, missedList.length ? 2 : 3)) {
    const incoming = threadMessages(snap.messages, me, th.key).filter(x => x.dir === 'in')
    const last = incoming[incoming.length - 1]?.msg ?? th.last
    const body = snippet(last, t('photo'), 90)
    notifs.push(`<div class="aph-notif" data-action="thread" data-arg="${esc(th.key)}">
  <div class="aph-notif-app"><span class="aph-notif-icon aph-notif-icon--messages"><i class="fa-solid fa-comment"></i></span>${esc(t('apps.messages'))}<span class="aph-notif-time">${esc(stamp(c, last.sentAt))}</span></div>
  <div class="aph-notif-title">${esc(nameOf(c, th.key))}${th.unread > 1 ? ` <span class="aph-notif-count">${th.unread}</span>` : ''}</div>
  <div class="aph-notif-body">${last.photo && !last.text ? '<i class="fa-solid fa-image"></i> ' : ''}${esc(body)}</div>
</div>`)
  }
  if (missedList.length) {
    const who = [...new Set(missedList.map(r => nameOf(c, r.key)))].slice(0, 2).join(', ')
    notifs.push(`<div class="aph-notif" data-action="tab" data-arg="recents">
  <div class="aph-notif-app"><span class="aph-notif-icon aph-notif-icon--phone"><i class="fa-solid fa-phone"></i></span>${esc(t('apps.phone'))}<span class="aph-notif-time">${esc(stamp(c, missedList[0].sentAt))}</span></div>
  <div class="aph-notif-title">${esc(t(missedList.length === 1 ? 'missedOne' : 'missedMany', { n: missedList.length }))}</div>
  <div class="aph-notif-body">${esc(who)}</div>
</div>`)
  }
  return `<div class="aph-lock" data-action="unlock">
  <div class="aph-wallpaper"></div>
  <div class="aph-lock-head">
    <div class="aph-lock-date"><i class="fa-solid fa-lock"></i>${live(c, 'date')}</div>
    <div class="aph-lock-time">${live(c, 'hour', 'aph-lock-h')}${live(c, 'minute', 'aph-lock-m')}</div>
    <div class="aph-lock-meta">${c.h24 ? '' : `${live(c, 'suffix', 'aph-lock-suffix')}<span class="aph-lock-sep"></span>`}<span>${esc(snap.signal ? snap.carrier : t('noService'))}</span></div>
  </div>
  <div class="aph-notifs">${notifs.join('')}</div>
  <div class="aph-lock-foot">
    <button type="button" class="aph-lock-btn${snap.flashlight ? ' is-on' : ''}" data-action="open" data-arg="flashlight" aria-label="${esc(t('apps.flashlight'))}"><i class="fa-solid fa-lightbulb"></i></button>
    <span class="aph-lock-hint"><i class="fa-solid fa-chevron-up"></i>${esc(t('tapToUnlock'))}</span>
    <button type="button" class="aph-lock-btn" data-action="open" data-arg="camera" aria-label="${esc(t('apps.camera'))}"><i class="fa-solid fa-camera"></i></button>
  </div>
</div>`
}

function stamp(c: Ctx, sentAt: number): string {
  return relativeStamp(c.snap.clock.start, c.snap.clock.worldTime, sentAt, c.h24, c.snap.clock.lang, c.t('yesterday'))
}

// ---- Home

function appBadge(c: Ctx, app: SmartApp): number {
  const me = { id: c.snap.device.id, number: c.snap.device.number }
  if (app === 'messages')
    return buildThreads(c.snap.messages, me, c.snap.record.read).reduce((n, th) => n + th.unread, 0)
  if (app === 'phone') return missedCalls(c.snap.messages, me, c.snap.record.callsSeen)
  if (app === 'photos') return c.snap.record.gallery.filter(p => p.fresh).length
  return 0
}

function appIcon(c: Ctx, app: SmartApp, withLabel = true): string {
  const meta = APP_META[app]
  const badge = appBadge(c, app)
  const on = app === 'flashlight' && c.snap.flashlight ? ' is-on' : ''
  return `<button type="button" class="aph-app aph-app--${app}${on}" data-action="open" data-arg="${app}">
  <span class="aph-app-icon"><i class="fa-solid ${meta.icon}"></i>${badge ? `<b class="aph-badge">${badge > 99 ? '99+' : badge}</b>` : ''}</span>
  ${withLabel ? `<span class="aph-app-label">${esc(c.t(meta.label))}</span>` : ''}
</button>`
}

function homeScreen(c: Ctx): string {
  const { snap, t } = c
  const dock = DOCK.filter(a => snap.apps.includes(a))
  const grid = snap.apps.filter(a => !dock.includes(a))
  const where = snap.signal ? snap.carrier : t('noService')
  const me = { id: snap.device.id, number: snap.device.number }
  const recent = snap.apps.includes('messages') ? buildThreads(snap.messages, me, snap.record.read).slice(0, 2) : []
  const recentRows = recent
    .map(
      th =>
        `<button type="button" class="aph-glance-row${th.unread ? ' is-unread' : ''}" data-action="thread" data-arg="${esc(th.key)}">${avatar(c, th.key, 'sm')}<span><b>${esc(nameOf(c, th.key))}</b><em>${esc(th.sending ? t('sending') : snippet(th.last, t('photo'), 48))}</em></span><small>${esc(stamp(c, th.last.sentAt))}</small></button>`
    )
    .join('')
  return `<div class="aph-home">
  <div class="aph-wallpaper aph-wallpaper--home"></div>
  <div class="aph-widget">
    <div class="aph-widget-time">${live(c, 'big')}${c.h24 ? '' : `<small>${live(c, 'suffix')}</small>`}</div>
    <div class="aph-widget-date">${live(c, 'date')}</div>
    <div class="aph-widget-meta"><i class="fa-solid ${snap.signal ? 'fa-signal' : 'fa-ban'}"></i> ${esc(where)}<span>${esc(fmt(snap.device.number))}</span></div>
  </div>
  <div class="aph-grid">${grid.map(a => appIcon(c, a)).join('')}</div>
  ${recentRows ? `<div class="aph-widget aph-glance"><div class="aph-glance-head"><i class="fa-solid fa-comment"></i>${esc(t('apps.messages'))}</div>${recentRows}</div>` : ''}
  <div class="aph-dock">${dock.map(a => appIcon(c, a, false)).join('')}</div>
</div>`
}

function header(
  c: Ctx,
  title: string,
  opts: { back?: boolean; action?: string; actionIcon?: string; actionLabel?: string; sub?: string } = {}
): string {
  const back =
    opts.back !== false
      ? `<button type="button" class="aph-head-back" data-action="back"><i class="fa-solid fa-chevron-left"></i>${esc(c.t('back'))}</button>`
      : '<span></span>'
  const act = opts.action
    ? `<button type="button" class="aph-head-act" data-action="${opts.action}" aria-label="${esc(opts.actionLabel ?? '')}"><i class="fa-solid ${opts.actionIcon}"></i></button>`
    : '<span></span>'
  return `<header class="aph-head">${back}<h2>${esc(title)}${opts.sub ? `<small>${esc(opts.sub)}</small>` : ''}</h2>${act}</header>`
}

const empty = (icon: string, text: string) =>
  `<div class="aph-empty"><i class="fa-solid ${icon}"></i><p>${esc(text)}</p></div>`

// ---- Messages

function messagesApp(c: Ctx): string {
  const { ui } = c
  if (ui.thread === '') return composeNew(c)
  if (ui.thread) return threadView(c, ui.thread)
  return threadList(c)
}

function threadList(c: Ctx): string {
  const { snap, t } = c
  const me = { id: snap.device.id, number: snap.device.number }
  const threads = buildThreads(snap.messages, me, snap.record.read)
  const rows = threads
    .map(th => {
      const prefix = th.lastDir === 'out' ? `${t('you')}: ` : ''
      const text = th.sending ? t('sending') : prefix + snippet(th.last, t('photo'))
      return `<button type="button" class="aph-row aph-thread${th.unread ? ' is-unread' : ''}" data-action="thread" data-arg="${esc(th.key)}">
  ${th.unread ? '<span class="aph-dot"></span>' : '<span class="aph-dot aph-dot--none"></span>'}
  ${avatar(c, th.key)}
  <span class="aph-row-main"><span class="aph-row-title">${esc(nameOf(c, th.key))}</span><span class="aph-row-sub">${th.last.photo && !th.last.text ? '<i class="fa-solid fa-image"></i> ' : ''}${esc(text)}</span></span>
  <span class="aph-row-meta">${esc(stamp(c, th.last.sentAt))}<i class="fa-solid fa-chevron-right"></i></span>
</button>`
    })
    .join('')
  return `<div class="aph-app-view aph-messages">
  ${header(c, t('apps.messages'), { back: false, action: 'compose', actionIcon: 'fa-pen-to-square', actionLabel: t('newMessage') })}
  <div class="aph-scroll" data-scroll="threads">${rows || empty('fa-comment-slash', t('noMessages'))}</div>
</div>`
}

function composeNew(c: Ctx): string {
  const { snap, t } = c
  const contacts = sortedContacts(snap.record.contacts)
  return `<div class="aph-app-view aph-messages">
  ${header(c, t('newMessage'))}
  <form class="aph-to" data-submit="composeTo">
    <label>${esc(t('to'))}</label><input type="tel" name="to" placeholder="${esc(t('numberPlaceholder'))}" autocomplete="off" data-focus>
    <button type="submit" class="aph-pill-btn">${esc(t('next'))}</button>
  </form>
  <div class="aph-scroll" data-scroll="pick">
    ${contacts.length ? `<div class="aph-section">${esc(t('contacts'))}</div>` : ''}
    ${contacts
      .map(
        ct =>
          `<button type="button" class="aph-row" data-action="thread" data-arg="${esc(ct.number)}">${avatar(c, ct.number, 'sm')}<span class="aph-row-main"><span class="aph-row-title">${esc(ct.name)}</span><span class="aph-row-sub">${esc(fmt(ct.number))}</span></span></button>`
      )
      .join('')}
  </div>
</div>`
}

function bubble(c: Ctx, msg: PhoneMsg, dir: 'in' | 'out'): string {
  const { t } = c
  const photo = msg.photo
    ? `<span class="aph-bubble-photo"><img src="${esc(msg.photo.src)}" alt="" loading="lazy" style="aspect-ratio:${msg.photo.w || 4}/${msg.photo.h || 3}">${
        dir === 'in' && c.snap.device.owner === 'agent' && !c.snap.inspect
          ? `<button type="button" class="aph-save-photo" data-action="saveIncoming" data-arg="${esc(msg.id)}" aria-label="${esc(t('saveToPhotos'))}"><i class="fa-solid fa-download"></i></button>`
          : ''
      }</span>`
    : ''
  const text = msg.text ? `<span class="aph-bubble-text">${esc(msg.text)}</span>` : ''
  const status =
    dir === 'out' && msg.state === 'outbox'
      ? `<span class="aph-bubble-status"><i class="fa-solid fa-circle-notch fa-spin"></i> ${esc(t('sending'))}</span>`
      : ''
  return `<div class="aph-bubble aph-bubble--${dir}${msg.photo ? ' has-photo' : ''}${msg.photo && !msg.text ? ' only-photo' : ''}">${photo}${text}</div>${status}`
}

function threadView(c: Ctx, key: string): string {
  const { snap, ui, t } = c
  const me = { id: snap.device.id, number: snap.device.number }
  const items = threadMessages(snap.messages, me, key)
  let lastDay = -1
  let lastAt = -Infinity
  const parts: string[] = []
  for (const { msg, dir } of items) {
    const day = Math.floor(gameTime(snap.clock.start, msg.sentAt).ms / 86_400_000)
    if (day !== lastDay || msg.sentAt - lastAt > 3600) {
      parts.push(`<div class="aph-daysep">${esc(dayLabel(c, msg.sentAt))}</div>`)
      lastDay = day
    }
    lastAt = msg.sentAt
    parts.push(bubble(c, msg, dir))
  }
  const draft = ui.drafts[key] ?? ''
  const attach = ui.attach
    ? `<div class="aph-attach"><img src="${esc(ui.attach.src)}" alt=""><button type="button" data-action="attachClear" aria-label="${esc(t('remove'))}"><i class="fa-solid fa-xmark"></i></button></div>`
    : ''
  const picker = ui.picking ? photoPicker(c) : ''
  const known = !!snap.names[key]
  const addContact =
    !known && snap.device.owner === 'agent'
      ? `<button type="button" class="aph-head-act" data-action="contactNew" data-arg="${esc(key)}" aria-label="${esc(t('addContact'))}"><i class="fa-solid fa-user-plus"></i></button>`
      : `<button type="button" class="aph-head-act" data-action="callNumber" data-arg="${esc(key)}" aria-label="${esc(t('call'))}"><i class="fa-solid fa-phone"></i></button>`
  const noSignal = !snap.signal
    ? `<div class="aph-banner"><i class="fa-solid fa-ban"></i> ${esc(t('noServiceQueued'))}</div>`
    : ''
  return `<div class="aph-app-view aph-messages aph-thread-view">
  <header class="aph-head aph-head--thread">
    <button type="button" class="aph-head-back" data-action="back"><i class="fa-solid fa-chevron-left"></i></button>
    <div class="aph-thread-who">${avatar(c, key, 'sm')}<span>${esc(nameOf(c, key))}</span>${known ? `<small>${esc(fmt(key))}</small>` : ''}</div>
    ${addContact}
  </header>
  ${noSignal}
  <div class="aph-scroll aph-bubbles" data-scroll="thread" data-stick="bottom">${parts.join('') || empty('fa-comment-dots', t('sayHello'))}</div>
  ${attach}
  <form class="aph-composer" data-submit="send">
    <button type="button" class="aph-composer-plus" data-action="attach" aria-label="${esc(t('attachPhoto'))}"><i class="fa-solid fa-image"></i></button>
    <input type="text" name="text" value="${esc(draft)}" placeholder="${esc(t('textPlaceholder'))}" autocomplete="off" maxlength="480" data-draft data-focus>
    <button type="submit" class="aph-composer-send" aria-label="${esc(t('send'))}"><i class="fa-solid fa-arrow-up"></i></button>
  </form>
  ${picker}
</div>`
}

function dayLabel(c: Ctx, sentAt: number): string {
  const g = gameTime(c.snap.clock.start, sentAt)
  const today = Math.floor(gameTime(c.snap.clock.start, c.snap.clock.worldTime).ms / 86_400_000)
  const day = Math.floor(g.ms / 86_400_000)
  const time = clockText(g, c.h24)
  if (day === today) return `${c.t('today')} ${time}`
  return `${formatDateLong(g, c.snap.clock.lang)} ${time}`
}

function photoPicker(c: Ctx): string {
  const { snap, t } = c
  const fromFile =
    snap.device.owner === 'npc'
      ? `<button type="button" class="aph-sheet-btn" data-action="attachFile"><i class="fa-solid fa-folder-open"></i> ${esc(t('chooseImage'))}</button>`
      : ''
  const photos = [...snap.record.gallery].reverse()
  return `<div class="aph-sheet">
  <div class="aph-sheet-head"><span>${esc(t('choosePhoto'))}</span><button type="button" data-action="back">${esc(t('cancel'))}</button></div>
  ${fromFile}
  <div class="aph-photo-grid aph-photo-grid--sheet">${
    photos
      .map(
        p =>
          `<button type="button" class="aph-thumb" data-action="attachPick" data-arg="${esc(p.id)}" style="background-image:${cssUrl(p.src)}"></button>`
      )
      .join('') || (fromFile ? '' : empty('fa-images', t('noPhotos')))
  }</div>
</div>`
}

// ---- Phone

function phoneApp(c: Ctx): string {
  const { ui, t } = c
  let body: string
  if (ui.contact) body = contactEditor(c)
  else if (ui.phoneTab === 'contacts') body = contactsTab(c)
  else if (ui.phoneTab === 'recents') body = recentsTab(c)
  else body = keypadTab(c)
  const me = { id: c.snap.device.id, number: c.snap.device.number }
  const missed = missedCalls(c.snap.messages, me, c.snap.record.callsSeen)
  const tab = (id: string, icon: string, label: string, badge = 0) =>
    `<button type="button" class="aph-tab${ui.phoneTab === id && !ui.contact ? ' is-active' : ''}" data-action="tab" data-arg="${id}"><i class="fa-solid ${icon}"></i>${badge ? `<b class="aph-badge">${badge}</b>` : ''}<span>${esc(label)}</span></button>`
  return `<div class="aph-app-view aph-phone">
  ${body}
  <nav class="aph-tabs">
    ${tab('recents', 'fa-clock-rotate-left', t('recents'), missed)}
    ${tab('contacts', 'fa-address-book', t('contacts'))}
    ${tab('keypad', 'fa-table-cells', t('keypad'))}
  </nav>
</div>`
}

const KEYPAD: [string, string][] = [
  ['1', ''],
  ['2', 'ABC'],
  ['3', 'DEF'],
  ['4', 'GHI'],
  ['5', 'JKL'],
  ['6', 'MNO'],
  ['7', 'PQRS'],
  ['8', 'TUV'],
  ['9', 'WXYZ'],
  ['*', ''],
  ['0', '+'],
  ['#', ''],
]

function keypadTab(c: Ctx): string {
  const { ui, snap, t } = c
  const typed = ui.dial
  const match = typed
    ? Object.entries(snap.names).find(([n]) => n.endsWith(typed.replace(/\D/g, '')) && typed.length >= 7)
    : null
  const keys = KEYPAD.map(
    ([d, l]) =>
      `<button type="button" class="aph-key" data-action="key" data-arg="${d}"><span>${d}</span><small>${l || '&nbsp;'}</small></button>`
  ).join('')
  return `<div class="aph-keypad">
  <div class="aph-dial-display${typed.length > 11 ? ' is-long' : ''}">${esc(formatPartial(typed))}</div>
  <div class="aph-dial-match">${match ? esc(match[1]) : typed && snap.device.owner === 'agent' ? `<button type="button" data-action="contactNew" data-arg="${esc(typed)}">${esc(t('addContact'))}</button>` : '&nbsp;'}</div>
  <div class="aph-keys">${keys}</div>
  <div class="aph-dial-actions">
    <span></span>
    <button type="button" class="aph-call-btn" data-action="dial" aria-label="${esc(t('call'))}"><i class="fa-solid fa-phone"></i></button>
    ${typed ? `<button type="button" class="aph-del-btn" data-action="del" aria-label="${esc(t('delete'))}"><i class="fa-solid fa-delete-left"></i></button>` : '<span></span>'}
  </div>
  <div class="aph-my-number">${esc(t('myNumber'))} ${esc(fmt(snap.device.number))}</div>
</div>`
}

function contactsTab(c: Ctx): string {
  const { snap, t } = c
  const contacts = sortedContacts(snap.record.contacts)
  let letter = ''
  const rows: string[] = []
  for (const ct of contacts) {
    const first = (ct.name[0] ?? '#').toUpperCase()
    if (first !== letter) {
      letter = first
      rows.push(`<div class="aph-section">${esc(letter)}</div>`)
    }
    rows.push(`<div class="aph-row aph-contact">
  ${avatar(c, ct.number, 'sm')}
  <button type="button" class="aph-row-main" data-action="contactEdit" data-arg="${esc(ct.id)}"><span class="aph-row-title">${esc(ct.name)}</span><span class="aph-row-sub">${esc(fmt(ct.number))}</span></button>
  <button type="button" class="aph-round-btn" data-action="textNumber" data-arg="${esc(ct.number)}" aria-label="${esc(t('message'))}"><i class="fa-solid fa-comment"></i></button>
  <button type="button" class="aph-round-btn aph-round-btn--green" data-action="callNumber" data-arg="${esc(ct.number)}" aria-label="${esc(t('call'))}"><i class="fa-solid fa-phone"></i></button>
</div>`)
  }
  const add =
    snap.device.owner === 'agent' ? { action: 'contactNew', actionIcon: 'fa-plus', actionLabel: t('addContact') } : {}
  return `${header(c, t('contacts'), { back: false, ...add })}
<div class="aph-me-card">${avatar(c, snap.device.number, 'md')}<div><b>${esc(snap.device.name)}</b><span>${esc(t('myNumber'))} ${esc(fmt(snap.device.number))}</span></div></div>
<div class="aph-scroll" data-scroll="contacts">${rows.join('') || empty('fa-address-book', t('noContacts'))}</div>`
}

function contactEditor(c: Ctx): string {
  const { ui, t } = c
  const ct = ui.contact!
  return `${header(c, ct.id ? t('editContact') : t('newContact'))}
<form class="aph-form" data-submit="contactSave">
  <div class="aph-form-avatar">${avatar(c, ct.number || '0', 'lg')}</div>
  <label class="aph-field"><span>${esc(t('name'))}</span><input type="text" name="name" value="${esc(ct.name)}" maxlength="40" autocomplete="off" data-focus></label>
  <label class="aph-field"><span>${esc(t('number'))}</span><input type="tel" name="number" value="${esc(ct.number ? fmt(ct.number) : '')}" maxlength="20" autocomplete="off"></label>
  <button type="submit" class="aph-wide-btn">${esc(t('save'))}</button>
  ${ct.id ? `<button type="button" class="aph-wide-btn aph-wide-btn--danger" data-action="contactDelete" data-arg="${esc(ct.id)}">${esc(t('deleteContact'))}</button>` : ''}
</form>`
}

function recentsTab(c: Ctx): string {
  const { snap, t } = c
  const me = { id: snap.device.id, number: snap.device.number }
  const rows = recentCalls(snap.messages, me)
    .map(r => {
      const icon = r.missed ? 'fa-phone-slash' : r.dir === 'out' ? 'fa-arrow-up aph-diag' : 'fa-arrow-down aph-diag'
      const label = r.missed
        ? t(r.outcome === 'declined' ? 'declined' : 'missed')
        : r.outcome === 'answered'
          ? formatDuration(r.duration)
          : t(r.dir === 'out' ? 'noAnswer' : 'missed')
      return `<div class="aph-row aph-recent${r.missed ? ' is-missed' : ''}">
  <i class="fa-solid ${icon} aph-recent-icon"></i>
  <button type="button" class="aph-row-main" data-action="callNumber" data-arg="${esc(r.key)}"><span class="aph-row-title">${esc(nameOf(c, r.key))}</span><span class="aph-row-sub">${esc(t(r.dir === 'out' ? 'outgoing' : 'incoming'))} · ${esc(label)}</span></button>
  <span class="aph-row-meta">${esc(stamp(c, r.sentAt))}</span>
  <button type="button" class="aph-round-btn" data-action="textNumber" data-arg="${esc(r.key)}" aria-label="${esc(t('message'))}"><i class="fa-solid fa-comment"></i></button>
</div>`
    })
    .join('')
  return `${header(c, t('recents'), { back: false })}
<div class="aph-scroll" data-scroll="recents">${rows || empty('fa-clock-rotate-left', t('noRecents'))}</div>`
}

// ---- Calls

function callScreen(c: Ctx): string {
  const { snap, t, ui } = c
  const call = snap.call!
  const who = nameOf(c, call.remote.number)
  const known = !!snap.names[call.remote.number]
  const sub = known ? fmt(call.remote.number) : t('mobile')
  let status: string
  let controls: string
  let extra = ''
  switch (call.phase) {
    case 'incoming':
      status = t('incomingCall')
      controls = `<div class="aph-call-pair">
  <button type="button" class="aph-call-round aph-call-round--decline" data-action="decline"><i class="fa-solid fa-phone"></i><span>${esc(t('decline'))}</span></button>
  <button type="button" class="aph-call-round aph-call-round--answer" data-action="answer"><i class="fa-solid fa-phone"></i><span>${esc(t('answer'))}</span></button>
</div>`
      break
    case 'dialing':
      status = t('calling')
      controls = `<div class="aph-call-one"><button type="button" class="aph-call-round aph-call-round--decline" data-action="hangup"><i class="fa-solid fa-phone"></i><span>${esc(t('end'))}</span></button></div>`
      break
    case 'active': {
      status = ''
      const lines = call.lines
        .slice(-8)
        .map(
          l =>
            `<div class="aph-sub aph-sub--${l.who}"><b>${esc(l.who === 'me' ? t('you') : who)}</b> ${esc(l.text)}</div>`
        )
        .join('')
      extra = `<div class="aph-subs" data-scroll="subs" data-stick="bottom">${lines || `<div class="aph-subs-hint">${esc(t('subtitlesHint'))}</div>`}</div>
<form class="aph-say" data-submit="say"><input type="text" name="say" data-bind="say" value="${esc(ui.say)}" maxlength="120" placeholder="${esc(t('sayPlaceholder'))}" autocomplete="off" data-focus><button type="submit" aria-label="${esc(t('send'))}"><i class="fa-solid fa-closed-captioning"></i></button></form>`
      controls = `<div class="aph-call-grid">
  <button type="button" class="aph-call-opt${call.muted ? ' is-on' : ''}" data-action="mute"><i class="fa-solid ${call.muted ? 'fa-microphone-slash' : 'fa-microphone'}"></i><span>${esc(t(call.muted ? 'unmute' : 'mute'))}</span></button>
  <button type="button" class="aph-call-round aph-call-round--decline" data-action="hangup"><i class="fa-solid fa-phone"></i><span>${esc(t('end'))}</span></button>
  <span class="aph-call-opt aph-call-opt--state">${call.remoteMuted ? `<i class="fa-solid fa-microphone-slash"></i><span>${esc(t('theyMuted'))}</span>` : ''}</span>
</div>`
      break
    }
    default:
      status = t(`ended.${call.end ?? 'hangup'}`)
      controls = `<div class="aph-call-one"><button type="button" class="aph-call-ended" data-action="dismissCall">${esc(call.startedAt ? formatDuration(Math.floor((call.endedAt - call.startedAt) / 1000)) : t('ok'))}</button></div>`
  }
  const timer =
    call.phase === 'active' ? live(c, 'timer', 'aph-call-timer') : `<span class="aph-call-status">${esc(status)}</span>`
  return `<div class="aph-call aph-call--${call.phase}">
  <div class="aph-call-bg" style="--aph-hue:${hue(call.remote.number)}"></div>
  <div class="aph-call-head">
    <div class="aph-call-avatar${call.phase === 'incoming' ? ' is-ringing' : ''}">${avatar(c, call.remote.number, 'lg')}</div>
    <div class="aph-call-name">${esc(who)}</div>
    <div class="aph-call-sub">${esc(sub)}</div>
    ${timer}
  </div>
  ${extra}
  <div class="aph-call-controls">${controls}</div>
</div>`
}

// ---- Camera

function cameraApp(c: Ctx): string {
  const { snap, ui, t } = c
  const last = snap.record.gallery[snap.record.gallery.length - 1]
  let view: string
  if (snap.preview === 'none')
    view = `<div class="aph-cam-msg"><i class="fa-solid fa-eye-slash"></i>${esc(t('noSubject'))}</div>`
  else if (snap.preview) view = `<img class="aph-cam-img" src="${esc(snap.preview)}" alt="">`
  else view = `<div class="aph-cam-msg"><i class="fa-solid fa-circle-notch fa-spin"></i></div>`
  return `<div class="aph-camera">
  <div class="aph-cam-top"><i class="fa-solid fa-bolt"></i><span class="aph-cam-ratio">4:3</span><i class="fa-solid fa-gear"></i></div>
  <div class="aph-cam-view" data-action="refreshPreview">
    ${view}
    <div class="aph-cam-grid"></div>
    <div class="aph-cam-focus"></div>
    <div class="aph-cam-flash" data-shutter="${ui.shutter}"></div>
  </div>
  <div class="aph-cam-zoom"><span>0.5</span><span class="is-on">1×</span><span>2</span></div>
  <div class="aph-cam-modes"><span>${esc(t('cam.video'))}</span><span class="is-on">${esc(t('cam.photo'))}</span><span>${esc(t('cam.pano'))}</span></div>
  <div class="aph-cam-controls">
    <button type="button" class="aph-cam-last" data-action="open" data-arg="photos" aria-label="${esc(t('apps.photos'))}"${last ? ` style="background-image:${cssUrl(last.src)}"` : ''}></button>
    <button type="button" class="aph-shutter" data-action="shutter" aria-label="${esc(t('takePhoto'))}"><span></span></button>
    <button type="button" class="aph-cam-flip" data-action="refreshPreview" aria-label="${esc(t('refresh'))}"><i class="fa-solid fa-arrows-rotate"></i></button>
  </div>
</div>`
}

// ---- Photos

function photosApp(c: Ctx): string {
  const { snap, ui, t } = c
  if (ui.sendPhoto) return sendPhotoSheet(c)
  const photo = ui.photo ? snap.record.gallery.find(p => p.id === ui.photo) : null
  if (photo) {
    return `<div class="aph-photo-full">
  <header class="aph-head aph-head--overlay"><button type="button" class="aph-head-back" data-action="back"><i class="fa-solid fa-chevron-left"></i>${esc(t('apps.photos'))}</button><h2>${esc(stamp(c, photo.taken))}</h2><span></span></header>
  <div class="aph-photo-stage"><img src="${esc(photo.src)}" alt=""></div>
  <form class="aph-caption" data-submit="photoCaption"><input type="text" name="caption" value="${esc(photo.caption)}" maxlength="140" placeholder="${esc(t('addCaption'))}" autocomplete="off"><button type="submit" aria-label="${esc(t('save'))}"><i class="fa-solid fa-check"></i></button></form>
  <div class="aph-photo-bar">
    <button type="button" data-action="photoSend" data-arg="${esc(photo.id)}"><i class="fa-solid fa-paper-plane"></i><span>${esc(t('send'))}</span></button>
    <button type="button" class="is-danger" data-action="photoDelete" data-arg="${esc(photo.id)}"><i class="fa-solid fa-trash"></i><span>${esc(t('delete'))}</span></button>
  </div>
</div>`
  }
  const photos = [...snap.record.gallery].reverse()
  const grid = photos
    .map(
      p =>
        `<button type="button" class="aph-thumb${p.fresh ? ' is-fresh' : ''}" data-action="photo" data-arg="${esc(p.id)}" style="background-image:${cssUrl(p.src)}"></button>`
    )
    .join('')
  return `<div class="aph-app-view aph-photos">
  ${header(c, t('apps.photos'), { back: false, sub: photos.length === 1 ? t('photoCountOne') : t('photoCount', { n: photos.length }) })}
  <div class="aph-scroll" data-scroll="photos">${grid ? `<div class="aph-photo-grid">${grid}</div>` : empty('fa-images', t('noPhotos'))}</div>
  ${snap.storage >= 80 ? `<div class="aph-storage">${esc(t('storageUsed', { n: snap.storage }))}</div>` : ''}
</div>`
}

function sendPhotoSheet(c: Ctx): string {
  const { snap, t } = c
  const me = { id: snap.device.id, number: snap.device.number }
  const threads = buildThreads(snap.messages, me, snap.record.read).map(th => th.key)
  const numbers = [...new Set([...threads, ...sortedContacts(snap.record.contacts).map(ct => ct.number)])]
  return `<div class="aph-app-view aph-photos">
  ${header(c, t('sendTo'))}
  <form class="aph-to" data-submit="sendPhotoTo"><label>${esc(t('to'))}</label><input type="tel" name="to" placeholder="${esc(t('numberPlaceholder'))}" autocomplete="off"><button type="submit" class="aph-pill-btn">${esc(t('next'))}</button></form>
  <div class="aph-scroll">${numbers
    .map(
      n =>
        `<button type="button" class="aph-row" data-action="sendPhotoTo" data-arg="${esc(n)}">${avatar(c, n, 'sm')}<span class="aph-row-main"><span class="aph-row-title">${esc(nameOf(c, n))}</span><span class="aph-row-sub">${esc(fmt(n))}</span></span></button>`
    )
    .join('')}</div>
</div>`
}

// ---- Maps

function mapsApp(c: Ctx): string {
  const { snap, ui, t } = c
  const map = snap.map
  if (!map?.src) {
    return `<div class="aph-map aph-map--none">
  <div class="aph-map-blank"></div>
  <div class="aph-map-search"><i class="fa-solid fa-magnifying-glass"></i><span>${esc(map?.place || t('maps.search'))}</span></div>
  <div class="aph-map-nodata"><i class="fa-solid fa-map"></i><b>${esc(t('maps.noData'))}</b><span>${esc(t('maps.noDataHint'))}</span></div>
</div>`
  }
  const g = mapGeometry(snap)
  const view = ui.map ?? centredView(g, map.dot)
  const p = layerPlacement(view, g)
  const dot = map.dot
    ? `<span class="aph-map-dot" style="left:${(map.dot.u * 100).toFixed(3)}%;top:${(map.dot.v * 100).toFixed(3)}%"><i></i></span>`
    : ''
  return `<div class="aph-map" data-map>
  <div class="aph-map-layer" data-map-layer style="left:${p.left.toFixed(1)}px;top:${p.top.toFixed(1)}px;width:${p.w.toFixed(1)}px;height:${p.h.toFixed(1)}px">
    <img src="${esc(map.src)}" alt="" draggable="false">${dot}
  </div>
  <div class="aph-map-search"><i class="fa-solid fa-magnifying-glass"></i><span>${esc(map.place)}</span></div>
  ${map.dot ? '' : `<div class="aph-map-lost">${esc(t('maps.notHere'))}</div>`}
  <div class="aph-map-tools">
    <button type="button" data-action="mapZoom" data-arg="in" aria-label="${esc(t('maps.zoomIn'))}"><i class="fa-solid fa-plus"></i></button>
    <button type="button" data-action="mapZoom" data-arg="out" aria-label="${esc(t('maps.zoomOut'))}"><i class="fa-solid fa-minus"></i></button>
    <button type="button" class="aph-map-me" data-action="mapRecentre" aria-label="${esc(t('maps.recentre'))}"><i class="fa-solid fa-location-arrow"></i></button>
  </div>
</div>`
}

// ---- Notes

function notesApp(c: Ctx): string {
  const { snap, ui, t } = c
  const note = ui.note ? snap.record.notes.find(n => n.id === ui.note) : null
  if (ui.note) {
    return `<div class="aph-app-view aph-notes aph-notes--edit">
  ${header(c, '', { action: 'noteDelete', actionIcon: 'fa-trash', actionLabel: t('delete') })}
  <div class="aph-note-date">${esc(note ? dayLabel(c, note.updated) : '')}</div>
  <textarea class="aph-note-text" name="note" data-note placeholder="${esc(t('notePlaceholder'))}" data-focus>${esc(note?.text ?? '')}</textarea>
</div>`
  }
  const notes = sortedNotes(snap.record.notes)
  const rows = notes
    .map(n => {
      const lines = n.text.split('\n').filter(l => l.trim())
      return `<button type="button" class="aph-note-row" data-action="note" data-arg="${esc(n.id)}"><b>${esc(noteTitle(n, t('untitled')))}</b><span><em>${esc(stamp(c, n.updated))}</em> ${esc(lines[1] ?? t('noText'))}</span></button>`
    })
    .join('')
  return `<div class="aph-app-view aph-notes">
  ${header(c, t('apps.notes'), { back: false, sub: notes.length === 1 ? t('noteCountOne') : t('noteCount', { n: notes.length }) })}
  <div class="aph-scroll" data-scroll="notes"><div class="aph-note-list">${rows || empty('fa-note-sticky', t('noNotes'))}</div></div>
  <button type="button" class="aph-fab" data-action="noteNew" aria-label="${esc(t('newNote'))}"><i class="fa-solid fa-pen-to-square"></i></button>
</div>`
}

// ---- Clock

function clockApp(c: Ctx): string {
  const { snap, t } = c
  const day = gameTime(snap.clock.start, snap.clock.worldTime)
  const dayNo = Math.floor(snap.clock.worldTime / 86400) + 1
  const hourDeg = ((day.hour % 12) + day.minute / 60) * 30
  const minDeg = (day.minute + day.second / 60) * 6
  return `<div class="aph-app-view aph-clock">
  ${header(c, t('apps.clock'), { back: false })}
  <div class="aph-clock-face">
    <div class="aph-dial">
      ${Array.from({ length: 12 }, (_, i) => `<i style="transform:rotate(${i * 30}deg)"></i>`).join('')}
      <b class="aph-hand aph-hand--h" style="transform:rotate(${hourDeg}deg)"></b>
      <b class="aph-hand aph-hand--m" style="transform:rotate(${minDeg}deg)"></b>
      <span class="aph-dial-pin"></span>
    </div>
    <div class="aph-clock-digital">${live(c, 'big')}<small>:${live(c, 'seconds')}</small>${c.h24 ? '' : `<em>${live(c, 'suffix')}</em>`}</div>
    <div class="aph-clock-date">${live(c, 'date')}</div>
    <div class="aph-clock-day">${esc(t('campaignDay', { n: dayNo }))}</div>
  </div>
  <button type="button" class="aph-switch-row" data-action="h24"><span>${esc(t('h24'))}</span><span class="aph-switch${c.h24 ? ' is-on' : ''}"><i></i></span></button>
</div>`
}

// ---- Calculator

const CALC_KEYS: [string, string, string][] = [
  ['C', 'C', 'fn'],
  ['back', '⌫', 'fn'],
  ['%', '%', 'fn'],
  ['/', '÷', 'op'],
  ['7', '7', ''],
  ['8', '8', ''],
  ['9', '9', ''],
  ['*', '×', 'op'],
  ['4', '4', ''],
  ['5', '5', ''],
  ['6', '6', ''],
  ['-', '−', 'op'],
  ['1', '1', ''],
  ['2', '2', ''],
  ['3', '3', ''],
  ['+', '+', 'op'],
  ['neg', '±', ''],
  ['0', '0', ''],
  ['.', '.', ''],
  ['=', '=', 'eq'],
]

function calcApp(c: Ctx): string {
  const { ui } = c
  const keys = CALC_KEYS.map(
    ([input, label, kind]) =>
      `<button type="button" class="aph-calc-key${kind ? ` aph-calc-key--${kind}` : ''}${kind === 'op' && ui.calc.op === input && ui.calc.fresh ? ' is-on' : ''}" data-action="calc" data-arg="${esc(input)}">${esc(label)}</button>`
  ).join('')
  const display = ui.calc.display
  const size = display.length > 11 ? ' is-small' : display.length > 8 ? ' is-mid' : ''
  return `<div class="aph-app-view aph-calc">
  <div class="aph-calc-screen"><div class="aph-calc-pending">${esc(calcPendingLine(ui.calc))}</div><div class="aph-calc-display${size}">${esc(display)}</div></div>
  <div class="aph-calc-keys">${keys}</div>
</div>`
}
