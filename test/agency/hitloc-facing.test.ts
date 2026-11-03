import { angleOffFacing, facingArc, type ArtFacing, type GridKind } from '../../module/agency/hitloc/facing.ts'

const target = { x: 500, y: 500 }

/** The attacker 100 px from the target, `degrees` clockwise from straight below (canvas y down). */
function at(degrees: number): { x: number; y: number } {
  const rad = ((degrees + 90) * Math.PI) / 180
  return { x: target.x + 100 * Math.cos(rad), y: target.y + 100 * Math.sin(rad) }
}

const arc = (degrees: number, grid: GridKind = 'hex', rotation = 0, art: ArtFacing = 'down') =>
  facingArc({ attacker: at(degrees), target, rotation, art, grid })

describe('facing arcs', () => {
  test.each([
    [0, 'front'],
    [30, 'front'],
    [60, 'front'],
    [-60, 'front'],
    [90, 'front'],
    [-90, 'front'],
    [120, 'side'],
    [-120, 'side'],
    [149, 'side'],
    [150, 'rear'],
    [180, 'rear'],
    [-160, 'rear'],
  ])('hex grid, attacker %i degrees off the facing: %s', (degrees, expected) => expect(arc(degrees)).toBe(expected))

  test.each([
    [0, 'front'],
    [45, 'front'],
    [67, 'front'],
    [90, 'side'],
    [-90, 'side'],
    [112, 'side'],
    [135, 'rear'],
    [180, 'rear'],
  ])('square grid, attacker %i degrees off the facing: %s', (degrees, expected) =>
    expect(arc(degrees, 'square')).toBe(expected)
  )

  test('gridless uses the hex arcs', () => {
    expect(arc(100, 'gridless')).toBe('side')
    expect(arc(170, 'gridless')).toBe('rear')
  })

  test('rotation turns the facing clockwise', () => {
    // Art faces down; rotated 90 degrees it faces left (west).
    const west = { x: 400, y: 500 }
    const east = { x: 600, y: 500 }
    expect(facingArc({ attacker: west, target, rotation: 90, art: 'down', grid: 'hex' })).toBe('front')
    expect(facingArc({ attacker: east, target, rotation: 90, art: 'down', grid: 'hex' })).toBe('rear')
    expect(facingArc({ attacker: east, target, rotation: -90, art: 'down', grid: 'hex' })).toBe('front')
    expect(facingArc({ attacker: east, target, rotation: 450, art: 'down', grid: 'hex' })).toBe('rear')
  })

  test.each<[ArtFacing, { x: number; y: number }]>([
    ['down', { x: 500, y: 600 }],
    ['up', { x: 500, y: 400 }],
    ['left', { x: 400, y: 500 }],
    ['right', { x: 600, y: 500 }],
  ])('art facing %s at rotation 0', (art, inFront) => {
    expect(facingArc({ attacker: inFront, target, rotation: 0, art, grid: 'hex' })).toBe('front')
    const behind = { x: 2 * target.x - inFront.x, y: 2 * target.y - inFront.y }
    expect(facingArc({ attacker: behind, target, rotation: 0, art, grid: 'hex' })).toBe('rear')
  })

  test('same spot counts as front', () => {
    expect(facingArc({ attacker: target, target, rotation: 0, art: 'down', grid: 'hex' })).toBe('front')
  })

  test('angleOffFacing is 0-180', () => {
    expect(angleOffFacing({ attacker: at(0), target, rotation: 0, art: 'down', grid: 'hex' })).toBeCloseTo(0)
    expect(angleOffFacing({ attacker: at(-170), target, rotation: 0, art: 'down', grid: 'hex' })).toBeCloseTo(170)
  })
})
