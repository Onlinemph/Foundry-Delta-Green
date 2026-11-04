/**
 * Scene configuration: mobile signal (on unless switched off) and the Maps app's source (off by
 * default, the scene background, or a custom image), stored in flags.gurps.agency.phone. The fields
 * sit at the end of the Basics tab; Foundry's form submission saves them with the rest.
 */
import { renderTemplate } from '../defense/foundry-helpers.ts'
import { mapMode } from './maps.ts'
import { L, phoneEnabled } from './settings.ts'
import { sceneFlags, sceneSignal } from './store.ts'

const TEMPLATE = 'systems/gurps/templates/agency/phone-scene-config.hbs'

async function inject(app: any, html: HTMLElement): Promise<void> {
  const root = html instanceof HTMLElement ? html : (app?.element as HTMLElement | undefined)
  if (!root || root.querySelector('.agency-phone-scene')) return
  const scene = app?.document
  if (!scene) return
  const flags = sceneFlags(scene)
  const content = await renderTemplate(TEMPLATE, {
    signal: sceneSignal(scene),
    map: mapMode(flags.map),
    mapImage: flags.mapImage ?? '',
    mapLabel: flags.mapLabel ?? '',
    mapModes: { off: `${L}.scene.mapOff`, background: `${L}.scene.mapBackground`, custom: `${L}.scene.mapCustom` },
  })
  if (root.querySelector('.agency-phone-scene')) return
  const tab = root.querySelector('.tab[data-tab="basics"]') ?? root.querySelector('.tab') ?? root.querySelector('form')
  if (!tab) return
  tab.insertAdjacentHTML('beforeend', content)
  app.setPosition?.({ height: 'auto' })
}

export function initSceneConfig(): void {
  Hooks.on('renderSceneConfig' as any, (app: any, html: HTMLElement) => {
    if (!game.user?.isGM || !phoneEnabled()) return
    inject(app, html).catch(err => console.error('GURPS | Agency | phone scene config', err))
  })
}
