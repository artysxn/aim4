// Metadata out of HLTV's own filenames. This is what makes correct team naming
// possible with no access to hltv.org at all, so it is worth pinning hard.
//
// Both fixtures are real download names.

import {
  describeArchive,
  displayNameFor,
  isOverpassFilename,
  parseArchiveFilename,
  parseDemoFilename,
  slugify
} from './hltvNames.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(slugify('Virtus.pro') === 'virtus-pro', 'dots become hyphens');
  assert(slugify('Natus Vincere') === 'natus-vincere', 'spaces become hyphens');
  assert(slugify('MOUZ') === 'mouz', 'case folded');
  assert(slugify('3DMAX') === '3dmax', 'digits kept');
  assert(slugify('  G2  ') === 'g2', 'trimmed');
}

{
  const d = parseDemoFilename('mibr-vs-bestia-m1-cache.dem');
  assert(d, 'demo filename parses');
  assert(d.team1Slug === 'mibr' && d.team2Slug === 'bestia', 'both teams');
  assert(d.mapNumber === 1, 'map number');
  assert(d.map === 'CCH', `map code, got ${d.map}`);

  // Hyphenated org names must not be mistaken for the separator.
  const h = parseDemoFilename('ninjas-in-pyjamas-vs-virtus-pro-m3-dust2.dem');
  assert(h.team1Slug === 'ninjas-in-pyjamas', `team1, got ${h.team1Slug}`);
  assert(h.team2Slug === 'virtus-pro', `team2, got ${h.team2Slug}`);
  assert(h.mapNumber === 3 && h.map === 'DD2', `map, got ${h.map}`);

  assert(parseDemoFilename('not-a-demo.txt') === null, 'junk returns null');
}

{
  assert(isOverpassFilename('mibr-vs-bestia-m2-overpass.dem'), 'HLTV overpass demo');
  assert(isOverpassFilename('liquid-vs-vitality-m1-de_overpass.dem'), 'de_overpass slug');
  assert(isOverpassFilename('de_overpass.dem'), 'bare de_overpass');
  assert(!isOverpassFilename('mibr-vs-bestia-m1-cache.dem'), 'cache is kept');
  assert(!isOverpassFilename('mibr-vs-bestia-m3-dust2.dem'), 'dust2 is kept');
}

{
  // The archive name alone cannot be split: <event>-<team1> is ambiguous. The
  // demo names resolve it, and that is the whole reason describeArchive takes
  // both.
  const name =
    'starladder-starseries-fall-2026-south-america-closed-qualifier-mibr-vs-bestia-bo3-9ZQrqX0NdyN8m8TXmPCtWf.rar';
  const a = parseArchiveFilename(name, { team1Slug: 'mibr', team2Slug: 'bestia' });
  assert(
    a.eventSlug === 'starladder-starseries-fall-2026-south-america-closed-qualifier',
    `event slug, got ${a.eventSlug}`
  );
  assert(a.bestOf === 3, 'best of');
  assert(a.token === '9zqrqx0ndyn8m8txmpctwf', `token, got ${a.token}`);
}

{
  const r = describeArchive(
    'starladder-starseries-fall-2026-south-america-closed-qualifier-mibr-vs-bestia-bo3-9ZQrqX0NdyN8m8TXmPCtWf.rar',
    ['mibr-vs-bestia-m2-inferno.dem', 'mibr-vs-bestia-m1-cache.dem']
  );
  assert(r.teams[0].name === 'MIBR', `team1, got ${r.teams[0].name}`);
  assert(r.teams[1].name === 'BESTIA', `team2, got ${r.teams[1].name}`);
  assert(r.bestOf === 3, 'best of');
  // Sorted by map number, not by the order the archive listed them.
  assert(r.maps[0].mapNumber === 1 && r.maps[0].map === 'CCH', 'map 1 is cache');
  assert(r.maps[1].mapNumber === 2 && r.maps[1].map === 'INF', 'map 2 is inferno');
  assert(r.event.includes('Starseries'), `event, got ${r.event}`);
}

{
  const r = describeArchive(
    'blast-bounty-2026-season-2-liquid-vs-vitality-bo3-qIJxv4f_-TgN3EMU0b5r8t.rar',
    ['liquid-vs-vitality-m1-anubis.dem', 'liquid-vs-vitality-m2-nuke.dem']
  );
  assert(r.teams.map((t) => t.name).join(' vs ') === 'Liquid vs Vitality', 'teams');
  assert(r.event === 'Blast Bounty 2026 Season 2', `event, got ${r.event}`);
  assert(r.maps.map((m) => m.map).join(',') === 'ANU,NUK', 'maps in order');
}

{
  // Known orgs come back with their real spelling from the Valve standings,
  // including the "ex-" prefix used when a roster has left its org.
  assert(displayNameFor('natus-vincere') === 'Natus Vincere', 'known org keeps its spelling');
  assert(displayNameFor('ex-ruby') === 'ex-RUBY', 'standings spelling wins over title case');

  // Unknown ones are title-cased, which still beats a player handle. Words of
  // three letters or fewer are upper-cased, because at that length they are
  // nearly always an acronym and "Ago" reads wrong where "AGO" does not.
  assert(displayNameFor('quux-tenacity') === 'Quux Tenacity', 'unknown org title cased');
  assert(displayNameFor('zzt') === 'ZZT', 'short unknown names read as acronyms');
  assert(displayNameFor('') === '', 'empty stays empty');
}

{
  // Discovery reads the archive name before opening it, so team1 has to be
  // separated from the event without help. The org index does it, including
  // for names that are themselves hyphenated.
  const a = parseArchiveFilename(
    'starladder-starseries-fall-2026-south-america-closed-qualifier-mibr-vs-bestia-bo3-TOKEN.rar'
  );
  assert(a.team1Slug === 'mibr', `team1 split off the event, got ${a.team1Slug}`);
  assert(
    a.event === 'Starladder Starseries Fall 2026 South America Closed Qualifier',
    `event has no team name in it, got ${a.event}`
  );

  const multi = parseArchiveFilename('iem-cologne-2026-ninjas-in-pyjamas-vs-virtus-pro-bo3-TOKEN.rar');
  assert(multi.team1Slug === 'ninjas-in-pyjamas', `hyphenated team1, got ${multi.team1Slug}`);
  assert(multi.team2Slug === 'virtus-pro', `hyphenated team2, got ${multi.team2Slug}`);
  assert(multi.event === 'IEM Cologne 2026', `event, got ${multi.event}`);

  // An org nobody has heard of stays folded into the event rather than being
  // guessed at. describeArchive corrects it once the demos are listed.
  const unknown = parseArchiveFilename('some-event-zzznotateam-vs-otherorg-bo1-TOKEN.rar');
  assert(unknown.team2Slug === 'otherorg', `team2 from last -vs-, got ${unknown.team2Slug}`);
  assert(unknown.team1Slug === '', 'unknown team1 is not guessed');
  assert(unknown.bestOf === 1, 'best of 1');
}

console.log('hltvNames: all assertions passed');
