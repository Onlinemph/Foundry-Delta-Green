# GURPS Game Aid: Agency fork (private)

A private fork of the GURPS 4e Game Aid for Foundry VTT v13/v14, set up for a present-day
conspiracy-horror campaign. It keeps the system id `gurps`, so existing worlds, actors and
GURPS modules keep working. It replaces the official system when installed, and its manifest has
no update URL, so Foundry won't overwrite it with an upstream release.

## Install

1. Back up your world folder.
2. Stop Foundry. Replace `Data/systems/gurps` with the contents of `release/gurps-agency-<version>.zip`.
3. Start Foundry and open the world as GM. Accept the **Modern Agent preset** when offered; it can be
   re-run from Configure Settings → Campaign preset.
4. House rules and automation are under Configure Settings → **Agency fork settings**. The dossier
   theme is a per-player setting in the main list.

To go back to the official system, reinstall it from Foundry's system browser. The fork's data lives in
actor/token flags and a `system.sanity` field; the official system ignores both.

## What's in it

| Area | At the table | Rules reference |
|---|---|---|
| Dossier theme | Manila / night-file look for sheets, chat, bucket and Foundry's UI. Per-player toggle. | |
| Wounds | Damage creates wounds by severity instead of subtracting HP. Chat buttons for stun, knockdown, impairment, limb trauma; bleeding, bandage, stabilize, surgery and recovery on the sheet. | [revised-fractional-health.md](revised-fractional-health.md) |
| SAN | SAN, Breaking Points, Bonds, disorders, adaptation. `/fc` takes a SAN loss; `/san 1/1d6 violence`; OtF `["Sees the body" SAN 0/1d4 violence]`. | |
| Defense prompts | A successful attack on a targeted token gives its owner Dodge/Parry/Block buttons; a failed defense leads to Roll damage → Apply. | |
| Turn flow | Maneuver picker at turn start, stun recovery rolls, HT-to-act at 0 FP. | |
| Rapid fire | Progressive Recoil: one roll per shot, cumulative Rcl penalty, bracing, aim on the first shot only. Fire dialog replaces the RoF prompt. | [shooting-rules.md](shooting-rules.md) |
| EUFC extras | Fractional Rcl per weapon, aim carry-over on single shots, Gunslinger. | [shooting-rules.md](shooting-rules.md) |
| Ammo | Rounds per gun (shared across its fire modes), empty guns can't fire, reload from carried magazines, change magazines, partial magazines kept. `/reload`, `/reload change`, `/ammo`. | |
| Readiness | Weapons are ready / holstered / slung / stowed / dropped. Unready weapon in combat → Ready maneuver or Fast-Draw. `/ready`, `/holster`. | |
| Hit locations | Every hit rolls on the Grand Unified Hit Locations chart, sub-tables included; special called shots in the hit-location picker. | [hit-locations.md](hit-locations.md) |
| Cover | GM token HUD button: cover presets or per body part, DR, HP, material. Covered hits strike the cover first. | [hit-locations.md](hit-locations.md) |
| Explosions | Explosive weapons: target a token or a point, scatter on a miss, templates, blast falloff, fragments, walls as cover, dive for cover, one GM card with Apply all. `/explode 4d cr ex [2d]`, `/explode 2lb c4`, `/explode flashbang`. | [explosions.md](explosions.md) |
| GCS import | Current GCS 5 files import cleanly; re-import keeps edits made in Foundry. | |
| Sheet sync | Fixes upstream bugs that left other players' sheets showing stale data. | |
| Campaign preset | Modern Agent: house rules on, TL8 default, field-agent NPC template. | |

## Status

Every feature has unit tests (`npm test`, about 2,100 tests) and the build is clean, but none of it
had run inside a live Foundry when this was written. Expect the first session to turn up UI glitches;
note the feature and what you clicked.

## Working on it

- `npm run build`, `npm test`, `npm run package` (writes `release/gurps-agency-<version>.zip`).
- Fork code lives in `module/agency/<feature>/`, `templates/agency/`, `styles/agency/`, `lang/agency/`.
  Edits to upstream files are marked `AGENCY` (`grep -rn AGENCY module lib templates`).
- Updating from upstream: `git fetch origin && git merge origin/main` on the `agency` branch. Conflicts
  should be limited to the `AGENCY`-marked lines and `system.json`.
