import {
  capitalizeNext,
  t9Backspace,
  t9CycleMode,
  t9Init,
  t9Insert,
  t9LongPress,
  t9Press,
  t9Tick,
  t9Value,
  t9View,
  T9_TIMEOUT_MS,
  type T9State,
} from '../../module/agency/phone/t9.ts'

/** Press keys `gap` ms apart starting at `at`. */
function press(state: T9State, keys: string, at = 0, gap = 100): T9State {
  let s = state
  let t = at
  for (const k of keys) {
    s = t9Press(s, k, t)
    t += gap
  }
  return s
}

describe('T9 multi-tap', () => {
  test('repeated presses cycle the letters on a key, then its digit', () => {
    let s = t9Init('', 'abc')
    s = t9Press(s, '2', 0)
    expect(t9View(s).pending).toBe('a')
    s = t9Press(s, '2', 100)
    expect(t9View(s).pending).toBe('b')
    s = t9Press(s, '2', 200)
    s = t9Press(s, '2', 300)
    expect(t9View(s).pending).toBe('2')
    s = t9Press(s, '2', 400)
    expect(t9View(s).pending).toBe('a')
    expect(s.text).toBe('')
  })

  test('the pause commits the letter; the next press starts a new one', () => {
    let s = t9Init('', 'abc')
    s = t9Press(s, '4', 0)
    s = t9Press(s, '4', 100) // h
    expect(t9Tick(s, 100 + T9_TIMEOUT_MS - 1).text).toBe('')
    s = t9Tick(s, 100 + T9_TIMEOUT_MS)
    expect(s.text).toBe('h')
    expect(s.pending).toBeNull()
    s = t9Press(s, '4', 5000) // same key after the pause: a new letter
    s = t9Press(s, '4', 5100)
    s = t9Press(s, '4', 5200)
    expect(t9Value(s)).toBe('hi')
  })

  test('pressing the same key after the timeout starts a new letter even without a tick', () => {
    let s = t9Init('', 'abc')
    s = t9Press(s, '2', 0)
    s = t9Press(s, '2', T9_TIMEOUT_MS + 10)
    expect(t9Value(s)).toBe('aa')
  })

  test('a different key commits immediately', () => {
    const s = press(t9Init('', 'abc'), '443', 0)
    expect(s.text).toBe('h')
    expect(t9View(s).pending).toBe('d')
    expect(t9Value(s)).toBe('hd')
    // Keys without letters are ignored.
    expect(press(t9Init('', 'abc'), 'x', 0).pending).toBeNull()
  })

  test('types "hello" with real timing', () => {
    let s = t9Init('', 'abc')
    let t = 0
    const tap = (key: string, times: number) => {
      for (let i = 0; i < times; i++) {
        s = t9Press(s, key, t)
        t += 120
      }
    }
    tap('4', 2) // h
    tap('3', 2) // e
    tap('5', 3) // l
    t += T9_TIMEOUT_MS // wait: same key next
    s = t9Tick(s, t)
    tap('5', 3) // l
    tap('6', 3) // o
    expect(t9Value(s)).toBe('hello')
  })

  test('sentence case capitalises at the start and after . ! ?', () => {
    expect(capitalizeNext('', 'Abc')).toBe(true)
    expect(capitalizeNext('ok', 'Abc')).toBe(false)
    expect(capitalizeNext('ok. ', 'Abc')).toBe(true)
    expect(capitalizeNext('ok.', 'Abc')).toBe(false)
    expect(capitalizeNext('wait! ', 'Abc')).toBe(true)
    expect(capitalizeNext('x', 'ABC')).toBe(true)
    expect(capitalizeNext('', 'abc')).toBe(false)
    let s = t9Init('', 'Abc')
    s = press(s, '2', 0)
    expect(t9View(s).pending).toBe('A')
    s = t9Tick(s, 10_000)
    s = press(s, '2', 20_000)
    expect(t9Value(s)).toBe('Aa')
  })

  test('# cycles the modes and commits; 123 mode types digits', () => {
    let s = t9Init('', 'Abc')
    s = t9Press(s, '2', 0)
    s = t9Press(s, '#', 50)
    expect(s.text).toBe('A')
    expect(s.mode).toBe('abc')
    s = t9CycleMode(t9CycleMode(s))
    expect(s.mode).toBe('123')
    s = press(s, '0300', 100)
    expect(t9Value(s)).toBe('A0300')
    expect(t9CycleMode(s).mode).toBe('Abc')
  })

  test('0 is space, * cycles symbols, holding a key types its digit', () => {
    let s = t9Init('', 'abc')
    s = t9Press(s, '0', 0)
    s = t9Tick(s, 5000)
    expect(s.text).toBe(' ')
    s = t9Press(s, '*', 6000)
    s = t9Press(s, '*', 6050)
    expect(t9View(s).pending).toBe('+')
    s = t9LongPress(s, '7')
    expect(s.text).toBe(' 7')
    expect(s.pending).toBeNull()
  })

  test('backspace drops the cycling letter first, then committed text', () => {
    let s = t9Init('ab', 'abc')
    s = t9Press(s, '2', 0)
    s = t9Backspace(s)
    expect(t9Value(s)).toBe('ab')
    s = t9Backspace(s)
    expect(t9Value(s)).toBe('a')
  })

  test('keyboard text goes straight in and respects the length limit', () => {
    let s = t9Init('', 'abc', 5)
    s = t9Press(s, '2', 0)
    s = t9Insert(s, 'xyz123')
    expect(s.text).toBe('axyz1')
    expect(t9View(s).remaining).toBe(0)
    expect(t9Value(t9Press(s, '3', 100))).toBe('axyz1')
  })
})
