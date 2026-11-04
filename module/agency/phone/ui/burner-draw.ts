/**
 * Paints the burner's top screen into an Lcd buffer. Pure apart from the image provider, which hands
 * back photos already reduced to LCD levels (or null while they load).
 */
import { callElapsed } from '../call-state.ts'
import { calcPendingLine, OP_SYMBOL } from '../calculator.ts'
import { formatClock, formatDateNumeric, formatDateShort, formatDuration, gameTime, clockText } from '../clock.ts'
import { formatNumber } from '../numbers.ts'
import { t9View, type T9State } from '../t9.ts'
import { missedCalls, snippet, threadMessages } from '../threads.ts'
import {
  BURNER_MENU,
  CONTACT_OPTS,
  callRows,
  contactRows,
  memoRows,
  photoRows,
  threadRows,
  top,
  type BurnerUI,
  type Route,
} from './burner.ts'
import { ADVANCE, clip, LINE_H, textWidth, wrapText } from './lcd-font.ts'
import { Lcd, LCD_H, LCD_W, type Shade } from './lcd.ts'
import { noteTitle, type PhoneSnapshot, type Translate } from './model.ts'

/** Photo levels at a size: 0 (dark) ... 3 (light), or null while loading. */
export type ImageLevels = (src: string, w: number, h: number) => Uint8Array | null

const TOP = 22 // first content row
const BOTTOM = 116 // soft-key rule
const ROW_H = 11
const COLS = Math.floor((LCD_W - 4) / ADVANCE) // 20

interface Ctx {
  lcd: Lcd
  ui: BurnerUI
  snap: PhoneSnapshot
  t: Translate
  now: number
  img: ImageLevels
  h24: boolean
}

const dash = (n: string) => formatNumber(n, 'dash')
const nameOf = (c: Ctx, n: string) => c.snap.names[n] || dash(n)
const blink = (now: number) => Math.floor(now / 500) % 2 === 0

// ---------------------------------------------------------------------------------------------
// Frame pieces

function statusBar(c: Ctx): void {
  const { lcd, snap } = c
  lcd.bars(1, 1, snap.signal ? snap.bars : 0)
  let x = 15
  const me = { id: snap.device.id, number: snap.device.number }
  const unread = threadRows(snap).some(th => th.unread > 0)
  if (unread && blink(c.now + 250)) {
    lcd.icon(x, 2, 'envelope')
    x += 9
  } else if (unread) x += 9
  if (missedCalls(snap.messages, me, snap.record.callsSeen)) {
    lcd.icon(x, 2, 'missed')
    x += 9
  }
  if (snap.flashlight) lcd.icon(x, 1, 'bulb')
  const g = gameTime(snap.clock.start, snap.clock.worldTime)
  const { time } = formatClock(g, true)
  lcd.textRight(LCD_W - 17, 1, time, 3)
  lcd.battery(LCD_W - 14, 1, 2)
}

function titleBar(c: Ctx, title: string, right = ''): void {
  const { lcd } = c
  lcd.rect(0, 10, LCD_W, 11, 3)
  const room = right ? COLS - right.length - 1 : COLS
  lcd.text(3, 12, clip(title, room), 0)
  if (right) lcd.textRight(LCD_W - 3, 12, right, 0)
}

function softKeys(c: Ctx, left: string, right: string, mid = ''): void {
  const { lcd, t } = c
  lcd.hline(0, BOTTOM, LCD_W, 1)
  if (left) lcd.text(2, BOTTOM + 3, t(left), 3)
  if (right) lcd.textRight(LCD_W - 2, BOTTOM + 3, t(right), 3)
  if (mid) lcd.textCenter(BOTTOM + 3, t(mid), 2)
}

/** A scrolling list; `draw` paints one row. Returns nothing; handles selection and scrollbar. */
function list(c: Ctx, count: number, sel: number, draw: (i: number, y: number, selected: boolean) => void): void {
  const { lcd } = c
  const visible = Math.floor((BOTTOM - TOP) / ROW_H)
  const first = Math.max(0, Math.min(sel - Math.floor(visible / 2), count - visible))
  for (let r = 0; r < visible && first + r < count; r++) {
    const i = first + r
    const y = TOP + r * ROW_H
    const selected = i === sel
    if (selected) lcd.roundRect(1, y - 1, count > visible ? LCD_W - 6 : LCD_W - 2, ROW_H, 3)
    draw(i, y, selected)
  }
  if (count > visible) {
    const trackH = visible * ROW_H
    lcd.vline(LCD_W - 3, TOP - 1, trackH, 1)
    const thumb = Math.max(6, Math.floor((trackH * visible) / count))
    const pos = Math.floor(((trackH - thumb) * sel) / Math.max(1, count - 1))
    lcd.rect(LCD_W - 4, TOP - 1 + pos, 3, thumb, 3)
  }
}

const ink = (selected: boolean): Shade => (selected ? 0 : 3)

function rowText(c: Ctx, y: number, text: string, selected: boolean, x = 4, right = ''): void {
  const room = COLS - Math.floor((x - 4) / ADVANCE) - (right ? right.length + 1 : 0)
  c.lcd.text(x, y + 1, clip(text, room), ink(selected))
  if (right) c.lcd.textRight(LCD_W - 8, y + 1, right, ink(selected))
}

function noticeBox(c: Ctx): void {
  const n = c.ui.notice
  if (!n || c.now >= n.until) return
  const { lcd, t } = c
  const lines = wrapText(t(n.text, n.data), 17).slice(0, 3)
  const h = lines.length * LINE_H + 10
  const y = Math.floor((LCD_H - h) / 2)
  lcd.rect(8, y, LCD_W - 16, h, 0)
  lcd.frame(8, y, LCD_W - 16, h, 3)
  lcd.frame(10, y + 2, LCD_W - 20, h - 4, 2)
  lines.forEach((line, i) => lcd.textCenter(y + 6 + i * LINE_H, line, 3))
}

/** Text editor area with wrapped text, the cycling letter inverted and a blinking cursor. */
function editor(c: Ctx, t9: T9State, y0: number, y1: number): void {
  const { lcd } = c
  const view = t9View(t9)
  const cols = COLS
  const full = view.text + (view.pending || '\u0000')
  const lines = wrapText(full, cols)
  const maxLines = Math.floor((y1 - y0) / LINE_H)
  const shown = lines.slice(-maxLines)
  shown.forEach((line, i) => {
    const y = y0 + i * LINE_H
    const isLast = i === shown.length - 1
    const plain = isLast ? line.slice(0, -1) : line
    lcd.text(3, y, plain.replace(/\u0000/g, ''), 3)
    if (isLast) {
      const x = 3 + plain.length * ADVANCE
      if (view.pending) {
        lcd.rect(x - 1, y - 1, ADVANCE + 1, LINE_H, 3)
        lcd.text(x, y, view.pending, 0)
      } else if (blink(c.now)) {
        lcd.vline(x, y - 1, 9, 3)
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Screens

function idle(c: Ctx): void {
  const { lcd, snap, t } = c
  const g = gameTime(snap.clock.start, snap.clock.worldTime)
  // A pixel skyline along the bottom, behind the soft keys.
  const skyline = [
    6, 9, 9, 14, 14, 11, 11, 18, 18, 18, 7, 7, 12, 12, 16, 16, 10, 10, 13, 13, 8, 8, 15, 15, 9, 9, 11, 11, 17, 17, 6, 6,
  ]
  for (let i = 0; i < skyline.length; i++) {
    const h = skyline[i]
    lcd.dither(i * 4, BOTTOM - h, 4, h, 1)
  }
  lcd.textCenter(13, snap.signal ? snap.carrier.toUpperCase() : t('b.noService'), snap.signal ? 3 : 3)
  const { time, suffix } = formatClock(g, c.h24)
  const big = time
  lcd.textCenter(28, big, 3, 3)
  if (suffix) lcd.textRight(LCD_W - 6, 28, suffix, 2)
  lcd.textCenter(55, formatDateShort(g, snap.clock.lang), 3)

  const me = { id: snap.device.id, number: snap.device.number }
  const unread = threadRows(snap).reduce((n, th) => n + th.unread, 0)
  const missed = missedCalls(snap.messages, me, snap.record.callsSeen)
  let y = 70
  if (unread) {
    lcd.rect(10, y - 2, LCD_W - 20, 12, 0)
    lcd.icon(14, y, 'envelope')
    lcd.text(25, y, t(unread === 1 ? 'b.newMessage' : 'b.newMessages', { n: unread }), 3)
    y += 12
  }
  if (missed) {
    lcd.rect(10, y - 2, LCD_W - 20, 12, 0)
    lcd.icon(14, y, 'missed')
    lcd.text(25, y, t(missed === 1 ? 'b.missedCall' : 'b.missedCalls', { n: missed }), 3)
  }
  lcd.rect(0, BOTTOM + 1, LCD_W, LCD_H - BOTTOM - 1, 0)
  softKeys(c, 'b.menuKey', 'b.names')
}

function menu(c: Ctx, route: Extract<Route, { s: 'menu' }>): void {
  const { lcd, t } = c
  titleBar(c, t(`b.menu.${BURNER_MENU[route.sel]}`), String(route.sel + 1))
  const cellW = 40
  const cellH = 31
  const x0 = 4
  const y0 = 23
  BURNER_MENU.forEach((id, i) => {
    const cx = x0 + (i % 3) * cellW
    const cy = y0 + Math.floor(i / 3) * cellH
    const selected = i === route.sel
    if (selected) {
      lcd.roundRect(cx + 2, cy, cellW - 4, cellH - 2, 3)
      lcd.icon(cx + 12, cy + 3, id === 'messages' ? 'messages' : id, true)
    } else {
      lcd.icon(cx + 12, cy + 3, id)
    }
    lcd.textCenter(cy + 20, String(i + 1), selected ? 0 : 2, 1, cx, cellW)
  })
  softKeys(c, 'b.select', 'b.back')
}

function threads(c: Ctx, route: Extract<Route, { s: 'threads' }>): void {
  const { lcd, snap, t } = c
  const rows = threadRows(snap)
  titleBar(c, t('b.menu.messages'), rows.length ? String(rows.length) : '')
  list(c, rows.length + 1, route.sel, (i, y, sel) => {
    if (i === 0) {
      rowText(c, y, t('b.newMessage1'), sel, 4)
      return
    }
    const th = rows[i - 1]
    if (th.unread) lcd.icon(3, y + 2, 'envelope', sel)
    else if (th.sending) lcd.text(4, y + 1, '…', ink(sel))
    else lcd.text(4, y + 1, th.lastDir === 'out' ? '▸' : '◂', sel ? 0 : 2)
    rowText(c, y, nameOf(c, th.key), sel, 12)
  })
  softKeys(c, 'b.open', 'b.back')
}

function thread(c: Ctx, route: Extract<Route, { s: 'thread' }>): void {
  const { lcd, snap, t } = c
  titleBar(c, nameOf(c, route.key))
  const me = { id: snap.device.id, number: snap.device.number }
  const items = threadMessages(snap.messages, me, route.key)
  // Lay out every message as lines, then show the window `scroll` lines up from the bottom.
  type Line = { text?: string; shade?: Shade; x?: number; img?: { src: string; w: number; h: number }; h: number }
  const lines: Line[] = []
  for (const { msg, dir } of items) {
    const g = gameTime(snap.clock.start, msg.sentAt)
    const who = dir === 'out' ? t('b.me') : clip(nameOf(c, route.key), 11)
    const status = dir === 'out' && msg.state === 'outbox' ? ` ${t('b.sending')}` : ''
    lines.push({ text: `${dir === 'out' ? '▸' : '◂'}${who} ${clockText(g, true)}${status}`, shade: 2, h: LINE_H })
    if (msg.photo) lines.push({ img: { src: msg.photo.src, w: 48, h: 36 }, h: 39 })
    for (const l of wrapText(msg.text ?? '', COLS - 1))
      if (l || msg.text) lines.push({ text: l, shade: 3, x: 9, h: LINE_H })
    lines.push({ h: 3 })
  }
  if (!items.length) lines.push({ text: t('b.noMessages'), shade: 2, h: LINE_H })
  // Pixel offsets from the bottom.
  const total = lines.reduce((n, l) => n + l.h, 0)
  const area = BOTTOM - TOP - 1
  const maxScroll = Math.max(0, Math.ceil((total - area) / LINE_H))
  const scroll = Math.min(route.scroll, maxScroll)
  let y = TOP + Math.min(0, area - total) + scroll * LINE_H
  for (const line of lines) {
    if (y + line.h > TOP - 2 && y < BOTTOM) {
      if (line.img) {
        const levels = c.img(line.img.src, line.img.w, line.img.h)
        lcd.frame(8, y, line.img.w + 2, line.img.h + 2, 3)
        if (levels) lcd.image(9, y + 1, line.img.w, line.img.h, levels)
        else lcd.dither(9, y + 1, line.img.w, line.img.h, 1)
      } else if (line.text) lcd.text(line.x ?? 2, y, line.text, line.shade ?? 3)
    }
    y += line.h
  }
  // Keep the title bar and soft keys clean.
  lcd.rect(0, 0, LCD_W, 10, 0)
  statusBar(c)
  titleBar(c, nameOf(c, route.key), scroll ? '▴' : '')
  lcd.rect(0, BOTTOM, LCD_W, LCD_H - BOTTOM, 0)
  softKeys(c, 'b.reply', 'b.back', 'b.call')
}

function compose(c: Ctx, route: Extract<Route, { s: 'compose' }>): void {
  const { lcd, t } = c
  const view = t9View(route.t9)
  titleBar(c, route.to ? `${t('b.to')} ${nameOf(c, route.to)}` : t('b.newMessage1'), '')
  // Mode and characters left, under the title like the old phones.
  lcd.text(2, TOP, route.t9.mode, 2)
  lcd.textRight(LCD_W - 2, TOP, String(view.remaining), 2)
  let y0 = TOP + 11
  if (route.photo) {
    lcd.frame(2, y0, 26, 20, 3)
    const levels = c.img(route.photo.src, 24, 18)
    if (levels) lcd.image(3, y0 + 1, 24, 18, levels)
    lcd.text(31, y0 + 6, t('b.photoAttached'), 2)
    y0 += 23
  }
  lcd.hline(0, y0 - 2, LCD_W, 1)
  editor(c, route.t9, y0, BOTTOM - 1)
  const empty = !route.t9.text && !route.t9.pending
  softKeys(c, 'b.send', empty ? 'b.back' : 'b.clear', 'b.options')
}

function pickTo(c: Ctx, route: Extract<Route, { s: 'pickTo' }>): void {
  const { t } = c
  titleBar(c, t('b.to'))
  const rows = contactRows(c.snap)
  list(c, rows.length + 1, route.sel, (i, y, sel) => {
    if (i === 0) rowText(c, y, t('b.enterNumber'), sel)
    else rowText(c, y, rows[i - 1].name, sel)
  })
  softKeys(c, 'b.select', 'b.back')
}

function numberEntry(c: Ctx, route: Extract<Route, { s: 'number' }>): void {
  const { lcd, t } = c
  titleBar(c, t('b.enterNumber'))
  const lines = wrapText(route.value, 10)
  lines.forEach((l, i) => lcd.text(4, TOP + 12 + i * 18, l, 3, 2))
  if (blink(c.now))
    lcd.vline(4 + textWidth(lines[lines.length - 1] ?? '', 2) + 2, TOP + 12 + (lines.length - 1) * 18, 15, 3)
  softKeys(c, 'b.ok', route.value ? 'b.clear' : 'b.back')
}

function names(c: Ctx, route: Extract<Route, { s: 'names' }>): void {
  const { t } = c
  const rows = contactRows(c.snap)
  titleBar(c, t('b.menu.names'), rows.length ? String(rows.length) : '')
  list(c, rows.length + 1, route.sel, (i, y, sel) => {
    if (i === 0) rowText(c, y, t('b.addNew'), sel)
    else rowText(c, y, rows[i - 1].name, sel)
  })
  softKeys(c, route.sel === 0 ? 'b.select' : 'b.options', 'b.back', route.sel === 0 ? '' : 'b.call')
}

function contact(c: Ctx, route: Extract<Route, { s: 'contact' }>): void {
  const { lcd, t } = c
  const ct = c.snap.record.contacts.find(x => x.id === route.id)
  if (!ct) return
  titleBar(c, ct.name)
  lcd.text(4, TOP, dash(ct.number), 2)
  lcd.hline(0, TOP + 10, LCD_W, 1)
  CONTACT_OPTS.forEach((opt, i) => {
    const y = TOP + 14 + i * ROW_H
    const sel = i === route.sel
    if (sel) lcd.roundRect(1, y - 1, LCD_W - 2, ROW_H, 3)
    rowText(c, y, `${i + 1} ${t(`b.${opt}`)}`, sel)
  })
  softKeys(c, 'b.select', 'b.back')
}

function editContact(c: Ctx, route: Extract<Route, { s: 'editContact' }>): void {
  const { lcd, t } = c
  titleBar(c, t(route.id ? 'b.editContact' : 'b.addNew'), route.field === 0 ? route.name.mode : '123')
  lcd.text(3, TOP, t('b.name'), 2)
  lcd.frame(1, TOP + 10, LCD_W - 2, 14, route.field === 0 ? 3 : 1)
  if (route.field === 0) editor(c, route.name, TOP + 13, TOP + 23)
  else lcd.text(3, TOP + 13, clip(route.name.text, COLS), 3)
  lcd.text(3, TOP + 30, t('b.number'), 2)
  lcd.frame(1, TOP + 40, LCD_W - 2, 14, route.field === 1 ? 3 : 1)
  const shown = route.number.length === 10 ? dash(route.number) : route.number
  lcd.text(3, TOP + 43, shown, 3)
  if (route.field === 1 && blink(c.now)) lcd.vline(3 + textWidth(shown) + 1, TOP + 42, 9, 3)
  lcd.text(3, TOP + 60, t('b.fieldHint'), 1)
  softKeys(c, 'b.save', 'b.back')
}

function calls(c: Ctx, route: Extract<Route, { s: 'calls' }>): void {
  const { lcd, t, snap } = c
  const rows = callRows(snap)
  titleBar(c, t('b.menu.calls'))
  if (!rows.length) lcd.textCenter(TOP + 30, t('b.noCalls'), 2)
  list(c, rows.length, route.sel, (i, y, sel) => {
    const r = rows[i]
    const mark = r.missed ? '!' : r.dir === 'out' ? '▸' : '◂'
    lcd.text(3, y + 1, mark, ink(sel))
    const g = gameTime(snap.clock.start, r.sentAt)
    rowText(c, y, nameOf(c, r.key), sel, 11, clockText(g, true))
  })
  const row = rows[route.sel]
  if (row) {
    const detail = row.outcome === 'answered' ? formatDuration(row.duration) : t(row.missed ? 'b.missed' : 'b.noAnswer')
    lcd.rect(0, BOTTOM - 11, LCD_W, 11, 0)
    lcd.hline(0, BOTTOM - 11, LCD_W, 1)
    lcd.text(3, BOTTOM - 9, detail, 2)
  }
  softKeys(c, 'b.options', 'b.back', 'b.call')
}

function dial(c: Ctx, route: Extract<Route, { s: 'dial' }>): void {
  const { lcd } = c
  const v = route.value
  const scale = v.length > 9 ? 2 : 3
  const per = Math.floor((LCD_W - 6) / (ADVANCE * scale))
  const lines = []
  for (let i = 0; i < v.length; i += per) lines.push(v.slice(i, i + per))
  const lh = 8 * scale + 2
  const y0 = Math.max(TOP, BOTTOM - 8 - lines.length * lh)
  lines.forEach((l, i) => lcd.textRight(LCD_W - 4, y0 + i * lh, l, 3, scale))
  const match = Object.entries(c.snap.names).find(([n]) => v.length >= 7 && n.endsWith(v))
  if (match) lcd.text(3, TOP, clip(match[1], COLS), 2)
  softKeys(c, 'b.save', 'b.clear', 'b.call')
}

function camera(c: Ctx): void {
  const { lcd, snap, t, ui } = c
  titleBar(c, t('b.menu.camera'))
  const w = 96
  const h = 72
  const x = Math.floor((LCD_W - w) / 2)
  const y = TOP + 2
  if (snap.preview && snap.preview !== 'none') {
    const levels = c.img(snap.preview, w, h)
    if (levels) lcd.image(x, y, w, h, levels)
    else lcd.dither(x, y, w, h, 1)
  } else {
    lcd.rect(x, y, w, h, 3)
    const msg = snap.preview === 'none' ? t('b.noSubject') : t('b.wait')
    wrapText(msg, 14).forEach((l, i) => lcd.textCenter(y + 24 + i * LINE_H, l, 0))
  }
  // Viewfinder corners
  const corner = (cx: number, cy: number, dx: number, dy: number) => {
    lcd.hline(dx > 0 ? cx : cx - 5, cy, 6, 0)
    lcd.vline(cx, dy > 0 ? cy : cy - 5, 6, 0)
  }
  corner(x + 4, y + 4, 1, 1)
  corner(x + w - 5, y + 4, -1, 1)
  corner(x + 4, y + h - 5, 1, -1)
  corner(x + w - 5, y + h - 5, -1, -1)
  lcd.frame(x - 1, y - 1, w + 2, h + 2, 3)
  if (c.now < ui.flashUntil) lcd.rect(x, y, w, h, 0)
  lcd.text(3, y + h + 4, `${snap.record.gallery.length}`, 2)
  lcd.textRight(LCD_W - 3, y + h + 4, '320x240', 2)
  softKeys(c, 'b.photos', 'b.back', 'b.capture')
}

function photos(c: Ctx, route: Extract<Route, { s: 'photos' }>): void {
  const { lcd, t } = c
  const rows = photoRows(c.snap)
  titleBar(c, t('b.menu.photos'), rows.length ? `${Math.min(route.sel + 1, rows.length)}/${rows.length}` : '')
  if (!rows.length) {
    lcd.textCenter(TOP + 30, t('b.noPhotos'), 2)
    softKeys(c, '', 'b.back')
    return
  }
  const tw = 36
  const th = 27
  const visibleRows = 3
  const rowOf = Math.floor(route.sel / 3)
  const firstRow = Math.max(0, rowOf - 1)
  for (let i = firstRow * 3; i < Math.min(rows.length, (firstRow + visibleRows) * 3); i++) {
    const col = i % 3
    const row = Math.floor(i / 3) - firstRow
    const x = 4 + col * (tw + 5)
    const y = TOP + 1 + row * (th + 4)
    const levels = c.img(rows[i].src, tw, th)
    if (levels) lcd.image(x, y, tw, th, levels)
    else lcd.dither(x, y, tw, th, 1)
    if (i === route.sel) {
      lcd.frame(x - 2, y - 2, tw + 4, th + 4, 3)
      lcd.frame(x - 1, y - 1, tw + 2, th + 2, 0)
    }
  }
  softKeys(c, 'b.view', 'b.back')
}

function photo(c: Ctx, route: Extract<Route, { s: 'photo' }>): void {
  const { lcd, snap, t } = c
  const p = snap.record.gallery.find(x => x.id === route.id)
  if (!p) return
  const w = 120
  const h = 90
  const levels = c.img(p.src, w, h)
  if (levels) lcd.image(4, TOP - 11, w, h, levels)
  else lcd.dither(4, TOP - 11, w, h, 1)
  lcd.rect(0, TOP + 80, LCD_W, BOTTOM - TOP - 80, 0)
  const g = gameTime(snap.clock.start, p.taken)
  lcd.text(2, TOP + 82, clip(p.caption || `${formatDateNumeric(g)} ${clockText(g, true)}`, COLS), p.caption ? 3 : 2)
  softKeys(c, 'b.options', 'b.back')
  void t
}

function caption(c: Ctx, route: Extract<Route, { s: 'caption' }>): void {
  const { t } = c
  titleBar(c, t('b.opt.caption'), route.t9.mode)
  editor(c, route.t9, TOP + 2, BOTTOM - 1)
  softKeys(c, 'b.save', route.t9.text ? 'b.clear' : 'b.back')
}

function torch(c: Ctx): void {
  const { lcd, snap, t } = c
  titleBar(c, t('b.menu.torch'))
  const on = snap.flashlight
  const cx = LCD_W / 2
  // Big bulb with rays when on.
  lcd.icon(cx - 8, TOP + 22, 'torch', on)
  if (on) {
    for (let i = 0; i < 3; i++) {
      lcd.rect(cx - 22 - i * 2, TOP + 8 + i * 4, 6, 1, 3)
      lcd.rect(cx + 16 + i * 2, TOP + 8 + i * 4, 6, 1, 3)
    }
  }
  lcd.textCenter(TOP + 48, t(on ? 'b.torchOn' : 'b.torchOff'), 3, 2)
  softKeys(c, on ? 'b.off' : 'b.on', 'b.back')
}

function memos(c: Ctx, route: Extract<Route, { s: 'memos' }>): void {
  const { t } = c
  const rows = memoRows(c.snap)
  titleBar(c, t('b.menu.memo'), rows.length ? String(rows.length) : '')
  list(c, rows.length + 1, route.sel, (i, y, sel) => {
    if (i === 0) rowText(c, y, t('b.newMemo'), sel)
    else rowText(c, y, noteTitle(rows[i - 1], t('b.untitled')), sel)
  })
  softKeys(c, 'b.open', 'b.back')
}

function memo(c: Ctx, route: Extract<Route, { s: 'memo' }>): void {
  const { lcd, t } = c
  const view = t9View(route.t9)
  titleBar(c, t('b.menu.memo'), route.t9.mode)
  lcd.textRight(LCD_W - 2, TOP, String(view.remaining), 2)
  editor(c, route.t9, TOP + 11, BOTTOM - 1)
  softKeys(c, 'b.save', route.t9.text || route.t9.pending ? 'b.clear' : 'b.back', 'b.options')
}

function clock(c: Ctx): void {
  const { lcd, snap, t } = c
  const g = gameTime(snap.clock.start, snap.clock.worldTime)
  titleBar(c, t('b.menu.clock'))
  const { time, suffix } = formatClock(g, c.h24)
  lcd.textCenter(TOP + 10, time, 3, 3)
  lcd.textCenter(TOP + 36, `:${String(g.second).padStart(2, '0')} ${suffix}`.trim(), 2)
  lcd.textCenter(TOP + 52, formatDateShort(g, snap.clock.lang), 3)
  lcd.textCenter(TOP + 62, formatDateNumeric(g), 2)
  lcd.hline(0, TOP + 76, LCD_W, 1)
  lcd.text(4, TOP + 80, t('b.format24'), 3)
  lcd.textRight(LCD_W - 4, TOP + 80, t(c.h24 ? 'b.on' : 'b.off'), 3)
  softKeys(c, 'b.change', 'b.back')
}

function calc(c: Ctx, route: Extract<Route, { s: 'calc' }>): void {
  const { lcd, t } = c
  titleBar(c, t('b.menu.calc'))
  const s = route.calc
  lcd.frame(2, TOP, LCD_W - 4, 40, 3)
  lcd.textRight(LCD_W - 6, TOP + 3, calcPendingLine(s), 2)
  const display = s.display
  const scale = display.length > 9 ? 1 : 2
  lcd.textRight(LCD_W - 6, TOP + (scale === 2 ? 20 : 26), display, 3, scale)
  // Operator hints in a D-pad cross.
  const cx = 34
  const cy = TOP + 60
  lcd.text(cx - 2, cy - 12, OP_SYMBOL['+'], 3)
  lcd.text(cx - 2, cy + 12, OP_SYMBOL['-'], 3)
  lcd.text(cx - 16, cy, OP_SYMBOL['*'], 3)
  lcd.text(cx + 12, cy, OP_SYMBOL['/'], 3)
  lcd.frame(cx - 6, cy - 3, 13, 13, 2)
  lcd.text(cx - 2, cy, '=', 3)
  lcd.text(70, cy - 12, t('b.calcPoint'), 2)
  lcd.text(70, cy, t('b.calcOps'), 2)
  lcd.text(70, cy + 12, t('b.calcEq'), 2)
  softKeys(c, 'b.clearAll', s.display === '0' && !s.op ? 'b.back' : 'b.clear')
}

function opts(c: Ctx, route: Extract<Route, { s: 'opts' }>): void {
  const { t } = c
  titleBar(c, t(`b.${route.title}`))
  list(c, route.items.length, route.sel, (i, y, sel) =>
    rowText(c, y, `${i + 1} ${t(`b.${route.items[i].label}`)}`, sel)
  )
  softKeys(c, 'b.select', 'b.back')
}

function confirm(c: Ctx, route: Extract<Route, { s: 'confirm' }>): void {
  const { lcd, t } = c
  titleBar(c, t('b.confirmTitle'))
  wrapText(t(`b.${route.text}`), COLS - 1).forEach((l, i) => lcd.textCenter(TOP + 20 + i * LINE_H, l, 3))
  softKeys(c, 'b.yes', 'b.no')
}

// ---- Calls

function callScreen(c: Ctx): void {
  const { lcd, snap, t, ui } = c
  const call = snap.call!
  const who = nameOf(c, call.remote.number)
  const known = !!snap.names[call.remote.number]
  switch (call.phase) {
    case 'incoming': {
      titleBar(c, t('b.incoming'))
      // Ringing handset that wiggles, with sound waves.
      const wiggle = Math.floor(c.now / 120) % 2 ? 1 : -1
      lcd.icon(LCD_W / 2 - 16 + wiggle, TOP + 2, 'calls', false, 2)
      if (blink(c.now)) lcd.waves(LCD_W / 2, TOP + 16, 22)
      lcd.textCenter(TOP + 40, clip(who, COLS), 3)
      if (known) lcd.textCenter(TOP + 51, dash(call.remote.number), 2)
      softKeys(c, 'b.answer', 'b.reject')
      return
    }
    case 'dialing': {
      titleBar(c, t('b.calling'))
      const dots = '.'.repeat((Math.floor(c.now / 400) % 4) + 0)
      lcd.icon(LCD_W / 2 - 16, TOP + 2, 'calls', false, 2)
      lcd.textCenter(TOP + 40, clip(who, COLS), 3)
      if (known) lcd.textCenter(TOP + 51, dash(call.remote.number), 2)
      lcd.textCenter(TOP + 66, `${t('b.calling')}${dots}`, 2)
      softKeys(c, '', 'b.end')
      return
    }
    case 'active': {
      titleBar(c, clip(who, 13), formatDuration(callElapsed(call, c.now)))
      let y = TOP
      if (call.muted || call.remoteMuted) {
        lcd.icon(3, y + 1, 'muted')
        lcd.text(11, y, t(call.muted ? 'b.muted' : 'b.theyMuted'), 2)
        y += 10
      }
      // Subtitles, newest at the bottom, above the input line.
      const lines: { text: string; shade: Shade }[] = []
      for (const l of call.lines.slice(-8)) {
        const prefix = l.who === 'me' ? '▸' : '◂'
        wrapText(`${prefix}${l.text}`, COLS).forEach(text => lines.push({ text, shade: l.who === 'me' ? 2 : 3 }))
      }
      const inputTop = BOTTOM - 22
      const room = Math.floor((inputTop - y - 2) / LINE_H)
      if (!lines.length)
        wrapText(t('b.subtitlesHint'), COLS)
          .slice(0, room)
          .forEach((l, i) => lcd.text(2, y + i * LINE_H, l, 1))
      lines.slice(-room).forEach((l, i) => lcd.text(2, y + i * LINE_H, l.text, l.shade))
      lcd.hline(0, inputTop - 1, LCD_W, 1)
      editor(c, ui.say, inputTop + 1, BOTTOM - 1)
      const typing = !!(ui.say.text || ui.say.pending)
      softKeys(c, call.muted ? 'b.unmute' : 'b.mute', typing ? 'b.clear' : 'b.end', typing ? 'b.say' : '')
      return
    }
    default: {
      titleBar(c, t('b.callEnded'))
      lcd.icon(LCD_W / 2 - 8, TOP + 4, 'calls')
      lcd.textCenter(TOP + 24, clip(who, COLS), 3)
      wrapText(t(`ended.${call.end ?? 'hangup'}`), COLS)
        .slice(0, 3)
        .forEach((l, i) => lcd.textCenter(TOP + 36 + i * LINE_H, l, 2))
      if (call.startedAt)
        lcd.textCenter(TOP + 68, formatDuration(Math.floor((call.endedAt - call.startedAt) / 1000)), 3, 2)
      softKeys(c, '', 'b.ok')
    }
  }
}

// ---------------------------------------------------------------------------------------------

export function drawBurner(
  lcd: Lcd,
  ui: BurnerUI,
  snap: PhoneSnapshot,
  t: Translate,
  now: number,
  img: ImageLevels
): void {
  const c: Ctx = { lcd, ui, snap, t, now, img, h24: snap.record.prefs.h24 }
  lcd.clear(0)
  const call = snap.call
  if (call && (call.phase !== 'ended' || now - call.endedAt < 2500)) {
    statusBar(c)
    callScreen(c)
    return
  }
  const route = top(ui)
  if (route.s !== 'photo') statusBar(c)
  switch (route.s) {
    case 'idle':
      idle(c)
      break
    case 'menu':
      menu(c, route)
      break
    case 'threads':
      threads(c, route)
      break
    case 'thread':
      thread(c, route)
      break
    case 'compose':
      compose(c, route)
      break
    case 'pickTo':
      pickTo(c, route)
      break
    case 'number':
      numberEntry(c, route)
      break
    case 'names':
      names(c, route)
      break
    case 'contact':
      contact(c, route)
      break
    case 'editContact':
      editContact(c, route)
      break
    case 'calls':
      calls(c, route)
      break
    case 'dial':
      dial(c, route)
      break
    case 'camera':
      camera(c)
      break
    case 'photos':
      photos(c, route)
      break
    case 'photo':
      photo(c, route)
      break
    case 'caption':
      caption(c, route)
      break
    case 'torch':
      torch(c)
      break
    case 'memos':
      memos(c, route)
      break
    case 'memo':
      memo(c, route)
      break
    case 'clock':
      clock(c)
      break
    case 'calc':
      calc(c, route)
      break
    case 'opts':
      opts(c, route)
      break
    case 'confirm':
      confirm(c, route)
      break
  }
  noticeBox(c)
  void snippet
}

/** Burner chassis (HTML). The screen is a <canvas data-lcd> the controller paints. */
export function renderBurnerChassis(snap: PhoneSnapshot, t: Translate, scale = 1): string {
  const esc = (v: unknown) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
    )
  const key = (k: string, label: string, inner: string, cls = '') =>
    `<button type="button" class="aph-bk${cls ? ` ${cls}` : ''}" data-key="${k}" aria-label="${esc(label)}">${inner}</button>`
  const digit = (k: string, sub: string) => key(k, k, `<span>${esc(k)}</span><small>${esc(sub)}</small>`)
  const pad: [string, string][] = [
    ['1', '.,?'],
    ['2', 'ABC'],
    ['3', 'DEF'],
    ['4', 'GHI'],
    ['5', 'JKL'],
    ['6', 'MNO'],
    ['7', 'PQRS'],
    ['8', 'TUV'],
    ['9', 'WXYZ'],
    ['*', '+=/'],
    ['0', '␣'],
    ['#', 'Aa'],
  ]
  const inspect = snap.inspect
    ? `<div class="aph-inspect"><i class="fa-solid fa-user-secret"></i> ${esc(t('inspect', { name: snap.device.name }))}</div>`
    : ''
  return `<div class="aph-device aph-burner" data-skin="burner" tabindex="0" style="--aph-scale:${scale}">
  <div class="aph-chrome">
    <span class="aph-chrome-label">${esc(snap.device.name)}</span>
    <button type="button" class="aph-win-btn" data-win="close" data-tooltip="${esc(t('putAway'))}" aria-label="${esc(t('putAway'))}"><i class="fa-solid fa-xmark"></i></button>
  </div>
  ${inspect}
  <div class="aph-flip" data-drag>
    <div class="aph-flip-lid">
      <div class="aph-flip-speaker"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="aph-flip-bezel">
        <div class="aph-flip-brand">${esc(t('b.brand'))}</div>
        <div class="aph-lcd"><canvas data-lcd width="${LCD_W}" height="${LCD_H}"></canvas><div class="aph-lcd-glass"></div></div>
      </div>
    </div>
    <div class="aph-flip-hinge"><i></i><span></span><i></i></div>
    <div class="aph-flip-base">
      <div class="aph-nav">
        ${key('softL', t('b.keys.softL'), '', 'aph-bk--soft aph-bk--softL')}
        <div class="aph-dpad">
          ${key('up', t('b.keys.up'), '', 'aph-dpad-up')}
          ${key('left', t('b.keys.left'), '', 'aph-dpad-left')}
          ${key('ok', 'OK', 'OK', 'aph-dpad-ok')}
          ${key('right', t('b.keys.right'), '', 'aph-dpad-right')}
          ${key('down', t('b.keys.down'), '', 'aph-dpad-down')}
        </div>
        ${key('softR', t('b.keys.softR'), '', 'aph-bk--soft aph-bk--softR')}
        ${key('call', t('b.keys.call'), '<i class="fa-solid fa-phone"></i>', 'aph-bk--call')}
        ${key('end', t('b.keys.end'), '<i class="fa-solid fa-phone"></i>', 'aph-bk--end')}
      </div>
      <div class="aph-pad">${pad.map(([k, sub]) => digit(k, sub)).join('')}</div>
      <div class="aph-flip-mic"></div>
    </div>
  </div>
</div>`
}
