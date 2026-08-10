// ---------------------------------------------------------------------------
// scripts/lib/rating3Rows.mjs
// Build stats-index-shaped round rows from .aim4replay packages.
//
// The Rating 3.0 trainer has to see exactly what the site sees, or the fitted
// constants end up calibrated against inputs production does not have. So this
// reproduces the row fields statsIndex writes (`kt`, `ev`, `p`, `ok`, `od`,
// `w`, `s1`/`s2`, `e1`/`e2`, `n`) and nothing else: the trainer and the live
// rating then run over the same numbers.
//
// Node-only.
// ---------------------------------------------------------------------------

import { timingFor } from '../../src/replays/viewer/roundClock.js';
import { cappedDamageFromMeta, playerRoundDamage } from '../../src/replays/shared/roundDamage.js';

const NOT_A_GUN =
  /grenade|molotov|incgrenade|firebomb|inferno|decoy|flash|knife|bayonet|karambit|c4|world|taser|zeus/i;

const isGun = (weapon) => {
  const w = String(weapon || '').trim().toLowerCase().replace(/^weapon_/, '');
  return Boolean(w) && !NOT_A_GUN.test(w);
};

/** A death counts as traded when the killer dies inside this window. */
const TRADE_SECONDS = 5;

/**
 * One round meta -> one index-shaped row.
 * @param {object} meta   round meta from the package
 * @param {Array<{id: string, name: string, team: number}>} roster
 * @param {Map<string, number>} teamOf  player id -> team
 */
export function rowFromMeta(meta, roster, teamOf) {
  const kills = [...(meta.events?.kills || [])].sort((a, b) => (a.tick || 0) - (b.tick || 0));

  let ok = '';
  let od = '';
  for (const k of kills) {
    const at = teamOf.get(k.attacker);
    const vt = teamOf.get(k.victim);
    if (!at || !vt || at === vt) continue;
    ok = k.attacker;
    od = k.victim;
    break;
  }

  const victims = new Set(kills.map((k) => k.victim).filter(Boolean));
  const rate = meta.tickRate || 64;
  const window = TRADE_SECONDS * rate;
  const traded = new Set();
  for (const k of kills) {
    if (!k.attacker || !k.victim) continue;
    const avenged = kills.some(
      (o) => o.victim === k.attacker && o.tick > k.tick && o.tick - k.tick <= window
    );
    if (avenged) traded.add(k.victim);
  }

  const timing = timingFor(meta || {});
  const tr = timing.tickRate || 64;
  const secondsAt = (tick) => Math.round((((tick || 0) - timing.freezeEndTick) / tr) * 10) / 10;

  const capped = cappedDamageFromMeta(meta, teamOf);

  const p = {};
  const ev = {};
  for (const pl of roster) {
    const st = meta.stats?.[pl.id] || {};
    const line = new Array(10).fill(0);
    line[0] = st.kills || 0;
    line[1] = st.deaths || 0;
    line[2] = st.assists || 0;
    line[3] = playerRoundDamage(capped, pl.id, st.damage);
    line[4] = st.gunShots ?? 0;
    line[5] = st.hits || 0;
    line[6] = st.headshots || 0;
    const survived = !victims.has(pl.id);
    line[9] = line[0] > 0 || line[2] > 0 || survived || traded.has(pl.id) ? 1 : 0;
    p[pl.id] = line;
    const value = Number(st.equipValue);
    if (Number.isFinite(value) && value >= 0) ev[pl.id] = Math.round(value);
  }

  return {
    n: meta.round || 0,
    w: meta.winner === 2 ? 2 : 1,
    s1: meta.team1Side || 'T',
    s2: meta.team2Side || 'CT',
    e1: meta.econ1 ?? 0,
    e2: meta.econ2 ?? 0,
    ok,
    od,
    p,
    ev,
    kt: kills
      .filter((k) => k.attacker || k.victim)
      .map((k) => ({
        t: secondsAt(k.tick),
        a: k.attacker || '',
        v: k.victim || '',
        h: k.headshot ? 1 : 0,
        g: isGun(k.weapon) ? 1 : 0,
        w: String(k.weapon || '').toLowerCase().replace(/^weapon_/, '')
      })),
    sw: null
  };
}

/** Every package's rows plus its roster, in a stable order. */
export async function packageRows(pkg) {
  const roster = (pkg.manifest.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team
  }));
  const teamOf = new Map(roster.map((p) => [p.id, p.team]));
  const rows = [];
  for (const entry of pkg.rounds) {
    const { meta } = pkg.readRound(entry);
    rows.push(rowFromMeta(meta, roster, teamOf));
  }
  return { roster, teamOf, rows };
}
