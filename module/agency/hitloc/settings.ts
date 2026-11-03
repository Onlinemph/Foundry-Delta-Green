import * as Settings from '../../../lib/miscellaneous-settings.js'
import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import type { TorsoCap } from './calc.ts'
import type { ArtFacing } from './facing.ts'

/** World settings for hit locations (keys get the 'agency-' prefix). */
export const HitLocSettings = {
  SYSTEM: 'hit-locations',
  TORSO_CAP: 'torso-injury-cap',
  FACING: 'hit-location-facing',
} as const

const L = 'GURPS.agency.hitloc.settings'

export function registerHitLocSettings(): void {
  registerAgencySetting(HitLocSettings.SYSTEM, {
    name: `${L}.system.name`,
    hint: `${L}.system.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: { guhl: `${L}.system.guhl`, standard: `${L}.system.standard` },
    default: 'guhl',
  })

  registerAgencySetting(HitLocSettings.TORSO_CAP, {
    name: `${L}.torsoCap.name`,
    hint: `${L}.torsoCap.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: { '2': `${L}.torsoCap.two`, '1': `${L}.torsoCap.one`, none: `${L}.torsoCap.none` },
    default: '2',
  })

  registerAgencySetting(HitLocSettings.FACING, {
    name: `${L}.facing.name`,
    hint: `${L}.facing.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: {
      down: `${L}.facing.down`,
      up: `${L}.facing.up`,
      left: `${L}.facing.left`,
      right: `${L}.facing.right`,
      off: `${L}.facing.off`,
    },
    default: 'down',
  })
}

const safeGet = <T>(key: string, fallback: T): T => {
  try {
    return (getAgencySetting<T>(key) ?? fallback) as T
  } catch {
    return fallback
  }
}

export const guhlEnabled = (): boolean => safeGet<string>(HitLocSettings.SYSTEM, 'guhl') !== 'standard'

export function torsoCap(): TorsoCap {
  const value = String(safeGet(HitLocSettings.TORSO_CAP, '2'))
  return value === '1' || value === 'none' ? value : '2'
}

/** Which way token art faces at rotation 0, or null when facing isn't worked out from tokens. */
export function artFacing(): ArtFacing | null {
  const value = String(safeGet(HitLocSettings.FACING, 'down'))
  return value === 'off' ? null : ((['down', 'up', 'left', 'right'].includes(value) ? value : 'down') as ArtFacing)
}

/** Upstream's default hit location ('Torso' or 'Random'). */
export function defaultLocation(): string {
  try {
    return String((game.settings as any).get(Settings.SYSTEM_NAME, Settings.SETTING_DEFAULT_LOCATION) ?? 'Torso')
  } catch {
    return 'Torso'
  }
}

export function onlyGMsOpenADD(): boolean {
  try {
    return !!(game.settings as any).get(Settings.SYSTEM_NAME, Settings.SETTING_ONLY_GMS_OPEN_ADD)
  } catch {
    return false
  }
}
