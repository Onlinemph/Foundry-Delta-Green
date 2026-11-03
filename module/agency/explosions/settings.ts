import { getAgencySetting, registerAgencySetting } from '../settings.ts'

/** World settings (keys get the 'agency-' prefix). */
export const ExplosionSettings = {
  ENABLED: 'explosions',
  WALLS_COVER: 'explosion-walls-cover',
  SCATTER: 'explosion-scatter',
  WALL_DR: 'explosion-wall-dr',
  SHARED_ROLL: 'explosion-shared-roll',
  KNOCKBACK_MOVE: 'explosion-knockback-move',
} as const

const L = 'GURPS.agency.explosions.settings'

export function registerExplosionSettings(): void {
  const bool = (key: string, name: string, def: boolean) =>
    registerAgencySetting(key, {
      name: `${L}.${name}.name`,
      hint: `${L}.${name}.hint`,
      scope: 'world',
      config: true,
      type: Boolean,
      default: def,
    })

  bool(ExplosionSettings.ENABLED, 'enabled', true)
  bool(ExplosionSettings.WALLS_COVER, 'wallsCover', true)
  registerAgencySetting(ExplosionSettings.WALL_DR, {
    name: `${L}.wallDR.name`,
    hint: `${L}.wallDR.hint`,
    scope: 'world',
    config: true,
    type: Number,
    // B558 Structural Damage Table: a modern house is DR 6.
    default: 6,
  })
  bool(ExplosionSettings.SCATTER, 'scatter', true)
  bool(ExplosionSettings.SHARED_ROLL, 'sharedRoll', false)
  bool(ExplosionSettings.KNOCKBACK_MOVE, 'knockbackMove', true)
}

function safe<T>(key: string, fallback: T): T {
  try {
    const value = getAgencySetting<T>(key)
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

export const explosionsEnabled = (): boolean => !!safe(ExplosionSettings.ENABLED, true)
export const wallsAreCover = (): boolean => !!safe(ExplosionSettings.WALLS_COVER, true)
export const scatterEnabled = (): boolean => !!safe(ExplosionSettings.SCATTER, true)
export const defaultWallDR = (): number => Math.max(0, Number(safe(ExplosionSettings.WALL_DR, 6)) || 0)
export const sharedNpcRoll = (): boolean => !!safe(ExplosionSettings.SHARED_ROLL, false)
export const knockbackMoves = (): boolean => !!safe(ExplosionSettings.KNOCKBACK_MOVE, true)
