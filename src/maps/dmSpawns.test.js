// Run: node src/maps/dmSpawns.test.js
//
// The getpos workflow, end to end and without a browser.
//
// The loop it has to close: stand somewhere in the map practice mode, type
// `getpos`, paste the line into src/maps/dmSpawns.js, and have the deathmatch
// player spawn in exactly that spot. Three coordinate systems and two unit
// scales are involved, all of them axis-swapped relative to each other, and
// every one of them is a place a sign can go quietly wrong — a spawn 90 degrees
// out looks like a bad spawn choice, not like a bug.
//
// So the test does what the workflow does. It takes the pack's own spawn
// entities (Source units — the same numbers `getpos` prints), formats them the
// way src/cs3d/main.js formats that command, parses them back with
// parseGetpos, and checks the result against what the porter independently
// wrote into the map data module. Two paths from one truth; they have to agree.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGetpos, dmSpawnsFor, DM_SPAWN_LINES } from './dmSpawns.js';
import { sceneToSource, UNIT_M, cameraYawFromSource } from '../../shared/sim3d/units.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('  ok:', msg);
    return;
  }
  failures++;
  console.error('  FAIL:', msg);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- the console line, exactly as the explorer prints it --------------------
// src/cs3d/main.js `onGetpos`: the player's FEET, which are in the explorer's
// SCENE frame (Source units but y-up — `manifest.frame` says so out loud), run
// back through sceneToSource and printed to two decimals.
//
// Which is the crux of the whole workflow and the easy thing to get wrong: the
// pack's spawn entities are scene-frame, so the porter converts them to metres
// with no axis swap at all, while a getpos line is true Source and dmSpawns.js
// must swap. Two different conversions of the same point, and the test is that
// they land on top of each other.
function formatGetpos(scenePos, sourceYaw = 0, pitch = 0) {
  const s = sceneToSource(scenePos[0], scenePos[1], scenePos[2]);
  return `setpos ${s[0].toFixed(2)} ${s[1].toFixed(2)} ${s[2].toFixed(2)}; setang ${pitch.toFixed(2)} ${sourceYaw.toFixed(2)} 0`;
}

// ---- the shape of the thing -------------------------------------------------
{
  const sp = parseGetpos('setpos -252.03 1234.50 -119.97; setang 3.40 -45.00 0');
  check(!!sp, 'a getpos line parses');
  // Source (x, y, z) → scene (x, z, −y), then units → metres.
  check(near(sp.pos[0], -252.03 * UNIT_M, 1e-9), 'x is x, in metres');
  check(near(sp.pos[1], -119.97 * UNIT_M, 1e-9), 'the trainer y is the Source z');
  check(near(sp.pos[2], -1234.5 * UNIT_M, 1e-9), 'the trainer z is minus the Source y');
  check(near(sp.camYaw, cameraYawFromSource(-45), 1e-12), 'camYaw is a three camera rotation.y');
  check(sp.yaw === -45, 'and `yaw` keeps the Source degrees it came from');

  check(parseGetpos('') === null, 'an empty line is not a spawn');
  check(parseGetpos('// a comment about mid') === null, 'a comment is not a spawn');
  check(parseGetpos('setpos 1 2') === null, 'two numbers are not a position');
  const bare = parseGetpos('-252.03 1234.50 -119.97');
  check(!!bare && near(bare.pos[0], -252.03 * UNIT_M, 1e-9), 'a bare triple works too');
  check(bare.yaw === 0, 'and faces Source yaw 0 when no angle was given');
}

// ---- the list is wired up, empty or not ------------------------------------
{
  const ids = Object.keys(DM_SPAWN_LINES);
  for (const id of ['dust2', 'mirage', 'inferno', 'nuke', 'ancient', 'anubis']) {
    check(ids.includes(id), `${id} has a spawn list to fill in`);
  }
  for (const id of ids) {
    const lines = DM_SPAWN_LINES[id];
    const out = dmSpawnsFor(id);
    if (!lines.length) {
      check(out === null, `${id}: an empty list falls back to the pack's spawns`);
      continue;
    }
    check(
      Array.isArray(out) && out.length === lines.filter((l) => parseGetpos(l)).length,
      `${id}: every readable line became a spawn (${out?.length} of ${lines.length})`
    );
    for (const sp of out) {
      check(
        sp.pos.every(Number.isFinite) && Number.isFinite(sp.camYaw),
        `${id}: no spawn came out with a NaN in it`
      );
    }
  }
}

// ---- the round trip, against a real map ------------------------------------
// The pack's spawn entities are the only Source-unit positions on disk whose
// trainer-frame answer is independently known: the porter wrote it out. So
// print them as getpos would, read them back, and compare.
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..');
  const pack = path.join(root, 'server', 'data', 'cs3d', 'pack', 'mirage', 'manifest.json');
  const data = path.join(root, 'src', 'maps', 'mirageMapData.js');
  if (!fs.existsSync(pack) || !fs.existsSync(data)) {
    console.log('  (no mirage pack or map data on disk — skipping the round trip)');
  } else {
    const manifest = JSON.parse(fs.readFileSync(pack, 'utf8'));
    const { MIRAGE_MAP_DATA } = await import('./mirageMapData.js');
    const entities = [...(manifest.spawns?.T || []), ...(manifest.spawns?.CT || [])];
    check(entities.length > 0, `the pack has ${entities.length} spawn entities to check against`);

    let worst = 0;
    for (let i = 0; i < entities.length; i++) {
      const line = formatGetpos(entities[i].pos, entities[i].yaw || 0);
      const sp = parseGetpos(line);
      // The porter's own conversion of the same entity. Its spawns are snapped
      // to the floor at LOAD time, not here, so the raw module value is the
      // right thing to compare against.
      const ref = MIRAGE_MAP_DATA.spawns[i].pos;
      for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs(sp.pos[a] - ref[a]));
    }
    // Two roundings, and between them they are the whole error budget: the
    // console prints two decimals of a Source unit (half a step = 0.005 u) and
    // the porter writes millimetres of a metre (half a step = 0.020 u). So
    // 0.03 u, which is 0.8 mm — a spawn point does not care and a sign error
    // would be thousands of units out, not fractions of one.
    check(worst < 0.03 * UNIT_M, `every spawn round-trips to within ${(worst / UNIT_M).toFixed(4)} u`);

    // And the direction survives. A three camera looks down -Z, so Source yaw 0
    // (+X) is a camera yaw of -90 degrees; getting this backwards spawns
    // everybody facing the wrong wall.
    const east = parseGetpos('setpos 0 0 0; setang 0 0 0');
    const fwd = [-Math.sin(east.camYaw), 0, -Math.cos(east.camYaw)];
    check(near(fwd[0], 1, 1e-9) && near(fwd[2], 0, 1e-9), 'Source yaw 0 faces +X in the trainer');
  }
}

console.log(failures ? `dmSpawns.test: ${failures} failure(s)` : 'dmSpawns.test: ok');
if (failures) process.exitCode = 1;
assert.ok(true);
