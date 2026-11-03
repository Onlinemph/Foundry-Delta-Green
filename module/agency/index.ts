/**
 * Entry point for the Agency fork's additions.
 *
 * Upstream files call initAgency() / readyAgency() from module/gurps.js. Everything else the
 * fork adds lives under module/agency, templates/agency, styles/agency and lang/agency, so
 * upstream releases can be merged with few conflicts. Edits to upstream files are marked AGENCY.
 */
import * as theme from './theme/index.ts'
import * as wounds from './wounds/index.ts'
import * as sanity from './sanity/index.ts'
import * as defense from './defense/index.ts'
import * as firearms from './firearms/index.ts'
import * as presets from './presets/index.ts'
import { registerAgencySettingsMenu } from './settings-app.ts'

const features = [theme, wounds, sanity, defense, firearms, presets]

/** Sheet partials shared by all features. Features add their own via registerAgencyPartials(). */
const partials: Record<string, string> = {
  'agency-sheet-panels': 'systems/gurps/templates/agency/sheet-panels.hbs',
  'agency-wounds-panel': 'systems/gurps/templates/agency/wounds-panel.hbs',
  'agency-sanity-panel': 'systems/gurps/templates/agency/sanity-panel.hbs',
}

/** Register extra named partials. Call from a feature's init(). */
export function registerAgencyPartials(more: Record<string, string>): void {
  Object.assign(partials, more)
}

export function initAgency(): void {
  registerAgencySettingsMenu()
  for (const feature of features) feature.init()
  // Register after features so they can add partials in init().
  foundry.applications.handlebars.loadTemplates(partials)
}

export function readyAgency(): void {
  for (const feature of features) feature.ready()
}

/**
 * Hook names the fork adds to upstream code paths.
 *
 * PRE_ROLL fires in doRoll() after actor.canRoll() passes; return false from a handler to cancel the roll.
 * ROLL_COMPLETE fires at the end of _doRoll() once the chat message has been sent.
 */
export const AgencyHooks = {
  PRE_ROLL: 'gurpsAgencyPreRoll',
  ROLL_COMPLETE: 'gurpsAgencyRollComplete',
} as const
