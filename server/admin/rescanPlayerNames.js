// ---------------------------------------------------------------------------
// server/admin/rescanPlayerNames.js
// Merge demo player display names by Steam ID.
//
// Identity is already shortIdFor(steamId) when a steam id is present. What
// drifts is the *name* stamped at first tick sighting per demo: Aquwo in one
// match, aRTYSAN in the next. This job counts names per steam id across the
// library, picks the most-used display name, and rewrites every demo record
// and round meta to that name. Stats are rebuilt afterwards so the Database
// and profiles pick it up.
// ---------------------------------------------------------------------------

import { shortIdFor } from '../../src/replays/shared/roundId.js';
import {
  invalidateDemoList,
  listDemos,
  readRecord,
  readRoundMeta,
  writeRecord,
  writeRoundMeta
} from '../replays/demoStore.js';
import { refreshLibraryStats } from '../replays/statsIndex.js';

function sanitizeStem(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.json(\.zst)?$/i, '');
}

function isSteamId(raw) {
  const s = String(raw || '').trim();
  // SteamID64 is a 17-digit decimal. Reject empties and the sentinel "0".
  return /^[0-9]{15,20}$/.test(s) && s !== '0';
}

/** Pick the name with the highest count; ties break alphabetically. */
export function pickCanonicalName(nameCounts) {
  let best = '';
  let bestCount = -1;
  for (const [label, count] of nameCounts) {
    if (!label) continue;
    if (count > bestCount || (count === bestCount && label.localeCompare(best) < 0)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/**
 * @param {object[]} records  listDemos() rows (must include players with steamId)
 * @returns {Map<string, { nameCounts: Map<string, number>, ids: Set<string>, demos: number }>}
 */
export function buildSteamNameIndex(records) {
  /** @type {Map<string, { nameCounts: Map<string, number>, ids: Set<string>, demos: number }>} */
  const bySteam = new Map();
  for (const record of records || []) {
    if (record?.status && record.status !== 'ready') continue;
    const seen = new Set();
    for (const p of record.players || []) {
      const steam = String(p.steamId || '').trim();
      if (!isSteamId(steam)) continue;
      // One vote per steam id per demo (roster is first-sighting).
      if (seen.has(steam)) continue;
      seen.add(steam);
      let bag = bySteam.get(steam);
      if (!bag) {
        bag = { nameCounts: new Map(), ids: new Set(), demos: 0 };
        bySteam.set(steam, bag);
      }
      bag.demos++;
      const name = String(p.name || '').trim();
      if (name) bag.nameCounts.set(name, (bag.nameCounts.get(name) || 0) + 1);
      if (p.id) bag.ids.add(String(p.id));
    }
  }
  return bySteam;
}

/**
 * @param {Map<string, { nameCounts: Map<string, number>, ids: Set<string>, demos: number }>} bySteam
 * @returns {Map<string, { name: string, id: string, nameCounts: Map<string, number>, demos: number }>}
 */
export function canonicalBySteam(bySteam) {
  /** @type {Map<string, { name: string, id: string, nameCounts: Map<string, number>, demos: number }>} */
  const out = new Map();
  for (const [steam, bag] of bySteam) {
    const name = pickCanonicalName(bag.nameCounts);
    if (!name) continue;
    out.set(steam, {
      name,
      id: shortIdFor(steam),
      nameCounts: bag.nameCounts,
      demos: bag.demos
    });
  }
  return out;
}

/**
 * Align display names to the steam→canonical map.
 *
 * Ids stay put: they are already shortIdFor(steamId) when a steam id is
 * present, and rewriting them without remapping every event key would split
 * the player's stats. Name is what drifts across demos.
 */
function renamePlayerList(players, canonBySteam) {
  if (!Array.isArray(players) || !players.length) return { players: players || [], changed: false };
  let changed = false;
  const next = players.map((p) => {
    const steam = String(p.steamId || '').trim();
    const canon = isSteamId(steam) ? canonBySteam.get(steam) : null;
    if (!canon) return p;
    if (String(p.name || '') === canon.name) return p;
    changed = true;
    return { ...p, name: canon.name };
  });
  return { players: next, changed };
}

function syncTopPlayer(record) {
  if (!record.topPlayer) return false;
  const hit = (record.players || []).find((p) => p.id === record.topPlayer.id);
  if (!hit) return false;
  if (record.topPlayer.name === hit.name && record.topPlayer.id === hit.id) return false;
  record.topPlayer = { ...record.topPlayer, id: hit.id, name: hit.name };
  return true;
}

/**
 * Rewrite one demo's record + round metas to the canonical steam→name map.
 * @returns {Promise<{ demoUpdated: boolean, rounds: number }>}
 */
async function applyDemo(user, record, canonBySteam) {
  let rounds = 0;
  let demoUpdated = false;

  const roster = renamePlayerList(record.players || [], canonBySteam);
  if (roster.changed) {
    record.players = roster.players;
    demoUpdated = true;
  }
  if (syncTopPlayer(record)) demoUpdated = true;

  for (const r of record.rounds || []) {
    if (!r?.file) continue;
    try {
      const meta = await readRoundMeta(user, r.file);
      if (!meta) continue;
      const renamed = renamePlayerList(meta.players || [], canonBySteam);
      if (!renamed.changed) continue;
      meta.players = renamed.players;
      await writeRoundMeta(user, sanitizeStem(r.file), meta);
      rounds++;
    } catch {
      /* missing round; skip */
    }
  }

  if (demoUpdated) await writeRecord(user, record);
  return { demoUpdated, rounds };
}

/**
 * Full library pass: scan → rewrite → rebuild stats.
 *
 * @param {object} io  stats Io { userDir, readRoundMeta, readRoundTicks, getZones, getCoachUtilities }
 * @param {string} user  library key (SHARED_LIBRARY)
 * @param {object[]} records
 * @param {{ onProgress?: (p: object) => void }} [opts]
 */
export async function rescanPlayerNames(io, user, records, { onProgress = null } = {}) {
  const ready = (records || []).filter((r) => !r.status || r.status === 'ready');
  const bySteam = buildSteamNameIndex(ready);
  const canon = canonicalBySteam(bySteam);

  const renamePreview = [];
  for (const [steam, bag] of bySteam) {
    const c = canon.get(steam);
    if (!c) continue;
    const aliases = [...bag.nameCounts.entries()]
      .filter(([n]) => n !== c.name)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!aliases.length) continue;
    renamePreview.push({
      steamId: steam,
      id: c.id,
      name: c.name,
      demos: bag.demos,
      aliases: aliases.map(([name, count]) => ({ name, count })),
      counts: Object.fromEntries(bag.nameCounts)
    });
  }
  renamePreview.sort((a, b) => b.demos - a.demos || a.name.localeCompare(b.name));

  let demosUpdated = 0;
  let roundsUpdated = 0;
  const errors = [];

  for (let i = 0; i < ready.length; i++) {
    const rec = ready[i];
    onProgress?.({
      phase: 'rewrite',
      done: i,
      total: ready.length,
      percent: ready.length ? Math.round((i / ready.length) * 70) : 0,
      current: rec.filename || rec.id
    });
    try {
      const full = (await readRecord(user, rec.id)) || rec;
      const result = await applyDemo(user, full, canon);
      if (result.demoUpdated) demosUpdated++;
      roundsUpdated += result.rounds;
    } catch (err) {
      errors.push({ id: rec.id, filename: rec.filename, error: err?.message || String(err) });
    }
  }

  invalidateDemoList(user);

  onProgress?.({
    phase: 'stats',
    done: ready.length,
    total: ready.length,
    percent: 70,
    current: 'Rebuilding statistics…'
  });

  const fresh = await listDemos(user, { fresh: true });
  const statsReport = await refreshLibraryStats(io, user, fresh, {
    force: true,
    onProgress: (p) => {
      onProgress?.({
        phase: 'stats',
        done: p.done,
        total: p.total,
        percent: 70 + Math.round((p.percent || 0) * 0.3),
        current: p.current
      });
    }
  });

  onProgress?.({
    phase: 'done',
    done: ready.length,
    total: ready.length,
    percent: 100,
    current: null
  });

  return {
    ready: ready.length,
    steamIds: bySteam.size,
    withAliases: renamePreview.length,
    demosUpdated,
    roundsUpdated,
    renames: renamePreview.slice(0, 40),
    failed: errors.length,
    errors: errors.slice(0, 20),
    stats: {
      built: statsReport.built,
      enriched: statsReport.enriched,
      current: statsReport.current,
      failed: statsReport.failed
    }
  };
}
