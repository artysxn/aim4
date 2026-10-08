// ---------------------------------------------------------------------------
// replays/performance/zoneStats.js
// Performance > Zones: a rating for every position (or zone) on a map.
//
// A round counts for a position when the player did something there: got a
// kill or an assist from it, hit someone from it, died in it, or was still
// alive in it when the round ended. The rating is Rating 3.0 over those events,
// in the neutral-economy form the phase windows already use
// (rating3FromCounters), so a position reads as "how do I do when I fight
// here".
//
// A round in which a player killed from one spot and died in another is split
// between the two: each gets half a round. Counting it whole in both made every
// region's rating sit below the player's own (more rounds, same kills), so a
// 1.29 player read 1.10 everywhere. Split, the regions average back to the
// player's rating, and a spot where the kills come from reads above it.
//
// The events come from roundZoneEvents: one compact record per round with a
// world position on every event. Records are fetched once per subject and map
// and kept, so every filter on the toolbar re-aggregates in memory.
// ---------------------------------------------------------------------------

import { fetchRoundPacks, fetchRoundZoneEvents } from '../api.js';
import { roundZoneEvents, ZONE_EVENT_FLAGS } from '../shared/roundZoneEvents.js';
import { rating3FromCounters } from '../shared/rating3.js';
import { positionsAtPoint } from '../zones/pointInZone.js';
import { mapHasStackedFloors, regionLevelForZ } from '../zones/zoneLevel.js';

/** Fewer rounds than this and a region is drawn, but not coloured by its rating. */
export const ZONE_MIN_ROUNDS = 5;

/** Rounds per request: under the server's 400 cap, and a few hundred KB of answer. */
const ZONE_BATCH = 300;
/** Round packs per request on the fallback path (the packs endpoint's own size). */
const PACK_BATCH = 150;
const CONCURRENCY = 3;

/**
 * Rating bands, the same cut points as the internal report's rating tables
 * (antistratInternal RATING_BANDS), with a colour for every band because a
 * map region has to be painted something.
 */
export const ZONE_BANDS = [
  { max: 0.85, color: '#e06666', label: '< 0.85' },
  { max: 1.0, color: '#f6a04d', label: '0.85' },
  { max: 1.12, color: '#c9c27a', label: '1.00' },
  { max: 1.3, color: '#9bd17f', label: '1.12' },
  { max: 1.7, color: '#4fbf73', label: '1.30' },
  { max: Infinity, color: '#5ea3f2', label: '1.70' }
];

export function zoneColor(rating) {
  if (!Number.isFinite(rating)) return null;
  return (ZONE_BANDS.find((b) => rating < b.max) || ZONE_BANDS[ZONE_BANDS.length - 1]).color;
}

/** Set once an older server answers 404, so later loads go straight to packs. */
let endpointMissing = false;

/**
 * Fetch the records for `jobs` that `cache` does not hold yet.
 *
 * @param {Array<{ file: string, ids: string[] }>} jobs
 * @param {Map<string, object|null>} cache  file -> record (null: no positions)
 * @param {{ onProgress?: (p: { done: number, total: number }) => void,
 *           isStale?: () => boolean }} [opts]
 */
export async function loadZoneRecords(jobs, cache, { onProgress = null, isStale = null } = {}) {
  const missing = jobs.filter((j) => j.file && !cache.has(j.file));
  const total = missing.length;
  let done = 0;
  onProgress?.({ done, total });
  if (!total) return cache;

  const chunks = [];
  const size = endpointMissing ? PACK_BATCH : ZONE_BATCH;
  for (let i = 0; i < missing.length; i += size) chunks.push(missing.slice(i, i + size));

  const viaPacks = async (chunk) => {
    const want = new Map(chunk.map((j) => [j.file, j.ids]));
    for (let i = 0; i < chunk.length; i += PACK_BATCH) {
      const part = chunk.slice(i, i + PACK_BATCH).map((j) => j.file);
      let packs = null;
      try {
        packs = await fetchRoundPacks(part, { stride: 100, ticks: true });
      } catch {
        packs = null;
      }
      for (const file of part) {
        const pack = packs?.get(file);
        let record = null;
        try {
          record = pack?.meta ? roundZoneEvents(pack.meta, pack.ticks, want.get(file)) : null;
        } catch {
          record = null;
        }
        cache.set(file, record);
      }
      done += part.length;
      onProgress?.({ done, total });
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      if (isStale?.()) return;
      const chunk = chunks[next++];
      if (!endpointMissing) {
        const ids = [...new Set(chunk.flatMap((j) => j.ids))];
        let got;
        try {
          got = await fetchRoundZoneEvents(
            chunk.map((j) => j.file),
            ids
          );
        } catch {
          got = undefined;
        }
        if (got === null) endpointMissing = true;
        if (got) {
          for (const j of chunk) cache.set(j.file, got.get(j.file) || null);
          done += chunk.length;
          onProgress?.({ done, total });
          continue;
        }
      }
      await viaPacks(chunk);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  return cache;
}

/**
 * Position ids for every event of a record, worked out once per network.
 * Kept on the record itself: the lookup is the expensive half of a repaint.
 */
function eventPositions(record, network, mapCode) {
  if (record._net === network) return record._pos;
  const stacked = mapHasStackedFloors(mapCode);
  record._pos = record.e.map((ev) => {
    const level = stacked ? regionLevelForZ(mapCode, ev[5]) : null;
    const hit = positionsAtPoint(ev[3], ev[4], network, level ? { level } : {});
    return hit[0]?.id || '';
  });
  record._net = network;
  return record._pos;
}

/** position id -> zone id, from the network's zones. */
export function positionZoneIndex(network) {
  const out = new Map();
  for (const z of network?.zones || []) {
    for (const pid of z.positionIds || []) if (!out.has(pid)) out.set(pid, z.id);
  }
  return out;
}

function emptyCounters() {
  return {
    rounds: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    openKills: 0,
    openDeaths: 0,
    headshots: 0,
    survived: 0,
    weight: 0,
    kastWeight: 0,
    files: [],
    players: new Map()
  };
}

function addCell(c, cell, w) {
  c.weight += w;
  if (cell.k || cell.a || cell.s || cell.t) c.kastWeight += w;
  c.kills += cell.k;
  c.deaths += cell.d;
  c.assists += cell.a;
  c.damage += cell.h;
  c.openKills += cell.ok;
  c.openDeaths += cell.od;
  c.headshots += cell.hs;
  c.survived += cell.s;
}

function phaseOf(tick, b) {
  if (tick >= b[2]) return 'late';
  if (tick >= b[1]) return 'mid';
  return 'early';
}

/**
 * Totals per region.
 *
 * @param {object} args
 * @param {Array<{ file: string, ids: string[], at: number }>} args.rounds
 *   rounds that passed the toolbar, with the subject's players in each
 * @param {Map<string, object|null>} args.records  file -> record
 * @param {object} args.network  the map's position network
 * @param {string} args.mapCode
 * @param {'position'|'zone'} [args.grain]
 * @param {''|'early'|'mid'|'late'} [args.phase]
 * @param {boolean} [args.perPlayer]  also keep each player's own counters
 *   (`players`, keyed by id): a team's regions say who fights there
 * @returns {{ regions: Map<string, object>, rounds: number, located: number }}
 *   `rounds` is how many filtered rounds had a record, `located` how many
 *   events landed inside a region.
 */
export function zoneTotals({
  rounds,
  records,
  network,
  mapCode,
  grain = 'position',
  phase = '',
  perPlayer = false
}) {
  const regions = new Map();
  const zoneOf = grain === 'zone' ? positionZoneIndex(network) : null;
  const { OPENING, HEADSHOT, TRADED } = ZONE_EVENT_FLAGS;
  let counted = 0;
  let located = 0;

  for (const r of rounds) {
    const record = records.get(r.file);
    if (!record?.e) continue;
    counted++;
    const pos = eventPositions(record, network, mapCode);
    const ids = new Set(r.ids);
    /** `${region}|${player}` -> this round's cell */
    const cells = new Map();
    for (let i = 0; i < record.e.length; i++) {
      const ev = record.e[i];
      if (!ids.has(ev[1])) continue;
      if (phase && phaseOf(ev[2], record.b) !== phase) continue;
      const pid = pos[i];
      if (!pid) continue;
      const region = zoneOf ? zoneOf.get(pid) : pid;
      if (!region) continue;
      located++;
      const key = `${region}|${ev[1]}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { region, k: 0, d: 0, a: 0, h: 0, ok: 0, od: 0, hs: 0, s: 0, t: 0 };
        cells.set(key, cell);
      }
      const n = ev[6] || 0;
      if (ev[0] === 'k') {
        cell.k++;
        if (n & OPENING) cell.ok++;
        if (n & HEADSHOT) cell.hs++;
      } else if (ev[0] === 'd') {
        cell.d++;
        if (n & OPENING) cell.od++;
        if (n & TRADED) cell.t++;
      } else if (ev[0] === 'a') cell.a++;
      else if (ev[0] === 'h') cell.h += n;
      else if (ev[0] === 's') cell.s++;
    }
    /** Regions each player touched this round: their share of the round. */
    const spread = new Map();
    for (const key of cells.keys()) {
      const id = key.slice(key.indexOf('|') + 1);
      spread.set(id, (spread.get(id) || 0) + 1);
    }
    for (const [key, cell] of cells) {
      const id = key.slice(key.indexOf('|') + 1);
      const w = 1 / spread.get(id);
      let c = regions.get(cell.region);
      if (!c) {
        c = emptyCounters();
        regions.set(cell.region, c);
      }
      // A team's players can share a region in one round: it is still one round.
      if (c.lastFile !== r.file) {
        c.lastFile = r.file;
        c.rounds++;
        c.files.push({ file: r.file, at: r.at || 0 });
      }
      addCell(c, cell, w);
      if (perPlayer) {
        let mine = c.players.get(id);
        if (!mine) {
          mine = emptyCounters();
          c.players.set(id, mine);
        }
        mine.rounds++;
        addCell(mine, cell, w);
      }
    }
  }

  for (const c of regions.values()) {
    Object.assign(c, zoneReadout(c));
    delete c.lastFile;
    for (const mine of c.players.values()) Object.assign(mine, zoneReadout(mine));
  }
  return { regions, rounds: counted, located };
}

/**
 * The numbers a region is shown with.
 *
 * Rates are over the region's share of rounds (`weight`), not its round
 * count: see zoneTotals. `rounds` stays the plain count, for the sample size.
 */
export function zoneReadout(c) {
  const w = c.weight || 0;
  const duels = c.openKills + c.openDeaths;
  return {
    rating: w
      ? rating3FromCounters({
          rounds: w,
          kills: c.kills,
          deaths: c.deaths,
          assists: c.assists,
          damage: c.damage,
          kast: c.kastWeight
        })
      : null,
    adr: w ? c.damage / w : null,
    kastPct: w ? (c.kastWeight / w) * 100 : null,
    kpr: w ? c.kills / w : null,
    opkRate: duels ? (c.openKills / duels) * 100 : null
  };
}

/**
 * Regions of the network at a grain, with the world pieces to draw.
 *
 * A zone is drawn as all of its positions. Hidden positions and empty zones
 * are left out, the same way positionsAtPoint never matches them.
 */
export function zoneRegions(network, grain = 'position') {
  const positions = (network?.positions || []).filter((p) => !p.hidden && p.pieces?.length);
  if (grain !== 'zone') {
    return positions.map((p) => ({
      id: p.id,
      name: p.name,
      level: p.level === 'lower' ? 'lower' : 'default',
      pieces: p.pieces
    }));
  }
  const byId = new Map(positions.map((p) => [p.id, p]));
  return (network?.zones || [])
    .map((z) => {
      const members = (z.positionIds || []).map((id) => byId.get(id)).filter(Boolean);
      return {
        id: z.id,
        name: z.name,
        level: members.every((p) => p.level === 'lower') ? 'lower' : 'default',
        pieces: members.flatMap((p) =>
          p.pieces.map((piece) => ({ ...piece, level: piece.level || p.level || 'default' }))
        )
      };
    })
    .filter((z) => z.pieces.length);
}
