#!/usr/bin/env node
// Line of sight, tested on the real maps.
//
// Deliberately not synthetic. A hand-built wall would only prove the ray
// intersects a shape, which was never in doubt; what can actually go wrong is
// the calibration, the raster orientation, the endpoint margins and the corner
// slack, and every one of those only shows up against real geometry at real
// player positions. So this loads the radar masks that ship with the app and
// the painted vision blocks from the local zones directory, and asserts on
// sightlines a Dust2 player would recognise.
//
// Skips with a message if the painted geometry has not been fetched, since it
// lives on the backend rather than in the repo:
//   node scripts/fetch-zone-networks.mjs

import { hasVisionLayers } from '../src/replays/zones/visionLayers.js';
import { getZones } from '../server/zonesStore.js';
import {
  blockingSmokesAt,
  cornerSlack,
  getBlockedMask,
  losBlockedBetween,
  castSightRay,
  SMOKE_FADE_SECONDS,
  SMOKE_LIFETIME_SECONDS
} from '../src/replays/duels/sightRay.js';
import { angleOffset, bearingDeg, pairVision } from '../src/replays/duels/visionState.js';
import { watcherSpreadDeg } from '../src/replays/duels/duelSnapshot.js';
import { prepareControlField, registerRadarMask } from '../src/replays/zones/zoneOverlay.js';
import { RADAR_SIZE } from '../src/replays/viewer/mapCalibration.js';
import { loadRadarMask } from './lib/radarMask.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// --- pure geometry, no map needed -----------------------------------------
{
  assert(close(bearingDeg(0, 0, 100, 0), 0), 'east is 0 degrees');
  assert(close(bearingDeg(0, 0, 0, 100), 90), 'north is 90 degrees');
  assert(close(bearingDeg(0, 0, -100, 0), 180), 'west is 180 degrees');

  assert(close(angleOffset(0, 0), 0), 'no offset');
  assert(close(angleOffset(10, 350), 20), 'offset wraps the short way');
  assert(close(angleOffset(-170, 170), 20), 'offset wraps across the seam');
  assert(close(angleOffset(0, 180), 180), 'facing away is 180');
  assert(angleOffset(0, 200) <= 180, 'offset never exceeds 180');

  // Corner slack forgives more at close range, where a body width is a wide
  // angle, and less far away, where it is a rounding error.
  assert(cornerSlack(0) > cornerSlack(500), 'slack shrinks with range');
  assert(cornerSlack(500) > cornerSlack(3000), 'slack keeps shrinking');
  assert(cornerSlack(4000) > 0, 'slack never reaches zero');

  assert(close(watcherSpreadDeg([]), 0), 'no watchers, no spread');
  assert(close(watcherSpreadDeg([40]), 0), 'one watcher has no spread');
  assert(close(watcherSpreadDeg([0, 90]), 90), 'two watchers, plain case');
  assert(close(watcherSpreadDeg([350, 10]), 20), 'spread wraps the short way');
  assert(close(watcherSpreadDeg([0, 60, 150]), 150), 'spread is the widest gap, not the mean');
}

// --- smoke lifetime --------------------------------------------------------
{
  const tickRate = 64;
  const nades = [{ type: 'smokegrenade', detonateTick: 1000, at: { x: 0, y: 0 } }];
  const opaqueUntil = 1000 + (SMOKE_LIFETIME_SECONDS - SMOKE_FADE_SECONDS) * tickRate;
  assert(blockingSmokesAt(nades, 999, tickRate).length === 0, 'not blocking before it lands');
  assert(blockingSmokesAt(nades, 1001, tickRate).length === 1, 'blocking once it lands');
  assert(blockingSmokesAt(nades, opaqueUntil - 10, tickRate).length === 1, 'still blocking mid life');
  // The last seconds of a cloud are see-through enough to be shot through.
  assert(blockingSmokesAt(nades, opaqueUntil + 10, tickRate).length === 0, 'thinning smoke stops blocking');
  assert(
    blockingSmokesAt([{ type: 'flashbang', detonateTick: 1000, at: { x: 0, y: 0 } }], 1001, tickRate).length === 0,
    'only smoke blocks'
  );
}

// --- real Dust2 ------------------------------------------------------------
const network = await getZones('DD2');
if (!network || !hasVisionLayers(network)) {
  console.log('duel-vision.test.mjs: skipped, no painted zones. Run scripts/fetch-zone-networks.mjs');
  process.exit(0);
}

const mask = await loadRadarMask('DD2');
assert(mask && mask.length === RADAR_SIZE * RADAR_SIZE, 'radar mask should load at full size');
registerRadarMask('DD2', mask);
prepareControlField(network, 'DD2', null);

{
  const blocked = getBlockedMask(network, 'DD2');
  assert(blocked?.length === RADAR_SIZE * RADAR_SIZE, 'blocked mask should cover the radar');
  let n = 0;
  for (let i = 0; i < blocked.length; i++) if (blocked[i]) n++;
  const share = n / blocked.length;
  // Most of a 1024 square is off-map void; a map that blocked almost nothing or
  // almost everything would mean the mask or the calibration is wrong.
  assert(share > 0.3 && share < 0.9, `blocked share looks wrong: ${(share * 100).toFixed(1)}%`);
}

// Real positions taken from the parsed demos, checked against the map.
{
  const los = (ax, ay, bx, by, smokes = null) =>
    losBlockedBetween({ ax, ay, bx, by, network, mapCode: 'DD2', smokes });

  // Down long A, from pit toward the doors: the map's longest open sightline.
  assert(!los(1250, 1150, 570, 800), 'long A should be open');
  // Mid doors to CT mid, straight down mid.
  assert(!los(-450, -180, -480, 1500), 'mid should be open');
  // B tunnels to the A site, opposite ends of the map through everything.
  assert(los(-1950, 1500, 1250, 2300), 'tunnels to A site should be blocked');
  // Upper tunnels to long A, separated by the whole B side.
  assert(los(-1400, 1900, 1250, 1150), 'upper tunnels to long should be blocked');

  // A smoke on the line blocks it, and the same smoke does not block a pair
  // standing on top of each other inside it.
  const smoke = [{ x: 910, y: 975 }];
  assert(los(1250, 1150, 570, 800, smoke), 'a smoke across long should block');
  assert(!los(900, 960, 930, 990, smoke), 'players inside one cloud still see each other');
}

// Aim rays stop at geometry and are capped when they do not.
{
  // Along the sightline the pair test just confirmed is open, so the ray must
  // reach at least as far as the player standing at the far end of it.
  const toDoors = bearingDeg(1250, 1150, 570, 800);
  const open = castSightRay({ ox: 1250, oy: 1150, dirDeg: toDoors, maxDist: 4200, network });
  const doorsDist = Math.hypot(570 - 1250, 800 - 1150);
  assert(
    open.dist >= doorsDist,
    `a ray down an open sightline stopped at ${open.dist.toFixed(0)} before ${doorsDist.toFixed(0)}`
  );
  assert(Number.isFinite(open.x) && Number.isFinite(open.y), 'ray endpoint should be finite');
  let anyBlocked = false;
  for (let yaw = 0; yaw < 360; yaw += 15) {
    const r = castSightRay({ ox: 1250, oy: 1150, dirDeg: yaw, maxDist: 4200, network });
    assert(r.dist > 0 && r.dist <= 4200, `ray distance out of range at yaw ${yaw}`);
    if (r.blocked) anyBlocked = true;
  }
  assert(anyBlocked, 'some angle from long A pit must hit a wall');
}

// pairVision ties the geometry to the field of view.
{
  const at = (x, y, yaw) => ({ x, y, z: 0, yaw });
  // Two players down long, facing each other.
  const facing = pairVision({
    a: at(1250, 1150, bearingDeg(1250, 1150, 570, 800)),
    b: at(570, 800, bearingDeg(570, 800, 1250, 1150)),
    network,
    mapCode: 'DD2'
  });
  assert(facing.losClear, 'long A should be clear');
  assert(facing.aSeesB && facing.bSeesA, 'both should have the other on screen');
  assert(facing.offA < 1 && facing.offB < 1, 'both crosshairs should be on target');

  // Same pair, one turned around.
  const turned = pairVision({
    a: at(1250, 1150, bearingDeg(1250, 1150, 570, 800) + 180),
    b: at(570, 800, bearingDeg(570, 800, 1250, 1150)),
    network,
    mapCode: 'DD2'
  });
  assert(turned.losClear, 'turning around does not move the wall');
  assert(!turned.aSeesB, 'a player facing away cannot see');
  assert(turned.bSeesA, 'but is still visible themselves');
  assert(close(turned.offA, 180, 1), 'facing away is 180 degrees off');

  // Through the map: no line, so neither sees the other however they face.
  const wall = pairVision({
    a: at(-1950, 1500, bearingDeg(-1950, 1500, 1250, 2300)),
    b: at(1250, 2300, bearingDeg(1250, 2300, -1950, 1500)),
    network,
    mapCode: 'DD2'
  });
  assert(!wall.losClear, 'tunnels to A site should be blocked');
  assert(!wall.aSeesB && !wall.bSeesA, 'a blocked pair sees nothing regardless of aim');
}

console.log('duel-vision.test.mjs: ok');
