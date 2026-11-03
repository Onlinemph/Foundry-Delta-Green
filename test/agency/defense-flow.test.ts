import {
  applyDamageRolled,
  applyDefenseAttempt,
  chooseCardExecutor,
  initialDefenseState,
  isStunned,
  maneuverDecision,
  pickAutomationRunner,
  reduceCard,
  stunRecoveryRolls,
  turnTransition,
} from '../../module/agency/defense/flow.js'
import type { DefenseCardFlag, TurnCardFlag } from '../../module/agency/defense/types.js'

const ALL = ['dodge', 'parry', 'block'] as const

const dodge = (success: boolean, margin: number) => ({ type: 'dodge' as const, label: '', success, margin })
const parry = (success: boolean, margin: number) => ({ type: 'parry' as const, label: 'Sword', success, margin })

describe('defense card state', () => {
  it('starts awaiting a defense', () => {
    const state = initialDefenseState(1, 0, null, [...ALL])
    expect(state).toMatchObject({ status: 'awaiting', potentialHits: 1, hitsRemaining: 1, criticalHits: 0 })
    expect(state.allowed).toEqual(['dodge', 'parry', 'block'])
  })

  it('starts as a hit when no defense is possible', () => {
    expect(initialDefenseState(1, 0, 'maneuver', [])).toMatchObject({ status: 'hit', allowed: [] })
  })

  it('makes every hit critical after a critical attack roll', () => {
    expect(initialDefenseState(3, 0, 'critical', [])).toMatchObject({
      status: 'hit',
      criticalHits: 3,
      hitsRemaining: 3,
    })
  })

  it('is a hit with no defense when every hit is critical', () => {
    expect(initialDefenseState(2, 2, null, [...ALL])).toMatchObject({ status: 'hit', noDefenseReason: 'critical' })
  })

  it('is defended after a successful defense', () => {
    const state = applyDefenseAttempt(initialDefenseState(1, 0, null, [...ALL]), dodge(true, 2), false)
    expect(state).toMatchObject({ status: 'defended', hitsRemaining: 0 })
    expect(state.attempts[0]).toMatchObject({ type: 'dodge', success: true, hitsBefore: 1, hitsAfter: 0 })
  })

  it('is a hit after a failed defense or no defense', () => {
    expect(applyDefenseAttempt(initialDefenseState(1, 0, null, [...ALL]), parry(false, -1), false).status).toBe('hit')
    expect(
      applyDefenseAttempt(
        initialDefenseState(1, 0, null, [...ALL]),
        { type: 'none', label: '', success: false, margin: 0 },
        false
      ).status
    ).toBe('hit')
  })

  it('leaves the undodged rapid-fire hits', () => {
    const state = applyDefenseAttempt(initialDefenseState(6, 0, null, [...ALL]), dodge(true, 2), false)
    expect(state).toMatchObject({ status: 'hit', hitsRemaining: 3 })
  })

  it('keeps critical hits through a successful dodge', () => {
    const state = applyDefenseAttempt(initialDefenseState(5, 2, null, [...ALL]), dodge(true, 9), false)
    expect(state).toMatchObject({ status: 'hit', hitsRemaining: 2 })
  })

  it('ignores defenses that are not allowed, and late results', () => {
    const noParry = initialDefenseState(1, 0, null, ['dodge'])
    expect(applyDefenseAttempt(noParry, parry(true, 3), false)).toBe(noParry)

    const done = applyDefenseAttempt(initialDefenseState(1, 0, null, [...ALL]), dodge(true, 0), false)
    expect(applyDefenseAttempt(done, dodge(false, -3), false)).toBe(done)
  })

  it('allows a second, different defense with All-Out Defense (Double) (B366)', () => {
    const first = applyDefenseAttempt(initialDefenseState(1, 0, null, [...ALL]), dodge(false, -2), true)
    expect(first).toMatchObject({ status: 'awaiting', allowed: ['parry', 'block'] })

    const second = applyDefenseAttempt(first, parry(false, -1), true)
    expect(second).toMatchObject({ status: 'hit', allowed: [] })
    expect(second.attempts).toHaveLength(2)
  })

  it('does not retry after choosing no defense', () => {
    const state = applyDefenseAttempt(
      initialDefenseState(1, 0, null, [...ALL]),
      { type: 'none', label: '', success: false, margin: 0 },
      true
    )
    expect(state.status).toBe('hit')
  })

  it('records the damage roll once', () => {
    const hit = initialDefenseState(2, 0, 'maneuver', [])
    const damaged = applyDamageRolled(hit, 2)
    expect(damaged).toMatchObject({ status: 'damaged', damageHits: 2 })
    expect(applyDamageRolled(damaged, 2)).toBe(damaged)
    const awaiting = initialDefenseState(1, 0, null, [...ALL])
    expect(applyDamageRolled(awaiting, 1)).toBe(awaiting)
  })
})

describe('reduceCard', () => {
  const defenseCard = (): DefenseCardFlag =>
    ({
      kind: 'defense-card',
      attack: {} as any,
      target: { sceneId: 's', tokenId: 't', actorId: 'a', name: 'Target' },
      maneuver: 'attack',
      state: initialDefenseState(1, 0, null, ['dodge']),
    }) as DefenseCardFlag

  const turnCard = (): TurnCardFlag => ({
    kind: 'turn-card',
    phase: 'end',
    combatId: 'c',
    combatantId: 'x',
    round: 2,
    token: { sceneId: 's', tokenId: 't', actorId: 'a', name: 'Bob' },
    promptManeuver: true,
    stunned: true,
    recoveryRolls: ['HT'],
    state: { maneuver: null, recovery: {} },
  })

  it('applies defense and damage events to defense cards', () => {
    const card = defenseCard()
    const hit = reduceCard(card, { kind: 'defense', attempt: dodge(false, -1), doubleDefense: false })
    expect(hit.state.status).toBe('hit')
    expect(reduceCard(hit, { kind: 'damage', hits: 1 }).state.status).toBe('damaged')
  })

  it('returns the same card for events that do not apply', () => {
    const card = defenseCard()
    expect(reduceCard(card, { kind: 'maneuver', maneuver: 'attack' })).toBe(card)
    const turn = turnCard()
    expect(reduceCard(turn, { kind: 'damage', hits: 1 })).toBe(turn)
  })

  it('records maneuver choices and the first recovery roll on turn cards', () => {
    const turn = reduceCard(turnCard(), { kind: 'maneuver', maneuver: 'attack' })
    expect(turn.state.maneuver).toBe('attack')

    const failed = reduceCard(turn, { kind: 'recovery', attribute: 'HT', success: false, margin: -2 })
    expect(failed.state.recovery.HT).toEqual({ success: false, margin: -2 })
    expect(reduceCard(failed, { kind: 'recovery', attribute: 'HT', success: true, margin: 3 })).toBe(failed)
  })
})

describe('chooseCardExecutor', () => {
  const base = {
    selfId: 'def',
    selfIsGM: false,
    authorId: 'atk',
    activeGMId: 'gm',
    activeUserIds: ['def', 'atk', 'gm'],
  }

  it('updates the card itself when it is the author or a GM', () => {
    expect(chooseCardExecutor({ ...base, selfId: 'atk' })).toEqual({ kind: 'self' })
    expect(chooseCardExecutor({ ...base, selfIsGM: true })).toEqual({ kind: 'self' })
  })

  it('asks the active GM first', () => {
    expect(chooseCardExecutor(base)).toEqual({ kind: 'remote', userId: 'gm' })
  })

  it('asks the online author when no GM is logged in', () => {
    expect(chooseCardExecutor({ ...base, activeGMId: null })).toEqual({ kind: 'remote', userId: 'atk' })
  })

  it('falls back to a new message when nobody can update the card', () => {
    expect(chooseCardExecutor({ ...base, activeGMId: null, activeUserIds: ['def'] })).toEqual({ kind: 'fallback' })
  })
})

describe('pickAutomationRunner', () => {
  const users = [
    { id: 'gm2', active: true, isGM: true },
    { id: 'gm1', active: true, isGM: true },
    { id: 'p2', active: true, isGM: false },
    { id: 'p1', active: true, isGM: false },
    { id: 'p0', active: false, isGM: false },
  ]

  it('prefers the active GM', () => {
    expect(pickAutomationRunner(users, ['p1'], 'gm2')).toBe('gm2')
  })

  it('agrees on one GM when the active GM is not known', () => {
    expect(pickAutomationRunner(users, ['p1'])).toBe('gm1')
  })

  it('falls back to the first online owner without a GM', () => {
    const players = users.filter(u => !u.isGM)
    expect(pickAutomationRunner(players, ['p0', 'p2', 'p1'], null)).toBe('p1')
  })

  it('returns null when nobody can run it', () => {
    expect(
      pickAutomationRunner(
        users.filter(u => !u.isGM),
        ['p0'],
        null
      )
    ).toBeNull()
  })
})

describe('turnTransition', () => {
  it('starts the first combatant when combat begins', () => {
    expect(
      turnTransition({ round: 0, turn: null, combatantId: null }, { round: 1, turn: 0, combatantId: 'a' })
    ).toEqual({ ended: null, started: 'a', rewind: false })
  })

  it('ends one turn and starts the next', () => {
    expect(turnTransition({ round: 1, turn: 0, combatantId: 'a' }, { round: 1, turn: 1, combatantId: 'b' })).toEqual({
      ended: 'a',
      started: 'b',
      rewind: false,
    })
  })

  it('handles a new round', () => {
    expect(turnTransition({ round: 1, turn: 2, combatantId: 'c' }, { round: 2, turn: 0, combatantId: 'a' })).toEqual({
      ended: 'c',
      started: 'a',
      rewind: false,
    })
  })

  it('handles a single combatant going round after round', () => {
    expect(turnTransition({ round: 1, turn: 0, combatantId: 'a' }, { round: 2, turn: 0, combatantId: 'a' })).toEqual({
      ended: 'a',
      started: 'a',
      rewind: false,
    })
  })

  it('does nothing when the GM steps back', () => {
    expect(
      turnTransition({ round: 1, turn: 1, combatantId: 'b' }, { round: 1, turn: 0, combatantId: 'a' }).rewind
    ).toBe(true)
    expect(
      turnTransition({ round: 2, turn: 0, combatantId: 'a' }, { round: 1, turn: 2, combatantId: 'c' }).rewind
    ).toBe(true)
  })
})

describe('stun recovery', () => {
  it('rolls HT for physical stun and IQ for mental stun (B420)', () => {
    expect(stunRecoveryRolls(['stun'], 'end', 'end')).toEqual(['HT'])
    expect(stunRecoveryRolls(['mentalstun'], 'end', 'end')).toEqual(['IQ'])
    expect(stunRecoveryRolls(['stun', 'mentalstun', 'prone'], 'start', 'start')).toEqual(['HT', 'IQ'])
  })

  it('only rolls in the configured phase', () => {
    expect(stunRecoveryRolls(['stun'], 'end', 'start')).toEqual([])
    expect(stunRecoveryRolls(['stun'], 'off', 'end')).toEqual([])
    expect(stunRecoveryRolls(['prone'], 'end', 'end')).toEqual([])
  })

  it('knows when an actor is stunned', () => {
    expect(isStunned(new Set(['mentalstun']))).toBe(true)
    expect(isStunned([])).toBe(false)
  })
})

describe('maneuverDecision', () => {
  const base = { current: 'allout_attack', endedWith: 'allout_attack', pickedThisRound: false, stunned: false }

  it('expires last turn’s maneuver and prompts for a new one', () => {
    expect(maneuverDecision(base)).toEqual({ reset: true, prompt: true })
  })

  it('prompts without resetting when already on Do Nothing', () => {
    expect(maneuverDecision({ ...base, current: 'do_nothing' })).toEqual({ reset: false, prompt: true })
    expect(maneuverDecision({ ...base, current: undefined, endedWith: undefined })).toEqual({
      reset: false,
      prompt: true,
    })
  })

  it('keeps a maneuver picked ahead of the turn', () => {
    expect(maneuverDecision({ ...base, current: 'attack' })).toEqual({ reset: false, prompt: false })
    expect(maneuverDecision({ ...base, pickedThisRound: true })).toEqual({ reset: false, prompt: false })
  })

  it('resets when it does not know the previous maneuver', () => {
    expect(maneuverDecision({ ...base, endedWith: undefined })).toEqual({ reset: true, prompt: true })
  })

  it('leaves stunned combatants alone (upstream forces Do Nothing)', () => {
    expect(maneuverDecision({ ...base, stunned: true })).toEqual({ reset: false, prompt: false })
  })
})
