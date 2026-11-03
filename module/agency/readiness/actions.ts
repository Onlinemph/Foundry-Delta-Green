/**
 * Readiness at the table: the Ready / Fast-Draw prompt for an unready weapon, the reload gate, the
 * combat-start reset, the parry filter and the "which weapon?" question after a Ready maneuver.
 */
import { performAndCapture, parseOtf, type RollResult } from '../defense/foundry-helpers.ts'
import { quoteOtfName } from '../defense/rules.ts'
import { flattenList } from '../firearms/ammo.ts'
import { escapeHtml, type ReloadGateContext, type ReloadGateResult } from '../firearms/reload.ts'
import { getAgencySetting } from '../settings.ts'
import {
  ammoFastDrawEffect,
  attackGate,
  canFastDrawFrom,
  combatStartChanges,
  fastDrawEffect,
  fastDrawModifier,
  fastDrawOutcome,
  findFastDrawSkill,
  gunslingerApplies,
  readyParries,
  type AttackLike,
  type FastDrawSpecialty,
  type FoundSkill,
} from './rules.ts'
import {
  attackEntries,
  asReadinessActor,
  combatStartMode,
  L10N,
  readinessEnabled,
  readyViews,
  setState,
  setStates,
  viewForAttack,
  type ReadinessActor,
  type ReadyView,
} from './state.ts'

const PROMPT_TEMPLATE = 'systems/gurps/templates/agency/readiness-prompt.hbs'
const PICK_TEMPLATE = 'systems/gurps/templates/agency/readiness-pick.hbs'

export const localize = (key: string) => game.i18n?.localize(`${L10N}.${key}`) ?? key
export const format = (key: string, data: Record<string, unknown>) =>
  game.i18n?.format(`${L10N}.${key}`, data as Record<string, string>) ?? key

export function stateLabel(state: string): string {
  return localize(`state.${state}`)
}

/* ---------------------------------------- */
/*  Combat                                  */
/* ---------------------------------------- */

function sameActor(combatant: any, actor: ReadinessActor): boolean {
  if (!combatant) return false
  if (combatant.actor === actor) return true
  // A linked actor: any of its combatants. A token's own actor only matches its own combatant.
  return !actor.isToken && !!actor.id && combatant.actorId === actor.id
}

/** In a started combat (round 1 or later). */
export function isInCombat(actor: ReadinessActor): boolean {
  const combat = game.combat as any
  if (!combat?.started) return false
  return !!combat.combatants?.some((c: any) => sameActor(c, actor))
}

export function isActorsTurn(actor: ReadinessActor): boolean {
  const combat = game.combat as any
  return !!combat?.started && sameActor(combat.combatant, actor)
}

/**
 * Set the Ready maneuver the way upstream's combat tracker menu does (token.setManeuver), on the
 * actor's turn only: readying off-turn (after a Wait) doesn't replace the turn's maneuver.
 */
export async function takeReadyManeuver(actor: ReadinessActor): Promise<boolean> {
  if (!isActorsTurn(actor)) return false
  const combatant = (game.combat as any).combatant
  if (String(combatant.actor?.system?.conditions?.maneuver ?? '') === 'ready') return true
  const token = combatant.token?.object
  try {
    if (token?.setManeuver) {
      await token.setManeuver('ready')
      await token.drawEffects?.()
    } else {
      await (actor as any).replaceManeuver?.('ready')
    }
    ui.combat?.render()
    return true
  } catch (err) {
    console.error('GURPS | Agency readiness: could not set the Ready maneuver', err)
    return false
  }
}

/* ---------------------------------------- */
/*  Skills and traits                       */
/* ---------------------------------------- */

export function fastDrawSkill(actor: ReadinessActor, specialty: FastDrawSpecialty): FoundSkill | null {
  const skills = flattenList<any>(actor.system?.skills, '').map(e => e.value)
  return findFastDrawSkill(skills, specialty)
}

/** EUFC Gunslinger (the shooting feature's setting): halves Fast-Draw penalties for guns. */
export function hasGunslinger(actor: ReadinessActor): boolean {
  try {
    if (!getAgencySetting<boolean>('gunslinger')) return false
  } catch {
    return false
  }
  return flattenList<any>(actor.system?.ads, '').some(e => /^gunslinger\b/i.test(String(e.value?.name ?? '')))
}

/**
 * Roll a Fast-Draw skill through upstream's skill roll. The modifier bucket may already hold the
 * attack's modifiers (the prompt comes up in the middle of an attack): they are set aside for this
 * roll and put back afterwards, so the attack still gets them and Fast-Draw doesn't.
 */
export async function rollFastDraw(
  actor: ReadinessActor,
  skill: FoundSkill,
  modifier: number,
  event: Event | null
): Promise<RollResult | null> {
  const action = parseOtf(`Sk:${quoteOtfName(skill.name)}`)
  if (!action) return null
  const bucket = GURPS.ModifierBucket as any
  const stack = bucket?.modifierStack
  const saved = [...(stack?.modifierList ?? [])]
  stack?.reset([])
  if (modifier) bucket.addModifier(modifier, localize('mod.situation'))
  try {
    return await performAndCapture(action, actor, event)
  } finally {
    stack?.reset(saved)
    bucket?.refresh?.()
  }
}

/* ---------------------------------------- */
/*  Chat                                    */
/* ---------------------------------------- */

export async function postNote(
  actor: ReadinessActor,
  lines: string[],
  verdict: '' | 'success' | 'failure' = ''
): Promise<void> {
  if (!lines.length) return
  const cls = verdict ? ` agency-chat-card--${verdict}` : ''
  const content = `<div class="agency-chat-card agency-readiness-card${cls}">
  <header class="agency-chat-card-header"><span><i class="fa-solid fa-hand-back-fist"></i> ${escapeHtml(localize('cardTitle'))}</span></header>
  <div class="agency-chat-card-body">${lines.map(line => `<p>${line}</p>`).join('')}</div>
</div>`
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: actor as any }), content } as any)
}

/* ---------------------------------------- */
/*  Ready / Fast-Draw prompt                */
/* ---------------------------------------- */

interface PromptChoice {
  kind: 'ready' | 'fastdraw'
  modifier: number
}

/** Why Fast-Draw isn't offered, or '' when it is. */
function fastDrawBlock(view: ReadyView, skill: FoundSkill | null): string {
  if (!view.specialty) return localize('prompt.noSpecialty')
  if (!canFastDrawFrom(view.state)) return format('prompt.notFrom', { state: stateLabel(view.state) })
  if (!skill) return format('prompt.noSkill', { specialty: view.specialty })
  return ''
}

async function promptReady(actor: ReadinessActor, view: ReadyView, attacking: boolean): Promise<PromptChoice | null> {
  const skill = view.specialty ? fastDrawSkill(actor, view.specialty) : null
  const blocked = fastDrawBlock(view, skill)
  const gunslinger = !!view.specialty && gunslingerApplies(view.specialty) && hasGunslinger(actor)
  const content = await foundry.applications.handlebars.renderTemplate(PROMPT_TEMPLATE, {
    weapon: view.weapon.name,
    state: stateLabel(view.state),
    stateId: view.state,
    intro: format(attacking ? 'prompt.introAttack' : 'prompt.intro', {
      weapon: view.weapon.name,
      state: stateLabel(view.state),
    }),
    turn: isActorsTurn(actor),
    canFastDraw: !blocked,
    blocked,
    specialty: view.specialty,
    skill,
    gunslinger,
    successText: localize(attacking ? 'prompt.successAttack' : 'prompt.success'),
  })

  const buttons: any[] = [
    {
      action: 'ready',
      label: localize('prompt.ready'),
      icon: 'fa-solid fa-hand',
      default: !!blocked,
      callback: () => ({ kind: 'ready', modifier: 0 }) satisfies PromptChoice,
    },
  ]
  if (!blocked)
    buttons.unshift({
      action: 'fastdraw',
      label: format('prompt.fastDraw', { specialty: view.specialty, level: skill!.level }),
      icon: 'fa-solid fa-bolt',
      default: true,
      callback: (_event: Event, button: HTMLButtonElement) => {
        const raw = Number((button.form?.elements as any)?.modifier?.value)
        return { kind: 'fastdraw', modifier: Number.isFinite(raw) ? Math.trunc(raw) : 0 } satisfies PromptChoice
      },
    })
  buttons.push({ action: 'cancel', label: game.i18n?.localize('Cancel') ?? 'Cancel', icon: 'fa-solid fa-xmark' })

  const result = await (foundry.applications.api.DialogV2 as any).wait({
    window: { title: format('prompt.title', { weapon: view.weapon.name }), icon: 'fa-solid fa-hand-back-fist' },
    classes: ['agency-readiness-dialog'],
    content,
    rejectClose: false,
    buttons,
  })
  return result && typeof result === 'object' ? (result as PromptChoice) : null
}

export type ReadyOutcome = 'attack' | 'readied' | 'cancelled'

/**
 * In combat: ask how to ready the weapon, then do it.
 *  - Ready: the weapon is ready and the turn is spent (Ready maneuver).
 *  - Fast-Draw: success readies it instantly ('attack' when attacking); failure readies it but spends
 *    the turn; critical failure drops it and spends the turn.
 */
export async function readyInCombat(
  actor: ReadinessActor,
  view: ReadyView,
  options: { attacking: boolean; event?: Event | null }
): Promise<ReadyOutcome> {
  const choice = await promptReady(actor, view, options.attacking)
  if (!choice) return 'cancelled'
  const weapon = escapeHtml(view.weapon.name)

  if (choice.kind === 'ready') {
    await setState(actor, view.weapon.id, 'ready')
    const maneuver = await takeReadyManeuver(actor)
    await postNote(actor, [format(maneuver ? 'note.readyManeuver' : 'note.ready', { weapon })])
    return 'readied'
  }

  const specialty = view.specialty!
  const skill = fastDrawSkill(actor, specialty)
  if (!skill) return 'cancelled'
  const gunslinger = gunslingerApplies(specialty) && hasGunslinger(actor)
  const modifier = fastDrawModifier(choice.modifier, gunslinger)
  const result = await rollFastDraw(actor, skill, modifier, options.event ?? null)
  if (!result) return 'cancelled'

  const outcome = fastDrawOutcome(result)
  const effect = fastDrawEffect(outcome)
  await setState(actor, view.weapon.id, effect.state)
  if (effect.turnSpent) await takeReadyManeuver(actor)
  const lines = [format(`note.fastDraw.${outcome}`, { weapon, specialty })]
  if (gunslinger && choice.modifier < 0) lines.push(format('note.gunslinger', { from: choice.modifier, to: modifier }))
  await postNote(actor, lines, outcome === 'success' ? 'success' : 'failure')
  return effect.attack && options.attacking ? 'attack' : 'readied'
}

/**
 * Ready a weapon outside an attack (/ready, the "which weapon?" question). In combat with a choice to
 * make it prompts as an attack would; otherwise it just marks it ready.
 */
export async function readyWeapon(
  actor: ReadinessActor,
  view: ReadyView,
  event: Event | null = null
): Promise<boolean> {
  if (view.state === 'ready') {
    ui.notifications?.info(format('alreadyReady', { weapon: view.weapon.name }))
    return false
  }
  if (isInCombat(actor)) return (await readyInCombat(actor, view, { attacking: false, event })) !== 'cancelled'
  await setState(actor, view.weapon.id, 'ready')
  await postNote(actor, [format('note.ready', { weapon: escapeHtml(view.weapon.name) })])
  return true
}

/* ---------------------------------------- */
/*  Hooks                                   */
/* ---------------------------------------- */

export interface BeforeAttackArgs {
  actor: unknown
  action?: { calcOnly?: boolean } | null
  att: AttackLike | null | undefined
  event?: Event | null
}

/**
 * Called from attack() in module/gurps.js before anything else happens to the attack (before the
 * shooting feature's fire dialog). Returns false to cancel the attack.
 */
export async function beforeAttack(args: BeforeAttackArgs): Promise<false | undefined> {
  try {
    if (!readinessEnabled() || args.action?.calcOnly) return undefined
    const actor = asReadinessActor(args.actor)
    if (!actor || !args.att) return undefined
    const view = viewForAttack(actor, args.att)
    if (!view) return undefined

    const gate = attackGate(view.state, isInCombat(actor))
    if (gate === 'proceed') return undefined
    if (gate === 'auto-ready') {
      if (actor.isOwner !== false) await setState(actor, view.weapon.id, 'ready')
      ui.notifications?.info(format('autoReady', { weapon: view.weapon.name, state: stateLabel(view.state) }))
      return undefined
    }
    const outcome = await readyInCombat(actor, view, { attacking: true, event: args.event ?? null })
    return outcome === 'attack' ? undefined : false
  } catch (err) {
    console.error('GURPS | Agency readiness: attack check failed', err)
    return undefined
  }
}

/**
 * Reload gate (registered with the firearms feature): the gun has to be in hand, and in combat a
 * Fast-Draw (Ammo) roll, made automatically when the character has the skill, takes a second off
 * (B194). A critical failure drops the magazine: no reload.
 */
export async function reloadGate(context: ReloadGateContext): Promise<ReloadGateResult> {
  if (!readinessEnabled()) return { proceed: true }
  const actor = asReadinessActor(context.actor)
  if (!actor) return { proceed: true }
  const combat = isInCombat(actor)
  const notes: string[] = []

  const view = viewForAttack(actor, context.view.weapon, context.view.path)
  if (view && view.state !== 'ready') {
    if (combat) {
      ui.notifications?.warn(format('reloadNotReady', { weapon: view.weapon.name, state: stateLabel(view.state) }))
      return { proceed: false }
    }
    await setState(actor, view.weapon.id, 'ready')
    notes.push(format('note.autoReadyReload', { weapon: escapeHtml(view.weapon.name) }))
  }

  if (!combat) return { proceed: true, notes }
  const skill = fastDrawSkill(actor, 'Ammo')
  if (!skill) return { proceed: true, notes }
  const result = await rollFastDraw(actor, skill, 0, null)
  if (!result) return { proceed: true, notes }
  const outcome = fastDrawOutcome(result)
  const effect = ammoFastDrawEffect(outcome)
  notes.push(format(`note.ammo.${outcome}`, { skill: escapeHtml(skill.name) }))
  return { proceed: effect.reload, secondsSaved: effect.secondsSaved, notes }
}

/** 'combatStart': every combatant's weapons back to their carry state, when the setting says so. */
export async function onCombatStart(combat: any): Promise<void> {
  if (!readinessEnabled() || combatStartMode() !== 'carry') return
  const seen = new Set<unknown>()
  for (const combatant of combat?.combatants ?? []) {
    const actor = asReadinessActor(combatant.actor)
    if (!actor || seen.has(actor) || !actor.isOwner) continue
    seen.add(actor)
    const views = readyViews(actor)
    const changes = combatStartChanges(
      views.map(v => ({ id: v.weapon.id, state: v.state, carry: v.carry })),
      'carry'
    )
    if (Object.keys(changes).length) await setStates(actor, changes)
  }
}

/** 'gurpsAgencyDefenseWeapons' from the defense feature: a parry needs a ready weapon. */
export function onDefenseWeapons(data: { actor?: unknown; type?: string; weapons?: { name: string }[] }): void {
  try {
    if (!readinessEnabled() || data?.type !== 'parry' || !Array.isArray(data.weapons)) return
    const actor = asReadinessActor(data.actor)
    if (!actor) return
    const views = readyViews(actor)
    const melee = attackEntries(actor).filter(e => e.kind === 'melee')
    data.weapons = readyParries(
      data.weapons,
      melee,
      views.map(v => v.weapon),
      weapon => views.find(v => v.weapon.id === weapon.id)?.state ?? 'ready'
    )
  } catch (err) {
    console.error('GURPS | Agency readiness: parry filter failed', err)
  }
}

/** 'gurpsAgencyManeuverPicked' from the defense feature's turn card: Ready -> which weapon? */
export async function onManeuverPicked(data: { actor?: unknown; maneuver?: string }): Promise<void> {
  if (!readinessEnabled() || data?.maneuver !== 'ready') return
  const actor = asReadinessActor(data.actor)
  if (!actor) return
  const unready = readyViews(actor).filter(v => v.state !== 'ready')
  if (!unready.length) return

  const content = await foundry.applications.handlebars.renderTemplate(PICK_TEMPLATE, {
    intro: format('pick.intro', { actor: actor.name ?? '' }),
    weapons: unready.map((v, index) => ({
      id: v.weapon.id,
      name: v.weapon.name,
      state: stateLabel(v.state),
      checked: index === 0,
    })),
    otherLabel: localize('pick.other'),
  })
  const id = (await (foundry.applications.api.DialogV2 as any).prompt({
    window: { title: format('pick.title', { actor: actor.name ?? '' }), icon: 'fa-solid fa-hand-back-fist' },
    classes: ['agency-readiness-dialog'],
    content,
    rejectClose: false,
    ok: {
      label: localize('pick.ok'),
      callback: (_event: Event, button: HTMLButtonElement) =>
        button.form?.querySelector<HTMLInputElement>('input[name="weapon"]:checked')?.value ?? '',
    },
  })) as string | null
  const view = unready.find(v => v.weapon.id === id)
  if (!view) return
  await setState(actor, view.weapon.id, 'ready')
  await postNote(actor, [format('note.readyManeuver', { weapon: escapeHtml(view.weapon.name) })])
}
