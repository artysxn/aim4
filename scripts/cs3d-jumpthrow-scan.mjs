// Scan sampledemos for standing jumpthrows and cluster inherited vz.
// This is how PERFECT_JUMPTHROW_INHERIT_Z in shared/sim3d/grenade.js was read:
// takeoff from the z-series, standing = pre-jump horiz < 30 u/s, leftover vz
// after subtracting the pitch-remapped throw. The 50% closest to the median
// are the perfect cluster (268.52, MAD 0.11); the rest are late / bounced.
//
//   node scripts/cs3d-jumpthrow-scan.mjs [sampledemos/]

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz } from '../server/replays/tickCodec.js';
import { readHeader, readRecord, HEADER_BYTES, TICK_BYTES } from '../src/replays/shared/tickFormat.js';
import { JUMP_IMPULSE, GRAVITY, TICK_DT } from '../shared/sim3d/constants.js';
import { throwPitch, throwSpeed, VELOCITY_INHERIT, GRENADE_GRAVITY_SCALE } from '../shared/sim3d/grenade.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const DIR = process.argv[2] || path.join(ROOT, 'sampledemos');

const STANDING_XY = 30; // u/s, "not moving"
const LOOKBACK = 40; // ticks before throw to find takeoff
const NADE_G = GRAVITY * GRENADE_GRAVITY_SCALE;

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function summarize(values) {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0 };
  const med = quantile(s, 0.5);
  return {
    n,
    med,
    mad: quantile(s.map((v) => Math.abs(v - med)).sort((a, b) => a - b), 0.5),
    p10: quantile(s, 0.1),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    p90: quantile(s, 0.9),
    min: s[0],
    max: s[n - 1]
  };
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');

async function listPackages(dir) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.endsWith('.aim4replay')) out.push(path.join(dir, e.name));
  }
  return out.sort();
}

function rowOf(header, tick) {
  const row = tick - header.firstTick;
  if (row < 0 || row >= header.tickCount) return -1;
  return row;
}

function findTakeoff(rows, throwRow) {
  // Flat ground then a rising tick. z is quantized to 0.25u.
  const from = Math.max(2, throwRow - LOOKBACK);
  let takeoff = -1;
  for (let i = from; i <= throwRow; i++) {
    if (!rows[i] || !rows[i - 1] || !rows[i - 2]) continue;
    const dz = rows[i].z - rows[i - 1].z;
    const prevDz = rows[i - 1].z - rows[i - 2].z;
    if (Math.abs(prevDz) < 0.4 && dz > 1.5) {
      takeoff = i;
    }
  }
  return takeoff;
}

function preJumpHoriz(rows, takeoff) {
  const a = Math.max(0, takeoff - 8);
  let sum = 0;
  let n = 0;
  for (let i = a + 1; i < takeoff; i++) {
    if (!rows[i] || !rows[i - 1]) continue;
    const dx = rows[i].x - rows[i - 1].x;
    const dy = rows[i].y - rows[i - 1].y;
    sum += Math.hypot(dx, dy) / TICK_DT;
    n++;
  }
  return n ? sum / n : Infinity;
}

function velAt(rows, i) {
  if (i <= 0 || !rows[i] || !rows[i - 1]) return { x: 0, y: 0, z: 0 };
  return {
    x: (rows[i].x - rows[i - 1].x) / TICK_DT,
    y: (rows[i].y - rows[i - 1].y) / TICK_DT,
    z: (rows[i].z - rows[i - 1].z) / TICK_DT
  };
}

function nadeReleaseVel(path, maxTicks = 24) {
  if (!path || path.length < 2) return null;
  const a = path[0];
  const b = path[1];
  const dticks = b.tick - a.tick;
  if (dticks < 1 || dticks > maxTicks) return null;
  const dt = dticks * TICK_DT;
  return {
    x: (b.x - a.x) / dt,
    y: (b.y - a.y) / dt,
    z: (b.z - a.z) / dt + 0.5 * NADE_G * dt,
    dticks
  };
}

const hits = [];

async function processPackage(pkgFile) {
  const { files } = decodeReplayPackage(await fsp.readFile(pkgFile));
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
    let buf;
    try {
      buf = decodeTickz(Buffer.from(tickRaw));
    } catch {
      continue;
    }
    const view = new DataView(buf);
    const header = readHeader(view);
    if (header.stride !== 1) continue;
    if (HEADER_BYTES + header.tickCount * TICK_BYTES > buf.byteLength) continue;

    const players = meta.players || [];
    const slotOf = new Map();
    for (const p of players) {
      if (p?.id != null) slotOf.set(String(p.id), p.slot ?? players.indexOf(p));
    }

    const grenades = meta.events?.grenades || [];
    for (const g of grenades) {
      const slot = slotOf.get(String(g.player));
      if (slot == null) continue;
      const throwRow = rowOf(header, g.throwTick);
      if (throwRow < 8) continue;

      const rows = [];
      const tmp = {};
      const lo = Math.max(0, throwRow - LOOKBACK - 10);
      const hi = Math.min(header.tickCount - 1, throwRow + 4);
      for (let r = lo; r <= hi; r++) {
        readRecord(view, r, slot, tmp);
        rows[r] = { x: tmp.x, y: tmp.y, z: tmp.z, yaw: tmp.yaw, pitch: tmp.pitch, duck: tmp.duckAmount };
      }
      if (!rows[throwRow] || !rows[throwRow - 1]) continue;

      const takeoff = findTakeoff(rows, throwRow);
      const flight = Array.isArray(g.path) ? g.path : [];
      const nadeV = nadeReleaseVel(flight, 32);
      const horizSpeed = nadeV ? Math.hypot(nadeV.x, nadeV.y) : NaN;
      const pThrow = rows[throwRow];
      const pitch = pThrow.pitch;
      const tp = throwPitch(pitch);
      const speed = throwSpeed(1);
      const throwVz = speed * Math.sin((-tp) * Math.PI / 180); // pitch remapped, negative up → +z
      // throwPitch returns Source pitch (neg = up). releaseState uses fz = -sin(tp*DEG).
      const fz = -Math.sin(tp * Math.PI / 180);
      const expectedThrowVz = speed * fz;

      const playerV = velAt(rows, throwRow);
      const inheritedFromLive = nadeV ? nadeV.z - expectedThrowVz : NaN;
      const liveK = playerV.z !== 0 ? inheritedFromLive / playerV.z : NaN;

      const jumpTicks = takeoff >= 0 ? throwRow - takeoff : -1;
      const jumpMs = jumpTicks >= 0 ? jumpTicks * 1000 / 64 : NaN;
      const horiz = takeoff >= 0 ? preJumpHoriz(rows, takeoff) : NaN;
      const standing = takeoff >= 0 && horiz < STANDING_XY;
      const takeoffV = takeoff >= 0 ? velAt(rows, takeoff) : null;
      const dzRise = takeoff >= 0 ? pThrow.z - rows[takeoff].z : NaN;

      const from = g.from || flight[0] || null;
      const eyeZ = pThrow.z + 64 * (1 - (pThrow.duck || 0)); // rough; origin is feet
      const spawnVsFeet = from ? from.z - pThrow.z : NaN;
      const spawnVsTakeoff = from && takeoff >= 0 ? from.z - rows[takeoff].z : NaN;

      hits.push({
        file: path.basename(pkgFile),
        map: meta.map,
        round: meta.round,
        type: g.type,
        throwTick: g.throwTick,
        jumpTicks,
        jumpMs,
        horiz,
        standing,
        duck: pThrow.duck,
        pitch,
        tp,
        expectedThrowVz,
        playerVz: playerV.z,
        takeoffVz: takeoffV?.z,
        dzRise,
        nadeVz: nadeV?.z,
        nadeDticks: nadeV?.dticks,
        inherited: inheritedFromLive,
        liveK,
        nadeHoriz: horizSpeed,
        inheritVsImpulse: inheritedFromLive / JUMP_IMPULSE,
        spawnVsFeet,
        spawnVsTakeoff,
        pathN: flight.length,
        pathGap: flight.length >= 2 ? flight[1].tick - flight[0].tick : null
      });
    }
  }
}

const files = await listPackages(DIR);
console.log(`scanning ${files.length} packages in ${DIR}`);
for (const f of files) await processPackage(f);

const all = hits.filter((h) => h.jumpTicks >= 0 && h.jumpTicks <= 24);
const standing = all.filter((h) => h.standing);
const standingWithVel = standing.filter((h) => Number.isFinite(h.inherited) && h.nadeDticks <= 20);
const standingAnySeg = standing.filter((h) => Number.isFinite(h.inherited));
const windowed = standing.filter((h) => h.jumpMs <= 300); // spawn within ~200ms release + 94ms anim

console.log(`\nthrows: ${hits.length}  jumps-near-throw: ${all.length}  standing: ${standing.length}  with nade v0: ${standingWithVel.length}  any first-seg: ${standingAnySeg.length}`);
console.log('pathGap standing', JSON.stringify(summarize(standing.map((h) => h.pathGap))));
console.log('spawn z - takeoff z (all standing)', JSON.stringify(summarize(standing.map((h) => h.spawnVsTakeoff))));
console.log('spawn z - feet at throw', JSON.stringify(summarize(standing.map((h) => h.spawnVsFeet))));
console.log('player dz rise', JSON.stringify(summarize(standing.map((h) => h.dzRise))));
console.log('playerVz at spawn', JSON.stringify(summarize(standing.map((h) => h.playerVz))));
console.log('takeoffVz', JSON.stringify(summarize(standing.map((h) => h.takeoffVz))));

console.log('\n--- standing jumpthrows: jump-to-projectile ticks ---');
console.log(JSON.stringify(summarize(standing.map((h) => h.jumpTicks))));
console.log('ms:', JSON.stringify(summarize(standing.map((h) => h.jumpMs))));

console.log('\n--- standing + usable first path segment ---');
const sv = standingWithVel;
console.log('n=', sv.length);
console.log('jumpTicks', JSON.stringify(summarize(sv.map((h) => h.jumpTicks))));
console.log('playerVz at spawn', JSON.stringify(summarize(sv.map((h) => h.playerVz))));
console.log('takeoffVz', JSON.stringify(summarize(sv.map((h) => h.takeoffVz))));
console.log('nade inherited vz (v0 - throw vz)', JSON.stringify(summarize(sv.map((h) => h.inherited))));
console.log('inherited / JUMP_IMPULSE', JSON.stringify(summarize(sv.map((h) => h.inheritVsImpulse))));
console.log('inherited / playerVz', JSON.stringify(summarize(sv.map((h) => h.liveK))));
console.log('spawn z - feet z', JSON.stringify(summarize(sv.map((h) => h.spawnVsFeet))));
console.log('spawn z - takeoff z', JSON.stringify(summarize(sv.map((h) => h.spawnVsTakeoff))));
console.log('dz rise player', JSON.stringify(summarize(sv.map((h) => h.dzRise))));

// Cluster inherited vz: majority vs outliers
const inherited = sv.map((h) => h.inherited).sort((a, b) => a - b);
if (inherited.length) {
  const med = quantile(inherited, 0.5);
  const dist = sv.map((h) => ({ ...h, d: Math.abs(h.inherited - med) })).sort((a, b) => a.d - b.d);
  const half = Math.ceil(dist.length / 2);
  const best = dist.slice(0, half);
  const worst = dist.slice(half);
  console.log('\n--- 50% closest to median inherited vz (best) ---');
  console.log('inherited', JSON.stringify(summarize(best.map((h) => h.inherited))));
  console.log('playerVz', JSON.stringify(summarize(best.map((h) => h.playerVz))));
  console.log('jumpMs', JSON.stringify(summarize(best.map((h) => h.jumpMs))));
  console.log('k vs impulse', JSON.stringify(summarize(best.map((h) => h.inheritVsImpulse))));
  console.log('k vs live', JSON.stringify(summarize(best.map((h) => h.liveK))));
  console.log('\n--- 50% farthest from median (worst) ---');
  console.log('inherited', JSON.stringify(summarize(worst.map((h) => h.inherited))));
  console.log('playerVz', JSON.stringify(summarize(worst.map((h) => h.playerVz))));
  console.log('jumpMs', JSON.stringify(summarize(worst.map((h) => h.jumpMs))));
  console.log('k vs impulse', JSON.stringify(summarize(worst.map((h) => h.inheritVsImpulse))));
}

console.log('\nexpected perfect inherit = JUMP_IMPULSE * 1.25 =', JUMP_IMPULSE * VELOCITY_INHERIT);
console.log('expected live at 6 ticks: (J - g*6/64)*1.25 =', (JUMP_IMPULSE - GRAVITY * 6 / 64) * VELOCITY_INHERIT);
console.log('JUMP_IMPULSE', JUMP_IMPULSE, 'VELOCITY_INHERIT', VELOCITY_INHERIT);

// Histogram inherited by 20 u/s bins
const bins = new Map();
for (const h of sv) {
  const b = Math.round(h.inherited / 20) * 20;
  bins.set(b, (bins.get(b) || 0) + 1);
}
console.log('\ninherited vz histogram (20 u/s):');
for (const b of [...bins.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(b).padStart(6)}  ${'█'.repeat(bins.get(b))} ${bins.get(b)}`);
}

console.log('\njumpTicks histogram (standing):');
const jbins = new Map();
for (const h of standing) {
  jbins.set(h.jumpTicks, (jbins.get(h.jumpTicks) || 0) + 1);
}
for (const b of [...jbins.keys()].sort((a, b) => a - b)) {
  console.log(`  t=${String(b).padStart(2)} ${f1(b * 1000 / 64).padStart(6)}ms  ${'█'.repeat(Math.min(40, jbins.get(b)))} ${jbins.get(b)}`);
}

console.log('\nsample of standing+vel (first 25):');
for (const h of sv.slice(0, 25)) {
  console.log(
    `  ${h.file.slice(0, 22).padEnd(22)} r${String(h.round).padStart(2)} ${String(h.type).padEnd(12)} ` +
      `j=${String(h.jumpTicks).padStart(2)}t ${f1(h.jumpMs)}ms  ` +
      `pVz=${f1(h.playerVz)} inh=${f1(h.inherited)} kJ=${f2(h.inheritVsImpulse)} kL=${f2(h.liveK)} gap=${h.pathGap}`
  );
}
