// ---------------------------------------------------------------------------
// dmMaps.js
// Which maps Deathmatch can be played on, and what kind of world each one is.
//
//   'boxes'  the trainer's own arena: a cover list, collided against with
//            BoxCollision.js, generated from deathmatch.json.
//   'mesh'   a CS2 map ported out of the 3D explorer's pack by
//            scripts/gen-trainer-map.mjs: one glb of flat-grey geometry plus
//            the authored collision hull, collided against with
//            MeshCollision.js.
//
// Only the arena is in the bundle. A ported map's data module is a few
// kilobytes of spawns and bounds; its geometry is fetched on demand the first
// time somebody picks it, and cached for the rest of the page.
// ---------------------------------------------------------------------------

import { DEATHMATCH_MAP } from '../scenarios/deathmatchMap.js';
import { DUST2_MAP_DATA } from './dust2MapData.js';

/** In menu order. `id` is what settings store. */
export const DM_MAPS = [
  { id: 'arena', label: 'Arena', kind: 'boxes', map: DEATHMATCH_MAP },
  { id: 'dust2', label: 'Dust 2', kind: 'mesh', data: DUST2_MAP_DATA }
];

export const DM_MAP_DEFAULT = 'arena';

/** The entry for an id, falling back to the arena rather than to nothing. */
export function dmMapById(id) {
  return DM_MAPS.find((m) => m.id === id) || DM_MAPS[0];
}

/** `<option>` rows for the Deathmatch map picker, in menu order. */
export function dmMapSelectOptions() {
  return DM_MAPS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
}
