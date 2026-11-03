/**
 * Grand Unified Hit Locations v2.4: rolling and resolving hit locations (docs/agency/hit-locations.md).
 *
 * Pure functions, no Foundry globals. Dice come in through a Roller so tests (and replays of a card
 * after the GM changes the facing) are deterministic.
 */
import {
  MISS_BY_ONE_NAMES,
  PIERCING,
  ROWS,
  ROW_TARGETS,
  TARGET_NAMES,
  mainRow,
  targetInfo,
  type TypeClass,
} from './tables.ts'
import type {
  Aim,
  AttackType,
  CoverZone,
  DamageType,
  DieRecord,
  Facing,
  HitResult,
  MainRowId,
  Part,
  PathSegment,
  Region,
  Roller,
  RowTarget,
  Side,
  TargetId,
} from './types.ts'

/* ---------------------------------------- */
/*  Damage types                             */
/* ---------------------------------------- */

const TYPE_ALIASES: Record<string, DamageType> = {
  cr: 'cr',
  crush: 'cr',
  crushing: 'cr',
  cut: 'cut',
  cu: 'cut',
  cutting: 'cut',
  imp: 'imp',
  impaling: 'imp',
  'pi-': 'pi-',
  'piercing-': 'pi-',
  'small piercing': 'pi-',
  pi: 'pi',
  piercing: 'pi',
  'pi+': 'pi+',
  'piercing+': 'pi+',
  'large piercing': 'pi+',
  'pi++': 'pi++',
  'piercing++': 'pi++',
  'huge piercing': 'pi++',
  burn: 'burn',
  burning: 'burn',
  cor: 'cor',
  corrosion: 'cor',
  corrosive: 'cor',
  tox: 'tox',
  toxic: 'tox',
}

/**
 * The attack's damage type from upstream's damage payload (damageType, damageModifier). The
 * tight-beam modifier is upstream's 'tbb' (also accepts 'tb').
 */
export function parseAttackType(type: unknown, modifier?: unknown): AttackType {
  const key = String(type ?? '')
    .trim()
    .toLowerCase()
  const parsed = TYPE_ALIASES[key] ?? 'other'
  const tightBeam = parsed === 'burn' && /(^|\s)tbb?(\s|$)/i.test(String(modifier ?? ''))
  return { type: parsed, tightBeam }
}

/** Does the attack's damage type belong to any of the classes? ('pi*' = any piercing, 'tb' = tight-beam burning). */
export function typeMatches(attack: AttackType, classes: TypeClass[]): boolean {
  if (classes.includes(attack.type)) return true
  if (classes.includes('pi*') && PIERCING.includes(attack.type)) return true
  return classes.includes('tb') && attack.type === 'burn' && attack.tightBeam
}

/* ---------------------------------------- */
/*  Wounding multipliers                     */
/* ---------------------------------------- */

/** Basic Set wounding modifiers (B379), for torso hits. 'other' (fat, dmg...) isn't GUHL's business. */
export const STANDARD_MULTIPLIERS: Record<DamageType, number | null> = {
  cr: 1,
  cut: 1.5,
  imp: 2,
  'pi-': 0.5,
  pi: 1,
  'pi+': 1.5,
  'pi++': 2,
  burn: 1,
  cor: 1,
  tox: 1,
  other: null,
}

const LIMB_PARTS: Part[] = ['arm', 'leg', 'hand', 'foot', 'limbJoint', 'extremityJoint']
const FACE_PARTS: Part[] = ['face', 'jaw', 'nose', 'ear']

/**
 * GUHL wounding multiplier for a hit on `part`. Uses the Basic Set values where the chart is silent.
 * Returns null for damage the chart doesn't cover (fatigue, generic damage), so the caller leaves
 * upstream's value alone.
 */
export function guhlMultiplier(part: Part, attack: AttackType): number | null {
  const type = attack.type
  const standard = STANDARD_MULTIPLIERS[type]
  if (standard === null) return null

  switch (part) {
    case 'skull':
    case 'eye':
      // "if not tox: x4 injury"; the eye is a skull hit without the skull's DR.
      return type === 'tox' ? standard : 4
    case 'neck':
      if (type === 'cr' || type === 'cor') return 1.5
      if (type === 'cut') return 2
      return standard
    case 'neckVein':
      // cr, cor x2; cut x2.5. Interpretation: imp and pi use the neck's (= standard) values.
      if (type === 'cr' || type === 'cor') return 2
      if (type === 'cut') return 2.5
      return standard
    case 'limbVein':
      // cr, cor x1.5; cut x2. Interpretation: no limb cap for imp/pi ("no injury limit"): torso values.
      if (type === 'cr' || type === 'cor') return 1.5
      if (type === 'cut') return 2
      return standard
    case 'vitals':
    case 'heart':
      if (type === 'imp' || PIERCING.includes(type)) return 3
      if (type === 'burn' && attack.tightBeam) return 2
      return standard
    default:
      if (FACE_PARTS.includes(part)) return type === 'cor' ? 1.5 : standard
      if (LIMB_PARTS.includes(part)) return type === 'imp' || type === 'pi+' || type === 'pi++' ? 1 : standard
      return standard
  }
}

/* ---------------------------------------- */
/*  Called shots                             */
/* ---------------------------------------- */

/** Aim for an upstream / picker hit-location name ("Left Arm", "Spine", "Skull, from behind"...); null if unknown. */
export function aimFromName(name: string | null | undefined): Aim | null {
  const wanted = String(name ?? '')
    .trim()
    .toLowerCase()
  if (!wanted) return null
  for (const [label, aim] of Object.entries(TARGET_NAMES)) {
    if (label.toLowerCase() === wanted) return { target: aim.target, side: aim.side ?? null }
  }
  return null
}

export interface CalledShotContext {
  facing?: Facing
  /** The target wears a helmet (eye: -10). */
  helmet?: boolean
  /** The arm or hand holds a shield (arm -4, hand -8). */
  shield?: boolean
  /** The target is unarmed (open palm: -6). */
  unarmed?: boolean
}

/** Penalty to hit a called-shot target, with the conditional penalties from the chart. */
export function calledShotPenalty(target: TargetId, ctx: CalledShotContext = {}): number {
  const rear = ctx.facing === 'rear'
  switch (target) {
    case 'random':
      return 0
    case 'skull':
      return rear ? -5 : -7
    case 'face':
      return rear ? -7 : -5
    case 'arm':
      return ctx.shield ? -4 : -2
    case 'hand':
      return ctx.shield ? -8 : -4
    case 'eye':
      return ctx.helmet ? -10 : -9
    case 'insideThigh':
      return rear ? -11 : -8
    case 'openPalm':
      return ctx.unarmed ? -6 : -8
    default:
      return targetInfo(target)?.penalty ?? 0
  }
}

/** Why a called shot isn't allowed for this attack (damage type, or facing), or null when it is. */
export function calledShotProblem(target: TargetId, attack: AttackType, facing: Facing): 'type' | 'facing' | null {
  const info = targetInfo(target)
  if (!info) return null
  if (info.allowed && !typeMatches(attack, info.allowed)) return 'type'
  if (info.facing === 'front' && facing !== 'front') return 'facing'
  if (info.facing === 'rear' && facing !== 'rear') return 'facing'
  return null
}

/** Where a called shot that misses by exactly 1 lands instead, if the chart says. */
export function missByOne(target: TargetId): TargetId | null {
  return targetInfo(target)?.missByOne ?? null
}

/**
 * The upstream name a failed attack roll lands on ("Torso", "Neck", "Limb", "Extremity"), or null
 * for a plain miss: only a called shot the chart gives a miss-by-1 rule, missed by exactly 1, and
 * not a roll of 17 or 18.
 */
export function missByOneName(
  margin: number,
  failure: boolean,
  rolledSeventeen: boolean,
  aimName: string | null
): string | null {
  if (!failure || rolledSeventeen || margin !== -1 || !aimName) return null
  const aim = aimFromName(aimName)
  const to = aim ? missByOne(aim.target) : null
  return to ? (MISS_BY_ONE_NAMES[to] ?? null) : null
}

/* ---------------------------------------- */
/*  Resolution                               */
/* ---------------------------------------- */

interface Draft {
  row: MainRowId | null
  region: Region
  side: Side | null
  part: Part
  sub: string | null
  path: PathSegment[]
  notes: string[]
}

export interface ResolveContext {
  attack: AttackType
  facing: Facing
  roll: Roller
}

const VEIN: TypeClass[] = ['cut', 'imp', 'tb']
const KNEE_ELBOW_JOINT: TypeClass[] = ['cr']
const VITALS: TypeClass[] = ['cr', 'imp', 'pi*', 'tb']
const EXTREMITY_JOINT: TypeClass[] = ['cr', 'cut', 'pi*', 'tb']
/** Neck vein/artery (sub-table G), and the inside-thigh armor gap's optional vein rule. */
const VEIN_TARGET: TypeClass[] = ['cut', 'imp', 'pi*', 'tb']
const PENETRATING: TypeClass[] = ['imp', 'pi*', 'tb']
const JOINT_TARGET: TypeClass[] = ['cr', 'cut', 'pi*', 'tb']

/** A roller that also records what it rolled. */
function recorder(roll: Roller): { roll: Roller; rolls: DieRecord[] } {
  const rolls: DieRecord[] = []
  return {
    rolls,
    roll: (key, dice) => {
      const value = roll(key, dice)
      rolls.push({ key, dice, value })
      return value
    },
  }
}

const rollSide = (roll: Roller): Side => (roll('side', 1) <= 3 ? 'right' : 'left')

function limbRow(limb: 'arm' | 'leg', side: Side): MainRowId {
  if (limb === 'arm') return side === 'left' ? 'armLeft' : 'armRight'
  return side === 'left' ? 'legLeft' : 'legRight'
}

function regionSegment(region: Region, side: Side | null): PathSegment {
  return side && ['arm', 'leg', 'hand', 'foot'].includes(region) ? { key: region, side } : { key: region }
}

/** Start a draft at a main-table location. */
function rowDraft(row: MainRowId, side: Side | null): Draft {
  const info = ROWS[row]
  const s = info.side ?? side
  // Every region is also the GUHL part for a plain hit there.
  const part = info.region as Part
  return { row, region: info.region, side: s, part, sub: null, path: [regionSegment(info.region, s)], notes: [] }
}

const step = (draft: Draft, changes: Partial<Draft>, ...keys: string[]): Draft => ({
  ...draft,
  ...changes,
  path: [...draft.path, ...keys.map(key => ({ key }))],
})

/** Roll the row's sub-table (A-G) and apply it. */
function rollSubTable(draft: Draft, ctx: ResolveContext): Draft {
  const sub = draft.row ? ROWS[draft.row].sub : null
  if (!sub) return draft
  const die = ctx.roll('sub', 1)
  const { attack, facing } = ctx
  const is = (classes: TypeClass[]) => typeMatches(attack, classes)

  switch (sub) {
    case 'A': // the face
      if (die === 1) return step(draft, { part: 'jaw', sub: 'jaw', notes: ['armorCheekGuards'] }, 'jaw')
      if (die === 2)
        return is(PENETRATING)
          ? step(draft, { part: 'skull', sub: 'nose', notes: ['armorNasal', 'noseToSkull'] }, 'nose', 'skull')
          : step(draft, { part: 'nose', sub: 'nose', notes: ['armorNasal'] }, 'nose')
      if (die === 3)
        return attack.type === 'cut'
          ? step(draft, { part: 'ear', sub: 'ear', notes: ['armorBroadCheekGuards'] }, 'ear')
          : step(draft, { part: 'face', sub: 'ear', notes: ['armorBroadCheekGuards', 'earAsFace'] }, 'ear')
      if (die <= 5) return step(draft, { part: 'face', sub: 'cheek', notes: ['armorCheekGuards'] }, 'cheek')
      // Interpretation: the eye only for attacks that may target it (imp, pi, tb burn); otherwise a face hit.
      return is(PENETRATING)
        ? step(draft, { part: 'eye', sub: 'eye', notes: ['armorVisor'] }, 'eyes')
        : step(draft, { part: 'face', sub: 'eye', notes: ['armorVisor', 'eyesAsFace'] }, 'eyes')

    case 'B': // the leg
      if (die <= 3) return step(draft, { sub: 'shin' }, 'shin')
      if (die === 4)
        return is(KNEE_ELBOW_JOINT)
          ? step(draft, { part: 'limbJoint', sub: 'knee' }, 'knee', 'joint')
          : step(draft, { sub: 'knee' }, 'knee')
      if (die === 5) return step(draft, { sub: 'thigh' }, 'thigh')
      return is(VEIN)
        ? step(draft, { part: 'limbVein', sub: 'thigh' }, 'thigh', 'veinArtery')
        : step(draft, { sub: 'thigh' }, 'thigh')

    case 'C': // the arm
      if (die <= 3) return step(draft, { sub: 'forearm' }, 'forearm')
      if (die === 4)
        return is(KNEE_ELBOW_JOINT)
          ? step(draft, { part: 'limbJoint', sub: 'elbow' }, 'elbow', 'joint')
          : step(draft, { sub: 'elbow' }, 'elbow')
      if (die === 5) return step(draft, { sub: 'upperArm' }, 'upperArm')
      return is(VEIN)
        ? step(draft, { part: 'limbVein', sub: 'shoulder' }, 'shoulder', 'veinArtery')
        : step(draft, { sub: 'shoulder' }, 'shoulder')

    case 'D': // the chest
      if (die === 1) {
        if (is(VITALS)) return step(draft, { part: 'vitals', sub: 'vitals' }, 'vitals')
        if (attack.type === 'cut' && facing === 'rear') return step(draft, { part: 'spine', sub: 'spine' }, 'spine')
      }
      return draft

    case 'E': // the abdomen
      if (die === 1) return is(VITALS) ? step(draft, { part: 'vitals', sub: 'vitals' }, 'vitals') : draft
      if (die <= 4) return step(draft, { part: 'digestive', sub: 'digestive' }, 'digestive')
      if (die === 5) return step(draft, { part: 'pelvis', sub: 'pelvis' }, 'pelvis')
      return step(draft, { part: 'groin', sub: 'groin' }, 'groin')

    case 'F': // the extremity
      if (die === 1 && is(EXTREMITY_JOINT)) return step(draft, { part: 'extremityJoint', sub: 'joint' }, 'joint')
      return draft

    case 'G': // the neck. Interpretation: cut/imp/pi/tb -> vein; cr from the rear -> spine.
      if (die === 1) {
        if (is(VEIN_TARGET)) return step(draft, { part: 'neckVein', sub: 'vein' }, 'veinArtery')
        if (attack.type === 'cr' && facing === 'rear') return step(draft, { part: 'spine', sub: 'spine' }, 'spine')
      }
      return draft
  }
}

/** Resolve a main-table location (random roll or a called main location), sub-table included. */
function resolveRow(row: MainRowId, side: Side | null, ctx: ResolveContext): Draft {
  const info = ROWS[row]
  const s = info.side ?? side ?? (info.region === 'hand' || info.region === 'foot' ? rollSide(ctx.roll) : null)
  return rollSubTable(rowDraft(row, s), ctx)
}

function rowForTarget(target: RowTarget, side: Side | null, roll: Roller): { row: MainRowId; side: Side | null } {
  switch (target) {
    case 'arm':
    case 'leg': {
      const s = side ?? rollSide(roll)
      return { row: limbRow(target, s), side: s }
    }
    default:
      return { row: target, side }
  }
}

function randomLimb(roll: Roller): 'arm' | 'leg' {
  return roll('limb', 1) <= 3 ? 'arm' : 'leg'
}

function randomExtremity(roll: Roller): 'hand' | 'foot' {
  return roll('extremity', 1) <= 3 ? 'hand' : 'foot'
}

/** A direct hit on a sub-location (no sub-table roll): e.g. a called shot to the vitals. */
function direct(region: Region, side: Side | null, part: Part, sub: string | null, ...keys: string[]): Draft {
  return {
    row: null,
    region,
    side,
    part,
    sub,
    path: [regionSegment(region, side), ...keys.map(key => ({ key }))],
    notes: [],
  }
}

/** Resolve a called shot at a "Targeted locations" / armor-gap target. */
function resolveSpecial(
  target: Exclude<TargetId, 'random' | RowTarget>,
  side: Side | null,
  ctx: ResolveContext
): Draft {
  const { attack, roll } = ctx
  const is = (classes: TypeClass[]) => typeMatches(attack, classes)

  switch (target) {
    case 'eye':
      return direct('face', null, 'eye', 'eye', 'eyes')
    case 'ear':
      // "cutting, or treat as face"
      return attack.type === 'cut'
        ? direct('face', null, 'ear', 'ear', 'ear')
        : { ...direct('face', null, 'face', 'ear', 'ear'), notes: ['earAsFace'] }
    case 'nose':
      // Interpretation: sub-table A's rule applies to an aimed nose hit too.
      return is(PENETRATING)
        ? { ...direct('face', null, 'skull', 'nose', 'nose', 'skull'), notes: ['noseToSkull'] }
        : direct('face', null, 'nose', 'nose', 'nose')
    case 'jaw':
      return direct('face', null, 'jaw', 'jaw', 'jaw')
    case 'spine':
      return direct('chest', null, 'spine', 'spine', 'spine')
    case 'neckVein':
      return direct('neck', null, 'neckVein', 'vein', 'veinArtery')
    case 'limbVein': {
      const limb = randomLimb(roll)
      const s = side ?? rollSide(roll)
      return direct(
        limb,
        s,
        'limbVein',
        limb === 'arm' ? 'shoulder' : 'thigh',
        limb === 'arm' ? 'shoulder' : 'thigh',
        'veinArtery'
      )
    }
    case 'limbJoint': {
      const limb = randomLimb(roll)
      const s = side ?? rollSide(roll)
      return direct(limb, s, 'limbJoint', limb === 'arm' ? 'elbow' : 'knee', limb === 'arm' ? 'elbow' : 'knee', 'joint')
    }
    case 'extremityJoint': {
      const ext = randomExtremity(roll)
      return direct(ext, side ?? rollSide(roll), 'extremityJoint', 'joint', 'joint')
    }
    case 'vitals':
      return direct('chest', null, 'vitals', 'vitals', 'vitals')
    case 'heart':
      return direct('chest', null, 'heart', 'heart', 'heart')
    case 'digestive':
      return direct('abdomen', null, 'digestive', 'digestive', 'digestive')
    case 'pelvis':
      return direct('abdomen', null, 'pelvis', 'pelvis', 'pelvis')
    case 'groin':
      return direct('abdomen', null, 'groin', 'groin', 'groin')
    case 'chinksTorso':
      return resolveRow('chest', null, ctx)
    case 'chinksOther': {
      // Any location but the torso: re-roll chest and abdomen results.
      let row = mainRow(roll('main', 3))
      for (let i = 2; (row === 'chest' || row === 'abdomen') && i <= 20; i++) row = mainRow(roll(`main${i}`, 3))
      return resolveRow(row, side, ctx)
    }
    case 'armpit':
      return { ...direct('chest', null, 'vitals', 'vitals', 'vitals'), notes: ['armpitCritical'] }
    case 'backOfKnee': {
      const s = side ?? rollSide(roll)
      return is(JOINT_TARGET)
        ? direct('leg', s, 'limbJoint', 'knee', 'knee', 'joint')
        : direct('leg', s, 'leg', 'knee', 'knee')
    }
    case 'eyeslits':
      return direct('face', null, 'eye', 'eye', 'eyes')
    case 'codpiece':
      return direct('abdomen', null, 'groin', 'groin', 'groin')
    case 'insideElbow': {
      const s = side ?? rollSide(roll)
      return is(JOINT_TARGET)
        ? direct('arm', s, 'limbJoint', 'elbow', 'elbow', 'joint')
        : direct('arm', s, 'arm', 'elbow', 'elbow')
    }
    case 'insideThigh': {
      // Optional rule from the chart, used: cut, imp, pi and tb burn hit the limb vein/artery.
      const s = side ?? rollSide(roll)
      return is(VEIN_TARGET)
        ? { ...direct('leg', s, 'limbVein', 'thigh', 'thigh', 'veinArtery'), notes: ['insideThighVein'] }
        : direct('leg', s, 'leg', 'thigh', 'thigh')
    }
    case 'neckGap':
      return resolveRow('neck', null, ctx)
    case 'openPalm':
      return resolveRow('hand', side, ctx)
    case 'limb': {
      const limb = randomLimb(roll)
      const s = side ?? rollSide(roll)
      return resolveRow(limbRow(limb, s), s, ctx)
    }
    case 'extremity':
      return resolveRow(randomExtremity(roll), side, ctx)
  }
}

function resolveAim(target: TargetId, side: Side | null, ctx: ResolveContext): Draft {
  if (target === 'random') {
    const row = mainRow(ctx.roll('main', 3))
    return resolveRow(row, side, ctx)
  }
  if (target in ROW_TARGETS) {
    const { row, side: s } = rowForTarget(target as RowTarget, side, ctx.roll)
    return resolveRow(row, s, ctx)
  }
  return resolveSpecial(target as Exclude<TargetId, 'random' | RowTarget>, side, ctx)
}

/**
 * Resolve one hit. `aim.target` 'random' rolls 3d6 on the main table; a main location still rolls
 * its sub-table; a special target is hit directly. A called shot the attack isn't allowed to make
 * (damage type, facing) is resolved as the chart's fallback and flagged `invalid`.
 */
export function resolveHit(aim: Aim, ctx: ResolveContext): HitResult {
  const rec = recorder(ctx.roll)
  const inner: ResolveContext = { ...ctx, roll: rec.roll }
  const side = aim.side ?? null

  let target = aim.target
  let invalid: HitResult['invalid'] = null
  const problem = calledShotProblem(target, ctx.attack, ctx.facing)
  const fallback = targetInfo(target)?.fallback
  if (problem && fallback) {
    invalid = { reason: problem, target }
    target = fallback
  }

  const draft = resolveAim(target, side, inner)
  const info = targetInfo(aim.target)
  const notes = [...draft.notes]
  if (invalid) notes.unshift(invalid.reason === 'type' ? 'invalidType' : 'invalidFacing')

  // Chinks and armor gaps: put the target in front of the path ("Armpit > Chest > Vitals").
  const gap = !invalid && !!info?.armorGap
  const prefix: PathSegment[] = gap || info?.halveDR ? [{ key: `target.${aim.target}` }] : []
  if (gap) notes.push('armorGap')
  if (info?.halveDR) notes.push('chinks')

  return finish(draft, {
    aim: { target: aim.target, side },
    attack: ctx.attack,
    path: [...prefix, ...draft.path],
    notes,
    armorGap: gap,
    halveDR: !!info?.halveDR,
    invalid,
    rolls: rec.rolls,
  })
}

/* ---------------------------------------- */
/*  Derived properties                       */
/* ---------------------------------------- */

const UPSTREAM: Partial<Record<Part, string>> = {
  skull: 'Skull',
  eye: 'Eye',
  face: 'Face',
  jaw: 'Face',
  nose: 'Face',
  ear: 'Face',
  neck: 'Neck',
  neckVein: 'Neck',
  chest: 'Torso',
  vitals: 'Vitals',
  heart: 'Vitals',
  abdomen: 'Torso',
  digestive: 'Torso',
  pelvis: 'Torso',
  groin: 'Groin',
}

const BODY_KEYS: Partial<Record<Part, string[]>> = {
  skull: ['Skull'],
  eye: ['Eye', 'Face'],
  face: ['Face'],
  jaw: ['Jaw', 'Face'],
  nose: ['Nose', 'Face'],
  ear: ['Ear', 'Face'],
  neck: ['Neck'],
  neckVein: ['Neck'],
  chest: ['Torso', 'Chest'],
  vitals: ['Vitals', 'Torso'],
  heart: ['Vitals, Heart', 'Heart', 'Vitals', 'Torso'],
  abdomen: ['Abdomen', 'Torso'],
  digestive: ['Digestive Tract', 'Abdomen', 'Torso'],
  pelvis: ['Pelvis', 'Abdomen', 'Torso'],
  groin: ['Groin', 'Torso'],
}

const REGION_UPSTREAM: Record<Region, string> = {
  skull: 'Skull',
  face: 'Face',
  neck: 'Neck',
  chest: 'Torso',
  abdomen: 'Torso',
  arm: 'Arm',
  leg: 'Leg',
  hand: 'Hand',
  foot: 'Foot',
}

/** Cover zone of a body region (limbs by side; no side counts as right). */
export function zoneOf(region: Region, side: Side | null): CoverZone {
  const s = side === 'left' ? 'L' : 'R'
  switch (region) {
    case 'arm':
    case 'leg':
    case 'hand':
    case 'foot':
      return `${region}${s}` as CoverZone
    default:
      return region
  }
}

function upstreamFor(part: Part, region: Region): { upstream: string; bodyKeys: string[] } {
  if (part === 'spine') {
    return region === 'neck'
      ? { upstream: 'Neck', bodyKeys: ['Neck'] }
      : { upstream: 'Torso', bodyKeys: ['Spine', 'Torso'] }
  }
  // Nose hit sent to the skull keeps the skull's DR.
  const upstream = UPSTREAM[part] ?? REGION_UPSTREAM[region]
  return { upstream, bodyKeys: BODY_KEYS[part] ?? [upstream] }
}

function partNotes(part: Part, attack: AttackType): string[] {
  const t = attack.type
  switch (part) {
    case 'skull':
      return t === 'tox' ? [] : ['skullShock']
    case 'eye':
      return ['eyeCripple', t === 'tox' ? 'eyeTox' : 'eyeSkull']
    case 'face':
      return ['faceShock']
    case 'jaw':
      return ['jawShock']
    case 'nose':
      return ['noseCripple', t === 'cut' ? 'noseCut' : 'noseCrush']
    case 'ear':
      return ['earCripple']
    case 'neck':
      return t === 'cr' ? ['neckWindpipe'] : []
    case 'spine':
      return ['spineShock', 'spineCripple']
    case 'chest':
    case 'abdomen':
      return ['torsoCap']
    case 'digestive':
      return ['torsoCap', 'digestiveMajor']
    case 'pelvis':
      return ['torsoCap', 'pelvisMajor']
    case 'groin':
      return ['torsoCap', 'groinShock']
    case 'vitals':
      return [...(t === 'cr' ? ['vitalsCrush'] : []), 'vitalsMajor']
    case 'heart':
      return [...(t === 'cr' ? ['vitalsCrush'] : []), 'vitalsMajor', 'heartSpecial']
    case 'arm':
    case 'leg':
      return ['limbCripple']
    case 'hand':
    case 'foot':
      return ['extremityCripple']
    case 'limbJoint':
      return ['jointLimb']
    case 'extremityJoint':
      return ['jointExtremity']
    case 'limbVein':
      return ['veinLimb']
    case 'neckVein':
      return []
  }
}

function bleeding(part: Part, attack: AttackType): { bleedModifier: number; bleedFast: boolean } {
  switch (part) {
    case 'skull':
    case 'eye':
      return { bleedModifier: 0, bleedFast: true }
    case 'neck':
      return { bleedModifier: -2, bleedFast: true }
    case 'neckVein':
    case 'limbVein':
      return { bleedModifier: attack.type === 'cut' ? -4 : -3, bleedFast: true }
    case 'vitals':
    case 'heart':
      return { bleedModifier: -4, bleedFast: true }
    default:
      return { bleedModifier: 0, bleedFast: false }
  }
}

const CAPPED: Part[] = ['chest', 'abdomen', 'digestive', 'pelvis', 'groin', 'spine']

function finish(
  draft: Draft,
  extra: Pick<HitResult, 'aim' | 'path' | 'notes' | 'armorGap' | 'halveDR' | 'invalid' | 'rolls'> & {
    attack: AttackType
  }
): HitResult {
  const { part, region, side } = draft
  const { upstream, bodyKeys } = upstreamFor(part, region)
  const notes = [...extra.notes, ...partNotes(part, extra.attack)]
  if (part === 'skull') notes.push('skullDR')
  if (part === 'spine') notes.push('spineDR')
  if (bleeding(part, extra.attack).bleedFast) notes.push('bleedFast')

  return {
    system: 'guhl',
    aim: extra.aim,
    row: draft.row,
    region,
    part,
    sub: draft.sub,
    side: ['arm', 'leg', 'hand', 'foot'].includes(region) ? side : null,
    path: extra.path,
    upstream,
    bodyKeys,
    zone: zoneOf(region, side),
    multiplier: guhlMultiplier(part, extra.attack),
    extraDR: part === 'spine' ? 3 : 0,
    naturalDR: part === 'skull' ? 2 : 0,
    armorGap: extra.armorGap,
    halveDR: extra.halveDR,
    injuryCap: CAPPED.includes(part),
    crippleDivisor: part === 'limbJoint' ? 3 : part === 'extremityJoint' ? 4 : part === 'limbVein' ? 0 : null,
    ...bleeding(part, extra.attack),
    notes: [...new Set(notes)],
    rolls: extra.rolls,
    invalid: extra.invalid,
  }
}

/* ---------------------------------------- */
/*  Dice                                     */
/* ---------------------------------------- */

/** A roller from a source of uniform [0, 1) numbers (Foundry: CONFIG.Dice.randomUniform). */
export function uniformRoller(uniform: () => number): Roller {
  return (_key, dice) => {
    let total = 0
    for (let i = 0; i < dice; i++) total += Math.min(6, Math.floor(uniform() * 6) + 1)
    return total
  }
}

/**
 * A roller that replays recorded values by key and records new ones. A card stores its record so
 * the GM can change the facing and get the same dice back.
 */
export function replayRoller(record: Record<string, number>, fresh: Roller): Roller {
  return (key, dice) => {
    if (typeof record[key] === 'number') return record[key]
    const value = fresh(key, dice)
    record[key] = value
    return value
  }
}

/** A roller that hands out fixed values in order (tests). */
export function sequenceRoller(values: number[]): Roller {
  let index = 0
  return () => {
    if (index >= values.length) throw new Error('sequenceRoller: out of dice')
    return values[index++]
  }
}
