// ---------------------------------------------------------------------------
// shared/sim/angles.js
// Reading the angle catalogue: what a spot sees, and what sees it.
//
// The catalogue is baked by scripts/sim-bake-angles.mjs over the viewer's own
// visibility code, so nothing here computes line of sight. This module is the
// query surface: it turns a baked file into the two questions a bot asks
// constantly and the plan prices everything with.
//
//   visibleSet   what I can see from here          (foresight, negative info)
//   exposureSet  what can see me here              (the cost of standing here)
//
// The second is the one that decides play. "What am I giving away" is exposure,
// and a bot that only reasons about what it can see is the bot that holds two
// angles at once and dies to the third.
//
// Coordinates here are CONTROL FIELD cells, a fixed 32 world units, which is
// the possession system's grid rather than the nav lattice's. Callers convert
// through world coordinates; the two grids are kept apart on purpose (see the
// bake script's header).
//
// DOM-free and dependency-free: it takes parsed JSON.
// ---------------------------------------------------------------------------

export const ANGLES_VERSION = 1;

export class AngleCatalogue {
  /** @param {object} bake  parsed angles/<MAP>.json */
  constructor(bake) {
    if (!bake || bake.v !== ANGLES_VERSION) {
      throw new Error(`angles: bake version ${bake?.v} is not ${ANGLES_VERSION}, re-bake`);
    }
    this.map = bake.map;
    this.geom = bake.geom;
    this.yaws = bake.yaws;
    this.entries = bake.entries;

    /** anchor id -> entry indices, in yaw order. */
    this.byAnchor = new Map();
    for (let i = 0; i < this.entries.length; i += 1) {
      const id = this.entries[i].anchor;
      let list = this.byAnchor.get(id);
      if (!list) {
        list = [];
        this.byAnchor.set(id, list);
      }
      list.push(i);
    }

    /** cell -> entry indices that can see it, unflattened from the run list. */
    this.exposure = new Map();
    const flat = bake.exposure || [];
    for (let i = 0; i < flat.length; ) {
      const cell = flat[i];
      const n = flat[i + 1];
      this.exposure.set(cell, flat.slice(i + 2, i + 2 + n));
      i += 2 + n;
    }

    /** Visible sets as Sets, built lazily: most entries are never queried. */
    this._sets = new Array(this.entries.length).fill(null);
  }

  /** World point to a control-field cell index, or -1 outside. */
  cellAt(x, y) {
    const g = this.geom;
    const ix = Math.floor((x - g.originX) / g.cell);
    const iy = Math.floor((y - g.originY) / g.cell);
    if (ix < 0 || iy < 0 || ix >= g.cols || iy >= g.rows) return -1;
    return iy * g.cols + ix;
  }

  /** Cell index to the world point at its centre. */
  worldAt(cell) {
    const g = this.geom;
    return {
      x: g.originX + ((cell % g.cols) + 0.5) * g.cell,
      y: g.originY + (Math.floor(cell / g.cols) + 0.5) * g.cell
    };
  }

  /**
   * The catalogued anchor nearest a world point, by cell.
   *
   * The catalogue is enumerated at anchors, so a body standing between two of
   * them has no entry of its own. Requiring an exact cell match makes almost
   * every position invisible, which shows up as bots walking past each other:
   * the first version of the match runner produced 24 kills in 18 rounds for
   * exactly this reason. Snapping to the nearest anchor is the right
   * approximation until the spot set is widened (SIM-PLAN 6.8 wants ~2,000
   * entries per map rather than ~950).
   */
  nearestAnchor(x, y) {
    if (!this._anchorCells) {
      this._anchorCells = [];
      for (const [id, list] of this.byAnchor) {
        const e = this.entries[list[0]];
        this._anchorCells.push({ id, x: e.world.x, y: e.world.y, level: e.level });
      }
    }
    let best = null;
    let bestD = Infinity;
    for (const a of this._anchorCells) {
      const d = (a.x - x) ** 2 + (a.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /**
   * Can a body at `from` see a body at `to`?
   *
   * Both are snapped to their nearest catalogued anchor, and the question
   * becomes whether any yaw at the watcher's anchor covers the target's cell.
   * Coarse, cached, and the same geometry the page draws with, which is the
   * trade this whole catalogue exists to make.
   */
  canSee(fromX, fromY, toX, toY, level = 'default') {
    const a = this.nearestAnchor(fromX, fromY);
    if (!a || a.level !== level) return false;
    const cell = this.cellAt(toX, toY);
    if (cell < 0) return false;
    if (!this._seeCache) this._seeCache = new Map();
    const key = `${a.id}|${cell}`;
    const hit = this._seeCache.get(key);
    if (hit !== undefined) return hit;
    let seen = false;
    for (const idx of this.byAnchor.get(a.id)) {
      if (this.visibleSet(idx).has(cell)) {
        seen = true;
        break;
      }
    }
    this._seeCache.set(key, seen);
    return seen;
  }

  /** Every catalogued yaw at an anchor. */
  at(anchorId) {
    return (this.byAnchor.get(anchorId) || []).map((i) => this.entries[i]);
  }

  /** The entry at an anchor whose yaw is nearest, or null. */
  facing(anchorId, yawDeg) {
    const list = this.byAnchor.get(anchorId);
    if (!list?.length) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const i of list) {
      const d = Math.abs(((this.entries[i].yaw - yawDeg + 540) % 360) - 180);
      if (d < bestDiff) {
        bestDiff = d;
        best = i;
      }
    }
    return best === null ? null : { index: best, ...this.entries[best] };
  }

  /** Membership test against an entry's visible set. */
  visibleSet(index) {
    let set = this._sets[index];
    if (!set) {
      set = new Set(this.entries[index].cells);
      this._sets[index] = set;
    }
    return set;
  }

  /** Can the entry see this world point? */
  sees(index, x, y) {
    const cell = this.cellAt(x, y);
    return cell >= 0 && this.visibleSet(index).has(cell);
  }

  /**
   * Which catalogued angles can see a world point.
   *
   * This is the exposure question, and it is what makes a hold spot priceable:
   * the entries returned here are the angles a body standing there is giving
   * away, and their count is the plan's `angleCount` (6.8).
   */
  exposedTo(x, y) {
    const cell = this.cellAt(x, y);
    if (cell < 0) return [];
    return (this.exposure.get(cell) || []).map((i) => ({ index: i, ...this.entries[i] }));
  }

  /**
   * Belief-weighted threat on a world point.
   *
   * `massAt(anchorId, level)` supplies the probability that a live enemy is at
   * that anchor, from the joint filter (SIM-PLAN 19.2), and `classOf` narrows
   * it to a weapon class so the AWP field (19.3) is the same call with a
   * different filter. Returns a probability-like total, not a count: two
   * angles held by the same hypothesis must not count twice, so mass is taken
   * per anchor rather than per entry.
   */
  threatAt(x, y, massAt, classFilter = null) {
    const seen = this.exposedTo(x, y);
    if (!seen.length) return 0;
    const perAnchor = new Map();
    for (const e of seen) {
      const m = massAt(e.anchor, e.level, classFilter);
      if (!m) continue;
      // An enemy at the anchor sees this point from at least one of its yaws,
      // so the anchor contributes its mass once, not once per sector.
      perAnchor.set(e.anchor, Math.max(perAnchor.get(e.anchor) || 0, m));
    }
    let total = 0;
    for (const m of perAnchor.values()) total += m;
    return total;
  }

  /**
   * The longest sightline available from an anchor, over all its yaws.
   * CS's own analysis calls the top of this distribution a sniper spot, and it
   * is the cheap half of deciding where an AWP is worth playing (19.3).
   */
  depthAt(anchorId) {
    let best = 0;
    for (const e of this.at(anchorId)) if (e.depth > best) best = e.depth;
    return best;
  }

  /** Anchors ranked by longest sightline. The AWP spot shortlist. */
  sniperSpots(limit = 8) {
    const out = [];
    for (const id of this.byAnchor.keys()) out.push({ anchor: id, depth: this.depthAt(id) });
    out.sort((a, b) => b.depth - a.depth);
    return out.slice(0, limit);
  }

  /**
   * The ordered danger list along a route: where each angle first opens.
   *
   * This is `ComputeSpotEncounters` from CS's nav mesh, and SIM-PLAN 6.8 calls
   * it the single best idea in there. For every catalogued angle that overlooks
   * any part of a route, record the distance along the route at which it FIRST
   * gains line of sight. A body walking the route then sweeps its crosshair
   * through that list in order, so it is always looking at the angle that is
   * about to open rather than the one it has already walked past.
   *
   * Computed live from the exposure transpose rather than baked per anchor
   * pair. Baking would need every pair of anchors (nearly four thousand on
   * Inferno) and would still be wrong for any route that is not the direct one,
   * whereas this is a walk over the route's own cells and costs microseconds.
   *
   * What it buys with no learning at all: pre-aim that is correct rather than
   * memorized, clearing order that matches how a human walks a corridor, and a
   * definition of "I have cleared this part of the route" for the belief's
   * negative information. It also gives the surprise layer something to
   * violate: a low-concentration bot skips entries, which is exactly what
   * checking an angle late looks like.
   *
   * @param {Array<{x: number, y: number}>} routeWorld  route points, in order
   * @param {(entry: object) => boolean} [keep]  filter, e.g. by belief mass
   * @returns {Array<{index: number, anchor: string, at: number, first: number}>}
   *   sorted by `at`, the distance along the route in world units
   */
  encountersAlong(routeWorld, keep = null) {
    const firstAt = new Map();
    let travelled = 0;

    for (let i = 0; i < routeWorld.length; i += 1) {
      if (i > 0) {
        travelled += Math.hypot(
          routeWorld[i].x - routeWorld[i - 1].x,
          routeWorld[i].y - routeWorld[i - 1].y
        );
      }
      const cell = this.cellAt(routeWorld[i].x, routeWorld[i].y);
      if (cell < 0) continue;
      const list = this.exposure.get(cell);
      if (!list) continue;
      for (const idx of list) {
        if (firstAt.has(idx)) continue;
        if (keep && !keep(this.entries[idx])) continue;
        firstAt.set(idx, { at: travelled, cell });
      }
    }

    const out = [];
    for (const [index, hit] of firstAt) {
      out.push({
        index,
        anchor: this.entries[index].anchor,
        level: this.entries[index].level,
        yaw: this.entries[index].yaw,
        at: hit.at,
        cell: hit.cell
      });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  /**
   * The same list collapsed to one row per anchor, which is what a crosshair
   * actually sweeps: a body checks "car", not the four yaw sectors of car that
   * happen to overlook this corridor.
   */
  anchorEncountersAlong(routeWorld, keep = null) {
    const seen = new Set();
    const out = [];
    for (const e of this.encountersAlong(routeWorld, keep)) {
      if (seen.has(e.anchor)) continue;
      seen.add(e.anchor);
      out.push(e);
    }
    return out;
  }
}

/** @param {object} bake parsed JSON @returns {AngleCatalogue} */
export function loadAngles(bake) {
  return new AngleCatalogue(bake);
}
