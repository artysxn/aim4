// ---------------------------------------------------------------------------
// scripts/hltv-recoverable.mjs
// How much of the library can be reparsed at PARSER_REVISION 3?
//
// Rounds parsed before revision 3 carry zeros in FLAG_DUCKING / FLAG_AIRBORNE
// (demoparser2 silently omits `is_ducking` and `in_air`), and that cannot be
// repaired from the tick buffer — a stationary crouch leaves no trace in a
// stored row. The only repair is a reparse, and a reparse needs the .dem.
//
// The ingest ledger is what makes that possible: for demos pulled from HLTV
// the row key IS the HLTV demo id, and the row carries `hltvDemoId` and the
// full `matchUrl`, so the archive can be fetched again. Demos that arrived
// any other way (user uploads, sources/local.js) have no such handle and are
// frozen as they are unless someone still holds the file.
//
// This script answers, without downloading anything:
//   - how many library demos exist, and how many the ledger accounts for
//   - how many of those are re-downloadable (have an hltvDemoId / matchUrl)
//   - which are orphaned, i.e. permanently stuck at revision < 3
//
//   node scripts/hltv-recoverable.mjs            # summary
//   node scripts/hltv-recoverable.mjs --ids      # also print the fetch list
//
// Run it on the server, where server/data is the live volume.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/ingest/hltv/config.js';
import { ROOT, listLibraryUsers, listDemos } from '../server/replays/demoStore.js';

const SHOW_IDS = process.argv.includes('--ids');

const cfg = await loadConfig();
console.log(`ledger:  ${cfg.ledgerPath}`);
console.log(`library: ${ROOT}\n`);

let ledger;
try {
  ledger = JSON.parse(await fsp.readFile(cfg.ledgerPath, 'utf8'));
} catch (err) {
  console.error(`Could not read the ledger (${err.code || err.message}).`);
  console.error('Without it, no demo can be traced back to an HLTV id.');
  process.exit(1);
}

const rows = ledger.matches || [];
// aim4 demo id -> the ledger row that produced it.
const byDemoId = new Map();
let withHandle = 0;
for (const row of rows) {
  const handle = row.hltvDemoId ?? (row.source === 'hltv' ? Number(row.matchId) : null);
  const usable = Number.isFinite(handle) && handle > 0;
  if (usable) withHandle++;
  for (const id of row.demoIds || []) {
    byDemoId.set(String(id), { row, handle: usable ? handle : null });
  }
}

console.log(`ledger rows: ${rows.length}`);
console.log(`  with an HLTV handle (re-downloadable): ${withHandle}`);
console.log(`  states: ${JSON.stringify(
  rows.reduce((a, r) => ((a[r.state] = (a[r.state] || 0) + 1), a), {})
)}`);
console.log(`  aim4 demo ids claimed by the ledger: ${byDemoId.size}\n`);

// Walk the actual library and classify every stored demo.
const users = await listLibraryUsers().catch(() => []);
let total = 0;
let recoverable = 0;
let orphaned = 0;
const fetchList = new Set();
const orphanSample = [];

for (const user of users) {
  const demos = await listDemos(user).catch(() => []);
  for (const d of demos) {
    total++;
    const hit = byDemoId.get(String(d.demoId ?? d.id));
    if (hit?.handle) {
      recoverable++;
      fetchList.add(hit.handle);
    } else {
      orphaned++;
      if (orphanSample.length < 8) orphanSample.push(d.demoId ?? d.id);
    }
  }
}

const pct = (n) => (total ? ((100 * n) / total).toFixed(1) : '0.0') + '%';
console.log(`library demos: ${total}  (${users.length} users)`);
console.log(`  recoverable — reparse at revision 3: ${recoverable}  ${pct(recoverable)}`);
console.log(`  orphaned    — no .dem handle, frozen: ${orphaned}  ${pct(orphaned)}`);
console.log(`  distinct HLTV archives to fetch: ${fetchList.size}`);
if (orphanSample.length) console.log(`  orphan sample: ${orphanSample.join(', ')}`);

if (SHOW_IDS) {
  console.log('\nHLTV demo ids to re-fetch:');
  console.log([...fetchList].sort((a, b) => a - b).join('\n'));
}

console.log(
  '\nOne archive is one download. The pipeline already knows how to fetch these\n' +
    '(server/ingest/hltv/pipeline.js runOneDemo), so a backfill is that loop over\n' +
    'the list above, reparsing rather than re-ingesting.'
);
