import {
  explosiveTextFor,
  facing,
  offsetPoint,
  parseExplodeCommand,
  pushAway,
} from '../../module/agency/explosions/command-parse.ts'
import { fromAbove, locationFor } from '../../module/agency/explosions/resolve.ts'

describe('geometry', () => {
  test('facing: east is 0, south (screen down) is +90°', () => {
    expect(facing({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0)
    expect(facing({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(Math.PI / 2)
  })

  test('scatter direction 1 is straight ahead, 4 straight back, 2 is 60° clockwise (B414)', () => {
    const ahead = offsetPoint({ x: 100, y: 100 }, 0, 0, 3, 10)
    expect(ahead.x).toBeCloseTo(130)
    expect(ahead.y).toBeCloseTo(100)
    const back = offsetPoint({ x: 100, y: 100 }, 0, 180, 3, 10)
    expect(back.x).toBeCloseTo(70)
    const right = offsetPoint({ x: 0, y: 0 }, 0, 60, 2, 10)
    expect(right.x).toBeCloseTo(10)
    expect(right.y).toBeCloseTo(17.3205)
  })

  test('knockback pushes away from the center', () => {
    const p = pushAway({ x: 0, y: 0 }, { x: 30, y: 40 }, 2, 10)
    expect(p.x).toBeCloseTo(42)
    expect(p.y).toBeCloseTo(56)
    expect(pushAway({ x: 5, y: 5 }, { x: 5, y: 5 }, 1, 10, Math.PI).x).toBeCloseTo(-5)
  })
})

describe('/explode arguments', () => {
  test('damage text', () => {
    const r = parseExplodeCommand('4d cr ex [2d]')
    expect(r).toMatchObject({ label: '4d cr ex [2d]', damage: '4d cr ex [2d]', charge: null })
    expect((r as any).options).toMatchObject({ environment: 'normal', enclosed: 1, airburst: false, atTarget: false })
  })

  test('option words anywhere', () => {
    const r = parseExplodeCommand('enclosed 6d×2 cr ex thermobaric') as any
    expect(r.damage).toBe('6d×2 cr ex')
    expect(r.options).toMatchObject({ enclosed: 2, environment: 'thermobaric' })
    expect((parseExplodeCommand('3d cr ex vented airburst') as any).options).toMatchObject({
      enclosed: 1.5,
      airburst: true,
    })
    expect((parseExplodeCommand('3d cr ex underwater') as any).options.environment).toBe('underwater')
  })

  test('contact and internal detonate at the targeted token', () => {
    expect((parseExplodeCommand('4d+1 [2d] cr ex contact') as any).options).toMatchObject({
      contact: true,
      atTarget: true,
    })
    expect((parseExplodeCommand('3d cr ex internal') as any).options).toMatchObject({ internal: true, atTarget: true })
    expect((parseExplodeCommand('3d cr ex target') as any).options.atTarget).toBe(true)
  })

  test('a charge by weight (B415): 1 lb of TNT is 6d×2', () => {
    const r = parseExplodeCommand('1lb tnt') as any
    expect(r.damage).toBe('6d×2 cr ex')
    expect(r.charge.pounds).toBe(1)
    expect(r.charge.explosive.id).toBe('tnt')
  })

  test('a charge with fragments and spaces: a nail-wrapped pipe bomb', () => {
    const r = parseExplodeCommand('0.5 lb black powder [2d]') as any
    expect(r.damage).toMatch(/^\d+d(\+\d+)? \[2d\] cr ex$/)
    expect(r.charge.explosive.id).toBe('black-powder')
  })

  test('C4 by alias, in grams', () => {
    const r = parseExplodeCommand('500g c-4') as any
    expect(r.charge.explosive.ref).toBe(1.4)
    expect(r.charge.pounds).toBeCloseTo(1.1023)
  })

  test('special munitions', () => {
    expect(parseExplodeCommand('flashbang')).toMatchObject({ label: 'Stun grenade', damage: 'HT-5 aff (10 yd.)' })
    expect(parseExplodeCommand('smoke 8')).toMatchObject({ damage: 'Smoke (8 yd.)' })
    expect(parseExplodeCommand('tear gas')).toMatchObject({ label: 'Tear gas', damage: 'Smoke (7 yd.)' })
  })

  test('errors', () => {
    expect(parseExplodeCommand('')).toEqual({ error: 'empty' })
    expect(parseExplodeCommand('enclosed')).toEqual({ error: 'empty' })
    expect(parseExplodeCommand('2lb unobtainium')).toEqual({ error: 'unknownExplosive', detail: 'unobtainium' })
    expect(parseExplodeCommand('2d+1 cut')).toEqual({ error: 'notExplosive', detail: '2d+1 cut' })
  })
})

describe('weapon text', () => {
  test('damage alone', () => expect(explosiveTextFor('9d [2d] cr ex', '')).toBe('9d [2d] cr ex'))
  test('a linked explosion from the notes (HEDP)', () =>
    expect(explosiveTextFor('7d(10) cr ex', 'HEDP; with 6d [2d] cr ex linked. Long round.')).toBe(
      '7d(10) cr ex with 6d [2d] cr ex linked'
    ))
  test('a linked explosion in notes without "with"', () =>
    expect(explosiveTextFor('6d(10) cr ex', 'Also 4d [1d] cr ex linked')).toBe(
      '6d(10) cr ex with 4d [1d] cr ex linked'
    ))
  test('damage that already has its link', () =>
    expect(explosiveTextFor('4d+2 cr ex linked burn', 'with 1d cr ex linked')).toBe('4d+2 cr ex linked burn'))
  test('array damage', () => expect(explosiveTextFor(['4d', 'cr ex'], undefined)).toBe('4d cr ex'))
})

describe('hit locations for fragments', () => {
  const table = [
    { where: 'Skull', roll: [3, 4] },
    { where: 'Torso', roll: [9, 10] },
    { where: 'Left Leg', roll: [13, 14] },
    { where: 'Foot', roll: [16] },
  ]
  test('3d6 against the table', () => {
    expect(locationFor(table, 10)).toBe('Torso')
    expect(locationFor(table, 3)).toBe('Skull')
    expect(locationFor(table, 11)).toBeNull()
  })
  test('from above: feet are hands, legs are arms (B400)', () => {
    expect(fromAbove('Foot')).toBe('Hand')
    expect(fromAbove('Left Leg')).toBe('Left Arm')
    expect(fromAbove('Legs')).toBe('Arms')
    expect(fromAbove('Torso')).toBe('Torso')
  })
})
