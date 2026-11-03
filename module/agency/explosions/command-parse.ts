/**
 * Pure helpers for the Foundry side: geometry for scatter and knockback, and the /explode command's
 * arguments. Tested in test/agency/explosions-command.test.ts.
 */
import { formatDice, parseExplosive, isExplosiveSpec, type DiceExpr } from './parse.ts'
import { chargeDice, diceFromCount, type BlastEnvironment } from './rules.ts'
import { findExplosive, parseWeight, type ExplosiveDef } from './specials.ts'

export interface Point {
  x: number
  y: number
}

/** Angle from a to b in canvas space (radians; y points down, so positive angles turn clockwise). */
export function facing(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x)
}

/**
 * The point `yards` from `origin`, turned `degrees` clockwise from `facingRadians` (B414 scatter:
 * 1 = the attacker's facing, each step 60° clockwise).
 */
export function offsetPoint(
  origin: Point,
  facingRadians: number,
  degrees: number,
  yards: number,
  pixelsPerYard: number
): Point {
  const angle = facingRadians + (degrees * Math.PI) / 180
  const distance = yards * pixelsPerYard
  return { x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance }
}

/** Knockback moves the target straight away from the blast (B378); a target on the center goes along `fallback`. */
export function pushAway(center: Point, target: Point, yards: number, pixelsPerYard: number, fallback = 0): Point {
  const dx = target.x - center.x
  const dy = target.y - center.y
  const angle = dx === 0 && dy === 0 ? fallback : Math.atan2(dy, dx)
  return {
    x: target.x + Math.cos(angle) * yards * pixelsPerYard,
    y: target.y + Math.sin(angle) * yards * pixelsPerYard,
  }
}

export interface ExplodeOptions {
  environment: BlastEnvironment
  /** HT181: 1, 1.5 (vented) or 2 (enclosed). */
  enclosed: number
  airburst: boolean
  /** B415: the targeted token is lying on the explosive. */
  contact: boolean
  /** B415: the explosive goes off inside the targeted token. */
  internal: boolean
  /** Detonate at the targeted token instead of a clicked point. */
  atTarget: boolean
}

export interface ExplodeRequest {
  label: string
  damage: string
  options: ExplodeOptions
  charge: { pounds: number; explosive: ExplosiveDef; dice: DiceExpr } | null
}

const OPTION_WORDS: Record<string, (o: ExplodeOptions) => void> = {
  airburst: o => (o.airburst = true),
  thermobaric: o => (o.environment = 'thermobaric'),
  fae: o => (o.environment = 'thermobaric'),
  'fuel-air': o => (o.environment = 'thermobaric'),
  underwater: o => (o.environment = 'underwater'),
  vacuum: o => (o.environment = 'vacuum'),
  enclosed: o => (o.enclosed = 2),
  contained: o => (o.enclosed = 2),
  vented: o => (o.enclosed = 1.5),
  contact: o => {
    o.contact = true
    o.atTarget = true
  },
  internal: o => {
    o.internal = true
    o.atTarget = true
  },
  '@target': o => (o.atTarget = true),
  target: o => (o.atTarget = true),
}

/** Words for special munitions -> the damage text that stands for them (HT192-193). */
const SPECIAL_WORDS: { pattern: RegExp; label: string; damage: (radius: number | null) => string }[] = [
  { pattern: /^(stun|flash-?bang|stun grenade)$/i, label: 'Stun grenade', damage: r => `HT-5 aff (${r ?? 10} yd.)` },
  { pattern: /^smoke$/i, label: 'Smoke', damage: r => `Smoke (${r ?? 7} yd.)` },
  { pattern: /^(tear ?gas|gas|cs)$/i, label: 'Tear gas', damage: r => `Smoke (${r ?? 7} yd.)` },
]

export function defaultExplodeOptions(): ExplodeOptions {
  return { environment: 'normal', enclosed: 1, airburst: false, contact: false, internal: false, atTarget: false }
}

/**
 * Parse the text after "/explode":
 *   4d cr ex [2d]            damage, as on a weapon
 *   2lb c4, 1.25 lbs semtex  a charge (B415 How Big a Blast?), optional "[1d]" fragments (nails, a pipe)
 *   flashbang, smoke 8       special munitions
 * plus option words anywhere: airburst, thermobaric, underwater, vacuum, enclosed, vented, contact,
 * internal, target.
 */
export function parseExplodeCommand(
  text: string
): ExplodeRequest | { error: 'empty' | 'unknownExplosive' | 'notExplosive'; detail?: string } {
  const options = defaultExplodeOptions()
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const kept: string[] = []
  for (const word of words) {
    const apply = OPTION_WORDS[word.toLowerCase()]
    if (apply) apply(options)
    else kept.push(word)
  }
  const rest = kept.join(' ')
  if (!rest) return { error: 'empty' }

  // A special munition, with an optional radius: "smoke 8".
  const specialMatch = rest.match(/^(.*?)(?:\s+(\d+))?$/)
  const specialName = specialMatch?.[1] ?? rest
  const special = SPECIAL_WORDS.find(s => s.pattern.test(specialName))
  if (special) {
    const radius = specialMatch?.[2] ? Number(specialMatch[2]) : null
    return { label: special.label, damage: special.damage(radius), options, charge: null }
  }

  // A charge: "<weight> <explosive> [fragments]".
  const frag = rest.match(/\[[^\]]*\]/)?.[0] ?? ''
  const withoutFrag = rest.replace(/\[[^\]]*\]/, '').trim()
  const charge = withoutFrag.match(
    /^((?:\d+(?:\.\d+)?|\.\d+)\s*(?:lbs?|pounds?|#|kg|kilos?|kilograms?|g|grams?|oz|ounces?))\s+(.+)$/i
  )
  if (charge) {
    const pounds = parseWeight(charge[1].replace(/\s+/g, ''))
    const explosive = findExplosive(charge[2])
    if (!explosive || !pounds) return { error: 'unknownExplosive', detail: charge[2] }
    const dice = diceFromCount(chargeDice(pounds, explosive.ref))
    const damage = `${formatDice(dice)}${frag ? ` ${frag}` : ''} cr ex`
    return { label: `${charge[1]} ${explosive.name}`, damage, options, charge: { pounds, explosive, dice } }
  }

  if (!isExplosiveSpec(parseExplosive(rest)) && !options.internal && !options.contact)
    return { error: 'notExplosive', detail: rest }
  return { label: rest, damage: rest, options, charge: null }
}

/**
 * A weapon's explosive text: its damage, plus a linked explosion that GCS sheets often keep in the
 * notes ("with 6d [2d] cr ex linked", High-Tech's HEDP / HEAT style).
 */
export function explosiveTextFor(damage: unknown, notes: unknown): string {
  const text = (Array.isArray(damage) ? damage.join(' ') : String(damage ?? '')).trim()
  if (/\blinked\b/i.test(text)) return text
  const n = String(notes ?? '')
  const linked =
    n.match(/\bwith\s+([^.;]*?\bex\b[^.;]*?\blinked\b)/i)?.[1] ?? n.match(/(\d+d[^.;]*?\bex\b[^.;]*?\blinked\b)/i)?.[1]
  return linked ? `${text} with ${linked}`.trim() : text
}
