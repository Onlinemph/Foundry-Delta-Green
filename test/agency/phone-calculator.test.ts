import {
  calcInit,
  calcInput,
  calcPendingLine,
  formatCalc,
  type CalcInput,
} from '../../module/agency/phone/calculator.ts'

const run = (keys: CalcInput[]) => keys.reduce(calcInput, calcInit())
const split = (s: string) => s.split(' ') as CalcInput[]

describe('calculator', () => {
  test('basic operations', () => {
    expect(run(split('1 2 + 7 =')).display).toBe('19')
    expect(run(split('9 - 1 2 =')).display).toBe('-3')
    expect(run(split('6 * 7 =')).display).toBe('42')
    expect(run(split('1 / 4 =')).display).toBe('0.25')
  })

  test('immediate execution, like a pocket calculator', () => {
    expect(run(split('2 + 3 * 4 =')).display).toBe('20')
    // The running total shows when the next operator is pressed.
    expect(run(split('2 + 3 *')).display).toBe('5')
    expect(calcPendingLine(run(split('2 + 3 *')))).toBe('5 ×')
  })

  test('repeated = repeats the last operation', () => {
    expect(run(split('5 + 2 = = =')).display).toBe('11')
  })

  test('changing the operator before the next number', () => {
    expect(run(split('8 + - 3 =')).display).toBe('5')
  })

  test('decimal point, sign and backspace', () => {
    expect(run(split('. 5 + 1 =')).display).toBe('1.5')
    expect(run(split('1 . . 5')).display).toBe('1.5')
    expect(run(split('4 2 neg')).display).toBe('-42')
    expect(run(split('1 2 3 back')).display).toBe('12')
    expect(run(split('7 back')).display).toBe('0')
  })

  test('percent: on its own and of the running total', () => {
    expect(run(split('5 0 %')).display).toBe('0.5')
    expect(run(split('2 0 0 + 1 0 % =')).display).toBe('220')
  })

  test('division by zero shows Error until cleared or a new number', () => {
    const err = run(split('5 / 0 ='))
    expect(err.display).toBe('Error')
    expect(err.error).toBe(true)
    expect(calcInput(err, '+').display).toBe('0')
    expect(calcInput(err, '7').display).toBe('7')
    expect(calcInput(err, 'C')).toEqual(calcInit())
  })

  test('no floating-point noise, exponent for huge numbers, 12-digit entry limit', () => {
    expect(run(split('0 . 1 + 0 . 2 =')).display).toBe('0.3')
    expect(formatCalc(1 / 3)).toBe('0.333333333333')
    expect(formatCalc(2e15)).toBe('2e15')
    const long = run(split('1 2 3 4 5 6 7 8 9 0 1 2 3 4'))
    expect(long.display).toBe('123456789012')
  })
})
