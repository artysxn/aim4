import assert from 'node:assert/strict';
import {
  FORMAT_VERSION,
  decodeComms,
  encodeComms,
  readHeader,
  speechMs,
  validateManifest
} from './format.js';
import { findCountdowns, normalizeWord, pickAnchor } from './countdown.js';
import {
  anchorRoundFrom,
  buildTimeline,
  msToTick,
  speakerLines,
  tickToMs,
  utterancesAtTick
} from './sync.js';

const manifest = () => ({
  version: FORMAT_VERSION,
  name: 'vs-navi-m2',
  lang: 'no',
  sync: { anchorMs: 13000, detected: true, confidence: 0.9 },
  speakers: [
    { uid: 'uid-a', nickname: 'playerA', talkMs: 400000 },
    { uid: 'uid-b', nickname: 'playerB', talkMs: 200000 }
  ],
  utterances: [
    { speaker: 0, startMs: 20000, endMs: 22000, text: 'de pusher banana' },
    { speaker: 1, startMs: 21000, endMs: 21500, text: 'jeg tar midt' },
    { speaker: 0, startMs: 60000, endMs: 61000, text: 'fall tilbake' }
  ]
});

// --- format ----------------------------------------------------------------

{
  const m = validateManifest(manifest());
  assert.equal(m.speakers.length, 2);
  assert.equal(m.utterances.length, 3);
  assert.equal(m.utterances[0].startMs, 20000, 'utterances sort by start');
  assert.equal(m.lang, 'no');
  assert.equal(speechMs(m), 600000);
}

{
  // Hostile input: the recorder is a program on someone's PC and the file
  // arrives over an upload, so every field must survive being wrong.
  const m = validateManifest({
    ...manifest(),
    speakers: [{ uid: 'x' }],
    utterances: [
      { speaker: 99, startMs: -5, endMs: -900, text: 'x'.repeat(9000) },
      { speaker: 0, startMs: 10, endMs: 20, text: '   ' },
      { speaker: 0, startMs: 5, endMs: 30, text: 'kept', conf: 40 }
    ]
  });
  assert.equal(m.speakers[0].nickname, 'Speaker 1', 'a missing nickname gets a label');
  assert.equal(m.utterances.length, 2, 'blank text is dropped');
  assert.equal(m.utterances[0].speaker, 0, 'out-of-range speaker is clamped');
  assert.equal(m.utterances[0].startMs, 0);
  assert.ok(m.utterances[0].endMs > m.utterances[0].startMs, 'degenerate span is widened');
  assert.equal(m.utterances[0].text.length, 500, 'text is capped');
  assert.equal(m.utterances[1].conf, 1, 'confidence is clamped to 0..1');
}

{
  assert.throws(() => validateManifest({ version: 99, speakers: [{ uid: 'a' }] }), /version/);
  assert.throws(() => validateManifest({ version: 1, speakers: [] }), /no speakers/);
}

{
  // Round trip, with audio riding behind the manifest.
  const audio = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const m = manifest();
  m.audio = {
    codec: 'opus',
    bitrate: 8000,
    tracks: [
      { speaker: 0, byteOff: 0, byteLen: 5 },
      { speaker: 1, byteOff: 5, byteLen: 3 }
    ]
  };
  const bytes = await encodeComms(m, audio);
  const head = readHeader(bytes);
  assert.equal(head.version, FORMAT_VERSION);
  assert.deepEqual([...head.audio], [...audio], 'audio survives framing unchanged');

  const file = await decodeComms(bytes);
  assert.equal(file.manifest.name, 'vs-navi-m2');
  assert.equal(file.manifest.utterances.length, 3);
  assert.deepEqual([...file.audioFor(0)], [1, 2, 3, 4, 5], 'first speaker slice');
  assert.deepEqual([...file.audioFor(1)], [6, 7, 8], 'second speaker slice');
  assert.equal(file.audioFor(7), null, 'unknown speaker has no track');
}

{
  const noAudio = await encodeComms(manifest());
  const file = await decodeComms(noAudio);
  assert.equal(file.manifest.audio, null, 'a transcript-only file is valid');
  assert.equal(file.audioFor(0), null);
  // Transcript-only files must stay small enough to be free to store.
  assert.ok(noAudio.byteLength < 2048, `transcript-only file is tiny (${noAudio.byteLength}B)`);
}

{
  assert.throws(() => readHeader(new Uint8Array([1, 2, 3])), /too short/);
  assert.throws(() => readHeader(new Uint8Array(20)), /wrong magic/);
}

// --- countdown -------------------------------------------------------------

/** Build a word stream at 1s spacing from a script. */
function words(script, startMs = 10000, stepMs = 1000) {
  return script.map((w, i) => ({
    word: w,
    startMs: startMs + i * stepMs,
    endMs: startMs + i * stepMs + 400
  }));
}

{
  assert.equal(normalizeWord('Två,'), 'tva');
  assert.equal(normalizeWord('one!'), 'one');
  assert.equal(normalizeWord('  Три. '), 'три');
}

{
  // "record" at 10s, then 3/2/1 at 11/12/13 -> live one second after "one".
  const found = findCountdowns(words(['record', 'three', 'two', 'one']), 'en');
  assert.equal(found.length, 1);
  assert.equal(found[0].cued, true);
  assert.equal(found[0].anchorMs, 14000, 'freeze end is 1s after "one"');
  assert.equal(found[0].spreadMs, 0, 'evenly paced words agree exactly');
  assert.ok(found[0].confidence > 0.9);
}

{
  // Every supported language must anchor on its own number words.
  const scripts = {
    no: ['record', 'tre', 'to', 'en'],
    da: ['record', 'tre', 'to', 'et'],
    sv: ['record', 'tre', 'två', 'ett'],
    fi: ['record', 'kolme', 'kaksi', 'yksi'],
    ru: ['record', 'три', 'два', 'один'],
    uk: ['record', 'три', 'два', 'один'],
    pl: ['record', 'trzy', 'dwa', 'jeden'],
    ro: ['record', 'trei', 'doi', 'unu'],
    fr: ['record', 'trois', 'deux', 'un'],
    es: ['record', 'tres', 'dos', 'uno'],
    pt: ['record', 'três', 'dois', 'um'],
    zh: ['record', '三', '二', '一'],
    en: ['record', '3', '2', '1']
  };
  for (const [lang, script] of Object.entries(scripts)) {
    const found = findCountdowns(words(script), lang);
    assert.equal(found.length, 1, `${lang}: countdown found`);
    assert.equal(found[0].cued, true, `${lang}: cue matched`);
    assert.equal(found[0].anchorMs, 14000, `${lang}: anchor at freeze end`);
  }
}

{
  // Transliterated cue: a Russian session where Whisper writes "рекорд".
  const found = findCountdowns(words(['рекорд', 'три', 'два', 'один']), 'ru');
  assert.equal(found[0].cued, true, 'transliterated cue still counts');
}

{
  // One badly aligned word must not move the anchor: the median holds.
  const stream = [
    { word: 'record', startMs: 10000 },
    { word: 'three', startMs: 11000 },
    { word: 'two', startMs: 12000 },
    { word: 'one', startMs: 13350 } // Whisper drifted this one
  ];
  const found = findCountdowns(stream, 'en');
  assert.equal(found[0].anchorMs, 14000, 'median ignores the outlier');
  assert.ok(found[0].spreadMs > 0, 'but the disagreement is reported');
  assert.ok(found[0].confidence < 0.95, 'and lowers confidence');
}

{
  // A bare countdown (no cue) is a candidate, never an automatic anchor.
  const found = findCountdowns(words(['flash', 'three', 'two', 'one']), 'en');
  assert.equal(found.length, 1);
  assert.equal(found[0].cued, false);
  assert.ok(found[0].confidence < 0.7, 'uncued countdowns are not trusted');

  const picked = pickAnchor(words(['flash', 'three', 'two', 'one']), 'en');
  assert.equal(picked.detected, false, 'uncued means the user must confirm');
}

{
  // Numbers scattered through a sentence are not a countdown.
  const slow = [
    { word: 'three', startMs: 10000 },
    { word: 'two', startMs: 30000 },
    { word: 'one', startMs: 60000 }
  ];
  assert.equal(findCountdowns(slow, 'en').length, 0, 'pacing rules it out');
}

{
  // First cued countdown wins, even if a later one looks tidier.
  const stream = [
    ...words(['record', 'three', 'two', 'one'], 10000),
    ...words(['record', 'three', 'two', 'one'], 600000)
  ];
  const picked = pickAnchor(stream, 'en');
  assert.equal(picked.anchorMs, 14000, 'the first instance is the anchor');
  assert.equal(picked.candidates.length, 2, 'the later one stays available');
}

{
  assert.equal(pickAnchor([], 'en'), null, 'silence has no anchor');
}

// --- sync ------------------------------------------------------------------

{
  const mapping = { anchorMs: 13000, anchorTick: 4991, tickRate: 64 };
  assert.equal(msToTick(mapping, 13000), 4991, 'the anchor maps to its tick');
  assert.equal(msToTick(mapping, 14000), 5055, 'a second later is 64 ticks on');
  assert.equal(tickToMs(mapping, 5055), 14000, 'and back again');

  // The nudge follows subtitle convention: positive shows a line later. A word
  // spoken at the anchor moves half a second further into the round.
  const later = { ...mapping, offsetMs: 500 };
  assert.equal(msToTick(later, 13000), 4991 + 32, '+500ms is 32 ticks later at 64 tick');
  assert.equal(tickToMs(later, 4991 + 32), 13000, 'and the inverse agrees');

  const earlier = { ...mapping, offsetMs: -500 };
  assert.equal(msToTick(earlier, 13000), 4991 - 32, 'negative pulls it earlier');
}

{
  const m = validateManifest(manifest());
  const mapping = { anchorMs: 13000, anchorTick: 4991, tickRate: 64 };
  const timeline = buildTimeline(m, mapping, (i) => ['p1', 'p2'][i]);

  assert.equal(timeline.items.length, 3);
  assert.equal(timeline.items[0].playerId, 'p1', 'speakers resolve to roster players');

  // 21.2s into the recording both are mid-sentence.
  const tick = msToTick(mapping, 21200);
  const live = utterancesAtTick(timeline, tick, { speaking: true });
  assert.equal(live.length, 2, 'overlapping talk shows both speakers');

  // 23s: both have stopped but the captions linger for two seconds.
  const after = msToTick(mapping, 23000);
  assert.equal(utterancesAtTick(timeline, after, { speaking: true }).length, 0);
  assert.equal(utterancesAtTick(timeline, after).length, 2, 'captions linger');

  // 25s: lingering is over.
  assert.equal(utterancesAtTick(timeline, msToTick(mapping, 25000)).length, 0);

  // Well before anything was said.
  assert.equal(utterancesAtTick(timeline, msToTick(mapping, 0)).length, 0);
}

{
  const m = validateManifest(manifest());
  const mapping = { anchorMs: 13000, anchorTick: 4991, tickRate: 64 };
  const timeline = buildTimeline(m, mapping);

  const rows = speakerLines(timeline, msToTick(mapping, 21200), 2);
  assert.equal(rows[0].speaking, true);
  assert.equal(rows[1].speaking, true);
  assert.equal(rows[0].text, 'de pusher banana');

  // Long after: the sidebar keeps the last line rather than blanking.
  const late = speakerLines(timeline, msToTick(mapping, 90000), 2);
  assert.equal(late[0].speaking, false);
  assert.equal(late[0].text, 'fall tilbake', 'last line stays');
  assert.ok(late[0].ageTicks > 0);
}

{
  // A big session must answer "who is talking" without scanning everything.
  const big = validateManifest({
    ...manifest(),
    utterances: Array.from({ length: 20000 }, (_, i) => ({
      speaker: i % 2,
      startMs: i * 500,
      endMs: i * 500 + 400,
      text: `line ${i}`
    }))
  });
  const mapping = { anchorMs: 0, anchorTick: 0, tickRate: 64 };
  const timeline = buildTimeline(big, mapping);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 5000; i++) {
    utterancesAtTick(timeline, msToTick(mapping, (i * 1000) % 10000000));
  }
  const perLookupUs = Number(process.hrtime.bigint() - started) / 1000 / 5000;
  assert.ok(perLookupUs < 50, `lookup stays cheap (${perLookupUs.toFixed(1)}us)`);
}

{
  const rounds = [
    { round: 3, freezeEndTick: 40000, tickRate: 64 },
    { round: 1, freezeEndTick: 4991, tickRate: 64 }
  ];
  assert.equal(anchorRoundFrom(rounds).anchorTick, 4991, 'round 1 is the anchor round');
  assert.equal(
    anchorRoundFrom([{ round: 12, freezeEndTick: 90000 }]),
    null,
    'without round 1 it refuses to guess'
  );
  assert.equal(anchorRoundFrom([]), null);
}

console.log('comms tests passed');
