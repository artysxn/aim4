# VOICE-COMMS-PLAN

TeamSpeak voice comms recorded on the user's PC, transcribed locally for free,
packed into a small comms file, and uploaded to any game in the replay viewer via
a new microphone button. In playback: caption above the player droplet in 2D, a
player comms sidebar in 3D.

Status: v5, part-built (2026-08-27). The site half is built and verified, as is
the recorder's download and auto-update feed. The recorder ships as one
self-contained .exe served by aim4; its capture core is not written. See §10.
v4: TeamSpeak only (in-game comms explicitly out of scope), recording controlled
from the companion app itself (no chat commands), sync via a spoken
"three, two, one" countdown against the round-1 freeze clock, output is a
standalone comms file attached per game inside the viewer.

---

## 1. Product shape

1. A small **aim4 recorder app** runs on the user's PC. The user clicks **record**
   (app window/tray, optional hotkey) and it captures **the entire TeamSpeak
   channel, each speaker as a separate track** (5 + coach headroom).
2. **Sync protocol:** in round 1, the recording user speaks **"record, three,
   two, one"** matching the freeze-time clock at 3 s, 2 s, 1 s. That's the whole
   ceremony — the anchor is embedded in the output file (e.g. "countdown ends
   13 s into the recording"), and the viewer later pins it to the round-1
   freeze-end tick of whatever replay it's attached to (e.g. tick 4991). If the
   phrase appears more than once in the recording, **the first instance wins**.
3. When the user **stops recording**, the app transcribes locally (one language
   per session, set in the app or auto-detected), finds the countdown in the
   recorder's own track, and packs transcript **plus compressed per-speaker
   audio** into one file — **`<name>.aim4comms`, target ≤ 2 MB** — ready to
   upload to any game. Full-quality audio stays on the PC.
4. In the replay viewer, a **ninth button — a microphone — joins the toolbar**.
   Click it → dialog → drag/drop or pick the `.aim4comms` file for that game →
   map the TS speakers to roster players (pre-filled after the first time) → done.
   The file's embedded anchor does the sync automatically (recording time ↔ tick);
   a ±nudge stays available for fine trim.
5. Playback:
   - **2D:** what a player is saying appears in a small pill above their droplet
     while they speak (plus ~2 s linger), fading out.
   - **3D:** a sidebar lists the players with a speaking indicator and the
     current/last line for each.

Scope: **TeamSpeak talk only.** In-game comms (Valve MM, FACEIT) are explicitly
not measured. (Researched and parked: FACEIT demos do embed per-player voice and
MIT extractors exist, but that's a different feature — noted in §9 for someday.)

Later (not v1): synced voice playback, voice-activity strip on the timeline.

---

## 2. Research findings

### 2.1 Capturing per-speaker audio from TeamSpeak

There is **no existing open-source TeamSpeak multitrack recorder** (Discord has
Craig; TeamSpeak has nothing — the popular TS bots are all music playback bots).
We build a small one, hosted on the user's PC. Two viable capture paths:

| Path | How | Pros | Cons |
|---|---|---|---|
| **A. Headless bot client** (recommended) | [tsclientlib](https://github.com/ReSpeak/tsclientlib) (Rust, MIT/Apache-2.0) implements the full TS3 client protocol including voice. Incoming voice arrives as `StreamItem::Audio` events where each packet carries the sender: `AudioData::S2C { from, .. }` — per-speaker separation is native. Its `AudioHandler` decodes Opus per client with jitter handling. The repo ships an [audio example](https://github.com/ReSpeak/tsclientlib/blob/master/tsclientlib/examples/audio.rs) that is ~80% of the recorder already. | Tiny (single binary, ~20 MB RAM, near-zero CPU — Opus frames stored without decoding). Runs fine alongside the game. Joins the channel as a visible extra client. | Unofficial protocol implementation; could break on a TS server update. No auto-reconnect out of the box. |
| **B. TS3 client plugin** (fallback) | Official [TS3 client plugin SDK](https://github.com/teamspeak/ts3client-pluginsdk): `onEditPlaybackVoiceDataEvent(serverConnectionHandlerID, clientID, samples, ...)` delivers **unmixed per-client PCM** before mixing — the documented way to record individual clients ([docs](https://teamspeakdocs.github.io/PluginAPI/client_html/ar01s18.html)). Plugs into the TS3 client the user already runs; the companion app would talk to the plugin locally. | Official API, stable. No extra client in the channel. | C/C++ plugin inside the TS3 client GUI; TS5/6 clients have no plugin API. |

Fallback library if Rust is a problem: [ts3j](https://github.com/Manevolent/ts3j)
(Java, same full-client protocol).

Notes on path A:
- TeamSpeak only transmits voice while a client's VAD/push-to-talk is open, so the
  packet stream is **inherently pre-segmented into utterances** — no VAD needed,
  and utterance timestamps come for free.
- TS voice is Opus at 48 kHz. The recorder appends raw Opus frames to disk (no
  decode). Recording cost is I/O only — nothing competes with the game.
- The bot sets the TS "recording" flag so everyone in the channel sees it.

### 2.2 Transcription (free, local, multilingual)

| Engine | Verdict |
|---|---|
| **faster-whisper** (SYSTRAN, MIT; CTranslate2 port of OpenAI Whisper) | **Recommended.** Same accuracy as openai/whisper, ~4x faster. On a gaming PC's NVIDIA GPU, `large-v3-turbo` runs ~20–60x real-time — a full map of speech transcribes in ~1–3 min. CPU int8 fallback: turbo ~2–4x real-time, `small` ~6x. ~99 languages, word timestamps. |
| openai/whisper (the repo the user linked) | Same models, reference implementation, slower. Use faster-whisper instead. |
| whisper.cpp | Same models in C++; easiest to embed/ship inside the app (no Python; CUDA/Vulkan builds for Windows, Metal for Mac). Real packaging candidate. |
| [Handy](https://github.com/cjpais/handy) | Desktop push-to-talk **dictation app** — wrong shape, but validates the engines (uses whisper.cpp and Parakeet). |
| Parakeet TDT v3 | Fast CPU, but 25 European languages only — **no Chinese**, which the language list requires. Skip. |
| Vosk | One model per language, worse accuracy. Skip. |

Everything is free and runs offline. No paid API anywhere in the pipeline.

Quality levers that matter for CS comms:
- **Fixed session language.** One language per recording (app setting, else
  auto-detected once), passed as Whisper's `language` — removes the flakiest part
  of multilingual ASR (per-utterance detection) entirely.
- **`initial_prompt` vocabulary biasing.** Feed map callouts + player nicknames
  as the prompt ("Banana, Apps, Truck, Xbox, retake, eco, AWP, ...", per map).
  English callouts appear inside every language as loanwords; the glossary keeps
  their spelling stable regardless of session language.
- Segment merging: utterances separated by <2 s merge into one chunk (max ~30 s)
  before transcription — Whisper does better with context than 0.4 s fragments.

---

## 3. Architecture

```
TeamSpeak channel (whole channel, per-client voice packets)
        │
┌───────▼──────────────────────────────────────────┐
│ aim4 recorder app (user's PC, window/tray)       │
│  [Record] ──► opus segments per speaker          │
│  [Stop]   ──► 1. transcribe (whisper, local GPU) │
│               2. find "three, two, one" anchor   │
│               3. pack <name>.aim4comms (≤ 2 MB)  │
│  audio stays local                               │
└───────┬──────────────────────────────────────────┘
        │ user has a file, attachable to any game
┌───────▼──────────────────────────────────────────┐
│ replay viewer — new microphone button (9th)      │
│  dialog: drag/drop .aim4comms                    │
│   → speakers ↔ roster players (remembered)       │
│   → sync: anchorMs ↔ round-1 freeze-end tick     │
│  uploads to server, stored with the replay       │
│  2D droplet pills · 3D comms sidebar             │
└──────────────────────────────────────────────────┘
```

### 3.1 Recorder app

- **Separate codebase** (`aim4-comms-recorder` repo). It shares nothing with the
  aim4 repo except the contract: the `.aim4comms` format (versioned in the file
  itself) and the upload API. Different language (Rust), different artifacts
  (installers), different release cadence and CI (Windows builds, update feed) —
  keeping it out of the main repo is strictly simpler.
- Suggested shape: **Tauri** — Rust core (tsclientlib recorder + whisper.cpp
  bindings) with a small webview UI, which keeps the UI in the stack the project
  already uses, and brings a **built-in signed auto-updater and installer
  bundling for free**.
- UI: TS server/identity/channel settings, session language picker, a Record/Stop
  button (optional global hotkey), and a "recent recordings" list with Open
  Folder. **No chat commands.**
- **Setup must be simple** (user-performed): download from aim4.io → enter TS
  server address (+ server password if any) and a nickname → the app generates a
  TS identity itself and connects → pick the channel from the live channel tree →
  saved. That's the whole setup; no aim4 account linking is needed in v1 because
  uploads happen in the browser via the mic button, not from the app.
- **Updates**: on launch (and daily) the app checks a static update manifest,
  shows "update available", and self-updates on click (Tauri updater; releases
  signed with our own updater key, manifest hosted on aim4.io or GitHub
  Releases). The Whisper model downloads on first run, separate from app
  updates, so app updates stay small (~10-20 MB, not 1.6 GB).
- While recording: append incoming Opus frames to the current segment of that
  speaker; a gap >200 ms closes the segment. Everyone in the channel is captured,
  whoever they are — mapping to players happens later in the viewer.
- Crash-safe: segments are append-only files; the session manifest is rewritten on
  every segment close. A crash still leaves a transcribable session.
- On Stop: transcribe → detect countdown → pack → notify "ready to upload", file
  saved to the recordings folder.

### 3.2 Sync: the countdown protocol

- In round 1 freeze time, the recording user says **"record, three, two, one"**
  on the freeze clock's 3, 2, 1 (the cue word "record" just before). Freeze end
  (round live) is therefore ~1 s after "one".
- Detection: the app scans the transcript of the **recording user's own track**
  (their TS UID is known from config) for the cue word followed by three
  number-words in sequence ~1 s apart. Number-word sets exist for all 13
  supported languages ("three two one", "tre to en", "tri dva odin", …); the cue
  matches "record" plus common transliterations Whisper may produce in non-Latin
  scripts (e.g. "рекорд"). Word-level timestamps give the anchor to ~±0.1 s.
- **If the phrase occurs multiple times, the first instance is the anchor.**
- The anchor is embedded in the file: `sync: { anchorMs, kind: "freeze-end-r1" }`
  where `anchorMs` = end of "one" + 1 s in recording time.
- Viewer side: round-1 freeze-end tick is already derivable from the replay's
  events (`roundClock` territory) — attaching is then pure arithmetic:
  `tick(t) = freezeEndTick + (t - anchorMs) * tickRate / 1000`. CS2 demos tick
  through pauses in real time, so one anchor holds for the map.
- Fallback: if nothing matches, the attach dialog lists the recorder's utterances
  from the first minutes and the user clicks the countdown; a ±0.1 s / ±1 s nudge
  is always available. Convention: one recording per map (first-instance-wins
  makes a multi-map recording sync only to its first map).

### 3.3 The `.aim4comms` file

A ZIP container (not base64-in-JSON — base64 would add +33% to the audio):

```
name.aim4comms  (zip)
  comms.json                  # transcript + sync + speakers, ~100-300 KB raw
  audio/<tsUid>.ogg           # per-speaker speech-only Opus, low bitrate
```

`comms.json`:

```json
{
  "version": 1,
  "name": "vs-navi-m2",
  "recordedAt": "2026-08-27T19:30:00Z",
  "lang": "no",
  "model": "faster-whisper-large-v3-turbo",
  "sync": { "anchorMs": 13000, "kind": "freeze-end-r1" },
  "speakers": [{ "tsUid": "base64uid", "nickname": "playerA", "talkMs": 412000 }],
  "audio": { "codec": "opus", "bitrate": 8000, "segments": [
    { "speaker": "…", "recMs": 12000, "durMs": 2140, "byteOff": 0 } ] },
  "utterances": [
    { "speaker": "base64uid", "startMs": 12000, "endMs": 14100,
      "text": "de pusher banana, fall tilbake", "conf": 0.83 }
  ]
}
```

**Hitting the ≤ 2 MB target.** The audio is speech-only (TS transmits nothing
during silence), so a map is ~40–60 minutes of actual talk across all speakers,
not 5 × 40 min of wall clock. Re-encoded to mono Opus in voip mode:

| Opus bitrate | 45 speech-min | 60 speech-min | Quality |
|---|---|---|---|
| 16 kbps | 5.4 MB | 7.2 MB | clean wideband speech |
| 12 kbps | 4.1 MB | 5.4 MB | clearly fine |
| 8 kbps  | 2.7 MB | 3.6 MB | narrowband, fully intelligible |
| 6 kbps  | 2.0 MB | 2.7 MB | Opus floor, muffled but understandable |

So the packer works **budget-first**: measure total speech duration, pick the
highest bitrate in 6–16 kbps that lands under 2 MB (typical scrim ≈ 45 speech-min
→ 6–8 kbps → ~2 MB). A very chatty 60-min-speech session at the 6 kbps floor
comes out ~2.5 MB — accepted overflow rather than dropping below intelligible.
Getting *guaranteed* sub-2 MB at better quality would need a neural speech codec
(Lyra v2 at 3.2 kbps ≈ 1.4 MB), which means shipping a WASM decoder in the
viewer — parked as a P3 option, not v1. Embedded audio is for spot-checking
transcripts and synced playback; it is not used for transcription (that already
happened at full quality).

Raw full-quality Opus segments (~20–30 MB/map) stay on the PC per config: keep,
or delete after packing. Kept audio allows re-transcribing with a bigger model
later.

### 3.4 Viewer: the microphone button

- New ninth toolbar button (microphone icon) in the replay viewer, follows the
  CLAUDE.md copy rules like all UI.
- Click → dialog:
  1. **Drop zone** — drag/upload the `.aim4comms` file (or pick a previously
     uploaded one to reuse/detach).
  2. **Mapping** — file's speakers (nickname + talk time) ↔ roster players of one
     team, coach mappable to a sidebar-only slot. TS UIDs are stable, so mappings
     are remembered server-side and pre-filled; typically zero clicks after the
     first game.
  3. **Sync check** — shows the detected anchor ("countdown at 0:13"); nudge
     buttons if needed; candidate picker if the file has several.
- Upload: `POST /api/replays/:id/comms` stores the **whole `.aim4comms` file**
  (compressed voice audio + transcription, ~2 MB) plus mapping + final offset
  with the replay (same visibility model as the replay). `GET` returns it to the
  viewer. No server-side processing — validate the format version, store, serve.
- Mic button shows an active state when the replay has comms attached; reopening
  the dialog allows replace/detach/delete.

### 3.5 Viewer rendering

Both views read the same derived stream: `utterancesAtTick(tick)` (binary search
over utterances converted to tick ranges via the anchor, +2 s linger, tick math
via `timing.tickRate` as in `playback.js`).

- **2D (`radarRenderer.js`)**: while a mapped player has an active utterance,
  draw a rounded pill above the droplet (the renderer already has `roundPill`):
  player color accent, truncated ~40 chars / max 2 lines, alpha fade over the
  linger. Stack at most 2 pills per cluster, newest wins. Viewer toggle "Comms".
- **3D (`view3d.js`)**: DOM overlay sidebar (not WebGL text), right edge: one row
  per mapped player — name, speaking dot, current/last line dimming with age.
  Fixed roster order, coach last.

## 4. Speaker identity

- Speaker key end-to-end: TS identity UID (stable; nicknames are display-only).
- Mapping targets the same roster player entities replays already use, so comms
  stats later (talk time per round, who calls most) can join with existing
  per-player stats.

## 5. Language handling

**One language per recording.** Teams don't switch mid-match, so language is a
session-level setting in the app (or auto-detected once from the longest speech
chunk), applied to every speaker and utterance. No per-utterance detection.

Required coverage — Russian, Swedish, Ukrainian, Chinese, English, Portuguese,
Spanish, Norwegian, Danish, Finnish, Polish, Romanian, French — is fully inside
Whisper's supported set. Quality tiers:

- Strong even on smaller models: English, Spanish, Portuguese, French, Polish,
  Russian.
- Want `large-v3-turbo` (or large-v3): Norwegian, Danish, Swedish, Finnish,
  Ukrainian, Romanian, Chinese.

The list is also why the engine locks to Whisper: Parakeet v3 has no Chinese,
Vosk needs 13 models. One Whisper model handles all of it. The countdown detector
carries a number-word table for the same 13 languages.

## 6. Size + resource budget

Baseline per map: ~40 min, 5 speakers, ~30% talk density ≈ 60 speaker-minutes of
speech. TS Opus voice ≈ 6–8 KB/s while talking.

| What | Size | Where it lives |
|---|---|---|
| `.aim4comms` file (transcript + budget-encoded audio) | **≤ 2 MB target** (~1.5–2.5 MB) | server, with the replay |
| Raw captured Opus segments (full quality) | ~20–30 MB | user's PC only |

Server-side cost is ~2 MB per game (see §3.3 for the bitrate budget table). The
raw audio never leaves the PC.

Recorder machine costs:

| Component | Cost |
|---|---|
| Recording while gaming | ~20 MB RAM, I/O only — no decode, no ASR during play |
| Whisper model on disk (one-time) | turbo ~1.6 GB (small fallback ~250 MB) |
| Transcription on Stop | GPU: ~1–3 min per map; CPU turbo int8: ~15–30 min, ~2 GB RAM; CPU small: ~10 min, ~0.5 GB |
| aim4 server | stores KB-sized JSON; zero compute |
| Money | 0. All engines local and MIT-licensed. No paid AI anywhere. |

## 7. Phases

**P0 — capture proof**
Fork the tsclientlib audio example → join the team's actual TS server, record a
2-person call from the app (Record/Stop), verify per-speaker segments and
timestamps. This is the riskiest piece (unofficial protocol lib) — prove it
before building anything else.

**P1 — pipeline + viewer**
App transcribe-on-stop (turbo), countdown detection, `.aim4comms` packing;
server endpoints (store/fetch per replay); viewer microphone button with
drop-zone, mapping (remembered), sync check; 2D droplet pills + 3D sidebar.
Deliverable: record a real scrim, drag the file onto the game, read the comms.

**P2 — quality**
Per-map callout glossary, re-transcribe with a bigger model (audio kept locally),
timeline voice-activity strip, multi-map recordings (anchor per map), app
auto-update of nickname→player mapping hints.

**P3 — voice playback**
The audio is already inside every uploaded file, so this is viewer work only:
synced playback of the embedded per-speaker tracks (per-player mute/volume).
Note: Ogg/Opus decodes natively in Chrome/Firefox; Safari needs a small WASM
opus decoder fallback. Optional here: evaluate Lyra v2 (neural codec, ~3 kbps)
if guaranteed sub-2 MB at higher voice quality becomes worth a WASM decoder.

## 8. Consent + access

- The bot sets the TS recording flag and is visible in the channel while
  recording; channel description notes recording when the bot is present.
- Uploaded comms inherit the replay's visibility (team-scoped); replace/detach/
  delete in one action from the mic dialog; tier-gateable via the entitlements
  catalogue later.

## 9. Risks, parked ideas, open questions

Risks:
1. **tsclientlib breakage** against newer TS servers. Mitigation: P0 proof against
   the team's actual server; fallbacks ts3j or the official client plugin (path B).
2. **Countdown detection misses** (mumbled, wrong language config, clock not at
   3/2/1). Mitigation: candidates list + manual pick + nudge in the dialog; the
   protocol is also self-healing — re-record habit forms fast.
3. **Whisper quality on the harder languages** (Nordic, Finnish, Ukrainian,
   Romanian) for fast overlapping comms. Mitigation: large-v3 re-transcribe
   option, callout glossary.
4. **App packaging** (Rust + whisper runtime + opus on Windows) is real but boring
   work; Tauri covers installer + auto-update, embedding whisper.cpp avoids
   shipping Python. One free-tier caveat: without a paid Windows code-signing
   certificate, first-time downloads trigger a SmartScreen "unknown publisher"
   warning (updater signing itself is free and unaffected). Acceptable for a team
   tool; a cert can come later.

Parked (out of scope, recorded so it isn't re-researched): FACEIT demos embed
per-player in-game voice keyed by SteamID/tick, extractable with MIT tools
([csgo-voice-extractor](https://github.com/akiver/csgo-voice-extractor),
[CS2VoiceData](https://github.com/DandrewsDev/CS2VoiceData)); Valve MM demos
carry no voice. We measure TeamSpeak talk, not in-game comms.

Open questions:
1. Which TeamSpeak server does the team run (version/host)? Needed for P0.
2. Recorder PC specs — NVIDIA GPU? Windows only, or Mac build too?
3. Countdown anchor: is "freeze clock 3-2-1" always available (scrim servers with
   short/no freeze time — count against the round-live beep instead?). Worth
   deciding the convention once and putting it in the app's UI text.
4. Should the `.aim4comms` file embed a suggested player mapping (nickname
   heuristics) or leave mapping fully to the viewer dialog?

---

## 10. Build log

### Built and verified (site half, in this repo)

| Piece | Where |
|---|---|
| `.aim4comms` format: framing, validation, decode | `shared/comms/format.js` |
| Countdown detection, 13 languages, median anchor | `shared/comms/countdown.js` |
| Anchor maths + per-frame lookup | `shared/comms/sync.js` |
| Tests for all three (incl. every language, a lookup perf bound) | `shared/comms/comms.test.js` |
| Server store: upload, sidecar, mapping, identity memory | `server/replays/commsStore.js` |
| Store tests against a scratch library | `server/replays/commsStore.test.js` |
| Endpoints (`GET/POST/DELETE .../comms`, `/file`, `/attach`) | `server/replays/routes.js` |
| Comms removed with their demo | `server/replays/demoStore.js` |
| Client API calls | `src/replays/api.js` |
| Controller + attach dialog | `src/replays/viewer/commsOverlay.js` |
| 2D droplet captions (plate, side stripe, wrap, fade) | `src/replays/viewer/radarRenderer.js` |
| Ninth toolbar button, 3D sidebar, wiring | `src/replays/viewer/timelineViewer.js` |
| `soleDemoId` so shared single rounds get comms too | `src/replays/shared/roundId.js` |
| Styles | `src/replays/replays.css` |
| Fixture generator | `tools/comms/make-fixture.mjs` |
| Conformance verifier | `tools/comms/verify.mjs` |

Verified in a browser against the built `dist` with a generated 23-round
Portuguese fixture on a real demo: the mic button appears as the ninth tool,
comms auto-load, the caption renders above the right player at the right tick
(cross-checked against an independent computation of the same timeline), and
the attach dialog shows the detected anchor with all five speakers pre-mapped.
No new console errors; no regressions in the surrounding test files.

Decisions made while building, worth knowing:

- **Container, not zip.** A length-prefixed gzip manifest plus a raw audio
  region. The library already refuses archive dependencies, and a browser can
  gunzip a slice with `DecompressionStream` but cannot open a zip without a
  library. It also means the viewer reads a ~200 KB transcript without touching
  the ~2 MB of audio behind it.
- **Utterances reference speakers by index**, not by UID string: the uid would
  otherwise be the largest thing in the file after the words.
- **Three number words, median anchor.** Each word independently estimates the
  same freeze-end instant, so the median survives one bad Whisper alignment and
  the spread between them is a free confidence signal.
- **The cue word is what makes it automatic.** Players count down constantly, so
  an uncued "three two one" is offered as a candidate and never taken on its own.
- **Comms follow the demo, not the match view.** Using `statsDemoId` would have
  hidden comms on any single round opened from a share link; round file names
  carry their demo id, so `soleDemoId()` resolves it for one round, a whole
  match, or nothing at all for a cross-demo playlist.
- **The anchor tick is resolved once and saved.** Round 1 may not be loaded when
  someone opens round 14, so the resolved tick lives on the attachment.

### Distribution: one .exe, served by aim4 (built and verified)

The recorder ships as **a single self-contained executable**. No installer, no
zip, no folder. It lives in this repo at `recorder/` and is served by this
server, because that is the only server there is.

| Piece | Where |
|---|---|
| Release store: publish, prune, roll back | `server/recorder/releaseStore.js` |
| Store tests | `server/recorder/releaseStore.test.js` |
| Update feed + download + admin publish | `server/recorder/routes.js` |
| Self-update client (check, verify, swap) | `recorder/src/update.rs` |
| Container writer | `recorder/src/comms/format.rs` |

Verified against the running server: the feed answers `{latest: null}` before
anything is published (a recorder can poll safely from day one), publishing is
admin-gated, the download serves the exe with the right headers, and the served
bytes hash exactly to the manifest's `sha256`. Simulating the updater's own
logic end to end: an older local version sees the update, the same and newer
versions do not, and a one-byte-truncated download fails the digest check.

Decisions this forced, and why:

- **Builds live in the data volume, not in the repo or the image.** Coolify
  mounts a named volume over `server/data`, so a published build survives every
  later deploy — and shipping a recorder update is an upload, not a site
  redeploy.
- **The site never compiles it.** `.dockerignore` excludes `recorder/` so it is
  not even in the build context, and `nixpacks.toml` already pins
  `providers = ["node"]`, which is what stops nixpacks noticing a `Cargo.toml`
  and trying to build it. That pin exists because `tools/cs3d-tex/` set the
  same trap once with a `.csproj`.
- **egui, not Tauri.** Tauri was chosen when an installer was assumed, for its
  installer bundling and signed updater. A single .exe removes both of those
  advantages and leaves Tauri's costs: it needs WebView2 on the machine and its
  updater is built around installer artifacts. egui compiles the UI into the
  binary with no runtime dependency, and `self_replace` handles the swap.
- **Published versions are immutable.** Recorders cache by version, so
  replacing bytes under a published number would strand whoever already has it.
  Ship a new number; `DELETE /api/recorder/releases/:version` pulls a bad one
  and the feed falls back.
- **Two safety rules on self-replacement:** verify the SHA-256 before swapping
  (a truncated download that still returned 200 would otherwise brick the app),
  and never swap mid-recording (a session holds open segment files and the
  TeamSpeak connection).
- **The download and feed are public.** The link must work before anyone has
  installed anything, and the app holds no aim4 login: uploading a recording
  happens in the browser, where the user is already signed in.

**The Whisper model cannot be in the .exe.** The exe is tens of megabytes;
`large-v3-turbo` is ~1.6 GB, or ~570 MB quantized. It downloads once on first
run with a progress bar. Pull it from Hugging Face rather than aim4: it is the
same public file for everyone, and serving hundreds of megabytes per user from
the one box that also serves the demo library is a bandwidth bill for nothing.

### Not built yet (recorder internals)

No Rust toolchain on this Mac, so **nothing under `recorder/` has been
compiled** — the Rust there is reviewed by eye, with unit tests written but
never run. Remaining, in order:

1. **TeamSpeak capture** (tsclientlib) — the riskiest assumption in the design
   and the reason it is first. Needs the team's actual server.
2. Whisper transcription over the captured segments (whisper.cpp).
3. Port the countdown detector to Rust (the JS version is the spec, and its
   tests are the acceptance criteria).
4. Opus packing to the 2 MB budget.
5. The egui window: record/stop, settings, update prompt.

The two halves meet only at the file format, and `tools/comms/verify.mjs` is
what proves they still agree — it exits non-zero on anything the site would
refuse.

### Follow-up pass: closing the loop and three real bugs

Added after the first build, all verified in the browser:

- **A way to get the recorder.** Nothing on the site linked to it, so the
  feature was unreachable for anyone who did not already have the app. The
  attach dialog's empty state now offers "Get the recorder" with the published
  version and size, fetched from `/api/recorder/latest`. That dialog is where
  someone discovers they need it, so that is where the download belongs. It
  stays hidden when no build is published rather than showing a dead link.
- **Controller and sidebar are now tested.** `src/replays/viewer/commsOverlay.test.js`
  covers what only a screenshot had checked: caption fade states, unmapped
  speakers being excluded from droplet captions but kept in the 3D sidebar,
  roster names beating TeamSpeak nicknames, the nudge direction, and the three
  button states. The sidebar's markup moved out of the viewer closure into
  `commsSidebarHtml()` so it could be tested at all.

Three bugs the tests and the browser found:

1. **The nudge ran backwards.** `+1s` moved captions *earlier* in the round,
   the opposite of every subtitle tool, and the buttons say only "+1s" with no
   explanation of direction. Flipped in `shared/comms/sync.js` so positive is
   later.
2. **A cached comms file survived being replaced.** `/comms/file` is served
   with `max-age=300`, so re-uploading a corrected recording kept showing the
   old transcript for five minutes with nothing to explain why. The viewer now
   requests `?v=<uploadedAt>`, which changes exactly when the bytes do and not
   when someone merely re-maps a speaker.
3. **An unplaceable recording looked switched on.** A file whose countdown was
   never found lit the toolbar button and said "Voice comms on" while the map
   stayed silent, which reads as broken rather than as one click from working.
   The button now has a third state, amber, saying "pick a sync point", and a
   plain click opens the dialog instead of toggling something that cannot draw.

The recovery path from (3) was then verified end to end: the dialog shows an
amber "No countdown found. Pick the moment below.", re-derives candidates from
the transcript itself, and offers them as one-click buttons. Transcribed speech
and TeamSpeak nicknames both reach `innerHTML`, so the sidebar's escaping is
covered by tests too.

### Rust half: compiled, tested, and proven against the site

A Rust toolchain was installed on the Mac (there was none before), so the
recorder is no longer reviewed-by-eye. It is now a two-crate workspace, split
along one line — what needs a window and what does not:

- `recorder/core/` is the contract with the site: the `.aim4comms` container
  and the sync countdown. Depends on nothing heavier than gzip and serde, so
  `cargo test -p aim4-recorder-core` runs in about a second.
- `recorder/app/` is the program: self-update today, capture and Whisper next.

**17 tests pass.** `npm run test:recorder` runs them.

What that bought, beyond the tests going green:

- **The countdown detector is ported and agrees with the JavaScript.** Its Rust
  tests are the JS test vectors, including the table that walks all thirteen
  languages, the median-survives-one-bad-alignment case, and first-cued-wins.
  Both halves have to agree because the recorder writes the anchor and the
  viewer re-derives candidates from the same transcript when it could not.
- **Rust wrote a file and the site accepted it.** `--selftest` produced a
  container, `tools/comms/verify.mjs` read it, and the site independently
  re-derived the same 0:10 anchor the Rust had declared. That is the whole
  point of the conformance harness, and it now demonstrably works.
- **Self-update was verified end to end against the running server.** A real
  0.1.0 binary saw the published 0.2.0, downloaded it, replaced itself, and
  came back up as 0.2.0 with a hash matching the manifest exactly. Then the
  safety rule: a 0.3.0 build was published and its stored bytes corrupted, and
  the updater refused it on the checksum and **left the installed app intact**.
  A truncated download that still returned 200 cannot brick the app.

Two fixes this turned up:

- `self-replace` takes a path, not bytes. Staging now writes beside the
  executable rather than in the system temp directory, because those are often
  on different filesystems and the swap wants a rename, not a cross-device copy
  of the whole binary.
- The publish endpoint only accepted `MZ`. Its actual job is catching a wrong
  artifact (a zip, a readme, the .pdb next to the exe), not enforcing an OS, so
  it now accepts PE, ELF and Mach-O. Windows stays the target because that is
  where CS2 is played, but a Mac build is a plausible thing to publish later
  and this check had no business being the reason it could not be.

### Quota

Comms count toward the storage meter, as asked. `commsDir` moved to
`demoStore.js` beside the other library folders so `usage()` can size it
without importing `commsStore` and forming a cycle, and the now-redundant
`commsBytes()` is gone. The UI reads the `bytes` total, so it picked this up
with no client change. Detaching gives the bytes back; the library-wide
identity memory deliberately survives, since that is what lets the next attach
pre-fill its speaker mapping.

### TeamSpeak capture: built, and the library proved out

**tsclientlib 0.2.0 compiles on Rust 1.98.** That was the single riskiest
assumption in the whole design — an unofficial protocol implementation whose
last release is old — and it is now settled rather than hoped. It needs libopus
present (`brew install opus pkgconf`), otherwise its `audiopus_sys` tries to
build the codec from source and wants autotools.

Reading the real API rather than the research notes changed three things:

- Voice arrives as `AudioData::S2C { id, from, codec, data }`, and an **empty
  `data` is the protocol's own end-of-talking marker**. That is a better
  segment boundary than the 200 ms silence heuristic the plan assumed: the
  speaking client already decided where the utterance ended. The gap rule stays
  as a fallback for when that marker is lost.
- **Raw Opus frames cannot be concatenated.** The codec has no self-delimiting
  framing, so the obvious "append the payloads" recorder writes a file that
  looks fine and cannot be decoded. Segments are length-prefixed
  (`core/src/capture.rs`), and a truncated tail from a crash mid-write keeps
  the frames that are whole.
- The bot's identity must persist **with its counter**, not just its key.
  Servers can require a minimum identity security level; computing it is
  deliberately slow, and storing the key alone silently drops back to level 0
  on next launch.

`--record <server> [channel] [dir]` joins a channel and records until Ctrl+C,
printing each speaker's UID and talk time. That is how the connection gets
proved against a real server, and it is worth doing before anything else is
built on top of it.

### The 2 MB target, corrected

Writing the budget arithmetic down honestly (`core/src/budget.rs`) showed the
earlier size table was optimistic. The real limit:

| speech (all speakers) | bitrate chosen | file |
|---|---|---|
| 10 min | 16 kbps | 1.21 MB |
| 20 min | 12 kbps | 1.82 MB |
| 30 min | 8 kbps | 1.82 MB |
| 40 min | 6 kbps | 1.82 MB |
| 45 min | 6 kbps (floor) | 2.05 MB, over |
| 60 min | 6 kbps (floor) | 2.73 MB, over |

**2 MB holds up to about 40 speech-minutes**, not the 45–60 claimed earlier.
Past that no intelligible bitrate fits, so the packer stays at the 6 kbps floor
and reports `over_budget` rather than mangling the audio. That is a missed
target, not a failure: the server cap is 32 MB. A test pins this exact table so
the documented size story cannot drift from the arithmetic again.

The transcript reserve also came down from 320 KB to 160 KB, because it was
measured rather than guessed: a 23 round, 128 line session gzips to 2 KB, so a
full map lands well under 100 KB. Every byte reserved there is a byte the audio
cannot spend.

### Still not built

Whisper transcription, the Opus encode into the container, and the egui window.
Everything they depend on — capture, framing, the budget, the anchor detector,
the container writer — is built and tested, so those three are the remaining
work rather than the remaining unknowns.

### The last three pieces, built and proven end to end

All three landed in one pass, and the pipeline has now run for real — model
download to site-accepted file — twice, in two languages.

**Opus packing** (`app/src/audio.rs` + `app/src/pipeline.rs`). Decode the
captured frames (mono voice and stereo music codecs, corrupt frames skipped,
Speex-era codecs refused loudly), re-encode 20 ms mono frames at the budget
bitrate, and write each utterance as its own self-contained Ogg/Opus stream —
one byte range per track in the container's audio index, so silence between
utterances costs zero bytes and the site can hand the browser one range at a
time. The Ogg writer is tested by *reading its own output back*: packets
decoded one by one, and the final granule position checked to trim the
zero-padded tail to the real sample count.

**Whisper** (`app/src/transcribe.rs`). whisper-rs 0.16 (whisper.cpp compiled
in via cmake — it built first try on this machine). Transcription runs per
captured segment, so utterance boundaries and timestamps come from TeamSpeak's
own end-of-talking markers rather than from Whisper's drifting clock, and no
language-specific splitting exists to go wrong in thirteen languages. Models
download once from Hugging Face (atomic `.part` rename, truncation refused)
and live beside the settings: large-v3-turbo-q5 by default, small-q5 and tiny
below it. Silence hallucinations are filtered by *shape* (bracketed lines,
music notation, no-speech probability) rather than by a phrase list that would
need maintaining per language. A test walks all 13 site codes through
Whisper's own language table so none can silently transcribe as the wrong
language.

**The window** (`app/src/ui.rs`, eframe 0.36 — whose App trait split
`update()` into `logic()`/`ui()` mid-flight). One screen in the order things
happen: update banner (install disabled mid-recording), connect-and-record
with a live per-speaker talk readout, then transcribe-and-pack over any past
session with language and model dropdowns. Passwords are session-only and
never written to disk. Recording and packing run on worker threads; the UI
only ever `try_recv()`s.

**The budget got honest framing numbers.** With a real encoder to measure,
the 6% multiplier became 90 bytes per speech-second (lacing + page headers +
per-track headers) — per-packet costs grow as bitrate shrinks, which a
percentage got wrong at the floor. The limit moved 40 → **38 speech-minutes**;
the pinned table test forced the docs to follow. And the estimate now only
picks the starting rung: the packer measures the real packed file and walks
down the ladder until it fits, so estimate error costs one extra encode pass,
never a broken promise.

**Proven end to end without a server.** `--ingest-wav` (a dev command that
ships) turns any 48 kHz wav into a captured segment. macOS `say` synthesized
"record, three, two, one" plus two calls; the pipeline downloaded a real model,
transcribed "Record 3 2 1" (digits — which the detector's tables already
cover), found the cued anchor at exactly countdown-start + 4 s, packed at
16 kbps, and the site's verifier accepted the file and re-derived the same
anchor from the transcript. Then again in Russian ("рекорд, три, два, один",
Milena voice, `lang=ru`) — cued anchor found, verifier green. The one thing
still unproven is a live TeamSpeak connection; `--record <server>` remains the
five-minute test.

### Review pass: eight fixes, one theme

A fresh read of everything just written found one repeated shape — **an error
at the edge of a finished recording threw the recording away** — plus a few
holes around it. All fixed and re-tested:

1. **A mid-stream error lost the session.** A kick, a dead network, or a full
   disk in the last round propagated `?` out of the capture loop, and an hour
   of comms on disk returned as `Err`. Now it breaks, salvages everything
   captured, and carries `interrupted: Some(why)` so the CLI and the window
   both say "the session ended on its own — here is what was saved".
2. **A failed goodbye discarded a finished recording.** `disconnect()?` after
   a complete session could error; it is best-effort now.
3. **Stop was dead while connecting.** The wait for the first book event
   ignored the stop flag and had no deadline, so an unreachable server hung
   the window forever. Now: stop works during connect, 30 s deadline, and the
   library's own 5 s timeout surfaces cleanly (proven live against a dead
   address).
4. **Closing the window mid-recording killed the session.** `on_exit` now
   presses Stop and waits up to five seconds for segments to close and
   session.json to be written.
5. **The update installer raced the Record button.** Install → 30 s download →
   user starts recording → the swap read the recording state from click time.
   It now reads a shared flag at swap time, and `apply()` refuses while busy.
6. **`download()` trusted the server to stop.** The updater read an unbounded
   stream into memory; it now enforces the manifest's size as a hard limit
   (and a 256 MB ceiling on the claim itself) and refuses length mismatches
   before hashing.
7. **All-corrupt segments produced headers-only Ogg tracks** a browser cannot
   decode; they are skipped on both the transcribe and encode paths now, and a
   failed model download no longer leaves a `.part` file behind.
8. **Comms uploads counted toward the quota but were never gated by it** — a
   full library could keep growing 32 MB at a time. The upload route now runs
   the same `checkQuota` gate as demos, charging a replace only for the
   difference; the attach endpoint's JSON body also got the 64 KB cap it was
   missing.

Still open, deliberately: pack has no cancel button (whisper.cpp offers no
clean mid-run abort worth the plumbing yet), and the two decisions waiting on
the user — whether comms attach stays uploader-only (`canManage`) and whether
tiers gate the feature at all.
