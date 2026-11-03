/**
 * Spending ammunition on attacks.
 *
 * gurpsAgencyPreRoll (module/dierolls/dieroll.js doRoll) runs before the roll, after upstream has asked
 * how many shots to fire (module/gurps.js attack(): optionalArgs.shots, RoF bonus pushed onto targetmods).
 * Here: refuse an empty weapon, or cut the shots down to what's loaded and fix the RoF bonus to match.
 * The decision is left on optionalArgs, which travels unchanged into _doRoll.
 *
 * gurpsAgencyRollComplete (end of _doRoll) subtracts the rounds, hit or miss. A roll cancelled in the
 * confirmation dialog never reaches _doRoll, so it spends nothing.
 */
import { calculateRoFModifier } from '../../combat/utilities.ts'
import { getAgencySetting } from '../settings.ts'
import {
  findThrownItem,
  isRangedWeapon,
  planFire,
  requestedShots,
  weaponId,
  weaponKey,
  weaponLabel,
  type EmptyMode,
  type RangedLike,
} from './ammo.ts'
import { FIRE_MARK, L10N, SETTING_EMPTY, SETTING_THROWN, SETTING_TRACKING } from './constants.ts'
import { isTracked } from './shots.ts'
import {
  allEquipment,
  enqueue,
  findViewById,
  pendingSpent,
  rangedWeapons,
  spendRounds,
  viewOf,
  type AmmoActor,
} from './state.ts'

/** A modifier as the ModifierBucket builds it (bucket-app.js _makeModifier). */
export interface RollModifier {
  mod?: string
  modint?: number
  desc?: string
  [key: string]: unknown
}

export interface PreRollContext {
  actor?: unknown
  optionalArgs?: Record<string, any>
  action?: { type?: string } | null
  targetmods?: RollModifier[]
}

export interface RollCompleteContext {
  actor?: unknown
  optionalArgs?: Record<string, any>
}

export interface FireMark {
  kind: 'rounds' | 'thrown'
  /** Weapon id (rounds) or thrown-equipment pending id. */
  id: string
  shots: number
  label: string
  /** Thrown weapons: the equipment whose count goes down. */
  eqtPath?: string
}

/* ---------------------------------------- */
/*  Helpers                                 */
/* ---------------------------------------- */

export function asAmmoActor(candidate: unknown): AmmoActor | undefined {
  const actor = candidate as AmmoActor | undefined
  if (!actor || typeof actor !== 'object') return undefined
  if (typeof actor.update !== 'function' || !actor.system || typeof actor.system !== 'object') return undefined
  return actor
}

export function emptyMode(): EmptyMode {
  return getAgencySetting<string>(SETTING_EMPTY) === 'warn' ? 'warn' : 'block'
}

const format = (key: string, data: Record<string, unknown>) =>
  game.i18n?.format(`${L10N}.${key}`, data as Record<string, string>) ?? key

/** Weapon id last fired per actor, for a bare /reload. In memory only. */
const lastFired = new Map<string, string>()

export function lastFiredId(actor: AmmoActor): string | undefined {
  return lastFired.get(actor.uuid ?? actor.id ?? '')
}

/** The data path of an attack object found by GURPS.findAttack (same object as in system.ranged). */
function pathOf(actor: AmmoActor, weapon: RangedLike): string {
  const entries = rangedWeapons(actor)
  const key = weaponKey(weapon)
  return (entries.find(e => e.value === weapon) ?? entries.find(e => weaponKey(e.value) === key))?.path ?? ''
}

/**
 * Swap the RoF bonus upstream added for `from` shots for the bonus for `to` shots.
 * Returns false when the original modifier can't be found (nothing is changed then).
 */
export function adjustRoFModifier(
  targetmods: RollModifier[] | undefined,
  from: number,
  to: number,
  labelFor: (shots: number) => string,
  add: (mod: number, label: string, list: RollModifier[]) => void
): boolean {
  if (!Array.isArray(targetmods)) return false
  const oldBonus = calculateRoFModifier(from)
  const newBonus = calculateRoFModifier(to)
  if (oldBonus !== 0) {
    const index = targetmods.findIndex(m => m.desc === labelFor(from))
    if (index < 0) return false
    targetmods.splice(index, 1)
  }
  if (newBonus !== 0) add(newBonus, labelFor(to), targetmods)
  return true
}

const rofLabel = (shots: number) =>
  game.i18n?.format('GURPS.combat.rof.bonusLabel', { shots: String(shots) }) ?? `RoF ${shots}`

const addToList = (mod: number, label: string, list: RollModifier[]) =>
  (GURPS.ModifierBucket as any).addModifier(mod, label, list)

/* ---------------------------------------- */
/*  Hooks                                   */
/* ---------------------------------------- */

export function onPreRoll(ctx: PreRollContext): false | void {
  try {
    if (!getAgencySetting<boolean>(SETTING_TRACKING)) return
    if (ctx?.action?.type !== 'attack') return
    const opt = ctx.optionalArgs
    const actor = asAmmoActor(ctx.actor)
    if (!actor || !opt || !isRangedWeapon(opt.obj)) return
    delete opt[FIRE_MARK]

    const weapon = opt.obj as RangedLike
    const view = viewOf(actor, pathOf(actor, weapon), weapon)
    const label = weaponLabel(weapon)
    const requested = requestedShots(opt.shots)

    let available: number
    let mark: Omit<FireMark, 'shots'>
    let emptyKey: string
    if (isTracked(view.spec)) {
      available = view.loaded
      mark = { kind: 'rounds', id: view.id, label }
      emptyKey = 'click'
    } else if (view.spec.thrown && getAgencySetting<boolean>(SETTING_THROWN)) {
      const item = findThrownItem(allEquipment(actor), weapon)
      if (!item) return
      const id = `t${weaponId(item.path)}`
      available = Math.max(0, item.count - pendingSpent(actor, id))
      mark = { kind: 'thrown', id, label, eqtPath: item.path }
      emptyKey = 'noneToThrow'
    } else return

    const plan = planFire(available, requested, emptyMode())
    if (plan.empty) {
      const message = format(emptyKey, { weapon: label })
      if (!plan.proceed) {
        ui.notifications?.warn(message)
        return false
      }
      ui.notifications?.warn(`${message} ${format('rollAnyway', {})}`)
      return
    }

    if (plan.capped) {
      opt.shots = plan.shots
      const adjusted = adjustRoFModifier(ctx.targetmods, requested, plan.shots, rofLabel, addToList)
      const note = format(mark.kind === 'thrown' ? 'cappedThrown' : 'capped', {
        weapon: label,
        count: plan.shots,
        requested,
      })
      ui.notifications?.warn(adjusted ? note : `${note} ${format('rofNotAdjusted', {})}`)
    }

    opt[FIRE_MARK] = { ...mark, shots: plan.shots } satisfies FireMark
  } catch (err) {
    // Never let a bookkeeping bug stop a roll.
    console.error('GURPS | Agency firearms: pre-roll check failed', err)
  }
}

export function onRollComplete(ctx: RollCompleteContext): void {
  try {
    const opt = ctx?.optionalArgs
    const mark = opt?.[FIRE_MARK] as FireMark | undefined
    if (!opt || !mark) return
    delete opt[FIRE_MARK]

    const actor = asAmmoActor(ctx.actor)
    if (!actor || actor.isOwner === false || !(mark.shots > 0)) return

    if (mark.kind === 'rounds') {
      const view = findViewById(actor, mark.id)
      if (!view) return
      lastFired.set(actor.uuid ?? actor.id ?? '', mark.id)
      void spendRounds(actor, view, mark.shots)
        .then(left => {
          if (left === 0) ui.notifications?.info(format('nowEmpty', { weapon: mark.label }))
        })
        .catch(err => console.error('GURPS | Agency firearms: could not record rounds fired', err))
      return
    }

    void enqueue(actor, mark.id, mark.shots, async () => {
      const entry = allEquipment(actor).find(e => e.path === mark.eqtPath)
      if (!entry || !actor.updateEqtCount) return
      await actor.updateEqtCount(entry.path, Math.max(0, entry.count - mark.shots))
    }).catch(err => console.error('GURPS | Agency firearms: could not update thrown weapon count', err))
  } catch (err) {
    console.error('GURPS | Agency firearms: roll-complete bookkeeping failed', err)
  }
}
