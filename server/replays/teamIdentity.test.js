// One team, one identity. Each rule gets the scenario it was written for.
import assert from 'node:assert/strict';
import {
  buildTeamIdentity,
  displayNameForToken,
  filenameTeams,
  findRenameTargets,
  isPlaceholderName,
  normName
} from './teamIdentity.js';

let demoSeq = 0;
/** A demo record. `a`/`b` are rosters (arrays of player ids). */
function demo({ nameA, nameB, a, b, filename = '', at = 0 }) {
  demoSeq += 1;
  const id = `d${demoSeq}`;
  const players = [
    ...a.map((p) => ({ id: p, name: `n-${p}`, team: 1 })),
    ...b.map((p) => ({ id: p, name: `n-${p}`, team: 2 }))
  ];
  return {
    id,
    filename: filename || `${id}.dem`,
    uploadedAt: at || demoSeq,
    team1: { id: `s${demoSeq}a`, name: nameA ?? `n-${a[0]}` },
    team2: { id: `s${demoSeq}b`, name: nameB ?? `n-${b[0]}` },
    players
  };
}
const R = (n, start = 0) => Array.from({ length: n }, (_, i) => `p${start + i}`);

// ---- helpers ---------------------------------------------------------------
assert.equal(normName('Team Spirit!'), 'teamspirit');
assert.ok(isPlaceholderName('Team 1', []), 'Team 1 is a placeholder');
assert.ok(
  isPlaceholderName('oontoma', [{ name: 'Oontoma' }]),
  'a side named after its own player is a placeholder'
);
assert.ok(!isPlaceholderName('The Golden Horde', [{ name: 'lyoli' }]), 'a real name is not');

assert.deepEqual(
  filenameTeams('762_M0kasyny-vs-TheGoldenHorde_cache_12_33_12_22_07_2026(1).dem'),
  [
    { raw: 'M0kasyny', key: 'm0kasyny' },
    { raw: 'TheGoldenHorde', key: 'thegoldenhorde' }
  ],
  'junk peels off both sides of vs'
);
assert.deepEqual(
  filenameTeams('eac-vs-hotu-m3-cache.aim4replay'),
  [{ raw: 'eac', key: 'eac' }, { raw: 'hotu', key: 'hotu' }],
  'map and mN suffixes are junk'
);
assert.deepEqual(
  filenameTeams('the-golden-horde-vs-eac-mirage.dem')?.[0],
  { raw: 'the golden horde', key: 'thegoldenhorde' },
  'multi-token names survive'
);
assert.equal(filenameTeams('CkgviSxCnjWhAJZVuPWBpZwIxV.dem'), null, 'no vs, no tokens');
assert.equal(displayNameForToken('TheGoldenHorde'), 'The Golden Horde');
assert.equal(displayNameForToken('eac'), 'EAC');

// ---- a Bo3 between unnamed teams is ONE team per side ----------------------
// The original complaint: three maps, six "team names", every one of them a
// random player. Same ten players every map, so both sides must collapse.
{
  demoSeq = 0;
  const A = R(5, 0);
  const B = R(5, 10);
  // Different "first player" per map: the parser's placeholder name rotates.
  const out = buildTeamIdentity([
    demo({ nameA: 'n-p0', nameB: 'n-p10', a: A, b: B }),
    demo({ nameA: 'n-p3', nameB: 'n-p12', a: [...A].reverse(), b: [...B].reverse() }),
    demo({ nameA: 'n-p1', nameB: 'n-p14', a: A, b: B })
  ]);
  assert.equal(out.summary.groups, 2, 'a Bo3 has exactly two teams, not six');
}

// ---- rule 1: SHARKS → DENDELE, transitively --------------------------------
{
  demoSeq = 0;
  const sharks2024 = ['s1', 's2', 's3', 'x1', 'x2'];   // 3 later replaced
  const core = ['s1', 's2', 's3', 's4', 's5'];          // the roster that moves
  const dendele2026 = ['s1', 's2', 'y1', 'y2', 'y3'];   // 3 of the movers cut
  const opp = R(5, 40);
  const out = buildTeamIdentity([
    demo({ nameA: 'SHARKS', nameB: 'Opp', a: sharks2024, b: opp, at: 100 }),
    demo({ nameA: 'SHARKS', nameB: 'Opp', a: core, b: opp, at: 200 }),
    demo({ nameA: 'DENDELE', nameB: 'Opp', a: core, b: opp, at: 300 }),
    demo({ nameA: 'DENDELE', nameB: 'Opp', a: dendele2026, b: opp, at: 400 })
  ]);
  const dendele = out.teams.find((t) => t.name === 'DENDELE');
  assert.ok(dendele, 'the current name is canonical');
  assert.equal(dendele.demos.length, 4, 'all four lineups are one team once the link exists');
  assert.ok(dendele.aliases.includes('SHARKS'), 'the old name is an alias');
  // The five-player transfer is what binds; the 2024 and 2026 lineups join
  // through their own name continuity, exactly as specified.
  const sharksRename = out.renames['d1'];
  assert.ok(sharksRename?.team1 === 'DENDELE', 'variant lineups are unified to the canonical name');
}

// ---- rule 1 boundary: 4 shared players do NOT merge two proper names -------
{
  demoSeq = 0;
  const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const teamB = ['a1', 'a2', 'a3', 'a4', 'b5']; // 4 shared, both properly named
  const opp = R(5, 40);
  const out = buildTeamIdentity([
    demo({ nameA: 'Alpha', nameB: 'Opp', a: teamA, b: opp }),
    demo({ nameA: 'Bravo', nameB: 'Opp', a: teamB, b: opp })
  ]);
  assert.equal(
    out.teams.filter((t) => ['Alpha', 'Bravo'].includes(t.name)).length,
    2,
    'two named teams sharing four players stay separate'
  );
}

// ---- rule 2: Spirit / Team Spirit ------------------------------------------
{
  demoSeq = 0;
  const spirit = ['sp1', 'sp2', 'z1', 'z2', 'z3'];
  const teamSpirit = ['sp1', 'sp2', 'w1', 'w2', 'w3']; // only 2 shared
  const opp = R(5, 40);
  const out = buildTeamIdentity([
    demo({ nameA: 'Spirit', nameB: 'Opp', a: spirit, b: opp, at: 100 }),
    demo({ nameA: 'Team Spirit', nameB: 'Opp', a: teamSpirit, b: opp, at: 200 })
  ]);
  const t = out.teams.find((x) => x.name === 'Team Spirit');
  assert.ok(t, 'variants merge under the most recent name');
  assert.equal(t.demos.length, 2);
  assert.ok(t.aliases.includes('Spirit'), 'the short form is an alias');
  // But an unrelated team with a containing name and no shared players stays out.
  demoSeq = 0;
  const out2 = buildTeamIdentity([
    demo({ nameA: 'Spirit', nameB: 'Opp', a: spirit, b: opp }),
    demo({ nameA: 'Team Spirit Academy', nameB: 'Opp', a: R(5, 60), b: R(5, 70) })
  ]);
  assert.ok(
    out2.teams.some((x) => x.name === 'Spirit') &&
      out2.teams.some((x) => x.name === 'Team Spirit Academy'),
    'a name variant with no shared players does not merge'
  );
}

// ---- rule 3: the infurity elimination, verbatim ----------------------------
{
  demoSeq = 0;
  const oontoma = ['oon1', 'oon2', 'oon3', 'oon4', 'oontoma'];
  const lyoli = ['ly1', 'ly2', 'ly3', 'ly4', 'lyoli'];
  const sh1fu = ['sh1', 'sh2', 'sh3', 'sh4', 'sh1fu'];
  const out = buildTeamIdentity([
    demo({ nameA: null, nameB: null, a: oontoma, b: lyoli, filename: 'infurity-vs-TheGoldenHorde-mirage.dem' }),
    demo({ nameA: null, nameB: null, a: sh1fu, b: oontoma, filename: 'eac-vs-infurity-dust2.dem' })
  ]);
  const byName = new Map(out.teams.map((t) => [t.name, t]));
  assert.ok(byName.has('infurity'), 'oontoma squad follows its token across matchups');
  assert.ok(byName.has('The Golden Horde'), 'the opponent is named by elimination, camel-split');
  assert.ok(byName.has('EAC'), 'and so is the second opponent');
  // The renames actually land on the right sides.
  assert.equal(out.renames['d1']?.team1, 'infurity');
  assert.equal(out.renames['d1']?.team2, 'The Golden Horde');
  assert.equal(out.renames['d2']?.team1, 'EAC');
  assert.equal(out.renames['d2']?.team2, 'infurity');
}

// ---- rule 3 restraint: a pure Bo3 claims nothing ---------------------------
// Both tokens ride with both squads in every demo; there is no elimination to
// run, so nobody gets named — better no name than a coin flip.
{
  demoSeq = 0;
  const A = R(5, 0);
  const B = R(5, 10);
  const out = buildTeamIdentity([
    demo({ nameA: null, nameB: null, a: A, b: B, filename: 'alpha-vs-beta-m1-nuke.dem' }),
    demo({ nameA: null, nameB: null, a: A, b: B, filename: 'alpha-vs-beta-m2-mirage.dem' }),
    demo({ nameA: null, nameB: null, a: A, b: B, filename: 'alpha-vs-beta-m3-inferno.dem' })
  ]);
  assert.equal(out.summary.groups, 2, 'still two teams');
  assert.equal(out.summary.renamedDemos, 0, 'but no side is guessed at');
}

// ---- rule 3 + existing names: token matched to a proper team ---------------
// One side of the matchup is already properly named; its token is recognised,
// so the other token names the unnamed side in a SINGLE demo.
{
  demoSeq = 0;
  const horde = ['h1', 'h2', 'h3', 'h4', 'h5'];
  const mystery = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const out = buildTeamIdentity([
    demo({ nameA: 'The Golden Horde', nameB: 'Opp9', a: horde, b: R(5, 80), at: 50 }),
    demo({
      nameA: 'The Golden Horde',
      nameB: null,
      a: horde,
      b: mystery,
      filename: 'thegoldenhorde-vs-xcity-cache.dem',
      at: 60
    })
  ]);
  assert.equal(out.renames['d2']?.team2, 'xcity', 'the known side anchors the elimination');
}

// ---- a hand-rename carries the roster's other unnamed demos ----------------
// The admin names one side of one map. The same three-man core is sitting in
// the rest of the series under a different invented label every time, and
// those are the demos the rename is really for.
{
  demoSeq = 0;
  const core = ['c1', 'c2', 'c3'];
  const map1 = [...core, 'x1', 'x2'];
  const map2 = [...core, 'x1', 'x9'];   // one stand-in
  const map3 = [...core, 'y1', 'y2'];   // two stand-ins, still the same core
  const twoOnly = ['c1', 'c2', 'z1', 'z2', 'z3']; // shares 2: not enough
  const opp = R(5, 40);
  const records = [
    demo({ nameA: null, nameB: 'Opp', a: map1, b: opp }),
    demo({ nameA: null, nameB: 'Opp', a: map2, b: opp }),
    demo({ nameA: 'Opp', nameB: null, a: opp, b: map3 }),
    demo({ nameA: null, nameB: 'Opp', a: twoOnly, b: opp }),
    demo({ nameA: 'Real Name FC', nameB: 'Opp', a: map1, b: opp })
  ];

  const targets = findRenameTargets(records, 'd1', 1);
  const keys = targets.map((t) => `${t.demoId}:${t.side}`).sort();
  assert.deepEqual(keys, ['d2:1', 'd3:2'], 'the core is followed onto either side of other demos');
  assert.ok(
    !keys.includes('d4:1'),
    'two shared players is not a core'
  );
  assert.ok(
    !keys.includes('d5:1'),
    'a side the demo actually named is somebody else\'s team, roster or not'
  );

  // The seed itself is never a target, and an opponent sharing nobody is not one.
  assert.ok(!targets.some((t) => t.demoId === 'd1' && t.side === 1), 'seed excluded');
  assert.ok(!targets.some((t) => t.side === 2 && t.demoId === 'd1'), 'unrelated opponent excluded');

  // Threshold is a knob, and raising it narrows the sweep.
  assert.equal(
    findRenameTargets(records, 'd1', 1, { minShared: 5 }).length,
    0,
    'no other lineup shares all five'
  );
  // A seed with fewer players than the threshold cannot claim anything.
  demoSeq = 0;
  const thin = [demo({ nameA: null, nameB: 'Opp', a: ['q1', 'q2'], b: R(5, 60) })];
  assert.deepEqual(findRenameTargets(thin, 'd1', 1), [], 'a two-man seed claims nothing');
}

console.log('teamIdentity.test.js: placeholders, rosters, variants, filenames, restraint and rename targets all pass');
