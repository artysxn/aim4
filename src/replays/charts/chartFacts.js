// ---------------------------------------------------------------------------
// replays/charts/chartFacts.js
// Flattens the stats index into the three fact tables the chart builder plots:
//
//   playerFacts  one player, one round   (every player metric aggregates here)
//   roundFacts   one team, one round     (team / round / match / map subjects)
//   killFacts    one kill                (anything resolved in round time)
//
// Every fact carries the full round context (map, side, both buys, result,
// opening duel, both teams) so a single filter predicate works on all three
// and so no chart ever has to reopen a round file.
// ---------------------------------------------------------------------------

import { P } from '../shared/statsMath.js';
import { buyBucket, econHasAwp } from '../shared/roundId.js';

/** Clock-based phase cuts, in live seconds after freeze end. */
export const PHASE_CUTS = { earlyEnd: 40, lateStart: 75 };

export function phaseAtSeconds(t) {
  if (!Number.isFinite(t)) return '';
  if (t < PHASE_CUTS.earlyEnd) return 'early';
  if (t < PHASE_CUTS.lateStart) return 'mid';
  return 'late';
}

/** Same normalization the stats tables use, so team rows merge across demos. */
function teamNameKey(name, shortId = '') {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm || norm === 'team 1' || norm === 'team 2') return shortId || norm || '';
  return norm;
}

const numOrNull = (v) => (Number.isFinite(v) ? v : null);

function phaseLine(bag, phase) {
  const line = bag?.[phase]?.p;
  return Array.isArray(line) ? line : null;
}

/**
 * @param {object} payload  the /api/replays/stats response
 */
export function buildFacts(payload) {
  const playerFacts = [];
  const roundFacts = [];
  const killFacts = [];
  /** @type {Map<string, {key: string, name: string, rounds: number}>} */
  const teams = new Map();
  /** @type {Map<string, {id: string, name: string, rounds: number}>} */
  const players = new Map();
  /** @type {Map<string, {id: string, label: string, map: string, rounds: number}>} */
  const matches = new Map();
  /** @type {Map<string, number>} */
  const maps = new Map();
  /** @type {Map<string, number>} */
  const weapons = new Map();

  for (const demo of payload?.demos || []) {
    const roster = new Map((demo.players || []).map((p) => [p.id, p]));
    const key1 = teamNameKey(demo.name1, demo.t1);
    const key2 = teamNameKey(demo.name2, demo.t2);
    const name1 = String(demo.name1 || demo.t1 || 'Team 1').trim();
    const name2 = String(demo.name2 || demo.t2 || 'Team 2').trim();
    const matchLabel = `${name1} vs ${name2}`;

    for (const row of demo.rounds || []) {
      const map = row.m || demo.map || '';
      const roundNo = row.n || 0;
      const half = roundNo > 12 ? '2' : '1';
      const dur = Number.isFinite(row.dur) ? row.dur : null;
      const plantTime = numOrNull(row.pt);
      const okTeam = row.ok ? roster.get(row.ok)?.team || 0 : 0;
      const odTeam = row.od ? roster.get(row.od)?.team || 0 : 0;
      const kills = Array.isArray(row.kt) ? row.kt : [];

      if (map) maps.set(map, (maps.get(map) || 0) + 1);

      // Per-team buy value, needed by both sides of the round as "opp equip".
      const equipSum = { 1: 0, 2: 0 };
      const equipN = { 1: 0, 2: 0 };
      for (const [id, value] of Object.entries(row.ev || {})) {
        const team = roster.get(id)?.team;
        if (!team || !Number.isFinite(value)) continue;
        equipSum[team] += value;
        equipN[team]++;
      }
      const teamEquip = {
        1: equipN[1] ? equipSum[1] / equipN[1] : null,
        2: equipN[2] ? equipSum[2] / equipN[2] : null
      };

      const firstKillTime = kills.length ? numOrNull(kills[0].t) : null;

      for (const team of [1, 2]) {
        const other = team === 1 ? 2 : 1;
        const teamKey = team === 1 ? key1 : key2;
        if (!teamKey) continue;
        const teamName = team === 1 ? name1 : name2;
        const oppName = team === 1 ? name2 : name1;
        const oppKey = team === 1 ? key2 : key1;
        const side = (team === 1 ? row.s1 : row.s2) || '';
        const oppSide = (team === 1 ? row.s2 : row.s1) || '';
        const rawEcon = team === 1 ? row.e1 : row.e2;
        const rawOppEcon = team === 1 ? row.e2 : row.e1;
        const won = row.w === team ? 1 : 0;
        const teamOpenKill = okTeam === team ? 1 : 0;
        const teamOpenDeath = odTeam === team ? 1 : 0;

        const ctx = {
          demoId: demo.id,
          file: row.f,
          map,
          roundNo,
          half,
          matchLabel,
          team,
          teamKey,
          teamName,
          oppKey,
          oppName,
          side,
          oppSide,
          econ: buyBucket(rawEcon),
          oppEcon: buyBucket(rawOppEcon),
          hasAwp: econHasAwp(rawEcon),
          oppHasAwp: econHasAwp(rawOppEcon),
          won,
          teamOpenKill,
          teamOpenDeath,
          dur,
          plantTime,
          prw: numOrNull(team === 1 ? row.prw1 : row.prw2),
          oppPrw: numOrNull(team === 1 ? row.prw2 : row.prw1),
          possession: numOrNull(team === 1 ? row.pos1 : row.pos2),
          oppPossession: numOrNull(team === 1 ? row.pos2 : row.pos1),
          teamEquip: teamEquip[team],
          oppEquip: teamEquip[other]
        };

        const roundFact = {
          ...ctx,
          subjectId: `${teamKey}`,
          rounds: 1,
          playersSeen: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          damage: 0,
          shots: 0,
          hits: 0,
          headshots: 0,
          awpShots: 0,
          awpHits: 0,
          kastCount: 0,
          swingSum: 0,
          swingN: 0,
          killsEarly: 0,
          killsMid: 0,
          killsLate: 0,
          damageEarly: 0,
          damageMid: 0,
          damageLate: 0,
          openingKillTime: teamOpenKill ? firstKillTime : null,
          teamFirstKillTime: null
        };

        for (const [id, line] of Object.entries(row.p || {})) {
          const who = roster.get(id);
          if (!who || who.team !== team) continue;
          if (!Array.isArray(line)) continue;
          players.set(id, {
            id,
            name: who.name || id,
            rounds: (players.get(id)?.rounds || 0) + 1
          });

          const ownKills = kills.filter((k) => k.a === id);
          const death = kills.find((k) => k.v === id);
          const bag = row.ph?.[id];
          const early = phaseLine(bag, 'early');
          const mid = phaseLine(bag, 'mid');
          const late = phaseLine(bag, 'late');
          const swing = Number.isFinite(row.sw?.[id]) ? row.sw[id] : null;

          const fact = {
            ...ctx,
            playerId: id,
            playerName: who.name || id,
            subjectId: id,
            rounds: 1,
            kills: line[P.KILLS] || 0,
            deaths: line[P.DEATHS] || 0,
            assists: line[P.ASSISTS] || 0,
            damage: line[P.DAMAGE] || 0,
            shots: line[P.SHOTS] || 0,
            hits: line[P.HITS] || 0,
            headshots: line[P.HEADSHOTS] || 0,
            awpShots: line[P.AWP_SHOTS] || 0,
            awpHits: line[P.AWP_HITS] || 0,
            kast: line[P.KAST] ? 1 : 0,
            openKill: row.ok === id ? 1 : 0,
            openDeath: row.od === id ? 1 : 0,
            swing,
            equip: Number.isFinite(row.ev?.[id]) ? row.ev[id] : null,
            survived: death ? 0 : 1,
            deathTime: death ? numOrNull(death.t) : null,
            firstKillTime: ownKills.length ? numOrNull(ownKills[0].t) : null,
            killsEarly: early ? early[P.KILLS] : 0,
            killsMid: mid ? mid[P.KILLS] : 0,
            killsLate: late ? late[P.KILLS] : 0,
            damageEarly: early ? early[P.DAMAGE] : 0,
            damageMid: mid ? mid[P.DAMAGE] : 0,
            damageLate: late ? late[P.DAMAGE] : 0
          };
          fact.multiKill = fact.kills >= 2 ? 1 : 0;
          fact.tripleKill = fact.kills >= 3 ? 1 : 0;
          playerFacts.push(fact);

          roundFact.playersSeen++;
          roundFact.kills += fact.kills;
          roundFact.deaths += fact.deaths;
          roundFact.assists += fact.assists;
          roundFact.damage += fact.damage;
          roundFact.shots += fact.shots;
          roundFact.hits += fact.hits;
          roundFact.headshots += fact.headshots;
          roundFact.awpShots += fact.awpShots;
          roundFact.awpHits += fact.awpHits;
          roundFact.kastCount += fact.kast;
          roundFact.killsEarly += fact.killsEarly;
          roundFact.killsMid += fact.killsMid;
          roundFact.killsLate += fact.killsLate;
          roundFact.damageEarly += fact.damageEarly;
          roundFact.damageMid += fact.damageMid;
          roundFact.damageLate += fact.damageLate;
          if (swing !== null) {
            roundFact.swingSum += swing;
            roundFact.swingN++;
          }
          if (fact.firstKillTime !== null) {
            roundFact.teamFirstKillTime =
              roundFact.teamFirstKillTime === null
                ? fact.firstKillTime
                : Math.min(roundFact.teamFirstKillTime, fact.firstKillTime);
          }
        }

        roundFacts.push(roundFact);
        const t = teams.get(teamKey) || { key: teamKey, name: teamName, rounds: 0 };
        t.rounds++;
        if (teamName) t.name = t.name || teamName;
        teams.set(teamKey, t);
      }

      const m = matches.get(demo.id) || { id: demo.id, label: matchLabel, map, rounds: 0 };
      m.rounds++;
      matches.set(demo.id, m);

      // ---- kills ----------------------------------------------------------
      kills.forEach((k, i) => {
        const attacker = k.a ? roster.get(k.a) : null;
        const victim = k.v ? roster.get(k.v) : null;
        const team = attacker?.team || 0;
        if (!team) return;
        const other = team === 1 ? 2 : 1;
        const teamKey = team === 1 ? key1 : key2;
        const rawEcon = team === 1 ? row.e1 : row.e2;
        const rawOppEcon = team === 1 ? row.e2 : row.e1;
        const t = numOrNull(k.t);
        const weapon = String(k.w || '').trim();
        if (weapon) weapons.set(weapon, (weapons.get(weapon) || 0) + 1);
        killFacts.push({
          demoId: demo.id,
          file: row.f,
          map,
          roundNo,
          half,
          matchLabel,
          team,
          teamKey,
          teamName: team === 1 ? name1 : name2,
          oppKey: team === 1 ? key2 : key1,
          oppName: team === 1 ? name2 : name1,
          side: (team === 1 ? row.s1 : row.s2) || '',
          oppSide: (team === 1 ? row.s2 : row.s1) || '',
          econ: buyBucket(rawEcon),
          oppEcon: buyBucket(rawOppEcon),
          hasAwp: econHasAwp(rawEcon),
          oppHasAwp: econHasAwp(rawOppEcon),
          won: row.w === team ? 1 : 0,
          teamOpenKill: okTeam === team ? 1 : 0,
          teamOpenDeath: odTeam === team ? 1 : 0,
          dur,
          plantTime,
          prw: numOrNull(team === 1 ? row.prw1 : row.prw2),
          possession: numOrNull(team === 1 ? row.pos1 : row.pos2),
          teamEquip: teamEquip[team],
          oppEquip: teamEquip[other],
          attackerId: k.a || '',
          playerId: k.a || '',
          attackerName: attacker?.name || k.a || '',
          playerName: attacker?.name || k.a || '',
          victimId: k.v || '',
          victimName: victim?.name || k.v || '',
          victimSide: victim ? (victim.team === 1 ? row.s1 : row.s2) || '' : '',
          attackerEquip: Number.isFinite(row.ev?.[k.a]) ? row.ev[k.a] : null,
          victimEquip: Number.isFinite(row.ev?.[k.v]) ? row.ev[k.v] : null,
          t,
          tPct: t !== null && dur ? Math.min(100, (t / dur) * 100) : null,
          phase: phaseAtSeconds(t),
          order: i + 1,
          isOpening: i === 0 ? 1 : 0,
          headshot: k.h ? 1 : 0,
          gun: k.g ? 1 : 0,
          weapon,
          postPlant: plantTime !== null && t !== null && t >= plantTime ? 1 : 0,
          trade: 0
        });
      });
    }
  }

  return {
    playerFacts,
    roundFacts,
    killFacts,
    teams: [...teams.values()].sort((a, b) => b.rounds - a.rounds),
    players: [...players.values()].sort((a, b) => b.rounds - a.rounds),
    matches: [...matches.values()].sort((a, b) => a.label.localeCompare(b.label)),
    maps: [...maps.keys()].sort(),
    weapons: [...weapons.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w),
    hasKillTimes: killFacts.some((k) => k.t !== null)
  };
}

/**
 * Empty filter state. Every chart holds one of these globally and one per axis;
 * the axis copy wins on any key it sets.
 */
export function emptyFilter() {
  return {
    maps: [],
    matches: [],
    teams: [],
    players: [],
    sides: [],
    econ: [],
    oppEcon: [],
    hasAwp: false,
    oppHasAwp: false,
    /** @type {''|'won'|'lost'} */
    result: '',
    /** @type {''|'5v4'|'4v5'|'even'} */
    opening: '',
    /** @type {''|'1'|'2'} */
    half: '',
    roundFrom: null,
    roundTo: null,
    phases: [],
    timeFrom: null,
    timeTo: null,
    /** @type {string[]} subset of hs / gun / awp / opening / postplant / preplant */
    killKinds: [],
    weapons: []
  };
}

/** Global filter with the axis overrides layered on top. */
export function mergeFilters(base, over) {
  const out = { ...emptyFilter(), ...(base || {}) };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v;
    } else if (typeof v === 'boolean') {
      if (v) out[k] = v;
    } else if (v !== '') {
      out[k] = v;
    }
  }
  return out;
}

/** Does one fact survive a filter? Works on all three fact tables. */
export function factPasses(fact, f = {}) {
  if (f.maps?.length && !f.maps.includes(fact.map)) return false;
  if (f.matches?.length && !f.matches.includes(fact.demoId)) return false;
  if (f.teams?.length && !f.teams.includes(fact.teamKey)) return false;
  if (f.players?.length) {
    const id = fact.playerId || '';
    if (!id || !f.players.includes(id)) return false;
  }
  if (f.sides?.length && !f.sides.includes(fact.side)) return false;
  if (f.econ?.length && !f.econ.includes(fact.econ)) return false;
  if (f.oppEcon?.length && !f.oppEcon.includes(fact.oppEcon)) return false;
  if (f.hasAwp && !fact.hasAwp) return false;
  if (f.oppHasAwp && !fact.oppHasAwp) return false;
  if (f.result === 'won' && !fact.won) return false;
  if (f.result === 'lost' && fact.won) return false;
  if (f.opening === '5v4' && !fact.teamOpenKill) return false;
  if (f.opening === '4v5' && !fact.teamOpenDeath) return false;
  if (f.opening === 'even' && (fact.teamOpenKill || fact.teamOpenDeath)) return false;
  if (f.half && fact.half !== f.half) return false;
  if (f.roundFrom !== null && f.roundFrom !== undefined && fact.roundNo < f.roundFrom) return false;
  if (f.roundTo !== null && f.roundTo !== undefined && fact.roundNo > f.roundTo) return false;

  // Kill-only keys. A fact without a round time is unaffected by them.
  if (fact.t !== undefined) {
    if (f.timeFrom !== null && f.timeFrom !== undefined && !(fact.t >= f.timeFrom)) return false;
    if (f.timeTo !== null && f.timeTo !== undefined && !(fact.t <= f.timeTo)) return false;
    if (f.phases?.length && !f.phases.includes(fact.phase)) return false;
    if (f.weapons?.length && !f.weapons.includes(fact.weapon)) return false;
    for (const kind of f.killKinds || []) {
      if (kind === 'hs' && !fact.headshot) return false;
      if (kind === 'gun' && !fact.gun) return false;
      if (kind === 'awp' && fact.weapon !== 'awp') return false;
      if (kind === 'opening' && !fact.isOpening) return false;
      if (kind === 'postplant' && !fact.postPlant) return false;
      if (kind === 'preplant' && fact.postPlant) return false;
    }
  }
  return true;
}

/** True when a filter would change nothing. */
export function filterIsEmpty(f) {
  const base = emptyFilter();
  return Object.keys(base).every((k) => {
    const v = f?.[k];
    if (Array.isArray(base[k])) return !v?.length;
    if (typeof base[k] === 'boolean') return !v;
    if (base[k] === null) return v === null || v === undefined;
    return !v;
  });
}
