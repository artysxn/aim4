// ---------------------------------------------------------------------------
// scripts/cs3d-bullet-oracle.mjs
// The bullet oracle: run every recorded `player_hurt` in a demo through
// shared/sim3d/penetration.js and report how far off the damage is.
//
//   node scripts/cs3d-bullet-oracle.mjs <demo.dem> [...] [--max N] [--verbose]
//
// What this settles, and what it deliberately cannot.
//
// SETTLES. A demo records, for every shot that landed: the weapon, both
// players' positions, the hit group, the victim's armour, and the damage split
// between health and armour. That is every input to the damage law except the
// wall, so the falloff curve (rangeModifier^(d/500)), the hit-group
// multipliers, the armour ratio and its 0.5 scale are all directly checkable
// against thousands of real hits, and this file is where they were checked.
//
// CANNOT. It says nothing about PENETRATION_UNITS. A demo records that a
// bullet arrived, not what it went through — no wall, no thickness, no surface
// — so a wallbang shows up here only as a hit that under-predicts, mixed in
// with every other cause of the same. Those are reported separately and
// excluded from the fit rather than quietly averaged into it. Settling that
// constant needs the shot line replayed against the map's collision, which is
// the same shape of job scripts/cs3d-nade-oracle.mjs does for grenades and is
// not this file.
//
// Distances are between the two players' ORIGINS, which is their feet: the real
// shot runs eye to hitbox, so every distance here is off by up to about 64
// units. On a 0.98 modifier that is 0.25% of the damage, well under the whole unit
// the game reports in, and it is the same small bias on every row.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rangeFalloff, armorSplit, hitgroupMultiplier, armorAgainst } from '../shared/sim3d/penetration.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const demos = [];
let MAX = 0;
let VERBOSE = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--max') MAX = Number(args[++i]) || 0;
  else if (a === '--verbose') VERBOSE = true;
  else demos.push(a);
}
if (!demos.length) {
  console.error('usage: node scripts/cs3d-bullet-oracle.mjs <demo.dem> [...] [--max N] [--verbose]');
  process.exit(1);
}

let parser;
try {
  parser = require('@laihoe/demoparser2');
} catch {
  console.error('cs3d-bullet-oracle: @laihoe/demoparser2 is not installed');
  process.exit(1);
}

const WEAPONS = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'server', 'data', 'cs3d', 'pack', 'weapons', 'manifest.json'), 'utf8')
).weapons;
const byName = new Map(Object.entries(WEAPONS).map(([name, w]) => [name, { name, ...w }]));

/**
 * Weapons whose `player_hurt` is not one bullet. A shotgun aggregates its
 * pellets into a single event, so the recorded damage is a sum over an unknown
 * number of hits and there is nothing here to compare a single-bullet
 * prediction against.
 */
const MULTI = new Set(['nova', 'xm1014', 'mag7', 'sawedoff', 'm249', 'negev']);
/** ...and these do not fire bullets at all. */
const NOT_A_BULLET = new Set(['hegrenade', 'inferno', 'molotov', 'incgrenade', 'flashbang', 'decoy', 'smokegrenade', 'world', 'knife', 'taser']);

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0');
function quantiles(list) {
  if (!list.length) return { p50: 0, p90: 0, max: 0, mean: 0 };
  const s = [...list].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length
  };
}

const rows = [];
for (const demo of demos) {
  if (!fs.existsSync(demo)) {
    console.error(`  missing: ${demo}`);
    continue;
  }
  process.stdout.write(`parsing ${path.basename(demo)} ... `);
  const events = parser.parseEvent(demo, 'player_hurt', ['X', 'Y', 'Z'], []);
  console.log(`${events.length} player_hurt`);
  for (const e of events) {
    const name = String(e.weapon || '').replace(/^weapon_/, '');
    if (NOT_A_BULLET.has(name) || MULTI.has(name)) continue;
    const w = byName.get(name);
    if (!w || !w.damage) continue;
    if (!Number.isFinite(e.attacker_X) || !Number.isFinite(e.user_X)) continue;
    const dist = Math.hypot(e.attacker_X - e.user_X, e.attacker_Y - e.user_Y, e.attacker_Z - e.user_Z);
    if (!(dist > 0)) continue;
    // `armor` and `health` are both POST-hit, so the vest the bullet actually
    // met is what is left plus what it took off.
    const armorBefore = (e.armor || 0) + (e.dmg_armor || 0);
    rows.push({
      weapon: name,
      w,
      dist,
      group: String(e.hitgroup || 'chest').toLowerCase().replace(/\s/g, ''),
      armorBefore,
      dmgHealth: e.dmg_health || 0,
      dmgArmor: e.dmg_armor || 0,
      health: e.health,
      tick: e.tick
    });
    if (MAX && rows.length >= MAX) break;
  }
  if (MAX && rows.length >= MAX) break;
}

if (!rows.length) {
  console.error('cs3d-bullet-oracle: no usable hits');
  process.exit(1);
}

// ---- predict --------------------------------------------------------------

const errors = [];
const byGroup = new Map();
const byArmor = { vest: [], bare: [] };
const under = [];
let capped = 0;

for (const r of rows) {
  const ranged = rangeFalloff(r.w.damage, r.w.rangeModifier, r.dist);
  const raw = ranged * hitgroupMultiplier(r.group, r.w.headshot);
  // A head shot meets a helmet or nothing; kevlar covers the body. The demo
  // does not say whether the victim had one, but it says whether the hit took
  // any armour off, which answers the same question.
  const split = armorSplit(raw, r.w.armorRatio, armorAgainst(r.group, r.armorBefore, r.dmgArmor > 0));
  // The game reports whole points and never takes more health than there is.
  const predicted = Math.round(split.health);
  const lethal = predicted >= r.health + r.dmgHealth;
  r.predicted = predicted;
  r.predArmor = Math.round(split.armor);
  r.err = r.dmgHealth - predicted;
  // A hit that killed is clamped by the victim's remaining health, so it can
  // only ever under-report; those cannot measure the law and are set aside.
  if (r.health === 0 && lethal) {
    capped++;
    continue;
  }
  errors.push(Math.abs(r.err));
  if (!byGroup.has(r.group)) byGroup.set(r.group, []);
  byGroup.get(r.group).push(Math.abs(r.err));
  (r.armorBefore > 0 ? byArmor.vest : byArmor.bare).push(Math.abs(r.err));
  // Recorded much less than predicted: something ate the bullet on the way,
  // and a wall is the usual something.
  if (r.err < -3) under.push(r);
}

const q = quantiles(errors);
const exact = errors.filter((e) => e === 0).length;
const within1 = errors.filter((e) => e <= 1).length;
const within3 = errors.filter((e) => e <= 3).length;

console.log(`\ncs3d-bullet-oracle: ${rows.length} recorded hits, ${errors.length} comparable (${capped} killing blows clamped by health)`);
console.log(`\n  damage error, |recorded − predicted|, in health points`);
console.log(`    exact      ${exact.toString().padStart(5)}  ${pct(exact, errors.length)}%`);
console.log(`    within 1   ${within1.toString().padStart(5)}  ${pct(within1, errors.length)}%`);
console.log(`    within 3   ${within3.toString().padStart(5)}  ${pct(within3, errors.length)}%`);
console.log(`    median ${q.p50.toFixed(1)}   p90 ${q.p90.toFixed(1)}   mean ${q.mean.toFixed(2)}   worst ${q.max.toFixed(0)}`);

console.log(`\n  by hit group (median error, count)`);
for (const [g, list] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const s = quantiles(list);
  console.log(`    ${g.padEnd(10)} ${s.p50.toFixed(1).padStart(5)}   n=${list.length}  within1 ${pct(list.filter((e) => e <= 1).length, list.length)}%`);
}

console.log(`\n  by armour (this is what tests the armorRatio × 0.5 scale)`);
for (const [k, list] of Object.entries(byArmor)) {
  const s = quantiles(list);
  console.log(`    ${k.padEnd(10)} ${s.p50.toFixed(1).padStart(5)}   n=${list.length}  within1 ${pct(list.filter((e) => e <= 1).length, list.length)}%`);
}

// ---- fit the hit-group multipliers ----------------------------------------
// Everything else in the damage law comes out of the game's own table; the hit
// groups do not, so they are solved here rather than asserted. Invert the chain
// on each hit — recorded damage over ranged damage over the armour ratio — and
// the multiplier falls out. Rows where the armour clamp bit, or where the kill
// truncated the damage, cannot be inverted and are left out.
const implied = new Map();
for (const r of rows) {
  if (r.health === 0) continue; // the kill clamped it
  const ranged = rangeFalloff(r.w.damage, r.w.rangeModifier, r.dist);
  if (!(ranged > 0)) continue;
  const armor = armorAgainst(r.group, r.armorBefore, r.dmgArmor > 0);
  // The clamp only bites when the vest ran out, which is exactly when it ends
  // the hit at zero armour left.
  if (armor > 0 && r.armorBefore - r.dmgArmor <= 0) continue;
  const scale = armor > 0 ? r.w.armorRatio * 0.5 : 1;
  const m = r.dmgHealth / (ranged * scale);
  if (!Number.isFinite(m) || m <= 0) continue;
  // The head is per weapon, so it is reported as a share of that weapon's own
  // headshot number rather than as a multiplier in its own right.
  const key = r.group;
  if (!implied.has(key)) implied.set(key, []);
  implied.get(key).push(r.group === 'head' ? m / r.w.headshot : m);
}
console.log(`\n  hit-group multipliers, SOLVED from the recorded damage`);
console.log(`    (head is reported as a share of the weapon own headshot multiplier)`);
for (const [g, list] of [...implied.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const s = quantiles(list);
  const used = hitgroupMultiplier(g, 1);
  console.log(
    `    ${g.padEnd(10)} median ${s.p50.toFixed(3).padStart(6)}   n=${String(list.length).padStart(3)}   in use ${used.toFixed(3)}` +
      (Math.abs(s.p50 - used) > 0.03 ? '   <-- differs' : '')
  );
}

console.log(`\n  ${under.length} hits (${pct(under.length, errors.length)}%) came in more than 3 under prediction.`);
console.log(`  A wallbang looks exactly like this, and so does a hit whose distance`);
console.log(`  this file measured feet-to-feet. Neither is separable without the map.`);

if (VERBOSE) {
  console.log(`\n  worst 20:`);
  const worst = [...rows].filter((r) => Number.isFinite(r.err)).sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 20);
  for (const r of worst) {
    console.log(
      `    ${r.weapon.padEnd(9)} ${r.group.padEnd(9)} ${r.dist.toFixed(0).padStart(5)}u  armor ${String(r.armorBefore).padStart(3)}  ` +
        `recorded ${String(r.dmgHealth).padStart(3)}  predicted ${String(r.predicted).padStart(3)}  err ${r.err > 0 ? '+' : ''}${r.err}`
    );
  }
}
