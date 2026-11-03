/**
 * Agency sanity: settings and actor data access (Foundry-facing, kept thin).
 */
import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import {
  DEFAULT_SAN_MULTIPLIER,
  type LastLoss,
  type SanityData,
  initialSanity,
  normalizeSanity,
  SAN_CATEGORIES,
  type SanCategory,
} from './rules.ts'

export const SANITY_PATH = 'system.sanity'
/** flags.gurps.agency.sanity.lastLoss: the most recent loss, which may be projected onto a Bond once. */
export const LAST_LOSS_FLAG = 'flags.gurps.agency.sanity.lastLoss'
export const I18N = 'GURPS.agency.sanity'

export const SETTING_ENABLED = 'sanity'
export const SETTING_ROLL = 'san-roll'
export const SETTING_MULTIPLIER = 'san-multiplier'
export const SETTING_BOND_START = 'san-bond-start'

export type SanRollMode = 'fright' | 'percentile'

/** Loose view of the GURPS actor: the fields this feature touches. */
export interface SanityActor {
  id: string | null
  uuid: string
  name: string
  isOwner: boolean
  system: any
  flags: any
  update(data: Record<string, unknown>, context?: Record<string, unknown>): Promise<unknown>
  findAdvantage?(name: string): any
  sheet?: { rendered?: boolean; render(force?: boolean): unknown } | null
}

export function t(key: string, data?: Record<string, unknown>): string {
  const full = `${I18N}.${key}`
  return data ? game.i18n!.format(full, data as Record<string, string>) : game.i18n!.localize(full)
}

export function categoryLabel(category: SanCategory): string {
  return t(`category.${category}`)
}

export function categoryChoices(): Record<string, string> {
  return Object.fromEntries(SAN_CATEGORIES.map(c => [c, categoryLabel(c)]))
}

export function registerSanitySettings(): void {
  registerAgencySetting(SETTING_ENABLED, {
    name: `${I18N}.settings.enabled.name`,
    hint: `${I18N}.settings.enabled.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => rerenderActorSheets(),
  })
  registerAgencySetting(SETTING_ROLL, {
    name: `${I18N}.settings.roll.name`,
    hint: `${I18N}.settings.roll.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: {
      fright: `${I18N}.settings.roll.fright`,
      percentile: `${I18N}.settings.roll.percentile`,
    },
    default: 'fright',
  })
  registerAgencySetting(SETTING_MULTIPLIER, {
    name: `${I18N}.settings.multiplier.name`,
    hint: `${I18N}.settings.multiplier.hint`,
    scope: 'world',
    config: true,
    type: Number,
    default: DEFAULT_SAN_MULTIPLIER,
  })
  registerAgencySetting(SETTING_BOND_START, {
    name: `${I18N}.settings.bondStart.name`,
    hint: `${I18N}.settings.bondStart.hint`,
    scope: 'world',
    config: true,
    type: Number,
    default: 0,
  })
}

function safeSetting<T>(key: string, fallback: T): T {
  try {
    const v = getAgencySetting<T>(key)
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

export function sanityEnabled(): boolean {
  return safeSetting<boolean>(SETTING_ENABLED, true) !== false
}

export function sanRollMode(): SanRollMode {
  return safeSetting<string>(SETTING_ROLL, 'fright') === 'percentile' ? 'percentile' : 'fright'
}

export function sanMultiplier(): number {
  const n = Number(safeSetting<number>(SETTING_MULTIPLIER, DEFAULT_SAN_MULTIPLIER))
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SAN_MULTIPLIER
}

export function bondStartSetting(): number {
  const n = Number(safeSetting<number>(SETTING_BOND_START, 0))
  return Number.isFinite(n) ? n : 0
}

export function willOf(actor: SanityActor): number {
  const w = Number(actor.system?.attributes?.WILL?.value)
  return Number.isFinite(w) && w > 0 ? w : 10
}

/** Stored sanity, normalised; uninitialised actors are shown with their computed starting values. */
export function getSanity(actor: SanityActor): SanityData {
  const s = normalizeSanity(actor.system?.sanity)
  return s.initialized ? s : initialSanity(s, willOf(actor), sanMultiplier())
}

export function getLastLoss(actor: SanityActor): LastLoss | null {
  const l = actor.flags?.gurps?.agency?.sanity?.lastLoss
  return l && typeof l === 'object' && l.id ? (l as LastLoss) : null
}

/** Full replacement of the stored sanity block (arrays are written whole, never by index). */
export function sanityUpdate(s: SanityData): Record<string, unknown> {
  return {
    [`${SANITY_PATH}.value`]: s.value,
    [`${SANITY_PATH}.max`]: s.max,
    [`${SANITY_PATH}.breakingPoint`]: s.breakingPoint,
    [`${SANITY_PATH}.unnatural`]: s.unnatural,
    [`${SANITY_PATH}.initialized`]: true,
    [`${SANITY_PATH}.bonds`]: s.bonds,
    [`${SANITY_PATH}.disorders`]: s.disorders,
    [`${SANITY_PATH}.adaptation`]: { ...s.adaptation },
  }
}

const initializing = new WeakSet<object>()

/**
 * Write starting SAN / Breaking Point the first time an owner needs them (sheet render or a SAN roll).
 * Non-owners never write; they just see the computed values from getSanity().
 */
export async function ensureSanityInitialized(actor: SanityActor): Promise<void> {
  if (!sanityEnabled() || !actor?.isOwner || (actor as any).pack) return
  if (normalizeSanity(actor.system?.sanity).initialized) return
  if (initializing.has(actor)) return
  initializing.add(actor)
  try {
    await actor.update(sanityUpdate(getSanity(actor)))
  } finally {
    initializing.delete(actor)
  }
}

export function rerenderActorSheets(): void {
  for (const actor of (game as any).actors ?? []) {
    if (actor.sheet?.rendered) actor.sheet.render(false)
  }
}

export function newId(): string {
  return foundry.utils.randomID()
}
