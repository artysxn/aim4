// ---------------------------------------------------------------------------
// scripts/cs3d-nade-oracle.mjs
// The grenade oracle: fly real recorded throws through shared/sim3d/grenade.js
// against the real map's collision, and report how far off they land.
//
//   node scripts/cs3d-nade-oracle.mjs <demo.dem> [--map nuke] [--max N] [--verbose]
//
// This is CS3D-ENGINE-PLAN E-4's acceptance test. It is possible at all because
// a CS2 demo networks the projectile's own release velocity
// (`m_vInitialVelocity`) alongside a per-tick position sample, so a throw can be
// replayed from EXACTLY the state the game started it from — no throw model, no
// view angles, no inheritance coefficient in the loop. What is under test here
// is purely the flight: gravity, the bounce, the elasticity, the rest rule, and
// whether the collision set a grenade sees is the right one.
//
// That last part is the reason this exists. A grenade passes through
// `playerclip` and is stopped by `grenadeclip`, which is the opposite of the
// player on both counts, and a wrong answer there is invisible in every unit
// test and obvious in exactly one measurement: the throws that end up nowhere
// near where the demo says they did.
//
// The map pack supplies the collision (server/data/cs3d/pack/<map>/phys.glb),
// so a map has to be packed locally for its demos to be checkable. Only nuke
// ships in the repo; the rest are a `npm run cs3d:pack` away.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { createHullTracer } from '../shared/sim3d/hullTrace.js';
import { createGrenade, stepGrenade, GRENADE_ELASTICITY, GRENADE_GRAVITY_SCALE } from '../shared/sim3d/grenade.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- CLI ------------------------------------------------------------------

const args = process.argv.slice(2);
const demos = [];
let MAP = '';
let MAX = 400;
let VERBOSE = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--map') MAP = args[++i];
  else if (a === '--max') MAX = Number(args[++i]) || MAX;
  else if (a === '--verbose') VERBOSE = true;
  else demos.push(a);
}
if (!demos.length) {
  console.error('usage: node scripts/cs3d-nade-oracle.mjs <demo.dem> [--map nuke] [--max N] [--verbose]');
  process.exit(1);
}

// ---- the map's collision, as a grenade sees it ----------------------------

/** Kinds a grenade collides with. Must match src/cs3d/mapLoader.js NADE_SOLID. */
const NADE_SOLID = new Set(['solid', 'entity', 'sky', 'grenadeclip']);

async function loadNadeWorld(slug) {
  const file = path.join(ROOT, 'server', 'data', 'cs3d', 'pack', slug, 'phys.glb');
  if (!fs.existsSync(file)) throw new Error(`no packed collision for "${slug}" (${file})`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder
  });
  const doc = await io.read(file);
  const tris = [];
  let kept = 0;
  let dropped = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const kind = node.getExtras()?.kind || 'solid';
    if (!NADE_SOLID.has(kind)) {
      dropped++;
      continue;
    }
    kept++;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const v = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(idx ? idx.getScalar(i) : i, v);
        // glTF node transform, column-major.
        tris.push(
          m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
        );
      }
    }
  }
  console.log(`  collision: ${(tris.length / 9).toFixed(0)} triangles from ${kept} nodes (${dropped} nodes are not grenade-solid)`);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3));
  const bvh = new MeshBVH(geo, { targetLeafSize: 8 });
  const bounds = new THREE.Box3();
  return createHullTracer((minX, minY, minZ, maxX, maxY, maxZ, visit) => {
    bounds.min.set(minX, minY, minZ);
    bounds.max.set(maxX, maxY, maxZ);
    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(bounds),
      intersectsTriangle: (t) => {
        visit(t.a.x, t.a.y, t.a.z, t.b.x, t.b.y, t.b.z, t.c.x, t.c.y, t.c.z);
        return false;
      }
    });
  });
}

// ---- the recorded throws ---------------------------------------------------

const TYPE = (n) => {
  const s = String(n || '');
  if (s.includes('Smoke')) return 'smokegrenade';
  if (s.includes('Flash')) return 'flashbang';
  if (s.includes('Decoy')) return 'decoy';
  if (s.includes('Molotov') || s.includes('Incendiary')) return 'molotov';
  if (s.includes('HE') || s.includes('Frag')) return 'hegrenade';
  return 'hegrenade';
};

function flightsFrom(file) {
  const p = require('@laihoe/demoparser2');
  const rows = p.parseGrenades(file, ['m_vInitialVelocity', 'm_flCreateTime', 'm_flDetonateTime'], false);
  const byEntity = new Map();
  for (const r of rows) {
    const id = r.grenade_entity_id ?? r.entity_id;
    if (id == null) continue;
    if (!byEntity.has(id)) byEntity.set(id, []);
    byEntity.get(id).push(r);
  }
  const out = [];
  for (const [, s] of byEntity) {
    s.sort((a, b) => a.tick - b.tick);
    let run = [];
    const flush = () => {
      if (run.length >= 4 && Array.isArray(run[0].m_vInitialVelocity)) out.push(run);
      run = [];
    };
    for (const x of s) {
      if (run.length && x.tick - run[run.length - 1].tick > 16) flush();
      run.push(x);
    }
    flush();
  }
  return out;
}

// ---- the comparison --------------------------------------------------------

const quant = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN);

/**
 * How much gravity to take off the release velocity before starting.
 *
 * The first recorded sample is not the release: the projectile has already
 * flown a tick by the time it appears, so its velocity there is no longer
 * `m_vInitialVelocity`. Starting with the raw release velocity leaves a
 * constant ~5 u/s of upward bias, which shows up as error growing LINEARLY
 * with flight time (a gravity error would grow quadratically). 5 u/s is
 * 320/64 — exactly one tick. --scan measures the coefficient instead of
 * assuming it.
 */
const GRAV_TICK = 800 * 0.4 * (1 / 64);
let START_GRAVITY_TICKS = 1;

function replay(flight, world) {
  const s = flight[0];
  const v = s.m_vInitialVelocity;
  const type = TYPE(s.grenade_type);
  const g = createGrenade(
    { x: s.x, y: s.y, z: s.z },
    { x: v[0], y: v[1], z: v[2] - GRAV_TICK * START_GRAVITY_TICKS },
    type
  );
  const recorded = flight.map((r) => ({ tick: r.tick, x: r.x, y: r.y, z: r.z }));
  const t0 = recorded[0].tick;
  const byTick = new Map(recorded.map((r) => [r.tick, r]));
  const last = recorded[recorded.length - 1];
  let worst = 0;
  let atLanding = 0;
  const perTick = [];
  for (let t = t0 + 1; t <= last.tick; t++) {
    stepGrenade(g, world);
    const r = byTick.get(t);
    if (!r) continue;
    const d = Math.hypot(g.pos.x - r.x, g.pos.y - r.y, g.pos.z - r.z);
    perTick.push({ dt: (t - t0) / 64, d });
    if (d > worst) worst = d;
    atLanding = d;
    if (g.detonated) break;
  }
  return { type, error: atLanding, worst, ticks: last.tick - t0, bounces: g.bounces, perTick, resting: g.resting };
}

// ---- run -------------------------------------------------------------------

const slug = MAP || 'nuke';
console.log(`grenade oracle: map "${slug}", ${demos.length} demo(s)\n`);
const world = await loadNadeWorld(slug);

const loaded = [];
for (const file of demos) {
  console.log(`  ${path.basename(file)}`);
  const flights = flightsFrom(file).slice(0, MAX);
  console.log(`    ${flights.length} recorded flights`);
  loaded.push(...flights);
}

// Which start state lines the sim up with the recording? Judged on the flights
// that never bounce, where nothing but the ballistics is under test.
{
  console.log('\nstart-state scan (0-bounce flights only, final error in units):');
  let best = { k: 1, med: Infinity };
  for (const k of [0, 0.5, 1, 1.5, 2]) {
    START_GRAVITY_TICKS = k;
    const e = loaded.map((f) => replay(f, world)).filter((r) => r.bounces === 0).map((r) => r.error);
    if (!e.length) break;
    const med = quant(e, 0.5);
    console.log(`  v0 - ${k} tick(s) of gravity:  n=${e.length}  median ${med.toFixed(2)}  p90 ${quant(e, 0.9).toFixed(2)}`);
    if (med < best.med) best = { k, med };
  }
  START_GRAVITY_TICKS = best.k;
  console.log(`  -> using ${best.k}`);
}

const all = loaded.map((f) => replay(f, world));

console.log(`\nreplayed ${all.length} flights from the recorded release velocity.`);
console.log(`elasticity ${GRENADE_ELASTICITY}, gravity scale ${GRENADE_GRAVITY_SCALE}\n`);

const byType = new Map();
for (const r of all) {
  if (!byType.has(r.type)) byType.set(r.type, []);
  byType.get(r.type).push(r);
}
console.log('final-position error (units), by type:');
for (const [t, list] of [...byType.entries()].sort()) {
  const e = list.map((r) => r.error);
  console.log(
    `  ${t.padEnd(13)} n=${String(list.length).padStart(4)}  ` +
      `median ${quant(e, 0.5).toFixed(1).padStart(7)}  p90 ${quant(e, 0.9).toFixed(1).padStart(8)}  max ${Math.max(...e).toFixed(0)}`
  );
}

// Error against how many bounces happened: the pre-bounce number is the pure
// ballistics check, and it should be tiny.
console.log('\nerror by bounce count (0 bounces = ballistics only):');
for (const b of [0, 1, 2, 3]) {
  const list = all.filter((r) => (b < 3 ? r.bounces === b : r.bounces >= 3));
  if (!list.length) continue;
  const e = list.map((r) => r.error);
  console.log(
    `  ${b < 3 ? `${b} bounce${b === 1 ? '' : 's'}` : '3+ bounces'}`.padEnd(14) +
      ` n=${String(list.length).padStart(4)}  median ${quant(e, 0.5).toFixed(1).padStart(7)}  p90 ${quant(e, 0.9).toFixed(1).padStart(8)}`
  );
}

// How the error grows with flight time, over every flight at once. A flat line
// is integration noise; a line with a knee is a wrong bounce.
console.log('\nerror vs time in flight (all flights pooled):');
const buckets = new Map();
for (const r of all) {
  for (const s of r.perTick) {
    const k = Math.floor(s.dt * 4) / 4;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(s.d);
  }
}
for (const [k, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  if (k > 4 || list.length < 8) continue;
  console.log(`  t=${k.toFixed(2)}s  n=${String(list.length).padStart(5)}  median ${quant(list, 0.5).toFixed(2).padStart(7)}  p90 ${quant(list, 0.9).toFixed(2).padStart(8)}`);
}

// ---- the bounce, measured straight off the recording ----------------------
//
// The elasticity is not in doubt (m_flElasticity reads 0.4375 on every
// projectile). HOW it is applied is: Source's ResolveFlyCollisionCustom
// reflects at full backoff and then damps the WHOLE vector, which damps the
// tangential component too, while the shape this repo used to have reflected at
// (1 + e) and then scaled - damping the normal twice and the tangential once.
// Those predict different tangential ratios and the recording can tell them
// apart, so this measures both ratios directly instead of trusting either.
{
  const normalRatios = [];
  const tangentRatios = [];
  for (const f of loaded) {
    // Velocity per tick from consecutive samples, only where they are adjacent.
    const vel = [];
    for (let i = 1; i < f.length; i++) {
      if (f[i].tick - f[i - 1].tick !== 1) {
        vel.push(null);
        continue;
      }
      vel.push({
        x: (f[i].x - f[i - 1].x) * 64,
        y: (f[i].y - f[i - 1].y) * 64,
        z: (f[i].z - f[i - 1].z) * 64
      });
    }
    for (let i = 1; i < vel.length - 1; i++) {
      const a = vel[i - 1];
      const b = vel[i + 1];
      if (!a || !b) continue;
      // A bounce is a velocity change gravity cannot explain, and the tick
      // either side of it is the cleanest pair: two ticks out and gravity has
      // already bent the answer.
      const dv = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (dv < 80) continue;
      // The plane: trace the step that crossed it and take the hull's normal.
      const p = f[i];
      const t = world.traceHull(
        { x: p.x - a.x / 64, y: p.y - a.y / 64, z: p.z - a.z / 64 },
        { x: p.x + b.x / 64, y: p.y + b.y / 64, z: p.z + b.z / 64 },
        2,
        2
      );
      if (t.fraction >= 1 || !t.normal) continue;
      const n = t.normal;
      const an = a.x * n.x + a.y * n.y + a.z * n.z;
      const bn = b.x * n.x + b.y * n.y + b.z * n.z;
      if (an >= -60) continue; // must be moving INTO the plane, and hard enough
      normalRatios.push(Math.abs(bn / an));
      const at = Math.hypot(a.x - an * n.x, a.y - an * n.y, a.z - an * n.z);
      const bt = Math.hypot(b.x - bn * n.x, b.y - bn * n.y, b.z - bn * n.z);
      if (at > 60) tangentRatios.push(bt / at);
    }
  }
  console.log('\nbounce, measured from the recorded velocities:');
  const show = (name, a, predictions) => {
    if (a.length < 8) {
      console.log(`  ${name}: only ${a.length} samples, not enough to conclude`);
      return;
    }
    console.log(
      `  ${name.padEnd(18)} n=${String(a.length).padStart(4)}  ` +
        `p25 ${quant(a, 0.25).toFixed(3)}  median ${quant(a, 0.5).toFixed(3)}  p75 ${quant(a, 0.75).toFixed(3)}`
    );
    for (const [label, v] of predictions) {
      const near = a.filter((x) => Math.abs(x - v) < 0.06).length;
      console.log(`      ${label} predicts ${v.toFixed(4)}: ${((100 * near) / a.length).toFixed(0)}% of samples within 0.06`);
    }
  };
  const e = GRENADE_ELASTICITY;
  show('normal restitution', normalRatios, [['Source: reflect then damp all', e], ['reflect at (1+e) then damp', e * e]]);
  show('tangential damping', tangentRatios, [
    ['reflect-then-damp-all (this repo)', e],
    ['damp the normal only', 1]
  ]);
}

if (VERBOSE) {
  console.log('\nworst 10 flights:');
  for (const r of all.slice().sort((a, b) => b.error - a.error).slice(0, 10)) {
    console.log(`  ${r.type.padEnd(13)} ${r.ticks} ticks, ${r.bounces} bounces, final error ${r.error.toFixed(1)}`);
  }
}
