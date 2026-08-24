// ---------------------------------------------------------------------------
// dmMaps.js
// Which maps Deathmatch can be played on, and what kind of world each one is.
//
//   'boxes'  the trainer's own arena: a cover list, generated from
//            deathmatch.json, collided against as a triangle soup built from
//            the boxes (src/utils/simWorld.js).
//   'mesh'   a CS2 map ported out of the 3D explorer's pack by
//            scripts/gen-trainer-map.mjs: one glb of flat-grey geometry plus
//            the authored collision hull.
//
// Only the arena is in the bundle. A ported map's data module is a few
// kilobytes of spawns and bounds; its geometry is fetched on demand the first
// time somebody picks it, and cached for the rest of the page. Sizes are what
// the porter last wrote, so a pick is an informed one:
//
//   Mirage    3.8 MB      Dust 2   7.5 MB     Cache    7.5 MB
//   Nuke      7.8 MB      Anubis   8.3 MB     Ancient 11.6 MB
//   Inferno  13.4 MB
//
// Menu order is smallest first for that reason, after the arena.
// ---------------------------------------------------------------------------

import { DEATHMATCH_MAP } from '../scenarios/deathmatchMap.js';
import { DUST2_MAP_DATA } from './dust2MapData.js';
import { MIRAGE_MAP_DATA } from './mirageMapData.js';
import { INFERNO_MAP_DATA } from './infernoMapData.js';
import { NUKE_MAP_DATA } from './nukeMapData.js';
import { ANCIENT_MAP_DATA } from './ancientMapData.js';
import { ANUBIS_MAP_DATA } from './anubisMapData.js';
import { CACHE_MAP_DATA } from './cacheMapData.js';

/** In menu order. `id` is what settings store. */
export const DM_MAPS = [
  { id: 'arena', label: 'Arena', kind: 'boxes', map: DEATHMATCH_MAP },
  { id: 'mirage', label: 'Mirage', kind: 'mesh', data: MIRAGE_MAP_DATA },
  { id: 'dust2', label: 'Dust 2', kind: 'mesh', data: DUST2_MAP_DATA },
  { id: 'cache', label: 'Cache', kind: 'mesh', data: CACHE_MAP_DATA },
  { id: 'anubis', label: 'Anubis', kind: 'mesh', data: ANUBIS_MAP_DATA },
  { id: 'nuke', label: 'Nuke', kind: 'mesh', data: NUKE_MAP_DATA },
  { id: 'ancient', label: 'Ancient', kind: 'mesh', data: ANCIENT_MAP_DATA },
  { id: 'inferno', label: 'Inferno', kind: 'mesh', data: INFERNO_MAP_DATA }
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
