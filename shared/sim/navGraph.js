// ---------------------------------------------------------------------------
// shared/sim/navGraph.js
// Where a bot may stand, and how it gets from one place to another.
//
// Built on the SAME 256x256 lattice pathDistance.js already walks, at the same
// coarsening rule, rather than on a separate ~64 unit node graph. SIM-PLAN 4.2
// suggests the latter; matching the existing lattice is the better call for one
// reason that outweighs node count: every geodesic distance in this project
// (rotation timing, sound propagation, reachability inflation, trade windows)
// already comes from that lattice, and a nav graph with its own spacing would
// answer "how far is that" differently from the analysis stack. Two disagreeing
// notions of distance inside one simulation is the kind of bug that never
// produces an error, only a slowly wrong model.
//
// A cell is 4 radar pixels, so roughly 20 world units depending on the map's
// scale (4.4 u/px on Dust2, 7.0 on Nuke). Well under a player's size.
//
// Pathfinding is A* with a swappable cost functor, which is the shape CS's own
// nav_pathfind.h uses and the shape SIM-PLAN 6.14 needs: fastest, safest, and
// retreat are the same search with different costs, not three algorithms.
//
// DOM-free and world-agnostic: it takes a walkable mask and a calibration, and
// never loads anything. The browser gets its mask from zoneOverlay's cache, the
// trainer from scripts/lib/radarMask.mjs, and both get the same graph.
// ---------------------------------------------------------------------------

/** Radar pixels per lattice cell. Must match pathDistance.js CELL_PIXELS. */
export const CELL_PIXELS = 4;
/** Walkable pixels needed in a cell before it counts. Matches pathDistance.js. */
export const WALKABLE_PIXELS = 4;
/** Radar edge length in pixels. Matches mapCalibration RADAR_SIZE. */
export const RADAR_SIZE = 1024;
/** Lattice edge length in cells. */
export const GRID = RADAR_SIZE / CELL_PIXELS;

const SQRT2 = Math.SQRT2;

/** Player collision radius, in world units. Mirrors constants.js BODY_RADIUS. */
export const BODY_RADIUS = 16;

/**
 * Coarsen a 1024x1024 walkable mask to the lattice.
 *
 * The quarter-of-a-block threshold is pathDistance's, and it is a deliberate
 * compromise stated in that file: requiring all sixteen pixels closes every
 * corridor narrower than a cell, requiring one lets a path squeeze through the
 * corner of a wall.
 *
 * @param {Uint8Array} mask  RADAR_SIZE^2, 1 where walkable
 * @returns {Uint8Array} GRID^2, 1 where walkable
 */
export function coarsenMask(mask, centreOnly = false) {
  if (!mask || mask.length !== RADAR_SIZE * RADAR_SIZE) {
    throw new Error(`navGraph: expected a ${RADAR_SIZE}x${RADAR_SIZE} mask`);
  }
  const grid = new Uint8Array(GRID * GRID);
  const half = CELL_PIXELS >> 1;
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      if (centreOnly) {
        // The nav lattice is walked by steering at CELL CENTRES, so what has to
        // be clear is the centre, not some fraction of the cell. Inheriting
        // pathDistance's "any four of sixteen pixels" rule here produced cells
        // that were nominally walkable and whose centre had no body clearance
        // at all: routes existed, every cell on them was legal, and bodies
        // ground to a halt one step in because the point they were steering at
        // was inside a wall. Ten bots walking at a site produced two kills a
        // round for exactly this reason.
        if (mask[(gy * CELL_PIXELS + half) * RADAR_SIZE + gx * CELL_PIXELS + half]) {
          grid[gy * GRID + gx] = 1;
        }
        continue;
      }
      let n = 0;
      for (let py = 0; py < CELL_PIXELS; py += 1) {
        const row = (gy * CELL_PIXELS + py) * RADAR_SIZE + gx * CELL_PIXELS;
        for (let px = 0; px < CELL_PIXELS; px += 1) if (mask[row + px]) n += 1;
      }
      if (n >= WALKABLE_PIXELS) grid[gy * GRID + gx] = 1;
    }
  }
  return grid;
}

/**
 * Erode a walkable mask by a radius in pixels.
 *
 * The lattice says where the floor is; it does not say where a body fits. A
 * cell is 4 radar pixels, roughly 20 world units, and a player is a disc 32
 * units across, so a route down a one-cell corridor is a route the body
 * physically cannot walk: it wedges, both slide axes refuse, and it stops dead
 * halfway to its order. That failure is silent, looks like a pathing bug, and
 * is actually a clearance bug.
 *
 * So pathing runs on an eroded mask (where the body's CENTRE may go) and
 * collision runs on the raw one (where the body's EDGE may go). Nav is
 * conservative, collision is exact, and the two disagreeing is the point.
 *
 * @param {Uint8Array} mask  RADAR_SIZE^2
 * @param {number} radiusPx  body radius in radar pixels
 */
export function erodeMask(mask, radiusPx) {
  const r = Math.max(0, Math.ceil(radiusPx));
  if (!r) return mask;
  const out = new Uint8Array(mask.length);
  // Offsets inside the disc, computed once rather than per pixel.
  const offsets = [];
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy <= radiusPx * radiusPx) offsets.push(dy * RADAR_SIZE + dx);
    }
  }
  for (let y = r; y < RADAR_SIZE - r; y += 1) {
    const row = y * RADAR_SIZE;
    for (let x = r; x < RADAR_SIZE - r; x += 1) {
      const i = row + x;
      if (!mask[i]) continue;
      let fits = true;
      for (let k = 0; k < offsets.length; k += 1) {
        if (!mask[i + offsets[k]]) {
          fits = false;
          break;
        }
      }
      if (fits) out[i] = 1;
    }
  }
  return out;
}

/** Pack a 0/1 mask to one bit per pixel: 1 MB becomes 128 kB. */
export function packMask(mask) {
  const out = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

export function unpackMask(packed, length = RADAR_SIZE * RADAR_SIZE) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (packed[i >> 3] >> (i & 7)) & 1;
  return out;
}

/**
 * Which of a cell's eight neighbours a BODY can actually reach, as a bitmask.
 *
 * A lattice cell is about 20 world units across and a player is a disc 32 units
 * wide, so two cells being individually stand-able does not mean the step
 * between them is walkable: the disc sweeping from one centre to the other can
 * clip a corner that neither centre touches. A* over unvalidated adjacency then
 * produces routes that are legal cell by cell and impossible to walk, and the
 * symptom is a body that grinds against geometry forever while no path fails
 * and nothing errors.
 *
 * So the edges are validated once, at bake, exactly as a real nav mesh
 * validates its connections. Eight bits per cell, in neighbour order
 * (dx, dy) = (-1,-1) (0,-1) (1,-1) (-1,0) (1,0) (-1,1) (0,1) (1,1).
 */
export function buildEdgeMask(grid, solidAt, worldAt, samples = 6) {
  const edges = new Uint8Array(GRID * GRID);
  const NB = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1]
  ];

  for (let cy = 0; cy < GRID; cy += 1) {
    for (let cx = 0; cx < GRID; cx += 1) {
      const idx = cy * GRID + cx;
      if (!grid[idx]) continue;
      const a = worldAt(cx, cy);
      let bits = 0;

      for (let n = 0; n < NB.length; n += 1) {
        const nx = cx + NB[n][0];
        const ny = cy + NB[n][1];
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        if (!grid[ny * GRID + nx]) continue;

        const b = worldAt(nx, ny);
        let clear = true;
        for (let k = 0; k <= samples && clear; k += 1) {
          const t = k / samples;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          if (
            solidAt(x, y) ||
            solidAt(x + BODY_RADIUS, y) ||
            solidAt(x - BODY_RADIUS, y) ||
            solidAt(x, y + BODY_RADIUS) ||
            solidAt(x, y - BODY_RADIUS)
          ) {
            clear = false;
          }
        }
        if (clear) bits |= 1 << n;
      }
      edges[idx] = bits;
    }
  }
  return edges;
}

/** Bit index for a neighbour offset, or -1. */
export function edgeBit(dx, dy) {
  if (dx === -1 && dy === -1) return 0;
  if (dx === 0 && dy === -1) return 1;
  if (dx === 1 && dy === -1) return 2;
  if (dx === -1 && dy === 0) return 3;
  if (dx === 1 && dy === 0) return 4;
  if (dx === -1 && dy === 1) return 5;
  if (dx === 0 && dy === 1) return 6;
  if (dx === 1 && dy === 1) return 7;
  return -1;
}

/**
 * The nav graph for one map.
 *
 * Edges are implicit (8-connected neighbours of a walkable cell) rather than
 * stored, because a stored edge list for 65k nodes is megabytes of pointer
 * chasing to express "the cell next to this one". The diagonal rule is
 * pathDistance's: a diagonal step is only legal when at least one of the two
 * orthogonal cells beside it is open, so a body cannot cut the corner of a wall.
 */
export class NavGraph {
  /**
   * @param {string} mapCode
   * @param {Uint8Array|Record<string, Uint8Array>} grids  one lattice, or one
   *   per level. Stacked maps (Nuke) have two floor plans over the same world
   *   x/y, split at the calibration's `lowerZ`.
   * @param {{posX: number, posY: number, scale: number, lowerZ?: number}} calibration
   */
  constructor(mapCode, grids, calibration) {
    this.map = mapCode;
    /** @type {Record<string, Uint8Array>} */
    this.grids = grids instanceof Uint8Array ? { default: grids } : { ...grids };
    /**
     * Full-resolution solid masks for collision, per level. Set by
     * buildNavGraph / navGraphFromBake. Falls back to the lattice when absent,
     * which is coarser but never wrong in the dangerous direction.
     */
    this.solid = null;
    /** The default level's lattice, for callers that predate stacked maps. */
    this.grid = this.grids.default;
    this.levels = Object.keys(this.grids);
    this.cal = calibration;
    /** World units per lattice cell, for turning path length into distance. */
    this.cellUnits = calibration.scale * CELL_PIXELS;
    /** Named anchors, filled by attachPositions(). */
    this.anchors = new Map();
    /** Reverse index cell -> anchor id, built with them. */
    this._cellToAnchor = null;
    /** Validated adjacency per level, when the bake supplied it. */
    this.edges = null;

    /** @type {Record<string, number>} */
    this.walkableByLevel = {};
    for (const [level, g] of Object.entries(this.grids)) {
      let n = 0;
      for (let i = 0; i < g.length; i += 1) if (g[i]) n += 1;
      this.walkableByLevel[level] = n;
    }
    this.walkableCells = this.walkableByLevel.default || 0;
  }

  /**
   * Which floor a world z is on.
   *
   * This is the whole of stacked-map handling and it is one comparison, because
   * the calibration already carries the split (Nuke: CS2's default radar starts
   * at AltitudeMin -495 and the lower radar ends there). A body's level is a
   * property of where it is standing, not a mode anything has to be put into,
   * so walking down a ramp changes it with no transition logic at all.
   */
  levelFor(z) {
    const lowerZ = this.cal?.lowerZ;
    if (lowerZ === undefined || !Number.isFinite(z)) return 'default';
    return z < lowerZ ? 'lower' : 'default';
  }

  /** @returns {boolean} */
  isWalkableCell(cx, cy, level = 'default') {
    if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return false;
    const grid = this.grids[level] || this.grids.default;
    return grid[cy * GRID + cx] === 1;
  }

  /**
   * Cells walkable on more than one level: where a body can change floor.
   *
   * Geometry only names the candidates. Which of them players actually use, and
   * in which direction, is a fact about the map that the demo library answers
   * directly: every round in it carries z per tick, so the x/y cells where z
   * crosses `lowerZ` are the real staircases, ramps, and vents. Mining those is
   * strictly better than painting them and it is what `transitions` is filled
   * from when a library is available (SIM-PLAN 4.2).
   */
  transitionCells() {
    if (this.levels.length < 2) return [];
    const out = [];
    for (let i = 0; i < GRID * GRID; i += 1) {
      let on = 0;
      for (const level of this.levels) if (this.grids[level][i]) on += 1;
      if (on > 1) out.push(i);
    }
    return out;
  }

  /**
   * Is this world point inside geometry, at full radar resolution?
   *
   * This is what the engine collides against, and it is deliberately finer than
   * the lattice: a body should be able to stand closer to a wall than the cell
   * grid can express, otherwise corners feel rounded off and angles a player
   * can hold are unreachable.
   */
  isSolidWorld(worldX, worldY, level = 'default') {
    const mask = this.solid?.[level] || this.solid?.default;
    if (!mask) {
      const c = this.cellAt(worldX, worldY);
      return !this.isWalkableCell(c.cx, c.cy, level);
    }
    const px = Math.floor((worldX - this.cal.posX) / this.cal.scale);
    const py = Math.floor((this.cal.posY - worldY) / this.cal.scale);
    if (px < 0 || py < 0 || px >= RADAR_SIZE || py >= RADAR_SIZE) return true;
    return !mask[py * RADAR_SIZE + px];
  }

  /** World point to lattice cell. Does not check walkability. */
  cellAt(worldX, worldY) {
    const px = (worldX - this.cal.posX) / this.cal.scale;
    const py = (this.cal.posY - worldY) / this.cal.scale;
    return { cx: Math.floor(px / CELL_PIXELS), cy: Math.floor(py / CELL_PIXELS) };
  }

  /** Lattice cell to the world point at its centre. */
  worldAt(cx, cy) {
    const px = (cx + 0.5) * CELL_PIXELS;
    const py = (cy + 0.5) * CELL_PIXELS;
    return { x: this.cal.posX + px * this.cal.scale, y: this.cal.posY - py * this.cal.scale };
  }

  /**
   * The nearest walkable cell to a world point, searched outward in rings.
   *
   * Spawn points and demo-sampled positions land a few units inside geometry
   * often enough that this cannot be optional: a spawn that does not resolve is
   * a round that cannot start.
   *
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} [maxRings]  give up beyond this many cells out
   * @returns {{cx: number, cy: number}|null}
   */
  nearestWalkable(worldX, worldY, maxRings = 16, level = 'default') {
    const { cx, cy } = this.cellAt(worldX, worldY);
    if (this.isWalkableCell(cx, cy, level)) return { cx, cy, level };
    for (let r = 1; r <= maxRings; r += 1) {
      let best = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          // Ring only: the interior was covered by a smaller r.
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.isWalkableCell(nx, ny, level)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { cx: nx, cy: ny, level };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * True when a diagonal step from (cx, cy) by (dx, dy) is legal. Orthogonal
   * steps are always legal onto a walkable cell.
   */
  canStep(cx, cy, dx, dy, level = 'default') {
    if (!this.isWalkableCell(cx + dx, cy + dy, level)) return false;

    // Validated adjacency wins when the bake computed it: it is the only test
    // that knows whether a BODY fits through the step rather than whether two
    // cells happen to be stand-able.
    const mask = this.edges?.[level] || this.edges?.default;
    if (mask) {
      if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return false;
      const bit = edgeBit(dx, dy);
      return bit >= 0 && (mask[cy * GRID + cx] & (1 << bit)) !== 0;
    }

    if (dx === 0 || dy === 0) return true;
    return (
      this.isWalkableCell(cx + dx, cy, level) || this.isWalkableCell(cx, cy + dy, level)
    );
  }

  /**
   * Attach the painted positions as named anchors.
   *
   * A painted position is a REGION, not a point: `{id, name, level, pieces[]}`
   * where a piece is a rect or a poly in world coordinates. That matters more
   * than it looks. "Banana" is not a spot, it is an area a bot can be anywhere
   * inside, so the graph stores the cells it covers as well as a single anchor
   * cell to path toward. The cell set is what the doctrine's zone classifier
   * reads (SIM-PLAN 20.2) and what the angle catalogue enumerates within (6.8);
   * the anchor is what a movement intent names.
   *
   * The anchor is chosen as the covered walkable cell nearest the covered
   * centroid, so it is always inside the position and always stand-able. Taking
   * the geometric centre instead would put the anchor for an L-shaped position
   * in a wall.
   *
   * @param {Array<{id?: string, name: string, level?: string, pieces?: Array}>} positions
   * @param {(x: number, y: number, piece: object) => boolean} pointInPiece
   *   passed in rather than imported so this file stays free of src/ imports
   *   and can be bundled for the browser, the server, and the trainer alike
   * @returns {{attached: number, skipped: string[], empty: string[]}}
   */
  attachPositions(positions, pointInPiece) {
    const skipped = [];
    const empty = [];
    let attached = 0;

    for (const p of positions || []) {
      const pieces = Array.isArray(p.pieces) ? p.pieces : [];
      if (!pieces.length) {
        skipped.push(p.name || p.id || '(unnamed)');
        continue;
      }

      // Bounds over every piece, so the raster only visits cells that could hit.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const piece of pieces) {
        for (const [x, y] of cornersOf(piece)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (!Number.isFinite(minX)) {
        skipped.push(p.name || p.id || '(unnamed)');
        continue;
      }

      // World Y grows north and radar Y grows down, so maxY maps to the low row.
      const level = p.level || 'default';
      const topLeft = this.cellAt(minX, maxY);
      const bottomRight = this.cellAt(maxX, minY);
      const cells = [];
      let sumX = 0;
      let sumY = 0;

      for (let cy = topLeft.cy; cy <= bottomRight.cy; cy += 1) {
        for (let cx = topLeft.cx; cx <= bottomRight.cx; cx += 1) {
          // Against its OWN level's lattice: a lower-level position on Nuke
          // covers ground the default radar draws as solid, and rasterizing it
          // against the wrong floor plan produces an empty position or, worse,
          // a plausible-looking wrong one.
          if (!this.isWalkableCell(cx, cy, level)) continue;
          const w = this.worldAt(cx, cy);
          let inside = false;
          for (const piece of pieces) {
            if (pointInPiece(w.x, w.y, piece)) {
              inside = true;
              break;
            }
          }
          if (!inside) continue;
          cells.push(cy * GRID + cx);
          sumX += cx;
          sumY += cy;
        }
      }

      const id = anchorId(p.name || p.id);

      if (!cells.length) {
        // Painted over unwalkable ground, or smaller than a lattice cell. Fall
        // back to the nearest stand-able cell to the region's centre so the name
        // is still addressable, and report it: a position that covers no
        // walkable ground is usually a painting mistake worth seeing.
        const cell = this.nearestWalkable((minX + maxX) / 2, (minY + maxY) / 2, 16, level);
        if (!cell) {
          skipped.push(p.name || p.id || '(unnamed)');
          continue;
        }
        empty.push(p.name || p.id || '(unnamed)');
        this.anchors.set(id, {
          id,
          name: p.name || id,
          level,
          cells: [],
          cx: cell.cx,
          cy: cell.cy,
          world: this.worldAt(cell.cx, cell.cy)
        });
        attached += 1;
        continue;
      }

      // Covered cell nearest the covered centroid: inside by construction.
      const midX = sumX / cells.length;
      const midY = sumY / cells.length;
      let best = cells[0];
      let bestD = Infinity;
      for (const idx of cells) {
        const cx = idx % GRID;
        const cy = (idx / GRID) | 0;
        const d = (cx - midX) ** 2 + (cy - midY) ** 2;
        if (d < bestD) {
          bestD = d;
          best = idx;
        }
      }

      this.anchors.set(id, {
        id,
        name: p.name || id,
        level,
        cells,
        cx: best % GRID,
        cy: (best / GRID) | 0,
        world: this.worldAt(best % GRID, (best / GRID) | 0)
      });
      attached += 1;
    }

    this._indexCells();
    return { attached, skipped, empty };
  }

  /**
   * @returns {{cx: number, cy: number, cells: number[]}|null}
   *
   * The map's keys are already canonical, and almost every caller passes an id
   * that came out of the graph, so the common case is a plain lookup. Slugging
   * first made two regexes the price of every anchor read, which the doctrine
   * frame and the space field turn into six figures of regex per round.
   * Normalization stays for callers passing a display name.
   */
  anchor(id) {
    const direct = this.anchors.get(id);
    if (direct) return direct;
    return this.anchors.get(anchorId(id)) || null;
  }

  /**
   * The anchor whose cell set contains this cell, or null.
   *
   * Backed by a reverse index rather than a scan: the doctrine's zone
   * classifier (SIM-PLAN 20.2) asks this for every walkable cell several times
   * a second, and a scan over sixty anchors would make that the most expensive
   * thing in the engine. Positions do overlap ("B site" and "B coffins"); the
   * index keeps the smallest one, because the more specific name is the one a
   * caller means.
   */
  positionAt(cx, cy, level = 'default') {
    const index = this._cellToAnchor?.get(level);
    if (!index) return null;
    const id = index.get(cy * GRID + cx);
    return id ? this.anchors.get(id) || null : null;
  }

  /**
   * Rebuild the cell to anchor index, one per level.
   *
   * Per level, not one index, because Nuke's floors occupy the same radar
   * pixels: "ramp" and "heaven" are the same cells at different heights, and a
   * single index would answer one of them at random. This makes the *vocabulary*
   * correct on two-floor maps. It does not make *pathing* correct: the lattice
   * is still 2D, so A* can currently walk from an upper cell to a lower one as
   * though they touched. Nuke therefore needs a second lattice from
   * de_nuke_lower.png before it can be trained on, and SIM-PLAN 14.6's rule
   * applies until then: bake it honestly or leave it out, never train on a
   * lying nav.
   */
  _indexCells() {
    /** @type {Map<string, Map<number, string>>} */
    const byLevel = new Map();
    const sizeOf = new Map();

    for (const a of this.anchors.values()) {
      sizeOf.set(a.id, a.cells.length);
      const level = a.level || 'default';
      let index = byLevel.get(level);
      if (!index) {
        index = new Map();
        byLevel.set(level, index);
      }
      for (const idx of a.cells) {
        const held = index.get(idx);
        // Positions overlap within a level too ("B site" contains "B coffins").
        // The smaller one wins, because the more specific name is the one a
        // caller means.
        if (held === undefined || a.cells.length < sizeOf.get(held)) index.set(idx, a.id);
      }
    }

    this._cellToAnchor = byLevel;
  }

  /**
   * How much of this map's walkable ground has a name, per level.
   *
   * A bake report rather than a runtime call. Coverage well under 100% means
   * bots have somewhere to stand that no order can send them to; over 100% on
   * one level means positions overlap more than they should.
   */
  anchorCoverage() {
    const out = {};
    for (const [level, index] of this._cellToAnchor || []) {
      out[level] = { named: index.size, walkable: this.walkableByLevel[level] ?? this.walkableCells };
    }
    return out;
  }
}

/** Corner points of a rect or poly piece, for bounds. */
function cornersOf(piece) {
  if (piece?.type === 'poly' && Array.isArray(piece.ring)) return piece.ring;
  const { x = 0, y = 0, w = 0, h = 0 } = piece || {};
  return [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h]
  ];
}

/** Anchor ids are lowercase snake so they survive a JSON round trip unchanged. */
export function anchorId(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * A* from one cell to another.
 *
 * `cost(cx, cy, graph)` is a per-cell multiplier on top of the step length,
 * defaulting to 1. This is the seam SIM-PLAN 6.14 needs: the safest route is
 * the same search with danger added to the cost, and the retreat route is the
 * same search away from a threat. Returning Infinity makes a cell impassable
 * for this query without touching the graph.
 *
 * @param {NavGraph} graph
 * @param {{cx: number, cy: number}} from
 * @param {{cx: number, cy: number}} to
 * @param {{cost?: (cx: number, cy: number) => number, maxExpansions?: number}} [opts]
 * @returns {{cells: Array<{cx: number, cy: number}>, cost: number, units: number}|null}
 */
export function findPath(graph, from, to, opts = {}) {
  const cost = opts.cost || null;
  const N = GRID * GRID;

  // The search space is (cell, level). On a single-level map that is just the
  // lattice; on a stacked map it is both floor plans plus the cells where a
  // body can move between them, which is how a bot walks Nuke ramp to heaven
  // without anything special-casing Nuke.
  const levels = graph.levels;
  const levelIndex = new Map(levels.map((l, i) => [l, i]));
  const size = N * levels.length;
  const maxExpansions = opts.maxExpansions || size;

  const fromLevel = from.level || 'default';
  const toLevel = to.level || 'default';
  if (!levelIndex.has(fromLevel) || !levelIndex.has(toLevel)) return null;
  if (!graph.isWalkableCell(from.cx, from.cy, fromLevel)) return null;
  if (!graph.isWalkableCell(to.cx, to.cy, toLevel)) return null;

  // Cells a body may change level on. Empty on every map but Nuke.
  const transitions = levels.length > 1 ? new Set(graph.transitionCells()) : null;

  const enc = (idx, li) => li * N + idx;
  const start = enc(from.cy * GRID + from.cx, levelIndex.get(fromLevel));
  const goal = enc(to.cy * GRID + to.cx, levelIndex.get(toLevel));
  if (start === goal) {
    return { cells: [{ cx: from.cx, cy: from.cy, level: fromLevel }], cost: 0, units: 0 };
  }

  const g = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  g[start] = 0;

  // Binary heap over (f, index). Small enough to keep inline rather than
  // importing a structure; this is the hottest allocation site in the engine.
  const heapIdx = [];
  const heapF = [];
  const push = (idx, f) => {
    heapIdx.push(idx);
    heapF.push(f);
    let i = heapIdx.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      [heapIdx[p], heapIdx[i]] = [heapIdx[i], heapIdx[p]];
      i = p;
    }
  };
  const pop = () => {
    const topIdx = heapIdx[0];
    const lastIdx = heapIdx.pop();
    const lastF = heapF.pop();
    if (heapIdx.length) {
      heapIdx[0] = lastIdx;
      heapF[0] = lastF;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < heapF.length && heapF[l] < heapF[s]) s = l;
        if (r < heapF.length && heapF[r] < heapF[s]) s = r;
        if (s === i) break;
        [heapF[s], heapF[i]] = [heapF[i], heapF[s]];
        [heapIdx[s], heapIdx[i]] = [heapIdx[i], heapIdx[s]];
        i = s;
      }
    }
    return topIdx;
  };

  // Octile distance: exact for 8-connected movement, so A* stays admissible and
  // does not expand more than it must.
  const h = (state) => {
    const idx = state % N;
    const cx = idx % GRID;
    const cy = (idx / GRID) | 0;
    const dx = Math.abs(cx - to.cx);
    const dy = Math.abs(cy - to.cy);
    // Level is deliberately not in the heuristic: a floor change costs one step
    // and adding it would not stay admissible when start and goal share a level
    // but the route dips through the other one.
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };

  push(start, h(start));
  let expansions = 0;

  while (heapIdx.length) {
    const current = pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) break;
    if (++expansions > maxExpansions) return null;

    const idx = current % N;
    const li = (current / N) | 0;
    const level = levels[li];
    const cx = idx % GRID;
    const cy = (idx / GRID) | 0;

    const relax = (nState, ncx, ncy, nLevel, step) => {
      if (closed[nState]) return;
      const mult = cost ? cost(ncx, ncy, nLevel) : 1;
      if (!(mult < Infinity)) return;
      const tentative = g[current] + step * mult;
      if (tentative >= g[nState]) return;
      g[nState] = tentative;
      cameFrom[nState] = current;
      push(nState, tentative + h(nState));
    };

    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        if (!graph.canStep(cx, cy, dx, dy, level)) continue;
        relax(enc((cy + dy) * GRID + (cx + dx), li), cx + dx, cy + dy, level, dx && dy ? SQRT2 : 1);
      }
    }

    // Change floor in place, where the geometry says a body can.
    if (transitions && transitions.has(idx)) {
      for (let ol = 0; ol < levels.length; ol += 1) {
        if (ol === li) continue;
        if (!graph.isWalkableCell(cx, cy, levels[ol])) continue;
        relax(enc(idx, ol), cx, cy, levels[ol], 1);
      }
    }
  }

  if (!closed[goal] || g[goal] === Infinity) return null;

  const cells = [];
  for (let at = goal; at !== -1; at = cameFrom[at]) {
    const i = at % N;
    cells.push({ cx: i % GRID, cy: (i / GRID) | 0, level: levels[(at / N) | 0] });
    if (at === start) break;
  }
  cells.reverse();

  // Path length in cells, ignoring the cost multipliers, so `units` is a real
  // distance rather than a score. A caller pricing a route wants both.
  let steps = 0;
  for (let i = 1; i < cells.length; i += 1) {
    const dx = Math.abs(cells[i].cx - cells[i - 1].cx);
    const dy = Math.abs(cells[i].cy - cells[i - 1].cy);
    if (!dx && !dy) continue; // a floor change is not lateral travel
    steps += dx && dy ? SQRT2 : 1;
  }

  return { cells, cost: g[goal], units: steps * graph.cellUnits };
}

/**
 * Build a graph from a full-resolution walkable mask.
 *
 * @param {string} mapCode
 * @param {Uint8Array} mask  RADAR_SIZE^2
 * @param {{posX: number, posY: number, scale: number}} calibration
 * @returns {NavGraph}
 */
export function buildNavGraph(mapCode, masks, calibration) {
  if (!calibration || !Number.isFinite(calibration.scale)) {
    throw new Error(`navGraph: no calibration for ${mapCode}`);
  }
  const byLevel = masks instanceof Uint8Array ? { default: masks } : masks;
  const radiusPx = BODY_RADIUS / calibration.scale;

  const grids = {};
  const solid = {};
  for (const [level, mask] of Object.entries(byLevel)) {
    if (!mask) continue;
    solid[level] = mask;
    grids[level] = coarsenMask(erodeMask(mask, radiusPx), true);
  }
  if (!grids.default) throw new Error(`navGraph: ${mapCode} has no default-level mask`);

  const graph = new NavGraph(mapCode, grids, calibration);
  graph.solid = solid;

  graph.edges = {};
  for (const level of Object.keys(grids)) {
    const edges = buildEdgeMask(
      grids[level],
      (x, y) => graph.isSolidWorld(x, y, level),
      (cx, cy) => graph.worldAt(cx, cy)
    );

    // A cell a body cannot leave is not somewhere a body can be. Erosion plus
    // centre-sampling leaves a small tail of these (1 to 3% per map, all of
    // them slivers against geometry), and edge validation already stops A*
    // routing through them. Pruning them as well keeps `isWalkableCell` an
    // honest answer rather than one that has to be read together with the edge
    // mask, and it means a spawn or an anchor that lands on one is refused at
    // bake rather than producing a body that cannot move.
    let pruned = 0;
    for (let i = 0; i < edges.length; i += 1) {
      if (grids[level][i] && edges[i] === 0) {
        grids[level][i] = 0;
        pruned += 1;
      }
    }
    graph.edges[level] = edges;
    graph.prunedByLevel = graph.prunedByLevel || {};
    graph.prunedByLevel[level] = pruned;
  }

  // Recount after pruning, or the bake reports cells that are no longer there.
  for (const [level, g2] of Object.entries(grids)) {
    let n = 0;
    for (let i = 0; i < g2.length; i += 1) if (g2[i]) n += 1;
    graph.walkableByLevel[level] = n;
  }
  graph.walkableCells = graph.walkableByLevel.default || 0;

  return graph;
}

/**
 * Seconds for a side to reach every cell from its spawns, at run speed.
 *
 * CS's own nav analysis computes `m_earliestOccupyTime[team]` and SIM-PLAN 6.8
 * calls it "the entire timing game precomputed as one float per area per side".
 * The useful quantity is the DIFFERENCE: `earliest[T] - earliest[CT]` for a
 * cell is who wins the race to it from a standing start, per map, as a single
 * number. Add the live clock and the belief and you have the question a T
 * player actually asks: can I be at car before they can be at logs.
 *
 * Multi-source Dijkstra, so all of a side's spawns seed the queue at once and
 * one sweep answers for every cell rather than one sweep per spawn.
 *
 * @param {NavGraph} graph
 * @param {Array<{x: number, y: number}>} spawns  one side's pool
 * @param {number} speed  units per second
 * @returns {Float32Array} seconds per cell, Infinity where unreachable
 */
export function earliestOccupy(graph, spawns, speed = 215) {
  const N = GRID * GRID;
  const time = new Float32Array(N).fill(Infinity);
  if (!spawns?.length || !(speed > 0)) return time;

  // Bucket queue over quantized time: distances here are multiples of one or
  // sqrt(2) cell widths, so a heap's log factor buys nothing a bucket cannot.
  const heapIdx = [];
  const heapKey = [];
  const push = (idx, key) => {
    heapIdx.push(idx);
    heapKey.push(key);
    let i = heapIdx.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p] <= heapKey[i]) break;
      [heapKey[p], heapKey[i]] = [heapKey[i], heapKey[p]];
      [heapIdx[p], heapIdx[i]] = [heapIdx[i], heapIdx[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heapIdx[0];
    const li = heapIdx.pop();
    const lk = heapKey.pop();
    if (heapIdx.length) {
      heapIdx[0] = li;
      heapKey[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let sm = i;
        if (l < heapKey.length && heapKey[l] < heapKey[sm]) sm = l;
        if (r < heapKey.length && heapKey[r] < heapKey[sm]) sm = r;
        if (sm === i) break;
        [heapKey[sm], heapKey[i]] = [heapKey[i], heapKey[sm]];
        [heapIdx[sm], heapIdx[i]] = [heapIdx[i], heapIdx[sm]];
        i = sm;
      }
    }
    return top;
  };

  for (const s of spawns) {
    const cell = graph.nearestWalkable(s.x, s.y);
    if (!cell) continue;
    const idx = cell.cy * GRID + cell.cx;
    if (time[idx] !== 0) {
      time[idx] = 0;
      push(idx, 0);
    }
  }

  const stepSeconds = graph.cellUnits / speed;
  while (heapIdx.length) {
    const cur = pop();
    const base = time[cur];
    const cx = cur % GRID;
    const cy = (cur / GRID) | 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        if (!graph.canStep(cx, cy, dx, dy)) continue;
        const n = (cy + dy) * GRID + (cx + dx);
        const t = base + stepSeconds * (dx && dy ? SQRT2 : 1);
        if (t >= time[n]) continue;
        time[n] = t;
        push(n, t);
      }
    }
  }
  return time;
}

/** Base64 to bytes, in node and in the browser, without a dependency. */
function decodeBase64(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** The bake format version this build can read. Must match sim-bake-map.mjs. */
export const BAKE_VERSION = 3;

/**
 * Rebuild a graph from a bake written by scripts/sim-bake-map.mjs.
 *
 * The version check throws rather than coping. A bake is a cache of a
 * derivation, so a mismatch means the derivation changed, and quietly reading
 * an old one produces a simulation running on geometry that no longer matches
 * the code that made it. Re-bake instead.
 *
 * @param {object} bake  parsed JSON
 * @returns {NavGraph}
 */
export function navGraphFromBake(bake) {
  if (!bake || bake.v !== BAKE_VERSION) {
    throw new Error(`navGraph: bake version ${bake?.v} is not ${BAKE_VERSION}, re-bake the map`);
  }
  const grids = {};
  for (const [level, b64] of Object.entries(bake.grids || { default: bake.grid })) {
    const g = decodeBase64(b64);
    if (g.length !== GRID * GRID) {
      throw new Error(`navGraph: bake grid "${level}" is ${g.length}, expected ${GRID * GRID}`);
    }
    grids[level] = g;
  }

  const graph = new NavGraph(bake.map, grids, bake.calibration);
  if (bake.edges) {
    graph.edges = {};
    for (const [level, b64] of Object.entries(bake.edges)) {
      graph.edges[level] = decodeBase64(b64);
    }
  }
  if (bake.solid) {
    graph.solid = {};
    for (const [level, b64] of Object.entries(bake.solid)) {
      graph.solid[level] = unpackMask(decodeBase64(b64));
    }
  }
  for (const a of bake.anchors || []) {
    graph.anchors.set(a.id, {
      id: a.id,
      name: a.name,
      level: a.level || 'default',
      cx: a.cx,
      cy: a.cy,
      world: a.world,
      cells: a.cells || []
    });
  }
  graph._indexCells();
  graph.spawns = bake.spawns || [];
  return graph;
}
