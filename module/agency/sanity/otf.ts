/**
 * Agency sanity: the [SAN <loss> [category]] On-the-Fly formula, e.g. ["Sees the body" SAN 0/1d4 violence].
 * Added to the front of lib/otf-parser.ts's PARSERS list; clicking it calls GURPS.actionFuncs[SAN_ACTION].
 */
import { gspan, PARSERS } from '../../../lib/otf-parser.ts'
import { formatSanLoss, parseSanOtf } from './rules.ts'

export const SAN_ACTION = 'agency-sanity'

interface OtfInput {
  str: string
  overridetxt?: string
  blindroll?: boolean
  sourceId?: string
}

/** Duck-typed like the parsers in lib/otf-parser.ts (only parse_() is called). */
export const sanOtfParser = {
  regex: /^SAN:?\s/i as RegExp | undefined,
  parse(_match: RegExpMatchArray, _input: OtfInput) {
    return null
  },
  parse_(input: OtfInput) {
    const parsed = parseSanOtf(input.str)
    if (!parsed) return null
    const action = {
      orig: input.str,
      type: SAN_ACTION,
      loss: formatSanLoss(parsed.loss),
      category: parsed.category,
      desc: input.overridetxt ?? '',
      blindroll: input.blindroll,
      sourceId: input.sourceId,
    }
    return { text: gspan(input.overridetxt, input.str, action as any), action }
  },
}

export function registerSanOtfParser(): void {
  const parsers = PARSERS as unknown as (typeof sanOtfParser)[]
  if (!parsers.includes(sanOtfParser)) parsers.unshift(sanOtfParser)
}
