# AIM4 FACEIT Demo Ingestion Plan

Fill the aim4 library from FACEIT tournaments: get told the moment a demo is
uploaded, download it through the sanctioned Downloads API, unpack, parse with
the existing aim4 parser, name the teams from FACEIT's rosters, ingest the
rounds, delete the source files. Live matches land minutes after they finish;
the same code backfills a whole championship by polling.

This is the successor to `HLTV-INGEST-PLAN.md`. HLTV is verified blocked behind
a Cloudflare challenge (see that plan's section 0.1), and that plan's own
fallback clause said "the same pipeline works unchanged against FACEIT". That
is what this is: an official API, used with permission, not a scrape.

> **Status, 2026-08-09: the Downloads API application is IN QUEUE, not
> approved.** Submitted 3 Aug 2026, "waiting for review", against a stated
> ~30-day turnaround (so expect an answer early September). Everything except
> the actual demo download can be built and tested today with the server-side
> key; the exchange call in section 1.3 is the one thing that will answer 401
> or 403 until approval lands. Section 11's build order is sequenced around
> exactly that: steps 1-4 and 6 need no Downloads access.

Why this plan is shorter than the HLTV one:

| HLTV | FACEIT |
|---|---|
| Scrape HTML, selectors break silently | JSON REST API with stable schemas |
| Crawl `/results` to learn about matches | FACEIT POSTs a webhook when the demo is ready |
| `.rar` archive per match, maps inside | One `.dem.zst` (or legacy `.dem.gz`) per map |
| Lineups scraped, Steam ids sometimes missing | Rosters with SteamID64 in every match response |
| Politeness engine, circuit breaker, quiet hours | Authenticated API, honor 429, that's it |
| Permission unresolved | Permission granted in writing |

Everything downstream of the download (unpack, parse, name, ingest, clean) is
already built and proven against the `local` source. The work here is one new
source, one team-namer, and one webhook receiver.

---

## 0. Credentials: what is required, and what we have

Four things, all managed in the [FACEIT Developer Portal](https://developers.faceit.com)
under your app in **App Studio**. **OAuth is not one of them**: OAuth2 clients
exist for "log in with FACEIT" user flows, and nothing in this pipeline acts on
behalf of a user. Server-to-server API key auth covers all of it.

| # | Credential | Used for | Status |
|---|---|---|---|
| 1 | **Server-side API key** | Data API (`Authorization: Bearer <key>`) | **Have it.** Created in App Studio. Client-side keys will not do. |
| 2 | **Downloads API scope** on that key | The demo URL exchange (section 1.3) | **In queue**, submitted 3 Aug 2026. Until approved, section 6 cannot run. |
| 3 | **Webhook subscription** | Push notification when a demo is ready | **Ours to create.** App Studio, Webhooks tab: subscription type, entities, events, callback URL + security. No key involved; FACEIT calls us. |
| 4 | **Webhook shared secret** | Authenticating FACEIT's calls to our endpoint | **We invent it.** A long random value set as the subscription's security header name/value and checked by the receiver. FACEIT treats webhook auth as optional; we do not. |

On (4), because it is the one that looks like it should come from FACEIT and
does not: FACEIT signs nothing. Their docs state plainly that the security
logic is the developer's to implement, and the subscription form simply echoes
back whatever header (or query string) name and value you type into it. So the
secret is a bearer credential we choose, paste into App Studio, and compare
against on arrival. If it is unset, the receiver rejects every delivery rather
than accepting every delivery: the endpoint is public, and fail-open would let
anyone on the internet queue ingest work.

When the Downloads approval arrives, pull out of the email and record here:

- which **app id / API key** the scope was granted to (it attaches to a
  specific one),
- any **quota or rate terms** stated (the public docs document none),
- any **usage terms** (redistribution restrictions; see section 8).

Then immediately run curl (d) in section 11, step 1. That call is the only
proof the scope actually landed, and everything in section 6 assumes it passes.

### Key handling

- Key lives in `AIM4_FACEIT_API_KEY` on the server. Never in the repo, never in
  client code, never in a URL.
- The webhook secret lives in `AIM4_FACEIT_WEBHOOK_SECRET`, compared
  constant-time. Rotating it is: change env, change App Studio, done.
- 401/403 from either API is a **credential or scope problem, not a retry
  case**: the run stops with an operator message naming the failing API.

---

## 1. The three FACEIT surfaces, digested

Reference: [Data API](https://docs.faceit.com/docs/data-api/data),
[Webhooks](https://docs.faceit.com/docs/webhooks/),
[Download API guide](https://docs.faceit.com/getting-started/Guides/download-api/).

### 1.1 Data API

Base `https://open.faceit.com/data/v4`, header `Authorization: Bearer <server-side key>`.
Rate limits are undocumented; excess answers `429 Too many requests`.

| Endpoint | Purpose here |
|---|---|
| `GET /championships/{id}` | Confirm a configured tournament exists, get name + organizer |
| `GET /championships/{id}/matches?type=past&offset=&limit=` | Backfill discovery. `limit` max 100, default 20, paged |
| `GET /matches/{match_id}` | The workhorse: status, `finished_at`, `best_of`, both factions with full rosters, and **`demo_url`, an array of demo resource URLs, one per map played** |
| `GET /championships?game=cs2&type=...` | Optional: enumerate an organizer's championships instead of hand-listing ids |

A "tournament" in FACEIT's current system is a **championship**; the id is the
UUID in the event page URL, `faceit.com/en/championship/<id>/...`. (Legacy
"tournaments v1" and hubs are different entity types with their own endpoints;
out of scope until a target event turns out to be one, section 12.)

Roster entries carry `player_id` (FACEIT id), `nickname`, and `game_player_id`,
which for CS2 is the **SteamID64**. That is the team-naming problem from HLTV
plan section 2 solved by the API itself.

`demo_url` entries look like
`https://demos.faceit.com/cs2/<match_id>-1-<n>.dem.zst`. That host is not
publicly fetchable; the URL is a *resource name* to be exchanged (1.3).

### 1.2 Webhooks

Configured per app in App Studio. Subscriptions are scoped to **organizers**
(all of yours, a static list of yours, or a static list of other organizers,
the last "with potential privacy restrictions"), not to individual
championships. So: subscribe at organizer level, filter by championship id in
the receiver.

Events we care about:

- **`match_demo_ready`**: the demo file is uploaded and exchangeable. This is
  the trigger for the whole live pipeline.
- `match_status_finished`: the match ended; the demo usually is not up yet.
  Useful only to pre-create an `awaiting_demo` row so ops can see the gap
  between "finished" and "demo arrived".
- `match_status_aborted` / `match_status_cancelled`: close any pending row.

Delivery is an HTTP POST of a JSON envelope. At-least-once: a `retry_count`
field exists, so duplicates must be harmless. Shape (from FACEIT's own example;
capture a real `match_demo_ready` in step 6 of the build order and keep it as a
fixture):

```jsonc
{
  "transaction_id": "8d24788c-...",        // unique per delivery attempt group
  "event": "match_demo_ready",
  "event_id": "af51ab9b-...",
  "third_party_id": "...",                  // your organizer/user binding
  "app_id": "...",                          // your app
  "timestamp": "2026-08-08T20:39:09Z",
  "retry_count": 0,
  "version": 1,
  "payload": {
    "id": "1-cb038819-b0d0-4471-b25c-0e7468ab1eb1",   // match_id
    "organizer_id": "...",
    "region": "EU",
    "game": "cs2",
    "entity": { "id": "<championship-id>", "name": "...", "type": "championship" },
    "teams": [ { "id": "...", "name": "...", "avatar": "..." } ]
  }
}
```

Do not assume the payload carries demo URLs. The receiver only needs
`payload.id` and `payload.entity.id`; everything else comes from
`GET /matches/{id}`, which we need anyway for rosters.

### 1.3 Downloads API

One endpoint. Exchange a resource URL for a short-lived signed URL:

```
POST https://open.faceit.com/download/v2/demos/download
Authorization: Bearer <key with Downloads scope>
Content-Type: application/json

{ "resource_url": "https://demos.faceit.com/cs2/1-...-1-1.dem.zst" }
```

```jsonc
{ "payload": { "download_url": "https://...X-Amz-Credential=...&X-Amz-Expires=..." } }
```

The signed URL is S3-style and expires (TTL undocumented, measure it once).
Consequences:

- **Exchange immediately before the GET**, one exchange per download attempt.
- The **ledger stores only `resource_url`**, never signed URLs.
- Signed URLs are secrets while valid: never log the query string.

---

## 2. Where this plugs into existing code

Same principle as the HLTV plan section 1: no new parsing or storage machinery.
The ingest core under `server/ingest/hltv/` (ledger, pipeline, process,
cleanup, config, cli) was proven source-agnostic against the `local` source;
sources are selected in `cli.js` (`createHltvSource` / `createLocalSource`).

| Existing | Where | Reused for |
|---|---|---|
| Source interface: `name`, `check()`, `discover({since,until})`, `fetchArchive(row, destPath, {onProgress})` | `sources/local.js`, `sources/hltv.js` | The shape `faceit.js` implements |
| `unpackUpload`, `classifyUpload`, `ACCEPTED_EXTS` | `server/replays/archive.js` | `.zst` and `.gz` single-stream demos are **already accepted**; no extraction work needed |
| `parseDemo` | `server/demoparser/index.js` | The parse |
| Name-before-materialize invariant | HLTV plan section 2, `materialize.js` | `applyFaceitTeams` runs in the same slot as `applyHltvTeams` |
| `ingestDemo` | `server/replays/ingest.js` | Materialize + persist |
| `ledger.js` states, atomic writes, orphan sweep | `server/ingest/hltv/` | Unchanged; new states in 3.2 |
| `fetcher.js` backoff | `server/ingest/hltv/` | With a FACEIT profile: normal API pacing, no Cloudflare semantics |
| `checkQuota`, `SHARED_LIBRARY`, scratch `--library` | `server/replays/` | Unchanged |

New code:

```
server/ingest/faceit/webhookRoutes.js  BUILT: POST /api/ingest/faceit/webhook, secret + filter
server/ingest/faceit/spool.js          BUILT: the receiver -> ingester handoff directory
server/ingest/faceit/config.js         BUILT: AIM4_FACEIT_* in one place
server/ingest/faceit/webhook.test.js   BUILT: door policy, in the npm test chain
server/ingest/hltv/sources/faceit.js   the source: discover + fetchArchive (sections 5, 6)
server/ingest/hltv/faceitTeams.js      applyFaceitTeams + tests (section 7)
server/ingest/hltv/faceitApi.js        thin typed client: data(), exchangeDemoUrl(), one fetch wrapper
```

The receiver lives in the API server process and the rest lives in the
ingester process; they share nothing but the spool directory and the env block.
That split is why `ingest/faceit/config.js` is separate from
`ingest/hltv/config.js` rather than merged into it.

The directory being called `hltv/` is now a lie, since it holds the shared core
plus three sources. A mechanical rename to `server/ingest/` (core) is worth a
small standalone commit, but nothing in this plan depends on it (section 12).

---

## 3. Two modes, one ledger

### 3.1 Live and backfill

- **Live**: webhook says a demo is ready, the row is ingested minutes later.
  This is the "once the demo finishes" requirement, and it also neutralizes
  FACEIT's demo retention window (demos do not stay downloadable forever):
  we take each demo while it is certainly still warm.
- **Backfill / safety net**: `discover()` polls the configured championships'
  past matches. Run once for history, then on an interval (default 15 min) as
  the catch-all for missed or restricted webhooks. Discovery is idempotent, so
  webhook rows and poll rows merge by match id without duplication.

Both modes produce identical ledger rows; the pipeline cannot tell them apart.

### 3.2 Ledger row and states

FACEIT's downloadable unit is **one map demo**, not a match archive, so the
row unit changes from the HLTV plan: **one row per demo file**, keyed
`<match_id>#<map_number>`, carrying shared match metadata. `fetchArchive`
stays a one-row-one-file function and `process.js` unpacks exactly one `.dem`
per row.

```jsonc
{
  "matchId": "1-cb038819-b0d0-4471-b25c-0e7468ab1eb1#2",
  "source": "faceit",
  "faceitMatchId": "1-cb038819-b0d0-4471-b25c-0e7468ab1eb1",
  "mapNumber": 2,
  "resourceUrl": "https://demos.faceit.com/cs2/1-cb038819-...-1-2.dem.zst",
  "championship": { "id": "...", "name": "..." },
  "organizerId": "...",
  "playedAt": "2026-08-08T19:04:11Z",          // finished_at of the match
  "bestOf": 3,
  "factions": [
    { "faceitId": "...", "name": "...", "players": [{ "nickname": "...", "steamId64": "..." }] },
    { "faceitId": "...", "name": "...", "players": [ ] }
  ],
  "state": "discovered",
  "attempts": 0, "lastError": null, "demoIds": [], "needsReview": false
}
```

States are the HLTV set plus one:

```
awaiting_demo -> discovered -> downloading -> downloaded -> parsing
                                          -> ingested -> cleaned
awaiting_demo -> demo_missing        (terminal: never uploaded / aborted)
any           -> failed_permanent    (attempts >= 3)
ingested      -> needs_review        (naming unresolved)
```

`awaiting_demo` is a **match-level** placeholder created when a match is known
finished but `demo_url` is still empty (poll saw it before the upload, or
`match_status_finished` arrived). Re-check with backoff (1, 2, 5, 10, 30, 60
min); when `demo_url` fills in, replace it with per-demo `discovered` rows.
After 48 h, `demo_missing` with the reason kept. Aborted/cancelled events close
it immediately.

All the HLTV restart-safety rules apply verbatim: transition written before
work, `attempts >= 3` goes terminal, `cleaned` never revisited, orphan sweep at
startup.

---

## 4. The webhook receiver

A dumb, fast spool writer in the existing API server. It does no FACEIT calls,
no parsing, no ledger writes; the ingest service owns the ledger (single
writer), the receiver owns nothing.

```
POST /api/ingest/faceit/webhook
```

1. Compare `AIM4_FACEIT_WEBHOOK_HEADER`'s value constant-time against
   `AIM4_FACEIT_WEBHOOK_SECRET`. Mismatch: 401, log, done. This is our only
   authentication of FACEIT, so it is not optional.
2. Body sanity: JSON, has `event` and `payload.id`. Garbage: 400.
3. Filter: `event` in our set, `payload.game == "cs2"`, and
   `payload.entity.id` in the configured championship list (or organizer in
   the organizer allowlist). Non-matching: **200 and drop**, so FACEIT does
   not retry events we chose to ignore.
4. Write the raw body to `AIM4_FACEIT_SPOOL_DIR/<event>-<payload.id>-<retry_count>.json`
   with write-and-rename. Filename keyed on match id, not transaction id, so
   redeliveries overwrite instead of piling up.
5. 200 immediately. Total budget ~1 ms of work; never block on downstream.

The ingest service polls the spool (or fs-watches it) as a discovery input:
read file, `GET /matches/{id}`, upsert ledger rows, delete file. A spool file
that fails to process stays for the next pass; the poll loop is the backstop
for a spool that goes stale.

Duplicates are structurally harmless: upserting the same match twice hits
idempotent discovery, and a row past `discovered` is never demoted.

**Ops note**: the endpoint must be publicly reachable before the App Studio
subscription is worth creating, or the first deliveries just fail into
FACEIT's retry policy. Deploy the route, confirm it answers, then create the
subscription and watch a real event arrive (build order step 6).

Filling in the App Studio form, field by field:

| Field | Value |
|---|---|
| Subscription type | **Organizer** (matches are organizer-scoped; user/game subscriptions do not carry tournament matches) |
| Entities | The organizer(s) running the target tournaments. Yours resolve immediately; someone else's may be restricted, which is open question 1. |
| Events | `match_demo_ready` at minimum; `match_status_finished`, `match_status_aborted`, `match_status_cancelled` for the `awaiting_demo` bookkeeping in 3.2. All four are already accepted by the receiver. |
| Callback URL | `https://<backend-origin>/api/ingest/faceit/webhook` — the **Node backend** origin (`VITE_API_URL`), not the static site. The static host does not run this route. |
| Security header name | `X-Aim4-Webhook-Secret` (must equal `AIM4_FACEIT_WEBHOOK_HEADER`) |
| Security header value | The generated secret (must equal `AIM4_FACEIT_WEBHOOK_SECRET`) |
| Security query string name/value | Leave blank. Only needed if a proxy strips custom headers; the receiver supports it as an alternative, not an addition. |

---

## 5. Discovery (`sources/faceit.js`)

Input: `AIM4_FACEIT_CHAMPIONSHIPS`, the hand-picked championship ids. Optional
convenience: `AIM4_FACEIT_ORGANIZERS`, expanded to that organizer's cs2
championships via `GET /championships?game=cs2` at startup.

For each championship:

1. `GET /championships/{id}` once: confirm it exists, record name + organizer,
   fail loudly on a typo'd id rather than silently discovering nothing.
2. Page `GET /championships/{id}/matches?type=past&limit=100&offset=...`.
3. Per match with `status == FINISHED`, honoring `--since` / `--until` against
   `finished_at`: `GET /matches/{match_id}`, then
   - `demo_url` non-empty: upsert one `discovered` row per entry, `mapNumber`
     from array position (1-based).
   - `demo_url` empty: upsert `awaiting_demo`.
4. The spool (section 4) feeds this same per-match step for live events.

Map identity note: `demo_url` order is taken to be map-play order, but the
authoritative map name comes from the parsed demo itself (`demo.map`), exactly
like the HLTV plan's "map by name, not file order" rule. The parse is the
ground truth; `mapNumber` is bookkeeping, not naming.

Pacing: sequential requests, ~2/s, `Retry-After` honored. A championship of
100 finished BO3s is ~101 requests, done in under a minute.

---

## 6. Download (`fetchArchive`)

Per row, inside the existing 3-slot batch loop:

1. `discovered -> downloading`.
2. `POST /download/v2/demos/download` with the row's `resourceUrl`. This is the
   moment a scope/quota problem surfaces: 401/403 stops the run with an
   operator message (section 0), 429 backs off per `fetcher.js`.
3. `GET` the signed URL, **streamed to disk** at
   `$WORK_DIR/<matchId>/<original filename>`; never buffered.
4. Verify: non-zero size, size under `--max-archive-bytes` (default 2 GB), and
   magic bytes match the extension: zstd `28 B5 2F FD` for `.zst`, gzip
   `1F 8B` for legacy `.gz`. An HTML error page saved as a demo must die here,
   not in the parser.
5. `downloading -> downloaded` with `archiveBytes`.

Retries re-run the exchange (step 2), since the old signed URL may have
expired mid-flight. `Range` resume applies only within one signed URL's
lifetime; across attempts, restart the file.

Concurrency 3, batch cooldown seconds not minutes: this is an authenticated
API we were granted, not a site we are tiptoeing around. The honest
`User-Agent` (`aim4.io-ingest/1.0 (+https://aim4.io; contact@aim4.io)`) stays;
it is just as valuable with a partner API as with a scrape target.

---

## 7. Unpack, parse, name, ingest

Per the HLTV plan section 7, with the match-level loop collapsed to one demo:

1. `downloaded -> parsing`.
2. `unpackUpload` extracts the single-stream `.zst`/`.gz` to one `.dem`
   (already supported, already filters junk entries).
3. `parseDemo(demoPath, { onProgress })`.
4. **`applyFaceitTeams(demo, row)`** before anything else touches the demo,
   for the same reason as ever: `shortIdFor` hashes the team *name* into every
   round id, so names must be right before `materializeDemo` runs
   (HLTV plan section 2 has the full argument).
5. `ingestDemo(SHARED_LIBRARY, newDemoId(), demo, meta)` with
   `meta.source = 'faceit'` and the provenance block below.
6. `parsing -> ingested`, or `needs_review` on `confidence: 'none'`.

`applyFaceitTeams` is `applyHltvTeams` with better inputs. Both factions come
with SteamID64 rosters, so:

- Score both assignments of parsed sides to factions by SteamID64 overlap of
  `demo.rounds[0].players` against `row.factions[].players[].steamId64`.
- Accept at >= 3 of 5 on both sides with a clear margin:
  `confidence: 'roster'`. Expected to be the outcome ~always; nickname
  fallbacks and score heuristics from the HLTV resolver are not ported unless
  real data shows they are needed.
- Otherwise `applied: false`, ingest with parser naming, `needs_review`, never
  guess. (Realistic cause: a stand-in playing on someone else's FACEIT
  account.)

Provenance on the record, mirroring `record.hltv`:

```js
record.faceit = {
  matchId, mapNumber,
  championship: { id, name }, organizerId,
  faceitUrl: `https://www.faceit.com/en/cs2/room/${matchId}`,
  playedAt,
  team1: { name, faceitId }, team2: { name, faceitId },
  confidence
};
```

Parse concurrency stays at the server default of 1
(`AIM4_INGEST_PARSE_CONCURRENCY`); FACEIT demos are the same 400-570 MB
uncompressed CS2 demos the parser already handles in 15-25 s with an 8 GB
heap.

---

## 8. Delete, and what we may keep

Stage 4 unchanged: once a row is `ingested`, delete the extracted `.dem`, the
downloaded `.dem.zst`, and the per-match work directory; `ingested -> cleaned`;
deletion driven only by ledger state; startup orphan sweep for crash debris.
The shredder model from the HLTV plan is exactly the "download, extract, parse,
delete" requirement, so there is nothing to add, only something to not break.

Compliance framing, worth stating because this access was *granted*:

- Raw demos and signed URLs are **never redistributed, never stored past the
  parse**. What persists is aim4's derived round data plus the provenance
  block, which names its source honestly.
- Whatever quota/terms the acceptance email states are config, not vibes:
  encode a daily exchange budget in `config.js` if one was given, and stop
  cleanly at the cap.
- If FACEIT ever answers an exchange with a revocation-style error for content
  taken down, the row goes `demo_missing`, not retried forever.

---

## 9. Scale and latency reality check

Per map: CS2 demo ~400-570 MB raw, zstd on the wire plausibly 100-250 MB;
parse 15-25 s; round output ~1-2 MB. Per BO3 match: ~2.4 maps average.

| Quantity | Estimate |
|---|---|
| One 100-match BO3 championship | ~240 demos, ~25-60 GB streamed |
| Peak transient disk (3 slots) | ~2-3 GB |
| Parsed output for that championship | ~0.3-0.5 GB |
| Wall clock, download-bound at ~50 Mbps | ~2-3 h per championship |
| Live mode: demo uploaded -> rounds visible | ~2-6 min (download + parse + ingest) |

Same two conclusions as HLTV: disk is a non-issue, the parser and the wire are
the budget. `MAX_BYTES` (20 GiB library cap in `demoStore.js`) survives several
championships but is the constant to watch once this runs continuously.

And the same instruction: **measure before trusting this table**. Build order
step 1 replaces every number here with ones from a real FACEIT demo on real
hardware.

---

## 10. Configuration

Additions to the existing `AIM4_INGEST_*` block in `.env.example`:

```bash
AIM4_FACEIT_API_KEY=                 # server-side key; Bearer for Data + Downloads
AIM4_FACEIT_WEBHOOK_HEADER=X-Aim4-Webhook-Secret
AIM4_FACEIT_WEBHOOK_SECRET=          # long random; same value in App Studio subscription
AIM4_FACEIT_CHAMPIONSHIPS=           # comma-separated championship ids (the tournaments)
AIM4_FACEIT_ORGANIZERS=              # optional: auto-expand to their cs2 championships
AIM4_FACEIT_SPOOL_DIR=/data/faceit-spool
AIM4_FACEIT_POLL_MINUTES=15          # safety-net poll; 0 disables
# reused unchanged: AIM4_INGEST_STATE_DIR, AIM4_INGEST_WORK_DIR,
# AIM4_INGEST_PARSE_CONCURRENCY, AIM4_INGEST_MAX_ARCHIVE_BYTES
```

CLI, following the established shapes:

```bash
# Discovery only, no downloads: prove the championship ids are right.
node server/ingest/hltv/cli.js discover --source faceit \
  --championship 0f9b2b8e-... --dry-run

# Three matches into a scratch library, keep sources for inspection.
node server/ingest/hltv/cli.js run --source faceit \
  --championship 0f9b2b8e-... --limit 3 --library scratch --keep-sources --verbose

# One match, for debugging naming.
node server/ingest/hltv/cli.js run --source faceit --match 1-cb038819-... --verbose

# Production: the long-running service, webhook spool + poll loop.
node server/ingest/hltv/cli.js serve --source faceit \
  --state-dir /data/faceit-ingest --work-dir /data/faceit-work
```

`serve` is the one genuinely new verb: `run` drains the queue and exits,
`serve` stays up consuming the spool and running the poll interval. Same
Coolify deployment rules as HLTV section 10: own process, own service, single
instance via lock file, graceful SIGTERM, status file for the admin panel,
disk headroom check.

---

## 11. Build order

Sequenced around the one thing we do not control: **Downloads approval**. Steps
1-4 and 6 need only the server-side key we already have, so the pipeline can be
finished, tested and deployed while the application sits in the queue. Step 5
is the first that needs the grant, and step 1(d) is how we find out it landed.

1. **Prove what we can, by hand, today.** Four curls against a real finished
   match from a target championship. Record what comes back, and keep the JSON
   bodies as fixtures for steps 2-4. (a) through (c) should pass now; **(d) is
   expected to fail with 401/403 until the application clears**, and re-running
   it is the cheapest approval check there is. When it does pass, note the
   signed URL's `X-Amz-Expires`.

   ```bash
   # a. Key valid against Data API
   curl -s -H "Authorization: Bearer $FACEIT_API_KEY" \
     "https://open.faceit.com/data/v4/championships/$CHAMPIONSHIP_ID"

   # b. Matches of the championship
   curl -s -H "Authorization: Bearer $FACEIT_API_KEY" \
     "https://open.faceit.com/data/v4/championships/$CHAMPIONSHIP_ID/matches?type=past&limit=5"

   # c. Match details: note demo_url array, factions, rosters' game_player_id
   curl -s -H "Authorization: Bearer $FACEIT_API_KEY" \
     "https://open.faceit.com/data/v4/matches/$MATCH_ID"

   # d. THE test: exchange succeeds only if the Downloads scope is truly on this key
   curl -s -X POST "https://open.faceit.com/download/v2/demos/download" \
     -H "Authorization: Bearer $FACEIT_API_KEY" -H "Content-Type: application/json" \
     -d "{\"resource_url\":\"$DEMO_RESOURCE_URL\"}"

   # e. Fetch + verify + parse one demo end to end with the existing parser
   curl -L -o demo.dem.zst "$SIGNED_URL"
   ```

   If (a)-(c) fail, the key itself is wrong. If only (d) fails after the
   approval email arrives, resolve with FACEIT support which app/key the grant
   is on.
2. **`faceitApi.js`.** Thin client over the three calls, one retry/backoff
   path, tested against the step-1 fixtures. *No Downloads access needed.*
3. **`faceitTeams.js` + tests.** Resolver on fixtures: clean roster, swapped
   sides, stand-in, empty roster forcing `applied: false`. Pure, no network.
4. **`sources/faceit.js` `discover()`** against fixtures; then one real
   supervised `discover --dry-run` on a target championship. This proves the
   whole discovery half, including that `demo_url` is populated on real
   matches, without downloading anything. *No Downloads access needed.*
5. **`fetchArchive`** — the first step that needs the grant. One real demo,
   watched; then `run --limit 3 --library scratch` end to end, checking naming
   by hand and that cleanup left the work directory empty.
6. **Webhook receiver + spool.** *(Built: `server/ingest/faceit/`, route
   `POST /api/ingest/faceit/webhook`, wired in `server/index.js`, secret check
   and event filter unit-tested in `webhook.test.js`.)* Remaining: deploy the
   route so the URL answers publicly, create the App Studio subscription
   pointing at it with the secret set, then capture the first real
   `match_demo_ready` payload as a fixture and reconcile it against section
   1.2's assumed shape. *No Downloads access needed*, and worth doing early:
   it is what proves the tournaments we care about actually deliver events to
   us, which is open question 1.
7. **`serve` mode** wiring spool + poll into the pipeline. Soak on one live
   tournament day: match finishes, rounds appear minutes later, sources gone,
   ledger clean after a mid-run kill.
8. **Deploy on Coolify** next to (not inside) the API server, poll enabled as
   the webhook safety net. Then backfill the target championships' history
   with `run --since ...`.

While the application is queued, steps 2, 3, 4 and 6 are the whole job. What
that leaves is a system that knows about every finished match in the target
tournaments within minutes and has a ledger row waiting for each demo; turning
on the grant then only unblocks `fetchArchive`, and the backlog drains by
itself.

---

## 12. Open questions

1. **Whose organizers are the target tournaments?** Webhook subscriptions for
   "other organizers" carry "potential privacy restrictions" per the docs. If
   a target tournament's organizer cannot be subscribed to, live mode degrades
   to the 15-minute poll, which still satisfies "automatically after the
   match". Test in build order step 6 and record which organizers worked.
2. **`match_demo_ready` payload contents.** Assumed to carry match id + entity
   only; the design pulls everything else from `GET /matches/{id}`. Confirm
   with the captured payload and simplify later if it carries more.
3. **Downloads quota.** Whatever the acceptance email says becomes a config
   cap; if it says nothing, pick a self-imposed daily budget and note it.
4. **Signed URL TTL** and **demo retention window**: both undocumented, both
   measurable. TTL decides nothing (we exchange per attempt); retention
   decides how deep `--since` can reach on backfill, so prioritize recent
   history first.
5. **Entity types other than championship.** If a target event is actually a
   hub or legacy tournament, discovery needs `/hubs/{id}/matches` or the v1
   endpoints. The ledger and pipeline do not care; only `discover()` grows.
6. **Rename `server/ingest/hltv/` to `server/ingest/`** now that it holds the
   shared core and three sources. Mechanical, own commit, do it when quiet.
7. **Ownership and visibility** of ingested demos: same question as HLTV plan
   13.4 (legacy `@artysan` identity vs a system account), now with a `faceit`
   source in play. Decide once for both sources.
8. **CSGO-era FACEIT demos** (`/csgo/` resource URLs, `.dem.gz`): the parser
   targets CS2; `game != "cs2"` is filtered at discovery. Revisit only if a
   backfill target predates CS2.
