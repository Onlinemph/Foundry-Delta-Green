/**
 * Shapes of the per-actor wound data stored at flags.gurps.agency.wounds.
 * The GCS importer never touches flags, so this survives re-imports.
 */
import type { LocationCategory } from './locations.ts'
import type { PainLevel, Severity } from './severity.ts'

export const STATE_VERSION = 1

/** Fixed-rate bleeding from special results (a vitals hit, a broken body, a neck wound). */
export type SpecialBleed = '2fp-per-second' | '1fp-per-second'

export interface BleedingState {
  /** Current bleeding rate, as a severity on the bleeding table; null when the wound is not (or no longer) bleeding. */
  severity: Severity | null
  /** A fixed rate that overrides the table; cleared only by stabilizing or surgery. */
  special: SpecialBleed | null
  /** Consecutive successful bleeding rolls (two in a row slow the bleeding by one level). */
  consecutive: number
  /** Total successful bleeding rolls (two stop bleeding from a Minor wound or Scratch). */
  successes: number
}

export interface WoundRecord {
  id: string
  /** Current severity (recovery lowers it). */
  severity: Severity
  /** Severity when the wound was taken. */
  originalSeverity: Severity
  location: string
  category: LocationCategory
  limbKey: string | null
  leg: boolean
  damageType: string
  injury: number
  /** game.time.worldTime when the wound was taken. */
  created: number
  bleeding: BleedingState
  bandageAttempted: boolean
  bandaged: boolean
  stabilizeAttempted: boolean
  stabilized: boolean
  /** Progressive Limb Trauma: passed the Major-wound check, so -1 to tasks with this limb until the wound heals below Major. */
  limbPenalty: boolean
  paralysis: boolean
  /** Free text notes the GM adds. */
  note: string
}

export interface LimbState {
  key: string
  leg: boolean
  crippled: boolean
  dismembered: boolean
}

export interface PainState {
  level: PainLevel
  /** World time (seconds) when the pain wears off; null lasts until cleared (adrenaline has worn off). */
  expiresAt: number | null
  /** Impaired by a Major or worse wound: Move and Dodge are halved too. */
  halfMove: boolean
}

export interface ShockState {
  amount: number
  combatId: string | null
  round: number
}

export interface WoundsState {
  version: number
  wounds: WoundRecord[]
  limbs: LimbState[]
  pain: PainState | null
  /** Worst severity an impairment roll has been called for; later wounds only call for another roll if worse (or Critical+). */
  impairmentTaken: Severity | null
  /** Shock for the victim's next turn, from the worst wound taken this turn. */
  shock: ShockState | null
  /** FP lost to bleeding; it only comes back through the daily HT roll (or a transfusion). */
  bleedingFP: number
}
