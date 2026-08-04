// ---------------------------------------------------------------------------
// replays/coach/duelMistakes.js
// The mechanical mistakes that are worth a number rather than an assertion.
//
// Section 8 of the plan: the duel model is the shared plumbing these notes all
// need, and it is the reason they are worth writing at all. "You shot while
// moving" is an opinion. "Standing still made that fight 71% and moving turned
// it into 44%" is a measurement, and it is the same function the Duels tool
// already trusts, evaluated twice.
//
// Two gates that are not negotiable:
//
//   - Untrained parameters say nothing. Seed weights would dress a guess up as
//     a measurement, which is worse than staying quiet, so this mirrors the
//     duel scanner and returns nothing until the model has been fit.
//   - No geometry, no notes. Without a prepared zone network there is no line
//     of sight, and a duel model reading through walls is confidently wrong.
//
// That means these fire in the viewer, where the map is loaded, and stay quiet
// in the team page's batch pass. That is the right way round: a wrong number is
// more expensive than a missing one.
// ---------------------------------------------------------------------------

import { coachText } from './coachMessages.js';
import { predictDuel } from '../duels/duelModel.js';
import { DUEL_MODEL_PARAMS, paramVector } from '../duels/duelModelParams.js';
import { computeDuelSnapshot, duelContext } from '../duels/duelSnapshot.js';
import { blockingSmokesAt } from '../duels/sightRay.js';
import { createVisionTracker } from '../duels/visionState.js';
import { createReloadTracker } from '../duels/reloadTracker.js';
import { speedAt } from '../duels/duelFeatures.js';
import { hasControlField } from '../zones/zoneOverlay.js';
import { isAimWeapon } from '../shared/aimMetrics.js';
import { ALONE_DISTANCE } from './cores.js';

/**
 * Speed at or above which a weapon stops shooting where it is pointed.
 *
 * These are the rule's own thresholds rather than the engine's exact per-weapon
 * numbers. They only decide which bullets get priced; the cost itself comes
 * from the model, so being a few units out changes what is measured, never the
 * measurement.
 */
const ACCURATE_SPEED = {
  ak47: 85,
  m4a1: 85,
  m4a1_silencer: 85,
  galilar: 90,
  famas: 90,
  aug: 85,
  sg556: 85,
  deagle: 85,
  awp: 45
};

/** Bullets above the cap needed in one burst before it is a habit, not a slip. */
const RUNNING_SHOTS = 3;
/** Win-probability points the counterfactual must find before it is worth saying. */
const RUNNING_DELTA = 0.1;
/** A burst ends after this many re-fire delays of silence. Matches shotMistakes. */
const BURST_GAP_CYCLES = 3;
/** An AWP shot this free is one you are expected to take. */
const AWP_FREE = 0.75;
/** A duel this far in your favour is one you are expected to convert. */
const AHEAD = 0.75;
/**
 * A fight this one-sided is already decided. Mistake notes are not sent for it
 * — neither "you should have converted" nor "you walked into a lost duel".
 */
const FIGHT_WON = 0.8;
/**
 * Enemy duel win chance this high, on this share of active fight samples, with
 * the round already won, is a fight that should not have been taken.
 * Stays below {@link FIGHT_WON}: decided fights are never coached.
 */
const UNDERDOG = 0.75;
const UNDERDOG_SHARE = 0.75;

/** True when one side already has the duel at {@link FIGHT_WON} or better. */
function fightIsWon(winProb) {
  return Number.isFinite(winProb) && (winProb >= FIGHT_WON || winProb <= 1 - FIGHT_WON);
}
/** Round win chance (0-100 series units) required before that duel. */
const ROUND_WON_PCT = 75;
/** How long before a death to look for the moment the fight opened. */
const SIGHT_LOOKBACK_SECONDS = 3;
/** How far back to sample an active gunfight for the underdog-won-round note. */
const FIGHT_LOOKBACK_SECONDS = 5;
/** The refrag has to be available this well before not taking it is a mistake. */
const TRADE_ODDS = 0.66;
/** Seconds you have to step up before the trade is gone. */
const TRADE_WINDOW_SECONDS = 1;
/** A trade attempt that ends in your own death this soon is a failed refrag. */
const TRADE_DEATH_SECONDS = 3;
/** How long after a shot a hit may land and still belong to it. */
const HIT_WINDOW_SECONDS = 0.2;
/** Ticks between snapshots when walking the round to keep the vision memory warm. */
const WALK_STRIDE = 16;
/** Seconds of catch-up walking before the first shot of a burst. */
const WARM_SECONDS = 3;

const bare = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^weapon_/, '');

const pct = (p) => `${Math.round(p * 100)}%`;

/**
 * @param {object} args
 * @param {object} args.meta
 * @param {number} args.tickRate
 * @param {Map<string, object>} args.byId
 * @param {(id: string) => ('CT'|'T'|undefined)} args.sideOf
 * @param {{CT: boolean, T: boolean}} args.gate
 * @param {(tick: number) => boolean} args.inCoachWindow
 * @param {number|null} args.defusedTick
 * @param {object|null} args.network  prepared zone network
 * @param {object|null} args.track    full tick track
 * @param {(tick: number, side: 'CT'|'T') => number|undefined|null} [args.roundWinAt]
 *        Live round win chance in 0-100 units for `side` at `tick`.
 * @returns {Array<{tick: number, playerId: string, rule: string, text: string}>}
 */
export function findDuelFlags({
  meta,
  tickRate,
  byId,
  sideOf,
  gate,
  inCoachWindow,
  defusedTick,
  kills = [],
  network,
  track,
  roundWinAt = null
}) {
  const flags = [];
  const players = meta?.players || [];
  const mapCode = meta?.map || '';
  if (!players.length || !track || !network || !mapCode) return flags;
  if (!hasControlField(network)) return flags;
  if (!(DUEL_MODEL_PARAMS.trainedOn > 0)) return flags;

  const shots = (meta.events?.shots || []).filter((s) => s.player && isAimWeapon(s.weapon));
  if (!shots.length) return flags;

  const weights = paramVector();
  const nameOf = (id) => byId.get(id)?.name || id;
  const coachable = (id, tick) => {
    const side = sideOf(id);
    if (!side || !gate[side]) return false;
    if (!inCoachWindow(tick)) return false;
    if (defusedTick != null && tick >= defusedTick) return false;
    return true;
  };

  // ---- the snapshot walker ------------------------------------------------
  //
  // Information advantage is a memory: who saw whom first only exists as a
  // running answer built by walking ticks in order. Jumping straight to a shot
  // tick would read it as zero for both players, so each snapshot is preceded
  // by a short catch-up walk, exactly as the live scanner does after a seek.

  const visionTracker = createVisionTracker(tickRate);
  const reloadTracker = createReloadTracker({ meta });
  let lastWalked = -Infinity;

  const grenades = meta.events?.grenades || [];
  const snapshotAt = (tick) =>
    computeDuelSnapshot({
      meta,
      track,
      tick,
      network,
      mapCode,
      smokes: blockingSmokesAt(grenades, tick, tickRate),
      visionTracker,
      reloadTracker
    });

  const snapshotWalked = (tick) => {
    const warm = WARM_SECONDS * tickRate;
    const from =
      tick < lastWalked || tick - lastWalked > warm
        ? Math.max(meta.freezeEndTick ?? track.firstTick, tick - warm)
        : lastWalked + WALK_STRIDE;
    if (tick < lastWalked) visionTracker.reset();
    for (let t = from; t < tick; t += WALK_STRIDE) snapshotAt(t);
    lastWalked = tick;
    return snapshotAt(tick);
  };

  /** The fight this player is actually in at a tick: nearest enemy in sight. */
  const openDuel = (snapshot, slot) => {
    let best = null;
    let bestDist = Infinity;
    for (const pair of snapshot?.pairs || []) {
      if (pair.aSlot !== slot && pair.bSlot !== slot) continue;
      if (!(pair.aSeesB || pair.bSeesA)) continue;
      if (pair.dist >= bestDist) continue;
      best = pair;
      bestDist = pair.dist;
    }
    if (!best) return null;
    const foe = best.aSlot === slot ? best.bSlot : best.aSlot;
    const ctx = duelContext(snapshot, slot, foe);
    return ctx ? { ctx, foeSlot: foe } : null;
  };

  // ---- hits, for the AWP rule --------------------------------------------

  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const hitWindow = Math.max(1, Math.round(HIT_WINDOW_SECONDS * tickRate));
  const hitsBy = new Map();
  for (const d of meta.events?.damage || []) {
    if (!d.attacker || !d.victim || !(Number(d.hp) > 0)) continue;
    if (teamOf.get(d.attacker) === teamOf.get(d.victim)) continue;
    if (!hitsBy.has(d.attacker)) hitsBy.set(d.attacker, []);
    hitsBy.get(d.attacker).push(d);
  }
  const landedNear = (playerId, tick, weapon) => {
    const list = hitsBy.get(playerId);
    if (!list) return false;
    const w = bare(weapon);
    return list.some((d) => d.tick >= tick && d.tick <= tick + hitWindow && bare(d.weapon) === w);
  };

  // ---- shots, in order, grouped into bursts per player --------------------

  const ordered = [...shots].sort((a, b) => a.tick - b.tick);
  /** player -> the burst being built. */
  const open = new Map();

  const closeBurst = (playerId) => {
    const burst = open.get(playerId);
    open.delete(playerId);
    if (!burst || burst.count < RUNNING_SHOTS || !(burst.delta >= RUNNING_DELTA)) return;
    if (!coachable(playerId, burst.tick)) return;
    // A fight that was already won standing still is not coached as a mistake.
    if (fightIsWon(burst.still)) return;
    flags.push({
      tick: burst.tick,
      playerId,
      rule: 'running-shot',
      text: coachText('running-shot', burst.tick, {
        player: nameOf(playerId),
        speed: Math.round(burst.speed),
        was: pct(burst.still),
        is: pct(burst.moving),
        delta: Math.round(burst.delta * 100)
      })
    });
  };

  for (const shot of ordered) {
    const shooter = byId.get(shot.player);
    if (!shooter || shooter.slot == null) continue;
    const weapon = bare(shot.weapon);
    const cap = ACCURATE_SPEED[weapon];
    const isAwp = weapon === 'awp';
    if (cap === undefined && !isAwp) {
      closeBurst(shot.player);
      continue;
    }
    if (!coachable(shot.player, shot.tick)) {
      closeBurst(shot.player);
      continue;
    }

    const speed = speedAt(track, shooter.slot, shot.tick, tickRate);
    const running = cap !== undefined && speed > cap;
    if (!running && !isAwp) {
      closeBurst(shot.player);
      continue;
    }

    let snapshot;
    try {
      snapshot = snapshotWalked(shot.tick);
    } catch {
      continue;
    }
    const duel = openDuel(snapshot, shooter.slot);
    if (!duel) {
      closeBurst(shot.player);
      continue;
    }

    // The AWP shot you were expected to take, and did not land.
    if (isAwp) {
      const free = predictDuel(duel.ctx, weights);
      // Free enough to expect a hit, but not a fight that was already decided.
      if (
        free >= AWP_FREE &&
        !fightIsWon(free) &&
        !landedNear(shot.player, shot.tick, weapon)
      ) {
        const foe = snapshot.players.find((p) => p.slot === duel.foeSlot);
        flags.push({
          tick: shot.tick,
          playerId: shot.player,
          rule: 'awp-miss',
          text: coachText('awp-miss', shot.tick, {
            player: nameOf(shot.player),
            win: pct(free),
            enemy: nameOf(foe?.id || '')
          })
        });
      }
      if (!running) {
        closeBurst(shot.player);
        continue;
      }
    }

    // The counterfactual: the same duel, at a standstill. The movement term is
    // one feature of the model, so this is a second call to a function that has
    // already been evaluated rather than a second model.
    const moving = predictDuel(duel.ctx, weights);
    const still = predictDuel(
      { ...duel.ctx, pair: { ...duel.ctx.pair, a: { ...duel.ctx.pair.a, speed: 0 } } },
      weights
    );
    const delta = still - moving;

    const burst = open.get(shot.player);
    const gapCycles = Math.max(
      2,
      Math.round((duel.ctx.pair.a.cycleSeconds || 0.1) * BURST_GAP_CYCLES * tickRate)
    );
    if (!burst || shot.tick - burst.lastTick > gapCycles || burst.weapon !== weapon) {
      closeBurst(shot.player);
      open.set(shot.player, {
        tick: shot.tick,
        lastTick: shot.tick,
        weapon,
        count: 1,
        speed,
        moving,
        still,
        delta
      });
      continue;
    }

    burst.lastTick = shot.tick;
    burst.count += 1;
    // The burst is reported at its worst bullet, not its average: the note is
    // about what the habit cost at its most expensive.
    if (delta > burst.delta) {
      burst.delta = delta;
      burst.moving = moving;
      burst.still = still;
      burst.speed = speed;
    }
  }

  for (const playerId of [...open.keys()]) closeBurst(playerId);

  // ---- the deaths, priced ------------------------------------------------
  //
  // Everything below walks the kill log in tick order so the snapshot walker
  // keeps moving forward. Each death asks two questions the model can answer
  // and the kill log cannot: was that duel already yours, and was the refrag
  // for it available to anyone standing next to you.

  const shotsByPlayer = new Map();
  for (const s of ordered) {
    if (!shotsByPlayer.has(s.player)) shotsByPlayer.set(s.player, []);
    shotsByPlayer.get(s.player).push(s.tick);
  }
  const firedBetween = (playerId, from, to) =>
    (shotsByPlayer.get(playerId) || []).some((t) => t >= from && t <= to);

  const sightLookback = SIGHT_LOOKBACK_SECONDS * tickRate;
  const fightLookback = FIGHT_LOOKBACK_SECONDS * tickRate;
  const tradeWindow = TRADE_WINDOW_SECONDS * tickRate;
  const tradeDeath = TRADE_DEATH_SECONDS * tickRate;
  const deaths = [...kills]
    .filter((k) => k.victim && k.attacker)
    .sort((a, b) => a.tick - b.tick);

  /** Active (on-screen) samples of victim vs killer in [from, to). */
  const sampleActiveFight = (victimSlot, killerSlot, from, to) => {
    /** @type {Array<{ tick: number, odds: number }>} */
    const samples = [];
    for (let t = from; t < to; t += WALK_STRIDE) {
      let snap;
      try {
        snap = snapshotWalked(t);
      } catch {
        continue;
      }
      const ctx = duelContext(snap, victimSlot, killerSlot);
      if (!ctx?.pair?.losClear) continue;
      if (!(ctx.pair.aSeesB || ctx.pair.bSeesA)) continue;
      samples.push({ tick: t, odds: predictDuel(ctx, weights) });
    }
    return samples;
  };

  for (const death of deaths) {
    const victim = death.victim;
    const killer = death.attacker;
    const side = sideOf(victim);
    if (!side || sideOf(killer) === side) continue;
    if (defusedTick != null && death.tick >= defusedTick) continue;
    if (!inCoachWindow(death.tick)) continue;

    const victimSlot = byId.get(victim)?.slot;
    const killerSlot = byId.get(killer)?.slot;
    if (victimSlot == null || killerSlot == null) continue;

    // The state one tick before the shot landed: the victim is still standing,
    // so the pair still exists and the fight can still be priced.
    let snapshot;
    try {
      snapshot = snapshotWalked(death.tick - 1);
    } catch {
      continue;
    }
    const victimFeat = snapshot.players.find((p) => p.slot === victimSlot);
    if (!victimFeat) continue;
    const sameSide = snapshot.players.filter((p) => p.side === victimFeat.side);

    // A duel that was already yours the moment you could see them.
    let lostAhead = false;
    if (coachable(victim, death.tick)) {
      let odds = null;
      for (let t = death.tick - sightLookback; t < death.tick; t += WALK_STRIDE) {
        let early;
        try {
          early = snapshotWalked(t);
        } catch {
          continue;
        }
        const ctx = duelContext(early, victimSlot, killerSlot);
        if (!ctx?.pair?.losClear) continue;
        if (!(ctx.pair.aSeesB || ctx.pair.bSeesA)) continue;
        odds = predictDuel(ctx, weights);
        break;
      }
      // Favourable enough to expect a convert, but not an already-decided fight.
      if (odds !== null && odds >= AHEAD && !fightIsWon(odds)) {
        lostAhead = true;
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'lost-ahead',
          text: coachText('lost-ahead', death.tick, {
            player: nameOf(victim),
            win: pct(odds)
          })
        });
      }

      // Losing duel in a winning round: most active fight samples heavily
      // favoured the enemy, while the round was already decided beforehand.
      // Decided fights (≥80% one way) are never coached.
      if (!lostAhead && typeof roundWinAt === 'function') {
        const samples = sampleActiveFight(
          victimSlot,
          killerSlot,
          death.tick - fightLookback,
          death.tick
        );
        if (samples.length) {
          const fightStart = samples[0].tick;
          const roundWp = roundWinAt(Math.max(0, fightStart - 1), side);
          const avgEnemy =
            samples.reduce((n, s) => n + (1 - s.odds), 0) / samples.length;
          const bad = samples.filter((s) => {
            const enemy = 1 - s.odds;
            return enemy >= UNDERDOG && enemy < FIGHT_WON;
          }).length;
          if (
            Number.isFinite(roundWp) &&
            roundWp >= ROUND_WON_PCT &&
            !fightIsWon(1 - avgEnemy) &&
            bad / samples.length >= UNDERDOG_SHARE
          ) {
            flags.push({
              tick: death.tick,
              playerId: victim,
              rule: 'underdog-won-round',
              text: coachText('underdog-won-round', death.tick, {
                player: nameOf(victim),
                win: `${Math.round(roundWp)}%`,
                duel: pct(avgEnemy),
                share: `${Math.round((bad / samples.length) * 100)}%`
              })
            });
          }
        }
      }

      // The lookback above walked backwards, so put the walker back where the
      // rest of this iteration expects it.
      try {
        snapshot = snapshotWalked(death.tick - 1);
      } catch {
        continue;
      }
    }

    // The refrag. Never coached in a 1vX: with the victim gone there would be
    // nobody left to trade with anyway.
    if (sameSide.length < 3) continue;
    for (const mate of sameSide) {
      if (mate.slot === victimSlot) continue;
      if (Math.hypot(mate.x - victimFeat.x, mate.y - victimFeat.y) > ALONE_DISTANCE) continue;
      if (!coachable(mate.id, death.tick)) continue;

      const ctx = duelContext(snapshot, mate.slot, killerSlot);
      if (!ctx) continue;
      const odds = predictDuel(ctx, weights);
      if (odds < TRADE_ODDS || fightIsWon(odds)) continue;

      const tried = firedBetween(mate.id, death.tick, death.tick + tradeWindow);
      const diedForIt = deaths.some(
        (k) =>
          k.victim === mate.id &&
          k.attacker === killer &&
          k.tick > death.tick &&
          k.tick - death.tick <= tradeDeath
      );

      if (!tried && !diedForIt) {
        flags.push({
          tick: death.tick,
          playerId: mate.id,
          rule: 'no-trade-attempt',
          text: coachText('no-trade-attempt', death.tick, {
            player: nameOf(mate.id),
            teammate: nameOf(victim),
            win: pct(odds)
          })
        });
        continue;
      }
      // Right read, wrong outcome. Separate note because the coaching differs.
      if (diedForIt) {
        flags.push({
          tick: death.tick,
          playerId: mate.id,
          rule: 'trade-failure',
          text: coachText('trade-failure', death.tick, {
            player: nameOf(mate.id),
            teammate: nameOf(victim),
            win: pct(odds)
          })
        });
      }
    }
  }

  return flags;
}
