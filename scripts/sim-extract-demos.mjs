#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-extract-demos.mjs
// K1 of SIM-PLAN 9.3b: behaviour-cloning samples from real demos.
//
// K0 (sim-mine-knowledge.mjs) mined what a position IS: where winners stand on
// Banana, when they get there, what they throw. This script mines what a
// winner DID at one moment, so a network can learn the residual: given that
// knowledge and this situation, what did the human actually do.
//
// What the operator asked to be captured, and where each lands:
//
//   positions in situations   `moveTo`, the anchor they were heading for over
//                             the next 3 s, plus `contract` as a conditioner
//   teammate configuration    the observation's teammate block already carries
//                             four living mates as relative offsets, so "when
//                             mid is alive and short is dead" is IN the input
//   how to clear on a call    `call` is a conditioner on every sample and the
//                             clearing order falls out of moveTo + aim over
//                             the steps after the call commits
//   copying movement          `gait`, `peek`, and the 12-step history window,
//                             which is what makes a jiggle distinguishable
//                             from a wide swing at all
//   refrag                    `refrag` marks the seconds after a teammate died
//                             near this player, and those samples are weighted
//                             up: it is the highest-value behaviour in the
//                             corpus and the rarest
//   where they aim            `aim`, the OFFSET from where they looked to the
//                             bearing of the thing that mattered. Absolute yaw
//                             is map trivia; the offset transfers
//
// Two rules inherited from the operator's brief, unchanged: only WINNING sides
// are labelled, and belief is replayed through the knowledge tracker so a bot
// is trained on what the player could SEE, never on god-view.
//
//   node scripts/sim-extract-demos.mjs --limit 20 --maps INF
//   node scripts/sim-extract-demos.mjs --batch 400
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { decodeReplayPackage } from '../src/replays/shared/replayPackage.js';
import { decodeTickz } from '../server/replays/tickCodec.js';
import { TickTrack } from '../src/replays/tickStore.js';
import { roundTagsFor } from '../src/replays/analytics/roundTags.js';
import { loadBake } from '../server/sim/bakes.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { JointBelief } from '../shared/sim/knowledge.js';
import { Rng } from '../shared/sim/rng.js';
import { buildObservation, OBSERVATION_SIZE, OBSERVE_VERSION, weaponClassOf } from '../shared/sim/observe.js';
import { OPTION_IDS } from '../shared/sim/options.js';
import { isSynthetic } from '../shared/sim/firewall.js';
import { optionAt, PACK_RADIUS, segmentTrack } from '../shared/sim/optionSegmenter.js';
import { weaponInfo } from '../src/replays/shared/weaponTable.js';
import {
  AIM_BUCKETS,
  DEMO_DATASET_VERSION,
  HISTORY_HZ,
  HISTORY_STEPS,
  PEEK_STYLES,
  REFRAG_RADIUS,
  REFRAG_WINDOW_SECONDS
} from '../shared/sim/demoContracts.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DIR = flag('dir', 'D:/Dev/trainingdemos');
const OUT = flag('out', path.join(REPLAY_ROOT, 'sim', 'datasets', 'demos'));
const ONLY_MAPS = String(flag('maps', '') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LIMIT = Number(flag('limit', 0)) || 0;
const BATCH = Number(flag('batch', 0)) || 0;
const SHARD_SAMPLES = Number(flag('shard-samples', 250000));
const CHECKPOINT_EVERY = Number(flag('checkpoint', 25));
const REBUILD = has('rebuild');
const IS_WORKER = has('worker');
/**
 * Parallel workers. Demos are independent, so this scales almost linearly to
 * the core count; the ceiling is cores minus two so the desktop stays usable,
 * and each worker holds one package at a time, so memory is JOBS x one demo
 * rather than JOBS x the corpus.
 */
const JOBS = (() => {
  const asked = Number(flag('jobs', 1)) || 1;
  return Math.max(1, Math.min(asked, Math.max(1, os.cpus().length - 2)));
})();

/** Sampling cadence for the stride half of 9.3b's table. */
const STRIDE_HZ = 4;
/** Seconds ahead the move label looks to decide where they were going. */
const MOVE_LOOKAHEAD = 3;
/** Under this displacement over the lookahead they were holding, not moving. */
const HOLD_UNITS = 110;
/** Running, in units per second, from the engine's own walk/run split. */
const RUN_SPEED = 150;
/**
 * How long a sighting stays a fair thing to have your crosshair on. Past this
 * the information is stale and "he is not looking at it" stops being a
 * mistake. `[calibrate]`
 */
const AIM_MEMORY_SECONDS = 6;
/** Sample weights. Refrag and utility are rare and precious (9.3). */
const W_HOLD = 0.6;
const W_MOVE = 1;
const W_UTILITY = 3;
const W_REFRAG = 4;

const round3 = (x) => Math.round(x * 1e3) / 1e3;
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

// ---------------------------------------------------------------------------

const mapCache = new Map();
async function mapState(map) {
  if (mapCache.has(map)) return mapCache.get(map);
  let state = null;
  try {
    const nav = await loadBake('navcache', map);
    const ang = await loadBake('angles', map);
    if (!nav || !ang) throw new Error('no bake');
    let network = null;
    try {
      network = JSON.parse(await fsp.readFile(path.join(REPLAY_ROOT, 'zones', `${map}.json`), 'utf8'));
    } catch {
      network = null;
    }
    state = { graph: navGraphFromBake(nav.bake), angles: loadAngles(ang.bake), network };
  } catch {
    state = null;
  }
  mapCache.set(map, state);
  return state;
}

/**
 * How a player showed himself over the last second, from the pose trace.
 *
 * The shapes are deliberately crude and deliberately about EXPOSURE rather
 * than about speed: a jiggle is ground given and taken straight back, a wide
 * swing is ground given and kept while moving fast. Getting this wrong makes
 * a bot that "peeks" by walking in a straight line, which is the tell every
 * scripted bot has ever had.
 */
function peekStyle(trail, lastPeekSeconds) {
  if (trail.length < 3) return 'none';
  // A peek STARTS FROM A HOLD. Without this, a player running down mid scores
  // as a wide swing and a player who ran twice scores as a repeek, which is
  // how the first pass ended up with more repeeks than holds. Rotating is
  // travel; showing yourself from a position you were holding is a peek.
  if ((trail[0].speed || 0) > 60) return 'none';
  const start = trail[0];
  const end = trail[trail.length - 1];
  let maxOut = 0;
  for (const p of trail) {
    const d = Math.hypot(p.x - start.x, p.y - start.y);
    if (d > maxOut) maxOut = d;
  }
  const net = Math.hypot(end.x - start.x, end.y - start.y);
  const speed = trail.reduce((s, p) => s + (p.speed || 0), 0) / trail.length;

  if (maxOut < 30) return 'hold';
  // Went out and came back: the ground was given and taken straight back.
  if (maxOut > 60 && net < maxOut * 0.45) {
    return maxOut < 140 ? 'jiggle' : 'shoulder';
  }
  if (net > 120 && speed > RUN_SPEED * 0.8) {
    return lastPeekSeconds != null && lastPeekSeconds < 3 ? 'repeek' : 'wide';
  }
  return 'none';
}

/** Which bucket the aim offset falls in. The offset is the transferable part. */
function aimBucket(offsetDeg) {
  const a = Math.abs(offsetDeg);
  if (a <= 10) return 'on';
  if (a <= 35) return 'near';
  if (a <= 90) return 'off';
  return 'away';
}

// ---------------------------------------------------------------------------

/**
 * Turn one round into samples for the winning side.
 *
 * Belief is a real JointBelief fed only percepts that side could have had:
 * a sighting when a LIVING teammate has line of sight through the angle
 * catalogue, and the kill feed, which is public in CS. Nothing reads an enemy
 * position directly, so a player who never saw the CT is never trained as if
 * he did.
 */
function extractRound({ meta, track, state, map, rng, onSample }) {
  const tickRate = meta.tickRate || 64;
  const t0 = meta.freezeEndTick ?? meta.startTick ?? 0;
  const endTick = Math.min(meta.endTick ?? t0, t0 + 115 * tickRate);
  if (!(endTick > t0)) return 0;

  const side1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  const sideOfTeam = { 1: side1, 2: side1 === 'CT' ? 'T' : 'CT' };
  const winnerTeam = meta.winner === 2 ? 2 : 1;
  const winSide = meta.winnerSide || sideOfTeam[winnerTeam];

  let call = 'default';
  if (state.network) {
    try {
      const tags = roundTagsFor({ meta, track, network: state.network, utilities: [], mapCode: map });
      const list = winSide === 'CT' ? tags.ct : tags.t;
      if (list?.length) call = list[0].k;
    } catch {
      /* untaggable round is a default round */
    }
  }

  const roster = meta.players || [];
  const winners = roster.filter((p) => p.team === winnerTeam);
  const foes = roster.filter((p) => p.team !== winnerTeam);
  if (winners.length === 0 || foes.length === 0) return 0;

  const belief = new JointBelief({
    anchors: [...state.graph.anchors.keys()],
    rng: rng.fork()
  });

  // Deaths, from the public kill feed: when, where, and who.
  const deaths = [];
  for (const k of meta.events?.kills || []) {
    deaths.push({ tick: k.tick, victim: k.victim, attacker: k.attacker });
  }
  const deathTickOf = new Map();
  for (const d of deaths) if (!deathTickOf.has(d.victim)) deathTickOf.set(d.victim, d.tick);

  const grenades = meta.events?.grenades || [];
  const step = Math.max(1, Math.round(tickRate / STRIDE_HZ));
  const historyStep = Math.max(1, Math.round(tickRate / HISTORY_HZ));
  const states = [];
  const trails = new Map(); // slot -> recent poses
  const lastPeek = new Map(); // slot -> seconds
  const deadFoes = new Set();
  /**
   * Where this side last actually SAW an enemy, and when. Shared across the
   * five, because a sighting is team knowledge the moment it happens. This is
   * the honest reference for the aim label: a crosshair is worth measuring
   * against something the player could have been looking at.
   */
  let lastSeen = null;
  const roundKey = `${meta.demoId || ''}:${meta.round ?? 0}`;
  let stepIndex = -1;

  let site = null;
  const planted = (meta.events?.bomb || []).find((b) => b.type === 'planted' || b.type === 'plant');
  if (planted && Number.isFinite(planted.x) && Number.isFinite(planted.y)) {
    site = { x: planted.x, y: planted.y };
  }

  const deathPos = [];
  for (const d of deaths) {
    const victim = roster.find((r) => r.id === d.victim);
    if (!victim || victim.team !== winnerTeam) continue;
    const vs = track.sample(victim.slot, d.tick, {});
    if (vs) deathPos.push({ tick: d.tick, x: vs.x, y: vs.y, slot: victim.slot });
  }

  const poseTracks = new Map();
  for (const p of winners) poseTracks.set(p.slot, []);
  const aSite = state.graph.anchor('a_site')?.world;
  const bSite = state.graph.anchor('b_site')?.world;
  let deepest = null;
  const scratch = {};
  for (let tick = t0; tick <= endTick; tick += step) {
    const living = [];
    for (const p of winners) {
      const me = track.sample(p.slot, tick, scratch);
      if (me?.alive) {
        const pose = { tick, x: me.x, y: me.y };
        poseTracks.get(p.slot).push(pose);
        living.push(pose);
      }
    }
    if (!site && living.length >= 2 && (aSite || bSite)) {
      const cx = living.reduce((s, p) => s + p.x, 0) / living.length;
      const cy = living.reduce((s, p) => s + p.y, 0) / living.length;
      const dA = aSite ? Math.hypot(cx - aSite.x, cy - aSite.y) : Infinity;
      const dB = bSite ? Math.hypot(cx - bSite.x, cy - bSite.y) : Infinity;
      const cand = dA <= dB ? aSite : bSite;
      const d = Math.min(dA, dB);
      const near = living.filter((p) => Math.hypot(p.x - cand.x, p.y - cand.y) <= PACK_RADIUS).length;
      if (near >= 2 && (!deepest || d < deepest.d)) deepest = { site: cand, d };
    }
  }
  if (!site) site = deepest?.site || null;

  // The objective channels, per slot.
  //
  // optionSegmenter labels `plant` and `defuse` from attested channel events
  // and says so — "a channel outranks feet, in labels as in play" — but it was
  // never given any, so those two options could not be produced at all. In a
  // corpus of 3,248 Cache rounds the option head saw seven of the thirty-two
  // words, and neither of these was among them.
  //
  // The demo meta records the END of each channel (the plant, the defuse), so
  // the start is backed off by how long the channel takes. Both durations are
  // the game's, not ours: 3.2 s to plant, 10 s to defuse bare-handed and 5 s
  // with a kit.
  const eventsBySlot = new Map();
  const pushEvent = (slot, ev) => {
    if (slot == null) return;
    if (!eventsBySlot.has(slot)) eventsBySlot.set(slot, []);
    eventsBySlot.get(slot).push(ev);
  };
  const slotOfId = (id) => roster.find((r) => r.id === id)?.slot ?? null;
  const hasKit = (id) =>
    (meta.stats?.[id]?.loadout || []).some((item) => /defus|kit/i.test(String(item)));

  for (const b of meta.events?.bomb || []) {
    const slot = slotOfId(b.player);
    if (slot == null || !Number.isFinite(b.tick)) continue;
    if (b.type === 'planted' || b.type === 'plant') {
      pushEvent(slot, { type: 'plant_start', tick: b.tick - Math.round(3.2 * tickRate) });
      pushEvent(slot, { type: 'plant_end', tick: b.tick });
    } else if (b.type === 'defused' || b.type === 'defuse') {
      const seconds = hasKit(b.player) ? 5 : 10;
      pushEvent(slot, { type: 'defuse_start', tick: b.tick - Math.round(seconds * tickRate) });
      pushEvent(slot, { type: 'defuse_end', tick: b.tick });
    }
  }
  // Damage taken, which the segmenter reads for its reactive labels. The kill
  // feed is the only attested source here; a demo carries no per-tick health
  // delta this pass reads.
  for (const d of deaths) {
    const slot = slotOfId(d.victim);
    if (slot != null) pushEvent(slot, { type: 'damage', tick: d.tick });
  }
  for (const list of eventsBySlot.values()) list.sort((a, b) => a.tick - b.tick);

  const segmentsBySlot = new Map();
  for (const p of winners) {
    const poses = poseTracks.get(p.slot) || [];
    const teammates = winners
      .filter((m) => m.slot !== p.slot)
      .map((m) => poseTracks.get(m.slot) || []);
    segmentsBySlot.set(
      p.slot,
      segmentTrack({
        poses,
        tickRate,
        teammates,
        site,
        events: eventsBySlot.get(p.slot) || [],
        deaths: deathPos.filter((d) => d.slot !== p.slot)
      })
    );
  }

  let written = 0;

  for (let tick = t0; tick <= endTick; tick += step) {
    track.sampleAll(tick, states);
    const seconds = (tick - t0) / tickRate;
    stepIndex += 1;

    // ---- percepts: what this side could legitimately know ----------------
    for (const f of foes) {
      const ft = deathTickOf.get(f.id);
      if (ft != null && tick >= ft && !deadFoes.has(f.id)) {
        deadFoes.add(f.id);
        belief.killed(foes.indexOf(f));
      }
    }
    for (const f of foes) {
      if (deadFoes.has(f.id)) continue;
      const fs2 = states[f.slot];
      if (!fs2?.alive) continue;
      for (const w of winners) {
        const ws = states[w.slot];
        if (!ws?.alive) continue;
        if (!state.angles.canSee(ws.x, ws.y, fs2.x, fs2.y, 'default')) continue;
        const at = state.angles.nearestAnchor(fs2.x, fs2.y);
        if (at) belief.sighting(foes.indexOf(f), at.id, { weapon: 'ak47' });
        lastSeen = { x: fs2.x, y: fs2.y, seconds };
        break;
      }
    }

    const aliveWinners = winners.filter((p) => states[p.slot]?.alive);
    const aliveFoes = foes.filter((p) => !deadFoes.has(p.id));

    // ---- one sample per living winner -------------------------------------
    for (const p of winners) {
      const me = states[p.slot];
      if (!me?.alive) continue;

      // Pose trail, for the peek shape and the gait.
      let trail = trails.get(p.slot);
      if (!trail) {
        trail = [];
        trails.set(p.slot, trail);
      }
      const prev = trail.length ? trail[trail.length - 1] : null;
      const dtSec = step / tickRate;
      const speed = prev ? Math.hypot(me.x - prev.x, me.y - prev.y) / dtSec : 0;
      trail.push({ x: me.x, y: me.y, yaw: me.yaw, speed, seconds });
      while (trail.length > 5) trail.shift();

      // Where were they going? The anchor nearest their pose in 3 seconds.
      const aheadTick = Math.min(endTick, tick + MOVE_LOOKAHEAD * tickRate);
      const ahead = track.sample(p.slot, aheadTick, {});
      const displaced = Math.hypot(ahead.x - me.x, ahead.y - me.y);
      const goingTo = displaced > HOLD_UNITS ? state.angles.nearestAnchor(ahead.x, ahead.y) : null;
      const here = state.angles.nearestAnchor(me.x, me.y);

      // Refrag: did a teammate just die near me?
      let refrag = 0;
      let refragBearing = null;
      for (const d of deaths) {
        const dt = (tick - d.tick) / tickRate;
        if (dt < 0 || dt > REFRAG_WINDOW_SECONDS) continue;
        const victim = roster.find((r) => r.id === d.victim);
        if (!victim || victim.team !== winnerTeam || victim.id === p.id) continue;
        const vs = track.sample(victim.slot, d.tick, {});
        const dist = Math.hypot(vs.x - me.x, vs.y - me.y);
        if (dist > REFRAG_RADIUS) continue;
        refrag = 1;
        refragBearing = (Math.atan2(vs.y - me.y, vs.x - me.x) * 180) / Math.PI;
        break;
      }

      // What mattered to look at, in priority order: the cell a mate just died
      // in, else the last place this side actually saw somebody. When neither
      // exists there is NO LABEL, and that is the whole fix.
      //
      // The first pass used the highest-mass belief anchor as the reference.
      // Early in a round the belief is near uniform, so that argmax is
      // arbitrary and the label was noise: the head scored 0.383 against a
      // 0.359 majority floor, which is to say it learned nothing at all. A
      // masked sample teaches nothing; a wrong one teaches wrongly.
      let target = refragBearing;
      if (target == null && lastSeen && seconds - lastSeen.seconds <= AIM_MEMORY_SECONDS) {
        target = (Math.atan2(lastSeen.y - me.y, lastSeen.x - me.x) * 180) / Math.PI;
      }
      const aimOffset = target == null ? null : wrapDeg(me.yaw - target);

      const style = peekStyle(trail, lastPeek.get(p.slot) != null ? seconds - lastPeek.get(p.slot) : null);
      if (style === 'jiggle' || style === 'shoulder' || style === 'wide' || style === 'repeek') {
        lastPeek.set(p.slot, seconds);
      }

      // Utility thrown in this window.
      let util = 'none';
      for (const g of grenades) {
        if (g.player !== p.id) continue;
        const gs = (g.throwTick - t0) / tickRate;
        if (Math.abs(gs - seconds) <= 0.5) {
          util = g.type;
          break;
        }
      }

      // ---- the observation, from what this side knew ---------------------
      const mates = aliveWinners
        .filter((m) => m.slot !== p.slot)
        .slice(0, 4)
        .map((m) => ({
          dx: states[m.slot].x - me.x,
          dy: states[m.slot].y - me.y,
          hp: states[m.slot].health
        }));

      const stat = meta.stats?.[p.id] || {};
      const weaponName = (meta.weapons || [])[me.weapon] || '';
      const obs = buildObservation({
        me: {
          x: me.x,
          y: me.y,
          hp: me.health,
          armor: me.armor,
          helmet: (me.flags & 128) !== 0,
          weaponClass: weaponClassOf(weaponInfo(weaponName).category),
          hasBomb: (me.flags & 32) !== 0,
          side: winSide
        },
        round: {
          elapsed: seconds,
          secondsLeft: Math.max(0, 115 - seconds),
          planted: meta.plantTick != null && tick >= meta.plantTick,
          bombSecondsLeft:
            meta.plantTick != null && tick >= meta.plantTick
              ? Math.max(0, 40 - (tick - meta.plantTick) / tickRate)
              : 0,
          myEquipAvg: stat.equipValue || 0,
          enemyEquipAvgBelieved: 3000
        },
        myAlive: aliveWinners.length,
        enemyAliveBelieved: aliveFoes.length,
        belief: {
          siteExpected: [0, 0],
          sitePEmpty: [0, 0],
          splitEntropy: belief.splitEntropy([
            { name: 'here', test: (anchor) => anchor === here?.id },
            { name: 'rest', test: (anchor) => anchor !== here?.id }
          ]),
          threatAtMe: Math.min(1, belief.massAt(here?.id || '', 'default'))
        },
        teammates: mates,
        recency: { sinceSeenSeconds: 10, sinceHeardSeconds: 10 }
      });

      const isEvent = refrag || util !== 'none' || style !== 'none';
      const w = refrag ? W_REFRAG : util !== 'none' ? W_UTILITY : goingTo ? W_MOVE : W_HOLD;
      const covering = optionAt(segmentsBySlot.get(p.slot) || [], tick);

      onSample({
        obs: obs.map(round3),
        // No history array on the line. Samples for one (round, slot) are
        // emitted in order at HISTORY_HZ, so the trainer rebuilds the 12-step
        // window from `seq` for a thirteenth of the disk: storing it inline
        // would have cost about 320 GB over the corpus.
        seq: { round: roundKey, slot: p.slot, i: stepIndex },
        cond: {
          map,
          side: winSide,
          call,
          contract: here?.id || 'any',
          player: p.steamId || p.id
        },
        y: {
          moveTo: goingTo?.id || null,
          gait: speed > RUN_SPEED ? 'run' : speed > 20 ? 'walk' : 'stand',
          peek: style,
          refrag,
          // null becomes -1 in the trainer, which masks it out of the loss.
          aim: aimOffset == null ? null : aimBucket(aimOffset),
          // The aux regression is not masked, so an unreferenced step reads 0
          // rather than a fabricated angle. It is dropped at export anyway.
          aimOffset: aimOffset == null ? 0 : round3(aimOffset),
          utility: util,
          option: covering?.option || (goingTo ? 'advance' : 'hold_angle'),
          spacingDx: covering?.detail?.spacing?.dx ?? 0,
          spacingDy: covering?.detail?.spacing?.dy ?? 0
        },
        w: isEvent ? w : w * 0.8,
        ev: isEvent ? 1 : 0
      });
      written += 1;


    }
  }
  return written;
}

// ---------------------------------------------------------------------------

class Progress {
  constructor(total, outDir) {
    this.total = total;
    this.outDir = outDir;
    this.done = 0;
    this.samples = 0;
    this.rounds = 0;
    this.failed = 0;
    this.reasons = new Map();
    this.labels = new Map();
    this.calls = new Map();
    this.startedAt = Date.now();
    this.lastWrite = 0;
  }

  note(y) {
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    bump(this.labels, `peek:${y.peek}`);
    bump(this.labels, `option:${y.option}`);
    if (y.refrag) bump(this.labels, 'refrag');
    if (y.utility !== 'none') bump(this.labels, `util:${y.utility}`);
    bump(this.labels, `aim:${y.aim}`);
  }

  tick(map, rounds, samples) {
    this.done += 1;
    this.rounds += rounds;
    this.samples += samples;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.done / Math.max(0.001, elapsed);
    const eta = rate > 0 ? (this.total - this.done) / rate : 0;
    console.log(
      `[${String(this.done).padStart(5)}/${this.total}] ` +
        `${((this.done / Math.max(1, this.total)) * 100).toFixed(1).padStart(5)}%  ` +
        `${(map || '???').padEnd(4)} ${String(rounds).padStart(2)}r  ` +
        `${this.samples.toLocaleString()} samples  ${rate.toFixed(1)}/s  ` +
        `ETA ${fmtDuration(eta)}  heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)}MB` +
        (this.failed ? `  skipped ${this.failed}` : '')
    );
    if (Date.now() - this.lastWrite > 2000) this.write();
  }

  write() {
    this.lastWrite = Date.now();
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.done / Math.max(0.001, elapsed);
    writeAtomic(
      path.join(this.outDir, 'progress.json'),
      JSON.stringify(
        {
          phase: 'extract-demos',
          done: this.done,
          total: this.total,
          percent: Math.round((this.done / Math.max(1, this.total)) * 1000) / 10,
          rounds: this.rounds,
          samples: this.samples,
          failed: this.failed,
          reasons: Object.fromEntries(this.reasons),
          labels: Object.fromEntries(this.labels),
          calls: Object.fromEntries(this.calls),
          demosPerSecond: Math.round(rate * 100) / 100,
          etaSeconds: Math.round(rate > 0 ? (this.total - this.done) / rate : 0),
          heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
          startedAt: new Date(this.startedAt).toISOString(),
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  }
}

// ---------------------------------------------------------------------------

/** The meta line every shard opens with, so a shard is self-describing. */
function metaLine() {
  return JSON.stringify({
    type: 'meta',
    v: DEMO_DATASET_VERSION,
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    historySteps: HISTORY_STEPS,
    historyHz: HISTORY_HZ,
    vocab: OPTION_IDS,
    peekStyles: PEEK_STYLES,
    aimBuckets: AIM_BUCKETS,
    source: DIR
  });
}

/**
 * One demo, start to finish. The only unit of work either mode deals in, so
 * the serial path and the parallel workers cannot drift apart.
 *
 * @returns {{demoId, map, rounds, samples, labels, calls, error}}
 */
async function processDemo(file, rng, emit) {
  const demoId = path.basename(file, '.aim4replay');
  const out = { demoId, map: null, rounds: 0, samples: 0, labels: {}, calls: {}, error: null };
  try {
    const { files } = decodeReplayPackage(await fsp.readFile(path.join(DIR, file)));
    const stems = new Set();
    for (const name of files.keys()) {
      const m = /^rounds\/(.+?)\.(tickz|json\.zst)$/.exec(name);
      if (m) stems.add(m[1]);
    }
    for (const stem of stems) {
      const metaRaw = files.get(`rounds/${stem}.json.zst`);
      const tickRaw = files.get(`rounds/${stem}.tickz`);
      if (!metaRaw || !tickRaw) continue;
      const meta = JSON.parse(zlib.zstdDecompressSync(Buffer.from(metaRaw)).toString('utf8'));
      // 9.3 step 1's "exclude synthetic", enforced rather than assumed (12.1).
      // This path reads packages from a folder, not the server library, so the
      // demo store's guards never see it: a sim round exported into the
      // training folder would otherwise be cloned as if a human had played it.
      if (isSynthetic(meta)) continue;
      const code = String(meta.map || '').toUpperCase();
      if (!code) continue;
      if (ONLY_MAPS.length && !ONLY_MAPS.includes(code)) break;
      const state = await mapState(code);
      if (!state) continue;
      out.map = code;
      const track = new TickTrack(decodeTickz(Buffer.from(tickRaw)));
      out.samples += extractRound({
        meta,
        track,
        state,
        map: code,
        rng,
        onSample: (s) => {
          const k = `peek:${s.y.peek}`;
          out.labels[k] = (out.labels[k] || 0) + 1;
          const a = `aim:${s.y.aim}`;
          out.labels[a] = (out.labels[a] || 0) + 1;
          if (s.y.refrag) out.labels.refrag = (out.labels.refrag || 0) + 1;
          if (s.y.utility !== 'none') {
            const u = `util:${s.y.utility}`;
            out.labels[u] = (out.labels[u] || 0) + 1;
          }
          out.calls[s.cond.call] = (out.calls[s.cond.call] || 0) + 1;
          emit(s);
        }
      });
      out.rounds += 1;
    }
  } catch (err) {
    out.error = String(err.message || err).slice(0, 60);
  }
  return out;
}

/**
 * Worker mode. Owns its OWN shard files so no two processes ever write the
 * same one, reports a message per demo, and holds one package at a time like
 * the serial path did: N workers cost N packages, not N corpora.
 */
async function runWorker() {
  const id = Number(flag('worker-id', 0));
  const rng = new Rng(4242 + id);
  let shardIndex = 0;
  let lines = [metaLine()];
  let count = 0;
  const shards = [];

  const closeShard = () => {
    if (!count) return;
    const name = `shard-w${id}-${String(shardIndex).padStart(3, '0')}.jsonl`;
    writeAtomic(path.join(OUT, name), lines.join('\n'));
    shards.push({ file: name, samples: count });
    shardIndex += 1;
    lines = [metaLine()];
    count = 0;
  };

  let stopping = false;
  process.on('message', (msg) => {
    if (msg?.type === 'stop') stopping = true;
  });

  const files = await new Promise((resolve) => {
    process.on('message', (msg) => {
      if (msg?.type === 'files') resolve(msg.files);
    });
    process.send({ type: 'ready' });
  });

  const done = [];
  for (const file of files) {
    if (stopping) break;
    const r = await processDemo(file, rng, (s) => {
      lines.push(JSON.stringify(s));
      count += 1;
      if (count >= SHARD_SAMPLES) closeShard();
    });
    if (!r.error) done.push(r.demoId);
    process.send({ type: 'demo', ...r });
  }
  closeShard();
  process.send({ type: 'done', shards, demos: done });
  process.exit(0);
}

async function main() {
  if (IS_WORKER) return runWorker();
  await fsp.mkdir(OUT, { recursive: true });
  const manifestFile = path.join(OUT, 'manifest.json');

  let manifest = { v: DEMO_DATASET_VERSION, obsVersion: OBSERVE_VERSION, demos: [], shards: [], samples: 0 };
  if (!REBUILD) {
    try {
      const prev = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      if (prev.v === DEMO_DATASET_VERSION && prev.obsVersion === OBSERVE_VERSION) manifest = prev;
    } catch {
      /* first run */
    }
  }
  const seen = new Set(manifest.demos);

  let all;
  try {
    all = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.aim4replay'));
  } catch (err) {
    console.error(`cannot read ${DIR}: ${err.message}`);
    process.exit(1);
  }
  all.sort();

  let todo = all.filter((f) => !seen.has(path.basename(f, '.aim4replay')));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  if (BATCH) todo = todo.slice(0, BATCH);

  console.log(`corpus ${all.length} demos in ${DIR}`);
  console.log(`already extracted ${seen.size}, this run ${todo.length}` + (ONLY_MAPS.length ? `, maps ${ONLY_MAPS.join(',')}` : ''));
  if (!todo.length) {
    console.log('nothing to do. --rebuild to start over.');
    return;
  }

  const progress = new Progress(todo.length, OUT);
  const rng = new Rng(4242);

  // ---- parallel path ------------------------------------------------------
  //
  // Demos are completely independent, so this is the one place in the project
  // where fanning out is free of correctness questions. Each worker owns its
  // own shard files; the parent owns the manifest, the progress line and the
  // decision to stop. Serial stays the default because it is the easier thing
  // to debug, and because one core is plenty for `--limit 5`.
  if (JOBS > 1) {
    const workers = [];
    const buckets = Array.from({ length: JOBS }, () => []);
    // Round robin rather than contiguous blocks: the corpus is sorted, maps
    // cluster in it, and a contiguous split would give one worker every Nuke
    // demo and the map bakes that come with them.
    todo.forEach((f, i) => buckets[i % JOBS].push(f));

    console.log(`fanning out over ${JOBS} workers (${os.cpus().length} cores)`);

    let stopping = false;
    const stopAll = () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log('\nstopping after the demos in flight. progress is kept; re-run to continue.');
      for (const w of workers) w.send({ type: 'stop' });
    };
    process.on('SIGINT', stopAll);

    await Promise.all(
      buckets.map(
        (files, id) =>
          new Promise((resolve) => {
            if (!files.length) return resolve();
            const w = fork(fileURLToPath(import.meta.url), [...args, '--worker', '--worker-id', String(id)], {
              stdio: ['ignore', 'inherit', 'inherit', 'ipc']
            });
            workers.push(w);
            w.on('message', (msg) => {
              if (msg?.type === 'ready') {
                w.send({ type: 'files', files });
                return;
              }
              if (msg?.type === 'demo') {
                if (msg.error) {
                  progress.failed += 1;
                  progress.reasons.set(msg.error, (progress.reasons.get(msg.error) || 0) + 1);
                } else {
                  manifest.demos.push(msg.demoId);
                }
                for (const [k, n] of Object.entries(msg.labels || {})) {
                  progress.labels.set(k, (progress.labels.get(k) || 0) + n);
                }
                for (const [k, n] of Object.entries(msg.calls || {})) {
                  progress.calls.set(k, (progress.calls.get(k) || 0) + n);
                }
                progress.tick(msg.map, msg.rounds, msg.samples);
                return;
              }
              if (msg?.type === 'done') {
                for (const s of msg.shards || []) manifest.shards.push(s);
              }
            });
            w.on('exit', () => resolve());
          })
      )
    );

    manifest.samples = (manifest.samples || 0) + progress.samples;
    manifest.updatedAt = new Date().toISOString();
    writeAtomic(manifestFile, JSON.stringify(manifest, null, 2));
    progress.write();
    report(progress, manifest, all, seen);
    return;
  }

  let shardIndex = manifest.shards.length;
  let shardLines = [];
  let shardCount = 0;

  const openShard = () => {
    shardLines = [
      JSON.stringify({
        type: 'meta',
        v: DEMO_DATASET_VERSION,
        obsVersion: OBSERVE_VERSION,
        obsSize: OBSERVATION_SIZE,
        historySteps: HISTORY_STEPS,
        historyHz: HISTORY_HZ,
        vocab: OPTION_IDS,
        peekStyles: PEEK_STYLES,
        aimBuckets: AIM_BUCKETS,
        source: DIR
      })
    ];
    shardCount = 0;
  };
  const closeShard = () => {
    if (!shardCount) return;
    const name = `shard-${String(shardIndex).padStart(4, '0')}.jsonl`;
    writeAtomic(path.join(OUT, name), shardLines.join('\n'));
    manifest.shards.push({ file: name, samples: shardCount });
    shardIndex += 1;
    shardLines = [];
    shardCount = 0;
  };
  openShard();

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nstopping after this demo. progress is kept; re-run to continue.');
  });

  const saveManifest = async () => {
    manifest.samples = progress.samples;
    manifest.updatedAt = new Date().toISOString();
    writeAtomic(manifestFile, JSON.stringify(manifest, null, 2));
    progress.write();
  };

  for (const file of todo) {
    if (stopping) break;
    const demoId = path.basename(file, '.aim4replay');
    let map = null;
    let rounds = 0;
    let samples = 0;
    try {
      const { files } = decodeReplayPackage(await fsp.readFile(path.join(DIR, file)));
      const stems = new Set();
      for (const name of files.keys()) {
        const m = /^rounds\/(.+?)\.(tickz|json\.zst)$/.exec(name);
        if (m) stems.add(m[1]);
      }
      for (const stem of stems) {
        const metaRaw = files.get(`rounds/${stem}.json.zst`);
        const tickRaw = files.get(`rounds/${stem}.tickz`);
        if (!metaRaw || !tickRaw) continue;
        const meta = JSON.parse(zlib.zstdDecompressSync(Buffer.from(metaRaw)).toString('utf8'));
        // Same refusal as the worker path (12.1). Both loops decode packages
        // independently, so a guard on one of them is a guard on neither.
        if (isSynthetic(meta)) continue;
        const code = String(meta.map || '').toUpperCase();
        if (!code) continue;
        if (ONLY_MAPS.length && !ONLY_MAPS.includes(code)) break;
        const state = await mapState(code);
        if (!state) continue;
        map = code;
        const track = new TickTrack(decodeTickz(Buffer.from(tickRaw)));
        const n = extractRound({
          meta,
          track,
          state,
          map: code,
          rng,
          onSample: (s) => {
            progress.note(s.y);
            progress.calls.set(s.cond.call, (progress.calls.get(s.cond.call) || 0) + 1);
            shardLines.push(JSON.stringify(s));
            shardCount += 1;
            if (shardCount >= SHARD_SAMPLES) {
              closeShard();
              openShard();
            }
          }
        });
        samples += n;
        rounds += 1;
      }
      manifest.demos.push(demoId);
    } catch (err) {
      progress.failed += 1;
      const reason = String(err.message || err).slice(0, 60);
      progress.reasons.set(reason, (progress.reasons.get(reason) || 0) + 1);
    }
    progress.tick(map, rounds, samples);
    if (progress.done % CHECKPOINT_EVERY === 0) {
      closeShard();
      openShard();
      await saveManifest();
    }
  }

  closeShard();
  await saveManifest();
  report(progress, manifest, all, seen);
}

/** The closing summary, shared by the serial and parallel paths. */
function report(progress, manifest, all, seen) {
  const elapsed = (Date.now() - progress.startedAt) / 1000;
  console.log(`\n${progress.samples.toLocaleString()} samples from ${progress.rounds} rounds of ${progress.done} demos in ${fmtDuration(elapsed)}`);
  console.log(`shards: ${manifest.shards.length} in ${OUT}`);
  const top = [...progress.labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [k, n] of top) console.log(`  ${k.padEnd(20)} ${n.toLocaleString()}`);
  const calls = [...progress.calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('calls:');
  for (const [k, n] of calls) console.log(`  ${k.padEnd(20)} ${n.toLocaleString()}`);
  const remaining = all.length - (seen.size + progress.done);
  if (remaining > 0) {
    console.log(`\n${remaining} demos left, about ${fmtDuration((elapsed / Math.max(1, progress.done)) * remaining)} at this rate. Re-run to continue.`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
