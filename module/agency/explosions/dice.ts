/**
 * Dice for the explosion engine. Every roll goes through an injected random source, so the
 * Foundry side passes Foundry's own generator and tests pass a seeded or scripted one.
 */
import type { DiceExpr } from './parse.ts'

/** A random number in [0, 1). */
export type Rng = () => number

/** mulberry32: a small, fast, seedable generator for tests and reproducible rolls. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Replays fixed d6 faces (1-6) in order, then repeats the last one. For tests. */
export function scriptedRng(faces: number[]): Rng {
  let i = 0
  return () => {
    const face = faces[Math.min(i, faces.length - 1)] ?? 1
    i++
    return (Math.min(6, Math.max(1, face)) - 1) / 6 + 1e-9
  }
}

export function rollD6(rng: Rng): number {
  return Math.min(6, Math.floor(rng() * 6) + 1)
}

export function roll3d6(rng: Rng): number {
  return rollD6(rng) + rollD6(rng) + rollD6(rng)
}

export interface DiceRoll {
  /** Final value: (dice + adds) × multiplier, after the minimum. */
  total: number
  faces: number[]
}

/**
 * Damage minimum (B378): a negative modifier can't take crushing damage below 0, or any other
 * damage type below 1.
 */
export function damageMinimum(type: string): number {
  return type === 'cr' || type === '' ? 0 : 1
}

/** Roll damage dice: "6d×2" rolls 6d and doubles it (B378). */
export function rollDamage(expr: DiceExpr, rng: Rng, type = ''): DiceRoll {
  const faces = Array.from({ length: Math.max(0, expr.dice) }, () => rollD6(rng))
  const sum = faces.reduce((a, b) => a + b, 0) + expr.adds
  const minimum = expr.dice > 0 || expr.adds !== 0 ? damageMinimum(type) : 0
  return { total: Math.max(minimum, sum) * expr.multiplier, faces }
}

/** Maximum possible damage (contact explosions, B415). */
export function maxDamage(expr: DiceExpr): number {
  return Math.max(0, expr.dice * 6 + expr.adds) * expr.multiplier
}

/** Average damage, for display. */
export function averageDamage(expr: DiceExpr): number {
  return Math.max(0, expr.dice * 3.5 + expr.adds) * expr.multiplier
}
