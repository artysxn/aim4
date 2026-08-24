// ---------------------------------------------------------------------------
// dmSpawns.js
// Hand-picked deathmatch spawns per map, written the way you find them.
//
// Why any of this exists. A ported map arrives with the spawns CS2 ships:
// fifteen T points in one corner and fifteen CT points in the other, all facing
// the same way, because that is what a competitive round needs. Free-for-all
// wants the opposite — points spread over the whole map, so that respawning is
// re-entering the fight somewhere new rather than walking back down long from
// T spawn for the ninth time.
//
// So: go into the map practice mode (/dust2, /mirage, ...), stand where a
// spawn belongs, look the way somebody spawning there should look, press Y and
// type `getpos`. It prints a line. Paste the line into the list below. That is
// the whole workflow, and the line is stored VERBATIM — no conversion by hand,
// no chance of a sign flip between the console and the file.
//
//   'setpos -252.03 1234.50 -119.97; setang 3.40 -45.00 0'
//
// A map with an empty list here keeps the pack's own spawns, so nothing is
// broken while a list is being filled in and a half-filled list is still an
// improvement over none.
//
// Coordinates are Source: units, z up, exactly what the console prints and
// exactly what `setpos` would take back. The conversion to the trainer's
// metres and y-up happens once, here, in `parseGetpos`.
// ---------------------------------------------------------------------------

import { UNIT_M, cameraYawFromSource } from '../../shared/sim3d/units.js';

/**
 * map id → getpos lines.
 *
 * Order does not matter; the spawn picker chooses by who can see where, not by
 * position in this list. Six to twelve well-spread points is plenty — past that
 * the picker is choosing between two spots in the same room.
 */
export const DM_SPAWN_LINES = {
  dust2: [],
  mirage: [],
  cache: [],
  inferno: [],
  nuke: [],
  ancient: [],
  anubis: []
};

/**
 * One console line → a spawn the trainer can use.
 *
 * Accepts what `getpos` prints and the things people type instead of it: the
 * `setang` half is optional, `setpos`/`setang` may be missing, and the
 * separator may be a semicolon or a newline. Returns null for a line that has
 * no three numbers in it, so a stray comment in the list above is ignored
 * rather than becoming a spawn at the origin.
 *
 * @param {string} line
 * @returns {{pos: [number, number, number], camYaw: number, yaw: number}|null}
 */
export function parseGetpos(line) {
  const text = String(line || '');
  const pos = /setpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i.exec(text)
    || /^\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(text);
  if (!pos) return null;
  const sx = Number(pos[1]);
  const sy = Number(pos[2]);
  const sz = Number(pos[3]);
  if (![sx, sy, sz].every(Number.isFinite)) return null;
  const ang = /setang\s+(-?[\d.]+)\s+(-?[\d.]+)/i.exec(text);
  const sourceYaw = ang ? Number(ang[2]) : 0;
  return {
    // Source (x, y, z) → scene (x, z, −y), then units → metres. The same
    // conversion shared/sim3d/units.js does for everything else; spelled out
    // through sourceToScene would allocate an array per spawn for no gain.
    pos: [sx * UNIT_M, sz * UNIT_M, -sy * UNIT_M],
    /**
     * What PlayerController.spawn() wants: a three camera rotation.y, radians.
     *
     * Its own field name, and NOT `yaw`, because the pack's spawns already
     * have a `yaw` and it is Source degrees. Two spawn lists flow through the
     * same picker into the same scenario, and a reader that cannot tell 45
     * degrees from 45 radians apart would be a bug nobody sees until they spawn
     * facing a wall.
     */
    camYaw: cameraYawFromSource(sourceYaw),
    yaw: sourceYaw
  };
}

/**
 * The hand-picked spawns for a map, or null when there are none yet.
 *
 * Null rather than an empty array on purpose: the caller falls back to the
 * pack's spawns, and "no list" and "a list with nothing in it" should not be
 * two different states to think about.
 */
export function dmSpawnsFor(id) {
  const lines = DM_SPAWN_LINES[id];
  if (!lines?.length) return null;
  const out = [];
  for (const line of lines) {
    const sp = parseGetpos(line);
    if (sp) out.push(sp);
  }
  return out.length ? out : null;
}
