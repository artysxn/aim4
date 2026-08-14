// ---------------------------------------------------------------------------
// scripts/lib/serverCorpus.mjs
// The same round stream as sampledemoPackages, sourced from the server library.
//
// Training locally reads `.aim4replay` packages out of a folder. Training on
// the server reads the library that the HLTV ingester has been filling, which
// is the entire point of moving training there: the local folder holds 42
// demos and the library's ceiling is 20 GB of round data, three orders of
// magnitude more. Every diagnostic run so far has ended at the same wall, that
// the optimizer is finished and only more data moves the number.
//
// Yields the identical `{ pkg, entry, meta, track }` shape so both extractors
// can switch source with a flag and nothing downstream notices. `pkg` carries
// only the fields the extractors actually read (`name`, `map`, `rounds`), so
// the two sources stay interchangeable without a package decoder here.
//
// Node-only.
// ---------------------------------------------------------------------------

import { SHARED_LIBRARY } from '../../server/replays/auth.js';
import { listDemos, readRoundMeta, readRoundTicks } from '../../server/replays/demoStore.js';
import { TickTrack } from '../../src/replays/tickStore.js';
import { isSynthetic } from '../../shared/sim/firewall.js';

/**
 * Walk every round of every ready demo in a library.
 *
 * Mirrors `eachRound` from sampledemoPackages: same option names, same yield
 * shape, same ordering guarantees (stable, demo by demo).
 *
 * @param {object} [opts]
 * @param {string} [opts.user]        library key, defaults to the shared one
 * @param {number} [opts.limit]       stop after this many demos
 * @param {string} [opts.match]       substring filter on the demo name
 * @param {string[]} [opts.maps]      map codes to keep
 * @param {string[]} [opts.skipMaps]  map codes to drop
 * @param {(msg: string) => void} [opts.onWarn]
 */
export async function* eachLibraryRound({
  user = SHARED_LIBRARY,
  limit = 0,
  match = '',
  maps = null,
  skipMaps = null,
  onWarn = null
} = {}) {
  const records = await listDemos(user, { fresh: true });
  let used = 0;

  for (const record of records) {
    if (limit && used >= limit) break;
    // Only demos that finished parsing have round files to read.
    if (record.status && record.status !== 'ready') continue;
    const rounds = Array.isArray(record.rounds) ? record.rounds : [];
    if (!rounds.length) continue;

    const name = record.filename || record.id;
    if (match && !String(name).includes(match)) continue;

    // The map lives on the round meta, not reliably on the record, so the
    // first round is read to find it before deciding whether to skip.
    let firstMeta = null;
    try {
      firstMeta = await readRoundMeta(user, rounds[0].file);
    } catch {
      firstMeta = null;
    }
    // The firewall, said out loud (12.1). `readRoundMeta` already refuses a
    // synthetic round, but that refusal arrives here as an unreadable-round
    // warning, and "training quietly skipped 400 demos" is the failure this
    // walk is least able to notice. Name it instead.
    if (isSynthetic(firstMeta)) {
      onWarn?.(`${name}: synthetic, not ingested (12.1)`);
      continue;
    }

    const map = firstMeta?.map || record.map || '';
    if (!map) continue;
    if (maps?.length && !maps.includes(map)) continue;
    if (skipMaps?.length && skipMaps.includes(map)) continue;

    used++;
    const pkg = { name: String(name), map, rounds, id: record.id };

    for (const entry of rounds) {
      let meta = null;
      let track = null;
      try {
        meta = entry.file === rounds[0].file ? firstMeta : await readRoundMeta(user, entry.file);
        if (!meta) continue;
        const buf = await readRoundTicks(user, entry.file, 1);
        if (!buf) continue;
        track = new TickTrack(buf);
      } catch (err) {
        // One unreadable round must not abandon a whole library walk; the
        // corpus is large and partial coverage is far better than none.
        onWarn?.(`${name} ${entry.file}: ${err.message}`);
        continue;
      }
      yield { pkg, entry, meta, track };
    }
  }
}

/** How many ready demos the library holds, for progress reporting. */
export async function countLibraryDemos({ user = SHARED_LIBRARY } = {}) {
  const records = await listDemos(user, { fresh: true });
  return records.filter(
    (r) => (!r.status || r.status === 'ready') && Array.isArray(r.rounds) && r.rounds.length
  ).length;
}
