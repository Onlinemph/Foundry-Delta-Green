/**
 * In-game date and time: the campaign start (a world setting, 'YYYY-MM-DD HH:MM') plus
 * game.time.worldTime seconds. Computed in UTC so every client shows the same time whatever its
 * own time zone. The lock screen, status bars and Clock apps all read it from here.
 */

export const DEFAULT_START = '2025-11-04 08:00'

/** 'YYYY-MM-DD HH:MM' (or with a T, optional seconds) -> epoch ms of those wall-clock values in UTC. */
export function parseStart(start: unknown): number | null {
  const m = String(start ?? '')
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!m) return null
  const [y, mo, d, h = '0', mi = '0', s = '0'] = m.slice(1)
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  const check = new Date(ms)
  // Reject 2025-02-30 and friends instead of silently rolling over.
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) return null
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null
  return ms
}

export interface GameTime {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday. */
  weekday: number
  /** Epoch ms (UTC wall clock) for Intl formatting. */
  ms: number
}

export function gameTime(start: unknown, worldTime: number): GameTime {
  const base = parseStart(start) ?? parseStart(DEFAULT_START)!
  const ms = base + Math.floor((Number(worldTime) || 0) * 1000)
  const d = new Date(ms)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    ms,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** '21:07' or '9:07' + 'PM'. */
export function formatClock(t: GameTime, h24: boolean, seconds = false): { time: string; suffix: string } {
  const sec = seconds ? `:${pad(t.second)}` : ''
  if (h24) return { time: `${pad(t.hour)}:${pad(t.minute)}${sec}`, suffix: '' }
  const h = t.hour % 12 || 12
  return { time: `${h}:${pad(t.minute)}${sec}`, suffix: t.hour < 12 ? 'AM' : 'PM' }
}

/** One string: '21:07' / '9:07 PM'. */
export function clockText(t: GameTime, h24: boolean, seconds = false): string {
  const { time, suffix } = formatClock(t, h24, seconds)
  return suffix ? `${time} ${suffix}` : time
}

function intl(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang || 'en', { timeZone: 'UTC', ...options })
  } catch {
    return new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...options })
  }
}

/** 'Tuesday, November 4' */
export function formatDateLong(t: GameTime, lang = 'en'): string {
  return intl(lang, { weekday: 'long', month: 'long', day: 'numeric' }).format(t.ms)
}

/** 'Tue 4 Nov' */
export function formatDateShort(t: GameTime, lang = 'en'): string {
  const parts = intl(lang, { weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(t.ms)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')}`.replace(/\./g, '')
}

/** '04/11/2025' style for the burner's Clock screen (day first; old phones were set to UK format). */
export function formatDateNumeric(t: GameTime): string {
  return `${pad(t.day)}/${pad(t.month)}/${t.year}`
}

/**
 * Message timestamps: just the time for today, the weekday within a week, otherwise a short date.
 * `now` and `then` are world seconds.
 */
export function relativeStamp(
  start: unknown,
  now: number,
  then: number,
  h24: boolean,
  lang = 'en',
  yesterday = 'Yesterday'
): string {
  const a = gameTime(start, now)
  const b = gameTime(start, then)
  const dayA = Math.floor(a.ms / 86_400_000)
  const dayB = Math.floor(b.ms / 86_400_000)
  if (dayA === dayB) return clockText(b, h24)
  if (dayA - dayB === 1) return yesterday
  if (dayA - dayB < 7 && dayA > dayB) return intl(lang, { weekday: 'short' }).format(b.ms)
  return intl(lang, { day: 'numeric', month: 'short' }).format(b.ms)
}

/** Call durations: '0:42', '12:05', '1:02:09'. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}
