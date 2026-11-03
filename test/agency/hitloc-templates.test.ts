import Handlebars from 'handlebars'
import { readFileSync } from 'node:fs'
import { cardView, resolveHits, type HitCardFlag, type Translate } from '../../module/agency/hitloc/card.ts'
import type { CoverData } from '../../module/agency/hitloc/cover.ts'
import { markApplied } from '../../module/agency/hitloc/card.ts'

const compile = (name: string) => Handlebars.compile(readFileSync(`templates/agency/${name}`, 'utf8'))
const t: Translate = (key, data) => (data ? `${key.split('.').pop()}${JSON.stringify(data)}` : key.split('.').pop()!)

const BODY = {
  wheres: [
    'Skull',
    'Face',
    'Neck',
    'Torso',
    'Vitals',
    'Groin',
    'Left Arm',
    'Right Arm',
    'Left Leg',
    'Right Leg',
    'Hand',
    'Foot',
    'Eye',
  ],
  table: [],
}
const ref = (name: string) => ({ sceneId: 's', tokenId: name, actorId: name, name })

function card(cover: CoverData | null): HitCardFlag {
  const hits = resolveHits({
    system: 'guhl',
    aim: { target: 'random' },
    aimName: null,
    called: false,
    attack: { type: 'pi', tightBeam: false },
    facing: 'front',
    damages: [10, 3, 9],
    dice: [
      { main: 13, sub: 2 },
      { main: 6, sub: 1 },
      { main: 9, sub: 1 },
    ],
    coverDice: [],
    fresh: () => {
      throw new Error('no dice')
    },
    body: BODY,
    cover,
    armorDivisor: 0,
  })
  return {
    kind: 'hitloc-card',
    attacker: ref('Agent'),
    target: ref('Cultist'),
    userId: 'u',
    weapon: 'Glock 17',
    damageText: '2d+2 pi',
    attack: { type: 'pi', tightBeam: false },
    armorDivisor: 0,
    aimName: null,
    aim: { target: 'random' },
    called: false,
    system: 'guhl',
    facingAuto: 'side',
    facingOverride: null,
    cover,
    hits,
    entries: [],
  }
}

const view = (c: HitCardFlag) => cardView(c, t, { torsoCap: '2', canApply: true, canEditFacing: true, aimLabel: '' })

describe('hit-location card template', () => {
  const template = compile('hitloc-card.hbs')

  test('one row per hit, Apply per hit and Apply all', () => {
    const html = template(view(card(null)))
    expect(html.match(/<tr class=/g)).toHaveLength(3)
    expect(html.match(/data-agency-action='apply'/g)).toHaveLength(3)
    expect(html).toContain("data-agency-action='apply-all'")
    expect(html).toContain("data-hit='2'")
    expect(html).toContain("name='agency-facing'")
    expect(html).toContain('Glock 17')
  })

  test('cover: stopped hits have no Apply button', () => {
    const cover: CoverData = { preset: 'lowWall', dr: 5, hp: 20, hpMax: 20, material: 'Brick' }
    const html = template(view(card(cover)))
    // Leg hits: 10 -> 5 through; 3 -> stopped. The chest is exposed.
    expect(html.match(/data-agency-action='apply'/g)).toHaveLength(2)
    expect(html).toContain('<s>3</s> 0')
    expect(html).toContain('stopped')
    expect(html).toContain('is-through')
  })

  test('all applied: a stamp, no buttons', () => {
    const c = card(null)
    const html = template(view(markApplied(c, [0, 1, 2])))
    expect(html).not.toContain('data-agency-action')
    expect(html).toContain('agency-stamp')
    expect(html).not.toContain("name='agency-facing'")
  })
})

describe('other templates', () => {
  test('note', () => {
    const html = compile('hitloc-note.hbs')({
      title: 'Hit location: Cultist',
      path: 'Neck › Vein/Artery',
      summary: '×2.5 cut',
      notes: ['Bleeding rolls every 30 seconds.'],
      dice: '3d6 17 · 1d6 1',
      facing: 'Attack from the front',
    })
    expect(html).toContain('Neck › Vein/Artery')
    expect(html).toContain('<li>Bleeding rolls every 30 seconds.</li>')
  })

  test('cover dialog', () => {
    const html = compile('hitloc-cover.hbs')({
      presets: [
        { value: 'none', label: 'No cover', selected: false },
        { value: 'lowWall', label: 'Low wall', selected: true },
      ],
      dr: 8,
      hp: 20,
      hpMax: 30,
      material: 'Brick',
      materials: ['Brick', 'Wood'],
      zones: [{ id: 'skull', label: 'Skull', states: [{ value: 'exposed', label: 'Exposed', selected: true }] }],
      labels: {
        preset: 'Cover',
        dr: 'DR',
        hp: 'HP',
        hpHint: '',
        material: 'Material',
        custom: 'Custom',
        customHint: '',
      },
    })
    expect(html).toContain("<option value='lowWall' selected>Low wall</option>")
    expect(html).toContain("name='zone.skull'")
    expect(html).toContain("name='hpMax'")
  })
})
