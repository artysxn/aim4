// ---------------------------------------------------------------------------
// replays/teamStandingsDb.js
// Loads Valve regional standings markdown from the repo and resolves demo
// team names from player handles before ingest / on package import.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseStandingsMarkdown,
  resolveDemoTeams
} from '../../src/replays/shared/teamStandings.js';

const STANDINGS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/replays/data/standings'
);

const STANDINGS_FILES = [
  { file: 'standings_europe_2026_07_06.md', region: 'europe' },
  { file: 'standings_americas_2026_07_06.md', region: 'americas' },
  { file: 'standings_asia_2026_07_06.md', region: 'asia' }
];

/** @type {import('../../src/replays/shared/teamStandings.js').StandingTeam[] | null} */
let cached = null;

export function loadStandingTeams() {
  if (cached) return cached;
  const teams = [];
  for (const { file, region } of STANDINGS_FILES) {
    const full = path.join(STANDINGS_DIR, file);
    try {
      const md = fs.readFileSync(full, 'utf8');
      teams.push(...parseStandingsMarkdown(md, region));
    } catch (err) {
      console.warn(`[standings] could not load ${file}:`, err?.message || err);
    }
  }
  cached = teams;
  return teams;
}

/** Test helper — drop the in-memory table so the next load re-reads disk. */
export function forgetStandingTeams() {
  cached = null;
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
  const resolved = resolveDemoTeams(players, loadStandingTeams());
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
