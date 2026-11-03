/**
 * Data for special munitions and explosives. To support another grenade, add an entry to SPECIALS;
 * to support another explosive for "/explode 2lb <name>", add it to EXPLOSIVES.
 * Pure data and lookups; tested in test/agency/explosions-rules.test.ts.
 */
import type { BlastEnvironment } from './rules.ts'
import type { ExplosiveSpec } from './parse.ts'

export interface SpecialAffliction {
  /** Modifier to the HT roll to resist (HT-5 for a stun grenade). */
  htModifier: number
  /** Status applied on a failed roll (a Foundry status id). */
  status: 'stun'
  /** Traits whose names match give a bonus to the roll. */
  bonuses: { trait: RegExp; bonus: number }[]
  /** Recovery roll each turn (modifier to HT). */
  recovery: number
}

export interface SpecialDef {
  id: string
  /** i18n key suffix: GURPS.agency.explosions.special.<id>. */
  label: string
  /** Page reference shown on the card. */
  ref: string
  /** Matched against the weapon name, its damage text and its notes. Any match selects the special. */
  match: { name?: RegExp; damage?: RegExp; notes?: RegExp }
  /** Radius of an area affliction (yards). */
  afflictionRadius?: number
  affliction?: SpecialAffliction
  /** A smoke cloud: radius in yards (null = take it from the damage text) and how long it lasts (null = not given). */
  smoke?: { radius: number | null; seconds: number | null }
  /** A tear-gas cloud: radius in yards, seconds. HT171: two HT-2 rolls (coughing, blindness). */
  gas?: { radius: number | null; seconds: number | null }
  environment?: BlastEnvironment
  airburst?: boolean
  /** B415 Hot Fragments: 1d(0.2) burn every 10 seconds for a minute. */
  hotFragments?: boolean
  /** Extra i18n note keys for the card. */
  notes?: string[]
}

/**
 * Special munitions with clear mechanics in the books.
 * - Stun / flashbang: HT193 note [7]. Vision- and hearing-based, 10-yard radius, HT-5 to resist,
 *   +5 each for Protected Hearing and Protected Vision, failure stuns, HT-5 each turn to recover, makes smoke.
 * - Smoke: HT171 (screening smoke, -10 to sight through it), HT192 (AN-M8: 7 yards, ~80 s), HT143 (40mm: 8 yards, 25 s).
 * - Tear gas: HT171, HT192 (M7: 7 yards, 25 s), HT143 (40mm: 8 yards, 20 s).
 * - White phosphorus: HT172, HT193 (M34: 5-yard smoke for about a minute, hot fragments B415).
 * - Thermobaric / fuel-air: HT170, HT187 (collateral divided by 2 × yards).
 * - Airburst: B415 (no posture modifier; only overhead cover protects).
 * - Incendiary: the linked burning damage comes from the damage string ("linked burn"); see Catching Fire (B434).
 */
export const SPECIALS: SpecialDef[] = [
  {
    id: 'stun',
    label: 'stun',
    ref: 'HT193',
    match: {
      name: /\b(stun|flash\s*-?\s*bang|stingball|stingmore|distraction device|nfdd|9-?banger)\b/i,
      damage: /\bHT\s*-\s*5\s*aff/i,
    },
    afflictionRadius: 10,
    affliction: {
      htModifier: -5,
      status: 'stun',
      bonuses: [
        { trait: /^protected hearing\b/i, bonus: 5 },
        { trait: /^protected vision\b/i, bonus: 5 },
      ],
      recovery: -5,
    },
    smoke: { radius: 10, seconds: null },
  },
  {
    id: 'wp',
    label: 'wp',
    ref: 'HT172',
    match: { name: /\b(white phosphorus|willy pete|wp)\b|\bM34\b/i },
    smoke: { radius: 5, seconds: 60 },
    hotFragments: true,
  },
  {
    id: 'smoke',
    label: 'smoke',
    ref: 'HT171',
    match: { name: /\bsmoke\b/i, damage: /^\s*smoke\b/i },
    smoke: { radius: null, seconds: 80 },
  },
  {
    id: 'gas',
    label: 'gas',
    ref: 'HT171',
    match: { name: /\b(tear gas|cs gas|cn gas|\bCS\b|pepper|oc gas)\b/i },
    gas: { radius: null, seconds: 25 },
    notes: ['gas'],
  },
  {
    id: 'thermobaric',
    label: 'thermobaric',
    ref: 'HT170',
    match: { name: /\b(thermobaric|fuel-?air|fae|tbg)\b/i },
    environment: 'thermobaric',
  },
  {
    id: 'airburst',
    label: 'airburst',
    ref: 'B415',
    match: { name: /\b(air-?burst|he-?ab|ab)\b/i },
    airburst: true,
  },
]

export interface SpecialMatch {
  ids: string[]
  defs: SpecialDef[]
  environment: BlastEnvironment
  airburst: boolean
  hotFragments: boolean
  affliction: (SpecialAffliction & { radius: number }) | null
  smoke: { radius: number; seconds: number | null } | null
  gas: { radius: number; seconds: number | null } | null
}

/** Default smoke/gas radius when neither the special nor the damage text gives one (HT192: 7 yards). */
const DEFAULT_CLOUD = 7

/**
 * Work out the special effects of a munition from its name, damage text and notes.
 * A radius in the damage text ("Smoke (8 yd.)", "HT-5 aff (10 yd.)") wins over the table's.
 */
export function matchSpecials(opts: {
  name?: string
  damage?: string
  notes?: string
  spec?: ExplosiveSpec | null
}): SpecialMatch {
  const name = String(opts.name ?? '')
  const damage = String(opts.damage ?? '')
  const notes = String(opts.notes ?? '')
  const defs = SPECIALS.filter(
    def =>
      (def.match.name && def.match.name.test(name)) ||
      (def.match.damage && def.match.damage.test(damage)) ||
      (def.match.notes && def.match.notes.test(notes))
  )
  const components = opts.spec?.components ?? []
  const textRadius = components.find(c => c.radius)?.radius ?? null
  const smokeComponent = components.find(c => c.smoke)

  let affliction: SpecialMatch['affliction'] = null
  const stun = defs.find(d => d.affliction)
  if (stun?.affliction) {
    const parsed = components.find(c => c.affliction)
    affliction = {
      ...stun.affliction,
      htModifier: parsed?.affliction?.htModifier ?? stun.affliction.htModifier,
      radius: parsed?.radius ?? stun.afflictionRadius ?? 10,
    }
  }

  let smoke: SpecialMatch['smoke'] = null
  const smokeDef = defs.find(d => d.smoke)
  if (smokeDef?.smoke || smokeComponent) {
    const radius = smokeComponent?.radius ?? smokeDef?.smoke?.radius ?? textRadius ?? DEFAULT_CLOUD
    smoke = { radius, seconds: smokeDef ? (smokeDef.smoke?.seconds ?? null) : null }
  }

  let gas: SpecialMatch['gas'] = null
  const gasDef = defs.find(d => d.gas)
  if (gasDef?.gas) gas = { radius: gasDef.gas.radius ?? textRadius ?? DEFAULT_CLOUD, seconds: gasDef.gas.seconds }

  return {
    ids: defs.map(d => d.id),
    defs,
    environment: defs.find(d => d.environment)?.environment ?? 'normal',
    airburst: defs.some(d => d.airburst),
    hotFragments: defs.some(d => d.hotFragments) || components.some(c => c.fragments?.type === 'burn'),
    affliction,
    smoke,
    gas,
  }
}

export function findSpecial(id: string): SpecialDef | undefined {
  return SPECIALS.find(d => d.id === id)
}

/* ------------------------------------------------------------------ */
/* Explosives: relative explosive force (B415 table, HT183 table)       */
/* ------------------------------------------------------------------ */

export interface ExplosiveDef {
  id: string
  name: string
  ref: number
  aliases: string[]
}

export const EXPLOSIVES: ExplosiveDef[] = [
  { id: 'tnt', name: 'TNT', ref: 1.0, aliases: ['tnt', 'trinitrotoluene'] },
  {
    id: 'c4',
    name: 'C4',
    ref: 1.4,
    aliases: ['c4', 'c-4', 'composition c4', 'comp c4', 'plastique', 'plastic explosive', 'pe4', 'pe-4'],
  },
  { id: 'semtex', name: 'Semtex-H', ref: 1.4, aliases: ['semtex', 'semtex-h'] },
  { id: 'compb', name: 'Composition B', ref: 1.4, aliases: ['composition b', 'comp b', 'cyclotol'] },
  { id: 'dynamite', name: 'Dynamite (80%)', ref: 1.2, aliases: ['dynamite', 'dynamite 80%'] },
  { id: 'military-dynamite', name: 'Military dynamite', ref: 0.9, aliases: ['military dynamite'] },
  { id: 'nitro', name: 'Nitroglycerin', ref: 1.5, aliases: ['nitroglycerin', 'nitroglycerine', 'nitro', 'ng'] },
  { id: 'black-powder', name: 'Black powder (improved)', ref: 0.5, aliases: ['black powder', 'gunpowder', 'bp'] },
  { id: 'smokeless', name: 'Smokeless powder', ref: 0.8, aliases: ['smokeless powder', 'smokeless', 'cordite'] },
  { id: 'anfo', name: 'ANFO', ref: 0.5, aliases: ['anfo', 'fertilizer', 'fertilizer bomb'] },
  { id: 'an', name: 'Ammonium nitrate', ref: 0.4, aliases: ['ammonium nitrate', 'an'] },
  { id: 'amatol', name: 'Amatol 80/20', ref: 1.2, aliases: ['amatol'] },
  { id: 'tetryl', name: 'Tetryl', ref: 1.3, aliases: ['tetryl'] },
  { id: 'picric', name: 'Picric acid', ref: 0.9, aliases: ['picric acid', 'picric', 'lyddite'] },
  { id: 'rdx', name: 'RDX', ref: 1.6, aliases: ['rdx', 'hexogen', 'cyclonite'] },
  { id: 'petn', name: 'PETN', ref: 1.7, aliases: ['petn'] },
  { id: 'hmx', name: 'HMX', ref: 1.7, aliases: ['hmx', 'octogen'] },
  { id: 'demex', name: 'Demex (extrudable)', ref: 1.4, aliases: ['demex', 'extrudable', 'extrudable explosive'] },
  { id: 'foam', name: 'Liquid explosive foam', ref: 1.1, aliases: ['foam', 'foam explosive', 'nitromethane'] },
  { id: 'thermobaric', name: 'Thermobaric composite', ref: 2, aliases: ['thermobaric composite'] },
  {
    id: 'fae',
    name: 'Fuel-air explosive',
    ref: 5,
    aliases: ['fae', 'fuel-air', 'fuel air explosive', 'fuel-air explosive'],
  },
]

export function findExplosive(name: string): ExplosiveDef | undefined {
  const key = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (!key) return undefined
  return EXPLOSIVES.find(e => e.id === key || e.aliases.includes(key))
}

/** "2lb", "1.25 lbs", "500g", "0.5 kg", "4 oz" -> pounds. */
export function parseWeight(text: string): number | null {
  const m = String(text ?? '')
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?|\.\d+)\s*(lbs?|pounds?|#|kg|kilos?|kilograms?|g|grams?|oz|ounces?)$/)
  if (!m) return null
  const value = Number(m[1])
  const unit = m[2]
  if (unit.startsWith('k')) return value * 2.20462
  if (unit === 'g' || unit.startsWith('gram')) return value * 0.00220462
  if (unit.startsWith('oz') || unit.startsWith('ounce')) return value / 16
  return value
}

/* ------------------------------------------------------------------ */
/* JSON-safe summary (stored in the GM card's flags)                    */
/* ------------------------------------------------------------------ */

export interface SpecialSummary {
  ids: string[]
  environment: BlastEnvironment
  airburst: boolean
  hotFragments: boolean
  affliction: { htModifier: number; radius: number; status: 'stun'; recovery: number } | null
  smoke: { radius: number; seconds: number | null } | null
  gas: { radius: number; seconds: number | null } | null
}

export function summarizeSpecials(match: SpecialMatch): SpecialSummary {
  const aff = match.affliction
  return {
    ids: [...match.ids],
    environment: match.environment,
    airburst: match.airburst,
    hotFragments: match.hotFragments,
    affliction: aff
      ? { htModifier: aff.htModifier, radius: aff.radius, status: aff.status, recovery: aff.recovery }
      : null,
    smoke: match.smoke ? { ...match.smoke } : null,
    gas: match.gas ? { ...match.gas } : null,
  }
}

/** Bonus to resist the special's affliction from the target's traits (e.g. Protected Hearing +5). */
export function afflictionBonus(match: SpecialMatch, traitNames: string[]): number {
  const bonuses = match.affliction?.bonuses ?? []
  return bonuses.reduce((sum, b) => sum + (traitNames.some(n => b.trait.test(n.trim())) ? b.bonus : 0), 0)
}
