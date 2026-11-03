/**
 * Agency feature: shooting house rules (see docs/agency/shooting-rules.md).
 *
 * - Progressive Recoil: a burst is rolled once per shot with a cumulative Rcl penalty. Shot 1 goes
 *   through upstream's normal roll (so the modifier bucket, tagged modifiers, confirmation dialog and
 *   action tracking all apply); the other shots reuse its final target minus aim bonuses, plus recoil.
 * - EUFC fractional Rcl (per-weapon override kept in flags), aim carry-over and Gunslinger.
 *
 * Upstream hook points: GURPS.agency.shooting.beforeRangedAttack() is called from attack() in
 * module/gurps.js before the RoF prompt; the rest runs on 'gurpsAgencyRollComplete'.
 */
import { flattenList, isRangedWeapon, weaponId, weaponKey, type RangedLike } from '../firearms/ammo.ts'
import { isTracked } from '../firearms/shots.ts'
import { rangedWeapons, viewOf, type AmmoActor } from '../firearms/state.ts'
import { hitLocationFromModifiers } from '../defense/defense-card.ts'
import { parseHitLocation } from '../defense/rules.ts'
import { missByOneName } from '../hitloc/engine.ts'
import { hitLocationNames } from '../hitloc/picker.ts'
import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import {
  carriedAcc,
  carryOverApplies,
  guessWeaponClass,
  gunslingerAcc,
  parseRcl,
  planBurst,
  recoilPenalties,
  resolveBurst,
  type BurstResult,
  type CarryOver,
  type WeaponClass,
} from './engine.ts'

const L = 'GURPS.agency.shooting'
const FLAG = 'flags.gurps.agency.shooting'
/** Tag on modifiers this feature adds that count as aim (first shot only). */
const AIM_TAG = '[Aim]'
const CARD_TEMPLATE = 'systems/gurps/templates/agency/shooting-burst.hbs'
const DIALOG_TEMPLATE = 'systems/gurps/templates/agency/shooting-fire.hbs'

type WeaponPrefs = { braced?: boolean; rcl?: number | null; weaponClass?: WeaponClass | '' }

/** Attached to optionalArgs so the roll-complete hook knows what was planned. */
export type ShootingMark = {
  rules: 'prs' | 'standard'
  burst: boolean
  shots: number
  braced: boolean
  rcl: number
  weaponId: string
  weaponKey: string
  weaponName: string
  targetIds: string[]
  round: number | null
}

const i18n = (key: string, data?: Record<string, unknown>) =>
  data ? game.i18n!.format(`${L}.${key}`, data as any) : game.i18n!.localize(`${L}.${key}`)

export function init(): void {
  registerAgencySetting('rapid-fire', {
    name: `${L}.settings.rapidFire.name`,
    hint: `${L}.settings.rapidFire.hint`,
    scope: 'world',
    config: true,
    type: String,
    choices: { prs: `${L}.settings.rapidFire.prs`, standard: `${L}.settings.rapidFire.standard` },
    default: 'prs',
  })
  registerAgencySetting('brace-acc', {
    name: `${L}.settings.braceAcc.name`,
    hint: `${L}.settings.braceAcc.hint`,
    scope: 'world',
    config: true,
    type: Number,
    default: 1,
  })
  registerAgencySetting('aim-carryover', {
    name: `${L}.settings.carryover.name`,
    hint: `${L}.settings.carryover.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })
  registerAgencySetting('gunslinger', {
    name: `${L}.settings.gunslinger.name`,
    hint: `${L}.settings.gunslinger.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })

  const g = GURPS as any
  g.agency ??= {}
  g.agency.shooting = { beforeRangedAttack }

  ;(Hooks as any).on('gurpsAgencyRollComplete', (ctx: any) => {
    void onRollComplete(ctx).catch(err => console.error('GURPS | Agency shooting: roll-complete failed', err))
  })
}

export function ready(): void {}

// ---------------------------------------------------------------------------------------------
// Helpers

function actorFlag<T>(actor: any, path: string): T | undefined {
  return foundry.utils.getProperty(actor, `${FLAG}.${path}`) as T | undefined
}

function prefsFor(actor: any, id: string): WeaponPrefs {
  return actorFlag<WeaponPrefs>(actor, `weapons.${id}`) ?? {}
}

async function savePrefs(actor: any, id: string, prefs: WeaponPrefs): Promise<void> {
  if (!actor.isOwner) return
  await actor.update({ [`${FLAG}.weapons.${id}`]: prefs }, { render: false })
}

function currentRound(): number | null {
  const combat = game.combat as any
  return combat?.started ? (combat.round ?? null) : null
}

function targetIds(): string[] {
  return Array.from((game.user as any)?.targets ?? []).map((t: any) => t.id as string)
}

function hasTrait(actor: any, pattern: RegExp): boolean {
  return flattenList<any>(actor?.system?.ads, '').some(e => pattern.test(String(e.value?.name ?? '')))
}

/** Rounds loaded for a tracked weapon, or null when ammo isn't tracked for it. */
function roundsLoaded(actor: AmmoActor, weapon: RangedLike): number | null {
  try {
    if (!getAgencySetting<boolean>('ammo-tracking')) return null
  } catch {
    return null
  }
  const key = weaponKey(weapon)
  const entry = rangedWeapons(actor).find(e => e.value === weapon || weaponKey(e.value) === key)
  if (!entry) return null
  const view = viewOf(actor, entry.path, entry.value)
  return isTracked(view.spec) ? view.loaded : null
}

function hasAimModifierFor(actor: any, weapon: RangedLike): boolean {
  const usermods: string[] = actor?.system?.conditions?.usermods ?? []
  const label = game.i18n!.localize('GURPS.toAimBonus')
  return usermods.some(m => m.includes('#maneuver') && m.includes(label) && m.includes(String(weapon.name ?? '')))
}

function isAimModifier(desc: string): boolean {
  const label = game.i18n!.localize('GURPS.toAimBonus')
  return desc.includes(AIM_TAG) || (!!label && desc.trim().startsWith(label))
}

// ---------------------------------------------------------------------------------------------
// Before the attack roll (called from attack() in module/gurps.js)

type AttackArgs = { actor: any; action: any; att: any; opt: any; targetmods: any[]; event?: any }

/**
 * Returns false to cancel the attack, { handledRoF: true } when this feature has already chosen the
 * number of shots (so upstream's RoF prompt and RoF bonus are skipped), or undefined to leave upstream alone.
 */
export async function beforeRangedAttack(args: AttackArgs): Promise<false | { handledRoF: boolean } | undefined> {
  const { actor, att, opt, targetmods } = args
  if (!actor || !isRangedWeapon(att)) return undefined
  const weapon = att as RangedLike & Record<string, any>
  const rules = getAgencySetting<string>('rapid-fire') === 'standard' ? 'standard' : 'prs'
  const id = weaponId(weaponKey(weapon))
  const prefs = prefsFor(actor, id)
  const rof = parseInt(String(weapon.rof ?? '1'), 10) || 1
  const baseRcl = prefs.rcl ?? parseRcl(weapon.rcl) ?? 1
  const targets = targetIds()
  const round = currentRound()
  const add = (mod: number, desc: string) => (GURPS.ModifierBucket as any).addModifier(mod, desc, targetmods)

  let shots = 1
  let braced = !!prefs.braced
  let rcl = baseRcl
  let weaponClass: WeaponClass = (prefs.weaponClass || guessWeaponClass(weapon)) as WeaponClass
  const gunslinger = getAgencySetting<boolean>('gunslinger') && hasTrait(actor, /^gunslinger\b/i)

  if (rules === 'prs' && rof > 1) {
    const loaded = roundsLoaded(actor, weapon)
    if (loaded === 0) {
      // Skip the RoF prompt: one shot is enough for the ammo feature to report the empty gun.
      opt.shots = 1
      return { handledRoF: true }
    }
    const max = loaded === null ? rof : Math.max(1, Math.min(rof, loaded))
    const choice = await fireDialog({ weapon, max, braced, rcl, weaponClass, gunslinger, loaded })
    if (!choice) return false
    ;({ shots, braced, rcl, weaponClass } = choice)
    await savePrefs(actor, id, { braced, rcl: rcl === parseRcl(weapon.rcl) ? null : rcl, weaponClass })
  }

  const burst = rules === 'prs' && shots > 1

  // Bracing Acc applies to every shot of a Progressive Recoil burst.
  const braceAcc = Number(getAgencySetting<number>('brace-acc')) || 0
  if (burst && braced && braceAcc) add(braceAcc, i18n('mod.braced'))

  // Aim-type bonuses (first shot only): carried-over Acc, then Gunslinger.
  const aimingNow = actor.system?.conditions?.maneuver === 'aim' || hasAimModifierFor(actor, weapon)
  const carry = actorFlag<CarryOver>(actor, 'carry')
  const targetId = targets.length === 1 ? targets[0] : null
  let carried = 0
  if (getAgencySetting<boolean>('aim-carryover') && carryOverApplies(carry, id, targetId, round)) {
    carried = carry!.acc
    add(carried, `${AIM_TAG} ${i18n('mod.carried')}`)
  }
  const moveAndAttack = actor.system?.conditions?.maneuver === 'move_and_attack'
  if (gunslinger && !aimingNow && !moveAndAttack) {
    const acc = gunslingerAcc(weaponClass, parseInt(String(weapon.acc ?? '0'), 10))
    const extra = Math.max(0, acc - carried)
    if (extra) add(extra, `${AIM_TAG} ${i18n('mod.gunslinger')}`)
  }
  if (gunslinger && moveAndAttack) {
    // Upstream adds -2 or the weapon's Bulk (whichever is worse) through tagged modifiers; Gunslinger ignores it.
    const usermods: string[] = actor.system?.conditions?.usermods ?? []
    if (usermods.some(m => m.includes('@man:move_and_attack'))) {
      const bulk = parseInt(String(weapon.bulk ?? ''), 10)
      const penalty = Number.isFinite(bulk) && bulk < -2 ? bulk : -2
      add(-penalty, i18n('mod.gunslingerMove'))
    }
  }

  opt.agencyShooting = {
    rules,
    burst,
    shots,
    braced,
    rcl,
    weaponId: id,
    weaponKey: weaponKey(weapon),
    weaponName: String(weapon.name ?? ''),
    targetIds: targets,
    round,
  } satisfies ShootingMark

  if (rules === 'prs' && rof > 1) {
    opt.shots = shots
    // The defense feature leaves bursts to us: we prompt it with the per-shot hit count.
    if (burst) opt.agencyHandled = true
    return { handledRoF: true }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Fire dialog

type FireChoice = { shots: number; braced: boolean; rcl: number; weaponClass: WeaponClass }

async function fireDialog(args: {
  weapon: Record<string, any>
  max: number
  braced: boolean
  rcl: number
  weaponClass: WeaponClass
  gunslinger: boolean
  loaded: number | null
}): Promise<FireChoice | null> {
  const render = (foundry.applications as any).handlebars.renderTemplate as (p: string, d: object) => Promise<string>
  const content = await render(DIALOG_TEMPLATE, {
    weapon: args.weapon.name,
    mode: args.weapon.mode,
    rof: args.weapon.rof,
    max: args.max,
    shots: args.max,
    loaded: args.loaded,
    loadedKnown: args.loaded !== null,
    braced: args.braced,
    rcl: args.rcl,
    gunslinger: args.gunslinger,
    weaponClass: args.weaponClass,
    classes: { pistol: i18n('class.pistol'), autopistol: i18n('class.autopistol'), longarm: i18n('class.longarm') },
  })

  const preview = (root: HTMLElement) => {
    const form = root.querySelector('form') ?? root
    const shots = Number((form.querySelector('[name=shots]') as HTMLInputElement)?.value) || 1
    const braced = !!(form.querySelector('[name=braced]') as HTMLInputElement)?.checked
    const rcl = parseRcl((form.querySelector('[name=rcl]') as HTMLInputElement)?.value) ?? 1
    const out = form.querySelector('.agency-fire-preview')
    if (out) out.textContent = recoilPenalties(Math.min(shots, 50), rcl, braced).map(p => (p === 0 ? '±0' : String(p))).join('  ')
  }

  const result = await (foundry.applications.api.DialogV2 as any).wait({
    window: { title: i18n('dialog.title', { weapon: args.weapon.name }), icon: 'fa-solid fa-crosshairs' },
    classes: ['agency-fire-dialog'],
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'fire',
        label: i18n('dialog.fire'),
        icon: 'fa-solid fa-gun',
        default: true,
        callback: (_event: Event, button: HTMLButtonElement) => {
          const data = new (foundry.applications as any).ux.FormDataExtended(button.form).object
          const shots = Math.max(1, Math.min(args.max, parseInt(data.shots, 10) || 1))
          return {
            shots,
            braced: !!data.braced,
            rcl: parseRcl(data.rcl) ?? args.rcl,
            weaponClass: (data.weaponClass || args.weaponClass) as WeaponClass,
          } satisfies FireChoice
        },
      },
      { action: 'cancel', label: game.i18n!.localize('Cancel'), icon: 'fa-solid fa-xmark' },
    ],
    render: (_event: Event, dialog: any) => {
      const root: HTMLElement = dialog.element
      preview(root)
      root.addEventListener('input', () => preview(root))
      root.addEventListener('change', () => preview(root))
    },
  })
  return result && typeof result === 'object' ? (result as FireChoice) : null
}

// ---------------------------------------------------------------------------------------------
// After the roll

async function onRollComplete(ctx: any): Promise<void> {
  const mark = ctx?.optionalArgs?.agencyShooting as ShootingMark | undefined
  if (!mark || !ctx.chatdata || !ctx.isTargeted) return
  delete ctx.optionalArgs.agencyShooting
  const actor = ctx.actor
  const chatdata = ctx.chatdata
  const mods: { modint: number; desc: string }[] = chatdata.targetmods ?? []
  const aimSum = mods.filter(m => isAimModifier(String(m.desc ?? ''))).reduce((sum, m) => sum + (Number(m.modint) || 0), 0)

  if (mark.burst) {
    await resolveRestOfBurst(ctx, mark, aimSum)
    if (actor?.isOwner) await actor.update({ [`${FLAG}.-=carry`]: null }, { render: false })
    return
  }

  // Single shot: remember Acc for next turn against the same target.
  if (!actor?.isOwner || !getAgencySetting<boolean>('aim-carryover')) return
  const targetId = mark.targetIds.length === 1 ? mark.targetIds[0] : null
  const fired = Number(ctx.optionalArgs?.shots) || 1
  const acc = targetId ? carriedAcc(fired, aimSum, mark.braced) : 0
  if (acc > 0) {
    const carry: CarryOver = { weaponKey: mark.weaponId, targetId: targetId!, acc, round: mark.round }
    await actor.update({ [`${FLAG}.carry`]: carry }, { render: false })
  } else if (actorFlag(actor, 'carry')) {
    await actor.update({ [`${FLAG}.-=carry`]: null }, { render: false })
  }
}

async function resolveRestOfBurst(ctx: any, planned: ShootingMark, aimSum: number): Promise<void> {
  const chatdata = ctx.chatdata
  // The ammo feature may have fired fewer rounds than planned (it lowers optionalArgs.shots).
  const allowed = Number(ctx.optionalArgs?.shots) || planned.shots
  const mark: ShootingMark = { ...planned, shots: Math.max(1, Math.min(planned.shots, allowed)) }
  const finalTarget = Number(chatdata.finaltarget)
  // Bracing Acc is already inside finalTarget, so it isn't added again here.
  const plan = planBurst({
    baseTarget: finalTarget - aimSum,
    aimBonus: aimSum,
    braceAcc: 0,
    braced: mark.braced,
    rcl: mark.rcl,
    shots: mark.shots,
  })
  const extra = mark.shots - 1
  const roll = extra > 0 ? await (Roll as any).create(Array.from({ length: extra }, () => '3d6').join(' + ')).evaluate() : null
  const rest: number[] = roll ? roll.dice.map((d: any) => Number(d.total)) : []
  const result: BurstResult = resolveBurst(plan, [Number(chatdata.rtotal), ...rest])

  const targets = mark.targetIds
    .map(id => (canvas as any)?.tokens?.get(id))
    .filter((t: any) => !!t)
  const render = (foundry.applications as any).handlebars.renderTemplate as (p: string, d: object) => Promise<string>
  const content = await render(CARD_TEMPLATE, {
    weapon: mark.weaponName,
    shots: mark.shots,
    rcl: mark.rcl,
    braced: mark.braced,
    natural1: Math.abs(mark.rcl - 1) < 1e-9,
    rows: result.shots.map(s => ({
      ...s,
      isCrit: s.outcome === 'critical',
      isHit: s.outcome === 'hit',
      isFumble: s.outcome === 'fumble',
      recoilText: s.recoil === 0 ? '' : String(s.recoil),
      outcomeLabel: i18n(`outcome.${s.outcome}`),
    })),
    hits: result.hits,
    criticalHits: result.criticalHits,
    target: targets.map((t: any) => t.name).join(', '),
  })
  const blind = !!chatdata.isBlind
  const message = await (ChatMessage as any).create({
    speaker: ctx.speaker,
    content,
    rolls: roll ? [roll] : [],
    ...(blind
      ? { whisper: (ChatMessage as any).getWhisperRecipients('GM').map((u: any) => u.id), blind: true }
      : {}),
    sound: (CONFIG as any).sounds?.dice,
    flags: { gurps: { agency: { burst: { ...mark, hits: result.hits, criticalHits: result.criticalHits } } } },
  })

  const defenseApi = (GURPS as any).agency?.defense
  const aimName = parseHitLocation(chatdata.targetmods, game.i18n!.localize('GURPS.modifierToHit'), hitLocationNames())
  const fallback = result.shots
    .filter(s => s.outcome === 'miss')
    .map(s => missByOneName(s.margin, true, s.roll >= 17, aimName))
    .filter((name): name is string => !!name)
  if (fallback.length && targets.length && typeof defenseApi?.promptDefense === 'function') {
    await defenseApi.promptDefense({
      attacker: ctx.actor,
      attackerToken: ctx.speaker?.token ? (canvas as any)?.tokens?.get(ctx.speaker.token) : undefined,
      targets,
      weapon: ctx.optionalArgs?.obj,
      isRanged: true,
      hits: fallback.length,
      criticalHits: 0,
      hitLocation: fallback[0],
    })
  }

  if (result.hits > 0 && targets.length > 0) {
    const defense = defenseApi
    if (typeof defense?.promptDefense === 'function') {
      await defense.promptDefense({
        attacker: ctx.actor,
        attackerToken: ctx.speaker?.token ? (canvas as any)?.tokens?.get(ctx.speaker.token) : undefined,
        targets,
        weapon: ctx.optionalArgs?.obj,
        isRanged: true,
        hits: result.hits,
        criticalHits: result.criticalHits,
        // A called shot applies to every shot of the burst.
        hitLocation: hitLocationFromModifiers(chatdata.targetmods) ?? undefined,
        chatMessageId: message?.id,
      })
    }
  }
}
