/**
 * Cool Under Fire (GURPS Tactical Shooting p. 34): a Fright Check on the turn after a traumatic event
 * in combat. Pure rules; Foundry glue is in cool-under-fire.ts.
 *
 * Triggers automated: a near miss (an attack that missed by 2 or less), being in an explosion's blast
 * zone, suffering a wound, seeing an ally incapacitated or killed.
 * Modifiers automated: +5 heat of battle; minus the attacker's rapid-fire bonus unless safely behind
 * cover; +1 if the attack was silenced/suppressed; the worst casualty's HP multiple (-1 at 0 HP, -2 at
 * -HP...); +2 Bloodlust; +1 Callous; plus the standard Fright Check trait modifiers. A Will-based
 * Soldier roll can replace Will. Left to the GM: -1 can't tell where the attack came from, -2
 * non-penetrating hit, -1 blood on you, -1 to -3 knew the victim, +1 veteran, +1/+5 plan/ambush/range.
 */

export type Trigger = 'nearMiss' | 'blast' | 'wounded' | 'allyDown'

/** Least to most traumatic; the worst trigger picks the SAN loss. */
export const TRIGGERS: Trigger[] = ['nearMiss', 'blast', 'wounded', 'allyDown']

export type CufModKey = 'heat' | 'rof' | 'silenced' | 'casualty'

export type CufMod = { key: CufModKey; mod: number }

export type Pending = { triggers: Trigger[]; mods: CufMod[] }

export const HEAT_OF_BATTLE = 5

/** Missed by exactly 1 or 2 (a critical failure is a wild shot, not a near miss). */
export function isNearMiss(margin: number, failure: boolean, criticalFailure: boolean): boolean {
  return failure && !criticalFailure && margin <= -1 && margin >= -2
}

/** "-1 at 0 HP, -2 at -HP, etc.": the penalty for a casualty with this many HP left of `maxHP`. */
export function casualtyPenaltyFromHP(hp: number, maxHP: number): number {
  if (!(maxHP > 0) || hp > 0) return 0
  return -(1 + Math.floor(-hp / maxHP))
}

/** The same penalty from a house-rule wound severity (injury as a multiple of HP). */
export function casualtyPenaltyFromSeverity(severity: string | null | undefined): number {
  switch (severity) {
    case 'critical':
      return -1
    case 'massive':
      return -2
    case 'gawdawful':
      return -4
    case 'destroyed':
      return -8
    default:
      return 0
  }
}

/** Silenced or sound-suppressed weapons: +1. */
export function isSilenced(text: string): boolean {
  return /\b(suppress(ed|or)|silenc(ed|er)|can\b)/i.test(text)
}

/**
 * Combine two sets of pending events for one character. Each modifier keeps its worst (lowest) value,
 * so a near miss from an unsilenced gun cancels the +1 another silenced one would give.
 */
export function mergePending(a: Pending | null | undefined, b: Pending): Pending {
  const triggers = TRIGGERS.filter(t => a?.triggers.includes(t) || b.triggers.includes(t))
  const byKey = new Map<CufModKey, number>()
  for (const m of [...(a?.mods ?? []), ...b.mods]) {
    const seen = byKey.get(m.key)
    byKey.set(m.key, seen === undefined ? m.mod : Math.min(seen, m.mod))
  }
  return { triggers, mods: [...byKey].map(([key, mod]) => ({ key, mod })) }
}

export function worstTrigger(triggers: Trigger[]): Trigger | null {
  for (let i = TRIGGERS.length - 1; i >= 0; i--) if (triggers.includes(TRIGGERS[i])) return TRIGGERS[i]
  return null
}

/** Trait modifiers Tactical Shooting adds on top of the standard Fright Check ones. */
export function cufTraitMods(traitNames: Iterable<string>): { label: string; mod: number }[] {
  const mods: { label: string; mod: number }[] = []
  const names = [...traitNames].map(n => String(n).toLowerCase())
  if (names.some(n => n.startsWith('bloodlust'))) mods.push({ label: 'Bloodlust', mod: 2 })
  if (names.some(n => n.startsWith('callous'))) mods.push({ label: 'Callous', mod: 1 })
  return mods
}

/** Fright Check target: the better of Will-based Fright Check and Will-based Soldier, then Rule of 14 (B360). */
export function frightTarget(base: number, soldierWillBased: number | null, mods: number[]): number {
  const start = soldierWillBased !== null ? Math.max(base, soldierWillBased) : base
  return Math.min(13, start + mods.reduce((s, m) => s + m, 0))
}
