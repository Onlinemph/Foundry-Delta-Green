/**
 * Photo sizes, storage budget, framing and the burner's cheap-sensor look. Pure: works on numbers and
 * pixel arrays, so it can be tested without a canvas.
 *
 * Storage. A user allowed to upload files (Foundry's "Upload new files" permission) gets photos written
 * to worlds/<world>/agency-phone/ as JPEG files; only the path goes into flags and messages. Anyone
 * else gets an inline data: URL, which lives inside the actor document (gallery) or chat message
 * (attachment) and is sent to every client with it, so inline photos are smaller and capped:
 *   smartphone file    1024 x 768 JPEG q0.85   (~150-300 KB on disk, nothing in the document)
 *   smartphone inline   640 x 480 JPEG q0.6    (~35-60 KB)
 *   burner (both)       320 x 240 JPEG q0.7    (~12-25 KB; it's a 0.1-megapixel camera anyway)
 * and a device keeps at most INLINE_BUDGET bytes of inline photos (about 25-40 smartphone shots).
 * Past that the camera reports "Storage full" until photos are deleted. A message attachment over
 * INLINE_ATTACHMENT_MAX is refused for the same reason.
 */
import type { DeviceKind, Photo } from './types.ts'

export interface PhotoSpec {
  width: number
  height: number
  quality: number
  mime: 'image/jpeg'
}

export const PHOTO_SPECS: Record<DeviceKind, { file: PhotoSpec; inline: PhotoSpec }> = {
  smartphone: {
    file: { width: 1024, height: 768, quality: 0.85, mime: 'image/jpeg' },
    inline: { width: 640, height: 480, quality: 0.6, mime: 'image/jpeg' },
  },
  burner: {
    file: { width: 320, height: 240, quality: 0.7, mime: 'image/jpeg' },
    inline: { width: 320, height: 240, quality: 0.7, mime: 'image/jpeg' },
  },
}

/** Inline (data URL) photos per device. */
export const INLINE_BUDGET = 1_500_000
/** Largest inline image a message may carry. */
export const INLINE_ATTACHMENT_MAX = 200_000
/** Most photos a gallery keeps, inline or not. */
export const GALLERY_MAX = 120

export function photoSpec(kind: DeviceKind, canUpload: boolean): PhotoSpec {
  return canUpload ? PHOTO_SPECS[kind].file : PHOTO_SPECS[kind].inline
}

/** Decoded size of a data: URL (0 for paths). */
export function dataUrlBytes(src: string): number {
  if (!src.startsWith('data:')) return 0
  const comma = src.indexOf(',')
  const body = comma >= 0 ? src.slice(comma + 1) : ''
  if (!src.slice(0, comma).includes(';base64')) return body.length
  const pad = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  return Math.floor((body.length * 3) / 4) - pad
}

export function inlineBytes(gallery: Photo[]): number {
  return gallery.reduce((n, p) => n + (p.bytes || dataUrlBytes(p.src)), 0)
}

export type StoreCheck = { ok: true } | { ok: false; reason: 'full' | 'count' }

export function canStore(gallery: Photo[], bytes: number, budget = INLINE_BUDGET, max = GALLERY_MAX): StoreCheck {
  if (gallery.length >= max) return { ok: false, reason: 'count' }
  if (bytes > 0 && inlineBytes(gallery) + bytes > budget) return { ok: false, reason: 'full' }
  return { ok: true }
}

/** Percentage of the inline budget used (for the Photos header). */
export function storageUsed(gallery: Photo[], budget = INLINE_BUDGET): number {
  return Math.min(100, Math.round((inlineBytes(gallery) / budget) * 100))
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The part of the rendered screen to keep: a box of the output's aspect ratio centred on the token's
 * screen position, `span` screen pixels wide, clamped to the screen (a token near the edge of the scene
 * can't be centred, so the frame slides instead).
 */
export function cropRect(
  center: { x: number; y: number },
  screen: { w: number; h: number },
  span: number,
  aspect: number
): Rect {
  let w = Math.max(1, Math.min(span, screen.w))
  let h = w / aspect
  if (h > screen.h) {
    h = screen.h
    w = h * aspect
  }
  const x = Math.min(Math.max(center.x - w / 2, 0), Math.max(0, screen.w - w))
  const y = Math.min(Math.max(center.y - h / 2, 0), Math.max(0, screen.h - h))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * Zoom for a photo: the frame should cover `gridSpan` grid squares across `outWidth` pixels, within
 * Foundry's zoom limits and so that the frame fits on screen.
 */
export function captureScale(
  gridSize: number,
  gridSpan: number,
  outWidth: number,
  screenW: number,
  minZoom = 0.1,
  maxZoom = 3
): number {
  const wanted = outWidth / Math.max(1, gridSize * gridSpan)
  const fit = (screenW * 0.95) / Math.max(1, gridSize * gridSpan)
  return Math.max(minZoom, Math.min(maxZoom, wanted, fit))
}

/** Deterministic PRNG for film grain (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

/**
 * The burner's sensor: washed-out contrast, lifted blacks, a green cast, 5-bit colour and grain.
 * In place on RGBA data.
 */
export function burnerFilter(data: Uint8ClampedArray, seed = 1): void {
  const rand = prng(seed)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    // Desaturate by 45%, squash contrast, lift blacks, tint green.
    const mix = (c: number) => c * 0.55 + luma * 0.45
    const grain = (rand() - 0.5) * 22
    let nr = mix(r) * 0.78 + 34 + grain
    let ng = mix(g) * 0.84 + 44 + grain
    let nb = mix(b) * 0.7 + 30 + grain
    // 5 bits per channel.
    nr = Math.round(clamp8(nr) / 8) * 8
    ng = Math.round(clamp8(ng) / 8) * 8
    nb = Math.round(clamp8(nb) / 8) * 8
    data[i] = clamp8(nr)
    data[i + 1] = clamp8(ng)
    data[i + 2] = clamp8(nb)
  }
}

/** 4x4 Bayer matrix for ordered dithering. */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

/**
 * Map RGBA pixels to a palette of shades (dark -> light) with ordered dithering. Returns indexes into
 * the palette. Used to show photos on the burner's 4-shade screen. The luminance range is stretched
 * first (2nd to 98th percentile), so a night shot still reads on four shades.
 */
export function ditherShades(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  shades: number,
  stretch = true
): Uint8Array {
  const out = new Uint8Array(w * h)
  const steps = Math.max(1, shades - 1)
  const lumas = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++)
    lumas[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255
  let lo = 0
  let hi = 1
  if (stretch && lumas.length) {
    const sorted = Float32Array.from(lumas).sort()
    lo = sorted[Math.floor(sorted.length * 0.02)]
    hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))]
    if (hi - lo < 0.08) {
      lo = Math.max(0, lo - 0.04)
      hi = Math.min(1, hi + 0.04)
    }
  }
  const range = Math.max(1e-3, hi - lo)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const norm = Math.pow(Math.min(1, Math.max(0, (lumas[p] - lo) / range)), 0.85)
      const threshold = (BAYER4[(y % 4) * 4 + (x % 4)] + 0.5) / 16 - 0.5
      const v = Math.round(norm * steps + threshold)
      out[p] = Math.max(0, Math.min(steps, v))
    }
  }
  return out
}
