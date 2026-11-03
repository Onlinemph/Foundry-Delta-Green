/**
 * What a hit-location result changes on upstream's damage calculator (module/damage/damagecalculator.js).
 *
 * The calculator picks its wounding modifier from its own location table; GUHL's multiplier is
 * applied as the difference, in the dialog's "additional wounding modifier" (visible and editable).
 * Extra DR, chinks and armor gaps become an "override DR"; the torso injury cap and the joint/vein
 * crippling thresholds go in two AGENCY fields the calculator reads (agencyInjuryCap,
 * agencyCripplingThreshold). Pure: the Foundry side reads the actor and sets the fields.
 */
import { PIERCING } from './tables.ts'
import type { AttackType, HitResult } from './types.ts'

export type TorsoCap = '2' | '1' | 'none'
export type InjuryToleranceType = 'unliving' | 'homogenous' | 'diffuse' | null

/** Upstream's roles (module/hitlocation/hitlocation.js). */
export type LocationRole = 'limb' | 'extremity' | 'chest' | 'groin' | null

const DEFAULTS: Record<string, number> = {
  cr: 1,
  cut: 1.5,
  imp: 2,
  'pi-': 0.5,
  pi: 1,
  'pi+': 1.5,
  'pi++': 2,
  burn: 1,
  cor: 1,
  tox: 1,
}

/**
 * Upstream's wounding multiplier for a location name and role, before Injury Tolerance
 * (CompositeDamageCalculator.effectiveWoundModifiers). Only exact names count, as upstream does.
 */
export function upstreamMultiplier(
  where: string,
  role: LocationRole,
  attack: AttackType,
  useLocationModifiers: boolean
): number {
  const type = attack.type
  const base = DEFAULTS[type] ?? 1
  if (!useLocationModifiers) return base
  switch (where) {
    case 'Vitals':
      if (type === 'imp' || PIERCING.includes(type)) return 3
      return type === 'burn' && attack.tightBeam ? 2 : base
    case 'Skull':
    case 'Eye':
      return type === 'tox' ? base : 4
    case 'Face':
      return type === 'cor' ? 1.5 : base
    case 'Neck':
      if (type === 'cr' || type === 'cor') return 1.5
      return type === 'cut' ? 2 : base
    default:
      if ((role === 'limb' || role === 'extremity') && (type === 'imp' || type === 'pi+' || type === 'pi++')) return 1
      return base
  }
}

const UNLIVING_CAPS: Record<string, number> = { imp: 1, 'pi++': 1, 'pi+': 0.5, pi: 1 / 3, 'pi-': 0.2 }

/** Injury Tolerance (Unliving) caps, as upstream applies them (not to skull, eye or vitals). */
function unliving(multiplier: number, type: string, exempt: boolean): number {
  if (exempt || UNLIVING_CAPS[type] === undefined) return multiplier
  return Math.min(multiplier, UNLIVING_CAPS[type])
}

export interface CalculatorInput {
  result: HitResult
  attack: AttackType
  /** The actor location the calculator uses (calculator.hitLocation). */
  where: string
  role: LocationRole
  useLocationModifiers: boolean
  injuryTolerance: InjuryToleranceType
  /** DR at `where` against this damage type. */
  locationDR: number
  /** Innate DR (armor gaps keep it). */
  innateDR: number
  hpMax: number
  torsoCap: TorsoCap
}

export interface CalculatorConfig {
  /** GUHL multiplier minus upstream's: goes in calculator.additionalWoundModifier. */
  additionalWoundModifier: number
  /** calculator.userEnteredDR, or null to leave the location's DR. */
  userEnteredDR: number | null
  /** Most injury one hit can do, in HP (calculator.agencyInjuryCap), or null. */
  injuryCap: number | null
  /** Crippling threshold in HP (calculator.agencyCripplingThreshold; Infinity = never), or null. */
  cripplingThreshold: number | null
}

const round = (n: number) => Math.round(n * 1000) / 1000

export function calculatorConfig(p: CalculatorInput): CalculatorConfig {
  const { result, attack } = p
  let additional = 0

  // Homogenous and Diffuse ignore hit-location wounding modifiers entirely (B380): nothing to add.
  if (result.multiplier !== null && p.injuryTolerance !== 'homogenous' && p.injuryTolerance !== 'diffuse') {
    let guhl = result.multiplier
    let upstream = upstreamMultiplier(p.where, p.role, attack, p.useLocationModifiers)
    if (p.injuryTolerance === 'unliving') {
      guhl = unliving(guhl, attack.type, ['skull', 'eye', 'vitals', 'heart'].includes(result.part ?? ''))
      upstream = unliving(upstream, attack.type, ['Eye', 'Skull', 'Vitals'].includes(p.where))
    }
    additional = round(guhl - upstream)
  }

  let userEnteredDR: number | null = null
  if (result.armorGap) userEnteredDR = Math.max(0, p.innateDR)
  else if (result.halveDR) userEnteredDR = Math.floor((p.locationDR + result.extraDR) / 2)
  else if (result.extraDR) userEnteredDR = p.locationDR + result.extraDR

  const capTimes = p.torsoCap === '1' ? 1 : p.torsoCap === '2' ? 2 : null
  const injuryCap = result.injuryCap && capTimes !== null && p.hpMax > 0 ? p.hpMax * capTimes : null

  let cripplingThreshold: number | null = null
  if (result.crippleDivisor === 0) cripplingThreshold = Infinity
  else if (result.crippleDivisor && p.hpMax > 0) cripplingThreshold = p.hpMax / result.crippleDivisor

  return { additionalWoundModifier: additional, userEnteredDR, injuryCap, cripplingThreshold }
}
