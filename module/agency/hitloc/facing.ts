/**
 * Facing (B386): is the attacker in the target's front, side or rear arc? Worked out from token
 * centers and the target token's rotation. Pure; the Foundry side passes coordinates in.
 */
import type { Facing } from './types.ts'

export type GridKind = 'hex' | 'square' | 'gridless'

/** Which way a token's art faces at rotation 0. Foundry's vision cone points down (south). */
export type ArtFacing = 'down' | 'up' | 'left' | 'right'

const BASE_ANGLE: Record<ArtFacing, number> = { right: 0, down: 90, left: 180, up: 270 }

/**
 * Arc limits, in degrees away from straight ahead. Hex (and gridless): the three front hexes span
 * 180 degrees, a side hex 60, the back hex 60. Square grid: three front squares (135 degrees),
 * one side square each side (45), three back squares (135).
 */
const ARCS: Record<GridKind, { front: number; side: number }> = {
  hex: { front: 90, side: 150 },
  gridless: { front: 90, side: 150 },
  square: { front: 67.5, side: 112.5 },
}

export interface FacingInput {
  attacker: { x: number; y: number }
  target: { x: number; y: number }
  /** Target token rotation in degrees (Foundry: clockwise on screen). */
  rotation: number
  art: ArtFacing
  grid: GridKind
}

/** Angle between the target's facing and the direction to the attacker, 0-180 degrees. */
export function angleOffFacing(p: FacingInput): number {
  const dx = p.attacker.x - p.target.x
  const dy = p.attacker.y - p.target.y
  // Canvas y points down, so atan2 gives clockwise-positive angles like Foundry's rotation.
  const toAttacker = (Math.atan2(dy, dx) * 180) / Math.PI
  const facing = BASE_ANGLE[p.art] + (Number(p.rotation) || 0)
  const diff = ((((toAttacker - facing) % 360) + 540) % 360) - 180
  return Math.abs(diff)
}

export function facingArc(p: FacingInput): Facing {
  if (p.attacker.x === p.target.x && p.attacker.y === p.target.y) return 'front'
  const angle = angleOffFacing(p)
  const arcs = ARCS[p.grid] ?? ARCS.hex
  const eps = 1e-6
  if (angle <= arcs.front + eps) return 'front'
  if (angle < arcs.side - eps) return 'side'
  return 'rear'
}
