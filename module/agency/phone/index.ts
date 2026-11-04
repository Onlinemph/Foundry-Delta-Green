/**
 * Agency feature: the in-game phone. Agents carry a smartphone, a burner flip phone, or both; each is
 * a draggable device window you operate by clicking its screen and keys.
 *
 * Storage (see types.ts): devices in actor flags, NPC identities in a world setting, texts and call-log
 * entries as whispered ChatMessages hidden from the chat log, scene signal / map in scene flags,
 * flashlight state in token flags. Calls run live over the system socket (calls.ts).
 */
import { ChatProcessors } from '../../chat.js'
import { openFromPicker, initLauncher, notifyArrival, setConsoleOpener, renderLauncher } from './launcher.ts'
import { openPhone, t } from './app.ts'
import { configureCalls, initCalls } from './calls.ts'
import { PhoneChatProcessor } from './command.ts'
import { initConsoleSocket, openConsole } from './console.ts'
import { initSceneConfig } from './scene-config.ts'
import { onPhoneSettingsChange, phoneEnabled, registerPhoneSettings } from './settings.ts'
import { arrivalText, initSync, onArrival, phoneChanged, readySync } from './sync.ts'
import { deviceLabel, messageFlag, myDevices } from './store.ts'
import { parseDeviceId } from './types.ts'

const HIDDEN = 'agency-phone-hidden'

export function init(): void {
  registerPhoneSettings()

  // Phone texts and call logs are ChatMessages, but never part of the chat log. This runs even with
  // the feature off, so turning it off doesn't spill old texts into the log.
  Hooks.on('renderChatMessageHTML' as any, (message: any, html: HTMLElement) => {
    if (!messageFlag(message) || !(html instanceof HTMLElement)) return
    html.classList.add(HIDDEN)
    html.style.display = 'none'
  })
  // "Clear chat log" would wipe every phone's history: keep phone messages out of a delete-all.
  Hooks.on('preDeleteChatMessage' as any, (message: any, options: any) => {
    if (options?.deleteAll && messageFlag(message) && !options?.agencyPhone) return false
    return undefined
  })

  initSceneConfig()
  ChatProcessors.registerProcessor(new PhoneChatProcessor(openByCommand))

  const gurps = GURPS as any
  gurps.agency = gurps.agency ?? {}
  gurps.agency.phone = { open: openPhone, console: openConsole }
}

function openByCommand(arg: string): void {
  if (!phoneEnabled()) {
    ui.notifications?.warn(t('disabled'))
    return
  }
  if (game.user?.isGM && !arg) {
    openConsole()
    return
  }
  const kind = arg.startsWith('b') ? 'burner' : arg.startsWith('s') ? 'smartphone' : ''
  openFromPicker(
    document.getElementById('agency-phone-launcher'),
    id => !kind || (parseDeviceId(id)?.type === 'actor' && (parseDeviceId(id) as any).kind === kind)
  )
}

// World settings can only be trusted from 'ready', so the feature switches on here.
export function ready(): void {
  if (!phoneEnabled()) return
  initSync()
  initCalls()
  onPhoneSettingsChange(() => phoneChanged())
  configureCalls(
    (id, opts) => void openPhone(id, opts),
    id => notifyArrival(id, null, t('toast.call', { device: deviceLabel(id) }))
  )
  onArrival((id, msg) => notifyArrival(id, msg, arrivalText(id, msg)))
  initConsoleSocket(id => {
    if (myDevices().some(d => d.id === id)) notifyArrival(id, null, t('toast.pushed'))
  })
  setConsoleOpener(openConsole)
  initLauncher()
  readySync()
  renderLauncher()
}
