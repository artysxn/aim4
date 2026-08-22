// ---------------------------------------------------------------------------
// replays/rosterCatalogue.js
// "Which demos feature this player / team?" — answered without touching a
// single stats index.
//
// This is the piece that made scoping impossible before. Performance, the
// player profile and the team page all want a handful of matches, but the only
// place that knew who played in what was the stats payload itself, so every one
// of them pulled the whole library to find out. The rosters are already on the
// demo records (materialize stamps `record.players`), and listDemos already
// holds every record in memory — so the catalogue is a projection of data the
// process has, not a new store to keep in sync.
//
// Records whose roster is empty (older manifests, imports) are backfilled from
// their stats index once, and only those.
// ---------------------------------------------------------------------------



const CACHE_TTL_MS = 60_000;

/** @type {Map<string, { stamp: string, at: number, value: object }>} */
const cache = new Map();

/**
 * Cheap identity for a record list: adding, removing or reparsing changes it.
 *
 * Deliberately computed over the *whole* library, never a caller's visible
 * subset — see `getRoster`.
 */
function stampOf(records) {
  let newest = 0;
  let ids = 0;
  for (const r of records) {
    const t = Number(r.uploadedAt || r.parsedAt || 0) || 0;
    if (t > newest) newest = t;
    ids += 1;
  }
  return `${ids}:${newest}`;
}

/**
 * Compact catalogue. Player identities are interned so 4100 demos cost a few
 * hundred KB rather than the tens of MB a naive roster-per-demo would.
 *
 * @param {object} io          storage shim (same one statsIndex uses)
 * @param {string} user
 * @param {object[]} records   from listDemos, already filtered to `ready`
 * @param {{ readEntry?: (user: string, id: string) => Promise<object|null> }} [opts]
 */
export async function buildRoster(io, user, records, opts = {}) {
  /** @type {Map<string, number>} playerId → index into `players` */
  const index = new Map();
  /** @type {Array<{ i: string, n: string, c: number }>} */
  const players = [];
  const demos = [];

  const intern = (id, name) => {
    let at = index.get(id);
    if (at === undefined) {
      at = players.length;
      index.set(id, at);
      players.push({ i: id, n: String(name || id), c: 0 });
    }
    const slot = players[at];
    slot.c += 1;
    // Keep the most recent non-empty display name; handles do change.
    if (name && String(name).trim()) slot.n = String(name).trim();
    return at;
  };

  for (const record of records) {
    let roster = Array.isArray(record.players) ? record.players : [];
    let map = record.map || '';
    // A manifest can lack either — statsIndex falls back to the rounds for both
    // (`record.map || rounds[0]?.m`), so the catalogue must too, or a demo with
    // no stamped map would be invisible to anything that scopes by map.
    if ((!roster.length || !map) && typeof opts.readEntry === 'function') {
      // Only the stragglers pay a file read, and only once per cache window.
      try {
        const entry = await opts.readEntry(user, record.id);
        if (!roster.length && Array.isArray(entry?.players)) roster = entry.players;
        if (!map) map = entry?.map || entry?.rounds?.[0]?.m || '';
      } catch {
        /* a record with no resolvable roster or map simply carries none */
      }
    }
    demos.push({
      id: record.id,
      m: map,
      u: Number(record.uploadedAt || record.parsedAt || 0) || 0,
      t1: record.team1?.id || '',
      t2: record.team2?.id || '',
      n1: record.team1?.name || '',
      n2: record.team2?.name || '',
      // Seat list as [playerIndex, team] pairs, flattened.
      p: roster.flatMap((p) => [intern(p.id, p.name), p.team === 2 ? 2 : 1])
    });
  }

  return { v: 1, players, demos, total: demos.length };
}

/**
 * Cached catalogue for one library. Rebuilt when the record set changes or the
 * TTL lapses, so an upload shows up without an explicit invalidation hook.
 *
 * `records` must be the whole library, not the caller's visible subset. Caching
 * a per-caller catalogue under one key went wrong two ways: an admin and a free
 * account alternating would each invalidate the other's stamp and force a
 * rebuild every request, and two callers who happened to see the same *number*
 * of demos would collide on the stamp — serving one of them a catalogue naming
 * demos they may not open. Visibility is applied by `scopeRoster` afterwards.
 */
export async function getRoster(io, user, records, opts = {}) {
  const stamp = stampOf(records);
  const hit = cache.get(user);
  if (hit && hit.stamp === stamp && hit.at > Date.now() - CACHE_TTL_MS) return hit.value;
  const value = await buildRoster(io, user, records, opts);
  cache.set(user, { stamp, at: Date.now(), value });
  return value;
}

/**
 * Narrow a catalogue to the demos one caller may read.
 *
 * Players are re-interned so the response never names someone who only appears
 * in demos this caller cannot open, and the seat indices stay consistent with
 * the trimmed player list.
 *
 * @param {object} roster    full-library catalogue
 * @param {Set<string>|null} allowedIds  null means "everything"
 */
export function scopeRoster(roster, allowedIds) {
  if (!allowedIds) return roster;
  const demos = [];
  /** old player index → new index */
  const remap = new Map();
  const players = [];
  for (const d of roster.demos || []) {
    if (!allowedIds.has(d.id)) continue;
    const p = [];
    for (let i = 0; i < d.p.length; i += 2) {
      const at = d.p[i];
      let next = remap.get(at);
      if (next === undefined) {
        const src = roster.players[at];
        if (!src) continue;
        next = players.length;
        remap.set(at, next);
        players.push({ i: src.i, n: src.n, c: 0 });
      }
      players[next].c += 1;
      p.push(next, d.p[i + 1]);
    }
    demos.push({ ...d, p });
  }
  return { v: roster.v, players, demos, total: demos.length };
}

export function invalidateRoster(user) {
  if (user == null) cache.clear();
  else cache.delete(user);
}

// Query helpers live in shared/rosterQuery.js so the browser and the server
// answer these questions with the same code. Re-exported here for callers that
// already have the catalogue in hand.
export { demosForPlayer, demosForTeam, rosterPlayers, rosterTeams } from '../../src/replays/shared/rosterQuery.js';
