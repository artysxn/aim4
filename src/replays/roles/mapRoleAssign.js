// ---------------------------------------------------------------------------
// Map-specific T/CT role assignment from painted-zone presence.
// AWPer is chosen the same way as the generic assigner (most AWP rounds).
// ---------------------------------------------------------------------------

import { zoneScore } from './mapRoleZones.js';

function awpScore(p, side) {
  if (side === 'T') {
    return p.tAwpRounds * 1e6 + p.tAwpKills * 1e3 + p.tAwpShots;
  }
  return p.ctAwpRounds * 1e6 + p.ctAwpKills * 1e3 + p.ctAwpShots;
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

function bag(p, side) {
  return side === 'T' ? p.zoneHitsT || {} : p.zoneHitsCT || {};
}

function place(out, id, key, side, setRole) {
  setRole(out, id, key, side);
}

function takeAwper(list, side, out, taken, setRole) {
  const awper = pickMax(list, (p) => awpScore(p, side));
  if (awper && awpScore(awper, side) > 0) {
    place(out, awper.id, 'awper', side, setRole);
    taken.add(awper.id);
  }
}

function remaining(list, taken) {
  return list.filter((p) => !taken.has(p.id));
}

function fillLeftovers(list, out, side, setRole, fallbackKey) {
  for (const p of list) {
    if (!out[p.id]) place(out, p.id, fallbackKey, side, setRole);
  }
}

function splitTwo(rest, out, side, setRole, scoreA, keyA, keyB) {
  if (rest.length >= 2) {
    const a = pickMax(rest, scoreA);
    const b = rest.find((p) => p.id !== a?.id) || null;
    if (a) place(out, a.id, keyA, side, setRole);
    if (b) place(out, b.id, keyB, side, setRole);
  } else if (rest.length === 1) {
    place(out, rest[0].id, keyA, side, setRole);
  }
}

// ---- Inferno --------------------------------------------------------------

function assignInfT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  // Banana: most Banana, least T Aps + 2nd mid.
  const banana = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return zoneScore(b, 'banana', 'bBanana') * 1e3 - zoneScore(b, 'tAps', 'secondMid');
  });
  if (banana) {
    place(out, banana.id, 'banana', 'T', setRole);
    taken.add(banana.id);
    rest = remaining(list, taken);
  }

  // A Lurk: most Pit+A + T Aps + 2nd mid.
  const aLurk = pickMax(rest, (p) => zoneScore(bag(p, 'T'), 'pitA', 'tAps', 'secondMid'));
  if (aLurk) {
    place(out, aLurk.id, 'aLurk', 'T', setRole);
    taken.add(aLurk.id);
    rest = remaining(list, taken);
  }

  // Pack: 2nd Mid (more 2nd mid / T Aps) vs Ramp (more Ramp + Banana).
  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => zoneScore(bag(p, 'T'), 'secondMid', 'tAps'),
    'secondMid',
    'ramp'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignInfCT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  const aAnchor = pickMax(rest, (p) => zoneScore(bag(p, 'CT'), 'pitA'));
  if (aAnchor) {
    place(out, aAnchor.id, 'aAnchor', 'CT', setRole);
    taken.add(aAnchor.id);
    rest = remaining(list, taken);
  }

  const aRot = pickMax(rest, (p) => zoneScore(bag(p, 'CT'), 'pitA', 'midA', 'ctLong'));
  if (aRot) {
    place(out, aRot.id, 'aRotation', 'CT', setRole);
    taken.add(aRot.id);
    rest = remaining(list, taken);
  }

  // B Anchor: more B Site + Banana; B Rotation: the other.
  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => zoneScore(bag(p, 'CT'), 'bSite', 'bBanana', 'banana'),
    'bAnchor',
    'bRotation'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

// ---- Dust2 ----------------------------------------------------------------

function assignDd2T(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  // B Upper: most B Tunnels, least everywhere else.
  const bUpper = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    const tunnels = zoneScore(b, 'bTunnels');
    const other = zoneScore(b, 'tLong', 'tMid', 'tSpawn', 'aLong', 'aShort', 'ctMid', 'aSite');
    return tunnels * 1e3 - other;
  });
  if (bUpper) {
    place(out, bUpper.id, 'bUpper', 'T', setRole);
    taken.add(bUpper.id);
    rest = remaining(list, taken);
  }

  // A Long: most A Long, strong T Long.
  const aLong = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return zoneScore(b, 'aLong') * 1e3 + zoneScore(b, 'tLong');
  });
  if (aLong) {
    place(out, aLong.id, 'aLong', 'T', setRole);
    taken.add(aLong.id);
    rest = remaining(list, taken);
  }

  // T Mid vs B Lower.
  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => {
      const b = bag(p, 'T');
      return zoneScore(b, 'tMid') * 1e3 + zoneScore(b, 'tSpawn', 'tLong');
    },
    'tMid',
    'bLower'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignDd2CT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  const aLong = pickMax(rest, (p) => zoneScore(bag(p, 'CT'), 'aLong', 'aCt'));
  if (aLong) {
    place(out, aLong.id, 'aLong', 'CT', setRole);
    taken.add(aLong.id);
    rest = remaining(list, taken);
  }

  const aShort = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'aLong', 'aCt') + zoneScore(b, 'aSite', 'aShort') * 2;
  });
  if (aShort) {
    place(out, aShort.id, 'aShort', 'CT', setRole);
    taken.add(aShort.id);
    rest = remaining(list, taken);
  }

  // B Anchor: most B Site; B Mid: most CT Mid among the pair (assigned as other).
  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => zoneScore(bag(p, 'CT'), 'bSite'),
    'bAnchor',
    'bMid'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

// ---- Anubis ---------------------------------------------------------------

function assignAnuT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  const aLurk = pickMax(rest, (p) => zoneScore(bag(p, 'T'), 'aWater', 'aSite'));
  if (aLurk) {
    place(out, aLurk.id, 'aLurk', 'T', setRole);
    taken.add(aLurk.id);
    rest = remaining(list, taken);
  }

  const bLurk = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return zoneScore(b, 'tSpawnBMain', 'bSite') * 1e3 + zoneScore(b, 'tMid');
  });
  if (bLurk) {
    place(out, bLurk.id, 'bLurk', 'T', setRole);
    taken.add(bLurk.id);
    rest = remaining(list, taken);
  }

  // Mid vs Water.
  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => zoneScore(bag(p, 'T'), 'tMid', 'aMid'),
    'packMid',
    'water'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignAnuCT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  const aAnchor = pickMax(rest, (p) => zoneScore(bag(p, 'CT'), 'aSite'));
  if (aAnchor) {
    place(out, aAnchor.id, 'aAnchor', 'CT', setRole);
    taken.add(aAnchor.id);
    rest = remaining(list, taken);
  }

  const mid = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'aMid') * 1e3 + zoneScore(b, 'aSite', 'ctSpawn');
  });
  if (mid) {
    place(out, mid.id, 'mid', 'CT', setRole);
    taken.add(mid.id);
    rest = remaining(list, taken);
  }

  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => zoneScore(bag(p, 'CT'), 'bSite'),
    'bSite',
    'bCon'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

// ---- Cache ----------------------------------------------------------------

function assignCchT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  const aLurk = pickMax(rest, (p) => zoneScore(bag(p, 'T'), 'tA'));
  if (aLurk) {
    place(out, aLurk.id, 'aLurk', 'T', setRole);
    taken.add(aLurk.id);
    rest = remaining(list, taken);
  }

  const bLurk = pickMax(rest, (p) => zoneScore(bag(p, 'T'), 'tB'));
  if (bLurk) {
    place(out, bLurk.id, 'bLurk', 'T', setRole);
    taken.add(bLurk.id);
    rest = remaining(list, taken);
  }

  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => zoneScore(bag(p, 'T'), 'tMid', 'ctMid'),
    'packMid',
    'packRotation'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignCchCT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  const aAnchor = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'aSite', 'tA') * 1e3 + zoneScore(b, 'ctMid');
  });
  if (aAnchor) {
    place(out, aAnchor.id, 'aAnchor', 'CT', setRole);
    taken.add(aAnchor.id);
    rest = remaining(list, taken);
  }

  const mid = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'ctMid') * 1e3 + zoneScore(b, 'aSite', 'bCheckers');
  });
  if (mid) {
    place(out, mid.id, 'mid', 'CT', setRole);
    taken.add(mid.id);
    rest = remaining(list, taken);
  }

  // B Anchor: most B Site (+ Checkers); B Rotation: other (more CT Mid lean).
  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => {
      const b = bag(p, 'CT');
      return zoneScore(b, 'bSite') * 1e3 + zoneScore(b, 'bCheckers') - zoneScore(b, 'ctMid');
    },
    'bAnchor',
    'bRotation'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

// ---- Ancient --------------------------------------------------------------

function assignAncT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  // B Lurk: most B Ramp; also B Street + T Spawn.
  const bLurk = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return zoneScore(b, 'bRamp') * 1e3 + zoneScore(b, 'bStreet', 'tSpawn');
  });
  if (bLurk) {
    place(out, bLurk.id, 'bLurk', 'T', setRole);
    taken.add(bLurk.id);
    rest = remaining(list, taken);
  }

  // A Lurk: most A Main; also T Mid.
  const aLurk = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return zoneScore(b, 'aMain') * 1e3 + zoneScore(b, 'tMid');
  });
  if (aLurk) {
    place(out, aLurk.id, 'aLurk', 'T', setRole);
    taken.add(aLurk.id);
    rest = remaining(list, taken);
  }

  // Pack: Mid vs Street.
  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => {
      const b = bag(p, 'T');
      return zoneScore(b, 'tMid', 'ctMid') * 1e3 + zoneScore(b, 'aMain');
    },
    'packMid',
    'street'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignAncCT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  // B Site: most B Site.
  const bSite = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'bSite') * 1e3 + zoneScore(b, 'bRamp', 'bCave');
  });
  if (bSite) {
    place(out, bSite.id, 'bSite', 'CT', setRole);
    taken.add(bSite.id);
    rest = remaining(list, taken);
  }

  // B Cave: most B Cave.
  const bCave = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'bCave') * 1e3 + zoneScore(b, 'bSite', 'bStreet');
  });
  if (bCave) {
    place(out, bCave.id, 'bCave', 'CT', setRole);
    taken.add(bCave.id);
    rest = remaining(list, taken);
  }

  // Mid / A vs Mid: both CT Mid + Donut + A Site; Mid / A has more A Site + CT Spawn.
  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => {
      const b = bag(p, 'CT');
      return (
        zoneScore(b, 'aSite', 'ctSpawn') * 1e3 + zoneScore(b, 'ctMid', 'ctDonut', 'aSite')
      );
    },
    'midA',
    'mid'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

// ---- Mirage ---------------------------------------------------------------

function assignMirT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  // A Lurk: most T A; sometimes T Spawn / A Site.
  const aLurk = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return zoneScore(b, 'tA') * 1e3 + zoneScore(b, 'tSpawn', 'aSite');
  });
  if (aLurk) {
    place(out, aLurk.id, 'aLurk', 'T', setRole);
    taken.add(aLurk.id);
    rest = remaining(list, taken);
  }

  // B / UG: most Underground; often T Spawn, B Aps, Mid, T Mid.
  const bUg = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return (
      zoneScore(b, 'underground') * 1e3 + zoneScore(b, 'tSpawn', 'bAps', 'mid', 'tMid')
    );
  });
  if (bUg) {
    place(out, bUg.id, 'bUg', 'T', setRole);
    taken.add(bUg.id);
    rest = remaining(list, taken);
  }

  // Mid: most T Mid among remaining; Rotation is leftover.
  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => {
      const b = bag(p, 'T');
      return zoneScore(b, 'tMid') * 1e3 + zoneScore(b, 'mid', 'bShort', 'aJungle', 'tSpawn');
    },
    'packMid',
    'packRotation'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignMirCT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  // B Anchor: most B Site + B Aps.
  const bAnchor = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'bSite', 'bAps') * 1e3 + zoneScore(b, 'bShort', 'bKitchen');
  });
  if (bAnchor) {
    place(out, bAnchor.id, 'bAnchor', 'CT', setRole);
    taken.add(bAnchor.id);
    rest = remaining(list, taken);
  }

  // A Anchor: most A Site + CT Spawn.
  const aAnchor = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return zoneScore(b, 'aSite', 'ctSpawn') * 1e3 + zoneScore(b, 'aJungle', 'tA');
  });
  if (aAnchor) {
    place(out, aAnchor.id, 'aAnchor', 'CT', setRole);
    taken.add(aAnchor.id);
    rest = remaining(list, taken);
  }

  // B Short vs A Con.
  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => {
      const b = bag(p, 'CT');
      return zoneScore(b, 'bShort') * 1e3 + zoneScore(b, 'aJungle', 'mid', 'bSite');
    },
    'bShort',
    'aCon'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

// ---- Nuke -----------------------------------------------------------------

function assignNukT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'T', out, taken, setRole);
  let rest = remaining(list, taken);

  // Lobby: most Lobby.
  const lobby = pickMax(rest, (p) => zoneScore(bag(p, 'T'), 'lobby'));
  if (lobby) {
    place(out, lobby.id, 'lobby', 'T', setRole);
    taken.add(lobby.id);
    rest = remaining(list, taken);
  }

  // 2nd Yard: most Silo out of anyone remaining.
  const second = pickMax(rest, (p) => {
    const b = bag(p, 'T');
    return (
      zoneScore(b, 'silo') * 1e3 +
      zoneScore(b, 'lobby', 'tYard', 'yard', 'ctYard', 'secret')
    );
  });
  if (second) {
    place(out, second.id, 'secondYard', 'T', setRole);
    taken.add(second.id);
    rest = remaining(list, taken);
  }

  // 1st Yard vs Rotation.
  splitTwo(
    rest,
    out,
    'T',
    setRole,
    (p) => {
      const b = bag(p, 'T');
      return zoneScore(b, 'tYard', 'yard') * 1e3 + zoneScore(b, 'ctYard', 'secret');
    },
    'firstYard',
    'packRotation'
  );

  fillLeftovers(list, out, 'T', setRole, 'pack');
  return out;
}

function assignNukCT(list, setRole) {
  const out = {};
  const taken = new Set();
  takeAwper(list, 'CT', out, taken, setRole);
  let rest = remaining(list, taken);

  // A Site: most A Anchor zone.
  const aSite = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return (
      zoneScore(b, 'aAnchor') * 1e3 + zoneScore(b, 'aDoor', 'ctHeaven', 'ctHell')
    );
  });
  if (aSite) {
    place(out, aSite.id, 'aSiteNuke', 'CT', setRole);
    taken.add(aSite.id);
    rest = remaining(list, taken);
  }

  // A Door: most A Door.
  const aDoor = pickMax(rest, (p) => {
    const b = bag(p, 'CT');
    return (
      zoneScore(b, 'aDoor') * 1e3 +
      zoneScore(b, 'lobby', 'ctYard', 'aAnchor', 'ctHeaven', 'ctHell')
    );
  });
  if (aDoor) {
    place(out, aDoor.id, 'aDoor', 'CT', setRole);
    taken.add(aDoor.id);
    rest = remaining(list, taken);
  }

  // Ramp vs Outside (Yard).
  splitTwo(
    rest,
    out,
    'CT',
    setRole,
    (p) => {
      const b = bag(p, 'CT');
      return zoneScore(b, 'ramp') * 1e3 + zoneScore(b, 'ctHeaven', 'ctHell');
    },
    'ramp',
    'outside'
  );

  fillLeftovers(list, out, 'CT', setRole, 'rotation');
  return out;
}

/**
 * @param {string} mapCode
 * @param {object[]} list
 * @param {'T'|'CT'} side
 * @param {(out: object, id: string, key: string, side: 'T'|'CT') => void} setRole
 * @returns {Record<string, object>|null} null when map has no custom rules
 */
export function assignMapRoles(mapCode, list, side, setRole) {
  const map = String(mapCode || '').toUpperCase();
  if (side === 'T') {
    if (map === 'INF') return assignInfT(list, setRole);
    if (map === 'DD2') return assignDd2T(list, setRole);
    if (map === 'ANU') return assignAnuT(list, setRole);
    if (map === 'CCH') return assignCchT(list, setRole);
    if (map === 'ANC') return assignAncT(list, setRole);
    if (map === 'MIR') return assignMirT(list, setRole);
    if (map === 'NUK') return assignNukT(list, setRole);
  } else {
    if (map === 'INF') return assignInfCT(list, setRole);
    if (map === 'DD2') return assignDd2CT(list, setRole);
    if (map === 'ANU') return assignAnuCT(list, setRole);
    if (map === 'CCH') return assignCchCT(list, setRole);
    if (map === 'ANC') return assignAncCT(list, setRole);
    if (map === 'MIR') return assignMirCT(list, setRole);
    if (map === 'NUK') return assignNukCT(list, setRole);
  }
  return null;
}
