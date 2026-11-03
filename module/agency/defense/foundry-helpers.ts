/**
 * Small Foundry-facing helpers shared by the defense card and turn flow. Typed loosely on purpose:
 * the GURPS actor is untyped upstream JS.
 */
import type { TokenRef } from './types.ts'

export type AnyActor = any
export type AnyTokenDoc = any

const OWNER = 3 // CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER

/** Same names as AgencyHooks in module/agency/index.ts (not imported, to keep the import graph acyclic). */
export const ROLL_COMPLETE_HOOK = 'gurpsAgencyRollComplete'
export const TURN_START_HOOK = 'gurpsAgencyTurnStart'
export const TURN_END_HOOK = 'gurpsAgencyTurnEnd'
export const DAMAGE_ROLLED_HOOK = 'gurpsAgencyDamageRolled'

export function localize(key: string, data?: Record<string, unknown>): string {
  const i18n = game.i18n as any
  return data ? i18n.format(key, data) : i18n.localize(key)
}

/** Token document -> reference that survives the trip through flags and sockets. */
export function tokenRef(tokenDoc: AnyTokenDoc | null, actor: AnyActor | null): TokenRef {
  return {
    sceneId: tokenDoc?.parent?.id ?? null,
    tokenId: tokenDoc?.id ?? null,
    actorId: actor?.id ?? tokenDoc?.actorId ?? null,
    name: tokenDoc?.name ?? actor?.name ?? '?',
  }
}

export function resolveTokenDoc(ref: TokenRef): AnyTokenDoc | null {
  if (!ref.tokenId) return null
  const scene = ref.sceneId ? (game.scenes as any)?.get(ref.sceneId) : canvas?.scene
  return scene?.tokens?.get(ref.tokenId) ?? null
}

/** The token's (possibly synthetic) actor, else the world actor. */
export function resolveActor(ref: TokenRef): AnyActor | null {
  return resolveTokenDoc(ref)?.actor ?? (ref.actorId ? (game.actors as any)?.get(ref.actorId) : null) ?? null
}

/** Players (not GMs) with Owner permission on the actor. */
export function playerOwnerIds(actor: AnyActor | null): string[] {
  if (!actor) return []
  return ((game.users as any)?.contents ?? [])
    .filter((user: any) => !user.isGM && actor.testUserPermission?.(user, OWNER))
    .map((user: any) => user.id)
}

export function gmIds(): string[] {
  return ((game.users as any)?.contents ?? []).filter((user: any) => user.isGM).map((user: any) => user.id)
}

export function activeGMId(): string | null {
  return (game.users as any)?.activeGM?.id ?? null
}

export function activeUserIds(): string[] {
  return ((game.users as any)?.contents ?? []).filter((user: any) => user.active).map((user: any) => user.id)
}

export function canControl(actor: AnyActor | null): boolean {
  return !!game.user?.isGM || !!actor?.isOwner
}

export function unique(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))]
}

export function currentManeuver(actor: AnyActor | null): string {
  return String(actor?.system?.conditions?.maneuver || 'do_nothing')
}

/** Is the token a combatant in the active combat? (Maneuvers only apply in combat.) */
export function inActiveCombat(tokenDoc: AnyTokenDoc | null): boolean {
  const combat = (game as any).combats?.active
  return !!tokenDoc && !!combat?.combatants?.some((c: any) => c.tokenId === tokenDoc.id)
}

export function parseOtf(otf: string): GurpsAction | null {
  return ((GURPS as any).parselink(otf)?.action as GurpsAction) ?? null
}

export interface RollResult {
  margin: number
  failure: boolean
  isCritSuccess: boolean
  isCritFailure: boolean
}

/**
 * Run an action through upstream's performAction (so the modifier bucket, tagged modifiers,
 * maneuver checks and confirmation dialog all apply) and capture the targeted roll it makes.
 * Returns null if nothing was rolled (cancelled, or the roll was refused).
 */
export async function performAndCapture(
  action: GurpsAction,
  actor: AnyActor,
  event: Event | null
): Promise<RollResult | null> {
  let captured: RollResult | null = null
  const hookId = Hooks.on(ROLL_COMPLETE_HOOK as any, (data: any) => {
    if (captured || !data?.isTargeted || data.actor?.id !== actor?.id) return
    const chat = data.chatdata ?? {}
    captured = {
      margin: Number(chat.margin) || 0,
      failure: !!data.failure,
      isCritSuccess: !!chat.isCritSuccess,
      isCritFailure: !!chat.isCritFailure,
    }
  })
  try {
    await GURPS.performAction(action, actor, event)
  } finally {
    Hooks.off(ROLL_COMPLETE_HOOK as any, hookId)
  }
  return captured
}

export async function renderTemplate(path: string, data: object): Promise<string> {
  return (foundry.applications as any).handlebars.renderTemplate(path, data)
}
