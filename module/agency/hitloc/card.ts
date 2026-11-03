/**
 * The hit-location card: one row per hit (location path, cover result, damage, Apply), stored in the
 * chat message's flags.gurps.agency.hitloc. Pure state and view building; the Foundry side is in
 * hit-card.ts. Translation comes in as a function so the view can be unit tested.
 */
import type { TokenRef } from '../defense/types.ts'
import { mapToBody, resolveStandard, type BodyLocation } from './body.ts'
import { resolveCoverHit, type CoverData, type CoverOutcome } from './cover.ts'
import { aimFromName, replayRoller, resolveHit } from './engine.ts'
import type { Aim, AttackType, Facing, HitResult, PathSegment, Roller } from './types.ts'

export const L = 'GURPS.agency.hitloc'

export interface HitEntry {
  /** 0-based hit number. */
  index: number
  /** Basic damage rolled for this hit. */
  damage: number
  /** Location dice by key (replayed when the card is re-resolved). */
  dice: Record<string, number>
  coverDice: Record<string, number>
  result: HitResult
  /** The defender's own location name for this hit (calculator.hitLocation); null if the body has none. */
  where: string | null
  cover: CoverOutcome | null
  /** Damage that reaches the target (after cover). */
  finalDamage: number
  applied: boolean
}

export interface HitCardFlag {
  kind: 'hitloc-card'
  attacker: TokenRef
  target: TokenRef
  /** User who rolled the damage. */
  userId: string
  weapon: string
  damageText: string
  attack: AttackType
  armorDivisor: number
  /** The attack's hit-location modifier (upstream / picker name), if any. */
  aimName: string | null
  aim: Aim
  /** An explicit called shot (not the default location or a random one). */
  called: boolean
  system: 'guhl' | 'standard'
  facingAuto: Facing
  facingOverride: Facing | null
  /** Cover at the time of the attack. */
  cover: CoverData | null
  hits: HitEntry[]
  /** Upstream damage payload entries (roll and token removed), one per hit. */
  entries: Record<string, unknown>[]
}

export interface BodyInfo {
  wheres: string[]
  table: BodyLocation[]
  localize?: (name: string) => string
}

/**
 * The aim for an attack: its hit-location modifier, else upstream's default-location setting
 * ('Random' rolls the main table; 'Torso' is the chest, whose sub-table is still rolled).
 */
export function chooseAim(
  aimName: string | null | undefined,
  defaultLocation: string
): { aim: Aim; called: boolean; known: boolean } {
  if (aimName) {
    const aim = aimFromName(aimName)
    if (aim) return { aim, called: !['random', 'chinksOther', 'limb', 'extremity'].includes(aim.target), known: true }
    // A location GUHL doesn't know (a tail, a wing): resolved on the actor's own table (known: false).
    return { aim: { target: 'chest' }, called: true, known: false }
  }
  return { aim: { target: defaultLocation === 'Random' ? 'random' : 'chest' }, called: false, known: true }
}

export interface ResolveHitsInput {
  system: 'guhl' | 'standard'
  aim: Aim
  aimName: string | null
  called: boolean
  attack: AttackType
  facing: Facing
  damages: number[]
  /** Recorded dice per hit (filled in as new dice are rolled). */
  dice: Record<string, number>[]
  coverDice: Record<string, number>[]
  fresh: Roller
  body: BodyInfo
  cover: CoverData | null
  armorDivisor: number
  applied?: boolean[]
}

/** Resolve every hit: location (GUHL or the actor's table), body-plan name, then cover in order. */
export function resolveHits(p: ResolveHitsInput): HitEntry[] {
  let hp = p.cover?.hp ?? null
  return p.damages.map((damage, index) => {
    const dice = (p.dice[index] ??= {})
    const coverDice = (p.coverDice[index] ??= {})
    const roll = replayRoller(dice, p.fresh)

    const result =
      p.system === 'guhl'
        ? resolveHit(p.aim, { attack: p.attack, facing: p.facing, roll })
        : resolveStandard(p.aim, p.aimName, p.body.table, roll)
    const where = p.system === 'guhl' ? mapToBody(result, p.body.wheres, p.body.localize) : result.bodyKeys[0]

    const cover = p.cover
      ? resolveCoverHit({
          cover: p.cover,
          hp,
          zone: result.zone,
          called: p.called,
          damage,
          armorDivisor: p.armorDivisor,
          roll: replayRoller(coverDice, p.fresh),
        })
      : null
    if (cover) hp = cover.hpAfter

    return {
      index,
      damage,
      dice,
      coverDice,
      result,
      where,
      cover,
      finalDamage: cover ? cover.through : damage,
      applied: !!p.applied?.[index],
    }
  })
}

export const effectiveFacing = (card: Pick<HitCardFlag, 'facingAuto' | 'facingOverride'>): Facing =>
  card.facingOverride ?? card.facingAuto

/** Cover HP after the whole attack, or null if nothing changed. */
export function coverHpAfter(card: Pick<HitCardFlag, 'cover' | 'hits'>): number | null {
  if (!card.cover || card.cover.hp === null) return null
  const last = [...card.hits].reverse().find(hit => hit.cover?.hitsCover)
  return last?.cover?.hpAfter ?? null
}

/** Re-resolve after the GM changes the facing: same dice, applied hits keep their state. */
export function withFacing(card: HitCardFlag, facing: Facing | null, body: BodyInfo, fresh: Roller): HitCardFlag {
  const next = { ...card, facingOverride: facing }
  const hits = resolveHits({
    system: card.system,
    aim: card.aim,
    aimName: card.aimName,
    called: card.called,
    attack: card.attack,
    facing: effectiveFacing(next),
    damages: card.hits.map(hit => hit.damage),
    dice: card.hits.map(hit => ({ ...hit.dice })),
    coverDice: card.hits.map(hit => ({ ...hit.coverDice })),
    fresh,
    body,
    cover: card.cover,
    armorDivisor: card.armorDivisor,
    applied: card.hits.map(hit => hit.applied),
  })
  return { ...next, hits }
}

export function markApplied(card: HitCardFlag, indexes: number[]): HitCardFlag {
  const set = new Set(indexes)
  if (!card.hits.some(hit => set.has(hit.index) && !hit.applied)) return card
  return { ...card, hits: card.hits.map(hit => (set.has(hit.index) ? { ...hit, applied: true } : hit)) }
}

/** Hits Apply all would apply: not yet applied, with damage left after cover. */
export function pendingHits(card: HitCardFlag): HitEntry[] {
  return card.hits.filter(hit => !hit.applied && hit.finalDamage > 0)
}

/* ---------------------------------------- */
/*  View                                     */
/* ---------------------------------------- */

export type Translate = (key: string, data?: Record<string, unknown>) => string

/** "Leg (Left) › Thigh › Vein/Artery". */
export function pathText(path: PathSegment[], t: Translate): string {
  return path
    .map(segment => {
      if (segment.raw) return segment.raw
      const part = t(`${L}.loc.${segment.key}`)
      return segment.side ? t(`${L}.withSide`, { part, side: t(`${L}.side.${segment.side}`) }) : part
    })
    .join(' › ')
}

export function noteTexts(result: HitResult, t: Translate, torsoCap: string): string[] {
  return result.notes
    .filter(id => id !== 'torsoCap' || torsoCap !== 'none')
    .map(id => t(`${L}.note.${id}`, { cap: torsoCap }))
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n))

/** One-line rules summary: multiplier, DR changes, bleeding. */
export function summaryText(result: HitResult, attack: AttackType, t: Translate): string {
  const parts: string[] = []
  if (result.multiplier !== null)
    parts.push(t(`${L}.card.multiplier`, { multiplier: result.multiplier, type: attackLabel(attack) }))
  if (result.armorGap) parts.push(t(`${L}.card.armorGap`))
  else if (result.halveDR) parts.push(t(`${L}.card.halfDR`))
  if (result.extraDR) parts.push(t(`${L}.card.extraDR`, { dr: result.extraDR }))
  if (result.bleedModifier || result.bleedFast)
    parts.push(
      t(result.bleedFast ? `${L}.card.bleedFast` : `${L}.card.bleed`, { modifier: sign(result.bleedModifier) })
    )
  return parts.join(' · ')
}

export function attackLabel(attack: AttackType): string {
  if (attack.type === 'burn' && attack.tightBeam) return 'burn (tb)'
  return attack.type === 'other' ? '' : attack.type
}

function diceText(result: HitResult, coverRoll: number | null): string {
  const parts = result.rolls.map(r => `${r.dice}d6 ${r.value}`)
  if (coverRoll !== null) parts.push(`1d6 ${coverRoll}`)
  return parts.join(' · ')
}

function coverText(cover: CoverOutcome | null, t: Translate): { text: string; cls: string } {
  if (!cover || cover.state === 'exposed') return { text: '', cls: '' }
  if (!cover.hitsCover) {
    return cover.roll !== null
      ? { text: t(`${L}.card.coverMissed`, { roll: cover.roll }), cls: 'is-exposed' }
      : { text: t(`${L}.card.coverAimed`), cls: 'is-exposed' }
  }
  const lines = [t(`${L}.card.coverHit`, { dr: cover.coverDR, absorbed: cover.absorbed, through: cover.through })]
  if (cover.hpBefore !== null && cover.hpAfter !== null)
    lines.push(t(`${L}.card.coverHp`, { before: cover.hpBefore, after: Math.max(0, cover.hpAfter) }))
  if (cover.destroyed) lines.push(t(`${L}.card.coverDestroyed`))
  return { text: lines.join(' '), cls: cover.through > 0 ? 'is-through' : 'is-stopped' }
}

export function coverSummary(cover: CoverData | null, t: Translate): string {
  if (!cover) return ''
  const parts = [t(`${L}.cover.preset.${cover.preset}`), t(`${L}.card.coverDR`, { dr: cover.dr })]
  if (cover.hp !== null) parts.push(t(`${L}.card.coverHpNow`, { hp: cover.hp, max: cover.hpMax ?? cover.hp }))
  if (cover.material) parts.push(cover.material)
  return parts.join(' · ')
}

export interface CardViewOptions {
  torsoCap: string
  /** The viewer may apply damage (shows the buttons). */
  canApply: boolean
  /** The viewer may change the facing. */
  canEditFacing: boolean
  /** Localized label of the attack's hit-location modifier. */
  aimLabel: string
}

export function cardView(card: HitCardFlag, t: Translate, opts: CardViewOptions): Record<string, unknown> {
  const facing = effectiveFacing(card)
  const hits = card.hits.map(hit => {
    const cover = coverText(hit.cover, t)
    const stopped = !!hit.cover?.hitsCover && hit.finalDamage <= 0
    return {
      index: hit.index,
      number: hit.index + 1,
      path: pathText(hit.result.path, t),
      summary: summaryText(hit.result, card.attack, t),
      notes: noteTexts(hit.result, t, opts.torsoCap),
      invalid: hit.result.invalid
        ? t(`${L}.card.invalid.${hit.result.invalid.reason}`, {
            target: t(`${L}.loc.target.${hit.result.invalid.target}`),
          })
        : '',
      noBody: hit.where === null ? t(`${L}.card.noBodyLocation`) : '',
      dice: diceText(hit.result, hit.cover?.roll ?? null),
      cover: cover.text,
      coverCls: cover.cls,
      damage: hit.damage,
      finalDamage: hit.finalDamage,
      reduced: hit.finalDamage !== hit.damage,
      applied: hit.applied,
      stopped,
      canApply: opts.canApply && !hit.applied && hit.finalDamage > 0,
    }
  })

  return {
    title: t(`${L}.card.title`, { attacker: card.attacker.name, target: card.target.name }),
    systemLabel: t(`${L}.card.system.${card.system}`),
    weapon: card.weapon,
    damageText: card.damageText,
    aimText: card.aimName
      ? t(`${L}.card.called`, { location: opts.aimLabel || card.aimName })
      : t(card.aim.target === 'random' ? `${L}.card.randomLocation` : `${L}.card.defaultLocation`),
    facing,
    facingText: t(`${L}.card.facing`, { facing: t(`${L}.facing.${facing}`) }),
    facingOverridden: card.facingOverride !== null,
    canEditFacing: opts.canEditFacing && !card.hits.some(hit => hit.applied),
    facingOptions: (['auto', 'front', 'side', 'rear'] as const).map(value => ({
      value,
      label:
        value === 'auto'
          ? t(`${L}.card.facingAuto`, { facing: t(`${L}.facing.${card.facingAuto}`) })
          : t(`${L}.facing.${value}`),
      selected: value === 'auto' ? card.facingOverride === null : card.facingOverride === value,
    })),
    coverText: coverSummary(card.cover, t),
    hits,
    canApplyAll: opts.canApply && pendingHits(card).length > 1,
    allDone: card.hits.every(hit => hit.applied || hit.finalDamage <= 0),
    labels: {
      number: t(`${L}.card.col.number`),
      location: t(`${L}.card.col.location`),
      cover: t(`${L}.card.col.cover`),
      damage: t(`${L}.card.col.damage`),
      apply: t(`${L}.card.apply`),
      applyAll: t(`${L}.card.applyAll`),
      applied: t(`${L}.card.applied`),
      stopped: t(`${L}.card.stopped`),
      done: t(`${L}.card.done`),
      facingLabel: t(`${L}.card.facingLabel`),
    },
  }
}
