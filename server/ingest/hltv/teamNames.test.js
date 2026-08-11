// Orientation: clan / VRS first, then match in-demo labels to HLTV filename names.

import {
  applyHltvTeams,
  nameAffinity,
  teamsFromDemoFilename
} from './teamNames.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function demoWith(side1, side2) {
  const players = [
    ...side1.players.map((p) => ({ ...p, team: 1 })),
    ...side2.players.map((p) => ({ ...p, team: 2 }))
  ];
  return {
    team1: { id: 'a', name: side1.teamName || side1.players[0]?.clanName || 'Team 1' },
    team2: { id: 'b', name: side2.teamName || side2.players[0]?.clanName || 'Team 2' },
    rounds: [{ players }]
  };
}

{
  assert(nameAffinity('NAVI', 'natus-vincere') === 80, 'navi alias');
  assert(nameAffinity('VP', 'virtus-pro') === 70 || nameAffinity('VP', 'virtus-pro') === 80, 'vp');
  assert(nameAffinity('G2', 'g2') === 100, 'exact');
  assert(nameAffinity('liquid', 'team-liquid') >= 50, 'liquid token');
  assert(nameAffinity('Team 1', 'mibr') === 0, 'generic ignored');
  assert(nameAffinity('cache', 'mibr') === 0, 'unrelated');
}

{
  const teams = teamsFromDemoFilename('mibr-vs-bestia-m1-cache.dem');
  assert(teams[0].slug === 'mibr' && teams[1].slug === 'bestia', 'filename teams');
  assert(teams[0].name && teams[1].name, 'display names');
}

{
  // No VRS roster hit (fake handles), but clan tags match filename names via alias.
  const demo = demoWith(
    { players: [{ name: 'p1', clanName: 'NAVI' }, { name: 'p2', clanName: 'NAVI' }] },
    { players: [{ name: 'p3', clanName: 'G2' }, { name: 'p4', clanName: 'G2' }] }
  );
  const r = applyHltvTeams(demo, [
    { slug: 'natus-vincere', name: 'Natus Vincere' },
    { slug: 'g2', name: 'G2' }
  ]);
  assert(r.applied, `should apply, got ${r.reason}`);
  assert(r.confidence === 'clan' || r.confidence === 'name', `confidence ${r.confidence}`);
  assert(demo.team1.name === 'Natus Vincere', `team1 ${demo.team1.name}`);
  assert(demo.team2.name === 'G2', `team2 ${demo.team2.name}`);
}

{
  // Swapped parser sides: filename order is A vs B, but parser has B on side 1.
  const demo = demoWith(
    { players: [{ name: 'x', clanName: 'BESTIA' }], teamName: 'BESTIA' },
    { players: [{ name: 'y', clanName: 'MIBR' }], teamName: 'MIBR' }
  );
  const r = applyHltvTeams(demo, teamsFromDemoFilename('mibr-vs-bestia-m2-inferno.dem'));
  assert(r.applied, `swapped should apply: ${r.reason}`);
  assert(demo.team1.name === 'BESTIA' || /bestia/i.test(demo.team1.name), `t1 ${demo.team1.name}`);
  assert(demo.team2.name === 'MIBR' || /mibr/i.test(demo.team2.name), `t2 ${demo.team2.name}`);
}

{
  // Ambiguous: both sides blank generics, cannot use filename alone.
  const demo = demoWith(
    { players: [{ name: 'a', clanName: '' }], teamName: 'Team 1' },
    { players: [{ name: 'b', clanName: '' }], teamName: 'Team 2' }
  );
  const r = applyHltvTeams(demo, teamsFromDemoFilename('liquid-vs-vitality-m1-nuke.dem'));
  assert(!r.applied, 'must not guess without a side label');
  assert(r.confidence === 'none', 'none');
}

console.log('teamNames: all assertions passed');
