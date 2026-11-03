/**
 * Agency sanity: the sheet panel (templates/agency/sanity-panel.hbs) and its listeners.
 * Sheets are upstream AppV1 classes, so everything is wired from hooks rather than subclasses.
 */
import { openSanCheckDialog } from './commands.ts'
import { recordDisorder } from './chat-card.ts'
import {
  bondStartSetting,
  categoryLabel,
  ensureSanityInitialized,
  getSanity,
  newId,
  sanRollMode,
  sanityEnabled,
  type SanityActor,
  sanityUpdate,
  t,
  willOf,
} from './data.ts'
import {
  ADAPTABLE_CATEGORIES,
  ADAPTATION_BOXES,
  type AdaptableCategory,
  atBreakingPoint,
  bondStartingScore,
  clampInt,
  normalizeSanity,
  reconcileSanityChange,
  removeById,
  type SanityData,
  type SanityPatch,
  toggleAdaptation,
  updateById,
} from './rules.ts'

const NUMERIC_FIELDS = ['value', 'max', 'breakingPoint', 'unnatural'] as const
type NumericField = (typeof NUMERIC_FIELDS)[number]

/** Handlebars helper `agencySanityPanel actor`: everything the panel template shows. */
export function panelContext(actor: SanityActor | null | undefined): Record<string, unknown> {
  if (!actor || !sanityEnabled()) return { enabled: false }
  const s = getSanity(actor)
  return {
    enabled: true,
    editable: actor.isOwner && !(actor as any).pack,
    locked: !actor.isOwner || !!(actor as any).pack,
    isGM: !!game.user?.isGM,
    value: s.value,
    max: s.max,
    breakingPoint: s.breakingPoint,
    unnatural: s.unnatural,
    atBreakingPoint: atBreakingPoint(s),
    permanentlyInsane: s.value === 0,
    bonds: s.bonds.map(b => ({ ...b, cssClass: b.score > 0 ? '' : 'agency-sanity-broken' })),
    disorders: s.disorders,
    adaptation: ADAPTABLE_CATEGORIES.map(category => ({
      category,
      label: categoryLabel(category),
      adapted: s.adaptation[category] >= ADAPTATION_BOXES,
      boxes: Array.from({ length: ADAPTATION_BOXES }, (_, index) => ({
        index,
        checked: index < s.adaptation[category],
      })),
    })),
    rollModeLabel: t(`settings.roll.${sanRollMode()}`),
  }
}

async function save(actor: SanityActor, s: SanityData): Promise<void> {
  await actor.update(sanityUpdate(s))
}

/**
 * Lists are written whole, so panel edits must not interleave (e.g. editing a Bond's name and then
 * clicking "add" straight away). Each edit reads the actor's data only after the previous one landed.
 */
const queues = new WeakMap<object, Promise<unknown>>()
function enqueue(actor: SanityActor, edit: () => Promise<void>): Promise<void> {
  const next = (queues.get(actor) ?? Promise.resolve()).catch(() => undefined).then(edit)
  queues.set(actor, next)
  return next
}

async function editNumber(actor: SanityActor, field: NumericField, raw: string): Promise<void> {
  const s = getSanity(actor)
  const patch = reconcileSanityChange(s, { [field]: Number(raw) } as SanityPatch)
  await save(actor, { ...s, ...patch })
}

async function onChange(actor: SanityActor, event: Event): Promise<void> {
  const el = event.target as HTMLInputElement
  if (!el?.dataset) return
  const { sanField, bondField, disorderField, adaptCategory } = el.dataset
  if (!sanField && !bondField && !disorderField && !adaptCategory) return
  // Keep the sheet's own submit-on-change away from fields it does not know about.
  event.stopPropagation()

  const value = el.value
  if (sanField && (NUMERIC_FIELDS as readonly string[]).includes(sanField)) {
    await enqueue(actor, () => editNumber(actor, sanField as NumericField, value))
    return
  }
  // Read everything from the DOM now: a re-render may replace the panel before the edit runs.
  const edit = {
    bondField,
    disorderField,
    adaptCategory,
    value,
    bondId: el.closest<HTMLElement>('[data-bond-id]')?.dataset.bondId,
    disorderId: el.closest<HTMLElement>('[data-disorder-id]')?.dataset.disorderId,
    adaptIndex: parseInt(el.dataset.adaptIndex ?? '0', 10),
  }
  await enqueue(actor, () => editList(actor, edit))
}

interface ListEdit {
  bondField?: string
  disorderField?: string
  adaptCategory?: string
  value: string
  bondId?: string
  disorderId?: string
  adaptIndex: number
}

async function editList(actor: SanityActor, edit: ListEdit): Promise<void> {
  const s = getSanity(actor)
  if (edit.bondField && edit.bondId) {
    const patch = edit.bondField === 'score' ? { score: clampInt(edit.value, 0, 999) } : { name: edit.value.trim() }
    await save(actor, { ...s, bonds: updateById(s.bonds, edit.bondId, patch) })
  } else if (edit.disorderField && edit.disorderId) {
    await save(actor, { ...s, disorders: updateById(s.disorders, edit.disorderId, { name: edit.value.trim() }) })
  } else if (edit.adaptCategory && (ADAPTABLE_CATEGORIES as readonly string[]).includes(edit.adaptCategory)) {
    const category = edit.adaptCategory as AdaptableCategory
    const count = toggleAdaptation(s.adaptation[category], edit.adaptIndex)
    await save(actor, { ...s, adaptation: { ...s.adaptation, [category]: count } })
  }
}

async function onClick(actor: SanityActor, event: Event): Promise<void> {
  const button = (event.target as HTMLElement)?.closest<HTMLElement>('[data-san-action]')
  if (!button) return
  event.preventDefault()
  event.stopPropagation()
  const action = button.dataset.sanAction
  if (action === 'check') return openSanCheckDialog(actor)
  if (action === 'breaking-point') return recordDisorder(actor, true)
  const bondId = button.closest<HTMLElement>('[data-bond-id]')?.dataset.bondId
  const disorderId = button.closest<HTMLElement>('[data-disorder-id]')?.dataset.disorderId
  await enqueue(actor, () => editFromButton(actor, action, bondId, disorderId))
}

async function editFromButton(
  actor: SanityActor,
  action: string | undefined,
  bondId: string | undefined,
  disorderId: string | undefined
): Promise<void> {
  const s = getSanity(actor)
  switch (action) {
    case 'bond-add':
      await save(actor, {
        ...s,
        bonds: [
          ...s.bonds,
          { id: newId(), name: t('newBond'), score: bondStartingScore(willOf(actor), bondStartSetting()) },
        ],
      })
      break
    case 'bond-remove':
      if (bondId) await save(actor, { ...s, bonds: removeById(s.bonds, bondId) })
      break
    case 'disorder-add':
      await save(actor, { ...s, disorders: [...s.disorders, { id: newId(), name: t('newDisorder') }] })
      break
    case 'disorder-remove':
      if (disorderId) await save(actor, { ...s, disorders: removeById(s.disorders, disorderId) })
      break
  }
}

/** renderActorSheet (AppV1): initialise SAN for owners and wire the panel. */
export function onRenderActorSheet(app: any, html: any): void {
  if (!sanityEnabled()) return
  const root: HTMLElement | undefined = html instanceof HTMLElement ? html : html?.[0]
  const panel = root?.querySelector<HTMLElement>('[data-agency-sanity]')
  const actor = (app?.actor ?? app?.document) as SanityActor | undefined
  if (!panel || !actor) return
  void ensureSanityInitialized(actor)
  if (!actor.isOwner || app.isEditable === false) return
  panel.addEventListener('change', event => void onChange(actor, event))
  panel.addEventListener('click', event => void onClick(actor, event))
}

/**
 * preUpdateActor: keep SAN consistent however it is edited (sheet, token bar, macros):
 * Unnatural moves max SAN, max ≤ 99 − Unnatural, current SAN within [0, max].
 */
export function onPreUpdateActor(actor: SanityActor, changes: Record<string, any>): void {
  const patch: SanityPatch = {}
  for (const field of NUMERIC_FIELDS) {
    const v = readChange(changes, `system.sanity.${field}`)
    if (v !== undefined && v !== null && v !== '') patch[field] = Number(v)
  }
  if (Object.keys(patch).length === 0) return
  const fixed = reconcileSanityChange(normalizeSanity(actor.system?.sanity), patch)
  for (const [field, value] of Object.entries(fixed)) writeChange(changes, `system.sanity.${field}`, value)
}

function readChange(changes: Record<string, any>, path: string): unknown {
  return foundry.utils.getProperty(changes, path)
}

function writeChange(changes: Record<string, any>, path: string, value: unknown): void {
  if (path in changes) changes[path] = value
  else foundry.utils.setProperty(changes, path, value)
}
