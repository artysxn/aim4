// ---------------------------------------------------------------------------
// scripts/cs3d-oracle.mjs
// The physics oracle: runs the demo corpus as ground truth against
// shared/sim3d. Demos record outcomes, not inputs, so this harness only tests
// what is input-free — and reports distributions, not single numbers, so a
// window contaminated by hidden input (a counter-strafe inside a "glide")
// shows up as a second mode instead of silently biasing a mean.
//
//   node scripts/cs3d-oracle.mjs [paths...] [--max N] [--map CODE] [--verbose]
//
// paths: .aim4replay files or directories (recursed). Default: sampledemos/.
//
// Two facts about THIS corpus shape everything below (verified 2026-08-16):
//   - FLAG_AIRBORNE and FLAG_DUCKING are zero in every local package — all
//     were parsed before the writer recorded them. Airborne segments are
//     therefore DERIVED from the z-series: flat ground is flat, and a jump
//     arc is a parabola with curvature −g·dt² per tick², which nothing else
//     a player does produces. The flag path stays as a fast-path for future
//     reparses.
//   - GrenadeEvent.path is sparse waypoints (2–8 points, gaps of seconds,
//     bounces in between), not a trajectory. Gravity is unfittable through a
//     bounce, so grenade gravity runs only on dense sub-paths (consecutive
//     ticks) and reports its own coverage — when that count is ~0, the fix
//     is a reparse with dense grenade sampling, not a cleverer fitter.
//
// What it measures, and against which constant:
//   fuse       detonate−throw per grenade type          → grenade.js FUSE
//   nade-grav  parabola over dense path runs            → GRENADE_GRAVITY_SCALE
//   gravity    parabola fit of derived airborne arcs    → GRAVITY
//   takeoff    first-tick rise of jumps + apex height   → JUMP_IMPULSE and the
//              leapfrog order: (J−g·dt/2)·dt = 4.6210u vs naive J·dt = 4.7186u,
//              with subtick phase smearing below whichever is true (E-1)
//   friction   whole-window fit of glide-to-stop curves → FRICTION (the low
//              mode; counter-strafing forms a separate higher mode)
//   plateau    modes of steady ground speed per weapon  → weapons.js runSpeed
//              and WALK_SPEED_SCALE (pros walk: expect BOTH modes)
//   simz       stepPlayer replay of arc z vs demo       → the integrator
//              itself, end to end through motion.js
//
// Positions are ¼-unit quantized; every fit here spans enough ticks that the
// noise floor is averaged out, and thresholds below are stated in units of it.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz } from '../server/replays/tickCodec.js';
import {
  readHeader,
  readRecord,
  FLAG_AIRBORNE,
  HEADER_BYTES,
  TICK_BYTES
} from '../src/replays/shared/tickFormat.js';
import { simWeapon } from '../shared/sim/weapons.js';
import {
  GRAVITY,
  JUMP_IMPULSE,
  FRICTION,
  STOP_SPEED,
  WALK_SPEED_SCALE,
  TICK_DT
} from '../shared/sim3d/constants.js';
import { GRENADE_GRAVITY_SCALE } from '../shared/sim3d/grenade.js';
import { createPlayerState, createInput, stepPlayer, emptyWorld } from '../shared/sim3d/motion.js';

// ---- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const inputs = [];
let MAX_PACKAGES = 40;
let MAP_FILTER = '';
let VERBOSE = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--max') MAX_PACKAGES = Number(args[++i]) || MAX_PACKAGES;
  else if (a === '--map') MAP_FILTER = String(args[++i] || '').toUpperCase();
  else if (a === '--verbose') VERBOSE = true;
  else inputs.push(a);
}
if (!inputs.length) inputs.push(path.join(process.cwd(), 'sampledemos'));

// ---- tiny stats -----------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}
function summarize(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const med = quantile(s, 0.5);
  const mad = n ? quantile(s.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5) : NaN;
  return { n, med, mad, p10: quantile(s, 0.1), p90: quantile(s, 0.9), min: s[0], max: s[n - 1] };
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : '—');

/**
 * Histogram modes: bin, 3-bin smooth, return peaks tallest-first. How the
 * report separates run from walk and release-glide from counter-strafe
 * without pretending to know which window was which.
 */
function modes(values, binWidth, minCount = 5) {
  if (!values.length) return [];
  let lo = Infinity;
  for (const v of values) if (v < lo) lo = v; // spread blows the stack at corpus scale
  const bins = new Map();
  for (const v of values) {
    const b = Math.round((v - lo) / binWidth);
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  let maxBin = 0;
  for (const b of bins.keys()) if (b > maxBin) maxBin = b;
  const smooth = [];
  for (let b = 0; b <= maxBin; b++) {
    smooth[b] = (bins.get(b - 1) || 0) + 2 * (bins.get(b) || 0) + (bins.get(b + 1) || 0);
  }
  const peaks = [];
  for (let b = 0; b <= maxBin; b++) {
    if (smooth[b] >= minCount * 2 && smooth[b] >= (smooth[b - 1] || 0) && smooth[b] > (smooth[b + 1] || 0)) {
      peaks.push({ at: lo + b * binWidth, count: (bins.get(b) || 0) + (bins.get(b - 1) || 0) + (bins.get(b + 1) || 0) });
    }
  }
  return peaks.sort((a, b) => b.count - a.count);
}

/** Least-squares quadratic z(τ), τ centered. gravity = −2·c2. */
function fitParabola(ts, zs) {
  const n = ts.length;
  if (n < 3) return null;
  const tm = ts.reduce((a, b) => a + b, 0) / n;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, sz = 0, szt = 0, szt2 = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i] - tm;
    const t2 = t * t;
    s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
    sz += zs[i]; szt += zs[i] * t; szt2 += zs[i] * t2;
  }
  const det = n * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return null;
  const c0 = (sz * (s2 * s4 - s3 * s3) - s1 * (szt * s4 - s3 * szt2) + s2 * (szt * s3 - s2 * szt2)) / det;
  const c1 = (n * (szt * s4 - szt2 * s3) - sz * (s1 * s4 - s3 * s2) + s2 * (s1 * szt2 - szt * s2)) / det;
  const c2 = (n * (s2 * szt2 - s3 * szt) - s1 * (s1 * szt2 - szt * s2) + sz * (s1 * s3 - s2 * s2)) / det;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i] - tm;
    const e = zs[i] - (c0 + c1 * t + c2 * t * t);
    rss += e * e;
  }
  return { c0, c1, c2, tm, rms: Math.sqrt(rss / n) };
}

// ---- accumulators ---------------------------------------------------------

const acc = {
  packages: 0,
  rounds: 0,
  flagRounds: 0,
  maps: new Map(),
  fuse: new Map(),
  nadeGravity: [],
  nadePathsTotal: 0,
  nadePathsDense: 0,
  playerGravity: [],
  takeoffDz: [],
  takeoffVz: [],
  apexDz: [],
  frictionWindows: [],
  plateaus: new Map(),
  simzErr: [],
  errors: 0
};

// ---- grenades -------------------------------------------------------------

function extractGrenades(meta, tickRate) {
  for (const g of meta?.events?.grenades || []) {
    const type = String(g.type || 'unknown');
    if (Number.isFinite(g.throwTick) && Number.isFinite(g.detonateTick) && g.detonateTick > g.throwTick) {
      if (!acc.fuse.has(type)) acc.fuse.set(type, []);
      acc.fuse.get(type).push((g.detonateTick - g.throwTick) / tickRate);
    }
    const p = Array.isArray(g.path) ? g.path : [];
    if (p.length < 2) continue;
    acc.nadePathsTotal++;
    // Dense sub-path: ≥5 consecutive samples at most 3 ticks apart. The
    // corpus rarely has one (waypoints, not trajectories) — the coverage
    // counter printed at the end is the honest statement of that.
    let runStart = 0;
    for (let i = 1; i <= p.length; i++) {
      const gap = i < p.length ? p[i].tick - p[i - 1].tick : Infinity;
      if (gap > 3 || gap <= 0) {
        if (i - runStart >= 5) {
          acc.nadePathsDense++;
          const ts = [], zs = [];
          for (let k = runStart; k < i; k++) {
            ts.push((p[k].tick - p[runStart].tick) / tickRate);
            zs.push(p[k].z);
          }
          const fit = fitParabola(ts, zs);
          if (fit && fit.rms < 0.5) {
            const g_est = -2 * fit.c2;
            if (g_est > 50 && g_est < 2000) acc.nadeGravity.push(g_est);
          }
        }
        runStart = i;
      }
    }
  }
}

// ---- airborne arcs from the z-series --------------------------------------

/**
 * Find ballistic arcs in one player's z-series. An arc is bounded by flat
 * stretches (grounded) and must fit a free parabola with ballistic curvature.
 * Stairs are staircases (bad rms), ramps are lines (c2 ≈ 0), duck-in-air
 * origin shifts are step discontinuities (bad rms): all self-reject.
 *
 * Returns [{ from, to, fit, takeoffFlat }] with from/to indexing rows and
 * takeoffFlat true when the arc is preceded by ≥3 flat ticks (a real jump
 * start rather than walking off an edge or a segment truncated by the round
 * window).
 */
function findArcs(rows, n, dt) {
  const arcs = [];
  const flatAt = (i) => i > 0 && i < n && Math.abs(rows[i].z - rows[i - 1].z) <= 0.3;
  let i = 1;
  while (i < n) {
    // Advance to the end of a flat stretch.
    if (!rows[i]?.alive || flatAt(i)) {
      i++;
      continue;
    }
    // z started moving at i. Collect until it flattens again for 3+ ticks or dies.
    const start = i - 1;
    let j = i;
    let flats = 0;
    while (j < n && rows[j].alive && flats < 3) {
      if (flatAt(j)) flats++;
      else flats = 0;
      if (Math.abs(rows[j].z - rows[j - 1].z) > 40) break; // teleport
      if (Math.hypot(rows[j].x - rows[j - 1].x, rows[j].y - rows[j - 1].y) > 40) break;
      j++;
    }
    const end = j - flats;
    const len = end - start;
    if (len >= 8 && len < 400) {
      // Fit the INTERIOR only: the first tick is subtick-partial (takeoff
      // mid-tick) and the last approaches the landing plane; both flatten the
      // parabola and bias g low. Detection uses the whole excursion, the fit
      // does not.
      const ts = [], zs = [];
      for (let k = start + 2; k < end - 2; k++) {
        ts.push((k - start) * dt);
        zs.push(rows[k].z);
      }
      const fit = fitParabola(ts, zs);
      if (fit && fit.rms < 0.5) {
        const g_est = -2 * fit.c2;
        if (g_est > 500 && g_est < 1100) {
          let takeoffFlat = true;
          for (let k = start - 2; k <= start; k++) {
            if (!(k > 0 && rows[k].alive && Math.abs(rows[k].z - rows[k - 1].z) <= 0.3)) takeoffFlat = false;
          }
          arcs.push({ from: start, to: end, fit, takeoffFlat });
        }
      }
    }
    i = j + 1;
  }
  return arcs;
}

function handleArc(rows, arc, dt) {
  const { from, to, fit } = arc;
  acc.playerGravity.push(-2 * fit.c2);

  if (arc.takeoffFlat) {
    // First-tick rise, on the demo's own grid. `from` is the last flat tick.
    const dz1 = rows[from + 1].z - rows[from].z;
    if (dz1 > 1 && dz1 < 8) acc.takeoffDz.push(dz1);
    // Jump impulse by energy, phase-immune: leapfrog samples lie EXACTLY on
    // the continuous parabola z = z0 + J·t − g·t²/2, so at the fit's center
    // J² = c1² + 2·ĝ·(c0 − z0) with z0 the flat pre-jump z — no takeoff
    // timing anywhere in it. Rising arcs only (c1 alone doesn't prove a jump).
    const gHat = -2 * fit.c2;
    const j2 = fit.c1 * fit.c1 + 2 * gHat * (fit.c0 - rows[from].z);
    if (j2 > 0) {
      const J = Math.sqrt(j2);
      if (J > 150 && J < 400) acc.takeoffVz.push(J);
    }
    // Apex above takeoff: J²/2g with no timing in it at all.
    let apex = -Infinity;
    for (let k = from; k < to; k++) apex = Math.max(apex, rows[k].z);
    const rise = apex - rows[from].z;
    if (rise > 30 && rise < 80) acc.apexDz.push(rise);
  }

  // End-to-end integrator replay: seed motion.js at the second airborne tick
  // (the first is subtick-partial), fly with no input, compare final z.
  const len = to - from;
  if (len >= 12) {
    const i0 = from + 2;
    const dz = rows[i0 + 1].z - rows[i0].z;
    const v0 = dz / dt + (GRAVITY * dt) / 2; // leapfrog inversion
    const st = createPlayerState(rows[i0].x, rows[i0].y, rows[i0].z);
    st.vel.z = v0;
    st.onGround = false;
    const input = createInput();
    const world = emptyWorld();
    const last = to - 2;
    for (let k = i0; k < last; k++) stepPlayer(st, input, world);
    acc.simzErr.push({ ticks: last - i0, err: st.pos.z - rows[last].z });
  }
}

// ---- ground extraction ----------------------------------------------------

function extractPlayer(view, header, slot, weaponNames, airFromFlags) {
  const rate = header.tickRate || 64;
  const dt = 1 / rate;
  const n = header.tickCount;
  const rows = new Array(n);
  const tmp = {};
  for (let i = 0; i < n; i++) rows[i] = { ...readRecord(view, i, slot, tmp) };

  const arcs = findArcs(rows, n, dt);
  for (const arc of arcs) handleArc(rows, arc, dt);

  // Airborne mask for the ground tests: derived arcs, or flags when present.
  const air = new Uint8Array(n);
  if (airFromFlags) {
    for (let i = 0; i < n; i++) if (rows[i].flags & FLAG_AIRBORNE) air[i] = 1;
  } else {
    for (const a of arcs) for (let k = a.from; k < a.to + 2; k++) if (k < n) air[k] = 1;
  }

  const speed2d = (i) => Math.hypot(rows[i + 1].x - rows[i].x, rows[i + 1].y - rows[i].y) * rate;
  const grounded = (i) => i + 1 < n && rows[i].alive && rows[i + 1].alive && !air[i] && Math.abs(rows[i + 1].z - rows[i].z) <= 1;

  // --- friction: glide-to-stop windows, fitted whole ---
  // Pros rarely release keys and coast: most stops are counter-strafes,
  // where the deceleration is friction PLUS a constant a·M braking term.
  // Both hide in one curve — friction scales with v, braking doesn't — so
  // each window gets a two-parameter (f, D) fit and the report clusters by D:
  // D≈0 is a true release-glide (f alone), D≈ACCEL·runSpeed is a brake.
  for (let i = 0; i < n - 2; i++) {
    if (!grounded(i)) continue;
    const v0 = speed2d(i);
    if (v0 < 160) continue;
    let j = i;
    const vs = [v0];
    while (j + 2 < n && grounded(j + 1)) {
      const v = speed2d(j + 1);
      if (v > vs[vs.length - 1] + 6) break;
      vs.push(v);
      j++;
      if (v < 6) break;
    }
    if (vs.length >= 7 && vs[vs.length - 1] < 15) {
      if (acc.frictionWindows.length < 60000) {
        acc.frictionWindows.push({ vs, dt, weapon: weaponNames[rows[i].weapon] || '' });
      }
      i = j;
    }
  }

  // --- plateaus: steady ground speed per weapon ---
  for (let i = 0; i < n - 14; i++) {
    if (!grounded(i)) continue;
    const w = rows[i].weapon;
    let j = i;
    const vs = [];
    while (j < n - 2 && j - i < 48 && grounded(j) && rows[j].weapon === w) {
      vs.push(speed2d(j));
      j++;
    }
    if (vs.length >= 12) {
      const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
      const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
      if (mean > 40 && sd < 7) {
        const name = weaponNames[w] || `#${w}`;
        if (!acc.plateaus.has(name)) acc.plateaus.set(name, []);
        acc.plateaus.get(name).push(mean);
      }
    }
    i = j;
  }
}

/**
 * SSE of one stop curve against v' = v − (control·f + D)·dt: the exact Source
 * tick for decelerating with an opposing wish — Friction's drop (control =
 * max(v, stopspeed)) plus Accelerate's constant a·M brake. Release-glides
 * have D≈0; counter-strafes D≈ACCEL·runSpeed.
 */
function frictionSse(vs, dt, f, D) {
  let v = vs[0];
  let e = 0;
  for (let k = 1; k < vs.length; k++) {
    const control = v < STOP_SPEED ? STOP_SPEED : v;
    v = Math.max(0, v - (control * f + D) * dt);
    e += (v - vs[k]) ** 2;
  }
  return e;
}

/** Continuous best-D for a window at fixed f: golden search, no grid noise. */
function bestD(vs, dt, f) {
  let a = 0;
  let b = 3000;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let ec = frictionSse(vs, dt, f, c);
  let ed = frictionSse(vs, dt, f, d);
  for (let it = 0; it < 28; it++) {
    if (ec < ed) {
      b = d; d = c; ed = ec;
      c = b - phi * (b - a);
      ec = frictionSse(vs, dt, f, c);
    } else {
      a = c; c = d; ec = ed;
      d = a + phi * (b - a);
      ed = frictionSse(vs, dt, f, d);
    }
  }
  const D = (a + b) / 2;
  return { D, e: frictionSse(vs, dt, f, D) };
}

/**
 * One window cannot separate f from D — below sv_stopspeed the friction drop
 * is constant (control = 80), fully degenerate with a constant brake, and a
 * fast counter-strafe stop spends most of its ticks there. The f signal
 * lives only in the v-dependent portion ABOVE stopspeed, so: keep windows
 * with enough samples up there, give every window a continuous nuisance D,
 * and sweep one shared f — one physics, thousands of curves.
 */
function jointFrictionFit(windows) {
  const informative = windows.filter((w) => {
    let above = 0;
    for (const v of w.vs) if (v > STOP_SPEED * 1.3) above++;
    return above >= 5;
  });
  const total = (f) => {
    let sum = 0;
    for (const w of informative) sum += bestD(w.vs, w.dt, f).e;
    return sum;
  };
  let bestF = 3;
  let bestE = Infinity;
  for (let f = 2; f <= 9; f += 0.25) {
    const e = total(f);
    if (e < bestE) {
      bestE = e;
      bestF = f;
    }
  }
  for (let f = bestF - 0.25; f <= bestF + 0.25; f += 0.05) {
    const e = total(f);
    if (e < bestE) {
      bestE = e;
      bestF = f;
    }
  }
  const dAt = informative.map((w) => ({ D: bestD(w.vs, w.dt, bestF).D, weapon: w.weapon }));
  return { f: bestF, dAt, informative: informative.length };
}

// ---- package walk ---------------------------------------------------------

async function listPackages(roots) {
  const out = [];
  for (const root of roots) {
    const st = await fsp.stat(root).catch(() => null);
    if (!st) continue;
    if (st.isFile() && root.endsWith('.aim4replay')) {
      out.push(root);
    } else if (st.isDirectory()) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.endsWith('.aim4replay')) out.push(p);
        }
      }
    }
  }
  out.sort();
  return out;
}

async function processPackage(file) {
  const { files } = decodeReplayPackage(await fsp.readFile(file));
  const stems = new Set();
  for (const name of files.keys()) {
    const m = /^rounds\/(.+?)\.(tickz|json\.zst)$/.exec(name);
    if (m) stems.add(m[1]);
  }
  for (const stem of stems) {
    const metaRaw = files.get(`rounds/${stem}.json.zst`);
    const tickRaw = files.get(`rounds/${stem}.tickz`);
    if (!metaRaw || !tickRaw) continue;
    let meta;
    try {
      meta = JSON.parse(zlib.zstdDecompressSync(Buffer.from(metaRaw)).toString('utf8'));
    } catch {
      continue;
    }
    const code = String(meta.map || '').toUpperCase();
    if (MAP_FILTER && !code.startsWith(MAP_FILTER.slice(0, 3))) continue;
    acc.maps.set(code, (acc.maps.get(code) || 0) + 1);

    let buf;
    try {
      buf = decodeTickz(Buffer.from(tickRaw));
    } catch {
      acc.errors++;
      continue;
    }
    const view = new DataView(buf);
    const header = readHeader(view);
    if (header.stride !== 1) continue;
    if (HEADER_BYTES + header.tickCount * TICK_BYTES > buf.byteLength) continue;

    extractGrenades(meta, header.tickRate || 64);

    // Does this round have real airborne flags? (Future reparses will.)
    let airFlags = 0;
    const tmp = {};
    for (let i = 0; i < Math.min(header.tickCount, 500); i++) {
      for (let s = 0; s < 10; s++) {
        readRecord(view, i, s, tmp);
        if (tmp.flags & FLAG_AIRBORNE) airFlags++;
      }
    }
    const airFromFlags = airFlags > 0;
    if (airFromFlags) acc.flagRounds++;

    const weaponNames = Array.isArray(meta.weapons) ? meta.weapons : [];
    for (let slot = 0; slot < (header.playerCount || 10); slot++) {
      extractPlayer(view, header, slot, weaponNames, airFromFlags);
    }
    acc.rounds++;
  }
}

// ---- report ---------------------------------------------------------------

function line(label, s, expected, unit = '') {
  const delta =
    Number.isFinite(expected) && Number.isFinite(s.med)
      ? ` Δ ${(((s.med - expected) / expected) * 100).toFixed(2)}%`
      : '';
  console.log(
    `  ${label.padEnd(14)} n=${String(s.n).padStart(6)}  med=${f2(s.med)}${unit}  ` +
      `mad=${f2(s.mad)}  p10=${f2(s.p10)}  p90=${f2(s.p90)}` +
      (Number.isFinite(expected) ? `  vs ${f2(expected)}${unit}${delta}` : '')
  );
}

async function main() {
  const t0 = Date.now();
  const all = await listPackages(inputs);
  const chosen = all.slice(0, MAX_PACKAGES);
  console.log(`cs3d-oracle: ${all.length} packages found, using ${chosen.length} (--max ${MAX_PACKAGES})`);
  for (const file of chosen) {
    try {
      await processPackage(file);
      acc.packages++;
      if (VERBOSE) console.log(`  done ${path.basename(file)}`);
    } catch (err) {
      acc.errors++;
      if (VERBOSE) console.log(`  ${path.basename(file)}: ERROR ${err.message}`);
    }
  }
  console.log(
    `parsed ${acc.rounds} rounds (${acc.flagRounds} with airborne flags) from ${acc.packages} packages ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s; maps: ${[...acc.maps.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`
  );

  console.log('\n— grenade fuse (throw → detonate, seconds) —');
  for (const [type, vals] of [...acc.fuse.entries()].sort()) {
    line(type, summarize(vals), NaN, 's');
  }

  console.log('\n— grenade gravity (u/s²) —');
  console.log(`  dense sub-paths: ${acc.nadePathsDense} of ${acc.nadePathsTotal} recorded paths`);
  line('fit', summarize(acc.nadeGravity), GRAVITY * GRENADE_GRAVITY_SCALE);
  if (acc.nadeGravity.length < 30) {
    console.log('  → too sparse to conclude; needs a reparse with dense grenade sampling (raw .dem + local parser)');
  }

  console.log('\n— player gravity (u/s², derived airborne arcs) —');
  line('fit', summarize(acc.playerGravity), GRAVITY);

  console.log('\n— jump takeoff —');
  const J = summarize(acc.takeoffVz);
  const apex = summarize(acc.apexDz);
  line('impulse (energy)', J, JUMP_IMPULSE, 'u/s');
  line('apex rise', apex, (JUMP_IMPULSE * JUMP_IMPULSE) / (2 * GRAVITY), 'u');
  if (Number.isFinite(apex.med)) {
    console.log(`  impulse implied by apex at g=800: ${f2(Math.sqrt(2 * GRAVITY * apex.med))}u/s`);
  }
  const tk = summarize(acc.takeoffDz);
  line('Δz first tick', tk, NaN, 'u');
  if (tk.n && Number.isFinite(J.med)) {
    const leapfrog = (J.med - (GRAVITY * TICK_DT) / 2) * TICK_DT;
    console.log(
      `  Δz upper edge p90=${f4(tk.p90)} max=${f4(tk.max)} — at measured J: ` +
        `leapfrog predicts ${f4(leapfrog)}, naive ${f4(J.med * TICK_DT)} ` +
        `(subtick phase smears below the true value, so the edge is the tell)`
    );
  }

  console.log('\n— ground friction (joint fit: one shared f, per-window brake D) —');
  if (acc.frictionWindows.length >= 50) {
    const { f, dAt } = jointFrictionFit(acc.frictionWindows);
    console.log(`  f              windows=${acc.frictionWindows.length}  fit=${f.toFixed(2)}  vs ${f2(FRICTION)} [docs]`);
    const akD = dAt.filter((w) => w.weapon === 'ak47').map((w) => w.D);
    line('D (ak47)', summarize(akD), 5.5 * 215, 'u/s²');
    console.log(
      '  ⚠ NOT a measurement of sv_friction: pro stops are counter-strafes whose brake ONSET',
      '\n    tick is a third hidden variable, degenerate with f in these curves. The fit shows',
      '\n    the degeneracy (it undershoots however you slice it); f stays [docs] 5.2 until the',
      '\n    CS2-server instrument records known-input stop curves.'
    );
  } else {
    console.log('  not enough stop windows collected');
  }

  console.log('\n— speed plateaus (u/s; run and walk modes per weapon) —');
  const rows = [...acc.plateaus.entries()]
    .map(([name, v]) => ({ name, vals: v }))
    .filter((r) => r.vals.length >= 20)
    .sort((a, b) => b.vals.length - a.vals.length)
    .slice(0, 14);
  for (const r of rows) {
    const table = simWeapon(r.name)?.runSpeed;
    const ms = modes(r.vals, 2, 6).slice(0, 2).sort((a, b) => b.at - a.at);
    const parts = ms.map((m) => `${f2(m.at)} (n≈${m.count})`);
    console.log(
      `  ${r.name.padEnd(14)} n=${String(r.vals.length).padStart(5)}  modes: ${parts.join(' / ').padEnd(34)}` +
        (Number.isFinite(table) ? `  table run ${table}, walk ${f2(table * WALK_SPEED_SCALE)}` : '')
    );
  }

  console.log('\n— motion.js airborne replay (z error at segment end, units) —');
  const short = acc.simzErr.filter((e) => e.ticks <= 16).map((e) => e.err);
  const long = acc.simzErr.filter((e) => e.ticks > 16).map((e) => e.err);
  line('≤16 ticks', summarize(short), NaN, 'u');
  line('>16 ticks', summarize(long), NaN, 'u');
  console.log('  (signed: a bias growing with length means wrong g or wrong integrator order)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
