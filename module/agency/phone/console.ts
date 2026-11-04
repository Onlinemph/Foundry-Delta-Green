/**
 * The GM's Handler console: every agent and device, signal at a glance, NPC identities and texts to
 * numbers nobody holds. From here the GM reads any phone, issues or revokes burners, sets numbers,
 * adds contacts, pushes evidence photos, and texts or calls as an NPC.
 */
import { emitSocket, onSocket } from '../defense/socket.ts'
import { FLAG_ROOT, FLAG_SCOPE } from '../settings.ts'
import { openPhone, t } from './app.ts'
import { mapMode } from './maps.ts'
import { formatNumber, generateNumber, validateNumber } from './numbers.ts'
import { areaCode, npcIdentities } from './settings.ts'
import * as store from './store.ts'
import { onPhoneChange } from './sync.ts'
import { deviceIdFor, randomId, type DeviceId, type DeviceKind } from './types.ts'

const TEMPLATE = 'systems/gurps/templates/agency/phone-console.hbs'
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api as any

const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

async function prompt(
  title: string,
  fields: { name: string; label: string; value?: string; type?: string }[]
): Promise<Record<string, string> | null> {
  const content = fields
    .map(f =>
      f.type === 'image'
        ? `<div class="form-group"><label>${esc(f.label)}</label><div class="form-fields"><file-picker name="${f.name}" type="image" value="${esc(f.value ?? '')}"></file-picker></div></div>`
        : `<div class="form-group"><label>${esc(f.label)}</label><div class="form-fields"><input type="text" name="${f.name}" value="${esc(f.value ?? '')}" autocomplete="off"></div></div>`
    )
    .join('')
  return (await (foundry.applications.api.DialogV2 as any).prompt({
    window: { title, icon: 'fa-solid fa-user-secret' },
    classes: ['agency-phone-dialog'],
    content,
    rejectClose: false,
    ok: {
      label: t('save'),
      callback: (_ev: Event, button: HTMLButtonElement) => {
        const out: Record<string, string> = {}
        for (const f of fields) out[f.name] = String((button.form!.elements as any)[f.name]?.value ?? '').trim()
        return out
      },
    },
  })) as Record<string, string> | null
}

async function confirm(title: string, text: string): Promise<boolean> {
  return !!(await (foundry.applications.api.DialogV2 as any).confirm({
    window: { title },
    content: `<p>${esc(text)}</p>`,
    rejectClose: false,
  }))
}

/** Ask for a number until it is valid and free (or cancelled). */
async function askNumber(title: string, current: string, self?: string): Promise<string | null> {
  let value = current ? formatNumber(current) : ''
  for (;;) {
    const res = await prompt(title, [{ name: 'number', label: t('number'), value }])
    if (!res) return null
    value = res.number
    const check = validateNumber(res.number, store.takenNumbers(), areaCode(), self)
    if (!check.ok) {
      ui.notifications?.warn(t(`console.numberError.${check.error}`))
      continue
    }
    if (!check.fictional) ui.notifications?.warn(t('console.notFictional'))
    return check.number
  }
}

function agentRows() {
  const actors = ((game.actors as any)?.contents ?? []).filter(
    (a: any) => store.actorDevices(a).length || (a.type === 'character' && a.hasPlayerOwner)
  )
  return actors
    .sort((a: any, b: any) => a.name.localeCompare(b.name))
    .map((a: any) => {
      const devices = (['smartphone', 'burner'] as DeviceKind[]).map(kind => {
        const record = store.deviceRecord(a, kind)
        if (!record) return { kind }
        const id = deviceIdFor(a.id, kind)
        return { kind, id, number: formatNumber(record.number), unread: store.unreadFor(id) }
      })
      const scene = store.agentScene(a.id)
      const signal = store.deviceHasSignal(deviceIdFor(a.id, 'smartphone'))
      return { id: a.id, name: a.name, img: a.img, devices, signal, where: scene?.name ?? t('console.offscreen') }
    })
}

export class HandlerConsole extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'agency-phone-console',
    classes: ['agency-phone-console-app'],
    window: { title: 'GURPS.agency.phone.console.title', icon: 'fa-solid fa-user-secret', resizable: true },
    position: { width: 720, height: 'auto' as const },
    actions: {
      open: HandlerConsole.#open,
      issue: HandlerConsole.#issue,
      revoke: HandlerConsole.#revoke,
      number: HandlerConsole.#number,
      push: HandlerConsole.#push,
      addContact: HandlerConsole.#addContact,
      npcNew: HandlerConsole.#npcEdit,
      npcEdit: HandlerConsole.#npcEdit,
      npcDelete: HandlerConsole.#npcDelete,
      npcOpen: HandlerConsole.#npcOpen,
      claim: HandlerConsole.#claim,
      toggleSignal: HandlerConsole.#toggleSignal,
    },
  }

  static PARTS = { main: { template: TEMPLATE, scrollable: [''] } }

  #unsubscribe: (() => void) | null = null

  async _prepareContext(options: unknown) {
    const context = await super._prepareContext(options)
    const scene = (canvas as any)?.scene
    const flags = scene ? store.sceneFlags(scene) : {}
    return {
      ...context,
      agents: agentRows(),
      npcs: npcIdentities()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(n => ({
          id: n.id,
          name: n.name || formatNumber(n.number),
          number: formatNumber(n.number),
          img: n.img,
          unread: store.unreadFor(`npc:${n.id}`),
        })),
      unlisted: store.unlistedNumbers().map(u => ({ ...u, label: formatNumber(u.number) })),
      scene: scene
        ? {
            id: scene.id,
            name: scene.name,
            signal: store.sceneSignal(scene),
            mapLabel: t(`console.mapMode.${mapMode(flags.map)}`),
          }
        : null,
    }
  }

  _onFirstRender(context: unknown, options: unknown) {
    super._onFirstRender?.(context, options)
    let timer: ReturnType<typeof setTimeout> | null = null
    this.#unsubscribe = onPhoneChange(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (this.rendered) this.render()
      }, 300)
    })
  }

  async _preClose(options: unknown) {
    await super._preClose?.(options)
    this.#unsubscribe?.()
  }

  static #open(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    openPhone(el.dataset.device as DeviceId, { focus: true })
  }

  static async #issue(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const actor = (game.actors as any)?.get(el.dataset.actor)
    if (!actor) return
    const number = await store.issueDevice(actor, el.dataset.kind as DeviceKind)
    ui.notifications?.info(t('console.issued', { name: actor.name, number: formatNumber(number) }))
  }

  static async #revoke(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const actor = (game.actors as any)?.get(el.dataset.actor)
    const kind = el.dataset.kind as DeviceKind
    if (!actor) return
    if (!(await confirm(t('console.revoke'), t(`console.revokeConfirm.${kind}`, { name: actor.name })))) return
    await store.revokeDevice(actor, kind)
  }

  static async #number(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const actor = (game.actors as any)?.get(el.dataset.actor)
    const kind = el.dataset.kind as DeviceKind
    const record = actor ? store.deviceRecord(actor, kind) : null
    if (!actor || !record) return
    const number = await askNumber(t('console.setNumber'), record.number, record.number)
    if (number && number !== record.number) await store.setDeviceNumber(actor, kind, number)
  }

  static async #addContact(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const id = el.dataset.device as DeviceId
    const res = await prompt(t('console.addContact'), [
      { name: 'name', label: t('name') },
      { name: 'number', label: t('number') },
    ])
    if (!res?.name) return
    const check = validateNumber(res.number, [], areaCode())
    if (!check.ok) {
      ui.notifications?.warn(t('console.numberError.format'))
      return
    }
    await store.saveContact(id, { id: randomId(), name: res.name, number: check.number })
  }

  static async #push(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const id = el.dataset.device as DeviceId
    const res = await prompt(t('console.push'), [
      { name: 'src', label: t('console.image'), type: 'image' },
      { name: 'caption', label: t('console.caption') },
    ])
    if (!res?.src) return
    const size = await new Promise<{ w: number; h: number }>(resolve => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => resolve({ w: 4, h: 3 })
      img.src = res.src
    })
    await store.addPhoto(id, {
      src: res.src,
      caption: res.caption ?? '',
      taken: Number((game.time as any)?.worldTime) || 0,
      ...size,
      origin: 'handler',
      bytes: 0,
      fresh: true,
    })
    const actor = store.actorOf(id)
    for (const user of (game.users as any).contents.filter(
      (u: any) => !u.isGM && u.active && actor?.testUserPermission(u, 3)
    ))
      emitSocket('phone.pushed', user.id, { device: id })
    ui.notifications?.info(t('console.pushed', { name: store.deviceLabel(id) }))
  }

  static async #npcEdit(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const existing = el.dataset.npc ? npcIdentities().find(n => n.id === el.dataset.npc) : undefined
    const taken = store.takenNumbers()
    const res = await prompt(existing ? t('console.npcEdit') : t('console.npcNew'), [
      { name: 'name', label: t('name'), value: existing?.name ?? '' },
      { name: 'number', label: t('console.numberBlank'), value: existing ? formatNumber(existing.number) : '' },
      { name: 'img', label: t('console.portrait'), value: existing?.img ?? '', type: 'image' },
    ])
    if (!res?.name) return
    let number = existing?.number ?? ''
    if (res.number) {
      const check = validateNumber(res.number, taken, areaCode(), existing?.number)
      if (!check.ok) {
        ui.notifications?.warn(t(`console.numberError.${check.error}`))
        return
      }
      if (!check.fictional) ui.notifications?.warn(t('console.notFictional'))
      number = check.number
    }
    if (!number) number = generateNumber(taken, Math.random, areaCode()) ?? ''
    if (!number) return
    await store.upsertNpc({ id: existing?.id, name: res.name, number, img: res.img })
  }

  static async #npcDelete(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const npc = npcIdentities().find(n => n.id === el.dataset.npc)
    if (!npc || !(await confirm(t('console.npcDelete'), t('console.npcDeleteConfirm', { name: npc.name })))) return
    await store.deleteNpc(npc.id)
  }

  static #npcOpen(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    openPhone(`npc:${el.dataset.npc}`, { focus: true })
  }

  static async #claim(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const number = el.dataset.number ?? ''
    const npc =
      npcIdentities().find(n => n.number === number) ?? (await store.upsertNpc({ name: formatNumber(number), number }))
    openPhone(`npc:${npc.id}`, { focus: true })
  }

  static async #toggleSignal(this: HandlerConsole, _ev: Event, el: HTMLElement) {
    const scene = (game.scenes as any)?.get(el.dataset.scene)
    if (!scene) return
    await scene.update({ [`flags.${FLAG_SCOPE}.${FLAG_ROOT}.phone.signal`]: !store.sceneSignal(scene) })
  }
}

let instance: HandlerConsole | null = null
export function openConsole(): void {
  if (!game.user?.isGM) return
  instance ??= new HandlerConsole()
  void instance.render({ force: true })
}

export function initConsoleSocket(onPushed: (device: DeviceId) => void): void {
  onSocket('phone.pushed', (data: any) => {
    if (data?.device) onPushed(data.device)
  })
}
