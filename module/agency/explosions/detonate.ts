/**
 * Setting off an explosion. Runs on the active GM's client (requestDetonation routes it there): find
 * every token in reach, roll each one's dice, place templates, post the GM's summary card, and ask
 * players whose characters were caught whether they dive for cover.
 */
import { playerOwnerIds } from '../defense/foundry-helpers.ts'
import { roll3d6, rollDamage } from './dice.ts'
import { isExplosiveSpec, parseExplosive } from './parse.ts'
import {
  deriveRow,
  fromAbove,
  locationFor,
  noDive,
  radii,
  rollTarget,
  type BlastSetup,
  type BlastState,
  type RowState,
} from './resolve.ts'
import { defaultWallDR, sharedNpcRoll, wallsAreCover } from './settings.ts'
import { foundryRng, placeTemplates, sceneOf, tokenFacts, tokensWithin } from './scene.ts'
import { matchSpecials, summarizeSpecials } from './specials.ts'
import { toGM } from './socket.ts'
import type { BlastCardFlag, BlastRequest, RowMeta } from './types.ts'
import { localize } from './i18n.ts'
import { postBlastCard } from './card.ts'
import { postDivePrompts } from './prompts.ts'

export function newBlastId(): string {
  return foundry.utils.randomID()
}

/** Send the request to the active GM (or run it here when this user is the GM, or nobody is). */
export async function requestDetonation(request: BlastRequest): Promise<void> {
  const reached = await toGM('detonate', request)
  if (!reached) ui.notifications?.warn(localize('warn.noGM'))
}

/**
 * The hit location of one fragment: the hit-location feature's roller when it is loaded
 * (GURPS.agency.hitloc.rollLocation), otherwise upstream's 3d6 against the actor's table.
 * B400: a random attack from directly above (an airburst) turns feet into hands and legs into arms.
 */
async function fragmentLocation(
  tokenDoc: any,
  damageType: string,
  airburst: boolean,
  rng: () => number
): Promise<string> {
  const actor = tokenDoc?.actor
  let location: string | null = null
  const roller = (GURPS as any).agency?.hitloc?.rollLocation
  if (typeof roller === 'function') {
    try {
      const result = await roller({ actor, token: tokenDoc, damageType, source: 'fragment', fromAbove: airburst })
      location = typeof result === 'string' ? result : (result?.location ?? result?.where ?? null)
    } catch (err) {
      console.warn('GURPS | Agency | explosions: hitloc.rollLocation failed, using the actor table', err)
    }
  }
  if (!location) location = locationFor(actor?.hitLocationsWithDR ?? [], roll3d6(rng)) ?? 'Torso'
  return airburst ? fromAbove(location) : location
}

/** Build the blast's setup from the request. Returns null when the text isn't something that explodes. */
export function setupFor(request: BlastRequest): BlastSetup | null {
  const spec = parseExplosive(request.damage)
  const internalOrContact = !!request.internalTokenId || !!request.contactTokenId
  if (!spec || (!isExplosiveSpec(spec) && !internalOrContact)) return null
  if (internalOrContact) for (const c of spec.components) if (c.dice > 0 || c.adds) c.explosive = true
  const special = matchSpecials({
    name: request.weaponName || request.label,
    damage: request.damage,
    notes: request.notes,
    spec,
  })
  return {
    spec,
    environment: request.options.environment !== 'normal' ? request.options.environment : special.environment,
    enclosed: request.options.enclosed,
    airburst: request.options.airburst || special.airburst,
    specials: summarizeSpecials(special),
    diveCoverDR: defaultWallDR(),
  }
}

/** GM side: set off the explosion described by the request. */
export async function detonate(request: BlastRequest): Promise<void> {
  const scene = sceneOf(request.sceneId)
  if (!scene) return
  const setup = setupFor(request)
  if (!setup) {
    ui.notifications?.warn(localize('warn.notExplosive', { text: request.damage }))
    return
  }
  if (canvas?.scene?.id !== scene.id) ui.notifications?.warn(localize('warn.otherScene', { scene: scene.name }))

  const spec = setup.spec
  const special = matchSpecials({
    name: request.weaponName || request.label,
    damage: request.damage,
    notes: request.notes,
    spec,
  })
  const reach = radii(setup)
  const fixed = [request.struckTokenId, request.contactTokenId, request.internalTokenId].filter(
    (id): id is string => !!id
  )
  const tokens = tokensWithin(scene, request.center, reach.max, fixed)
  const rng = foundryRng()

  // B414: the GM may use one damage roll for several NPCs.
  const shared = sharedNpcRoll()
    ? spec.components.map(c => (c.dice > 0 || c.adds ? rollDamage(c, rng, c.type).total : 0))
    : null

  const meta: Record<string, RowMeta> = {}
  const rows: RowState[] = []
  for (const tokenDoc of tokens) {
    const struck = tokenDoc.id === request.struckTokenId || tokenDoc.id === request.internalTokenId
    const facts = tokenFacts(tokenDoc, request.center, {
      struck,
      walls: wallsAreCover(),
      wallDR: defaultWallDR(),
      airburst: setup.airburst,
      special,
      scene,
    })
    if (tokenDoc.id === request.contactTokenId) facts.distance = 0
    const npc = playerOwnerIds(tokenDoc.actor).length === 0
    const rolls = rollTarget(setup, facts, rng, { shared: npc ? shared : null })
    const fragType = rolls.fragDamage.length
      ? (spec.components.find(c => c.fragments)?.fragments?.type ?? 'cut')
      : 'cut'
    for (let i = 0; i < rolls.fragDamage.length; i++)
      rolls.fragLocations[i] = await fragmentLocation(tokenDoc, fragType, setup.airburst, rng)
    rows.push({ facts, rolls, dive: noDive(), coverOverride: null, applied: false })
    meta[tokenDoc.id] = {
      actorId: tokenDoc.actor?.id ?? null,
      npc,
      img: tokenDoc.texture?.src ?? tokenDoc.actor?.img ?? '',
    }
  }

  // Struck first, then nearest first.
  rows.sort((a, b) => Number(b.facts.struck) - Number(a.facts.struck) || a.facts.distance - b.facts.distance)

  let state: BlastState = { setup, rows, contactId: request.contactTokenId, internalId: request.internalTokenId }
  // Everyone who may dive starts as "pending" until they answer (or the GM applies anyway).
  state = {
    ...state,
    rows: state.rows.map(row =>
      deriveRow(state, row).canDive ? { ...row, dive: { ...row.dive, status: 'pending' } } : row
    ),
  }

  const templateIds = await placeTemplates(
    scene,
    request.center,
    {
      blast: reach.blast,
      fragments: reach.fragments,
      affliction: reach.affliction,
      smoke: Math.max(reach.smoke, reach.gas),
    },
    request.id
  )

  const flag: BlastCardFlag = { kind: 'blast', request, state, templateIds, meta, prompts: {} }
  const message = await postBlastCard(flag)
  if (message) await postDivePrompts(message, flag)
}
