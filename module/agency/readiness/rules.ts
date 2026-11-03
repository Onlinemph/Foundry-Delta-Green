/**
 * Weapon readiness rules (B194 Fast-Draw, B366 Ready, B383). Pure functions: no Foundry globals,
 * so jest exercises them directly (test/agency/readiness-rules.test.ts).
 *
 * A "physical weapon" is one piece of equipment: every melee and ranged entry that comes from it
 * (a rifle's shots and its butt stroke, a knife's thrust and throw) shares one readiness state.
 * Entries that don't come from equipment (Punch, Kick, Bite, claws, a martial arts technique) are
 * always ready and never shown.
 */
import { gunslingerHalvedPenalty, guessWeaponClass, type WeaponClass } from '../shooting/engine.ts'

export type ReadyState = 'ready' | 'holstered' | 'slung' | 'stowed' | 'dropped'

/** Click order on the sheet icon. */
export const READY_STATES: readonly ReadyState[] = ['ready', 'holstered', 'slung', 'stowed', 'dropped']

export type FastDrawSpecialty = 'Pistol' | 'Long Arm' | 'Knife' | 'Sword' | 'Two-Handed Sword' | 'Force Sword' | 'Ammo'

/** Specialties a weapon can be drawn with (Ammo is for reloads). */
export const WEAPON_SPECIALTIES: readonly FastDrawSpecialty[] = [
  'Pistol',
  'Long Arm',
  'Knife',
  'Sword',
  'Two-Handed Sword',
  'Force Sword',
]

/** Per-weapon data in flags.gurps.agency.readiness.weapons.<id>. */
export interface WeaponReadiness {
  /** Human-readable key the id was hashed from. */
  key?: string
  /** Absent: the default carry state. */
  state?: ReadyState
  /** Default carry state set by hand. Absent: guessed (defaultCarryState). */
  carry?: ReadyState
  /** Fast-Draw specialty set by hand; 'none' when it can't be fast-drawn. Absent: guessed. */
  fastDraw?: FastDrawSpecialty | 'none'
}

export function isReadyState(value: unknown): value is ReadyState {
  return typeof value === 'string' && (READY_STATES as readonly string[]).includes(value)
}

const clean = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

/* ---------------------------------------- */
/*  Which entries are equipment weapons     */
/* ---------------------------------------- */

/** The fields of a system.melee / system.ranged entry read here. Data is loose: all optional. */
export interface AttackLike {
  name?: string
  originalName?: string
  mode?: string
  fromItem?: string
  eqtkey?: string
  shots?: unknown
  rof?: unknown
  bulk?: unknown
  rcl?: unknown
  reach?: unknown
  parry?: unknown
  block?: unknown
}

export interface AttackEntry {
  kind: 'melee' | 'ranged'
  /** Data path: system.melee.00001 */
  path: string
  value: AttackLike
}

/** A carried or other equipment entry. */
export interface EquipmentRef {
  path: string
  name: string
  /** Name at import (GCS description); the sheet name may have been edited since. */
  originalName?: string
  /** Foundry item id (Foundry-items mode). */
  itemid?: string
}

/** "Glock 17 - Shooting" (Foundry-items mode child) -> "Glock 17". */
function baseName(weapon: AttackLike): string {
  const name = clean(weapon.name)
  const mode = clean(weapon.mode)
  const suffix = mode ? ` - ${mode}` : ''
  return suffix && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length).trim() : name
}

/**
 * The equipment an attack entry comes from, or undefined for natural attacks and attacks from
 * traits, skills and spells.
 *
 * - Foundry-items mode: the entry's fromItem is its parent item's id; a parent that isn't an
 *   equipment entry (a trait such as Natural Attacks) means it is not an equipment weapon.
 * - Equipment additions (items mode off): eqtkey is the equipment's data path.
 * - GCS / GCA import: the entry is named after the item it comes from (GCS: the equipment's
 *   description, which is also the equipment's name), so the names match. Traits, skills and
 *   natural attacks have no equipment of that name.
 */
export function matchEquipment(weapon: AttackLike, equipment: EquipmentRef[]): EquipmentRef | undefined {
  const fromItem = clean(weapon.fromItem)
  if (fromItem) return equipment.find(e => !!e.itemid && e.itemid === fromItem)

  const eqtkey = clean(weapon.eqtkey)
  if (eqtkey) {
    const byPath = equipment.find(e => e.path === eqtkey)
    if (byPath) return byPath
  }

  const names = [baseName(weapon), clean(weapon.originalName), clean(weapon.name)].map(normalize).filter(Boolean)
  for (const name of names) {
    const hit = equipment.find(e => normalize(e.name) === name || normalize(clean(e.originalName)) === name)
    if (hit) return hit
  }
  return undefined
}

/** One piece of equipment and every attack entry that comes from it. */
export interface PhysicalWeapon {
  /** 'eqt:<equipment name>' */
  key: string
  /** Flag-safe id (hash of key). */
  id: string
  /** Equipment name, for display and chat commands. */
  name: string
  equipmentPath: string
  entries: AttackEntry[]
}

/** Flag-safe id: names hold dots ("S&W .38"), which Foundry would expand into nested objects. */
export function readinessId(key: string): string {
  // FNV-1a, 32 bit
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `r${(hash >>> 0).toString(36)}`
}

/** Group attack entries by the equipment they come from. Entries with no equipment are left out. */
export function physicalWeapons(entries: AttackEntry[], equipment: EquipmentRef[]): PhysicalWeapon[] {
  const byKey = new Map<string, PhysicalWeapon>()
  for (const entry of entries) {
    const eqt = matchEquipment(entry.value, equipment)
    if (!eqt) continue
    const key = `eqt:${normalize(clean(eqt.originalName) || eqt.name)}`
    let weapon = byKey.get(key)
    if (!weapon) {
      weapon = { key, id: readinessId(key), name: eqt.name, equipmentPath: eqt.path, entries: [] }
      byKey.set(key, weapon)
    }
    weapon.entries.push(entry)
  }
  return [...byKey.values()]
}

/** The physical weapon an attack entry belongs to (by data path, else by object identity). */
export function weaponForEntry(
  weapons: PhysicalWeapon[],
  entry: { path?: string; value?: unknown }
): PhysicalWeapon | undefined {
  return weapons.find(w => w.entries.some(e => (entry.path && e.path === entry.path) || e.value === entry.value))
}

/* ---------------------------------------- */
/*  What kind of weapon                     */
/* ---------------------------------------- */

const isThrownShots = (shots: unknown): boolean => /^\s*t\b/i.test(clean(shots))
const BOW = /\b(?:long|short|cross|compound|composite|self|recurve)?bows?\b/i
const FORCE_SWORD = /\b(force ?sword|light ?saber|beam ?sword|plasma ?sword|blaster ?sword)\b/i
const TWO_HANDED_SWORD = /\b(great ?sword|two[- ]handed sword|claymore|zweih[aä]nder|flamberge|no-?dachi|o-?dachi)\b/i
const SWORD =
  /\b(sword|sabre|saber|rapier|cutlass|scimitar|katana|wakizashi|machete|falchion|gladius|spatha|estoc|[eé]p[eé]e|foil|tulwar|shamshir|jian|kopis|khopesh|broadsword|shortsword|longsword|smallsword)s?\b/i
const KNIFE =
  /\b(knife|knives|dagger|dirk|stiletto|bayonet|kukri|kris|tanto|switchblade|bowie|shiv|main[- ]gauche|karambit|kerambit|balisong|sai|kunai)\b/i

function numbers(text: unknown): number[] {
  return (clean(text).match(/\d+/g) ?? []).map(Number)
}

/** A gun (or other shooter): a ranged entry that isn't thrown and isn't a bow. */
function gunEntry(weapon: PhysicalWeapon): AttackLike | undefined {
  return weapon.entries.find(e => e.kind === 'ranged' && !isThrownShots(e.value.shots) && !BOW.test(weaponText(weapon)))
    ?.value
}

function weaponText(weapon: PhysicalWeapon): string {
  return [weapon.name, ...weapon.entries.map(e => clean(e.value.name))].join(' ')
}

/** Gun class: what the user picked in the fire dialog, else a guess from Bulk, RoF and name. */
export function gunClass(weapon: PhysicalWeapon, override?: WeaponClass | ''): WeaponClass | null {
  const gun = gunEntry(weapon)
  if (!gun) return null
  if (override === 'pistol' || override === 'autopistol' || override === 'longarm') return override
  return guessWeaponClass({ name: weapon.name || gun.name, bulk: gun.bulk, rof: gun.rof })
}

/** Blocks: only shields (and cloaks) have a Block value. */
function isShield(weapon: PhysicalWeapon): boolean {
  return weapon.entries.some(e => e.kind === 'melee' && numbers(e.value.block).some(n => n > 0))
}

/**
 * The Fast-Draw specialty that readies this weapon (B194), or null when none does (an axe, a club,
 * a shield, a bow: those take a Ready maneuver).
 */
export function fastDrawSpecialty(
  weapon: PhysicalWeapon,
  override?: WeaponReadiness['fastDraw'],
  classOverride?: WeaponClass | ''
): FastDrawSpecialty | null {
  if (override === 'none') return null
  if (override && (WEAPON_SPECIALTIES as readonly string[]).includes(override)) return override
  const cls = gunClass(weapon, classOverride)
  if (cls) return cls === 'longarm' ? 'Long Arm' : 'Pistol'
  const text = weaponText(weapon)
  if (BOW.test(text)) return null
  if (FORCE_SWORD.test(text)) return 'Force Sword'
  if (TWO_HANDED_SWORD.test(text)) return 'Two-Handed Sword'
  if (SWORD.test(text)) return 'Sword'
  if (KNIFE.test(text)) return 'Knife'
  return null
}

/**
 * How the weapon is carried when not in hand. Pistols, knives and one-handed weapons: holstered (or
 * sheathed); long arms, bows, two-handed swords and long weapons (reach 2+): slung; shields: ready
 * (strapped on).
 */
export function defaultCarryState(
  weapon: PhysicalWeapon,
  override?: ReadyState,
  classOverride?: WeaponClass | ''
): ReadyState {
  if (override && isReadyState(override) && override !== 'dropped') return override
  if (isShield(weapon)) return 'ready'
  const cls = gunClass(weapon, classOverride)
  if (cls) return cls === 'longarm' ? 'slung' : 'holstered'
  const text = weaponText(weapon)
  if (BOW.test(text) || TWO_HANDED_SWORD.test(text)) return 'slung'
  const reach = Math.max(0, ...weapon.entries.filter(e => e.kind === 'melee').flatMap(e => numbers(e.value.reach)))
  if (reach >= 2) return 'slung'
  return 'holstered'
}

/** Current state: stored, else the default carry state. */
export function currentState(stored: WeaponReadiness | undefined, carry: ReadyState): ReadyState {
  return isReadyState(stored?.state) ? stored!.state! : carry
}

/** Next state for a click on the sheet icon. */
export function nextState(state: ReadyState): ReadyState {
  const index = READY_STATES.indexOf(state)
  return READY_STATES[(index + 1) % READY_STATES.length]
}

/** Where /holster puts a weapon: its carry state (a shield, carried ready, goes on the back). */
export function holsterState(carry: ReadyState): ReadyState {
  return carry === 'ready' || carry === 'dropped' ? 'slung' : carry
}

/* ---------------------------------------- */
/*  Attacking with an unready weapon        */
/* ---------------------------------------- */

/** Fast-Draw works from a holster, sheath, scabbard or sling, not from a pack or the floor (B194). */
export function canFastDrawFrom(state: ReadyState): boolean {
  return state === 'holstered' || state === 'slung'
}

export type AttackGate = 'proceed' | 'auto-ready' | 'prompt'

/** What an attack with this weapon needs: nothing, a silent "ready it" (out of combat), or the Ready / Fast-Draw choice. */
export function attackGate(state: ReadyState, inCombat: boolean): AttackGate {
  if (state === 'ready') return 'proceed'
  return inCombat ? 'prompt' : 'auto-ready'
}

export interface SkillLike {
  name?: string
  level?: unknown
}

export interface FoundSkill {
  name: string
  level: number
}

const SPECIALTY_PATTERN: Record<FastDrawSpecialty, string> = {
  Pistol: 'pistol',
  'Long Arm': 'long[\\s-]?arm',
  Knife: 'knife',
  Sword: 'sword',
  'Two-Handed Sword': 'two[\\s-]?handed[\\s-]?sword',
  'Force Sword': 'force[\\s-]?sword',
  Ammo: 'ammo',
}

/**
 * The actor's Fast-Draw skill for a specialty ("Fast-Draw (Pistol)", "Fast Draw/TL8 (Ammo)"), the
 * best one if listed twice. Fast-Draw has no default (B194): without the skill there is no roll.
 */
export function findFastDrawSkill(skills: SkillLike[], specialty: FastDrawSpecialty): FoundSkill | null {
  const pattern = new RegExp(
    `^fast[\\s-]?draw(?:\\s*/\\s*tl\\s*\\d+)?\\s*\\(\\s*${SPECIALTY_PATTERN[specialty]}\\s*\\)`,
    'i'
  )
  let best: FoundSkill | null = null
  for (const skill of skills) {
    const name = clean(skill.name)
    const level = parseInt(clean(skill.level), 10)
    if (!pattern.test(name) || !Number.isFinite(level) || level <= 0) continue
    if (!best || level > best.level) best = { name, level }
  }
  return best
}

/** Specialties Gunslinger's halving applies to. */
export function gunslingerApplies(specialty: FastDrawSpecialty): boolean {
  return specialty === 'Pistol' || specialty === 'Long Arm' || specialty === 'Ammo'
}

/**
 * The modifier a Fast-Draw roll gets for a situational penalty (a concealed holster, a cramped car).
 * Gunslinger halves Fast-Draw penalties, rounding in the shooter's favour; bonuses stay as they are.
 */
export function fastDrawModifier(modifier: number, gunslinger: boolean): number {
  const mod = Number.isFinite(modifier) ? Math.trunc(modifier) : 0
  return gunslinger && mod < 0 ? gunslingerHalvedPenalty(mod) : mod
}

export type FastDrawOutcome = 'success' | 'failure' | 'critical-failure'

export function fastDrawOutcome(result: { failure: boolean; isCritFailure?: boolean }): FastDrawOutcome {
  if (result.isCritFailure) return 'critical-failure'
  return result.failure ? 'failure' : 'success'
}

export interface FastDrawEffect {
  /** The weapon's state afterwards. */
  state: ReadyState
  /** The attack goes ahead now. */
  attack: boolean
  /** The turn went on readying (a Ready maneuver). */
  turnSpent: boolean
}

/**
 * B194: success readies the weapon instantly (the attack goes ahead); failure readies it, but that
 * takes the turn (a Ready maneuver); critical failure drops it (the turn is gone as well).
 */
export function fastDrawEffect(outcome: FastDrawOutcome): FastDrawEffect {
  if (outcome === 'success') return { state: 'ready', attack: true, turnSpent: false }
  if (outcome === 'failure') return { state: 'ready', attack: false, turnSpent: true }
  return { state: 'dropped', attack: false, turnSpent: true }
}

/**
 * B194 Fast-Draw (Ammo): success takes a second off the reload (not below zero); a critical failure
 * drops the magazine or rounds being loaded, so the reload doesn't happen.
 */
export function ammoFastDrawEffect(outcome: FastDrawOutcome): { secondsSaved: number; reload: boolean } {
  if (outcome === 'success') return { secondsSaved: 1, reload: true }
  if (outcome === 'failure') return { secondsSaved: 0, reload: true }
  return { secondsSaved: 0, reload: false }
}

/* ---------------------------------------- */
/*  Combat start, defenses                  */
/* ---------------------------------------- */

export type CombatStartMode = 'keep' | 'carry'

/** State changes at combat start: none ('keep'), or every weapon back to its carry state. */
export function combatStartChanges(
  weapons: { id: string; state: ReadyState; carry: ReadyState }[],
  mode: CombatStartMode
): Record<string, ReadyState> {
  const changes: Record<string, ReadyState> = {}
  if (mode !== 'carry') return changes
  for (const weapon of weapons) if (weapon.state !== weapon.carry) changes[weapon.id] = weapon.carry
  return changes
}

/** "Broadsword (Swung)": how the defense feature names a parry (see listDefenseWeapons). */
export function attackLabel(weapon: AttackLike): string {
  const name = clean(weapon.name)
  const mode = clean(weapon.mode)
  return mode ? `${name} (${mode})` : name
}

/**
 * Parry choices the defender can use: a weapon's parry needs it ready; parries from entries that
 * aren't equipment (Karate, Brawling, a Punch) are always there.
 */
export function readyParries<T extends { name: string }>(
  parries: T[],
  melee: AttackEntry[],
  weapons: PhysicalWeapon[],
  stateOf: (weapon: PhysicalWeapon) => ReadyState
): T[] {
  return parries.filter(parry => {
    const entries = melee.filter(e => attackLabel(e.value) === parry.name)
    if (!entries.length) return true
    // Usable if any entry with this label is unarmed or comes from a ready weapon.
    return entries.some(entry => {
      const weapon = weaponForEntry(weapons, entry)
      return !weapon || stateOf(weapon) === 'ready'
    })
  })
}
