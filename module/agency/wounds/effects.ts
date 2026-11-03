/**
 * Turning engine results into status effects on actors and tokens.
 *
 * Reuses upstream statuses wherever they exist (stun, prone, disabled, dead, bleed, the pain statuses,
 * shock1-4 and the "AtNextTurn" shock queue in module/token-actions.js) and adds only what upstream lacks:
 * shock5-7, unconscious, "half Move and Dodge", and one token indicator per wound severity.
 */
import {
  PAIN_STATUS_IDS,
  SEVERITIES,
  activePain,
  deriveStatus,
  effectiveShock,
  hasHighPainThreshold,
  painStatusId,
  type Effect,
  type PainState,
  type Traits,
  type WoundsState,
} from './engine.ts'
import { combatantFor, format, worldTime } from './config.ts'

const K = 'GURPS.agency.wounds'
// Setting keys from lib/miscellaneous-settings.js. Not imported: that module pulls in the whole actor sheet.
const SYSTEM_NAME = 'gurps'
const SETTING_ADD_SHOCK_AT_TURN = 'add-shock-at-turn'
const SETTING_USE_TAGGED_MODIFIERS = 'use-tagged-modifiers'
const ICONS = 'systems/gurps/icons/agency/wounds'

export const HALF_MOVE_STATUS = 'agency-halfmove'
export const UNCONSCIOUS_STATUS = 'unconscious'
export const WOUND_STATUS_PREFIX = 'agency-wound-'
export const SHOCK_STATUS_IDS = [1, 2, 3, 4, 5, 6, 7].map(n => `shock${n}`)

/** Flag marking the ActiveEffect this feature manages for Gawdawful wounds. */
const MANAGED_FLAG = 'agencyWounds'

function statusList(): any[] {
  return (CONFIG as any).statusEffects as any[]
}

function hasStatusConfig(id: string): boolean {
  return statusList().some(e => e.id === id)
}

/** Called from ready(), after upstream has replaced CONFIG.statusEffects with its own list. */
export function registerStatuses(): void {
  const list = statusList()
  const shock4 = list.find(e => e.id === 'shock4')
  for (const n of [5, 6, 7]) {
    const id = `shock${n}`
    if (hasStatusConfig(id)) continue
    const status = shock4 ? foundry.utils.deepClone(shock4) : { img: `${ICONS}/shock.svg`, duration: { rounds: 1 } }
    status.id = id
    status.name = format(`${K}.status.shock`, { n })
    status.order = 640 + n
    status.changes = (status.changes ?? []).map((change: any) => ({
      ...change,
      value: String(change.value ?? '')
        .replace(/GURPS\.modifierStatusShock4/, format(`${K}.status.shockModifier`, { n }))
        .replace(/#shock4\b/, `#${id}`),
    }))
    list.push(status)
  }

  if (!hasStatusConfig(UNCONSCIOUS_STATUS))
    list.push({
      id: UNCONSCIOUS_STATUS,
      name: 'EFFECT.StatusUnconscious',
      img: 'icons/svg/unconscious.svg',
      order: 735,
    })

  if (!hasStatusConfig(HALF_MOVE_STATUS))
    list.push({
      id: HALF_MOVE_STATUS,
      name: `${K}.status.halfMove`,
      img: `${ICONS}/half-move.svg`,
      hud: false,
      order: 1990,
      // The same change upstream's Reeling status makes: the actor halves Move and Dodge (B419).
      changes: [{ key: 'system.conditions.reeling', value: 'true', type: 'override', mode: 5 }],
    })

  // Token indicator for the worst current wound (see the report for why a status icon).
  SEVERITIES.filter(s => s !== 'destroyed').forEach((severity, index) => {
    const id = `${WOUND_STATUS_PREFIX}${severity}`
    if (!hasStatusConfig(id))
      list.push({
        id,
        name: `${K}.severity.${severity}`,
        img: `${ICONS}/${severity}.svg`,
        hud: false,
        order: 2000 + index,
      })
  })
}

export function hasStatus(actor: any, id: string): boolean {
  return !!actor?.statuses?.has?.(id)
}

/** Turn a status on or off, if it exists and is not already in that state. */
export async function setStatus(actor: any, id: string, active: boolean, overlay = false): Promise<void> {
  if (!hasStatusConfig(id)) return
  if (hasStatus(actor, id) === active) return
  await actor.toggleStatusEffect(id, { active, overlay })
}

/** Statuses for the immediate results of a wound or a check. Pain is handled by syncPain(). */
export async function applyEffectStatuses(actor: any, effects: readonly Effect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case 'stun':
        await setStatus(actor, 'stun', true)
        break
      case 'prone':
        await setStatus(actor, 'prone', true)
        break
      case 'unconscious':
        await setStatus(actor, UNCONSCIOUS_STATUS, true)
        break
      case 'incapacitated':
        await setStatus(actor, 'disabled', true)
        break
      case 'dead':
        await setStatus(actor, 'dead', true, true)
        break
    }
  }
}

/** Swap the upstream pain status to match the pain state (High Pain Threshold picks the halved status). */
export async function syncPain(
  actor: any,
  before: PainState | null,
  after: PainState | null,
  traits: Traits
): Promise<void> {
  const hpt = hasHighPainThreshold(traits)
  const now = worldTime()
  const live = after && (after.expiresAt === null || after.expiresAt > now) ? after : null
  const nextId = live ? painStatusId(live.level, hpt) : null
  const previousId = before ? painStatusId(before.level, hpt) : null
  if (previousId && previousId !== nextId) await setStatus(actor, previousId, false)
  if (nextId) await setStatus(actor, nextId, true)
}

/** Remove whatever pain status this feature put on (used when the GM clears pain). */
export async function clearPainStatuses(actor: any, before: PainState | null, traits: Traits): Promise<void> {
  if (!before) return
  const id = painStatusId(before.level, hasHighPainThreshold(traits))
  if (PAIN_STATUS_IDS.includes(id)) await setStatus(actor, id, false)
}

function taggedModifierTags(): string[] {
  try {
    const tagged: any = (game as any).settings.get(SYSTEM_NAME, SETTING_USE_TAGGED_MODIFIERS)
    return [tagged.allDXRolls, tagged.allAttackRolls]
      .map((t: unknown) =>
        String(t ?? '')
          .split(',')[0]
          .trim()
      )
      .filter(t => !!t)
  } catch {
    return ['dx', 'hit']
  }
}

/** -1 DX per Gawdawful wound, as a self modifier tagged for DX rolls and attacks. */
async function syncGawdawful(actor: any, count: number): Promise<void> {
  const existing = actor.effects?.find((e: any) => e.getFlag?.('gurps', MANAGED_FLAG) === 'gawdawful')
  if (count <= 0) {
    if (existing) await existing.delete()
    return
  }
  const name = format(`${K}.status.gawdawful`, { n: count })
  const tags = taggedModifierTags()
    .map(t => `#${t}`)
    .join(' ')
  const value = `-${count} ${format(`${K}.status.gawdawfulModifier`, { n: count })} ${tags} @combatmod`
  const changes = [{ key: 'system.conditions.self.modifiers', value, type: 'add', mode: 2 }]
  if (existing) {
    if (existing.name !== name) await existing.update({ name, changes })
    return
  }
  await actor.createEmbeddedDocuments('ActiveEffect', [
    { name, img: `${ICONS}/gawdawful.svg`, changes, flags: { gurps: { [MANAGED_FLAG]: 'gawdawful' } } },
  ])
}

/**
 * Bring the derived conditions in line with the wound state: half Move and Dodge, the worst-wound token
 * indicator, Gawdawful DX penalties, and the bleeding status (only when bleeding starts or stops, so a
 * bleed status the GM set by hand for other reasons is left alone).
 */
export async function syncDerived(actor: any, before: WoundsState, after: WoundsState): Promise<void> {
  const now = worldTime()
  const derived = deriveStatus(after, now)
  await setStatus(actor, HALF_MOVE_STATUS, derived.halfMoveDodge)
  for (const severity of SEVERITIES) {
    if (severity === 'destroyed') continue
    await setStatus(actor, `${WOUND_STATUS_PREFIX}${severity}`, severity === derived.worst)
  }
  const wasBleeding = deriveStatus(before, now).bleeding
  if (wasBleeding !== derived.bleeding) await setStatus(actor, 'bleed', derived.bleeding)
  await syncGawdawful(actor, derived.gawdawful)
}

export interface ShockOutcome {
  amount: number
  effective: number
  when: 'nextTurn' | 'now' | 'notInCombat'
}

/** Combat round (or, out of combat, the world-time second) that identifies "this turn" for merging shock. */
export function shockClock(): { combatId: string | null; round: number } {
  const combat = (game as any).combat
  if (combat?.started) return { combatId: combat.id, round: combat.round }
  return { combatId: null, round: Math.floor(worldTime()) }
}

/** Is the stored shock still waiting for the victim's next turn? */
export function shockPending(state: WoundsState): boolean {
  if (!state.shock) return false
  const clock = shockClock()
  return state.shock.combatId === clock.combatId && state.shock.round === clock.round
}

/**
 * Apply the stored shock using upstream's mechanism: with "add shock at next turn" (the default) it is
 * queued on the token for the next turn; with "immediately" the shock status goes on now. Pain does not
 * stack with shock, so only the shock above the current pain penalty is applied. Calling this again (after
 * pain changes) replaces the earlier shock.
 */
export async function applyShock(actor: any, state: WoundsState, traits: Traits): Promise<ShockOutcome | null> {
  const shock = state.shock
  if (!shock || shock.amount <= 0) return null
  const effective = Math.min(
    7,
    effectiveShock(shock.amount, activePain(state, worldTime()), hasHighPainThreshold(traits))
  )
  const statusId = `shock${effective}`
  let applyAt = 'AtNextTurn'
  try {
    applyAt = (game as any).settings.get(SYSTEM_NAME, SETTING_ADD_SHOCK_AT_TURN) ?? applyAt
  } catch {
    // keep the default
  }

  if (applyAt === 'AtNextTurn') {
    const combat = (game as any).combat
    const combatant = combat?.started ? combatantFor(actor) : null
    const token = combatant?.token?.object ?? null
    if (!combatant || !token) return { amount: shock.amount, effective, when: 'notInCombat' }
    // Loaded on demand: token-actions.js is already loaded by the system, and importing it eagerly here
    // would drag the combat classes into anything that imports this module.
    const { TokenActions } = await import('../../token-actions.js')
    const actions: any = await (TokenActions as any).fromToken(token)
    const queued = (actions.getNextTurnEffects() as string[]).filter(e => SHOCK_STATUS_IDS.includes(e))
    if (queued.length) await actions.removeFromNextTurn(queued)
    if (effective > 0) await actions.addToNextTurn([statusId])
    return { amount: shock.amount, effective, when: 'nextTurn' }
  }

  for (const id of SHOCK_STATUS_IDS) if (id !== statusId) await setStatus(actor, id, false)
  if (effective > 0) await setStatus(actor, statusId, true)
  return { amount: shock.amount, effective, when: 'now' }
}

/** The shock status the actor carries right now, if any (for the sheet). */
export function currentShock(actor: any): number {
  for (let n = 7; n >= 1; n--) if (hasStatus(actor, `shock${n}`)) return n
  return 0
}
