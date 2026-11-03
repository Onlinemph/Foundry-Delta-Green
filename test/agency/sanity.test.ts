import {
  applySanLoss,
  atBreakingPoint,
  bondStartingScore,
  defaultSanity,
  formatLossExpr,
  formatSanLoss,
  frightCheckSucceeds,
  frightCheckTarget,
  initialSanity,
  type LastLoss,
  lastLossFrom,
  lossRange,
  maxSanity,
  nextBreakingPoint,
  normalizeSanity,
  parseCategory,
  parseLossExpr,
  parseSanCommand,
  parseSanLoss,
  parseSanOtf,
  percentileSucceeds,
  projectOntoBond,
  reconcileSanityChange,
  removeById,
  rollLossExpr,
  type SanityData,
  startingSanity,
  toggleAdaptation,
  updateById,
} from '../../module/agency/sanity/rules.ts'

function sanity(overrides: Partial<SanityData> = {}): SanityData {
  return { ...defaultSanity(), value: 50, max: 99, breakingPoint: 40, initialized: true, ...overrides }
}

describe('SAN loss notation', () => {
  test.each([
    ['0/1d6', '0/1d6'],
    ['1/1d4+1', '1/1d4+1'],
    ['1d6/1d20', '1d6/1d20'],
    ['0/1D10', '0/1d10'],
    [' 1 / 1d4 + 1 ', '1/1d4+1'],
    ['d6/d20', '1d6/1d20'],
    ['1/1d4-1', '1/1d4-1'],
    ['1/1d4−1', '1/1d4-1'],
    ['0/3d6', '0/3d6'],
    ['2/5', '2/5'],
  ])('parses %p', (text, formatted) => {
    const loss = parseSanLoss(text)
    expect(loss).not.toBeNull()
    expect(formatSanLoss(loss!)).toBe(formatted)
  })

  test.each(['', '1d6', '0/1d6/2', 'abc', 'x/1d6', '0/0d6', '0/1d0', '0/1d6x2', '0/-1', '0/1d6+', '/1d6'])(
    'rejects %p',
    text => {
      expect(parseSanLoss(text)).toBeNull()
    }
  )

  test('parses the parts', () => {
    expect(parseLossExpr('2d6+3')).toEqual({ dice: 2, sides: 6, mod: 3 })
    expect(parseLossExpr('0')).toEqual({ dice: 0, sides: 0, mod: 0 })
    expect(formatLossExpr({ dice: 1, sides: 4, mod: -1 })).toBe('1d4-1')
  })

  test('ranges and rolls', () => {
    expect(lossRange(parseLossExpr('1d4+1')!)).toEqual({ min: 2, max: 5 })
    expect(lossRange(parseLossExpr('1d4-3')!)).toEqual({ min: 0, max: 1 })
    expect(lossRange(parseLossExpr('3')!)).toEqual({ min: 3, max: 3 })
    expect(rollLossExpr(parseLossExpr('2d6+1')!, () => 4)).toBe(9)
    expect(rollLossExpr(parseLossExpr('1d4-3')!, () => 1)).toBe(0)
    expect(rollLossExpr(parseLossExpr('0')!, () => 6)).toBe(0)
    const sides: number[] = []
    rollLossExpr(parseLossExpr('3d20')!, s => (sides.push(s), 1))
    expect(sides).toEqual([20, 20, 20])
  })
})

describe('categories, /san and OTF parsing', () => {
  test.each([
    ['violence', 'violence'],
    ['V', 'violence'],
    ['viol', 'violence'],
    ['help', 'helplessness'],
    ['h', 'helplessness'],
    ['u', 'unnatural'],
    ['Unnatural', 'unnatural'],
    ['none', 'none'],
    ['', 'none'],
    [undefined, 'none'],
    ['sees', null],
    ['violently', null],
  ])('parseCategory(%p) = %p', (text, expected) => {
    expect(parseCategory(text as string | undefined)).toBe(expected)
  })

  test('/san arguments', () => {
    const a = parseSanCommand('0/1d6 violence')
    expect('error' in a).toBe(false)
    if (!('error' in a)) {
      expect(formatSanLoss(a.loss)).toBe('0/1d6')
      expect(a.category).toBe('violence')
      expect(a.source).toBe('')
    }
    const b = parseSanCommand('1/1d4+1 u Sees the thing in the well')
    if ('error' in b) throw new Error('expected a request')
    expect(b.category).toBe('unnatural')
    expect(b.source).toBe('Sees the thing in the well')
    const c = parseSanCommand('1d6/1d20 Sees the body')
    if ('error' in c) throw new Error('expected a request')
    expect(c.category).toBe('none')
    expect(c.source).toBe('Sees the body')
    expect(parseSanCommand('1d6 violence')).toEqual({ error: 'notation', text: '1d6' })
  })

  test('OTF body', () => {
    expect(parseSanOtf('SAN 0/1d4 violence')).toEqual({
      loss: parseSanLoss('0/1d4'),
      category: 'violence',
    })
    expect(parseSanOtf('san: 1/1d6')?.category).toBe('none')
    expect(parseSanOtf('SAN 0/1d4 sees')).toBeNull()
    expect(parseSanOtf('SAN 1d6')).toBeNull()
    expect(parseSanOtf('Sanity')).toBeNull()
    expect(parseSanOtf('S:Sanitation')).toBeNull()
  })
})

describe('starting values', () => {
  test('SAN = Will × multiplier, capped by 99 − Unnatural', () => {
    expect(startingSanity(10, 5)).toBe(50)
    expect(startingSanity(12, 5)).toBe(60)
    expect(startingSanity(14, 4)).toBe(56)
    expect(startingSanity(20, 5, 10)).toBe(89)
    expect(startingSanity(10, 0)).toBe(50) // invalid multiplier falls back to 5
    expect(maxSanity(0)).toBe(99)
    expect(maxSanity(15)).toBe(84)
    expect(maxSanity(150)).toBe(0)
  })

  test('Breaking Point = SAN − Will, never negative', () => {
    expect(nextBreakingPoint(50, 10)).toBe(40)
    expect(nextBreakingPoint(8, 12)).toBe(0)
  })

  test('initialises a template-default actor', () => {
    const s = initialSanity(defaultSanity(), 12, 5)
    expect(s).toMatchObject({ value: 60, max: 99, breakingPoint: 48, initialized: true })
  })

  test('keeps values that were already entered', () => {
    const s = initialSanity({ ...defaultSanity(), value: 33, unnatural: 10, max: 99 }, 12, 5)
    expect(s.value).toBe(33)
    expect(s.max).toBe(89)
    expect(s.breakingPoint).toBe(21)
    const t = initialSanity({ ...defaultSanity(), breakingPoint: 30 }, 10, 5)
    expect(t.breakingPoint).toBe(30)
  })

  test('Bond starting score', () => {
    expect(bondStartingScore(12, 0)).toBe(12)
    expect(bondStartingScore(12, 15)).toBe(15)
  })
})

describe('normalizeSanity', () => {
  test('defaults for missing data', () => {
    expect(normalizeSanity(undefined)).toEqual(defaultSanity())
    expect(normalizeSanity(null).initialized).toBe(false)
  })

  test('accepts index-keyed objects and loose values', () => {
    const s = normalizeSanity({
      value: '45',
      max: 120,
      bonds: { 0: { id: 'a', name: 'Sister', score: '9' }, 1: { name: 'Partner', score: -2 } },
      disorders: ['Nightmares', { id: 'd2', name: 'Paranoia' }],
      adaptation: { violence: 7 },
      initialized: true,
    })
    expect(s.value).toBe(45)
    expect(s.max).toBe(99)
    expect(s.bonds).toEqual([
      { id: 'a', name: 'Sister', score: 9 },
      { id: 'bond1', name: 'Partner', score: 0 },
    ])
    expect(s.disorders).toEqual([
      { id: 'disorder0', name: 'Nightmares' },
      { id: 'd2', name: 'Paranoia' },
    ])
    expect(s.adaptation).toEqual({ violence: 3, helplessness: 0 })
  })
})

describe('applySanLoss', () => {
  test('simple loss', () => {
    const o = applySanLoss(sanity(), { rolled: 3, category: 'none', will: 10 })
    expect(o).toMatchObject({ lost: 3, before: 50, after: 47, breakingPoint: false, temporaryInsanity: false })
    expect(o.state.value).toBe(47)
  })

  test('does not mutate the input', () => {
    const s = sanity({ bonds: [{ id: 'a', name: 'A', score: 5 }] })
    applySanLoss(s, { rolled: 3, category: 'violence', will: 10 })
    expect(s.value).toBe(50)
    expect(s.adaptation.violence).toBe(0)
  })

  test('5+ SAN from one roll is temporary insanity, 4 is not', () => {
    expect(applySanLoss(sanity(), { rolled: 4, category: 'none', will: 10 }).temporaryInsanity).toBe(false)
    expect(applySanLoss(sanity(), { rolled: 5, category: 'none', will: 10 }).temporaryInsanity).toBe(true)
  })

  test('reaching the Breaking Point resets it to SAN − Will', () => {
    const o = applySanLoss(sanity({ value: 43, breakingPoint: 40 }), { rolled: 3, category: 'none', will: 10 })
    expect(o.breakingPoint).toBe(true)
    expect(o.bpBefore).toBe(40)
    expect(o.state.breakingPoint).toBe(30)
    expect(atBreakingPoint(o.state)).toBe(false)
    const above = applySanLoss(sanity({ value: 44, breakingPoint: 40 }), { rolled: 3, category: 'none', will: 10 })
    expect(above.breakingPoint).toBe(false)
    expect(above.state.breakingPoint).toBe(40)
  })

  test('SAN stops at 0: permanent insanity', () => {
    const o = applySanLoss(sanity({ value: 3, breakingPoint: 0 }), { rolled: 6, category: 'none', will: 10 })
    expect(o.lost).toBe(3)
    expect(o.after).toBe(0)
    expect(o.permanentInsanity).toBe(true)
    expect(o.breakingPoint).toBe(true)
    expect(o.state.breakingPoint).toBe(0)
  })

  test('no loss means no breaking point and no adaptation box', () => {
    const o = applySanLoss(sanity({ value: 40, breakingPoint: 40 }), { rolled: 0, category: 'violence', will: 10 })
    expect(o.breakingPoint).toBe(false)
    expect(o.adaptation).toBeNull()
  })

  test('three violence losses adapt the character and every Bond loses 1', () => {
    let s = sanity({
      bonds: [
        { id: 'a', name: 'Spouse', score: 10 },
        { id: 'b', name: 'Old friend', score: 0 },
      ],
    })
    const first = applySanLoss(s, { rolled: 1, category: 'violence', will: 10 })
    expect(first.adaptation).toEqual({ category: 'violence', before: 0, after: 1, becameAdapted: false })
    s = applySanLoss(first.state, { rolled: 1, category: 'violence', will: 10 }).state
    const third = applySanLoss(s, { rolled: 2, category: 'violence', will: 10 })
    expect(third.adaptation?.becameAdapted).toBe(true)
    expect(third.lost).toBe(2)
    expect(third.state.bonds).toEqual([
      { id: 'a', name: 'Spouse', score: 9 },
      { id: 'b', name: 'Old friend', score: 0 },
    ])
    expect(third.bondsReduced).toEqual([{ id: 'a', name: 'Spouse', before: 10, after: 9 }])
    // Adapted: no further loss from violence, but helplessness still hurts.
    const fourth = applySanLoss(third.state, { rolled: 6, category: 'violence', will: 10 })
    expect(fourth.adaptedImmune).toBe(true)
    expect(fourth.lost).toBe(0)
    expect(fourth.temporaryInsanity).toBe(false)
    expect(applySanLoss(third.state, { rolled: 2, category: 'helplessness', will: 10 }).lost).toBe(2)
  })

  test('unnatural and none never adapt', () => {
    const o = applySanLoss(sanity(), { rolled: 2, category: 'unnatural', will: 10 })
    expect(o.adaptation).toBeNull()
    expect(o.state.adaptation).toEqual({ violence: 0, helplessness: 0 })
  })
})

describe('projectOntoBond', () => {
  function lossOf(state: SanityData, rolled: number, will = 10) {
    const o = applySanLoss(state, { rolled, category: 'none', will })
    return { state: o.state, last: lastLossFrom(o, 'loss1', 'none') }
  }
  const bonds = [
    { id: 'a', name: 'Sister', score: 10 },
    { id: 'b', name: 'Partner', score: 2 },
  ]

  test('reduces the loss by 1d4; the Bond loses the same', () => {
    const { state, last } = lossOf(sanity({ bonds }), 4)
    const r = projectOntoBond(state, last, 'a', 3)
    if (!r.ok) throw new Error(r.reason)
    expect(r.refund).toBe(3)
    expect(r.remaining).toBe(1)
    expect(r.state.value).toBe(49)
    expect(r.bond).toEqual({ id: 'a', name: 'Sister', before: 10, after: 7 })
    expect(r.lastLoss.projected).toBe(true)
  })

  test('refund is capped at the loss; the Bond still loses the full roll (never below 0)', () => {
    const { state, last } = lossOf(sanity({ bonds }), 1)
    const r = projectOntoBond(state, last, 'b', 4)
    if (!r.ok) throw new Error(r.reason)
    expect(r.refund).toBe(1)
    expect(r.state.value).toBe(50)
    expect(r.bond.after).toBe(0)
  })

  test('can undo the Breaking Point and temporary insanity of that loss', () => {
    const { state, last } = lossOf(sanity({ value: 44, breakingPoint: 40, bonds }), 6)
    expect(last.breakingPoint).toBe(true)
    expect(state.breakingPoint).toBe(28)
    const r = projectOntoBond(state, last, 'a', 4)
    if (!r.ok) throw new Error(r.reason)
    expect(r.state.value).toBe(42)
    expect(r.bpReverted).toBe(true)
    expect(r.state.breakingPoint).toBe(40)
    expect(r.temporaryInsanityAverted).toBe(true)
  })

  test('keeps the Breaking Point reset when SAN stays at or below the old one', () => {
    const { state, last } = lossOf(sanity({ value: 41, breakingPoint: 40, bonds }), 5)
    const r = projectOntoBond(state, last, 'a', 1)
    if (!r.ok) throw new Error(r.reason)
    expect(r.state.value).toBe(37)
    expect(r.bpReverted).toBe(false)
    expect(r.state.breakingPoint).toBe(26)
    expect(r.temporaryInsanityAverted).toBe(true)
  })

  test('refusals', () => {
    const { state, last } = lossOf(sanity({ bonds: [...bonds, { id: 'z', name: 'Gone', score: 0 }] }), 3)
    expect(projectOntoBond(state, { ...last, projected: true }, 'a', 2)).toEqual({
      ok: false,
      reason: 'already-projected',
    })
    expect(projectOntoBond(state, { ...last, amount: 0 }, 'a', 2)).toEqual({ ok: false, reason: 'nothing-to-project' })
    expect(projectOntoBond(state, last, 'nope', 2)).toEqual({ ok: false, reason: 'no-bond' })
    expect(projectOntoBond(state, last, 'z', 2)).toEqual({ ok: false, reason: 'bond-broken' })
    expect(projectOntoBond(state, null as unknown as LastLoss, 'a', 2)).toEqual({
      ok: false,
      reason: 'nothing-to-project',
    })
  })

  test('SAN never exceeds max', () => {
    const { last } = lossOf(sanity({ bonds }), 3)
    const r = projectOntoBond(sanity({ value: 98, max: 99, bonds }), last, 'a', 3)
    if (!r.ok) throw new Error(r.reason)
    expect(r.state.value).toBe(99)
  })
})

describe('reconcileSanityChange', () => {
  test('an Unnatural increase lowers max SAN by the same amount and clamps SAN', () => {
    const s = sanity({ value: 95, max: 99, unnatural: 0 })
    expect(reconcileSanityChange(s, { unnatural: 6 })).toEqual({ unnatural: 6, max: 93, value: 93 })
    expect(reconcileSanityChange(sanity({ value: 50 }), { unnatural: 6 })).toEqual({ unnatural: 6, max: 93 })
  })

  test('keeps a manually lowered max', () => {
    expect(reconcileSanityChange(sanity({ max: 80, value: 50 }), { unnatural: 5 })).toEqual({ unnatural: 5, max: 75 })
  })

  test('max is capped at 99 − Unnatural', () => {
    expect(reconcileSanityChange(sanity({ unnatural: 10, max: 89 }), { max: 95 })).toEqual({ max: 89 })
    expect(reconcileSanityChange(sanity({ unnatural: 0, max: 99, value: 60 }), { max: 55 })).toEqual({
      max: 55,
      value: 55,
    })
  })

  test('SAN is clamped to [0, max]', () => {
    expect(reconcileSanityChange(sanity({ max: 80 }), { value: 85 })).toEqual({ value: 80 })
    expect(reconcileSanityChange(sanity(), { value: -4 })).toEqual({ value: 0 })
    expect(reconcileSanityChange(sanity(), { value: 30 })).toEqual({ value: 30 })
  })

  test('Breaking Point is clamped and nothing else is touched', () => {
    expect(reconcileSanityChange(sanity(), { breakingPoint: -3 })).toEqual({ breakingPoint: 0 })
    expect(reconcileSanityChange(sanity(), {})).toEqual({})
  })

  test('an Unnatural decrease raises max back up to 99 − Unnatural', () => {
    expect(reconcileSanityChange(sanity({ unnatural: 10, max: 89 }), { unnatural: 4 })).toEqual({
      unnatural: 4,
      max: 95,
    })
  })
})

describe('checks', () => {
  test('3d6 Fright Check with criticals', () => {
    expect(frightCheckSucceeds(10, 10)).toBe(true)
    expect(frightCheckSucceeds(11, 10)).toBe(false)
    expect(frightCheckSucceeds(4, 2)).toBe(true)
    expect(frightCheckSucceeds(17, 20)).toBe(false)
  })

  test('Rule of 14', () => {
    expect(frightCheckTarget(12, [{ mod: 2 }, { mod: -1 }])).toEqual({ total: 13, target: 13, ruleOf14: false })
    expect(frightCheckTarget(14, [{ mod: 2 }])).toEqual({ total: 16, target: 13, ruleOf14: true })
  })

  test('d100 ≤ SAN', () => {
    expect(percentileSucceeds(50, 50)).toBe(true)
    expect(percentileSucceeds(51, 50)).toBe(false)
    expect(percentileSucceeds(1, 0)).toBe(true)
    expect(percentileSucceeds(100, 99)).toBe(false)
  })
})

describe('sheet editing helpers', () => {
  test('adaptation checkboxes', () => {
    expect(toggleAdaptation(0, 0)).toBe(1)
    expect(toggleAdaptation(0, 2)).toBe(3)
    expect(toggleAdaptation(2, 1)).toBe(1)
    expect(toggleAdaptation(1, 0)).toBe(0)
    expect(toggleAdaptation(3, 2)).toBe(2)
  })

  test('list updates', () => {
    const list = [
      { id: 'a', name: 'A', score: 1 },
      { id: 'b', name: 'B', score: 2 },
    ]
    expect(updateById(list, 'b', { score: 5 })).toEqual([
      { id: 'a', name: 'A', score: 1 },
      { id: 'b', name: 'B', score: 5 },
    ])
    expect(removeById(list, 'a')).toEqual([{ id: 'b', name: 'B', score: 2 }])
    expect(list).toHaveLength(2)
  })
})
