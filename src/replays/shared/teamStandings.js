// ---------------------------------------------------------------------------
// replays/shared/teamStandings.js
// Parse Valve regional standings tables and match a demo side's player names
// to a known roster (e.g. NiKo + karrigan + m0NESY → Falcons).
//
// Pure data helpers — no fs. The server loads the latest snapshot (live copy
// or bundled fallback) and hands the parsed teams to these functions.
// ---------------------------------------------------------------------------

import { shortIdFor } from './roundId.js';

/** Minimum overlapping players before we trust a roster hit. */
export const MIN_ROSTER_HITS = 3;

/**
 * @typedef {{ standing: number, points: number, name: string, roster: string[], region: string }} StandingTeam
 */

/** Collapse handles the way demos / standings disagree on punctuation. */
export function normalizePlayerName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Parse one Valve standings markdown table.
 * @param {string} markdown
 * @param {string} [region]
 * @returns {StandingTeam[]}
 */
export function parseStandingsMarkdown(markdown, region = '') {
  const teams = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    if (/standing/i.test(line) || /:-/.test(line)) continue;
    const parts = line.split('|').map((p) => p.trim());
    // Leading/trailing empties from edge pipes → ['', standing, points, name, roster, details, '']
    if (parts.length < 5) continue;
    const standing = Number(parts[1]);
    const points = Number(parts[2]);
    const name = parts[3];
    const rosterRaw = parts[4];
    if (!Number.isFinite(standing) || !name || !rosterRaw) continue;
    if (/^team name$/i.test(name) || /^roster$/i.test(rosterRaw)) continue;
    const roster = rosterRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (roster.length < 2) continue;
    teams.push({
      standing,
      points: Number.isFinite(points) ? points : 0,
      name,
      roster,
      region
    });
  }
  return teams;
}

/**
 * Best standings team for a set of in-demo player names, or null.
 * @param {string[]} playerNames
 * @param {StandingTeam[]} teams
 * @param {{ minHits?: number }} [opts]
 * @returns {{ team: StandingTeam, hits: number } | null}
 */
export function matchStandingTeam(playerNames, teams, opts = {}) {
  const minHits = opts.minHits ?? MIN_ROSTER_HITS;
  const side = new Set(
    (playerNames || []).map(normalizePlayerName).filter(Boolean)
  );
  if (side.size < minHits) return null;

  let best = null;
  let bestHits = 0;
  for (const team of teams || []) {
    const rosterNorm = team.roster.map(normalizePlayerName).filter(Boolean);
    let hits = 0;
    for (const p of rosterNorm) if (side.has(p)) hits++;
    if (hits < minHits) continue;
    if (
      !best ||
      hits > bestHits ||
      (hits === bestHits &&
        (team.points > best.team.points ||
          (team.points === best.team.points && team.standing < best.team.standing)))
    ) {
      bestHits = hits;
      best = { team, hits };
    }
  }
  return best;
}

/**
 * Resolve display teams for a demo roster (team 1 / team 2 sides).
 * @param {Array<{ name?: string, team?: number }>} players
 * @param {StandingTeam[]} teams
 * @returns {{ team1: { id: string, name: string } | null, team2: { id: string, name: string } | null }}
 */
export function resolveDemoTeams(players, teams) {
  const names1 = [];
  const names2 = [];
  for (const p of players || []) {
    if (!p?.name) continue;
    if (p.team === 1) names1.push(p.name);
    else if (p.team === 2) names2.push(p.name);
  }
  const hit1 = matchStandingTeam(names1, teams);
  const hit2 = matchStandingTeam(names2, teams);
  // Avoid assigning the same org to both sides when rosters are messy.
  if (hit1 && hit2 && hit1.team.name === hit2.team.name) {
    if (hit1.hits >= hit2.hits) {
      return {
        team1: { id: shortIdFor(hit1.team.name), name: hit1.team.name },
        team2: null
      };
    }
    return {
      team1: null,
      team2: { id: shortIdFor(hit2.team.name), name: hit2.team.name }
    };
  }
  return {
    team1: hit1 ? { id: shortIdFor(hit1.team.name), name: hit1.team.name } : null,
    team2: hit2 ? { id: shortIdFor(hit2.team.name), name: hit2.team.name } : null
  };
}
