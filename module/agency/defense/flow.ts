/**
 * Pure state machine for defense cards and turn flow: card state transitions, which client applies
 * an update, which client runs turn automation, and when to reset/prompt maneuvers.
 * No Foundry globals in here (unit tested in test/agency/defense-flow.test.ts).
 */
import { hitsAfterDefense } from './rules.ts'
import type {
  AgencyCardFlag,
  AttemptInput,
  CardEvent,
  DefenseCardState,
  DefenseType,
  NoDefenseReason,
  RecoveryAttribute,
  TurnCardState,
  TurnPhase,
} from './types.ts'

const ALL_DEFENSES: DefenseType[] = ['dodge', 'parry', 'block']

/**
 * A new card's state. When every hit is critical there is nothing to defend against (B556): the
 * card starts as a hit, like any other no-defense situation.
 */
export function initialDefenseState(
  potentialHits: number,
  criticalHits: number,
  noDefense: NoDefenseReason | null,
  allowed: DefenseType[]
): DefenseCardState {
  const hits = Math.max(1, Math.floor(potentialHits) || 1)
  let critical = Math.min(hits, Math.max(0, Math.floor(criticalHits) || 0))
  // A critical attack roll (B556): every hit counts as critical.
  if (noDefense === 'critical') critical = hits
  else if (!noDefense && critical === hits) noDefense = 'critical'
  return {
    status: noDefense ? 'hit' : 'awaiting',
    potentialHits: hits,
    criticalHits: critical,
    hitsRemaining: hits,
    attempts: [],
    allowed: noDefense ? [] : ALL_DEFENSES.filter(type => allowed.includes(type)),
    noDefenseReason: noDefense,
    damageHits: null,
  }
}

/**
 * Apply a defense roll (or "No defense") to an awaiting card.
 *
 * All-Out Defense (Double Defense) lets a defender who fails one defense try a different one
 * against the same attack (B366): `doubleDefense` keeps the card open once, without the type just used.
 * Late or duplicate results (card no longer awaiting) are ignored.
 */
export function applyDefenseAttempt(
  state: DefenseCardState,
  attempt: AttemptInput,
  doubleDefense: boolean
): DefenseCardState {
  if (state.status !== 'awaiting') return state
  if (attempt.type !== 'none' && !state.allowed.includes(attempt.type)) return state

  const hitsBefore = state.hitsRemaining
  const hitsAfter = hitsAfterDefense(hitsBefore, attempt, state.criticalHits)
  const attempts = [
    ...state.attempts,
    {
      type: attempt.type,
      label: attempt.label,
      success: attempt.success,
      margin: attempt.margin,
      critSuccess: !!attempt.critSuccess,
      critFailure: !!attempt.critFailure,
      hitsBefore,
      hitsAfter,
    },
  ]

  if (hitsAfter === 0) return { ...state, attempts, hitsRemaining: 0, allowed: [], status: 'defended' }

  const remaining = attempt.type === 'none' ? [] : state.allowed.filter(type => type !== attempt.type)
  const retry = doubleDefense && attempt.type !== 'none' && state.attempts.length === 0 && remaining.length > 0

  return retry
    ? { ...state, attempts, hitsRemaining: hitsAfter, allowed: remaining, status: 'awaiting' }
    : { ...state, attempts, hitsRemaining: hitsAfter, allowed: [], status: 'hit' }
}

/** Record that damage has been rolled for a card that hit. */
export function applyDamageRolled(state: DefenseCardState, hits: number): DefenseCardState {
  if (state.status !== 'hit') return state
  return { ...state, status: 'damaged', damageHits: hits }
}

export function applyManeuverChosen(state: TurnCardState, maneuver: string): TurnCardState {
  return { ...state, maneuver }
}

/** First recovery result per attribute wins (a second click can't overwrite a failure). */
export function applyRecovery(
  state: TurnCardState,
  attribute: RecoveryAttribute,
  success: boolean,
  margin: number
): TurnCardState {
  if (state.recovery[attribute]) return state
  return { ...state, recovery: { ...state.recovery, [attribute]: { success, margin } } }
}

/** Apply any card event to a card. Returns the same object when nothing changes. */
export function reduceCard<T extends AgencyCardFlag>(card: T, event: CardEvent): T {
  if (card.kind === 'defense-card') {
    let state = card.state
    if (event.kind === 'defense') state = applyDefenseAttempt(state, event.attempt, event.doubleDefense)
    else if (event.kind === 'damage') state = applyDamageRolled(state, event.hits)
    return state === card.state ? card : { ...card, state }
  }

  let state = card.state
  if (event.kind === 'maneuver') state = applyManeuverChosen(state, event.maneuver)
  else if (event.kind === 'recovery') state = applyRecovery(state, event.attribute, event.success, event.margin)
  return state === card.state ? card : { ...card, state }
}

export type CardExecutor = { kind: 'self' } | { kind: 'remote'; userId: string } | { kind: 'fallback' }

/**
 * Who updates a chat card. Only the author or a GM may update a ChatMessage, so a defender's click
 * on the attacker's card is applied by: this client if it may; else the active GM; else the card's
 * author if they are online. With neither, the caller posts a new card instead (fallback).
 */
export function chooseCardExecutor(p: {
  selfId: string
  selfIsGM: boolean
  authorId: string | null
  activeGMId: string | null
  activeUserIds: string[]
}): CardExecutor {
  if (p.selfIsGM || (p.authorId && p.selfId === p.authorId)) return { kind: 'self' }
  if (p.activeGMId) return { kind: 'remote', userId: p.activeGMId }
  if (p.authorId && p.activeUserIds.includes(p.authorId)) return { kind: 'remote', userId: p.authorId }
  return { kind: 'fallback' }
}

export interface UserLite {
  id: string
  active: boolean
  isGM: boolean
}

/**
 * The one client that runs turn automation for a combatant: the active GM if there is one, else the
 * first online player who owns the combatant (by id, so every client agrees). Null if nobody can.
 */
export function pickAutomationRunner(users: UserLite[], ownerIds: string[], activeGMId?: string | null): string | null {
  if (activeGMId) return activeGMId
  const online = users.filter(u => u.active)
  const gm = online.filter(u => u.isGM).sort((a, b) => a.id.localeCompare(b.id))[0]
  if (gm) return gm.id
  const owner = online.filter(u => !u.isGM && ownerIds.includes(u.id)).sort((a, b) => a.id.localeCompare(b.id))[0]
  return owner?.id ?? null
}

export interface TurnState {
  round: number
  turn: number | null
  combatantId: string | null
}

export interface TurnTransition {
  ended: string | null
  started: string | null
  /** The GM stepped back (previous turn/round): no automation. */
  rewind: boolean
}

/** Whose turn ended and whose started, from Foundry's combatTurnChange prior/current states. */
export function turnTransition(prior: TurnState, current: TurnState): TurnTransition {
  const rewind =
    current.round < prior.round || (current.round === prior.round && (current.turn ?? 0) < (prior.turn ?? 0))
  if (rewind) return { ended: null, started: null, rewind: true }

  const changed = prior.combatantId !== current.combatantId || prior.round !== current.round
  if (!changed) return { ended: null, started: null, rewind: false }

  // Round 0 is "combat created, not started": nobody's turn has ended yet.
  const ended = prior.round > 0 && prior.combatantId ? prior.combatantId : null
  const started = current.round > 0 && current.combatantId ? current.combatantId : null
  return { ended, started, rewind: false }
}

export type StunTiming = 'end' | 'start' | 'off'

/**
 * Stun recovery rolls due in this phase: HT for physical stun, IQ for mental stun (B420).
 * By the book the roll comes at the end of the stunned character's turn ('end').
 */
export function stunRecoveryRolls(
  statuses: Iterable<string>,
  timing: StunTiming,
  phase: TurnPhase
): RecoveryAttribute[] {
  if (timing !== phase) return []
  const set = new Set(statuses)
  const rolls: RecoveryAttribute[] = []
  if (set.has('stun')) rolls.push('HT')
  if (set.has('mentalstun')) rolls.push('IQ')
  return rolls
}

/** Unconscious or dead (the wound feature sets 'unconscious'; upstream uses 'dead'): no defenses or choices. */
export function isIncapacitated(statuses: Iterable<string>): boolean {
  const set = new Set(statuses)
  return set.has('unconscious') || set.has('dead')
}

export function isStunned(statuses: Iterable<string>): boolean {
  const set = new Set(statuses)
  return set.has('stun') || set.has('mentalstun')
}

export interface ManeuverDecisionInput {
  /** Maneuver now (system.conditions.maneuver). */
  current: string | null | undefined
  /** Maneuver when this combatant's last turn ended; undefined if unknown. */
  endedWith: string | undefined
  /** Upstream already has a maneuver recorded for this round (picked ahead in this round, or a rewind). */
  pickedThisRound: boolean
  stunned: boolean
}

/**
 * At the start of a combatant's turn the maneuver chosen last turn expires (its defense effects
 * last "until your next turn", B364). Reset it to Do Nothing and prompt for a new one, unless the
 * player already picked one for this turn (changed since their last turn ended, or recorded for
 * this round) or the character is stunned (upstream's Stun effect forces Do Nothing).
 */
export function maneuverDecision(p: ManeuverDecisionInput): { reset: boolean; prompt: boolean } {
  if (p.stunned) return { reset: false, prompt: false }
  const current = p.current || 'do_nothing'
  const picked =
    current !== 'do_nothing' && (p.pickedThisRound || (p.endedWith !== undefined && p.endedWith !== current))
  if (picked) return { reset: false, prompt: false }
  return { reset: current !== 'do_nothing', prompt: true }
}
