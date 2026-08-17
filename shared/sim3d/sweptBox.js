// ---------------------------------------------------------------------------
// shared/sim3d/sweptBox.js
// Continuous collision of an axis-aligned box against a triangle: the time of
// first contact for a box of half extents h moving from centre c by d, and the
// plane it hits. This is the primitive under `traceHull` — Source's player
// hull is an AABB, the map's physics mesh is triangles, and a swept test is
// what makes 250 u/s at 64 Hz (3.9 u per tick against 32 u of hull) never
// tunnel through a wall or miss a step edge.
//
// Method: separating axis theorem over the 13 candidate axes (three box face
// normals, the triangle normal, nine box-edge × triangle-edge cross products),
// each axis giving the interval of time during which the projections overlap.
// The intersection of those intervals is when the shapes touch; its start is
// the contact time and the axis that starts it last is the contact normal.
// Exact for two convex shapes, no iteration, no allocation.
//
// Frame-agnostic: caller decides which axes are up. Positions and the result
// are plain numbers; the sim rounds to f32 where it stores them.
// ---------------------------------------------------------------------------

/**
 * Sweep result, reused by the caller. `t` is the contact time in [0, 1] along
 * `d`; (nx, ny, nz) the unit contact normal facing against the motion;
 * `depth` the penetration at t = 0 when the shapes already overlap (else 0).
 */
export function createSweepHit() {
  return { t: 1, nx: 0, ny: 0, nz: 0, depth: 0 };
}

const NEG_INF = -Infinity;
const POS_INF = Infinity;
/** Axes shorter than this (near-parallel edges) are skipped as degenerate. */
const AXIS_EPS2 = 1e-10;
/** Projected velocity below this counts as "not moving along the axis". */
const VEL_EPS = 1e-9;

// One axis of the SAT, inlined by hand into the main routine below through
// these module-level scratch registers (the routine is called many thousand
// times per second and a closure per axis would allocate).
let _tEnter;
let _tExit;
let _enterAxisX;
let _enterAxisY;
let _enterAxisZ;
let _enterVel;
let _minDepth;
let _sep;

/**
 * Test one axis (ax, ay, az), not necessarily unit length (only direction and
 * consistent scale matter within an axis). Updates the enter/exit window.
 * Sets `_sep` when the axis separates the shapes for the whole sweep.
 */
function axis(ax, ay, az, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z) {
  const len2 = ax * ax + ay * ay + az * az;
  if (len2 < AXIS_EPS2) return;
  const inv = 1 / Math.sqrt(len2);
  ax *= inv;
  ay *= inv;
  az *= inv;
  const cb = cx * ax + cy * ay + cz * az;
  const rb = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
  const p0 = v0x * ax + v0y * ay + v0z * az;
  const p1 = v1x * ax + v1y * ay + v1z * az;
  const p2 = v2x * ax + v2y * ay + v2z * az;
  let tmin = p0;
  let tmax = p0;
  if (p1 < tmin) tmin = p1;
  else if (p1 > tmax) tmax = p1;
  if (p2 < tmin) tmin = p2;
  else if (p2 > tmax) tmax = p2;
  const bmin = cb - rb;
  const bmax = cb + rb;
  const va = dx * ax + dy * ay + dz * az;
  // Overlap at t = 0 along this axis (negative = separated by that much).
  const o1 = bmax - tmin;
  const o2 = tmax - bmin;
  const overlap = o1 < o2 ? o1 : o2;
  if (overlap < _minDepth) _minDepth = overlap;
  if (va > -VEL_EPS && va < VEL_EPS) {
    if (overlap < 0) _sep = true;
    return;
  }
  const t0 = (tmin - bmax) / va;
  const t1 = (tmax - bmin) / va;
  let enter;
  let exit;
  if (t0 < t1) {
    enter = t0;
    exit = t1;
  } else {
    enter = t1;
    exit = t0;
  }
  if (enter > _tEnter) {
    _tEnter = enter;
    // The face of the box that leads along the motion meets the triangle:
    // the contact normal points back against the motion on this axis.
    if (va > 0) {
      _enterAxisX = -ax;
      _enterAxisY = -ay;
      _enterAxisZ = -az;
    } else {
      _enterAxisX = ax;
      _enterAxisY = ay;
      _enterAxisZ = az;
    }
    _enterVel = va;
  }
  if (exit < _tExit) _tExit = exit;
  if (_tEnter > _tExit) _sep = true;
}

/**
 * Sweep the box (centre c, half extents h, motion d) against triangle
 * (v0, v1, v2). Writes `hit` and returns true when the box touches the
 * triangle within the sweep (t in [0, 1]); the caller keeps the smallest t
 * over all triangles. Also fills `hit.depth` for a box that already overlaps
 * the triangle at t = 0, so the caller can decide what "start solid" means.
 */
export function sweepBoxTriangle(cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, hit) {
  _tEnter = NEG_INF;
  _tExit = POS_INF;
  _enterAxisX = 0;
  _enterAxisY = 0;
  _enterAxisZ = 0;
  _enterVel = 0;
  _minDepth = POS_INF;
  _sep = false;

  // Triangle edges and normal.
  const e0x = v1x - v0x;
  const e0y = v1y - v0y;
  const e0z = v1z - v0z;
  const e1x = v2x - v1x;
  const e1y = v2y - v1y;
  const e1z = v2z - v1z;
  const e2x = v0x - v2x;
  const e2y = v0y - v2y;
  const e2z = v0z - v2z;
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;

  // Box face normals first: they are the cheapest and separate most pairs.
  axis(1, 0, 0, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(0, 1, 0, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(0, 0, 1, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(nx, ny, nz, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  // Edge cross products: box axis X × edge = (0, -ez, ey), Y × edge = (ez, 0, -ex), Z × edge = (-ey, ex, 0).
  axis(0, -e0z, e0y, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(0, -e1z, e1y, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(0, -e2z, e2y, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(e0z, 0, -e0x, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(e1z, 0, -e1x, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(e2z, 0, -e2x, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(-e0y, e0x, 0, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(-e1y, e1x, 0, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;
  axis(-e2y, e2x, 0, cx, cy, cz, hx, hy, hz, dx, dy, dz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  if (_sep) return false;

  // The shapes' projections overlap on every axis for t in [tEnter, tExit].
  if (_tExit <= 0) return false; // touching or overlapping only in the past: moving away
  if (_tEnter > 1) return false; // not within this sweep

  if (_tEnter < 0) {
    // Already overlapping at the start. Report contact at t = 0 with the
    // shallowest-penetration axis as the way out, and how deep it is.
    hit.t = 0;
    hit.depth = _minDepth > 0 ? _minDepth : 0;
    // Push-out direction: recompute the least-overlap axis's orientation
    // against the motion (or, if the box is not moving into it, away from the
    // triangle centroid).
    if (_enterVel !== 0 && _tEnter > NEG_INF) {
      hit.nx = _enterAxisX;
      hit.ny = _enterAxisY;
      hit.nz = _enterAxisZ;
    } else {
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const mx = (v0x + v1x + v2x) / 3 - cx;
      const my = (v0y + v1y + v2y) / 3 - cy;
      const mz = (v0z + v1z + v2z) / 3 - cz;
      const s = mx * nx + my * ny + mz * nz > 0 ? -1 : 1;
      hit.nx = (s * nx) / l;
      hit.ny = (s * ny) / l;
      hit.nz = (s * nz) / l;
    }
    return true;
  }

  hit.t = _tEnter;
  hit.depth = 0;
  hit.nx = _enterAxisX;
  hit.ny = _enterAxisY;
  hit.nz = _enterAxisZ;
  return true;
}
