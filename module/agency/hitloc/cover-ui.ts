/**
 * Cover on tokens: a GM-only Token HUD button opens the cover dialog (preset or custom body parts,
 * DR, HP, material). The data lives in the token's flags.gurps.agency.cover; while a token has
 * working cover its actor shows the 'agency-cover' status icon. Removing that status from the HUD's
 * status palette clears the cover; adding it opens the dialog.
 */
import { renderTemplate } from '../defense/foundry-helpers.ts'
import { FLAG_SCOPE } from '../settings.ts'
import { L } from './card.ts'
import { COVER_PRESETS, COVER_ZONES, coverIsActive, coverZones, normalizeCover, type CoverData } from './cover.ts'
import { t, tokenDocOf, type AnyTokenDoc } from './foundry.ts'
import { COVER_FLAG } from './hit-card.ts'

export const COVER_STATUS = 'agency-cover'
const DIALOG_TEMPLATE = 'systems/gurps/templates/agency/hitloc-cover.hbs'
const MATERIALS = ['brick', 'concrete', 'wood', 'sandbags', 'earth', 'carDoor', 'engineBlock', 'steel', 'treeTrunk']

export function readCover(doc: AnyTokenDoc | null): CoverData | null {
  return normalizeCover(doc?.getFlag?.(FLAG_SCOPE, COVER_FLAG))
}

/** Register the status effect that shows cover on the token. Call at ready (after upstream replaces the list). */
export function registerCoverStatus(): void {
  const effects = (CONFIG as any).statusEffects as any[] | undefined
  if (!Array.isArray(effects) || effects.some(e => e?.id === COVER_STATUS)) return
  effects.push({ id: COVER_STATUS, name: `${L}.cover.status`, img: 'icons/svg/shield.svg' })
}

/* ---------------------------------------- */
/*  Dialog                                   */
/* ---------------------------------------- */

function dialogData(cover: CoverData | null): Record<string, unknown> {
  const zones = coverZones(cover)
  const preset = cover?.preset ?? 'none'
  return {
    presets: COVER_PRESETS.map(value => ({
      value,
      label: t(`${L}.cover.preset.${value}`),
      selected: value === preset,
    })),
    dr: cover?.dr ?? 0,
    hp: cover?.hp ?? '',
    hpMax: cover?.hpMax ?? '',
    material: cover?.material ?? '',
    materials: MATERIALS.map(id => t(`${L}.cover.material.${id}`)),
    zones: COVER_ZONES.map(id => ({
      id,
      label: t(`${L}.cover.zone.${id}`),
      states: (['exposed', 'covered', 'half'] as const).map(state => ({
        value: state,
        label: t(`${L}.cover.state.${state}`),
        selected: zones[id] === state,
      })),
    })),
    labels: {
      preset: t(`${L}.cover.dialog.preset`),
      dr: t(`${L}.cover.dialog.dr`),
      hp: t(`${L}.cover.dialog.hp`),
      hpHint: t(`${L}.cover.dialog.hpHint`),
      material: t(`${L}.cover.dialog.material`),
      custom: t(`${L}.cover.dialog.custom`),
      customHint: t(`${L}.cover.dialog.customHint`),
    },
  }
}

function readForm(form: HTMLFormElement | null | undefined): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  const zones: Record<string, string> = {}
  for (const el of Array.from(form?.elements ?? []) as (HTMLInputElement | HTMLSelectElement)[]) {
    if (!el.name) continue
    if (el.name.startsWith('zone.')) zones[el.name.slice(5)] = el.value
    else data[el.name] = el.value
  }
  return { ...data, zones }
}

export async function saveCover(doc: AnyTokenDoc, cover: CoverData | null): Promise<void> {
  if (!cover) {
    if (doc.getFlag?.(FLAG_SCOPE, COVER_FLAG) !== undefined) await doc.unsetFlag(FLAG_SCOPE, COVER_FLAG)
    return
  }
  await doc.update({ [`flags.${FLAG_SCOPE}.${COVER_FLAG}`]: cover })
}

/** The GM's cover dialog for a token. Resolves true if the cover was saved or cleared. */
export async function openCoverDialog(doc: AnyTokenDoc): Promise<boolean> {
  if (!game.user?.isGM || !doc) return false
  const content = await renderTemplate(DIALOG_TEMPLATE, dialogData(readCover(doc)))
  const DialogV2 = (foundry.applications as any).api.DialogV2
  const result = await DialogV2.wait({
    window: { title: t(`${L}.cover.dialog.title`, { name: doc.name ?? '' }), icon: 'fa-solid fa-shield-halved' },
    position: { width: 440 },
    content,
    buttons: [
      {
        action: 'save',
        label: t(`${L}.cover.dialog.save`),
        icon: 'fa-solid fa-check',
        default: true,
        callback: (_event: Event, button: any) => readForm(button?.form),
      },
      { action: 'clear', label: t(`${L}.cover.dialog.clear`), icon: 'fa-solid fa-eraser' },
      { action: 'cancel', label: t(`${L}.cover.dialog.cancel`), icon: 'fa-solid fa-xmark' },
    ],
    rejectClose: false,
  })
  if (!result || result === 'cancel') return false
  await saveCover(doc, result === 'clear' ? null : normalizeCover(result))
  return true
}

/* ---------------------------------------- */
/*  Token HUD                                */
/* ---------------------------------------- */

/** renderTokenHUD: a GM-only cover button in the left column. */
export function decorateTokenHUD(hud: any, html: HTMLElement): void {
  if (!game.user?.isGM) return
  const element = html instanceof HTMLElement ? html : (html as any)?.[0]
  const doc = hud?.document ?? hud?.object?.document
  const column = element?.querySelector?.('.col.left')
  if (!doc || !column || column.querySelector('.agency-cover-hud')) return

  const button = document.createElement('button')
  button.type = 'button'
  button.className = `control-icon agency-cover-hud${coverIsActive(readCover(doc)) ? ' active' : ''}`
  button.dataset.tooltip = t(`${L}.cover.hud`)
  button.setAttribute('aria-label', t(`${L}.cover.hud`))
  button.innerHTML = '<i class="fa-solid fa-shield-halved" inert></i>'
  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    void openCoverDialog(doc).then(() => hud?.render?.())
  })
  column.append(button)
}

/* ---------------------------------------- */
/*  Status icon                              */
/* ---------------------------------------- */

/** Actors whose cover status this client is toggling right now (so the effect hooks ignore it). */
const syncing = new Set<string>()

function isActiveGM(): boolean {
  const gm = (game.users as any)?.activeGM
  return !!game.user?.isGM && (!gm || gm.id === game.user.id)
}

/** Show the status while the token (or, for a linked actor, any of its tokens here) has working cover. */
export async function syncCoverStatus(doc: AnyTokenDoc): Promise<void> {
  const actor = doc?.actor
  if (!actor?.toggleStatusEffect) return
  const docs: AnyTokenDoc[] = actor.isToken ? [doc] : [doc, ...(actor.getActiveTokens?.(false, true) ?? [])]
  const active = docs.some(d => coverIsActive(readCover(d)))
  if (!!actor.statuses?.has?.(COVER_STATUS) === active) return
  const key = actor.uuid ?? actor.id
  syncing.add(key)
  try {
    await actor.toggleStatusEffect(COVER_STATUS, { active })
  } finally {
    syncing.delete(key)
  }
}

export function onUpdateToken(doc: AnyTokenDoc, changes: any): void {
  if (!changes?.flags?.[FLAG_SCOPE]?.agency || !isActiveGM()) return
  void syncCoverStatus(doc).catch(err => console.error('GURPS | Agency | cover status', err))
}

const hasCoverStatus = (effect: any) => !!effect?.statuses?.has?.(COVER_STATUS)

/** The GM added the cover status from the palette: ask for the cover. */
export function onCreateEffect(effect: any, _options: unknown, userId: string): void {
  if (userId !== game.user?.id || !hasCoverStatus(effect)) return
  const actor = effect.parent
  if (!actor || syncing.has(actor.uuid ?? actor.id)) return
  const doc = tokenDocOf(actor)
  if (!doc || readCover(doc)) return
  void openCoverDialog(doc).then(() => syncCoverStatus(doc))
}

/** The GM removed the cover status from the palette: clear the cover. */
export function onDeleteEffect(effect: any, _options: unknown, userId: string): void {
  if (userId !== game.user?.id || !hasCoverStatus(effect)) return
  const actor = effect.parent
  if (!actor || syncing.has(actor.uuid ?? actor.id)) return
  const docs: AnyTokenDoc[] = actor.isToken ? [actor.token] : (actor.getActiveTokens?.(false, true) ?? [])
  for (const doc of docs) if (doc && readCover(doc)) void saveCover(doc, null)
}
