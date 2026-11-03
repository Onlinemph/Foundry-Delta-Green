/**
 * Zonal cover (the user's "Zonal Aiming, Cover & Hit Location v3", adapted per body part).
 *
 * The GM marks which body parts of a token are behind cover (a preset or a custom list), plus the
 * cover's DR, HP and material. A hit whose resolved location is behind cover hits the cover first:
 * damage vs the cover's DR; what penetrates goes on to the target at that location (B407).
 *
 * Reading of B407 used here: the cover's DR is subtracted from the attack's basic damage (armor
 * divisors apply to it as to any DR) and the rest continues as the attack's damage against the
 * target's own DR. No extra halving. The cover loses HP equal to the damage that penetrated it.
 *
 * Pure functions; the token flag (flags.gurps.agency.cover) holds a CoverData.
 */
import type { CoverZone, Roller } from './types.ts'

export type CoverState = 'exposed' | 'covered' | 'half'

export type CoverPreset =
  | 'none'
  | 'lowWall'
  | 'chestHigh'
  | 'overCover'
  | 'cornerLeft'
  | 'cornerRight'
  | 'full'
  | 'custom'

export const COVER_PRESETS: CoverPreset[] = [
  'none',
  'lowWall',
  'chestHigh',
  'overCover',
  'cornerLeft',
  'cornerRight',
  'full',
  'custom',
]

export const COVER_ZONES: CoverZone[] = [
  'skull',
  'face',
  'neck',
  'chest',
  'abdomen',
  'armL',
  'armR',
  'handL',
  'handR',
  'legL',
  'legR',
  'footL',
  'footR',
]

export interface CoverData {
  preset: CoverPreset
  /** Custom preset only: the state of each zone (missing = exposed). */
  zones?: Partial<Record<CoverZone, CoverState>>
  dr: number
  /** Current HP; null when the GM doesn't track it. */
  hp: number | null
  hpMax: number | null
  material: string
}

const HEAD: CoverZone[] = ['skull', 'face', 'neck']
const LEFT: CoverZone[] = ['armL', 'handL', 'legL', 'footL']
const RIGHT: CoverZone[] = ['armR', 'handR', 'legR', 'footR']

/** Zones a preset covers. Corners cover that side's limbs and half the torso. */
export function presetZones(preset: CoverPreset): Record<CoverZone, CoverState> {
  const zones = Object.fromEntries(COVER_ZONES.map(z => [z, 'exposed'])) as Record<CoverZone, CoverState>
  const set = (list: CoverZone[], state: CoverState) => list.forEach(z => (zones[z] = state))
  switch (preset) {
    case 'lowWall':
      set(['legL', 'legR', 'footL', 'footR', 'abdomen'], 'covered')
      break
    case 'chestHigh':
      set(
        COVER_ZONES.filter(z => !HEAD.includes(z)),
        'covered'
      )
      break
    case 'overCover':
      set(['chest', 'abdomen', 'legL', 'legR', 'footL', 'footR'], 'covered')
      break
    case 'cornerLeft':
      set(LEFT, 'covered')
      set(['chest', 'abdomen'], 'half')
      break
    case 'cornerRight':
      set(RIGHT, 'covered')
      set(['chest', 'abdomen'], 'half')
      break
    case 'full':
      set(COVER_ZONES, 'covered')
      break
    default:
      break
  }
  return zones
}

/** Zone states of a cover (custom zones, or the preset's). */
export function coverZones(cover: CoverData | null): Record<CoverZone, CoverState> {
  if (!cover) return presetZones('none')
  if (cover.preset !== 'custom') return presetZones(cover.preset)
  const zones = presetZones('none')
  for (const zone of COVER_ZONES) {
    const state = cover.zones?.[zone]
    if (state === 'covered' || state === 'half') zones[zone] = state
  }
  return zones
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Clean cover data from a token flag or the config form; null when there's no cover. */
export function normalizeCover(raw: unknown): CoverData | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const preset = COVER_PRESETS.includes(data.preset as CoverPreset) ? (data.preset as CoverPreset) : 'none'
  if (preset === 'none') return null

  const zones: Partial<Record<CoverZone, CoverState>> = {}
  if (preset === 'custom' && data.zones && typeof data.zones === 'object') {
    for (const zone of COVER_ZONES) {
      const state = (data.zones as Record<string, unknown>)[zone]
      if (state === 'covered' || state === 'half') zones[zone] = state
    }
  }

  const hpMax = num(data.hpMax)
  let hp = num(data.hp)
  if (hp === null && hpMax !== null) hp = hpMax
  return {
    preset,
    ...(preset === 'custom' ? { zones } : {}),
    dr: Math.max(0, Math.floor(num(data.dr) ?? 0)),
    hp: hp === null ? null : Math.floor(hp),
    hpMax: hpMax === null ? null : Math.max(0, Math.floor(hpMax)),
    material: String(data.material ?? '').trim(),
  }
}

/** Cover that still protects something: a preset with covered zones, not yet destroyed. */
export function coverIsActive(cover: CoverData | null): boolean {
  if (!cover) return false
  if (cover.hp !== null && cover.hp <= 0) return false
  return Object.values(coverZones(cover)).some(state => state !== 'exposed')
}

/**
 * The cover's DR against an attack with this armor divisor, as upstream does it for armor:
 * divisor -1 ignores DR, a fractional divisor multiplies DR (minimum 1), 0/1 leaves it alone.
 */
export function effectiveCoverDR(dr: number, armorDivisor: number): number {
  const d = Number(armorDivisor) || 0
  if (!d || d === 1) return dr
  if (d === -1) return 0
  if (d < 1 && dr === 0) return 1
  return Math.floor(dr / d)
}

export interface CoverOutcome {
  zone: CoverZone
  state: CoverState
  /** The 1d6 rolled for a half-covered zone (1-3: covered). */
  roll: number | null
  hitsCover: boolean
  coverDR: number
  /** Damage the cover stopped. */
  absorbed: number
  /** Damage that goes on to the target. */
  through: number
  hpBefore: number | null
  hpAfter: number | null
  /** This hit destroyed the cover. */
  destroyed: boolean
}

export interface CoverHitInput {
  cover: CoverData | null
  /** Cover HP before this hit (tracked through a burst); null = untracked. */
  hp: number | null
  zone: CoverZone
  /** A called shot: aimed at a half-covered part it hits the exposed half; at a covered part, the cover. */
  called: boolean
  damage: number
  armorDivisor: number
  roll: Roller
}

/** One hit against the target's cover. */
export function resolveCoverHit(p: CoverHitInput): CoverOutcome {
  const state = coverZones(p.cover)[p.zone]
  const destroyedAlready = p.hp !== null && p.hp <= 0
  const base: CoverOutcome = {
    zone: p.zone,
    state,
    roll: null,
    hitsCover: false,
    coverDR: 0,
    absorbed: 0,
    through: p.damage,
    hpBefore: p.hp,
    hpAfter: p.hp,
    destroyed: false,
  }
  if (!p.cover || destroyedAlready || state === 'exposed') return base

  let hitsCover = state === 'covered'
  let roll: number | null = null
  if (state === 'half' && !p.called) {
    roll = p.roll('cover', 1)
    hitsCover = roll <= 3
  }
  if (!hitsCover) return { ...base, roll }

  const coverDR = effectiveCoverDR(p.cover.dr, p.armorDivisor)
  const damage = Math.max(0, Math.floor(p.damage))
  const through = Math.max(0, damage - coverDR)
  const hpAfter = p.hp === null ? null : p.hp - through
  return {
    ...base,
    roll,
    hitsCover: true,
    coverDR,
    absorbed: damage - through,
    through,
    hpAfter,
    destroyed: p.hp !== null && p.hp > 0 && hpAfter !== null && hpAfter <= 0,
  }
}
