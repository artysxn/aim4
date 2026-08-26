// ---------------------------------------------------------------------------
// replays/lineupNames.js
// Name a new demo after the teams the library already knows.
//
// The parser labels a side after its clan tag, and when the demo carries none,
// after whichever player happens to be first (laihoe.js teamNameFor). Two
// things used to fix that label, and between them they left a gap:
//
//   * the Valve standings (teamStandingsDb.applyStandingsToDemo) name a side
//     whose handles match a VRS roster — so only teams in the VRS tables;
//   * the admin re-scan (teamRescan.js) knows the whole library, but runs when
//     somebody presses the button.
//
// Everything else — a team that is real, already named in the library, and not
// in the standings — came in labelled "s1mple" again and stayed that way until
// the next rescan.
//
// So: at ingest, a side the demo did not name takes the name of any library
// lineup it shares FOUR OF FIVE players with. That is the threshold the rescan
// already uses for an unnamed lineup (teamIdentity.UNNAMED_MERGE_SHARED) — one
// squad with a stand-in — for the same reason: a side nobody named has no name
// claim of its own to defend. A side the demo DID name is left alone; that name
// belongs to whoever owns it.
//
// Timing is the whole point of doing this at ingest rather than afterwards.
// materializeDemo bakes shortIdFor(team name) into every round FILENAME, and
// that id is what the round filters read (roundId.js). A rename after ingest
// fixes the display name and leaves the rounds filed under a hash of a
// player's handle — the demo then displays right and filters wrong. See
// ingest/hltv/teamNames.js for the same argument at length.
// ---------------------------------------------------------------------------

import { shortIdFor } from '../../src/replays/shared/roundId.js';
import { isPlaceholderName, normName, UNNAMED_MERGE_SHARED } from './teamIdentity.js';
import { listDemoLineups, listDemos } from './demoStore.js';
import { applyResolvedTeamsToRecord } from './teamStandingsDb.js';

/**
 * Players a new side must share with a named library lineup to take its name.
 *
 * Four of five: one stand-in, one absence, one late roster move. Deliberately
 * the rescan's own constant rather than a second number that can drift from it.
 */
export const LINEUP_SHARED_MIN = UNNAMED_MERGE_SHARED;

/**
 * Everything one player answers to across records.
 *
 * The steam id is the real identity; the short id is a three-character hash of
 * it, and old manifests (and local packages) may carry only the short one. Both
 * are indexed so a lineup still matches across records that disagree on which
 * they stamped.
 */
function playerKeys(p) {
  const keys = [];
  const steam = String(p?.steamId || '').trim();
  if (steam) keys.push(`s:${steam}`);
  const id = String(p?.id || '').trim();
  if (id) keys.push(`i:${id}`);
  return keys;
}

/** The side-`side` players of a roster. */
function sideOf(players, side) {
  return (Array.isArray(players) ? players : []).filter(
    (p) => (p?.team === 2 ? 2 : 1) === side
  );
}

/**
 * The named lineups of a library, ready to be matched against.
 *
 * A lineup the demos never named ("Team 1", or a player's own handle) is left
 * out: it has no name to lend.
 *
 * @param {object[]} records   from listDemoLineups (or full demo records)
 * @param {{ skipDemoId?: string }} [opts]
 */
export function buildLineupIndex(records, opts = {}) {
  const skip = String(opts.skipDemoId || '');
  const lineups = [];
  for (const r of records || []) {
    if (!r) continue;
    if (skip && String(r.id || '') === skip) continue;
    // Whatever the caller handed over — a projection or whole records — a demo
    // that has not finished parsing has no roster worth matching.
    if (r.status && r.status !== 'ready') continue;
    for (const side of [1, 2]) {
      const sidePlayers = sideOf(r.players, side);
      if (sidePlayers.length < LINEUP_SHARED_MIN) continue;
      const name = String((side === 1 ? r.team1 : r.team2)?.name || '').trim();
      if (!name || isPlaceholderName(name, sidePlayers)) continue;
      const keys = new Set();
      for (const p of sidePlayers) for (const k of playerKeys(p)) keys.add(k);
      if (!keys.size) continue;
      lineups.push({
        name,
        norm: normName(name),
        at: Number(r.uploadedAt) || 0,
        demoId: String(r.id || ''),
        keys
      });
    }
  }
  return lineups;
}

/**
 * Best library lineup for each side of a roster, by shared players.
 *
 * @param {object[]} players  roster: [{ id, name, steamId, team }]
 * @param {object[]} lineups  from buildLineupIndex
 * @param {{ minShared?: number, keep?: {1?: string, 2?: string} }} [opts]
 *   keep — the names the demo already carries, so a match can never name a
 *   side after the team standing opposite it.
 * @returns {{ 1: object|null, 2: object|null }} hit = { name, norm, shared, at, demoId }
 */
export function resolveLineupNames(players, lineups, opts = {}) {
  const minShared = opts.minShared ?? LINEUP_SHARED_MIN;
  /** @type {{1: object|null, 2: object|null}} */
  const best = { 1: null, 2: null };

  for (const side of [1, 2]) {
    const sidePlayers = sideOf(players, side);
    if (sidePlayers.length < minShared) continue;
    const keys = sidePlayers.map(playerKeys);
    let hit = null;
    for (const lineup of lineups || []) {
      let shared = 0;
      for (const ks of keys) if (ks.some((k) => lineup.keys.has(k))) shared += 1;
      if (shared < minShared) continue;
      // Most shared players wins. On a tie the most recently uploaded name
      // does, the same way the rescan lets an organisation's current name beat
      // its own history.
      if (!hit || shared > hit.shared || (shared === hit.shared && lineup.at > hit.at)) {
        hit = {
          name: lineup.name,
          norm: lineup.norm,
          shared,
          at: lineup.at,
          demoId: lineup.demoId
        };
      }
    }
    best[side] = hit;
  }

  // Two guards, both against the one way this rule can go badly wrong — a
  // four-man overlap with the lineup on the WRONG side of the match:
  //   * never name a side after the team it is playing;
  //   * never put one name on both sides.
  // Where the evidence cannot tell the two apart, unnamed is the better answer.
  const keep = { 1: normName(opts.keep?.[1] || ''), 2: normName(opts.keep?.[2] || '') };
  for (const side of [1, 2]) {
    const other = side === 1 ? 2 : 1;
    if (best[side]?.norm && best[side].norm === keep[other]) best[side] = null;
  }
  if (best[1] && best[2] && best[1].norm === best[2].norm) {
    if (best[1].shared === best[2].shared) {
      best[1] = null;
      best[2] = null;
    } else if (best[1].shared > best[2].shared) {
      best[2] = null;
    } else {
      best[1] = null;
    }
  }
  return best;
}

/**
 * Library names for the sides of a demo the demo itself did not name.
 *
 * Pure: takes the roster, the two team labels and the lineup index, and says
 * what each side should be called. Applying it is the caller's job, because a
 * parsed demo and a stored record are stamped differently.
 *
 * @returns {{ team1: {id,name}|null, team2: {id,name}|null,
 *             shared: {1: number, 2: number} }}
 */
export function libraryNamesFor(players, team1, team2, lineups, opts = {}) {
  const names = {
    1: String(team1?.name || '').trim(),
    2: String(team2?.name || '').trim()
  };
  const open = {
    1: isPlaceholderName(names[1], sideOf(players, 1)),
    2: isPlaceholderName(names[2], sideOf(players, 2))
  };
  const empty = { team1: null, team2: null, shared: { 1: 0, 2: 0 } };
  if (!open[1] && !open[2]) return empty;

  const hits = resolveLineupNames(players, lineups, { ...opts, keep: names });
  const shared = { 1: 0, 2: 0 };
  const pick = (side) => {
    const hit = open[side] ? hits[side] : null;
    // A name the side already carries is not a rename.
    if (!hit || hit.norm === normName(names[side])) return null;
    shared[side] = hit.shared;
    return { id: shortIdFor(hit.name), name: hit.name };
  };
  return { team1: pick(1), team2: pick(2), shared };
}

/**
 * Index the lineups the library has names for. Never throws — a library that
 * cannot be read is a library that names nothing.
 *
 * `read` is the caller's choice of scan, and the two callers want different
 * ones: the parse worker wants the projection (its heap already holds a demo),
 * a request on the main server wants the record listing everything else there
 * has already cached. `opts.records` short-circuits both, for tests.
 */
async function lineupsFor(user, read, opts = {}) {
  try {
    const records = opts.records || (await read(user));
    return buildLineupIndex(records, opts);
  } catch (err) {
    console.warn(`[teams] lineup index unavailable: ${err?.message || err}`);
    return [];
  }
}

/**
 * Name a freshly parsed demo after the library, in place.
 *
 * Call between the standings pass and materializeDemo: the standings own the
 * teams they know (a VRS org's spelling should stay the VRS spelling), and the
 * round ids have to be built from whatever this leaves behind.
 *
 * Never throws — a demo that cannot be named is still a demo.
 *
 * @param {string} user
 * @param {import('../demoparser/schema.js').NormalizedDemo} demo  mutated
 * @param {{ demoId?: string, minShared?: number }} [opts]
 * @returns {Promise<{ applied: Array<{side: 1|2, name: string, shared: number}> }>}
 */
export async function applyLibraryTeamNames(user, demo, opts = {}) {
  if (!demo) return { applied: [] };
  const players = demo.rounds?.[0]?.players || demo.players || [];
  if (!players.length) return { applied: [] };

  const lineups = await lineupsFor(user, listDemoLineups, {
    ...opts,
    skipDemoId: opts.demoId
  });
  if (!lineups.length) return { applied: [] };

  const resolved = libraryNamesFor(players, demo.team1, demo.team2, lineups, opts);
  const applied = [];
  for (const side of [1, 2]) {
    const key = side === 1 ? 'team1' : 'team2';
    const hit = resolved[key];
    if (!hit) continue;
    demo[key] = { ...(demo[key] || {}), id: hit.id, name: hit.name };
    applied.push({ side, name: hit.name, shared: resolved.shared[side] });
  }
  return { applied };
}

/**
 * The same rule for a demo that arrives already materialized — a local
 * .aim4replay package. Its round ids are baked by the client, so only the
 * display names move (record + round metas), exactly as applyStandingsToRecord
 * and the admin rename already do.
 *
 * @param {string} user
 * @param {object} record                mutated
 * @param {Map<string, Uint8Array>|null} [files]  package entries, stamped too
 */
export async function applyLibraryTeamNamesToRecord(user, record, files = null, opts = {}) {
  if (!record) return { applied: [] };
  const players = Array.isArray(record.players) ? record.players : [];
  if (!players.length) return { applied: [] };

  // A request on the main server, so the cached record listing the rest of
  // the site is already using beats a second walk of the demos directory.
  const lineups = await lineupsFor(user, listDemos, { ...opts, skipDemoId: record.id });
  if (!lineups.length) return { applied: [] };

  const resolved = libraryNamesFor(players, record.team1, record.team2, lineups, opts);
  if (!resolved.team1 && !resolved.team2) return { applied: [] };
  applyResolvedTeamsToRecord(record, resolved, files);

  const applied = [];
  for (const side of [1, 2]) {
    const hit = resolved[side === 1 ? 'team1' : 'team2'];
    if (hit) applied.push({ side, name: hit.name, shared: resolved.shared[side] });
  }
  return { applied };
}
