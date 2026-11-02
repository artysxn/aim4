// Run: node src/replays/zones/mapControl.test.js
import assert from 'node:assert/strict';
import { buildMapControlSeries, mapControlSeriesSteps, VISION_STRIDE } from './mapControl.js';

const cell = 32;
const cols = 16;
const rows = 16;
const count = cols * rows;
const geom = {
  mapCode: 'TEST',
  cell,
  area: cell * cell,
  originX: 0,
  originY: 0,
  cols,
  rows,
  count,
  walkable: new Uint8Array(count).fill(1),
  walkableCount: count,
  walkableArea: count * cell * cell
};

const STRIDES = 20;
const meta = {
  tickRate: 64,
  freezeEndTick: 1000,
  endTick: 1000 + VISION_STRIDE * STRIDES,
  team1Side: 'T',
  team2Side: 'CT',
  players: [
    { id: 'a', slot: 0, team: 1 },
    { id: 'b', slot: 1, team: 2 }
  ]
};
const track = {
  sampleAll(tick, out) {
    out[0] = { alive: true, x: 60 + (tick - 1000) * 0.5, y: 60, yaw: 0 };
    out[1] = { alive: true, x: 400, y: 400 - (tick - 1000) * 0.5, yaw: 180 };
    return out;
  }
};
const args = () => {
  const calls = { casts: 0 };
  return {
    calls,
    input: {
      meta,
      track,
      geom,
      castCone: () => {
        calls.casts++;
        return null;
      }
    }
  };
};

// Nothing runs until it is asked to: starting the job costs the frame nothing.
{
  const { calls, input } = args();
  const steps = mapControlSeriesSteps(input);
  assert.equal(calls.casts, 0);
  steps.next();
  assert.equal(calls.casts, 2, 'one step is one stride: a cone per living player');
}

// One step per stride, and the slices come out the same as the whole.
{
  const steps = mapControlSeriesSteps(args().input);
  let n = 0;
  let at = steps.next();
  while (!at.done) {
    n++;
    at = steps.next();
  }
  assert.equal(n, STRIDES + 1, 'first and last tick both included');
  const whole = buildMapControlSeries(args().input);
  assert.deepEqual(at.value, whole);
  assert.equal(whole.length, STRIDES + 1);
  assert.equal(whole[0].tick, 1000);
  assert.equal(whole.at(-1).tick, meta.endTick);
  for (const s of whole) assert.ok(Math.abs(s.t + s.ct + s.neu - 100) < 1e-6, 'shares add up');
  assert.ok(whole.at(-1).t > 0 && whole.at(-1).ct > 0, 'both sides hold the ground they stand on');
}

// Missing pieces end straight away, with an empty series and no work.
{
  assert.deepEqual(buildMapControlSeries({ meta, track, geom: null, castCone: () => null }), []);
  assert.deepEqual(mapControlSeriesSteps({}).next(), { done: true, value: [] });
}

console.log('mapControl.test.js: ok');
