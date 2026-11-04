/**
 * Flashlight: turns the agent's token light into a forward cone (bright/dim/angle/colour from the world
 * settings) and puts the previous light back when switched off. The light it replaced is kept on the
 * token, flags.gurps.agency.phone.flashlight = { on, saved }, so it survives reloads.
 */
import { FLAG_ROOT, FLAG_SCOPE } from '../settings.ts'
import { flashlightConfig } from './settings.ts'

const PATH = `flags.${FLAG_SCOPE}.${FLAG_ROOT}.phone.flashlight`

/** Pure: the light data for the cone, merged over whatever the token had. */
export function coneLight(
  saved: Record<string, any> | null | undefined,
  cfg: { bright: number; dim: number; angle: number; color: string }
): Record<string, any> {
  return {
    ...(saved ?? {}),
    bright: cfg.bright,
    dim: Math.max(cfg.dim, cfg.bright),
    angle: cfg.angle,
    color: cfg.color,
    alpha: 0.45,
    coloration: 1,
    luminosity: 0.5,
    attenuation: 0.6,
    animation: { ...(saved?.animation ?? {}), type: null },
    darkness: { min: 0, max: 1 },
  }
}

export function flashlightFlag(tokenDoc: any): { on: boolean; saved: Record<string, any> | null } {
  const f = tokenDoc?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.phone?.flashlight
  return { on: !!f?.on, saved: f?.saved ?? null }
}

/** The agent's token documents the flashlight acts on: the viewed scene, else the active scene. */
export function agentTokens(actor: any): any[] {
  if (!actor) return []
  const viewed: any[] = actor.getActiveTokens?.(false, true) ?? []
  if (viewed.length) return viewed
  const active = (game.scenes as any)?.active
  return active?.tokens?.filter?.((t: any) => t.actorId === actor.id) ?? []
}

export function isFlashlightOn(actor: any): boolean {
  return agentTokens(actor).some(t => flashlightFlag(t).on)
}

export async function toggleFlashlight(actor: any): Promise<'on' | 'off' | 'noToken'> {
  const tokens = agentTokens(actor)
  if (!tokens.length) return 'noToken'
  const on = tokens.some(t => flashlightFlag(t).on)
  const cfg = flashlightConfig()
  for (const token of tokens) {
    const flag = flashlightFlag(token)
    if (on) {
      if (!flag.on) continue
      await token.update({ light: flag.saved ?? {}, [PATH]: { on: false, saved: null } })
    } else {
      const saved = token.toObject?.()?.light ?? {}
      await token.update({ light: coneLight(saved, cfg), [PATH]: { on: true, saved } })
    }
  }
  return on ? 'off' : 'on'
}
