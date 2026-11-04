/**
 * The phone camera: a picture of what THIS client's canvas renders around the agent's token, with
 * the user's own vision, fog of war and lighting.
 *
 * How (Foundry v13, PIXI 7): pan the canvas so the token is centred at a zoom that frames the shot,
 * hide token chrome (borders, bars, nameplates, targets) and the controls layer, render one frame with
 * canvas.app.renderer.render(canvas.stage), read it back with canvas.app.renderer.extract.canvas()
 * (falling back to drawing the WebGL view in the same task), crop around the token, then restore the
 * view and the chrome. It all happens in one task, so the user never sees the jump. Panning instead of
 * rendering the stage into an off-screen texture matters: Foundry's vision and lighting masks are
 * screen-space render textures and only line up with the normal screen render.
 *
 * Output: smartphone 1024x768 (or 640x480 when stored inline), burner 320x240 drawn from a 160x120
 * frame with no smoothing (chunky pixels) and burnerFilter() (washed out, green, grainy).
 */
import { burnerFilter, captureScale, cropRect, photoSpec, type PhotoSpec } from './photos.ts'
import type { DeviceKind } from './types.ts'

export type CaptureResult = { canvas: HTMLCanvasElement } | { error: 'noToken' | 'noCanvas' }

/** Grid squares across the frame. */
const SPAN: Record<DeviceKind, number> = { smartphone: 12, burner: 10 }

const CHROME = [
  'border',
  'bars',
  'nameplate',
  'tooltip',
  'effects',
  'target',
  'targetArrows',
  'targetPips',
  'turnMarker',
  'ruler',
]

function hideChrome(): () => void {
  const hidden: { obj: any; visible: boolean }[] = []
  const hide = (obj: any) => {
    if (!obj || typeof obj.visible !== 'boolean') return
    hidden.push({ obj, visible: obj.visible })
    obj.visible = false
  }
  try {
    for (const token of (canvas as any)?.tokens?.placeables ?? []) for (const key of CHROME) hide(token?.[key])
    hide((canvas as any)?.controls)
  } catch (err) {
    console.warn('GURPS | Agency | phone camera: could not hide token chrome', err)
  }
  return () => {
    for (const { obj, visible } of hidden) obj.visible = visible
  }
}

/** The actor's token on the scene this client is viewing. */
export function tokenOnCanvas(actor: any): any | null {
  if (!(canvas as any)?.ready) return null
  const tokens = actor?.getActiveTokens?.(false, false) ?? []
  return (
    tokens.find(
      (t: any) => t?.scene?.id === (canvas as any).scene?.id || t?.document?.parent?.id === (canvas as any).scene?.id
    ) ??
    tokens[0] ??
    null
  )
}

function readScreen(): HTMLCanvasElement | null {
  const app = (canvas as any).app
  const renderer = app.renderer
  renderer.render(app.stage)
  try {
    const out = renderer.extract.canvas() as HTMLCanvasElement
    if (out?.width) return out
  } catch (err) {
    console.warn('GURPS | Agency | phone camera: extract failed, reading the view instead', err)
  }
  // Same task as the render, so the drawing buffer still holds the frame.
  const view = renderer.view as HTMLCanvasElement
  const copy = document.createElement('canvas')
  copy.width = view.width
  copy.height = view.height
  copy.getContext('2d')?.drawImage(view, 0, 0)
  return copy
}

export function capture(actor: any, kind: DeviceKind, spec: { width: number; height: number }): CaptureResult {
  const c = canvas as any
  if (!c?.ready || !c.app?.renderer) return { error: 'noCanvas' }
  const token = tokenOnCanvas(actor)
  if (!token) return { error: 'noToken' }
  const renderer = c.app.renderer
  const stage = c.stage
  const saved = { x: stage.pivot.x, y: stage.pivot.y, scale: stage.scale.x }
  const grid = c.dimensions?.size ?? 100
  const screen = { w: renderer.screen.width, h: renderer.screen.height }
  const zoomLimits = (CONFIG as any).Canvas ?? {}
  const scale = captureScale(grid, SPAN[kind], spec.width, screen.w, zoomLimits.minZoom ?? 0.1, zoomLimits.maxZoom ?? 3)
  const center = token.center ?? { x: token.x + token.w / 2, y: token.y + token.h / 2 }
  const restore = hideChrome()
  let frame: HTMLCanvasElement | null = null
  let rect = { x: 0, y: 0, w: 0, h: 0 }
  try {
    c.pan({ x: center.x, y: center.y, scale })
    frame = readScreen()
    if (frame) {
      const p = stage.worldTransform.apply(new (globalThis as any).PIXI.Point(center.x, center.y))
      const res = frame.width / screen.w
      const span = grid * SPAN[kind] * stage.scale.x * res
      rect = cropRect(
        { x: p.x * res, y: p.y * res },
        { w: frame.width, h: frame.height },
        span,
        spec.width / spec.height
      )
    }
  } finally {
    restore()
    c.pan(saved)
  }
  if (!frame) return { error: 'noCanvas' }
  return { canvas: develop(frame, rect, kind, spec) }
}

/** Crop and scale; the burner gets its cheap-sensor treatment. */
function develop(
  frame: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  kind: DeviceKind,
  spec: { width: number; height: number }
): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = spec.width
  out.height = spec.height
  const ctx = out.getContext('2d', { willReadFrequently: kind === 'burner' })!
  if (kind !== 'burner') {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(frame, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height)
    return out
  }
  const small = document.createElement('canvas')
  small.width = Math.round(spec.width / 2)
  small.height = Math.round(spec.height / 2)
  small.getContext('2d')!.drawImage(frame, rect.x, rect.y, rect.w, rect.h, 0, 0, small.width, small.height)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, out.width, out.height)
  const data = ctx.getImageData(0, 0, out.width, out.height)
  burnerFilter(data.data, Math.floor(Math.random() * 1e9))
  ctx.putImageData(data, 0, 0)
  return out
}

export function captureSpec(kind: DeviceKind, canUpload: boolean): PhotoSpec {
  return photoSpec(kind, canUpload)
}

export function toBlob(canvas: HTMLCanvasElement, spec: PhotoSpec): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), spec.mime, spec.quality))
}

// ---------------------------------------------------------------------------------------------
// Storage: the world's data folder when the user may upload, else an inline data URL.

const DIR = () => `worlds/${(game as any).world?.id}/agency-phone`
let dirReady: Promise<boolean> | null = null

function filePicker(): any {
  return (foundry.applications as any)?.apps?.FilePicker?.implementation ?? (globalThis as any).FilePicker
}

/** Best effort: make the folder if it isn't there. The upload itself decides whether it worked. */
async function ensureDir(): Promise<void> {
  const FP = filePicker()
  if (!FP) return
  dirReady ??= (async () => {
    try {
      await FP.browse('data', DIR())
    } catch {
      try {
        await FP.createDirectory('data', DIR(), {})
      } catch (err) {
        console.warn('GURPS | Agency | phone: could not create the photo folder', err)
      }
    }
    return true
  })()
  await dirReady
}

export function canUpload(): boolean {
  return !!(game.user as any)?.can?.('FILES_UPLOAD') && !!filePicker()
}

/** Store a developed photo; returns its src and the bytes it costs inline (0 for files). */
export async function storeImage(
  canvas: HTMLCanvasElement,
  kind: DeviceKind,
  actorId: string
): Promise<{ src: string; bytes: number; w: number; h: number }> {
  const upload = canUpload()
  if (upload) {
    await ensureDir()
    const spec = photoSpec(kind, true)
    const blob = await toBlob(canvas, spec)
    if (blob) {
      const name = `${actorId}-${kind}-${Date.now().toString(36)}.jpg`
      try {
        const res = await filePicker().upload(
          'data',
          DIR(),
          new File([blob], name, { type: spec.mime }),
          {},
          { notify: false }
        )
        if (res?.path) return { src: res.path, bytes: 0, w: canvas.width, h: canvas.height }
      } catch (err) {
        console.warn('GURPS | Agency | phone: upload failed, keeping the photo inline', err)
      }
    }
  }
  const spec = photoSpec(kind, false)
  let source = canvas
  if (canvas.width > spec.width) {
    source = document.createElement('canvas')
    source.width = spec.width
    source.height = spec.height
    const ctx = source.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(canvas, 0, 0, spec.width, spec.height)
  }
  const src = source.toDataURL(spec.mime, spec.quality)
  const bytes = Math.floor(((src.length - src.indexOf(',') - 1) * 3) / 4)
  return { src, bytes, w: source.width, h: source.height }
}
