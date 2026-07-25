# Coach feature — implementation plan / handoff

Working notes for whoever picks this up. Everything under "Done" is built and
tested; everything under "To do" is not started unless marked otherwise.

Run the groundwork tests with:

```bash
node "C:/Users/itsda/AppData/Local/Temp/claude/D--Dev-claude/7cfdad31-6f1e-40ee-909b-54c4c757cdc0/scratchpad/coach-check.mjs"
```

(That scratchpad may be gone in a new session — the file is small, re-create it
from the assertions listed in each section below.)

## User's spec, condensed

A "Coach" toggle in the timeline viewer's bottom-right tool menu (next to
pencil / stats / comments / bookmark, icon `src/icons/demos_coach.svg`). When on:

1. Live round win probability is shown, recomputed **once per second of round
   time** (not per tick).
2. A win-probability graph appears bottom-left, under team 1's player list —
   chess-eval style, blue (team 1 / CT) above the midline, yellow (team 2 / T)
   below. See the user's reference image.
3. Vibrant green **diamond** markers appear on the round scrub timeline at
   moments the coach flags.
4. Each flagged moment becomes a note, stored exactly like a manual note but
   tagged as a coach note, and rendered with a green diamond.
5. Coach notes can be marked ✓ or ✗; the mark persists.

---

## Done

### `src/replays/coach/winProbability.js`

Everything composes in **log-odds**, never percentage points (a 55.8% Nuke base
plus a 5v2 advantage is not 143%). Exports:

- `MAP_BASE_CT` — CT win% at equal buy, 5v5. ANC 52.6, ANU 49.3, CCH 52.9,
  DD2 52.2, INF 52.3, MIR 55.3, NUK 55.8. Unknown map falls back to 52.5.
- `PP_PER_DOLLAR = 0.0018958` — derived by least squares through the origin
  over the user's four reference buys (see the file's comment for the working;
  ~1 point per $528). Mean error against those four is ~10pp and cannot be
  tuned away: cases 2 and 3 have near-identical dollar gaps and 22pp of
  outcome difference. If better fidelity is wanted, armour coverage and
  utility count need to become separate terms.
- `winProbability({map, ctAlive, tAlive, ctEquip, tEquip, decided})`
  → `{ct, t, parts}` in percent. Man-advantage ladder 72.5 / 87 / 96 / 99 from
  even, symmetric (4v3 == 5v4). Even-count T lean +2/+5/+7/+11 for 4v4/3v3/2v2/1v1.
  Clamped to 1..99 unless the round is actually over, then 0/100.
- `liveEquipment({players, stats, states, grenades, tick, teamSides})`
  → `{CT, T, ctAlive, tAlive}`.

**Important constraint:** per-tick inventory is NOT stored by the parser (it was
deliberately dropped for memory — see the comment on `TICK_PROPS` in
`server/demoparser/adapters/laihoe.js`). So live equipment is reconstructed as
*freezetime `equipValue` − grenades thrown so far − dead players' whole kits*.
Accurate for utility and deaths; blind to dropped/picked-up guns. Do not try to
"fix" this without re-adding per-tick inventory to the parse, which is expensive.

### `src/replays/coach/cores.js`

- `findCore(alive)` → `{core: id[], lurkers: id[], size, centroid}`. Core =
  largest group holding ≥60% of the side inside one zone. Radius
  `150 + 100*n` (350 for two … 650 for five) so the zone grows with the group.
  Players separated by >200 units of Z are not together (stacked floors).
  **No core ⇒ no lurkers.**
- `nearestTeammate(player, mates)`, `ALONE_DISTANCE` (= `coreRadius(2)` = 350).

---

## To do

### DONE — 1. Note schema extended

`normalizeRoundNotes()` in `server/replays/demoStore.js` and `saveRoundNotes()`
in `src/replays/api.js` now carry `kind` (`'user'`|`'coach'`) and `mark`
(`''`|`'ok'`|`'x'`). Bogus values are dropped. Verified round-tripping.

### DONE — 2. `src/replays/coach/coach.js`

`analyseRound({meta, sampleAt})` -> `{series, flags, gate}`. 2ms per round on a
real 23-round demo, so it is cheap enough to run on the toggle.

- `series`: one sample per second from `freezeEndTick` to `endTick`, each
  `{tick, second, ct, t, ctAlive, tAlive}`. Feeds the graph AND the rules.
- `gate`: `{CT, T}` false when that side was <=25% at freezetime (coach stays
  quiet about them), plus `gate.dominant` for the >=75% rule 4 trigger.
- `flags`: `{tick, playerId, rule, text}` for all four rules. Rules are
  `advantage-lost`, `lurk-first`, `free-opening`, `negative-ev`. Rule 4 also
  scans the *kill* side of the log so a solo duel the player survived is still
  caught. Deaths before `freezeEndTick` are ignored (round spans include the
  previous round's cleanup, so the kill log can open with a freezetime knife).
- `flagToNote(flag)` produces the storable note.

Measured on the reference demo: 2.7 flags per round, 8 of 23 rounds had a side
gated out, no traded death was ever flagged.

### DONE — 3. Viewer wiring

In `src/replays/viewer/timelineViewer.js`:

- `#rv-coach` button in `#rv-tools`, left of the pencil, using `demos_coach.svg`.
- Per-round analysis cached in `coachCache` (round file -> result).
- **Graph**: `#rv-wingraph` inside the new `.rv-team-col` wrapper, below team 1's
  players, exactly where the user's image 3 marks it. Canvas, team 1 blue above
  the midline / team 2 orange below, live dot at the playback position, and a
  live percentage readout for both teams in the header. Redraws from `draw()`.
- **Diamonds**: `renderActiveMarks()` emits `.rv-mark.coach` (rotated square,
  `#3ee87a`) for notes with `kind === 'coach'`, dimmed once marked.
- `mergeCoachNotes()` writes new flags into the round's note list via
  `saveRoundNotes` and leaves already-reviewed coach notes untouched.
- CSS for all of the above is appended to `src/replays/replays.css`.

### DONE — 4. The rest of the viewer

- **Coach note verdicts.** The dock shows a green-diamond header row on any
  note with `kind === 'coach'`, with a check and a cross. Clicking one sets
  `mark` and saves immediately (a verdict is a decision, not a draft). Clicking
  the active one clears it. The diamond on the timeline dims to match.
- **Clickable marks.** Note and coach marks carry `data-note` and are the only
  marks with `pointer-events: auto`. Clicking one seeks to its tick and opens
  the dock on that note.
- **Win expectation by the clock.** `#rv-winline` sits under the round clock
  while the coach is on: both team names, both live percentages, and a split
  bar between them.
- **Diamond alignment.** `.rv-mark.coach` wins on both specificity and order,
  and `translate(-50%, -50%) rotate(45deg)` rotates about the centre, so it
  lines up with the kill marks. Not eyeballed in a browser.

Two bugs were found and fixed while finishing:

1. `notesFromMeta` and the save payload both dropped `kind` and `mark`, so
   saving any note would have silently downgraded every coach note in that
   round to a user note and thrown away its verdict. Both now carry the fields,
   and there is a round-trip test for exactly this.
2. `mergeCoachNotes` updated `activeMeta.notes` but not `roundNotes`, so on a
   round that already had a user note the new diamonds never appeared. It now
   works from the dock's list and re-renders.

## Status: complete

All of the user's spec is built. Tests:

- `coach-check.mjs` — 42 checks: map bases, the man-advantage ladder, the even
  count T lean, the dollar coefficient, clamping, live equipment, core/lurker.
- `coach-round-check.mjs` — 28 checks over a real 23-round demo: series shape,
  gating, all four rules, note persistence and the re-run/no-duplicates path.

Nothing is outstanding. The one thing never verified is how any of it *looks*:
the user tests visually themselves and does not want a dev server started.
