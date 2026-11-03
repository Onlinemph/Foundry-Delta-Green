/**
 * Shared helpers for the Agency fork's features.
 *
 * Every Agency setting lives in the 'gurps' namespace with an 'agency-' key prefix,
 * so nothing collides with upstream settings and the fork's settings are easy to find.
 */
export const NAMESPACE = 'gurps'
export const PREFIX = 'agency-'

export function settingKey(key: string): string {
  return key.startsWith(PREFIX) ? key : `${PREFIX}${key}`
}

/**
 * World settings the GM can edit, in registration order. These are kept out of Foundry's main
 * settings list (which is already long for GURPS) and shown together in the "Agency fork settings" window.
 * Client-scoped settings stay in the main list so players can reach them.
 */
export const groupedSettingKeys: string[] = []

export function registerAgencySetting(key: string, data: Record<string, unknown>): void {
  const full = settingKey(key)
  let registered = data
  if (data.config !== false && data.scope !== 'client') {
    groupedSettingKeys.push(full)
    registered = { ...data, config: false }
  }
  // @ts-expect-error - setting keys are not declared in fvtt-types' ClientSettings config
  game.settings.register(NAMESPACE, full, registered)
}

export function getAgencySetting<T = unknown>(key: string): T {
  // @ts-expect-error - see registerAgencySetting
  return game.settings.get(NAMESPACE, settingKey(key)) as T
}

export async function setAgencySetting(key: string, value: unknown): Promise<unknown> {
  // @ts-expect-error - see registerAgencySetting
  return game.settings.set(NAMESPACE, settingKey(key), value)
}

/** Flag scope + root used by features that store per-actor data in flags (flags.gurps.agency.<feature>). */
export const FLAG_SCOPE = 'gurps'
export const FLAG_ROOT = 'agency'
