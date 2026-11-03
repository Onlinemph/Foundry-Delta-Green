/**
 * Parser for explosive damage strings, as GCS, this system and the books write them:
 *
 *   "4d cr ex [2d]"            book style, fragments before or after the type
 *   "4d+1 cr ex [2d cut]"      GCS style (the fragment type sits inside the brackets)
 *   "6dx2 cr ex", "6d×2 cr ex" multiplied dice
 *   "5d(10) cr inc ex"         armor divisor, extra damage modifiers (inc, sur, dkb...)
 *   "[3d] cut"                 fragments only
 *   "7d(10) cr ex with 6d [2d] cr ex linked"   High-Tech's linked explosions
 *   "4d+2 cr ex linked burn"   a linked component given by type only (it reuses the primary's dice)
 *   "HT-5 aff (10 yd.)"        an area affliction (stun grenades, HT193)
 *   "Smoke (7 yd.)"            a smoke cloud (HT192)
 *
 * Pure: no Foundry globals. Tested in test/agency/explosions-parse.test.ts.
 */

export interface DiceExpr {
  /** Number of six-sided dice (0 for a flat amount). */
  dice: number
  adds: number
  /** The "×N" after the dice; 1 when there is none. */
  multiplier: number
}

export interface FragSpec extends DiceExpr {
  /** 1 when there is no armor divisor. */
  armorDivisor: number
  type: string
  /** False when the string gave no fragment type (B414: fragmentation damage is cutting). */
  typed: boolean
}

export interface DamageComponent extends DiceExpr {
  /** 1 when there is no armor divisor; -1 for "ignores DR" (upstream's calculator convention; JSON-safe). */
  armorDivisor: number
  /** Canonical damage type (cr, cut, burn, pi+ ...), or '' when the string gives none. */
  type: string
  /** "ex": the component explodes (B414). */
  explosive: boolean
  /** Other damage modifiers, lower case: inc, sur, dkb, nkb ... */
  modifiers: string[]
  fragments: FragSpec | null
  /** "HT-5 aff": a resistance roll instead of damage. */
  affliction: { htModifier: number } | null
  /** "(10 yd.)": an area-effect radius in yards. */
  radius: number | null
  /** "Smoke (7 yd.)". */
  smoke: boolean
  /** True when the dice were copied from the primary component ("linked burn"). */
  inheritedDice: boolean
  text: string
}

export interface ExplosiveSpec {
  /** components[0] is the primary attack; the rest are linked to it. */
  components: DamageComponent[]
  raw: string
}

/** Armor divisor meaning "ignores DR" (as upstream's damage calculator writes it). */
export const IGNORES_DR = -1

/** Long and short spellings -> canonical damage type. */
const TYPE_ALIASES: Record<string, string> = {
  cr: 'cr',
  crush: 'cr',
  crushing: 'cr',
  cut: 'cut',
  cutting: 'cut',
  imp: 'imp',
  impaling: 'imp',
  'pi-': 'pi-',
  pi: 'pi',
  'pi+': 'pi+',
  'pi++': 'pi++',
  burn: 'burn',
  burning: 'burn',
  cor: 'cor',
  corrosion: 'cor',
  tox: 'tox',
  toxic: 'tox',
  fat: 'fat',
  fatigue: 'fat',
  aff: 'aff',
  affliction: 'aff',
  kb: 'kb',
}

/** Words that carry no meaning for us. */
const NOISE = new Set(['with', 'linked', 'and', 'damage', 'dmg', 'plus', '+', '-', 'x', 'yd', 'yds', 'yd.'])

export function normalizeText(text: string): string {
  return String(text ?? '')
    .replace(/[−–—]/g, '-')
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDivisor(raw: string): number | null {
  const text = raw.trim().toLowerCase()
  if (text === '∞' || text === 'inf' || text === 'infinity' || text === 'ignores dr') return IGNORES_DR
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : null
}

interface DicePrefix {
  expr: DiceExpr
  armorDivisor: number
  rest: string
  found: boolean
}

/**
 * Read "4d+2", "6dx2", "6d×3(10)", "5d(10)", "2d6-1", "1d(0.2)" from the start of a string.
 * A bare number ("3 burn") is a flat amount.
 */
function readDicePrefix(input: string): DicePrefix {
  let rest = input.trim()
  const expr: DiceExpr = { dice: 0, adds: 0, multiplier: 1 }
  let armorDivisor = 1
  let found = false

  const dice = rest.match(/^(\d+)\s*d(?:6)?(?=$|[\s+\-x(\[,;.])/i)
  if (dice) {
    expr.dice = Number(dice[1])
    rest = rest.slice(dice[0].length)
    found = true
    const adds = rest.match(/^\s*([+-])\s*(\d+)(?![\d.]*\s*(?:yd|yard))/i)
    if (adds) {
      expr.adds = Number(adds[2]) * (adds[1] === '-' ? -1 : 1)
      rest = rest.slice(adds[0].length)
    }
  } else {
    const flat = rest.match(/^(\d+)(?=\s+[a-z]|\s*\[|\s*$)/i)
    if (flat) {
      expr.adds = Number(flat[1])
      rest = rest.slice(flat[0].length)
      found = true
    }
  }

  if (found) {
    // Multiplier and armor divisor, in either order: "6dx3(10)" or "6d(10)x3".
    for (let i = 0; i < 2; i++) {
      const mult = rest.match(/^\s*x\s*(\d+(?:\.\d+)?)/i)
      if (mult) {
        expr.multiplier = Number(mult[1])
        rest = rest.slice(mult[0].length)
        continue
      }
      const div = rest.match(/^\s*\(\s*([^)]+?)\s*\)/)
      if (div && parseDivisor(div[1]) !== null) {
        armorDivisor = parseDivisor(div[1])!
        rest = rest.slice(div[0].length)
      }
    }
  }
  return { expr, armorDivisor, rest: rest.trim(), found }
}

/** Parse plain dice ("4d+1", "6dx2", "2d(0.5)"). Returns null if the text doesn't start with dice. */
export function parseDice(text: string): (DiceExpr & { armorDivisor: number }) | null {
  const prefix = readDicePrefix(normalizeText(text))
  return prefix.found ? { ...prefix.expr, armorDivisor: prefix.armorDivisor } : null
}

function canonicalType(word: string): string | null {
  return TYPE_ALIASES[word.toLowerCase()] ?? null
}

function parseFragments(inner: string): FragSpec | null {
  const prefix = readDicePrefix(inner)
  if (!prefix.found) return null
  let type = ''
  for (const word of prefix.rest.split(/[\s,]+/).filter(Boolean)) {
    const t = canonicalType(word)
    if (t) {
      type = t
      break
    }
  }
  return { ...prefix.expr, armorDivisor: prefix.armorDivisor, type: type || 'cut', typed: !!type }
}

function emptyComponent(text: string): DamageComponent {
  return {
    dice: 0,
    adds: 0,
    multiplier: 1,
    armorDivisor: 1,
    type: '',
    explosive: false,
    modifiers: [],
    fragments: null,
    affliction: null,
    radius: null,
    smoke: false,
    inheritedDice: false,
    text,
  }
}

/**
 * Parse one damage component (no "with"/"linked" in it). `linked`: a linked part, where a bare type
 * next to fragments ("burn [2d]") is the part's own type, not the fragments'.
 */
export function parseComponent(text: string, linked = false): DamageComponent {
  // Book text often reads "Dmg 3d cr ex".
  let rest = normalizeText(text)
    .replace(/[;,.]+$/, '')
    .replace(/^(?:dmg|damage)\.?:?\s+/i, '')
  const component = emptyComponent(rest)

  // "(10 yd.)" / "(7 yards)" area radius.
  const radius = rest.match(/\(\s*(\d+(?:\.\d+)?)\s*-?\s*(?:yd|yds|yard|yards)\.?\s*(?:radius)?\s*\)/i)
  if (radius) {
    component.radius = Number(radius[1])
    rest = rest.replace(radius[0], ' ')
  }

  // Fragments in brackets, anywhere.
  const frag = rest.match(/\[([^\]]*)\]/)
  if (frag) {
    component.fragments = parseFragments(frag[1])
    rest = rest.replace(frag[0], ' ')
  }

  // Affliction: "HT-5 aff", "HT aff".
  const aff = rest.match(/\bHT\s*(?:([+-])\s*(\d+))?\s*aff(?:liction)?\b/i)
  if (aff) {
    component.affliction = { htModifier: aff[2] ? Number(aff[2]) * (aff[1] === '-' ? -1 : 1) : 0 }
    component.type = 'aff'
    rest = rest.replace(aff[0], ' ')
  }

  if (/^\s*smoke\b/i.test(rest)) {
    component.smoke = true
    rest = rest.replace(/^\s*smoke\b/i, ' ')
  }

  const prefix = readDicePrefix(rest)
  if (prefix.found) {
    Object.assign(component, prefix.expr)
    component.armorDivisor = prefix.armorDivisor
    rest = prefix.rest
  }

  for (const raw of rest.split(/[\s,;]+/).filter(Boolean)) {
    const word = raw.toLowerCase().replace(/^\(|\)$/g, '')
    if (!word || NOISE.has(word)) continue
    if (word === 'ex' || word === 'explosive' || word === 'explosion') {
      component.explosive = true
      continue
    }
    const type = canonicalType(word)
    if (type && !component.type) {
      component.type = type
      continue
    }
    if (type) continue
    component.modifiers.push(word)
  }

  // "[3d] cut": no main dice, so a trailing type belongs to the fragments.
  const hasMain = component.dice > 0 || component.adds !== 0 || !!component.affliction || component.smoke
  if (!linked && !hasMain && component.fragments && component.type && !component.fragments.typed) {
    component.fragments = { ...component.fragments, type: component.type, typed: true }
    component.type = ''
  }

  // Hot fragments (B415; WP, HT172): "2d [1d(0.2)] burn ex" -- untyped fragments with a
  // fractional armor divisor on a burning explosion burn rather than cut.
  if (
    component.fragments &&
    !component.fragments.typed &&
    component.type === 'burn' &&
    component.fragments.armorDivisor > 0 &&
    component.fragments.armorDivisor < 1
  ) {
    component.fragments = { ...component.fragments, type: 'burn' }
  }

  return component
}

function hasDamage(c: DamageComponent): boolean {
  return c.dice > 0 || c.adds !== 0
}

function isEmpty(c: DamageComponent): boolean {
  return !hasDamage(c) && !c.fragments && !c.affliction && !c.smoke && !c.type && !c.explosive
}

/** Split "A with B linked", "A linked B", "A linked" into component texts. */
function splitLinked(text: string): string[] {
  const normalized = normalizeText(text)
  const withMatch = normalized.match(/^(.*?)\s+with\s+(.*)$/i)
  if (withMatch) {
    const primary = withMatch[1]
    const rest = withMatch[2]
      .replace(/\s+linked\s*$/i, '')
      .split(/\s+linked\s+(?:and\s+)?|\s+and\s+/i)
      .map(s => s.replace(/\s+linked$/i, ''))
    return [primary, ...rest]
  }
  return normalized
    .replace(/^with\s+/i, '')
    .split(/\s*\blinked\b\s*/i)
    .map(s => s.trim())
}

/**
 * Parse a damage string. Returns null when nothing in it is damage, an affliction or smoke
 * ("Special", "", "see notes").
 */
export function parseExplosive(text: string): ExplosiveSpec | null {
  const raw = String(text ?? '')
  if (!raw.trim()) return null
  const parts = splitLinked(raw).filter(p => p.length > 0)
  if (!parts.length) return null

  const components = parts.map((part, i) => parseComponent(part, i > 0)).filter(c => !isEmpty(c))
  if (!components.length) return null
  const [primary, ...linked] = components

  for (const c of linked) {
    // "4d+2 cr ex linked burn [2d]": fragments trailing a type-only linked part belong to the blast.
    if (!hasDamage(c) && c.fragments && !primary.fragments) {
      primary.fragments = c.fragments
      c.fragments = null
    }
    // "linked burn": a type alone takes the primary's dice and spreads with its blast.
    if (!hasDamage(c) && !c.fragments && !c.affliction && !c.smoke && hasDamage(primary)) {
      c.dice = primary.dice
      c.adds = primary.adds
      c.multiplier = primary.multiplier
      c.inheritedDice = true
      if (primary.explosive) c.explosive = true
    }
  }

  // "4d(10) with 1d [1d] cr ex linked": book shorthand, the primary takes the linked type.
  if (!primary.type && hasDamage(primary) && linked.length) {
    const typed = linked.find(c => c.type && c.type !== 'aff')
    if (typed) {
      primary.type = typed.type
      if (typed.explosive) primary.explosive = true
    }
  }

  const valid =
    hasDamage(primary) || !!primary.fragments || !!primary.affliction || primary.smoke || linked.some(hasDamage)
  return valid ? { components, raw } : null
}

/** Does this spec do anything this feature handles (a blast, fragments, an area affliction, smoke)? */
export function isExplosiveSpec(spec: ExplosiveSpec | null | undefined): spec is ExplosiveSpec {
  if (!spec) return false
  return spec.components.some(c => c.explosive || !!c.fragments || c.smoke || (!!c.affliction && !!c.radius))
}

/** "B414: dice of damage" -- the dice times any multiplier (6d×2 counts as 12 dice). */
export function diceCount(expr: DiceExpr): number {
  return expr.dice * expr.multiplier
}

export function formatDice(expr: DiceExpr): string {
  let text = expr.dice > 0 ? `${expr.dice}d` : ''
  if (expr.adds) text += expr.dice > 0 ? `${expr.adds > 0 ? '+' : '-'}${Math.abs(expr.adds)}` : String(expr.adds)
  if (!text) text = '0'
  if (expr.multiplier !== 1) text += `×${expr.multiplier}`
  return text
}

function formatDivisor(divisor: number): string {
  if (divisor === 1) return ''
  return divisor === IGNORES_DR ? '(∞)' : `(${divisor})`
}

export function formatFragments(frag: FragSpec): string {
  return `[${formatDice(frag)}${formatDivisor(frag.armorDivisor)}${frag.typed || frag.type !== 'cut' ? ` ${frag.type}` : ''}]`
}

/** Book-style text: "4d+1 [2d] cr ex", "HT-5 aff (10 yd.)". */
export function formatComponent(c: DamageComponent): string {
  const parts: string[] = []
  if (c.smoke) parts.push('Smoke')
  if (c.affliction)
    parts.push(
      `HT${c.affliction.htModifier ? (c.affliction.htModifier > 0 ? '+' : '') + c.affliction.htModifier : ''} aff`
    )
  if (c.dice > 0 || c.adds) parts.push(`${formatDice(c)}${formatDivisor(c.armorDivisor)}`)
  if (c.fragments) parts.push(formatFragments(c.fragments))
  if (c.type && c.type !== 'aff') parts.push(c.type)
  parts.push(...c.modifiers)
  if (c.explosive) parts.push('ex')
  if (c.radius) parts.push(`(${c.radius} yd.)`)
  return parts.join(' ')
}

export function formatSpec(spec: ExplosiveSpec): string {
  const [primary, ...linked] = spec.components
  const head = formatComponent(primary)
  return linked.length ? `${head} with ${linked.map(formatComponent).join(' and ')} linked` : head
}
