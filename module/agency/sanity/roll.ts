/**
 * Agency sanity: performing a SAN check, applying the loss and posting the result card.
 */
import { Foundry } from '../../utilities/foundry-compat.ts'
import {
  categoryLabel,
  ensureSanityInitialized,
  getSanity,
  I18N,
  LAST_LOSS_FLAG,
  newId,
  sanRollMode,
  sanityEnabled,
  sanityUpdate,
  type SanityActor,
  t,
  willOf,
} from './data.ts'
import {
  ADAPTATION_BOXES,
  applySanLoss,
  formatLossExpr,
  formatSanLoss,
  frightCheckSucceeds,
  frightCheckTarget,
  isAdapted,
  isConstant,
  lastLossFrom,
  type LossExpr,
  percentileSucceeds,
  type SanCategory,
  type SanLoss,
  type SanLossOutcome,
} from './rules.ts'

export const CARD_TEMPLATE = 'systems/gurps/templates/agency/sanity-chat-card.hbs'
export const NOTE_TEMPLATE = 'systems/gurps/templates/agency/sanity-note-card.hbs'

export interface TargetMod {
  mod: number
  desc: string
}

export interface SanCheckOptions {
  loss: SanLoss
  category: SanCategory
  /** What caused it, e.g. the OTF override text ("Sees the body"). */
  source?: string
  /** Result of a Fright Check already rolled by the /fc dialog ('fright' mode). */
  frightCheck?: { success: boolean; margin: number }
  /** Modifiers for a stand-alone Fright Check ('fright' mode, /san and OTF). */
  frightMods?: TargetMod[]
}

interface CheckView {
  label: string
  total: number
  target: number
  success: boolean
  margin?: number
  mods: TargetMod[]
  ruleOf14: boolean
  fromDialog: boolean
}

function notify(level: 'info' | 'warn' | 'error', message: string): void {
  ui.notifications?.[level](message)
}

async function rollFormula(formula: string): Promise<Roll> {
  const roll = new Roll(formula)
  await roll.evaluate()
  return roll
}

/** Modifier Bucket contents for a stand-alone roll; emptied afterwards like any other GURPS roll. */
function takeBucketMods(): TargetMod[] {
  const bucket = (GURPS as any).ModifierBucket
  const list: any[] = bucket?.modifierStack?.modifierList ?? []
  const mods = list
    .map(m => ({ mod: parseInt(m.modint ?? m.mod, 10) || 0, desc: String(m.desc ?? '') }))
    .filter(m => m.mod !== 0)
  if (mods.length > 0 && bucket?.modifierStack?.AUTO_EMPTY !== false) bucket.clear?.()
  return mods
}

function frightBase(actor: SanityActor): number {
  return parseInt(actor.system?.frightcheck || actor.system?.attributes?.WILL?.value, 10) || willOf(actor)
}

/**
 * Roll (or take from the Fright Check dialog) the success/failure that picks the left or right side
 * of the SAN loss notation.
 */
async function resolveCheck(actor: SanityActor, san: number, opts: SanCheckOptions, rolls: Roll[]): Promise<CheckView> {
  if (opts.frightCheck) {
    return {
      label: t('card.frightCheckDialog'),
      total: 0,
      target: 0,
      success: opts.frightCheck.success,
      margin: opts.frightCheck.margin,
      mods: [],
      ruleOf14: false,
      fromDialog: true,
    }
  }
  if (sanRollMode() === 'percentile') {
    const roll = await rollFormula('1d100')
    rolls.push(roll)
    const total = roll.total ?? 0
    return {
      label: t('card.percentile'),
      total,
      target: san,
      success: percentileSucceeds(total, san),
      mods: [],
      ruleOf14: false,
      fromDialog: false,
    }
  }
  const mods = [...(opts.frightMods ?? []), ...takeBucketMods()]
  const { target, ruleOf14 } = frightCheckTarget(frightBase(actor), mods)
  const roll = await rollFormula('3d6')
  rolls.push(roll)
  const total = roll.total ?? 0
  return {
    label: t('card.frightCheck', { base: frightBase(actor) }),
    total,
    target,
    success: frightCheckSucceeds(total, target),
    margin: target - total,
    mods,
    ruleOf14,
    fromDialog: false,
  }
}

async function rollLoss(expr: LossExpr, rolls: Roll[]): Promise<number> {
  if (isConstant(expr)) return Math.max(0, expr.mod)
  const roll = await rollFormula(formatLossExpr(expr))
  rolls.push(roll)
  return Math.max(0, roll.total ?? 0)
}

export async function createCard(
  actor: SanityActor,
  template: string,
  data: Record<string, unknown>,
  rolls: Roll[] = []
): Promise<void> {
  const content = await foundry.applications.handlebars.renderTemplate(template, data)
  const messageMode = Foundry.getMessageMode()
  const messageData: Record<string, unknown> = {
    speaker: ChatMessage.getSpeaker({ actor: actor as any }),
    content,
    rolls,
  }
  ChatMessage.applyRollMode(messageData as any, messageMode.value as any)
  await ChatMessage.create(messageData as any, Foundry.applyMessageMode({}, messageMode) as any)

  // A self-roll hides the card from the GM; make sure the GM still hears about insanity.
  const alert = data.gmAlert as string | undefined
  if (alert && messageMode.isSelf() && !game.user?.isGM) {
    const gms = ChatMessage.getWhisperRecipients('GM').map((u: any) => u.id)
    if (gms.length) await ChatMessage.create({ content: alert, whisper: gms } as any)
  }
}

function adaptationView(outcome: SanLossOutcome) {
  if (!outcome.adaptation) return null
  const a = outcome.adaptation
  return {
    label: categoryLabel(a.category),
    count: a.after,
    boxes: Array.from({ length: ADAPTATION_BOXES }, (_, i) =>
      i < a.after ? 'fa-solid fa-square-check' : 'fa-regular fa-square'
    ),
    becameAdapted: a.becameAdapted,
  }
}

/**
 * Perform a SAN check for an actor, apply the loss, remember it for projection, and post the card.
 * Returns whether the check succeeded, or null if nothing happened.
 */
export async function performSanCheck(actor: SanityActor | null, opts: SanCheckOptions): Promise<boolean | null> {
  if (!sanityEnabled()) {
    notify('warn', t('errors.disabled'))
    return null
  }
  if (!actor) {
    notify('warn', t('errors.noActor'))
    return null
  }
  if (!actor.isOwner) {
    notify('warn', t('errors.notOwner', { name: actor.name }))
    return null
  }
  await ensureSanityInitialized(actor)
  const state = getSanity(actor)
  const will = willOf(actor)
  const rolls: Roll[] = []

  const immune = isAdapted(state, opts.category)
  let check: CheckView | null = null
  let lossExpr: LossExpr | null = null
  let rolled = 0
  if (!immune || opts.frightCheck) check = await resolveCheck(actor, state.value, opts, rolls)
  if (!immune) {
    lossExpr = check!.success ? opts.loss.success : opts.loss.failure
    rolled = await rollLoss(lossExpr, rolls)
  }

  const outcome = applySanLoss(state, { rolled, category: opts.category, will })
  const lossId = newId()
  await actor.update({
    ...sanityUpdate(outcome.state),
    [LAST_LOSS_FLAG]: lastLossFrom(outcome, lossId, opts.category),
  })

  const hasBonds = outcome.state.bonds.some(b => b.score > 0)
  const gmAlertParts: string[] = []
  if (outcome.temporaryInsanity) gmAlertParts.push(t('card.temporaryInsanity', { lost: outcome.lost }))
  if (outcome.breakingPoint) gmAlertParts.push(t('card.breakingPoint', { bp: outcome.bpBefore }))
  if (outcome.permanentInsanity) gmAlertParts.push(t('card.permanentInsanity'))

  await createCard(
    actor,
    CARD_TEMPLATE,
    {
      i18n: I18N,
      actorName: actor.name,
      actorUuid: actor.uuid,
      lossId,
      source: opts.source || '',
      notation: formatSanLoss(opts.loss),
      category: opts.category,
      categoryLabel: opts.category === 'none' ? '' : categoryLabel(opts.category),
      check: check && {
        ...check,
        resultClass: check.success ? 'success' : 'failure',
        resultLabel: t(check.success ? 'card.success' : 'card.failure'),
      },
      lossFormula: lossExpr ? formatLossExpr(lossExpr) : '',
      rolled: outcome.rolled,
      outcome,
      max: outcome.state.max,
      adaptation: adaptationView(outcome),
      showProject: outcome.lost > 0 && hasBonds,
      showDisorder: outcome.breakingPoint,
      showUnnatural: outcome.lost > 0 && opts.category === 'unnatural',
      gmAlert: gmAlertParts.length
        ? `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>: ${gmAlertParts.join(' ')}`
        : '',
    },
    rolls
  )
  return check ? check.success : null
}
