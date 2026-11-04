/**
 * Photos on the burner's LCD: load once, scale to the box (cover), dither to the four shades, cache.
 * Browser-only (Image + canvas), no Foundry.
 */
import { ditherShades } from '../photos.ts'
import type { ImageLevels } from './burner-draw.ts'

export function createImageLevels(onLoad: () => void, maxEntries = 64): ImageLevels {
  const images = new Map<string, HTMLImageElement | 'error'>()
  const levels = new Map<string, Uint8Array>()

  function load(src: string): HTMLImageElement | null {
    const known = images.get(src)
    if (known === 'error') return null
    if (known) return known.complete && known.naturalWidth ? known : null
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => onLoad()
    img.onerror = () => images.set(src, 'error')
    img.src = src
    images.set(src, img)
    if (images.size > maxEntries) images.delete(images.keys().next().value as string)
    return null
  }

  return (src, w, h) => {
    const key = `${src}|${w}x${h}`
    const cached = levels.get(key)
    if (cached) return cached
    const img = load(src)
    if (!img) return null
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    // Cover the box.
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
    // Lift contrast a little so the 4 shades carry the picture.
    const data = ctx.getImageData(0, 0, w, h).data
    const out = ditherShades(data, w, h, 4)
    levels.set(key, out)
    if (levels.size > maxEntries * 2) levels.delete(levels.keys().next().value as string)
    return out
  }
}

/** Paint an Lcd buffer onto its canvas. */
export function blitLcd(canvas: HTMLCanvasElement, rgba: Uint8ClampedArray, w: number, h: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0)
}
