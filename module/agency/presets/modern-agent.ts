/**
 * Data for the "Modern agent" campaign preset. Kept apart from index.ts so it can be unit-tested
 * and edited without touching Foundry code.
 */
export type PresetSetting = {
  /** Full setting key in the 'gurps' namespace. */
  key: string
  value: unknown
  /** i18n key describing the change, shown in the confirmation dialog. */
  label: string
}

const L = 'GURPS.agency.presets.change'

/**
 * World settings the preset writes. Entries whose setting isn't registered (feature missing or
 * renamed) are skipped at apply time, so this list can name every fork feature safely.
 */
export const MODERN_AGENT_SETTINGS: PresetSetting[] = [
  { key: 'useConditionalInjury', value: false, label: `${L}.noCI` },
  { key: 'agency-damage-model', value: 'rfh', label: `${L}.rfh` },
  { key: 'agency-sanity', value: true, label: `${L}.sanity` },
  { key: 'agency-san-roll', value: 'fright', label: `${L}.sanRoll` },
  { key: 'agency-ammo-tracking', value: true, label: `${L}.ammo` },
  { key: 'agency-ammo-empty', value: 'block', label: `${L}.ammoEmpty` },
]

/**
 * Example NPC for the quick NPC generator ("Mook"), in the generator's own text format
 * (see lib/npc-input.js, class Mook). A competent field agent rather than a fantasy goblin.
 */
export const MODERN_AGENT_MOOK = {
  name: 'Field Agent',
  title: 'federal agent',
  desc: 'Dark suit, lanyard badge, tired eyes.',
  st: 10,
  dx: 11,
  iq: 11,
  ht: 11,
  dodge: 0,
  parry: 0,
  hp: 10,
  will: 12,
  per: 12,
  fp: 11,
  speed: 0,
  move: 0,
  sm: '+0',
  dr: 0,
  damage: '1d-2/1d',
  notes: `Carries a sidearm, badge and phone. Calls for backup when outgunned.
[Per to spot a tail] [Will to keep a cover story straight]`,
  traits: `Combat Reflexes
Legal Enforcement Powers 2
Duty (Agency; 12 or less)`,
  skills: `Guns (Pistol)-13
Guns (Rifle)-12
Brawling-12
Driving (Automobile)-11
Observation-12
Interrogation-11
Stealth-11`,
  melee: `Punch (12) 1d-2 cr`,
  ranged: `Pistol, 9mm (13) 2d+2 pi acc 2 rof 3 shots 17(3) bulk -2`,
  spells: '',
  equipment: `Pistol, 9mm; 1; $600; 2 lbs
Spare magazine; 2; $30; 0.5 lbs
Badge and credentials; 1; $0; 0.2 lbs
Smartphone; 1; $250; 0.3 lbs`,
}
