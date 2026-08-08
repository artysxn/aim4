// ---------------------------------------------------------------------------
// A stand-in for one round's facts, for the round library tests.
//
// Ground is described as intervals — "this player is inside these names from
// second a to second b" — and every predicate the definitions use is answered
// off that one list. Points carry their name set in `x`, which is what lets
// the definitions that reach for `regions.inside` directly work unchanged.
//
// Names are compared exactly, so `pos:B Ramp` and `B Ramp` are different
// ground here. That is deliberate: it is the only way to write a test for a
// definition that depends on the distinction.
//
// Test-only. Nothing in the app imports this.
// ---------------------------------------------------------------------------

/** The last second of the fake round. Long enough for any definition. */
export const LAST_SEC = 100;

/**
 * One side of a fake round.
 *
 * @param {'T'|'CT'} side
 * @param {object} spec
 * @param {Array<{id: string, names: string[], from?: number, to?: number}>} [spec.stays]
 * @param {string[]} [spec.enemies]  ids in `stays` that belong to the other side
 * @param {Array<object>} [spec.nades]
 * @param {Array<object>} [spec.fights]
 * @param {string[]} [spec.awp]
 */
export function fakeSide(side, spec = {}) {
  const stays = (spec.stays || []).map((s) => ({ from: 0, to: LAST_SEC, ...s }));
  const enemies = new Set(spec.enemies || []);
  // Ground lives in this table; a point or a detonation carries its index in
  // `x`, so the real `regions.inside(names, x, y, z)` signature still answers.
  const table = [];
  const nades = (spec.nades || []).map((n) => {
    const nade = {
      type: 'smokegrenade',
      name: '',
      spot: '',
      player: '',
      names: [],
      from: [],
      at: 0,
      ...n,
      thrown: n.thrown ?? n.at ?? 0
    };
    // A detonation is a point too: the definitions that ask where a grenade
    // landed go through regions.inside just like the ones that ask about feet.
    nade.x = table.push(nade.names) - 1;
    nade.y = 0;
    nade.z = 0;
    return nade;
  });
  const fights = (spec.fights || []).map((x) => ({
    gun: true,
    kill: false,
    killedThem: false,
    ours: 'us',
    enemy: 'them',
    ...x
  }));
  const awp = new Set(spec.awp || []);

  const series = Array.from({ length: LAST_SEC + 1 }, (_, i) => ({ sec: i, pts: [] }));
  const ourIds = [...new Set(stays.map((s) => s.id))].filter((id) => !enemies.has(id));

  const namesAt = (id, sec) => {
    const out = [];
    for (const s of stays) {
      if (s.id !== id || sec < s.from || sec > s.to) continue;
      out.push(...s.names);
    }
    return out;
  };

  const pointFor = (id, sec) => {
    const names = namesAt(id, sec);
    if (!names.length) return null;
    return { id, side, x: table.push(names) - 1, y: 0, z: 0, awp: awp.has(id) };
  };
  const inside = (want, x) => {
    const has = table[x] || [];
    const list = Array.isArray(want) ? want : [want];
    return has.some((n) => list.includes(n));
  };

  const ptsAt = (sec) => ourIds.map((id) => pointFor(id, sec)).filter(Boolean);
  const playersIn = (names, sec) =>
    new Set(ptsAt(sec).filter((p) => inside(names, p.x)).map((p) => p.id));
  const pointAt = (id, sec) => pointFor(id, sec);

  const f = {
    side,
    ids: ourIds,
    lastSec: LAST_SEC,
    nades,
    series,
    regions: { inside: (names, x) => inside(names, x), insideSite: () => false, stacked: false },
    ptsAt,
    pointAt,
    playersIn,
    countIn: (names, sec) => playersIn(names, sec).size,
    playersDuring(names, from, to) {
      const out = new Set();
      for (let sec = Math.max(0, from); sec <= Math.min(LAST_SEC, to); sec++) {
        for (const id of playersIn(names, sec)) out.add(id);
      }
      return out;
    },
    playersLower: () => new Set(),
    playersInSite: () => new Set(),
    transitions(fromNames, toNames, { from = 0, to = LAST_SEC } = {}) {
      const seen = new Map();
      const done = new Map();
      for (let sec = Math.max(0, from); sec <= Math.min(LAST_SEC, to); sec++) {
        for (const p of ptsAt(sec)) {
          if (inside(fromNames, p.x)) {
            if (!done.has(p.id)) seen.set(p.id, sec);
            continue;
          }
          if (!seen.has(p.id) || done.has(p.id)) continue;
          if (inside(toNames, p.x)) {
            done.set(p.id, { id: p.id, leftAt: seen.get(p.id), arrivedAt: sec });
          }
        }
      }
      return [...done.values()].sort((a, b) => a.arrivedAt - b.arrivedAt);
    },
    cluster: () => null,
    firstSecWith(names, min, from = 0, to = LAST_SEC) {
      for (let sec = Math.max(0, from); sec <= Math.min(LAST_SEC, to); sec++) {
        if (playersIn(names, sec).size >= min) return sec;
      }
      return null;
    },
    aliveCount: () => 5,
    nadesIn: (type, names) =>
      nades.filter(
        (n) => (!type || n.type === type) && n.names.some((x) => names.includes(x))
      ),
    nadesFrom: (type, names) =>
      nades.filter((n) => (!type || n.type === type) && n.from.some((x) => names.includes(x))),
    nadesNotIn: (type, names) =>
      nades.filter(
        (n) => (!type || n.type === type) && !n.names.some((x) => names.includes(x))
      ),
    nadesNamed: (name) => nades.filter((n) => n.name === String(name).toLowerCase()),
    // A spec may set `spot` explicitly; a named grenade is always on its own
    // spot, which is what makes "a decoy where the smoke goes" expressible.
    nadesAtSpot: (name) =>
      nades.filter((n) => (n.spot || n.name) === String(name).toLowerCase()),
    fights({ from = 0, to = LAST_SEC, enemyIn = null, ours = null, gunOnly = false, killsOnly = false } = {}) {
      return fights.filter((x) => {
        if (x.sec < from || x.sec > to) return false;
        if (gunOnly && !x.gun) return false;
        if (killsOnly && !x.kill) return false;
        if (ours && !ours.has(x.ours)) return false;
        if (enemyIn) {
          const at = pointAt(x.enemy, x.sec);
          if (!at || !inside(enemyIn, at.x)) return false;
        }
        return true;
      });
    },
    awper: () => [...awp][0] || '',
    heldAwp: (id) => awp.has(id),
    deathSec: (id) => (id in (spec.deaths || {}) ? spec.deaths[id] : null),
    deaths: Object.values(spec.deaths || {}).sort((a, b) => a - b)
  };
  return f;
}

/** One round: our side, with the other side reachable through `enemy`. */
export function fakeRound(side, spec = {}, enemySpec = {}) {
  const f = fakeSide(side, spec);
  const other = fakeSide(side === 'T' ? 'CT' : 'T', enemySpec);
  f.enemy = other;
  other.enemy = f;
  return f;
}
