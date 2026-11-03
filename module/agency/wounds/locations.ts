/**
 * Map the hit locations this system uses (module/hitlocation/hitlocation.js) onto the categories the
 * Revised Fractional Health rules talk about: head (with the brain singled out), neck, vitals, torso,
 * groin, limbs and extremities.
 */

export type LocationCategory = 'head' | 'neck' | 'vitals' | 'torso' | 'groin' | 'limb' | 'extremity' | 'other'

export interface LocationInfo {
  /** The location name as the damage dialog reported it. */
  where: string
  category: LocationCategory
  /** Skull, brain and eye: a Critical wound here calls for the brain check. */
  brain: boolean
  /** Neck vein/artery or limb vein/artery. */
  vein: boolean
  /** A leg (or foreleg, hind leg...): crippling it or a Major+ wound to it halves Move and Dodge. */
  leg: boolean
  arm: boolean
  /** Key used to track per-limb state (crippled, dismembered); null for anything that is not a limb or extremity. */
  limbKey: string | null
}

/** Hit location roles from module/hitlocation/hitlocation.js. */
const ROLE_LIMB = 'limb'
const ROLE_EXTREMITY = 'extremity'
const ROLE_CHEST = 'chest'
const ROLE_GROIN = 'groin'

/** "Right Arm, holding shield" and "Mid Leg*" are the same limb as "Right Arm" and "Mid Leg". */
export function limbKeyFor(where: string): string {
  return where
    .replace(/,\s*holding shield$/i, '')
    .replace(/\*+$/, '')
    .trim()
}

export function classifyLocation(where: string, role?: string | null): LocationInfo {
  const name = (where ?? '').trim()
  const lower = name.toLowerCase()
  const base: LocationInfo = {
    where: name,
    category: 'other',
    brain: false,
    vein: false,
    leg: false,
    arm: false,
    limbKey: null,
  }

  // Locations that never carry a role in the hit location tables come first.
  if (/^(skull|brain)\b/.test(lower) || /^eyes?$/.test(lower)) return { ...base, category: 'head', brain: true }
  if (/^(face|jaw|nose)\b/.test(lower)) return { ...base, category: 'head' }
  if (/^neck vein/.test(lower)) return { ...base, category: 'neck', vein: true }
  if (/^neck\b/.test(lower)) return { ...base, category: 'neck' }
  if (/^vitals\b/.test(lower)) return { ...base, category: 'vitals' }
  if (/^limb vein/.test(lower)) return { ...base, category: 'limb', vein: true, limbKey: limbKeyFor(name) }

  const leg = /(^|\s)(leg|legs|foreleg|hind ?leg|mid ?leg)\b/.test(lower) || /^leg\b/.test(lower)
  const arm = /(^|\s)arms?\b/.test(lower)

  if (role === ROLE_LIMB) return { ...base, category: 'limb', leg, arm, limbKey: limbKeyFor(name) }
  if (role === ROLE_EXTREMITY) return { ...base, category: 'extremity', limbKey: limbKeyFor(name) }
  if (role === ROLE_GROIN || /^groin\b/.test(lower)) return { ...base, category: 'groin' }
  if (role === ROLE_CHEST || /^(torso|chest|chinks in torso)\b/.test(lower)) return { ...base, category: 'torso' }

  // No role (hand-edited locations, GCA names): fall back to the name.
  if (leg || arm || /\bwings?\b/.test(lower)) return { ...base, category: 'limb', leg, arm, limbKey: limbKeyFor(name) }
  if (/\b(hands?|foot|feet|fins?|tail|extremity)\b/.test(lower))
    return { ...base, category: 'extremity', limbKey: limbKeyFor(name) }

  return base
}

export function isHeadOrVitals(info: LocationInfo): boolean {
  return info.category === 'head' || info.category === 'vitals'
}

export function isLimbOrExtremity(info: LocationInfo): boolean {
  return info.category === 'limb' || info.category === 'extremity'
}

/** Fragile (Unnatural) dies at the first Critical wound "to the head or torso": everything but limbs and extremities. */
export function isHeadOrTorso(info: LocationInfo): boolean {
  return ['head', 'neck', 'vitals', 'torso', 'groin'].includes(info.category)
}

/**
 * Large-area injury: reduce wound severity by one for the head, arms and legs (all limbs) and by two
 * for hands and feet (all extremities).
 */
export function largeAreaReduction(info: LocationInfo): number {
  switch (info.category) {
    case 'head':
    case 'limb':
      return 1
    case 'extremity':
      return 2
    default:
      return 0
  }
}

/**
 * The surface locations a large-area injury hits: every location on the actor's body that can be
 * rolled for. Internal locations (vitals, eyes, veins) and duplicate roll ranges ("Torso*") are left out.
 */
export function largeAreaLocations(locations: { where: string; roll?: string }[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const location of locations) {
    const where = (location.where ?? '').trim()
    if (!where) continue
    if (!location.roll || location.roll.trim() === '-' || location.roll.trim() === '') continue
    const info = classifyLocation(where)
    if (info.category === 'vitals' || info.vein) continue
    const key = limbKeyFor(where)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(where)
  }
  return result
}
