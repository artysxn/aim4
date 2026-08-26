// ---------------------------------------------------------------------------
// replays/teamStandingsDb.js
// Loads Valve regional standings markdown and resolves demo team names from
// player handles before ingest / on package import.
//
// Newest snapshot wins. The repo ships a bundled copy; a daily GitHub scan
// (vrsSync.js) writes newer live/<year> tables into AIM4_STANDINGS_DIR (or
// <replay root>/standings) when Valve publishes a new date.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseStandingsMarkdown,
  resolveDemoTeams
} from '../../src/replays/shared/teamStandings.js';
import {
  VRS_REGIONS,
  compareStandingDates,
  parseStandingFileName
} from '../../src/replays/shared/vrsStandings.js';
import { buildGlobalRanks } from '../../src/replays/shared/vrsRanks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_STANDINGS_DIR = path.join(
  __dirname,
  '../../src/replays/data/standings'
);

export function bundledStandingsDir() {
  return process.env.AIM4_STANDINGS_BUNDLED_DIR || BUNDLED_STANDINGS_DIR;
}

export function liveStandingsDir() {
  if (process.env.AIM4_STANDINGS_DIR) return process.env.AIM4_STANDINGS_DIR;
  const replayRoot =
    process.env.AIM4_REPLAY_DIR || path.join(__dirname, '..', 'data', 'replays');
  return path.join(replayRoot, 'standings');
}

/**
 * Newest standings file per region, live copy beating bundled on a date tie.
 * @param {string[]} [dirs]
 * @returns {Record<string, { region: string, date: string, year: string, file: string, dir: string, path: string }>}
 */
export function discoverStandingFiles(dirs) {
  const search = dirs || [bundledStandingsDir(), liveStandingsDir()];
  /** @type {Record<string, { region: string, date: string, year: string, file: string, dir: string, path: string }>} */
  const best = {};
  for (const dir of search) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const parsed = parseStandingFileName(name);
      if (!parsed) continue;
      const next = { ...parsed, dir, path: path.join(dir, name) };
      const prev = best[parsed.region];
      if (!prev) {
        best[parsed.region] = next;
        continue;
      }
      const cmp = compareStandingDates(parsed.date, prev.date);
      if (cmp > 0 || (cmp === 0 && dir === liveStandingsDir())) {
        best[parsed.region] = next;
      }
    }
  }
  return best;
}

/** Date stamp currently on disk per region, or null if that region is missing. */
export function loadedStandingSnapshot() {
  const files = discoverStandingFiles();
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const region of VRS_REGIONS) out[region] = files[region]?.date || null;
  return out;
}

/** @type {import('../../src/replays/shared/teamStandings.js').StandingTeam[] | null} */
let cached = null;
/** @type {ReturnType<typeof buildGlobalRanks> | null} */
let rankCache = null;

export function loadStandingTeams() {
  if (cached) return cached;
  const teams = [];
  const files = discoverStandingFiles();
  for (const region of VRS_REGIONS) {
    const hit = files[region];
    if (!hit) {
      console.warn(`[standings] no ${region} snapshot on disk`);
      continue;
    }
    try {
      const md = fs.readFileSync(hit.path, 'utf8');
      teams.push(...parseStandingsMarkdown(md, region));
    } catch (err) {
      console.warn(`[standings] could not load ${hit.file}:`, err?.message || err);
    }
  }
  cached = teams;
  return teams;
}

/** Test helper — drop the in-memory table so the next load re-reads disk. */
export function forgetStandingTeams() {
  cached = null;
  rankCache = null;
}

/** Three regions pooled by points. Rank 1 is worldwide, not per-region. */
export function loadGlobalRanks() {
  if (rankCache) return rankCache;
  rankCache = buildGlobalRanks(loadStandingTeams());
  return rankCache;
}

/**
 * Mutate a NormalizedDemo's team1/team2 when a side matches a standings roster.
 * Call before materializeDemo so round ids pick up the resolved short ids.
 *
 * @param {import('../demoparser/schema.js').NormalizedDemo} demo
 */
export function applyStandingsToDemo(demo) {
  if (!demo) return demo;
  const players = demo.rounds?.[0]?.players || [];
  const resolved = resolveDemoTeams(players, loadStandingTeams());
  if (resolved.team1) demo.team1 = resolved.team1;
  if (resolved.team2) demo.team2 = resolved.team2;
  return demo;
}

/**
 * Update a library record's display names (and matching round JSON in a
 * package file map). Round filename ids stay as baked — same as rename.
 *
 * @param {object} record
 * @param {Map<string, Uint8Array>} [files]
 */
export function applyStandingsToRecord(record, files = null) {
  if (!record) return record;
  const players = record.players || [];
  return applyResolvedTeamsToRecord(
    record,
    resolveDemoTeams(players, loadStandingTeams()),
    files
  );
}

/**
 * Stamp already-resolved team names onto a record and its round metas.
 *
 * Split out of applyStandingsToRecord because the standings are not the only
 * thing that can name a side of an imported package: lineupNames.js resolves
 * the same shape from the library's own rosters, and both have to land in the
 * same two places or the manifest and the round files disagree.
 *
 * @param {object} record
 * @param {{ team1: {id,name}|null, team2: {id,name}|null }} resolved
 * @param {Map<string, Uint8Array>} [files]
 */
export function applyResolvedTeamsToRecord(record, resolved, files = null) {
  if (!record || !resolved) return record;
  if (!resolved.team1 && !resolved.team2) return record;

  if (resolved.team1) {
    record.team1 = {
      ...(record.team1 || {}),
      name: resolved.team1.name,
      id: record.team1?.id || resolved.team1.id
    };
  }
  if (resolved.team2) {
    record.team2 = {
      ...(record.team2 || {}),
      name: resolved.team2.name,
      id: record.team2?.id || resolved.team2.id
    };
  }

  if (files) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const stamp = (meta) => {
      if (resolved.team1 && meta.team1) meta.team1 = { ...meta.team1, name: resolved.team1.name };
      if (resolved.team2 && meta.team2) meta.team2 = { ...meta.team2, name: resolved.team2.name };
      return meta;
    };
    for (const [name, data] of [...files.entries()]) {
      const n = String(name).replace(/\\/g, '/');
      if (n === 'manifest.json') {
        files.set(n, enc.encode(JSON.stringify(record, null, 2)));
        continue;
      }
      if (!n.startsWith('rounds/')) continue;
      try {
        if (n.endsWith('.json.zst')) {
          const meta = stamp(JSON.parse(zlib.zstdDecompressSync(Buffer.from(data)).toString('utf8')));
          files.set(
            n,
            new Uint8Array(zlib.zstdCompressSync(Buffer.from(JSON.stringify(meta))))
          );
        } else if (n.endsWith('.json')) {
          const meta = stamp(JSON.parse(dec.decode(data)));
          files.set(n, enc.encode(JSON.stringify(meta)));
        }
      } catch {
        /* leave corrupt entries alone; import validates later */
      }
    }
  }

  return record;
}
