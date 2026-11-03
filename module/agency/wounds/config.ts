/**
 * Settings for the Revised Fractional Health feature, plus small helpers for reading actors.
 */
import { FLAG_ROOT, FLAG_SCOPE, getAgencySetting, registerAgencySetting } from '../settings.ts'
import { normalizeState, type Traits, type WoundsState, detectTraits } from './engine.ts'

export const SETTING_DAMAGE_MODEL = 'damage-model'
export const SETTING_MINOR_BLEEDING = 'rfh-minor-bleeding'

/** Path under flags.gurps where the wound state lives. */
export const FLAG_KEY = `${FLAG_ROOT}.wounds`

const K = 'GURPS.agency.wounds'

function rerenderSheets(): void {
  for (const app of Object.values((ui as any).windows ?? {}) as any[]) {
    if (app?.rendered && app.actor) app.render(false)
  }
}

export function registerWoundSettings(): void {
  registerAgencySetting(SETTING_DAMAGE_MODEL, {
    name: `${K}.settings.model.name`,
    hint: `${K}.settings.model.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: {
      rfh: `${K}.settings.model.rfh`,
      standard: `${K}.settings.model.standard`,
    },
    default: 'rfh',
    onChange: rerenderSheets,
  })

  registerAgencySetting(SETTING_MINOR_BLEEDING, {
    name: `${K}.settings.minorBleeding.name`,
    hint: `${K}.settings.minorBleeding.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  })
}

/** True when Revised Fractional Health is the damage model. */
export function isRFH(): boolean {
  try {
    return getAgencySetting<string>(SETTING_DAMAGE_MODEL) === 'rfh'
  } catch {
    return false
  }
}

export function trackMinorBleeding(): boolean {
  try {
    return !!getAgencySetting<boolean>(SETTING_MINOR_BLEEDING)
  } catch {
    return false
  }
}

export function readState(actor: any): WoundsState {
  return normalizeState(foundry.utils.getProperty(actor, `flags.${FLAG_SCOPE}.${FLAG_KEY}`))
}

export async function writeState(actor: any, state: WoundsState): Promise<void> {
  await actor.update({ [`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: state })
}

export function actorTraits(actor: any, injuryTolerance?: Traits['injuryTolerance'] | 'homogenous'): Traits {
  const traits = detectTraits(actor?.system?.ads)
  if (injuryTolerance === 'homogenous') return { ...traits, injuryTolerance: 'homogeneous' }
  if (injuryTolerance) return { ...traits, injuryTolerance }
  return traits
}

export function maxHP(actor: any): number {
  return Number(actor?.system?.HP?.max) || 0
}

export function htOf(actor: any): number {
  const ht = Number(actor?.system?.attributes?.HT?.value)
  return Number.isFinite(ht) ? ht : 10
}

export function worldTime(): number {
  return Number((game as any).time?.worldTime) || 0
}

/** The combatant for this actor (linked or synthetic) in the active combat, if any. */
export function combatantFor(actor: any): any | null {
  const combat = (game as any).combat
  if (!combat) return null
  return (
    combat.combatants.find((c: any) => c.actor === actor || (actor?.token && c.tokenId === actor.token.id)) ??
    combat.combatants.find((c: any) => !actor?.isToken && c.actorId === actor?.id) ??
    null
  )
}

/** "In an emergency": taking part in a started combat. Outside one the impairment roll is at -3. */
export function inEmergency(actor: any): boolean {
  const combat = (game as any).combat
  return !!combat?.started && !!combatantFor(actor)
}

export function localize(key: string): string {
  return (game as any).i18n?.localize(key) ?? key
}

export function format(key: string, data: Record<string, unknown>): string {
  return (game as any).i18n?.format(key, data) ?? key
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`
}
