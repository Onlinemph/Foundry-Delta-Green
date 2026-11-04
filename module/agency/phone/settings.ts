/**
 * Phone settings. World settings show in the "Agency fork settings" window; client settings in
 * Foundry's main list.
 */
import { getAgencySetting, registerAgencySetting, setAgencySetting } from '../settings.ts'
import { DEFAULT_START, parseStart } from './clock.ts'
import { DEFAULT_AREA_CODE, isAreaCode } from './numbers.ts'
import type { NpcIdentity } from './types.ts'

export const L = 'GURPS.agency.phone'

export const KEYS = {
  enabled: 'phone',
  autoSmartphone: 'phone-auto-smartphone',
  areaCode: 'phone-area-code',
  start: 'phone-start',
  carrier: 'phone-carrier',
  npcs: 'phone-npcs',
  torchBright: 'phone-flashlight-bright',
  torchDim: 'phone-flashlight-dim',
  torchAngle: 'phone-flashlight-angle',
  torchColor: 'phone-flashlight-color',
  sounds: 'phone-sounds',
  scale: 'phone-scale',
  launcher: 'phone-launcher',
  launcherPos: 'phone-launcher-pos',
} as const

/** Callbacks run when a setting that changes what phones show is edited. */
const listeners: (() => void)[] = []
export function onPhoneSettingsChange(fn: () => void): void {
  listeners.push(fn)
}
const changed = () => {
  for (const fn of listeners) fn()
}

export function registerPhoneSettings(): void {
  const world = (key: string, type: any, def: unknown, extra: Record<string, unknown> = {}) =>
    registerAgencySetting(key, {
      name: `${L}.settings.${key}.name`,
      hint: `${L}.settings.${key}.hint`,
      scope: 'world',
      config: true,
      type,
      default: def,
      onChange: changed,
      ...extra,
    })
  world(KEYS.enabled, Boolean, true, { requiresReload: true })
  world(KEYS.autoSmartphone, Boolean, true)
  world(KEYS.areaCode, String, DEFAULT_AREA_CODE)
  world(KEYS.start, String, DEFAULT_START)
  world(KEYS.carrier, String, 'Nightline')
  world(KEYS.torchBright, Number, 3)
  world(KEYS.torchDim, Number, 8)
  world(KEYS.torchAngle, Number, 60)
  world(KEYS.torchColor, String, '#ffcf8a')
  registerAgencySetting(KEYS.npcs, { scope: 'world', config: false, type: Array, default: [], onChange: changed })

  const client = (key: string, type: any, def: unknown, extra: Record<string, unknown> = {}) =>
    registerAgencySetting(key, {
      name: `${L}.settings.${key}.name`,
      hint: `${L}.settings.${key}.hint`,
      scope: 'client',
      config: true,
      type,
      default: def,
      onChange: changed,
      ...extra,
    })
  client(KEYS.sounds, Boolean, true)
  client(KEYS.scale, Number, 1, { range: { min: 0.7, max: 1.3, step: 0.05 } })
  client(KEYS.launcher, Boolean, true)
  registerAgencySetting(KEYS.launcherPos, { scope: 'client', config: false, type: Object, default: {} })
}

function get<T>(key: string, fallback: T): T {
  try {
    const v = getAgencySetting<T>(key)
    return v === undefined || v === null ? fallback : v
  } catch {
    return fallback
  }
}

export const phoneEnabled = () => !!get(KEYS.enabled, true)
export const autoSmartphone = () => !!get(KEYS.autoSmartphone, true)
export const areaCode = () => {
  const v = String(get(KEYS.areaCode, DEFAULT_AREA_CODE)).trim()
  return isAreaCode(v) ? v : DEFAULT_AREA_CODE
}
export const campaignStart = () => {
  const v = String(get(KEYS.start, DEFAULT_START))
  return parseStart(v) === null ? DEFAULT_START : v
}
export const carrierName = () => String(get(KEYS.carrier, 'Nightline')).slice(0, 24) || 'Nightline'
export const soundsOn = () => !!get(KEYS.sounds, true)
export const phoneScale = () => Math.min(1.3, Math.max(0.7, Number(get(KEYS.scale, 1)) || 1))
export const launcherOn = () => !!get(KEYS.launcher, true)

export function flashlightConfig(): { bright: number; dim: number; angle: number; color: string } {
  const num = (key: string, def: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number(get(key, def)) || def))
  const color = String(get(KEYS.torchColor, '#ffcf8a'))
  return {
    bright: num(KEYS.torchBright, 3, 0, 100),
    dim: num(KEYS.torchDim, 8, 0, 200),
    angle: num(KEYS.torchAngle, 60, 1, 360),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffcf8a',
  }
}

export function npcIdentities(): NpcIdentity[] {
  const raw = get<unknown>(KEYS.npcs, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter(n => n && typeof n.id === 'string' && typeof n.number === 'string')
    .map(n => ({
      id: n.id,
      name: String(n.name ?? ''),
      number: n.number,
      img: String(n.img ?? ''),
      read: n.read && typeof n.read === 'object' ? { ...n.read } : {},
      callsSeen: Number(n.callsSeen) || 0,
    }))
}

export async function saveNpcIdentities(list: NpcIdentity[]): Promise<void> {
  await setAgencySetting(KEYS.npcs, list)
}

export function launcherPosition(): { left?: number; top?: number } {
  const v = get<any>(KEYS.launcherPos, {})
  return v && typeof v === 'object' ? v : {}
}

export async function saveLauncherPosition(pos: { left: number; top: number }): Promise<void> {
  await setAgencySetting(KEYS.launcherPos, pos)
}
