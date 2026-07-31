// ---------------------------------------------------------------------------
// Attach stored demo roles onto aggregated player rows for Statistics.
// Role assignment itself runs on the backend (computeRoles.js + stats index).
// ---------------------------------------------------------------------------

import { roleForPlayer } from './computeRoles.js';

/**
 * Tactical role from map position counts across maps.
 * @param {{ awper: number, lurk: number, pack: number, rotation: number, anchor: number, maps: number }} counts
 * @param {'T'|'CT'} side
 */
export function tacticalFromCounts(counts, side) {
  const maps = counts.maps || 0;
  if (!maps) return '';
  if (counts.awper * 2 >= maps && counts.awper > 0) return 'AWPer';
  if (side === 'T') {
    if (counts.pack > counts.lurk) return 'Pack';
    if (counts.lurk > counts.pack) return 'Lurk';
    return counts.pack >= counts.lurk ? 'Pack' : 'Lurk';
  }
  if (counts.rotation > counts.anchor) return 'Rotation';
  if (counts.anchor > counts.rotation) return 'Anchor';
  return counts.rotation >= counts.anchor ? 'Rotation' : 'Anchor';
}

/**
 * For one demo on one map: read roles written by the stats index.
 * @param {object} demo  stats index entry
 * @param {object[]} rounds  filtered rounds belonging to this demo/map
 * @returns {{ T: Map<string, object>, CT: Map<string, object> }}
 */
export function assignDemoRoles(demo, rounds) {
  const map = rounds?.[0]?.m || demo?.map || '';
  const stored = demo?.roles?.maps?.[map];
  /** @type {{ T: Map<string, object>, CT: Map<string, object> }} */
  const out = { T: new Map(), CT: new Map() };
  if (!stored) return out;
  for (const side of ['T', 'CT']) {
    for (const [id, role] of Object.entries(stored[side] || {})) {
      out[side].set(id, role);
    }
  }
  return out;
}

/**
 * Attach role fields onto aggregated player rows for the stats table.
 *
 * @param {object[]} playerRows  from aggregatePlayers
 * @param {object} payload       stats payload
 * @param {object} filter        active filters (maps, …)
 * @returns {object[]} players with roleT, roleCT, posT, posCT
 */
export function attachPlayerRoles(playerRows, payload, filter = {}) {
  const singleMap = filter.maps?.length === 1 ? filter.maps[0] : '';
  /** playerId → { T: [], CT: [] } */
  const hist = new Map();
  const bump = (id, side, key, role) => {
    if (!hist.has(id)) hist.set(id, { T: [], CT: [] });
    hist.get(id)[side].push({ key, ...role });
  };

  for (const demo of payload?.demos || []) {
    let rounds = demo.rounds || [];
    if (filter.files?.length) rounds = rounds.filter((r) => filter.files.includes(r.f));
    if (filter.maps?.length) rounds = rounds.filter((r) => filter.maps.includes(r.m));
    if (!rounds.length) continue;

    const byMap = new Map();
    for (const r of rounds) {
      if (!byMap.has(r.m)) byMap.set(r.m, []);
      byMap.get(r.m).push(r);
    }
    for (const [map, mapRounds] of byMap) {
      if (singleMap && map !== singleMap) continue;
      const roles = assignDemoRoles(demo, mapRounds);
      for (const side of ['T', 'CT']) {
        for (const [id, role] of roles[side]) {
          bump(id, side, `${demo.id}:${map}`, role);
        }
      }
    }
  }

  const modeLabel = (entries, field) => {
    if (!entries?.length) return '';
    const counts = new Map();
    for (const e of entries) {
      const v = e[field];
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = '';
    let n = 0;
    for (const [k, c] of counts) {
      if (c > n) {
        best = k;
        n = c;
      }
    }
    return best;
  };

  return playerRows.map((p) => {
    const h = hist.get(p.id) || { T: [], CT: [] };
    if (singleMap) {
      return {
        ...p,
        posT: modeLabel(h.T, 'label'),
        posCT: modeLabel(h.CT, 'label'),
        roleT: modeLabel(h.T, 'tactical'),
        roleCT: modeLabel(h.CT, 'tactical'),
        roleMode: 'position'
      };
    }
    const tally = (side) => {
      const c = { awper: 0, lurk: 0, pack: 0, rotation: 0, anchor: 0, maps: 0 };
      const byMap = new Map();
      for (const e of h[side]) {
        const map = String(e.key).split(':')[1] || e.key;
        if (!byMap.has(map)) byMap.set(map, []);
        byMap.get(map).push(e);
      }
      for (const entries of byMap.values()) {
        const tac = modeLabel(entries, 'tactical');
        if (!tac) continue;
        c.maps++;
        if (tac === 'AWPer') c.awper++;
        else if (tac === 'Lurk' || tac === 'Lurker') c.lurk++;
        else if (tac === 'Pack') c.pack++;
        else if (tac === 'Anchor') c.anchor++;
        else if (tac === 'Rotation') c.rotation++;
      }
      return c;
    };
    return {
      ...p,
      posT: '',
      posCT: '',
      roleT: tacticalFromCounts(tally('T'), 'T'),
      roleCT: tacticalFromCounts(tally('CT'), 'CT'),
      roleMode: 'tactical'
    };
  });
}

/** True when any demo in the payload has computed roles. */
export function payloadHasRoles(payload) {
  for (const d of payload?.demos || []) {
    if (d.roles?.maps && Object.keys(d.roles.maps).length) return true;
  }
  return false;
}

/** Filter players by role / position chip. */
export function playerMatchesRoleFilter(p, roleFilter) {
  if (!roleFilter?.side || !roleFilter?.value) return true;
  const side = roleFilter.side;
  const want = roleFilter.value;
  if (p.roleMode === 'position') {
    const label = side === 'T' ? p.posT : p.posCT;
    const tac = side === 'T' ? p.roleT : p.roleCT;
    return label === want || tac === want;
  }
  const tac = side === 'T' ? p.roleT : p.roleCT;
  return tac === want;
}

export { roleForPlayer };
