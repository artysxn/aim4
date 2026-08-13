// ---------------------------------------------------------------------------
// shared/sim/comms.js
// The team's voice channel: five levels, one delay draw per message, and an
// ask that carries no information.
//
// SIM-PLAN 19.6 ("The support request") and SIM-PLAN 20.7 ("Communication
// levels: negative information is a comm, not a fact"). They are one module
// because they are one channel. A support request is Level 4 of the same
// doctrine ladder that makes "banana is clear" a Level 2, and both pay the
// same 0.5 to 1.5 s delay from 5.1.
//
// WHAT MUST NEVER BE ROUTED THROUGH THIS BUS. 5.1's knowledge table is
// explicit and it is not a knob: **radar-like facts are INSTANT in
// Counter-Strike**. Living teammates' positions, enemies spotted by anyone on
// the side, the bomb on the T radar, the kill feed, the plant sound — the game
// itself shares all of those, no human has to say them, and delaying them here
// would make the sim less like CS rather than more. This bus carries only what
// a player has to actually SAY: a sound only one bot heard, a negative
// confirmation, an intent, an ask, a plan. If a spotted enemy ever ends up in
// here, the bug is upstream: the engine already showed him to the whole side.
//
// THE HONESTY HOLE THIS CLOSES (20.7). knowledge.js's header states the rule
// and this module is the other half of it: clearing an angle deletes mass from
// the clearing bot's own view immediately, and from the team blackboard **only
// when he says so**, at the comm delay. Chapter 3 calls the gap between Level 1
// ("one short") and Level 2 ("*only* one short") one of the biggest gaps
// between amateur and professional play; if negative information were free,
// Level 2 would be worth nothing. So `belief.cleared()` is applied on ARRIVAL
// of a Level 2 message, never at the moment of observation, and the team
// blackboard is legitimately behind the sharp personal views by the delay and
// by whatever nobody bothered to say. Expect this to make every belief-accuracy
// number worse on the day it lands (decision 64): that is the point.
//
// THE FIVE LEVELS, in the plan's own words:
//
//   1 observation  "what I see or hear"
//   2 negative     "what I have cleared and it was empty"
//   3 intent       "the option I am about to take"
//   4 request      "what I want you to do (19.6)"
//   5 asp          "the after-situation plan"
//
// A message carries exactly one of them. The level is not decoration: it is
// what a `teamwork`-scaled emission gate is applied to (`willSay`), so a `mix`
// team is not blind, it simply does not tell itself what it has cleared, and it
// plays on a staler map. That is a far better model of bad play than slower
// reactions.
//
// THE REQUEST IS AN OFFER, NEVER A COMPULSION. 19.6: serving a request is an
// ordinary priced decision by the receiver and **he is not obliged**, because
// good teams refuse bad requests. Nothing in this file dispatches a servicer,
// scores one, or nudges one. `openRequests()` publishes the live asks and
// `secondsLeft()` tells a receiver how much of the deadline is left to discount
// `worth` against; the pricing itself belongs to foresight.js and the refusal
// is simply the absence of a `serve()` call.
//
// AND IT IS NOT A BACK CHANNEL (decision 58: "The support request can become a
// telepathy channel"). A request carries an ask and never a percept. That is
// enforced structurally rather than by convention: the request payload is the
// one payload this module REBUILDS from a field whitelist instead of passing
// through, an envelope whose level disagrees with its payload is refused, and a
// request with any extra key is refused outright rather than quietly stripped,
// because a caller who tried to smuggle wants to know. `worth` is deliberately
// the only number that crosses, and it is a price, not a percept.
//
// NO TRANSCRIPT (decision 40). Delivered messages are drained and forgotten;
// only unserved requests are held, and only until they are served or die on
// their deadline. Nothing here accumulates a conversation.
//
// No I/O, no Date.now, no Math.random. Ticks are passed in and every delay is
// drawn from an injected Rng, because a comm delay that is not seeded makes
// two runs of the same seed diverge — and under a delay this large, diverge
// into different rounds.
//
// NOT yet wired into desireBot.js, which still calls `belief.cleared()` on the
// team blackboard directly (the pre-20.7 behaviour). The controller change is a
// later step; this module is the channel only.
// ---------------------------------------------------------------------------

import { COMM_DELAY_MAX, COMM_DELAY_MIN, TICK_RATE } from './constants.js';

/** The doctrine's five levels (20.7), as numbers because the schema uses them. */
export const LEVEL = Object.freeze({
  OBSERVATION: 1,
  NEGATIVE: 2,
  INTENT: 3,
  REQUEST: 4,
  ASP: 5
});

/** Level -> the single payload field it may carry. Index 0 is unused. */
export const LEVEL_PAYLOAD = Object.freeze([
  '',
  'observation',
  'negative',
  'intent',
  'request',
  'asp'
]);

/** The plan's gloss for each level, kept so a decision log reads like comms. */
export const LEVEL_MEANING = Object.freeze([
  '',
  'what I see or hear',
  'what I have cleared and it was empty',
  'the option I am about to take',
  'what I want you to do',
  'the after-situation plan'
]);

const PAYLOAD_FIELDS = Object.freeze(new Set(LEVEL_PAYLOAD.slice(1)));
const ENVELOPE_FIELDS = Object.freeze(new Set(['level', 'from', 'to']));

/** The five asks of 19.6. Nothing else is a support request. */
export const REQUEST_KINDS = Object.freeze(['flash', 'smoke', 'molotov', 'trade', 'info']);

/**
 * The whitelist that makes the ask an ask. Every other key on a request is a
 * smuggling attempt by construction, whatever it was named.
 */
export const REQUEST_FIELDS = Object.freeze(['type', 'what', 'where', 'by', 'worth']);

/**
 * Requests one bot may put on the channel in one round.
 *
 * 19.6 says a request storm is a real failure mode and the cap is the only
 * defence, and does not name a number, so here is the argument for four.
 * MAX_GRENADES is 4: a bot that has asked four times has already asked for more
 * utility than any single teammate can be carrying, so the fifth ask cannot be
 * served by the natural servicer (the teammate holding that lineup in his
 * `utilBudget`, 6.19) even in principle. Four asks also cost at least four comm
 * delays of team voice out of a two-minute round, and under 20.7's silence
 * discipline every one of them lands on somebody as attention. The number is a
 * ceiling on spam, not a budget to spend: a bot that needs four is already
 * playing badly. `[calibrate against the chapter-3 message-volume metric]`
 */
export const REQUESTS_PER_ROUND = 4;

/**
 * Attention a message costs its receiver while `inDuel` (5.7 slot units).
 *
 * 20.7: silence discipline is a cost, not a rule. Chapter 3 says do not talk to
 * a player who is in a duel, so a message that lands on one is charged, and the
 * charge grows with the number of fields — explanation is a longer message for
 * the same action content, so "do not explain why mid-round" falls out of the
 * arithmetic instead of being written down as a rule. `[calibrate]`
 */
export const COMM_ATTENTION_COST = 0.4;
export const COMM_ATTENTION_PER_FIELD = 0.15;

/**
 * Per level, the probability that a bot emits it at all, from `mix` to `pro`.
 *
 * 20.7: comm quality is a trait with teeth. It rides on `teamwork` (6.16,
 * skill.js) rather than a new trait, because that is the trait mimicry already
 * fits. Everybody calls contact; almost nobody at the bottom of the ladder says
 * what they have CLEARED, which is exactly the amateur/professional gap chapter
 * 3 names, and the Level 5 row is why an after-situation plan is rare enough to
 * be worth something. `[calibrate against the 20.15 chapter-3 metrics: Level 2
 * emission rate after clearing a zone, Level 5 share of orders]`
 */
export const SAY_RATE = Object.freeze({
  1: Object.freeze([0.75, 0.98]),
  2: Object.freeze([0.1, 0.9]),
  3: Object.freeze([0.35, 0.95]),
  4: Object.freeze([0.5, 0.95]),
  5: Object.freeze([0.05, 0.8])
});

/**
 * One delay draw, uniform over 5.1's range. Exported because it is the one
 * number the whole channel is built on, and because a second definition of it
 * elsewhere is how two subsystems end up disagreeing about how fast a team can
 * talk. attention.js draws the same range for a team replan.
 */
export function commDelaySeconds(rng) {
  return COMM_DELAY_MIN + rng.next() * (COMM_DELAY_MAX - COMM_DELAY_MIN);
}

/** Fields of content in a payload, with a list counting as one. */
function contentSize(payload) {
  if (!payload || typeof payload !== 'object') return 1;
  let n = 0;
  for (const v of Object.values(payload)) {
    n += v && typeof v === 'object' && !Array.isArray(v) ? contentSize(v) : 1;
  }
  return n;
}

/**
 * Rebuild a request from the whitelist, and report anything that was not on it.
 *
 * The rebuild is the enforcement. Nothing from the caller's object reaches the
 * bus by reference, so a percept cannot ride along in a field nobody thought to
 * ban, and a caller who mutates his object after sending cannot change what was
 * said. `stripped` is what a smuggling attempt looks like from here; `bad` is a
 * malformed ask.
 *
 * @returns {{request: object|null, stripped: string[], bad: string|null}}
 */
export function sanitizeRequest(raw) {
  const stripped = [];
  if (!raw || typeof raw !== 'object') {
    return { request: null, stripped, bad: 'request is not an object' };
  }
  for (const key of Object.keys(raw)) {
    if (!REQUEST_FIELDS.includes(key)) stripped.push(key);
  }
  if (raw.type != null && raw.type !== 'request') {
    return { request: null, stripped, bad: `type must be "request" (${raw.type})` };
  }
  if (!REQUEST_KINDS.includes(raw.what)) {
    return { request: null, stripped, bad: `what must be one of ${REQUEST_KINDS.join('|')}` };
  }
  if (typeof raw.where !== 'string' || !raw.where) {
    return { request: null, stripped, bad: 'where must be an anchor or zone id' };
  }
  if (!Number.isFinite(raw.by) || raw.by <= 0) {
    return { request: null, stripped, bad: 'by must be a positive number of seconds' };
  }
  if (!Number.isFinite(raw.worth) || raw.worth < 0) {
    return { request: null, stripped, bad: 'worth must be a non-negative dPRW gain' };
  }
  const request = Object.freeze({
    type: 'request',
    what: raw.what,
    where: raw.where,
    by: raw.by,
    worth: raw.worth
  });
  return { request, stripped, bad: null };
}

/**
 * The channel. One instance per side, per match.
 *
 * The delay is drawn once PER MESSAGE and not per listener: it is one
 * utterance, and everybody who was listening hears it at the same moment. That
 * is also what 5.1 says ("per message, seeded"), and it is what makes 19.11's
 * point work — under independently drawn delays a team cannot synchronize by
 * talking, so it synchronizes on observable events instead.
 */
export class CommBus {
  /**
   * @param {object} cfg
   * @param {import('./rng.js').Rng} cfg.rng   injected; never Math.random
   * @param {number} [cfg.tickRate]
   * @param {number} [cfg.requestsPerRound]    the 19.6 storm cap
   */
  constructor({ rng, tickRate = TICK_RATE, requestsPerRound = REQUESTS_PER_ROUND } = {}) {
    if (!rng || typeof rng.next !== 'function') {
      throw new Error('CommBus needs an injected rng: an unseeded comm delay breaks determinism');
    }
    this.rng = rng;
    this.tickRate = tickRate;
    this.requestsPerRound = requestsPerRound;

    /** In flight: sent, not yet arrived. Drained by deliver(). */
    this.flight = [];
    /** Delivered requests nobody has served yet, by id. The live offers. */
    this.open = new Map();
    /** Requests each bot has put on the channel this round (the cap). */
    this.sentThisRound = new Map();
    this.nextId = 1;

    /**
     * Cumulative across the match, because the diagnostic 19.6 asks for is a
     * RATE: "a team whose entry asks for the same flash every round and never
     * gets it has a budget bug or a sync bug, and it is one counter rather than
     * an investigation."
     */
    this.stats = {
      sent: 0,
      delivered: 0,
      refused: 0,
      byLevel: [0, 0, 0, 0, 0, 0],
      requests: { sent: 0, served: 0, expired: 0, capped: 0, refused: 0 },
      /** Per ask kind, so "the flash that never comes" is one lookup. */
      byWhat: Object.fromEntries(
        REQUEST_KINDS.map((k) => [k, { sent: 0, served: 0, expired: 0, capped: 0 }])
      )
    };
  }

  /**
   * Say something. Returns `{ok, msg, reason}` rather than throwing, because a
   * throw inside a tick loop kills a round, and returns `ok: false` rather than
   * dropping quietly, because a silently swallowed message is how a comms bug
   * hides for a week.
   *
   * @param {number} tick
   * @param {{level:number, from:number, to?:number|null, observation?:object,
   *          negative?:object, intent?:object, request?:object, asp?:object}} envelope
   */
  send(tick, envelope) {
    if (!envelope || typeof envelope !== 'object') return this._refuse('bad_envelope');
    const { level } = envelope;
    if (!Number.isInteger(level) || level < 1 || level > 5) return this._refuse('bad_level');
    if (!Number.isInteger(envelope.from)) return this._refuse('bad_from');
    const to = envelope.to == null ? null : envelope.to;
    if (to !== null && !Number.isInteger(to)) return this._refuse('bad_to');

    // Exactly one payload, and it must be the one this level names. A Level 4
    // envelope carrying an `observation` is the back channel, one layer up from
    // a smuggled field, so it is refused at the envelope too.
    const field = LEVEL_PAYLOAD[level];
    for (const key of Object.keys(envelope)) {
      if (ENVELOPE_FIELDS.has(key)) continue;
      if (!PAYLOAD_FIELDS.has(key)) return this._refuse('unknown_field');
      if (key !== field) {
        return this._refuse(
          level === LEVEL.REQUEST ? 'percept_in_request' : 'payload_level_mismatch'
        );
      }
    }
    if (envelope[field] == null) return this._refuse('missing_payload');

    let payload = envelope[field];
    let expiresTick = null;

    if (level === LEVEL.REQUEST) {
      const { request, stripped, bad } = sanitizeRequest(payload);
      if (stripped.length) {
        this.stats.requests.refused += 1;
        return this._refuse('percept_in_request', { stripped });
      }
      if (bad) {
        this.stats.requests.refused += 1;
        return this._refuse('bad_request', { detail: bad });
      }
      const used = this.sentThisRound.get(envelope.from) || 0;
      if (used >= this.requestsPerRound) {
        this.stats.requests.capped += 1;
        this.stats.byWhat[request.what].capped += 1;
        return this._refuse('capped');
      }
      this.sentThisRound.set(envelope.from, used + 1);
      this.stats.requests.sent += 1;
      this.stats.byWhat[request.what].sent += 1;
      payload = request;
      // `by` is a horizon in seconds from the moment it was said, so a request
      // whose delay outruns its own deadline is dead on arrival. That is a real
      // outcome, not an error: asking for a 0.6 s flash over a 1.4 s channel is
      // how a request goes unserved, and the counter is supposed to see it.
      expiresTick = tick + Math.max(1, Math.round(request.by * this.tickRate));
    } else if (typeof payload === 'object') {
      // Every other payload is the caller's percept or plan and keeps its
      // shape; the copy only stops later mutation from rewriting what was said.
      payload = Array.isArray(payload) ? [...payload] : { ...payload };
    }

    const delay = commDelaySeconds(this.rng);
    const msg = Object.freeze({
      id: this.nextId++,
      level,
      from: envelope.from,
      to,
      sentTick: tick,
      // At least one tick: nothing said is ever heard on the tick it was said.
      arriveTick: tick + Math.max(1, Math.round(delay * this.tickRate)),
      delay,
      expiresTick,
      [field]: payload
    });

    this.flight.push(msg);
    this.stats.sent += 1;
    this.stats.byLevel[level] += 1;
    return { ok: true, msg, reason: null };
  }

  _refuse(reason, extra = {}) {
    this.stats.refused += 1;
    return { ok: false, msg: null, reason, ...extra };
  }

  /**
   * Everything that has arrived by `tick`, removed from the channel.
   *
   * Expiry is checked first and wins ties: at its deadline a request is dead
   * whether or not it also arrived on that tick. Delivered requests move to the
   * open set; everything else is handed over and forgotten (decision 40).
   */
  deliver(tick) {
    for (const [id, m] of this.open) {
      if (tick >= m.expiresTick) {
        this.open.delete(id);
        this._countExpired(m);
      }
    }

    const out = [];
    const still = [];
    for (const m of this.flight) {
      if (m.expiresTick != null && tick >= m.expiresTick) {
        this._countExpired(m);
        continue;
      }
      if (tick >= m.arriveTick) {
        out.push(m);
        this.stats.delivered += 1;
        if (m.level === LEVEL.REQUEST) this.open.set(m.id, m);
      } else {
        still.push(m);
      }
    }
    this.flight = still;
    return out;
  }

  _countExpired(m) {
    this.stats.requests.expired += 1;
    this.stats.byWhat[m.request.what].expired += 1;
  }

  /** Messages still in flight. A test's window into the delay, nothing more. */
  pending() {
    return this.flight.length;
  }

  /**
   * The live asks a receiver may price. An OFFER: the bus never picks a
   * servicer and never penalizes one for walking past. Pass a slot to see what
   * was addressed to that bot plus everything said to the team.
   */
  openRequests(slot = null) {
    const out = [];
    for (const m of this.open.values()) {
      if (slot == null || m.to == null || m.to === slot) out.push(m);
    }
    return out;
  }

  /** Seconds left on a request's deadline: what `worth` is discounted against. */
  secondsLeft(msg, tick) {
    if (!msg || msg.expiresTick == null) return Infinity;
    return Math.max(0, (msg.expiresTick - tick) / this.tickRate);
  }

  /**
   * A receiver chose to serve this ask. Not an obligation and not a scoring
   * hook: it closes the offer and moves one number from unserved to served.
   * Who served it is not recorded, because that is a transcript (decision 40)
   * and the diagnostic only ever asks whether anybody did.
   */
  serve(id) {
    const m = this.open.get(id);
    if (!m) return false;
    this.open.delete(id);
    this.stats.requests.served += 1;
    this.stats.byWhat[m.request.what].served += 1;
    return true;
  }

  /**
   * The 19.6 diagnostic. Unserved over asked, for one kind or all of them. A
   * team that asks for the same flash every round and never gets it reads here
   * as a number instead of an investigation.
   */
  unservedRequestRate(what = null) {
    const s = what ? this.stats.byWhat[what] : this.stats.requests;
    if (!s) return 0;
    const settled = s.served + s.expired;
    return settled > 0 ? s.expired / settled : 0;
  }

  /** Requests this bot has left this round, against the storm cap. */
  requestsLeft(slot) {
    return Math.max(0, this.requestsPerRound - (this.sentThisRound.get(slot) || 0));
  }

  /**
   * New round: the cap resets and the channel empties.
   *
   * Anything still outstanding counts as expired rather than vanishing, because
   * an ask that died on the round clock went unserved exactly as much as one
   * that died on its deadline, and the diagnostic is about being ignored.
   */
  newRound() {
    for (const m of this.open.values()) this._countExpired(m);
    for (const m of this.flight) if (m.level === LEVEL.REQUEST) this._countExpired(m);
    this.open.clear();
    this.flight = [];
    this.sentThisRound.clear();
  }
}

/**
 * Apply an ARRIVED message to the team blackboard (knowledge.js).
 *
 * The whole point of 20.7 is in the word arrived: this is called from the
 * delivery loop, never from the observation that produced the message. A
 * negative confirmation is the first-class case — "banana is clear" is a Level
 * 2 comm, and until it lands the blackboard still believes somebody could be on
 * banana, which is what makes saying it valuable.
 *
 * Level 1 is the part of a contact call the radar does not already carry (which
 * enemy, at which anchor, with what) — the blip itself was instant and is not
 * this bus's business. Levels 3 to 5 are decisions, not evidence, and touch no
 * belief.
 *
 * @param {object} msg  a message from bus.deliver()
 * @param {import('./knowledge.js').JointBelief} belief  the team blackboard
 * @returns {boolean} whether the belief changed
 */
export function applyArrival(msg, belief) {
  if (!msg || !belief) return false;
  if (msg.level === LEVEL.NEGATIVE) {
    const anchors = msg.negative?.anchors;
    if (!anchors || (Array.isArray(anchors) ? !anchors.length : !anchors.size)) return false;
    belief.cleared(anchors);
    return true;
  }
  if (msg.level === LEVEL.OBSERVATION) {
    const o = msg.observation;
    if (!o || !Number.isInteger(o.enemySlot) || typeof o.anchor !== 'string') return false;
    belief.sighting(o.enemySlot, o.anchor, { level: o.level, weapon: o.weapon || null });
    return true;
  }
  return false;
}

/**
 * Does this bot bother to say it? (20.7, comm quality as a trait.)
 *
 * Rides on `teamwork`. A `mix` bot is not blind and is not slower; it simply
 * does not tell its team what it cleared, so the team plays on a staler map.
 * The caller owns the draw's rng so this cannot perturb the bus's delay stream.
 */
export function willSay(level, profile, rng) {
  const band = SAY_RATE[level];
  if (!band) return false;
  const t = Math.max(0, Math.min(1, profile?.teamwork ?? 0.5));
  return rng.next() < band[0] + (band[1] - band[0]) * t;
}

/**
 * What a message costs the bot it lands on, in the attention slots of 5.7.
 *
 * Zero unless he is in a duel, which is the whole of chapter 3's silence
 * discipline expressed as arithmetic: comm spam is punished and terseness is
 * rewarded without anybody writing "be terse". Charging it belongs to the
 * controller and attention.js; this is the price only.
 */
export function attentionCost(msg, { inDuel = false } = {}) {
  if (!inDuel || !msg) return 0;
  const fields = contentSize(msg[LEVEL_PAYLOAD[msg.level]]);
  return COMM_ATTENTION_COST + COMM_ATTENTION_PER_FIELD * Math.max(0, fields - 1);
}
