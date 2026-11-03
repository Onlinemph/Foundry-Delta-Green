/**
 * Foundry-facing helpers for hit locations: reading the defender's body plan, facing from tokens,
 * dice, and labels. Typed loosely: the GURPS actor is untyped upstream JS.
 */
import { flattenList } from '../firearms/ammo.ts'
import { innateDR, isGuhlBody, type BodyLocation } from './body.ts'
import type { BodyInfo, Translate } from './card.ts'
import { uniformRoller } from './engine.ts'
import { facingArc, type GridKind } from './facing.ts'
import { artFacing } from './settings.ts'
import type { Facing, Roller } from './types.ts'

export type AnyActor = any
export type AnyTokenDoc = any

export const t: Translate = (key, data) => {
  const i18n = game.i18n as any
  return data ? i18n.format(key, data) : i18n.localize(key)
}

/** Localized upstream label of a hit-location name ("GURPS.hitLocation<name>"), or the name. */
export function locationLabel(name: string): string {
  const key = `GURPS.hitLocation${name}`
  const text = t(key)
  return text === key ? name : text
}

/** Dice from Foundry's own random source (the one its dice use). */
export function liveRoller(): Roller {
  const uniform = (CONFIG as any).Dice?.randomUniform ?? Math.random
  return uniformRoller(() => uniform())
}

/** The defender's hit locations: names, roll table and a localizer for matching translated names. */
export function bodyInfo(actor: AnyActor): BodyInfo & { bodyplan: string; guhl: boolean } {
  let entries: any[] = []
  try {
    entries = actor?.hitLocationsWithDR ?? []
  } catch {
    entries = Object.values(actor?.system?.hitlocations ?? {})
  }
  const table: BodyLocation[] = entries
    .filter(e => e?.where)
    .map(e => ({ where: String(e.where), roll: Array.isArray(e.roll) ? e.roll.map(Number) : [] }))
  const wheres = table.map(e => e.where)
  const bodyplan = String(actor?.system?.additionalresources?.bodyplan ?? '')
  return {
    wheres,
    table,
    bodyplan,
    guhl: isGuhlBody(bodyplan, wheres),
    localize: (name: string) => locationLabel(name),
  }
}

/** DR at one of the actor's locations against a damage type. */
export function locationDR(actor: AnyActor, where: string | null, damageType: string): number {
  if (!where) return 0
  try {
    const entry = (actor?.hitLocationsWithDR ?? []).find((e: any) => e.where === where)
    const dr = entry?.getDR ? entry.getDR(damageType) : entry?.dr
    return Number(dr) || 0
  } catch {
    return 0
  }
}

/** Upstream's role for a location on the actor's body plan (limb, extremity, chest, groin). */
export function locationRole(actor: AnyActor, where: string | null): any {
  if (!where) return null
  try {
    return actor?._hitLocationRolls?.[where]?.role ?? null
  } catch {
    return null
  }
}

export function actorInnateDR(actor: AnyActor): number {
  const traits = flattenList<any>(actor?.system?.ads, '').map(e => ({ name: e.value?.name, level: e.value?.level }))
  return innateDR(traits)
}

/** The actor's torso location name, if it has one. */
export function torsoWhere(info: BodyInfo): string | null {
  return info.wheres.find(w => /^(torso|chest)$/i.test(w)) ?? null
}

function gridKind(): GridKind {
  const grid = (canvas as any)?.grid
  if (grid?.isHexagonal) return 'hex'
  if (grid?.isSquare) return 'square'
  return 'gridless'
}

function center(doc: AnyTokenDoc): { x: number; y: number } | null {
  const obj = doc?.object
  if (obj?.center) return { x: obj.center.x, y: obj.center.y }
  const size = (canvas as any)?.grid?.size ?? (canvas as any)?.dimensions?.size ?? 100
  if (typeof doc?.x !== 'number') return null
  return { x: doc.x + ((doc.width ?? 1) * size) / 2, y: doc.y + ((doc.height ?? 1) * size) / 2 }
}

/** Attacker's arc relative to the target token's facing; 'front' when unknown or turned off. */
export function facingBetween(attackerDoc: AnyTokenDoc | null, targetDoc: AnyTokenDoc | null): Facing {
  const art = artFacing()
  if (!art || !attackerDoc || !targetDoc) return 'front'
  if (attackerDoc.parent?.id && targetDoc.parent?.id && attackerDoc.parent.id !== targetDoc.parent.id) return 'front'
  const a = center(attackerDoc)
  const b = center(targetDoc)
  if (!a || !b) return 'front'
  return facingArc({ attacker: a, target: b, rotation: Number(targetDoc.rotation) || 0, art, grid: gridKind() })
}

/** A token of the actor on the current scene (its own token for a synthetic actor). */
export function tokenDocOf(actor: AnyActor): AnyTokenDoc | null {
  if (!actor) return null
  if (actor.token) return actor.token
  const tokens = actor.getActiveTokens?.(false, true) ?? []
  return tokens[0] ?? null
}
