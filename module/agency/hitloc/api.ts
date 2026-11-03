/**
 * Public helpers other fork features call through GURPS.agency.hitloc (the explosions feature uses
 * both: a GUHL location for each fragment, and the body parts behind a token's cover).
 */
import { mapToBody, regionOfWhere, sideOfWhere } from './body.ts'
import { coverIsActive, coverZones, normalizeCover } from './cover.ts'
import { parseAttackType, resolveHit, zoneOf } from './engine.ts'
import { bodyInfo, liveRoller } from './foundry.ts'
import { FLAG_ROOT } from '../settings.ts'
import { guhlEnabled } from './settings.ts'
import type { Facing } from './types.ts'

/** Same key as hit-card.ts COVER_FLAG; not imported from there to keep this module light. */
const COVER_FLAG = `${FLAG_ROOT}.cover`

export type RollLocationArgs = { actor: any; damageType?: string; facing?: Facing }

/**
 * A random GUHL hit location on this actor's body, as the actor's own location name.
 * Null when GUHL is off or the body plan isn't one GUHL covers (callers then use upstream's table).
 */
export function rollLocation(args: RollLocationArgs): { where: string; location: string } | null {
  if (!guhlEnabled() || !args?.actor) return null
  const info = bodyInfo(args.actor)
  if (!info.guhl) return null
  const result = resolveHit(
    { target: 'random' },
    { attack: parseAttackType(args.damageType ?? 'cr'), facing: args.facing ?? 'front', roll: liveRoller() }
  )
  const where = mapToBody(result, info.wheres, info.localize)
  return where ? { where, location: where } : null
}

/** Covered zone of one of the actor's own location names. */
export function zoneOfWhere(where: string) {
  return zoneOf(regionOfWhere(where), sideOfWhere(where))
}

/**
 * The actor's locations that are fully behind the token's cover, and the cover's DR. Half-covered
 * parts count as exposed here: an explosion reaches them around the edge.
 */
export function coveredLocations(actor: any, tokenDoc: any): { locations: string[]; dr: number } | null {
  const raw = tokenDoc?.getFlag?.('gurps', COVER_FLAG) ?? tokenDoc?.flags?.gurps?.agency?.cover
  const cover = normalizeCover(raw)
  if (!cover || !coverIsActive(cover)) return null
  const zones = coverZones(cover)
  const wheres: string[] = (actor?.hitLocationsWithDR ?? []).map((e: any) => String(e.where))
  const locations = wheres.filter(where => zones[zoneOfWhere(where)] === 'covered')
  return locations.length ? { locations, dr: Math.max(0, Number(cover.dr) || 0) } : null
}
