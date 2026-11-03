/**
 * Hooks that run the time- and turn-based parts of Revised Fractional Health:
 * - FP dropping to 0 or below, and past -1 x FP and each further 1/2 FP, posts the HT checks it calls for.
 * - At the start of a turn at 0 or less FP, an HT roll to act.
 * - Pain wears off when world time passes its expiry.
 */
import {
  actCheckModifiers,
  fatigueCheckSpec,
  fatigueChecksCrossed,
  fatigueCondition,
  fatigueBreakpoints,
  reachedZeroFP,
} from './engine.ts'
import { actorTraits, format, isRFH, localize, readState, signed, writeState } from './config.ts'
import { hasStatus, syncDerived, syncPain, UNCONSCIOUS_STATUS } from './effects.ts'
import { ownerWhisper, postCard, type CardCheck } from './chat.ts'

const K = 'GURPS.agency.wounds'
const OLD_FP = 'agencyWoundsOldFP'

function fpIn(changes: any): number | undefined {
  const flat = changes?.['system.FP.value']
  const value = flat !== undefined ? flat : foundry.utils.getProperty(changes ?? {}, 'system.FP.value')
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** FP before an update, by actor UUID: preUpdateActor runs on the same client as the updateActor that reads it. */
const oldFPs = new Map<string, number>()

export function onPreUpdateActor(actor: any, changes: any, options: any): void {
  if (!isRFH() || fpIn(changes) === undefined) return
  const old = Number(actor.system?.FP?.value)
  oldFPs.set(actor.uuid, old)
  if (options) options[OLD_FP] = old
}

export async function onUpdateActor(actor: any, changes: any, options: any, userId: string): Promise<void> {
  if (!isRFH() || userId !== (game as any).user?.id) return
  const newFP = fpIn(changes)
  const oldFP = Number(options?.[OLD_FP] ?? oldFPs.get(actor.uuid))
  oldFPs.delete(actor.uuid)
  if (newFP === undefined || !Number.isFinite(oldFP)) return
  const maxFP = Number(actor.system?.FP?.max) || 0
  const crossed = fatigueChecksCrossed(oldFP, newFP, maxFP)
  const zero = reachedZeroFP(oldFP, newFP)
  if (!crossed.length && !zero) return

  const traits = actorTraits(actor)
  const checks: CardCheck[] = crossed.map(threshold => ({
    source: 'fatigue',
    id: foundry.utils.randomID(),
    kind: 'fatigue',
    threshold,
    spec: fatigueCheckSpec(threshold, traits),
  }))
  const lines: string[] = []
  if (zero) lines.push(localize(`${K}.card.zeroFP`))
  if (crossed.length) lines.push(localize(`${K}.card.fpCheckHelp`))
  await postCard(actor, {
    actorUuid: actor.uuid,
    actorName: actor.name,
    title: format(`${K}.card.fpTitle`, { fp: newFP, max: maxFP }),
    entries: [],
    lines,
    checks,
    results: [],
    whisper: ownerWhisper(actor),
    injuryTolerance: null,
  })
}

/* ------------------------------------------------------------------ */
/* Turn start                                                         */
/* ------------------------------------------------------------------ */

const turnsSeen = new Set<string>()

export async function onTurnStart(combat: any, combatant: any): Promise<void> {
  if (!isRFH() || !(game as any).users?.activeGM?.isSelf || !combat || !combatant) return
  // Both Foundry's combatTurnChange and the fork's gurpsAgencyTurnStart may report the same turn.
  const key = `${combat.id}:${combat.round}:${combat.turn}:${combatant.id}`
  if (turnsSeen.has(key)) return
  turnsSeen.add(key)

  const actor = combatant.actor
  if (!actor) return
  const fp = Number(actor.system?.FP?.value)
  if (!(fp <= 0)) return
  if (hasStatus(actor, 'dead') || hasStatus(actor, UNCONSCIOUS_STATUS)) return

  const check: CardCheck = {
    source: 'act',
    id: foundry.utils.randomID(),
    kind: 'act',
    modifiers: actCheckModifiers(actorTraits(actor)),
  }
  await postCard(actor, {
    actorUuid: actor.uuid,
    actorName: actor.name,
    title: format(`${K}.card.fpTitle`, { fp, max: actor.system?.FP?.max ?? 0 }),
    entries: [],
    lines: [localize(`${K}.card.actHelp`)],
    checks: [check],
    results: [],
    whisper: ownerWhisper(actor),
    injuryTolerance: null,
  })
}

export function onCombatTurnChange(combat: any, _prior: any, current: any): void {
  const combatant = current?.combatantId ? combat?.combatants?.get(current.combatantId) : combat?.combatant
  void onTurnStart(combat, combatant)
}

/* ------------------------------------------------------------------ */
/* Pain wearing off                                                   */
/* ------------------------------------------------------------------ */

function actorsWithPain(): any[] {
  const g = game as any
  const actors: any[] = [...(g.actors?.contents ?? [])]
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    if (!token.document?.actorLink && token.actor) actors.push(token.actor)
  }
  return actors.filter(a => !!foundry.utils.getProperty(a, 'flags.gurps.agency.wounds.pain'))
}

export async function onUpdateWorldTime(now: number): Promise<void> {
  if (!isRFH() || !(game as any).users?.activeGM?.isSelf) return
  for (const actor of actorsWithPain()) {
    const state = readState(actor)
    if (!state.pain || state.pain.expiresAt === null || state.pain.expiresAt > now) continue
    const next = { ...state, pain: null }
    await writeState(actor, next)
    const traits = actorTraits(actor)
    await syncPain(actor, state.pain, null, traits)
    await syncDerived(actor, state, next)
  }
}

/* ------------------------------------------------------------------ */
/* FP condition on the sheets                                         */
/* ------------------------------------------------------------------ */

/**
 * Upstream shows "Unconscious" at -1 x FP. Under RFH that is only where the HT checks begin, so when RFH
 * is on the FP condition helpers (lib/hitpoints.js) answer from fatigueCondition() instead.
 */
export function overrideFatigueHelpers(): void {
  const H = Handlebars as any
  const wrap = (name: string, replacement: (original: any, ...args: any[]) => any) => {
    const original = H.helpers?.[name]
    if (!original) return
    H.registerHelper(name, function (this: any, ...args: any[]) {
      return replacement.call(this, original, ...args)
    })
  }

  const condition = (FP: any, member: string) => {
    const c = fatigueCondition(Number(FP?.value), Number(FP?.max) || 0)
    return member === 'label' ? c.label : c.style
  }

  const breakpoints = (FP: any, options: any) => {
    const value = Number(FP?.value)
    const list = fatigueBreakpoints(Number(FP?.max) || 0)
    let selected = -1
    list.forEach((b, i) => {
      if (value <= b.breakpoint) selected = i
    })
    return list
      .map((b, i) =>
        options.fn({
          breakpoint: b.breakpoint,
          label: b.modifier ? `${localize(b.label)} (${signed(b.modifier)})` : localize(b.label),
          style: i === selected ? 'selected' : '',
        })
      )
      .join('')
  }

  wrap('hpFpCondition', function (this: any, original: any, type: string, value: any, attr: string, ...rest: any[]) {
    if (type === 'FP' && isRFH()) return condition(value, attr)
    return original.call(this, type, value, attr, ...rest)
  })
  wrap('fpCondition', function (this: any, original: any, FP: any, member: string, ...rest: any[]) {
    if (isRFH()) return condition(FP, member)
    return original.call(this, FP, member, ...rest)
  })
  wrap('hpFpBreakpoints', function (this: any, original: any, type: string, value: any, options: any) {
    if (type === 'FP' && isRFH()) return breakpoints(value, options)
    return original.call(this, type, value, options)
  })
  wrap('fpBreakpoints', function (this: any, original: any, FP: any, options: any) {
    if (isRFH()) return breakpoints(FP, options)
    return original.call(this, FP, options)
  })
}
