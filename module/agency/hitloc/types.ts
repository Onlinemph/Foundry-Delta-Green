/**
 * Shared types for the hit-location feature (Grand Unified Hit Locations v2.4 + zonal cover).
 * Plain data only: results are stored in chat message flags and on the damage calculator.
 */

/** Damage types the tables know. Anything else (fat, dmg, injury, kb, resources) is 'other'. */
export type DamageType = 'cr' | 'cut' | 'imp' | 'pi-' | 'pi' | 'pi+' | 'pi++' | 'burn' | 'cor' | 'tox' | 'other'

export interface AttackType {
  type: DamageType
  /** Burning with the tight-beam modifier ("burn (tb)", upstream damage modifier 'tbb'). */
  tightBeam: boolean
}

/** Where the attacker stands relative to the target's facing (B386). */
export type Facing = 'front' | 'side' | 'rear'

export type Side = 'left' | 'right'

/** Rows of the main 3d6 table. */
export type MainRowId =
  | 'skull'
  | 'face'
  | 'legRight'
  | 'armRight'
  | 'chest'
  | 'abdomen'
  | 'armLeft'
  | 'legLeft'
  | 'hand'
  | 'foot'
  | 'neck'

/** Body region a hit lands in: decides the cover zone and, for limbs, the upstream location. */
export type Region = 'skull' | 'face' | 'neck' | 'chest' | 'abdomen' | 'arm' | 'leg' | 'hand' | 'foot'

/** What the wound rules apply to: one entry per distinct set of GUHL effects. */
export type Part =
  | 'skull'
  | 'eye'
  | 'face'
  | 'jaw'
  | 'nose'
  | 'ear'
  | 'neck'
  | 'neckVein'
  | 'spine'
  | 'chest'
  | 'vitals'
  | 'heart'
  | 'abdomen'
  | 'digestive'
  | 'pelvis'
  | 'groin'
  | 'arm'
  | 'leg'
  | 'limbJoint'
  | 'limbVein'
  | 'hand'
  | 'foot'
  | 'extremityJoint'

/** Called-shot targets that are a main-table location (the sub-table is still rolled). */
export type RowTarget = 'skull' | 'face' | 'neck' | 'chest' | 'abdomen' | 'arm' | 'leg' | 'hand' | 'foot'

/** Called-shot targets from the "Targeted locations" and armor-gap tables, plus miss-by-1 destinations. */
export type SpecialTarget =
  | 'eye'
  | 'ear'
  | 'nose'
  | 'jaw'
  | 'spine'
  | 'neckVein'
  | 'limbVein'
  | 'limbJoint'
  | 'extremityJoint'
  | 'vitals'
  | 'heart'
  | 'digestive'
  | 'pelvis'
  | 'groin'
  | 'chinksTorso'
  | 'chinksOther'
  | 'armpit'
  | 'backOfKnee'
  | 'eyeslits'
  | 'codpiece'
  | 'insideElbow'
  | 'insideThigh'
  | 'neckGap'
  | 'openPalm'
  /** Miss by 1 from a limb vein/joint: a random limb. */
  | 'limb'
  /** Miss by 1 from an extremity joint: a random hand or foot. */
  | 'extremity'

export type TargetId = 'random' | RowTarget | SpecialTarget

/** What the attacker aimed at. */
export interface Aim {
  target: TargetId
  /** Side named by the attack ("Left Arm"); otherwise rolled. */
  side?: Side | null
}

/** Cover zones (body parts the GM can mark as behind cover). */
export type CoverZone =
  | 'skull'
  | 'face'
  | 'neck'
  | 'chest'
  | 'abdomen'
  | 'armL'
  | 'armR'
  | 'handL'
  | 'handR'
  | 'legL'
  | 'legR'
  | 'footL'
  | 'footR'

/** One labelled die roll the resolution used ('main' 3d6, 'sub' 1d6, 'side' 1d6, ...). */
export interface DieRecord {
  key: string
  dice: number
  value: number
}

/**
 * Rolls `dice` six-sided dice and returns the total. `key` names the roll ('main', 'sub', 'side',
 * 'limb', 'extremity', 'cover'): replaying a card re-uses the recorded value for the same key.
 */
export type Roller = (key: string, dice: number) => number

/** One segment of a display path: a localization id under GURPS.agency.hitloc.loc, or a raw name. */
export interface PathSegment {
  key?: string
  side?: Side
  /** Literal text (an upstream hit location name, for body plans GUHL doesn't cover). */
  raw?: string
}

export type InvalidReason = 'type' | 'facing'

export interface HitResult {
  /** 'guhl': resolved on the GUHL tables; 'standard': on the actor's own (upstream) table. */
  system: 'guhl' | 'standard'
  aim: Aim
  /** Main-table row, when the hit went through one (random roll or a called main location). */
  row: MainRowId | null
  region: Region
  /** GUHL rules location; null for 'standard'. */
  part: Part | null
  /** Sub-location id (jaw, thigh, shoulder, joint, vitals...), when the sub-table gave one. */
  sub: string | null
  side: Side | null
  path: PathSegment[]
  /** Upstream canonical location name (no side): Skull, Face, Eye, Neck, Torso, Vitals, Groin, Arm, Leg, Hand, Foot. */
  upstream: string
  /** Names to look for on the target's body plan, most specific first (sides are added by the mapper). */
  bodyKeys: string[]
  zone: CoverZone
  /** GUHL wounding multiplier for the attack's damage type; null when GUHL has no opinion (fat, dmg...). */
  multiplier: number | null
  /** Extra DR on top of the location's DR (spine 3). */
  extraDR: number
  /** Natural DR the location has that body plans normally include already (skull 2, from GCS). */
  naturalDR: number
  /** An armor gap: the armor's DR doesn't count (innate DR does). */
  armorGap: boolean
  /** Chinks in armor: halve DR. */
  halveDR: boolean
  /** Chest/abdomen injury cap applies. */
  injuryCap: boolean
  /** Cripple over HP / n; 0 = can't be crippled (and no injury limit); null = the location's usual rule. */
  crippleDivisor: number | null
  bleedModifier: number
  /** Bleeding rolls every 30 seconds instead of every minute. */
  bleedFast: boolean
  notes: string[]
  /** Dice used, in order. */
  rolls: DieRecord[]
  /** The called shot isn't allowed (damage type or facing): resolved as `fallback` instead. */
  invalid: { reason: InvalidReason; target: TargetId } | null
}
