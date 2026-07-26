// ---------------------------------------------------------------------------
// replays/coach/coach.js
// Reads one round and says what went wrong.
//
// Two passes. The first walks the round a second at a time, recording the win
// probability and who was standing where — that series feeds the graph and is
// also what every rule below reasons against. The second walks the deaths and
// asks, of each, whether it cost something it did not have to.
//
// Pure: positions arrive through a sampler the caller supplies, so this runs
// in node against a round file with no DOM anywhere near it.
// ---------------------------------------------------------------------------

import {
  deadPlayersAt,
  decidedSideAt,
  liveEquipment,
  winProbability
} from './winProbability.js';
import { ALONE_DISTANCE, findCore, nearestTeammate } from './cores.js';

/** A kill this soon after a death answers it. */
const TRADE_SECONDS = 3;
/** An advantage has to have been held this long before losing it is a mistake. */
const HOLD_SECONDS = 3;
/** Below this at freezetime, the round was lost on the buy; say nothing. */
const HOPELESS = 25;
/** Above this on economy alone, trading a solo duel is throwing value away. */
const DOMINANT = 75;

const pct = (n) => `${Math.round(n)}%`;

/**
 * @param {object} args
 * @param {object} args.meta      round meta (events, stats, players, sides…)
 * @param {(tick: number) => Array} args.sampleAt  per-slot tick states
 * @returns {{series: Array, flags: Array, gate: object}}
 */
export function analyseRound({ meta, sampleAt }) {
  const tickRate = meta.tickRate || 64;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const sideOfTeam = (team) => teamSides[team];
  const byId = new Map(players.map((p) => [p.id, p]));
  const sideOf = (id) => sideOfTeam(byId.get(id)?.team);

  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const endTick = meta.endTick ?? to;
  // Coachable window: 1s after freezetime ends → 1s before the winner is decided.
  const coachFrom = from + tickRate;
  const coachUntil = endTick - tickRate;
  const inCoachWindow = (tick) => tick >= coachFrom && tick <= coachUntil;
  const grenades = meta.events?.grenades || [];
  // Kill log for alive counts starts at freeze end (not earlier freezetime knives).
  // Flagging itself is further gated by inCoachWindow below.
  const kills = [...(meta.events?.kills || [])]
    .filter((k) => k.victim && (k.tick || 0) >= from)
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));

  const winnerSide = meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  const bomb = meta.events?.bomb || [];

  // ---- pass one: the round, one second at a time --------------------------

  const series = [];
  for (let tick = from; tick <= to; tick += tickRate) {
    const sampled = sampleAt(tick) || [];
    // Copy out of the sampler scratch buffer — it is reused every step.
    const states = sampled.map((s) => (s ? { ...s } : null));
    const deadIds = deadPlayersAt(kills, tick);
    const eq = liveEquipment({
      players,
      stats: meta.stats,
      states,
      grenades,
      tick,
      teamSides,
      deadIds
    });
    const decided = decidedSideAt({
      tick,
      endTick,
      winnerSide,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      bomb
    });
    const wp = winProbability({
      map: meta.map,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      ctEff: eq.ctEff,
      tEff: eq.tEff,
      ctEquip: eq.CT,
      tEquip: eq.T,
      decided
    });
    series.push({
      tick,
      second: Math.round((tick - from) / tickRate),
      ct: wp.ct,
      t: wp.t,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      ctEff: eq.ctEff,
      tEff: eq.tEff,
      ctEquip: eq.CT,
      tEquip: eq.T,
      parts: wp.parts,
      deadIds,
      states
    });
  }

  // The buy alone, before a shot is fired, decides whether the coach speaks.
  const opening = series[0];
  const gate = {
    CT: opening ? opening.ct > HOPELESS : true,
    T: opening ? opening.t > HOPELESS : true,
    dominant: {
      CT: opening ? opening.ct >= DOMINANT : false,
      T: opening ? opening.t >= DOMINANT : false
    },
    winnerSide
  };

  // ---- pass two: the deaths -----------------------------------------------

  const flags = [];
  const trade = TRADE_SECONDS * tickRate;
  const hold = HOLD_SECONDS * tickRate;

  /** Living count per side at a tick, from the kill log. */
  const aliveAt = (tick) => {
    const out = { CT: 5, T: 5 };
    for (const k of kills) {
      if (k.tick > tick) break;
      const s = sideOf(k.victim);
      if (s) out[s]--;
    }
    return out;
  };

  const sampleNear = (tick) => {
    let best = series[0];
    for (const s of series) {
      if (s.tick <= tick) best = s;
      else break;
    }
    return best;
  };

  /** Everyone alive on a side at a sample, as core-detection input. */
  const positionsOf = (sample, side) => {
    const out = [];
    const dead = sample?.deadIds;
    for (const p of players) {
      if (sideOfTeam(p.team) !== side) continue;
      if (dead?.has(p.id)) continue;
      const st = sample?.states?.[p.slot];
      if (!st?.alive) continue;
      out.push({ id: p.id, x: st.x, y: st.y, z: st.z });
    }
    return out;
  };

  // First death inside the coachable window (not freezetime / post-round).
  const firstDeathTick = kills.find((k) => inCoachWindow(k.tick))?.tick ?? null;
  // Extra hard stops once the round is factually over (may precede endTick).
  const defusedTick =
    (meta.events?.bomb || []).find((b) => b.type === 'defused')?.tick ?? null;

  for (const death of kills) {
    const victim = death.victim;
    const side = sideOf(victim);
    if (!side || !gate[side]) continue;
    if (!inCoachWindow(death.tick)) continue;
    if (defusedTick != null && death.tick >= defusedTick) continue;
    const before = aliveAt(death.tick - 1);
    const opp = side === 'CT' ? 'T' : 'CT';
    // Enemy team already wiped: nothing left to throw away.
    if (before[opp] <= 0) continue;
    const name = byId.get(victim)?.name || victim;

    // Answered inside the window? Then nothing was lost and nothing is said.
    const answered = kills.some(
      (k) => k.tick > death.tick && k.tick - death.tick <= trade && sideOf(k.attacker) === side
    );

    const sample = sampleNear(death.tick);
    const mates = positionsOf(sample, side);
    const me = mates.find((m) => m.id === victim);
    const { core, lurkers } = findCore(mates);
    const inCore = core.includes(victim);
    const isLurker = lurkers.includes(victim);

    const wpBefore = sampleNear(death.tick)?.[side === 'CT' ? 'ct' : 't'];
    const wpAfter = sampleNear(death.tick + tickRate)?.[side === 'CT' ? 'ct' : 't'];
    const drop =
      Number.isFinite(wpBefore) && Number.isFinite(wpAfter) && wpAfter < wpBefore
        ? ` Round win chance fell from ${pct(wpBefore)} to ${pct(wpAfter)}.`
        : '';

    // 1. An advantage held for a while, then handed back for nothing.
    if (!answered && before[side] > before[opp]) {
      const then = aliveAt(death.tick - hold);
      if (then[side] > then[opp]) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'advantage-lost',
          text: inCore
            ? `${name} died in a ${before[side]}v${before[opp]} with no trade. In a man advantage the refrags and the spacing have to be tighter than this.${drop}`
            : `${name} died alone in a ${before[side]}v${before[opp]} with no trade. A solo player should not be the one dying when the team is already up.${drop}`
        });
        continue;
      }
    }

    // 2. Even numbers, and the lurker died before the core ever took a fight.
    if (!answered && before[side] === before[opp] && core.length && isLurker) {
      const coreFought = kills.some(
        (k) => k.tick < death.tick && (core.includes(k.attacker) || core.includes(k.victim))
      );
      if (!coreFought) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'lurk-first',
          text: `${name} died out on their own before the group had taken a fight. In an even round it is generally better to let the core play first and open the map from there.${drop}`
        });
        continue;
      }
    }

    // 3. The round's first death, with the map otherwise silent around it.
    if (death.tick === firstDeathTick) {
      const isolated = !kills.some(
        (k) => k !== death && Math.abs(k.tick - death.tick) <= trade
      );
      if (isolated) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'free-opening',
          text: `${name} opened the round by dying with nothing else happening anywhere on the map. Nothing was traded and nothing was gained, so this is a potentially unnecessary opening death.${drop}`
        });
        continue;
      }
    }

    // 4. Duelling alone while the buy had already won the round for you.
    if (gate.dominant[side] && me && nearestTeammate(me, mates) > ALONE_DISTANCE) {
      flags.push({
        tick: death.tick,
        playerId: victim,
        rule: 'negative-ev',
        text: `${name} took a solo duel with the round already ${pct(
          side === 'CT' ? opening.ct : opening.t
        )} won on equipment. With that much of an edge a fight nobody can trade is negative EV whether it is won or lost.${drop}`
      });
    }
  }

  // Solo duels the winner survived leave no death behind, so they are picked
  // up from the kill side of the log rather than the death side.
  if (opening) {
    for (const side of ['CT', 'T']) {
      if (!gate.dominant[side] || !gate[side]) continue;
      const opp = side === 'CT' ? 'T' : 'CT';
      for (const k of kills) {
        if (sideOf(k.attacker) !== side) continue;
        if (!inCoachWindow(k.tick)) continue;
        if (defusedTick != null && k.tick >= defusedTick) continue;
        if (aliveAt(k.tick - 1)[opp] <= 0) continue;
        const sample = sampleNear(k.tick);
        const mates = positionsOf(sample, side);
        const me = mates.find((m) => m.id === k.attacker);
        if (!me || nearestTeammate(me, mates) <= ALONE_DISTANCE) continue;
        if (flags.some((f) => f.playerId === k.attacker && Math.abs(f.tick - k.tick) <= trade)) continue;
        const name = byId.get(k.attacker)?.name || k.attacker;
        flags.push({
          tick: k.tick,
          playerId: k.attacker,
          rule: 'negative-ev',
          text: `${name} won a solo duel, but took it with no teammate in support and the round already ${pct(
            side === 'CT' ? opening.ct : opening.t
          )} won on equipment. That fight was negative EV even though it came off.`
        });
      }
    }
  }

  flags.sort((a, b) => a.tick - b.tick);
  // The states are only needed while the rules run; the graph wants numbers.
  for (const s of series) delete s.states;
  return { series, flags, gate };
}

/** Turn a flag into the note shape the round file stores. */
export function flagToNote(flag) {
  return {
    id: `c${flag.tick}${flag.rule.slice(0, 3)}`.slice(0, 32),
    tick: flag.tick,
    text: flag.text,
    kind: 'coach',
    mark: '',
    updatedAt: Date.now()
  };
}
