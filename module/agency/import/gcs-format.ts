/**
 * Readers for GCS character files (data "version": 5, written by GCS 5.x).
 *
 * The upstream importer (module/actor/actor-importer.js) was written against older GCS output and reads several
 * fields that current GCS no longer writes (equipment "weight"/"categories", modifier "notes", spell "college" as a
 * string, ancestry containers named "race") or reads raw values where GCS writes the resolved one into "calc"
 * (weapon reach/accuracy/range/..., note text). These helpers read the current fields and fall back to the old ones,
 * so files from older 5.x releases keep working.
 */

export type GcsNode = Record<string, any>

/** Parse a GCS number or measurement ("1,900 lb", "2.4 lb", 350, "-2") to a number. Unparseable input gives 0. */
export function parseGcsNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string') return 0
  const match = value.replace(/,/g, '').match(/-?(\d+(\.\d*)?|\.\d+)/)
  return match ? parseFloat(match[0]) : 0
}

/** Round away floating point noise (0.4999999999999998 -> 0.5). */
export function roundGcs(value: number, places = 6): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

export function isContainer(node: GcsNode): boolean {
  if (typeof node.type === 'string') return node.type.endsWith('_container')
  // Data version 5: the first character of the id is the kind, upper case for containers.
  const kind = typeof node.id === 'string' ? node.id[0] : ''
  return !!kind && kind !== kind.toLowerCase()
}

/** Every node in a GCS list, depth first. */
export function* walkGcs(nodes: GcsNode[] | undefined): Generator<GcsNode> {
  for (const node of nodes ?? []) {
    yield node
    yield* walkGcs(node.children)
  }
}

/**
 * Per-piece cost and weight of an equipment row, not counting its contents.
 *
 * Current GCS writes these as calc.value and calc.weight. Older output only had the extended (quantity x
 * (own + contents)) figures, which the upstream importer divides and subtracts; that breaks on quantity 0, on
 * containers that reduce the weight of their contents, and on weights with thousands separators.
 */
export function equipmentPieceValues(node: GcsNode): { cost: number; weight: number } | undefined {
  const calc = node.calc
  if (!calc || calc.value === undefined || calc.weight === undefined) return undefined
  let weight = parseGcsNumber(calc.weight)
  // A container that reduces the weight of its contents (contained_weight_reduction): Foundry sums the full weight
  // of the contents, so fold the reduction into the container's own weight to keep the totals (and encumbrance)
  // equal to GCS's. This can make the container's own weight negative, as upstream's arithmetic did.
  const qty = parseGcsNumber(node.quantity)
  const children: GcsNode[] = node.children ?? []
  if (
    qty > 0 &&
    children.length &&
    calc.extended_weight !== undefined &&
    children.every(c => c.calc?.extended_weight !== undefined)
  ) {
    const contents = children.reduce((sum, c) => sum + parseGcsNumber(c.calc.extended_weight), 0)
    const reduced = parseGcsNumber(calc.extended_weight) / qty - weight
    if (contents - reduced > 1e-6) weight -= contents - reduced
  }
  return { cost: parseGcsNumber(calc.value), weight: roundGcs(weight) }
}

/** The key of a hit location table entry, ignoring spacing and case ("Midleg" -> "Mid Leg"). */
export function hitLocationTableKey(where: string, table: Record<string, unknown> | undefined): string | undefined {
  if (!table) return undefined
  if (where in table) return where
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const target = squash(where)
  return Object.keys(table).find(key => squash(key) === target)
}

/**
 * Weight carried, for encumbrance: the extended weight of each enabled top level carried row (contents, quantity and
 * contained-weight reductions included, as GCS computes it). Falls back to the old "weight" field.
 */
export function carriedWeight(equipment: GcsNode[] | undefined): number {
  let total = 0
  for (const node of equipment ?? []) {
    if (node.disabled) continue // as GCS's Entity.WeightCarried
    if (node.calc?.extended_weight !== undefined) {
      total += parseGcsNumber(node.calc.extended_weight)
    } else {
      const qty = isContainer(node) ? 1 : parseGcsNumber(node.quantity)
      total += parseGcsNumber(node.weight ?? node.base_weight) * qty + carriedWeight(node.children)
    }
  }
  return roundGcs(total)
}

/** Tags (current GCS) or categories (older GCS) as the comma separated string Foundry shows. */
export function gcsTags(node: GcsNode): string {
  const tags = node.tags ?? node.categories
  return Array.isArray(tags) ? tags.join(', ') : typeof tags === 'string' ? tags : ''
}

/** Spell colleges: an array in current GCS. Foundry code calls string methods on it, so join it. */
export function gcsCollege(college: unknown): string {
  if (Array.isArray(college)) return college.join(', ')
  return typeof college === 'string' ? college : ''
}

/** Note text: GCS writes the text with any embedded scripts resolved to calc.resolved_text. */
export function gcsNoteText(node: GcsNode): string {
  return node.calc?.resolved_text ?? node.markdown ?? node.text ?? ''
}

/** Notes of a trait/equipment modifier: local_notes in current GCS (resolved into calc), notes in older files. */
function modifierNoteText(modifier: GcsNode): string {
  return modifier.calc?.resolved_notes ?? modifier.local_notes ?? modifier.notes ?? ''
}

/**
 * The enabled modifiers of a trait or equipment row, formatted for its notes: "Name 2 (notes)". Modifier containers
 * are skipped but their enabled children are listed.
 */
export function modifierSummaries(modifiers: GcsNode[] | undefined): string[] {
  const out: string[] = []
  for (const modifier of modifiers ?? []) {
    if (modifier.disabled) continue
    if (modifier.children?.length) {
      out.push(...modifierSummaries(modifier.children))
      continue
    }
    const levels = parseGcsNumber(modifier.levels)
    const notes = modifierNoteText(modifier)
    out.push(`${modifier.name ?? ''}${levels > 0 ? ' ' + levels : ''}${notes ? ' (' + notes + ')' : ''}`)
  }
  return out
}

/** The level GCS shows for a leveled trait (calc.level includes bonuses), else its bought levels. */
export function traitLevel(node: GcsNode): number | undefined {
  const level = node.calc?.level ?? node.levels
  return level === undefined || level === null || level === '' ? undefined : parseGcsNumber(level)
}

/**
 * A weapon field as GCS shows it. GCS writes the resolved value into calc only when it differs from the raw value
 * (skill and SM bonuses to parry and reach, scopes, muscle-powered ranges...), so prefer calc and fall back to raw.
 */
export function weaponField(weapon: GcsNode, key: string): string {
  const value = weapon.calc?.[key] ?? weapon[key]
  return value === undefined || value === null ? '' : String(value)
}

/** Map a GCS DR specialization ("crushing", "fire", "burn") to the key Foundry's split DR uses. */
export function drSplitKey(key: string, damageTypeMap: Record<string, string> | undefined): string {
  const lower = key.toLowerCase()
  return damageTypeMap?.[lower] ?? lower
}

/**
 * Map a GCS body type name to a Foundry hit location table: GCS names winged variants "Quadruped, Winged" and adds
 * qualifiers like "Humanoid (Low-Tech)".
 */
export function bodyPlanKey(name: string, tables: Record<string, unknown>): string {
  const lower = (name ?? '').toLowerCase().trim()
  if (lower in tables) return lower
  const winged = lower.match(/^(\w+),\s*winged$/)
  if (winged) {
    for (const key of [`${winged[1]}Winged`, `winged ${winged[1]}`]) if (key in tables) return key
  }
  const bare = lower.replace(/\s*\(.*\)\s*$/, '')
  if (bare in tables) return bare
  return lower
}

/** The name of the character's ancestry (race) container, if any. */
export function ancestryName(traits: GcsNode[] | undefined): string {
  for (const node of walkGcs(traits)) {
    if (!node.disabled && isContainer(node) && ['ancestry', 'race'].includes(node.container_type))
      return node.name ?? ''
  }
  return ''
}

export interface TraitPoints {
  ads: number
  disads: number
  quirks: number
  race: number
  attributes: number
}

/**
 * Trait point totals, split the way GCS's PointsBreakdown does: disabled traits count nothing, group containers
 * count their children, ancestry and attribute containers count as a whole toward race and attributes, any other
 * container (meta-trait, alternative abilities) counts as one trait, and a -1 point trait is a quirk.
 */
export function traitPoints(traits: GcsNode[] | undefined, into?: TraitPoints): TraitPoints {
  const pb = into ?? { ads: 0, disads: 0, quirks: 0, race: 0, attributes: 0 }
  for (const node of traits ?? []) {
    if (node.disabled) continue
    const points = parseGcsNumber(node.calc?.points)
    if (isContainer(node)) {
      const type = node.container_type ?? 'group'
      if (type === 'group') {
        traitPoints(node.children, pb)
        continue
      }
      if (type === 'ancestry' || type === 'race') {
        pb.race += points
        continue
      }
      if (type === 'attributes') {
        pb.attributes += points
        continue
      }
    }
    if (points === -1) pb.quirks += points
    else if (points > 0) pb.ads += points
    else pb.disads += points
  }
  return pb
}

/** Skill or spell points, skipping disabled rows and their contents, as GCS does. */
export function listPoints(nodes: GcsNode[] | undefined): number {
  let total = 0
  for (const node of nodes ?? []) {
    if (node.disabled) continue
    if (isContainer(node)) total += listPoints(node.children)
    else total += parseGcsNumber(node.points)
  }
  return total
}

export interface GcsPool {
  id: string
  name: string
  max: number
  current: number
}

const STANDARD_POOLS = new Set(['hp', 'fp', 'qp'])

/**
 * Custom resource pools (attribute type "pool" other than HP/FP/QP, e.g. Mana or Energy Reserve), which Foundry
 * shows as resource trackers.
 */
export function customPools(file: GcsNode): GcsPool[] {
  const defs: GcsNode[] = file.settings?.attributes ?? []
  const out: GcsPool[] = []
  for (const def of defs) {
    if (def.type !== 'pool' || STANDARD_POOLS.has(def.id)) continue
    const attr = (file.attributes ?? []).find((a: GcsNode) => a.attr_id === def.id)
    if (!attr) continue
    const max = parseGcsNumber(attr.calc?.value)
    out.push({
      id: def.id,
      name: def.full_name || def.name || def.id,
      max,
      current: attr.calc?.current === undefined ? max : parseGcsNumber(attr.calc.current),
    })
  }
  return out
}
