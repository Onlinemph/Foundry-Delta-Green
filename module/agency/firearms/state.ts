/**
 * Per-actor ammunition state in flags.gurps.agency.firearms.weapons.<id>.
 *
 * Flags survive a GCS re-import (the importer only rewrites system.ranged / system.equipment).
 * Rounds are not written until a weapon is first fired or reloaded: until then it reads as full.
 */
import {
  currentLoaded,
  equipmentEntries,
  flattenList,
  weaponId,
  weaponKey,
  type EquipmentEntry,
  type FlatEntry,
  type RangedLike,
  type WeaponAmmoState,
} from './ammo.ts'
import { FLAG_PATH } from './constants.ts'
import { parseShots, type ShotsSpec } from './shots.ts'

/** The slice of a GurpsActor this feature touches. */
export interface AmmoActor {
  id: string | null
  uuid?: string
  name: string | null
  isOwner?: boolean
  flags?: Record<string, any>
  system?: {
    ranged?: Record<string, RangedLike>
    equipment?: { carried?: Record<string, any>; other?: Record<string, any> }
  }
  update(data: Record<string, unknown>, context?: Record<string, unknown>): Promise<unknown>
  updateEqtCount?(eqtkey: string, count: number): Promise<void>
}

export interface WeaponView {
  path: string
  weapon: RangedLike
  key: string
  id: string
  spec: ShotsSpec
  state: WeaponAmmoState
  loaded: number
}

function actorRef(actor: AmmoActor): string {
  return actor.uuid ?? actor.id ?? actor.name ?? '?'
}

export function weaponStates(actor: AmmoActor): Record<string, WeaponAmmoState> {
  return actor.flags?.gurps?.agency?.firearms?.weapons ?? {}
}

/* ---------------------------------------- */
/*  Rounds already fired but not yet saved  */
/* ---------------------------------------- */

const pending = new Map<string, number>()
const queues = new Map<string, Promise<unknown>>()

export function pendingSpent(actor: AmmoActor, id: string): number {
  return pending.get(`${actorRef(actor)}|${id}`) ?? 0
}

/**
 * Run updates for one actor one after another, so quick successive shots each read the
 * previous result; `spent` rounds count as gone for reads made while the update is in flight.
 */
export function enqueue(actor: AmmoActor, id: string, spent: number, task: () => Promise<unknown>): Promise<unknown> {
  const pendingKey = `${actorRef(actor)}|${id}`
  pending.set(pendingKey, (pending.get(pendingKey) ?? 0) + spent)
  const queueKey = actorRef(actor)
  const previous = queues.get(queueKey) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        // The task reads the stored flag (without the pending overlay) and writes the new value.
        return await task()
      } finally {
        // Once the update has landed the stored flag already reflects these rounds.
        const left = (pending.get(pendingKey) ?? 0) - spent
        if (left > 0) pending.set(pendingKey, left)
        else pending.delete(pendingKey)
      }
    })
  queues.set(queueKey, next)
  return next.finally(() => {
    if (queues.get(queueKey) === next) queues.delete(queueKey)
  })
}

/* ---------------------------------------- */
/*  Views                                   */
/* ---------------------------------------- */

export function viewOf(actor: AmmoActor, path: string, weapon: RangedLike): WeaponView {
  const key = weaponKey(weapon)
  const id = weaponId(key)
  const spec = parseShots(weapon.shots)
  const state = weaponStates(actor)[id] ?? {}
  return { path, weapon, key, id, spec, state, loaded: currentLoaded(state, spec, pendingSpent(actor, id)) }
}

export function rangedWeapons(actor: AmmoActor): FlatEntry<RangedLike>[] {
  return flattenList(actor.system?.ranged, 'system.ranged.')
}

export function weaponViews(actor: AmmoActor): WeaponView[] {
  return rangedWeapons(actor).map(({ path, value }) => viewOf(actor, path, value))
}

export function findViewById(actor: AmmoActor, id: string): WeaponView | undefined {
  return weaponViews(actor).find(v => v.id === id)
}

export function findViewByPath(actor: AmmoActor, path: string): WeaponView | undefined {
  const entry = rangedWeapons(actor).find(e => e.path === path)
  return entry ? viewOf(actor, entry.path, entry.value) : undefined
}

/** Carried equipment: the only place a reload draws from. */
export function carriedEquipment(actor: AmmoActor): EquipmentEntry[] {
  return equipmentEntries(actor.system?.equipment?.carried, 'system.equipment.carried.')
}

/** Carried, then other equipment: where a thrown weapon's count lives. */
export function allEquipment(actor: AmmoActor): EquipmentEntry[] {
  return [...carriedEquipment(actor), ...equipmentEntries(actor.system?.equipment?.other, 'system.equipment.other.')]
}

/* ---------------------------------------- */
/*  Writes                                  */
/* ---------------------------------------- */

export async function writeState(actor: AmmoActor, view: Pick<WeaponView, 'id' | 'key'>, data: WeaponAmmoState) {
  const update: Record<string, unknown> = { [`${FLAG_PATH}.${view.id}.key`]: view.key }
  for (const [field, value] of Object.entries(data)) update[`${FLAG_PATH}.${view.id}.${field}`] = value
  return actor.update(update)
}

/** Subtract rounds fired. Reads the stored value when the update runs, never goes below 0. */
export function spendRounds(actor: AmmoActor, view: WeaponView, shots: number): Promise<unknown> {
  return enqueue(actor, view.id, shots, async () => {
    const loaded = Math.max(0, currentLoaded(weaponStates(actor)[view.id], view.spec) - shots)
    await writeState(actor, view, { loaded })
    return loaded
  })
}
