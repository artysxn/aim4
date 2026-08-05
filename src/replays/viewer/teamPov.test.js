// Team POV: what one side is allowed to see.
//
// Run without a zone network, so every line of sight is clear and the tests are
// about the two things this module actually decides: the field-of-view and
// memory rules for enemy droplets, and which half of an overlay survives.

import { POV_MEMORY_SECONDS, createPovVision, povDuelOverlay, povZonePaint } from './teamPov.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const TICK = 64;

/** Slots 0-1 are T, slots 5-6 are CT. */
function meta() {
  return {
    tickRate: TICK,
    team1Side: 'T',
    team2Side: 'CT',
    players: [
      { id: 'p0', slot: 0, team: 1 },
      { id: 'p1', slot: 1, team: 1 },
      { id: 'p5', slot: 5, team: 2 },
      { id: 'p6', slot: 6, team: 2 }
    ],
    events: { grenades: [] }
  };
}

/** A living player at a point, facing `yaw`. */
function at(x, y, yaw, side) {
  return { alive: true, x, y, z: 0, yaw, side, health: 100, flags: 0 };
}

const seenAt = (vision, states, tick) =>
  vision.seenAt({
    meta: meta(),
    states,
    network: null,
    mapCode: 'DD2',
    tick,
    tickRate: TICK,
    povSide: 'T',
    roundKey: 'r1'
  });

// --- vision ------------------------------------------------------------------

{
  // A CT straight ahead is on screen; one directly behind is not.
  const states = [];
  states[0] = at(0, 0, 0, 'T');
  states[5] = at(500, 0, 180, 'CT');
  states[6] = at(-500, 0, 180, 'CT');

  const vision = createPovVision();
  const seen = seenAt(vision, states, 1000);
  assert(seen.has(5), 'enemy in front must be visible');
  assert(!seen.has(6), 'enemy behind must not be visible');
  assert(!seen.has(0) && !seen.has(1), 'own side is never in the seen set');
}

{
  // Losing sight holds the droplet for the memory window and then drops it.
  const states = [];
  states[0] = at(0, 0, 0, 'T');
  states[5] = at(500, 0, 180, 'CT');

  const vision = createPovVision();
  assert(seenAt(vision, states, 1000).has(5), 'seen on the first frame');

  // Same positions, but the T has turned around.
  states[0] = at(0, 0, 180, 'T');
  const hold = Math.floor(POV_MEMORY_SECONDS * TICK);
  assert(seenAt(vision, states, 1000 + hold - 2).has(5), 'held inside the memory window');
  assert(!seenAt(vision, states, 1000 + hold + 2).has(5), 'dropped once the memory lapses');
}

{
  // Seeking backwards is not a memory. A tick before anything was observed
  // must not inherit a later frame's sighting.
  const states = [];
  states[0] = at(0, 0, 0, 'T');
  states[5] = at(500, 0, 180, 'CT');

  const vision = createPovVision();
  seenAt(vision, states, 5000);
  states[0] = at(0, 0, 180, 'T');
  assert(!seenAt(vision, states, 1000).has(5), 'a backwards seek must drop the memory');
}

{
  // The whole POV side dead: nothing new is seen, and the last sighting still
  // ages out rather than blinking off.
  const states = [];
  states[0] = at(0, 0, 0, 'T');
  states[5] = at(500, 0, 180, 'CT');

  const vision = createPovVision();
  seenAt(vision, states, 1000);
  states[0] = { ...states[0], alive: false };
  assert(seenAt(vision, states, 1010).has(5), 'held while the memory lasts');
  assert(
    !seenAt(vision, states, 1000 + POV_MEMORY_SECONDS * TICK + 5).has(5),
    'gone once it lapses'
  );
}

// --- overlays ----------------------------------------------------------------

{
  const paint = {
    territory: { t: ['t1'], ct: ['ct1'], contested: ['x'] },
    cones: { t: ['tc'], ct: ['ctc'] },
    feet: { t: ['tf'], ct: ['ctf'] },
    footRadius: 90
  };
  const t = povZonePaint(paint, 'T');
  assert(t.territory.t.length === 1, 'own territory survives');
  assert(t.territory.ct.length === 0, 'enemy territory is dropped');
  assert(t.territory.contested.length === 0, 'contested ground is dropped');
  assert(t.cones.ct.length === 0 && t.feet.ct.length === 0, 'enemy cones and feet are dropped');
  assert(t.footRadius === 90, 'everything else is passed through');

  const ct = povZonePaint(paint, 'CT');
  assert(ct.territory.ct.length === 1 && ct.territory.t.length === 0, 'the other side, mirrored');
}

{
  const line = { aSlot: 0, aSide: 'T', bSlot: 5, bSide: 'CT' };
  const hiddenLine = { aSlot: 1, aSide: 'T', bSlot: 6, bSide: 'CT' };
  const overlay = {
    lines: [line, hiddenLine],
    rays: [
      { slot: 0, side: 'T' },
      { slot: 6, side: 'CT' }
    ],
    xk: [
      { slot: 5, side: 'CT' },
      { slot: 6, side: 'CT' }
    ],
    hover: hiddenLine,
    showPercent: true,
    trained: true
  };

  const out = povDuelOverlay(overlay, 'T', new Set([5]));
  assert(out.lines.length === 1 && out.lines[0] === line, 'only the seen pairing is drawn');
  assert(out.rays.length === 1 && out.rays[0].slot === 0, 'an unseen enemy casts no ray');
  assert(out.xk.length === 1 && out.xk[0].slot === 5, 'xK follows the same rule');
  assert(out.hover === null && out.showPercent === false, 'a dropped line cannot stay hovered');
  assert(out.trained === true, 'unrelated fields are passed through');
}

console.log('teamPov.test.js: ok');
