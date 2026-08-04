// The rules added for the coach-mistakes taxonomy: utility friendly fire, the
// flash timings, the wasted buy, and the shot-log mechanical notes.
//
// These test the third pass in isolation rather than through analyseRound. The
// pass takes its inputs explicitly precisely so it can be driven without a
// round file, and the interesting behaviour is the thresholds, not the wiring.

import { dropAngleHoldAdvice, isHoldingVsPeekIn } from './angleHold.js';
import { COACH_MESSAGES, coachCategory, coachText } from './coachMessages.js';
import { findDuelFlags } from './duelMistakes.js';
import { findShotFlags } from './shotMistakes.js';
import { findUtilityFlags } from './utilityMistakes.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const TICK = 64;

/** Slots 0-4 are team 1 (T), slots 5-9 are team 2 (CT). */
function roster() {
  const out = [];
  for (let slot = 0; slot < 10; slot++) {
    out.push({
      id: `p${slot}`,
      slot,
      team: slot < 5 ? 1 : 2,
      name: `P${slot}`
    });
  }
  return out;
}

function baseMeta(events = {}, extra = {}) {
  const players = roster();
  return {
    map: 'DD2',
    tickRate: TICK,
    team1Side: 'T',
    team2Side: 'CT',
    freezeEndTick: 0,
    endTick: 10000,
    players,
    stats: {},
    weapons: ['none', 'ak47', 'knife'],
    events: { kills: [], damage: [], shots: [], grenades: [], bomb: [], ...events },
    ...extra
  };
}

function context(meta, { flashAt, stateAt, gate } = {}) {
  const byId = new Map(meta.players.map((p) => [p.id, p]));
  const sides = { 1: meta.team1Side, 2: meta.team2Side };
  return {
    meta,
    tickRate: TICK,
    byId,
    sideOf: (id) => sides[byId.get(id)?.team],
    gate: gate || { CT: true, T: true },
    inCoachWindow: () => true,
    defusedTick: null,
    kills: meta.events.kills,
    flashAt: flashAt || (() => 0),
    stateAt: stateAt || (() => null)
  };
}

const rules = (flags) => flags.map((f) => f.rule);
const one = (flags, rule) => flags.filter((f) => f.rule === rule);

/**
 * Every note is readable copy with nothing left unfilled.
 *
 * Asserting on the wording instead would be asserting on which of the four
 * variants the tick happened to hash to, which is not what any of these rules
 * is about.
 */
function assertFilled(flags) {
  for (const f of flags) {
    assert(f.text && f.text.length > 10, `empty copy for ${f.rule}`);
    assert(!/\{\w+\}/.test(f.text), `unfilled placeholder in ${f.rule}: ${f.text}`);
    assert(!/\byou\b/i.test(f.text), `second-person "you" in ${f.rule}: ${f.text}`);
    assert(!/\byour\b/i.test(f.text), `second-person "your" in ${f.rule}: ${f.text}`);
  }
}

// --- messages ---------------------------------------------------------------

{
  // Same rule and tick always reads the same way, so a round does not rewrite
  // itself every time it is opened.
  const a = coachText('solo-even', 4321, { player: 'Alice', n: 3 });
  const b = coachText('solo-even', 4321, { player: 'Alice', n: 3 });
  assert(a === b, 'variant pick must be deterministic');
  assert(a.includes('Alice'), 'filled copy must name the player');
  assert(!/\byou\b/i.test(a), 'filled copy must not say you');

  // Different ticks should not all land on one variant, and every variant that
  // does use the headcount has it filled in.
  const seen = new Set();
  for (let t = 0; t < 400; t++) {
    const text = coachText('solo-even', t, { player: 'Alice', n: 3 });
    assert(!text.includes('{n}'), `unfilled placeholder: ${text}`);
    assert(text.includes('Alice'), `missing player name: ${text}`);
    seen.add(text);
  }
  assert(seen.size === 4, `expected all four variants over many ticks, got ${seen.size}`);
  assert([...seen].some((t) => t.includes('3v3')), 'at least one variant states the headcount');

  // An unsupplied placeholder stays visible rather than printing "undefined",
  // so a copy bug is obvious in the note instead of quiet.
  const bare = [];
  for (let t = 0; t < 50; t++) bare.push(coachText('late-off-flash', t, { player: 'Alice' }));
  assert(
    bare.some((text) => text.includes('{seconds}')),
    'missing var must stay literal'
  );
  assert(
    !bare.some((text) => text.includes('undefined')),
    'missing var must never print undefined'
  );

  // Every shipped variant names the player; none speak in second person.
  for (const [key, entry] of Object.entries(COACH_MESSAGES)) {
    for (const variant of entry.variants) {
      assert(
        variant.includes('{player}'),
        `${key} variant missing {player}: ${variant}`
      );
      assert(!/\byou\b/i.test(variant), `${key} still says you: ${variant}`);
      assert(!/\byour\b/i.test(variant), `${key} still says your: ${variant}`);
    }
  }

  assert(coachCategory('advantage-lost') === 'carelessness', 'category lookup');
  assert(coachCategory('underdog-won-round') === 'carelessness', 'underdog-won-round category');
  assert(coachCategory('a-understack') === 'synchronization', 'per-site rule category');
  assert(coachCategory('b-overstack') === 'praise', 'praise has its own lane');
  assert(coachCategory('nope') === '', 'unknown rule has no category');

  const underdog = coachText('underdog-won-round', 100, {
    player: 'Alice',
    win: '82%',
    duel: '78%',
    share: '80%'
  });
  assert(underdog.includes('Alice'), 'underdog-won-round names the player');
  assert(underdog.includes('82%') || underdog.includes('78%') || underdog.includes('80%'), 'underdog-won-round fills odds');
  assert(!/\byou\b/i.test(underdog), 'underdog-won-round has no you');
}

// --- flashbangs -------------------------------------------------------------

{
  const det = 500;
  const meta = baseMeta({
    grenades: [{ type: 'flashbang', player: 'p0', throwTick: det - 60, detonateTick: det }],
    kills: []
  });
  // p1 (teammate) eats 2s; p5 (enemy) gets a 0.3s flicker, under the floor.
  const flashAt = (slot, tick) => {
    if (tick < det) return 0;
    if (slot === 1) return 2;
    if (slot === 5) return 0.3;
    return 0;
  };
  const flags = findUtilityFlags(context(meta, { flashAt }));

  assert(one(flags, 'missed-flash').length === 1, `missed-flash: ${rules(flags)}`);
  assert(one(flags, 'missed-flash')[0].playerId === 'p0', 'missed-flash blames the thrower');
  assert(one(flags, 'ate-team-flash').length === 1, `ate-team-flash: ${rules(flags)}`);
  assert(one(flags, 'ate-team-flash')[0].playerId === 'p1', 'ate-team-flash blames the victim');
  assertFilled(flags);
}

{
  // The same flash, but it did more to the enemy than to the teammate.
  const det = 500;
  const meta = baseMeta({
    grenades: [{ type: 'flashbang', player: 'p0', throwTick: det - 60, detonateTick: det }]
  });
  const flashAt = (slot, tick) => {
    if (tick < det) return 0;
    if (slot === 1) return 0.6;
    if (slot === 5) return 3;
    return 0;
  };
  const flags = findUtilityFlags(context(meta, { flashAt }));
  assert(!one(flags, 'missed-flash').length, 'a working flash must not fire missed-flash');
  assert(!one(flags, 'ate-team-flash').length, '0.6s of team flash is under the floor');
}

{
  // Died before your own flash popped.
  const meta = baseMeta({
    grenades: [{ type: 'flashbang', player: 'p0', throwTick: 400, detonateTick: 500 }],
    kills: [{ tick: 450, attacker: 'p5', victim: 'p0' }]
  });
  const flags = findUtilityFlags(context(meta));
  const early = one(flags, 'early-off-flash');
  assert(early.length === 1, `early-off-flash: ${rules(flags)}`);
  assert(early[0].tick === 450, 'note sits on the death');
  assertFilled(flags);
}

{
  // Arrived after the flash we paid for had worn off.
  const death = 1000;
  const meta = baseMeta({
    grenades: [{ type: 'flashbang', player: 'p1', throwTick: 800, detonateTick: 880 }],
    kills: [{ tick: death, attacker: 'p5', victim: 'p0' }]
  });
  // p5 was blind until 60 ticks before the death, and can see by then.
  const flashAt = (slot, tick) => (slot === 5 && tick >= 880 && tick <= death - 60 ? 1 : 0);
  const flags = findUtilityFlags(context(meta, { flashAt }));
  const late = one(flags, 'late-off-flash');
  assert(late.length === 1, `late-off-flash: ${rules(flags)}`);
  assert(late[0].playerId === 'p0', 'blames whoever arrived late');
}

// --- utility damage ---------------------------------------------------------

{
  const meta = baseMeta({
    damage: [
      { tick: 700, attacker: 'p1', victim: 'p0', hp: 25, weapon: 'molotov' },
      { tick: 760, attacker: 'p1', victim: 'p0', hp: 12, weapon: 'molotov' },
      // A teammate under the threshold stays quiet.
      { tick: 800, attacker: 'p1', victim: 'p2', hp: 8, weapon: 'molotov' },
      // Your own fire under your own feet is not the team's fault.
      { tick: 820, attacker: 'p3', victim: 'p3', hp: 40, weapon: 'inferno' }
    ]
  });
  const flags = findUtilityFlags(context(meta));
  const ff = one(flags, 'team-util-damage');
  assert(ff.length === 1, `team-util-damage: ${flags.map((f) => f.playerId + ':' + f.rule)}`);
  assert(ff[0].playerId === 'p0', 'the note goes to whoever lost the health');
  assert(ff[0].tick === 700, 'note sits on the first tick of the burn');
  assertFilled(flags);
}

{
  // One enemy HE across a stack.
  const meta = baseMeta({
    damage: [
      { tick: 900, attacker: 'p5', victim: 'p0', hp: 25, weapon: 'hegrenade' },
      { tick: 902, attacker: 'p5', victim: 'p1', hp: 22, weapon: 'hegrenade' },
      { tick: 904, attacker: 'p5', victim: 'p2', hp: 4, weapon: 'hegrenade' }
    ]
  });
  const flags = findUtilityFlags(context(meta));
  const stack = one(flags, 'nade-stack');
  assert(stack.length === 1, `nade-stack: ${rules(flags)}`);
  assert(stack[0].playerId === 'p0', 'pinned to a victim so the team filter works');
  assertFilled(flags);
}

{
  // The same grenade, but only one player was really in it.
  const meta = baseMeta({
    damage: [
      { tick: 900, attacker: 'p5', victim: 'p0', hp: 60, weapon: 'hegrenade' },
      { tick: 902, attacker: 'p5', victim: 'p1', hp: 5, weapon: 'hegrenade' }
    ]
  });
  assert(!one(findUtilityFlags(context(meta)), 'nade-stack').length, 'one player is not a stack');
}

// --- the buy that never got thrown -----------------------------------------

{
  const meta = baseMeta({
    kills: [{ tick: 1200, attacker: 'p5', victim: 'p0' }],
    grenades: [{ type: 'flashbang', player: 'p0', throwTick: 1100, detonateTick: 1180 }]
  });
  meta.stats.p0 = {
    loadout: ['weapon_ak47', 'knife', 'flashbang', 'flashbang', 'smokegrenade', 'molotov']
  };
  const flags = findUtilityFlags(context(meta));
  const held = one(flags, 'died-holding-util');
  assert(held.length === 1, `died-holding-util: ${rules(flags)}`);
  assertFilled(flags);
}

{
  // Two left is a normal round, not a wasted buy.
  const meta = baseMeta({ kills: [{ tick: 1200, attacker: 'p5', victim: 'p0' }] });
  meta.stats.p0 = { loadout: ['weapon_ak47', 'flashbang', 'smokegrenade'] };
  assert(
    !one(findUtilityFlags(context(meta)), 'died-holding-util').length,
    'two grenades is under the floor'
  );
}

// --- the buy gate still applies --------------------------------------------

{
  const det = 500;
  const meta = baseMeta({
    grenades: [{ type: 'flashbang', player: 'p0', throwTick: det - 60, detonateTick: det }]
  });
  const flashAt = (slot, tick) => (tick >= det && slot === 1 ? 2 : 0);
  const flags = findUtilityFlags(
    context(meta, { flashAt, gate: { CT: true, T: false } })
  );
  assert(!flags.length, `a hopeless buy is not coached: ${rules(flags)}`);
}

// --- the shot log -----------------------------------------------------------

const aliveState = (over = {}) => ({ x: 0, y: 0, yaw: 0, alive: true, flags: 0, weapon: 1, ...over });

{
  // Five shots, nothing landed, died.
  const shots = [];
  for (let i = 0; i < 5; i++) shots.push({ tick: 900 + i * 8, player: 'p0', weapon: 'ak47' });
  const meta = baseMeta({ shots, kills: [{ tick: 1000, attacker: 'p5', victim: 'p0' }] });
  const flags = findShotFlags(context(meta, { stateAt: () => aliveState() }));
  const miss = one(flags, 'missed-everything');
  assert(miss.length === 1, `missed-everything: ${rules(flags)}`);
  assertFilled(flags);
}

{
  // Two shots is not a verdict.
  const shots = [
    { tick: 900, player: 'p0', weapon: 'ak47' },
    { tick: 910, player: 'p0', weapon: 'ak47' }
  ];
  const meta = baseMeta({ shots, kills: [{ tick: 1000, attacker: 'p5', victim: 'p0' }] });
  const flags = findShotFlags(context(meta, { stateAt: () => aliveState() }));
  assert(!one(flags, 'missed-everything').length, 'two shots is under the floor');
}

{
  // Landed most of them: nothing to say about the aim.
  const shots = [];
  const damage = [];
  for (let i = 0; i < 5; i++) {
    shots.push({ tick: 900 + i * 8, player: 'p0', weapon: 'ak47' });
    if (i < 4) {
      damage.push({ tick: 902 + i * 8, attacker: 'p0', victim: 'p5', hp: 20, weapon: 'ak47' });
    }
  }
  const meta = baseMeta({ shots, damage, kills: [{ tick: 1000, attacker: 'p5', victim: 'p0' }] });
  const flags = findShotFlags(context(meta, { stateAt: () => aliveState() }));
  assert(!one(flags, 'missed-everything').length, 'four of five landing is not a whiff');
}

{
  // A burst that kept going long after it stopped landing.
  const shots = [];
  for (let i = 0; i < 12; i++) shots.push({ tick: 600 + i * 7, player: 'p0', weapon: 'ak47' });
  const damage = [
    { tick: 602, attacker: 'p0', victim: 'p5', hp: 27, weapon: 'ak47' },
    { tick: 610, attacker: 'p0', victim: 'p5', hp: 27, weapon: 'ak47' }
  ];
  const meta = baseMeta({ shots, damage });
  const flags = findShotFlags(context(meta, { stateAt: () => aliveState() }));
  const spray = one(flags, 'spray-past-control');
  assert(spray.length === 1, `spray-past-control: ${rules(flags)}`);
  assertFilled(flags);
}

{
  // The same trigger discipline on a pistol is not a spray.
  const shots = [];
  for (let i = 0; i < 12; i++) shots.push({ tick: 600 + i * 12, player: 'p0', weapon: 'deagle' });
  const damage = [{ tick: 602, attacker: 'p0', victim: 'p5', hp: 40, weapon: 'deagle' }];
  const meta = baseMeta({ shots, damage });
  const flags = findShotFlags(context(meta, { stateAt: () => aliveState() }));
  assert(!one(flags, 'spray-past-control').length, 'pistols cannot spray past control');
}

{
  // Caught with the knife out.
  const meta = baseMeta({ kills: [{ tick: 1500, attacker: 'p5', victim: 'p0' }] });
  const stateAt = (slot) => aliveState({ weapon: slot === 0 ? 2 : 1 });
  const flags = findShotFlags(context(meta, { stateAt }));
  const knife = one(flags, 'knife-out');
  assert(knife.length === 1, `knife-out: ${rules(flags)}`);
  assertFilled(flags);
}

{
  // Same weapon, but they were planting. That is the job.
  const meta = baseMeta({ kills: [{ tick: 1500, attacker: 'p5', victim: 'p0' }] });
  const stateAt = (slot) => aliveState({ weapon: slot === 0 ? 2 : 1, flags: 1 << 4 });
  const flags = findShotFlags(context(meta, { stateAt }));
  assert(!one(flags, 'knife-out').length, 'planting is not knife-out');
}

// --- the model notes stay quiet without a map -------------------------------

{
  // A duel model reading through walls is confidently wrong, so no geometry
  // means no notes rather than guessed ones.
  const shots = [];
  for (let i = 0; i < 6; i++) shots.push({ tick: 600 + i * 7, player: 'p0', weapon: 'ak47' });
  const meta = baseMeta({ shots });
  const ctx = context(meta);
  const fakeTrack = { firstTick: 0, sample: () => ({ alive: true, x: 0, y: 0 }) };

  assert(!findDuelFlags({ ...ctx, network: null, track: fakeTrack }).length, 'no network, no notes');
  assert(!findDuelFlags({ ...ctx, network: {}, track: null }).length, 'no ticks, no notes');
  assert(
    !findDuelFlags({ ...ctx, network: {}, track: fakeTrack }).length,
    'an unprepared network has no line of sight to read'
  );
}

// --- angle hold vs peek-in --------------------------------------------------

{
  // Holder stands still at the origin; peeker runs +X toward them.
  const track = {
    firstTick: 0,
    sample(slot, tick, out = {}) {
      if (slot === 0) {
        out.alive = true;
        out.x = 0;
        out.y = 0;
        return out;
      }
      out.alive = true;
      out.x = -800 + tick * 4; // ~256 u/s toward the holder at 64 tick
      out.y = 0;
      return out;
    }
  };
  assert(
    isHoldingVsPeekIn(track, 64, 0, 1, 200),
    'still holder + enemy closing should read as hold vs peek'
  );

  // Both moving: not a hold.
  const bothMoving = {
    firstTick: 0,
    sample(slot, tick, out = {}) {
      out.alive = true;
      out.x = tick * 3;
      out.y = 0;
      return out;
    }
  };
  assert(
    !isHoldingVsPeekIn(bothMoving, 64, 0, 1, 200),
    'a moving "holder" is not holding'
  );

  // Enemy strafing sideways, not into the hold.
  const strafe = {
    firstTick: 0,
    sample(slot, tick, out = {}) {
      if (slot === 0) {
        out.alive = true;
        out.x = 0;
        out.y = 0;
        return out;
      }
      out.alive = true;
      out.x = -500;
      out.y = tick * 4;
      return out;
    }
  };
  assert(
    !isHoldingVsPeekIn(strafe, 64, 0, 1, 200),
    'sideways velocity is not peeking into the angle'
  );

  const byId = new Map([
    ['holder', { id: 'holder', slot: 0 }],
    ['peeker', { id: 'peeker', slot: 1 }]
  ]);
  const kills = [{ tick: 200, victim: 'holder', attacker: 'peeker' }];
  const kept = dropAngleHoldAdvice(
    [
      { rule: 'not-ready', playerId: 'holder', tick: 200, text: 'x' },
      { rule: 'knife-out', playerId: 'holder', tick: 200, text: 'y' }
    ],
    { tickRate: 64, byId, kills, track }
  );
  assert(
    kept.length === 1 && kept[0].rule === 'knife-out',
    'hold advice drops; unrelated death notes stay'
  );
}

console.log('coach mistakes: ok');
