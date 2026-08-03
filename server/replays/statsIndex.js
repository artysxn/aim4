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
import { aimFromRound } from '../../src/replays/shared/aimMetrics.js';
import { utilityFromRound } from '../../src/replays/shared/utilityMetrics.js';
import { phaseCombatFromMeta } from '../../src/replays/roles/phaseCombat.js';
import {
  averagePossessionOverRound,
  enrichPrwAndSwing
} from '../../src/replays/stats/prwEnrich.js';
import { TickTrack } from '../../src/replays/tickStore.js';
import { timingFor } from '../../src/replays/viewer/roundClock.js';
import {
  buildZonePresence,
  hasControlField,
  prepareControlField,
  registerRadarMask
} from '../../src/replays/zones/zoneOverlay.js';
import { loadRadarMask } from '../../scripts/lib/radarMask.mjs';
import { hasBombSites } from '../../src/replays/zones/bombSites.js';
import { hasKeyZones } from '../../src/replays/zones/keyZones.js';
import { getVisionLayerTests } from '../../src/replays/zones/visionLayers.js';
import {
  accumulateRoundRoles,
  createRoleWork,
  finalizeRoles,
  ROLES_VERSION
} from '../../src/replays/roles/computeRoles.js';
import { applyMovementFields } from '../../src/replays/roles/movementFromTicks.js';

// v12 adds overflick / underflick counters on first-bullet misses (row.am).
// Bumping this rebuilds every index from the round files already on disk; it
// does NOT reparse demos.
export const STATS_VERSION = 12;

/** A death counts as traded when the killer dies inside this window. */
const TRADE_SECONDS = 5;

/** demoId -> { key, entry } for the current process. */
const memory = new Map();

/** demoIds currently computing roles in the background. */
const roleJobs = new Set();

const statsDir = (userDir) => path.join(userDir, 'stats');

/** Demo identity part of the index key (ignores STATS_VERSION prefix). */
function recordFingerprint(record) {
  return [
    record.parsedAt || 0,
    record.uploadedAt || 0,
    record.roundCount || 0,
    record.team1?.name || '',
    record.team2?.name || ''
  ].join('|');
}

/**
 * Base index fingerprint (parse / rename). Zone edits do not invalidate kill
 * stats.
 */
function versionKey(record) {
  return `${STATS_VERSION}|${recordFingerprint(record)}`;
}

/** True when the stored key is for the same demo bytes / rename, any stats ver. */
function keyMatchesRecord(entryKey, record) {
  if (typeof entryKey !== 'string' || !record) return false;
  const fp = recordFingerprint(record);
  const pipe = entryKey.indexOf('|');
  if (pipe < 0) return false;
  const rest = entryKey.slice(pipe + 1);
  // Accept older/newer STATS_VERSION prefixes with the same fingerprint so a
  // roles-only bump never forces a full library rebuild on GET /stats.
  return rest === fp || rest.startsWith(`${fp}|`);
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
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
function rowFromRound(meta, demoId, file, playerIds, teamOf, tickBuffer = null, network = null) {
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
  applyTimingFields(row, meta, playerIds);
  applyAimUtility(row, meta, tickBuffer, network);
  return row;
}

/**
 * Timing + buy detail the chart builder needs: when each kill landed (live
 * seconds after freeze end), what each player spent, and how long the round
 * ran. Kept on the row so a time-in-round chart never reopens a round file.
 */
function applyTimingFields(row, meta, playerIds) {
  const timing = timingFor(meta || {});
  const rate = timing.tickRate || 64;
  const secondsAt = (tick) => Math.round(((tick || 0) - timing.freezeEndTick) / rate * 10) / 10;

  row.dur = Math.max(0, Math.round(((timing.endTick - timing.freezeEndTick) / rate) * 10) / 10);
  row.pt = Number.isFinite(timing.plantTick) && timing.plantTick
    ? Math.max(0, secondsAt(timing.plantTick))
    : null;

  const kills = [...(meta?.events?.kills || [])].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  row.kt = kills
    .filter((k) => k.attacker || k.victim)
    .map((k) => ({
      t: secondsAt(k.tick),
      a: k.attacker || '',
      v: k.victim || '',
      h: k.headshot ? 1 : 0,
      g: isGun(k.weapon) ? 1 : 0,
      w: String(k.weapon || '').toLowerCase().replace(/^weapon_/, '')
    }));

  row.ev = {};
  for (const id of playerIds || []) {
    const value = Number(meta?.stats?.[id]?.equipValue);
    if (Number.isFinite(value) && value >= 0) row.ev[id] = Math.round(value);
  }
}

function applyPrwFields(row, meta) {
  const { prw1, prw2, sw } = enrichPrwAndSwing(meta);
  row.prw1 = prw1;
  row.prw2 = prw2;
  row.sw = sw;
  if (row.pos1 === undefined) row.pos1 = null;
  if (row.pos2 === undefined) row.pos2 = null;
}

/**
 * Aim measurements and utility effectiveness, per player, for this round.
 *
 * Both read only the round meta and its tick buffer, which is why adding these
 * columns is a stats rebuild rather than a demo reparse. Stored as their own
 * per-player bags (like `row.ph`) rather than widened into the fixed-width P
 * line, because they are sums that get divided at query time and the line array
 * is a set of plain counters.
 */
function applyAimUtility(row, meta, tickBuffer, network = null) {
  if (!tickBuffer) {
    row.am = null;
    row.ut = null;
    row.utt = null;
    return;
  }
  // Painted vision blocks let the aim pass tell "could not see" from "missed".
  // Absent (no zone network for this map) it falls back to smoke-only, which is
  // how it behaved before zones were wired in.
  let visionBlockAt = null;
  try {
    if (network && meta.map) visionBlockAt = getVisionLayerTests(network, meta.map).visionBlockAt;
  } catch {
    visionBlockAt = null;
  }
  try {
    row.am = aimFromRound(meta, tickBuffer, { visionBlockAt });
  } catch {
    row.am = null;
  }
  try {
    const { players, teams } = utilityFromRound(meta, tickBuffer);
    row.ut = players;
    // Team totals are kept per round so "utility damage per round" is a real
    // average over rounds played rather than a sum divided by a guess.
    row.utt = { 1: teams[1].utilDamage, 2: teams[2].utilDamage };
  } catch {
    row.ut = null;
    row.utt = null;
  }
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
      r.sw === undefined ||
      !Array.isArray(r.kt) ||
      !r.ev
  );
}

/** Roles missing or on an older role algorithm. */
function needsRoleEnrichment(entry) {
  if (!entry?.rounds?.length) return false;
  if (!entry.roles || entry.roles.v !== ROLES_VERSION) return true;
  return false;
}

/** PSDT / distance-travelled bags missing on any round. */
function needsMovementEnrichment(entry) {
  if (!entry?.rounds?.length) return false;
  return entry.rounds.some((r) => !r.mv || typeof r.mv !== 'object');
}

/** Background tick walk for roles and/or movement metrics. */
function needsTickDerivedEnrichment(entry) {
  return needsRoleEnrichment(entry) || needsMovementEnrichment(entry);
}

/** Load zone network for a map (bombsites + vision). Always returns an object. */
async function loadMapNetwork(io, mapCode) {
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
  return network;
}

/**
 * Cache radar + zones per map while indexing one demo.
 * Returns control-ready network for possession, or null if no field.
 * Also fills `zoneCache` with the raw network (for roles / bombsites).
 */
async function ensureMapControl(io, mapCode, cache, zoneCache = null) {
  if (!mapCode) return null;
  if (zoneCache?.has(mapCode) && cache.has(mapCode)) {
    return cache.get(mapCode);
  }
  const network = await loadMapNetwork(io, mapCode);
  if (zoneCache) zoneCache.set(mapCode, network);
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
 * Refresh phase combat + AWP Acc + possession from ticks (no painted geography).
 * Also fills roles when ticks are already open (same pass).
 */
async function enrichPhases(io, user, entry, { roles = true } = {}) {
  if (!entry?.rounds?.length) return entry;

  const rosterFallback = (entry.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    slot: p.slot
  }));

  const canTicks = typeof io.readRoundTicks === 'function';
  const controlCache = new Map();
  const zoneCache = new Map();
  const roleWork = roles ? createRoleWork() : null;

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
    applyTimingFields(row, meta, playerIds);

    if (tickBuffer) {
      const network = await ensureMapControl(
        io,
        meta.map || row.m,
        controlCache,
        zoneCache
      );
      const track = new TickTrack(tickBuffer);
      await applyPossessionFields(row, meta, track, network);
      applyMovementFields(row, meta, track, roster);
      if (roleWork) {
        const zones = zoneCache.get(meta.map || row.m) || network;
        accumulateRoundRoles(roleWork, {
          meta,
          track,
          row,
          network: zones,
          roster
        });
      }
    } else {
      row.pos1 = null;
      row.pos2 = null;
      row.mv = row.mv || {};
    }
    await yieldEventLoop();
  }

  if (roleWork) {
    const sitesByMap = new Map();
    for (const [map, net] of zoneCache) {
      const bomb = hasBombSites(net);
      sitesByMap.set(map, { bomb, ct: bomb || hasKeyZones(net) });
    }
    entry.roles = finalizeRoles(roleWork, sitesByMap);
  }
  entry.positions = false;
  entry.pz = 0;
  entry.v = STATS_VERSION;
  return entry;
}

/**
 * Background pass: roles + PSDT/DT from ticks. Does not rebuild kill/phase bags.
 */
async function enrichTickDerived(io, user, entry) {
  if (!entry?.rounds?.length) return entry;
  const wantRoles = needsRoleEnrichment(entry);
  const wantMv = needsMovementEnrichment(entry);
  if (!wantRoles && !wantMv) return entry;

  if (typeof io.readRoundTicks !== 'function') {
    if (wantRoles) entry.roles = { v: ROLES_VERSION, maps: {} };
    if (wantMv) {
      for (const row of entry.rounds) row.mv = row.mv || {};
    }
    return entry;
  }

  const rosterFallback = (entry.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    slot: p.slot
  }));
  const zoneCache = new Map();
  const roleWork = wantRoles ? createRoleWork() : null;

  for (const row of entry.rounds) {
    let meta = null;
    try {
      meta = await io.readRoundMeta(user, row.f);
    } catch {
      meta = null;
    }
    if (!meta) {
      if (wantMv) row.mv = row.mv || {};
      await yieldEventLoop();
      continue;
    }
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

    let tickBuffer = null;
    try {
      tickBuffer = await io.readRoundTicks(user, row.f, 1);
    } catch {
      tickBuffer = null;
    }
    if (!tickBuffer) {
      if (wantMv) row.mv = row.mv || {};
      await yieldEventLoop();
      continue;
    }

    const track = new TickTrack(tickBuffer);
    if (wantMv) applyMovementFields(row, meta, track, roster);

    if (roleWork) {
      const mapCode = meta.map || row.m || '';
      if (!zoneCache.has(mapCode)) {
        zoneCache.set(mapCode, await loadMapNetwork(io, mapCode));
      }
      const zones = zoneCache.get(mapCode);
      accumulateRoundRoles(roleWork, { meta, track, row, network: zones, roster });
    }
    await yieldEventLoop();
  }

  if (roleWork) {
    const sitesByMap = new Map();
    for (const [map, net] of zoneCache) {
      const bomb = hasBombSites(net);
      sitesByMap.set(map, { bomb, ct: bomb || hasKeyZones(net) });
    }
    entry.roles = finalizeRoles(roleWork, sitesByMap);
  }
  return entry;
}

/** Fire-and-forget roles + movement so GET /stats never blocks on tick walks. */
function scheduleTickDerivedEnrichment(io, user, record) {
  if (!record?.id || roleJobs.has(record.id)) return;
  roleJobs.add(record.id);
  setImmediate(() => {
    (async () => {
      try {
        const key = versionKey(record);
        let entry = await loadStoredEntry(io, user, record.id);
        if (!entry || !keyMatchesRecord(entry.key, record)) return;
        if (!needsTickDerivedEnrichment(entry)) return;
        await enrichTickDerived(io, user, entry);
        entry.key = key;
        await persistEntry(io, user, key, entry);
      } catch (err) {
        console.warn(
          `[stats] tick-derived enrich failed for ${record.id}:`,
          err?.message || err
        );
        try {
          const key = versionKey(record);
          const entry = await loadStoredEntry(io, user, record.id);
          if (entry && needsRoleEnrichment(entry)) {
            entry.roles = { v: ROLES_VERSION, maps: {} };
            entry.key = key;
            await persistEntry(io, user, key, entry);
          }
        } catch {
          /* ignore */
        }
      } finally {
        roleJobs.delete(record.id);
      }
    })();
  });
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
  const controlCache = new Map();
  const zoneCache = new Map();
  const roleWork = createRoleWork();

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

    // Zones are loaded before the row is built, not after: the aim pass needs
    // the painted vision blocks to tell "could not see them" apart from
    // "missed them", and possession and roles reuse the same cached network.
    const controlNetwork = tickBuffer
      ? await ensureMapControl(io, meta.map, controlCache, zoneCache)
      : null;

    const row = rowFromRound(
      meta,
      record.id,
      file,
      roster.map((p) => p.id),
      new Map(roster.map((p) => [p.id, p.team])),
      tickBuffer,
      zoneCache.get(meta.map) || controlNetwork
    );

    if (tickBuffer) {
      const network = controlNetwork;
      const track = new TickTrack(tickBuffer);
      await applyPossessionFields(row, meta, track, network);
      applyMovementFields(row, meta, track, roster);
      const zones = zoneCache.get(meta.map || row.m) || network;
      accumulateRoundRoles(roleWork, {
        meta,
        track,
        row,
        network: zones,
        roster
      });
    } else {
      row.mv = {};
    }

    rounds.push(row);
    await yieldEventLoop();
  }

  const sitesByMap = new Map();
  for (const [map, net] of zoneCache) {
    const bomb = hasBombSites(net);
    sitesByMap.set(map, { bomb, ct: bomb || hasKeyZones(net) });
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
    roles: finalizeRoles(roleWork, sitesByMap),
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
 * Role assignment is scheduled in the background so GET /stats stays fast.
 * Pass `{ roles: true }` to wait for roles (explicit refresh).
 *
 * @param {object} io  { userDir, readRoundMeta, readRoundTicks? }
 * @param {{ roles?: boolean }} [opts]
 */
export async function demoIndex(io, user, record, opts = {}) {
  if (!record || record.status !== 'ready') return null;

  const key = versionKey(record);
  let entry = await loadStoredEntry(io, user, record.id);
  const keyOk = entry && keyMatchesRecord(entry.key, record);

  if (!entry || !keyOk) {
    entry = await buildIndex(io, user, record);
    await persistEntry(io, user, key, entry);
    return entry;
  }

  if (entry.key !== key) entry.key = key;

  if (needsPhaseEnrichment(entry)) {
    await enrichPhases(io, user, entry, { roles: true });
    await persistEntry(io, user, key, entry);
    return entry;
  }

  if (needsTickDerivedEnrichment(entry)) {
    if (opts.roles) {
      await enrichTickDerived(io, user, entry);
      await persistEntry(io, user, key, entry);
    } else {
      scheduleTickDerivedEnrichment(io, user, record);
    }
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

/**
 * Walk every ready demo and rebuild or enrich stats indexes that are missing
 * or behind STATS_VERSION (PRW / possession / swing, etc.).
 *
 * @param {object} io
 * @param {string} user
 * @param {object[]} records  from listDemos
 * @param {{ force?: boolean }} [opts]  force=true drops existing indexes first
 * @returns {Promise<{
 *   total: number,
 *   ready: number,
 *   built: number,
 *   enriched: number,
 *   current: number,
 *   failed: number,
 *   errors: Array<{ id: string, filename?: string, error: string }>
 * }>}
 */
export async function refreshLibraryStats(io, user, records, { force = false } = {}) {
  const ready = (records || []).filter((r) => (r.status || 'ready') === 'ready');
  const report = {
    total: (records || []).length,
    ready: ready.length,
    built: 0,
    enriched: 0,
    current: 0,
    failed: 0,
    errors: []
  };

  for (const record of ready) {
    try {
      if (force) await forgetDemoIndex(io, user, record.id);

      const before = force ? null : await loadStoredEntry(io, user, record.id);
      const keyOk = before && keyMatchesRecord(before.key, record);
      const wasMissing = !before || !keyOk;
      const wasStale = Boolean(
        before &&
          keyOk &&
          (needsPhaseEnrichment(before) || needsTickDerivedEnrichment(before))
      );

      const entry = await demoIndex(io, user, record, { roles: true });
      if (!entry) {
        report.failed++;
        report.errors.push({
          id: record.id,
          filename: record.filename,
          error: 'No stats index produced.'
        });
        continue;
      }

      if (wasMissing || force) report.built++;
      else if (wasStale) report.enriched++;
      else report.current++;
    } catch (err) {
      report.failed++;
      report.errors.push({
        id: record.id,
        filename: record.filename,
        error: err?.message || String(err)
      });
    }
  }

  return report;
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
