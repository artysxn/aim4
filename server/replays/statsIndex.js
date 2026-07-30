// ---------------------------------------------------------------------------
// replays/statsIndex.js
// The stats database.
//
// Round files (.json + .bin ticks) are the source of truth. Each demo is boiled
// down once into a compact index — counters per player per round. Geography
// stamping (painted positions / region bags) was removed; Analytics filters via
// user-drawn shapes at query time instead.
//
// AWP Acc is recalculated here from shot angles + smoke geometry (≤10° on an
// enemy, clear path) — not taken raw from the parser.
//
//   server/data/replays/<user>/stats/<demoId>.json
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { P, PLAYER_SLOTS } from '../../src/replays/shared/statsMath.js';
import { awpAccuracyFromTicks } from '../../src/replays/shared/awpAccuracy.js';
import { phaseCombatFromMeta } from '../../src/replays/roles/phaseCombat.js';
import {
  averagePossessionOverRound,
  enrichPrwAndSwing
} from '../../src/replays/stats/prwEnrich.js';
import { TickTrack } from '../../src/replays/tickStore.js';
import {
  buildZonePresence,
  hasControlField,
  prepareControlField,
  registerRadarMask
} from '../../src/replays/zones/zoneOverlay.js';
import { loadRadarMask } from '../../scripts/lib/radarMask.mjs';

export const STATS_VERSION = 9;

/** A death counts as traded when the killer dies inside this window. */
const TRADE_SECONDS = 5;

/** demoId -> { key, entry } for the current process. */
const memory = new Map();

const statsDir = (userDir) => path.join(userDir, 'stats');

/**
 * Base index fingerprint (parse / rename). Zone edits do not invalidate kill
 * stats.
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
function rowFromRound(meta, demoId, file, playerIds, teamOf, tickBuffer = null) {
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

  const awpAcc = tickBuffer ? awpAccuracyFromTicks(meta, tickBuffer) : null;

  const p = {};
  for (const id of playerIds) {
    const st = meta.stats?.[id] || {};
    const kills0 = st.kills || 0;
    const assists0 = st.assists || 0;
    const deaths0 = st.deaths || 0;
    const survived = !victims.has(id);
    const kast = kills0 > 0 || assists0 > 0 || survived || traded.has(id);
    const awp = awpAcc?.get(id);

    const line = new Array(PLAYER_SLOTS).fill(0);
    line[P.KILLS] = kills0;
    line[P.DEATHS] = deaths0;
    line[P.ASSISTS] = assists0;
    line[P.DAMAGE] = Math.round(st.damage || 0);
    if (st.hits !== undefined) {
      line[P.SHOTS] = st.gunShots ?? shotsByPlayer.get(id) ?? 0;
      line[P.HITS] = st.hits || 0;
      line[P.HEADSHOTS] = st.headshots || 0;
      line[P.AWP_SHOTS] = awp ? awp.shots : st.awpShots || 0;
      line[P.AWP_HITS] = awp ? awp.hits : st.awpHits || 0;
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
  applyPhaseBags(row, meta, playerIds, tickBuffer);
  applyPrwFields(row, meta);
  return row;
}

function applyPrwFields(row, meta) {
  const { prw1, prw2, sw } = enrichPrwAndSwing(meta);
  row.prw1 = prw1;
  row.prw2 = prw2;
  row.sw = sw;
  if (row.pos1 === undefined) row.pos1 = null;
  if (row.pos2 === undefined) row.pos2 = null;
}

function applyPhaseBags(row, meta, playerIds, tickBuffer = null) {
  row.ph = phaseCombatFromMeta(meta, playerIds, tickBuffer);
  // Drop legacy painted location fields if any sneak in.
  for (const bag of Object.values(row.ph || {})) {
    for (const phase of ['early', 'mid', 'late']) {
      if (!bag?.[phase]) continue;
      delete bag[phase].pos;
      delete bag[phase].zone;
      delete bag[phase].area;
    }
  }
}

/** Phase bags / AWP Acc / PRW missing or on a pre-v9 index. */
function needsPhaseEnrichment(entry) {
  if (!entry?.rounds?.length) return false;
  if (Number(entry.v) < STATS_VERSION) return true;
  return entry.rounds.some(
    (r) =>
      !r.ph ||
      typeof r.ph !== 'object' ||
      r.prw1 === undefined ||
      r.sw === undefined
  );
}

/** Cache radar + zones per map while indexing one demo. */
async function ensureMapControl(io, mapCode, cache) {
  if (!mapCode) return null;
  if (cache.has(mapCode)) return cache.get(mapCode);
  let network = null;
  try {
    network = typeof io.getZones === 'function' ? await io.getZones(mapCode) : null;
  } catch {
    network = null;
  }
  if (!network) {
    network = {
      map: mapCode,
      visionBlocks: [],
      elevated: [],
      underpasses: [],
      ledges: [],
      bombSites: { a: null, b: null }
    };
  }
  try {
    const mask = await loadRadarMask(mapCode);
    if (mask) registerRadarMask(mapCode, mask);
  } catch {
    /* possession stays null without a walkable mask */
  }
  prepareControlField(network, mapCode, null);
  const ready = hasControlField(network) ? network : null;
  cache.set(mapCode, ready);
  return ready;
}

async function applyPossessionFields(row, meta, track, network) {
  row.pos1 = null;
  row.pos2 = null;
  if (!network || !track || !meta) return;
  const presence = buildZonePresence({
    meta,
    track,
    network,
    mapCode: meta.map || row.m || ''
  });
  if (!presence) return;
  const { pos1, pos2 } = averagePossessionOverRound({
    meta,
    track,
    network,
    presence
  });
  row.pos1 = pos1;
  row.pos2 = pos2;
}

/**
 * Refresh phase combat + AWP Acc from ticks (no painted geography).
 */
async function enrichPhases(io, user, entry) {
  if (!entry?.rounds?.length) return entry;

  const rosterFallback = (entry.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    slot: p.slot
  }));

  const canTicks = typeof io.readRoundTicks === 'function';
  const zoneCache = new Map();

  for (const row of entry.rounds) {
    let meta = null;
    try {
      meta = await io.readRoundMeta(user, row.f);
    } catch {
      meta = null;
    }
    if (!meta) continue;
    meta.map = meta.map || row.m || entry.map || '';

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

    let tickBuffer = null;
    if (canTicks) {
      try {
        // Full-detail ticks for possession sampling; AWP Acc tolerates stride.
        tickBuffer = await io.readRoundTicks(user, row.f, 1);
      } catch {
        tickBuffer = null;
      }
    }

    // Strip legacy geography bags.
    delete row.z;
    delete row.ctTB;

    if (tickBuffer && row.p) {
      const awpAcc = awpAccuracyFromTicks(meta, tickBuffer);
      for (const id of playerIds) {
        const line = row.p[id];
        if (!line) continue;
        const awp = awpAcc.get(id);
        if (awp) {
          line[P.AWP_SHOTS] = awp.shots;
          line[P.AWP_HITS] = awp.hits;
        }
      }
    }

    applyPhaseBags(row, meta, playerIds, tickBuffer);
    applyPrwFields(row, meta);

    if (tickBuffer) {
      const network = await ensureMapControl(io, meta.map || row.m, zoneCache);
      const track = new TickTrack(tickBuffer);
      await applyPossessionFields(row, meta, track, network);
    } else {
      row.pos1 = null;
      row.pos2 = null;
    }
  }

  entry.positions = false;
  entry.pz = 0;
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
 * Build kill/economy stats from round JSON. Uses parsed files only.
 *
 * @param {object} io  { readRoundMeta, readRoundTicks? }
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
  const zoneCache = new Map();

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

    meta.map = meta.map || record.map || '';

    let tickBuffer = null;
    if (typeof io.readRoundTicks === 'function') {
      try {
        tickBuffer = await io.readRoundTicks(user, file, 1);
      } catch {
        tickBuffer = null;
      }
    }

    const row = rowFromRound(
      meta,
      record.id,
      file,
      roster.map((p) => p.id),
      new Map(roster.map((p) => [p.id, p.team])),
      tickBuffer
    );

    if (tickBuffer) {
      const network = await ensureMapControl(io, meta.map || row.m, zoneCache);
      const track = new TickTrack(tickBuffer);
      await applyPossessionFields(row, meta, track, network);
    }

    rounds.push(row);
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
    rounds,
    positions: false,
    pz: 0
  };
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
 * Ensure the stats index exists. Never re-parses a demo — only reads round
 * JSON / tick bins already on disk.
 *
 * @param {object} io  { userDir, readRoundMeta, readRoundTicks? }
 */
export async function demoIndex(io, user, record) {
  if (!record || record.status !== 'ready') return null;

  const key = versionKey(record);
  let entry = await loadStoredEntry(io, user, record.id);

  const keyOk =
    entry &&
    (entry.key === key ||
      (typeof entry.key === 'string' && entry.key.startsWith(`${key}|`)));

  if (!entry || !keyOk) {
    entry = await buildIndex(io, user, record);
    await persistEntry(io, user, key, entry);
    return entry;
  }

  if (entry.key !== key) entry.key = key;

  if (needsPhaseEnrichment(entry)) {
    await enrichPhases(io, user, entry);
    await persistEntry(io, user, key, entry);
    return entry;
  }

  // Clear legacy geography flags on old indexes that already have phase bags.
  if (entry.positions || entry.pz) {
    entry.positions = false;
    entry.pz = 0;
  }

  memory.set(record.id, { key, entry });
  return entry;
}

/**
 * Fire-and-forget after a successful parse (or import). Safe to call often.
 *
 * @param {(err: Error|null) => void} [done] called once the index has landed.
 *   The upload progress bar reports "analyzed" as its own phase, so it needs to
 *   know when this finished rather than only that it started. Failures still
 *   call back: a demo whose stats did not build is watchable, and leaving the
 *   bar stuck at "parsed" forever would be the worse outcome.
 */
export function scheduleStatsIndex(io, user, record, done) {
  if (!record || record.status !== 'ready') {
    done?.(null);
    return;
  }
  demoIndex(io, user, record)
    .then(() => done?.(null))
    .catch((err) => {
      console.warn(`[stats] index failed for ${record.id}:`, err?.message || err);
      done?.(err instanceof Error ? err : new Error(String(err)));
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

/** @deprecated Painted networks are gone — always false. */
export function needsPositionAnalysis(_entry, _network) {
  return false;
}
