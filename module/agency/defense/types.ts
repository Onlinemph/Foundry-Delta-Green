/**
 * Shared types for the Agency defense / turn-flow feature.
 *
 * Everything in here is plain data: it is stored in chat message flags
 * (flags.gurps.agency.defense) and sent over the socket, so keep it JSON-safe.
 */

export type AttackKind = 'melee' | 'ranged'
export type DefenseType = 'dodge' | 'parry' | 'block'
export type DefenseChoice = DefenseType | 'none'

/** Why a defender gets no active defense roll at all. */
export type NoDefenseReason = 'critical' | 'maneuver' | 'cantSee' | 'incapacitated'

/**
 * What a maneuver lets you defend with (B364-366). 'any', 'none' and 'dodge-block' are upstream's
 * DEFENSE_* values in module/combat/maneuver.js; 'dodge' is ours for maneuvers upstream restricts
 * through TokenActions instead (Committed Aim: no parries or blocks).
 */
export type ManeuverDefenseRule = 'any' | 'none' | 'dodge-block' | 'dodge'

export interface AttackProfile {
  kind: AttackKind
  /** A thrown weapon: can be parried at -1 (B376). */
  thrown: boolean
  /** A firearm or beam (numeric Rcl): can't be blocked (B375). */
  firearm: boolean
}

/** Identifies a token (and the actor behind it) across clients. */
export interface TokenRef {
  sceneId: string | null
  tokenId: string | null
  actorId: string | null
  name: string
}

/** Everything about the attack a defense card needs; captured on the attacker's client. */
export interface AttackContext {
  attacker: TokenRef
  /** User who rolled the attack. */
  userId: string
  profile: AttackProfile
  /** Weapon name as upstream's findAttack() expects it: "Broadsword (Swung)". */
  weapon: string
  /** Damage text at roll time, e.g. "2d+1 cut" (re-read from the actor when damage is rolled). */
  damage: string
  /** Upstream's damage follow-on OTF ("[@id@D:"Broadsword (Swung)"]"), fallback for odd damage text. */
  followon: string | null
  /** Attack roll margin; null when another feature supplied the hits (promptDefense). */
  margin: number | null
  isCritSuccess: boolean
  isBlind: boolean
  /** Hit location chosen with a "to hit <location>" modifier, as upstream's raw (English) key. */
  hitLocation: string | null
  /** Penalty to the defense from a Deceptive Attack (B369): positive number N means -N. */
  deceptivePenalty: number
  rof: string | null
  rcl: string | null
  /** The chat message of the attack roll, when known. */
  rollMessageId: string | null
}

export interface DefenseAttempt {
  type: DefenseChoice
  /** What was used: weapon/shield name; empty for dodge or no defense. */
  label: string
  success: boolean
  margin: number
  critSuccess: boolean
  critFailure: boolean
  hitsBefore: number
  hitsAfter: number
}

export type DefenseCardStatus = 'awaiting' | 'defended' | 'hit' | 'damaged'

export interface DefenseCardState {
  status: DefenseCardStatus
  potentialHits: number
  /** Critical hits among the hits: they can't be defended and always reach the damage step. */
  criticalHits: number
  hitsRemaining: number
  attempts: DefenseAttempt[]
  /** Defense types still allowed (shrinks after an All-Out Defense (Double) attempt). */
  allowed: DefenseType[]
  noDefenseReason: NoDefenseReason | null
  /** Hits damage was rolled for, once it has been. */
  damageHits: number | null
}

export interface DefenseCardFlag {
  kind: 'defense-card'
  attack: AttackContext
  target: TokenRef
  /** Defender maneuver at attack time (for display and Double Defense). */
  maneuver: string
  state: DefenseCardState
}

export type TurnPhase = 'start' | 'end'
export type RecoveryAttribute = 'HT' | 'IQ'

export interface TurnCardState {
  /** Maneuver picked from this card, if any. */
  maneuver: string | null
  recovery: Partial<Record<RecoveryAttribute, { success: boolean; margin: number }>>
}

export interface TurnCardFlag {
  kind: 'turn-card'
  phase: TurnPhase
  combatId: string
  combatantId: string
  round: number
  token: TokenRef
  promptManeuver: boolean
  stunned: boolean
  recoveryRolls: RecoveryAttribute[]
  state: TurnCardState
}

export type AgencyCardFlag = DefenseCardFlag | TurnCardFlag

/** Events that change a card. Applied by exactly one client (see chooseCardExecutor). */
export type CardEvent =
  | { kind: 'defense'; attempt: AttemptInput; doubleDefense: boolean }
  | { kind: 'damage'; hits: number }
  | { kind: 'maneuver'; maneuver: string }
  | { kind: 'recovery'; attribute: RecoveryAttribute; success: boolean; margin: number }

export interface AttemptInput {
  type: DefenseChoice
  label: string
  success: boolean
  margin: number
  critSuccess?: boolean
  critFailure?: boolean
}
