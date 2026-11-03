/**
 * Turn flow: on each combatant's turn start/end, exactly one client (the active GM, else an online
 * owner) fires gurpsAgencyTurnStart / gurpsAgencyTurnEnd, prompts for a maneuver, and offers the
 * stun recovery roll.
 */
import { postCard, submitCardEvent } from './cards.ts'
import {
  isStunned,
  maneuverDecision,
  pickAutomationRunner,
  stunRecoveryRolls,
  turnTransition,
  type TurnState,
} from './flow.ts'
import {
  activeGMId,
  canControl,
  currentManeuver,
  gmIds,
  localize,
  MANEUVER_PICKED_HOOK,
  parseOtf,
  performAndCapture,
  playerOwnerIds,
  resolveActor,
  resolveTokenDoc,
  tokenRef,
  TURN_END_HOOK,
  TURN_START_HOOK,
  unique,
  type AnyActor,
  type AnyTokenDoc,
} from './foundry-helpers.ts'
import { maneuverPromptEnabled, stunRecoveryTiming } from './settings.ts'
import type { RecoveryAttribute, TurnCardFlag, TurnPhase } from './types.ts'

const L = 'GURPS.agency.defense'

/** Maneuver each combatant had when its last turn ended (runner client only; see maneuverDecision). */
const endedWith = new Map<string, string>()

export interface TurnHookData {
  combat: Combat
  combatant: Combatant
  actor: Actor | null
  token: TokenDocument | null
}

function isRunner(combatant: any): boolean {
  const users = ((game.users as any)?.contents ?? []).map((u: any) => ({
    id: u.id,
    active: !!u.active,
    isGM: !!u.isGM,
  }))
  return pickAutomationRunner(users, playerOwnerIds(combatant.actor), activeGMId()) === game.user?.id
}

const toTurnState = (s: any): TurnState => ({
  round: Number(s?.round) || 0,
  turn: s?.turn ?? null,
  combatantId: s?.combatantId ?? null,
})

function tokenActionsRound(tokenDoc: AnyTokenDoc | null, round: number): boolean {
  return !!tokenDoc?.getFlag?.('gurps', 'tokenActions')?.lastManeuvers?.[round]
}

/** combatTurnChange runs on every client after the combat update. */
export function onCombatTurnChange(combat: any, prior: any, current: any): void {
  const transition = turnTransition(toTurnState(prior), toTurnState(current))
  if (transition.rewind) return

  const ended = transition.ended ? combat.combatants?.get(transition.ended) : null
  const started = transition.started ? combat.combatants?.get(transition.started) : null
  const runEnd = !!ended && isRunner(ended)
  const runStart = !!started && isRunner(started)
  if (!runEnd && !runStart) return

  // Read what the maneuver decision needs now, before anything awaits: upstream's own
  // combatTurnChange handler (GM clients) records this round's maneuver on the token shortly.
  const round = Number(current?.round) || 0
  const startState = runStart
    ? {
        current: currentManeuver(started.actor),
        endedWith: ended?.id === started.id ? currentManeuver(started.actor) : endedWith.get(started.id),
        pickedThisRound: tokenActionsRound(started.token, round),
      }
    : null

  void (async () => {
    if (runEnd) await turnEnd(combat, ended, Number(prior?.round) || 0)
    if (runStart && startState) await turnStart(combat, started, round, startState)
  })().catch(err => console.error('GURPS | Agency | turn flow failed', err))
}

export function onDeleteCombat(combat: any): void {
  for (const combatant of combat?.combatants ?? []) endedWith.delete(combatant.id)
}

function hookData(combat: any, combatant: any): TurnHookData {
  return { combat, combatant, actor: combatant.actor ?? null, token: combatant.token ?? null }
}

async function turnStart(
  combat: any,
  combatant: any,
  round: number,
  snapshot: { current: string; endedWith: string | undefined; pickedThisRound: boolean }
): Promise<void> {
  Hooks.callAll(TURN_START_HOOK as any, hookData(combat, combatant))

  const actor = combatant.actor
  if (!actor || combatant.isDefeated) return
  const statuses = Array.from<string>(actor.statuses ?? [])
  const stunned = isStunned(statuses)
  const timing = stunRecoveryTiming()

  let promptManeuver = false
  if (maneuverPromptEnabled() && combatant.token) {
    const decision = maneuverDecision({ ...snapshot, stunned })
    if (decision.reset) {
      // Let upstream's TokenActions.newTurn() read last turn's maneuver (Aim, Evaluate...) first.
      if (game.user?.isGM && !snapshot.pickedThisRound) await upstreamNewTurn(combatant.token, round)
      await applyManeuver(combatant.token, actor, 'do_nothing')
    }
    promptManeuver = decision.prompt
  }

  const recoveryRolls = stunRecoveryRolls(statuses, timing, 'start')
  const showStun = stunned && timing !== 'off'
  if (!promptManeuver && !recoveryRolls.length && !showStun) return

  await postTurnCard(combat, combatant, round, 'start', { promptManeuver, stunned: showStun, recoveryRolls })
}

async function turnEnd(combat: any, combatant: any, round: number): Promise<void> {
  Hooks.callAll(TURN_END_HOOK as any, hookData(combat, combatant))

  const actor = combatant.actor
  if (!actor) return
  endedWith.set(combatant.id, currentManeuver(actor))
  if (combatant.isDefeated) return

  const recoveryRolls = stunRecoveryRolls(Array.from<string>(actor.statuses ?? []), stunRecoveryTiming(), 'end')
  if (recoveryRolls.length)
    await postTurnCard(combat, combatant, round, 'end', { promptManeuver: false, stunned: true, recoveryRolls })
}

/** Wait (briefly) until upstream's newTurn() has saved this round's entry on the token. */
function upstreamNewTurn(tokenDoc: AnyTokenDoc, round: number, timeoutMs = 3000): Promise<void> {
  if (tokenActionsRound(tokenDoc, round)) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => {
      Hooks.off('updateToken' as any, hookId)
      clearTimeout(timer)
      resolve()
    }
    const hookId = Hooks.on('updateToken' as any, (doc: any) => {
      if (doc.id === tokenDoc.id && tokenActionsRound(tokenDoc, round)) finish()
    })
    const timer = setTimeout(finish, timeoutMs)
  })
}

/** Set a maneuver the way upstream's combat tracker menu does. */
async function applyManeuver(tokenDoc: AnyTokenDoc | null, actor: AnyActor, maneuver: string): Promise<void> {
  const token = tokenDoc?.object
  if (token?.setManeuver) {
    await token.setManeuver(maneuver)
    await token.drawEffects?.()
  } else {
    await actor.replaceManeuver?.(maneuver)
  }
  ui.combat?.render()
}

async function postTurnCard(
  combat: any,
  combatant: any,
  round: number,
  phase: TurnPhase,
  options: { promptManeuver: boolean; stunned: boolean; recoveryRolls: RecoveryAttribute[] }
): Promise<void> {
  const actor = combatant.actor
  const card: TurnCardFlag = {
    kind: 'turn-card',
    phase,
    combatId: combat.id,
    combatantId: combatant.id,
    round,
    token: tokenRef(combatant.token, actor),
    promptManeuver: options.promptManeuver,
    stunned: options.stunned,
    recoveryRolls: options.recoveryRolls,
    state: { maneuver: null, recovery: {} },
  }
  const whisper = unique([...playerOwnerIds(actor), ...gmIds()])
  const speaker = (ChatMessage as any).getSpeaker({ actor, token: combatant.token })
  await postCard(card, whisper, speaker)
}

/* ---------------------------------------- */
/*  Card buttons                             */
/* ---------------------------------------- */

const busy = new Set<string>()

/** renderChatMessageHTML: wire the maneuver and recovery buttons for the combatant's owners. */
export function decorateTurnCard(message: any, html: HTMLElement, card: TurnCardFlag): void {
  const root = html.querySelector<HTMLElement>('[data-agency-card="turn"]')
  if (!root) return

  const actor = resolveActor(card.token)
  if (!actor || !canControl(actor)) {
    root.querySelectorAll('[data-agency-role="owner"]').forEach(el => el.remove())
    return
  }

  root.querySelectorAll<HTMLButtonElement>('[data-agency-action="maneuver"]').forEach(button =>
    button.addEventListener('click', event => {
      event.preventDefault()
      void onPickManeuver(message, card, button.dataset.maneuver ?? '')
    })
  )
  root.querySelectorAll<HTMLButtonElement>('[data-agency-action="recover"]').forEach(button =>
    button.addEventListener('click', event => {
      event.preventDefault()
      void onRecover(message, card, button.dataset.attribute as RecoveryAttribute, event)
    })
  )
}

async function onPickManeuver(message: any, card: TurnCardFlag, maneuver: string): Promise<void> {
  if (!maneuver || busy.has(message.id)) return
  busy.add(message.id)
  try {
    const actor = resolveActor(card.token)
    if (!actor) return
    const tokenDoc = resolveTokenDoc(card.token)
    await applyManeuver(tokenDoc, actor, maneuver)
    await submitCardEvent(message, { kind: 'maneuver', maneuver })
    Hooks.callAll(MANEUVER_PICKED_HOOK as any, { actor, token: tokenDoc, maneuver })
  } finally {
    busy.delete(message.id)
  }
}

/** Stun recovery (B420): HT for physical stun, IQ for mental stun; success removes the status. */
async function onRecover(message: any, card: TurnCardFlag, attribute: RecoveryAttribute, event: Event): Promise<void> {
  if (!attribute || busy.has(message.id) || card.state.recovery[attribute]) return
  busy.add(message.id)
  try {
    const actor = resolveActor(card.token)
    const action = parseOtf(attribute)
    if (!actor || !action) return
    const result = await performAndCapture(action, actor, event)
    if (!result) return

    if (!result.failure) {
      const status = attribute === 'HT' ? 'stun' : 'mentalstun'
      if (actor.statuses?.has?.(status)) await actor.toggleStatusEffect(status, { active: false })
    } else {
      ui.notifications?.info(localize(`${L}.turn.stillStunnedNote`, { name: card.token.name }))
    }
    await submitCardEvent(message, { kind: 'recovery', attribute, success: !result.failure, margin: result.margin })
  } finally {
    busy.delete(message.id)
  }
}
