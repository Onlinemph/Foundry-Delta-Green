/**
 * Ammunition bookkeeping that doesn't need Foundry: weapon keys, firing and reload plans,
 * and finding the equipment a reload draws from. The Foundry glue lives in state.ts,
 * firing.ts, reload.ts and sheet.ts.
 */
import { fullLoad, isTracked, type ShotsSpec } from './shots.ts'

/** The fields of a system.ranged entry this feature reads. Everything is optional: data is loose. */
export interface RangedLike {
  name?: string
  originalName?: string
  mode?: string
  uuid?: string
  importid?: string
  shots?: unknown
  rof?: unknown
  ammo?: unknown
  fromItem?: string
  contains?: Record<string, RangedLike>
  collapsed?: Record<string, RangedLike>
}

export interface EquipmentLike {
  name?: string
  count?: unknown
  itemid?: string
  contains?: Record<string, EquipmentLike>
  collapsed?: Record<string, EquipmentLike>
}

/** How the ammunition item is counted: one magazine per reload, or loose rounds. */
export type AmmoUnit = 'magazines' | 'rounds'

/** Per-weapon state in flags.gurps.agency.firearms.weapons.<id>. */
export interface WeaponAmmoState {
  /** Human-readable key the id was hashed from (name|mode or uuid|mode). */
  key?: string
  /** Rounds in the weapon, chamber included. Absent until the weapon is first fired or reloaded. */
  loaded?: number
  /** Equipment name a reload draws from. Blank: use the weapon's Ammo field. */
  ammoItem?: string
  /** How that equipment is counted. Blank: decide from the Shots notation. */
  ammoUnit?: AmmoUnit | ''
}

export type EmptyMode = 'block' | 'warn'

/* ---------------------------------------- */
/*  Weapon identity                         */
/* ---------------------------------------- */

const clean = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())

/**
 * A key that survives a GCS re-import: the GCS uuid / import id when the entry has one,
 * else name + mode (GGA stores GCS "usage" as the mode).
 */
export function weaponKey(weapon: RangedLike): string {
  const mode = clean(weapon.mode)
  const id = clean(weapon.uuid) || clean(weapon.importid)
  if (id) return `uuid:${id}|${mode}`
  return `name:${clean(weapon.name)}|${mode}`
}

/**
 * Flag-safe id for a weapon key. Names hold dots ("S&W .38"), which Foundry would expand into
 * nested objects in an update path, so the flag is keyed by a hash and the key is stored beside it.
 */
export function weaponId(key: string): string {
  // FNV-1a, 32 bit
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `w${(hash >>> 0).toString(36)}`
}

/** "Glock 17 (Shooting)" */
export function weaponLabel(weapon: RangedLike): string {
  const name = clean(weapon.name) || '?'
  const mode = clean(weapon.mode)
  return mode ? `${name} (${mode})` : name
}

/** Is this attack object a ranged weapon (as opposed to a melee entry found by an A: OtF)? */
export function isRangedWeapon(weapon: unknown): weapon is RangedLike {
  if (!weapon || typeof weapon !== 'object') return false
  return 'shots' in weapon || 'rof' in weapon
}

export interface FlatEntry<T> {
  /** Full data path, e.g. system.ranged.00001.contains.00000 */
  path: string
  value: T
}

/** Flatten a GGA list (keyed records with nested contains/collapsed) into path + value pairs. */
export function flattenList<T extends { contains?: Record<string, T>; collapsed?: Record<string, T> }>(
  list: Record<string, T> | undefined | null,
  prefix: string
): FlatEntry<T>[] {
  const result: FlatEntry<T>[] = []
  if (!list || typeof list !== 'object') return result
  for (const [key, value] of Object.entries(list)) {
    if (!value || typeof value !== 'object') continue
    const path = `${prefix}${key}`
    result.push({ path, value })
    result.push(...flattenList(value.contains, `${path}.contains.`))
    result.push(...flattenList(value.collapsed, `${path}.collapsed.`))
  }
  return result
}

/* ---------------------------------------- */
/*  Rounds loaded                           */
/* ---------------------------------------- */

/** Rounds currently loaded: full when the weapon has never been seen, clamped to the weapon's capacity. */
export function currentLoaded(state: WeaponAmmoState | undefined, spec: ShotsSpec, pendingSpent = 0): number {
  const full = fullLoad(spec)
  const stored = typeof state?.loaded === 'number' && Number.isFinite(state.loaded) ? state.loaded : full
  return Math.max(0, Math.min(full, Math.floor(stored) - pendingSpent))
}

/** Shots requested by the attack: optionalArgs.shots when upstream asked for it (RoF > 1), else 1. */
export function requestedShots(shots: unknown): number {
  const value = Math.floor(Number(shots))
  return Number.isFinite(value) && value > 0 ? value : 1
}

export interface FirePlan {
  /** Let the roll go ahead. */
  proceed: boolean
  /** Nothing loaded. */
  empty: boolean
  /** Rounds that will be spent. */
  shots: number
  /** Fewer rounds than requested were left. */
  capped: boolean
}

export function planFire(loaded: number, requested: number, emptyMode: EmptyMode): FirePlan {
  const want = requestedShots(requested)
  if (loaded <= 0) return { proceed: emptyMode === 'warn', empty: true, shots: 0, capped: false }
  if (want > loaded) return { proceed: true, empty: false, shots: loaded, capped: true }
  return { proceed: true, empty: false, shots: want, capped: false }
}

/* ---------------------------------------- */
/*  Reloading                               */
/* ---------------------------------------- */

/** Default unit: loose rounds for weapons loaded a round at a time (or single shots), else magazines. */
export function resolveUnit(configured: AmmoUnit | '' | undefined, spec: ShotsSpec): AmmoUnit {
  if (configured === 'magazines' || configured === 'rounds') return configured
  return spec.individual || spec.capacity <= 1 ? 'rounds' : 'magazines'
}

export type ReloadRefusal = 'untracked' | 'full' | 'no-ammo'

export interface ReloadPlan {
  ok: boolean
  reason?: ReloadRefusal
  /** Rounds in the weapon afterwards. */
  newLoaded: number
  /** Rounds added to the weapon. */
  added: number
  /** Ammo items consumed (magazines or rounds, per `unit`). */
  itemUsed: number
  /** Rounds left behind in a swapped-out magazine. */
  leftInOldMagazine: number
  /** Seconds the reload takes (0 when the Shots notation gives no time). */
  seconds: number
}

/**
 * Work out a reload.
 *
 * Magazine weapons swap in a full magazine; the chambered round survives only if the weapon wasn't
 * fired dry ("17+1": empty -> 17, partly loaded -> 18). Individually loaded weapons take one round
 * per reload. `available` is the ammo item's count, or null when no item is tracked (free reloads).
 */
export function planReload(spec: ShotsSpec, loaded: number, unit: AmmoUnit, available: number | null): ReloadPlan {
  const refuse = (reason: ReloadRefusal): ReloadPlan => ({
    ok: false,
    reason,
    newLoaded: loaded,
    added: 0,
    itemUsed: 0,
    leftInOldMagazine: 0,
    seconds: 0,
  })
  if (!isTracked(spec)) return refuse('untracked')

  const full = fullLoad(spec)
  const current = Math.max(0, Math.min(full, Math.floor(loaded)))
  if (current >= full) return { ...refuse('full'), newLoaded: current }

  const seconds = spec.reloadSeconds

  if (spec.individual) {
    if (available !== null && available < 1) return { ...refuse('no-ammo'), newLoaded: current }
    return {
      ok: true,
      newLoaded: current + 1,
      added: 1,
      itemUsed: available === null ? 0 : 1,
      leftInOldMagazine: 0,
      seconds,
    }
  }

  const target = Math.min(full, spec.capacity + (current > 0 ? spec.chambered : 0))

  if (unit === 'rounds') {
    // Top the weapon up from loose rounds: nothing is lost.
    let added = target - current
    if (available !== null) {
      if (available < 1) return { ...refuse('no-ammo'), newLoaded: current }
      added = Math.min(added, Math.floor(available))
    }
    return {
      ok: true,
      newLoaded: current + added,
      added,
      itemUsed: available === null ? 0 : added,
      leftInOldMagazine: 0,
      seconds,
    }
  }

  // Swap magazines: the old magazine leaves with whatever it still held.
  if (available !== null && available < 1) return { ...refuse('no-ammo'), newLoaded: current }
  const kept = current > 0 ? Math.min(current, spec.chambered) : 0
  return {
    ok: true,
    newLoaded: target,
    added: target - current,
    itemUsed: available === null ? 0 : 1,
    leftInOldMagazine: current - kept,
    seconds,
  }
}

/* ---------------------------------------- */
/*  Ammo items                              */
/* ---------------------------------------- */

export interface EquipmentEntry {
  path: string
  name: string
  count: number
  itemid?: string
}

export function equipmentEntries(
  list: Record<string, EquipmentLike> | undefined | null,
  prefix: string
): EquipmentEntry[] {
  return flattenList(list, prefix).map(({ path, value }) => {
    const count = Number(value.count)
    return {
      path,
      name: clean(value.name),
      count: Number.isFinite(count) ? count : 0,
      itemid: value.itemid,
    }
  })
}

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Best equipment match for an ammo name: exact name, then prefix, then substring (case-insensitive).
 * Within a tier, an entry with some left beats an empty one, then list order wins.
 */
export function findAmmoItem(entries: EquipmentEntry[], name: string): EquipmentEntry | undefined {
  const wanted = normalize(name)
  if (!wanted) return undefined
  const tiers = [(n: string) => n === wanted, (n: string) => n.startsWith(wanted), (n: string) => n.includes(wanted)]
  for (const test of tiers) {
    const hits = entries.filter(e => test(normalize(e.name)))
    if (hits.length) return hits.find(e => e.count > 0) ?? hits[0]
  }
  return undefined
}

/** The weapon's own Ammo field as an equipment name. GCS stores 0 there, so numbers are ignored. */
export function ammoFieldName(ammo: unknown): string {
  const text = clean(ammo)
  if (!text || /^[\d.,\s]+$/.test(text)) return ''
  return text
}

/**
 * The equipment a thrown weapon comes from: same item (Foundry-items mode), else the same name.
 * Items-mode ranged entries are named "<item> - <mode>", so the name before " - " is tried too.
 */
export function findThrownItem(entries: EquipmentEntry[], weapon: RangedLike): EquipmentEntry | undefined {
  if (weapon.fromItem) {
    const byItem = entries.find(e => e.itemid && e.itemid === weapon.fromItem)
    if (byItem) return byItem
  }
  const names = [clean(weapon.originalName), clean(weapon.name), clean(weapon.name).split(' - ')[0]]
    .map(normalize)
    .filter(Boolean)
  for (const name of names) {
    const hit = entries.find(e => normalize(e.name) === name)
    if (hit) return hit
  }
  return undefined
}

/* ---------------------------------------- */
/*  Weapon lookup by name (chat commands)   */
/* ---------------------------------------- */

/** Weapons whose "name (mode)" or name matches the query: exact first, then prefix, then substring. */
export function matchWeapons<T extends RangedLike>(weapons: FlatEntry<T>[], query: string): FlatEntry<T>[] {
  const wanted = normalize(query)
  if (!wanted) return []
  const labels = (w: RangedLike) => [normalize(weaponLabel(w)), normalize(clean(w.name))]
  const tiers = [(l: string) => l === wanted, (l: string) => l.startsWith(wanted), (l: string) => l.includes(wanted)]
  for (const test of tiers) {
    const hits = weapons.filter(w => labels(w.value).some(test))
    if (hits.length) return hits
  }
  return []
}
