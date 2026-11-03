/**
 * Reloading: from the sheet's reload icon, the /reload chat command, the change-magazine dialog, or the
 * per-weapon ammo dialog.
 *
 * Every reload goes through the same steps:
 *   1. plan it (planLoad) and refuse early when there is nothing to do;
 *   2. ask the reload gates other features register (readiness: the gun must be ready; Fast-Draw (Ammo));
 *   3. in the actor's update queue, re-plan from fresh data and apply: rounds, the magazine's name,
 *      partial magazines (an ejected magazine with rounds left is kept), equipment counts;
 *   4. post a chat card.
 */
import { isActorInCombat } from '../../combat/utilities.ts'
import {
  ammoFieldName,
  configuredAmmoNames,
  findAmmoItem,
  gunName,
  magazineChoices,
  newPartialId,
  planLoad,
  resolveUnit,
  weaponLabel,
  type AmmoUnit,
  type EquipmentEntry,
  type LoadPlan,
  type MagazineChoice,
  type PartialMagazine,
  type WeaponAmmoState,
} from './ammo.ts'
import { CHANGE_MAGAZINE_TEMPLATE, FLAG_PATH, L10N, RELOAD_CONFIG_TEMPLATE } from './constants.ts'
import { formatRounds, fullLoad, isTracked } from './shots.ts'
import {
  carriedEquipment,
  enqueue,
  findViewById,
  partialMagazines,
  rangedWeapons,
  stateUpdate,
  weaponStates,
  type AmmoActor,
  type WeaponView,
} from './state.ts'

const localize = (key: string) => game.i18n?.localize(`${L10N}.${key}`) ?? key
const format = (key: string, data: Record<string, unknown>) =>
  game.i18n?.format(`${L10N}.${key}`, data as Record<string, string>) ?? key

export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/* ---------------------------------------- */
/*  Where a reload draws from               */
/* ---------------------------------------- */

/** Configured ammo names, then the weapon's Ammo field. */
export function ammoNames(view: WeaponView): string[] {
  const names = configuredAmmoNames(view.state)
  const field = ammoFieldName(view.weapon.ammo)
  if (field && !names.some(n => n.toLowerCase() === field.toLowerCase())) names.push(field)
  return names
}

export interface AmmoSource {
  /** Equipment name looked for ('' when the weapon has none configured and no Ammo field). */
  name: string
  /** Chosen in the weapon's ammo dialog (as opposed to read from its Ammo field). */
  configured: boolean
  /** The first match with some left, else the first match. */
  item?: EquipmentEntry
  unit: AmmoUnit
}

/** Where a quick reload of this weapon draws from (before partial magazines). */
export function ammoSource(actor: AmmoActor, view: WeaponView): AmmoSource {
  const names = ammoNames(view)
  const carried = carriedEquipment(actor)
  let name = names[0] ?? ''
  let item: EquipmentEntry | undefined
  for (const candidate of names) {
    const hit = findAmmoItem(carried, candidate)
    if (hit && hit.count > 0) {
      item = hit
      name = candidate
      break
    }
    if (hit && !item) {
      item = hit
      name = candidate
    }
  }
  return {
    name,
    configured: configuredAmmoNames(view.state).length > 0,
    item,
    unit: resolveUnit(view.state.ammoUnit, view.spec),
  }
}

/** Everything the change-magazine dialog can offer for this weapon. */
export function choicesFor(actor: AmmoActor, view: WeaponView): MagazineChoice[] {
  return magazineChoices({
    spec: view.spec,
    unit: resolveUnit(view.state.ammoUnit, view.spec),
    feedId: view.id,
    names: ammoNames(view),
    carried: carriedEquipment(actor),
    partials: partialMagazines(actor),
    magazine: view.state.magazine,
  })
}

/** "spare: 3 × 9mm Magazine; partial: 2 (5, 12 rds)" for tooltips and /ammo. */
export function spareSummary(actor: AmmoActor, view: WeaponView): string {
  const choices = choicesFor(actor, view)
  const items = choices.filter(c => c.kind === 'item').map(c => format('spare', { count: c.count, item: c.name }))
  const partials = choices.filter(c => c.kind === 'partial')
  const parts = [...items]
  if (partials.length) {
    const rounds = partials.flatMap(c => Array(c.count).fill(c.rounds) as number[])
    parts.push(format('sparePartials', { count: rounds.length, rounds: rounds.join(', ') }))
  }
  return parts.join('; ')
}

/** "Loaded: Glock Magazine (HP)" when the loaded magazine is known. */
export function loadedText(view: WeaponView): string {
  const name = (view.state.magazine ?? '').trim()
  return name ? format('loadedMagazine', { item: name }) : ''
}

/* ---------------------------------------- */
/*  Reload gates                            */
/* ---------------------------------------- */

export interface ReloadGateContext {
  actor: AmmoActor
  view: WeaponView
  inCombat: boolean
}

export interface ReloadGateResult {
  /** false: don't reload. */
  proceed: boolean
  /** Seconds taken off the reload time (Fast-Draw (Ammo)). */
  secondsSaved?: number
  /** Lines (HTML-safe) for the reload chat card; when the reload is refused they are posted on a card of their own. */
  notes?: string[]
}

export type ReloadGate = (context: ReloadGateContext) => Promise<ReloadGateResult>

const gates: ReloadGate[] = []

/** Let another feature check or speed up reloads (readiness: the gun must be ready; Fast-Draw (Ammo)). */
export function registerReloadGate(gate: ReloadGate): void {
  gates.push(gate)
}

async function runGates(context: ReloadGateContext): Promise<Required<ReloadGateResult>> {
  const result = { proceed: true, secondsSaved: 0, notes: [] as string[] }
  for (const gate of gates) {
    let answer: ReloadGateResult
    try {
      answer = await gate(context)
    } catch (err) {
      console.error('GURPS | Agency firearms: reload gate failed', err)
      continue
    }
    result.notes.push(...(answer.notes ?? []))
    result.secondsSaved += Math.max(0, Number(answer.secondsSaved) || 0)
    if (!answer.proceed) return { ...result, proceed: false }
  }
  return result
}

/* ---------------------------------------- */
/*  Reloading                               */
/* ---------------------------------------- */

function inCombat(actor: AmmoActor): boolean {
  return !!actor.id && isActorInCombat(actor.id)
}

function timeText(seconds: number, saved: number, combat: boolean): string {
  if (!(seconds > 0)) return localize('chat.timeUnknown')
  const left = Math.max(0, seconds - saved)
  if (left === 0) return localize('chat.timeInstant')
  const text = format('chat.time', { seconds: left })
  if (!combat) return text
  const turns = Math.ceil(left)
  return `${text} ${turns === 1 ? localize('chat.readyOne') : format('chat.readyMany', { count: turns })}`
}

function planFor(actor: AmmoActor, view: WeaponView, choiceId?: string): { plan: LoadPlan; choices: MagazineChoice[] } {
  const choices = choicesFor(actor, view)
  const plan = planLoad({
    spec: view.spec,
    unit: resolveUnit(view.state.ammoUnit, view.spec),
    loaded: view.loaded,
    choices,
    tracked: ammoNames(view).length > 0,
    choiceId,
  })
  return { plan, choices }
}

function explainRefusal(actor: AmmoActor, view: WeaponView, plan: LoadPlan): void {
  const label = view.label
  if (plan.reason === 'full') return void ui.notifications?.info(format('full', { weapon: label }))
  if (plan.reason === 'untracked') return void ui.notifications?.warn(format('untracked', { weapon: label }))
  if (plan.reason === 'gone') return void ui.notifications?.warn(format('choiceGone', { weapon: label }))
  const source = ammoSource(actor, view)
  if (source.configured && !source.item)
    return void ui.notifications?.warn(format('notCarried', { item: source.name, weapon: label }))
  ui.notifications?.warn(format('noAmmo', { item: source.item?.name ?? source.name, weapon: label }))
}

/**
 * Reload one weapon: a quick reload (full magazine, else the fullest partial), or exactly `choiceId`
 * from the change-magazine dialog. Refuses (with a notification) when it is full, untracked, or out of
 * ammo. Returns true when rounds were loaded. The work runs in the actor's update queue and re-reads the
 * weapon there, so a quick double click plans from the result of the first reload.
 */
export async function reloadWeapon(actor: AmmoActor, view: WeaponView, choiceId?: string): Promise<boolean> {
  const current = findViewById(actor, view.id) ?? view
  if (!isTracked(current.spec)) {
    ui.notifications?.warn(format('untracked', { weapon: current.label }))
    return false
  }
  const first = planFor(actor, current, choiceId)
  if (!first.plan.ok) {
    explainRefusal(actor, current, first.plan)
    return false
  }

  const combat = inCombat(actor)
  const gate = await runGates({ actor, view: current, inCombat: combat })
  if (!gate.proceed) {
    if (gate.notes.length) await postCard(actor, current.label, gate.notes)
    return false
  }

  const loaded = await enqueue(actor, view.id, 0, () => loadNow(actor, view.id, choiceId, gate, combat))
  return loaded === true
}

async function loadNow(
  actor: AmmoActor,
  feedId: string,
  choiceId: string | undefined,
  gate: Required<ReloadGateResult>,
  combat: boolean
): Promise<boolean> {
  const view = findViewById(actor, feedId)
  if (!view) return false
  const { plan, choices } = planFor(actor, view, choiceId)
  if (!plan.ok) {
    explainRefusal(actor, view, plan)
    return false
  }

  const label = view.label
  const choice = plan.choice
  const lines: string[] = []
  const rounds = formatRounds(plan.newLoaded, view.spec)
  const swaps = resolveUnit(view.state.ammoUnit, view.spec) === 'magazines' && !view.spec.individual
  const picked = choiceId !== undefined && !!choice
  const text = { weapon: escapeHtml(label), item: escapeHtml(choice?.name ?? ''), rounds }
  if (view.spec.individual) lines.push(format(picked ? 'chat.loadOneFrom' : 'chat.loadOne', text))
  else if (picked) lines.push(format(swaps ? 'chat.change' : 'chat.reloadFrom', text))
  else lines.push(format('chat.reload', text))

  // The magazine coming out: kept as a partial, back with the full ones, or (free reloads) gone.
  let partials: PartialMagazine[] | undefined
  let returnTo: string | undefined
  if (plan.ejected > 0) {
    const tracked = ammoNames(view).length > 0
    const from = (view.state.magazine ?? '').trim() || choices.find(c => c.kind === 'item')?.name || ''
    if (!tracked || !from) lines.push(format('chat.oldMagazine', { count: plan.ejected }))
    else if (plan.ejected >= view.spec.capacity && findExact(carriedEquipment(actor), from)) {
      returnTo = from
    } else {
      const existing = partialMagazines(actor)
      const partial: PartialMagazine = {
        id: newPartialId(existing, Date.now()),
        item: from,
        rounds: plan.ejected,
        capacity: view.spec.capacity,
        feed: view.id,
      }
      partials = [...existing, partial]
      lines.push(format('chat.partialKept', { item: escapeHtml(from), count: plan.ejected }))
    }
  }

  if (choice?.kind === 'partial') {
    const used = choice.partialIds?.[0]
    partials = (partials ?? partialMagazines(actor)).filter(p => p.id !== used)
    lines.push(format('chat.partialLoaded', { item: escapeHtml(choice.name), count: choice.rounds }))
  }

  const data: WeaponAmmoState = { loaded: plan.newLoaded }
  if (choice) data.magazine = choice.name
  else if (!ammoNames(view).length) data.magazine = ''
  await actor.update(stateUpdate(actor, view, { data, partials }))

  if (choice?.kind === 'item' && plan.itemUsed > 0 && actor.updateEqtCount) {
    const entry = carriedEquipment(actor).find(e => e.path === choice.path)
    if (entry) {
      const left = Math.max(0, entry.count - plan.itemUsed)
      await actor.updateEqtCount(entry.path, left)
      lines.push(format('chat.used', { count: plan.itemUsed, item: escapeHtml(entry.name), left }))
    }
  }

  if (returnTo && actor.updateEqtCount) {
    // Read the count after the one used above: the same item may have gone out and come back.
    const entry = findExact(carriedEquipment(actor), returnTo)!
    await actor.updateEqtCount(entry.path, entry.count + 1)
    lines.push(format('chat.returned', { item: escapeHtml(entry.name), count: entry.count + 1 }))
  }

  lines.push(timeText(plan.seconds, gate.secondsSaved, combat))
  lines.push(...gate.notes)

  await postCard(actor, label, lines)
  return true
}

function findExact(entries: EquipmentEntry[], name: string): EquipmentEntry | undefined {
  const wanted = name.trim().toLowerCase()
  return entries.find(e => e.name.trim().toLowerCase() === wanted)
}

async function postCard(actor: AmmoActor, title: string, lines: string[]): Promise<void> {
  const content = `<div class="agency-chat-card agency-firearms-card">
  <header class="agency-chat-card-header"><span class="agency-firearms-card-title"><i class="fa-solid fa-rotate-right"></i> ${escapeHtml(title)}</span></header>
  <div class="agency-chat-card-body">
  ${lines.map(line => `<p>${line}</p>`).join('\n  ')}
  </div>
</div>`
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: actor as any }),
    content,
  } as any)
}

/* ---------------------------------------- */
/*  Change magazine dialog                  */
/* ---------------------------------------- */

/**
 * List the magazines and ammo carried for this weapon (configured items, Ammo field matches,
 * partial magazines) and load the one picked: the current magazine is ejected first.
 */
export async function changeMagazine(actor: AmmoActor, view: WeaponView): Promise<boolean> {
  const current = findViewById(actor, view.id) ?? view
  if (!isTracked(current.spec)) {
    ui.notifications?.warn(format('untracked', { weapon: current.label }))
    return false
  }
  const choices = choicesFor(actor, current)
  if (!choices.length) {
    ui.notifications?.warn(format('noChoices', { weapon: current.label }))
    return false
  }

  const unit = resolveUnit(current.state.ammoUnit, current.spec)
  const swaps = unit === 'magazines' && !current.spec.individual
  const firstLoadable = choices.find(c => c.count > 0 && c.rounds > 0)
  const content = await foundry.applications.handlebars.renderTemplate(CHANGE_MAGAZINE_TEMPLATE, {
    weapon: current.label,
    rounds: formatRounds(current.loaded, current.spec),
    loadedText: loadedText(current),
    swaps,
    hint: swaps ? localize('change.hintSwap') : localize('change.hintRounds'),
    rows: choices.map(c => ({
      id: c.id,
      name: c.name,
      partial: c.kind === 'partial',
      rounds: swaps ? `${c.rounds}/${c.capacity}` : String(c.rounds),
      count: c.count,
      current: c.current,
      disabled: !(c.count > 0 && c.rounds > 0),
      checked: c.id === firstLoadable?.id,
      cls: [c.current ? 'is-current' : '', c.count > 0 && c.rounds > 0 ? '' : 'is-bad'].filter(Boolean).join(' '),
    })),
  })

  const choiceId = (await foundry.applications.api.DialogV2.prompt({
    window: { title: format('change.title', { weapon: current.label }), icon: 'fa-solid fa-right-left' },
    classes: ['agency-firearms-dialog'],
    content,
    rejectClose: false,
    ok: {
      label: localize(swaps ? 'change.load' : 'change.loadRounds'),
      icon: 'fa-solid fa-right-left',
      callback: (_event: Event, button: HTMLButtonElement) => {
        const picked = button.form?.querySelector<HTMLInputElement>('input[name="choice"]:checked')
        return picked?.value ?? null
      },
    },
  } as any)) as string | null

  if (!choiceId) return false
  return reloadWeapon(actor, current, choiceId)
}

/* ---------------------------------------- */
/*  Per-weapon ammo dialog                  */
/* ---------------------------------------- */

export async function configureWeapon(actor: AmmoActor, view: WeaponView): Promise<void> {
  const current = findViewById(actor, view.id) ?? view
  const autoUnit = resolveUnit('', current.spec)
  const unit = current.state.ammoUnit ?? ''
  const configured = configuredAmmoNames(current.state)
  const gun = gunName(view.weapon).toLowerCase()
  const siblings = rangedWeapons(actor).filter(e => e.path !== view.path && gunName(e.value).toLowerCase() === gun)
  const content = await foundry.applications.handlebars.renderTemplate(RELOAD_CONFIG_TEMPLATE, {
    weapon: current.label,
    usage: weaponLabel(view.weapon),
    shots: String(view.weapon.shots ?? ''),
    loaded: current.loaded,
    full: fullLoad(current.spec),
    rounds: formatRounds(current.loaded, current.spec),
    // The configured names plus two blank lines for more; the first shows the Ammo field as a hint.
    ammoItems: [...configured, '', ''].map((value, index) => ({
      value,
      placeholder: index === 0 ? ammoFieldName(view.weapon.ammo) : '',
    })),
    spare: spareSummary(actor, current),
    loadedText: loadedText(current),
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
    // Only worth offering when another usage of the same gun exists.
    showSeparate: siblings.length > 0 || !!weaponStates(actor)[view.modeId]?.separate,
    separate: !!weaponStates(actor)[view.modeId]?.separate,
    sharedWith: current.modes > 1 ? format('config.sharedWith', { count: current.modes }) : '',
  })

  const result = (await foundry.applications.api.DialogV2.prompt({
    window: { title: format('config.title', { weapon: weaponLabel(view.weapon) }) },
    classes: ['agency-firearms-dialog'],
    content,
    rejectClose: false,
    ok: {
      label: localize('config.save'),
      callback: (_event: Event, button: HTMLButtonElement) => {
        const form = button.form!
        const elements = form.elements as any
        return {
          loaded: Number(elements.loaded?.value),
          ammoItems: [...form.querySelectorAll<HTMLInputElement>('input[name="ammoItem"]')].map(i => i.value.trim()),
          ammoUnit: String(elements.ammoUnit?.value ?? ''),
          separate: !!elements.separate?.checked,
        }
      },
    },
  } as any)) as { loaded: number; ammoItems: string[]; ammoUnit: string; separate: boolean } | null

  if (!result) return
  const data: WeaponAmmoState = {
    ammoItems: configuredAmmoNames({ ammoItems: result.ammoItems }),
    ammoItem: '',
    ammoUnit: result.ammoUnit === 'magazines' || result.ammoUnit === 'rounds' ? result.ammoUnit : '',
  }
  if (Number.isFinite(result.loaded) && result.loaded !== current.loaded)
    data.loaded = Math.max(0, Math.min(fullLoad(current.spec), Math.floor(result.loaded)))

  const wasSeparate = !!weaponStates(actor)[view.modeId]?.separate
  await enqueue(actor, current.id, 0, async () => {
    if (result.separate === wasSeparate) return actor.update(stateUpdate(actor, current, { data }))
    if (result.separate) {
      // Split this usage off: its own feed starts with these settings, full unless a count was given.
      const update: Record<string, unknown> = {
        [`${FLAG_PATH}.${view.modeId}`]: { key: view.modeKey, separate: true, ...data },
      }
      return actor.update(update)
    }
    // Back to the shared magazine: the separate entry goes, the shared feed keeps its own state.
    return actor.update({ [`${FLAG_PATH}.-=${view.modeId}`]: null })
  })
}
