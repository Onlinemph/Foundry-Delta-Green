/**
 * Per-actor readiness in flags.gurps.agency.readiness.weapons.<id> (see WeaponReadiness). Flags
 * survive a GCS re-import; the weapon id is a hash of the equipment name, so it survives too.
 */
import { flattenList, weaponId, weaponKey } from '../firearms/ammo.ts'
import { getAgencySetting } from '../settings.ts'
import type { WeaponClass } from '../shooting/engine.ts'
import {
  currentState,
  defaultCarryState,
  fastDrawSpecialty,
  physicalWeapons,
  weaponForEntry,
  type AttackEntry,
  type AttackLike,
  type CombatStartMode,
  type EquipmentRef,
  type FastDrawSpecialty,
  type PhysicalWeapon,
  type ReadyState,
  type WeaponReadiness,
} from './rules.ts'

export const L10N = 'GURPS.agency.readiness'
export const SETTING_ENABLED = 'readiness'
export const SETTING_COMBAT_START = 'readiness-combat-start'
const FLAG_PATH = 'flags.gurps.agency.readiness.weapons'

/** The slice of a GurpsActor this feature touches. */
export interface ReadinessActor {
  id: string | null
  uuid?: string
  name: string | null
  isOwner?: boolean
  isToken?: boolean
  flags?: Record<string, any>
  system?: Record<string, any>
  update(data: Record<string, unknown>, context?: Record<string, unknown>): Promise<unknown>
}

export function asReadinessActor(candidate: unknown): ReadinessActor | undefined {
  const actor = candidate as ReadinessActor | undefined
  if (!actor || typeof actor !== 'object') return undefined
  if (typeof actor.update !== 'function' || !actor.system || typeof actor.system !== 'object') return undefined
  return actor
}

export function readinessEnabled(): boolean {
  try {
    return getAgencySetting<boolean>(SETTING_ENABLED) !== false
  } catch {
    return false
  }
}

export function combatStartMode(): CombatStartMode {
  try {
    return getAgencySetting<string>(SETTING_COMBAT_START) === 'carry' ? 'carry' : 'keep'
  } catch {
    return 'keep'
  }
}

/* ---------------------------------------- */
/*  Reading                                 */
/* ---------------------------------------- */

export function attackEntries(actor: ReadinessActor): AttackEntry[] {
  const melee = flattenList<any>(actor.system?.melee, 'system.melee.').map(e => ({ kind: 'melee' as const, ...e }))
  const ranged = flattenList<any>(actor.system?.ranged, 'system.ranged.').map(e => ({ kind: 'ranged' as const, ...e }))
  return [...melee, ...ranged]
}

export function equipmentRefs(actor: ReadinessActor): EquipmentRef[] {
  const refs = (list: unknown, prefix: string) =>
    flattenList<any>(list as Record<string, any>, prefix).map(({ path, value }) => ({
      path,
      name: String(value?.name ?? '').trim(),
      originalName: value?.originalName ? String(value.originalName) : undefined,
      itemid: value?.itemid ? String(value.itemid) : undefined,
    }))
  return [
    ...refs(actor.system?.equipment?.carried, 'system.equipment.carried.'),
    ...refs(actor.system?.equipment?.other, 'system.equipment.other.'),
  ]
}

export function storedReadiness(actor: ReadinessActor): Record<string, WeaponReadiness> {
  return actor.flags?.gurps?.agency?.readiness?.weapons ?? {}
}

/** The gun class picked in the shooting fire dialog for this weapon's first ranged entry, if any. */
function shootingClass(actor: ReadinessActor, weapon: PhysicalWeapon): WeaponClass | '' {
  const ranged = weapon.entries.find(e => e.kind === 'ranged')
  if (!ranged) return ''
  const id = weaponId(weaponKey(ranged.value as any))
  return actor.flags?.gurps?.agency?.shooting?.weapons?.[id]?.weaponClass ?? ''
}

export interface ReadyView {
  weapon: PhysicalWeapon
  stored: WeaponReadiness
  /** Default carry state (set by hand, else guessed). */
  carry: ReadyState
  state: ReadyState
  /** Fast-Draw specialty that readies it, or null. */
  specialty: FastDrawSpecialty | null
}

export function readyViews(actor: ReadinessActor): ReadyView[] {
  const stored = storedReadiness(actor)
  return physicalWeapons(attackEntries(actor), equipmentRefs(actor)).map(weapon => {
    const own = stored[weapon.id] ?? {}
    const cls = shootingClass(actor, weapon)
    const carry = defaultCarryState(weapon, own.carry, cls)
    return {
      weapon,
      stored: own,
      carry,
      state: currentState(own, carry),
      specialty: fastDrawSpecialty(weapon, own.fastDraw, cls),
    }
  })
}

/** The readiness view of an attack entry (an object from system.melee / system.ranged), if it comes from equipment. */
export function viewForAttack(
  actor: ReadinessActor,
  attack: AttackLike | null | undefined,
  path?: string
): ReadyView | undefined {
  if (!attack && !path) return undefined
  const views = readyViews(actor)
  const weapon = weaponForEntry(
    views.map(v => v.weapon),
    { path, value: attack }
  )
  if (weapon) return views.find(v => v.weapon.id === weapon.id)
  // Not the same object (a copy from an OtF lookup): match by name and usage.
  if (!attack) return undefined
  return views.find(v =>
    v.weapon.entries.some(
      e =>
        String(e.value.name ?? '') === String(attack.name ?? '') &&
        String(e.value.mode ?? '') === String(attack.mode ?? '')
    )
  )
}

export function viewById(actor: ReadinessActor, id: string): ReadyView | undefined {
  return readyViews(actor).find(v => v.weapon.id === id)
}

/* ---------------------------------------- */
/*  Writing                                 */
/* ---------------------------------------- */

export function stateUpdate(views: ReadyView[], changes: Record<string, Partial<WeaponReadiness>>) {
  const update: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(changes)) {
    const view = views.find(v => v.weapon.id === id)
    if (!view) continue
    update[`${FLAG_PATH}.${id}.key`] = view.weapon.key
    for (const [field, value] of Object.entries(data)) update[`${FLAG_PATH}.${id}.${field}`] = value
  }
  return update
}

/** Set several weapons' states in one update. */
export async function setStates(actor: ReadinessActor, states: Record<string, ReadyState>): Promise<void> {
  const changes = Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }]))
  const update = stateUpdate(readyViews(actor), changes)
  if (Object.keys(update).length) await actor.update(update)
}

export async function setState(actor: ReadinessActor, id: string, state: ReadyState): Promise<void> {
  return setStates(actor, { [id]: state })
}

export async function saveSettings(actor: ReadinessActor, id: string, data: Partial<WeaponReadiness>): Promise<void> {
  const update = stateUpdate(readyViews(actor), { [id]: data })
  // A blank choice means "guess again": remove the field.
  for (const field of ['carry', 'fastDraw'] as const) {
    if (field in data && !data[field]) {
      delete update[`${FLAG_PATH}.${id}.${field}`]
      update[`${FLAG_PATH}.${id}.-=${field}`] = null
    }
  }
  if (Object.keys(update).length) await actor.update(update)
}
