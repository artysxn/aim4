// ---------------------------------------------------------------------------
// scripts/cs3d-breakable-oracle.mjs
// How much speed does a grenade lose going through a window or a vent?
//
//   node --max-old-space-size=8192 scripts/cs3d-breakable-oracle.mjs <demo.dem> [...]
//
// This is where GRENADE_BREAK_KEEP.glass in shared/sim3d/interactives.js came
// from. A demo does not say "this grenade broke a window", so a pass-through
// has to be recognised out of the per-tick positions, and the discriminator is
// three conditions in order of importance:
//
//   1. it was in FREE FLIGHT on the tick before   (ratio ~ 1)
//   2. it kept going the same way                 (a wall bounce reverses it)
//   3. it lost real speed on that tick
//
// Condition 1 is the one that matters. Without it the sample fills up with
// grenades already sliding to a stop, which shed speed smoothly tick after tick
// and read as a run of small impacts. With it, free flight measures 1.000 and a
// real loss stands out.
//
// On a map whose pack has been split (scripts/cs3d-split-interactives.mjs) each
// breakable carries its real collision box out of phys.glb, so "did it hit one"
// is a containment test. Without that it falls back to distance from the entity
// origin, which is much weaker — prefer a split map.
//
// TWO TRAPS, both of which produced confident nonsense before they were found:
//
//   The entity key is `grenade_entity_id`. There is no `entity_id` column, so
//   grouping by one silently collapses every grenade in the match into a single
//   1.9M-row "projectile" and the whole measurement returns noise.
//
//   Only the `*Projectile` rows are in flight. The rest are the grenade still
//   in a player's hand, and they move with the player.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const parser = require('@laihoe/demoparser2');

const TICK = 1 / 64;
const PAD = 12; // a grenade is a 2-unit ball stopping DIST_EPSILON short
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const mag = (v) => Math.hypot(v[0], v[1], v[2]);
const q = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9), mean: s.reduce((a, b) => a + b, 0) / s.length };
};

function breakables(map) {
  const f = `server/data/cs3d/pack/${map}/interactives.json`;
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8')).interactives.filter((i) => i.role === 'breakable');
}
/** Distance from a point to a breakable: 0 when inside its box. */
function nearness(p, t) {
  if (t.phys) {
    const d = [0, 1, 2].map((k) => Math.max(t.phys.min[k] - [p.x, p.y, p.z][k], 0, [p.x, p.y, p.z][k] - t.phys.max[k]));
    return Math.hypot(d[0], d[1], d[2]);
  }
  return mag(sub(p, { x: t.origin[0], y: t.origin[1], z: t.origin[2] }));
}

const hits = [];
for (const demo of process.argv.slice(2)) {
  if (!fs.existsSync(demo)) {
    console.log(`missing: ${demo}`);
    continue;
  }
  const map = (parser.parseHeader(demo).map_name || '').replace(/^de_/, '');
  const bs = breakables(map);
  const boxed = bs.filter((b) => b.phys).length;
  console.log(`\n=== ${demo.split(/[\\/]/).pop()}  ${map}  ${bs.length} breakables (${boxed} with a real hull) ===`);
  if (!bs.length) continue;

  // `grenade_entity_id`, and only the *Projectile rows: the others are the
  // grenade still in a player's hand, which moves with the player.
  const rows = parser
    .parseGrenades(demo)
    .filter((r) => Number.isFinite(r.x) && /Projectile$/.test(r.grenade_type || ''));
  const byEnt = new Map();
  for (const r of rows) {
    const k = `${r.grenade_entity_id}`;
    if (!byEnt.has(k)) byEnt.set(k, []);
    byEnt.get(k).push(r);
  }
  console.log(`  ${rows.length} in-flight samples across ${byEnt.size} projectiles`);

  let paths = 0;
  let inside = 0;
  const near = [];
  const far = [];
  for (const raw of byEnt.values()) {
    raw.sort((a, b) => a.tick - b.tick);
    // Entity ids are reused between rounds; cut wherever the samples jump.
    const runs = [[]];
    for (const r of raw) {
      const prev = runs.at(-1).at(-1);
      if (prev && (r.tick - prev.tick !== 1 || mag(sub(r, prev)) > 40)) runs.push([]);
      runs.at(-1).push(r);
    }
    for (const list of runs) {
      if (list.length < 5) continue;
      paths++;
      for (let i = 2; i + 1 < list.length; i++) {
        let best = Infinity;
        let who = null;
        for (const t of bs) {
          const d = nearness(list[i], t);
          if (d < best) {
            best = d;
            who = t;
          }
        }
        if (best <= PAD) inside++;
        const v0 = sub(list[i - 1], list[i - 2]).map((v) => v / TICK);
        const v1 = sub(list[i], list[i - 1]).map((v) => v / TICK);
        const v2 = sub(list[i + 1], list[i]).map((v) => v / TICK);
        const s0 = mag(v0);
        const s1 = mag(v1);
        const s2 = mag(v2);
        if (s1 < 250) continue;
        if (s1 / s0 < 0.97 || s1 / s0 > 1.06) continue; // free flight going in
        const dot = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (s1 * s2);
        const turn = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
        const ratio = s2 / s1;
        if (turn > 20 || ratio > 0.97 || ratio < 0.02) continue;
        const row = { ratio, turn, d: best, s1, s2, who, type: list[i].grenade_type || '?' };
        if (best <= PAD) {
          near.push(row);
          hits.push(row);
          console.log(
            `      ${s1.toFixed(0).padStart(4)} -> ${s2.toFixed(0).padStart(4)} u/s  kept ${ratio.toFixed(3)}  turn ${turn.toFixed(1).padStart(5)}deg  ` +
              `${best.toFixed(0)}u  ${(who.phys?.surface || '?').padEnd(15)} ${(who.model || '').split('/').pop()}  ${row.type}`
          );
        } else far.push(row);
      }
    }
  }
  console.log(`  ${paths} clean flight paths, ${inside} samples inside a breakable hull, ${near.length} pass-throughs`);
  const show = (n, l) => l.length && console.log(`  ${n}: n=${l.length} kept p25 ${q(l.map((x) => x.ratio)).p25.toFixed(3)} p50 ${q(l.map((x) => x.ratio)).p50.toFixed(3)} p75 ${q(l.map((x) => x.ratio)).p75.toFixed(3)}`);
  show('through a breakable', near);
  show('everything else    ', far);
}

if (hits.length) {
  console.log('\n===== ALL PASS-THROUGHS =====');
  const r = q(hits.map((x) => x.ratio));
  console.log(`n=${r.n}  kept  p10 ${r.p10.toFixed(3)}  p25 ${r.p25.toFixed(3)}  p50 ${r.p50.toFixed(3)}  p75 ${r.p75.toFixed(3)}  p90 ${r.p90.toFixed(3)}  mean ${r.mean.toFixed(3)}`);
  const bySurf = new Map();
  for (const h of hits) {
    const s = h.who.phys?.surface || 'unknown';
    if (!bySurf.has(s)) bySurf.set(s, []);
    bySurf.get(s).push(h.ratio);
  }
  for (const [s, l] of bySurf) console.log(`  ${s.padEnd(16)} n=${String(l.length).padStart(3)}  median kept ${q(l).p50.toFixed(3)}`);
} else {
  console.log('\nno pass-throughs found');
}
