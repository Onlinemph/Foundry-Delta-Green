/**
 * Phone numbers. Every generated number is a North American 555-0100..555-0199 number, the block set
 * aside for fiction, so no number on screen can belong to a real person. Stored as ten digits
 * ('2025550143'), shown as '(202) 555-0143' (smartphone) or '202-555-0143' (burner).
 *
 * The 100 fictional lines exist in every area code, so a campaign area code gives 100 numbers and
 * generation spills into other area codes when it runs out.
 */

/** Area codes used for burners and as overflow. Any area code works: 555-01xx is fictional in all of them. */
export const AREA_CODES = [
  '202',
  '212',
  '213',
  '305',
  '312',
  '404',
  '415',
  '503',
  '512',
  '602',
  '617',
  '702',
  '713',
  '718',
  '206',
  '303',
] as const

export const DEFAULT_AREA_CODE = '202'

export function digitsOnly(input: unknown): string {
  return String(input ?? '').replace(/\D+/g, '')
}

/** 555-0100 through 555-0199 in any area code. */
export function isFictional(number: string): boolean {
  return /^\d{3}55501\d{2}$/.test(number)
}

export function isAreaCode(code: unknown): code is string {
  return typeof code === 'string' && /^[2-9]\d{2}$/.test(code)
}

/**
 * What the user typed -> ten digits, or null if it can't be a number.
 * Seven digits get the default area code (dialling locally); a leading 1 on eleven digits is dropped.
 */
export function normalizeNumber(input: unknown, defaultArea: string = DEFAULT_AREA_CODE): string | null {
  let digits = digitsOnly(input)
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (digits.length === 7) digits = (isAreaCode(defaultArea) ? defaultArea : DEFAULT_AREA_CODE) + digits
  return digits.length === 10 ? digits : null
}

export function formatNumber(number: string, style: 'paren' | 'dash' = 'paren'): string {
  const d = digitsOnly(number)
  if (d.length !== 10) return d || String(number ?? '')
  const [a, b, c] = [d.slice(0, 3), d.slice(3, 6), d.slice(6)]
  return style === 'dash' ? `${a}-${b}-${c}` : `(${a}) ${b}-${c}`
}

/** Progressive formatting while dialling: '20255' -> '202-55'. */
export function formatPartial(input: string): string {
  const d = digitsOnly(input)
  if (d.length <= 3) return d
  // Reads as a local seven-digit number until it grows past seven.
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  return d
}

export function sameNumber(a: unknown, b: unknown): boolean {
  const x = digitsOnly(a)
  return !!x && x === digitsOnly(b)
}

/**
 * A fresh fictional number not in `taken`. Tries the preferred area code first, then the others in a
 * random order. Null only when every listed area code's 100 lines are used.
 */
export function generateNumber(
  taken: Iterable<string>,
  rng: () => number = Math.random,
  preferredArea?: string,
  areas: readonly string[] = AREA_CODES
): string | null {
  const used = new Set(Array.from(taken, n => digitsOnly(n)))
  const order: string[] = []
  if (isAreaCode(preferredArea)) order.push(preferredArea)
  const rest = areas.filter(a => a !== preferredArea)
  // Fisher-Yates with the injected rng, so tests are deterministic.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  order.push(...rest)
  for (const area of order) {
    const free: string[] = []
    for (let line = 0; line < 100; line++) {
      const number = `${area}55501${String(line).padStart(2, '0')}`
      if (!used.has(number)) free.push(number)
    }
    if (free.length) return free[Math.floor(rng() * free.length)]
  }
  return null
}

export type NumberCheck =
  | { ok: true; number: string; fictional: boolean }
  | { ok: false; error: 'format' | 'taken'; number?: string }

/** Validate a number the GM typed. `self` is the number being replaced (it may keep its own number). */
export function validateNumber(
  input: unknown,
  taken: Iterable<string>,
  defaultArea: string = DEFAULT_AREA_CODE,
  self?: string
): NumberCheck {
  const number = normalizeNumber(input, defaultArea)
  if (!number) return { ok: false, error: 'format' }
  const selfDigits = digitsOnly(self)
  for (const t of taken) {
    const d = digitsOnly(t)
    if (d === number && d !== selfDigits) return { ok: false, error: 'taken', number }
  }
  return { ok: true, number, fictional: isFictional(number) }
}
