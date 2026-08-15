// ---------------------------------------------------------------------------
// shared/sim/orders.js
// 6.1: the viewer calls it, and the bots may say no.
//
// God mode's Call mode (11.5). An order is issued at freeze or at any tick
// mid-round, to the whole team or to any subset of it, and the interesting
// half is not that the bots obey. It is that they can REFUSE, with a motive
// a human can read, because a team that always obeys is a puppet and a
// puppet's round teaches nothing about what the bots believe.
//
// Two rules this file exists to hold:
//
//   A REFUSAL IS PRICED, NOT SCRIPTED. The caller already prices calls
//   (9.25 stage 1); a refusal is that price coming back far enough below what
//   the team is already doing that overriding would be malpractice. Hard
//   refusals -- an illegal call, a bot mid-defuse -- come first, because those
//   are not judgements.
//
//   A HUMAN CALL IS RADIOACTIVE. It is labelled here, at the source, and the
//   label rides the round into the meta, the experience index and the training
//   queue. A human call is not evidence about what the Strategy AI would have
//   chosen, and letting the two mix would quietly poison both the memory and
//   the evaluation (11.5). Nothing downstream is trusted to remember this:
//   the round carries `humanCalled` and the write paths check it.
// ---------------------------------------------------------------------------

/** Where an order came from. Only `human` is quarantined. */
export const ORDER_SOURCE = Object.freeze({ HUMAN: 'human', CALLER: 'caller', DRILL: 'drill' });

export const ORDER_VERDICT = Object.freeze({ ACCEPTED: 'accepted', REFUSED: 'refused' });

/**
 * How much worse than the current plan an ordered call may be priced before
 * the team refuses it. Wider than the caller's own recall margin on purpose:
 * a human is allowed to be wrong, and only stopped from being absurd.
 */
export const REFUSAL_MARGIN = 0.22;

/** Below this support the head is not confident enough to refuse ON PRICE. */
export const REFUSAL_MIN_SUPPORT = 40;

export const REFUSAL = Object.freeze({
  ILLEGAL: 'illegal',
  CHANNEL: 'channel',
  DEAD: 'dead',
  PRICE: 'price',
  LATE: 'late'
});

/** Past this much of the round gone, a fresh execute is not a plan. */
export const LATE_CALL_SECONDS = 95;

/**
 * One order, normalized.
 *
 * @param {object} raw
 * @param {string} raw.call            the call name, from this map's vocabulary
 * @param {'T'|'CT'} raw.side
 * @param {number[]} [raw.slots]       who it binds; empty or absent means the team
 * @param {number} [raw.tick]          when it was issued; 0 is at the freeze
 * @param {string} [raw.source]
 * @param {string} [raw.note]          free text from the viewer, carried, never parsed
 */
export function makeOrder(raw = {}) {
  return {
    call: String(raw.call || '').trim() || null,
    side: raw.side === 'CT' ? 'CT' : 'T',
    slots: Array.isArray(raw.slots) ? [...new Set(raw.slots.map(Number).filter(Number.isInteger))] : [],
    tick: Number.isFinite(Number(raw.tick)) ? Math.max(0, Number(raw.tick)) : 0,
    source: raw.source === ORDER_SOURCE.CALLER || raw.source === ORDER_SOURCE.DRILL
      ? raw.source
      : ORDER_SOURCE.HUMAN,
    note: raw.note ? String(raw.note).slice(0, 200) : null
  };
}

/**
 * A queue of orders, drained by tick.
 *
 * Orders are held rather than applied immediately because the engine steps in
 * ticks and a call issued "now" from a browser lands between two of them. The
 * queue makes the tick the order takes effect on explicit, which is also what
 * makes a branch (6.0) of the same call reproducible.
 */
export function createOrderQueue(orders = []) {
  const pending = orders.map(makeOrder).filter((o) => o.call).sort((a, b) => a.tick - b.tick);
  let cursor = 0;

  return {
    /** Orders for this side whose tick has arrived. Each is handed out once. */
    due(tick, side) {
      const out = [];
      while (cursor < pending.length && pending[cursor].tick <= tick) {
        const o = pending[cursor];
        cursor += 1;
        if (o.side === side) out.push(o);
      }
      return out;
    },
    /**
     * Peek without consuming, for the side that is not draining. Both sides
     * share one queue in a versus match, so a T order must not be swallowed
     * by the CT controller's drain.
     */
    forSide(side) {
      return pending.filter((o) => o.side === side);
    },
    get size() {
      return pending.length;
    }
  };
}

/**
 * Should the team take this order?
 *
 * Hard refusals first, and they are facts rather than opinions: a call this
 * side cannot make, a bot committed to a channel, nobody alive to run it. Then
 * the priced refusal, which is the one that makes the mode worth having.
 *
 * @param {object} args
 * @param {object} args.order
 * @param {string[]} args.legalCalls    what this side may call on this map
 * @param {number} args.clock           seconds elapsed in the round
 * @param {object[]} args.bodies        the ordered slots' bodies (alive, channel)
 * @param {string|null} args.currentCall
 * @param {(call: string) => ({mean?: number, n?: number}|null)} [args.priceOf]
 *        the caller's head, same shape `memoryOf` returns
 * @returns {{verdict: string, reason: string|null, motive: string, price: object|null}}
 */
export function evaluateOrder({
  order,
  legalCalls = [],
  clock = 0,
  bodies = [],
  currentCall = null,
  priceOf = null
}) {
  const refuse = (reason, motive) => ({ verdict: ORDER_VERDICT.REFUSED, reason, motive, price: null });

  if (!order?.call) return refuse(REFUSAL.ILLEGAL, 'no call given');
  if (legalCalls.length && !legalCalls.includes(order.call)) {
    return refuse(REFUSAL.ILLEGAL, `${order.call} is not a call this side can make here`);
  }

  const bound = bodies.filter((b) => !order.slots.length || order.slots.includes(b.slot));
  if (!bound.length || bound.every((b) => !b.alive)) {
    return refuse(REFUSAL.DEAD, 'nobody alive to run it');
  }
  // Planting and defusing are commitments, not preferences. Pulling a bot out
  // of a defuse to run an execute is the one override that loses rounds
  // outright, so it is refused before anything is priced.
  const busy = bound.find((b) => b.alive && b.channel);
  if (busy) {
    return refuse(REFUSAL.CHANNEL, `slot ${busy.slot} is ${busy.channel} and will not break off`);
  }
  if (clock > LATE_CALL_SECONDS) {
    return refuse(REFUSAL.LATE, `${Math.round(clock)}s in, there is no time to run it`);
  }

  // The priced refusal. Only when the head has enough support to mean it: a
  // thin cell talking the team out of a human's call is the failure mode 18.4
  // spends its whole Wilson bound avoiding.
  if (typeof priceOf === 'function' && currentCall && currentCall !== order.call) {
    const asked = priceOf(order.call);
    const now = priceOf(currentCall);
    if (
      asked &&
      now &&
      (asked.n || 0) >= REFUSAL_MIN_SUPPORT &&
      (now.n || 0) >= REFUSAL_MIN_SUPPORT
    ) {
      const drop = (now.mean ?? 0) - (asked.mean ?? 0);
      if (drop > REFUSAL_MARGIN) {
        return {
          verdict: ORDER_VERDICT.REFUSED,
          reason: REFUSAL.PRICE,
          motive:
            `${order.call} prices at ${(asked.mean * 100).toFixed(0)}% against ` +
            `${(now.mean * 100).toFixed(0)}% for ${currentCall}`,
          price: { asked: asked.mean, now: now.mean, n: asked.n }
        };
      }
      return {
        verdict: ORDER_VERDICT.ACCEPTED,
        reason: null,
        motive: `taking ${order.call} at ${(asked.mean * 100).toFixed(0)}%`,
        price: { asked: asked.mean, now: now.mean, n: asked.n }
      };
    }
  }

  return {
    verdict: ORDER_VERDICT.ACCEPTED,
    reason: null,
    motive: `taking ${order.call}`,
    price: null
  };
}

/**
 * Did a human touch this round?
 *
 * The one question every downstream write path asks. An order the bots
 * REFUSED still counts: the refusal itself came from a human being in the
 * loop, and the round is no longer a clean sample of what the team would have
 * done unwatched.
 */
export function humanTouched(log = []) {
  return log.some((e) => e?.source === ORDER_SOURCE.HUMAN);
}
