// Run: node server/demoparser/adapters/laihoe.grenades.test.js
//
// Grenade paths are simplified for storage. The viewer lerps between kept
// samples by tick, so the error that matters is 3D interpolation error, not
// perpendicular distance to the ground track. A lofted smoke's apex sits on
// that track; XY-only simplify drops it.

import { simplifyPath } from './laihoe.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const EPS = 6;

function lerpAt(path, tick) {
  if (tick <= path[0].tick) return path[0];
  for (let i = 1; i < path.length; i++) {
    if (path[i].tick >= tick) {
      const a = path[i - 1];
      const b = path[i];
      const f = (tick - a.tick) / (b.tick - a.tick || 1);
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f
      };
    }
  }
  return path[path.length - 1];
}

function maxError(truth, path) {
  let max = 0;
  for (const p of truth) {
    const q = lerpAt(path, p.tick);
    max = Math.max(max, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  return max;
}

function loft({ ticks, dist, H }) {
  const pts = [];
  for (let i = 0; i <= ticks; i++) {
    const f = i / ticks;
    pts.push({ tick: i, x: dist * f, y: 0, z: 4 * H * f * (1 - f) });
  }
  return pts;
}

{
  const truth = loft({ ticks: 128, dist: 800, H: 250 });
  const path = simplifyPath(truth, EPS);
  assert(path.length > 2, 'a lofted smoke keeps more than throw and land');
  assert(maxError(truth, path) <= EPS + 0.15, `loft error ${maxError(truth, path)} exceeds ${EPS}`);
  const apex = truth.reduce((a, p) => (p.z > a.z ? p : a));
  const keptZ = Math.max(...path.map((p) => p.z));
  assert(keptZ > apex.z * 0.8, `apex was dropped (${keptZ} vs ${apex.z})`);
}

{
  const truth = loft({ ticks: 448, dist: 1800, H: 450 });
  const path = simplifyPath(truth, EPS);
  assert(maxError(truth, path) <= EPS + 0.15, 'long loft stays inside the 6u cap');
  assert(path.length < 40, 'a 7s loft is still a handful of points, not every tick');
}

{
  // Bounce that comes back down its own ground track: perpendicular XY is 0,
  // tick-lerp is not. The corner must survive.
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push({ tick: i, x: i * 10, y: 0, z: 0 });
  for (let i = 1; i <= 40; i++) pts.push({ tick: 40 + i, x: 400 - i * 10, y: 0, z: 0 });
  const path = simplifyPath(pts, EPS);
  const mid = path.find((p) => Math.abs(p.x - 400) < 1 && p.tick === 40);
  assert(mid, 'a bounce that retraces XY is kept');
}

{
  const short = [
    { tick: 0, x: 0, y: 0, z: 0 },
    { tick: 10, x: 50, y: 0, z: 2 }
  ];
  const path = simplifyPath(short, EPS);
  assert(path.length === 2, 'two-point paths are unchanged');
}

console.log('laihoe.grenades.test: ok');
