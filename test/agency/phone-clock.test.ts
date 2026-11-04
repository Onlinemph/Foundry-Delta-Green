import {
  clockText,
  formatClock,
  formatDateLong,
  formatDateNumeric,
  formatDateShort,
  formatDuration,
  gameTime,
  parseStart,
  relativeStamp,
} from '../../module/agency/phone/clock.ts'

const START = '2025-11-03 08:00'

describe('in-game clock', () => {
  test('campaign start plus world time', () => {
    const t = gameTime(START, 0)
    expect([t.year, t.month, t.day, t.hour, t.minute]).toEqual([2025, 11, 3, 8, 0])
    const later = gameTime(START, 86400 + 15 * 3600 + 47 * 60 + 5)
    expect([later.day, later.hour, later.minute, later.second]).toEqual([4, 23, 47, 5])
    expect(later.weekday).toBe(2) // Tuesday
  })

  test('crosses midnight, month and year ends', () => {
    const t = gameTime('2025-12-31 23:30', 3600)
    expect([t.year, t.month, t.day, t.hour, t.minute]).toEqual([2026, 1, 1, 0, 30])
  })

  test('12 and 24 hour formats', () => {
    const night = gameTime(START, 15 * 3600 + 47 * 60) // 23:47
    expect(formatClock(night, true)).toEqual({ time: '23:47', suffix: '' })
    expect(formatClock(night, false)).toEqual({ time: '11:47', suffix: 'PM' })
    const midnight = gameTime('2025-11-03 00:05', 0)
    expect(clockText(midnight, false)).toBe('12:05 AM')
    expect(clockText(midnight, true)).toBe('00:05')
    const noon = gameTime('2025-11-03 12:00', 0)
    expect(clockText(noon, false)).toBe('12:00 PM')
    expect(clockText(gameTime(START, 9), true, true)).toBe('08:00:09')
  })

  test('dates', () => {
    const t = gameTime(START, 86400)
    expect(formatDateLong(t, 'en')).toBe('Tuesday, November 4')
    expect(formatDateShort(t, 'en')).toBe('Tue 4 Nov')
    expect(formatDateNumeric(t)).toBe('04/11/2025')
  })

  test('the same on every client whatever its time zone (UTC maths)', () => {
    expect(parseStart('2025-11-03 08:00')).toBe(Date.UTC(2025, 10, 3, 8, 0))
    expect(parseStart('2025-11-03T08:00:30')).toBe(Date.UTC(2025, 10, 3, 8, 0, 30))
    expect(parseStart('2025-11-03')).toBe(Date.UTC(2025, 10, 3))
  })

  test('bad start dates fall back to the default', () => {
    expect(parseStart('2025-02-30 10:00')).toBeNull()
    expect(parseStart('soon')).toBeNull()
    expect(parseStart('2025-01-01 25:00')).toBeNull()
    expect(gameTime('nonsense', 0).year).toBe(2025)
  })

  test('message stamps: time today, yesterday, weekday, date', () => {
    const now = 86400 * 10 + 12 * 3600
    expect(relativeStamp(START, now, now - 600, true)).toMatch(/^\d\d:\d\d$/)
    expect(relativeStamp(START, now, now - 86400, true)).toBe('Yesterday')
    expect(relativeStamp(START, now, now - 3 * 86400, true)).toMatch(/^[A-Z][a-z]{2}$/)
    expect(relativeStamp(START, now, now - 9 * 86400, true)).toMatch(/Nov/)
  })

  test('call durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(42)).toBe('0:42')
    expect(formatDuration(725)).toBe('12:05')
    expect(formatDuration(3729)).toBe('1:02:09')
  })
})
