# Explosions (automated)

Code: `module/agency/explosions/`. Tests: `test/agency/explosions-*.test.ts`. Settings: Agency fork settings window.

Page references: **Bnnn** = Basic Set, **HTnnn** = High-Tech, **TSnn** = Tactical Shooting. Rules were taken from the
books; this file summarizes how they are implemented and marks each **interpretation** where the books leave a gap.

## At the table

**Throwing or firing an explosive** (any ranged weapon whose damage explodes: `ex`, fragments in brackets, a stun
grenade's `HT-5 aff`, `Smoke`; a linked explosion in the weapon's notes, `with 6d [2d] cr ex linked`, counts too):

1. Click the attack as usual.
   - One token targeted: choose **At <name>** (a direct hit; they may dodge), **At the ground there** (+4, no
     defense) or **Pick a spot** (+4).
   - Nothing targeted: click the spot. A preview shows the blast and fragment radii; Shift places it off the grid;
     right-click or Esc cancels the attack.
   - Area attacks get +4 (B414) and the range modifier to the spot, unless a range modifier is already in the bucket.
2. The attack roll goes through upstream's roll as usual (modifier bucket, ammo, the shooting feature's dialog).
3. Result:
   - **Area attack hit**: it goes off on the spot.
   - **Miss** (either mode): it scatters (B414) and goes off where it lands. With the scatter setting off, the
     thrower clicks where it lands.
   - **Direct hit**: the target's owner (or the GM) gets an **Incoming!** card: Dodge, Dodge and drop (+3, ends
     prone) or No defense. A successful dodge sends it off by the dodger's margin of success; otherwise it struck
     him. A critical hit strikes with no defense (B556).
4. The active GM's client sets it off: circle templates for the blast, fragment, stun and smoke radii; every token
   in reach (the thrower too) by grid distance in yards; walls between the blast and each token as cover; each
   target's dice rolled.
5. Players whose characters were caught get a whispered **Explosion!** prompt: **Dive for cover** (Dodge +3, with an
   optional "cover within a step"), **Throw yourself on it** (within a step of the explosive), or **Stay put**.
6. The GM gets one **explosion card**: per target, distance, cover DR (editable), blast damage after the divisor (and
   the B400 DR it meets), the fragment attack and each fragment's damage and location, knockback, stun results, the
   dive result. NPCs' dives are rolled from the card (Dive / Smother it / Stay). The enclosed-space selector re-derives
   every row.
7. **Apply** (per row) or **Apply all**: each blast and fragment goes through upstream's Apply Damage calculator
   without opening it: `Large-Area` for the blast, the rolled location for each fragment. Under Revised Fractional
   Health the wounds feature records a wound per location for the blast. Failed stun rolls set Stunned; knockback
   pushes the token away from the blast, stopping at walls. Dives still pending are closed ("too late").
   **Remove templates** clears the circles.

**GM command** for IEDs, set charges and anything without an attack roll (then click where it goes off):

```
/explode 4d cr ex [2d]
/explode 2lb c4                      charge by weight and explosive (B415, HT183): 6d×n
/explode 1lb black powder [1d]       a pipe bomb wrapped in nails (TS67)
/explode flashbang | smoke 8 | tear gas
/explode 9d [2d] cr ex target        at the targeted token instead of a click
/explode 9d [2d] cr ex contact       the targeted token is lying on it (B415)
/explode 3d cr ex internal           it goes off inside the targeted token (B415)
... options: enclosed (×2), vented (×1.5), thermobaric, underwater, vacuum, airburst
```

A wall's cover DR can be set per wall: `wall.document.setFlag('gurps', 'agency.coverDR', 16)` (e.g. from a macro on
`canvas.walls.controlled`); otherwise the setting's default applies.

## Damage strings

Parsed (`parse.ts`): book style `9d [2d] cr ex`, GCS style `4d+1 cr ex [2d cut]`, `6dx2`/`6d×2`, armor divisors
`5d(10)`, extra modifiers (`inc`, `sur`, `dkb`...), fragments only `[3d] cut`, linked components
`7d(10) cr ex with 6d [2d] cr ex linked`, `4d+2 cr ex linked burn`, `HT-5 aff (10 yd.)`, `Smoke (7 yd.)`, `Dmg` prefixes.

- **Interpretation:** a linked component given only by type (`linked burn`) uses the primary's dice and spreads with
  its blast (a separate burning collateral roll per target).
- **Interpretation:** book shorthand with an untyped primary (`4d(10) with 1d [1d] cr ex linked`, HT144) takes the
  linked type.
- Fragments without a type cut (B414). **Interpretation:** untyped fragments with a fractional armor divisor on a
  burning explosion (`2d [1d(0.2)] burn ex`, WP) burn: hot fragments (B415, HT172).

## Rules implemented

| Rule | Source | Notes |
|---|---|---|
| Collateral radius 2 × dice (6d×2 = 12 dice) | B414 | Adds don't count. |
| Collateral damage ÷ (3 × yards), round down | B414 | Rolled for each target individually; a setting lets NPCs share one roll, as B414 allows the GM. |
| Target struck takes the listed damage as is, with the armor divisor; others get full DR | B414 | |
| Explosion DR = large-area injury | B400, B414 | Applied as `Large-Area`; card shows the B400 DR (average of torso and least-protected exposed location, round up; locations behind the token's partial cover excluded). |
| Fragment radius 5 × frag dice | B414 | |
| Fragment attack: skill 15 + range (B550) + posture (B551: -2 for any non-standing posture) + SM; +1 hit per 3 of margin; struck target hit automatically | B414 | Critical success rules B556. One damage roll and random location per hit (B400). |
| Fragments don't get the explosive's armor divisor | B414 | Their own divisor (e.g. 0.2) applies. |
| Fragment whose location is behind cover hits the cover | B414 | Full cover (walls, a dive into cover, a body) stops every fragment; the token's partial cover only covered locations. |
| Airburst: no posture modifier; only overhead cover | B415 | Walls ignored; fragment locations rolled "from above" (feet→hands, legs→arms, B400). |
| Underwater ÷ yards, vacuum ÷ 10 × yards | B415 | `/explode ... underwater/vacuum`. |
| Thermobaric / fuel-air ÷ 2 × yards | HT170, HT187 | Weapon name or `/explode ... thermobaric`. |
| Enclosed space ×2, ×1.5 with doors/windows | HT181 | GM selector on the card; `/explode ... enclosed/vented`. |
| Contact explosion: max damage to the one on it; others get his torso DR + HP as cover | B415, B377 | |
| Internal explosion: DR has no effect, vitals ×3 | B415 | `/explode ... internal`. |
| Dive for cover: Dodge and Drop (+3, ends prone); success = a step farther; with cover a step away, success reaches it; failure = effect first | B377, B414 | Rolled through upstream's Dodge with the defense feature's modifiers. |
| Throwing yourself on it: sacrificial dodge and drop within a step; success = contact explosion | B377 | First success wins. |
| Knockback: 1 yd per full (ST−2) of crushing damage, away from the blast; DX at −1 per yard after the first or fall | B378 | ST ≤ 3: 1 yd per point; no ST: HP. Uses the damage after the divisor and cover. |
| Cover DR through walls; armor divisor applies to cover | B407-408 | Every wall that blocks movement between blast and token adds its cover DR; default DR 6 (B558 modern house). |
| Scatter: miss by MoF yards, max half the distance (round up); 1d direction, 1 = attacker's facing, 60° clockwise | B414 | |
| Attacking an area: +4, no defense, dive allowed | B414 | |
| Charge size: 6d × √(lbs × 4 × REF); REF table | B415, HT183-188 | Matches the book's examples (1 lb TNT 6d×2, 0.5 lb dynamite 9d+1...). |
| Stun / flashbang: 10 yd, HT-5, +5 each Protected Hearing / Vision, failure stuns, HT-5 each turn to recover | HT193 | Also makes smoke. DR doesn't help (sense-based). |
| Smoke: template only | HT171, HT192, HT143 | Radius from the damage text. |
| Tear gas: template and a note (two HT-2 rolls) | HT171 | Not rolled. |
| Burning damage ≥ 3 / ≥ 10 sets clothing on fire | B434 | Card note; explosions are incendiary (B414). |
| Rapid fire: extra hits | B373 | One explosion per attack roll; extra hits are noted on the card. |

## Interpretations

- **Distance 0**: someone in the blast's hex who wasn't struck counts as 1 yard away (B414 gives no rule).
- **Gridless scenes**: distances round to the nearest yard.
- **Diving vs fragments**: B414 calls the dive the only active defense against fragments. As for a dodge against rapid
  fire (B375), a successful dive stops one fragment plus one per point of margin; the extra yard (B377) applies to
  the blast. Critical fragment hits can't be dived away (B556).
- **Who may dive**: anyone in the blast or fragment radius except the target struck (he had his defense against the
  attack itself). Not against a stun grenade's flash.
- **A dodged direct hit**: scatters by the dodger's margin of success, with the same half-distance cap as a miss.
- **Smothering**: the hero takes maximum damage from each explosive component, and no separate fragment attack.
- **Internal explosion**: others nearby get the host's torso DR + HP as cover, as for a contact explosion.
- **Walls and afflictions**: a stun grenade doesn't affect someone behind a wall.
- **Knockback** isn't applied to someone lying on the explosive or hosting it.

## Not automated

- Throwing a grenade back (B410), cooking off (HT190, TS25): the fuse is the thrower's business.
- High-Tech's optional concussion/deafness and flash/blindness checks (HT181-182).
- Incidental fragmentation (B415): add it to the string, e.g. `/explode 8d [1d-4] cr ex`.
- Damage to the cover itself, and spall (HT170).
- The Critical Hit Table on a critical attack (only "no defense" is applied).

## Integration

- The before-attack step is chained at runtime onto the hook upstream's `attack()` already calls
  (`GURPS.agency.shooting.beforeRangedAttack`): ours runs first, then the shooting feature's. No upstream file was
  changed. Explosive attacks set `optionalArgs.agencyHandled`, so the defense feature doesn't post its own card.
- Fragment hit locations call `GURPS.agency.hitloc.rollLocation({ actor, token, damageType, source: 'fragment',
  fromAbove })` when the hit-location feature is loaded (a string or `{ location }` / `{ where }`, sync or async),
  else upstream's 3d6 against the actor's table. A location missing from the actor's table is applied to the torso.
- Partial cover is read from `flags.gurps.agency.cover` on the token: `{ locations: string[], dr: number }`.
- Socket messages use upstream's `system.gurps` channel, namespaced `agencyBoom.*`; the active GM's client does the
  work. With no GM online the explosion is resolved on the sender's client.
- `GURPS.agency.explosions.detonate(request)` sets one off from a macro.
