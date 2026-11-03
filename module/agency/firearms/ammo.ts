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

/**
 * Per-feed state in flags.gurps.agency.firearms.weapons.<id>. A feed is one physical magazine: all the
 * usages of a gun (same name, same Shots) share it; a usage marked `separate` keeps its own.
 */
export interface WeaponAmmoState {
  /** Human-readable key the id was hashed from (gun:name|shots, or name|mode / uuid|mode for a separate usage). */
  key?: string
  /** Rounds in the weapon, chamber included. Absent until the weapon is first fired or reloaded. */
  loaded?: number
  /** Equipment names a reload draws from, in order of preference. Empty: use the weapon's Ammo field. */
  ammoItems?: string[]
  /** Older single-item form of ammoItems (read, never written). */
  ammoItem?: string
  /** How that equipment is counted. Blank: decide from the Shots notation. */
  ammoUnit?: AmmoUnit | ''
  /** Name of the magazine (or ammo item) loaded now: shown in the badge tooltip, kept on a partial when ejected. */
  magazine?: string
  /** This usage has a feed of its own (e.g. an underbarrel launcher sharing the gun's name). */
  separate?: boolean
}

/**
 * A magazine ejected with rounds left, kept in flags.gurps.agency.firearms.partials until it is
 * loaded again. Foundry-side only: the equipment list never sees it.
 */
export interface PartialMagazine {
  id: string
  /** Equipment name the magazine came from ("Glock 17 Magazine"). */
  item: string
  rounds: number
  /** Capacity of the magazine (the Shots count of the gun it came out of). */
  capacity: number
  /** Feed id it was ejected from: listed for that gun even if the item name stops matching. */
  feed: string
}

export type EmptyMode = 'block' | 'warn'

/* ---------------------------------------- */
/*  Weapon identity                         */
/* ---------------------------------------- */

const clean = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

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

/**
 * The gun a ranged entry belongs to. Foundry-items mode names entries "<item> - <usage>", so the
 * usage suffix is dropped; GCS imports already use the item name.
 */
export function gunName(weapon: RangedLike): string {
  const name = clean(weapon.name)
  const mode = clean(weapon.mode)
  const suffix = mode ? ` - ${mode}` : ''
  return suffix && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length).trim() : name
}

/** What a magazine must match to fit: capacity, chamber and loading style ("17+1", "6i"). */
export function shotsSignature(spec: ShotsSpec): string {
  return `${spec.capacity}+${spec.chambered}${spec.individual ? 'i' : ''}`
}

/**
 * The feed (magazine) a usage draws from. Usages of the same gun with the same Shots share one;
 * a usage marked separate, or with nothing to count, keeps its own per-usage key.
 */
export function feedKey(weapon: RangedLike, spec: ShotsSpec, separate = false): string {
  if (separate || !isTracked(spec)) return weaponKey(weapon)
  return `gun:${normalize(gunName(weapon))}|${shotsSignature(spec)}`
}

/** Configured ammo names, new list first, then the older single item; trimmed, without duplicates. */
export function configuredAmmoNames(state: WeaponAmmoState | undefined): string[] {
  const names = [...(Array.isArray(state?.ammoItems) ? state!.ammoItems : []), state?.ammoItem ?? '']
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = clean(raw)
    if (!name || seen.has(normalize(name))) continue
    seen.add(normalize(name))
    result.push(name)
  }
  return result
}

/**
 * One state from the per-usage states kept before usages shared a magazine. Rounds: the lowest
 * count (rounds fired in any usage came out of the one magazine, so never invent rounds);
 * ammo items: all of them, in order; unit and magazine: the first one set.
 */
export function mergeLegacyStates(states: WeaponAmmoState[]): WeaponAmmoState {
  const merged: WeaponAmmoState = {}
  const counts = states.map(s => s.loaded).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (counts.length) merged.loaded = Math.min(...counts)
  const items = configuredAmmoNames({ ammoItems: states.flatMap(s => configuredAmmoNames(s)) })
  if (items.length) merged.ammoItems = items
  const unit = states.find(s => s.ammoUnit)?.ammoUnit
  if (unit) merged.ammoUnit = unit
  const magazine = states.find(s => clean(s.magazine))?.magazine
  if (magazine) merged.magazine = magazine
  return merged
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

export interface MagazineSwap {
  /** Rounds in the weapon afterwards. */
  newLoaded: number
  /** Rounds that stay in the chamber. */
  kept: number
  /** Rounds that leave in the old magazine. */
  ejected: number
}

/**
 * Swap magazines: the old one leaves with what it still holds, a round already chambered stays
 * ("17+1": 5 loaded, swap in a 17-round magazine -> 18; fired dry -> 17).
 */
export function planMagazineSwap(spec: ShotsSpec, loaded: number, incoming: number): MagazineSwap {
  const full = fullLoad(spec)
  const current = Math.max(0, Math.min(full, Math.floor(loaded)))
  const kept = current > 0 ? Math.min(current, spec.chambered) : 0
  const rounds = Math.max(0, Math.floor(incoming))
  return { newLoaded: Math.min(full, kept + rounds), kept, ejected: current - kept }
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

/** Every equipment entry in the best matching tier for an ammo name (see findAmmoItem), list order. */
export function findAmmoItems(entries: EquipmentEntry[], name: string): EquipmentEntry[] {
  const wanted = normalize(name)
  if (!wanted) return []
  const tiers = [(n: string) => n === wanted, (n: string) => n.startsWith(wanted), (n: string) => n.includes(wanted)]
  for (const test of tiers) {
    const hits = entries.filter(e => test(normalize(e.name)))
    if (hits.length) return hits
  }
  return []
}

/** Is an item name one of the wanted ammo names (case-insensitive; the wanted name may be the start of it or inside it)? */
export function ammoNameMatches(itemName: string, wanted: string[]): boolean {
  const item = normalize(itemName)
  if (!item) return false
  return wanted.map(normalize).some(w => !!w && (item === w || item.includes(w)))
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

/* ---------------------------------------- */
/*  Changing magazines                      */
/* ---------------------------------------- */

/** One line of the change-magazine dialog. */
export interface MagazineChoice {
  /** Stable within one listing: 'item:<path>' or 'partial:<item>|<rounds>'. */
  id: string
  kind: 'item' | 'partial'
  /** Equipment name. */
  name: string
  /** Rounds this choice puts in the weapon: a full magazine, the rounds left in a partial, or loose rounds carried. */
  rounds: number
  /** Magazine capacity (for "12/17"). */
  capacity: number
  /** How many of these there are: the item's count, or partials holding the same rounds. */
  count: number
  /** Equipment path (items). */
  path?: string
  /** Ids of the partial records with this item and rounds (partials). */
  partialIds?: string[]
  /** This is what is loaded now (same item name). */
  current: boolean
}

export interface ChoiceInput {
  spec: ShotsSpec
  unit: AmmoUnit
  feedId: string
  /** Configured names, then the Ammo field's name. */
  names: string[]
  /** Carried equipment. */
  carried: EquipmentEntry[]
  partials: PartialMagazine[]
  /** Name of the magazine loaded now. */
  magazine?: string
}

/**
 * What the change-magazine dialog offers: carried items for each configured name and the Ammo field
 * (every match of the best tier, so "9mm" lists both the 17- and 33-round magazines), then partial
 * magazines for this gun, fullest first. Loose-round weapons get no partials.
 */
export function magazineChoices(input: ChoiceInput): MagazineChoice[] {
  const { spec, unit, names, carried } = input
  const capacity = spec.capacity
  const current = normalize(input.magazine ?? '')
  const result: MagazineChoice[] = []
  const seen = new Set<string>()

  for (const name of names) {
    for (const entry of findAmmoItems(carried, name)) {
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      const count = Math.max(0, Math.floor(entry.count))
      result.push({
        id: `item:${entry.path}`,
        kind: 'item',
        name: entry.name,
        rounds: unit === 'rounds' ? count : capacity,
        capacity,
        count,
        path: entry.path,
        current: !!current && normalize(entry.name) === current,
      })
    }
  }

  if (unit === 'magazines') {
    const itemNames = [...names, ...result.map(r => r.name)]
    const groups = new Map<string, MagazineChoice>()
    for (const partial of input.partials) {
      if (!(partial.rounds > 0)) continue
      if (partial.feed !== input.feedId && !ammoNameMatches(partial.item, itemNames)) continue
      const id = `partial:${normalize(partial.item)}|${partial.rounds}`
      const group = groups.get(id)
      if (group) {
        group.count++
        group.partialIds!.push(partial.id)
        continue
      }
      groups.set(id, {
        id,
        kind: 'partial',
        name: partial.item,
        rounds: partial.rounds,
        capacity: partial.capacity || capacity,
        count: 1,
        partialIds: [partial.id],
        current: false,
      })
    }
    result.push(...[...groups.values()].sort((a, b) => b.rounds - a.rounds))
  }
  return result
}

/** A choice that can be loaded now: something left, and (partials) more rounds than the magazine being ejected. */
export function canLoadChoice(choice: MagazineChoice): boolean {
  return choice.count > 0 && choice.rounds > 0
}

/**
 * The quick reload's pick: the first item with a full magazine left; failing that the fullest partial
 * that holds more than is left in the magazine being ejected. Undefined: nothing worth loading.
 */
export function quickReloadChoice(
  choices: MagazineChoice[],
  spec: ShotsSpec,
  loaded: number
): MagazineChoice | undefined {
  const item = choices.find(c => c.kind === 'item' && c.count > 0)
  if (item) return item
  const inMagazine = planMagazineSwap(spec, loaded, 0).ejected
  return choices.filter(c => c.kind === 'partial' && c.count > 0).find(c => c.rounds > inMagazine)
}

/** A partial record id that won't collide with the ones already kept. */
export function newPartialId(existing: PartialMagazine[], seed: number): string {
  const taken = new Set(existing.map(p => p.id))
  let n = Math.abs(Math.floor(seed)) % 1_000_000_000
  let id = `p${n.toString(36)}`
  while (taken.has(id)) id = `p${(++n).toString(36)}`
  return id
}

export type LoadRefusal = 'untracked' | 'full' | 'no-ammo' | 'gone'

export interface LoadPlan {
  ok: boolean
  reason?: LoadRefusal
  /** What goes in. Undefined (with ok) for a free reload: no ammo item is tracked for the weapon. */
  choice?: MagazineChoice
  /** Rounds in the weapon afterwards. */
  newLoaded: number
  /** Equipment used up (items only: a magazine, or loose rounds). */
  itemUsed: number
  /** Rounds leaving in the old magazine (magazine swaps). */
  ejected: number
  /** Seconds the reload takes (0 when the Shots notation gives no time). */
  seconds: number
}

export interface LoadInput {
  spec: ShotsSpec
  unit: AmmoUnit
  loaded: number
  choices: MagazineChoice[]
  /** Some ammo item is configured or named in the Ammo field (else reloads are free). */
  tracked: boolean
  /** A choice picked in the change-magazine dialog; omitted for a quick reload. */
  choiceId?: string
}

/**
 * Plan a reload. A quick reload loads the first item with something left (a partial only when no full
 * magazine is left) and refuses a full weapon; a pick from the change-magazine dialog loads exactly that,
 * even into a full weapon (swapping one kind of magazine for another). Magazine weapons swap magazines
 * (planMagazineSwap); loose-round and individually loaded weapons top up as planReload does.
 */
export function planLoad(input: LoadInput): LoadPlan {
  const { spec, unit, choices } = input
  const loaded = Math.max(0, Math.min(fullLoad(spec), Math.floor(input.loaded)))
  const refuse = (reason: LoadRefusal): LoadPlan => ({
    ok: false,
    reason,
    newLoaded: loaded,
    itemUsed: 0,
    ejected: 0,
    seconds: 0,
  })
  if (!isTracked(spec)) return refuse('untracked')

  const explicit = input.choiceId !== undefined
  const swapsMagazines = unit === 'magazines' && !spec.individual
  if (!explicit && loaded >= fullLoad(spec)) return refuse('full')

  let choice: MagazineChoice | undefined
  if (explicit) {
    choice = choices.find(c => c.id === input.choiceId)
    if (!choice || !canLoadChoice(choice)) return refuse('gone')
  } else if (input.tracked) {
    choice = swapsMagazines
      ? quickReloadChoice(choices, spec, loaded)
      : choices.find(c => c.kind === 'item' && c.count > 0)
    if (!choice) return refuse('no-ammo')
  }

  if (swapsMagazines) {
    const swap = planMagazineSwap(spec, loaded, choice ? choice.rounds : spec.capacity)
    return {
      ok: true,
      choice,
      newLoaded: swap.newLoaded,
      itemUsed: choice?.kind === 'item' ? 1 : 0,
      ejected: swap.ejected,
      seconds: spec.reloadSeconds,
    }
  }

  const reload = planReload(spec, loaded, unit, choice ? choice.count : null)
  if (!reload.ok)
    return refuse(reload.reason === 'no-ammo' ? 'no-ammo' : reload.reason === 'full' ? 'full' : 'untracked')
  return {
    ok: true,
    choice,
    newLoaded: reload.newLoaded,
    itemUsed: reload.itemUsed,
    ejected: 0,
    seconds: reload.seconds,
  }
}
