# Coach mistakes: taxonomy and roadmap

Every mistake the coach can currently find, sorted into categories, plus the list of
detections worth adding now that the parser exposes shots, damage, grenade
trajectories, per-tick flash, and line-of-sight geometry. Written 2026-08-04.
Code lives in `src/replays/coach/`.

## 1. The categories

Five buckets, all on one axis: **the nature of the error**, not the game system it
happened in. A flash that blinds your own team is a coordination error, not a
"utility" error, because what went wrong is that you hurt a teammate.

| Category | What it means | The question it answers |
|---|---|---|
| **Carelessness** | The information was there and you did not use it. | "Why didn't you see that?" |
| **Mechanical error** | The decision was fine, your hands lost the fight. | "Why didn't you hit that?" |
| **Quality** | The decision itself was wrong for the situation. | "Why did you take that?" |
| **Coordination** | The team's shape, trades, or friendly fire were wrong. | "Why were you alone?" |
| **Timing** | Right action, wrong moment. | "Why did you go *then*?" |

Precedence when a death fits more than one: **Carelessness > Timing > Coordination >
Quality > Mechanical**. A player who was flanked while unaware is coached on the
awareness, not on the spray that followed.

## 2. What the coach finds today

Ten rules across four categories. **Mechanical error is empty** — the aim data exists
(`shared/aimMetrics.js` computes crosshair error, ready rate, over/underflicks) but
none of it is wired into a coach flag. That gap is the single biggest one in section 4.

### Carelessness

| Rule | Where | Trigger |
|---|---|---|
| `unaware-openness` | [coach.js:698](src/replays/coach/coach.js:698) | Victim's yaw was ≥30° (`UNAWARE_DEGREES`) off the killer at the tick before death. |
| `unchecked-position` | [coach.js:662](src/replays/coach/coach.js:662) | A connected stack of 3+ teammates (`UNCHECKED_GROUP`), and *every one* of them was >15° (`AIM_DEGREES`) off the angle the killer came from. Beats `unaware-openness` when both fire. |
| `utility-unawareness` | [coach.js:752](src/replays/coach/coach.js:752) | Died to an enemy standing within 150 units (`MOLLY_NEAR_UNITS`) of **your own** molotov, between 1s and 7s after it landed. |

### Timing

| Rule | Where | Trigger |
|---|---|---|
| `lurk-first` | [coach.js:549](src/replays/coach/coach.js:549) | Even headcount, victim was a lurker (outside the core per `cores.js`), and the core had not been in a single fight yet. The lurk happened before the round had any information to lurk off. |

### Coordination

| Rule | Where | Trigger |
|---|---|---|
| `advantage-lost` | [coach.js:531](src/replays/coach/coach.js:531) | Died with no trade while up a man, and the side had already been up a man 3s earlier (`HOLD_SECONDS`). Copy differs for a core death vs a solo death. |
| `solo-even` | [coach.js:614](src/replays/coach/coach.js:614) | Died alone (no teammate within `ALONE_DISTANCE`), no trade, in a 3v3 or 4v4 that had held for 3s. Fires even when HP makes the live win% look bad. |
| `multikill-refrag` | [coach.js:859](src/replays/coach/coach.js:859) | One lone enemy killed 2+ stacked teammates inside a 4s chain (`MULTIKILL_GAP_SECONDS`) and was the **only** player to deal damage to them in a ±4s window. Needs `events.damage`; requires ≥2500 average equip unless it is pistol vs pistol. |
| `a-understack` / `b-understack` | [siteExecute.js:166](src/replays/coach/siteExecute.js:166) | T core sat on a bombsite for 3s in mid or late round and the CT count on that site was at or below the per-map default (`CT_SITE_DEFAULTS`). Fires at most once per site. |

### Quality

| Rule | Where | Trigger |
|---|---|---|
| `negative-ev` (died) | [coach.js:590](src/replays/coach/coach.js:590) | Took a solo duel and died while the **live** win chance was ≥75% (`DOMINANT`). Deliberately gated on the win% at the fight, not at freezetime. |
| `negative-ev` (survived) | [coach.js:891](src/replays/coach/coach.js:891) | Same fight, but they won it. Picked up from the kill side of the log because a won duel leaves no death behind. |
| `free-opening` | [coach.js:565](src/replays/coach/coach.js:565) | The round's first death, with no other kill anywhere within 3s of it. Nothing traded, nothing gained. |

### Shared gates (every rule above inherits these)

Worth listing once because most tuning arguments end up being about these, not about
the rules themselves.

- **Buy gate** — if the side opened freezetime below 25% win chance (`HOPELESS`), the
  coach says nothing to that side all round. The round was lost on the buy.
- **Coach window** — 1s after freezetime ends through 1s before `endTick`, and hard-stopped
  at the defuse tick.
- **Frag grace** — a kill in the previous 5s (`FRAG_GRACE_SECONDS`) suppresses the death.
  You were in a fight, not making a free mistake.
- **Trade window** — a teammate's kill within 3s (`TRADE_SECONDS`) after the death
  answers it, and most rules go quiet.
- **Last alive** — a 1vX is never coached. There is nobody left to stack with.
- **Win-chance line** — rules read `ct`/`t` from the trained round model, never the
  duel-lookahead overlay (`ctDuel`). A probability that has already priced the death in
  would report that every death cost nothing.

## 3. Not carried forward

- `round-decided` ([coach.js:927](src/replays/coach/coach.js:927), `roundDecided.js`) —
  marks the tick win% crossed 88% and never came back on an equal buy. **Being removed.**
  Not a mistake, and it is the one flag pinned to a side rather than a player.
- `a-overstack` / `b-overstack` ([siteExecute.js:154](src/replays/coach/siteExecute.js:154)) —
  praise for rotating correctly, not a mistake. Keep it, but it does not belong in the
  taxonomy above. If the panel groups by category it needs a "good read" lane of its own.

---

## 4. Suggested new detections

Feasibility is marked per item:

- **(disk)** — every input is already in the round file or the tick buffer. Stats-index
  rebuild at worst, no reparse.
- **(geom)** — on disk, but needs new work against `duels/sightRay.js`, `duels/visionState.js`,
  or the zone network.
- **(parse)** — needs a field the adapter does not currently emit.

The data that makes most of this newly possible: `events.shots` (every shot with x/y/z/yaw/pitch),
`events.damage` (attacker/victim/hp/weapon, so friendly fire is attributable),
`events.grenades` (throw origin, detonation point, full trajectory), the per-tick `flash`
byte in 20ths of a second, kill flags (`headshot`, `throughSmoke`, `attackerBlind`,
`noscope`, `penetrated`), and the LOS/FOV machinery built for the duel model.

### Carelessness

- **Died mid-reload with an enemy in LOS** — death while `reloadTracker` says reloading
  and the killer had an unbroken sight line for ≥0.5s before it. Reloading is a decision
  about safety, and this is the version of it that costs a round. **(geom)**
- **Ignored a visible enemy** — the killer was inside your 53° half-FOV with clear LOS for
  ≥0.75s before the kill, and you fired no shot and corrected your yaw by <10° in that
  window. Distinct from `unaware-openness`: there the enemy was off-screen, here they were
  on it. **(geom)**
- **Walked into burning fire** — took ≥15 HP of `inferno`/`molotov` damage entering a pool
  that had been down for >1.5s. The fire was drawn on the radar before you crossed it. **(disk)**
- **Died holding utility** — died with grenades still in the loadout that were never thrown.
  Compare `stats[id].loadout` at freezetime against `events.grenades` for that player.
  Gate it on the round having reached mid/late phase. **(disk)**
- **Bomb carrier took the opening duel** — the player with `FLAG_HAS_BOMB` was the first
  death of the round. Frame it as the bomb ending up wherever they fell. **(disk)**
- **Defused or planted under a live angle** — started `FLAG_DEFUSING`/`FLAG_PLANTING` while
  a living enemy had LOS to the bomb, with no teammate covering that angle. **(geom)**
- **Died scoped in a close fight** — died with `FLAG_SCOPED` set at <500 units. The scope
  was the mistake, not the aim. **(disk)**

### Mechanical error

The empty category. Everything here is derivable from `events.shots` plus the tick buffer,
and `aimMetrics.classifyFlickMiss` already exists.

- **Lost a duel you entered ahead** — died to an enemy whose crosshair error toward you was
  ≥30° when the engagement opened while yours was ≤15°. You won the information and lost the
  fight anyway. This is the flagship mechanical flag. **(geom)**
- **Overflick / underflick on the fatal engagement** — run `classifyFlickMiss` over the shots
  fired in the 1s before death and report the pattern. Overflicking under pressure and
  underflicking are different problems with different fixes. **(disk)**
- **Fired while running** — shot tick where `speedAt` exceeds ~110 units/s (well past walk),
  in an engagement that was then lost. First-bullet accuracy thrown away for nothing. **(disk)**
- **Counter-strafe failure** — fired within ~0.1s of dropping below run speed rather than
  after the stop settled. Narrower and more actionable than "fired while running". **(disk)**
- **Sprayed past control** — ≥8 consecutive shots in one burst with no damage event landing
  after shot 5. Uses `cycleSeconds` from the weapon table to segment bursts. **(disk)**
- **Shot into smoke and lost the fight** — `shotsInSmoke` is already counted; promote it to a
  flag when the shots preceded a death and no damage landed. Gave away position for free. **(geom)**
- **Lost to a blind enemy** — died to a killer whose per-tick `flash` was >1.0s. They could not
  see you. Reads directly off the tick buffer plus the kill's `attackerBlind` flag inverted
  onto the victim's side. **(disk)**
- **Never pulled the trigger** — died with the killer inside your cone for ≥0.4s and zero
  shots fired in that window. The freeze, as distinct from the miss. **(geom)**
- **Airborne on contact** — the engagement opened with `FLAG_AIRBORNE` set. **(disk)**

### Quality

- **Repeeked the angle that just killed a teammate** — took the same sight line within 6s of a
  teammate dying to it, no util thrown in between, and died. Same angle means within ~200 units
  of where the teammate fell with LOS to the same killer position. **(geom)**
- **Rifle peeked an AWP dry** — opened a duel at >1800 units against a scoped AWP with no smoke
  or flash detonating in the prior 3s. **(geom)**
- **Fought a lost round instead of saving** — took a duel with the live win chance below ~12%
  while holding a rifle, and died with it. Costs the next round too, so the note should say so. **(disk)**
- **Retook with nothing** — post-plant CT retake started with no defuse kit on any living player
  and zero utility thrown in the 10s before contact. **(disk)**
- **Executed with no smokes** — the T core reached a bombsite (reuse `siteExecute`'s core-at-site
  detection) with zero smokes detonated in the prior 8s. **(disk)**
- **Dumped utility before contact** — a player threw their entire grenade loadout before the first
  enemy contact of the round, then the site hit came with none left. **(disk)**
- **Wasted fire or HE** — a molotov or HE whose damage total was 0 and which had no enemy within
  its radius at any point in its life. Separates "missed" from "never had a target". **(disk)**
- **Bad plant position** — bomb planted at a spot with no living teammate holding LOS to it, when
  a different plant spot on the same site did have cover. Needs plant-spot zones per map. **(geom)**

### Coordination

- **Spacing** *(your example)* — a player positioned beyond `ALONE_DISTANCE` from the nearest
  teammate but within roughly 2× it, where that gap produced 2+ untradeable duels in the same
  round. The point is "close enough that you thought you were together", which is why the upper
  bound matters. **(disk)**
- **Missed flashbang** *(your example)* — a flash where total teammate blind seconds exceed total
  enemy blind seconds, with at least one teammate over the 0.5s floor. `blindFromFlash` in
  [utilityMetrics.js:98](src/replays/shared/utilityMetrics.js:98) already measures the rise in each
  player's blind timer across detonation and deliberately skips teammates; measuring both sides is
  a small change to that function. **(disk)**
- **Ate a team flash** *(your example)* — the receiving-end flag. Blinded >1.0s by a teammate's
  flashbang. Worth flagging separately from the throw because the fix is different: the thrower
  needs a better lineup, the victim needs to turn. Escalate when the player died within 2s of it. **(disk)**
- **Team utility damage** *(your example)* — lost >20 HP to grenades or fire thrown by your own
  side, summed per round. `events.damage` carries attacker and victim ids, so same-side attribution
  is direct. Flag both the thrower and the victim, with different copy. **(disk)**
- **Trade failure** — a teammate died within trade range of you, you had clear LOS to the killer for
  ≥1s afterward, and you fired nothing. The complement to `advantage-lost`, which only ever blames
  the player who died. **(geom)**
- **Stacked into one grenade** — a single HE or molotov dealt damage to 2+ teammates. Group the
  damage events by grenade weapon and tick proximity. **(disk)**
- **Simultaneous reload** — 2+ teammates in the same engagement reloading in overlapping windows.
  `reloadTracker` already has the state. **(disk)**
- **Entry with no follow** — a player crossed a choke into enemy-held space and no teammate crossed
  the same threshold within 3s. Needs choke zones, which the network partly has. **(geom)**
- **Bomb left uncovered** — post-plant, no living T has LOS to the bomb for a continuous 5s. **(geom)**

### Timing

- **Late off a flash** *(your example)* — took a duel against an enemy who was blind at the moment
  the flash popped but had fully recovered by the time you made contact. The per-tick `flash` byte
  gives the exact recovery tick, so this is a clean subtraction: enemy `flash` hit 0 at tick X, your
  first shot or first LOS was at tick X+N. Report N. **(disk)**
- **Early off a flash** — the mirror case: you crossed before your own flash detonated, so the enemy
  was never blind when you arrived. **(disk)**
- **Slow rotation** — a CT started moving toward the other site only after `plantTick`. Measure from
  the first tick the T core's zone commitment was readable, which the map-control shares in
  `mapControlAdvantage.js` already produce. **(geom)**
- **Late defuse start** — started defusing with less time on the bomb than the defuse needs (10s with
  kit, 5s without), with no teammate alive to cover. **(disk)**
- **Repeeked too fast** — peeked the same angle within 2s of losing a duel there, before the enemy had
  any reason to have moved off it. Pairs with the Quality version, which is about the angle; this one
  is about the clock. **(geom)**
- **Time mismanagement** — T side holding under 20% map control with under 40s left and no plant.
  The round was lost to the clock before any fight decided it. **(geom)**

## 5. Suggested build order

1. **Utility friendly-fire trio** (missed flash, ate a team flash, team util damage). All three are
   pure `events.damage` + `blindFromFlash` work, all three are your examples, and none of them need
   geometry. Highest value per hour by a wide margin.
2. **Mechanical error, first three** (lost-ahead duel, fired while running, over/underflick). Fills the
   empty category and reuses `aimMetrics` wholesale.
3. **Spacing and trade failure.** Both are the natural completion of the existing coordination rules,
   which currently only ever blame the player who died.
4. **Timing off flashes.** Cheap once the flash-attribution work in step 1 exists.
5. Everything marked **(geom)**, ordered by whichever zone work lands first.
