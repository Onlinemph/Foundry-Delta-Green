/**
 * Reloading: from the sheet's reload icon, the /reload chat command, or the per-weapon dialog.
 */
import { isActorInCombat } from '../../combat/utilities.ts'
import {
  ammoFieldName,
  findAmmoItem,
  planReload,
  resolveUnit,
  weaponLabel,
  type AmmoUnit,
  type EquipmentEntry,
  type WeaponAmmoState,
} from './ammo.ts'
import { L10N, RELOAD_CONFIG_TEMPLATE } from './constants.ts'
import { formatRounds, fullLoad, isTracked } from './shots.ts'
import { carriedEquipment, enqueue, findViewById, writeState, type AmmoActor, type WeaponView } from './state.ts'

const localize = (key: string) => game.i18n?.localize(`${L10N}.${key}`) ?? key
const format = (key: string, data: Record<string, unknown>) =>
  game.i18n?.format(`${L10N}.${key}`, data as Record<string, string>) ?? key

export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

export interface AmmoSource {
  /** Equipment name looked for ('' when the weapon has none configured and no Ammo field). */
  name: string
  /** Chosen in the weapon's ammo dialog (as opposed to read from its Ammo field). */
  configured: boolean
  item?: EquipmentEntry
  unit: AmmoUnit
}

/** Where a reload of this weapon draws from. */
export function ammoSource(actor: AmmoActor, view: WeaponView): AmmoSource {
  const configured = (view.state.ammoItem ?? '').trim()
  const name = configured || ammoFieldName(view.weapon.ammo)
  const item = name ? findAmmoItem(carriedEquipment(actor), name) : undefined
  return { name, configured: !!configured, item, unit: resolveUnit(view.state.ammoUnit, view.spec) }
}

/** "3 × 9mm Magazine" for tooltips and /ammo. */
export function spareText(source: AmmoSource): string {
  if (!source.item) return ''
  return format('spare', { count: source.item.count, item: source.item.name })
}

function timeText(seconds: number, inCombat: boolean): string {
  if (!(seconds > 0)) return localize('chat.timeUnknown')
  const text = format('chat.time', { seconds })
  if (!inCombat) return text
  const turns = Math.ceil(seconds)
  return `${text} ${turns === 1 ? localize('chat.readyOne') : format('chat.readyMany', { count: turns })}`
}

/**
 * Reload one weapon. Refuses (with a notification) when it is full, untracked, or its ammo item is used up.
 * Returns true when rounds were loaded. Runs in the actor's update queue and re-reads the weapon there,
 * so a quick double click plans from the result of the first reload.
 */
export async function reloadWeapon(actor: AmmoActor, view: WeaponView): Promise<boolean> {
  const loaded = await enqueue(actor, view.id, 0, () => reloadNow(actor, findViewById(actor, view.id) ?? view))
  return loaded === true
}

async function reloadNow(actor: AmmoActor, view: WeaponView): Promise<boolean> {
  const label = weaponLabel(view.weapon)
  if (!isTracked(view.spec)) {
    ui.notifications?.warn(format('untracked', { weapon: label }))
    return false
  }

  const source = ammoSource(actor, view)
  if (source.configured && !source.item) {
    ui.notifications?.warn(format('notCarried', { item: source.name, weapon: label }))
    return false
  }

  const plan = planReload(view.spec, view.loaded, source.unit, source.item ? source.item.count : null)
  if (!plan.ok) {
    if (plan.reason === 'full') ui.notifications?.info(format('full', { weapon: label }))
    else if (plan.reason === 'no-ammo')
      ui.notifications?.warn(format('noAmmo', { item: source.item?.name ?? source.name, weapon: label }))
    else ui.notifications?.warn(format('untracked', { weapon: label }))
    return false
  }

  await writeState(actor, view, { loaded: plan.newLoaded })
  if (source.item && plan.itemUsed > 0 && actor.updateEqtCount)
    await actor.updateEqtCount(source.item.path, Math.max(0, source.item.count - plan.itemUsed))

  const rounds = formatRounds(plan.newLoaded, view.spec)
  const lines = [
    view.spec.individual
      ? format('chat.loadOne', { weapon: escapeHtml(label), rounds })
      : format('chat.reload', { weapon: escapeHtml(label), rounds }),
  ]
  if (source.item && plan.itemUsed > 0)
    lines.push(
      format('chat.used', {
        count: plan.itemUsed,
        item: escapeHtml(source.item.name),
        left: Math.max(0, source.item.count - plan.itemUsed),
      })
    )
  if (plan.leftInOldMagazine > 0) lines.push(format('chat.oldMagazine', { count: plan.leftInOldMagazine }))
  lines.push(timeText(plan.seconds, !!actor.id && isActorInCombat(actor.id)))

  await postCard(actor, label, lines)
  return true
}

async function postCard(actor: AmmoActor, title: string, lines: string[]): Promise<void> {
  const content = `<div class="agency-chat-card agency-firearms-card">
  <div class="agency-firearms-card-title"><i class="fa-solid fa-rotate-right"></i> ${escapeHtml(title)}</div>
  ${lines.map(line => `<p>${line}</p>`).join('\n  ')}
</div>`
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: actor as any }),
    content,
  } as any)
}

/* ---------------------------------------- */
/*  Per-weapon ammo dialog                  */
/* ---------------------------------------- */

export async function configureWeapon(actor: AmmoActor, view: WeaponView): Promise<void> {
  const label = weaponLabel(view.weapon)
  const source = ammoSource(actor, view)
  const autoUnit = resolveUnit('', view.spec)
  const unit = view.state.ammoUnit ?? ''
  const content = await foundry.applications.handlebars.renderTemplate(RELOAD_CONFIG_TEMPLATE, {
    weapon: label,
    shots: String(view.weapon.shots ?? ''),
    loaded: view.loaded,
    full: fullLoad(view.spec),
    rounds: formatRounds(view.loaded, view.spec),
    ammoItem: view.state.ammoItem ?? '',
    ammoField: ammoFieldName(view.weapon.ammo),
    matched: source.item ? `${source.item.name} (${source.item.count})` : '',
    items: [
      ...new Set(
        carriedEquipment(actor)
          .map(e => e.name)
          .filter(Boolean)
      ),
    ],
    unit,
    units: {
      '': format('config.unitAuto', { unit: localize(`config.unit.${autoUnit}`) }),
      magazines: localize('config.unit.magazines'),
      rounds: localize('config.unit.rounds'),
    },
  })

  const result = (await foundry.applications.api.DialogV2.prompt({
    window: { title: format('config.title', { weapon: label }) },
    content,
    rejectClose: false,
    ok: {
      label: localize('config.save'),
      callback: (_event: Event, button: HTMLButtonElement) => {
        const elements = button.form!.elements as any
        return {
          loaded: Number(elements.loaded?.value),
          ammoItem: String(elements.ammoItem?.value ?? '').trim(),
          ammoUnit: String(elements.ammoUnit?.value ?? ''),
        }
      },
    },
  } as any)) as { loaded: number; ammoItem: string; ammoUnit: string } | null

  if (!result) return
  const data: WeaponAmmoState = {
    ammoItem: result.ammoItem,
    ammoUnit: result.ammoUnit === 'magazines' || result.ammoUnit === 'rounds' ? result.ammoUnit : '',
  }
  if (Number.isFinite(result.loaded) && result.loaded !== view.loaded)
    data.loaded = Math.max(0, Math.min(fullLoad(view.spec), Math.floor(result.loaded)))
  await enqueue(actor, view.id, 0, () => writeState(actor, view, data))
}
