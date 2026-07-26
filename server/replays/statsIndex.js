// ---------------------------------------------------------------------------
// replays/statsIndex.js
// The stats database.
//
// Round files (.json + .bin ticks) are the source of truth. Each demo is boiled
// down once into a compact index — counters per player per round, plus optional
// zone-presence samples for role assignment. That uses already-parsed round
// files only; demos are never re-parsed for stats or positions.
//
//   server/data/replays/<user>/stats/<demoId>.json
//
// After a successful parse we build the index immediately. Older demos that
// already have a stats index but no position analysis are enriched the next
// time they are loaded (ticks only — still no re-parse).
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, PLAYER_SLOTS } from '../../src/replays/shared/statsMath.js';
import {
  mergePhaseLocations,
  phaseCombatFromMeta
} from '../../src/replays/roles/phaseCombat.js';
import { presenceFromTicks } from '../../src/replays/roles/presenceFromTicks.js';
import { isZoneNetworkReady } from '../../src/replays/zones/zoneModel.js';

export const STATS_VERSION = 3;

/** ~1 Hz occupancy samples (demo ticks between samples). */
const TICK_STRIDE = 64;

/** A death counts as traded when the killer dies inside this window. */
const TRADE_SECONDS = 5;

/** demoId -> { key, entry } for the current process. */
const memory = new Map();

const statsDir = (userDir) => path.join(userDir, 'stats');

/**
 * Base index fingerprint (parse / rename). Zone edits do not invalidate kill
 * stats — they only trigger a positions re-sample via `pz`.
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
function rowFromRound(meta, demoId, file, playerIds, teamOf, presence = null) {
  const kills = meta.events?.kills || [];
  const ordered = [...kills].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  const opening = openingDuel(ordered, teamOf);
  const traded = tradedVictims(ordered, meta.tickRate);
  const victims = new Set(ordered.map((k) => k.victim).filter(Boolean));

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

  const row = {
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
  applyPresence(row, presence);
  applyPhaseBags(row, meta, playerIds, presence);
  return row;
}

function applyPresence(row, presence) {
  if (!presence?.z || !Object.keys(presence.z).length) return;
  row.z = presence.z;
  if (presence.ctTB && Object.keys(presence.ctTB).length) row.ctTB = presence.ctTB;
  else delete row.ctTB;
}

function applyPhaseBags(row, meta, playerIds, presence = null) {
  const combat = phaseCombatFromMeta(meta, playerIds);
  if (presence?.phaseLoc) mergePhaseLocations(combat, presence.phaseLoc);
  row.ph = combat;
}

async function loadZoneNetwork(io, mapCode) {
  if (!mapCode || typeof io.getZones !== 'function') return null;
  try {
    const network = await io.getZones(mapCode);
    if (!isZoneNetworkReady(network)) return null;
    return network;
  } catch {
    return null;
  }
}

/** True when this map has a network and the index is missing / stale positions. */
export function needsPositionAnalysis(entry, network) {
  if (!isZoneNetworkReady(network)) return false;
  const want = Number(network.updatedAt) || 1;
  if (Number(entry?.pz) === want && entry?.positions === true) {
    // Sanity: at least one round should carry zone samples.
    const hasZ = (entry.rounds || []).some((r) => r.z && Object.keys(r.z).length);
    return !hasZ && (entry.rounds || []).length > 0;
  }
  return true;
}

/** Phase bags (combat + dominant locations) missing or on a pre-v3 index. */
function needsPhaseEnrichment(entry) {
  if (!entry?.rounds?.length) return false;
  if (Number(entry.v) < STATS_VERSION) return true;
  return entry.rounds.some((r) => !r.ph || typeof r.ph !== 'object');
}

/**
 * Sample ticks onto an existing index (no re-parse, no kill-stat rebuild).
 * Also fills `row.ph` combat + dominant pos/zone/area when missing.
 */
async function enrichPositions(io, user, record, entry, network) {
  if (!entry?.rounds?.length) {
    entry.positions = false;
    entry.pz = 0;
    return entry;
  }

  const rosterFallback = (entry.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    slot: p.slot
  }));

  const canTicks = Boolean(network && typeof io.readRoundTicks === 'function');

  for (const row of entry.rounds) {
    let meta = null;
    try {
      meta = await io.readRoundMeta(user, row.f);
    } catch {
      meta = null;
    }
    if (!meta) continue;

    const roster =
      meta.players?.length
        ? meta.players.map((p) => ({
            id: p.id,
            name: p.name,
            team: p.team,
            slot: p.slot
          }))
        : rosterFallback;
    const playerIds = roster.map((p) => p.id);

    let presence = null;
    if (canTicks) {
      try {
        const buf = await io.readRoundTicks(user, row.f, TICK_STRIDE);
        presence = buf ? presenceFromTicks(buf, meta, network, roster) : null;
        delete row.z;
        delete row.ctTB;
        applyPresence(row, presence);
      } catch {
        delete row.z;
        delete row.ctTB;
      }
    }

    applyPhaseBags(row, meta, playerIds, presence);
  }

  if (network) {
    entry.positions = (entry.rounds || []).some((r) => r.z && Object.keys(r.z).length);
    entry.pz = Number(network.updatedAt) || 1;
  }
  entry.v = STATS_VERSION;
  return entry;
}

async function persistEntry(io, user, key, entry) {
  memory.set(entry.id, { key, entry });
  try {
    const dir = statsDir(io.userDir(user));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry));
  } catch {
    /* in-memory copy still serves this process */
  }
}

/**
 * Build kill/economy stats from round JSON; sample positions when a zone
 * network exists. Uses parsed files only.
 *
 * @param {object} io  { readRoundMeta, readRoundTicks?, getZones? }
 */
async function buildIndex(io, user, record) {
  const files = (record.rounds || []).map((r) => r.file).filter(Boolean);
  const rounds = [];
  let players = (record.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    slot: p.slot
  }));

  const mapCode = String(record.map || rounds[0]?.m || '').toUpperCase();
  const network = await loadZoneNetwork(io, mapCode);

  for (const file of files) {
    let meta = null;
    try {
      meta = await io.readRoundMeta(user, file);
    } catch {
      meta = null;
    }
    if (!meta) continue;
    if (!players.length && meta.players?.length) {
      players = meta.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        slot: p.slot
      }));
    }
    const roster =
      meta.players?.length
        ? meta.players.map((p) => ({
            id: p.id,
            name: p.name,
            team: p.team,
            slot: p.slot
          }))
        : players;

    let presence = null;
    if (network && typeof io.readRoundTicks === 'function') {
      try {
        const buf = await io.readRoundTicks(user, file, TICK_STRIDE);
        if (buf) presence = presenceFromTicks(buf, meta, network, roster);
      } catch {
        presence = null;
      }
    }

    rounds.push(
      rowFromRound(
        meta,
        record.id,
        file,
        roster.map((p) => p.id),
        new Map(roster.map((p) => [p.id, p.team])),
        presence
      )
    );
  }

  const score = record.score || { team1: 0, team2: 0 };
  const entry = {
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
    rounds,
    positions: false,
    pz: 0
  };

  if (network) {
    entry.positions = rounds.some((r) => r.z && Object.keys(r.z).length);
    entry.pz = Number(network.updatedAt) || 1;
  }

  return entry;
}

async function loadStoredEntry(io, user, demoId) {
  const cached = memory.get(demoId);
  if (cached?.entry) return cached.entry;
  const file = path.join(statsDir(io.userDir(user)), `${demoId}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Ensure the stats index exists and positions are analyzed when possible.
 * Never re-parses a demo — only reads round JSON / tick bins already on disk.
 *
 * @param {object} io  { userDir, readRoundMeta, readRoundTicks?, getZones? }
 */
export async function demoIndex(io, user, record) {
  if (!record || record.status !== 'ready') return null;

  const key = versionKey(record);
  const mapCode = String(record.map || '').toUpperCase();
  const network = await loadZoneNetwork(io, mapCode);

  let entry = await loadStoredEntry(io, user, record.id);

  // Full rebuild when missing or parse/rename fingerprint changed.
  // Legacy keys appended |zoneUpdatedAt after the base fingerprint.
  const keyOk =
    entry &&
    (entry.key === key ||
      (typeof entry.key === 'string' && entry.key.startsWith(`${key}|`)));

  if (!entry || !keyOk) {
    entry = await buildIndex(io, user, record);
    await persistEntry(io, user, key, entry);
    return entry;
  }

  // Normalize key on upgrade from zone-suffixed fingerprints.
  if (entry.key !== key) entry.key = key;

  if (needsPositionAnalysis(entry, network) || needsPhaseEnrichment(entry)) {
    await enrichPositions(io, user, record, entry, network);
    await persistEntry(io, user, key, entry);
    return entry;
  }

  // Map has no zone network yet — mark so we don't keep trying.
  if (!network && entry.positions !== false) {
    entry.positions = false;
    entry.pz = 0;
  }

  memory.set(record.id, { key, entry });
  return entry;
}

/**
 * Fire-and-forget after a successful parse (or import). Safe to call often.
 */
export function scheduleStatsIndex(io, user, record) {
  if (!record || record.status !== 'ready') return;
  demoIndex(io, user, record).catch((err) => {
    console.warn(`[stats] index failed for ${record.id}:`, err?.message || err);
  });
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
