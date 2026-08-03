// ---------------------------------------------------------------------------
// server/ingest/hltv/teamNames.js
// Put the real org names onto a parsed demo, before its round ids exist.
//
// Why the timing matters, since getting this wrong is silent:
//
// materializeDemo builds every round id from shortIdFor(team name) and bakes it
// into the round's FILENAME. The existing rename route
// (POST /api/replays/demos/:id/teams) deliberately leaves short ids alone,
// because rewriting filenames would break saved playlists, notes and share
// links. So renaming after ingest fixes the label and leaves every round
// grouped under a hash of whichever player happened to be in slot 0. The demo
// then displays correctly and filters wrongly, which is the worst of both.
//
// Hence: this runs between parseDemo and ingestDemo, and rewrites both `name`
// and `id`. materialize.js already has a hook in exactly this position
// (applyStandingsToDemo) for exactly this reason.
//
// The hard part is not the names, it is the ORIENTATION: which of the parser's
// two sides is which of HLTV's two teams. The parser's team numbers come from
// the demo's internal team ids and have no relationship to HLTV's ordering.
// Getting it backwards is worse than not naming at all, so anything below a
// confident answer is refused and flagged rather than guessed.
// ---------------------------------------------------------------------------

import { shortIdFor } from '../../../src/replays/shared/roundId.js';
import { loadStandingTeams } from '../../replays/teamStandingsDb.js';
import { slugify } from './hltvNames.js';

/** Normalise a player handle for comparison: case and punctuation are noise. */
function handleKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Roster handles for an org, from the Valve standings the library ships. */
function rosterFor(teamName) {
  const want = slugify(teamName);
  if (!want) return null;
  try {
    for (const team of loadStandingTeams()) {
      if (slugify(team.name) === want) return new Set((team.roster || []).map(handleKey));
    }
  } catch {
    /* standings missing */
  }
  return null;
}

/** The parser's two sides, as { clanKeys, handleKeys }. */
function sidesOf(demo) {
  const players = demo?.rounds?.[0]?.players || [];
  const side = (n) => {
    const list = players.filter((p) => p.team === n);
    return {
      handles: new Set(list.map((p) => handleKey(p.name))),
      clans: new Set(list.map((p) => slugify(p.clanName)).filter(Boolean))
    };
  };
  return [side(1), side(2)];
}

/** How strongly one parsed side looks like one HLTV team. */
function scoreSide(side, teamSlug, roster) {
  let score = 0;
  // A clan name written into the demo is the strongest signal there is: it is
  // the org naming itself, not us inferring it.
  if (side.clans.has(teamSlug)) score += 100;
  if (roster) {
    for (const h of side.handles) if (roster.has(h)) score += 10;
  }
  return score;
}

/**
 * Overwrite a parsed demo's team names with the ones from HLTV metadata.
 *
 * Never throws. A match whose orientation cannot be resolved is left with the
 * parser's naming and reported as `applied: false`, so the demo is still
 * ingested and can be revisited rather than lost.
 *
 * @param {object} demo               a NormalizedDemo, mutated in place
 * @param {{name: string, slug?: string}[]} teams  exactly two, HLTV order
 * @returns {{applied: boolean, confidence: 'clan'|'roster'|'none',
 *            team1: string, team2: string, reason?: string, scores?: number[]}}
 */
export function applyHltvTeams(demo, teams) {
  const parserNames = {
    team1: demo?.team1?.name || '',
    team2: demo?.team2?.name || ''
  };
  const none = (reason) => ({
    applied: false,
    confidence: 'none',
    ...parserNames,
    reason
  });

  if (!demo?.rounds?.length) return none('demo has no rounds');
  if (!Array.isArray(teams) || teams.length !== 2) return none('need exactly two teams');

  const named = teams.map((t) => ({ name: String(t?.name || '').trim(), slug: slugify(t?.slug || t?.name) }));
  if (!named[0].name || !named[1].name) return none('a team has no name');
  if (named[0].slug === named[1].slug) return none('both teams resolve to the same slug');

  const [sideA, sideB] = sidesOf(demo);
  const rosters = named.map((t) => rosterFor(t.name));

  // Two possible assignments. `straight` = parser side 1 is HLTV team 1.
  const straight =
    scoreSide(sideA, named[0].slug, rosters[0]) + scoreSide(sideB, named[1].slug, rosters[1]);
  const swapped =
    scoreSide(sideA, named[1].slug, rosters[1]) + scoreSide(sideB, named[0].slug, rosters[0]);

  if (straight === 0 && swapped === 0) {
    return none('no clan name or roster overlap on either side');
  }
  if (straight === swapped) {
    return none(`ambiguous orientation (both assignments score ${straight})`);
  }

  const useStraight = straight > swapped;
  const winner = Math.max(straight, swapped);
  // A clan-name hit is worth 100, so anything at or above that came from the
  // demo naming itself. Below it we are relying on roster overlap, which needs
  // at least three of five to be trustworthy against stand-ins.
  const confidence = winner >= 100 ? 'clan' : 'roster';
  if (confidence === 'roster' && winner < 30) {
    return none(`weak roster overlap (best score ${winner}, need 30)`);
  }

  const t1 = useStraight ? named[0].name : named[1].name;
  const t2 = useStraight ? named[1].name : named[0].name;

  // Both name and id: shortIdFor hashes the name, and setting one without the
  // other is the failure this whole module exists to prevent.
  demo.team1 = { ...(demo.team1 || {}), name: t1, id: shortIdFor(t1) };
  demo.team2 = { ...(demo.team2 || {}), name: t2, id: shortIdFor(t2) };

  return {
    applied: true,
    confidence,
    team1: t1,
    team2: t2,
    scores: [straight, swapped]
  };
}
