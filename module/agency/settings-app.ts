import { GurpsSettingsApplication } from '../utilities/gurps-settings-application.ts'
import { groupedSettingKeys, NAMESPACE } from './settings.ts'

/** One window for every GM-facing Agency setting (see groupedSettingKeys). */
class AgencySettingsApplication extends GurpsSettingsApplication {
  constructor(options?: any) {
    super(
      { title: game.i18n!.localize('GURPS.agency.settings.title'), module: 'agency', icon: 'fa-solid fa-folder-closed' },
      options
    )
  }

  protected override _selectSettings(): any[] {
    const registry = game.settings!.settings as Map<string, any>
    return groupedSettingKeys
      .map(key => registry.get(`${NAMESPACE}.${key}`))
      .filter(setting => !!setting && setting.type !== Object && setting.type !== Array)
  }
}

export function registerAgencySettingsMenu(): void {
  // @ts-expect-error - fvtt-types does not know the 'gurps' namespace keys
  game.settings.registerMenu(NAMESPACE, 'agency-settings-menu', {
    name: 'GURPS.agency.settings.name',
    label: 'GURPS.agency.settings.label',
    hint: 'GURPS.agency.settings.hint',
    icon: 'fa-solid fa-folder-closed',
    type: AgencySettingsApplication,
    restricted: true,
  })
}
