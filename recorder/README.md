# aim4-recorder

Records a TeamSpeak channel on the user's own PC, transcribes it locally, and
writes one `.aim4comms` file that gets uploaded to a game in the aim4 viewer.

**Ships as a single .exe.** No installer, no zip, no folder. The user downloads
one file, runs it, and it replaces itself whenever a newer build is published.

## Why this lives in the aim4 repo

It is a Rust program inside a Node repo, which normally would not belong here.
It is here because aim4 is the only server there is, so aim4 is what serves the
download and the update feed, and keeping the source beside the thing that
serves it beats a second repo nobody deploys.

The site build never touches it:

- `.dockerignore` excludes `recorder/`, so it is not even in the image's build
  context. The image has no Rust toolchain and no reason to grow one.
- `nixpacks.toml` pins `providers = ["node"]`, which is what stops nixpacks
  noticing a `Cargo.toml` and trying to build it. (`tools/cs3d-tex/` set the
  same trap once with a `.csproj`, and that is why the pin exists.)

So: built on a developer machine, published to the running server as a binary.

## What it does

1. The user clicks **Record**. The app joins their TeamSpeak channel as a
   client and captures **every speaker as a separate track**.
2. During round 1's freeze time the user says **"record, three, two, one"**,
   timed so each number lands on that second of the freeze clock. That is the
   entire sync ceremony.
3. On **Stop**, the app transcribes locally, finds the countdown in the
   recording user's own track, and packs transcript plus low-bitrate voice into
   `<name>.aim4comms`.
4. The user drags that file onto a game in the aim4 viewer, behind the
   microphone button. Speakers map to players once and are remembered.

Nothing is live, and no audio or transcription ever touches an aim4 server.

## Status

| Piece | State |
|---|---|
| `.aim4comms` container writer | done, tested — `core/src/format.rs` |
| Self-update against aim4 | done, tested end to end — `app/src/update.rs` |
| Server side of the update feed | done — `server/recorder/`, live |
| TeamSpeak capture (tsclientlib) | built, compiles against the real protocol; needs a server to prove it connects (`--record`) |
| Segment capture + framing | done, tested — `core/src/capture.rs` |
| Size budget | done, tested — `core/src/budget.rs` |
| Whisper transcription | done, proven end to end — `app/src/transcribe.rs` |
| Countdown port from JS | done, tested — `core/src/countdown.rs` |
| Opus encode into the container | done, tested — `app/src/audio.rs` + `pipeline.rs` |
| egui window | done — `app/src/ui.rs`, the no-arguments path |

End to end has been proven without a TeamSpeak server: `--ingest-wav` turns any
48 kHz wav into a captured segment, and a session synthesized that way — in
English and in Russian — transcribed with a real Whisper model, found its cued
countdown, packed under budget, and passed the site's verifier, which
re-derived the same anchor from the transcript. The one remaining unknown is a
live TeamSpeak connection, and `--record <server>` is the five-minute test.

## Why egui and not Tauri

Tauri was the obvious pick while an installer was assumed: it brings a signed
updater and installer bundling. A single self-contained .exe removes both of
those advantages and leaves Tauri's cost, which is that it needs WebView2
present on the machine and its updater is built around installer artifacts.

egui compiles the entire UI into the binary, depends on nothing at runtime, and
leaves updating to `self-replace`, which is a truer fit for one file that
rewrites itself.

## Updating: how a new build reaches users

Publishing does **not** redeploy the site. Builds live in the server's data
volume, which survives deploys.

```bash
cargo build --release --target x86_64-pc-windows-msvc

curl -X POST https://aim4.io/api/recorder/releases \
  -H "Authorization: Bearer <admin token>" \
  -H "X-Aim4-Version: 1.2.0" \
  -H "X-Aim4-Notes: fixes a stuck reconnect" \
  --data-binary @target/x86_64-pc-windows-msvc/release/aim4-recorder.exe
```

Every running recorder picks it up on its next check. Two rules keep in-place
replacement safe, both in `app/src/update.rs` and both verified end to end:

1. **Verify before swapping.** The manifest carries a SHA-256 of the exact
   bytes the download serves, and the app refuses to replace itself unless the
   download matches. A truncated download that still returned 200 would
   otherwise brick the app.
2. **Never swap mid-recording.** A running session holds open segment files and
   the TeamSpeak connection; the swap waits for idle.

A published version is immutable — recorders cache by version, so ship a new
number rather than replacing bytes under an old one. `DELETE
/api/recorder/releases/<version>` pulls a bad build and the feed falls back to
the previous one.

Endpoints, all in `server/recorder/routes.js`:

| Route | Who |
|---|---|
| `GET /api/recorder/latest` | public — the update manifest |
| `GET /api/recorder/download` | public — the latest build, as a plain .exe |
| `GET /api/recorder/download/:version` | public — one specific build |
| `GET /api/recorder/releases` | admin |
| `POST /api/recorder/releases` | admin — publish |
| `DELETE /api/recorder/releases/:version` | admin — pull |

The public two are unauthenticated on purpose: the download link has to work
before anyone has installed anything, and the app never holds an aim4 login
because uploading a recording happens in the browser, where the user already
is signed in.

## The Whisper model is not in the .exe

It cannot be. The exe is tens of megabytes; `large-v3-turbo` is around 1.6 GB,
or roughly 570 MB quantized. It downloads once on first run, with a progress
bar, and is cached next to the app's settings.

Pull it from Hugging Face rather than from aim4: the model is the same public
file for everyone, and serving hundreds of megabytes per user from the one box
that also serves the demo library is a bandwidth bill for no benefit. aim4 is
worth keeping as a fallback mirror only if Hugging Face turns out to be blocked
somewhere a user actually is.

## Setup, for whoever runs it

1. Download the .exe from aim4.io and run it. There is nothing to install.
2. Enter the TeamSpeak server address (and its password, if it has one) and a
   nickname. The app makes its own TeamSpeak identity; there is nothing to
   create or paste.
3. Name the channel to join, or leave it empty for the server's default.
4. Set the language the team calls in.

Passwords are used for the session and never written to disk; everything else
is remembered in `settings.json` beside the app's identity. Recordings land in
`Documents/aim4-recordings/`, one folder per session, and any of them can be
packed (or re-packed in another language) later.

## Building

Needs a Rust toolchain (`rustup`). Two crates:

- `core/` is the contract with the site (container + countdown) and depends on
  nothing heavier than gzip and serde, so its tests run in about a second.
- `app/` is the program: the window, TeamSpeak capture, Whisper, the Opus
  packer, and self-update.

```bash
cargo test                    # 49 tests across both crates
cargo test -p aim4-recorder-core   # just the contract, fast
cargo build --release         # one self-contained binary
```

Native build dependencies: `cmake` (whisper.cpp) and `libopus` with
`pkg-config` — on macOS `brew install cmake opus pkgconf`; on Windows the
`audiopus_sys` crate builds libopus itself via cmake. On Windows the release
build sets `windows_subsystem = "windows"` so a double-click opens the window
without a console — which also means the CLI commands print nothing there; use
the window, or a debug build, when the text output matters.

```bash
./target/release/aim4-recorder                      # the window
./target/release/aim4-recorder --record ts.example.com
./target/release/aim4-recorder --pack recording en "scrim vs navi"
./target/release/aim4-recorder --selftest out.aim4comms
./target/release/aim4-recorder --check-update http://localhost:3799
./target/release/aim4-recorder --update http://localhost:3799

# dev: fake a captured segment from any 48 kHz wav, no server needed
./target/release/aim4-recorder --ingest-wav session 1 10000 cue.wav
```

## Conformance: staying compatible with the site

The site decides what a valid `.aim4comms` file is and refuses anything it
cannot read. One command checks it:

```bash
node ../tools/comms/verify.mjs out.aim4comms
```

It exits non-zero on anything the site would reject, prints what is in the
file, and re-derives the sync candidates the attach dialog would offer.
`conformance/golden-transcript-only.aim4comms` is a real session written by the
site's own writer; a recorder that reads that file and produces one the
verifier accepts is compatible.

## The format, in short

Full definition in `../shared/comms/format.js`, which is the single source of
truth.

```
magic     4 bytes   "A4C1"
version   2 bytes   little-endian, currently 1
flags     2 bytes   reserved, 0
jsonLen   4 bytes   little-endian byte length of the gzipped manifest
manifest  jsonLen   gzip(JSON): transcript, speakers, sync anchor, audio index
audio     rest      per-speaker Ogg/Opus streams, back to back
```

Not a zip: a browser can gunzip a slice with `DecompressionStream` but cannot
open a zip without a library, and the site avoids archive dependencies. Audio
is indexed rather than inlined because base64 would add a third to the exact
bytes the packer spends its whole size budget on.

### Size budget

Target **2 MB per map**, and the packer works backwards from it: it tries
16, 12, 10, 8 and 6 kbps mono Opus in turn and takes the first that fits,
reserving 160 KB for the transcript.

Only speech is ever encoded — TeamSpeak transmits nothing while nobody is
talking — which is what makes the target reachable at all. But be honest about
where it stops: **2 MB holds up to about 38 speech-minutes** across all
speakers. Past that, no intelligible bitrate fits, so the packer stays at the
6 kbps floor and goes over rather than mangling the audio. A very chatty map
lands near 2.4 MB, against a server cap of 32 MB, so this is a missed target
rather than a failure.

| speech (all speakers) | bitrate chosen | estimate |
|---|---|---|
| 10 min | 16 kbps | 1.20 MB |
| 20 min | 12 kbps | 1.82 MB |
| 25 min | 8 kbps | 1.56 MB |
| 30 min | 6 kbps | 1.44 MB |
| 38 min | 6 kbps | 1.83 MB |
| 40 min | 6 kbps (floor) | 1.92 MB, over the audio budget |
| 60 min | 6 kbps (floor) | 2.88 MB, over |

Those are the numbers `choose_bitrate` actually returns, not an estimate of
them: `budget.rs` has a test pinning the table so the docs cannot drift from
the arithmetic. The framing figure inside it (90 bytes per speech-second for
Ogg lacing, page headers and per-track headers) is derived from what
`encode_ogg_opus` writes — a flat per-second cost, because framing is per
packet and its share grows as the bitrate shrinks, which a percentage
multiplier used to get wrong at the floor.

The estimate only picks the starting rung. The packer then measures the real
file and walks down the ladder until it actually fits, so an estimate being a
little wrong costs one extra encode pass, never a broken promise. (This is also
why the 30-minute row shows a lower bitrate than the 25-minute one: a fixed
ladder has no rung between "8 kbps almost fits" and 6 kbps.)

Transcription always runs against the full-quality captured segments, never
this re-encode, so the bitrate chosen here can never cost accuracy.

### Sync anchor

Three spoken numbers give three independent estimates of the same freeze-end
instant (start of "three" + 3s, "two" + 2s, "one" + 1s). Take the **median** —
it survives one bad word alignment, which a single word cannot — and report
their spread as confidence. The cue word "record" is what separates a sync
countdown from players counting down a flash; an uncued countdown is offered to
the user as a candidate, never taken automatically. When there are several,
**the first wins**.

## Languages

One per recording; teams do not switch mid-match. Danish, English, Finnish,
French, Norwegian, Polish, Portuguese, Romanian, Russian, Spanish, Swedish,
Ukrainian, Chinese. Nordic languages, Finnish, Ukrainian, Romanian and Chinese
want `large-v3-turbo`; the rest are fine on smaller models.
