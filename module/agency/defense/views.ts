/**
 * Chat card content for defense and turn cards. The content is rendered by whichever client creates
 * or updates the card; per-viewer parts (the defender's buttons, the attacker's damage button) are
 * added or removed when the card is displayed (see decorate* in defense-card.ts / turn-flow.ts).
 */
import Maneuvers from '../../combat/maneuver.js'
import { localize, renderTemplate } from './foundry-helpers.ts'
import type { AgencyCardFlag, DefenseAttempt, DefenseCardFlag, TurnCardFlag } from './types.ts'

export const TEMPLATES = {
  defenseCard: 'systems/gurps/templates/agency/defense-card.hbs',
  defenseControls: 'systems/gurps/templates/agency/defense-controls.hbs',
  turnCard: 'systems/gurps/templates/agency/turn-card.hbs',
}

const L = 'GURPS.agency.defense'

export function maneuverInfo(name: string): { id: string; label: string; img: string } {
  const data: any = Maneuvers.getManeuver(name)
  return { id: name, label: localize(data?.label ?? name), img: data?.img ?? '' }
}

export function hitLocationLabel(raw: string): string {
  const key = `GURPS.hitLocation${raw}`
  const text = localize(key)
  return text === key ? raw : text
}

export function defenseLabel(type: string, weapon = ''): string {
  const name = localize(`${L}.defense.${type}`)
  return weapon ? `${name} (${weapon})` : name
}

function attemptText(attempt: DefenseAttempt, rapid: boolean): string {
  if (attempt.type === 'none') return localize(`${L}.card.noDefenseTaken`)
  const what = defenseLabel(attempt.type, attempt.label)
  let text = attempt.success
    ? localize(`${L}.card.attemptSuccess`, { defense: what, margin: attempt.margin })
    : localize(`${L}.card.attemptFailure`, { defense: what, margin: Math.abs(attempt.margin) })
  if (attempt.critSuccess) text += ` ${localize(`${L}.card.critSuccess`)}`
  if (attempt.critFailure) text += ` ${localize(`${L}.card.critFailure`)}`
  if (rapid && attempt.success)
    text += ` ${localize(`${L}.card.hitsStopped`, { stopped: attempt.hitsBefore - attempt.hitsAfter, of: attempt.hitsBefore })}`
  return text
}

function reasonText(card: DefenseCardFlag): string {
  switch (card.state.noDefenseReason) {
    case 'critical':
      return localize(`${L}.reason.critical`)
    case 'maneuver':
      return localize(`${L}.reason.maneuver`, { maneuver: maneuverInfo(card.maneuver).label })
    case 'cantSee':
      return localize(`${L}.reason.cantSee`)
    default:
      return ''
  }
}

function defenseCardView(card: DefenseCardFlag): Record<string, unknown> {
  const { attack, state } = card
  const rapid = state.potentialHits > 1
  const kind = attack.profile.thrown ? 'thrown' : attack.profile.kind
  const stamp: Record<string, string> = {
    defended: localize(`${L}.card.stampDefended`),
    hit:
      state.hitsRemaining > 1
        ? localize(`${L}.card.stampHits`, { hits: state.hitsRemaining })
        : localize(`${L}.card.stampHit`),
    damaged: localize(`${L}.card.stampDamaged`),
  }

  return {
    status: state.status,
    isAwaiting: state.status === 'awaiting',
    isHit: state.status === 'hit',
    title: localize(`${L}.card.title`, { attacker: attack.attacker.name, target: card.target.name }),
    kindLabel: localize(`${L}.card.kind.${kind}`),
    kindIcon: attack.profile.kind === 'melee' ? 'fa-solid fa-sword' : 'fa-solid fa-crosshairs',
    weapon: attack.weapon,
    damage: attack.damage,
    hitLocation: attack.hitLocation
      ? localize(`${L}.card.hitLocation`, { location: hitLocationLabel(attack.hitLocation) })
      : '',
    hitsText: rapid ? localize(`${L}.card.potentialHits`, { hits: state.potentialHits }) : '',
    marginText: attack.isCritSuccess
      ? localize(`${L}.card.criticalHit`)
      : attack.isBlind || attack.margin === null
        ? ''
        : localize(`${L}.card.margin`, { margin: attack.margin }),
    criticalText:
      !attack.isCritSuccess && state.criticalHits > 0
        ? localize(`${L}.card.criticalHits`, { critical: state.criticalHits })
        : '',
    deceptiveText:
      attack.deceptivePenalty > 0 ? localize(`${L}.card.deceptive`, { penalty: attack.deceptivePenalty }) : '',
    reasonText: reasonText(card),
    attempts: state.attempts.map(a => ({ text: attemptText(a, rapid), cls: a.success ? 'is-success' : 'is-failure' })),
    waitingText: localize(`${L}.card.waiting`, { target: card.target.name }),
    stampText: stamp[state.status] ?? '',
    damageButtonLabel:
      state.hitsRemaining > 1
        ? localize(`${L}.card.rollDamageTimes`, { hits: state.hitsRemaining })
        : localize(`${L}.card.rollDamage`),
  }
}

function turnCardView(card: TurnCardFlag): Record<string, unknown> {
  const recovery = card.recoveryRolls.map(attribute => {
    const result = card.state.recovery[attribute]
    return {
      attribute,
      done: !!result,
      cls: result?.success ? 'is-success' : 'is-failure',
      label: localize(`${L}.turn.recoverButton`, { attribute }),
      text: result
        ? localize(result.success ? `${L}.turn.recovered` : `${L}.turn.stillStunned`, {
            attribute,
            margin: Math.abs(result.margin),
          })
        : '',
    }
  })

  const current = card.state.maneuver
  const maneuvers = card.promptManeuver
    ? Object.entries((Maneuvers as any).getAllInPlayData() as Record<string, any>).map(([id, data]) => ({
        id,
        label: localize(data.label),
        img: data.img,
      }))
    : []

  return {
    phase: card.phase,
    title: localize(card.phase === 'start' ? `${L}.turn.start` : `${L}.turn.end`, { name: card.token.name }),
    roundLabel: localize(`${L}.turn.round`, { round: card.round }),
    stunnedText: card.stunned
      ? localize(card.phase === 'start' ? `${L}.turn.stunnedStart` : `${L}.turn.stunnedEnd`)
      : '',
    recovery,
    promptManeuver: card.promptManeuver,
    maneuverPromptText: localize(`${L}.turn.pickManeuver`),
    chosen: current ? maneuverInfo(current) : null,
    chosenText: current ? localize(`${L}.turn.chosen`, { maneuver: maneuverInfo(current).label }) : '',
    maneuvers,
  }
}

export async function renderCard(card: AgencyCardFlag): Promise<string> {
  return card.kind === 'defense-card'
    ? renderTemplate(TEMPLATES.defenseCard, defenseCardView(card))
    : renderTemplate(TEMPLATES.turnCard, turnCardView(card))
}
