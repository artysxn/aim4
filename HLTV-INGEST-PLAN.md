# AIM4 HLTV Demo Ingestion Plan

A long-running batch program that fills the aim4 library from HLTV: discover
matches, download their demo archives three at a time, unpack, parse with the
existing aim4 parser, name the teams from HLTV rather than from player handles,
delete the source files, and repeat.

Two build targets from one codebase:

- **Local mode** — runs on the MacBook, bounded by `--limit` or `--since`, for
  proving the pipeline and measuring real costs.
- **Backfill mode** — runs on the Coolify backend, walks every match back to
  **2025-01-01**, resumable across restarts.

---

## 0. Before anything else

### 0.1 Two things to confirm

**Terms of service.** HLTV's terms restrict automated collection, and their
robots.txt disallows much of the site. Demos are publicly downloadable and this
plan is deliberately gentle, but "gentle" is not the same as "permitted". Worth
a look at where you stand, and an email to HLTV asking for a rate you may use is
cheap insurance for something that will run for weeks. If they say no, the same
pipeline works unchanged against FACEIT, Valve's own match-sharing codes, or
demos you already hold.

> **VERIFIED 2026-08-03: hltv.org is blocked, and politeness will not fix it.**
> Every endpoint tested, `/results`, `/matches/...` and `/download/demo/...`,
> answers **HTTP 403 with a Cloudflare managed challenge** to any non-browser
> client. `/robots.txt` does too, so the crawl rules cannot even be read. This
> is a blanket bot challenge, not a rate limit, so slower pacing changes
> nothing. Getting past it needs precisely the techniques the table below rules
> out.
>
> Everything downstream of the download is built, tested and working against
> the `local` source (see section 9). Only the `hltv` source is blocked, and it
> is the single file that has to start working if access is arranged.

**This plan rate-limits. It does not defeat bot detection.** The distinction
matters and is enforced throughout section 5:

| In scope | Deliberately excluded |
|---|---|
| Low concurrency, long delays, jitter | CAPTCHA solving |
| Honouring `Retry-After`, 429/503 backoff | TLS/JA3 fingerprint spoofing |
| One IP, one session, honest User-Agent | Stealth headless browser plugins |
| Circuit breaker that stops on challenge | Residential proxy rotation |

If Cloudflare starts challenging us, the correct response is **slow down or
stop**, not to get cleverer. The circuit breaker in 5.4 encodes that: a
challenge page halts the run and pages you, it does not trigger a workaround.

### 0.2 Scale reality check, read this before committing

The pipeline is a **shredder, not a warehouse**. Parsing is roughly **200:1**
(a 200 MB demo becomes about 1 MB of round data), and every source file is
deleted the moment its parse lands. So the only thing on disk at any moment is
the current batch of 3 plus the accumulated round data.

| Quantity | Estimate |
|---|---|
| HLTV matches with demos, all tiers, 2025-01-01 to now | ~12,000-20,000 |
| Archive size per match (Bo3) | 200 MB - 1 GB |
| **Peak transient disk (3 in flight)** | **~1.5 GB typical, 3 GB worst case** |
| Parsed output per match, at 200:1 | ~1-5 MB |
| Total raw volume *streamed through* | 3-15 TB |
| **Total parsed library after full backfill** | **~15-75 GB** |

Two conclusions, and they point in opposite directions:

**Disk is a non-issue.** The working set is fixed at ~3 GB regardless of how
long the run goes, because stage 4 clears the shelf every batch. No staging
area, no growing archive directory, nothing to prune. The one real number is the
parsed library, and even the pessimistic end of that is an ordinary volume size.

`MAX_BYTES` in `demoStore.js` is currently 20 GiB for the whole shared library,
which covers the low end of that range but not the high end. That is a constant
to raise (section 13.3), not a design constraint.

**Time and bandwidth are the actual limits.** 3-15 TB has to move over the wire
at a deliberately slow rate, and every map has to go through the parser. The
parser is the bottleneck, not the disk and not the download. That is what
section 11's filter is for now: shortening the run and reducing how much traffic
we send HLTV, *not* saving space. A full unfiltered backfill is a
storage-feasible, time-expensive proposition, and the honest answer to "how
expensive" comes from step 1 of the build order rather than from this table.

Measure the real ratio and the real parse rate with the local run in section 9
before starting a backfill. Everything above is an estimate; step 1 replaces it
with numbers from your own demos on your own hardware.

---

## 1. Where this plugs into existing code

Nothing here is new parsing or storage machinery. The program is a driver around
what already exists:

| Existing | File | Used for |
|---|---|---|
| `unpackUpload` | `server/replays/archive.js` | `.rar` / `.zip` extraction, already supports both |
| `rarSupport()` | `server/replays/archive.js` | Preflight: bsdtar present on this host |
| `parseDemo` | `server/demoparser/index.js` | The parse itself |
| `ingestDemo` | `server/replays/ingest.js` | Materialize + persist rounds |
| `materializeDemo` | `server/replays/materialize.js` | Round ids, record shape |
| `newDemoId`, `writeRecord`, `checkQuota` | `server/replays/demoStore.js` | Library writes |
| `SHARED_LIBRARY` | `server/replays/auth.js` | Which library to write into |

**It does not go through HTTP.** No `startIngest`, no multipart upload, no
`/api/replays/demos`. Those exist to get a browser's bytes onto disk, and we
already have the bytes on disk. Going through the HTTP path would mean copying
every archive through a socket to the same machine.

It also does **not** use the in-memory queue in `jobs.js`. That queue is sized
for interactive uploads and its state dies with the process. This program needs
a ledger that survives restarts (section 3).

New code, all under `server/ingest/hltv/`:

```
server/ingest/hltv/
  cli.js            entry point, arg parsing, mode selection
  config.js         env + flag resolution, one place
  ledger.js         the resumable state store
  discover.js       stage 1: crawl HLTV for match metadata
  fetcher.js        the polite HTTP client (section 5)
  download.js       stage 2: archive download, 3 at a time
  process.js        stage 3: unpack, parse, ingest, name
  cleanup.js        stage 4: delete sources
  pipeline.js       the loop that ties 2-4 together
  teamNames.js      HLTV names -> demo.team1/team2 (section 2)
  report.js         progress output, run summary
  ledger.test.js
  teamNames.test.js
  discover.test.js  against saved HTML fixtures, never the live site
```

---

## 2. The team-name problem, and why timing matters

This is the part most likely to be got wrong, so it goes near the top.

### 2.1 What happens today

`laihoe.js:408`:

```js
function teamNameFor(players, fallback) {
  // Demos rarely carry a clan name; a stable, readable label beats an empty
  // one, so fall back to the first player's handle.
  return players[0]?.clanName || players[0]?.name || fallback;
}
```

CS2 demos usually carry no clan name, so team names become whichever player
happened to land in slot 0. That is the "random player" naming you want gone.

### 2.2 Why a post-hoc rename is the wrong fix

There is already a rename path, `POST /api/replays/demos/:id/teams`, and it is
**not** what this program should use. From `demoStore.js:257`:

> Update display names for both teams on a demo and its round JSON files.
> **Short ids (and therefore round filenames) stay the same.**

That is deliberate and correct for a user fixing a typo, because rewriting round
filenames would break every saved playlist, note and share link pointing at them.
But it means the rename only touches the *display* name.

The id is a different thing. `materialize.js:43`:

```js
const id = buildRoundId({
  team1: demo.team1.id,     // <- shortIdFor(team name)
  team2: demo.team2.id,
  ...
});
const stem = `${id}~${demoId}`;   // <- the round's filename
```

`shortIdFor` (`roundId.js:104`) is an FNV-1a hash of the **name string**. So if a
demo is ingested as "s1mple" and renamed to "NAVI" afterwards, every round file
keeps an id hashed from "s1mple" forever. Team filters in the Database, Pattern
Finder and Charts key off those short ids, so the demo would display correctly
and still group wrongly. Silent, and very annoying to discover six thousand
demos later.

**Therefore: HLTV names must be set on the parsed `demo` object before
`materializeDemo` runs.**

### 2.3 The hook already exists

`materializeDemo` opens with:

```js
// Prefer Valve standings org names when a side's handles match a roster
// (>=3 players). Runs before round ids are built so short ids stay aligned.
applyStandingsToDemo(demo);
```

That comment is describing exactly the invariant we need, for exactly this
reason. The HLTV naming is a second, higher-priority source in the same slot.

### 2.4 Implementation

`teamNames.js` exports one function, applied in `process.js` between `parseDemo`
and `ingestDemo`:

```js
/**
 * Overwrite a parsed demo's team names with HLTV's, before round ids exist.
 *
 * Both name and id are rewritten: shortIdFor hashes the name, so setting one
 * without the other leaves round ids grouping under the handle the parser
 * guessed. Returns a report rather than throwing, so a match whose sides
 * cannot be resolved is ingested with parser naming and flagged for review
 * instead of being lost.
 */
export function applyHltvTeams(demo, hltvMatch, { mapName }) -> {
  applied: boolean,
  confidence: 'roster' | 'score' | 'none',
  team1: string,
  team2: string,
  reason?: string
}
```

### 2.5 Which HLTV team is `team1`?

The hard half. The parser's `team1`/`team2` come from the demo's internal team
numbers, which have no relationship to HLTV's left/right ordering, and sides
swap at half time. Matching by score is unreliable because a 13-11 could be
either way round.

Resolve by **roster overlap**, which is robust and needs no guessing:

1. Take the SteamID64s of each parsed side (`demo.rounds[0].players`, grouped by
   `team`). Steam ids are already in the roster; `laihoe.js` reads them.
2. Take HLTV's two lineups for the match, as Steam ids where the player page
   exposes one, otherwise as nicknames.
3. Score each of the two possible assignments by how many players overlap.
   Steam id match is worth more than a normalised-nickname match.
4. Accept the better assignment when it beats the other by a clear margin and
   covers at least 3 of 5 on both sides. Report `confidence: 'roster'`.
5. If HLTV lineups are unavailable, fall back to the **map result**: HLTV lists
   per-map scores, and the parser knows the final score per side. If exactly one
   assignment matches the map's score, take it with `confidence: 'score'`.
6. Otherwise `applied: false`, `confidence: 'none'`. Ingest with parser naming,
   mark the ledger row `needs_review`, continue. Do not guess.

Stand-ins and mid-event roster changes are the reason for the 3-of-5 floor
rather than 5-of-5.

Store the provenance on the record so it is visible later and so a future pass
can re-resolve the `none` rows:

```js
record.hltv = {
  matchId, demoId, eventName, eventId,
  matchUrl, playedAt,
  team1: { name, hltvId }, team2: { name, hltvId },
  mapNumber, confidence
};
```

This also gives the site something better than a filename to show, and makes the
whole ingest auditable.

### 2.6 Test it without the network

`teamNames.test.js` runs `applyHltvTeams` over fixtures: clean roster match,
swapped sides, one stand-in per side, no HLTV lineup with a decisive score, and
an ambiguous case that must return `applied: false`. Pure function, no I/O, add
it to the `npm test` chain like `equipmentIcons.test.js`.

---

## 3. State: the ledger

The whole program is a state machine over a table of matches. Everything else is
a worker that moves rows between states.

`data/hltv-ingest/ledger.json` (local) or `$AIM4_INGEST_DIR/ledger.json`
(server). JSON with atomic write-and-rename; if it outgrows that, SQLite behind
the same `ledger.js` interface. Nothing else touches the file.

One row per **match**, not per demo file, because one HLTV download is a Bo3
archive containing several maps:

```jsonc
{
  "matchId": 2396238,
  "hltvDemoId": 109970,
  "matchUrl": "https://www.hltv.org/matches/2396238/mibr-vs-bestia-...",
  "playedAt": "2026-09-14T18:00:00Z",
  "event": { "id": 7811, "name": "StarLadder StarSeries Fall 2026 SA Closed Qualifier" },
  "stars": 1,
  "teams": [
    { "hltvId": 9215, "name": "MIBR",   "players": [{ "nick": "...", "steamId64": "..." }] },
    { "hltvId": 11460, "name": "BESTIA", "players": [...] }
  ],
  "maps": [{ "number": 1, "map": "de_mirage", "score": "13-9" }],

  "state": "discovered",
  "attempts": 0,
  "lastError": null,
  "lastAttemptAt": null,
  "archiveBytes": null,
  "demoIds": [],
  "needsReview": false,
  "updatedAt": "..."
}
```

States, strictly forward except on retry:

```
discovered -> filtered_out                       (fails the section 11 filter)
           -> downloading -> downloaded
                          -> parsing -> ingested -> cleaned  (terminal, success)
           -> failed_permanent                   (terminal, give up)
           -> needs_review                       (ingested, but naming unresolved)
```

Rules that make restart-safety fall out:

- **Write the state transition before doing the work, not after.** A row in
  `downloading` at startup means the process died mid-download; the partial file
  is discarded and the row goes back to `discovered`.
- `attempts` increments per try. At `attempts >= 3` the row becomes
  `failed_permanent` with the last error kept, and never blocks the queue.
- Discovery is idempotent: re-crawling a known `matchId` updates its metadata
  and leaves `state` alone.
- `cleaned` rows are never revisited, which is what makes the whole run
  resumable at no cost.

---

## 4. Stage 1: discovery

Separate from downloading, and runs to completion first (or in a slow background
trickle). Cheap HTML pages, no large transfers, and it means the download loop
always has a full work queue and never has to interleave crawling with 500 MB
transfers.

**Source:** `https://www.hltv.org/results?offset=N`, paged 100 at a time,
optionally `&startDate=&endDate=` to window it. Walk backwards until the results
page date passes `--since`.

For each result row, fetch the match page once to get:

- match id + canonical URL
- **the demo id**, from the `/download/demo/<id>` link on the page
- both team names and HLTV team ids
- both lineups (nick + Steam id where exposed) for section 2.5
- event name + id, `playedAt`, per-map list and scores, stars

Then write the row and move on.

Notes:

- **Do not parse the demo id out of the match URL slug.** They are unrelated ids
  (`/matches/2396238/...` has demo `109970`), and the slug's team names are
  lowercased and hyphen-mangled. Read the download link and the structured team
  elements from the page.
- Matches with no demo link (not uploaded, or removed) go straight to
  `filtered_out` with a reason. Perfectly normal, especially for older events.
- Selectors will break when HLTV changes markup. Keep every selector in one
  `selectors.js` object with a comment naming what it targets, and have
  `discover.js` throw a loud, specific error when a required field is missing
  rather than writing a half-empty row. `discover.test.js` runs against saved
  HTML fixtures so a markup change is a failing test, not a silent 4,000-row
  corruption.
- Discovery is the cheapest stage to re-run. If it produces junk, delete the
  affected rows and crawl again.

---

## 5. The politeness engine

Everything network-facing goes through `fetcher.js`. No other module calls
`fetch` directly, so the limits cannot be bypassed by accident.

### 5.1 Concurrency

- **Downloads: 3 at a time**, as specified, and never more. This is the batch
  size for the whole pipeline.
- **Discovery: 1 at a time.** Sequential, never parallel with itself.
- **Global cap of 3 in-flight requests to hltv.org**, shared across stages, so
  discovery and downloading cannot add up to more than the budget.

### 5.2 Pacing

- Minimum **8-15 s between discovery page requests**, randomised. Not a fixed
  interval: a perfectly periodic request train is both rude and conspicuous.
- Minimum **20-40 s between starting downloads**, randomised, on top of the
  concurrency cap.
- A **batch cooldown of 60-120 s** between the end of one group of 3 and the
  start of the next. Parsing takes minutes anyway, so this is nearly free.
- Optional `--quiet-hours` to pause during HLTV's peak (European evenings).
  Bandwidth is cheapest for them when nobody is watching a match.

### 5.3 Request hygiene

- **One session, one IP.** Keep-alive agent, reuse the connection, keep cookies
  in a jar across the run so we look like one long-lived client rather than
  thousands of strangers.
- **An honest `User-Agent` naming the project and a contact address**, e.g.
  `aim4.io-ingest/1.0 (+https://aim4.io; contact@aim4.io)`. This is the single
  highest-value thing in this section: it lets HLTV throttle or mail us instead
  of silently banning an anonymous scraper, and it is the difference between
  "a bot we can talk to" and "a bot".
- `Accept-Encoding: gzip`, and an `If-None-Match` / `If-Modified-Since` cache for
  discovery pages so re-crawls are mostly 304s.
- Never re-download an archive already in the ledger as `downloaded` or later.

### 5.4 Backoff and the circuit breaker

On `429` or `503`: honour `Retry-After` if present, otherwise exponential
backoff from 60 s, doubling, capped at 30 min, with jitter. Three consecutive
throttles halves the pacing rate **for the rest of the run** and does not
restore it.

On `403`, or a `200` whose body is a Cloudflare interstitial or challenge:

1. **Stop the whole pipeline.** Not just that request.
2. Write the reason and a timestamp to the ledger.
3. Emit a loud operator notice (log + optional webhook).
4. Exit non-zero. Do not auto-retry on a schedule, and do not attempt to satisfy
   the challenge.

That is the intended behaviour, not a limitation. A challenge means we have
been noticed and asked to stop; the recovery is a human deciding to slow the
config down or to go and ask for access. Auto-retrying into a challenge is how a
soft throttle becomes a hard IP ban.

Downloads must also be **resumable** where the server supports `Range`, so a
dropped 700 MB transfer does not restart from zero and re-spend the bandwidth.

---

## 6. Stage 2: download

For each of the 3 slots:

1. Ledger row `discovered` -> `downloading`.
2. `GET https://www.hltv.org/download/demo/<hltvDemoId>` with redirect following
   (the real file is served from their storage host).
3. **Stream to disk.** Never buffer; these are hundreds of megabytes.
   `$WORK_DIR/<matchId>/<original-filename>`.
4. Enforce a per-file ceiling (`--max-archive-bytes`, default 2 GB) and abort a
   transfer that exceeds it.
5. Take the filename from `Content-Disposition` when present, otherwise
   `<matchId>.rar`. Classify with `classifyUpload()` from `archive.js` and reject
   anything not in `ACCEPTED_EXTS`.
6. Verify: non-zero length, and the magic bytes match the extension. An HTML
   error page saved as `.rar` is the classic failure and must not reach the
   parser.
7. `downloading` -> `downloaded`, recording `archiveBytes`.

**"Waits until fully downloaded" is the barrier here**: all 3 slots must reach
`downloaded` (or `failed`) before stage 3 begins for the batch. Sequential
stages, not a continuous pipeline. Slightly less efficient, dramatically easier
to reason about and to resume, and the parser is the bottleneck anyway.

Preflight once at startup: `rarSupport()` must be true, or `.rar` archives cannot
be opened on this host and the run should refuse to start with that message
rather than failing 3,000 times.

---

## 7. Stage 3: unpack, parse, name, ingest

Per downloaded match, and the three run **concurrently but capped**, because
parsing is memory-hungry (`jobs.js` already fights OOM kills with batch-halving
retries).

> Set parse concurrency separately from download concurrency. 3 simultaneous
> parses of a 128-tick Bo3 will OOM a small Coolify box. Default parse
> concurrency to **1** on the server, `--parse-concurrency` to raise it, and
> reuse `AIM4_PARSE_BATCH_TICKS` when memory is tight.

1. `downloaded` -> `parsing`.
2. **Unpack** with `unpackUpload({ source, filename, targetFor, allowedBytes })`
   from `archive.js`. It already handles `.rar` via bsdtar, `.zip` in process,
   and filters junk entries with `isDemoEntry` (macOS `._` resource forks, which
   matter since we are testing on a Mac).
3. For each extracted `.dem`, in sequence:
   a. `parseDemo(demoPath, { onProgress })`.
   b. **`applyHltvTeams(demo, row, { mapName: demo.map })`** — section 2, before
      anything else touches the demo.
   c. `ingestDemo(SHARED_LIBRARY, newDemoId(), demo, meta)` where `meta` carries
      `source: 'hltv'`, the original filename, and the `record.hltv` block.
   d. Push the new demo id onto `row.demoIds`.
4. Map the archive's demo files to HLTV's map list by **map name**, not by file
   order. Archive ordering is not guaranteed, and getting this wrong mislabels
   which map a round belongs to.
5. `parsing` -> `ingested`, or `needs_review` if any map came back
   `confidence: 'none'`.

**Quota.** Call `checkQuota` before ingesting and stop the run cleanly when the
library is full, rather than half-writing a demo into a full volume. At ~1-5 MB
per match this should be a very distant backstop, not something the run trips
over. If it fires early, the 200:1 assumption is wrong for your demos and step 1
of the build order needs redoing.

**A failed parse is not a failed match.** One corrupt map in a Bo3 should ingest
the other two and record the failure. `attempts` applies per match; a map that
fails twice is skipped permanently and noted.

---

## 8. Stage 4: cleanup, then loop

Once all three matches in the batch are `ingested` (or terminal):

1. Delete the extracted `.dem` files.
2. Delete the downloaded `.rar` / `.zip`.
3. Delete the per-match work directory.
4. `ingested` -> `cleaned`.
5. Batch cooldown (5.2), then pull the next 3 `discovered` rows.

Deletion is **only** driven by ledger state, never by "everything in the work
directory". A crash mid-parse must not delete a demo that a retry still needs.
`cleanup.js` takes match ids, not paths.

Add a startup **orphan sweep**: work directories with no ledger row, or whose
row is `cleaned`, are left over from a crash and get removed. This is the only
place allowed to delete by directory scan, it runs before any download starts,
and it is what stops a long run from slowly filling the disk with debris.

The parsed round files stay, obviously. Those are the product.

---

## 9. Local test mode (MacBook)

The same program with tighter defaults and no assumptions about the environment.

```bash
# Discover only, no downloads. Cheap, safe, run this first.
node server/ingest/hltv/cli.js discover --since 2026-09-01 --dry-run

# Whole pipeline over three matches, into a scratch library.
node server/ingest/hltv/cli.js run \
  --limit 3 \
  --since 2026-09-01 \
  --library scratch \
  --work-dir ./tmp/hltv \
  --keep-sources \
  --verbose

# One specific match, for debugging naming.
node server/ingest/hltv/cli.js run --match 2396238 --verbose
```

Local-mode flags:

| Flag | Purpose |
|---|---|
| `--limit N` | Stop after N matches. The main test knob. |
| `--since YYYY-MM-DD` | Discovery floor. Recent dates keep test runs small. |
| `--until YYYY-MM-DD` | Upper bound, for reproducible test windows. |
| `--match <id>` | One match, ignore the queue. |
| `--dry-run` | Discover and plan, download nothing. |
| `--keep-sources` | Skip stage 4, so archives can be inspected. |
| `--library <name>` | Write to a scratch library, not `SHARED_LIBRARY`. |
| `--offline <dir>` | Skip HLTV entirely, use archives already on disk. |

`--library scratch` matters: it means the test run cannot pollute the real demo
library, and cleanup is `rm -rf` on one directory. It works because every store
function is already keyed by `user`.

`--offline` matters more than it looks. It lets the unpack/parse/name/ingest half
be developed and tested against the `.aim4replay` and `.dem` files already in
`~/Documents/07 31/aim4replay/` and `~/Downloads/`, with **zero HLTV traffic**.
Most of the debugging should happen here.

Mac-specific things that will bite:

- `bsdtar` is present on macOS by default, so `.rar` works locally. Confirm the
  Coolify image has it; `rarSupport()` is the preflight.
- Archives from macOS carry `._` resource forks. `isDemoEntry` already filters
  them.
- The default work directory must not be inside the repo, or Vite's watcher will
  try to index several hundred megabytes of demo.

---

## 10. Production mode (Coolify)

```bash
node server/ingest/hltv/cli.js run \
  --since 2025-01-01 \
  --min-stars 1 \
  --parse-concurrency 1 \
  --state-dir /data/hltv-ingest \
  --work-dir /data/hltv-work
```

Requirements beyond local mode:

- **Runs as its own process**, not inside the API server. It is a
  memory-hungry batch job and must not be able to OOM the thing serving the site.
  Separate Coolify service, same volume mount for the library.
- **Survives restarts** by construction: the ledger is the only state, and the
  orphan sweep cleans the rest.
- **Graceful shutdown.** On `SIGTERM`, stop pulling new work, let in-flight
  parses finish (or mark them for retry), flush the ledger, exit 0. Coolify will
  restart it and it will resume.
- **Single instance.** A PID/lock file in the state directory; two copies sharing
  a ledger and a work directory would double the request rate, which is exactly
  the thing section 5 exists to prevent.
- **A status file** the API can read, so ingest progress is visible in the admin
  panel without giving the admin panel a way to drive the ingester:
  `{ running, currentBatch, counts: {...}, lastError, ratePerHour, etaDays }`.
- **Disk headroom check** before each batch. Refuse to start with less than
  ~10 GB free: 3 GB for the worst-case working set, the rest as margin for the
  slowly growing parsed library. The check exists to catch a stuck cleanup
  (stage 4 silently failing and letting archives pile up), which is the only
  realistic way this run fills a volume.

---

## 11. Configuration and filtering

`config.js`, env with flag overrides, documented in `.env.example` alongside the
existing `AIM4_*` block:

```bash
AIM4_INGEST_STATE_DIR=/data/hltv-ingest
AIM4_INGEST_WORK_DIR=/data/hltv-work
AIM4_INGEST_SINCE=2025-01-01
AIM4_INGEST_BATCH_SIZE=3            # do not raise without reading section 5
AIM4_INGEST_PARSE_CONCURRENCY=1
AIM4_INGEST_MIN_DELAY_MS=20000
AIM4_INGEST_MAX_DELAY_MS=40000
AIM4_INGEST_USER_AGENT="aim4.io-ingest/1.0 (+https://aim4.io; contact@aim4.io)"
AIM4_INGEST_MAX_ARCHIVE_BYTES=2147483648
AIM4_INGEST_QUIET_HOURS=17-23       # UTC, optional
```

The filter between discovery and download. Since storage is not the constraint
(0.2), this exists to **shorten the run and reduce traffic sent to HLTV**, and
to let you get the matches you actually care about first. It is a scheduling
tool, not a space-saving one, so the sensible default is a narrow first pass
that widens over time rather than one attempt at everything.

| Flag | Effect |
|---|---|
| `--min-stars N` | HLTV star rating floor. The single most effective cut. |
| `--event <id,...>` | Only these events. |
| `--team <id,...>` | Only matches involving these teams. |
| `--map <name,...>` | Only these maps (post-unpack, per map). |
| `--lan-only` | Skip online matches. |
| `--max-matches N` | Hard ceiling for a run. |

A filtered-out match stays in the ledger as `filtered_out`, so widening the
filter later picks it up without re-crawling.

---

## 12. Build order

Each step is independently testable, and the risky, network-facing work is last
rather than first.

1. **Measure.** Parse three demos you already have, end to end. Record for each:
   wall-clock parse time, peak RSS, source bytes in, round bytes out. That gives
   the real compression ratio (0.2 assumes 200:1) and the real parse rate, which
   together fix the only two unknowns that matter: how long a backfill takes and
   how large the library ends up. Then pick the first production filter.
   *Nothing else is worth building until this is done.*
2. **`ledger.js` + tests.** State machine, atomic writes, crash recovery. Pure,
   no network, no parsing.
3. **`teamNames.js` + tests.** Section 2.5's resolver against fixtures. The
   highest-risk correctness logic in the project, and it needs no network.
4. **`process.js` + `cleanup.js` in `--offline` mode.** Unpack, parse, name,
   ingest, delete, driven from local archives. This is the whole product minus
   HLTV.
5. **`fetcher.js` + tests.** Pacing, backoff, circuit breaker, tested against a
   local stub server that returns 429s and challenge pages on demand. Never
   tested against HLTV.
6. **`discover.js` + fixture tests.** Then one real, tiny, supervised crawl of a
   single results page.
7. **`download.js`.** One archive, by hand, watched.
8. **`pipeline.js`.** Wire 3 at a time. Run `--limit 3` locally.
9. **Local soak.** `--limit 30` overnight. Check naming accuracy by hand across
   all 30, check nothing leaked into the work directory, check the ledger
   resumes after a mid-run `SIGKILL`.
10. **Deploy, filtered.** Start with `--max-matches 100` on the server. Confirm
    memory, disk and request rate, then widen.

---

## 13. Open questions

1. **Permission.** Section 0.1. Worth resolving before step 10, not after.
2. **Run ordering.** Storage does not force a choice about what to backfill, but
   time does: at a polite request rate a full crawl is a long-running job. Which
   matches should land first, so the library is useful before the run finishes?
   Most recent backwards is the obvious default; by event or by team may be
   better if there is a specific use case driving this.
3. **`MAX_BYTES`.** Currently 20 GiB for the whole shared library, against an
   estimated 15-75 GB of parsed output. Raise it once step 1 pins the real
   ratio, and keep `checkQuota` as the backstop that stops the run cleanly.
4. **Ownership and visibility.** Ingested demos have no uploader. Do they belong
   to the legacy `@artysan` identity like the pre-account library, or to a new
   `hltv` system account? This decides who sees them and interacts with
   `demos.full_recent_access`, since a Free account would only get the first half
   of anything under a month old.
5. **Re-ingest policy.** If a match is re-parsed later (parser improvement),
   does it replace the old rounds or sit alongside them? Round ids are content-
   derived, so a same-input re-parse produces the same ids, but a parser change
   that alters team resolution would produce different ones.
6. **`needs_review` workflow.** Where does an operator see and fix the matches
   whose sides could not be resolved? An admin panel list is the obvious answer,
   but note section 2.2: fixing them after ingest only corrects the display name.
   A genuine fix is a re-parse.
7. **Stars are a weak proxy.** HLTV stars track viewer interest, not data
   quality. If the goal is coverage of specific teams or leagues, `--event` and
   `--team` are better filters than `--min-stars`.
