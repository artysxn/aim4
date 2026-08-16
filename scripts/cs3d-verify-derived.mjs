// ---------------------------------------------------------------------------
// scripts/cs3d-verify-derived.mjs
// Score shared/sim3d/deriveFlags.js against ground truth.
//
// The derivation exists to recover movement state for rounds parsed before
// the adapter asked the demo for it by the right names. Whether that recovery
// is good enough is not a matter of opinion: for one match we still have both
// the parsed package AND the .dem, so the derived flags can be compared tick
// by tick with what the game actually replicated.
//
//   node scripts/cs3d-verify-derived.mjs <package.aim4replay> <match.dem>
//
// Ground truth comes from the fully-qualified props (the ones that work):
//   CCSPlayerPawn.m_fFlags & 1            FL_ONGROUND, so airborne = !(f & 1)
//   ...MovementServices.m_bDucked         the ducked boolean
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz } from '../server/replays/tickCodec.js';
import { readHeader, readRecord } from '../src/replays/shared/tickFormat.js';
import { deriveMovementFlags } from '../shared/sim3d/deriveFlags.js';
import { simWeapon } from '../shared/sim/weapons.js';

const require = createRequire(import.meta.url);
const parser = require('@laihoe/demoparser2');

const MS = 'CCSPlayerPawn.CCSPlayer_MovementServices.';
const PROP_DUCKED = `${MS}m_bDucked`;
const PROP_DUCK_AMOUNT = `${MS}m_flDuckAmount`;
const PROP_FLAGS = 'CCSPlayerPawn.m_fFlags';

const [pkgPath, demPath] = process.argv.slice(2);
if (!pkgPath || !demPath) {
  console.error('usage: node scripts/cs3d-verify-derived.mjs <package.aim4replay> <match.dem>');
  process.exit(1);
}

function score(name, tp, fp, fn, tn) {
  const total = tp + fp + fn + tn;
  const acc = total ? (tp + tn) / total : 0;
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  console.log(
    `  ${name.padEnd(9)} accuracy ${(100 * acc).toFixed(2)}%   precision ${(100 * prec).toFixed(1)}%  ` +
      `recall ${(100 * rec).toFixed(1)}%  F1 ${(100 * f1).toFixed(1)}%   ` +
      `(${tp} hit, ${fp} false, ${fn} missed of ${tp + fn} real)`
  );
}

const { files } = decodeReplayPackage(await fsp.readFile(pkgPath));
const stems = [];
for (const n of files.keys()) {
  const m = /^rounds\/(.+?)\.tickz$/.exec(n);
  if (m) stems.push(m[1]);
}

// One parseTicks over the whole demo, indexed by tick then steamid.
console.log(`reading ${demPath} …`);
const rows = parser.parseTicks(demPath, [PROP_FLAGS, PROP_DUCKED, PROP_DUCK_AMOUNT]);
const truth = new Map(); // `${tick}:${steamid}` -> { air, duck, amount }
for (const r of rows) {
  const f = r[PROP_FLAGS];
  if (f === null || f === undefined) continue;
  truth.set(`${r.tick}:${r.steamid}`, {
    air: (f & 1) === 0 ? 1 : 0,
    duck: r[PROP_DUCKED] ? 1 : 0,
    amount: r[PROP_DUCK_AMOUNT] ?? 0
  });
}
console.log(`ground truth: ${truth.size} tick-player rows\n`);

const acc = { air: [0, 0, 0, 0], duck: [0, 0, 0, 0] };
let partialDuck = 0;
let anyDuck = 0;
let rounds = 0;

for (const stem of stems) {
  const meta = JSON.parse(zlib.zstdDecompressSync(Buffer.from(files.get(`rounds/${stem}.json.zst`))).toString('utf8'));
  const view = new DataView(decodeTickz(Buffer.from(files.get(`rounds/${stem}.tickz`))));
  const header = readHeader(view);
  const derived = deriveMovementFlags(view, header, {
    weapons: meta.weapons || [],
    runSpeedFor: (n) => simWeapon(n)?.runSpeed || 0
  });
  const bySlot = new Map((meta.players || []).map((p) => [p.slot, p.steamId]));
  const tmp = {};

  for (let slot = 0; slot < (header.playerCount || 10); slot++) {
    const steam = bySlot.get(slot);
    if (!steam) continue;
    for (let i = 0; i < header.tickCount; i++) {
      const r = readRecord(view, i, slot, tmp);
      if (!r.alive) continue;
      const t = truth.get(`${header.firstTick + i * header.stride}:${steam}`);
      if (!t) continue;
      if (t.amount > 0.001 && t.amount < 0.999) partialDuck++;
      if (t.duck) anyDuck++;
      for (const [key, got, want] of [
        ['air', derived.airborne[slot][i], t.air],
        ['duck', derived.ducked[slot][i], t.duck]
      ]) {
        const a = acc[key];
        if (got && want) a[0]++;
        else if (got && !want) a[1]++;
        else if (!got && want) a[2]++;
        else a[3]++;
      }
    }
  }
  rounds++;
}

console.log(`derived vs demo, ${rounds} rounds:`);
score('airborne', ...acc.air);
score('ducked', ...acc.duck);
console.log(
  `\n  note: ${partialDuck} of ${partialDuck + anyDuck} crouch-state rows are MID-TRANSITION ` +
    `(0 < m_flDuckAmount < 1),\n  which a binary flag cannot represent at all — see tick format v2 in the plan.`
);
