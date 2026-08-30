// ---------------------------------------------------------------------------
// replays/teamRescan.js
// The admin's "re-scan team names" button: analyse the whole library with
// teamIdentity, apply the renames, and leave a teams database behind —
// without the site noticing that any of it happened.
//
// Everything here follows the house contract for library-wide work: the job
// runs DETACHED (the admin request that starts it returns immediately), one
// at a time, yielding the thread between demos, with its position readable at
// any moment. Renames go through the same renameDemoTeams the per-demo admin
// tool uses, so record and round files stay consistent; the stats index is
// then patched in place (patchIndexTeamNames) precisely so the rename does
// NOT invalidate it — a mass rebuild of thousands of indexes is the one cost
// this job must never trigger. The hot store is invalidated once at the end
// and rebuilds in the background behind its own 503-and-fallback contract.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildTeamIdentity, findRenameTargets } from './teamIdentity.js';
import { renameDemoTeams, invalidateDemoList, listDemos } from './demoStore.js';
import { patchIndexTeamNames } from './statsIndex.js';
import { invalidateHotStore, patchHotStoreTeamNames } from './statsHotService.js';
import { invalidatePeerAverages } from './peerAverages.js';
import { invalidateRoster } from './rosterCatalogue.js';

/** Where the teams database lands: next to the library it describes. */
const STORE_FILE = 'teamIdentity.json';

/**
 * Ceiling on how many extra demos ONE hand-rename may carry with it.
 *
 * A three-man core is a generous match, and a core of stand-ins can appear in
 * more demos than the admin has any intention of touching. Past this the
 * rename stops at the demo that was actually asked for and says so, rather
 * than quietly rewriting a slice of the library nobody reviewed.
 */
export const RENAME_PROPAGATION_LIMIT = 200;

const state = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  phase: '',            // 'analyze' | 'rename' | ''
  done: 0,
  total: 0,
  error: '',
  summary: null
};

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export function teamRescanStatus() {
  return { ...state };
}

/**
 * One hand-rename, plus every unnamed lineup that shares its core.
 *
 * Naming a side of one demo (My Uploads, the library, or the admin tool)
 * carries that name to every other side the parser labelled after a player,
 * so a Bo3 that defaulted to jcobbb / neityu / jboen becomes FaZe on all
 * three maps. Public demos are included when their stored name is still a
 * placeholder. A side that already has a real name is left alone.
 *
 * Targets are taken from the listing we already hold, not a second library
 * read: the seed write would otherwise force a full rescan of every record.
 *
 * @returns {{ record: object|null, alsoRenamed: number, capped: boolean, others: object[] }}
 */
export async function applyTeamRename(io, user, demoId, team1, team2) {
  const empty = { record: null, alsoRenamed: 0, capped: false, others: [] };
  const records = await listDemos(user);
  const before = records.find((r) => r.id === demoId);
  if (!before) return empty;

  const wanted = {
    1: String(team1 ?? before.team1?.name ?? '').trim(),
    2: String(team2 ?? before.team2?.name ?? '').trim()
  };
  const record = await renameDemoTeams(user, demoId, wanted[1], wanted[2]);
  if (!record) return empty;
  await patchIndexTeamNames(io, user, record);

  // Only a side whose name actually MOVED propagates. Re-saving the dialog
  // unchanged must not sweep the library.
  /** @type {Map<string, { 1?: string, 2?: string }>} */
  const edits = new Map();
  let capped = false;
  for (const side of [1, 2]) {
    const nextName = side === 1 ? record.team1?.name : record.team2?.name;
    const prevName = side === 1 ? before.team1?.name : before.team2?.name;
    if (!nextName || nextName === prevName) continue;
    const targets = findRenameTargets(records, demoId, side);
    if (targets.length > RENAME_PROPAGATION_LIMIT) {
      capped = true;
      continue;
    }
    for (const t of targets) {
      const bag = edits.get(t.demoId) || {};
      bag[t.side] = nextName;
      edits.set(t.demoId, bag);
    }
  }
  edits.delete(demoId);

  const byId = new Map(records.map((r) => [r.id, r]));
  const touched = [record];
  for (const [id, sides] of edits) {
    const rec = byId.get(id);
    try {
      const renamed = await renameDemoTeams(
        user,
        id,
        sides[1] ?? rec?.team1?.name,
        sides[2] ?? rec?.team2?.name
      );
      if (renamed) {
        await patchIndexTeamNames(io, user, renamed);
        touched.push(renamed);
      }
    } catch (err) {
      console.warn(`[teams] rename propagation skipped ${id}: ${err?.message || err}`);
    }
    await yieldEventLoop();
  }

  invalidateDemoList(user);
  invalidateRoster(user);
  invalidatePeerAverages();
  const patched = patchHotStoreTeamNames(io, user, touched);
  if (patched < touched.length) invalidateHotStore();

  const others = touched.slice(1).map((r) => ({
    id: r.id,
    team1: r.team1,
    team2: r.team2
  }));
  return { record, alsoRenamed: others.length, capped, others };
}

/** The stored teams database, or null before the first rescan. */
export async function readTeamIdentityStore(io, user) {
  try {
    const file = path.join(io.userDir(user), STORE_FILE);
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Start a rescan. Returns false when one is already running.
 * The heavy work happens after this resolves; poll teamRescanStatus().
 */
export function startTeamRescan(io, user) {
  if (state.running) return false;
  state.running = true;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.phase = 'analyze';
  state.done = 0;
  state.total = 0;
  state.error = '';
  state.summary = null;

  (async () => {
    const records = (await listDemos(user)).filter((r) => (r.status || 'ready') === 'ready');
    state.total = records.length;

    // Analysis is pure CPU over data already in memory; a few thousand demos
    // take well under a second, but the thread is handed back around it anyway.
    await yieldEventLoop();
    const identity = buildTeamIdentity(records);
    await yieldEventLoop();

    // Renames. Each one rewrites the record and its round metas (that is the
    // existing renameDemoTeams contract), then patches the stats index in
    // place. One demo at a time, one yield each: this is IO-bound work that
    // must stay invisible next to live requests.
    state.phase = 'rename';
    state.total = Object.keys(identity.renames).length;
    state.done = 0;
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const [demoId, names] of Object.entries(identity.renames)) {
      const rec = byId.get(demoId);
      try {
        const renamed = await renameDemoTeams(
          user,
          demoId,
          names.team1 ?? rec?.team1?.name,
          names.team2 ?? rec?.team2?.name
        );
        if (renamed) await patchIndexTeamNames(io, user, renamed);
      } catch (err) {
        console.warn(`[teams] rescan skipped ${demoId}: ${err?.message || err}`);
      }
      state.done += 1;
      await yieldEventLoop();
    }

    // The teams database, for lookups and for the admin's own reading.
    const store = {
      v: 1,
      builtAt: Date.now(),
      summary: identity.summary,
      teams: identity.teams
        .filter((t) => t.demos.length > 0)
        .sort((a, b) => b.demos.length - a.demos.length)
    };
    const file = path.join(io.userDir(user), STORE_FILE);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(store));
    await fsp.rename(tmp, file);

    // Everything that holds team names is brought current, once, at the end.
    // The resident store is PATCHED rather than dropped: the names are the one
    // thing not in its packed columns, so a rebuild would be minutes of CPU to
    // change a few strings. If it turns out not to hold these demos (cold, or
    // built from a different record set), fall back to invalidating it.
    invalidateDemoList(user);
    invalidateRoster(user);
    invalidatePeerAverages();
    const renamedRecords = (await listDemos(user, { fresh: true })).filter((r) =>
      Object.prototype.hasOwnProperty.call(identity.renames, r.id)
    );
    const patched = patchHotStoreTeamNames(io, user, renamedRecords);
    if (patched < renamedRecords.length) invalidateHotStore();

    state.summary = { ...identity.summary, teams: store.teams.length };
    console.log(
      `[teams] rescan done: ${identity.summary.renamedDemos} demos renamed, ` +
        `${store.teams.length} teams identified`
    );
  })()
    .catch((err) => {
      state.error = String(err?.message || err);
      console.error('[teams] rescan failed:', err);
    })
    .finally(() => {
      state.running = false;
      state.phase = '';
      state.finishedAt = Date.now();
    });

  return true;
}
