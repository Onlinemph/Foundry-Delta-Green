/**
 * Canvas and scene helpers: distances in yards, walls between two points, token facts for the
 * explosion engine, templates, and picking a point on the map. Foundry-only (not unit tested).
 */
import { Length } from '../../data/common/index.js'
import { offsetPoint, type Point } from './command-parse.ts'
import type { Rng } from './dice.ts'
import { largeAreaDR, wallCoverDR, type Posture } from './rules.ts'
import type { TargetFacts } from './resolve.ts'
import { afflictionBonus, type SpecialMatch } from './specials.ts'

/** Foundry's own generator (so rolls behave like every other roll in the game). */
export function foundryRng(): Rng {
  const uniform = (CONFIG as any)?.Dice?.randomUniform
  return typeof uniform === 'function' ? () => uniform() : Math.random
}

export function sceneOf(sceneId: string | null | undefined): any {
  return (sceneId ? (game.scenes as any)?.get(sceneId) : null) ?? canvas?.scene ?? null
}

function onCanvas(scene: any): boolean {
  return !!scene && canvas?.scene?.id === scene.id && !!canvas?.grid
}

/** Yards per scene grid unit ("yd" = 1, "m" ≈ 1.09, "ft" = 1/3), the way upstream's ruler converts. */
export function yardsPerUnit(scene: any = canvas?.scene): number {
  const units = String(scene?.grid?.units ?? 'yd')
  try {
    const value = (Length as any).from(1, units)?.to((Length as any).Unit.Yard)?.value
    if (Number.isFinite(value) && value > 0) return value
  } catch {
    /* unknown unit */
  }
  return 1
}

/** Canvas pixels per grid unit. */
function pixelsPerUnit(scene: any): number {
  if (onCanvas(scene)) {
    const d: any = canvas!.dimensions
    if (d?.distancePixels) return d.distancePixels
    if (d?.size && d?.distance) return d.size / d.distance
  }
  const size = Number(scene?.grid?.size) || 100
  const distance = Number(scene?.grid?.distance) || 1
  return size / distance
}

export function pixelsPerYard(scene: any = canvas?.scene): number {
  return pixelsPerUnit(scene) / yardsPerUnit(scene)
}

/**
 * Grid distance between two points in whole yards (B414 works in yards; on gridless scenes the
 * distance is rounded to the nearest yard). Uses the grid's own measurement (diagonal rules) when the
 * scene is on the canvas.
 */
export function measureYards(a: Point, b: Point, scene: any = canvas?.scene): number {
  let units: number | null = null
  if (onCanvas(scene)) {
    try {
      units = (canvas!.grid as any).measurePath([a, b]).distance
    } catch {
      units = null
    }
  }
  if (units === null || !Number.isFinite(units)) units = Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerUnit(scene)
  return Math.max(0, Math.round(units * yardsPerUnit(scene)))
}

export function snapToGrid(point: Point): Point {
  try {
    const grid: any = canvas?.grid
    if (!grid || grid.isGridless) return point
    return grid.getCenterPoint(point)
  } catch {
    return point
  }
}

export function tokenCenter(token: any): Point {
  const placeable = token?.object ?? token
  if (placeable?.center) return { x: placeable.center.x, y: placeable.center.y }
  const doc = token?.document ?? token
  const size = Number(doc?.parent?.grid?.size ?? canvas?.grid?.size ?? 100)
  return { x: doc.x + (doc.width * size) / 2, y: doc.y + (doc.height * size) / 2 }
}

/**
 * Walls between two points that block movement (closed doors included, open doors not), with each
 * wall's cover DR: flags.gurps.agency.coverDR on the wall, else the setting's default (B558).
 */
export function wallsBetween(
  a: Point,
  b: Point,
  defaultDR: number,
  scene: any = canvas?.scene
): { walls: number; drs: number[] } {
  if (!onCanvas(scene)) return { walls: 0, drs: [] }
  try {
    const backend = (CONFIG as any).Canvas?.polygonBackends?.move
    const hits: any[] = backend?.testCollision?.(a, b, { type: 'move', mode: 'all' }) ?? []
    const walls = new Map<string, any>()
    let unknown = 0
    for (const vertex of hits ?? []) {
      const edges: any[] = Array.from(vertex?.edges ?? [])
      const found = edges.map(e => e?.object).filter(o => o?.document?.documentName === 'Wall')
      if (!found.length) unknown++
      for (const wall of found) walls.set(wall.id ?? wall.document.id, wall)
    }
    const drs = [...walls.values()].map(wall => {
      const dr = Number(wall.document?.getFlag?.('gurps', 'agency.coverDR'))
      return Number.isFinite(dr) && dr >= 0 ? dr : defaultDR
    })
    for (let i = 0; i < unknown; i++) drs.push(defaultDR)
    return { walls: drs.length, drs }
  } catch (err) {
    console.warn('GURPS | Agency | explosions: wall collision test failed', err)
    return { walls: 0, drs: [] }
  }
}

const DOWN_STATUSES = ['prone', 'kneel', 'crouch', 'sit', 'crawl']

export function postureOf(actor: any): Posture {
  return DOWN_STATUSES.some(s => actor?.statuses?.has?.(s)) ? 'down' : 'standing'
}

/** Names of the actor's advantages and disadvantages, nested ones included. */
export function traitNames(actor: any): string[] {
  const names: string[] = []
  const walk = (list: any) => {
    for (const entry of Object.values(list ?? {}) as any[]) {
      if (entry?.name) names.push(String(entry.name))
      walk(entry?.contains)
      walk(entry?.collapsed)
    }
  }
  walk(actor?.system?.ads)
  return names
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(String(value ?? '').replace(/^\+/, ''))
  return Number.isFinite(n) ? n : fallback
}

export function torsoDR(actor: any): number {
  const entries: any[] = actor?.hitLocationsWithDR ?? []
  const torso = entries.find(e => e.where === 'Torso') ?? entries.find(e => /chest|torso/i.test(String(e.where)))
  return numberOr(torso?.dr, 0)
}

/**
 * Partial cover from the hit-location feature: flags.gurps.agency.cover on the token. Assumed shape:
 * { locations: string[] (body parts behind cover), dr: number }. Anything else is ignored.
 */
function partialCover(tokenDoc: any): { locations: string[]; dr: number } | null {
  const cover = tokenDoc?.getFlag?.('gurps', 'agency.cover') ?? tokenDoc?.flags?.gurps?.agency?.cover
  const locations = cover?.locations ?? cover?.covered
  if (!Array.isArray(locations) || !locations.length) return null
  return { locations: locations.map(String), dr: Math.max(0, numberOr(cover?.dr, 0)) }
}

export function tokenFacts(
  tokenDoc: any,
  center: Point,
  opts: { struck: boolean; walls: boolean; wallDR: number; airburst: boolean; special: SpecialMatch; scene: any }
): TargetFacts {
  const actor = tokenDoc.actor
  const at = tokenCenter(tokenDoc)
  const distance = opts.struck ? 0 : measureYards(center, at, opts.scene)
  const walls = opts.walls && !opts.struck ? wallsBetween(center, at, opts.wallDR, opts.scene) : { walls: 0, drs: [] }
  const st = numberOr(actor?.system?.attributes?.ST?.value, NaN)
  return {
    id: tokenDoc.id,
    name: tokenDoc.name ?? actor?.name ?? '?',
    distance,
    struck: opts.struck,
    posture: postureOf(actor),
    sizeModifier: numberOr(actor?.system?.traits?.sizemod, 0),
    st: Number.isFinite(st) ? st : null,
    hp: numberOr(actor?.system?.HP?.max, 10),
    ht: numberOr(actor?.system?.attributes?.HT?.value, 10),
    torsoDR: torsoDR(actor),
    wallDR: wallCoverDR(walls.drs, opts.airburst),
    walls: walls.walls,
    afflictionBonus: afflictionBonus(opts.special, traitNames(actor)),
    partialCover: partialCover(tokenDoc),
    largeAreaDR: largeAreaDR(torsoDR(actor), exposedDRs(actor, partialCover(tokenDoc))),
  }
}

/** DR of every body location with a hit-location roll, minus those behind the token's partial cover (B400). */
function exposedDRs(actor: any, cover: { locations: string[] } | null): number[] {
  const entries: any[] = actor?.hitLocationsWithDR ?? []
  return entries
    .filter(e => (Array.isArray(e.roll) ? e.roll.length > 0 : true) && !cover?.locations.includes(String(e.where)))
    .map(e => numberOr(e.dr, 0))
}

/** Tokens with an actor within `yards` of the center (grid distance), on the given scene. */
export function tokensWithin(scene: any, center: Point, yards: number, always: string[] = []): any[] {
  const docs: any[] = Array.from(scene?.tokens ?? [])
  return docs.filter(
    doc => doc.actor && (always.includes(doc.id) || measureYards(center, tokenCenter(doc), scene) <= yards)
  )
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const TEMPLATE_COLORS = {
  blast: '#c0362c',
  fragments: '#e08a1e',
  affliction: '#e8d44d',
  smoke: '#9a9a9a',
} as const

/** Circle templates for the blast, fragment, affliction and smoke radii (yards). */
export async function placeTemplates(
  scene: any,
  center: Point,
  radii: Partial<Record<keyof typeof TEMPLATE_COLORS, number>>,
  blastId: string
): Promise<string[]> {
  if (!scene) return []
  const perUnit = yardsPerUnit(scene)
  const seen = new Set<number>()
  const data: any[] = []
  for (const key of ['blast', 'fragments', 'affliction', 'smoke'] as const) {
    const yards = radii[key] ?? 0
    if (!(yards > 0) || seen.has(yards)) continue
    seen.add(yards)
    data.push({
      t: 'circle',
      x: center.x,
      y: center.y,
      distance: yards / perUnit,
      direction: 0,
      borderColor: TEMPLATE_COLORS[key],
      fillColor: TEMPLATE_COLORS[key],
      flags: { gurps: { agency: { explosion: { id: blastId, ring: key } } } },
    })
  }
  if (!data.length) return []
  try {
    const created = await scene.createEmbeddedDocuments('MeasuredTemplate', data)
    return created.map((t: any) => t.id)
  } catch (err) {
    console.warn('GURPS | Agency | explosions: could not place templates', err)
    return []
  }
}

export async function removeTemplates(sceneId: string, ids: string[]): Promise<void> {
  const scene = sceneOf(sceneId)
  const existing = ids.filter(id => scene?.templates?.get(id))
  if (existing.length) await scene.deleteEmbeddedDocuments('MeasuredTemplate', existing)
}

/* ------------------------------------------------------------------ */
/* Picking a point                                                     */
/* ------------------------------------------------------------------ */

let picking: (() => void) | null = null

/**
 * Let the user click a point on the canvas, showing the given radii (yards) around the pointer.
 * Snaps to the grid (hold Shift to place freely). Right-click or Escape cancels (resolves null).
 */
export function pickPoint(opts: { radii: number[]; hint: string }): Promise<Point | null> {
  picking?.()
  const view: HTMLCanvasElement | undefined = (canvas as any)?.app?.view
  if (!view || !canvas?.scene) return Promise.resolve(null)
  ui.notifications?.info(opts.hint)

  return new Promise(resolve => {
    const ppy = pixelsPerYard()
    const PIXI_ = (globalThis as any).PIXI
    const layer: any = (canvas as any).controls ?? (canvas as any).interface ?? (canvas as any).stage
    const preview = PIXI_ ? new PIXI_.Graphics() : null
    if (preview && layer) layer.addChild(preview)

    const toCanvas = (event: MouseEvent, free: boolean): Point => {
      const p = (canvas as any).canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY })
      return free ? { x: p.x, y: p.y } : snapToGrid({ x: p.x, y: p.y })
    }
    const draw = (p: Point) => {
      if (!preview) return
      preview.clear()
      for (const [i, yards] of opts.radii.filter(r => r > 0).entries()) {
        preview.lineStyle(3, i === 0 ? 0xc0362c : 0xe08a1e, 0.9)
        preview.beginFill(i === 0 ? 0xc0362c : 0xe08a1e, 0.08)
        preview.drawCircle(p.x, p.y, yards * ppy)
        preview.endFill()
      }
      preview.lineStyle(2, 0xffffff, 1).drawCircle(p.x, p.y, 4)
    }

    const finish = (value: Point | null) => {
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('contextmenu', onContext, true)
      document.removeEventListener('keydown', onKey, true)
      preview?.destroy()
      picking = null
      resolve(value)
    }
    const onMove = (event: PointerEvent) => {
      if (event.target === view) draw(toCanvas(event, event.shiftKey))
    }
    const onDown = (event: PointerEvent) => {
      if (event.target !== view) return
      event.preventDefault()
      event.stopPropagation()
      if (event.button === 2) return finish(null)
      if (event.button === 0) finish(toCanvas(event, event.shiftKey))
    }
    const onContext = (event: Event) => {
      if (event.target === view) event.preventDefault()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        finish(null)
      }
    }
    document.addEventListener('pointermove', onMove, true)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('contextmenu', onContext, true)
    document.addEventListener('keydown', onKey, true)
    picking = () => finish(null)
  })
}

/** Where a scattered explosive lands (B414), snapped to the grid. */
export function scatterPoint(aim: Point, facingRadians: number, degrees: number, yards: number): Point {
  return snapToGrid(offsetPoint(aim, facingRadians, degrees, yards, pixelsPerYard()))
}

/** Stop a straight move at the first wall (for knockback). */
export function stopAtWalls(from: Point, to: Point): Point {
  try {
    const backend = (CONFIG as any).Canvas?.polygonBackends?.move
    const hit = backend?.testCollision?.(from, to, { type: 'move', mode: 'closest' })
    if (!hit) return to
    // Stop just short of the wall.
    const dx = hit.x - from.x
    const dy = hit.y - from.y
    const length = Math.hypot(dx, dy)
    if (length < 1) return from
    const back = Math.min(length, pixelsPerYard() / 2)
    return { x: hit.x - (dx / length) * back, y: hit.y - (dy / length) * back }
  } catch {
    return to
  }
}
