import {
  SEVERITIES,
  atLeast,
  severityFromInjury,
  severityThresholds,
  shiftSeverity,
  treatmentPenalty,
  healerRollIntervalDays,
  type Severity,
} from '../../module/agency/wounds/severity.js'
import { resolveRoll } from '../../module/agency/wounds/rolls.js'

describe('severityFromInjury', () => {
  // HP 16 puts every band edge on a whole number: 1, 2, 4, 8, 16, 32, 64, 128.
  test.each<[number, Severity | null]>([
    [0, null],
    [0.99, null],
    [1, 'scratch'],
    [1.99, 'scratch'],
    [2, 'minor'],
    [3.99, 'minor'],
    [4, 'moderate'],
    [7.99, 'moderate'],
    [8, 'major'],
    [15.99, 'major'],
    [16, 'critical'],
    [31.99, 'critical'],
    [32, 'massive'],
    [63.99, 'massive'],
    [64, 'gawdawful'],
    [127.99, 'gawdawful'],
    [128, 'destroyed'],
    [10000, 'destroyed'],
  ])('HP 16, injury %p -> %p', (injury, expected) => {
    expect(severityFromInjury(injury, 16)).toBe(expected)
  })

  // HP 10: edges at 0.625, 1.25, 2.5, 5, 10, 20, 40, 80.
  test.each<[number, Severity | null]>([
    [0.6249, null],
    [0.625, 'scratch'],
    [1, 'scratch'],
    [1.2499, 'scratch'],
    [1.25, 'minor'],
    [2, 'minor'],
    [2.4999, 'minor'],
    [2.5, 'moderate'],
    [3, 'moderate'],
    [4, 'moderate'],
    [4.99, 'moderate'],
    [5, 'major'],
    [9, 'major'],
    [10, 'critical'],
    [19, 'critical'],
    [20, 'massive'],
    [39, 'massive'],
    [40, 'gawdawful'],
    [79, 'gawdawful'],
    [80, 'destroyed'],
  ])('HP 10, injury %p -> %p', (injury, expected) => {
    expect(severityFromInjury(injury, 10)).toBe(expected)
  })

  // Small HP: whole points skip the low bands entirely.
  test.each<[number, number, Severity | null]>([
    [1, 0.0624, null],
    [1, 0.0625, 'scratch'],
    [1, 0.5, 'major'],
    [1, 1, 'critical'],
    [1, 2, 'massive'],
    [1, 3, 'massive'],
    [1, 4, 'gawdawful'],
    [1, 7, 'gawdawful'],
    [1, 8, 'destroyed'],
    [2, 1, 'major'],
    [2, 2, 'critical'],
    [3, 1, 'moderate'],
    [3, 2, 'major'],
    [3, 3, 'critical'],
    [3, 5, 'critical'],
    [3, 6, 'massive'],
    [3, 12, 'gawdawful'],
    [3, 24, 'destroyed'],
    [7, 1, 'minor'],
    [7, 2, 'moderate'],
    [7, 3, 'moderate'],
    [7, 4, 'major'],
    [7, 7, 'critical'],
    [12, 1, 'scratch'],
    [12, 2, 'minor'],
    [12, 3, 'moderate'],
    [12, 6, 'major'],
    [12, 12, 'critical'],
  ])('HP %p, injury %p -> %p', (hp, injury, expected) => {
    expect(severityFromInjury(injury, hp)).toBe(expected)
  })

  it('treats max HP below 1 as 1', () => {
    expect(severityFromInjury(1, 0)).toBe('critical')
    expect(severityFromInjury(1, -3)).toBe('critical')
    expect(severityFromInjury(1, NaN)).toBe('critical')
  })

  it('ignores zero, negative and non-numeric injury', () => {
    expect(severityFromInjury(-5, 10)).toBeNull()
    expect(severityFromInjury(NaN, 10)).toBeNull()
  })

  it('handles large HP', () => {
    expect(severityFromInjury(6, 100)).toBeNull()
    expect(severityFromInjury(7, 100)).toBe('scratch')
    expect(severityFromInjury(12, 100)).toBe('scratch')
    expect(severityFromInjury(13, 100)).toBe('minor')
    expect(severityFromInjury(25, 100)).toBe('moderate')
    expect(severityFromInjury(50, 100)).toBe('major')
    expect(severityFromInjury(100, 100)).toBe('critical')
  })
})

describe('severityThresholds', () => {
  it('lists the least whole injury for each band', () => {
    expect(severityThresholds(10)).toEqual([
      { severity: 'scratch', injury: 1 },
      { severity: 'minor', injury: 2 },
      { severity: 'moderate', injury: 3 },
      { severity: 'major', injury: 5 },
      { severity: 'critical', injury: 10 },
      { severity: 'massive', injury: 20 },
      { severity: 'gawdawful', injury: 40 },
      { severity: 'destroyed', injury: 80 },
    ])
  })

  it('leaves out bands whole points skip', () => {
    expect(severityThresholds(1).map(t => t.severity)).toEqual(['critical', 'massive', 'gawdawful', 'destroyed'])
    expect(severityThresholds(3).map(t => `${t.severity}:${t.injury}`)).toEqual([
      'moderate:1',
      'major:2',
      'critical:3',
      'massive:6',
      'gawdawful:12',
      'destroyed:24',
    ])
  })
})

describe('shiftSeverity and atLeast', () => {
  it('moves along the ladder', () => {
    expect(shiftSeverity('moderate', -1)).toBe('minor')
    expect(shiftSeverity('minor', -2)).toBeNull()
    expect(shiftSeverity('scratch', -1)).toBeNull()
    expect(shiftSeverity('gawdawful', 3)).toBe('destroyed')
    expect(shiftSeverity('major', 0)).toBe('major')
  })

  it('compares severities', () => {
    expect(atLeast('major', 'major')).toBe(true)
    expect(atLeast('critical', 'major')).toBe(true)
    expect(atLeast('moderate', 'major')).toBe(false)
    expect(atLeast(null, 'scratch')).toBe(false)
    expect(SEVERITIES).toHaveLength(8)
  })
})

describe('treatment and healer tables', () => {
  it('penalizes First Aid and Surgery for the worst wounds', () => {
    expect(treatmentPenalty('major')).toBe(0)
    expect(treatmentPenalty('critical')).toBe(-2)
    expect(treatmentPenalty('massive')).toBe(-4)
    expect(treatmentPenalty('gawdawful')).toBe(-6)
  })

  it('maps TL to healer roll frequency', () => {
    expect(healerRollIntervalDays(2)).toBe(30)
    expect(healerRollIntervalDays(4)).toBe(21)
    expect(healerRollIntervalDays(5)).toBe(14)
    expect(healerRollIntervalDays(8)).toBe(7)
    expect(healerRollIntervalDays(9)).toBe(3)
    expect(healerRollIntervalDays(10)).toBe(2)
    expect(healerRollIntervalDays(11)).toBe(1)
    expect(healerRollIntervalDays(12)).toBe(0.5)
  })
})

describe('resolveRoll', () => {
  test.each([
    // total, target, success, crit success, crit failure
    [3, 1, true, true, false],
    [4, 2, true, true, false],
    [5, 15, true, true, false],
    [5, 14, true, false, false],
    [6, 16, true, true, false],
    [6, 15, true, false, false],
    [10, 10, true, false, false],
    [11, 10, false, false, false],
    [16, 16, true, false, false],
    [17, 20, false, false, false],
    [17, 15, false, false, true],
    [18, 25, false, false, true],
    [15, 5, false, false, true],
    [14, 5, false, false, false],
    [7, 1, false, false, false],
  ])('roll %p vs %p', (total, target, success, critSuccess, critFailure) => {
    const r = resolveRoll(total, target)
    expect(r.success).toBe(success)
    expect(r.critSuccess).toBe(critSuccess)
    expect(r.critFailure).toBe(critFailure)
    expect(r.margin).toBe(target - total)
  })
})
