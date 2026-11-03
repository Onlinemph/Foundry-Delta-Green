/**
 * Agency sanity: entry points that start a SAN check.
 *  - /san <loss> [category] [description]   chat command for the selected actor
 *  - [SAN 0/1d4 violence] OTF                (e.g. ["Sees the body" SAN 0/1d4 violence])
 *  - the sheet panel's "SAN check" button, which opens the Fright Check dialog
 */
import ChatProcessor from '../../chat/chat-processor.js'
import { FrightCheckChatProcessor } from '../../chat/frightcheck.js'
import { ChatProcessors } from '../../chat.js'
import { readSanityDialog, sanityDialogData, type SanityDialogInput } from './fright-check.ts'
import { registerSanOtfParser, SAN_ACTION } from './otf.ts'
import { performSanCheck, type TargetMod } from './roll.ts'
import { type SanityActor, t } from './data.ts'
import { parseCategory, parseSanCommand, parseSanLoss } from './rules.ts'

const FC_FIELDS_TEMPLATE = 'systems/gurps/templates/agency/sanity-fc-fields.hbs'

/** The trait modifiers the Fright Check dialog would preselect for this actor. */
export function frightTraitMods(actor: SanityActor | null): TargetMod[] {
  if (!actor || typeof actor.findAdvantage !== 'function') return []
  const fc = new FrightCheckChatProcessor() as any
  const i18n = (key: string) => game.i18n!.localize(key)
  const mods: TargetMod[] = []
  try {
    const fear = fc.getFearModifier(actor) || 0
    if (fear)
      mods.push({
        mod: fear,
        desc: `${i18n(fear > 0 ? 'GURPS.traits.fearlessness' : 'GURPS.traits.fearfulness')} ${Math.abs(fear)}`,
      })
    const combat = fc.getCombatModifier(actor) || 0
    if (combat)
      mods.push({
        mod: combat,
        desc: i18n(combat > 0 ? 'GURPS.traits.combatReflexes' : 'GURPS.traits.combatParalysis'),
      })
    const cowardice = fc.getCowardiceModifier(actor) || 0
    if (cowardice) mods.push({ mod: cowardice, desc: i18n('GURPS.traits.cowardice') })
    if (actor.findAdvantage(i18n('GURPS.traits.daredevil'))) mods.push({ mod: 1, desc: i18n('GURPS.traits.daredevil') })
  } catch (err) {
    console.warn('GURPS Agency | sanity: could not read Fright Check traits', err)
  }
  return mods
}

function lastActor(): SanityActor | null {
  return ((GURPS as any).LastActor as SanityActor | null) ?? null
}

class SanChatProcessor extends ChatProcessor {
  match: RegExpMatchArray | null = null

  override help() {
    return '/san &lt;success/failure&gt; [violence|helplessness|unnatural] [description]'
  }

  override matches(line: string) {
    this.match = line.match(/^\/san\s+(.+)$/i)
    return !!this.match
  }

  override usagematches(line: string) {
    return line.match(/^[\/\?]san$/i)
  }

  usage() {
    return t('chat.usage')
  }

  override async process(_line: string) {
    const request = parseSanCommand(this.match?.[1] ?? '')
    if ('error' in request) {
      this.priv(t('errors.badNotation', { text: request.text }))
      return false
    }
    const actor = lastActor()
    if (!actor) {
      ui.notifications?.warn(game.i18n!.localize('GURPS.chatYouMustHaveACharacterSelected'))
      return false
    }
    return (
      (await performSanCheck(actor, {
        loss: request.loss,
        category: request.category,
        source: request.source,
        frightMods: frightTraitMods(actor),
      })) ?? false
    )
  }
}

async function sanAction({ action, actor, calcOnly }: { action: any; actor: any; calcOnly?: boolean }) {
  if (calcOnly) return false
  const loss = parseSanLoss(String(action.loss ?? ''))
  const category = parseCategory(String(action.category ?? ''))
  if (!loss || !category) return false
  const who = (actor && actor.documentName === 'Actor' ? actor : lastActor()) as SanityActor | null
  const result = await performSanCheck(who, {
    loss,
    category,
    source: String(action.desc ?? ''),
    frightMods: frightTraitMods(who),
  })
  return result ?? false
}

export function registerSanCommands(): void {
  ChatProcessors.registerProcessor(new SanChatProcessor() as any)
  registerSanOtfParser()
  ;(GURPS as any).actionFuncs[SAN_ACTION] = sanAction
}

/**
 * The sheet panel's "SAN check" button. GMs get the Fright Check dialog (with its SAN loss fields);
 * players get a compact prompt for the same fields, rolled like /san (the /fc flow is GM-only upstream).
 */
export async function openSanCheckDialog(actor: SanityActor): Promise<void> {
  if (game.user?.isGM) {
    await (new FrightCheckChatProcessor() as any).openDialog(actor)
    return
  }
  const data = sanityDialogData(actor)
  if (!data) return
  const content = await foundry.applications.handlebars.renderTemplate(FC_FIELDS_TEMPLATE, data)
  const input = (await foundry.applications.api.DialogV2.prompt({
    window: { title: t('dialog.title', { name: actor.name }) },
    content: `<div class='gga-app fright-check'>${content}</div>`,
    ok: {
      label: t('dialog.roll'),
      icon: 'fa-solid fa-dice',
      callback: (_event: Event, button: HTMLButtonElement) => readSanityDialog(button.form),
    },
    rejectClose: false,
  } as any)) as SanityDialogInput | null
  if (!input) return
  const loss = parseSanLoss(input.notation)
  if (!loss) {
    ui.notifications?.error(t('errors.badNotation', { text: input.notation }))
    return
  }
  await performSanCheck(actor, { loss, category: input.category, frightMods: frightTraitMods(actor) })
}
