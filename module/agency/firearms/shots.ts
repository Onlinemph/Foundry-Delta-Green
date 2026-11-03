/**
 * GURPS "Shots" notation (B269, High-Tech).
 *
 *   17+1(3)    17 in the magazine, 1 more in the chamber, 3 seconds to change magazines
 *   8(3i)      8 rounds, loaded individually, 3 seconds per round
 *   30(3)      30-round magazine, 3 seconds to reload
 *   T(1)       thrown weapon, 1 second to ready another
 *   Sp, FP     special / costs fatigue: nothing to count
 *   4(3i)/6(3i) alternatives: the first one is the weapon's primary load
 *
 * Pure functions only: no Foundry globals, so jest can exercise them directly.
 */

export interface ShotsSpec {
  /** Rounds held in the magazine, cylinder, tube or belt (0 when untracked). */
  capacity: number
  /** Extra rounds held in the chamber: the "+1" in "17+1(3)". */
  chambered: number
  /** Seconds to reload; per round when `individual`. 0 when the notation doesn't say. */
  reloadSeconds: number
  /** "i": rounds are loaded one at a time. */
  individual: boolean
  /** "T": a thrown weapon (the weapon itself is the ammunition). */
  thrown: boolean
  /** Nothing in the weapon to count: blank, Sp, FP, thrown, unparseable. */
  untracked: boolean
}

const UNTRACKED: ShotsSpec = Object.freeze({
  capacity: 0,
  chambered: 0,
  reloadSeconds: 0,
  individual: false,
  thrown: false,
  untracked: true,
})

// <count or T> [+<chambered>] [( [<seconds>] [i] )]. Anything else in the parentheses ("T(F)") is ignored.
const SHOTS_PATTERN =
  /^(?<count>\d+|t)\s*(?:\+\s*(?<chambered>\d+))?\s*(?:\(\s*(?<time>\d+(?:[.,]\d+)?)?\s*(?<individual>i\b)?[^)]*\))?/i

// Any "(<seconds>[i])" in the string, used when the primary alternative omits the reload time.
const TIME_PATTERN = /\(\s*(?<time>\d+(?:[.,]\d+)?)\s*(?<individual>i)?\s*\)/i

// Footnote markers that GCS and the books hang off a stat.
const FOOTNOTES = /[*†‡§¶#]/g

function toSeconds(text: string | undefined): number {
  if (!text) return 0
  const value = parseFloat(text.replace(',', '.'))
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Parse a weapon's Shots value. Accepts anything (GCS stores '' or 0 for "no value").
 */
export function parseShots(raw: unknown): ShotsSpec {
  if (raw === null || raw === undefined) return { ...UNTRACKED }
  const text = String(raw).replace(FOOTNOTES, '').trim()
  if (!text || /^[-–—]+$/.test(text)) return { ...UNTRACKED }

  // Fatigue-powered and special weapons have nothing to reload.
  if (/fp/i.test(text) || /^sp\b/i.test(text)) return { ...UNTRACKED }

  // Alternatives ("4(3i)/6(3i)", "30(3)/100(5)") — the first is the weapon's primary load.
  const primary = text.split('/')[0].trim()
  const match = primary.match(SHOTS_PATTERN)
  if (!match?.groups) return { ...UNTRACKED }

  const groups = match.groups
  let reloadSeconds = toSeconds(groups.time)
  let individual = !!groups.individual
  if (!groups.time && !groups.individual) {
    // "20/C(3)": the reload time sits on a later alternative.
    const fallback = text.match(TIME_PATTERN)
    if (fallback?.groups) {
      reloadSeconds = toSeconds(fallback.groups.time)
      individual = !!fallback.groups.individual
    }
  }

  if (groups.count.toLowerCase() === 't') {
    return { ...UNTRACKED, thrown: true, reloadSeconds }
  }

  const capacity = parseInt(groups.count, 10)
  const chambered = groups.chambered ? parseInt(groups.chambered, 10) : 0
  if (!(capacity > 0) && !(chambered > 0)) return { ...UNTRACKED, reloadSeconds }

  return { capacity, chambered, reloadSeconds, individual, thrown: false, untracked: false }
}

/** True when the weapon holds rounds the tracker should count. */
export function isTracked(spec: ShotsSpec): boolean {
  return !spec.untracked && spec.capacity + spec.chambered > 0
}

/** Rounds in a fully loaded weapon, chamber included. */
export function fullLoad(spec: ShotsSpec): number {
  return isTracked(spec) ? spec.capacity + spec.chambered : 0
}

/** "14/17+1", "5/8", "0/1". Empty string for untracked weapons. */
export function formatRounds(loaded: number, spec: ShotsSpec): string {
  if (!isTracked(spec)) return ''
  const max = spec.chambered > 0 ? `${spec.capacity}+${spec.chambered}` : `${spec.capacity}`
  return `${Math.max(0, Math.floor(loaded))}/${max}`
}
