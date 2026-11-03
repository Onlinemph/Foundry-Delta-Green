import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import type { StunTiming } from './flow.ts'

/** World settings for the defense / turn-flow automations (keys get the 'agency-' prefix). */
export const DefenseSettings = {
  PROMPTS: 'defense-prompts',
  AUTO_DAMAGE: 'defense-auto-damage',
  MANEUVER_PROMPT: 'turn-maneuver-prompt',
  STUN_RECOVERY: 'turn-stun-recovery',
} as const

const L = 'GURPS.agency.defense.settings'

export function registerDefenseSettings(): void {
  registerAgencySetting(DefenseSettings.PROMPTS, {
    name: `${L}.prompts.name`,
    hint: `${L}.prompts.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  registerAgencySetting(DefenseSettings.AUTO_DAMAGE, {
    name: `${L}.autoDamage.name`,
    hint: `${L}.autoDamage.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  registerAgencySetting(DefenseSettings.MANEUVER_PROMPT, {
    name: `${L}.maneuverPrompt.name`,
    hint: `${L}.maneuverPrompt.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  registerAgencySetting(DefenseSettings.STUN_RECOVERY, {
    name: `${L}.stunRecovery.name`,
    hint: `${L}.stunRecovery.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: {
      end: `${L}.stunRecovery.end`,
      start: `${L}.stunRecovery.start`,
      off: `${L}.stunRecovery.off`,
    },
    default: 'end',
  })
}

const safeGet = <T>(key: string, fallback: T): T => {
  try {
    return (getAgencySetting<T>(key) ?? fallback) as T
  } catch {
    return fallback
  }
}

export const defensePromptsEnabled = (): boolean => !!safeGet(DefenseSettings.PROMPTS, true)
export const autoDamageEnabled = (): boolean => !!safeGet(DefenseSettings.AUTO_DAMAGE, true)
export const maneuverPromptEnabled = (): boolean => !!safeGet(DefenseSettings.MANEUVER_PROMPT, true)
export const stunRecoveryTiming = (): StunTiming => safeGet<StunTiming>(DefenseSettings.STUN_RECOVERY, 'end')
