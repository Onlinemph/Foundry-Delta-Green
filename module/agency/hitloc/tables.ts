/**
 * Grand Unified Hit Locations Table v2.4 (Emily Smirle), as transcribed in docs/agency/hit-locations.md.
 * Data only; the rules that read it are in engine.ts.
 */
import type { DamageType, MainRowId, Region, RowTarget, Side, TargetId } from './types.ts'

/* ---------------------------------------- */
/*  Main table (3d6)                         */
/* ---------------------------------------- */

export interface RowInfo {
  region: Region
  side: Side | null
  /** Sub-table to roll on (A-G), if any. */
  sub: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | null
}

export const MAIN_TABLE: { from: number; to: number; row: MainRowId }[] = [
  { from: 3, to: 4, row: 'skull' },
  { from: 5, to: 5, row: 'face' },
  { from: 6, to: 7, row: 'legRight' },
  { from: 8, to: 8, row: 'armRight' },
  { from: 9, to: 10, row: 'chest' },
  { from: 11, to: 11, row: 'abdomen' },
  { from: 12, to: 12, row: 'armLeft' },
  { from: 13, to: 14, row: 'legLeft' },
  { from: 15, to: 15, row: 'hand' },
  { from: 16, to: 16, row: 'foot' },
  { from: 17, to: 18, row: 'neck' },
]

export const ROWS: Record<MainRowId, RowInfo> = {
  skull: { region: 'skull', side: null, sub: null },
  face: { region: 'face', side: null, sub: 'A' },
  legRight: { region: 'leg', side: 'right', sub: 'B' },
  armRight: { region: 'arm', side: 'right', sub: 'C' },
  chest: { region: 'chest', side: null, sub: 'D' },
  abdomen: { region: 'abdomen', side: null, sub: 'E' },
  armLeft: { region: 'arm', side: 'left', sub: 'C' },
  legLeft: { region: 'leg', side: 'left', sub: 'B' },
  // Hand and foot don't say which side: rolled (1d6: 1-3 right, 4-6 left).
  hand: { region: 'hand', side: null, sub: 'F' },
  foot: { region: 'foot', side: null, sub: 'F' },
  neck: { region: 'neck', side: null, sub: 'G' },
}

/** Main-table row for a 3d6 total (clamped to 3-18). */
export function mainRow(total: number): MainRowId {
  const roll = Math.max(3, Math.min(18, Math.round(total)))
  return MAIN_TABLE.find(entry => roll >= entry.from && roll <= entry.to)!.row
}

/* ---------------------------------------- */
/*  Damage type classes                      */
/* ---------------------------------------- */

/** A damage type, or 'pi*' (every piercing grade) or 'tb' (tight-beam burning). */
export type TypeClass = DamageType | 'pi*' | 'tb'

export const PIERCING: DamageType[] = ['pi-', 'pi', 'pi+', 'pi++']

/* ---------------------------------------- */
/*  Called shots                             */
/* ---------------------------------------- */

export interface TargetInfo {
  /** Penalty to hit. */
  penalty: number
  /** Damage types that may target it (all when absent). */
  allowed?: TypeClass[]
  /** Only from the front arc / only from behind. */
  facing?: 'front' | 'rear'
  /** A miss by exactly 1 hits this instead. */
  missByOne?: TargetId
  /** What a hit counts as when the attack isn't allowed here. */
  fallback?: TargetId
  /** Armor gap: ignores the armor's DR (innate DR still counts). */
  armorGap?: boolean
  /** Chinks in armor: halves DR. */
  halveDR?: boolean
}

const PI: TypeClass[] = ['pi*']

/** Main-table locations as called shots ("Targeted" at a main location: the sub-table is still rolled). */
export const ROW_TARGETS: Record<RowTarget, TargetInfo> = {
  skull: { penalty: -7 },
  face: { penalty: -5 },
  neck: { penalty: -5, missByOne: 'chest' },
  chest: { penalty: 0 },
  abdomen: { penalty: -1 },
  arm: { penalty: -2 },
  leg: { penalty: -2 },
  hand: { penalty: -4 },
  foot: { penalty: -4 },
}

/** "Targeted locations" and "Harsh Realism: armor gaps". */
export const SPECIAL_TARGETS: Record<Exclude<TargetId, 'random' | RowTarget>, TargetInfo> = {
  chinksTorso: { penalty: -8, halveDR: true },
  chinksOther: { penalty: -10, halveDR: true },
  eye: { penalty: -9, allowed: ['imp', ...PI, 'tb'], fallback: 'face' },
  ear: { penalty: -7, missByOne: 'chest' },
  nose: { penalty: -7, facing: 'front', missByOne: 'chest', fallback: 'face' },
  jaw: { penalty: -6, facing: 'front', missByOne: 'chest', fallback: 'face' },
  spine: {
    penalty: -8,
    facing: 'rear',
    allowed: ['cr', 'cut', 'imp', ...PI, 'tb'],
    missByOne: 'chest',
    fallback: 'chest',
  },
  neckVein: { penalty: -8, allowed: ['cut', 'imp', ...PI, 'tb'], missByOne: 'neck', fallback: 'neck' },
  limbVein: { penalty: -5, allowed: ['cut', 'imp', ...PI, 'tb'], missByOne: 'limb', fallback: 'limb' },
  limbJoint: { penalty: -5, allowed: ['cr', 'cut', ...PI, 'tb'], missByOne: 'limb', fallback: 'limb' },
  extremityJoint: {
    penalty: -7,
    allowed: ['cr', 'cut', ...PI, 'tb'],
    missByOne: 'extremity',
    fallback: 'extremity',
  },
  vitals: { penalty: -3, allowed: ['cr', 'imp', ...PI, 'tb'], fallback: 'chest' },
  heart: { penalty: -5, allowed: ['cr', 'imp', ...PI, 'tb'], fallback: 'chest' },
  digestive: { penalty: -3 },
  pelvis: { penalty: -3 },
  groin: { penalty: -3 },
  armpit: { penalty: -8, allowed: ['imp'], armorGap: true, fallback: 'chest' },
  backOfKnee: { penalty: -8, armorGap: true },
  eyeslits: { penalty: -10, allowed: ['imp', ...PI, 'tb'], armorGap: true, fallback: 'face' },
  codpiece: { penalty: -8, armorGap: true },
  insideElbow: { penalty: -8, armorGap: true },
  insideThigh: { penalty: -8, armorGap: true },
  neckGap: { penalty: -8, armorGap: true },
  openPalm: { penalty: -8, armorGap: true },
  limb: { penalty: -2 },
  extremity: { penalty: -4 },
}

export function targetInfo(target: TargetId): TargetInfo | null {
  if (target === 'random') return null
  return (ROW_TARGETS as Record<string, TargetInfo>)[target] ?? (SPECIAL_TARGETS as Record<string, TargetInfo>)[target]
}

/**
 * Upstream hit-location names (and the ones this feature adds to the modifier bucket's picker) to
 * GUHL called-shot targets. Matched case-insensitively.
 */
export const TARGET_NAMES: Record<string, { target: TargetId; side?: Side }> = {
  Random: { target: 'random' },
  Eye: { target: 'eye' },
  Eyes: { target: 'eye' },
  'Eye, in helmet': { target: 'eye' },
  Skull: { target: 'skull' },
  'Skull, from behind': { target: 'skull' },
  Brain: { target: 'skull' },
  Face: { target: 'face' },
  'Face, from behind': { target: 'face' },
  Nose: { target: 'nose' },
  Jaw: { target: 'jaw' },
  Ear: { target: 'ear' },
  Neck: { target: 'neck' },
  'Neck Vein/Artery': { target: 'neckVein' },
  'Limb Vein/Artery': { target: 'limbVein' },
  'Limb Joint': { target: 'limbJoint' },
  'Extremity Joint': { target: 'extremityJoint' },
  Arm: { target: 'arm' },
  Arms: { target: 'arm' },
  'Arm, holding shield': { target: 'arm' },
  'Right Arm': { target: 'arm', side: 'right' },
  'Left Arm': { target: 'arm', side: 'left' },
  'Right Arm, holding shield': { target: 'arm', side: 'right' },
  'Left Arm, holding shield': { target: 'arm', side: 'left' },
  Leg: { target: 'leg' },
  Legs: { target: 'leg' },
  'Right Leg': { target: 'leg', side: 'right' },
  'Left Leg': { target: 'leg', side: 'left' },
  Hand: { target: 'hand' },
  Hands: { target: 'hand' },
  'Hand, holding shield': { target: 'hand' },
  'Right Hand': { target: 'hand', side: 'right' },
  'Left Hand': { target: 'hand', side: 'left' },
  Foot: { target: 'foot' },
  Feet: { target: 'foot' },
  'Right Foot': { target: 'foot', side: 'right' },
  'Left Foot': { target: 'foot', side: 'left' },
  Torso: { target: 'chest' },
  Chest: { target: 'chest' },
  Abdomen: { target: 'abdomen' },
  Vitals: { target: 'vitals' },
  'Vitals, Heart': { target: 'heart' },
  Groin: { target: 'groin' },
  'Digestive Tract': { target: 'digestive' },
  Pelvis: { target: 'pelvis' },
  Spine: { target: 'spine' },
  'Chinks in Torso': { target: 'chinksTorso' },
  'Chinks in Other': { target: 'chinksOther' },
  Armpit: { target: 'armpit' },
  'Back of Knee': { target: 'backOfKnee' },
  Eyeslits: { target: 'eyeslits' },
  Codpiece: { target: 'codpiece' },
  'Inside Elbow': { target: 'insideElbow' },
  'Inside Thigh': { target: 'insideThigh' },
  'Inside Thigh, from behind': { target: 'insideThigh' },
  'Neck (armor gap)': { target: 'neckGap' },
  'Open Palm': { target: 'openPalm' },
  'Open Palm, unarmed': { target: 'openPalm' },
  Limb: { target: 'limb' },
  Extremity: { target: 'extremity' },
}

/** Upstream name to send a miss-by-1 hit to (promptDefense's hitLocation). */
export const MISS_BY_ONE_NAMES: Partial<Record<TargetId, string>> = {
  chest: 'Torso',
  neck: 'Neck',
  limb: 'Limb',
  extremity: 'Extremity',
}

/**
 * Entries this feature adds to upstream's hit-location picker (HitLocations.hitlocationRolls), in
 * order. `desc` are i18n keys shown in brackets; upstream's own keys are reused where they exist.
 * Names already in upstream's list (Nose, Jaw, Vitals...) aren't repeated.
 */
export const PICKER_ENTRIES: { name: string; id: string; penalty: number; desc: string[] }[] = [
  { name: 'Abdomen', id: 'abdomen', penalty: -1, desc: [] },
  {
    name: 'Ear',
    id: 'ear',
    penalty: -7,
    desc: ['GURPS.agency.hitloc.desc.cuttingElseFace', 'GURPS.hitLocationDescChest'],
  },
  { name: 'Eye, in helmet', id: 'eyeHelmet', penalty: -10, desc: ['GURPS.agency.hitloc.desc.impPiTb'] },
  { name: 'Hand, holding shield', id: 'handShield', penalty: -8, desc: [] },
  {
    name: 'Spine',
    id: 'spine',
    penalty: -8,
    desc: [
      'GURPS.agency.hitloc.desc.behindOnly',
      'GURPS.agency.hitloc.desc.crCutImpPiTb',
      'GURPS.hitLocationDescChest',
    ],
  },
  {
    name: 'Limb Joint',
    id: 'limbJoint',
    penalty: -5,
    desc: ['GURPS.agency.hitloc.desc.crCutPiTb', 'GURPS.hitLocationDescLimb'],
  },
  {
    name: 'Extremity Joint',
    id: 'extremityJoint',
    penalty: -7,
    desc: ['GURPS.agency.hitloc.desc.crCutPiTb', 'GURPS.agency.hitloc.desc.missExtremity'],
  },
  { name: 'Digestive Tract', id: 'digestive', penalty: -3, desc: [] },
  { name: 'Pelvis', id: 'pelvis', penalty: -3, desc: [] },
  {
    name: 'Armpit',
    id: 'armpit',
    penalty: -8,
    desc: ['GURPS.agency.hitloc.desc.impOnly', 'GURPS.agency.hitloc.desc.gap'],
  },
  { name: 'Back of Knee', id: 'backOfKnee', penalty: -8, desc: ['GURPS.agency.hitloc.desc.gap'] },
  {
    name: 'Eyeslits',
    id: 'eyeslits',
    penalty: -10,
    desc: ['GURPS.agency.hitloc.desc.impPiTb', 'GURPS.agency.hitloc.desc.gap'],
  },
  { name: 'Codpiece', id: 'codpiece', penalty: -8, desc: ['GURPS.agency.hitloc.desc.gap'] },
  { name: 'Inside Elbow', id: 'insideElbow', penalty: -8, desc: ['GURPS.agency.hitloc.desc.gap'] },
  { name: 'Inside Thigh', id: 'insideThigh', penalty: -8, desc: ['GURPS.agency.hitloc.desc.gap'] },
  {
    name: 'Inside Thigh, from behind',
    id: 'insideThighBehind',
    penalty: -11,
    desc: ['GURPS.agency.hitloc.desc.gap'],
  },
  { name: 'Neck (armor gap)', id: 'neckGap', penalty: -8, desc: ['GURPS.agency.hitloc.desc.gap'] },
  { name: 'Open Palm', id: 'openPalm', penalty: -8, desc: ['GURPS.agency.hitloc.desc.gap'] },
  { name: 'Open Palm, unarmed', id: 'openPalmUnarmed', penalty: -6, desc: ['GURPS.agency.hitloc.desc.gap'] },
]

/** Extra names shown on cards (not in the picker) that need a GURPS.hitLocation<name> label. */
export const EXTRA_LABELS: { name: string; id: string }[] = [{ name: 'Limb', id: 'limb' }]

/* ---------------------------------------- */
/*  H and I: striking around partial armor   */
/* ---------------------------------------- */

/**
 * H: Pectorals. Armor that protects the vitals, and the % it covers of the upper chest: penalty to
 * hit around it, by coverage in sixths. Full coverage (6/6) has no way around: null.
 */
export function pectoralsPenalty(sixths: number): number | null {
  const n = Math.floor(sixths)
  if (n <= 0) return 0
  if (n <= 2) return -1
  if (n <= 4) return -2
  if (n === 5) return -3
  return null
}

/** I: Hitting 'Em Where It Hurts (striking around other partial coverage), by coverage in sixths. */
export function aroundCoveragePenalty(sixths: number): number | null {
  const n = Math.floor(sixths)
  if (n <= 0) return 0
  if (n <= 2) return -1
  if (n === 3) return -2
  if (n === 4) return -3
  return null
}
