// ---------------------------------------------------------------------------
// server/ingest/hltv/hltvNames.js
// Match metadata out of the filenames HLTV itself generates.
//
// HLTV names its downloads and the demos inside them to a fixed grammar:
//
//   archive: <event-slug>-<team1>-vs-<team2>-bo<N>-<token>.rar
//            starladder-starseries-fall-2026-south-america-closed-qualifier
//              -mibr-vs-bestia-bo3-9ZQrqX0NdyN8m8TXmPCtWf.rar
//
//   demo:    <team1>-vs-<team2>-m<N>-<map>.dem
//            mibr-vs-bestia-m1-cache.dem
//
// That is a complete, authoritative source for team names, event, map order and
// map identity, and it needs no access to hltv.org at all. It is what makes the
// naming work for archives already on disk.
//
// The archive name alone is ambiguous: `<event>-<team1>` cannot be split
// without knowing where the event ends, since both are hyphenated slugs. The
// demo names inside resolve it, because there team1 starts at the beginning of
// the string. So teams come from the demo filenames and the event is whatever
// is left over on the archive.
//
// Slugs are lowercased and hyphenated, so "Virtus.pro" arrives as "virtus-pro".
// They are matched back to real org names against the Valve standings the
// library already ships, which is 378 teams with rosters.
// ---------------------------------------------------------------------------

import { loadStandingTeams } from '../../replays/teamStandingsDb.js';
import { MAP_CODES, MAPS } from '../../../src/replays/shared/roundId.js';

/** Lowercase, non-alphanumeric runs to single hyphens. "Virtus.pro" -> virtus-pro */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** slug -> canonical org name, built once from the standings markdown. */
let orgBySlug = null;

function orgIndex() {
  if (orgBySlug) return orgBySlug;
  orgBySlug = new Map();
  try {
    for (const team of loadStandingTeams()) {
      const slug = slugify(team.name);
      if (slug && !orgBySlug.has(slug)) orgBySlug.set(slug, team.name);
    }
  } catch {
    /* standings missing; fall back to title case */
  }
  return orgBySlug;
}

/** Forget the cached index. Tests set up different standings. */
export function forgetOrgIndex() {
  orgBySlug = null;
}

/**
 * A slug back to a display name.
 *
 * Prefers the real org spelling from the standings ("natus-vincere" ->
 * "Natus Vincere"), and falls back to title case, which is still far better
 * than the player handle the parser would otherwise use.
 */
export function displayNameFor(slug) {
  const s = slugify(slug);
  if (!s) return '';
  const known = orgIndex().get(s);
  if (known) return known;
  return s
    .split('-')
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Map slug from a demo filename to an aim4 map code. "cache" -> "CCH".
 *
 * Matched on the display name, since aim4's codes are three-letter ("CCH") and
 * HLTV's filenames use the plain map name. Returns '' for a map the library
 * does not know, which the caller treats as "cannot place this demo".
 */
export function mapCodeFor(slug) {
  const s = slugify(slug).replace(/^de-/, '');
  if (!s) return '';
  for (const code of MAP_CODES) {
    if (slugify(MAPS[code]?.name || '') === s) return code;
  }
  return '';
}

const DEMO_RE = /^(.+?)-vs-(.+?)-m(\d+)-([a-z0-9_]+)$/;

/**
 * Parse a demo filename from inside an HLTV archive.
 *
 * @param {string} filename  with or without the .dem extension
 * @returns {{team1Slug: string, team2Slug: string, mapNumber: number,
 *            mapSlug: string, map: string} | null}
 */
export function parseDemoFilename(filename) {
  const stem = String(filename || '')
    .replace(/^.*[/\\]/, '')
    .replace(/\.dem$/i, '')
    .toLowerCase();
  const m = DEMO_RE.exec(stem);
  if (!m) return null;
  const [, team1Slug, team2Slug, mapNumber, mapSlug] = m;
  return {
    team1Slug,
    team2Slug,
    mapNumber: Number(mapNumber),
    mapSlug,
    map: mapCodeFor(mapSlug)
  };
}

/**
 * True when a .dem (or loose path) is Overpass, from the HLTV filename alone.
 * `team-vs-team-m1-overpass.dem` and `de_overpass` both match; other maps do not.
 */
export function isOverpassFilename(filename) {
  const base = String(filename || '')
    .replace(/^.*[/\\]/, '')
    .toLowerCase();
  if (!base) return false;
  const stem = base.replace(/\.dem$/i, '');
  const parsed = parseDemoFilename(base);
  if (parsed && slugify(parsed.mapSlug).replace(/^de-/, '') === 'overpass') return true;
  // Fallback when the name is not the usual HLTV grammar.
  return /(?:^|[^a-z0-9])de[_-]?overpass(?:[^a-z0-9]|$)/.test(stem) ||
    /(?:^|[^a-z0-9])overpass(?:[^a-z0-9]|$)/.test(stem);
}

/**
 * Parse an archive filename, using the team slugs learned from the demos
 * inside it to find where the event name ends.
 *
 * @param {string} filename
 * @param {{team1Slug?: string, team2Slug?: string}} [teams]
 */
export function parseArchiveFilename(filename, teams = {}) {
  const stem = String(filename || '')
    .replace(/^.*[/\\]/, '')
    .replace(/\.(rar|zip|tar|tar\.gz|tar\.zst|7z)$/i, '')
    .toLowerCase();

  const bo = /-bo(\d+)-([a-z0-9_-]+)$/i.exec(stem);
  const bestOf = bo ? Number(bo[1]) : null;
  const token = bo ? bo[2] : '';
  const head = bo ? stem.slice(0, bo.index) : stem;

  let eventSlug = head;
  let team1Slug = teams.team1Slug || '';
  let team2Slug = teams.team2Slug || '';

  if (team1Slug && team2Slug) {
    // Strip the exact "-team1-vs-team2" tail the demos told us to expect.
    const tail = `${team1Slug}-vs-${team2Slug}`;
    eventSlug = head.endsWith(tail) ? head.slice(0, -tail.length).replace(/-$/, '') : head;
  } else {
    // No demo names yet (discovery reads the filename before opening the
    // archive). The last "-vs-" gives team2 exactly, but team1 is ambiguous
    // because both it and the event are hyphenated slugs: "…-qualifier-mibr"
    // could be any split. Left unresolved the team name lands in the event, so
    // the admin page reads "StarSeries … Closed Qualifier Mibr".
    //
    // Resolve it by asking the org index for the longest known team name that
    // ends where "-vs-" begins. Unknown orgs stay folded into the event and are
    // corrected once the demos inside are listed.
    const idx = head.lastIndexOf('-vs-');
    if (idx > 0) {
      team2Slug = head.slice(idx + 4);
      const before = head.slice(0, idx);
      const parts = before.split('-');
      const orgs = orgIndex();
      for (let take = Math.min(parts.length, 5); take >= 1; take--) {
        const candidate = parts.slice(-take).join('-');
        if (orgs.has(candidate)) {
          team1Slug = candidate;
          break;
        }
      }
      eventSlug = team1Slug ? before.slice(0, -team1Slug.length).replace(/-$/, '') : before;
    }
  }

  return {
    eventSlug,
    event: eventSlug ? titleCaseEvent(eventSlug) : '',
    team1Slug,
    team2Slug,
    bestOf,
    token
  };
}

/** Event slugs are long and full of small words; title case them readably. */
function titleCaseEvent(slug) {
  const small = new Set(['of', 'the', 'and', 'in', 'at', 'for', 'to', 'a', 'an', 'vs']);
  return slug
    .split('-')
    .map((w, i) => {
      if (i > 0 && small.has(w)) return w;
      if (/^\d+$/.test(w)) return w;
      if (w.length <= 3) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/**
 * Everything derivable about one archive and its demos.
 *
 * @param {string} archiveName
 * @param {string[]} demoNames  the .dem entries inside it
 */
export function describeArchive(archiveName, demoNames = []) {
  const maps = demoNames
    .map((name) => {
      const parsed = parseDemoFilename(name);
      return parsed ? { ...parsed, filename: name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.mapNumber - b.mapNumber);

  const first = maps[0] || {};
  const archive = parseArchiveFilename(archiveName, {
    team1Slug: first.team1Slug,
    team2Slug: first.team2Slug
  });

  const team1Slug = first.team1Slug || archive.team1Slug;
  const team2Slug = first.team2Slug || archive.team2Slug;

  return {
    archiveName,
    event: archive.event,
    eventSlug: archive.eventSlug,
    bestOf: archive.bestOf,
    token: archive.token,
    teams: [
      { slug: team1Slug, name: displayNameFor(team1Slug) },
      { slug: team2Slug, name: displayNameFor(team2Slug) }
    ],
    maps
  };
}
