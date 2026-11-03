/**
 * Optional sweep: import every .gcs file under $GCS_SWEEP_DIR (e.g. a clone of
 * github.com/richardwilkes/gcs_master_library) and report any that crash, raise import errors,
 * or produce obviously broken data. Skipped unless the variable is set:
 *
 *   GCS_SWEEP_DIR=/path/to/gcs_master_library npm test -- gcs-library-sweep
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  captured,
  installImporterModuleMocks,
  loadImporter,
  MockActor,
  resetHarness,
  runImport,
} from './gcs-harness.js'

installImporterModuleMocks()

const dir = process.env.GCS_SWEEP_DIR

function gcsFiles(root: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue
    const path = join(root, name)
    if (statSync(path).isDirectory()) out.push(...gcsFiles(path))
    else if (name.endsWith('.gcs')) out.push(path)
  }
  return out
}

/** Things in the imported data that point at dropped or mangled values. */
function problems(commit: Record<string, any>): string[] {
  const found: string[] = []
  const text = JSON.stringify(commit)
  if (/\bNaN\b|"undefined"|\[object Object\]/.test(text)) {
    for (const m of text.matchAll(/.{60}(NaN|"undefined"|\[object Object\]).{20}/g)) found.push(m[0])
  }
  return found
}

const LISTS = ['ads', 'skills', 'spells', 'notes', 'equipment', 'melee', 'ranged', 'reactions', 'conditionalmods']

;(dir ? describe : describe.skip)('GCS library sweep', () => {
  test('every character imports cleanly', async () => {
    const { ActorImporter } = await loadImporter()
    const report: string[] = []
    const files = gcsFiles(dir!)
    for (const file of files) {
      resetHarness()
      const actor = new MockActor()
      let result: unknown
      try {
        ;({ result } = await runImport(ActorImporter, actor, readFileSync(file, 'utf8'), 'sweep.gcs'))
      } catch (err) {
        report.push(`${file}: THROWN ${(err as Error).stack}`)
        continue
      }
      const errs = [
        ...captured.errors,
        ...captured.notifications.filter(n => n.level !== 'info').map(n => `${n.level}: ${n.message}`),
      ]
      if (!result || errs.length) report.push(`${file}: result=${result} ${errs.join(' | ').slice(0, 600)}`)
      const bad = problems(actor.lastCommit)
      if (bad.length) report.push(`${file}: DATA ${bad.slice(0, 5).join(' || ')}`)

      // Re-importing the same file must not change, duplicate or drop anything.
      const before = JSON.stringify(LISTS.map(k => actor.system[k]))
      await runImport(ActorImporter, actor, readFileSync(file, 'utf8'), 'sweep.gcs')
      if (JSON.stringify(LISTS.map(k => actor.system[k])) !== before)
        report.push(`${file}: RE-IMPORT changed the lists`)
    }
    console.info(`swept ${files.length} files, ${report.length} problems\n${report.join('\n')}`)
    expect(report).toEqual([])
  }, 600_000)
})
