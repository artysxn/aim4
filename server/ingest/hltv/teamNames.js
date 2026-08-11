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
//
// Resolution order:
//   1. Exact clan tag = HLTV slug, and/or VRS standings roster overlap
//   2. If that fails: match in-demo clan / team labels to the two team names
//      already present in the HLTV .dem filename (fuzzy + common aliases)
// ---------------------------------------------------------------------------

import { shortIdFor } from '../../../src/replays/shared/roundId.js';
import { loadStandingTeams } from '../../replays/teamStandingsDb.js';
import { displayNameFor, parseDemoFilename, slugify } from './hltvNames.js';

/** Normalise a player handle for comparison: case and punctuation are noise. */
function handleKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Labels that never identify an org. */
const GENERIC_LABELS = new Set([
  'team',
  'team1',
  'team2',
  'team 1',
  'team 2',
  'unknown',
  'ct',
  't',
  'terrorist',
  'counterterrorist',
  'counter-terrorist',
  'spectator'
]);

/**
 * Common clan-tag / short-name aliases for HLTV filename slugs.
 * Bidirectional: either side of a pair may appear in the demo or the filename.
 */
const NAME_ALIASES = [
  ['navi', 'natus-vincere'],
  ['vp', 'virtus-pro'],
  ['nip', 'ninjas-in-pyjamas'],
  ['c9', 'cloud9'],
  ['cloud-9', 'cloud9'],
  ['tl', 'liquid'],
  ['tl', 'team-liquid'],
  ['liquid', 'team-liquid'],
  ['faze', 'faze-clan'],
  ['ts', 'spirit'],
  ['ts', 'team-spirit'],
  ['spirit', 'team-spirit'],
  ['gl', 'gamerlegion'],
  ['gamer-legion', 'gamerlegion'],
  ['ef', 'eternal-fire'],
  ['mibr', 'made-in-brazil'],
  ['saw', 'saw'],
  ['3dmax', '3dmax'],
  ['heroic', 'heroic'],
  ['astr', 'astralis'],
  ['ence', 'ence'],
  ['big', 'big'],
  ['og', 'og'],
  ['fnatic', 'fnatic'],
  ['g2', 'g2'],
  ['mouz', 'mouz'],
  ['mous', 'mouz'],
  ['complexity', 'complexity'],
  ['col', 'complexity'],
  ['pain-gaming', 'pain'],
  ['team-falcons', 'falcons'],
  ['betboom-team', 'betboom'],
  ['bb', 'betboom'],
  ['mongolz', 'the-mongolz'],
  ['lv', 'lynn-vision']
].flatMap(([a, b]) => {
  const sa = slugify(a);
  const sb = slugify(b);
  return sa && sb && sa !== sb ? [[sa, sb]] : [];
});

const aliasIndex = (() => {
  const map = new Map();
  for (const [a, b] of NAME_ALIASES) {
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
})();

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

function isUsefulLabel(label) {
  const s = slugify(label);
  if (!s || s.length < 2) return false;
  if (GENERIC_LABELS.has(s) || GENERIC_LABELS.has(String(label || '').trim().toLowerCase())) {
    return false;
  }
  return true;
}

/** The parser's two sides, as handles / clan tags / team display labels. */
function sidesOf(demo) {
  const players = demo?.rounds?.[0]?.players || [];
  const side = (n) => {
    const list = players.filter((p) => p.team === n);
    const clans = new Set(list.map((p) => slugify(p.clanName)).filter(isUsefulLabel));
    const teamName = n === 1 ? demo?.team1?.name : demo?.team2?.name;
    const labels = new Set(clans);
    if (isUsefulLabel(teamName)) labels.add(slugify(teamName));
    return {
      handles: new Set(list.map((p) => handleKey(p.name))),
      clans,
      labels
    };
  };
  return [side(1), side(2)];
}

/** How strongly one parsed side looks like one HLTV team via clan + VRS roster. */
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
 * How strongly a single in-demo label looks like one HLTV filename team slug.
 * Exported for tests.
 */
export function nameAffinity(label, teamSlug) {
  const a = slugify(label);
  const b = slugify(teamSlug);
  if (!a || !b || !isUsefulLabel(a)) return 0;
  if (a === b) return 100;
  if (aliasIndex.get(a)?.has(b)) return 80;

  const ac = a.replace(/-/g, '');
  const bc = b.replace(/-/g, '');
  if (ac.length >= 3 && bc.length >= 3) {
    if (bc.includes(ac) || ac.includes(bc)) return 60;
  }

  const aParts = a.split('-').filter((p) => p.length >= 3);
  const bParts = b.split('-').filter((p) => p.length >= 3);
  if (aParts.some((p) => bParts.includes(p))) return 50;

  // Initials: virtus-pro -> vp, ninjas-in-pyjamas -> nip
  const initials = b
    .split('-')
    .map((p) => p[0])
    .join('');
  if (initials.length >= 2 && a === initials) return 70;

  return 0;
}

/** Best affinity of any label on a side to one HLTV team. */
function scoreNameSide(side, teamSlug) {
  let best = 0;
  for (const label of side.labels) {
    best = Math.max(best, nameAffinity(label, teamSlug));
  }
  return best;
}

function applyNames(demo, t1, t2) {
  demo.team1 = { ...(demo.team1 || {}), name: t1, id: shortIdFor(t1) };
  demo.team2 = { ...(demo.team2 || {}), name: t2, id: shortIdFor(t2) };
}

/**
 * Teams for one .dem from its own filename when possible (both org slugs are
 * in `team-vs-team-mN-map.dem`). Falls back to archive-level teams.
 *
 * @param {string} demoFilename
 * @param {{name: string, slug?: string}[]} [archiveTeams]
 */
export function teamsFromDemoFilename(demoFilename, archiveTeams = []) {
  const parsed = parseDemoFilename(demoFilename);
  if (parsed?.team1Slug && parsed?.team2Slug && parsed.team1Slug !== parsed.team2Slug) {
    return [
      { slug: parsed.team1Slug, name: displayNameFor(parsed.team1Slug) },
      { slug: parsed.team2Slug, name: displayNameFor(parsed.team2Slug) }
    ];
  }
  return archiveTeams;
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
 * @returns {{applied: boolean, confidence: 'clan'|'roster'|'name'|'none',
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

  const named = teams.map((t) => ({
    name: String(t?.name || '').trim(),
    slug: slugify(t?.slug || t?.name)
  }));
  if (!named[0].name || !named[1].name) return none('a team has no name');
  if (named[0].slug === named[1].slug) return none('both teams resolve to the same slug');

  const [sideA, sideB] = sidesOf(demo);
  const rosters = named.map((t) => rosterFor(t.name));

  // ---- 1) Clan tags + VRS roster overlap ---------------------------------
  // Two possible assignments. `straight` = parser side 1 is HLTV team 1.
  const straight =
    scoreSide(sideA, named[0].slug, rosters[0]) + scoreSide(sideB, named[1].slug, rosters[1]);
  const swapped =
    scoreSide(sideA, named[1].slug, rosters[1]) + scoreSide(sideB, named[0].slug, rosters[0]);

  if (straight !== swapped && (straight > 0 || swapped > 0)) {
    const useStraight = straight > swapped;
    const winner = Math.max(straight, swapped);
    // A clan-name hit is worth 100, so anything at or above that came from the
    // demo naming itself. Below it we are relying on roster overlap, which needs
    // at least three of five to be trustworthy against stand-ins.
    const confidence = winner >= 100 ? 'clan' : 'roster';
    if (!(confidence === 'roster' && winner < 30)) {
      const t1 = useStraight ? named[0].name : named[1].name;
      const t2 = useStraight ? named[1].name : named[0].name;
      applyNames(demo, t1, t2);
      return {
        applied: true,
        confidence,
        team1: t1,
        team2: t2,
        scores: [straight, swapped]
      };
    }
  }

  // ---- 2) Filename team names ↔ in-demo clan / team labels ---------------
  // HLTV .dem names already carry both orgs (`mibr-vs-bestia-m1-cache.dem`).
  // When VRS has no roster for them (or stand-ins dilute the overlap), orient
  // by matching whatever label the demo already wrote on each side.
  const nameStraight =
    scoreNameSide(sideA, named[0].slug) + scoreNameSide(sideB, named[1].slug);
  const nameSwapped =
    scoreNameSide(sideA, named[1].slug) + scoreNameSide(sideB, named[0].slug);

  if (nameStraight === 0 && nameSwapped === 0) {
    return none(
      straight === 0 && swapped === 0
        ? 'no clan, roster, or filename-name match on either side'
        : `weak roster overlap (best score ${Math.max(straight, swapped)}, need 30); no filename-name match`
    );
  }
  if (nameStraight === nameSwapped) {
    return none(`ambiguous filename-name orientation (both assignments score ${nameStraight})`);
  }

  const nameWinner = Math.max(nameStraight, nameSwapped);
  const nameMargin = Math.abs(nameStraight - nameSwapped);
  // Need a real hit on at least one side and a clear preference between the
  // two assignments so we do not flip MIBR/BESTIA on a coin toss.
  if (nameWinner < 50 || nameMargin < 40) {
    return none(
      `weak filename-name orientation (best ${nameWinner}, margin ${nameMargin}; need 50 / 40)`
    );
  }

  const useStraight = nameStraight > nameSwapped;
  const t1 = useStraight ? named[0].name : named[1].name;
  const t2 = useStraight ? named[1].name : named[0].name;
  applyNames(demo, t1, t2);
  return {
    applied: true,
    confidence: 'name',
    team1: t1,
    team2: t2,
    scores: [nameStraight, nameSwapped]
  };
}
