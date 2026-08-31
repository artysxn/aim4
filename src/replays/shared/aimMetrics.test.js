// Aim and utility metrics, on synthetic rounds where the right answer is known.
//
// These exist mostly to pin the unit conversions and the exclusion rules, which
// are where the quiet mistakes live. The flash column shipped reading zero for
// every player because readRecord already converts the stored 20ths-of-a-second
// byte and it was divided by 20 a second time; nothing about that is visible
// without a fixture that knows what the answer should be.

import { writeHeader, writeRecord, HEADER_BYTES, TICK_BYTES, FLAG_ALIVE } from './tickFormat.js';
import { aimFromRound, aimRating, addAim, yawDeltaDeg, signedYawDelta, classifyFlickMiss, FIRST_BULLET_CONE_DEG, AIM_OUTCOME_BENCH } from './aimMetrics.js';
import { utilityFromRound, utilityAverages } from './utilityMetrics.js';
import { segmentCrossesVision } from '../zones/visionLayers.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

const TICK_RATE = 64;

/**
 * Build a stride-1 tick buffer.
 * @param {number} tickCount
 * @param {(tick: number, slot: number) => object} at  state for a player
 */
function buildTicks(tickCount, at) {
  const buffer = new ArrayBuffer(HEADER_BYTES + tickCount * TICK_BYTES);
  const view = new DataView(buffer);
  writeHeader(view, {
    tickCount,
    firstTick: 0,
    stride: 1,
    tickRate: TICK_RATE,
    playerCount: 10
  });
  for (let t = 0; t < tickCount; t++) {
    for (let slot = 0; slot < 10; slot++) writeRecord(view, t, slot, at(t, slot));
  }
  return buffer;
}

const alive = (over = {}) => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  armor: 100,
  weapon: 0,
  flags: FLAG_ALIVE,
  flash: 0,
  side: 2,
  ...over
});

/** Two players: slot 0 on team 1, slot 5 on team 2. */
function twoPlayerMeta(events) {
  return {
    tickRate: TICK_RATE,
    team1Side: 'T',
    team2Side: 'CT',
    players: [
      { id: 'aaa', name: 'A', team: 1, slot: 0 },
      { id: 'bbb', name: 'B', team: 2, slot: 5 }
    ],
    events: { kills: [], shots: [], grenades: [], bomb: [], damage: [], items: [], ...events }
  };
}

// ---------------------------------------------------------------------------
{
  // yaw wrap-around: 350 and 10 are 20 apart, not 340.
  assert(yawDeltaDeg(350, 10) === 20, 'yaw wraps');
  assert(yawDeltaDeg(-170, 170) === 20, 'negative yaw wraps');
  assert(yawDeltaDeg(0, 180) === 180, 'opposite is 180');
  assert(close(signedYawDelta(70, 80), 10), 'signed +10');
  assert(close(signedYawDelta(80, 74), -6), 'signed -6');
}

{
  // Under: start 70, enemy 80, fire at 79.1 — short of the target.
  assert(classifyFlickMiss(70, 79.1, 80) === 'under', 'underflick example');
  // Over: start 80, enemy 74, fire at 71 — past the target.
  assert(classifyFlickMiss(80, 71, 74) === 'over', 'overflick example');
  // Landed on them but still "missed" (spread): neither.
  assert(classifyFlickMiss(70, 80, 80) === null, 'on target is not over/under');
  // Already aimed at lookback: not a flick.
  assert(classifyFlickMiss(80, 79, 80) === null, 'tiny target delta is not a flick');
  // Wrong way: not over/under.
  assert(classifyFlickMiss(70, 60, 80) === null, 'away from enemy is not classified');
}

// ---------------------------------------------------------------------------
{
  // Flash blindness is measured as the RISE across the detonation, in seconds.
  // Player B (enemy) goes from 0 to 2.5 s of blind at tick 100.
  const ticks = buildTicks(200, (t, slot) =>
    alive({
      x: slot === 0 ? 0 : 500,
      flash: slot === 5 && t >= 100 && t < 160 ? 2.5 : 0,
      side: slot < 5 ? 2 : 3
    })
  );
  const meta = twoPlayerMeta({
    grenades: [{ type: 'flashbang', player: 'aaa', throwTick: 80, detonateTick: 100, at: { x: 250, y: 0 } }]
  });

  const { players } = utilityFromRound(meta, ticks);
  assert(players.aaa.flashesThrown === 1, 'one flash thrown');
  assert(
    close(players.aaa.enemyBlindSeconds, 2.5),
    `2.5 s of enemy blind, got ${players.aaa.enemyBlindSeconds}`
  );
  assert(players.aaa.flashesLanded === 1, 'flash counted as landed');

  const avg = utilityAverages({ ...players.aaa, rounds: 1 });
  assert(close(avg.blindPerFlash, 2.5), `blind per flash, got ${avg.blindPerFlash}`);
  assert(close(avg.flashHitRate, 1), 'hit rate 1');
}

{
  // A flash that blinds a TEAMMATE is worth nothing.
  const ticks = buildTicks(200, (t, slot) =>
    alive({ flash: slot === 1 && t >= 100 ? 3 : 0, side: slot < 5 ? 2 : 3 })
  );
  const meta = {
    ...twoPlayerMeta({
      grenades: [{ type: 'flashbang', player: 'aaa', throwTick: 80, detonateTick: 100, at: { x: 0, y: 0 } }]
    })
  };
  meta.players = [
    { id: 'aaa', name: 'A', team: 1, slot: 0 },
    { id: 'mate', name: 'M', team: 1, slot: 1 },
    { id: 'bbb', name: 'B', team: 2, slot: 5 }
  ];
  const { players } = utilityFromRound(meta, ticks);
  assert(players.aaa.enemyBlindSeconds === 0, 'team flash earns nothing');
  assert(players.aaa.flashesLanded === 0, 'team flash is not a landed flash');
}

// ---------------------------------------------------------------------------
{
  // HE damage per nade, and team damage excluded.
  const ticks = buildTicks(50, () => alive());
  const meta = twoPlayerMeta({
    grenades: [
      { type: 'hegrenade', player: 'aaa', throwTick: 5, detonateTick: 10, at: { x: 0, y: 0 } },
      { type: 'hegrenade', player: 'aaa', throwTick: 20, detonateTick: 25, at: { x: 0, y: 0 } }
    ],
    damage: [
      { tick: 10, attacker: 'aaa', victim: 'bbb', hp: 60, weapon: 'hegrenade' },
      { tick: 25, attacker: 'aaa', victim: 'bbb', hp: 20, weapon: 'hegrenade' },
      // Self and team damage must not count.
      { tick: 26, attacker: 'aaa', victim: 'aaa', hp: 30, weapon: 'hegrenade' }
    ]
  });
  const { players, teams } = utilityFromRound(meta, ticks);
  assert(players.aaa.heThrown === 2, 'two HEs thrown');
  assert(players.aaa.heDamage === 80, `80 HE damage, got ${players.aaa.heDamage}`);
  assert(teams[1].utilDamage === 80, 'team util damage excludes self damage');

  const avg = utilityAverages({ ...players.aaa, rounds: 1 });
  assert(close(avg.heDamagePerNade, 40), `40 dmg per HE, got ${avg.heDamagePerNade}`);
}

// ---------------------------------------------------------------------------
{
  // Crosshair placement: B shoots at A from due east while looking at them.
  // A is facing due east too (yaw 0 points +x), so A's error is ~180 because
  // the attacker is at +x and A must turn to face them... place carefully:
  // A at origin, B at (500,0). Direction from A to B is yaw 0. If A looks at
  // yaw 0 the error is 0; if A looks at yaw 180 the error is 180.
  const ticks = buildTicks(120, (t, slot) =>
    alive({
      x: slot === 0 ? 0 : 500,
      y: 0,
      yaw: slot === 0 ? 180 : 180, // A looks away (180); B looks back at A (180)
      side: slot < 5 ? 2 : 3
    })
  );
  const meta = twoPlayerMeta({
    shots: [{ tick: 60, player: 'bbb', weapon: 'ak47', x: 500, y: 0, z: 0, yaw: 180, pitch: 0 }]
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.engagements === 1, `one engagement, got ${out.aaa.engagements}`);
  assert(close(out.aaa.crosshairErrorSum, 180, 1), `error ~180, got ${out.aaa.crosshairErrorSum}`);
  assert(out.aaa.fightsUnaware === 1, 'counted as unaware');
  assert(out.aaa.fightsReady === 0, 'not ready');
}

{
  // Same geometry, but A is looking straight at B: ready, error ~0.
  const ticks = buildTicks(120, (t, slot) =>
    alive({ x: slot === 0 ? 0 : 500, y: 0, yaw: slot === 0 ? 0 : 180, side: slot < 5 ? 2 : 3 })
  );
  const meta = twoPlayerMeta({
    shots: [{ tick: 60, player: 'bbb', weapon: 'ak47', x: 500, y: 0, z: 0, yaw: 180, pitch: 0 }]
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.fightsReady === 1, 'ready when already on the angle');
  assert(close(out.aaa.crosshairErrorSum, 0, 1), `error ~0, got ${out.aaa.crosshairErrorSum}`);
}

// ---------------------------------------------------------------------------
{
  // Accuracy: three shots, one hit. Then the same with a smoke on the line,
  // which must be excluded from the denominator entirely.
  const ticks = buildTicks(300, (t, slot) =>
    alive({ x: slot === 0 ? 0 : 500, y: 0, yaw: 0, side: slot < 5 ? 2 : 3 })
  );
  const shot = (tick) => ({ tick, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  const meta = twoPlayerMeta({
    shots: [shot(50), shot(120), shot(200)],
    damage: [{ tick: 52, attacker: 'aaa', victim: 'bbb', hp: 27, weapon: 'ak47' }]
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.shots === 3, `three shots counted, got ${out.aaa.shots}`);
  assert(out.aaa.hits === 1, `one hit, got ${out.aaa.hits}`);

  // Now put a smoke between A and B. Every shot goes into it, so none count.
  const smoky = twoPlayerMeta({
    shots: [shot(50), shot(120), shot(200)],
    damage: [],
    grenades: [
      { type: 'smokegrenade', player: 'bbb', throwTick: 10, detonateTick: 20, at: { x: 250, y: 0 } }
    ]
  });
  const smokyOut = aimFromRound(smoky, ticks);
  assert(smokyOut.aaa.shots === 0, `smoke shots excluded, got ${smokyOut.aaa.shots}`);
  assert(smokyOut.aaa.shotsInSmoke === 3, `three smoke shots, got ${smokyOut.aaa.shotsInSmoke}`);
}

{
  // A smoke BEHIND the enemy must not exclude the shot: shooting someone
  // standing in front of a smoke is a normal duel.
  const ticks = buildTicks(120, (t, slot) =>
    alive({ x: slot === 0 ? 0 : 500, y: 0, yaw: 0, side: slot < 5 ? 2 : 3 })
  );
  const meta = twoPlayerMeta({
    shots: [{ tick: 60, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }],
    grenades: [
      { type: 'smokegrenade', player: 'bbb', throwTick: 10, detonateTick: 20, at: { x: 900, y: 0 } }
    ]
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.shots === 1, `smoke behind the enemy still counts, got ${out.aaa.shots}`);
}

// ---------------------------------------------------------------------------
{
  // First bullet: only the first shot of a burst, and only with an enemy in
  // the cone. Three shots 2 ticks apart are one burst.
  const ticks = buildTicks(300, (t, slot) =>
    alive({ x: slot === 0 ? 0 : 500, y: 0, yaw: 0, side: slot < 5 ? 2 : 3 })
  );
  const shot = (tick) => ({ tick, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  const meta = twoPlayerMeta({
    shots: [shot(50), shot(52), shot(54), shot(200)],
    damage: [{ tick: 51, attacker: 'aaa', victim: 'bbb', hp: 27, weapon: 'ak47' }]
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.firstBullets === 2, `two bursts, got ${out.aaa.firstBullets}`);
  assert(out.aaa.firstBulletHits === 1, `first bullet of burst 1 hit, got ${out.aaa.firstBulletHits}`);
}

{
  // Overflick / underflick on first-bullet misses.
  // Geometry: A at origin, B at (500, 0) → enemy yaw is 0°.
  // Under: A starts at yaw −10, fires at −1 (short of 0). Miss.
  // Over: later burst, A starts at +10, fires at −3 (past 0). Miss.
  const underTick = 50;
  const overTick = 200;
  const ticks = buildTicks(260, (t, slot) => {
    if (slot === 5) return alive({ x: 500, y: 0, yaw: 180, side: 3 });
    let yaw = 0;
    if (t < underTick - 5) yaw = -10;
    else if (t <= underTick) yaw = -1;
    else if (t < overTick - 5) yaw = 10;
    else yaw = -3;
    return alive({ x: 0, y: 0, yaw, side: 2 });
  });
  const meta = twoPlayerMeta({
    shots: [
      { tick: underTick, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: -1, pitch: 0 },
      { tick: overTick, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: -3, pitch: 0 }
    ],
    damage: []
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.firstBullets === 2, `two first-bullet misses, got ${out.aaa.firstBullets}`);
  assert(out.aaa.firstBulletHits === 0, 'both missed');
  assert(out.aaa.underflicks === 1, `one underflick, got ${out.aaa.underflicks}`);
  assert(out.aaa.overflicks === 1, `one overflick, got ${out.aaa.overflicks}`);

  const rated = aimRating(out.aaa);
  assert(close(rated.raw.underflick, 0.5), `underflick 50% of engagements, got ${rated.raw.underflick}`);
  assert(close(rated.raw.overflick, 0.5), `overflick 50% of engagements, got ${rated.raw.overflick}`);
}

{
  // An enemy outside the cone is not a first-bullet opportunity.
  const ticks = buildTicks(120, (t, slot) =>
    alive({ x: slot === 0 ? 0 : 0, y: slot === 0 ? 0 : 500, yaw: 0, side: slot < 5 ? 2 : 3 })
  );
  // Enemy is due north (yaw 90); shooter faces east (yaw 0): 90 apart.
  assert(yawDeltaDeg(0, 90) > FIRST_BULLET_CONE_DEG, 'fixture is outside the cone');
  const meta = twoPlayerMeta({
    shots: [{ tick: 60, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }]
  });
  const out = aimFromRound(meta, ticks);
  assert(out.aaa.firstBullets === 0, 'no first-bullet chance outside the cone');
}

// ---------------------------------------------------------------------------
{
  // Painted vision blocks are the same category as smoke, on both sides of the
  // measurement. A wall between two players means neither "he missed" nor
  // "she was caught unaware" is a claim we can make.
  const ticks = buildTicks(120, (t, slot) =>
    alive({ x: slot === 0 ? 0 : 500, y: 0, yaw: slot === 0 ? 180 : 180, side: slot < 5 ? 2 : 3 })
  );
  // A block sitting between them, at x = 250.
  const wallAt = (x) => x > 200 && x < 300;

  // 1. Shots at an enemy behind a wall do not count against accuracy.
  const shootMeta = twoPlayerMeta({
    shots: [{ tick: 60, player: 'aaa', weapon: 'ak47', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }]
  });
  const open = aimFromRound(shootMeta, ticks);
  assert(open.aaa.shots === 1, 'baseline: the shot counts with no wall');
  const walled = aimFromRound(shootMeta, ticks, { visionBlockAt: (x) => wallAt(x) });
  assert(walled.aaa.shots === 0, `wall excludes the shot, got ${walled.aaa.shots}`);
  assert(walled.aaa.shotsInSmoke === 1, 'and is counted as a blocked shot');

  // 2. An enemy firing from behind a wall is not an engagement, so the player
  //    on the other side is never scored as unaware.
  const engageMeta = twoPlayerMeta({
    shots: [{ tick: 60, player: 'bbb', weapon: 'ak47', x: 500, y: 0, z: 0, yaw: 180, pitch: 0 }]
  });
  const seen = aimFromRound(engageMeta, ticks);
  assert(seen.aaa.engagements === 1, 'baseline: engagement counts with no wall');
  assert(seen.aaa.fightsUnaware === 1, 'baseline: scored unaware');

  const blocked = aimFromRound(engageMeta, ticks, { visionBlockAt: (x) => wallAt(x) });
  assert(blocked.aaa.engagements === 0, `wall removes the engagement, got ${blocked.aaa.engagements}`);
  assert(blocked.aaa.fightsUnaware === 0, 'and the unaware penalty with it');
  assert(blocked.aaa.crosshairErrorSum === 0, 'no crosshair error recorded');

  // 3. A block that is NOT between them changes nothing.
  const elsewhere = aimFromRound(engageMeta, ticks, { visionBlockAt: (x) => x > 900 });
  assert(elsewhere.aaa.engagements === 1, 'a block off the sight line is ignored');
}

{
  // segmentCrossesVision itself: endpoints are excluded so a player standing in
  // the edge of a painted block is not blind along every line they hold.
  const inBlock = (x, y) => x >= 0 && x <= 10;
  assert(segmentCrossesVision(inBlock, 0, 0, 500, 0) === false, 'own footprint does not block');
  assert(segmentCrossesVision((x) => x > 200 && x < 300, 0, 0, 500, 0), 'a wall in between blocks');
  assert(segmentCrossesVision(null, 0, 0, 500, 0) === false, 'no tester means no blocking');
  assert(segmentCrossesVision((x) => x > 200, 0, 0, 0, 0) === false, 'zero-length line never blocks');
}

// ---------------------------------------------------------------------------
{
  // Rating: components without enough sample are dropped and the remaining
  // weights renormalise, rather than scoring a confident zero.
  const thin = aimRating({ engagements: 2, crosshairErrorSum: 40, shots: 3, hits: 1 });
  assert(thin.components.crosshairError === null, 'thin sample is not scored');
  assert(thin.components.accuracy === null, 'thin accuracy is not scored');

  /**
   * Counters that produce exactly these raw values.
   *
   * Built from the benchmarks rather than from copied numbers: recalibrating
   * against the library is an expected change (see aimCalibration.js), and a
   * test holding the old anchors would fail for the wrong reason every time it
   * happened. What is being pinned is the SHAPE of the scale — the good tail
   * is 100, the bad tail is 0, the average is 50 — which is the part that must
   * not drift.
   */
  const totalsFor = (pick) => {
    const b = AIM_OUTCOME_BENCH;
    const N = 1000;
    const ready = pick(b.readyRate);
    return {
      engagements: 400,
      crosshairErrorSum: 400 * pick(b.crosshairError),
      fightsReady: Math.round(400 * ready),
      fightsUnaware: 400 - Math.round(400 * ready),
      shots: N,
      hits: Math.round(N * pick(b.accuracy)),
      firstBullets: N,
      firstBulletHits: Math.round(N * pick(b.firstBullet)),
      overflicks: Math.round(N * pick(b.overflick)),
      underflicks: Math.round(N * pick(b.underflick))
    };
  };

  const full = aimRating(totalsFor((a) => a.good));
  assert(
    Math.abs(full.rating - 100) < 1,
    `every component at the 97th percentile is 100, got ${full.rating}`
  );

  const worst = aimRating(totalsFor((a) => a.bad));
  assert(
    Math.abs(worst.rating - 0) < 1,
    `every component at the 3rd percentile is 0, got ${worst.rating}`
  );

  const average = aimRating(totalsFor((a) => a.mid));
  assert(
    Math.abs(average.rating - 50) < 1,
    `every component at the average is 50, got ${average.rating}`
  );

  // Values beyond the anchors clamp rather than running off the scale.
  const superhuman = aimRating({
    engagements: 400,
    crosshairErrorSum: 400 * 2,
    fightsReady: 400,
    fightsUnaware: 0,
    shots: 300,
    hits: 300,
    firstBullets: 100,
    firstBulletHits: 100,
    overflicks: 0,
    underflicks: 0
  });
  assert(superhuman.rating === 100, 'clamped at 100');

  // Lower over/underflick rates must score higher than high rates.
  const base = {
    engagements: 400,
    crosshairErrorSum: 400 * 30,
    fightsReady: 260,
    fightsUnaware: 140,
    shots: 300,
    hits: 81,
    firstBullets: 100,
    firstBulletHits: 32
  };
  const tidy = aimRating({ ...base, overflicks: 5, underflicks: 5 });
  const sloppy = aimRating({ ...base, overflicks: 28, underflicks: 28 });
  assert(
    tidy.components.underflick > sloppy.components.underflick,
    `lower underflick rate scores higher (${tidy.components.underflick} vs ${sloppy.components.underflick})`
  );
  assert(
    tidy.components.overflick > sloppy.components.overflick,
    `lower overflick rate scores higher (${tidy.components.overflick} vs ${sloppy.components.overflick})`
  );
  assert(tidy.rating > sloppy.rating, `tidy flick rates raise aim rating (${tidy.rating} vs ${sloppy.rating})`);
}

{
  // addAim is a plain fold, used to roll rounds into a match and matches into
  // a library. Order must not matter.
  const a = { shots: 3, hits: 1 };
  const b = { shots: 5, hits: 2 };
  const sum = addAim(addAim({}, a), b);
  assert(sum.shots === 8 && sum.hits === 3, 'counters add');
}

console.log('aimMetrics + utilityMetrics: all assertions passed');
