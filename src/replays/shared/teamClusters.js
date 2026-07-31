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

  for (let i = 0; i < appearances.length; i++) {
    for (let j = i + 1; j < appearances.length; j++) {
      if (find(i) === find(j)) continue;
      const a = appearances[i].players;
      const b = appearances[j].players;
      if (a.size < 3 || b.size < 3) continue;
      let shared = 0;
      for (const p of a) {
        if (b.has(p)) {
          shared++;
          if (shared >= 3) {
            union(i, j);
            break;
          }
        }
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
