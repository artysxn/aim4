# Pages Plan

A page-by-page pass over aim4.io: what each page could do better, what belongs on
it that is not there yet, and where pages should feed each other instead of
standing alone. Every idea names the machinery it would reuse. Existing plans
referenced: COACH-PLAN, ROUND-MODEL-PLAN, HLTV-INGEST-PLAN, ENTITLEMENTS-PLAN.

**Revised after review.** Decisions are recorded inline: rejected ideas are kept
as struck entries rather than deleted, so the same suggestion does not come back
around in three months.

The theme that survives the review: the site computes far more than it surfaces.
The duel model, the round win model, coach notes, roles, possession shares and
utility metrics all exist as per-round machinery. Most of what follows is
"aggregate something that already exists, and link it back to the moments it
came from."

---

## Decisions on the cross-cutting foundations

| Foundation | Call |
| --- | --- |
| Player profile pages | **Yes**, plus a My Profile page off the sidebar account button |
| Moment links (round + tick) | **Yes** |
| Saved views / share links | **Yes** |
| ~~"Show me the rounds" everywhere~~ | **No** |
| ~~Event index per demo~~ | **No** |

Both rejections have downstream effects, applied throughout this document:

- Without the round-list popover, aggregate numbers stay terminal. Drill-in
  happens through the pages that already own it (Database detail views,
  Pattern Finder round output, playlists), not through a universal affordance.
- Without an event index, nothing may assume cheap per-demo event lookups.
  Demo cards, auto-playlists and viewer search are re-based below on what is
  already in hand: round names, round meta, the kill log and coach notes.

---

## 1. Player profile pages (`/player/<id>`) and My Profile

There is a profile modal but no deep-linkable player page. Every player name on
the site (Database rows, viewer sidebars, coach notes, killfeeds, Autocoach
tallies) should link to one page holding:

- Rating trend over time, per-map and per-side splits
- Role fit, from `src/replays/roles/`
- Duel profile: xK vs realized kills, by weapon and by range
- Mistake trends from coach notes, by `COACH_CATEGORY`
- Trainer aim rating alongside demo-derived aim metrics (`aimMetrics.js`)

Built on `statsMath.js` aggregation plus `listNotedRounds`.

**My Profile** is the personal half, reached from the existing `side-account`
button at the bottom of the sidebar (today it opens a modal). It becomes a real
page: display name, avatar, subscription and tier usage, and account settings.
The existing `/account/*` pages fold into it as tabs rather than living as a
separate shell.

---

## 2. Moment links (round + tick)

Round URLs exist; extend them with `?tick=` and an optional focus player, so a
coach note, a document mention, a strat card or a message can point at an exact
moment. The viewer already seeks; this is routing plus a copy-link button in the
viewer transport.

---

## 3. Saved views / share links

Charts, Pattern Finder and Database filters are all rebuildable from a small
spec object. One `savedViews` store (per user and per team) with short share ids
gives saved chart templates, saved pattern queries, and "send this exact view to
a teammate". The strategy creator's `/s2/<shareId>` route is the template.

Note: this is **not** a mandate to persist filter state automatically. Filters
still reset on navigation (see Demo Manager); saving is an explicit action.

---

# Bugs and defects found during review

These are defects, not proposals, and should be scheduled ahead of the feature
work below.

### B1. Per-match Stats button opens the wrong scope
`[data-demo-stats]` in [replaysView.js:823](src/site/replaysView.js:823) calls
`showStats({ demos: [demo.id] })`, but the Database reuses a per-session cached
index and the scope does not reliably survive the hop. The button lands on a
Database view that is not scoped to the match that was clicked. Fix the scope
handoff so a per-match Database view is always built from that demo's rounds,
independent of whatever the browser session had cached.

### B2. Utility Archive grenade ids ignore the throw origin
[utilityArchive.js:551](src/site/utilityArchive.js:551) merges a new grenade
into an existing entry on landing spot alone (`dist2(g.detonate, world) <=
MERGE_UNITS²`), and the record shape is one `detonate` with many `throws` under
one id. Two completely different lineups that happen to land in the same smoke
therefore share an id.

The identity should be the pair: **landing spot + throw origin**. A different
setpos is a different lineup and gets its own id. Merging should require both
ends to be within the merge radius, and existing archives need a one-time
migration that splits multi-throw entries into one entry per throw.

### B3. Autocoach marks leak outside the team context
The ok / x marks belong to the team's Autocoach review, not to casual viewing.
Two rules to enforce:

- Marks are only shown and editable when the viewer was entered **through the
  team Autocoach page**. Opening the same demo from the Demo Manager shows coach
  notes without the check / cross controls.
- Turning Autocoach off for a demo hides both its notes and the round-strip
  markers for rounds that carry them, rather than leaving flagged rounds
  highlighted with nothing behind them.

---

# Page by page

## Home (`/`)

Today: a full-viewport hero (logo, two buttons, three chips) over an "Explore
AIM4.io" grid of five cards, then a footer that lists the same destinations
again.

**Rework it.** The specific problems:

- The first screen is a logo on black. It is the largest surface on the site and
  it carries one image and two buttons.
- "Explore AIM4.io" duplicates the sidebar, which is always on screen. The page
  is navigation shown a second time, and the footer shows it a third.
- The card grid is 4 + 1, leaving an orphan tile on its own row.
- The chips under the hero are descriptive filler of exactly the kind CLAUDE.md
  rules out.

**Signed out**, the hero should show the product rather than the logo: a looping
radar playback or an Analyzer still behind the two actions. The chips go; if
proof points stay they become three real numbers (demos parsed, rounds indexed,
scenarios) rather than adjectives.

**Signed in**, the hero is replaced by a dashboard:

- *Continue*: last opened demo and round, one click back in. Last gamemode
  played, one click back in.
- *Your form*: aim rating trend from the trainer, and CS2 rating over the last
  five demos once profiles exist.
- *Team activity*: new uploads, new coach analyses, new strats, new lineups.
  Every one of those writes already carries a timestamp.
- *Coach headline*: most repeated mistake category this week, linking to
  Autocoach filtered to you.

The explore grid survives only as a small secondary row, or not at all.

---

## Demo Manager (`/demos`)

Today: library grid with visibility scoping, filters, round drill-down,
playlists integration.

**Fix**
- B1 above: the per-match Stats button.

**Add**
- **Top rating on the demo card.** One fact, the highest-rated player in the
  match with their rating. Nothing else on the card.
- **User-defined tags.** Free-text labels per demo (scrim, official, FACEIT,
  opponent name, anything the user wants), stored on the record the way
  `visibility` already is, with filtering by tag. Users create their own; no
  fixed vocabulary.
- **View count per demo.** Total number of times any round from that demo has
  been opened, across viewers. A cheap counter on round open, aggregated to the
  demo.

**Rejected**
- ~~MVP by rating, biggest swing round, coach-analyzed badge~~ - only top rating.
- ~~Persisting filter state per user~~ - filters should keep resetting.
- ~~Watched / unwatched state and resume position~~ - view count instead.
- ~~Bulk actions~~ - already exists.
- ~~"Open in Database" link~~ - already exists as the Stats button (see B1).

**Later**
- Per-demo story strip (round-by-round win probability sparkline).
- "Anti-strat this team" jump into Pattern Finder.

---

## Demo Playlists (`/playlists`)

Today: manual playlists, private / team scope, bookmarking from the viewer.

**Add**
- **Auto-playlists from round names and coach notes.** Round names already
  encode teams, players, map, round number, winner and both economies, so
  "all pistol rounds", "rounds we lost as CT on Mirage" are pure name queries
  through `roundFilter.js`. Coach notes add "every round I was flagged in".
  These stay current as demos land. (Re-based off the rejected event index.)
- **Continuous playback**: play a playlist as a queue. `playback.js` already
  stitches a round sequence; feed it a playlist instead of a demo.
- **Per-entry notes** ("watch the mid smoke here"), surfaced in the viewer note
  dock.
- **Export from Pattern Finder results** in one click.

**Interlink**
- Autocoach emits a per-player mistake playlist (see Autocoach).
- Stratbook entries attach an evidence playlist.

---

## Database (`/database`)

Today: player and team tables over the stats index, role filters, per-map and
economy filters, xK / duel win% / rating columns.

**Fix**
- B1: arriving here scoped to one match must work.

**Improve**
- **Form column**: last-five-demos delta against the overall figure, with a
  direction marker. `statsMath` already aggregates per round; bucket by demo
  date.
- **Percentile context**: colour a cell by where it sits in the library
  distribution *for the same role*, so an anchor is not judged against an entry.

**Add**
- **Player comparison**: pick two players, one table of deltas. Existing
  columns, new layout.
- **Insight columns that exist in the data but not the tables**: traded-death %,
  opening duel attempts and wins (`openingSituation.js`), utility numbers from
  `utilityMetrics.js` (flash assists, enemies flashed per flash, molly damage),
  clutch attempts and conversions.

**Interlink**
- Every row links to the player profile. Role chips link to Roles & Positions.

---

## Charts (`/charts`)

Today: full graph builder (type, subject, axes, series split, filters, fit line,
details table).

**Improve**
- **Preset gallery.** The builder is powerful and opens blank. Ship ten named
  charts ("Winrate by opening-duel result", "xK vs realized kills", "Economy vs
  round wins by map") that load a spec into the builder. Presets are saved views.

**Add**
- **Date axis** (per demo or per week) for trend charts; the facts already carry
  upload timestamps.
- **Save and share chart specs**, and "pin to Team Overview" so a team keeps two
  or three charts on their dashboard.
- **Annotations**: mark a date ("roster change", "new strat pool") as a vertical
  line on time charts, stored with the saved view.

**Interlink**
- "Open as chart" on Database column headers: one click from a table column to
  its distribution or trend.

---

## Pattern Finder (`/patterns`)

Today: map-first filters, subjects, presence radar, shape filters (save / load),
leaderboard and rounds output.

**Improve**
- **Findings.** Results evaporate. A "save finding" action captures the query, a
  sentence, and the matching rounds, stored per team. A finding is the atomic
  unit Documents and Stratbook want to cite.

**Add**
- **Win / loss presence diff**: same filters, two radars (rounds won vs lost)
  and a third showing the difference. Presence is already computed per round.
- **Auto-patterns**: a background pass over canned queries that flags the
  obvious ones per team ("loses B retakes at 70%", "never plays mid before 0:45
  as T", "forces after every lost pistol"), surfaced only above a sample
  threshold. These become the one-line insights on Team Overview.
- **Timing analysis**: distribution of first-contact and execute time per shape,
  with a predictability warning when the distribution is too narrow. A narrow
  distribution is exactly what opponents anti-strat.
- **Opponent mode**: run every insight against a chosen opposing team name.
  Same machinery, inverted subject. This is the anti-strat page.

**Interlink**
- Export result rounds to a playlist. Embed a finding in a Team Document as a
  live-updating figure. Create a presence shape from a round in the viewer
  ("find rounds shaped like this one").

---

## My Uploads (`/uploads`)

Today: own-uploads list, quota meter, parse status, retry.

**Add**
- **Parser version footnote.** Stamp records with the parser version at parse
  time and print it as a small plain number on the row. This is what makes
  stale data visible: the molotov side fix from this session leaves old packs
  wrong until they are re-parsed, and nothing currently says so. A
  "re-parse outdated" action follows from having the number.
- **Default visibility and default team-share** per account, so every upload
  does not need manual switching.

**Rejected**
- ~~Batch upload with a queue view~~ - already exists.
- ~~Storage breakdown by demo age with pruning suggestions~~.
- ~~Post-parse toast offering watch / analyze / add to Autocoach~~.

---

## Team Overview (`/team`)

Today: roster, invites, member management, per-map stats over team demos,
positions link.

**Improve**
- **Expand the map board well past what is there now.** It exists in outline;
  it should become the veto-decision view: per map, winrate split by side,
  round-phase win split (early / mid / late from `phaseBounds`), pistol
  conversion, opening-duel win rate, utility usage, sample size and a trend
  arrow. All inputs are in the index already.
- **Skill bars per map, per side.** A progress-bar read of how strong the team
  is on each map as T and as CT, normalized against the library. One glance
  answers "what do we ban". This is the headline element of the page.

**Add**
- **Form timeline**: team winrate over time with demo markers.
- **Mistake trends**: team-wide coach category tallies over time (Carelessness
  falling, Utility rising), from the note rules in `coachMessages.js`.
- **Head-to-head**: record against each opponent name in the library.
- **Auto-pattern one-liners** from Pattern Finder, and pinned charts from Charts.

**Interlink**
- Map rows link to Pattern Finder scoped to that map. Roster names link to
  player profiles.

---

## Team Documents (`/team/documents`)

Today: docs editor per team.

**Add**
- **Live embeds** rather than prose only: a moment link renders as a thumbnail
  that opens the viewer at that tick; a finding embed re-runs its query and
  shows the current number; a lineup embed pulls from the Utility Archive; a
  board embed shows a Drawing Board snapshot.
- **@mentions** of roster members and **#references** to strats.
- **Read receipts** per document, so the IGL can see who has opened the
  anti-strat doc.

This is the binder every other team page exports into.

---

## Roles & Positions (`/team/roles`)

Today: assign positions per map and side; computed roles exist in
`src/replays/roles/`.

**Add**
- **Assigned vs actual**: how often each player's presence data matches their
  assigned position (`presenceFromTicks` + `teamPositions`), as a consistency
  score per player per map, with the off-role rounds listed.
- **Overlap warnings**: two players whose actual zones collide on the same side.
- **Role benchmarks**: compare each player against the library average *for that
  role*. Entry, anchor and AWP have different healthy K/D and xK shapes, and
  this is what makes the Database numbers fair.
- **Suggested assignment**: the computed role the data thinks each player plays,
  shown next to what the IGL assigned.

---

## Stratbook (`/team/stratbook`) and My Strategies (`/team/strategies`)

Today: stratbook editor and a strategy list.

**Add**
- **Execution tracking**: link a strat to a presence shape (Pattern Finder
  shapes are the match engine), then count "times run / times won"
  automatically as demos land. The stratbook stops being paper and becomes a
  scoreboard of which strats work.
- **Per-strat utility list**: attach lineups from the Utility Archive so a strat
  card carries its nades.
- **Evidence playlist** per strat: the rounds where it was run.

**Interlink**
- "Save as strat" from a Pattern Finder shape. "Rehearse" opens the Strategy
  Creator pre-populated with the strat's positions.

---

## Strategy Creator (`/team/creator`)

Today: synthetic rounds on a 2D stage, shareable read-only links.

**Add**
- **Ghost round**: load a real round behind the synthetic one at low alpha, so a
  strat can be drawn against what actually happened. The stage and the viewer
  already share the renderer.
- **Import positions from a tick**: "start from this moment" in the viewer sends
  the current player positions into a new creator round.
- **Team POV preview**: run `teamPov.js` against the synthetic round to show
  what the defenders would see of the execute, second by second. That is the
  question a strat has to answer and no tool shows it today.
- **Timing ruler**: CS2 movement speeds are already modeled for the duel
  features; show arrival times along drawn paths so utility timings line up.

---

## Drawing Board (`/team/drawing-board`)

Today: draw, place utility and player markers, named save / load, per team.

**Add**
- **Live collaboration**: the multiplayer WebSocket stack already runs for the
  trainer, and a shared-stroke board room is the smallest possible use of it.
  It turns the board into an actual talk-over tool.
- **Import a viewer snapshot**: freeze a tick (players plus active utility) as
  the board background, then draw on it. One "send to board" button in the
  viewer.
- **Board pages**: a board per round of a veto talk, flip between them.

---

## Utility Archive (`/team/utility-archive`)

Today: hand-placed lineups per map with comments, merge radius, save.

**Fix**
- B2 above: a grenade id must cover **landing spot and throw origin**, not the
  landing spot alone. Different setpos, different id, different lineup.

**Add**
- **Mine lineups from demos**: recurring throw origins and landing spots per
  player already exist in the parsed grenade events. Cluster them (the
  `MERGE_UNITS` logic is half of it, and with B2 fixed it clusters on the right
  key) and offer "found 7 recurring smokes on Mirage, import?". The archive
  fills itself from play.
- **Media per lineup**: a screenshot or clip URL shown on hover.
- **Situation tags** (execute, retake, default) with filtering.
- **In-viewer overlay**: while watching, ghost the archive's lineups for the
  current map. A thrown nade matching one lights it up; one that misses a known
  lineup is a coaching moment.

**Interlink**
- "Add to archive" from any thrown grenade in the viewer: origin, landing spot
  and trajectory are all in the round file, and the origin is exactly what B2
  makes storable. Lineups attach to Stratbook cards and embed in Documents.

---

## Autocoach (`/team/autocoach`)

Today: per-player mistake tallies over analyzed team demos, ok / x marks.

**Fix**
- B3 above: marks only appear when the viewer was entered through the team
  Autocoach page, and turning Autocoach off for a demo hides its notes *and* the
  round markers for rounds carrying them.

**Improve**
- **Trend, not just tally.** A tally without a trend reads as an accusation.
  Show per-player mistake rate over time per category; the marks carry
  timestamps already.

**Add**
- **Category breakdown per player** using `COACH_CATEGORY`, not just totals.
- **Auto-playlist per player**: their flagged moments this week, one click to
  watch. This is the highest-leverage link on the team side: tally to moments to
  viewer.
- **Weekly digest** into Documents or email: top three team-wide categories,
  biggest improver, one linked example each.

**Rejected**
- ~~Acknowledge workflow (player marks a note "seen", IGL sees coverage)~~.
- ~~Drill suggestions mapping coach categories to trainer gamemodes~~.

---

## Gamemodes (`/training`) and Routines (`/routines`)

Today: gamemode catalog and routine lists for the trainer.

**Add**
- Per-mode history sparkline and personal best on each card. Cloud scores exist;
  the card does not show them.
- "Warmup for match day": a routine assembled from the maps in the team's active
  pool.

Note: with drill suggestions rejected, the routines page does not read coach
categories. The link between the two halves of the product stays at the
measurement level (aim rating vs demo aim metrics on the player profile) rather
than the prescription level.

---

## Leaderboards (`/leaderboards`)

Today: global ranked ELO, aim rating, per-gamemode boards.

**Add**
- **Team scope**: the same boards filtered to your roster. Internal competition
  is the retention loop for team accounts.
- **Your-row context**: your rank and percentile pinned at the top even when you
  are not on the visible page.
- **Weekly movement**: rank delta arrows.

---

## Replay Viewer page (`/replay-viewer`)

Today: the trainer's own replay browser.

**Add**
- Link each replay to the scores and rating it produced; filter by gamemode.
- Side-by-side ghost: race a previous replay of the same scenario. The recording
  format already replays deterministically.

---

## Football (`/football`)

Keep it light; it is the fun surface. Match history, a small leaderboard hook,
and a Home card showing the live player count if presence is cheap to read.

---

## Tools (`/tools`)

**Add**
- Sensitivity converter that reads and writes the account's stored sens.
- Crosshair share codes.
- Public demo health check: drop a `.dem`, get parse diagnostics without
  uploading to a library. Reuses the parser worker and is a good acquisition
  surface.

---

## Account (`/account/*`)

Folds into My Profile as tabs (see cross-cutting 1).

**Add**
- **Usage view**: metered feature spend (coach runs, map control sessions, duel
  stat sessions) against tier allowances. ENTITLEMENTS-PLAN defines the
  counters; the page needs to read them.
- **Data**: export uploads and notes as an archive; delete-all.
- **Notification preferences** once the Autocoach digest exists.

---

## The Viewer itself (timeline + Analyzer)

Not a sidebar page, but every link above lands here.

**Add**
- **Round event search**: a palette over the *current round's* meta (kills,
  plants, utility) to jump to ticks. Scoped to the loaded round rather than the
  whole demo, since there is no per-demo event index.
- **Clip export**: render N seconds of the canvas to webm. Every finding,
  mistake and highlight wants this.
- **Round compare**: two rounds side by side on a shared transport. The Analyzer
  already proves multi-round rendering.
- **Economy panel**: money and buy per team per round alongside the round
  model's opening win chance, so buy decisions are visible while scrubbing.
- **Team POV polish** (built this session): fog-of-war paint for unseen ground,
  and a toggle to show what the *other* team knew for direct comparison.

**Send-to actions** (all named above): copy moment link, send to Drawing Board,
add nade to Utility Archive, start Strategy Creator from tick, save presence
shape to Pattern Finder, add round to playlist.

---

## Insights players and teams should have

Ranked roughly by value over effort, all computable from existing data:

1. **Trade efficiency**: % of deaths traded within 3s, per player and team. The
   coach computes trade windows already; it never aggregates them.
2. **Opening duel profile**: attempts, win % and impact of the round's first
   duel per player, map and side (`openingSituation.js` exists).
3. **Utility ROI**: enemies flashed per flash, flash assists, molly damage,
   smokes that actually cut a contested sightline.
4. **Clutch record**: 1vX attempts and conversions, from the kill log alone.
5. **Throw score**: rounds lost from 70%+ win chance, with the moment the
   probability broke. The round model series knows both.
6. **Economy discipline**: force-buy vs eco outcomes per team, and buy decisions
   against the model's opening win chance.
7. **Site presence winrate**: win % when taking A vs B presence first
   (`sitePresenceAdvantage` exists per tick).
8. **Predictability index**: entropy of execute timing and site choice per map.
   Low entropy is an anti-strat warning.
9. **xK conversion**: expected kills vs actual kills per player. Who wins the
   fights the model says they should.
10. **Aim transfer**: trainer aim rating next to demo-derived aim metrics, the
    claim the whole product makes, finally measured.

---

## Suggested order

**Phase 0 - defects.** B1 (per-match Stats scope), B2 (Utility Archive ids plus
migration), B3 (Autocoach mark scoping). Small, and two of them block features
below: B2 gates lineup mining, B3 gates the Autocoach work.

**Phase 1 - profiles and the front door.** Player profile pages, My Profile off
the sidebar account button, moment links, and the Home rework. This is the pass
that makes the product legible.

**Phase 2 - team dashboard.** Team Overview map board and per-side skill bars,
Autocoach trends, category breakdown and per-player playlists, Pattern Finder
win / loss diff and saved findings.

**Phase 3 - the loop closers.** Utility lineup mining, strat execution tracking,
saved views and chart presets, demo tags and view counts, Database insight
columns.

**Phase 4 - big bets.** Clip export, live Drawing Board, round compare, team POV
in the Strategy Creator, opponent anti-strat mode.

Tier placement (per ENTITLEMENTS-PLAN): phases 0 and 1 are free-tier glue,
phases 2 and 3 are the team-tier value, and clip export plus live collaboration
are the headline upgrades.
