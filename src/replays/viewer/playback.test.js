// Run with: node src/replays/viewer/playback.test.js
import assert from 'node:assert/strict';

// A frame clock the tests step by hand.
let queued = new Map();
let nextId = 1;
let clock = 1000;
globalThis.requestAnimationFrame = (fn) => {
  const id = nextId++;
  queued.set(id, fn);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  queued.delete(id);
};
globalThis.performance = { now: () => clock };

function frame(ms = 16) {
  clock += ms;
  const due = queued;
  queued = new Map();
  for (const fn of due.values()) fn(clock);
}

const { Playback } = await import('./playback.js');

function make(onFrame = () => {}) {
  queued = new Map();
  const p = new Playback(onFrame);
  p.setDuration(100);
  return p;
}

// A frame that throws costs that frame, not the transport.
{
  let calls = 0;
  const p = make(() => {
    calls++;
    if (calls === 2) throw new Error('draw failed');
  });
  p.play();
  frame();
  assert.equal(calls, 1);
  assert.throws(() => frame(), /draw failed/);
  assert.equal(p.playing, true);
  assert.equal(queued.size, 1, 'the next frame is still booked after a throw');
  const before = p.position;
  frame();
  assert.equal(calls, 3);
  assert.ok(p.position > before, 'the playhead keeps moving after the bad frame');
}

// Same on the way backwards.
{
  let calls = 0;
  const p = make(() => {
    calls++;
    if (calls === 1) throw new Error('draw failed');
  });
  p.position = 50;
  p.rewind(true);
  assert.throws(() => frame(), /draw failed/);
  assert.equal(queued.size, 1);
  const before = p.position;
  frame();
  assert.ok(p.position < before);
  p.rewind(false);
  assert.equal(queued.size, 0);
}

// A throw on the very last frame still stops at the end, and says so.
{
  const p = make(() => {
    throw new Error('draw failed');
  });
  let changes = 0;
  p.position = 99.999;
  p.play();
  p.onStateChange = () => changes++;
  assert.throws(() => frame(), /draw failed/);
  assert.equal(p.playing, false);
  assert.equal(p.position, 100);
  assert.equal(queued.size, 0);
  assert.equal(changes, 1);
}

// Running off the end is a state change the button has to hear about: nothing
// that asked for it is around to call syncPlayButton.
{
  const p = make();
  let changes = 0;
  p.onStateChange = () => changes++;
  p.position = 99.999;
  p.play();
  assert.equal(changes, 1);
  frame();
  assert.equal(p.playing, false);
  assert.equal(changes, 2);
  assert.equal(queued.size, 0);
}

// A pause from inside the frame sticks: nothing books a frame behind it.
{
  let p = null;
  p = make(() => p.pause());
  p.play();
  frame();
  assert.equal(p.playing, false);
  assert.equal(queued.size, 0);
}

// And a pause followed by a play from inside the frame leaves exactly one.
{
  let p = null;
  let flipped = false;
  p = make(() => {
    if (flipped) return;
    flipped = true;
    p.pause();
    p.play();
  });
  p.play();
  frame();
  assert.equal(p.playing, true);
  assert.equal(queued.size, 1);
}

// A rewind holds forward play and hands it back on release, telling each time.
{
  const p = make();
  let changes = 0;
  p.play();
  p.position = 50;
  p.onStateChange = () => changes++;
  p.rewind(true);
  assert.equal(p.playing, false);
  assert.equal(p.rewinding, true);
  assert.equal(changes, 2, 'once for the pause, once for the rewind');
  frame();
  assert.ok(p.position < 50);
  p.rewind(false);
  assert.equal(p.rewinding, false);
  assert.equal(p.playing, true);
  assert.equal(changes, 3);
  assert.equal(queued.size, 1);
}

// Paused when the rewind began: paused after it, and the button still hears it.
{
  const p = make();
  let changes = 0;
  p.position = 50;
  p.onStateChange = () => changes++;
  p.rewind(true);
  p.rewind(false);
  assert.equal(p.playing, false);
  assert.equal(changes, 2);
  assert.equal(queued.size, 0);
}

// A pause with nothing playing changes nothing, so it does not notify.
{
  const p = make();
  let changes = 0;
  p.onStateChange = () => changes++;
  p.pause();
  assert.equal(changes, 0);
}

// The first frame's timestamp can predate play(): never a step backwards.
{
  const seen = [];
  const p = make((pos) => seen.push(pos));
  p.position = 10;
  p.play();
  const due = queued;
  queued = new Map();
  for (const fn of due.values()) fn(clock - 8);
  assert.equal(seen[0], 10);
}

console.log('playback.test.js: ok');
