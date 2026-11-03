import {
  cardView,
  chooseAim,
  coverHpAfter,
  markApplied,
  noteTexts,
  pathText,
  pendingHits,
  resolveHits,
  summaryText,
  withFacing,
  type BodyInfo,
  type HitCardFlag,
  type Translate,
} from '../../module/agency/hitloc/card.ts'
import type { CoverData } from '../../module/agency/hitloc/cover.ts'
import { resolveHit } from '../../module/agency/hitloc/engine.ts'
import type { AttackType, Roller } from '../../module/agency/hitloc/types.ts'

const L = 'GURPS.agency.hitloc'

const WORDS: Record<string, string> = {
  [`${L}.loc.leg`]: 'Leg',
  [`${L}.loc.thigh`]: 'Thigh',
  [`${L}.loc.veinArtery`]: 'Vein/Artery',
  [`${L}.loc.chest`]: 'Chest',
  [`${L}.loc.spine`]: 'Spine',
  [`${L}.side.left`]: 'Left',
  [`${L}.side.right`]: 'Right',
}

/** Known words, else "key{json}" so tests can see what was asked for. */
const t: Translate = (key, data) => {
  if (key === `${L}.withSide`) return `${data!.part} (${data!.side})`
  return WORDS[key] ?? (data ? `${key}${JSON.stringify(data)}` : key)
}

const noDice: Roller = key => {
  throw new Error(`unexpected roll '${key}'`)
}

const BODY: BodyInfo = {
  wheres: [
    'Eye',
    'Skull',
    'Face',
    'Right Leg',
    'Right Arm',
    'Torso',
    'Groin',
    'Left Arm',
    'Left Leg',
    'Hand',
    'Foot',
    'Neck',
    'Vitals',
  ],
  table: [],
}

const CUT: AttackType = { type: 'cut', tightBeam: false }
const ref = (name: string) => ({ sceneId: 's', tokenId: name, actorId: name, name })

function card(over: Partial<HitCardFlag> = {}): HitCardFlag {
  const base: HitCardFlag = {
    kind: 'hitloc-card',
    attacker: ref('Agent'),
    target: ref('Cultist'),
    userId: 'u1',
    weapon: 'Machete',
    damageText: '2d cut',
    attack: CUT,
    armorDivisor: 0,
    aimName: null,
    aim: { target: 'random' },
    called: false,
    system: 'guhl',
    facingAuto: 'front',
    facingOverride: null,
    cover: null,
    hits: [],
    entries: [],
  }
  return { ...base, ...over }
}

describe('aim', () => {
  test('a named location is a called shot', () => {
    expect(chooseAim('Spine', 'Torso')).toEqual({ aim: { target: 'spine', side: null }, called: true, known: true })
    expect(chooseAim('Left Arm', 'Random')).toEqual({
      aim: { target: 'arm', side: 'left' },
      called: true,
      known: true,
    })
  })

  test('random-ish targets are not called shots', () => {
    expect(chooseAim('Chinks in Other', 'Torso').called).toBe(false)
    expect(chooseAim('Limb', 'Torso').called).toBe(false)
  })

  test("a name GUHL doesn't know is called, but resolved on the body plan's table", () => {
    expect(chooseAim('Wing', 'Torso')).toEqual({ aim: { target: 'chest' }, called: true, known: false })
  })

  test("no location: upstream's default", () => {
    expect(chooseAim(null, 'Random')).toEqual({ aim: { target: 'random' }, called: false, known: true })
    expect(chooseAim(null, 'Torso')).toEqual({ aim: { target: 'chest' }, called: false, known: true })
    expect(chooseAim('', 'Torso')).toEqual({ aim: { target: 'chest' }, called: false, known: true })
  })
})

describe('resolving every hit', () => {
  const dice: Record<string, number>[] = [{ main: 14, sub: 6 }, { main: 10, sub: 1 }, { main: 3 }]

  test('a location per hit, mapped onto the body plan', () => {
    const hits = resolveHits({
      system: 'guhl',
      aim: { target: 'random' },
      aimName: null,
      called: false,
      attack: CUT,
      facing: 'front',
      damages: [9, 7, 5],
      dice: dice.map(d => ({ ...d })),
      coverDice: [],
      fresh: noDice,
      body: BODY,
      cover: null,
      armorDivisor: 0,
    })
    expect(hits.map(h => h.result.part)).toEqual(['limbVein', 'chest', 'skull'])
    expect(hits.map(h => h.where)).toEqual(['Left Leg', 'Torso', 'Skull'])
    expect(hits.map(h => h.finalDamage)).toEqual([9, 7, 5])
    expect(hits.every(h => !h.applied && h.cover === null)).toBe(true)
  })

  test('new dice are recorded per hit', () => {
    const recorded = [{}, {}] as Record<string, number>[]
    let n = 0
    const fresh: Roller = (key, count) => (key === 'main' ? [9, 13][n++] : count === 1 ? 2 : 10)
    resolveHits({
      system: 'guhl',
      aim: { target: 'random' },
      aimName: null,
      called: false,
      attack: CUT,
      facing: 'front',
      damages: [4, 4],
      dice: recorded,
      coverDice: [],
      fresh,
      body: BODY,
      cover: null,
      armorDivisor: 0,
    })
    expect(recorded).toEqual([
      { main: 9, sub: 2 },
      { main: 13, sub: 2 },
    ])
  })

  test('standard system rolls on the body table', () => {
    const hits = resolveHits({
      system: 'standard',
      aim: { target: 'random' },
      aimName: null,
      called: false,
      attack: CUT,
      facing: 'front',
      damages: [6],
      dice: [{ main: 7 }],
      coverDice: [],
      fresh: noDice,
      body: {
        wheres: ['Foreleg', 'Torso'],
        table: [
          { where: 'Foreleg', roll: [7, 8] },
          { where: 'Torso', roll: [9] },
        ],
      },
      cover: null,
      armorDivisor: 0,
    })
    expect(hits[0].where).toBe('Foreleg')
    expect(hits[0].result.system).toBe('standard')
  })

  test('cover HP is tracked from hit to hit', () => {
    const cover: CoverData = { preset: 'lowWall', dr: 5, hp: 10, hpMax: 10, material: 'Wood' }
    const hits = resolveHits({
      system: 'guhl',
      aim: { target: 'random' },
      aimName: null,
      called: false,
      attack: CUT,
      facing: 'front',
      damages: [12, 9, 8, 8],
      dice: [{ main: 13, sub: 2 }, { main: 6, sub: 5 }, { main: 3 }, { main: 14, sub: 1 }],
      coverDice: [],
      fresh: noDice,
      body: BODY,
      cover,
      armorDivisor: 0,
    })
    // Leg: 12 vs DR 5 -> 7 through, cover 10 -> 3. Leg: 9 -> 4 through, cover 3 -> -1 (destroyed).
    // Skull: exposed. Leg again: the wall is gone.
    expect(hits.map(h => h.finalDamage)).toEqual([7, 4, 8, 8])
    expect(hits.map(h => h.cover?.hitsCover)).toEqual([true, true, false, false])
    expect(hits[1].cover?.destroyed).toBe(true)
    expect(coverHpAfter({ cover, hits })).toBe(-1)
  })

  test('no cover HP change when nothing hit the cover', () => {
    expect(coverHpAfter({ cover: null, hits: [] })).toBeNull()
    const cover: CoverData = { preset: 'lowWall', dr: 5, hp: null, hpMax: null, material: '' }
    expect(coverHpAfter({ cover, hits: [] })).toBeNull()
  })
})

describe('card state', () => {
  function chestCard(): HitCardFlag {
    const hits = resolveHits({
      system: 'guhl',
      aim: { target: 'random' },
      aimName: null,
      called: false,
      attack: CUT,
      facing: 'front',
      damages: [6, 5],
      dice: [
        { main: 9, sub: 1 },
        { main: 13, sub: 6 },
      ],
      coverDice: [],
      fresh: noDice,
      body: BODY,
      cover: null,
      armorDivisor: 0,
    })
    return card({ hits })
  }

  test('the GM turning the attack to the rear re-reads the same dice', () => {
    const before = chestCard()
    expect(before.hits[0].result.part).toBe('chest')
    const after = withFacing(before, 'rear', BODY, noDice)
    expect(after.facingOverride).toBe('rear')
    expect(after.hits[0].result.part).toBe('spine')
    expect(after.hits[1].result.part).toBe('limbVein')
    expect(after.hits[0].dice).toEqual({ main: 9, sub: 1 })
    const back = withFacing(after, null, BODY, noDice)
    expect(back.hits[0].result.part).toBe('chest')
  })

  test('applied hits', () => {
    const c = chestCard()
    expect(pendingHits(c).map(h => h.index)).toEqual([0, 1])
    const one = markApplied(c, [1])
    expect(one.hits.map(h => h.applied)).toEqual([false, true])
    expect(pendingHits(one).map(h => h.index)).toEqual([0])
    expect(markApplied(one, [1])).toBe(one)
    expect(withFacing(one, 'rear', BODY, noDice).hits[1].applied).toBe(true)
  })
})

describe('view', () => {
  test('path text with sides', () => {
    const r = resolveHit({ target: 'random' }, { attack: CUT, facing: 'front', roll: k => ({ main: 14, sub: 6 })[k]! })
    expect(pathText(r.path, t)).toBe('Leg (Left) › Thigh › Vein/Artery')
    expect(pathText([{ raw: 'Hind Leg' }], t)).toBe('Hind Leg')
  })

  test('notes: the torso cap is dropped when off', () => {
    const r = resolveHit({ target: 'chest' }, { attack: CUT, facing: 'front', roll: () => 3 })
    expect(noteTexts(r, t, '2')).toEqual([`${L}.note.torsoCap{"cap":"2"}`])
    expect(noteTexts(r, t, 'none')).toEqual([])
  })

  test('summary line', () => {
    const vein = resolveHit({ target: 'neckVein' }, { attack: CUT, facing: 'front', roll: noDice })
    expect(summaryText(vein, CUT, t)).toBe(
      `${L}.card.multiplier{"multiplier":2.5,"type":"cut"} · ${L}.card.bleedFast{"modifier":"-4"}`
    )
    const gap = resolveHit({ target: 'codpiece' }, { attack: CUT, facing: 'front', roll: noDice })
    expect(summaryText(gap, CUT, t)).toContain(`${L}.card.armorGap`)
    const spine = resolveHit({ target: 'spine' }, { attack: CUT, facing: 'rear', roll: noDice })
    expect(summaryText(spine, CUT, t)).toContain(`${L}.card.extraDR{"dr":3}`)
  })

  test('card view', () => {
    const cover: CoverData = { preset: 'full', dr: 4, hp: null, hpMax: null, material: '' }
    const hits = resolveHits({
      system: 'guhl',
      aim: { target: 'eye' },
      aimName: 'Eye',
      called: true,
      attack: { type: 'cr', tightBeam: false },
      facing: 'front',
      damages: [3, 9, 8],
      dice: [{ sub: 4 }, { sub: 4 }, { sub: 4 }],
      coverDice: [],
      fresh: noDice,
      body: BODY,
      cover,
      armorDivisor: 0,
    })
    const view = cardView(card({ hits, cover, aimName: 'Eye', aim: { target: 'eye' }, called: true }), t, {
      torsoCap: '2',
      canApply: true,
      canEditFacing: true,
      aimLabel: 'Eye',
    }) as any
    expect(view.hits).toHaveLength(3)
    // Crushing can't target the eye: face hits, behind full cover (DR 4).
    expect(view.hits[0].invalid).toContain(`${L}.card.invalid.type`)
    expect(view.hits[0]).toMatchObject({ number: 1, stopped: true, canApply: false, finalDamage: 0, reduced: true })
    expect(view.hits[1]).toMatchObject({ finalDamage: 5, canApply: true, coverCls: 'is-through' })
    expect(view.canApplyAll).toBe(true)
    expect(view.allDone).toBe(false)
    expect(view.aimText).toBe(`${L}.card.called{"location":"Eye"}`)
    expect(view.facingOptions.find((o: any) => o.selected).value).toBe('auto')
  })

  test('done once every hit is applied or stopped', () => {
    const hits = resolveHits({
      system: 'guhl',
      aim: { target: 'skull' },
      aimName: 'Skull',
      called: true,
      attack: CUT,
      facing: 'front',
      damages: [5],
      dice: [{}],
      coverDice: [],
      fresh: noDice,
      body: BODY,
      cover: null,
      armorDivisor: 0,
    })
    const c = markApplied(card({ hits }), [0])
    const view = cardView(c, t, { torsoCap: '2', canApply: true, canEditFacing: true, aimLabel: '' }) as any
    expect(view.allDone).toBe(true)
    expect(view.canApplyAll).toBe(false)
    expect(view.canEditFacing).toBe(false)
    expect(view.hits[0].applied).toBe(true)
  })
})
