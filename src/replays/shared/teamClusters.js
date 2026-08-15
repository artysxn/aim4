// ---------------------------------------------------------------------------
// replays/shared/teamClusters.js
// Merge demo team appearances into searchable clusters (same name, or ≥3
// shared player steam/ids). Used by the library TEAM filter and the demos API.
// ---------------------------------------------------------------------------

/**
 * @param {object[]} demoList  demo records with team1/team2 + players
 * @returns {{ key: string, name: string, shortIds: string[] }[]}
 */
export function clusterTeams(demoList) {
  /** @type {{ shortId: string, name: string, players: Set<string> }[]} */
  const appearances = [];
  for (const d of demoList || []) {
    for (const side of [1, 2]) {
      const team = side === 1 ? d.team1 : d.team2;
      if (!team?.id) continue;
      const players = new Set();
      for (const p of d.players || []) {
        if (Number(p.team) !== side) continue;
        const key = p.steamId || p.id;
        if (key) players.add(String(key));
      }
      appearances.push({
        shortId: String(team.id),
        name: String(team.name || ''),
        players
      });
    }
  }
  if (!appearances.length) return [];

  const parent = appearances.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const byNormName = new Map();
  for (let i = 0; i < appearances.length; i++) {
    const norm = appearances[i].name.trim().toLowerCase();
    if (!norm) continue;
    if (byNormName.has(norm)) union(byNormName.get(norm), i);
    else byNormName.set(norm, i);
  }

  // Union appearances sharing >= 3 players, through an inverted index rather
  // than pairwise set intersection. The pairwise loop was O(n^2) over every
  // team appearance in the library and ran on EVERY listing request; at a few
  // thousand demos that is tens of millions of set probes inside the event
  // loop, which the perf panel showed as an 8-second p50 on /api/replays/demos.
  //
  // Same equivalence classes, provably: a pair reaches union() here exactly
  // when it shares 3 players, which is exactly when the old loop unioned it,
  // and union-find does not care in which order the unions arrive. Pairs that
  // share no player -- almost all of them -- are never visited at all.
  const byPlayer = new Map();
  for (let i = 0; i < appearances.length; i++) {
    // Fewer than 3 players can never reach 3 shared; keep them out of the
    // index so a lurker-only record does not fan out pairs for nothing.
    if (appearances[i].players.size < 3) continue;
    for (const p of appearances[i].players) {
      let list = byPlayer.get(p);
      if (!list) {
        list = [];
        byPlayer.set(p, list);
      }
      list.push(i);
    }
  }
  const sharedCounts = new Map();
  for (const list of byPlayer.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        // Already together -- usually via the name pass, which catches the
        // whole org in one union. Counting their remaining shared players
        // would be most of this loop's work for zero information.
        if (find(list[a]) === find(list[b])) continue;
        const key = list[a] * appearances.length + list[b];
        const seen = (sharedCounts.get(key) || 0) + 1;
        if (seen === 3) union(list[a], list[b]);
        sharedCounts.set(key, seen);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < appearances.length; i++) {
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = { shortIds: new Set(), nameCounts: new Map() };
      groups.set(root, g);
    }
    g.shortIds.add(appearances[i].shortId);
    const name = appearances[i].name.trim();
    if (name) g.nameCounts.set(name, (g.nameCounts.get(name) || 0) + 1);
  }

  const clusters = [];
  for (const g of groups.values()) {
    const shortIds = [...g.shortIds].sort();
    let bestName = shortIds[0];
    let bestCount = -1;
    for (const [name, count] of g.nameCounts) {
      if (count > bestCount || (count === bestCount && name.localeCompare(bestName) < 0)) {
        bestName = name;
        bestCount = count;
      }
    }
    clusters.push({
      key: shortIds.join('|'),
      name: bestName || shortIds[0],
      shortIds
    });
  }
  clusters.sort((a, b) => a.name.localeCompare(b.name));
  return clusters;
}
