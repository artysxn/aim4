// ---------------------------------------------------------------------------
// scripts/cs3d-backfill.mjs
// Upgrade the whole library to the current PARSER_REVISION, one demo at a time.
//
// Why this is not "just re-run the ingester": the ingester is idempotent by
// design. runOneDemo() skips any match whose ledger row is terminal, and every
// successfully ingested demo is CLEANED, which is terminal — so a re-run walks
// the whole cursor and downloads nothing. Forcing it past that would be worse:
// process.js mints a fresh newDemoId() per parse, so the library would gain
// 4200 duplicates instead of upgrading 4200 rows.
//
// This drives server/replays/reparseQueue.js instead, which re-fetches by the
// ledger's HLTV handle and writes the result back UNDER THE EXISTING DEMO ID,
// carrying visibility, tags, views and notes across.
//
//   node scripts/cs3d-backfill.mjs --dry-run      # what would happen
//   node scripts/cs3d-backfill.mjs --limit 10     # ten, then stop
//   node scripts/cs3d-backfill.mjs --map NUK      # only maps with a 3D pack
//   node scripts/cs3d-backfill.mjs                # everything recoverable
//
// Serial on purpose: HLTV is rate limited and Cloudflare-gated, and the
// continuous ingester may be running. Ctrl-C is safe at any point — a demo is
// only replaced after its parse succeeds, so an interrupted run leaves every
// demo either upgraded or exactly as it was.
// ---------------------------------------------------------------------------

import { PARSER_REVISION } from '../server/demoparser/schema.js';
import { listLibraryUsers, listDemos } from '../server/replays/demoStore.js';
import { hltvHandleFor, statusFor, requestUpgrade } from '../server/replays/reparseQueue.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const DRY = has('--dry-run');
const LIMIT = Number(val('--limit', Infinity)) || Infinity;
const MAP = String(val('--map', '')).toUpperCase();

console.log(`target revision ${PARSER_REVISION}${DRY ? '  (dry run)' : ''}`);

const users = await listLibraryUsers().catch(() => []);
if (!users.length) {
  console.error('No library users found. Is AIM4_REPLAY_DIR pointing at the volume?');
  process.exit(1);
}

/** Everything that is behind, with the reason it can or cannot be fixed. */
const plan = [];
let current = 0;
let total = 0;

for (const user of users) {
  for (const demo of await listDemos(user).catch(() => [])) {
    total++;
    const id = demo.demoId ?? demo.id;
    const revision = demo.parser?.revision ?? 1;
    if (revision >= PARSER_REVISION) {
      current++;
      continue;
    }
    if (MAP && String(demo.map || '').toUpperCase() !== MAP) continue;
    const handle = await hltvHandleFor(id);
    plan.push({
      user,
      id,
      map: demo.map || '?',
      revision,
      handle: handle?.hltvDemoId ?? null,
      label: `${demo.team1?.name || demo.team1 || '?'} vs ${demo.team2?.name || demo.team2 || '?'}`
    });
  }
}

const doable = plan.filter((p) => p.handle);
const stuck = plan.filter((p) => !p.handle);

console.log(`\nlibrary: ${total} demos across ${users.length} user(s)`);
console.log(`  already at revision ${PARSER_REVISION}: ${current}`);
console.log(`  behind and recoverable:               ${doable.length}`);
console.log(`  behind with no HLTV source (frozen):  ${stuck.length}`);
if (MAP) console.log(`  (filtered to map ${MAP})`);

if (stuck.length) {
  console.log(`\n  frozen sample: ${stuck.slice(0, 5).map((p) => `${p.id}(${p.map})`).join(', ')}`);
  console.log('  these were uploaded or locally ingested; only the original .dem can fix them.');
}

if (!doable.length) {
  console.log('\nNothing to do.');
  process.exit(0);
}

const work = doable.slice(0, LIMIT === Infinity ? doable.length : LIMIT);
console.log(`\nwill upgrade ${work.length} demo(s):`);
for (const p of work.slice(0, 10)) {
  console.log(`  ${p.id}  ${p.map.padEnd(4)} rev ${p.revision} -> ${PARSER_REVISION}  hltv/${p.handle}  ${p.label}`);
}
if (work.length > 10) console.log(`  … and ${work.length - 10} more`);

if (DRY) {
  console.log('\nDry run: nothing was downloaded or written.');
  process.exit(0);
}

console.log('\nstarting — one download at a time, Ctrl-C is safe\n');
let ok = 0;
let failed = 0;
const t0 = Date.now();

for (let i = 0; i < work.length; i++) {
  const p = work[i];
  const at = `[${i + 1}/${work.length}]`;
  process.stdout.write(`${at} ${p.id} ${p.map} … `);
  try {
    // requestUpgrade queues and drains; the queue is serial, so awaiting the
    // settle below keeps this loop in step with it.
    await requestUpgrade(p.user, p.id);
    let state = null;
    // Poll the job until it leaves the queue.
    for (;;) {
      const s = await statusFor(p.user, p.id);
      state = s.job?.state ?? (s.current ? 'done' : 'failed');
      if (state === 'done' || state === 'failed' || s.current) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const after = await statusFor(p.user, p.id);
    if (after.current) {
      ok++;
      console.log('upgraded');
    } else {
      failed++;
      console.log(`FAILED (${after.job?.error || 'unknown'})`);
    }
  } catch (err) {
    failed++;
    console.log(`FAILED (${String(err?.message || err).slice(0, 120)})`);
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\ndone in ${mins} min — ${ok} upgraded, ${failed} failed, ${stuck.length} unfixable`);
