// ---------------------------------------------------------------------------
// replays/eye/playerPatterns.js
// Each player of a team as a coach describes him: where he starts, whether he
// looks for early fights and where, whether he plays alone, when he rotates or
// lurks, what utility he throws and when, whether his deaths get traded and
// whether he trades, and what to do about it. Every habit carries "in X of N".
//
// The antistrat's player lines were a most-played position per side ("Banana
// 60%"), which says where he stands, not how he plays. A tool's "aggressive
// AWPer" came from opening duels alone, for a player who only takes safe
// angles and backs off when nobody can trade him. These read the rounds.
//
// Input: antistratScan roundFeatures (the scouted team's view: its players as
// `pts` every second), the map's zone network, and id -> name.
// ---------------------------------------------------------------------------

import { pointInPiece } from '../zones/zoneGeom.js';
import { clockText, placeIndex } from './roundStory.js';

/** Seconds into the round at which a player's starting spot is read. */
const START_AT = 20;
/** Seconds into the round at which "alone" is read. */
const ALONE_AT = 40;
/** Nearest living teammate farther than this (world units) is alone. */
const ALONE_UNITS = 1200;
/** A fight in the first this-many seconds is an early fight. */
const EARLY = 25;
/** A death avenged within this many seconds was traded. */
const TRADE = 5;
/** A teammate's death counts as his chance to trade only when he was this close (world units). */
const TRADE_RANGE = 1000;
/** A habit is written when it holds in at least this share of rounds, over MIN_ROUNDS. */
const HABIT = 0.4;
const MIN_ROUNDS = 3;

const NADE = { smokegrenade: 'smoke', molotov: 'molotov', incgrenade: 'molotov', flashbang: 'flash', hegrenade: 'HE' };
const bump = (m, k, by = 1) => k && m.set(k, (m.get(k) || 0) + by);
const top = (m, n = 2) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const of = (k, n) => `${k} of ${n}`;

function fresh() {
  return {
    rounds: 0,
    starts: new Map(),
    startZones: new Map(),
    alone: 0,
    early: 0,
    earlyAt: new Map(),
    openWon: 0,
    openLost: 0,
    died: 0,
    diedFirst: 0,
    traded: 0,
    tradeChances: 0,
    tradedMate: 0,
    nades: new Map(),
    nadeTimes: new Map(),
    allEarly: 0,
    utilRounds: 0,
    awp: 0,
    rotations: 0,
    rotateChances: 0,
    rotateSeconds: [],
    rotateEarly: 0,
    stayed: 0,
    lurk: 0,
    lurkAt: new Map(),
    files: []
  };
}

/**
 * @param {object[]} rounds  roundFeatures of one team on one map
 * @param {object} network
 * @param {{ nameOf?: Map<string,string>, side?: 'T'|'CT'|'both', player?: string, fullBuyOnly?: boolean }} [opts]
 */
export function playerPatterns(rounds, network, { nameOf = new Map(), side = 'both', player = '', fullBuyOnly = true } = {}) {
  const place = placeIndex(network);
  const zoneOf = (pos) => place.get(pos)?.zone || pos;
  const name = (id) => nameOf.get(id) || id;
  const wanted = String(player || '').trim().toLowerCase();
  const out = [];
  for (const s of side === 'both' ? ['T', 'CT'] : [side]) {
    const set = rounds.filter((r) => r.side === s && r.hasTicks && (!fullBuyOnly || r.ownEcon === 4));
    const per = new Map();
    for (const r of set) {
      const at = (sec) => r.sampleAt(r.t0 + sec * r.tickRate);
      const startS = at(START_AT);
      const aloneS = at(ALONE_AT);
      // T: our own entry. CT: the attackers' (the other team, `opp`), two of them on the site.
      const entry = s === 'T' ? r.siteEntry(2) : null;
      const target = s === 'T' ? r.plantSite || entry?.site || null : r.plantSite || r.hitSite || null;
      const commitS = entry ? r.sampleAt(entry.tick) : null;
      const theirEntry =
        s === 'CT' && target
          ? r.series.find((x) => x.opp.filter((q) => (r.sitePieces?.[target] || []).some((piece) => pointInPiece(q.x, q.y, piece))).length >= 2)?.elapsed ?? null
          : null;
      const plantT = r.plantClock != null ? 115 - r.plantClock : null;
      const firstOurDeath = r.kills.find((k) => k.victimOurs);
      for (const id of r.ourIds) {
        if (!per.has(id)) per.set(id, fresh());
        const p = per.get(id);
        p.rounds++;
        if (p.files.length < 40) p.files.push(r.file);
        const me = (sample) => sample?.pts.find((x) => x.id === id) || null;

        // Where he starts.
        const st = me(startS);
        if (st?.pos) {
          bump(p.starts, st.pos);
          bump(p.startZones, zoneOf(st.pos));
        }
        // Alone: nearest living teammate far away.
        const al = me(aloneS);
        if (al) {
          const near = Math.min(...aloneS.pts.filter((x) => x.id !== id).map((x) => Math.hypot(x.x - al.x, x.y - al.y)), Infinity);
          if (near > ALONE_UNITS) p.alone++;
        }
        if (me(at(30))?.awp) p.awp++;

        // Early fights: damage given or taken, or a kill or death, in the first EARLY seconds.
        const fight = r.damage.find((d) => (d.attacker === id || d.victim === id) && d.elapsed <= EARLY);
        const earlyKill = r.kills.find((k) => (k.attacker === id || k.victim === id) && 115 - k.clock <= EARLY);
        if (fight || earlyKill) {
          p.early++;
          const t = fight ? fight.elapsed : 115 - earlyKill.clock;
          const spot = me(at(Math.max(0, Math.round(t))))?.pos;
          bump(p.earlyAt, spot ? zoneOf(spot) : '');
        }

        // Opening duel.
        const first = r.kills[0];
        if (first?.attacker === id) p.openWon++;
        if (first?.victim === id) p.openLost++;

        // Deaths, and whether they were traded; teammates' deaths he traded.
        const death = r.kills.find((k) => k.victim === id);
        if (death) {
          p.died++;
          if (firstOurDeath === death) p.diedFirst++;
          if (r.kills.some((k) => k.attackerOurs && k.victim === death.attacker && k.clock <= death.clock && death.clock - k.clock <= TRADE)) p.traded++;
        }
        for (const d of r.kills.filter((k) => k.victimOurs && k.victim !== id)) {
          if (death && death.clock >= d.clock) continue;
          // Only a death he was near enough to answer.
          const before = r.sampleAt(d.tick - r.tickRate);
          const mePt = before?.pts.find((x) => x.id === id);
          const mate = before?.pts.find((x) => x.id === d.victim);
          // Height counts: on Nuke the sites are stacked, one above the other.
          const dz = Number.isFinite(mePt?.z) && Number.isFinite(mate?.z) ? mePt.z - mate.z : 0;
          if (!mePt || !mate || Math.hypot(mePt.x - mate.x, mePt.y - mate.y, dz) > TRADE_RANGE) continue;
          p.tradeChances++;
          if (r.kills.some((k) => k.attacker === id && k.victim === d.attacker && k.clock <= d.clock && d.clock - k.clock <= TRADE)) p.tradedMate++;
        }

        // Utility.
        const mine = r.nades.filter((n) => n.player === id);
        if (mine.length) p.utilRounds++;
        if (mine.length >= 2 && mine.every((n) => n.throwAt <= EARLY)) p.allEarly++;
        const seen = new Set();
        for (const n of mine) {
          const key = `${NADE[n.type] || n.type} ${n.label || n.zone || ''}`.trim();
          if (seen.has(key)) continue;
          seen.add(key);
          bump(p.nades, key);
          if (!p.nadeTimes.has(key)) p.nadeTimes.set(key, []);
          p.nadeTimes.get(key).push(n.throwAt);
        }

        // CT: rotations when the other site is hit. T: lurking when the team commits.
        if (s === 'CT' && target && st) {
          const home = r.siteNear(st.x, st.y);
          if (home && home !== target) {
            p.rotateChances++;
            const where = (x) => {
              const q = x.pts.find((y) => y.id === id);
              return q ? r.siteNear(q.x, q.y) : undefined;
            };
            const arrive = r.series.find((x) => x.elapsed > START_AT && where(x) === target);
            if (arrive) {
              p.rotations++;
              // When he left home: before the attackers were on the site, he went on information
              // (sound, utility), which a fake can give him.
              // The last second he was still home, so a walk around his own site earlier does not count.
              const lastHome = [...r.series].reverse().find((x) => x.elapsed < arrive.elapsed && where(x) === home);
              const left = lastHome ? r.series.find((x) => x.elapsed > lastHome.elapsed) : null;
              if (left && theirEntry != null) {
                p.rotateSeconds.push(theirEntry - left.elapsed);
                if (left.elapsed < theirEntry) p.rotateEarly++;
              }
            } else p.stayed++;
          }
        }
        if (s === 'T' && commitS && target) {
          const q = me(commitS);
          if (q && r.siteNear(q.x, q.y) !== target) {
            const near = Math.min(...commitS.pts.filter((x) => x.id !== id).map((x) => Math.hypot(x.x - q.x, x.y - q.y)), Infinity);
            if (near > ALONE_UNITS) {
              p.lurk++;
              bump(p.lurkAt, q.pos ? zoneOf(q.pos) : '');
            }
          }
        }
      }
    }

    for (const [id, p] of per) {
      const who = name(id);
      if (wanted && !who.toLowerCase().includes(wanted)) continue;
      if (p.rounds < MIN_ROUNDS) continue;
      const n = p.rounds;
      const lines = [];
      const counters = [];
      const habit = (k, base = n) => base >= MIN_ROUNDS && k / base >= HABIT;

      const zones = top(p.startZones, 2);
      if (zones.length) {
        const [z1, c1] = zones[0];
        const spots = top(new Map([...p.starts].filter(([pos]) => zoneOf(pos) === z1)), 2).map(([pos, c]) => `${pos} ${c}`).join(', ');
        lines.push(`Starts ${z1} in ${of(c1, n)} rounds (${spots})${zones[1] ? `, otherwise ${zones[1][0]} (${zones[1][1]})` : ''}.`);
      }
      if (habit(p.early)) {
        const [where] = top(p.earlyAt, 1);
        lines.push(`Looks for an early fight in ${of(p.early, n)} rounds${where?.[0] ? `, most often around ${where[0]}` : ''}.`);
        counters.push(`Expect him in the first ${EARLY} seconds${where?.[0] ? ` at ${where[0]}` : ''}: hold it with a crossfire or flash for a teammate rather than a dry peek.`);
      } else if (p.early <= n * 0.15) lines.push(`Rarely fights early (${of(p.early, n)} rounds): he waits for the round to come to him.`);
      if (habit(p.alone)) {
        lines.push(`Plays alone in ${of(p.alone, n)} rounds (no teammate within reach at ${clockText(115 - ALONE_AT)}).`);
        counters.push(s === 'CT' ? 'He is often the only one on his spot: a fast two- or three-man hit there meets him alone.' : 'He is often alone away from the team: catch him with two players and he cannot be traded.');
      }
      if (p.openWon + p.openLost >= MIN_ROUNDS) {
        lines.push(`Takes the opening duel in ${of(p.openWon + p.openLost, n)} rounds and wins ${of(p.openWon, p.openWon + p.openLost)}.`);
      }
      if (p.died >= MIN_ROUNDS) {
        const untraded = p.died - p.traded;
        lines.push(`Dies first for his team in ${of(p.diedFirst, n)} rounds; ${of(p.traded, p.died)} of his deaths are traded within ${TRADE} seconds.`);
        if (untraded / p.died >= 0.65 && p.diedFirst / n >= 0.25) counters.push('When he dies first, nobody trades him: kill him and the opening is free.');
      }
      if (p.tradeChances >= MIN_ROUNDS) {
        const share = p.tradedMate / p.tradeChances;
        if (share >= 0.25) lines.push(`Trades teammates well: he killed the killer within ${TRADE} seconds in ${of(p.tradedMate, p.tradeChances)} teammate deaths within reach of him.`);
        else if (share <= 0.08) lines.push(`Seldom trades: he killed the killer in ${of(p.tradedMate, p.tradeChances)} teammate deaths within reach of him.`);
      }
      const nades = top(p.nades, 3).filter(([, c]) => habit(c));
      for (const [key, c] of nades) {
        const t = median(p.nadeTimes.get(key));
        lines.push(`Throws the ${key} in ${of(c, n)} rounds, at about ${clockText(115 - t)}.`);
      }
      if (s === 'CT' && habit(p.allEarly, p.utilRounds)) {
        lines.push(`Uses all his utility in the first ${EARLY} seconds in ${of(p.allEarly, p.utilRounds)} rounds he threw any.`);
        counters.push('His utility is gone early: a slower hit on his spot meets no grenades from him.');
      }
      if (habit(p.awp)) lines.push(`Has the AWP in ${of(p.awp, n)} rounds.`);
      if (s === 'CT' && p.rotateChances >= MIN_ROUNDS) {
        const sec = median(p.rotateSeconds);
        if (habit(p.rotations, p.rotateChances)) {
          lines.push(`Rotates when the other site is hit in ${of(p.rotations, p.rotateChances)} rounds${p.rotateEarly ? `; in ${p.rotateEarly} he left before the attackers were on the site` : ''}${sec != null && Math.abs(sec) <= 40 ? ` (median: left ${Math.abs(Math.round(sec))} s ${sec >= 0 ? 'before' : 'after'} they got there)` : ''}.`);
          if (habit(p.rotateEarly, p.rotateChances)) counters.push('He leaves his site on information, before the attackers are on the other one: show utility or noise there, then hit his.');
        } else lines.push(`Stays on his site when the other is hit in ${of(p.stayed, p.rotateChances)} rounds.`);
      }
      if (s === 'T' && habit(p.lurk)) {
        const [where] = top(p.lurkAt, 1);
        lines.push(`Lurks away from the hit in ${of(p.lurk, n)} rounds${where?.[0] ? `, usually ${where[0]}` : ''}.`);
        counters.push(`Their hit comes with a lurker${where?.[0] ? ` in ${where[0]}` : ''}: keep someone watching it, or punish it with an aggressive check.`);
      }
      out.push({ player: who, side: s, rounds: n, how_he_plays: lines, how_to_play_him: counters, files: p.files });
    }
  }
  return out;
}
