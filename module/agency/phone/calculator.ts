/**
 * A pocket calculator: immediate execution (2 + 3 x 4 = 20, like the real thing), repeated '='
 * repeats the last operation, percent, sign change, backspace. Pure state in, state out.
 */

export type CalcOp = '+' | '-' | '*' | '/'
export type CalcInput =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '.'
  | CalcOp
  | '='
  | 'C'
  | 'back'
  | 'neg'
  | '%'

export interface CalcState {
  /** What the display shows (the entry being typed or the last result). */
  display: string
  /** Left operand waiting for the right one. */
  acc: number | null
  op: CalcOp | null
  /** The next digit starts a new entry. */
  fresh: boolean
  error: boolean
  /** Last operation, for repeated '='. */
  last: { op: CalcOp; operand: number } | null
}

export const MAX_DIGITS = 12

export function calcInit(): CalcState {
  return { display: '0', acc: null, op: null, fresh: true, error: false, last: null }
}

export const OP_SYMBOL: Record<CalcOp, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' }

/** Number -> display string: at most 12 significant digits, no float noise, exponent when huge. */
export function formatCalc(value: number): string {
  if (!Number.isFinite(value)) return 'Error'
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e12 || abs < 1e-9) {
    return value
      .toExponential(6)
      .replace(/\.?0+e/, 'e')
      .replace('e+', 'e')
  }
  const rounded = Number(value.toPrecision(MAX_DIGITS))
  let text = String(rounded)
  if (text.includes('e')) text = rounded.toFixed(MAX_DIGITS).replace(/\.?0+$/, '')
  return text
}

function apply(a: number, op: CalcOp, b: number): number {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return b === 0 ? NaN : a / b
  }
}

const value = (s: CalcState) => Number(s.display)

function result(state: CalcState, n: number): CalcState {
  if (!Number.isFinite(n)) return { ...calcInit(), display: 'Error', error: true }
  return { ...state, display: formatCalc(n), fresh: true }
}

export function calcInput(state: CalcState, input: CalcInput): CalcState {
  if (input === 'C') return calcInit()
  if (state.error) {
    // Any key after an error starts over, keeping a typed digit.
    return /^[0-9.]$/.test(input) ? calcInput(calcInit(), input) : calcInit()
  }

  if (/^[0-9]$/.test(input)) {
    if (state.fresh) return { ...state, display: input, fresh: false }
    const digits = state.display.replace(/[-.]/g, '').length
    if (digits >= MAX_DIGITS) return state
    return { ...state, display: state.display === '0' ? input : state.display + input }
  }

  switch (input) {
    case '.':
      if (state.fresh) return { ...state, display: '0.', fresh: false }
      return state.display.includes('.') ? state : { ...state, display: state.display + '.' }
    case 'back':
      if (state.fresh) return state
      if (state.display.length <= 1 || (state.display.length === 2 && state.display.startsWith('-')))
        return { ...state, display: '0' }
      return { ...state, display: state.display.slice(0, -1) }
    case 'neg':
      if (state.display === '0') return state
      return {
        ...state,
        display: state.display.startsWith('-') ? state.display.slice(1) : '-' + state.display,
      }
    case '%': {
      // 200 + 10 % -> 200 + 20; on its own, 10 % -> 0.1.
      const n = value(state)
      const pct = state.acc !== null && (state.op === '+' || state.op === '-') ? (state.acc * n) / 100 : n / 100
      return result(state, pct)
    }
    case '=': {
      if (state.op !== null && state.acc !== null) {
        const operand = value(state)
        const out = result(state, apply(state.acc, state.op, operand))
        return { ...out, acc: null, op: null, last: { op: state.op, operand } }
      }
      if (state.last) {
        return result(state, apply(value(state), state.last.op, state.last.operand))
      }
      return { ...state, fresh: true }
    }
    default: {
      const op = input as CalcOp
      // Changing your mind about the operator.
      if (state.fresh && state.op !== null) return { ...state, op }
      if (state.op !== null && state.acc !== null) {
        const out = result(state, apply(state.acc, state.op, value(state)))
        if (out.error) return out
        return { ...out, acc: Number(out.display), op }
      }
      return { ...state, acc: value(state), op, fresh: true, last: null }
    }
  }
}

/** The small line above the display: '12 ×' while an operation waits. */
export function calcPendingLine(state: CalcState): string {
  if (state.error || state.op === null || state.acc === null) return ''
  return `${formatCalc(state.acc)} ${OP_SYMBOL[state.op]}`
}
