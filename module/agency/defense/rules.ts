/**
 * Pure GURPS rules for defense prompts: which active defenses an attack allows, the modifiers a
 * defense option adds, and how many hits get through. No Foundry globals in here, so it is unit tested
 * (test/agency/defense-rules.test.ts).
 */
import type {
  AttackKind,
  AttackProfile,
  DefenseAttempt,
  DefenseType,
  ManeuverDefenseRule,
  NoDefenseReason,
} from './types.ts'

type Obj = Record<string, unknown>

const has = (obj: Obj, key: string): boolean => key in obj && obj[key] !== undefined && obj[key] !== null

/** Last segment after the actor id: `[@abc@M:"Sword"]` -> `M:"Sword"]`. */
function rollRef(chatthing: string): string {
  return (chatthing ?? '')
    .split('@')
    .pop()!
    .replace(/^\[\s*/, '')
}

/**
 * Is this roll an attack, and what kind? Uses the roll's OTF prefix (M:/R:, as upstream's attack
 * action writes it) and falls back to the shape of the weapon object for A: and sheet rolls.
 *
 * @param chatthing - the roll's chatthing (`[@actorId@M:"Broadsword (Swung)"]`)
 * @param obj - optionalArgs.obj: the melee/ranged entry the roll came from
 */
export function classifyAttack(chatthing: string, obj: Obj | null | undefined): AttackProfile | null {
  const prefix = rollRef(chatthing)
    .match(/^([AMR]):/i)?.[1]
    ?.toUpperCase()
  const weapon = obj ?? {}
  const looksRanged = ['rof', 'acc', 'rcl', 'halfd', 'max', 'bulk'].some(key => has(weapon, key))
  const looksMelee = ['reach', 'parry', 'block'].some(key => has(weapon, key))

  let kind: AttackKind | null = null
  if (prefix === 'M') kind = 'melee'
  else if (prefix === 'R') kind = 'ranged'
  else if (has(weapon, 'damage')) kind = looksRanged ? 'ranged' : looksMelee ? 'melee' : null

  if (!kind) return null

  const text = ['name', 'mode', 'originalName'].map(key => String(weapon[key] ?? '')).join(' ')
  const thrown = kind === 'ranged' && /\bthrow(n|ing)?\b/i.test(text)
  const recoil = parseInt(String(weapon.rcl ?? ''), 10)
  const firearm = kind === 'ranged' && !thrown && Number.isFinite(recoil) && recoil > 0

  return { kind, thrown, firearm }
}

/**
 * The defense rule of a maneuver. `flag` is the maneuver's upstream `flags.gurps.defense`.
 * Committed Aim (Pyramid 3/77) allows no parries or blocks; upstream enforces that through
 * TokenActions (maxParries/maxBlocks = 0) rather than the maneuver flag.
 */
export function maneuverDefenseRule(
  maneuver: string | null | undefined,
  flag: string | null | undefined
): ManeuverDefenseRule {
  if (maneuver === 'committed_aim') return 'dodge'
  if (flag === 'none' || flag === 'dodge-block') return flag
  return 'any'
}

export interface DefenseSituation {
  attack: AttackProfile
  isCritical: boolean
  maneuverRule: ManeuverDefenseRule
  /** The defender can't see the attack: blind defender or invisible attacker. */
  cantSee: boolean
  hasParry: boolean
  hasBlock: boolean
}

export interface DefenseAvailability {
  noDefense: NoDefenseReason | null
  dodge: boolean
  parry: boolean
  block: boolean
  /** i18n keys (GURPS.agency.defense.note.*) explaining restrictions. */
  notes: string[]
}

/**
 * Which active defenses the defender may try.
 *
 * - Critical hit: no defense (B556).
 * - All-Out Attack and similar: no active defense (B365-366).
 * - A ranged attack the defender can't see can't be defended (B390); in melee the -4 for not seeing
 *   the attacker is a modifier instead (upstream's Blind status adds it).
 * - Ranged attacks can't be parried, except thrown weapons (B376); bullets and beams can't be
 *   blocked (B375).
 * - Move and Attack: dodge or block only; Committed Aim: dodge only.
 */
export function defenseAvailability(s: DefenseSituation): DefenseAvailability {
  const none = (noDefense: NoDefenseReason): DefenseAvailability => ({
    noDefense,
    dodge: false,
    parry: false,
    block: false,
    notes: [],
  })

  if (s.isCritical) return none('critical')
  if (s.maneuverRule === 'none') return none('maneuver')
  if (s.attack.kind === 'ranged' && s.cantSee) return none('cantSee')

  const notes: string[] = []
  let parry = s.hasParry
  let block = s.hasBlock

  if (s.attack.kind === 'ranged') {
    if (s.attack.thrown) {
      if (parry) notes.push('parryThrown')
    } else if (parry) {
      parry = false
      notes.push('noParryRanged')
    }
    if (s.attack.firearm && block) {
      block = false
      notes.push('noBlockFirearm')
    }
  }

  if (s.maneuverRule === 'dodge-block' && parry) {
    parry = false
    notes.push('noParryManeuver')
  }
  if (s.maneuverRule === 'dodge' && (parry || block)) {
    parry = false
    block = false
    notes.push('dodgeOnlyManeuver')
  }

  return { noDefense: null, dodge: true, parry, block, notes }
}

/** Options the defender can switch on in the card. */
export interface DefenseToggles {
  retreat?: boolean
  dodgeAndDrop?: boolean
  acrobatic?: boolean
  feverish?: boolean
  side?: boolean
}

/** Which toggles make sense for this attack (the card hides the rest). */
export function availableToggles(attack: AttackProfile, stunned: boolean): Required<DefenseToggles> {
  return {
    // Retreat is a melee option (B377), and stunned characters can't retreat (B420).
    retreat: attack.kind === 'melee' && !stunned,
    // Dodge and Drop is against ranged attacks only (B377).
    dodgeAndDrop: attack.kind === 'ranged',
    acrobatic: true,
    feverish: true,
    side: true,
  }
}

export interface ModifierSpec {
  mod: number
  /** i18n key of the modifier description. */
  key: string
  /** Appended to the description verbatim (e.g. upstream's " *Cost 1FP"). */
  suffix?: string
}

export interface ModifierContext {
  attack: AttackProfile
  defense: DefenseType
  /** Fencing weapon parry ("F" suffix): retreat gives +3 instead of +1 (B377). */
  fencing: boolean
  stunned: boolean
  cantSee: boolean
  deceptivePenalty: number
  maneuver: string
  /** Result of the Acrobatics roll when the acrobatic toggle is on. */
  acrobaticResult?: 'success' | 'failure'
  /**
   * Add maneuver and status modifiers (AoD, Committed Aim, Stunned, can't see) ourselves. Only when
   * upstream's tagged modifiers are not auto-added; otherwise upstream already puts them in the roll.
   */
  includeManeuverAndStatus: boolean
}

const MOD = 'GURPS.modifiers_.'
const OWN = 'GURPS.agency.defense.mod.'

/** All-Out Defense (Increased Defense) +2 to the chosen defense (B366); upstream's generic AoD gives it to all. */
const AOD_BONUS: Record<string, DefenseType[]> = {
  allout_defense: ['dodge', 'parry', 'block'],
  aod_dodge: ['dodge'],
  aod_parry: ['parry'],
  aod_block: ['block'],
}

/** The modifiers to put in the bucket before rolling a defense. */
export function defenseModifiers(ctx: ModifierContext, toggles: DefenseToggles): ModifierSpec[] {
  const mods: ModifierSpec[] = []
  const allowed = availableToggles(ctx.attack, ctx.stunned)

  if (toggles.retreat && allowed.retreat) {
    if (ctx.defense === 'dodge') mods.push({ mod: 3, key: `${MOD}dodgeRetreat` })
    else if (ctx.defense === 'parry' && ctx.fencing) mods.push({ mod: 3, key: `${MOD}fencingRetreat` })
    else mods.push({ mod: 1, key: `${MOD}blockRetreat` })
  }

  if (toggles.dodgeAndDrop && allowed.dodgeAndDrop && ctx.defense === 'dodge')
    mods.push({ mod: 3, key: `${MOD}dodgeAndDrop` })

  if (toggles.acrobatic && ctx.defense === 'dodge' && ctx.acrobaticResult)
    mods.push(
      ctx.acrobaticResult === 'success'
        ? { mod: 2, key: `${MOD}dodgeAcrobatic` }
        : { mod: -2, key: `${MOD}dodgeAcrobaticFail` }
    )

  if (toggles.feverish) mods.push({ mod: 2, key: `${MOD}feverishDefense`, suffix: ' *Cost 1FP' })
  if (toggles.side) mods.push({ mod: -2, key: `${MOD}defenseSide` })

  if (ctx.deceptivePenalty > 0) mods.push({ mod: -ctx.deceptivePenalty, key: `${MOD}deceptiveDefense` })

  if (ctx.defense === 'parry' && ctx.attack.kind === 'ranged' && ctx.attack.thrown)
    mods.push({ mod: -1, key: `${OWN}parryThrown` })

  if (ctx.includeManeuverAndStatus) {
    if (AOD_BONUS[ctx.maneuver]?.includes(ctx.defense)) mods.push({ mod: 2, key: `${MOD}aodIncreased` })
    if (ctx.maneuver === 'committed_aim') mods.push({ mod: -2, key: `${MOD}committedAimDefense` })
    if (ctx.maneuver === 'committed_attack_ranged') mods.push({ mod: -2, key: `${OWN}committedAttack` })
    if (ctx.stunned) mods.push({ mod: -4, key: `${OWN}stunned` })
    if (ctx.cantSee && ctx.attack.kind === 'melee') mods.push({ mod: -4, key: `${OWN}cantSee` })
  }

  return mods
}

/**
 * Hits left after a defense. One defense roll covers every hit of the attack: a successful dodge
 * against rapid fire stops one hit plus one per point of success (B375); a parry or block stops
 * one; a failed defense stops none. Critical hits can't be defended (B556) and always remain.
 */
export function hitsAfterDefense(
  hits: number,
  attempt: Pick<DefenseAttempt, 'type' | 'success' | 'margin'>,
  criticalHits = 0
): number {
  if (hits <= 0) return 0
  const critical = Math.min(hits, Math.max(0, criticalHits))
  const defendable = hits - critical
  if (attempt.type === 'none' || !attempt.success || defendable === 0) return hits
  const stopped = attempt.type === 'dodge' ? 1 + Math.max(0, attempt.margin) : 1
  return critical + Math.max(0, defendable - stopped)
}

/**
 * Split a rapid-fire attack's hits between several targets, in target order. With a single hit
 * (melee, single shot) every target is attacked once.
 */
export function distributeHits(totalHits: number, targets: number): number[] {
  if (targets <= 0) return []
  const total = Math.max(1, Math.floor(totalHits) || 1)
  if (total === 1) return Array(targets).fill(1)
  const base = Math.floor(total / targets)
  const extra = total % targets
  return Array.from({ length: targets }, (_, i) => base + (i < extra ? 1 : 0))
}

/**
 * Split an attack's hits and critical hits between targets: hits as distributeHits(); critical
 * hits handed out in target order, never more than a target's hits. With a single hit every target
 * is attacked once, critically if any hit was critical.
 */
export function distributeAttack(
  totalHits: number,
  criticalHits: number,
  targets: number
): { hits: number; critical: number }[] {
  const shares = distributeHits(totalHits, targets)
  const total = Math.max(1, Math.floor(totalHits) || 1)
  let remaining = Math.min(total, Math.max(0, Math.floor(criticalHits) || 0))
  if (total === 1) return shares.map(hits => ({ hits, critical: remaining > 0 ? hits : 0 }))

  const critical = shares.map(() => 0)
  while (remaining > 0) {
    let given = false
    for (let i = 0; i < shares.length && remaining > 0; i++) {
      if (critical[i] < shares[i]) {
        critical[i]++
        remaining--
        given = true
      }
    }
    if (!given) break
  }
  return shares.map((hits, i) => ({ hits, critical: critical[i] }))
}

export interface RollModifier {
  modint?: number
  mod?: string
  desc?: string
}

const modValue = (m: RollModifier): number =>
  typeof m.modint === 'number' ? m.modint : parseInt(m.mod ?? '0', 10) || 0

/**
 * The hit location an attack aimed at, from upstream's hit location modifiers ("-7 to hit Skull",
 * optionally followed by "[notes]").
 *
 * @param mods - the roll's target modifiers (chatdata.targetmods)
 * @param toHit - the localized "to hit" (GURPS.modifierToHit)
 * @param locations - localized location name -> upstream raw key (e.g. "Skull" -> "Skull")
 */
export function parseHitLocation(
  mods: RollModifier[] | null | undefined,
  toHit: string,
  locations: Record<string, string>
): string | null {
  const prefix = toHit.trim().toLowerCase()
  const lookup = new Map(Object.entries(locations).map(([label, raw]) => [label.trim().toLowerCase(), raw]))

  for (const mod of [...(mods ?? [])].reverse()) {
    const desc = (mod.desc ?? '').trim()
    if (!desc.toLowerCase().startsWith(`${prefix} `)) continue
    const label = desc
      .slice(prefix.length)
      .replace(/\[.*\]\s*$/, '')
      .trim()
      .toLowerCase()
    const raw = lookup.get(label)
    if (raw) return raw
  }
  return null
}

/**
 * Deceptive Attack (B369): every -2 to hit gives -1 to the target's defense. Returns the defense
 * penalty as a positive number.
 *
 * @param label - the localized "to hit (Deceptive Attack)" (GURPS.modifiers_.deceptive)
 */
export function deceptivePenalty(mods: RollModifier[] | null | undefined, label: string): number {
  const needle = label.trim().toLowerCase()
  const total = (mods ?? [])
    .filter(m => (m.desc ?? '').toLowerCase().includes(needle))
    .reduce((sum, m) => sum + modValue(m), 0)
  return total < 0 ? Math.floor(-total / 2) : 0
}

export interface DefenseWeapon {
  /** What upstream's findAttack() matches: "Broadsword (Swung)". */
  name: string
  value: number
  fencing: boolean
}

interface MeleeEntry {
  name?: string
  mode?: string
  parry?: string | number
  block?: string | number
  contains?: Record<string, MeleeEntry>
  collapsed?: Record<string, MeleeEntry>
}

/**
 * The defender's parries or blocks from their melee list (system.melee), best first. Entries with
 * no usable value ("No", "-", 0) are left out. Duplicates (same name and mode) keep the best value.
 */
export function listDefenseWeapons(
  melee: Record<string, MeleeEntry> | null | undefined,
  field: 'parry' | 'block'
): DefenseWeapon[] {
  const found = new Map<string, DefenseWeapon>()

  const walk = (list: Record<string, MeleeEntry> | null | undefined) => {
    for (const entry of Object.values(list ?? {})) {
      if (!entry || typeof entry !== 'object') continue
      const raw = String(entry[field] ?? '').trim()
      const value = parseInt(raw, 10)
      if (entry.name && Number.isFinite(value) && value > 0) {
        const name = entry.mode ? `${entry.name} (${entry.mode})` : entry.name
        const weapon = { name, value, fencing: field === 'parry' && /f$/i.test(raw) }
        const existing = found.get(name)
        if (!existing || existing.value < value) found.set(name, weapon)
      }
      walk(entry.contains)
      walk(entry.collapsed)
    }
  }
  walk(melee)

  return [...found.values()].sort((a, b) => b.value - a.value)
}

/** Quote a weapon name for an OTF the way upstream's quotedAttackName() does. */
export function quoteOtfName(name: string): string {
  return name.includes('"') ? `'${name.replace(/'/g, "\\'")}'` : `"${name}"`
}

/** The OTF that rolls a defense through upstream's actions ("Dodge", P:"Sword", B:"Shield"). */
export function defenseOtf(type: DefenseType, weapon?: string): string {
  if (type === 'dodge') return 'Dodge'
  return `${type === 'parry' ? 'P' : 'B'}:${quoteOtfName(weapon ?? '')}`
}
