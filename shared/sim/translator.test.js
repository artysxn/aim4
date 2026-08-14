// Run: node shared/sim/translator.test.js
//
// P3's own acceptance criteria, run as a test instead of a demo:
//
//   a recorded round replayed through the follower lands within the plan's
//     numbers: median geodesic error < 60 u, p90 < 150 u over the first 20 s
//     against a frozen world (10.4)
//   a single isolated peek stays LOCAL while four teammates keep the tape
//   the interrupt taxonomy classifies the table in 10.2 the way 10.2 says
//   masks are the contract: an illegal intent is a loud error at the boundary
//
// The tape is a recorded SIM round rather than a demo, deliberately: tracks
// are source-agnostic, so the machinery proves out here and swaps to real
// rounds on the server, where the library lives.

import { DECISION_EVERY_TICKS, FREEZE_SECONDS, TICK_RATE, ticksFor } from './constants.js';
import { PHASE, createEngine } from './engine.js';
import { navGraphFromBake } from './navGraph.js';
import { RoundRecorder } from './encode.js';
import { createTranslator } from './translator.js';
import { tracksFromFrames, followErrorStats } from './trackFollow.js';
import { INTERRUPT, classifyEvent, shouldPromote } from './interrupts.js';
import { idleIntent, legalIntents, validateIntent, validateDirective, INTENTS_VERSION } from './intents.js';
import { skillProfile } from './skill.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const pathDistance = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---- the interrupt table, straight from 10.2 --------------------------------

{
  const ctx = {
    side: 'T',
    sideOf: (slot) => (slot < 5 ? 'T' : 'CT'),
    teamDeaths: 0,
    brokenCount: 0,
    roundSeconds: 20,
    awperSlot: 1,
    plannedSite: 'b'
  };
  const c = (event, over = {}) => classifyEvent(event, { ...ctx, ...over });

  // The tape keeps rolling.
  assert(c({ type: 'freeze_end' }).clazz === INTERRUPT.IGNORE, 'housekeeping is ignored');
  assert(c({ type: 'shot', slot: 7 }).clazz === INTERRUPT.IGNORE, 'distant gunfire is ignored');
  assert(
    c({ type: 'grenade_detonate', slot: 2 }).clazz === INTERRUPT.IGNORE,
    'our own utility is ignored'
  );

  // One bot's problem.
  assert(c({ type: 'damage', slot: 3 }).clazz === INTERRUPT.LOCAL, 'taking damage is local');
  assert(
    c({ type: 'damage', slot: 3 }).slots[0] === 3,
    'and names the bot it happened to'
  );
  assert(c({ type: 'contact', slot: 2 }).clazz === INTERRUPT.LOCAL, 'off-script contact is local');
  assert(
    c({ type: 'contact', slot: 2 }, { contactExpected: true }).clazz === INTERRUPT.IGNORE,
    'expected contact is not an interrupt at all'
  );
  assert(c({ type: 'follow_error', slot: 4 }).clazz === INTERRUPT.LOCAL, 'falling off the tape is local');
  assert(c({ type: 'death', slot: 0 }).clazz === INTERRUPT.LOCAL, 'the first death is local');

  // The whole team's problem.
  assert(
    c({ type: 'death', slot: 0 }, { teamDeaths: 1 }).clazz === INTERRUPT.TEAM,
    'the second death is a team replan'
  );
  assert(
    c({ type: 'death', slot: 1 }, { roundSeconds: 15 }).clazz === INTERRUPT.TEAM,
    'the AWPer dying early is a team replan'
  );
  assert(
    c({ type: 'death', slot: 1 }, { roundSeconds: 80 }).clazz === INTERRUPT.LOCAL,
    'but not late: late he is one body among five'
  );
  assert(c({ type: 'bomb_planted', slot: 0 }).clazz === INTERRUPT.TEAM, 'the afterplant is always a team step');
  assert(
    c({ type: 'defuse_start', slot: 7 }).clazz === INTERRUPT.TEAM,
    'a started defuse is a T-side alarm'
  );
  assert(
    c({ type: 'site_contact', site: 'a' }, { side: 'CT', plannedSite: 'b' }).clazz === INTERRUPT.TEAM,
    'contact at the site we did not stack is a CT replan'
  );
  assert(
    c({ type: 'site_contact', site: 'b' }, { side: 'CT', plannedSite: 'b' }).clazz === INTERRUPT.IGNORE,
    'contact where we stacked is the plan working'
  );

  // Good news has its own class (19.8).
  assert(
    c({ type: 'death', slot: 7 }, { farSide: true }).clazz === INTERRUPT.OPPORTUNITY,
    'a kill on the far side is an opportunity'
  );
  assert(
    c({ type: 'death', slot: 6 }, { awperSlot: 6 }).clazz === INTERRUPT.OPPORTUNITY,
    'their AWP dying is an opportunity'
  );
  assert(
    c({ type: 'death', slot: 7 }).clazz === INTERRUPT.IGNORE,
    'an enemy death inside the plan is just the plan working'
  );
  assert(c({ type: 'zone_empty', zone: 'b' }).clazz === INTERRUPT.OPPORTUNITY, 'an empty zone is an opportunity');

  // The heartbeat promotion.
  assert(!shouldPromote({ brokenCount: 2, teamDeaths: 1 }).promote, 'two broken is not yet dissolved');
  assert(shouldPromote({ brokenCount: 3, teamDeaths: 0 }).promote, 'three broken is');
  assert(shouldPromote({ brokenCount: 0, teamDeaths: 2 }).promote, 'and so is two dead');
}

// ---- masks are the contract -------------------------------------------------

let graph = null;
try {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('../../server/replays/demoStore.js');
  const path = await import('node:path');
  graph = navGraphFromBake(
    JSON.parse(await readFile(path.join(ROOT, 'sim', 'navcache', 'INF.json'), 'utf8'))
  );
} catch {
  graph = null;
}

if (!graph) {
  console.log('translator: interrupt table ok, map half skipped (no bake)');
} else {
  function roster() {
    const t = graph.spawns.filter((s) => s.side === 'T').slice(0, 5);
    const ct = graph.spawns.filter((s) => s.side === 'CT').slice(0, 5);
    return [...t, ...ct].map((s, i) => ({
      id: i < 5 ? `t${i}` : `ct${i - 5}`,
      side: i < 5 ? 'T' : 'CT',
      x: s.x,
      y: s.y,
      z: s.z || 0,
      weapon: 'ak47',
      grenades: i === 0 ? ['smokegrenade'] : []
    }));
  }
  const mk = (seed, over = {}) =>
    createEngine({
      map: 'INF',
      graph,
      seed,
      roster: roster(),
      profiles: [...Array(10)].map(() => skillProfile('average')),
      pathDistance,
      record: 'full',
      ...over
    });

  {
    const e = mk(1);
    const mask = legalIntents(e, 0);
    assert(mask.alive, 'a living bot has a mask');
    assert(mask.targets.includes('banana'), 'anchors are the movement vocabulary');
    assert(!mask.objectives.includes('plant'), 'no planting during freeze');
    assert(mask.utility.length === 0, 'and no throwing during freeze either');

    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
    const live = legalIntents(e, 0);
    assert(live.utility.includes('smokegrenade'), 'the pocket enters the mask when live');
    assert(live.objectives.includes('plant'), 'the carrier may pursue a plant when live');
    assert(!legalIntents(e, 1).objectives.includes('plant'), 'a T without the bomb may not');
    assert(!legalIntents(e, 5).objectives.includes('plant'), 'and a CT never');

    const bad = { ...idleIntent(), move: { mode: 'advance', target: 'no_such_place' } };
    assert(validateIntent(bad, live).length > 0, 'an unknown anchor fails validation');
    const worse = { ...idleIntent(), objective: 'defuse' };
    assert(validateIntent(worse, live).length > 0, 'an unavailable objective fails validation');
    assert(validateIntent(idleIntent(), live).length === 0, 'the idle intent is always legal');

    const t = createTranslator(e, { assertLegal: true });
    let threw = false;
    try {
      t.setIntent(0, bad);
    } catch {
      threw = true;
    }
    assert(threw, 'the translator refuses an illegal intent loudly');
  }

  {
    const d = {
      v: INTENTS_VERSION,
      call: 'b-execute',
      orders: [
        { to: [0, 1, 2], task: 'execute', anchor: 'b_site' },
        { to: [3], task: 'lurk', anchor: 'mid' },
        { to: [4], task: 'hold', anchor: 'banana' }
      ]
    };
    assert(validateDirective(d).length === 0, 'a sane directive validates');
    assert(
      validateDirective({ ...d, orders: [{ to: [0], task: 'execute' }, { to: [0], task: 'hold' }] }).length > 0,
      'one body, two orders is refused'
    );
  }

  // ---- translated movement: hold closes in, advance arrives, avoid holds fire

  {
    const e = mk(2);
    const t = createTranslator(e);
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();

    const banana = graph.anchor('banana');
    t.setIntent(0, { ...idleIntent(), move: { mode: 'advance', target: 'banana', gait: 'run' } });
    t.setIntent(1, { ...idleIntent(), move: { mode: 'hold', target: 'banana', gait: 'run' } });
    t.setIntent(2, { ...idleIntent(), combat: { posture: 'avoid' } });

    for (let i = 0; i < ticksFor(30); i += 1) {
      if (i % DECISION_EVERY_TICKS === 0) t.step();
      e.step();
    }
    const d0 = Math.hypot(e.state.bodies[0].pos.x - banana.world.x, e.state.bodies[0].pos.y - banana.world.y);
    const d1 = Math.hypot(e.state.bodies[1].pos.x - banana.world.x, e.state.bodies[1].pos.y - banana.world.y);
    assert(d0 < 60, `advance arrives (${Math.round(d0)}u)`);
    assert(d1 < 60, `hold closes to its anchor (${Math.round(d1)}u)`);
    assert(e.state.bodies[2].intent.holdFire === true, 'avoid reaches the trigger');
    assert(
      e.state.events.filter((x) => x.type === 'shot' && x.slot === 2).length === 0,
      'and an avoiding bot fired nothing'
    );
  }

  // ---- the P3 follow acceptance -----------------------------------------------

  {
    // Record a tape: five Ts walk their opening, everything else frozen.
    const src = mk(3, { canSee: () => false });
    const rec = new RoundRecorder(src);
    const dests = ['banana', 'car', 'mid', '2nd_mid', 'b'].map((id) => graph.anchor(id));
    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 20); i += 1) {
      if (i === ticksFor(FREEZE_SECONDS) + 1) {
        dests.forEach((a, s) => src.setIntent(s, { moveTo: { cx: a.cx, cy: a.cy, level: a.level } }));
      }
      src.step();
      rec.sample();
    }
    const tracks = tracksFromFrames(rec.frames);
    assert(tracks.length === 10 && tracks[0].samples.length === rec.frames.length, 'the tape exists');

    // Replay it: a fresh engine, followers on the five tracks, frozen world.
    const e = mk(3, { canSee: () => false });
    const t = createTranslator(e);
    for (let i = 0; i < ticksFor(FREEZE_SECONDS); i += 1) e.step();
    for (let s = 0; s < 5; s += 1) t.startFollow(s, tracks[s]);

    // The follower's clock starts now; the tape's own first 15 s are freeze,
    // which the follower spends standing exactly where the tape stands.
    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 20); i += 1) {
      if (i % DECISION_EVERY_TICKS === 0) t.step();
      e.step();
    }

    const all = [];
    for (let s = 0; s < 5; s += 1) {
      const st = t.followStats(s);
      assert(st.n > 100, `slot ${s} measured its error (${st.n} samples)`);
      all.push(st);
      assert(!t.isBroken(s), `slot ${s} never fell off a tape of its own round`);
    }
    const worstMedian = Math.max(...all.map((x) => x.median));
    const worstP90 = Math.max(...all.map((x) => x.p90));
    assert(worstMedian < 60, `median follow error under 60u (worst ${worstMedian.toFixed(1)}u)`);
    assert(worstP90 < 150, `p90 follow error under 150u (worst ${worstP90.toFixed(1)}u)`);
    assert(t.events.filter((x) => x.type === 'follow_error').length === 0, 'no false breaks');
  }

  // ---- an isolated peek stays local while four keep the tape ------------------

  {
    // Same tape, but the world is not frozen: one CT stands on the walk of
    // exactly one T. That bot fights and falls behind; the other four must
    // keep following, which is the acceptance sentence in the plan verbatim.
    const src = mk(4, { canSee: () => false });
    const rec = new RoundRecorder(src);
    const dests = ['banana', 'car', 'b', '2nd_mid', 'mid'].map((id) => graph.anchor(id));
    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 25); i += 1) {
      if (i === ticksFor(FREEZE_SECONDS) + 1) {
        dests.forEach((a, s) => src.setIntent(s, { moveTo: { cx: a.cx, cy: a.cy, level: a.level } }));
      }
      src.step();
      rec.sample();
    }
    const tracks = tracksFromFrames(rec.frames);

    // The ambush: a CT placed on banana, and vision that only exists between
    // him and whoever walks banana (slot 0). Nobody else can see anything, so
    // any break that happens is the peek and only the peek.
    const banana = graph.anchor('banana');
    const specs = roster();
    specs[5] = { ...specs[5], x: banana.world.x, y: banana.world.y };
    const e = createEngine({
      map: 'INF',
      graph,
      seed: 4,
      roster: specs,
      profiles: [...Array(10)].map(() => skillProfile('average')),
      pathDistance,
      record: 'full',
      // The ambushed bot must NOT be the carrier: a dead carrier drops the
      // bomb, and a loose bomb is a TEAM event by the taxonomy's own table
      // (10.2, "bomb events the plan did not own"). The first version of this
      // test ambushed slot 0, got a team replan, and the classifier was right.
      bombCarrier: 1,
      canSee: (w, tg) =>
        (w.slot === 0 && tg.slot === 5) || (w.slot === 5 && tg.slot === 0)
    });
    const t = createTranslator(e);
    for (let i = 0; i < ticksFor(FREEZE_SECONDS); i += 1) e.step();
    for (let s = 0; s < 5; s += 1) t.startFollow(s, tracks[s]);

    let deaths = 0;
    const classifications = [];
    for (let i = 0; i < ticksFor(FREEZE_SECONDS + 25); i += 1) {
      if (i % DECISION_EVERY_TICKS === 0) t.step();
      const before = e.state.events.length;
      e.step();
      for (const ev of e.state.events.slice(before)) {
        const cls = classifyEvent(ev, {
          side: 'T',
          sideOf: (slot) => (slot < 5 ? 'T' : 'CT'),
          teamDeaths: deaths,
          brokenCount: [0, 1, 2, 3, 4].filter((s) => t.isBroken(s)).length,
          roundSeconds: (e.state.tick - e.state.liveTick) / TICK_RATE,
          awperSlot: null
        });
        classifications.push({ ev: ev.type, cls: cls.clazz });
        if (ev.type === 'death' && ev.slot < 5) deaths += 1;
      }
      if (e.state.phase === PHASE.OVER) break;
    }
    for (const ev of t.events) {
      classifications.push({
        ev: ev.type,
        cls: classifyEvent(ev, {
          side: 'T',
          sideOf: (slot) => (slot < 5 ? 'T' : 'CT'),
          teamDeaths: deaths,
          brokenCount: 0,
          roundSeconds: 25
        }).clazz
      });
    }

    const fought = e.state.events.some(
      (x) => (x.type === 'damage' || x.type === 'death') && [0, 5].includes(x.slot)
    );
    assert(fought, 'the ambush actually produced a fight');

    const team = classifications.filter((c) => c.cls === INTERRUPT.TEAM);
    assert(team.length === 0, `one isolated peek never fires a team replan (${JSON.stringify(team)})`);
    const local = classifications.filter((c) => c.cls === INTERRUPT.LOCAL);
    assert(local.length > 0, 'and it does fire local ones');

    // The other four either finished their tape or are still on it: nobody
    // else broke. Slot 0 may have (he was dragged into a fight).
    for (let s = 1; s < 5; s += 1) {
      assert(!t.isBroken(s), `slot ${s} kept the tape through slot 0's fight`);
    }
    const st = followErrorStats([1, 2, 3, 4].flatMap((s) => t.followStats(s).n ? [t.followStats(s).median] : []));
    assert(st.n === 4, 'all four measured');
  }

  {
    const e = mk(7);
    for (let i = 0; i < ticksFor(FREEZE_SECONDS) + 1; i += 1) e.step();
    const t = createTranslator(e, { slots: [0, 1, 2, 3, 4] });
    const body = e.state.bodies[0];
    const at = { x: body.pos.x + 200, y: body.pos.y };
    t.setIntent(0, {
      ...idleIntent(),
      utility: {
        type: 'smokegrenade',
        atX: at.x,
        atY: at.y,
        flight: 1,
        tapeIndex: 2
      }
    });
    t.step();
    assert(t.tapeIndex(0) === 2, 'tapeIndex reports the copied throw');
    assert(
      e.state.events.some((x) => x.type === 'grenade_throw' && x.lineup),
      'and the translator took the throwLineup path'
    );
  }

  console.log('translator: ok (interrupts, masks, follow acceptance, isolated peek)');
}
