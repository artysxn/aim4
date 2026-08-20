// ---------------------------------------------------------------------------
// replays/strategy/regionNames.js
// Naming ground, for text a coach reads.
//
// The painted hierarchy is Positions → Zones → Areas. The two questions a
// generated strategy asks of it are not the same question:
//
//   Where is this body?      A ZONE. Zones are the coarse names a call is made
//                            in ("Mid", "Underground"), and a note that listed
//                            every position footprint a player clipped would
//                            read like a GPS log.
//   Where did this land?     A POSITION. A grenade is a point, and the tight
//                            name is the useful one ("Top Car", not "A Site").
//
// Both fall back to the other layer when a map is painted at only one of them,
// and to nothing at all when the point is off the paint — an unnamed spot is
// left blank rather than guessed at, because a wrong landmark in a strat is
// worse than a missing one.
//
// Nuke stacks two floors under one radar, so a name lookup there is filtered
// by the body's world Z before anything else runs.
// ---------------------------------------------------------------------------

import { positionsAtPoint } from '../zones/pointInZone.js';
import { buildZoneIndex } from '../roles/zoneIndex.js';
import { mapHasStackedFloors, regionLevelForZ } from '../zones/zoneLevel.js';
import { pieceBounds } from '../zones/zoneGeom.js';

/**
 * @param {object|null} network
 * @param {string} mapCode
 */
export function createNamer(network, mapCode = '') {
  const zIndex = buildZoneIndex(network);
  const stacked = mapHasStackedFloors(mapCode);
  const positions = Array.isArray(network?.positions)
    ? network.positions
    : Array.isArray(network?.zones)
      ? network.zones.filter((z) => z?.pieces)
      : [];

  /** Cheap centroid per position, for "closest named spot" fallbacks. */
  const centers = positions
    .filter((p) => !p.hidden && p.pieces?.length)
    .map((p) => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const piece of p.pieces) {
        const b = pieceBounds(piece);
        if (!b) continue;
        sx += (b.minX + b.maxX) / 2;
        sy += (b.minY + b.maxY) / 2;
        n += 1;
      }
      return n ? { name: p.name || '', level: p.level || 'default', x: sx / n, y: sy / n } : null;
    })
    .filter((c) => c && c.name);

  const levelFor = (z) => (stacked ? regionLevelForZ(mapCode, z) : null);

  function hitsAt(x, y, z) {
    const level = levelFor(z);
    const hits = positionsAtPoint(x, y, network, level ? { level } : {});
    // A stacked map with nothing on the derived floor is usually a body on a
    // ledge between them; falling back to any floor beats naming nothing.
    return hits.length || !level ? hits : positionsAtPoint(x, y, network);
  }

  /**
   * The zone a body is standing in: the layer a strategy note measures
   * movement at.
   *
   * Zones are the coarse grouping, and that is the point of using them here. A
   * player crossing four painted positions inside one zone has not gone
   * anywhere a call cares about, and a note listing each of them would read
   * like a GPS log. Where a map is painted at the position layer only, the
   * position name stands in rather than leaving the body nowhere.
   *
   * No distance fallback: naming ground a player is merely near would put him
   * in places he never stood.
   */
  function zoneName(x, y, z = 0) {
    const hits = hitsAt(x, y, z);
    for (const pos of hits) {
      const zones = zIndex.zonesByPositionId?.get(pos.id) || [];
      if (zones[0]?.name) return zones[0].name;
    }
    return hits[0]?.name || '';
  }

  /**
   * Both layers for one point, from a single footprint test.
   *
   * A note measures entering at the zone layer and holding at the position
   * layer, so every position sample needs both names. Asking twice would walk
   * every painted footprint on the map twice per sample per player.
   */
  function namesAt(x, y, z = 0) {
    const hits = hitsAt(x, y, z);
    const position = hits[0]?.name || '';
    let zone = '';
    for (const pos of hits) {
      const zones = zIndex.zonesByPositionId?.get(pos.id) || [];
      if (zones[0]?.name) {
        zone = zones[0].name;
        break;
      }
    }
    return { zone: zone || position, position };
  }

  /** The position a point sits in, or the nearest named one within `maxUnits`. */
  function positionName(x, y, z = 0, maxUnits = 900) {
    const hit = hitsAt(x, y, z)[0];
    if (hit?.name) return hit.name;
    const level = levelFor(z);
    let best = '';
    let bestD = maxUnits * maxUnits;
    for (const c of centers) {
      if (level && c.level !== level) continue;
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = c.name;
      }
    }
    return best;
  }

  return { zoneName, namesAt, positionName, hasPaint: positions.length > 0 };
}
