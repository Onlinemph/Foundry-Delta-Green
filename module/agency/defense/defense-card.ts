/**
 * Defense prompts: a successful attack on targeted tokens posts a defense card per target. The
 * defender rolls Dodge / Parry / Block through upstream's actions (so modifiers, maneuvers and the
 * modifier bucket apply); a hit lets the attacker (or GM) roll the weapon's damage and opens upstream's
 * Apply Damage dialog on the target, prefilled with the hit location and one entry per hit.
 */
import * as Settings from '../../../lib/miscellaneous-settings.js'
import Maneuvers from '../../combat/maneuver.js'
import * as HitLocations from '../../hitlocation/hitlocation.js'
import { postCard, submitCardEvent } from './cards.ts'
import { initialDefenseState, isStunned } from './flow.ts'
import {
  activeGMId,
  canControl,
  currentManeuver,
  gmIds,
  inActiveCombat,
  localize,
  parseOtf,
  performAndCapture,
  playerOwnerIds,
  renderTemplate,
  resolveActor,
  resolveTokenDoc,
  tokenRef,
  unique,
  type AnyActor,
  type AnyTokenDoc,
} from './foundry-helpers.ts'
import {
  availableToggles,
  classifyAttack,
  deceptivePenalty,
  defenseAvailability,
  defenseModifiers,
  defenseOtf,
  distributeAttack,
  listDefenseWeapons,
  maneuverDefenseRule,
  parseHitLocation,
  quoteOtfName,
  type DefenseToggles,
} from './rules.ts'
import { autoDamageEnabled, defensePromptsEnabled } from './settings.ts'
import { emitSocket, onSocket } from './socket.ts'
import type { AttackContext, DefenseCardFlag, DefenseChoice, DefenseType, TokenRef } from './types.ts'
import { TEMPLATES } from './views.ts'

const L = 'GURPS.agency.defense'
const DEFENSES: DefenseType[] = ['dodge', 'parry', 'block']

const hasStatus = (actor: AnyActor | null, id: string): boolean => !!actor?.statuses?.has?.(id)

/* ---------------------------------------- */
/*  Attack -> defense cards                  */
/* ---------------------------------------- */

/** Upstream localized hit location names -> raw keys, for reading "to hit <location>" modifiers. */
function hitLocationNames(): Record<string, string> {
  const names: Record<string, string> = {}
  for (const raw of Object.keys((HitLocations as any).hitlocationRolls ?? {})) {
    names[raw] = raw
    names[localize(`GURPS.hitLocation${raw}`)] = raw
  }
  return names
}

function weaponName(obj: any): string {
  const name = String(obj?.name ?? '')
  return obj?.mode ? `${name} (${obj.mode})` : name
}

function damageText(obj: any): string {
  return Array.isArray(obj?.damage) ? obj.damage.join(', ') : String(obj?.damage ?? '')
}

/** Handler for 'gurpsAgencyRollComplete' on the attacker's client. */
export async function onRollComplete(data: any): Promise<void> {
  if (!defensePromptsEnabled()) return
  if (!data?.isTargeted || data.failure) return
  // Another fork feature resolved this attack itself and calls promptDefense() with its own hits.
  if (data.optionalArgs?.agencyHandled) return
  const attacker = data.actor
  if (!(attacker instanceof Actor)) return

  const obj = data.optionalArgs?.obj
  const profile = classifyAttack(data.chatthing ?? '', obj)
  if (!profile) return

  const speaker = data.speaker ?? {}
  const targets = (Array.from((game.user as any)?.targets ?? []) as any[]).filter(
    token => token?.actor && token.id !== speaker.token
  )
  if (!targets.length) return

  const chat = data.chatdata ?? {}
  const attackerScene = speaker.scene ? (game.scenes as any)?.get(speaker.scene) : canvas?.scene
  const attackerToken = speaker.token ? attackerScene?.tokens?.get(speaker.token) : null

  const attack: AttackContext = {
    attacker: tokenRef(attackerToken, attacker),
    userId: game.user!.id,
    profile,
    weapon: weaponName(obj),
    damage: damageText(obj),
    followon: chat.followon ?? data.optionalArgs?.followon ?? null,
    margin: Number(chat.margin) || 0,
    isCritSuccess: !!chat.isCritSuccess,
    isBlind: !!chat.isBlind,
    hitLocation: parseHitLocation(chat.targetmods, localize('GURPS.modifierToHit'), hitLocationNames()),
    deceptivePenalty: deceptivePenalty(chat.targetmods, localize('GURPS.modifiers_.deceptive')),
    rof: chat.rof ?? null,
    rcl: chat.rcl ?? null,
    rollMessageId: null,
  }

  // A critical attack roll means no defense against any of its hits (B556).
  const hits = Number(chat.rofrcl) || 1
  await postDefenseCards(attack, attacker, attackerToken, targets, hits, attack.isCritSuccess ? hits : 0)
}

export interface PromptDefenseArgs {
  attacker: Actor
  attackerToken?: Token | TokenDocument | null
  targets: (Token | TokenDocument)[]
  /** The melee or ranged entry the attack was made with (system.melee.* / system.ranged.*). */
  weapon: any
  isRanged: boolean
  /** Hits on the targets (split between them in target order when there are several). */
  hits: number
  /** How many of those hits are critical: they can't be defended (B556). */
  criticalHits: number
  /** Upstream hit location key ("Skull", "Torso"...). */
  hitLocation?: string
  /** The attack roll's chat message. */
  chatMessageId?: string
}

/**
 * Start the defense flow with hit data another feature already worked out (e.g. per-shot rapid
 * fire): posts a defense card per target, exactly as a successful attack roll would. One defense
 * roll covers all of a target's hits; critical hits always get through to the damage step.
 * Also available as GURPS.agency.defense.promptDefense for non-TS code.
 */
export async function promptDefense(args: PromptDefenseArgs): Promise<void> {
  if (!defensePromptsEnabled()) return
  const attacker: any = args.attacker
  if (!attacker || !(Number(args.hits) > 0)) return

  const attackerToken: any =
    (args.attackerToken as any)?.document ??
    args.attackerToken ??
    attacker.token ??
    attacker.getActiveTokens?.()[0]?.document ??
    null
  const targets = (args.targets ?? [])
    .map((t: any) => t?.object ?? t)
    .filter((t: any) => t?.actor && t.id !== attackerToken?.id)
  if (!targets.length) return

  const weapon = args.weapon ?? {}
  const profile = classifyAttack(args.isRanged ? 'R:' : 'M:', weapon)!
  const name = weaponName(weapon)
  const hitLocation = args.hitLocation
    ? ((HitLocations as any).HitLocation?.translate?.(args.hitLocation) ?? args.hitLocation)
    : null

  const attack: AttackContext = {
    attacker: tokenRef(attackerToken, attacker),
    userId: game.user!.id,
    profile,
    weapon: name,
    damage: damageText(weapon),
    followon: name ? `[@${attacker.id}@D:${quoteOtfName(name)}]` : null,
    margin: null,
    isCritSuccess: false,
    isBlind: false,
    hitLocation,
    deceptivePenalty: 0,
    rof: weapon.rof ?? null,
    rcl: weapon.rcl ?? null,
    rollMessageId: args.chatMessageId ?? null,
  }

  await postDefenseCards(attack, attacker, attackerToken, targets, Number(args.hits), Number(args.criticalHits) || 0)
}

async function postDefenseCards(
  attack: AttackContext,
  attacker: AnyActor,
  attackerToken: AnyTokenDoc | null,
  targets: any[],
  hits: number,
  criticalHits: number
): Promise<void> {
  const shares = distributeAttack(hits, criticalHits, targets.length)
  const speaker = (ChatMessage as any).getSpeaker({ actor: attacker, token: attackerToken })

  for (const [index, target] of targets.entries()) {
    const share = shares[index]
    if (share.hits > 0) await postDefenseCard(attack, target.document ?? target, attacker, share, speaker)
  }
}

async function postDefenseCard(
  attack: AttackContext,
  targetDoc: AnyTokenDoc,
  attacker: AnyActor,
  share: { hits: number; critical: number },
  speaker: object
): Promise<void> {
  const defender = targetDoc.actor
  // Maneuvers only mean something in combat; outside it the stored one may be stale.
  const maneuver = inActiveCombat(targetDoc) ? currentManeuver(defender) : 'do_nothing'
  const availability = defenseAvailability({
    attack: attack.profile,
    isCritical: attack.isCritSuccess,
    maneuverRule: maneuverDefenseRule(maneuver, (Maneuvers.getManeuver(maneuver) as any)?.flags?.gurps?.defense),
    cantSee: hasStatus(defender, 'blind') || hasStatus(attacker, 'invisible'),
    hasParry: listDefenseWeapons(defender?.system?.melee, 'parry').length > 0,
    hasBlock: listDefenseWeapons(defender?.system?.melee, 'block').length > 0,
  })

  const card: DefenseCardFlag = {
    kind: 'defense-card',
    attack,
    target: tokenRef(targetDoc, defender),
    maneuver,
    state: initialDefenseState(
      share.hits,
      share.critical,
      availability.noDefense,
      DEFENSES.filter(type => availability[type])
    ),
  }

  const whisper = unique([...playerOwnerIds(defender), ...gmIds(), game.user!.id])
  await postCard(card, whisper, speaker)
}

/* ---------------------------------------- */
/*  Displaying a card                        */
/* ---------------------------------------- */

const busy = new Set<string>()

function canRollDamage(card: DefenseCardFlag): boolean {
  return !!game.user?.isGM || game.user?.id === card.attack.userId || canControl(resolveActor(card.attack.attacker))
}

/** renderChatMessageHTML: add the viewer's own controls to a defense card. */
export async function decorateDefenseCard(message: any, html: HTMLElement, card: DefenseCardFlag): Promise<void> {
  const root = html.querySelector<HTMLElement>('[data-agency-card="defense"]')
  if (!root) return

  // Synchronously, so a button nobody may use never shows.
  const mayDamage = canRollDamage(card)
  root.querySelectorAll<HTMLElement>('[data-agency-role="attacker"]').forEach(el => {
    if (!mayDamage) el.remove()
  })
  root.querySelector<HTMLButtonElement>('[data-agency-action="roll-damage"]')?.addEventListener('click', event => {
    event.preventDefault()
    void onRollDamage(message, card, event)
  })

  const defender = resolveActor(card.target)
  const container = root.querySelector<HTMLElement>('[data-agency-defense-controls]')
  if (card.state.status !== 'awaiting' || !container || !defender || !canControl(defender)) return

  container.innerHTML = await renderTemplate(TEMPLATES.defenseControls, controlsView(card, defender))
  container.querySelectorAll<HTMLButtonElement>('[data-agency-action="defend"]').forEach(button =>
    button.addEventListener('click', event => {
      event.preventDefault()
      void onDefend(message, card, container, button.dataset.defense as DefenseChoice, event)
    })
  )
}

function controlsView(card: DefenseCardFlag, defender: AnyActor): Record<string, unknown> {
  const attacker = resolveActor(card.attack.attacker)
  const parries = listDefenseWeapons(defender.system?.melee, 'parry')
  const blocks = listDefenseWeapons(defender.system?.melee, 'block')
  const live = defenseAvailability({
    attack: card.attack.profile,
    isCritical: false,
    maneuverRule: maneuverDefenseRule(
      card.maneuver,
      (Maneuvers.getManeuver(card.maneuver) as any)?.flags?.gurps?.defense
    ),
    cantSee: hasStatus(defender, 'blind') || hasStatus(attacker, 'invisible'),
    hasParry: parries.length > 0,
    hasBlock: blocks.length > 0,
  })
  const allowed = (type: DefenseType) => card.state.allowed.includes(type) && live[type]
  const toggles = availableToggles(card.attack.profile, isStunned(defender.statuses ?? []))

  const notes = live.notes.map(key => localize(`${L}.note.${key}`))
  if (card.state.attempts.length > 0) notes.unshift(localize(`${L}.note.doubleDefense`))
  if (card.attack.deceptivePenalty > 0)
    notes.push(localize(`${L}.note.deceptive`, { penalty: card.attack.deceptivePenalty }))

  return {
    notes,
    toggles: (Object.keys(toggles) as (keyof DefenseToggles)[])
      .filter(id => toggles[id] && (id !== 'acrobatic' || allowed('dodge')))
      .map(id => ({ id, label: localize(`${L}.toggle.${id}`), hint: localize(`${L}.toggle.${id}Hint`) })),
    dodge: allowed('dodge') ? { value: defender.system?.currentdodge, label: localize(`${L}.defense.dodge`) } : null,
    parries: allowed('parry') ? parries : [],
    blocks: allowed('block') ? blocks : [],
    parryLabel: localize(`${L}.defense.parry`),
    blockLabel: localize(`${L}.defense.block`),
    noDefenseLabel: localize(`${L}.card.noDefense`),
  }
}

/* ---------------------------------------- */
/*  Rolling the defense                      */
/* ---------------------------------------- */

function readToggles(container: HTMLElement): DefenseToggles {
  const checked = (name: string) => !!container.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked
  return {
    retreat: checked('retreat'),
    dodgeAndDrop: checked('dodgeAndDrop'),
    acrobatic: checked('acrobatic'),
    feverish: checked('feverish'),
    side: checked('side'),
  }
}

function taggedModifiersAutoAdd(): boolean {
  try {
    return !!(game.settings as any).get(Settings.SYSTEM_NAME, Settings.SETTING_USE_TAGGED_MODIFIERS)?.autoAdd
  } catch {
    return false
  }
}

/** Snapshot of the modifier bucket, to take our modifiers back out if the roll doesn't happen. */
function bucketSnapshot(): () => void {
  const stack = (GURPS.ModifierBucket as any).modifierStack
  const saved = [...(stack?.modifierList ?? [])]
  return () => {
    stack?.reset(saved)
    GURPS.ModifierBucket.refresh()
  }
}

async function onDefend(
  message: any,
  card: DefenseCardFlag,
  container: HTMLElement,
  type: DefenseChoice,
  event: Event
): Promise<void> {
  if (busy.has(message.id)) return
  busy.add(message.id)
  container.classList.add('is-busy')

  try {
    if (type === 'none') {
      await submitCardEvent(message, {
        kind: 'defense',
        attempt: { type: 'none', label: '', success: false, margin: 0 },
        doubleDefense: false,
      })
      return
    }

    const defender = resolveActor(card.target)
    if (!defender) {
      ui.notifications?.warn(localize(`${L}.warn.noDefender`))
      return
    }

    const toggles = readToggles(container)
    const weapon =
      type === 'dodge'
        ? null
        : (listDefenseWeapons(defender.system?.melee, type).find(
            w => w.name === container.querySelector<HTMLSelectElement>(`select[name="${type}"]`)?.value
          ) ?? null)
    if (type !== 'dodge' && !weapon) return

    // Acrobatic Dodge (B375): an Acrobatics roll first, +2 to the dodge on a success, -2 on a failure.
    let acrobaticResult: 'success' | 'failure' | undefined
    if (toggles.acrobatic && type === 'dodge') {
      const skill = quoteOtfName(localize('GURPS.skillAcrobatics'))
      const acrobatics = parseOtf(`Sk:${skill} | DX-6`)
      const result = acrobatics ? await performAndCapture(acrobatics, defender, event) : null
      if (!result) return
      acrobaticResult = result.failure ? 'failure' : 'success'
    }

    const attacker = resolveActor(card.attack.attacker)
    const mods = defenseModifiers(
      {
        attack: card.attack.profile,
        defense: type,
        fencing: !!weapon?.fencing,
        stunned: isStunned(defender.statuses ?? []),
        cantSee: hasStatus(defender, 'blind') || hasStatus(attacker, 'invisible'),
        deceptivePenalty: card.attack.deceptivePenalty,
        maneuver: card.maneuver,
        acrobaticResult,
        includeManeuverAndStatus: !taggedModifiersAutoAdd(),
      },
      toggles
    )

    const action = parseOtf(defenseOtf(type, weapon?.name))
    if (!action) return

    const restoreBucket = bucketSnapshot()
    for (const mod of mods) GURPS.ModifierBucket.addModifier(String(mod.mod), localize(mod.key) + (mod.suffix ?? ''))

    const result = await performAndCapture(action, defender, event)
    if (!result) return restoreBucket()

    // Dodge and Drop leaves you prone whether or not it works (B377).
    if (toggles.dodgeAndDrop && type === 'dodge' && card.attack.profile.kind === 'ranged') {
      try {
        await defender.toggleStatusEffect('prone', { active: true })
      } catch (err) {
        console.warn('GURPS | Agency | could not set prone after Dodge and Drop', err)
      }
    }

    await submitCardEvent(message, {
      kind: 'defense',
      attempt: {
        type,
        label: weapon?.name ?? '',
        success: !result.failure,
        margin: result.margin,
        critSuccess: result.isCritSuccess,
        critFailure: result.isCritFailure,
      },
      doubleDefense: card.maneuver === 'aod_double',
    })
  } finally {
    busy.delete(message.id)
    container.classList.remove('is-busy')
  }
}

/* ---------------------------------------- */
/*  Rolling damage                           */
/* ---------------------------------------- */

/** The weapon's damage as an upstream damage action carrying the attack's hit location. */
function damageAction(attacker: AnyActor, attack: AttackContext): GurpsAction | null {
  const att = (GURPS as any).findAttack(
    attacker.system,
    attack.weapon,
    attack.profile.kind === 'melee',
    attack.profile.kind === 'ranged'
  )
  const text = att?.damage ? (Array.isArray(att.damage) ? att.damage.join(', ') : String(att.damage)) : attack.damage
  const action = text ? parseOtf(text) : null

  if (action && (action.type === 'damage' || action.type === 'deriveddamage')) {
    if (attack.hitLocation) action.hitlocation = attack.hitLocation
    if (att) action.att = att
    return action
  }

  // Damage text that isn't a plain roll: fall back to upstream's own follow-on ("D:weapon").
  return attack.followon ? parseOtf(attack.followon.replace(/^\[|\]$/g, '')) : null
}

/** Resolve with the damage payload of the next damage chat message this user posts for the attacker. */
function captureDamageMessage(attackerId: string): { wait(ms: number): Promise<any[] | null>; cancel(): void } {
  let finish: (value: any[] | null) => void = () => {}
  const result = new Promise<any[] | null>(resolve => {
    let done = false
    const hookId = Hooks.on('createChatMessage' as any, (msg: any) => {
      if ((msg.author?.id ?? msg.user?.id) !== game.user?.id) return
      const transfer = foundry.utils.getProperty(msg, 'flags.gurps.transfer') as any
      if (transfer?.type !== 'damageItem' || !Array.isArray(transfer.payload)) return
      if (transfer.payload[0]?.attacker !== attackerId) return
      finish(transfer.payload)
    })
    finish = value => {
      if (done) return
      done = true
      Hooks.off('createChatMessage' as any, hookId)
      resolve(value)
    }
  })

  return {
    cancel: () => finish(null),
    wait: (ms: number) => {
      setTimeout(() => finish(null), ms)
      return result
    },
  }
}

async function onRollDamage(message: any, card: DefenseCardFlag, event: Event): Promise<void> {
  if (busy.has(message.id) || card.state.status !== 'hit') return
  const attacker = resolveActor(card.attack.attacker)
  if (!attacker) {
    ui.notifications?.warn(localize(`${L}.warn.noAttacker`))
    return
  }

  const action = damageAction(attacker, card.attack)
  if (!action) {
    ui.notifications?.warn(localize(`${L}.warn.noDamage`, { weapon: card.attack.weapon }))
    return
  }

  busy.add(message.id)
  try {
    const hits = Math.max(1, card.state.hitsRemaining)
    // Upstream's "multiple damage rolls": one labelled roll per hit, in one damage message.
    const labels = hits > 1 ? Array.from({ length: hits }, (_, i) => String(i + 1)) : []
    const targetDoc = resolveTokenDoc(card.target)

    // Upstream refuses untargeted damage rolls in combat under some settings, and the damage
    // message offers the GM an "apply" button for the user's target: target the defender if
    // nothing is targeted.
    if (targetDoc?.object && !(game.user as any)?.targets?.size) {
      try {
        targetDoc.object.setTarget(true, { releaseOthers: true, groupSelection: false })
      } catch {
        /* targeting is a convenience */
      }
    }

    const capture = captureDamageMessage(attacker.id)
    let rolled = false
    try {
      rolled = !!(await GURPS.performAction(action, attacker, event, labels))
    } finally {
      if (!rolled) capture.cancel()
    }
    if (!rolled) return

    const payload = await capture.wait(5000)
    await submitCardEvent(message, { kind: 'damage', hits })
    if (payload && autoDamageEnabled()) openApplyDamage(card.target, payload)
  } finally {
    busy.delete(message.id)
  }
}

/* ---------------------------------------- */
/*  Opening upstream's Apply Damage dialog   */
/* ---------------------------------------- */

function cleanPayload(payload: any[]): any[] {
  return payload.map(entry => {
    const { roll: _roll, token: _token, ...rest } = foundry.utils.deepClone(entry)
    return rest
  })
}

function openLocally(target: TokenRef, payload: any[]): void {
  const tokenDoc = resolveTokenDoc(target)
  const actor = tokenDoc?.actor ?? resolveActor(target)
  if (!actor) return void ui.notifications?.warn(localize(`${L}.warn.noDefender`))
  const entries = cleanPayload(payload)
  // Upstream sets the drop target's token on the payload; the dialog reads its token actions from it.
  if (tokenDoc?.object) entries.forEach(entry => (entry.token = tokenDoc.object))
  actor.handleDamageDrop(entries)
}

/** Open the Apply Damage dialog here if allowed, else on the active GM's client. */
function openApplyDamage(target: TokenRef, payload: any[]): void {
  const onlyGMs = !!(game.settings as any).get(Settings.SYSTEM_NAME, Settings.SETTING_ONLY_GMS_OPEN_ADD)
  if (game.user?.isGM || !onlyGMs) return openLocally(target, payload)

  const gm = activeGMId()
  if (!gm) return void ui.notifications?.warn(localize(`${L}.warn.noGMForDamage`))
  emitSocket('openDamage', gm, { target, payload: cleanPayload(payload) })
  ui.notifications?.info(localize(`${L}.info.damageSentToGM`))
}

export function registerDefenseSocket(): void {
  onSocket('openDamage', (data: { target: TokenRef; payload: any[] }) => {
    if (game.user?.isGM) openLocally(data.target, data.payload)
  })
}
