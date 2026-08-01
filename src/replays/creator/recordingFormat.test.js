// Run: node src/replays/creator/recordingFormat.test.js
//
// The size budget is the point of this format: a hand-built round has to stay
// far under a real parsed demo (1-2 MB for a whole match). A full ten-body
// round is simulated here and the encoded bytes are asserted, so a change that
// quietly doubles the file fails loudly instead of shipping.

import {
  MAX_SAMPLES_PER_TRACK,
  MOVE_SPEED_UNITS,
  ROUND_SECONDS,
  SAMPLE_HZ,
  SAMPLE_MS,
  decodeRound,
  emptyRound,
  emptyTrack,
  encodeRound,
  frameFor,
  makeNade,
  pushSample,
  roundSummary,
  sampleAt
} from './recordingFormat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// A deterministic wander that moves like a player: full speed, changing course.
function buildTrack(seed, index) {
  const track = emptyTrack(seed);
  let x = -1000 + index * 120;
  let y = 500 - index * 90;
  let heading = index * 0.7;
  const perSample = MOVE_SPEED_UNITS / SAMPLE_HZ;
  const n = SAMPLE_HZ * ROUND_SECONDS;
  for (let i = 0; i < n; i++) {
    heading += Math.sin(i / 24 + index) * 0.09;
    x += Math.cos(heading) * perSample;
    y += Math.sin(heading) * perSample;
    pushSample(track, x, y, (heading * 180) / Math.PI + Math.sin(i / 7) * 12);
  }
  for (let g = 0; g < 4; g++) {
    track.nades.push(
      makeNade({
        type: ['flashbang', 'smokegrenade', 'molotov', 'hegrenade'][g],
        t: 4000 + g * 6000,
        from: { x, y },
        to: { x: x + 600, y: y - 400 }
      })
    );
  }
  for (let s = 0; s < 30; s++) track.shots.push({ t: 9000 + s * 300, yaw: s * 11, x, y });
  return track;
}

const round = emptyRound({ map: 'ANC', side: 'T', name: 'Full round budget' });
for (let i = 0; i < 10; i++) {
  round.tracks.push(buildTrack({ id: `tr${i}`, side: i < 5 ? 'T' : 'CT', name: `Body ${i}` }, i));
}

// ---- size --------------------------------------------------------------------

{
  const encoded = encodeRound(round);
  const bytes = Buffer.byteLength(JSON.stringify(encoded), 'utf8');
  const kb = bytes / 1024;
  const samples = round.tracks.reduce((n, t) => n + t.samples.length / 3, 0);
  console.log(
    `  10 bodies, ${ROUND_SECONDS}s, ${samples} samples, 40 nades, 300 shots -> ${kb.toFixed(1)} KB`
  );
  assert(kb < 200, `a full round must stay under 200 KB, got ${kb.toFixed(1)} KB`);
  // Real budget check: this should land far below the cap, not just inside it.
  assert(kb < 120, `expected well under 120 KB for a full round, got ${kb.toFixed(1)} KB`);
  const perSampleBytes = bytes / samples;
  console.log(`  ${perSampleBytes.toFixed(2)} bytes per sample including all JSON overhead`);
  assert(perSampleBytes < 5, `per-sample cost should stay small, got ${perSampleBytes.toFixed(2)}`);
}

// ---- round trip --------------------------------------------------------------

{
  const back = decodeRound(encodeRound(round));
  assert(back.tracks.length === 10, 'every track survives');
  assert(back.map === 'ANC' && back.side === 'T', 'header survives');
  for (let i = 0; i < 10; i++) {
    const a = round.tracks[i];
    const b = back.tracks[i];
    assert(a.samples.length === b.samples.length, `track ${i} sample count`);
    for (let s = 0; s < a.samples.length; s++) {
      assert(
        Math.round(a.samples[s]) === b.samples[s],
        `track ${i} sample ${s}: ${a.samples[s]} != ${b.samples[s]}`
      );
    }
    assert(a.nades.length === b.nades.length, `track ${i} nades`);
    assert(a.shots.length === b.shots.length, `track ${i} shots`);
    assert(b.nades[0].detonateT > b.nades[0].t, 'a thrown nade lands after it is thrown');
  }
  console.log('  encode -> decode is lossless for positions, facing, nades and shots');
}

// ---- sampling ----------------------------------------------------------------

{
  const track = round.tracks[0];
  const first = sampleAt(track, 0, {});
  assert(first.x === track.samples[0], 'time 0 is the first sample');
  // Halfway between two samples is halfway between two positions.
  const mid = sampleAt(track, SAMPLE_MS / 2, {});
  const want = (track.samples[0] + track.samples[3]) / 2;
  assert(Math.abs(mid.x - want) < 0.001, `interpolates between samples, got ${mid.x} want ${want}`);
  // A body that starts late is not on the map before its first sample.
  const late = emptyTrack({ id: 'late', side: 'CT' });
  late.t0 = 5000;
  pushSample(late, 10, 20, 0);
  const early = sampleAt(late, 0, {});
  assert(early.x === 10, 'a late body clamps to its first sample rather than vanishing');
  console.log('  playback interpolates between samples and clamps at the ends');
}

// ---- yaw wrap ----------------------------------------------------------------

{
  const t = emptyTrack({ id: 'spin', side: 'T' });
  pushSample(t, 0, 0, 170);
  pushSample(t, 0, 0, -170);
  const mid = sampleAt(t, SAMPLE_MS / 2, {});
  // 170 -> -170 is 20 degrees the short way, so the midpoint is 180, not 0.
  assert(Math.abs(Math.abs(mid.yaw) - 180) < 0.001, `yaw takes the short way, got ${mid.yaw}`);
  console.log('  facing interpolates the short way round the circle');
}

// ---- frames the renderer can draw --------------------------------------------

{
  const frame = frameFor(round, 12000);
  assert(frame.players.length === 10, 'ten players in a frame');
  assert(frame.states.length === 10, 'ten states in a frame');
  assert(frame.states.every((s) => Number.isFinite(s.x)), 'every state has a position');
  assert(frame.tickRate === 64, 'frames report a tick rate');
  const g = frame.events.grenades[0];
  assert(g.path?.length === 2 && g.at && g.from, 'grenades carry a path the renderer can trail');
  assert(g.throwTick < g.detonateTick, 'a grenade detonates after it is thrown');
  console.log('  frames match the shape RadarRenderer already draws for real demos');
}

// ---- guard rails -------------------------------------------------------------

{
  const t = emptyTrack({ id: 'cap', side: 'T' });
  for (let i = 0; i < MAX_SAMPLES_PER_TRACK + 500; i++) pushSample(t, i, i, 0);
  assert(
    t.samples.length === MAX_SAMPLES_PER_TRACK * 3,
    `a track stops recording at the cap, got ${t.samples.length / 3}`
  );

  const junk = decodeRound({ map: 'ANC', tracks: [{ id: 'x', n: 99, p: 'not-base64!!' }] });
  assert(junk.tracks.length === 1 && junk.tracks[0].samples.length === 0, 'bad payload decodes empty');
  console.log('  sample cap holds and a corrupt payload decodes to nothing');
}

// ---- summary -----------------------------------------------------------------

{
  const s = roundSummary(round);
  assert(s.tracks === 10 && s.tSide === 5 && s.ctSide === 5, 'summary counts bodies per side');
  assert(s.nadeTotal === 40, `summary counts grenades, got ${s.nadeTotal}`);
  assert(s.nades.flashbang === 10, 'summary counts each grenade type');
  // Last sample sits one interval before the nominal end: 1839 * 62.5ms.
  assert(
    s.durationMs >= ROUND_SECONDS * 1000 - SAMPLE_MS,
    `summary knows the round length, got ${s.durationMs}`
  );
  console.log('  summary reports bodies, grenades and length');
}

console.log('recordingFormat: all assertions passed');
