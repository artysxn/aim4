// ---------------------------------------------------------------------------
// Assign T/CT map positions from zone presence, then tactical roles.
// ---------------------------------------------------------------------------

import { RK, T_POSITIONS, CT_POSITIONS } from './regionKeys.js';
import { sec } from './presenceFromTicks.js';

/**
 * Aggregate presence for one side's players over filtered rounds of one demo.
 * @returns {Map<string, {
 *   id: string,
 *   awpRounds: number,
 *   openEng: number,
 *   bananaBSite: number,
 *   tSpawnBanana: number,
 *   aps: number,
 *   apsMidA: number,
 *   bArea: number,
 *   topBanana: number,
 *   bSiteOrCt: number,
 *   aCorridor: number,
 *   bRelated: number,
 *   tbWhile: Map<string, number>
 * }>}
 */
export function aggregateSidePresence(rounds, playerIds, side, teamIndex, teamOf) {
  /** @type {Map<string, any>} */
  const acc = new Map();
  const seat = (id) => {
    let s = acc.get(id);
    if (!s) {
      s = {
        id,
        awpRounds: 0,
        openEng: 0,
        bananaBSite: 0,
        tSpawnBanana: 0,
        aps: 0,
        apsMidA: 0,
        bArea: 0,
        topBanana: 0,
        bSiteOrCt: 0,
        aCorridor: 0,
        bRelated: 0,
        /** @type {Map<string, number>} */
        tbWhile: new Map()
      };
      acc.set(id, s);
    }
    return s;
  };

  for (const id of playerIds) seat(id);

  for (const row of rounds) {
    const rowSide = teamIndex === 1 ? row.s1 : row.s2;
    if (rowSide !== side) continue;
    for (const id of playerIds) {
      const bag = row.z?.[id];
      if (!bag) continue;
      const s = seat(id);
      if (bag.awp) s.awpRounds++;
      if (row.ok === id || row.od === id) s.openEng++;

      const banana = sec(bag, RK.BANANA);
      const bSite = sec(bag, RK.B_SITE);
      const tSpawn = sec(bag, RK.T_SPAWN);
      const aps = sec(bag, RK.APS);
      const midLong = sec(bag, RK.MID_LONG);
      const aSite = sec(bag, RK.A_SITE);
      const topBanana = sec(bag, RK.TOP_BANANA);
      const bCt = sec(bag, RK.B_CT);

      // Round-presence counts (≥1s in region).
      if (banana + bSite > 0) s.bananaBSite++;
      if (tSpawn + banana > 0) s.tSpawnBanana++;
      if (aps > 0) s.aps++;
      if (aps + midLong + aSite > 0) s.apsMidA++;

      // Time sums (seconds ≈ samples).
      s.bArea += banana + bSite;
      s.topBanana += topBanana;
      s.bSiteOrCt += bSite + bCt;
      s.aCorridor += aSite + midLong + aps;
      s.bRelated += banana + bSite + topBanana + bCt;
    }

    // CT pair: top banana while mate on B Site / B CT.
    if (side === 'CT' && row.ctTB) {
      for (const [pair, n] of Object.entries(row.ctTB)) {
        const [watcher, anchor] = pair.split('>');
        if (!playerIds.includes(watcher) || !playerIds.includes(anchor)) continue;
        const s = seat(watcher);
        s.tbWhile.set(anchor, (s.tbWhile.get(anchor) || 0) + (n || 0));
      }
    }
  }

  return acc;
}

function pickMax(list, scoreFn, exclude = new Set()) {
  let best = null;
  let bestScore = -Infinity;
  for (const p of list) {
    if (exclude.has(p.id)) continue;
    const sc = scoreFn(p);
    if (sc > bestScore || (sc === bestScore && best && p.id < best.id)) {
      best = p;
      bestScore = sc;
    }
  }
  return best;
}

/**
 * Assign five T positions for one team's roster on one map.
 * @returns {Map<string, { position: string, label: string, tactical: string }>}
 */
export function assignTPositions(statsById) {
  const list = [...statsById.values()];
  /** @type {Map<string, { position: string, label: string, tactical: string }>} */
  const out = new Map();
  const taken = new Set();
  const set = (id, key) => {
    if (!id || taken.has(id)) return;
    const def = T_POSITIONS[key];
    out.set(id, { position: key, label: def.label, tactical: def.tactical });
    taken.add(id);
  };

  const awper = pickMax(list, (p) => p.awpRounds);
  if (awper) set(awper.id, 'awper');

  const bSite = pickMax(list, (p) => p.bananaBSite, taken);
  if (bSite) set(bSite.id, 'bSite');

  const aSite = pickMax(list, (p) => p.aps, taken);
  if (aSite) set(aSite.id, 'aSite');

  // B Rotation: #2 on T Spawn & Banana behind B Site (or best remaining on that metric).
  const byTSpawn = [...list].sort(
    (a, b) => b.tSpawnBanana - a.tSpawnBanana || a.id.localeCompare(b.id)
  );
  let bRot = null;
  for (const p of byTSpawn) {
    if (taken.has(p.id)) continue;
    if (awper && p.awpRounds >= awper.awpRounds && p.id !== awper.id) continue;
    bRot = p;
    break;
  }
  if (bRot) set(bRot.id, 'bRotation');

  const aRot = pickMax(list, (p) => p.apsMidA, taken);
  if (aRot) set(aRot.id, 'aRotation');

  // Any leftover (short roster / ties).
  for (const p of list) {
    if (!taken.has(p.id)) set(p.id, 'aRotation');
  }
  return out;
}

/**
 * Assign five CT positions.
 * @returns {Map<string, { position: string, label: string, tactical: string }>}
 */
export function assignCTPositions(statsById) {
  const list = [...statsById.values()];
  /** @type {Map<string, { position: string, label: string, tactical: string }>} */
  const out = new Map();
  const taken = new Set();
  const set = (id, key) => {
    if (!id || taken.has(id)) return;
    const def = CT_POSITIONS[key];
    out.set(id, { position: key, label: def.label, tactical: def.tactical });
    taken.add(id);
  };

  const awper = pickMax(list, (p) => p.awpRounds);
  if (awper) set(awper.id, 'awper');

  // Two B players: most time in B Site + Banana areas.
  const byB = [...list]
    .filter((p) => !taken.has(p.id))
    .sort((a, b) => b.bArea - a.bArea || a.id.localeCompare(b.id));
  const bDuo = byB.slice(0, 2);
  if (bDuo.length === 2) {
    const [x, y] = bDuo;
    const xWhileY = x.tbWhile.get(y.id) || 0;
    const yWhileX = y.tbWhile.get(x.id) || 0;
    // Aggro: more openings, and more Top Banana while mate on B Site/B CT.
    const xAggroScore = x.openEng * 1000 + xWhileY * 10 + x.topBanana;
    const yAggroScore = y.openEng * 1000 + yWhileX * 10 + y.topBanana;
    const xSiteScore = x.bSiteOrCt * 10 - x.openEng + (yWhileX > 0 ? 0 : 1);
    const ySiteScore = y.bSiteOrCt * 10 - y.openEng + (xWhileY > 0 ? 0 : 1);

    let aggro = x;
    let site = y;
    if (yAggroScore > xAggroScore || (yAggroScore === xAggroScore && ySiteScore < xSiteScore)) {
      aggro = y;
      site = x;
    }
    // Prefer site player to have more B Site/B CT time when openings are close.
    if (Math.abs(x.openEng - y.openEng) <= 1 && y.bSiteOrCt > x.bSiteOrCt + 5) {
      if (aggro.id === y.id) {
        aggro = x;
        site = y;
      }
    }
    set(aggro.id, 'bAggro');
    set(site.id, 'bSite');
  } else {
    for (const p of bDuo) set(p.id, 'bSite');
  }

  // A Site vs A Rotation among remaining (less-awping).
  const rest = list.filter((p) => !taken.has(p.id));
  const aSite = pickMax(rest, (p) => p.aCorridor * 100 - p.bRelated);
  if (aSite) set(aSite.id, 'aSite');
  const aRot = pickMax(list, (p) => -(p.aCorridor || 0), taken);
  // Prefer remaining player as A Rotation
  for (const p of list) {
    if (!taken.has(p.id)) set(p.id, 'aRotation');
  }
  if (aRot && !out.has(aRot.id)) set(aRot.id, 'aRotation');

  return out;
}

/**
 * Tactical role from map position counts across maps.
 * @param {{ awper: number, lurker: number, rotation: number, anchor: number, maps: number }} counts
 * @param {'T'|'CT'} side
 */
export function tacticalFromCounts(counts, side) {
  const maps = counts.maps || 0;
  if (!maps) return '';
  if (counts.awper * 2 >= maps && counts.awper > 0) return 'AWPer';
  if (side === 'T') {
    if (counts.rotation > counts.lurker) return 'Rotation';
    if (counts.lurker > counts.rotation) return 'Lurker';
    // tie → rotation if any, else lurker
    return counts.rotation >= counts.lurker ? 'Rotation' : 'Lurker';
  }
  if (counts.rotation > counts.anchor) return 'Rotation';
  if (counts.anchor > counts.rotation) return 'Anchor';
  return counts.rotation >= counts.anchor ? 'Rotation' : 'Anchor';
}

/**
 * For one demo on one map: assign T and CT positions for both teams.
 * Geography (painted regionKeys) path is disabled — returns empty until a
 * dynamic-cell role design lands.
 * @param {object} demo  stats index entry
 * @param {object[]} rounds  filtered rounds belonging to this demo
 * @returns {{ T: Map<string, object>, CT: Map<string, object> }}
 */
export function assignDemoRoles(_demo, _rounds) {
  return { T: new Map(), CT: new Map() };
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
  /** playerId → { T: Map<map|demo, role>, CT: ... } */
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

    // Group by map so a multi-map demo still works.
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
    // Cross-map tactical roles.
    const tally = (side) => {
      const c = { awper: 0, lurker: 0, rotation: 0, anchor: 0, maps: 0 };
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
        else if (tac === 'Lurker') c.lurker++;
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
