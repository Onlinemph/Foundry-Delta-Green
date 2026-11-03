/**
 * Per-actor ammunition state in flags.gurps.agency.firearms:
 *   weapons.<feed id>   rounds loaded and ammo settings per feed (one magazine per gun: see feedKey)
 *   partials            magazines ejected with rounds left
 *
 * Flags survive a GCS re-import (the importer only rewrites system.ranged / system.equipment).
 * Rounds are not written until a weapon is first fired or reloaded: until then it reads as full.
 *
 * Before usages shared a magazine, state was kept per usage (name|mode). Those entries are merged
 * when read (mergeLegacyStates) and replaced by the feed's entry on the next write.
 */
import {
  currentLoaded,
  equipmentEntries,
  feedKey,
  flattenList,
  gunName,
  mergeLegacyStates,
  weaponId,
  weaponKey,
  weaponLabel,
  type EquipmentEntry,
  type FlatEntry,
  type PartialMagazine,
  type RangedLike,
  type WeaponAmmoState,
} from './ammo.ts'
import { FLAG_PATH, PARTIALS_PATH } from './constants.ts'
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
  /** Feed key and id: every usage drawing from the same magazine has the same ones. */
  key: string
  id: string
  /** This usage's own key and id (name|mode): where a 'separate' mark is kept. */
  modeKey: string
  modeId: string
  spec: ShotsSpec
  /** The feed's state (merged from per-usage entries until it is first written). */
  state: WeaponAmmoState
  loaded: number
  /** Usages sharing this feed (this one included). */
  modes: number
  /** Per-usage entries still to be replaced by the feed's own entry on the next write. */
  legacyIds: string[]
  /** "Glock 17" for a shared feed, "M16A2 (M203)" for a usage with its own. */
  label: string
}

function actorRef(actor: AmmoActor): string {
  return actor.uuid ?? actor.id ?? actor.name ?? '?'
}

export function weaponStates(actor: AmmoActor): Record<string, WeaponAmmoState> {
  return actor.flags?.gurps?.agency?.firearms?.weapons ?? {}
}

export function partialMagazines(actor: AmmoActor): PartialMagazine[] {
  const list = actor.flags?.gurps?.agency?.firearms?.partials
  return Array.isArray(list) ? list.filter(p => p && typeof p === 'object' && typeof p.id === 'string') : []
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

interface FeedInfo {
  key: string
  id: string
  modeKey: string
  modeId: string
  spec: ShotsSpec
}

function feedInfo(states: Record<string, WeaponAmmoState>, weapon: RangedLike): FeedInfo {
  const modeKey = weaponKey(weapon)
  const modeId = weaponId(modeKey)
  const spec = parseShots(weapon.shots)
  const key = feedKey(weapon, spec, !!states[modeId]?.separate)
  return { key, id: weaponId(key), modeKey, modeId, spec }
}

/**
 * The feed's state: its own entry once written, else the merged per-usage entries of the usages
 * sharing it (older data), else nothing (full, no settings).
 */
function feedState(actor: AmmoActor, feed: FeedInfo): { state: WeaponAmmoState; legacyIds: string[]; modes: number } {
  const states = weaponStates(actor)
  const members = rangedWeapons(actor)
    .map(e => feedInfo(states, e.value))
    .filter(info => info.id === feed.id)
  const legacyIds = [...new Set(members.map(m => m.modeId))].filter(id => id !== feed.id && !!states[id])
  const modes = Math.max(1, members.length)
  const own = states[feed.id]
  if (own) return { state: own, legacyIds, modes }
  if (!legacyIds.length) return { state: {}, legacyIds, modes }
  return { state: mergeLegacyStates(legacyIds.map(id => states[id])), legacyIds, modes }
}

export function viewOf(actor: AmmoActor, path: string, weapon: RangedLike): WeaponView {
  const feed = feedInfo(weaponStates(actor), weapon)
  const { state, legacyIds, modes } = feedState(actor, feed)
  const shared = feed.key !== feed.modeKey
  return {
    path,
    weapon,
    ...feed,
    state,
    legacyIds,
    modes,
    label: shared && modes > 1 ? gunName(weapon) || weaponLabel(weapon) : weaponLabel(weapon),
    loaded: currentLoaded(state, feed.spec, pendingSpent(actor, feed.id)),
  }
}

export function rangedWeapons(actor: AmmoActor): FlatEntry<RangedLike>[] {
  return flattenList(actor.system?.ranged, 'system.ranged.')
}

export function weaponViews(actor: AmmoActor): WeaponView[] {
  return rangedWeapons(actor).map(({ path, value }) => viewOf(actor, path, value))
}

/** One view per feed (the first usage of each), for listings. */
export function feedViews(actor: AmmoActor): WeaponView[] {
  const seen = new Set<string>()
  return weaponViews(actor).filter(v => (seen.has(v.id) ? false : (seen.add(v.id), true)))
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

export interface StateWrite {
  /** Fields to set on the feed's entry. */
  data?: WeaponAmmoState
  /** Replace the partial magazine list. */
  partials?: PartialMagazine[]
}

/** The update for a feed write: carries a merged legacy state over, and drops the per-usage entries it replaces. */
export function stateUpdate(actor: AmmoActor, view: Pick<WeaponView, 'id' | 'key'>, write: StateWrite) {
  const fresh = findViewById(actor, view.id)
  const legacyIds = fresh?.legacyIds ?? []
  const base: WeaponAmmoState = legacyIds.length && !weaponStates(actor)[view.id] ? { ...fresh!.state } : {}
  const update: Record<string, unknown> = { [`${FLAG_PATH}.${view.id}.key`]: view.key }
  for (const [field, value] of Object.entries({ ...base, ...(write.data ?? {}) }))
    if (field !== 'key') update[`${FLAG_PATH}.${view.id}.${field}`] = value
  for (const id of legacyIds) update[`${FLAG_PATH}.-=${id}`] = null
  if (write.partials) update[PARTIALS_PATH] = write.partials
  return update
}

export async function writeState(actor: AmmoActor, view: Pick<WeaponView, 'id' | 'key'>, data: WeaponAmmoState) {
  return actor.update(stateUpdate(actor, view, { data }))
}

/** Subtract rounds fired. Reads the stored value when the update runs, never goes below 0. */
export function spendRounds(actor: AmmoActor, view: WeaponView, shots: number): Promise<unknown> {
  return enqueue(actor, view.id, shots, async () => {
    const state = (findViewById(actor, view.id) ?? view).state
    const loaded = Math.max(0, currentLoaded(state, view.spec) - shots)
    await writeState(actor, view, { loaded })
    return loaded
  })
}
