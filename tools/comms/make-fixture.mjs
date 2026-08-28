// ---------------------------------------------------------------------------
// tools/comms/make-fixture.mjs
// Build a realistic .aim4comms file for a demo already in the local library.
//
// The shipping writer is the desktop recorder; this exists so the viewer side
// can be developed and demonstrated without a TeamSpeak server in the room. It
// produces a transcript-only file (no audio), which the format allows.
//
// It also exercises the real countdown detector: the generated speech contains
// a spoken "record, three, two, one" and the anchor is FOUND rather than
// asserted, so a fixture that syncs proves the detector agrees with the writer.
//
//   node tools/comms/make-fixture.mjs <demoId> [--lang pt] [--user local]
//                                     [--out path] [--install]
//
// --install writes it straight into the library as an attachment, mapping the
// speakers onto the demo's own team-1 players, which is the fastest way to see
// captions in the viewer.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { encodeComms, FORMAT_VERSION } from '../../shared/comms/format.js';
import { pickAnchor } from '../../shared/comms/countdown.js';

const args = process.argv.slice(2);
const demoId = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

if (!demoId) {
  console.error('usage: node tools/comms/make-fixture.mjs <demoId> [--lang pt] [--install]');
  process.exit(1);
}

const user = flag('user', 'local');
const lang = flag('lang', 'pt');
const root = process.env.AIM4_REPLAY_DIR || path.join(process.cwd(), 'server', 'data', 'replays');

/** Spoken countdown, per language. Matches shared/comms/countdown.js. */
const COUNTDOWN = {
  en: ['record', 'three', 'two', 'one'],
  pt: ['record', 'três', 'dois', 'um'],
  no: ['record', 'tre', 'to', 'en'],
  ru: ['record', 'три', 'два', 'один'],
  sv: ['record', 'tre', 'två', 'ett'],
  es: ['record', 'tres', 'dos', 'uno'],
  fr: ['record', 'trois', 'deux', 'un'],
  pl: ['record', 'trzy', 'dwa', 'jeden'],
  fi: ['record', 'kolme', 'kaksi', 'yksi'],
  da: ['record', 'tre', 'to', 'et'],
  uk: ['record', 'три', 'два', 'один'],
  ro: ['record', 'trei', 'doi', 'unu'],
  zh: ['record', '三', '二', '一']
};

/**
 * Callouts by phase. Deliberately the way people actually talk: short, English
 * loanwords inside the local language, no punctuation ceremony.
 */
const LINES = {
  pt: {
    buy: ['comprando awp', 'me da uma flash', 'eco esse round', 'full buy, sem drop'],
    open: ['dois na banana', 'vou de meio', 'segura o TR', 'smoke no CT agora'],
    mid: [
      'um caiu no meio',
      'rotaciona pro B',
      'eles tao com o kit',
      'to com 30 de vida, voltando',
      'joga a molly na box'
    ],
    late: ['planta no A', 'segura o retake', 'tres do lado do B', 'sai fora, sai fora']
  },
  en: {
    buy: ['buying awp', 'drop me a flash', 'eco this round', 'full buy no drop'],
    open: ['two banana', 'taking mid', 'hold the T spawn', 'smoke ct now'],
    mid: [
      'one down mid',
      'rotate to B',
      'they have the kit',
      'thirty health, falling back',
      'molly the box'
    ],
    late: ['planting A', 'hold for retake', 'three on B side', 'get out, get out']
  }
};

const pool = (l) => LINES[l] || LINES.en;
const pick = (arr, i) => arr[i % arr.length];

const recordPath = path.join(root, user, 'demos', `${demoId}.json`);
let record;
try {
  record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
} catch {
  console.error(`No demo record at ${recordPath}`);
  process.exit(1);
}

const rounds = (record.rounds || []).filter((r) => Number.isFinite(r.freezeEndTick));
if (!rounds.length) {
  console.error('That demo has no materialized rounds.');
  process.exit(1);
}

const tickRate = record.tickRate || 64;
const r1 = rounds.find((r) => r.round === 1) || rounds[0];

// The recording starts a little before round 1 goes live, which is when the
// countdown is spoken. Everything else is placed relative to that.
const ANCHOR_MS = 10000;
const msAt = (tick) => Math.round(ANCHOR_MS + ((tick - r1.freezeEndTick) * 1000) / tickRate);

// Team 1 does the talking; five voices plus nobody else.
const team = (record.players || []).filter((p) => p.team === 1).slice(0, 5);
if (!team.length) {
  console.error('That demo has no team 1 players.');
  process.exit(1);
}

const speakers = team.map((p, i) => ({
  uid: `fixture-uid-${i}`,
  nickname: p.name || `Player ${i + 1}`,
  talkMs: 0
}));

/** @type {Array<{speaker:number,startMs:number,endMs:number,text:string,conf:number}>} */
const utterances = [];
/** Word stream for the recorder's own track (speaker 0), for anchor detection. */
const words = [];

const say = (speaker, startMs, text, conf = 0.86) => {
  const durMs = Math.max(700, Math.min(4200, text.length * 78));
  utterances.push({ speaker, startMs, endMs: startMs + durMs, text, conf });
  speakers[speaker].talkMs += durMs;
  if (speaker === 0) {
    const parts = text.split(/\s+/);
    const step = durMs / Math.max(1, parts.length);
    parts.forEach((w, i) => words.push({ word: w, startMs: Math.round(startMs + i * step) }));
  }
};

// The sync countdown: spoken by the recording user during round 1 freeze time.
// "record" leads, then the numbers on an exact one-second grid so that "one"
// lands one second before the round goes live.
const cd = COUNTDOWN[lang] || COUNTDOWN.en;
const cdStartMs = ANCHOR_MS - 4000;
cd.forEach((w, i) => words.push({ word: w, startMs: cdStartMs + i * 1000 }));
utterances.push({
  speaker: 0,
  startMs: cdStartMs,
  endMs: ANCHOR_MS - 500,
  text: cd.join(' '),
  conf: 0.95
});
speakers[0].talkMs += 3500;

const P = pool(lang);
let n = 0;

for (const round of rounds) {
  const live = round.freezeEndTick;
  const end = round.endTick || live + 90 * tickRate;
  const span = Math.max(1, end - live);

  // Buy chatter just before the round goes live.
  say(n % speakers.length, msAt(live - Math.round(4 * tickRate)), pick(P.buy, n));
  n++;

  // Opening call as the round starts.
  say(0, msAt(live + Math.round(1.5 * tickRate)), pick(P.open, n));
  n++;

  // Two or three midround calls spread through the round.
  const midCount = 2 + (round.round % 2);
  for (let i = 0; i < midCount; i++) {
    const at = live + Math.round(span * (0.25 + 0.2 * i));
    say((n + i + 1) % speakers.length, msAt(at), pick(P.mid, n + i));
  }
  n += midCount;

  // A late call near the end of the round.
  say((n + 2) % speakers.length, msAt(live + Math.round(span * 0.82)), pick(P.late, n));
  n++;
}

utterances.sort((a, b) => a.startMs - b.startMs);

// Detect the anchor the same way the recorder would, rather than asserting it.
const found = pickAnchor(words, lang);
if (!found?.detected) {
  console.error('The generated countdown was not detected. Fixture would not sync.');
  process.exit(1);
}

const manifest = {
  version: FORMAT_VERSION,
  name: `${record.team1?.name || 'Team 1'} comms`,
  recordedAt: new Date().toISOString(),
  lang,
  model: 'fixture',
  durationMs: utterances[utterances.length - 1].endMs + 5000,
  sync: {
    anchorMs: found.anchorMs,
    kind: 'freeze-end-r1',
    detected: true,
    confidence: found.confidence
  },
  speakers,
  utterances
};

const bytes = await encodeComms(manifest);
const outPath = flag('out', path.join(process.cwd(), `${demoId}.aim4comms`));

if (has('install')) {
  const { saveComms, updateCommsAttachment } = await import('../../server/replays/commsStore.js');
  process.env.AIM4_REPLAY_DIR = root;
  await saveComms(user, demoId, Buffer.from(bytes), { filename: path.basename(outPath) });
  const mapping = {};
  speakers.forEach((s, i) => {
    if (team[i]?.id) mapping[s.uid] = team[i].id;
  });
  await updateCommsAttachment(user, demoId, { mapping, anchorTick: r1.freezeEndTick });
  console.log(`installed into the library for demo ${demoId}`);
}

await fsp.writeFile(outPath, bytes);
console.log(
  [
    `wrote ${outPath}`,
    `  ${(bytes.byteLength / 1024).toFixed(1)} KB, ${utterances.length} lines, ${speakers.length} speakers`,
    `  lang ${lang}, anchor ${found.anchorMs}ms (confidence ${found.confidence}) -> tick ${r1.freezeEndTick}`,
    `  speakers: ${speakers.map((s) => s.nickname).join(', ')}`
  ].join('\n')
);
