/**
 * Called shots in upstream's hit-location picker (the modifier bucket's "Hit Locations" list, built
 * from HitLocations.hitlocationRolls). GUHL's extra targets are added as entries without a roll, so
 * they never come up on upstream's random table. The defense card reads the chosen "to hit <name>"
 * modifier back through the same list.
 *
 * Upstream labels each entry with GURPS.hitLocation<name>; our names are translated under
 * GURPS.agency.hitloc.picker.* and copied to those keys once translations are loaded.
 */
import * as HitLocations from '../../hitlocation/hitlocation.js'
import { EXTRA_LABELS, PICKER_ENTRIES } from './tables.ts'

export function extendPicker(): void {
  const rolls = (HitLocations as any).hitlocationRolls as Record<string, any> | null
  if (!rolls) return
  for (const entry of PICKER_ENTRIES) {
    if (rolls[entry.name]) continue
    rolls[entry.name] = { penalty: entry.penalty, ...(entry.desc.length ? { desc: entry.desc } : {}) }
  }
}

export function aliasLabels(): void {
  const i18n = game.i18n as any
  if (!i18n?.translations) return
  for (const { name, id } of [...PICKER_ENTRIES, ...EXTRA_LABELS]) {
    const key = `GURPS.hitLocation${name}`
    if (i18n.localize(key) !== key) continue
    const source = `GURPS.agency.hitloc.picker.${id}`
    const label = i18n.localize(source)
    if (label !== source) foundry.utils.setProperty(i18n.translations, key, label)
  }
}

/** Upstream raw hit-location names, and their localized labels, to raw names (for "to hit <name>" modifiers). */
export function hitLocationNames(): Record<string, string> {
  const names: Record<string, string> = {}
  const i18n = game.i18n as any
  for (const raw of Object.keys((HitLocations as any).hitlocationRolls ?? {})) {
    names[raw] = raw
    names[i18n.localize(`GURPS.hitLocation${raw}`)] = raw
  }
  return names
}
