// ---------------------------------------------------------------------------
// comms/format.js — the .aim4comms container
//
// One recorded TeamSpeak session: who said what, when, and the voice itself.
// Written by the desktop recorder (a separate codebase), read by the viewer.
// This module is the contract between the two, so the wire layout is defined
// here and nowhere else.
//
// Layout, little-endian throughout:
//
//   magic     4 bytes   "A4C1"
//   version   2 bytes   FORMAT_VERSION
//   flags     2 bytes   reserved, always 0
//   jsonLen   4 bytes   byte length of the gzipped manifest
//   manifest  jsonLen   gzip(JSON) — transcript, speakers, sync, audio index
//   audio     rest      per-speaker Ogg/Opus streams, back to back
//
// Not a zip. The library already hand-rolls its archive readers rather than
// take a zip dependency (see server/replays/archive.js), and a browser can
// gunzip a slice with DecompressionStream but cannot open a zip without a
// library. A length-prefixed manifest plus a blob region needs nothing on
// either side, and lets the viewer read the transcript without touching the
// audio — which matters, because the transcript is ~200 KB and the audio it
// sits in front of is ~2 MB.
//
// Audio is indexed, never inlined: base64 inside the JSON would add a third
// again to the exact bytes the recorder spends its whole bitrate budget on.
// ---------------------------------------------------------------------------

export const FORMAT_MAGIC = 'A4C1';
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 12;

/** Anchor kinds a manifest may carry. Only one exists so far. */
export const SYNC_FREEZE_END_R1 = 'freeze-end-r1';

// Caps. A 40 minute map with five speakers lands near 3,000 utterances, so
// these are ceilings on absurdity, not on real sessions.
export const MAX_SPEAKERS = 16;
export const MAX_UTTERANCES = 40000;
export const MAX_TEXT_CHARS = 500;
export const MAX_NAME_CHARS = 80;
/** Refused above this. The recorder targets 2 MB; this is the safety rail. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Languages the recorder may declare. Matches the countdown tables. */
export const LANGUAGES = Object.freeze([
  'da',
  'en',
  'es',
  'fi',
  'fr',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sv',
  'uk',
  'zh'
]);

const te = new TextEncoder();
const td = new TextDecoder();

// --- gzip helpers ----------------------------------------------------------
// CompressionStream is global in browsers and in Node 18+, so one code path
// serves the viewer, the tests, and the server.

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- framing ---------------------------------------------------------------

/**
 * Split a container into its parts without decompressing anything.
 * Throws on anything that is not an .aim4comms file this build understands.
 *
 * @param {Uint8Array} bytes
 * @returns {{ version: number, manifestGz: Uint8Array, audio: Uint8Array }}
 */
export function readHeader(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < HEADER_BYTES) throw new Error('Not a comms file: too short.');
  if (td.decode(u8.subarray(0, 4)) !== FORMAT_MAGIC) {
    throw new Error('Not a comms file: wrong magic.');
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = view.getUint16(4, true);
  if (version > FORMAT_VERSION) {
    throw new Error(`Comms file version ${version} is newer than this site supports.`);
  }
  const jsonLen = view.getUint32(8, true);
  const end = HEADER_BYTES + jsonLen;
  if (end > u8.byteLength) throw new Error('Comms file is truncated.');
  return {
    version,
    manifestGz: u8.subarray(HEADER_BYTES, end),
    audio: u8.subarray(end)
  };
}

/**
 * Frame a gzipped manifest and an audio blob into one container.
 * @param {Uint8Array} manifestGz
 * @param {Uint8Array} audio
 */
export function writeContainer(manifestGz, audio = new Uint8Array(0)) {
  const out = new Uint8Array(HEADER_BYTES + manifestGz.byteLength + audio.byteLength);
  out.set(te.encode(FORMAT_MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, manifestGz.byteLength, true);
  out.set(manifestGz, HEADER_BYTES);
  out.set(audio, HEADER_BYTES + manifestGz.byteLength);
  return out;
}

// --- encode / decode -------------------------------------------------------

/**
 * Build a whole .aim4comms file. Mostly for tests and fixtures: the shipping
 * writer is the Rust recorder, which follows this same layout.
 *
 * @param {object} manifest  validated with validateManifest first
 * @param {Uint8Array} [audio]
 */
export async function encodeComms(manifest, audio = new Uint8Array(0)) {
  const clean = validateManifest(manifest);
  const gz = await gzip(te.encode(JSON.stringify(clean)));
  return writeContainer(gz, audio);
}

/**
 * Read a container into its manifest plus an audio accessor.
 *
 * The audio bytes are kept as one slice and handed out per speaker on demand:
 * nothing decodes voice until something actually asks to play it, so opening
 * a demo with comms attached costs a gunzip of the transcript and no more.
 *
 * @param {Uint8Array} bytes
 */
export async function decodeComms(bytes) {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Comms file is too large.');
  const { version, manifestGz, audio } = readHeader(bytes);
  let parsed;
  try {
    parsed = JSON.parse(td.decode(await gunzip(manifestGz)));
  } catch {
    throw new Error('Comms file manifest is unreadable.');
  }
  const manifest = validateManifest(parsed);
  return {
    version,
    manifest,
    audio,
    /**
     * Ogg/Opus bytes for one speaker, or null when the file carries no audio.
     * @param {number} speakerIndex
     */
    audioFor(speakerIndex) {
      const track = manifest.audio?.tracks?.find((t) => t.speaker === speakerIndex);
      if (!track || !audio.byteLength) return null;
      const end = track.byteOff + track.byteLen;
      if (end > audio.byteLength) return null;
      return audio.subarray(track.byteOff, end);
    }
  };
}

// --- validation ------------------------------------------------------------

const int = (v, fallback = 0) => (Number.isFinite(v) ? Math.round(v) : fallback);
const str = (v, max) => String(v ?? '').slice(0, max);

/**
 * Normalize and bounds-check a manifest.
 *
 * The recorder is a program on someone's PC and the file arrives over an
 * upload, so nothing in here is trusted: every field is coerced to its type,
 * clamped, and sorted. Callers get a manifest they can render without
 * defending themselves again.
 *
 * @param {object} raw
 */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Comms manifest is missing.');
  if (int(raw.version) !== FORMAT_VERSION) {
    throw new Error(`Unsupported comms manifest version ${raw.version}.`);
  }

  const speakers = (Array.isArray(raw.speakers) ? raw.speakers : []).slice(0, MAX_SPEAKERS).map(
    (s, i) => ({
      // The TeamSpeak identity UID: stable across nickname changes, which is
      // what lets a saved player mapping survive someone renaming themselves.
      uid: str(s?.uid, MAX_NAME_CHARS) || `speaker-${i}`,
      nickname: str(s?.nickname, MAX_NAME_CHARS) || `Speaker ${i + 1}`,
      talkMs: Math.max(0, int(s?.talkMs))
    })
  );
  if (!speakers.length) throw new Error('Comms manifest has no speakers.');

  const lang = LANGUAGES.includes(raw.lang) ? raw.lang : '';

  const utterances = (Array.isArray(raw.utterances) ? raw.utterances : [])
    .slice(0, MAX_UTTERANCES)
    .map((u) => {
      const startMs = Math.max(0, int(u?.startMs));
      // A zero-length utterance would flicker for one frame and vanish; give
      // anything degenerate a floor so it is at least readable on screen.
      const endMs = Math.max(startMs + 200, int(u?.endMs, startMs));
      return {
        speaker: Math.min(speakers.length - 1, Math.max(0, int(u?.speaker))),
        startMs,
        endMs,
        text: str(u?.text, MAX_TEXT_CHARS).trim(),
        conf: Number.isFinite(u?.conf) ? Math.min(1, Math.max(0, u.conf)) : null
      };
    })
    .filter((u) => u.text)
    .sort((a, b) => a.startMs - b.startMs);

  const sync = raw.sync && typeof raw.sync === 'object' ? raw.sync : {};
  const anchorMs = Number.isFinite(sync.anchorMs) ? Math.max(0, Math.round(sync.anchorMs)) : null;

  const tracks = (Array.isArray(raw.audio?.tracks) ? raw.audio.tracks : [])
    .map((t) => ({
      speaker: Math.min(speakers.length - 1, Math.max(0, int(t?.speaker))),
      byteOff: Math.max(0, int(t?.byteOff)),
      byteLen: Math.max(0, int(t?.byteLen)),
      // Recording-time position of this track's first audio sample. Tracks are
      // silence-padded from zero by the recorder, so this is normally 0; it is
      // carried so a future recorder can trim leading silence instead.
      startMs: Math.max(0, int(t?.startMs))
    }))
    .filter((t) => t.byteLen > 0);

  return {
    version: FORMAT_VERSION,
    name: str(raw.name, MAX_NAME_CHARS) || 'Voice comms',
    recordedAt: str(raw.recordedAt, 40),
    lang,
    model: str(raw.model, MAX_NAME_CHARS),
    durationMs: Math.max(0, int(raw.durationMs)),
    sync: {
      anchorMs,
      kind: sync.kind === SYNC_FREEZE_END_R1 ? SYNC_FREEZE_END_R1 : SYNC_FREEZE_END_R1,
      // Whether the recorder found the countdown itself. False means the user
      // has to point at it in the attach dialog, so the viewer must not treat
      // a missing anchor as a broken file.
      detected: Boolean(sync.detected) && anchorMs !== null,
      confidence: Number.isFinite(sync.confidence)
        ? Math.min(1, Math.max(0, sync.confidence))
        : 0
    },
    speakers,
    audio: tracks.length
      ? {
          codec: str(raw.audio?.codec, 16) || 'opus',
          bitrate: Math.max(0, int(raw.audio?.bitrate)),
          tracks
        }
      : null,
    utterances
  };
}

/** Total speech time in a manifest, which is what the file's size tracks. */
export function speechMs(manifest) {
  return (manifest.speakers || []).reduce((sum, s) => sum + s.talkMs, 0);
}
