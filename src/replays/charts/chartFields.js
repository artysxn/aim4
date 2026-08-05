// ---------------------------------------------------------------------------
// replays/charts/chartFields.js
// The field catalogue behind the chart builder: metrics (what an axis can
// measure), dimensions (what an axis can group by), subjects (what one point
// is) and series splits.
//
// A metric is a ratio of sums: `num` per fact over `den` per fact. That single
// shape covers totals (no den), per-round rates, hit rates, weighted stats like
// EAK and mean-of-samples like PRW, and it stays correct under any grouping.
// Metrics that are not linear in their inputs (HLTV rating, impact) provide a
// `custom` aggregator instead.
// ---------------------------------------------------------------------------

import { ECONOMIES, MAPS, economyLabel } from '../shared/roundId.js';
import { aim4OpeningRating, aim4Rating, impactOf, ratingOf } from '../shared/statsMath.js';
import { PHASE_CUTS } from './chartFacts.js';

const div = (a, b) => (b > 0 ? a / b : 0);

/** @type {Record<string, (v: number) => string>} */
export const FORMATS = {
  int: (v) => String(Math.round(v)),
  num1: (v) => v.toFixed(2),
  num2: (v) => v.toFixed(2),
  num3: (v) => v.toFixed(3),
  pct: (v) => `${v.toFixed(2)}%`,
  signedPct: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`,
  money: (v) => `$${Math.round(v).toLocaleString('en-US')}`,
  sec: (v) => `${v.toFixed(2)}s`
};

export function formatValue(value, fmt) {
  if (!Number.isFinite(value)) return '-';
  return (FORMATS[fmt] || FORMATS.num2)(value);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Metric
 * @property {string} key
 * @property {string} label
 * @property {'player'|'round'|'kill'} source   which fact table it reads
 * @property {string} group                     option-group heading
 * @property {string} fmt
 * @property {(f: object) => number|null} [num]
 * @property {(f: object) => number|null} [den]
 * @property {(facts: object[]) => number|null} [custom]
 * @property {string} [tip]
 */

const ratingFromCounters = (rounds, seats, c) => {
  if (!rounds || !seats) return null;
  const kpr = div(c.kills, seats);
  const dpr = div(c.deaths, seats);
  const apr = div(c.assists, seats);
  const adr = div(c.damage, seats);
  const kast = div(c.kast, seats) * 100;
  return ratingOf({ kast, kpr, dpr, impact: impactOf({ kpr, apr }), adr });
};

function playerCounters(facts) {
  const c = { kills: 0, deaths: 0, assists: 0, damage: 0, kast: 0 };
  for (const f of facts) {
    c.kills += f.kills;
    c.deaths += f.deaths;
    c.assists += f.assists;
    c.damage += f.damage;
    c.kast += f.kast;
  }
  return c;
}

function avgSwing(facts) {
  let sum = 0;
  let n = 0;
  for (const f of facts) {
    if (!Number.isFinite(f.swing)) continue;
    sum += f.swing;
    n++;
  }
  return n ? sum / n : null;
}

function avgSwingWhere(facts, won) {
  let sum = 0;
  let n = 0;
  for (const f of facts) {
    if (!Number.isFinite(f.swing)) continue;
    if (!!f.won !== won) continue;
    sum += f.swing;
    n++;
  }
  return n ? sum / n : null;
}

function a4rFromFacts(facts) {
  if (!facts.length) return null;
  const rating = ratingFromCounters(facts.length, facts.length, playerCounters(facts));
  if (!Number.isFinite(rating)) return null;
  const c = playerCounters(facts);
  const rounds = facts.length;
  const kills = c.kills;
  const deaths = c.deaths;
  const kd = deaths ? kills / deaths : kills;
  const fights = kills + deaths;
  const duelWin = fights > 0 ? (kills / fights) * 100 : null;
  const kast = div(c.kast, rounds) * 100;
  let ok = 0;
  let od = 0;
  let xkSum = 0;
  let xkN = 0;
  let duelW = 0;
  let duelP = 0;
  let duelN = 0;
  for (const f of facts) {
    ok += f.openKill || 0;
    od += f.openDeath || 0;
    if (f.duelXk !== null && f.duelXk !== undefined && Number.isFinite(f.duelXk)) {
      xkSum += f.duelXk;
      xkN++;
    }
    if (Number.isFinite(f.duelW) && f.duelW > 0) {
      duelW += f.duelW;
      duelP += Number(f.duelP) || 0;
      duelN += Number(f.duelN) || 0;
    }
  }
  const openings = ok + od;
  return aim4Rating({
    rating,
    swing: avgSwing(facts),
    kd,
    xk: xkN ? xkSum / rounds : null,
    duelWin,
    kast,
    opatt: openings / rounds,
    or: openings > 0 ? (ok / openings) * 100 : null,
    // Charts facts do not carry aim / ready rate yet; baselines contribute 0.
    ready: null,
    aim: null,
    pfw: duelW > 0 ? (duelP / duelW) * 100 : null,
    pfo: duelW > 0 ? ((duelN - duelP) / duelW) * 100 : null,
    swingWon: avgSwingWhere(facts, true),
    swingLost: avgSwingWhere(facts, false),
    rounds
  });
}

function a4orFromFacts(facts) {
  if (!facts.length) return null;
  let ok = 0;
  let od = 0;
  for (const f of facts) {
    ok += f.openKill || 0;
    od += f.openDeath || 0;
  }
  return aim4OpeningRating({
    opkd: ok - od,
    swing: avgSwing(facts),
    opatt: (ok + od) / facts.length
  });
}

/** Per-player, per-round facts. */
const PLAYER_METRICS = [
  { key: 'rounds', label: 'Rounds played', group: 'Volume', fmt: 'int', num: () => 1 },
  { key: 'kills', label: 'Kills (total)', group: 'Volume', fmt: 'int', num: (f) => f.kills },
  { key: 'deaths', label: 'Deaths (total)', group: 'Volume', fmt: 'int', num: (f) => f.deaths },
  { key: 'assists', label: 'Assists (total)', group: 'Volume', fmt: 'int', num: (f) => f.assists },
  { key: 'damage', label: 'Damage (total)', group: 'Volume', fmt: 'int', num: (f) => f.damage },
  {
    key: 'rating',
    label: 'Rating (HLTV 2.0)',
    group: 'Core',
    fmt: 'num2',
    custom: (facts) => ratingFromCounters(facts.length, facts.length, playerCounters(facts))
  },
  {
    key: 'a4r',
    label: 'A4R',
    group: 'Core',
    fmt: 'num2',
    custom: a4rFromFacts,
    tip: 'Composite ^1.10 + rounds/3000 + 0.93 (Rating, Swing, K/D, xK, Duel Win%, KAST, OPATT, OR, R%, Aim, PFO, PFW, swing won/lost)'
  },
  {
    key: 'a4or',
    label: 'A4OR',
    group: 'Core',
    fmt: 'num2',
    custom: a4orFromFacts,
    tip: '1.00 + OPKD/100 + Swing/8 + OPATT'
  },
  {
    key: 'impact',
    label: 'Impact',
    group: 'Core',
    fmt: 'num2',
    custom: (facts) => {
      if (!facts.length) return null;
      const c = playerCounters(facts);
      return impactOf({ kpr: div(c.kills, facts.length), apr: div(c.assists, facts.length) });
    }
  },
  { key: 'kpr', label: 'Kills per round', group: 'Core', fmt: 'num2', num: (f) => f.kills, den: () => 1 },
  { key: 'dpr', label: 'Deaths per round', group: 'Core', fmt: 'num2', num: (f) => f.deaths, den: () => 1 },
  { key: 'apr', label: 'Assists per round', group: 'Core', fmt: 'num2', num: (f) => f.assists, den: () => 1 },
  { key: 'adr', label: 'ADR', group: 'Core', fmt: 'num1', num: (f) => f.damage, den: () => 1 },
  { key: 'kd', label: 'K/D', group: 'Core', fmt: 'num2', num: (f) => f.kills, den: (f) => f.deaths },
  { key: 'kast', label: 'KAST %', group: 'Core', fmt: 'pct', num: (f) => f.kast * 100, den: () => 1 },
  {
    key: 'opatt',
    label: 'OPATT',
    group: 'Core',
    fmt: 'num2',
    num: (f) => (f.openKill || 0) + (f.openDeath || 0),
    den: () => 1,
    tip: 'Opening attempts (kills + deaths) per round.'
  },
  {
    key: 'psdt',
    label: 'PSDT',
    group: 'Core',
    fmt: 'int',
    num: (f) => f.psdt,
    den: (f) => (f.psdt === null || f.psdt === undefined ? null : 1),
    tip: 'Pulled-string distance travelled (125u), averaged per round.'
  },
  {
    key: 'dt',
    label: 'DT',
    group: 'Core',
    fmt: 'int',
    num: (f) => f.dt,
    den: (f) => (f.dt === null || f.dt === undefined ? null : 1),
    tip: 'Raw distance travelled, averaged per round.'
  },
  {
    key: 'hsPct',
    label: 'Headshot %',
    group: 'Aim',
    fmt: 'pct',
    num: (f) => f.headshots * 100,
    den: (f) => f.kills
  },
  {
    key: 'accuracy',
    label: 'Accuracy %',
    group: 'Aim',
    fmt: 'pct',
    num: (f) => f.hits * 100,
    den: (f) => f.shots
  },
  {
    key: 'awpAcc',
    label: 'AWP accuracy %',
    group: 'Aim',
    fmt: 'pct',
    num: (f) => f.awpHits * 100,
    den: (f) => f.awpShots,
    tip: 'Only holds within 10 degrees of an enemy with a clear path count as shots.'
  },
  { key: 'shots', label: 'Gun shots (total)', group: 'Aim', fmt: 'int', num: (f) => f.shots },
  { key: 'awpShots', label: 'AWP shots (total)', group: 'Aim', fmt: 'int', num: (f) => f.awpShots },
  {
    key: 'openKills',
    label: 'First kills (total)',
    group: 'Opening duel',
    fmt: 'int',
    num: (f) => f.openKill
  },
  {
    key: 'openDeaths',
    label: 'First deaths (total)',
    group: 'Opening duel',
    fmt: 'int',
    num: (f) => f.openDeath
  },
  {
    key: 'openKillRate',
    label: 'First kills per round',
    group: 'Opening duel',
    fmt: 'num3',
    num: (f) => f.openKill,
    den: () => 1
  },
  {
    key: 'openWinPct',
    label: 'Opening duels won %',
    group: 'Opening duel',
    fmt: 'pct',
    num: (f) => f.openKill * 100,
    den: (f) => f.openKill + f.openDeath
  },
  {
    key: 'opkd',
    label: 'OPKD',
    group: 'Opening duel',
    fmt: 'num1',
    custom: (facts) => {
      if (!facts.length) return null;
      let ok = 0;
      let od = 0;
      for (const f of facts) {
        ok += f.openKill || 0;
        od += f.openDeath || 0;
      }
      return ok - od;
    },
    tip: 'Opening kill difference (OK − OD) over the filtered rounds.'
  },
  {
    key: 'pfw',
    label: 'PFW',
    group: 'Duels',
    fmt: 'pct',
    num: (f) => (f.duelW > 0 ? f.duelP * 100 : null),
    den: (f) => (f.duelW > 0 ? f.duelW : null),
    tip: 'Predicted fight winrate: average model odds across active duels. How hard the fights were, not how they went.'
  },
  {
    key: 'pfo',
    label: 'PFO',
    group: 'Duels',
    fmt: 'signedPct',
    num: (f) => (f.duelW > 0 ? (f.duelN - f.duelP) * 100 : null),
    den: (f) => (f.duelW > 0 ? f.duelW : null),
    tip: 'Predicted fight overperformance: actual win rate minus predicted, in points. Already adjusted for difficulty.'
  },
  {
    key: 'tfw',
    label: 'TFW',
    group: 'Duels',
    fmt: 'pct',
    num: (f) => f.kills * 100,
    den: (f) => {
      const fights = (f.kills || 0) + (f.deaths || 0);
      return fights > 0 ? fights : null;
    },
    tip: 'Total fight winrate: kills as a share of kills plus deaths.'
  },
  {
    key: 'xk',
    label: 'xK',
    group: 'Duels',
    fmt: 'num2',
    num: (f) => f.duelXk,
    den: (f) => (f.duelXk === null || f.duelXk === undefined ? null : 1),
    tip: 'Expected kills per round: sum of model win chances across duels. A 50/50 is 0.50; a strong 1v2 is close to 2.'
  },
  {
    key: 'firstKillTime',
    label: 'First kill time (avg)',
    group: 'Timing',
    fmt: 'sec',
    num: (f) => f.firstKillTime,
    den: (f) => (f.firstKillTime === null ? null : 1),
    tip: 'Live seconds after freeze end, averaged over rounds where the player got a kill.'
  },
  {
    key: 'deathTime',
    label: 'Death time (avg)',
    group: 'Timing',
    fmt: 'sec',
    num: (f) => f.deathTime,
    den: (f) => (f.deathTime === null ? null : 1)
  },
  {
    key: 'killsEarly',
    label: 'Early kills per round',
    group: 'Timing',
    fmt: 'num2',
    num: (f) => f.killsEarly,
    den: () => 1
  },
  {
    key: 'killsMid',
    label: 'Mid kills per round',
    group: 'Timing',
    fmt: 'num2',
    num: (f) => f.killsMid,
    den: () => 1
  },
  {
    key: 'killsLate',
    label: 'Late kills per round',
    group: 'Timing',
    fmt: 'num2',
    num: (f) => f.killsLate,
    den: () => 1
  },
  {
    key: 'swing',
    label: 'Round swing (avg)',
    group: 'Win impact',
    fmt: 'num1',
    num: (f) => f.swing,
    den: (f) => (f.swing === null ? null : 1),
    tip: 'Predicted round winrate the player moved, in points per round.'
  },
  {
    key: 'swingTotal',
    label: 'Round swing (total)',
    group: 'Win impact',
    fmt: 'num1',
    num: (f) => f.swing
  },
  {
    key: 'winPct',
    label: 'Round win %',
    group: 'Win impact',
    fmt: 'pct',
    num: (f) => f.won * 100,
    den: () => 1
  },
  {
    key: 'teamPrw',
    label: 'Team predicted winrate (avg)',
    group: 'Win impact',
    fmt: 'pct',
    num: (f) => (f.prw === null ? null : f.prw * 100),
    den: (f) => (f.prw === null ? null : 1)
  },
  {
    key: 'teamPossession',
    label: 'Team possession (avg)',
    group: 'Map control',
    fmt: 'pct',
    num: (f) => (f.possession === null ? null : f.possession * 100),
    den: (f) => (f.possession === null ? null : 1)
  },
  {
    key: 'survivalPct',
    label: 'Survival %',
    group: 'Core',
    fmt: 'pct',
    num: (f) => f.survived * 100,
    den: () => 1
  },
  {
    key: 'multiKillPct',
    label: '2K+ rounds %',
    group: 'Volume',
    fmt: 'pct',
    num: (f) => f.multiKill * 100,
    den: () => 1
  },
  {
    key: 'tripleKillPct',
    label: '3K+ rounds %',
    group: 'Volume',
    fmt: 'pct',
    num: (f) => f.tripleKill * 100,
    den: () => 1
  },
  {
    key: 'equip',
    label: 'Own buy value (avg)',
    group: 'Economy',
    fmt: 'money',
    num: (f) => f.equip,
    den: (f) => (f.equip === null ? null : 1)
  },
  {
    key: 'oppEquip',
    label: 'Enemy buy value (avg)',
    group: 'Economy',
    fmt: 'money',
    num: (f) => f.oppEquip,
    den: (f) => (f.oppEquip === null ? null : 1)
  },
  {
    key: 'eak',
    label: 'EAK (economy adjusted kills)',
    group: 'Economy',
    fmt: 'num2',
    num: (f) => (f.oppEquip === null ? null : (f.kills * f.oppEquip) / 1000),
    den: (f) => (f.oppEquip === null ? null : 1),
    tip: 'Kills times the enemy average buy value in thousands, per round. Higher is better.'
  },
  {
    key: 'eadPer1k',
    label: 'Damage per $1k enemy buy',
    group: 'Economy',
    fmt: 'num1',
    num: (f) => f.damage,
    den: (f) => (f.oppEquip ? f.oppEquip / 1000 : null)
  }
];

/** Per-team, per-round facts. */
const ROUND_METRICS = [
  { key: 'rounds', label: 'Rounds', group: 'Volume', fmt: 'int', num: () => 1 },
  { key: 'roundsWon', label: 'Rounds won', group: 'Volume', fmt: 'int', num: (f) => f.won },
  {
    key: 'winPct',
    label: 'Round win %',
    group: 'Core',
    fmt: 'pct',
    num: (f) => f.won * 100,
    den: () => 1
  },
  {
    key: 'teamRating',
    label: 'Team rating (avg player)',
    group: 'Core',
    fmt: 'num2',
    custom: (facts) => {
      const seats = facts.reduce((n, f) => n + (f.playersSeen || 0), 0);
      const c = { kills: 0, deaths: 0, assists: 0, damage: 0, kast: 0 };
      for (const f of facts) {
        c.kills += f.kills;
        c.deaths += f.deaths;
        c.assists += f.assists;
        c.damage += f.damage;
        c.kast += f.kastCount;
      }
      return ratingFromCounters(facts.length, seats, c);
    }
  },
  { key: 'teamKills', label: 'Kills per round', group: 'Core', fmt: 'num2', num: (f) => f.kills, den: () => 1 },
  {
    key: 'teamDeaths',
    label: 'Deaths per round',
    group: 'Core',
    fmt: 'num2',
    num: (f) => f.deaths,
    den: () => 1
  },
  { key: 'teamAdr', label: 'Team damage per round', group: 'Core', fmt: 'num1', num: (f) => f.damage, den: () => 1 },
  { key: 'teamKd', label: 'Team K/D', group: 'Core', fmt: 'num2', num: (f) => f.kills, den: (f) => f.deaths },
  {
    key: 'teamKast',
    label: 'Team KAST %',
    group: 'Core',
    fmt: 'pct',
    num: (f) => f.kastCount * 100,
    den: (f) => f.playersSeen
  },
  {
    key: 'teamHsPct',
    label: 'Team headshot %',
    group: 'Aim',
    fmt: 'pct',
    num: (f) => f.headshots * 100,
    den: (f) => f.kills
  },
  {
    key: 'teamAccuracy',
    label: 'Team accuracy %',
    group: 'Aim',
    fmt: 'pct',
    num: (f) => f.hits * 100,
    den: (f) => f.shots
  },
  {
    key: 'teamAwpAcc',
    label: 'Team AWP accuracy %',
    group: 'Aim',
    fmt: 'pct',
    num: (f) => f.awpHits * 100,
    den: (f) => f.awpShots
  },
  {
    key: 'prw',
    label: 'Predicted round winrate (avg)',
    group: 'Win impact',
    fmt: 'pct',
    num: (f) => (f.prw === null ? null : f.prw * 100),
    den: (f) => (f.prw === null ? null : 1),
    tip: 'Mean of the round win probability series, sampled every 4 seconds.'
  },
  {
    key: 'prwEdge',
    label: 'Predicted winrate edge',
    group: 'Win impact',
    fmt: 'pct',
    num: (f) => (f.prw === null || f.oppPrw === null ? null : (f.prw - f.oppPrw) * 100),
    den: (f) => (f.prw === null || f.oppPrw === null ? null : 1)
  },
  {
    key: 'possession',
    label: 'Possession (avg)',
    group: 'Map control',
    fmt: 'pct',
    num: (f) => (f.possession === null ? null : f.possession * 100),
    den: (f) => (f.possession === null ? null : 1),
    tip: 'Share of the walkable map this team controlled, averaged over the round.'
  },
  {
    key: 'possessionEdge',
    label: 'Possession edge',
    group: 'Map control',
    fmt: 'pct',
    num: (f) =>
      f.possession === null || f.oppPossession === null
        ? null
        : (f.possession - f.oppPossession) * 100,
    den: (f) => (f.possession === null || f.oppPossession === null ? null : 1)
  },
  {
    key: 'openKillPct',
    label: 'First kill rate %',
    group: 'Opening duel',
    fmt: 'pct',
    num: (f) => f.teamOpenKill * 100,
    den: (f) => f.teamOpenKill + f.teamOpenDeath
  },
  {
    key: 'teamPfw',
    label: 'Team PFW',
    group: 'Duels',
    fmt: 'pct',
    num: (f) => f.duelPfwSum,
    den: (f) => (f.duelPlayers > 0 ? f.duelPlayers : null),
    tip: 'Team predicted fight winrate: the side’s players’ PFW averaged.'
  },
  {
    key: 'teamPfo',
    label: 'Team PFO',
    group: 'Duels',
    fmt: 'signedPct',
    num: (f) => f.duelPfoSum,
    den: (f) => (f.duelPlayers > 0 ? f.duelPlayers : null),
    tip: 'Team predicted fight overperformance: the side’s players’ PFO averaged.'
  },
  {
    key: 'teamXk',
    label: 'Team xK',
    group: 'Duels',
    fmt: 'num2',
    num: (f) => f.duelXkSum,
    den: (f) => (f.duelXkPlayers > 0 ? f.duelXkPlayers : null),
    tip: 'Team expected kills per round: the side’s players’ xK averaged.'
  },
  {
    key: 'conv5v4',
    label: '5v4 conversion %',
    group: 'Opening duel',
    fmt: 'pct',
    num: (f) => (f.teamOpenKill ? f.won * 100 : null),
    den: (f) => (f.teamOpenKill ? 1 : null)
  },
  {
    key: 'conv4v5',
    label: '4v5 comeback %',
    group: 'Opening duel',
    fmt: 'pct',
    num: (f) => (f.teamOpenDeath ? f.won * 100 : null),
    den: (f) => (f.teamOpenDeath ? 1 : null)
  },
  {
    key: 'openingKillTime',
    label: 'Own first kill time (avg)',
    group: 'Timing',
    fmt: 'sec',
    num: (f) => f.teamFirstKillTime,
    den: (f) => (f.teamFirstKillTime === null ? null : 1)
  },
  {
    key: 'roundDuration',
    label: 'Round length (avg)',
    group: 'Timing',
    fmt: 'sec',
    num: (f) => f.dur,
    den: (f) => (f.dur === null ? null : 1)
  },
  {
    key: 'plantTime',
    label: 'Plant time (avg)',
    group: 'Timing',
    fmt: 'sec',
    num: (f) => f.plantTime,
    den: (f) => (f.plantTime === null ? null : 1)
  },
  {
    key: 'plantRate',
    label: 'Rounds with a plant %',
    group: 'Timing',
    fmt: 'pct',
    num: (f) => (f.plantTime === null ? 0 : 100),
    den: () => 1
  },
  {
    key: 'teamKillsEarly',
    label: 'Early kills per round',
    group: 'Timing',
    fmt: 'num2',
    num: (f) => f.killsEarly,
    den: () => 1
  },
  {
    key: 'teamKillsMid',
    label: 'Mid kills per round',
    group: 'Timing',
    fmt: 'num2',
    num: (f) => f.killsMid,
    den: () => 1
  },
  {
    key: 'teamKillsLate',
    label: 'Late kills per round',
    group: 'Timing',
    fmt: 'num2',
    num: (f) => f.killsLate,
    den: () => 1
  },
  {
    key: 'teamSwing',
    label: 'Team swing per round',
    group: 'Win impact',
    fmt: 'num1',
    num: (f) => (f.swingN ? f.swingSum : null),
    den: (f) => (f.swingN ? 1 : null)
  },
  {
    key: 'teamEquip',
    label: 'Own buy value (avg)',
    group: 'Economy',
    fmt: 'money',
    num: (f) => f.teamEquip,
    den: (f) => (f.teamEquip === null ? null : 1)
  },
  {
    key: 'teamOppEquip',
    label: 'Enemy buy value (avg)',
    group: 'Economy',
    fmt: 'money',
    num: (f) => f.oppEquip,
    den: (f) => (f.oppEquip === null ? null : 1)
  },
  {
    key: 'equipEdge',
    label: 'Buy value edge',
    group: 'Economy',
    fmt: 'money',
    num: (f) => (f.teamEquip === null || f.oppEquip === null ? null : f.teamEquip - f.oppEquip),
    den: (f) => (f.teamEquip === null || f.oppEquip === null ? null : 1)
  },
  {
    key: 'teamEak',
    label: 'EAK (economy adjusted kills)',
    group: 'Economy',
    fmt: 'num2',
    num: (f) => (f.oppEquip === null ? null : (f.kills * f.oppEquip) / 1000),
    den: (f) => (f.oppEquip === null ? null : 1)
  }
];

/** One kill per fact. */
const KILL_METRICS = [
  { key: 'killCount', label: 'Kills (count)', group: 'Volume', fmt: 'int', num: () => 1 },
  {
    key: 'openingCount',
    label: 'First kills (count)',
    group: 'Volume',
    fmt: 'int',
    num: (f) => f.isOpening
  },
  {
    key: 'hsCount',
    label: 'Headshot kills (count)',
    group: 'Volume',
    fmt: 'int',
    num: (f) => f.headshot
  },
  {
    key: 'killTime',
    label: 'Kill time (avg)',
    group: 'Timing',
    fmt: 'sec',
    num: (f) => f.t,
    den: (f) => (f.t === null ? null : 1)
  },
  {
    key: 'killTimePct',
    label: 'Kill time, % of round (avg)',
    group: 'Timing',
    fmt: 'pct',
    num: (f) => f.tPct,
    den: (f) => (f.tPct === null ? null : 1)
  },
  {
    key: 'killHsPct',
    label: 'Headshot %',
    group: 'Quality',
    fmt: 'pct',
    num: (f) => f.headshot * 100,
    den: () => 1
  },
  {
    key: 'killGunPct',
    label: 'Gun kill %',
    group: 'Quality',
    fmt: 'pct',
    num: (f) => f.gun * 100,
    den: () => 1
  },
  {
    key: 'killPostPlantPct',
    label: 'Post-plant %',
    group: 'Quality',
    fmt: 'pct',
    num: (f) => f.postPlant * 100,
    den: () => 1
  },
  {
    key: 'killWinPct',
    label: 'Round won after %',
    group: 'Quality',
    fmt: 'pct',
    num: (f) => f.won * 100,
    den: () => 1
  },
  {
    key: 'victimEquip',
    label: 'Victim buy value (avg)',
    group: 'Economy',
    fmt: 'money',
    num: (f) => f.victimEquip,
    den: (f) => (f.victimEquip === null ? null : 1)
  },
  {
    key: 'attackerEquip',
    label: 'Killer buy value (avg)',
    group: 'Economy',
    fmt: 'money',
    num: (f) => f.attackerEquip,
    den: (f) => (f.attackerEquip === null ? null : 1)
  },
  {
    key: 'killOrder',
    label: 'Kill order in round (avg)',
    group: 'Timing',
    fmt: 'num1',
    num: (f) => f.order,
    den: () => 1
  }
];

export const METRICS = {
  player: PLAYER_METRICS,
  round: ROUND_METRICS,
  kill: KILL_METRICS
};

export function metricsFor(source) {
  return METRICS[source] || [];
}

export function findMetric(source, key) {
  const list = metricsFor(source);
  return list.find((m) => m.key === key) || list[0] || null;
}

/**
 * Ratio of sums (or plain sum when the metric has no denominator).
 * @returns {number|null} null when nothing in `facts` contributes.
 */
export function aggregateMetric(metric, facts) {
  if (!metric || !facts?.length) return null;
  if (metric.custom) return metric.custom(facts);
  let num = 0;
  let den = 0;
  let n = 0;
  for (const f of facts) {
    const a = metric.num(f);
    if (a === null || a === undefined || !Number.isFinite(a)) continue;
    if (metric.den) {
      const b = metric.den(f);
      if (b === null || b === undefined || !Number.isFinite(b)) continue;
      den += b;
    }
    num += a;
    n++;
  }
  if (!n) return null;
  if (!metric.den) return num;
  return den > 0 ? num / den : null;
}

// ---------------------------------------------------------------------------
// Dimensions (X grouping for line / bar / distribution charts)
// ---------------------------------------------------------------------------

const ECON_LABEL = (code) => ECONOMIES[code]?.label || economyLabel(Number(code));

/**
 * @typedef {object} Dimension
 * @property {string} key
 * @property {string} label
 * @property {'bin'|'cat'} kind
 * @property {string[]} sources
 * @property {(f: object) => number|string|null} value
 * @property {number} [step]      default bin width
 * @property {number[]} [steps]   selectable bin widths
 * @property {(v: any) => string} [tick]
 * @property {string} [unit]
 * @property {string} [tip]
 */

/** @type {Dimension[]} */
export const DIMENSIONS = [
  {
    key: 'time',
    label: 'Time in the round (s)',
    kind: 'bin',
    sources: ['kill'],
    value: (f) => f.t,
    step: 5,
    steps: [1, 2, 5, 10, 15],
    unit: 's',
    tip: 'Live seconds after freeze end.'
  },
  {
    key: 'timePct',
    label: 'How far into the round (%)',
    kind: 'bin',
    sources: ['kill'],
    value: (f) => f.tPct,
    step: 10,
    steps: [5, 10, 20, 25],
    unit: '%',
    tip: 'Kill time as a share of that round’s length.'
  },
  {
    key: 'phase',
    label: 'Round phase',
    kind: 'cat',
    sources: ['kill'],
    value: (f) => f.phase,
    order: ['early', 'mid', 'late'],
    tick: (v) => ({ early: 'Early', mid: 'Mid', late: 'Late' }[v] || v),
    tip: `Early is under ${PHASE_CUTS.earlyEnd}s, late is from ${PHASE_CUTS.lateStart}s.`
  },
  {
    key: 'killOrder',
    label: 'Kill number in round',
    kind: 'bin',
    sources: ['kill'],
    value: (f) => f.order,
    step: 1,
    steps: [1],
    tick: (v) => `#${v}`
  },
  {
    key: 'roundNo',
    label: 'Round number',
    kind: 'bin',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.roundNo,
    step: 1,
    steps: [1, 2, 3, 6]
  },
  {
    key: 'map',
    label: 'Map',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.map,
    tick: (v) => MAPS[v]?.name || v || 'Unknown'
  },
  {
    key: 'side',
    label: 'Side',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.side,
    order: ['T', 'CT']
  },
  {
    key: 'econ',
    label: 'Own buy',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.econ,
    order: [0, 1, 2, 3, 4],
    tick: ECON_LABEL
  },
  {
    key: 'oppEcon',
    label: 'Enemy buy',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.oppEcon,
    order: [0, 1, 2, 3, 4],
    tick: ECON_LABEL
  },
  {
    key: 'result',
    label: 'Round result',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => (f.won ? 'Won' : 'Lost'),
    order: ['Won', 'Lost']
  },
  {
    key: 'opening',
    label: 'Opening duel',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => (f.teamOpenKill ? '5v4' : f.teamOpenDeath ? '4v5' : 'Even'),
    order: ['5v4', '4v5', 'Even']
  },
  {
    key: 'half',
    label: 'Half',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.half,
    order: ['1', '2'],
    tick: (v) => (v === '2' ? 'Second half' : 'First half')
  },
  {
    key: 'team',
    label: 'Team',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.teamKey,
    labelOf: (f) => f.teamName
  },
  {
    key: 'player',
    label: 'Player',
    kind: 'cat',
    sources: ['player', 'kill'],
    value: (f) => f.playerId,
    labelOf: (f) => f.playerName
  },
  {
    key: 'match',
    label: 'Match',
    kind: 'cat',
    sources: ['player', 'round', 'kill'],
    value: (f) => f.demoId,
    labelOf: (f) => f.matchLabel
  },
  {
    key: 'weapon',
    label: 'Weapon',
    kind: 'cat',
    sources: ['kill'],
    value: (f) => f.weapon,
    labelOf: (f) => f.weapon || 'unknown'
  },
  {
    key: 'victim',
    label: 'Victim',
    kind: 'cat',
    sources: ['kill'],
    value: (f) => f.victimId,
    labelOf: (f) => f.victimName
  },
  {
    key: 'buyEdge',
    label: 'Buy value edge ($)',
    kind: 'bin',
    sources: ['player', 'round'],
    value: (f) =>
      f.teamEquip === null || f.oppEquip === null ? null : f.teamEquip - f.oppEquip,
    step: 1000,
    steps: [500, 1000, 2000],
    unit: '$'
  }
];

export function dimensionsFor(source) {
  return DIMENSIONS.filter((d) => d.sources.includes(source));
}

export function findDimension(source, key) {
  const list = dimensionsFor(source);
  return list.find((d) => d.key === key) || list[0] || null;
}

// ---------------------------------------------------------------------------
// Subjects (what a scatter point is) and series splits
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Subject
 * @property {string} key
 * @property {string} label
 * @property {'player'|'round'|'kill'} source
 * @property {(f: object) => string} id
 * @property {(f: object) => string} name
 * @property {(f: object) => string} [sub]
 */

/** @type {Subject[]} */
export const SUBJECTS = [
  {
    key: 'players',
    label: 'Players',
    source: 'player',
    id: (f) => f.playerId,
    name: (f) => f.playerName,
    sub: (f) => f.teamName
  },
  {
    key: 'playerMatches',
    label: 'Players per match',
    source: 'player',
    id: (f) => `${f.playerId}:${f.demoId}`,
    name: (f) => f.playerName,
    sub: (f) => `${f.matchLabel} - ${MAPS[f.map]?.name || f.map}`
  },
  {
    key: 'playerSides',
    label: 'Players per side',
    source: 'player',
    id: (f) => `${f.playerId}:${f.side}`,
    name: (f) => `${f.playerName} (${f.side})`,
    sub: (f) => f.teamName
  },
  {
    key: 'teams',
    label: 'Teams',
    source: 'round',
    id: (f) => f.teamKey,
    name: (f) => f.teamName
  },
  {
    key: 'teamMaps',
    label: 'Teams per map',
    source: 'round',
    id: (f) => `${f.teamKey}:${f.map}`,
    name: (f) => `${f.teamName} (${MAPS[f.map]?.name || f.map})`
  },
  {
    key: 'teamSides',
    label: 'Teams per side',
    source: 'round',
    id: (f) => `${f.teamKey}:${f.side}`,
    name: (f) => `${f.teamName} (${f.side})`
  },
  {
    key: 'teamMatches',
    label: 'Teams per match',
    source: 'round',
    id: (f) => `${f.teamKey}:${f.demoId}`,
    name: (f) => f.teamName,
    sub: (f) => `${f.matchLabel} - ${MAPS[f.map]?.name || f.map}`
  },
  {
    key: 'rounds',
    label: 'Rounds',
    source: 'round',
    id: (f) => `${f.file}:${f.team}`,
    name: (f) => `${f.teamName} R${f.roundNo}`,
    sub: (f) => `${f.matchLabel} - ${MAPS[f.map]?.name || f.map}`
  },
  {
    key: 'maps',
    label: 'Maps',
    source: 'round',
    id: (f) => f.map,
    name: (f) => MAPS[f.map]?.name || f.map || 'Unknown'
  },
  {
    key: 'kills',
    label: 'Kills',
    source: 'kill',
    id: (f) => `${f.file}:${f.order}`,
    name: (f) => `${f.playerName} killed ${f.victimName}`,
    sub: (f) => `R${f.roundNo} at ${f.t === null ? '?' : `${f.t.toFixed(2)}s`}`
  }
];

export function findSubject(key) {
  return SUBJECTS.find((s) => s.key === key) || SUBJECTS[0];
}

/** Series splits available for a source, reusing the categorical dimensions. */
export function seriesFor(source) {
  return dimensionsFor(source).filter((d) => d.kind === 'cat');
}

export const CHART_TYPES = [
  { key: 'scatter', label: 'Scatter', tip: 'One point per subject, X and Y both measured.' },
  { key: 'line', label: 'Line', tip: 'A measure across a grouping, drawn in order.' },
  { key: 'bar', label: 'Bars', tip: 'A measure across a grouping, drawn as columns.' },
  { key: 'area', label: 'Distribution', tip: 'Share or count over a binned grouping.' }
];
