// Run: node shared/sim/optionSegmenter.test.js
//
// The segmenter reads options off feet, so the tests are feet with known
// intentions: synthetic tracks whose true labels are constructed, not argued.
//
//   stillness with duration is a hold; a stutter-step is not
//   an excursion that comes back is a peek; one that keeps going is a move
//   a long move is a rotate, a reversal after damage is a fall_back
//   channels outrank feet, and clip the segments they overlap
//   every label is a real option id, and coverage is honest

import { coverage, optionAt, segmentTrack } from './optionSegmenter.js';
import { OPTION_DEFS } from './options.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const RATE = 64;
/** Build a track by walking instructions: ['still', seconds] | ['move', dx, dy, seconds]. */
function track(steps, stepSeconds = 0.125) {
  const poses = [];
  let x = 0;
  let y = 0;
  let tick = 0;
  const push = () => poses.push({ tick, x, y });
  push();
  for (const s of steps) {
    if (s[0] === 'still') {
      const n = Math.round(s[1] / stepSeconds);
      for (let i = 0; i < n; i += 1) {
        tick += stepSeconds * RATE;
        push();
      }
    } else {
      const [, dx, dy, seconds] = s;
      const n = Math.round(seconds / stepSeconds);
      for (let i = 0; i < n; i += 1) {
        tick += stepSeconds * RATE;
        x += dx / n;
        y += dy / n;
        push();
      }
    }
  }
  return poses;
}

// ---- holds --------------------------------------------------------------------

{
  const segs = segmentTrack({ poses: track([['still', 3]]) });
  assert(segs.length === 1 && segs[0].option === 'hold_angle', 'three seconds still is a hold');

  const stutter = segmentTrack({
    poses: track([
      ['move', 400, 0, 2],
      ['still', 0.5],
      ['move', 400, 0, 2]
    ])
  });
  assert(
    stutter.every((s) => s.option !== 'hold_angle'),
    `a half-second stutter is not a hold (${stutter.map((s) => s.option).join(',')})`
  );
  assert(stutter.length === 1 && stutter[0].option === 'advance', 'it is one advance');
}

// ---- peeks come back, moves keep going ------------------------------------------

{
  const peek = segmentTrack({
    poses: track([
      ['still', 2],
      ['move', 200, 0, 0.6],
      ['move', -200, 0, 0.7],
      ['still', 2]
    ])
  });
  const ids = peek.map((s) => s.option);
  assert(ids.includes('jiggle'), `out-and-back is a peek (${ids.join(',')})`);
  assert(ids.filter((i) => i === 'hold_angle').length === 2, 'between two holds');

  const through = segmentTrack({
    poses: track([
      ['still', 2],
      ['move', 700, 0, 2]
    ])
  });
  assert(
    through.map((s) => s.option).includes('advance'),
    'an excursion that keeps going is an advance'
  );
}

// ---- rotates and fall backs -----------------------------------------------------

{
  const rot = segmentTrack({ poses: track([['move', 2400, 800, 9]]) });
  assert(rot.length === 1 && rot[0].option === 'rotate', 'a cross-map move is a rotate');

  const poses = track([
    ['move', 600, 0, 2.4],
    ['move', -500, 60, 2]
  ]);
  const hurtAt = poses[Math.round(poses.length / 2)].tick - 8;
  const fb = segmentTrack({ poses, events: [{ type: 'damage', tick: hurtAt }] });
  assert(
    fb.some((s) => s.option === 'fall_back'),
    `a reversal after damage is a fall_back (${fb.map((s) => s.option).join(',')})`
  );

  const brave = segmentTrack({ poses });
  assert(
    !brave.some((s) => s.option === 'fall_back'),
    'the same reversal without the damage is just a move'
  );
}

// ---- channels outrank feet ------------------------------------------------------

{
  const poses = track([['still', 8]]);
  const segs = segmentTrack({
    poses,
    events: [
      { type: 'plant_start', tick: 128 },
      { type: 'plant_end', tick: 320 }
    ]
  });
  const plant = segs.find((s) => s.option === 'plant');
  assert(plant && plant.startTick === 128 && plant.endTick === 320, 'the channel is a segment');
  const holds = segs.filter((s) => s.option === 'hold_angle');
  assert(
    holds.every((h) => h.endTick <= plant.startTick || h.startTick >= plant.endTick),
    'and it clips the hold it interrupted'
  );
}

// ---- every label is a real option, and coverage is honest ------------------------

{
  const poses = track([
    ['still', 3],
    ['move', 300, 0, 1],
    ['still', 2],
    ['move', 2400, 300, 8],
    ['still', 1.5]
  ]);
  const segs = segmentTrack({ poses, events: [] });
  for (const s of segs) {
    assert(OPTION_DEFS[s.option], `${s.option} is in the vocabulary`);
    assert(s.endTick > s.startTick, 'segments run forward');
  }
  const c = coverage(segs, poses);
  assert(c > 0.85, `most of a clean track is labeled (${(c * 100).toFixed(0)}%)`);
  assert(coverage([], poses) === 0, 'no labels, no coverage');

  const again = segmentTrack({ poses, events: [] });
  assert(JSON.stringify(again) === JSON.stringify(segs), 'deterministic');
}

// ---- lurk, trade, execute_entry, spacing --------------------------------------

function teammateTrack(x, y, seconds, stepSeconds = 0.125) {
  const poses = [];
  let tick = 0;
  const n = Math.round(seconds / stepSeconds);
  for (let i = 0; i <= n; i += 1) {
    poses.push({ tick, x, y });
    tick += stepSeconds * RATE;
  }
  return poses;
}

{
  const me = track([['move', 600, 0, 3]]);
  const far = teammateTrack(0, 2500, 3);
  const segs = segmentTrack({ poses: me, teammates: [far] });
  assert(
    segs.some((s) => s.option === 'lurk'),
    `isolated from the pack is a lurk (${segs.map((s) => s.option).join(',')})`
  );
  assert(segs.some((s) => s.detail?.spacing), 'and the spacing is on the move');
}

{
  const poses = track([['move', 500, 0, 2]]);
  const deaths = [{ tick: 0, x: 400, y: 0 }];
  const segs = segmentTrack({ poses, deaths, teammates: [teammateTrack(0, 0, 2)] });
  assert(
    segs.some((s) => s.option === 'trade'),
    `moving toward a recent teammate death is a trade (${segs.map((s) => s.option).join(',')})`
  );
}

{
  const me = track([['move', 800, 0, 3]]);
  const t1 = teammateTrack(50, 40, 3);
  const t2 = teammateTrack(-30, 20, 3);
  const segs = segmentTrack({
    poses: me,
    teammates: [t1, t2],
    site: { x: 2000, y: 0 }
  });
  assert(
    segs.some((s) => s.option === 'execute_entry'),
    `a pack walking the site is execute_entry (${segs.map((s) => s.option).join(',')})`
  );
}

{
  const poses = track([['move', 400, 0, 2]]);
  const segs = segmentTrack({ poses, teammates: [teammateTrack(80, 0, 2)] });
  const hit = optionAt(segs, poses[Math.floor(poses.length / 2)].tick);
  assert(hit && hit.option === 'advance', 'optionAt finds the covering segment');
  assert(optionAt(segs, -1) == null, 'and misses ticks before the track');
}

console.log('optionSegmenter: ok');
