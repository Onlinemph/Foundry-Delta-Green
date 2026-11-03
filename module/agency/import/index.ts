/**
 * Agency feature: GCS import
 *
 * Fixes for importing current GCS (5.x, data version 5) files and a re-import that keeps Foundry-side edits.
 * The importer itself is upstream's module/actor/actor-importer.js; the edits there are marked AGENCY and call into
 * gcs-format.ts (reading GCS fields) and preserve.ts (merging with the actor's existing data).
 */
import { getAgencySetting, registerAgencySetting } from '../settings.ts'
import { ReimportMerger } from './preserve.ts'

export * from './gcs-format.ts'
export { mergePoolTrackers, ReimportMerger } from './preserve.ts'

export const SETTING_PRESERVE = 'import-preserve'

export function init(): void {
  registerAgencySetting(SETTING_PRESERVE, {
    name: 'GURPS.agency.import.preserveName',
    hint: 'GURPS.agency.import.preserveHint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  })
}

export function ready(): void {}

/** Whether re-import keeps Foundry-side edits. Defaults to true when the setting can't be read. */
export function preserveOnReimport(): boolean {
  try {
    const value = getAgencySetting<boolean | null | undefined>(SETTING_PRESERVE)
    return value ?? true
  } catch {
    return true
  }
}

/**
 * The merger for this import, or undefined when the setting is off (upstream behaviour).
 * Takes a snapshot of the actor's lists, so call it before the importer changes anything.
 */
export function createMerger(system: Record<string, any>): ReimportMerger | undefined {
  return preserveOnReimport() ? new ReimportMerger(system) : undefined
}
