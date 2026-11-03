import { readFileSync } from 'node:fs'
import { COVER_PRESETS, COVER_ZONES } from '../../module/agency/hitloc/cover.ts'
import { resolveHit } from '../../module/agency/hitloc/engine.ts'
import { EXTRA_LABELS, PICKER_ENTRIES, ROW_TARGETS, SPECIAL_TARGETS } from '../../module/agency/hitloc/tables.ts'
import type { DamageType, Facing, TargetId } from '../../module/agency/hitloc/types.ts'

const lang = JSON.parse(readFileSync('lang/agency/en-hitloc.json', 'utf8'))
const upstream = JSON.parse(readFileSync('lang/en.json', 'utf8'))

function has(key: string): boolean {
  const parts = key.split('.')
  // Upstream keys are flat under GURPS ("GURPS.hitLocationDescChest").
  if (parts[1] !== 'agency') return upstream.GURPS?.[parts.slice(1).join('.')] !== undefined
  let node: any = lang
  for (const part of parts) node = node?.[part]
  return typeof node === 'string'
}

const L = 'GURPS.agency.hitloc'
const TYPES: DamageType[] = ['cr', 'cut', 'imp', 'pi-', 'pi', 'pi+', 'pi++', 'burn', 'cor', 'tox', 'other']
const FACINGS: Facing[] = ['front', 'side', 'rear']
const TARGETS = ['random', ...Object.keys(ROW_TARGETS), ...Object.keys(SPECIAL_TARGETS)] as TargetId[]

describe('hit-location translations', () => {
  test('every note and path segment the engine can produce is translated', () => {
    const notes = new Set<string>()
    const segments = new Set<string>()
    for (const target of TARGETS)
      for (const type of TYPES)
        for (const tb of [false, true])
          for (const facing of FACINGS)
            for (let die = 1; die <= 6; die++)
              for (const main of target === 'random' || target === 'chinksOther'
                ? [3, 5, 7, 8, 9, 11, 12, 13, 15, 16, 17]
                : [10]) {
                const r = resolveHit(
                  { target },
                  {
                    attack: { type, tightBeam: tb },
                    facing,
                    roll: (key, n) => (n === 3 ? (key === 'main' ? main : 4) : die),
                  }
                )
                r.notes.forEach(n => notes.add(n))
                r.path.forEach(s => s.key && segments.add(s.key))
                if (r.invalid) segments.add(`target.${r.invalid.target}`)
              }
    expect([...notes].filter(id => !has(`${L}.note.${id}`))).toEqual([])
    expect([...segments].filter(key => !has(`${L}.loc.${key}`))).toEqual([])
    expect(notes.size).toBeGreaterThan(30)
  })

  test('picker labels and descriptions', () => {
    for (const { id, desc } of PICKER_ENTRIES) {
      expect(has(`${L}.picker.${id}`)).toBe(true)
      for (const key of desc) expect([key, has(key)]).toEqual([key, true])
    }
    for (const { id } of EXTRA_LABELS) expect(has(`${L}.picker.${id}`)).toBe(true)
  })

  test('cover dialog', () => {
    for (const preset of COVER_PRESETS) expect(has(`${L}.cover.preset.${preset}`)).toBe(true)
    for (const zone of COVER_ZONES) expect(has(`${L}.cover.zone.${zone}`)).toBe(true)
    for (const state of ['exposed', 'covered', 'half']) expect(has(`${L}.cover.state.${state}`)).toBe(true)
  })

  test('the feature is registered', () => {
    const system = JSON.parse(readFileSync('system.json', 'utf8'))
    expect(system.languages.some((l: any) => l.path === 'lang/agency/en-hitloc.json')).toBe(true)
    expect(readFileSync('styles/agency/_index.scss', 'utf8')).toMatch(/@use 'hitloc';/)
    expect(readFileSync('module/agency/index.ts', 'utf8')).toMatch(/hitloc,/)
  })
})
