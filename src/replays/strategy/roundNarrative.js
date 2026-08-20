// ---------------------------------------------------------------------------
// replays/strategy/roundNarrative.js
// What each body actually did, as the one line that goes in its stratbook
// column.
//
// A strategy note is a sequence, not a description: the reader is a player who
// wants to know what he does next, so the output is the round's events for one
// person in the order they happened, comma separated.
//
// Movement is read at two different layers on purpose, because the two
// questions a strat asks about ground are not the same question:
//
//   Go Mid on flash from ropz        arriving is a ZONE. "Go A Site" is a call;
//                                    "Go Catwalk then Top Mid then Catwalk" is
//                                    a GPS log of one man crossing mid.
//   Stay Chair until 1:21            holding is a POSITION. The whole value of
//                                    the line is which exact spot he is on.
//
// What counts as an event, and nothing else does:
//
//   throws            every grenade, named and timed, wrapped in the link tags
//                     that make it clickable
//   go                arriving in a new zone while a teammate's grenade is in
//                     the air. Walking somewhere on your own is movement;
//                     walking in behind a flash is a call
//   stay              five seconds or more on one position with a GUN in hand.
//                     Five seconds holding a smoke is not holding an angle, it
//                     is lining up a throw, which is the next line instead
//   line up           standing somewhere with utility out and throwing it
//                     later: where he sets up, and when it leaves his hand
//   drops / pickups   utility handed between players
//   smoke             standing inside one
//
// Times are the clock, never a duration. A player reads "until 1:21" against
// the clock on his own screen; "for 14s" he would have to do arithmetic during
// a round to use.
//
// Where four or more grenades land from two or more players inside five
// seconds after the 1:35 mark, that is an execute, and the actions inside it
// are gathered under one "On exec, do ..." clause rather than listed loose.
//
// The FIRST zone a body stands in never produces any movement event. That is
// where the round spawns, and "Stay T Spawn until 1:40" is not a strategy, it
// is the buy. Grenades thrown from spawn still count: what a player throws is
// always worth writing, where he starts never is.
//
// Utility that changes hands is written once per hand it passes through, and
// round trips are not written at all. A smoke going 1 → 2 → 1 is a player
// picking up his own smoke again; writing "drop smoke" under one column and
// "pick up smoke, drop smoke" under another describes a shuffle nobody
// performed on purpose. A smoke going 1 → 2 → 3 is a real relay and every leg
// of it is written.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { createNamer } from './regionNames.js';
import { normalizeNadeType, TYPE_WORDS } from './utilityImport.js';
import { isGun, normalizeLoadout } from '../viewer/equipmentIcons.js';
import { SMOKE_RADIUS_UNITS } from '../viewer/utilityMarkers.js';

/** Position samples per second. Five seconds is the shortest thing measured. */
const SAMPLE_HZ = 2;
/** Ground occupied for less than this is transit, not a position. */
const MIN_RUN_SECONDS = 1.5;
/** How far a receiver may stand from the teammate who dropped him utility. */
const HANDOVER_UNITS = 260;
/** "Remains in the same position for 5+ seconds". */
const HOLD_SECONDS = 5;
/** …and it only counts as holding if the gun was out for that whole time. */
const GUN_HOLD_SECONDS = 5;
/** A grenade thrown this soon after leaving a spot was lined up on it. */
const LINEUP_TAIL_SECONDS = 2.5;

/**
 * An execute: this many grenades, from this many players, inside this window,
 * and not before the clock reads 1:35.
 */
const EXEC_NADES = 4;
const EXEC_PLAYERS = 2;
const EXEC_WINDOW_SECONDS = 5;
const EXEC_AFTER_CLOCK = '1:35';
/** How long after the last grenade of an execute an action still belongs to it. */
const EXEC_TAIL_SECONDS = 6;
/** A smoke is up this long after it pops. */
const SMOKE_SECONDS = 18;
/** Shortest time inside a smoke worth writing. */
const MIN_SMOKE_SECONDS = 1.5;
/** A throw and its item_remove land on the same moment, give or take. */
const THROW_MATCH_SECONDS = 0.75;
/** How long a dropped grenade may lie on the floor and still count as handed over. */
const HANDOVER_SECONDS = 15;
/** Everything a dying player was carrying hits the floor; that is not a drop. */
const DEATH_DROP_SECONDS = 1;
/** Grace either side of a grenade's flight, for "entered while it was in the air". */
const FLIGHT_LEAD_SECONDS = 0.5;
const FLIGHT_TAIL_SECONDS = 1.5;

/** Stratbook roleNotes are capped by the server; leave the trim to us. */
const NOTE_MAX = 800;

/** Buy letters, in the order they are written. `K` first, then gun, then util. */
const BUY_LETTERS = [
  ['kevlar', 'K'],
  ['p250', 'P'],
  ['elite', 'D'],
  ['tec9', 'T'],
  ['smokegrenade', 'S'],
  ['flashbang', 'F'],
  ['molotov', 'M'],
  ['incgrenade', 'M'],
  ['hegrenade', 'N']
];

/** Economies whose notes open with what the player bought. */
const BUY_ECONOMIES = new Set(['Pistol', 'Force']);

/** "1:49" for a second offset into the live round. */
export function clockAt(seconds) {
  const left = Math.max(0, Math.min(ROUND_SECONDS, Math.round(ROUND_SECONDS - seconds)));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** "1:35" back to the 20 seconds into the round that it means. */
export function secondsAtClock(clock) {
  const m = /^(\d+):(\d{1,2})$/.exec(String(clock || '').trim());
  if (!m) return 0;
  return ROUND_SECONDS - (Number(m[1]) * 60 + Number(m[2]));
}

/**
 * The window an execute happened in, or null.
 *
 * Four grenades from two players inside five seconds is a co-ordinated hit
 * rather than one man using utility; before the 1:35 mark the same burst is
 * the opening default every team throws, which is not an execute either.
 *
 * @param {Array<{ player: string, sec: number }>} throws  our side's, in order
 */
export function execWindow(throws) {
  const after = secondsAtClock(EXEC_AFTER_CLOCK);
  const live = throws.filter((t) => t.sec >= after);
  for (let i = 0; i < live.length; i++) {
    const burst = live.filter(
      (t) => t.sec >= live[i].sec && t.sec <= live[i].sec + EXEC_WINDOW_SECONDS
    );
    if (burst.length < EXEC_NADES) continue;
    if (new Set(burst.map((t) => t.player)).size < EXEC_PLAYERS) continue;
    return { from: burst[0].sec, to: burst[burst.length - 1].sec + EXEC_TAIL_SECONDS };
  }
  return null;
}

const lower = (word) => String(word || '').toLowerCase();

/**
 * The moment a line reads as. Lines that print a clock are placed by THAT
 * clock, so a note counts down without ever stepping backwards; lines that
 * print no clock fall where they happened.
 */
const eventClock = (e) => (Number.isFinite(e.at) ? e.at : e.sec);

/**
 * One note out of one player's events, with the execute gathered up.
 *
 * Everything inside the execute window becomes a single "On exec, do ..."
 * clause in place of the loose list, because that is how the call is made: the
 * four things a player does during a hit are one instruction, not four.
 *
 * @param {Array<{ sec: number, text: string }>} events  already in time order
 * @param {{ from: number, to: number }|null} exec
 */
function joinEvents(events, exec) {
  if (!exec) return events.map((e) => e.text).join(', ');
  const before = [];
  const during = [];
  const after = [];
  for (const e of events) {
    const at = eventClock(e);
    if (at < exec.from) before.push(e.text);
    else if (at <= exec.to) during.push(e.text);
    else after.push(e.text);
  }
  if (!during.length) return events.map((e) => e.text).join(', ');
  // The clause closes with a full stop. Without it "On exec, do A, B, C, D"
  // gives the reader no way to see where the execute stopped and the rest of
  // the round started again.
  const head = before.length ? `${before.join(', ')}, ` : '';
  const tail = after.length ? ` ${after.join(', ')}` : '';
  return `${head}On exec, do ${during.join(', ')}.${tail}`;
}

/**
 * Collapse a per-sample name series into runs, dropping transit.
 *
 * `pick` selects which layer of the sample to run on: the same sample list
 * produces the zone runs that answer "where did he go" and the position runs
 * that answer "what was he sitting on".
 *
 * @param {Array<object>} samples
 * @param {number} step  seconds between samples
 * @param {(s: object) => string} pick
 */
function runsFrom(samples, step, pick) {
  const raw = [];
  for (const s of samples) {
    const name = pick(s);
    const last = raw[raw.length - 1];
    if (last && last.name === name) {
      last.to = s.sec + step;
      last.samples.push(s);
    } else raw.push({ name, from: s.sec, to: s.sec + step, samples: [s] });
  }
  // Drop flickers, then re-collapse so ground re-entered around one is one run.
  const kept = raw.filter((r) => r.name && r.to - r.from >= MIN_RUN_SECONDS);
  const runs = [];
  for (const r of kept) {
    const last = runs[runs.length - 1];
    if (last && last.name === r.name) {
      last.to = r.to;
      last.samples.push(...r.samples);
    } else runs.push({ ...r, samples: [...r.samples] });
  }
  return runs;
}

/**
 * Grenades that changed hands, with the round trips already removed.
 *
 * A CS2 demo does not say who dropped anything. `item_remove` is not emitted at
 * all in practice, and even where it is it fires for a throw as much as for a
 * drop — so the drop has to be inferred from the pickup at the other end.
 *
 * The inference is an inventory model: everyone starts with the freezetime
 * loadout, throwing spends one, and a pickup is credited to the teammate who
 * (a) still held one of that type, (b) was alive, and (c) was standing closest
 * to the pickup. Utility taken off a corpse or off the floor from nobody finds
 * no donor and is not written — a player who picks up a dead enemy's molotov
 * did not receive it from anyone.
 *
 * `item_remove` is still honoured when a parse does produce it, because a real
 * drop event beats an inferred one.
 *
 * @returns {Array<{ item: string, from: string, to: string, sec: number }>}
 */
export function utilityHandovers({
  items,
  grenades,
  loadouts,
  deadAt,
  positionAt,
  secOf,
  tickRate,
  sideIds,
  fromTick,
  toTick
}) {
  const throws = (grenades || [])
    .map((g) => ({ player: g.player, type: normalizeNadeType(g.type), tick: Number(g.throwTick) }))
    .filter((g) => g.type && Number.isFinite(g.tick));
  const slack = THROW_MATCH_SECONDS * tickRate;
  const wasThrow = (player, type, tick) =>
    throws.some((g) => g.player === player && g.type === type && Math.abs(g.tick - tick) <= slack);

  /** playerId → type → how many he is holding right now. */
  const held = new Map();
  for (const id of sideIds) {
    const bag = new Map();
    for (const item of normalizeLoadout(loadouts?.get?.(id) || [])) {
      const type = normalizeNadeType(item);
      if (TYPE_WORDS[type]) bag.set(type, (bag.get(type) || 0) + 1);
    }
    held.set(id, bag);
  }
  const take = (id, type) => {
    const bag = held.get(id);
    if (!bag) return;
    bag.set(type, Math.max(0, (bag.get(type) || 0) - 1));
  };
  const give = (id, type) => {
    const bag = held.get(id);
    if (!bag) return;
    bag.set(type, (bag.get(type) || 0) + 1);
  };
  const has = (id, type) => (held.get(id)?.get(type) || 0) > 0;
  const alive = (id, tick) => !(Number.isFinite(deadAt.get(id)) && deadAt.get(id) <= tick);

  // Everything that touches the model, in the order it happened. Only the live
  // round counts: the pickups every player logs as the next freezetime opens
  // are the game handing out knives, not a teammate dropping one.
  const steps = [];
  for (const g of throws) {
    if (!sideIds.has(g.player) || g.tick < fromTick || g.tick > toTick) continue;
    steps.push({ kind: 'throw', tick: g.tick, player: g.player, type: g.type });
  }
  /** @type {Array<{ tick: number, player: string, type: string }>} */
  const explicitDrops = [];
  for (const e of items || []) {
    const type = normalizeNadeType(e.item);
    if (!TYPE_WORDS[type] || !sideIds.has(e.player)) continue;
    if (e.tick < fromTick || e.tick > toTick) continue;
    if (e.op === 'pickup') steps.push({ kind: 'pickup', tick: e.tick, player: e.player, type });
    else if (e.op === 'remove' && !wasThrow(e.player, type, e.tick)) {
      const died = deadAt.get(e.player);
      if (Number.isFinite(died) && died - e.tick <= DEATH_DROP_SECONDS * tickRate) continue;
      explicitDrops.push({ tick: e.tick, player: e.player, type });
      steps.push({ kind: 'drop', tick: e.tick, player: e.player, type });
    }
  }
  steps.sort((a, b) => a.tick - b.tick);

  const chain = [];
  const usedDrop = new Set();
  for (const step of steps) {
    if (step.kind === 'throw' || step.kind === 'drop') {
      take(step.player, step.type);
      continue;
    }
    // A pickup. Prefer a drop this parse actually reported.
    const window = HANDOVER_SECONDS * tickRate;
    let donor = '';
    const reported = explicitDrops.find(
      (d) =>
        !usedDrop.has(d) &&
        d.type === step.type &&
        d.player !== step.player &&
        d.tick <= step.tick &&
        step.tick - d.tick <= window
    );
    if (reported) {
      usedDrop.add(reported);
      donor = reported.player;
    } else {
      const me = positionAt(step.player, step.tick);
      let bestD = Infinity;
      for (const id of sideIds) {
        if (id === step.player || !has(id, step.type) || !alive(id, step.tick)) continue;
        const them = positionAt(id, step.tick);
        const d = me && them ? (me.x - them.x) ** 2 + (me.y - them.y) ** 2 : Infinity;
        if (d < bestD) {
          bestD = d;
          donor = id;
        }
      }
      if (bestD > HANDOVER_UNITS * HANDOVER_UNITS) donor = '';
    }
    give(step.player, step.type);
    if (!donor) continue;
    take(donor, step.type);
    chain.push({ item: step.type, from: donor, to: step.player, sec: secOf(step.tick) });
  }

  chain.sort((a, b) => a.sec - b.sec);

  // A → B followed by B → A on the same item is a round trip, not a relay.
  // Removing a pair can expose another, so the sweep repeats until it is quiet.
  let dirty = true;
  let live = chain;
  while (dirty) {
    dirty = false;
    const next = [];
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      const b = live[i + 1];
      if (b && a.item === b.item && a.from === b.to && a.to === b.from) {
        i += 1;
        dirty = true;
        continue;
      }
      next.push(a);
    }
    live = next;
  }
  return live;
}

/**
 * The buy line for a pistol or force round: what the player owned when
 * freezetime ended.
 */
export function buyString(loadout, state) {
  const items = new Set(normalizeLoadout(loadout));
  if ((state?.armor ?? 0) > 0) items.add('kevlar');
  const seen = new Set();
  let out = '';
  for (const [item, letter] of BUY_LETTERS) {
    if (!items.has(item) || seen.has(letter)) continue;
    seen.add(letter);
    out += letter;
  }
  return out;
}

/**
 * One note per player on the side.
 *
 * @param {object} args
 * @param {object} args.meta       round meta (players, events, timing, stats)
 * @param {object} args.track      tick track for the round
 * @param {object|null} args.network
 * @param {string} args.mapCode
 * @param {'T'|'CT'} args.side
 * @param {string[]} args.playerIds  the five on that side
 * @param {Array} args.links       from foldRoundUtility — throw ids to link
 * @param {string} args.economy    the economy chosen in the Add strategy form
 * @returns {Map<string, string>} playerId → note
 */
export function buildRoundNotes({
  meta,
  track,
  network,
  mapCode,
  side,
  playerIds,
  links = [],
  economy = ''
}) {
  const notes = new Map();
  const ids = (playerIds || []).filter(Boolean);
  if (!meta || !track || !ids.length) return notes;

  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const t0 = timing.freezeEndTick;
  const endTick = Math.min(timing.endTick, t0 + ROUND_SECONDS * rate);
  const secOf = (tick) => (tick - t0) / rate;
  const namer = createNamer(network, mapCode);
  const slotOf = new Map((meta.players || []).map((p) => [p.id, p.slot]));

  // Two different questions, and they are not the same set. `ids` is who gets a
  // note; `sideIds` is whose grenades and whose dropped utility count as ours.
  // A column left empty (four bodies on the side, or a seat nobody filled) must
  // not stop a teammate's flash from being the cover an entry happened behind.
  const side1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  const side2 = meta.team2Side === 'CT' || meta.team2Side === 'T' ? meta.team2Side : side1 === 'CT' ? 'T' : 'CT';
  const sideIds = new Set(ids);
  for (const p of meta.players || []) {
    const theirs = p.team === 1 ? side1 : p.team === 2 ? side2 : '';
    if (theirs === side) sideIds.add(p.id);
  }

  const deadAt = new Map();
  for (const k of meta.events?.kills || []) {
    if (k.victim && !deadAt.has(k.victim)) deadAt.set(k.victim, k.tick || 0);
  }

  const allGrenades = meta.events?.grenades || [];
  const ourGrenades = allGrenades.filter((g) => sideIds.has(g.player));
  const linkOf = new Map(links.map((l) => [l.grenade, l]));
  const weaponNames = (meta.weapons || []).map((w) => String(w || ''));
  const nameOf = new Map((meta.players || []).map((p) => [p.id, p.name || '']));

  // One execute for the whole side: it is the same hit under every column, so
  // every player's note breaks at the same moment.
  const exec = execWindow(
    ourGrenades
      .filter((g) => TYPE_WORDS[normalizeNadeType(g.type)])
      .map((g) => ({ player: g.player, sec: secOf(Number(g.throwTick)) }))
      .filter((t) => Number.isFinite(t.sec))
      .sort((a, b) => a.sec - b.sec)
  );

  /** Smokes that were up, for "standing in one". */
  const smokes = allGrenades
    .filter((g) => normalizeNadeType(g.type) === 'smokegrenade')
    .map((g) => ({
      x: Number(g.at?.x),
      y: Number(g.at?.y),
      from: Number(g.detonateTick ?? g.throwTick),
      to: Number(g.detonateTick ?? g.throwTick) + SMOKE_SECONDS * rate
    }))
    .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.from));

  /** Our own utility in the air, for "entered while it was flying". */
  const flights = ourGrenades
    .map((g) => {
      const from = Number(g.throwTick);
      const to = Number(g.detonateTick ?? g.throwTick + 2 * rate);
      if (!Number.isFinite(from)) return null;
      return {
        player: g.player,
        word: TYPE_WORDS[normalizeNadeType(g.type)] || '',
        from: from - FLIGHT_LEAD_SECONDS * rate,
        to: (Number.isFinite(to) ? to : from) + FLIGHT_TAIL_SECONDS * rate
      };
    })
    .filter((f) => f && f.word);

  const handoverScratch = {};
  const positionAt = (id, tick) => {
    const slot = slotOf.get(id);
    if (slot == null || slot < 0) return null;
    const s = track.sample(slot, tick, handoverScratch);
    return s && Number.isFinite(s.x) ? { x: s.x, y: s.y } : null;
  };
  const handovers = utilityHandovers({
    items: meta.events?.items || [],
    grenades: allGrenades,
    loadouts: new Map([...sideIds].map((id) => [id, meta.stats?.[id]?.loadout || []])),
    deadAt,
    positionAt,
    secOf,
    tickRate: rate,
    sideIds,
    fromTick: t0,
    toTick: endTick
  });

  const step = 1 / SAMPLE_HZ;
  const stepTicks = Math.max(1, Math.round(rate * step));
  const scratch = {};
  const showBuy = BUY_ECONOMIES.has(String(economy || ''));

  for (const id of ids) {
    const slot = slotOf.get(id);
    if (slot == null || slot < 0) {
      notes.set(id, '');
      continue;
    }
    const died = deadAt.has(id) ? deadAt.get(id) : Infinity;
    const lastTick = Math.min(endTick, died);

    // ---- where he was, second by second ---------------------------------
    //
    // One walk, both layers, plus what was in his hands: whether five seconds
    // on a spot is a hold or a line-up is a question about the weapon, not the
    // ground.
    const samples = [];
    for (let tick = t0; tick <= lastTick; tick += stepTicks) {
      const s = track.sample(slot, tick, scratch);
      if (!s.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const where = namer.namesAt(s.x, s.y, s.z);
      const inHand = weaponNames[s.weapon] || '';
      samples.push({
        sec: secOf(tick),
        tick,
        zone: where.zone,
        position: where.position,
        gun: isGun(inHand),
        nade: normalizeNadeType(inHand),
        x: s.x,
        y: s.y
      });
    }
    const zoneRuns = runsFrom(samples, step, (s) => s.zone);
    // The first zone is the spawn. It never produces a movement event.
    const spawnEndsAt = zoneRuns.length ? zoneRuns[0].to : 0;

    /** @type {Array<{ sec: number, text: string, exec?: boolean }>} */
    const events = [];
    /** Grenades already spoken for by a "Line up" line, so they are not repeated. */
    const linedUp = new Set();
    /** `stay|type` pairs already looked at, so the search below terminates. */
    const linedUpTypes = new Set();

    // ---- staying somewhere, and lining up from it ------------------------
    //
    // Positions, not zones: the value of this line is the exact spot. A repeat
    // of the last spot written extends that stay rather than adding another,
    // so a body peeking in and out of one does not read as two holds.
    const stays = [];
    let lastStay = null;
    for (const run of runsFrom(samples, step, (s) => s.position)) {
      if (run.from < spawnEndsAt) continue;
      if (run.to - run.from < HOLD_SECONDS) continue;
      if (lastStay && lastStay.name === run.name) {
        lastStay.to = run.to;
        lastStay.samples.push(...run.samples);
        continue;
      }
      lastStay = { name: run.name, from: run.from, to: run.to, samples: [...run.samples] };
      stays.push(lastStay);
    }

    for (const stay of stays) {
      // Five seconds on a spot is only a hold if the gun was out for them. Time
      // spent with a smoke in hand is not holding an angle.
      const gunSecs = stay.samples.filter((s) => s.gun).length * step;
      if (gunSecs >= GUN_HOLD_SECONDS) {
        events.push({ sec: stay.from, at: stay.to, text: `Stay ${stay.name} until ${clockAt(stay.to)}` });
      }

      // Utility out on this spot, and thrown from it: a line-up. Independent of
      // the hold above, because a player does both from one spot — he sits on
      // Chair watching mid and puts the Window smoke up from the same step.
      for (;;) {
        const first = stay.samples.find(
          (s) => TYPE_WORDS[s.nade] && !linedUpTypes.has(`${stay.from}|${s.nade}`)
        );
        if (!first) break;
        linedUpTypes.add(`${stay.from}|${first.nade}`);
        const g = ourGrenades.find(
          (t) =>
            t.player === id &&
            !linedUp.has(t) &&
            normalizeNadeType(t.type) === first.nade &&
            secOf(Number(t.throwTick)) >= first.sec &&
            secOf(Number(t.throwTick)) <= stay.to + LINEUP_TAIL_SECONDS
        );
        if (!g) continue;
        linedUp.add(g);
        const link = linkOf.get(g);
        const word = lower(link?.word || TYPE_WORDS[normalizeNadeType(g.type)] || '');
        const what = [link?.spot || '', word].filter(Boolean).join(' ');
        const tag = link?.throwId ? `<${what}><!${link.throwId}>` : what;
        const thrownAt = secOf(Number(g.throwTick));
        events.push({
          sec: first.sec,
          at: thrownAt,
          text: `Line up ${tag} from ${stay.name}, throw at ${clockAt(thrownAt)}`
        });
      }
    }

    // ---- throws ----------------------------------------------------------
    for (const g of ourGrenades) {
      if (g.player !== id || linedUp.has(g)) continue;
      const link = linkOf.get(g);
      const word = link?.word || TYPE_WORDS[normalizeNadeType(g.type)] || '';
      if (!word) continue;
      const sec = secOf(Number(g.throwTick));
      const label = [word, link?.spot || '', `at ${clockAt(sec)}`].filter(Boolean).join(' ');
      events.push({ sec, at: sec, text: link?.throwId ? `<${label}><!${link.throwId}>` : label });
    }

    // ---- going somewhere, behind someone's utility -----------------------
    //
    // Never back into the spawn zone. A body drifting over that boundary is
    // the same "first zone" the rules already ignore, and "Go T Spawn on flash"
    // is not an instruction anyone would give.
    const spawnZone = zoneRuns[0]?.name || '';
    let lastGo = '';
    for (const run of zoneRuns.slice(1)) {
      if (run.name === spawnZone) continue;
      // The most recent grenade still in the air, so the line names the piece
      // of utility he actually walked in behind, and who threw it.
      const cover = flights
        .filter((f) => f.player !== id && secOf(f.from) <= run.from && secOf(f.to) >= run.from)
        .sort((a, b) => b.from - a.from)[0];
      if (!cover || run.name === lastGo) continue;
      lastGo = run.name;
      const who = nameOf.get(cover.player) || '';
      events.push({
        sec: run.from,
        text: `Go ${run.name} on ${lower(cover.word)}${who ? ` from ${who}` : ''}`
      });
    }

    // ---- standing in smoke -----------------------------------------------
    let smokeFrom = -1;
    let smokeAt = '';
    const closeSmoke = (endSec) => {
      if (smokeFrom < 0) return;
      if (endSec - smokeFrom >= MIN_SMOKE_SECONDS && smokeFrom >= spawnEndsAt) {
        events.push({
          sec: smokeFrom,
          text: smokeAt ? `In smoke at ${smokeAt}` : 'In smoke'
        });
      }
      smokeFrom = -1;
      smokeAt = '';
    };
    for (const s of samples) {
      const inside = smokes.some(
        (sm) =>
          s.tick >= sm.from &&
          s.tick <= sm.to &&
          (sm.x - s.x) ** 2 + (sm.y - s.y) ** 2 <= SMOKE_RADIUS_UNITS * SMOKE_RADIUS_UNITS
      );
      if (inside) {
        if (smokeFrom < 0) {
          smokeFrom = s.sec;
          smokeAt = s.position || s.zone;
        }
      } else {
        closeSmoke(s.sec);
      }
    }
    closeSmoke(samples[samples.length - 1]?.sec ?? 0);

    // ---- utility handed over ---------------------------------------------
    for (const h of handovers) {
      const word = lower(TYPE_WORDS[h.item] || h.item);
      if (h.from === id) events.push({ sec: h.sec, text: `Drop ${word}` });
      else if (h.to === id) events.push({ sec: h.sec, text: `Pick up ${word}` });
    }

    // Ordered by the clock each line SHOWS, not by when its situation began.
    // "Stay Top mid until 1:38" is ordered by 1:38; putting it where the stay
    // started would print 1:38 ahead of a throw at 1:45 and read backwards.
    events.sort((a, b) => eventClock(a) - eventClock(b) || a.sec - b.sec);

    let note = joinEvents(events, exec);
    if (showBuy) {
      const buy = buyString(
        meta.stats?.[id]?.loadout || [],
        track.sample(slot, t0, scratch)
      );
      if (buy) note = note ? `${buy}. ${note}` : `${buy}.`;
    }
    notes.set(id, note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX - 1).trimEnd()}…` : note);
  }

  return notes;
}
