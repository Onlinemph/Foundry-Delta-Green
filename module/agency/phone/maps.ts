/**
 * Maps app geometry. A scene's map is off (the default: a building interior shouldn't draw itself),
 * the scene's background image, or a custom image. Either image is taken to cover the scene's
 * rectangle (the area inside the padding), which is how Foundry lays out a background.
 *
 * The map fills the phone's screen at zoom 1 ("cover"), and zooms up to MAP_MAX_ZOOM. A view is the
 * zoom plus the map point (as fractions 0-1) at the centre of the screen.
 */
import type { MapMode } from './types.ts'

export function mapMode(flag: unknown): MapMode {
  return flag === 'background' || flag === 'custom' ? flag : 'off'
}

export function mapSource(
  mode: MapMode,
  background: string | null | undefined,
  custom: string | null | undefined
): string | null {
  if (mode === 'background') return background || null
  if (mode === 'custom') return custom || null
  return null
}

export interface SceneRect {
  x: number
  y: number
  width: number
  height: number
}

/** The token's centre as a fraction of the map (0-1 each way), or null when it's off the map. */
export function dotPosition(center: { x: number; y: number }, rect: SceneRect): { u: number; v: number } | null {
  if (!(rect.width > 0 && rect.height > 0)) return null
  const u = (center.x - rect.x) / rect.width
  const v = (center.y - rect.y) / rect.height
  if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) return null
  return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) }
}

export interface MapView {
  zoom: number
  cx: number
  cy: number
}

export interface MapGeometry {
  /** Viewport size in px. */
  vw: number
  vh: number
  /** Map aspect (width / height). */
  aspect: number
}

export const MAP_MIN_ZOOM = 1
export const MAP_MAX_ZOOM = 6

/** Size of the map layer in px at a zoom. */
export function layerSize(g: MapGeometry, zoom: number): { w: number; h: number } {
  const aspect = g.aspect > 0 ? g.aspect : 1
  // Cover: the smaller scale that still fills both dimensions.
  const base = Math.max(g.vw / aspect, g.vh)
  return { w: base * aspect * zoom, h: base * zoom }
}

export function clampView(view: MapView, g: MapGeometry): MapView {
  const zoom = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, Number(view.zoom) || 1))
  const { w, h } = layerSize(g, zoom)
  const clamp = (c: number, view: number, layer: number) => {
    const half = view / 2 / layer
    return half >= 0.5 ? 0.5 : Math.min(1 - half, Math.max(half, Number.isFinite(c) ? c : 0.5))
  }
  return { zoom, cx: clamp(view.cx, g.vw, w), cy: clamp(view.cy, g.vh, h) }
}

/** Zoom keeping the map point under viewport pixel (px, py) still. */
export function zoomAt(view: MapView, g: MapGeometry, factor: number, px = g.vw / 2, py = g.vh / 2): MapView {
  const before = layerSize(g, view.zoom)
  const mx = view.cx + (px - g.vw / 2) / before.w
  const my = view.cy + (py - g.vh / 2) / before.h
  const zoom = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, view.zoom * factor))
  const after = layerSize(g, zoom)
  return clampView({ zoom, cx: mx - (px - g.vw / 2) / after.w, cy: my - (py - g.vh / 2) / after.h }, g)
}

/** Drag by (dx, dy) px. */
export function panBy(view: MapView, g: MapGeometry, dx: number, dy: number): MapView {
  const { w, h } = layerSize(g, view.zoom)
  return clampView({ ...view, cx: view.cx - dx / w, cy: view.cy - dy / h }, g)
}

/** Where to put the map layer: its size and top-left offset in px. */
export function layerPlacement(view: MapView, g: MapGeometry): { left: number; top: number; w: number; h: number } {
  const { w, h } = layerSize(g, view.zoom)
  return { left: g.vw / 2 - view.cx * w, top: g.vh / 2 - view.cy * h, w, h }
}

/** A view centred on the dot (or the middle of the map). */
export function centredView(g: MapGeometry, dot: { u: number; v: number } | null, zoom = 1.6): MapView {
  return clampView({ zoom, cx: dot?.u ?? 0.5, cy: dot?.v ?? 0.5 }, g)
}
