// ---------------------------------------------------------------------------
// tools/comms/verify.mjs
// Check that a .aim4comms file is one the site will accept, and say what is
// in it.
//
// This is the conformance harness for the desktop recorder, which lives in its
// own repo and writes this format from Rust. Running a recorder's output
// through here is what proves the two halves still agree, without needing the
// site, a login, or a demo:
//
//   node tools/comms/verify.mjs path/to/session.aim4comms
//
// Exits non-zero on anything the site would refuse, so it can gate a release.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import process from 'node:process';

import { decodeComms, MAX_FILE_BYTES, speechMs } from '../../shared/comms/format.js';
import { findCountdowns } from '../../shared/comms/countdown.js';

/** The size the recorder aims at. Over this is a warning, not a failure. */
const TARGET_BYTES = 2 * 1024 * 1024;

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/comms/verify.mjs <file.aim4comms>');
  process.exit(2);
}

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const problems = [];
const warnings = [];

let bytes;
try {
  bytes = new Uint8Array(await fsp.readFile(file));
} catch (err) {
  console.error(`Cannot read ${file}: ${err.message}`);
  process.exit(2);
}

let decoded;
try {
  decoded = await decodeComms(bytes);
} catch (err) {
  console.error(`REJECTED  ${file}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}

const { manifest, audio } = decoded;

// ---- the checks the server makes, plus the ones only a human would notice --

if (bytes.byteLength > MAX_FILE_BYTES) {
  problems.push(`file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the hard limit`);
} else if (bytes.byteLength > TARGET_BYTES) {
  warnings.push(
    `file is ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB, over the 2 MB target — ` +
      'the packer should have chosen a lower bitrate'
  );
}

if (!manifest.utterances.length) problems.push('no utterances: nothing would be shown');
if (!manifest.lang) warnings.push('no language declared; the site will show "auto"');

if (manifest.sync.anchorMs === null) {
  warnings.push('no sync anchor: the user has to pick the countdown by hand');
} else if (!manifest.sync.detected) {
  warnings.push('anchor present but not marked detected; the site will ask for confirmation');
}

// Audio index must actually address bytes that are there.
if (manifest.audio) {
  let covered = 0;
  for (const t of manifest.audio.tracks) {
    if (t.byteOff + t.byteLen > audio.byteLength) {
      problems.push(`audio track for speaker ${t.speaker} runs past the end of the file`);
    }
    covered += t.byteLen;
  }
  const seen = new Set(manifest.audio.tracks.map((t) => t.speaker));
  for (let i = 0; i < manifest.speakers.length; i++) {
    if (!seen.has(i)) warnings.push(`speaker ${i} (${manifest.speakers[i].nickname}) has no audio`);
  }
  if (covered < audio.byteLength) {
    warnings.push(`${audio.byteLength - covered} audio bytes are not referenced by any track`);
  }
} else if (audio.byteLength) {
  problems.push('the file carries audio bytes but no audio index');
}

// Timestamps must be sane against each other.
for (const s of manifest.speakers) {
  if (manifest.durationMs && s.talkMs > manifest.durationMs) {
    problems.push(`${s.nickname} talks for longer than the session lasts`);
  }
}
const last = manifest.utterances[manifest.utterances.length - 1];
if (manifest.durationMs && last && last.endMs > manifest.durationMs + 1000) {
  warnings.push('the last utterance ends after the declared duration');
}

// ---- report ---------------------------------------------------------------

const talk = speechMs(manifest);
const perMinute = talk ? bytes.byteLength / (talk / 60000) : 0;

console.log(`${problems.length ? 'REJECTED' : 'OK'}  ${file}`);
console.log(`  name        ${manifest.name}`);
console.log(`  language    ${manifest.lang || '(auto)'}`);
console.log(`  model       ${manifest.model || '(unstated)'}`);
console.log(`  size        ${(bytes.byteLength / 1024).toFixed(1)} KB`);
console.log(
  `  speech      ${mmss(talk)} across ${manifest.speakers.length} speakers` +
    (talk ? ` (${(perMinute / 1024).toFixed(1)} KB per speech-minute)` : '')
);
console.log(`  lines       ${manifest.utterances.length}`);
console.log(
  `  audio       ${
    manifest.audio
      ? `${manifest.audio.codec} @ ${manifest.audio.bitrate || '?'} bps, ${(
          audio.byteLength /
          1024
        ).toFixed(1)} KB`
      : 'none (transcript only)'
  }`
);
console.log(
  `  sync        ${
    manifest.sync.anchorMs === null
      ? 'none'
      : `${mmss(manifest.sync.anchorMs)} (${
          manifest.sync.detected ? 'detected' : 'unconfirmed'
        }, confidence ${manifest.sync.confidence})`
  }`
);
for (const s of manifest.speakers) {
  console.log(`    - ${s.nickname.padEnd(18)} ${mmss(s.talkMs)}`);
}

// Re-derive candidates from the transcript, the way the attach dialog does, so
// a recorder can see what the site would offer the user.
const words = [];
for (const u of manifest.utterances) {
  const parts = String(u.text).split(/\s+/).filter(Boolean);
  const step = (u.endMs - u.startMs) / Math.max(1, parts.length);
  parts.forEach((w, i) => words.push({ word: w, startMs: u.startMs + i * step }));
}
const found = findCountdowns(words, manifest.lang || 'en');
if (found.length) {
  console.log(`  countdowns  ${found.length} found in the transcript`);
  for (const c of found.slice(0, 5)) {
    console.log(
      `    - at ${mmss(c.atMs)} -> anchor ${mmss(c.anchorMs)}` +
        `${c.cued ? '' : ' (no cue word)'}, confidence ${c.confidence}`
    );
  }
}

for (const w of warnings) console.log(`  warning: ${w}`);
for (const p of problems) console.log(`  PROBLEM: ${p}`);

process.exit(problems.length ? 1 : 0);
