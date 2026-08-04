// ---------------------------------------------------------------------------
// replays/coach/tacticalMistakes.js
// The seven rules whose copy was written before their detection was.
//
// They sat in coachMessages.js with four wording variants each and nothing
// anywhere calling them, so the coach could describe these mistakes but never
// found one. This module is the missing half.
//
// They live together because they share a dependency the older rules do not:
// all seven need the map and the clock rather than just the kill log. Where a
// player stood, how long they had been there, what a smoke closed, whether a
// rotate could arrive. Three of them are also priced against the duel model,
// because "was that fight worth taking" is not answerable from the outcome:
// winning a bad fight does not make it a good one.
//
// Every rule here stays silent rather than guessing when the geometry is
// missing, matching how duelMistakes behaves when the map is not loaded.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { coachText } from './coachMessages.js';
import { isHoldingVsPeekIn } from './angleHold.js';
import { hasControlField } from '../zones/zoneOverlay.js';
import { bombSiteCenters, bombSiteNearPoint } from '../zones/bombSites.js';
import { predictDuel } from '../duels/duelModel.js';
import { DUEL_MODEL_PARAMS, paramVector } from '../duels/duelModelParams.js';
import { computeDuelSnapshot, duelContext } from '../duels/duelSnapshot.js';
import { createReloadTracker } from '../duels/reloadTracker.js';
import { createVisionTracker } from '../duels/visionState.js';
import { blockingSmokesAt, losBlockedBetween } from '../duels/sightRay.js';

const pct = (p) => `${Math.round(p * 100)}%`;

/** Ticks between snapshots when walking the round to keep vision memory warm. */
const WALK_STRIDE = 16;
/** Seconds of catch-up walking before a snapshot is trusted. */
const WARM_SECONDS = 3;

// --- afterplant-duel --------------------------------------------------------
/** Once the bomb is down, the clock is winning; fights inside this window are a choice. */
const AFTERPLANT_SECONDS = 15;
/** Below this, the bomb wins more rounds than the fight does. */
const AFTERPLANT_ODDS = 0.66;
/** A fight this one-sided is already decided; mistake notes are not sent for it. */
const FIGHT_WON = 0.8;

// --- not-ready --------------------------------------------------------------
/** An enemy on screen this long with no shot fired is being looked at, not fought. */
const NOT_READY_SECONDS = 1.5;
/** Only worth saying when the fight was winnable rather than already lost. */
const NOT_READY_MIN_ODDS = 0.35;

// --- spacing ----------------------------------------------------------------
/** Two deaths to one enemy inside this window are one sequence, not two rounds. */
const SPACING_SECONDS = 8;
/** Each fight has to have been near even alone, or it is just a better player. */
const SPACING_SOLO_MIN = 0.35;
const SPACING_SOLO_MAX = 0.65;
/** And badly one-sided taken together, or there was nothing to fix. */
const SPACING_PAIR_ODDS = 0.7;

// --- pushed-advantage -------------------------------------------------------
/** Ground has to have been held this long before leaving it is a choice. */
const HELD_SECONDS = 5;
/** World units moved toward the enemy before it counts as a push. */
const PUSH_UNITS = 400;
/** Nobody within this many units counts as pushing alone. */
const ALONE_UNITS = 700;

// --- late-rotation ----------------------------------------------------------
/** A rotate begun this long after the plant is already behind the bomb. */
const ROTATE_LATE_SECONDS = 12;
/** With at least this far still to travel, it cannot arrive in time. */
const ROTATE_FAR_UNITS = 1800;
/** Assumed travel speed, world units per second. Matches the bomb race. */
const APPROACH_SPEED = 200;
/**
 * Arriving is not the same as mattering.
 *
 * A rotate that reaches the site with four seconds left has not saved the
 * round: the retake still has to be won and the bomb still has to be defused.
 * So the deadline is travel plus a defuse plus a minimal allowance for the
 * fight, and "too late" means that total does not fit inside the bomb clock.
 *
 * Measured against real demos this is the difference between the rule never
 * firing and it firing on the genuinely stranded: living CTs sit a median 1260
 * units from the bomb after a plant and at most about 3750, so a bare
 * can-they-physically-reach-it test is satisfied by everyone, always.
 */
const RETAKE_DEFUSE_SECONDS = 10;
const RETAKE_FIGHT_SECONDS = 5;
/** Bomb timer, seconds. */
const BOMB_SECONDS = 40;

// --- smoke-peek -------------------------------------------------------------
/** A smoke landing this soon after the death would have closed the fight. */
const SMOKE_SOON_SECONDS = 4;

// --- flash-no-followup ------------------------------------------------------
/** A flash is spent if nothing happens on it within this long. */
const FOLLOWUP_SECONDS = 3;
/** Blind for less than this and there was nothing to follow up on. */
const FLASH_MIN_BLIND = 0.7;
/** Somebody has to have been close enough for the flash to have been for them. */
const FLASH_NEAR_UNITS = 1500;

const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * A readable place name for a world point.
 *
 * The painted bombsites are the only named geometry the maps carry, so a flash
 * is described by the site it landed on or near, and by nothing at all when it
 * landed elsewhere. Inventing a label would read as knowledge the data does not
 * have.
 */
function zoneName(at, network) {
  const site = bombSiteNearPoint(at.x, at.y, network);
  if (site === 'a') return 'A site';
  if (site === 'b') return 'B site';
  return 'open';
}

/** Tick the bomb went down, or null. */
function plantedAt(meta) {
  if (Number.isFinite(meta?.plantTick)) return meta.plantTick;
  const ev = (meta?.events?.bomb || []).find((b) => b?.type === 'planted');
  return Number.isFinite(ev?.tick) ? ev.tick : null;
}

/**
 * The seven map-and-clock rules.
 *
 * @param {object} args  the shared coach context, plus network and track
 * @returns {Array<{tick:number, playerId:string, rule:string, text:string}>}
 */
export function findTacticalFlags({
  meta,
  tickRate,
  byId,
  sideOf,
  gate,
  inCoachWindow,
  defusedTick,
  kills = [],
  network,
  track
}) {
  const flags = [];
  const players = meta?.players || [];
  const mapCode = meta?.map || '';
  if (!players.length || !track || !network || !mapCode) return flags;
  if (!hasControlField(network)) return flags;

  const nameOf = (id) => byId.get(id)?.name || id;
  const coachable = (id, tick) => {
    const side = sideOf(id);
    if (!side || !gate[side]) return false;
    if (!inCoachWindow(tick)) return false;
    if (defusedTick != null && tick >= defusedTick) return false;
    return true;
  };

  const grenades = meta.events?.grenades || [];
  const plantTick = plantedAt(meta);
  const firstTick = meta.freezeEndTick ?? track.firstTick;
  const lastTick = Math.min(meta.endTick ?? track.lastTick, track.lastTick);

  // ---- shared snapshot machinery, same warm-walk as duelMistakes ----------
  const visionTracker = createVisionTracker(tickRate);
  const reloadTracker = createReloadTracker({ meta });
  let lastWalked = -Infinity;

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
        ? Math.max(firstTick, tick - warm)
        : lastWalked + WALK_STRIDE;
    if (tick < lastWalked) visionTracker.reset();
    for (let t = from; t < tick; t += WALK_STRIDE) snapshotAt(t);
    lastWalked = tick;
    return snapshotAt(tick);
  };

  const deaths = kills.filter((k) => k?.victim && k?.attacker && k.victim !== k.attacker);
  const weights = paramVector();
  const duelModelReady = DUEL_MODEL_PARAMS.trainedOn > 0;
  const sample = (slot, tick) => track.sample(slot, tick, {});

  // =========================================================================
  // afterplant-duel: a 1v1 taken at poor odds while the bomb was winning
  // =========================================================================
  if (duelModelReady && plantTick != null) {
    const window = AFTERPLANT_SECONDS * tickRate;
    for (const death of deaths) {
      if (death.tick < plantTick || death.tick > plantTick + window) continue;
      // The T side is the one the plant handed an advantage to.
      if (sideOf(death.victim) !== 'T') continue;
      if (!coachable(death.victim, death.tick)) continue;
      const victimSlot = byId.get(death.victim)?.slot;
      const killerSlot = byId.get(death.attacker)?.slot;
      if (victimSlot == null || killerSlot == null) continue;

      let snap;
      try {
        snap = snapshotWalked(death.tick - 1);
      } catch {
        continue;
      }
      // Only a true 1v1. With anyone else alive the fight may not have been
      // a choice at all.
      const tAlive = snap.players.filter((p) => p.side === 'T').length;
      const ctAlive = snap.players.filter((p) => p.side === 'CT').length;
      if (tAlive !== 1 || ctAlive !== 1) continue;

      const ctx = duelContext(snap, victimSlot, killerSlot);
      if (!ctx?.pair) continue;
      if (!(ctx.pair.aSeesB || ctx.pair.bSeesA)) continue;
      const odds = predictDuel(ctx, weights);
      // Already a fine fight, or already hopeless: not coached.
      if (odds >= AFTERPLANT_ODDS || odds <= 1 - FIGHT_WON) continue;

      flags.push({
        tick: death.tick,
        playerId: death.victim,
        rule: 'afterplant-duel',
        text: coachText('afterplant-duel', death.tick, {
          player: nameOf(death.victim),
          seconds: Math.round((death.tick - plantTick) / tickRate),
          win: pct(odds)
        })
      });
    }
  }

  // =========================================================================
  // not-ready: the enemy was on screen for a while and no shot was ever fired
  // =========================================================================
  if (duelModelReady) {
    const shots = meta.events?.shots || [];
    const shotsBy = new Map();
    for (const s of shots) {
      if (!s?.player) continue;
      if (!shotsBy.has(s.player)) shotsBy.set(s.player, []);
      shotsBy.get(s.player).push(s.tick || 0);
    }
    for (const list of shotsBy.values()) list.sort((a, b) => a - b);
    const firedBetween = (id, from, to) => {
      const list = shotsBy.get(id);
      if (!list?.length) return false;
      for (const t of list) {
        if (t >= from && t <= to) return true;
        if (t > to) break;
      }
      return false;
    };

    const need = NOT_READY_SECONDS * tickRate;
    for (const death of deaths) {
      if (!coachable(death.victim, death.tick)) continue;
      const victimSlot = byId.get(death.victim)?.slot;
      const killerSlot = byId.get(death.attacker)?.slot;
      if (victimSlot == null || killerSlot == null) continue;
      if (firedBetween(death.victim, death.tick - need, death.tick)) continue;

      // Sight has to be unbroken. A killer who left and came back is a new
      // fight, not somebody standing there failing to shoot.
      let seenFrom = null;
      let odds = null;
      for (let t = death.tick - need; t < death.tick; t += WALK_STRIDE) {
        let snap;
        try {
          snap = snapshotWalked(t);
        } catch {
          continue;
        }
        const ctx = duelContext(snap, victimSlot, killerSlot);
        if (!ctx?.pair?.aSeesB) {
          seenFrom = null;
          odds = null;
          continue;
        }
        if (seenFrom === null) {
          seenFrom = t;
          odds = predictDuel(ctx, weights);
        }
      }
      if (seenFrom === null || odds === null) continue;
      const held = (death.tick - seenFrom) / tickRate;
      if (held < NOT_READY_SECONDS || odds < NOT_READY_MIN_ODDS) continue;
      // Already-decided fights are not coached.
      if (odds >= FIGHT_WON || odds <= 1 - FIGHT_WON) continue;
      // Holding the angle into a peek is not "not ready on the angle".
      if (
        track &&
        isHoldingVsPeekIn(track, tickRate, victimSlot, killerSlot, seenFrom)
      ) {
        continue;
      }

      flags.push({
        tick: death.tick,
        playerId: death.victim,
        rule: 'not-ready',
        text: coachText('not-ready', death.tick, {
          player: nameOf(death.victim),
          enemy: nameOf(death.attacker),
          seconds: held.toFixed(1)
        })
      });
    }
  }

  // =========================================================================
  // spacing: two teammates fed to one enemy in sequence
  //
  // Neither player was wrong in their own duel. They were wrong together, which
  // is the cost every per-death rule misses.
  // =========================================================================
  if (duelModelReady) {
    const window = SPACING_SECONDS * tickRate;
    const byKiller = new Map();
    for (const d of deaths) {
      if (!byKiller.has(d.attacker)) byKiller.set(d.attacker, []);
      byKiller.get(d.attacker).push(d);
    }
    for (const [killer, list] of byKiller) {
      if (list.length < 2) continue;
      const killerSlot = byId.get(killer)?.slot;
      if (killerSlot == null) continue;
      list.sort((a, b) => a.tick - b.tick);

      const killerOdds = (death) => {
        const vs = byId.get(death.victim)?.slot;
        if (vs == null) return null;
        let snap;
        try {
          snap = snapshotWalked(death.tick - 1);
        } catch {
          return null;
        }
        const ctx = duelContext(snap, vs, killerSlot);
        if (!ctx?.pair) return null;
        // Read from the killer's seat so both deaths are on one scale.
        return 1 - predictDuel(ctx, weights);
      };

      for (let i = 1; i < list.length; i++) {
        const first = list[i - 1];
        const second = list[i];
        if (second.tick - first.tick > window) continue;
        if (sideOf(first.victim) !== sideOf(second.victim)) continue;
        if (!coachable(second.victim, second.tick)) continue;

        const a = killerOdds(first);
        const b = killerOdds(second);
        if (a === null || b === null) continue;
        if (a < SPACING_SOLO_MIN || a > SPACING_SOLO_MAX) continue;
        if (b < SPACING_SOLO_MIN || b > SPACING_SOLO_MAX) continue;
        const together = 1 - (1 - a) * (1 - b);
        if (together < SPACING_PAIR_ODDS || together >= FIGHT_WON) continue;

        flags.push({
          tick: second.tick,
          playerId: second.victim,
          rule: 'spacing',
          text: coachText('spacing', second.tick, {
            player: nameOf(second.victim),
            teammate: nameOf(first.victim),
            enemy: nameOf(killer),
            win: pct(together)
          })
        });
      }
    }
  }

  // =========================================================================
  // pushed-advantage: left held ground alone while the team was up a man
  // =========================================================================
  {
    const held = HELD_SECONDS * tickRate;
    for (const death of deaths) {
      if (!coachable(death.victim, death.tick)) continue;
      const side = sideOf(death.victim);
      const victimSlot = byId.get(death.victim)?.slot;
      if (victimSlot == null) continue;
      if (death.tick - held < firstTick) continue;

      // Up a man at the moment of the push.
      const aliveAt = (tick, want) => {
        let n = 0;
        for (const p of players) {
          if (sideOf(p.id) !== want) continue;
          const dead = deaths.some((d) => d.victim === p.id && d.tick <= tick);
          if (!dead) n++;
        }
        return n;
      };
      const pushTick = death.tick - held;
      const mine = aliveAt(pushTick, side);
      const theirs = aliveAt(pushTick, side === 'CT' ? 'T' : 'CT');
      if (mine <= theirs) continue;

      const before = sample(victimSlot, pushTick);
      const at = sample(victimSlot, death.tick - 1);
      if (!before?.alive || !at?.alive) continue;

      // Moved a real distance, and toward the enemy rather than away.
      const moved = dist2d(before, at);
      if (moved < PUSH_UNITS) continue;
      const enemySide = side === 'CT' ? 'T' : 'CT';
      const enemies = players
        .filter((p) => sideOf(p.id) === enemySide)
        .map((p) => sample(p.slot, death.tick - 1))
        .filter((s) => s?.alive);
      if (!enemies.length) continue;
      const nearBefore = Math.min(...enemies.map((e) => dist2d(before, e)));
      const nearAfter = Math.min(...enemies.map((e) => dist2d(at, e)));
      if (nearAfter >= nearBefore) continue;

      // Alone: no teammate close enough to have come with them.
      const mates = players
        .filter((p) => p.id !== death.victim && sideOf(p.id) === side)
        .map((p) => sample(p.slot, death.tick - 1))
        .filter((s) => s?.alive);
      if (mates.some((m) => dist2d(at, m) < ALONE_UNITS)) continue;

      flags.push({
        tick: death.tick,
        playerId: death.victim,
        rule: 'pushed-advantage',
        text: coachText('pushed-advantage', death.tick, {
          player: nameOf(death.victim),
          seconds: HELD_SECONDS
        })
      });
    }
  }

  // =========================================================================
  // late-rotation: began moving to the bomb too late to arrive in time
  // =========================================================================
  if (plantTick != null) {
    const bombEv = (meta.events?.bomb || []).find((b) => b?.type === 'planted');
    const centers = bombSiteCenters(network);
    const site =
      bombEv && Number.isFinite(bombEv.x)
        ? { x: bombEv.x, y: bombEv.y }
        : centers.a || centers.b;
    if (site) {
      const lateBy = ROTATE_LATE_SECONDS * tickRate;
      const checkAt = Math.min(lastTick, plantTick + lateBy);
      for (const p of players) {
        if (sideOf(p.id) !== 'CT') continue;
        if (!coachable(p.id, checkAt)) continue;
        const died = deaths.find((d) => d.victim === p.id && d.tick <= checkAt);
        if (died) continue;

        const atPlant = sample(p.slot, plantTick);
        const atCheck = sample(p.slot, checkAt);
        if (!atPlant?.alive || !atCheck?.alive) continue;

        const wasFar = dist2d(atPlant, site);
        const stillFar = dist2d(atCheck, site);
        if (stillFar < ROTATE_FAR_UNITS) continue;
        // Only counts as late if they had not already been travelling: someone
        // who has been closing the distance the whole time rotated on time and
        // simply had a long way to come.
        if (wasFar - stillFar > ROTATE_FAR_UNITS / 2) continue;
        // And only if arriving could no longer change the round.
        const secondsLeft = Math.max(0, BOMB_SECONDS - (checkAt - plantTick) / tickRate);
        const needed =
          stillFar / APPROACH_SPEED + RETAKE_DEFUSE_SECONDS + RETAKE_FIGHT_SECONDS;
        if (needed <= secondsLeft) continue;

        flags.push({
          tick: checkAt,
          playerId: p.id,
          rule: 'late-rotation',
          text: coachText('late-rotation', checkAt, {
            player: nameOf(p.id),
            seconds: Math.round((checkAt - plantTick) / tickRate),
            distance: `${Math.round(stillFar)} units`
          })
        });
      }
    }
  }

  // =========================================================================
  // smoke-peek: died across a line a teammate's smoke closed moments later
  // =========================================================================
  {
    const smokes = grenades.filter(
      (g) => g?.type === 'smokegrenade' && Number.isFinite(g.detonateTick) && g.at
    );
    if (smokes.length) {
      const soon = SMOKE_SOON_SECONDS * tickRate;
      for (const death of deaths) {
        if (!coachable(death.victim, death.tick)) continue;
        const side = sideOf(death.victim);
        const victimSlot = byId.get(death.victim)?.slot;
        const killerSlot = byId.get(death.attacker)?.slot;
        if (victimSlot == null || killerSlot == null) continue;

        const v = sample(victimSlot, death.tick - 1);
        const k = sample(killerSlot, death.tick - 1);
        if (!v?.alive || !k?.alive) continue;

        for (const g of smokes) {
          // The smoke has to be their own team's, and has to land after.
          if (sideOf(g.player) !== side) continue;
          const delay = g.detonateTick - death.tick;
          if (delay <= 0 || delay > soon) continue;
          // The line has to be open now and closed once the smoke is up.
          const openNow = !losBlockedBetween({
            ax: v.x,
            ay: v.y,
            bx: k.x,
            by: k.y,
            network,
            mapCode,
            smokes: blockingSmokesAt(grenades, death.tick, tickRate)
          });
          if (!openNow) continue;
          const closedLater = losBlockedBetween({
            ax: v.x,
            ay: v.y,
            bx: k.x,
            by: k.y,
            network,
            mapCode,
            smokes: [{ x: g.at.x, y: g.at.y }]
          });
          if (!closedLater) continue;

          flags.push({
            tick: death.tick,
            playerId: death.victim,
            rule: 'smoke-peek',
            text: coachText('smoke-peek', death.tick, {
              player: nameOf(death.victim),
              enemy: nameOf(death.attacker),
              seconds: (delay / tickRate).toFixed(1)
            })
          });
          break;
        }
      }
    }
  }

  // =========================================================================
  // flash-no-followup: an enemy was blinded and nobody used it
  // =========================================================================
  {
    const flashes = grenades.filter(
      (g) => g?.type === 'flashbang' && Number.isFinite(g.detonateTick) && g.at
    );
    const window = FOLLOWUP_SECONDS * tickRate;
    for (const g of flashes) {
      const side = sideOf(g.player);
      if (!side) continue;
      if (!coachable(g.player, g.detonateTick)) continue;
      if (g.detonateTick > lastTick) continue;

      // Who did it actually blind, and for how long.
      const after = g.detonateTick + Math.round(0.3 * tickRate);
      let blinded = null;
      let worst = 0;
      for (const p of players) {
        if (sideOf(p.id) === side) continue;
        const s = sample(p.slot, Math.min(lastTick, after));
        if (!s?.alive) continue;
        if ((s.flash || 0) > worst) {
          worst = s.flash;
          blinded = p;
        }
      }
      if (!blinded || worst < FLASH_MIN_BLIND) continue;

      // Somebody on the throwing side has to have been close enough for the
      // flash to have been thrown for them.
      const mates = players
        .filter((p) => sideOf(p.id) === side)
        .map((p) => sample(p.slot, g.detonateTick))
        .filter((s) => s?.alive);
      if (!mates.some((m) => dist2d(m, g.at) < FLASH_NEAR_UNITS)) continue;

      // Followed up? Any kill either way inside the window counts as the fight
      // having happened; so does any shot from the throwing side.
      const fought = deaths.some(
        (d) => d.tick >= g.detonateTick && d.tick <= g.detonateTick + window
      );
      if (fought) continue;
      const shotAt = (meta.events?.shots || []).some(
        (s) =>
          sideOf(s.player) === side &&
          (s.tick || 0) >= g.detonateTick &&
          (s.tick || 0) <= g.detonateTick + window
      );
      if (shotAt) continue;

      flags.push({
        tick: g.detonateTick,
        playerId: g.player,
        rule: 'flash-no-followup',
        text: coachText('flash-no-followup', g.detonateTick, {
          player: nameOf(g.player),
          enemy: nameOf(blinded.id),
          zone: zoneName(g.at, network),
          seconds: FOLLOWUP_SECONDS
        })
      });
    }
  }

  return flags;
}

/** Exported for the drift test: every rule this module can emit. */
export const TACTICAL_RULES = Object.freeze([
  'afterplant-duel',
  'not-ready',
  'spacing',
  'pushed-advantage',
  'late-rotation',
  'smoke-peek',
  'flash-no-followup'
]);
