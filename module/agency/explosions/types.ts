/**
 * JSON-safe shapes stored in chat message flags (flags.gurps.agency.explosion) and sent over the socket.
 */
import type { TokenRef } from '../defense/types.ts'
import type { ExplodeOptions, Point } from './command-parse.ts'
import type { BlastState, DiveStatus } from './resolve.ts'

export type { TokenRef }

/** Everything the GM's client needs to set off an explosion. */
export interface BlastRequest {
  id: string
  sceneId: string
  center: Point
  /** What exploded: the weapon ("M67 Grenade") or the /explode text. */
  label: string
  /** Damage text to parse. */
  damage: string
  /** Weapon name and notes, for spotting special munitions (stun, smoke, thermobaric...). */
  weaponName: string
  notes: string
  attacker: TokenRef | null
  /** The token the explosive struck (B414: takes the listed damage as is). */
  struckTokenId: string | null
  options: ExplodeOptions
  scatter: { yards: number; direction: number; from: Point; dodged: boolean } | null
  /** B415 contact / internal explosions set from /explode. */
  contactTokenId: string | null
  internalTokenId: string | null
  /** The user who set it off. */
  userId: string
  /** Rapid fire: further explosives that hit too (resolved one explosion per attack, see attack.ts). */
  extraHits?: number
}

export interface RowMeta {
  actorId: string | null
  /** No player owns it: the GM decides its dive. */
  npc: boolean
  img: string
}

export interface BlastCardFlag {
  kind: 'blast'
  request: BlastRequest
  state: BlastState
  templateIds: string[]
  meta: Record<string, RowMeta>
  /** Prompt message per token id, so the GM can update it when the dive result comes back. */
  prompts: Record<string, string>
}

export interface DivePromptFlag {
  kind: 'dive-prompt'
  blastMessageId: string
  sceneId: string
  tokenId: string
  actorId: string | null
  name: string
  label: string
  distance: number
  canSmother: boolean
  status: DiveStatus
  margin: number
  coverStep: boolean
  smother: boolean
}

export interface IncomingFlag {
  kind: 'incoming'
  request: BlastRequest
  target: TokenRef
  attackerCenter: Point | null
  status: 'awaiting' | 'struck' | 'dodged'
  margin: number
  dropped: boolean
}

export type ExplosionFlag = BlastCardFlag | DivePromptFlag | IncomingFlag

/** Changes to a GM card, applied by the GM's client. */
export type BlastEvent =
  | { kind: 'dive'; tokenId: string; status: DiveStatus; margin: number; coverStep: boolean; smother: boolean }
  | { kind: 'cover'; tokenId: string; dr: number | null }
  | { kind: 'applied'; tokenIds: string[] }
  | { kind: 'enclosed'; value: number }
  | { kind: 'templates'; ids: string[] }
