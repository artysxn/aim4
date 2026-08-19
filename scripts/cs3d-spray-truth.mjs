#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-spray-truth.mjs
// The spray pattern, measured out of CS2 itself.
//
// This is the tool behind the reference table in shared/sim3d/recoil.test.js,
// and the reason that file can claim to check the generator against the game
// rather than against a fixture of its own.
//
// It works because CS2 NETWORKS THE RECOIL. A GOTV demo carries, per tick, for
// every player:
//
//   CCSPlayerPawn.m_aimPunchAngle      where the bullets are actually going
//   CCSPlayerPawn.m_aimPunchAngleVel   the velocity behind it, post-kick
//   CCSPlayerPawn.m_aimPunchTickBase   the tick the pair was stamped at
//   CCSPlayerPawn.m_aimPunchTickFraction   ...and the sub-tick within it
//   CCSPlayerPawn.m_iShotsFired        where in the spray they are
//   Weapon.m_flRecoilIndex             the table index, as a float
//   Weapon.m_fAccuracyPenalty          the decayed inaccuracy state
//
// So a demo of people spraying rifles at each other is a recording of the
// exact pattern the game generates, from as many players as were in the
// server. What it took to read cleanly:
//
//   THE PROPS NEED THEIR FULL NAMES. `parseTicks(file, ['m_aimPunchAngle'])`
//   returns rows with no such column and no error — the property is silently
//   dropped. `CCSPlayerPawn.m_aimPunchAngle` works. (The weapon's own fields
//   are the other way round: `m_flRecoilIndex`, unqualified.)
//
//   THE CADENCE HAS TO BE FILTERED. `m_iShotsFired` does not reset the moment
//   a player stops shooting, so a burst-pause-burst reads as one continuous
//   spray and its shot 6 sat 0.4 s after its shot 5. Averaging those together
//   smears every number. This keeps the LEADING RUN of each spray whose gaps
//   are at the weapon's own cycle time and throws the rest away.
//
//   THE TICK BASE IS QUANTISED. `m_aimPunchTickBase` counts at twice the demo
//   tick, and the fraction moves in steps of 0.4, so an AK's 0.1 s cycle shows
//   up as gaps that alternate 12.4 and 13.4 rather than a constant 12.8. The
//   cadence window is around the MEAN, not the median, for that reason.
//
// What it found, and what recoil.js is built on:
//
//   * the first table angle for seed 223 is 27.33 deg, and the first shot's
//     measured punch velocity is at 27.330 deg — so ran1 plus the vdata seed
//     IS the game's generator, confirmed rather than inferred. The M4A4
//     (38965) and the Galil (51191) agree on their own first angles.
//   * the first shot's kick is exactly 0.75 of the weapon's magnitude
//   * solving `vel[k] = D·vel[k-1] + M·û` per interval gives D = 0.63763 at
//     EVERY shot index of an AK spray, and exp(-4.5 × 0.1) is 0.637628
//
// Usage:
//   node --max-old-space-size=8192 scripts/cs3d-spray-truth.mjs <demo.dem...>
//   ... --weapon ak47      only that one
//   ... --json out.json    the full per-shot table
//   ... --raw sprays.json  every spray, unaggregated, for re-analysis
// ---------------------------------------------------------------------------

import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const files = args.filter((a) => a.toLowerCase().endsWith('.dem'));
const only = opt('--weapon');
const jsonOut = opt('--json');
const rawOut = opt('--raw');

if (!files.length) {
  console.error('cs3d-spray-truth: give it one or more .dem files');
  process.exit(1);
}

let parser;
try {
  parser = await import('@laihoe/demoparser2');
} catch (e) {
  console.error('cs3d-spray-truth: @laihoe/demoparser2 is not installed (it is an optional dependency)');
  process.exit(1);
}
const { parseTicks, parseEvent } = parser;

const PUNCH = 'CCSPlayerPawn.m_aimPunchAngle';
const VEL = 'CCSPlayerPawn.m_aimPunchAngleVel';
const SHOTS = 'CCSPlayerPawn.m_iShotsFired';
const TICKBASE = 'CCSPlayerPawn.m_aimPunchTickBase';
const TICKFRAC = 'CCSPlayerPawn.m_aimPunchTickFraction';

/** weapon -> array of sprays, each an array of shots in order. */
const sprays = {};

for (const file of files) {
  process.stderr.write(`[${file}]\n`);
  const fires = parseEvent(file, 'weapon_fire', ['user_steamid'], []);
  const ticks = [...new Set(fires.map((f) => f.tick))].sort((a, b) => a - b);
  const rows = parseTicks(file, [PUNCH, VEL, SHOTS, TICKBASE, TICKFRAC, 'm_flRecoilIndex', 'm_fAccuracyPenalty'], ticks);
  process.stderr.write(`  ${fires.length} shots, ${rows.length} tick rows\n`);

  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.tick}|${r.steamid}`, r);

  const byPlayer = new Map();
  for (const f of fires) {
    if (!f.user_steamid) continue;
    if (!byPlayer.has(f.user_steamid)) byPlayer.set(f.user_steamid, []);
    byPlayer.get(f.user_steamid).push(f);
  }

  for (const [id, shots] of byPlayer) {
    shots.sort((a, b) => a.tick - b.tick);
    let cur = null;
    for (const s of shots) {
      const r = byKey.get(`${s.tick}|${id}`);
      if (!r) continue;
      const n = r[SHOTS];
      const p = r[PUNCH];
      const v = r[VEL];
      if (!Array.isArray(p) || !Array.isArray(v) || !Number.isFinite(n)) continue;
      const weapon = String(s.weapon || '').replace(/^weapon_/, '');
      if (only && weapon !== only) continue;
      // A new spray starts at shot 1; anything that skips an index has had a
      // reload or a weapon switch in the middle and is not one run.
      if (n === 1 || !cur || cur.weapon !== weapon || n !== cur.shots.length + 1) {
        if (cur && cur.shots.length >= 4) (sprays[cur.weapon] ||= []).push(cur.shots);
        cur = n === 1 ? { weapon, shots: [] } : null;
      }
      if (!cur) continue;
      cur.shots.push({
        i: n,
        at: (r[TICKBASE] ?? s.tick * 2) + (r[TICKFRAC] ?? 0),
        punch: [p[0], p[1]],
        vel: [v[0], v[1]],
        recoilIndex: r.m_flRecoilIndex ?? null,
        penalty: r.m_fAccuracyPenalty ?? null
      });
    }
    if (cur && cur.shots.length >= 4) (sprays[cur.weapon] ||= []).push(cur.shots);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/** Per weapon: the median punch at each shot index, full-auto runs only. */
function aggregate(list) {
  const gaps = [];
  for (const s of list) for (let k = 1; k < s.length; k++) gaps.push(s[k].at - s[k - 1].at);
  if (!gaps.length) return null;
  const med = median(gaps);
  const near = gaps.filter((g) => Math.abs(g - med) < 2);
  const cadence = near.reduce((a, b) => a + b, 0) / Math.max(1, near.length);

  const per = new Map();
  for (const s of list) {
    if (!s.length || s[0].i !== 1) continue;
    for (let k = 0; k < s.length; k++) {
      // Stop at the first gap that is not the weapon's own fire rate.
      if (k > 0 && Math.abs(s[k].at - s[k - 1].at - cadence) > 0.75) break;
      const e = per.get(s[k].i) || { p: [], y: [], vp: [], vy: [] };
      e.p.push(s[k].punch[0]);
      e.y.push(s[k].punch[1]);
      e.vp.push(s[k].vel[0]);
      e.vy.push(s[k].vel[1]);
      per.set(s[k].i, e);
    }
  }
  return {
    cadence,
    rows: [...per.entries()]
      .filter(([, v]) => v.p.length >= 5)
      .sort((a, b) => a[0] - b[0])
      .map(([i, v]) => ({
        i,
        n: v.p.length,
        pitch: +median(v.p).toFixed(4),
        yaw: +median(v.y).toFixed(4),
        velPitch: +median(v.vp).toFixed(3),
        velYaw: +median(v.vy).toFixed(3)
      }))
  };
}

const out = {};
for (const [weapon, list] of Object.entries(sprays)) {
  const agg = aggregate(list);
  if (!agg) continue;
  out[weapon] = agg;
  console.log(`\n=== ${weapon}  ${list.length} sprays, cadence ${agg.cadence.toFixed(3)} tick-base units ===`);
  console.log('  i     n     pitch       yaw  |  velPitch    velYaw');
  for (const r of agg.rows.slice(0, 24)) {
    console.log(
      `${String(r.i).padStart(3)} ${String(r.n).padStart(5)} ${r.pitch.toFixed(4).padStart(9)} ${r.yaw
        .toFixed(4)
        .padStart(9)} | ${r.velPitch.toFixed(2).padStart(9)} ${r.velYaw.toFixed(2).padStart(9)}`
    );
  }
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\nwritten ${jsonOut}`);
}
if (rawOut) {
  fs.writeFileSync(rawOut, JSON.stringify(sprays));
  console.log(`written ${rawOut} (every spray, for re-analysis)`);
}
