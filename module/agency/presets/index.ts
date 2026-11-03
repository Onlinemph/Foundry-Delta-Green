/**
 * Agency feature: campaign presets.
 *
 * "Modern agent" preset for a present-day conspiracy-horror campaign:
 * - turns on the fork's house rules (wounds, SAN, ammo, defense prompts) where those features exist,
 * - turns off upstream Conditional Injury, which conflicts with the wound system,
 * - defaults new actors to TL8,
 * - replaces the NPC generator's example with a field agent.
 *
 * The GM is offered the preset once, on the first ready of a world; it can be re-applied from the settings menu.
 */
import { getAgencySetting, NAMESPACE, registerAgencySetting, setAgencySetting } from '../settings.ts'
import { MODERN_AGENT_MOOK, MODERN_AGENT_SETTINGS, type PresetSetting } from './modern-agent.ts'

const L = 'GURPS.agency.presets'

export function init(): void {
  registerAgencySetting('preset-offered', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  })

  registerAgencySetting('default-tl', {
    name: `${L}.defaultTL.name`,
    hint: `${L}.defaultTL.hint`,
    scope: 'world',
    config: true,
    type: String,
    default: '8',
  })

  // @ts-expect-error - fvtt-types does not know the 'gurps' namespace keys
  game.settings.registerMenu(NAMESPACE, 'agency-preset-menu', {
    name: `${L}.menu.name`,
    label: `${L}.menu.label`,
    hint: `${L}.menu.hint`,
    icon: 'fa-solid fa-user-secret',
    type: PresetMenu,
    restricted: true,
  })

  Hooks.on('preCreateActor', (actor: any, data: any) => {
    const tl = getAgencySetting<string>('default-tl')
    if (!tl) return
    if (foundry.utils.getProperty(data, 'system.traits.techlevel')) return
    actor.updateSource({ 'system.traits.techlevel': tl } as any)
  })
}

export function ready(): void {
  if (!game.user?.isGM) return
  // Only the first active GM offers, so two GMs don't both see the dialog.
  const firstGM = game.users?.activeGM
  if (firstGM && firstGM.id !== game.user.id) return
  if (getAgencySetting<boolean>('preset-offered')) return
  void offerPreset()
}

/** Settings that are registered right now, with the values the preset would write. */
function applicableSettings(): PresetSetting[] {
  const registry = game.settings!.settings as Map<string, unknown>
  return MODERN_AGENT_SETTINGS.filter(s => registry.has(`${NAMESPACE}.${s.key}`))
}

function describeChanges(): string {
  const items = applicableSettings()
    .map(s => `<li>${game.i18n!.localize(s.label)}</li>`)
    .join('')
  return `
    <p>${game.i18n!.localize(`${L}.dialog.intro`)}</p>
    <ul>${items}
      <li>${game.i18n!.localize(`${L}.dialog.tl`)}</li>
      <li>${game.i18n!.localize(`${L}.dialog.mook`)}</li>
    </ul>
    <p class="hint">${game.i18n!.localize(`${L}.dialog.outro`)}</p>`
}

export async function offerPreset(): Promise<boolean> {
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: `${L}.dialog.title`, icon: 'fa-solid fa-user-secret' },
    content: describeChanges(),
    rejectClose: false,
    modal: true,
  } as any)
  await setAgencySetting('preset-offered', true)
  if (confirmed) await applyModernAgentPreset()
  return !!confirmed
}

export async function applyModernAgentPreset(): Promise<void> {
  for (const s of applicableSettings()) {
    // @ts-expect-error - dynamic keys
    await game.settings!.set(NAMESPACE, s.key, s.value)
  }
  await setAgencySetting('default-tl', '8')
  // @ts-expect-error - upstream key, not declared in fvtt-types
  await game.settings!.set(NAMESPACE, 'mook-default', { ...MODERN_AGENT_MOOK })
  ui.notifications?.info(game.i18n!.localize(`${L}.applied`))
}

/** Settings-menu entry: opening it shows the preset dialog instead of a form. */
class PresetMenu extends foundry.applications.api.ApplicationV2 {
  // Deliberately replaces rendering with the confirmation dialog.
  override async render(): Promise<this> {
    await offerPreset()
    return this
  }
}
