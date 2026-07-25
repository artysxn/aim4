// ---------------------------------------------------------------------------
// replays/statsIndex.js
// The stats database.
//
// Round files are the source of truth but they are far too heavy to read on
// every visit to the stats page: a library is hundreds of files holding every
// kill, shot and grenade of every round. So each demo is boiled down ONCE into
// a compact index — ten numbers per player per round plus a few round facts —
// and every question after that is answered from those numbers.
//
//   server/data/replays/<user>/stats/<demoId>.json
//
// The file is a few kilobytes per demo. It is also held in memory keyed by the
// demo's parse time, so repeat visits touch no disk at all, and a re-parse or
// re-import invalidates it by changing that key.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, PLAYER_SLOTS } from '../../src/replays/shared/statsMath.js';

export const STATS_VERSION = 1;

/** A death counts as traded when the killer dies inside this window. */
const TRADE_SECONDS = 5;

/** demoId -> { key, entry } for the current process. */
const memory = new Map();

const statsDir = (userDir) => path.join(userDir, 'stats');

/**
 * Everything that makes an index stale, in one string: a re-parse, a re-import
 * or a team rename all move it.
 */
function versionKey(record) {
  return [
    STATS_VERSION,
    record.parsedAt || 0,
    record.uploadedAt || 0,
    record.roundCount || 0,
    record.team1?.name || '',
    record.team2?.name || ''
  ].join('|');
}

/**
 * Which rounds a player's death was avenged in. Returns the set of player ids
 * whose death that round was traded.
 *
 * ropz dies to s1mple, then ZywOo kills s1mple inside the window: ropz's death
 * was traded, and it counts toward his KAST even though he did nothing else.
 */
function tradedVictims(kills, tickRate) {
  const window = TRADE_SECONDS * (tickRate || 64);
  const traded = new Set();
  for (const k of kills) {
    if (!k.attacker || !k.victim) continue;
    const avenged = kills.some(
      (other) =>
        other.victim === k.attacker && other.tick > k.tick && other.tick - k.tick <= window
    );
    if (avenged) traded.add(k.victim);
  }
  return traded;
}

const NOT_A_GUN =
  /grenade|molotov|incgrenade|firebomb|inferno|decoy|flash|knife|bayonet|karambit|c4|world|taser|zeus/i;

const isGun = (weapon) => {
  const w = String(weapon || '').trim().toLowerCase().replace(/^weapon_/, '');
  return Boolean(w) && !NOT_A_GUN.test(w);
};

/**
 * The first genuine duel of the round: the earliest kill where one side killed
 * the other. A teamkill, a bomb death or a fall is the first death of some
 * rounds and is nobody's opening kill, so those are skipped rather than handed
 * to whichever team happened to own the body.
 */
function openingDuel(ordered, teamOf) {
  for (const k of ordered) {
    const at = teamOf.get(k.attacker);
    const vt = teamOf.get(k.victim);
    if (!at || !vt || at === vt) continue;
    return { ok: k.attacker, od: k.victim };
  }
  return { ok: '', od: '' };
}

/** One round of a demo -> one compact row. */
function rowFromRound(meta, demoId, file, playerIds, teamOf) {
  const kills = meta.events?.kills || [];
  const ordered = [...kills].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  const opening = openingDuel(ordered, teamOf);
  const traded = tradedVictims(ordered, meta.tickRate);
  const victims = new Set(ordered.map((k) => k.victim).filter(Boolean));

  // Shots are only in the round file for demos parsed before hit counts
  // existed; when the parser supplied them, its numbers win.
  const shotsByPlayer = new Map();
  for (const s of meta.events?.shots || []) {
    if (!s.player || !isGun(s.weapon)) continue;
    shotsByPlayer.set(s.player, (shotsByPlayer.get(s.player) || 0) + 1);
  }

  const p = {};
  for (const id of playerIds) {
    const st = meta.stats?.[id] || {};
    const kills0 = st.kills || 0;
    const assists0 = st.assists || 0;
    const deaths0 = st.deaths || 0;
    const survived = !victims.has(id);
    const kast = kills0 > 0 || assists0 > 0 || survived || traded.has(id);

    const line = new Array(PLAYER_SLOTS).fill(0);
    line[P.KILLS] = kills0;
    line[P.DEATHS] = deaths0;
    line[P.ASSISTS] = assists0;
    line[P.DAMAGE] = Math.round(st.damage || 0);
    // Accuracy is all-or-nothing per round: a round with no hit counts
    // contributes nothing to it rather than reading as 0% accuracy.
    if (st.hits !== undefined) {
      line[P.SHOTS] = st.gunShots ?? shotsByPlayer.get(id) ?? 0;
      line[P.HITS] = st.hits || 0;
      line[P.HEADSHOTS] = st.headshots || 0;
      line[P.AWP_SHOTS] = st.awpShots || 0;
      line[P.AWP_HITS] = st.awpHits || 0;
    }
    line[P.KAST] = kast ? 1 : 0;
    p[id] = line;
  }

  return {
    f: file,
    d: demoId,
    m: meta.map || '',
    n: meta.round || 0,
    w: meta.winner === 2 ? 2 : 1,
    s1: meta.team1Side || 'T',
    s2: meta.team2Side || 'CT',
    e1: meta.econ1 ?? 0,
    e2: meta.econ2 ?? 0,
    ok: opening.ok,
    od: opening.od,
    p
  };
}

/**
 * Read a demo's rounds and boil them down. This is the only place round files
 * are opened for stats, and it happens once per demo per parse.
 */
async function buildIndex(readRoundMeta, user, record) {
  const files = (record.rounds || []).map((r) => r.file).filter(Boolean);
  const rounds = [];
  let players = (record.players || []).map((p) => ({ id: p.id, name: p.name, team: p.team }));

  for (const file of files) {
    let meta = null;
    try {
      meta = await readRoundMeta(user, file);
    } catch {
      meta = null;
    }
    if (!meta) continue;
    if (!players.length && meta.players?.length) {
      players = meta.players.map((p) => ({ id: p.id, name: p.name, team: p.team }));
    }
    rounds.push(
      rowFromRound(
        meta,
        record.id,
        file,
        players.map((p) => p.id),
        new Map(players.map((p) => [p.id, p.team]))
      )
    );
  }

  const score = record.score || { team1: 0, team2: 0 };
  return {
    id: record.id,
    v: STATS_VERSION,
    key: versionKey(record),
    map: record.map || rounds[0]?.m || '',
    mapName: record.mapName || '',
    t1: record.team1?.id || '',
    t2: record.team2?.id || '',
    name1: record.team1?.name || 'Team 1',
    name2: record.team2?.name || 'Team 2',
    winner: score.team1 === score.team2 ? 0 : score.team1 > score.team2 ? 1 : 2,
    uploadedAt: record.uploadedAt || record.parsedAt || 0,
    players,
    rounds
  };
}

/**
 * The index for one demo, from memory, then disk, then built from scratch.
 *
 * @param {object} io  { userDir, readRoundMeta }
 */
export async function demoIndex(io, user, record) {
  if (!record || record.status !== 'ready') return null;
  const key = versionKey(record);
  const cached = memory.get(record.id);
  if (cached && cached.key === key) return cached.entry;

  const dir = statsDir(io.userDir(user));
  const file = path.join(dir, `${record.id}.json`);
  try {
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (onDisk.key === key) {
      memory.set(record.id, { key, entry: onDisk });
      return onDisk;
    }
  } catch {
    /* not indexed yet, or the file is unreadable; rebuild below */
  }

  const entry = await buildIndex(io.readRoundMeta, user, record);
  memory.set(record.id, { key, entry });
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(entry));
  } catch {
    /* cache write failed; the in-memory copy still serves this process */
  }
  return entry;
}

/**
 * Indexes for a whole library (or a subset of it).
 *
 * @returns {Promise<{demos: object[]}>}
 */
export async function statsPayload(io, user, records, demoIds = null) {
  const wanted = demoIds?.length ? new Set(demoIds) : null;
  const demos = [];
  for (const record of records) {
    if (wanted && !wanted.has(record.id)) continue;
    const entry = await demoIndex(io, user, record);
    if (entry) demos.push(entry);
  }
  return { demos };
}

/** Drop a demo's index when the demo goes. */
export async function forgetDemoIndex(io, user, demoId) {
  memory.delete(demoId);
  try {
    await fsp.rm(path.join(statsDir(io.userDir(user)), `${demoId}.json`), { force: true });
  } catch {
    /* nothing cached */
  }
}
