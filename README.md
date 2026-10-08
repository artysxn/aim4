# AIM4.io

A Counter-Strike 2 analysis platform and browser aim trainer in one app.

Upload a `.dem` and the backend parses it into rounds you can watch, filter,
measure and scout. On top of that sit a stats database, a pattern finder, an
automatic antistrat report writer, a team workspace with a stratbook and a 2D
strategy creator, and a full aim trainer with cloud leaderboards.

- **Part 1 — [Using the site](#part-1-using-the-site)**: every feature and how to work it.
- **Part 2 — [Running the code](#part-2-running-the-code)**: setup, layout, deployment.

---

# Part 1: Using the site

## The map

| Page | Path | What it is |
| --- | --- | --- |
| Home | `/` | Landing page |
| Demo Manager | `/demos` | The shared demo library, round filters, the viewer |
| Demo Playlists | `/playlists` | Saved sets of rounds |
| Database | `/database` | Player and team statistics over the whole library |
| Charts | `/charts` | Plotted metrics |
| Pattern Finder | `/patterns` | Map selections, subject filters, Teams antistrat |
| My Uploads | `/uploads` | Your own demos, visibility and tags |
| Team | `/team` | Team overview: map winrates, statistics, round types |
| Documents | `/team/documents` | Shared rich-text docs, where antistrat reports land |
| Roles & Positions | `/team/roles` | Who plays what, per map, per side |
| Stratbook Editor | `/team/stratbook` | Strategies per map and side |
| My Strategies | `/team/strategies` | Your own slice of the stratbook |
| Drawing Board | `/team/drawing-board` | Freehand map drawing |
| Utility Archive | `/team/utility-archive` | Lineups your team keeps |
| Team Replays | `/team/replays` | Autocoach review queue |
| 2D Strategy Creator | `/team/creator` | Animated 2D strat builder |
| Gamemodes | `/training` | Aim trainer scenario cards |
| Trainer | `/train` | The 3D trainer itself |
| Leaderboards | `/leaderboards` | Cloud scores per scenario |
| Replay Viewer | `/replay-viewer` | Playback of your own trainer runs |
| Routines | `/routines` | Custom practice sets (in progress) |
| Football | `/football` | Multiplayer football side game |
| Tools | `/tools` | Level Editor |
| My Profile | `/account` | Profile, subscription, teams, data, security |
| Admin | `/admin` | Site administration (admins only) |

## Plans

Seven tiers on two ladders: **Free**, then **Solo Lite / Solo Premium / Solo Elite**
and **Team Tier 3 / Team Tier 2 / Team Tier 1**. A team plan is the solo plan of
the same band plus the team toolkit. Team Tier 3 creates 1 team with 7 seats;
Tier 2 creates 2 teams with 14 seats; Tier 1 creates 3 teams with 20 seats.

Locked features are never hidden. You land on the page and it tells you which
plan unlocks it, so a shared link always goes somewhere sensible. Some features
are metered rather than tiered: the Pattern Finder spends one use when you run
a search, not when you open the page. On a team plan the daily allowance for
the expensive tools belongs to the subscription, not to each seat.

Capabilities are grouped as `demos.*`, `stats.*`, `analytics.*`, `team.*` and
`aim.*`. The full list with per-plan values lives in
[`shared/entitlements/catalogue.js`](shared/entitlements/catalogue.js).

---

## Demos

### Uploading

Drop a `.dem` on **My Uploads**. It streams straight to disk, gets queued, and
is parsed in a worker thread. The progress bar reports parsed, then analyzed —
statistics are built as a second step, so a demo is watchable before its
numbers are ready.

Each upload has a visibility: **public**, **unlisted** or **private**. The
library is shared, but who can see what is not.

### Finding rounds

Every round is stored under a name encoding its teams, players, map, round
number, winner and both economies. Filtering the library is a directory listing
plus a regex — nothing opens a round file to decide whether it matches.

On **Demo Manager**, filter by map, either team's buy, AWP, round winner, and
whether the round was decided mid or late. The counter above the list shows how
many rounds match. Select rounds, then:

- **Load rounds** opens the timeline viewer.
- **Analyzer** opens the macro viewer, every selected round at once in a grid.
- **Database** scopes the statistics tables to just this selection.

### Watching

The **timeline viewer** plays one round at a time with the whole match on a
single scrub bar. The radar draws players, view cones, utility and the bomb;
the clock knows freeze, live, planted and over as separate phases.

The **macro viewer** plays every selected round simultaneously. Use it to see
a habit rather than an instance: twenty B executes side by side make the
timing obvious in a way one round never does.

### Notes

Add a timestamped note at any point in a round. Notes are **yours** and are
stored outside the round file, so they survive a reparse, a rename, or a stats
rebuild. Autocoach notes are kept separately and are regenerated when a demo is
reparsed; your own are not touched.

---

## Database

Player and team tables over one cached index. The payload is fetched once per
scope; every filter, tab and sort after that is recomputed in memory, so
nothing re-reads a round.

Filters: map, side, both economies, AWP, result, opening advantage, phase,
role, date range, and a minimum-rounds floor. With a map selected you can also
filter by **round type** — rounds where your side, or the opposing side, ran a
particular named call.

Click any player or team for a per-match breakdown. Save a filter set as a
named view and share it by link.

The default floor is 80 rounds on the unfiltered Database, 5 once you pick a
map, and 0 for a match or team scope.

---

## Pattern Finder

Reached at `/patterns`. Chapters across the top: **Players**, **Teams:
Antistrat**, and three in progress (Teams: Explore, Meta, Search).

### Players

Pick a map, optionally pick subjects, then draw selections directly on the
radar — rectangle, polygon or lasso. Ask where players stood, where kills came
from, where people died, or where the first duel happened, and filter by side,
result, opening, both buys and round phase.

### Teams: Antistrat

Point it at a team and a map and it writes a scouting report into one of your
team's Documents.

**How to run one**

1. Search for the team.
2. Pick the map. Under 4 matches it warns you the sample is thin.
3. Untick any matches you do not want included.
4. Pick sections.
5. Choose the destination team and press **Analyze and save**.

It walks every included round, then writes the report. Numbers link back to the
rounds behind them, so any claim in the document opens in the viewer.

**Sections**

*General* — Pistol rounds · Positions on T and CT · Pace on T · Default
utility · Biggest tells · Responses to their calls · 5v4s · 4v5s · Force
buys · Anti-eco and anti-force · First gun round and forced buys · First
engagement timing · Patterns · Openings · Per player

*T specific* — T Round list · Set calls · T formations in defaults ·
Afterplants · Early rounds · Midrounds · Laterounds

*CT specific* — CT Round list · Winrate vs site hits · Players on A and B over
time · Retakes and retake winrates

---

## The round library

Named round types, recognised automatically from tick data. A round type is a
call a coach says out loud — "A Fake", "Lobby crunch", "Banana pop" — written
as a test over what actually happened: which utility landed where, how many
bodies went which way, and when.

Covered maps and the number of calls defined on each:

| Map | T calls | CT calls |
| --- | --- | --- |
| Ancient | 19 | 15 |
| Anubis | 12 | 5 |
| Cache | 16 | 7 |
| Dust2 | 13 | 13 |
| Inferno | 15 | 10 |
| Mirage | 21 | 8 |
| Nuke | 18 | 7 |

Every round is tagged for **both** sides, so a call can be measured from both
ends: how often their A Fake works when they run it, and how often they hold
one when it is run against them. A round can carry several tags — a Navi fake
early and an A Execute late are one round and two calls. Families that are
genuinely alternatives (the three Nuke smoke walls; A Fake vs A Pop vs A
Execute) are mutually exclusive by construction.

Where you see it:

- **Antistrat** → *T Round list* and *CT Round list*, with winrate for and
  against, usage share, and average timings on the round clock.
- **Team overview** → the *Round types* panel: how often your team calls each
  one against the library average, and whether it works.
- **Database** → round-type filters once a map is selected.

Tags are computed once when a demo's statistics are built and stored on the
round, so reading them costs nothing.

A definition depends on the map's painted geography and its named utility
spots. Anything not painted or not named makes the rules built on it
unreachable, and the report says which rather than reporting a zero as a
finding.

---

## Team workspace

Create a team on **My Profile → Teams**, then share the invite link. Members
join with one click; the owner can roll the link, ban, and add placeholder
members for players not on the site yet.

### Overview

Per-map record, round winrate, predicted round winrate and pistol winrate, with
T and CT bars anchored at 50% — the question for a map pool is which side of
even you are on, not how big the number is.

Pick a map to scope the statistics panel beneath it and reveal the **Round
types** panel: every named call on that map, how often you run it, your winrate
with it, and a `vs avg` figure comparing your usage to the whole library. 2.0x
means you call it twice as often as everyone else. Calls you never run keep
their row, dimmed — the gap is the finding.

### Documents

Shared rich-text documents. Antistrat reports land here. Share one publicly
with a link and it renders read-only for anyone who opens it.

### Roles & Positions

Assign each player a position per map per side. These names feed the antistrat
report and the Database role filters, so they are worth keeping accurate.

### Stratbook

Strategies per map and side, with economy and category tags, colour coding, and
per-player notes so each member sees their own job. **My Strategies** is the
same data filtered to you.

### Utility Archive

Your team's lineups per map. Separate from the admin-curated spot database that
names grenades for the analysis tools.

### 2D Strategy Creator

Build an animated strategy on the map overview: place players, set paths, add
utility, and scrub through it.

### Drawing Board

Freehand drawing over a map, for when a picture is faster than a document.

### Team Replays (Autocoach)

Queue demos for automatic analysis. It flags mistakes by category and writes
them as coach notes on the rounds, so you can review them in the viewer.
Clearing coach notes never touches your own.

---

## Aim trainer

`/train` for the trainer, `/training` for the scenario cards.

45+ scenarios across clicking, tracking, switching, sniping and reaction, plus
Deathmatch and a multiplayer 1v1 Duel. Competitive runs submit to cloud
leaderboards; Practice runs do not. Four fixed-rule challenge modes — Galaxy,
Waves, Sequence Ultra, Reaction Time — are always ranked.

**Playing**: click a card to lock the mouse and start a timed run. Left-click
shoots. **WASD** and **Ctrl/C** work in the movement scenarios. **Esc**
releases the mouse.

Scores save per scenario *and per configuration*, so changing the rules never
pollutes a leaderboard.

### Sensitivity and display

True `cm/360`:

```
Counts per 360  = cm360 × DPI × 0.393701
Radians / count = 2π / Counts per 360
```

Raw Pointer Lock deltas are multiplied by radians/count and applied to the
camera's `YXZ` Euler angles, pitch clamped to ±89°.

Fixed resolutions render at their exact backbuffer size while the canvas scales
to fill the viewport. 4:3 stretched modes stretch horizontally, matching CS2's
"Stretched". The FOV slider follows Source semantics: horizontal FOV at 4:3.

### Movement

Player and bots share one integrator
([`utils/SourceMovement.js`](src/utils/SourceMovement.js)), a direct port of
`PM_Friction` / `PM_Accelerate`:

```
sv_maxspeed   215 u/s  (running, AK)   walk 112 u/s   crouch 73 u/s
sv_accelerate 5.5                    1 unit       = 0.0254 m
sv_friction   5.2                    stand eye    = 1.60 m
sv_stopspeed  80 u/s                 crouch eye   = 1.15 m
```

Bots strafe through a 1-D variant with counter-strafe braking, so their peeks
ramp and stop like a player's.

### Replay Viewer

Play back your own trainer runs — last run or personal best — to see what your
aim actually did.

---

## Other

**Football** (`/football`) is a multiplayer side game with a public lobby
browser and join-by-code.

**Level Editor** (`/tools/level-editor.html`) builds custom trainer levels.

---

## Admin

Admins get `/admin` with six tabs. Everyone else gets a 404 from the API, so
hiding the UI is a convenience rather than the control.

- **Users** — accounts, plans, grants, impersonation
- **Ingest** — bulk demo ingestion
- **Tools** — library-wide maintenance jobs
- **Models** — fitted duel and round model weights
- **Utility** — the curated grenade spot database that names utility
- **Audit** — a log of every administrative action

### Maintenance jobs

One at a time across the whole library, with live progress. Safe to navigate
away; progress stays on the server.

| Job | What it does |
| --- | --- |
| Recalculate all statistics | Rebuilds every compact index from parsed round files. Run after a stats schema change. |
| Reload positions | Walks tick tracks only, to reassign map roles. Does not rebuild anything else. |
| Rescan round types | Rewatches every round against the round library and rewrites its tags. Run after editing a definition, painting a map, or naming a utility spot. |
| Rescan player names | Merges players by Steam ID onto their most-used display name. |

**Rescan round types** drops stored tags first, so it is always a fresh read.
The report is per map — a map at zero means its ground or its utility spots are
not named yet.

---

# Part 2: Running the code

## Quick start

```bash
npm install
npm run build
npm start
```

One Node process serves everything on `http://localhost:3784`: the built client,
the REST API, and the multiplayer WebSocket, all on the same origin. There is no
separate client host, no proxy and no external service to sign up for.

`npm start` binds `0.0.0.0`, so anything on the LAN can open
`http://<your-lan-ip>:3784`. Set `AIM4_HOST=127.0.0.1` (as `npm run server`
does) to keep it to this machine.

Other scripts:

```bash
npm run dev            # build without minifying, then serve (use while editing)
npm run server         # backend only, 127.0.0.1, no static files
npm run smoke          # drive every page in Chrome and report what broke
npm test               # the full suite
npm run parse-demo     # parse a .dem locally
```

To iterate quickly, rebuild without minifying so stack traces read:

```bash
npm run dev
```

### Map and asset packs

3D map packs, weapon models and the fx/player/bullet packs are read from disk
under `server/data/cs3d/pack`, served by the same process at `/api/cs3d/…`. A
file that is not there is a 404 that names the path it tried; nothing is
silently fetched from the network. To pull packs in from the published bucket
once, deliberately:

```bash
npm run cs3d:fetch -- weapons
```

## Environment

Client variables must be prefixed `VITE_` — that is what `build/build.mjs`
copies into the bundle. Full table in `.env.example`.

| Variable | Side | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | Client, build-time | Backend origin. Empty = same origin, which is the default. |
| `VITE_LOCAL_MODE` | Client, build-time | `1` (default) runs signed-in as one local owner with everything unlocked. |
| `AIM4_REPLAY_DIR` | Server | Where demos, rounds, zones and notes live |
| `AIM4_HOST` / `AIM4_API_PORT` | Server | Bind address and port (default `0.0.0.0` / `3784` under `npm start`) |
| `CS3D_PACK_DIR` | Server | Where the map packs live |

`AIM4_REPLAY_DIR` should be on a **case-sensitive** volume. Round ids differ by
case, so on a case-insensitive filesystem rounds silently overwrite each other.
The server warns at boot when it detects this.

### Local mode

There is one account and no sign-in. At boot the server logs
`signed in as @owner, everything unlocked`, and `src/lib/supabase.js` hands the
client a local stand-in for the Supabase client rather than a real one, so every
code path that used to ask "is this user entitled?" asks "is this user the
owner?" and the answer is yes.

What is genuinely unavailable offline stays unavailable and says so:

| Gone | Why |
| --- | --- |
| Billing / subscriptions | Paddle is a hosted service. The account page shows plan state locally instead. |
| Steam sign-in and profile linking | Steam OpenID needs a public callback URL. |
| HLTV / FACEIT demo ingestion | Both fetch over the internet. |
| Impersonation and admin sessions | Single-user, so there is nobody to become. |
| Remote asset fill | See "Map and asset packs" above. |

`VITE_LOCAL_MODE=0` turns the local stand-in off if you ever want the real
Supabase path back.

## Layout

```
src/
├── main.js                  # composition root + game loop
├── core/                    # engine, input, player controller, scenes, settings
├── components/              # crosshair, UI overlay, targets
├── scenarios/               # 45+ trainer scenarios
├── utils/                   # sensitivity math, Source movement, storage
├── site/                    # the site shell: routing, pages, team, admin
└── replays/                 # everything demo-related
    ├── shared/              # pure data, imported by BOTH browser and backend
    │   ├── roundId.js       # the round naming scheme
    │   ├── roundFilter.js   # query engine over round NAMES, never contents
    │   ├── tickFormat.js    # binary per-tick layout, written once read twice
    │   └── statsMath.js     # aggregation shared by every table
    ├── viewer/              # timeline + macro playback, radar, clock
    ├── zones/               # painted geography: positions, zones, areas, sites
    ├── analytics/           # pattern finder, antistrat, the round library
    ├── stats/               # the Database panel
    ├── coach/               # autocoach mistake detection
    ├── duels/ · rounds/     # the fitted duel and round-win models
    └── roles/               # role assignment from positions

server/
├── demoparser/              # SWAPPABLE. Read its README before changing parsers.
├── replays/                 # storage, quota, parse queue, stats index, routes
├── ingest/                  # HLTV / FACEIT demo ingestion
├── entitlements/            # plan resolution and quota enforcement
├── admin/                   # admin API and maintenance jobs
└── training/                # trainer leaderboards
```

## How the demo pipeline fits together

1. **Upload** streams to disk. A `.dem` is hundreds of megabytes and never
   passes through the JSON body reader.
2. **Parse** runs in a worker thread — a long synchronous call into a native
   module, and the same process serves the 128-tick multiplayer loop.
3. **Rounds** are written as compressed meta plus a tick sidecar, sharing a
   stem, so the collector goes from a name to every file without an index.
4. **Stats index** boils each demo down once into counters per player per
   round, plus derived bags: phase combat, AWP accuracy, possession, duel
   totals, movement, and round library tags.
5. **Everything downstream** reads the index. No panel reopens a round file.

Two versions govern rebuilds:

- `STATS_VERSION` in `server/replays/statsIndex.js`. **Do not bump this
  casually.** `needsPhaseEnrichment` treats a lower `entry.v` as stale and that
  path is *awaited* inside `demoIndex`, so a bump makes the next `GET /stats`
  walk every tick buffer in the library before it answers.
- `ROUND_LIBRARY_VERSION` in `src/replays/analytics/roundTags.js`. Bump when a
  round definition changes; the admin rescan rewrites tags.

## Painted geography

The analysis tools read the map by name. Three levels, painted in the site's
zone editors and stored server-side:

- **Position** — one footprint with a name, optionally per floor on Nuke
- **Zone** — a named group of positions
- **Area** — a named group of zones

Bombsite polygons and key zones are painted separately in the Sites editor.

Round definitions resolve a name against positions, zones and areas alike,
because coaches do not keep them apart: the same ground is "the Lobby zone" in
one sentence and "the Lobby position" in the next.

Grenades are named by matching a detonation to the admin utility database
within 250 units.

## Adding a map to the round library

1. Paint its positions, zones and areas, and its bombsites and key zones.
2. Name the utility spots the definitions need in **Admin → Utility**.
3. Add the definitions to
   [`src/replays/analytics/roundLibrary.js`](src/replays/analytics/roundLibrary.js)
   under a new map code. Each is a `key`, `label`, `desc` and a `match(facts)`
   returning timing marks or `null`.
4. Add the map's vocabulary to the `READINESS` table so the reports can report
   what is missing.
5. Bump `ROUND_LIBRARY_VERSION`.
6. Run **Admin → Tools → Rescan round types**.

Facts available to a matcher — positions over time, utility by name and landing
zone, transitions between regions, fights filtered by weapon and by where the
enemy stood, floor level, AWP possession — are in
[`roundFacts.js`](src/replays/analytics/roundFacts.js).

Definitions measure a side against the map as it is actually painted, and that
catches things reading cannot. On Nuke, CT spawn is painted inside the CT Yard
zone, so "3 CTs outside" was true in 100% of rounds at the two-second mark
until a hold was added. Check a new definition's hit rate against real rounds
before trusting it.

## Testing

```bash
npm test
```

Roughly 40 suites: entitlements, billing, tick codec, demo store, ingest, zone
geometry, the duel and round models, coach coverage, the round library. Add new
suites to the `test` script in `package.json`.

## Deployment

There is no separate deploy. One machine, one process, one port:

```bash
npm run build && npm start
```

`npm start` sets `AIM4_SERVE_STATIC=1` and binds `0.0.0.0`, so the client, the
API and the WebSocket share an origin and nothing needs a reverse proxy or an
external host. To reach it from another machine, open the port in the firewall
or forward it.

`VITE_API_URL` only matters if you deliberately split the client off onto
another host. It is build-time, so changing it needs a rebuild.

## Conventions

[CLAUDE.md](CLAUDE.md) carries the rules for site copy. The short version: no
em dashes in design text, and no marketing filler under a heading. A title
stands on its own.
