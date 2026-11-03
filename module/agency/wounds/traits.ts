/**
 * Traits that change how Revised Fractional Health treats a character, detected from the actor's
 * advantage/disadvantage list (system.ads, as imported from GCS or GCA).
 */

export type InjuryTolerance = 'unliving' | 'homogeneous' | 'diffuse'

export interface Traits {
  highPainThreshold: boolean
  hardToSubdue: number
  hardToKill: number
  injuryTolerance: InjuryTolerance | null
  fragileUnnatural: boolean
  hemophilia: boolean
  rapidHealing: boolean
}

export interface TraitLike {
  name?: string
  notes?: string
  level?: number | string | null
  contains?: Record<string, TraitLike> | TraitLike[]
  collapsed?: Record<string, TraitLike> | TraitLike[]
}

export const NO_TRAITS: Traits = Object.freeze({
  highPainThreshold: false,
  hardToSubdue: 0,
  hardToKill: 0,
  injuryTolerance: null,
  fragileUnnatural: false,
  hemophilia: false,
  rapidHealing: false,
})

function children(trait: TraitLike): TraitLike[] {
  const list = trait.contains ?? trait.collapsed
  if (!list) return []
  return Array.isArray(list) ? list : Object.values(list)
}

/** Flatten nested trait containers into one list. */
export function flattenTraits(traits: TraitLike[] | Record<string, TraitLike> | null | undefined): TraitLike[] {
  if (!traits) return []
  const list = Array.isArray(traits) ? traits : Object.values(traits)
  const result: TraitLike[] = []
  for (const trait of list) {
    if (!trait || typeof trait !== 'object') continue
    result.push(trait)
    result.push(...flattenTraits(children(trait)))
  }
  return result
}

/** "Hard to Subdue 2" or { level: 2 } -> 2; a leveled trait without a number counts as one level. */
export function traitLevel(trait: TraitLike): number {
  const level = Number(trait.level)
  if (Number.isFinite(level) && level > 0) return level
  const match = (trait.name ?? '').match(/(\d+)\s*$/)
  return match ? parseInt(match[1], 10) : 1
}

function injuryToleranceOf(trait: TraitLike): InjuryTolerance | null {
  const name = (trait.name ?? '').trim()
  const notes = trait.notes ?? ''
  const isIT = /^injury tolerance\b/i.test(name)
  const text = isIT ? `${name} ${notes}` : name
  if (!isIT && !/^(unliving|homogen(e)?ous|diffuse)\b/i.test(name)) return null
  if (/diffuse/i.test(text)) return 'diffuse'
  if (/homogen(e)?ous/i.test(text)) return 'homogeneous'
  if (/unliving/i.test(text)) return 'unliving'
  return null
}

const IT_RANK: Record<InjuryTolerance, number> = { unliving: 1, homogeneous: 2, diffuse: 3 }

export function detectTraits(traits: TraitLike[] | Record<string, TraitLike> | null | undefined): Traits {
  const result: Traits = { ...NO_TRAITS }
  for (const trait of flattenTraits(traits)) {
    const name = (trait.name ?? '').trim()
    if (/^high pain threshold\b/i.test(name)) result.highPainThreshold = true
    else if (/^hard to subdue\b/i.test(name)) result.hardToSubdue = Math.max(result.hardToSubdue, traitLevel(trait))
    else if (/^hard to kill\b/i.test(name)) result.hardToKill = Math.max(result.hardToKill, traitLevel(trait))
    else if (/^fragile\b/i.test(name) && /unnatural/i.test(`${name} ${trait.notes ?? ''}`))
      result.fragileUnnatural = true
    else if (/^hemophilia\b/i.test(name)) result.hemophilia = true
    else if (/^(very )?rapid healing\b/i.test(name)) result.rapidHealing = true

    const it = injuryToleranceOf(trait)
    if (it && (!result.injuryTolerance || IT_RANK[it] > IT_RANK[result.injuryTolerance])) result.injuryTolerance = it
  }
  return result
}

/** Injury Tolerance (unliving, and so homogeneous and diffuse) includes High Pain Threshold. */
export function hasHighPainThreshold(traits: Traits): boolean {
  return traits.highPainThreshold || traits.injuryTolerance !== null
}

/** Unliving, homogeneous and diffuse characters never suffer shock, impairment or stunning. */
export function ignoresShockAndStun(traits: Traits): boolean {
  return traits.injuryTolerance !== null
}

/** Homogeneous and diffuse bodies have no vital organs or brain to single out. */
export function hasNoVitals(traits: Traits): boolean {
  return traits.injuryTolerance === 'homogeneous' || traits.injuryTolerance === 'diffuse'
}
