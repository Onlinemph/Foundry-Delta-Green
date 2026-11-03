/**
 * Agency sanity: hooks for the upstream Fright Check dialog (module/chat/frightcheck.js, /fc).
 *
 * The dialog gets a "SAN loss" field and a source category. After the Fright Check is rolled,
 * success applies the left side of the notation and failure the right ('fright' mode), or a
 * separate d100 ≤ SAN roll decides ('percentile' mode). The Fright Check table is untouched.
 */
import { categoryChoices, I18N, sanRollMode, sanityEnabled, type SanityActor, t } from './data.ts'
import { performSanCheck } from './roll.ts'
import { parseCategory, parseSanLoss, type SanCategory } from './rules.ts'

export interface SanityDialogInput {
  notation: string
  category: SanCategory
}

/** Remember the last values entered in this session so repeated checks are quick. */
let lastInput: SanityDialogInput = { notation: '0/1d6', category: 'none' }

/** Extra template data for templates/frightcheck-macro.hbs (null hides the fields). */
export function sanityDialogData(_actor?: SanityActor | null): Record<string, unknown> | null {
  if (!sanityEnabled()) return null
  return {
    i18n: I18N,
    loss: lastInput.notation,
    category: lastInput.category,
    categories: categoryChoices(),
    modeHint: t(sanRollMode() === 'percentile' ? 'dialog.hintPercentile' : 'dialog.hintFright'),
  }
}

/** Read the SAN fields from the dialog element. Call before the first await (the dialog closes). */
export function readSanityDialog(html: HTMLElement | null | undefined): SanityDialogInput | null {
  if (!sanityEnabled() || !html?.querySelector) return null
  const lossInput = html.querySelector<HTMLInputElement>('#agency-san-loss')
  if (!lossInput) return null
  const notation = String(lossInput.value ?? '').trim()
  const category = parseCategory(html.querySelector<HTMLSelectElement>('#agency-san-category')?.value) ?? 'none'
  lastInput = { notation, category }
  return notation ? { notation, category } : null
}

/** Apply SAN loss after the Fright Check roll. Never throws: the Fright Check flow must carry on. */
export async function applyFrightCheckSanity(
  actor: SanityActor | null,
  input: SanityDialogInput | null,
  result: { failure: boolean; margin: number }
): Promise<void> {
  if (!input) return
  try {
    const loss = parseSanLoss(input.notation)
    if (!loss) {
      ui.notifications?.error(t('errors.badNotation', { text: input.notation }))
      return
    }
    await performSanCheck(actor, {
      loss,
      category: input.category,
      frightCheck: sanRollMode() === 'fright' ? { success: !result.failure, margin: result.margin } : undefined,
    })
  } catch (err) {
    console.error('GURPS Agency | sanity: SAN loss after Fright Check failed', err)
  }
}
