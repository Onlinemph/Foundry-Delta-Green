/**
 * Agency feature: hit locations (Grand Unified Hit Locations v2.4) and zonal cover.
 * See docs/agency/hit-locations.md.
 *
 * - Engine (engine.ts, tables.ts): the 3d6 table, sub-tables A-G, called shots and armor gaps.
 * - Body plans (body.ts): results mapped to the defender's own location names; non-humanoid body
 *   plans (and the 'standard' setting) roll on the actor's own table.
 * - Hit card (hit-card.ts): the defense card's damage step resolves a location per hit, checks
 *   cover, and lists the hits with Apply / Apply all (through upstream's Apply Damage dialog).
 * - Apply Damage dialog (dialog.ts): AGENCY hooks in module/damage/applydamage.js; the GUHL detail is
 *   left on the calculator as calculator.agencyHitLocation.
 * - Cover (cover.ts, cover-ui.ts): token flag flags.gurps.agency.cover, GM HUD button, status icon.
 * - Called shots: GUHL targets added to upstream's hit-location picker (picker.ts); miss by 1 (miss-by-one.ts).
 *
 * init() runs in the system 'init' hook; ready() in the system 'ready' hook.
 */
import { registerAgencyPartials } from '../index.ts'
import {
  decorateTokenHUD,
  onCreateEffect,
  onDeleteEffect,
  onUpdateToken,
  openCoverDialog,
  registerCoverStatus,
} from './cover-ui.ts'
import { coveredLocations, rollLocation } from './api.ts'
import { configureDialog, decorateDialog, randomizeHitLocation } from './dialog.ts'
import { decorateHitCard, getHitCard, onDamageRolled, registerHitCardSocket } from './hit-card.ts'
import { onRollComplete } from './miss-by-one.ts'
import { aliasLabels, extendPicker } from './picker.ts'
import { registerHitLocSettings } from './settings.ts'

export type { AgencyHitLocation, HitRequest } from './dialog.ts'

/** Hook the defense card fires after rolling damage (see module/agency/defense/defense-card.ts). */
export const DAMAGE_ROLLED_HOOK = 'gurpsAgencyDamageRolled'

export function init(): void {
  registerHitLocSettings()
  registerAgencyPartials({
    'agency-hitloc-card': 'systems/gurps/templates/agency/hitloc-card.hbs',
    'agency-hitloc-cover': 'systems/gurps/templates/agency/hitloc-cover.hbs',
    'agency-hitloc-note': 'systems/gurps/templates/agency/hitloc-note.hbs',
  })
  extendPicker()

  // Called from upstream's ApplyDamageDialog (AGENCY hooks) and available to non-TS code.
  const gurps = GURPS as any
  gurps.agency = gurps.agency ?? {}
  gurps.agency.hitloc = { configureDialog, randomizeHitLocation, openCoverDialog, rollLocation, coveredLocations }

  Hooks.once('i18nInit' as any, aliasLabels)
  Hooks.on(DAMAGE_ROLLED_HOOK as any, onDamageRolled)
  Hooks.on('gurpsAgencyRollComplete' as any, (data: any) => {
    onRollComplete(data).catch(err => console.error('GURPS | Agency | miss by 1 failed', err))
  })

  Hooks.on('renderChatMessageHTML' as any, (message: any, html: HTMLElement) => {
    const card = getHitCard(message)
    if (card && html instanceof HTMLElement) decorateHitCard(message, html, card)
  })
  Hooks.on('renderApplyDamageDialog' as any, decorateDialog)
  Hooks.on('renderTokenHUD' as any, decorateTokenHUD)
  Hooks.on('updateToken' as any, onUpdateToken)
  Hooks.on('createActiveEffect' as any, onCreateEffect)
  Hooks.on('deleteActiveEffect' as any, onDeleteEffect)
}

export function ready(): void {
  aliasLabels()
  registerCoverStatus()
  registerHitCardSocket()
}
