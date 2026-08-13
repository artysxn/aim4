// ---------------------------------------------------------------------------
// shared/sim/sync.js
// Synchronization is anchored, not reactive.
//
// SIM-PLAN 19.11. With a 0.5 to 1.5 s comm delay drawn independently per
// message (5.1), a team physically cannot synchronize by reacting to each
// other. Five bots cannot go on a call that arrives at five different times.
// The anchor is therefore pre-agreed at the last common moment, and it is
// something every participant can observe locally.
//
// Two kinds, both real, both already available:
//
//   CLOCK  "go at 1:32"   exact, needs no percept, readable by an opponent
//                         who is counting
//   EVENT  "go on the CT smoke"  self-correcting under drift, needs only a
//                         percept everyone gets (a detonation is seen or heard)
//
// The TeamDirective's `sync` field is this object. Role-contract `window`
// clauses (6.19) are measured relative to it rather than to the round clock.
// Deviation is the synchronization spread `coach/siteExecute.js` already
// measures, so the metric ships with the feature.
//
// THE ANCHOR IS A TELL. A team that always goes on the smoke can be timed, so
// the choice is mixed by the same machinery as everything else (6.9).
// `mixAnchor` draws from an injected Rng and throws without one: Math.random
// here would make two runs of the same seed diverge into different executes.
//
// PARTIAL BREAKS RE-SOLVE RATHER THAN ABORT. If a body is late past tolerance,
// the pack either waits (paying clock and anchor freshness) or goes
// short-handed, and going short-handed is `clearPartition` (19.5) re-solved
// over fewer bodies. This file returns the flags; the caller prices them.
//
// Pure: no I/O, no Date.now, no Math.random. Same sync and the same percepts
// always produce the same go.
// ---------------------------------------------------------------------------

export const ANCHOR = Object.freeze({
  CLOCK: 'clock',
  EVENT: 'event'
});

/** Event names a sync can wait on. Detonation is the percept everyone gets. */
export const SYNC_EVENT = Object.freeze({
  CT_SMOKE: 'ct_smoke',
  DETONATE: 'detonate',
  FLASH: 'flash'
});

/**
 * P(the team picks a clock anchor). Clock is the readable tell, so it is the
 * minority mix; event is what real teams mostly use. `[calibrate]`
 */
export const MIX_CLOCK_P = 0.35;

/** Seconds either side of a clock mark that still count as it. `[calibrate]` */
export const DEFAULT_TOLERANCE_SECONDS = 0.4;

function clockMotive(atSeconds) {
  const s = Math.max(0, Math.round(Number(atSeconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `go at ${m}:${String(r).padStart(2, '0')}`;
}

function eventMotive(event) {
  if (event === SYNC_EVENT.CT_SMOKE) return 'go on the CT smoke';
  if (event === SYNC_EVENT.FLASH) return 'go on the flash';
  if (event === SYNC_EVENT.DETONATE) return 'go on the detonation';
  return `go on ${event}`;
}

/**
 * Pre-agree an anchor.
 *
 * Clock: `atSeconds` is remaining on the round clock ("go at 1:32").
 * Event: `event` is `ct_smoke` | `detonate` | `flash`, and everyone goes on
 * the percept.
 *
 * @param {object} args
 * @param {'clock'|'event'} args.kind
 * @param {number} [args.atSeconds]
 * @param {string} [args.event]
 * @param {number} [args.toleranceSeconds]
 */
export function makeSync({ kind, atSeconds, event, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = {}) {
  const tol = Number.isFinite(toleranceSeconds) ? Math.max(0, toleranceSeconds) : DEFAULT_TOLERANCE_SECONDS;
  if (kind === ANCHOR.CLOCK) {
    return {
      kind: ANCHOR.CLOCK,
      atSeconds,
      toleranceSeconds: tol,
      motive: clockMotive(atSeconds)
    };
  }
  if (kind === ANCHOR.EVENT) {
    return {
      kind: ANCHOR.EVENT,
      event,
      toleranceSeconds: tol,
      motive: eventMotive(event)
    };
  }
  throw new Error(`makeSync: unknown kind ${kind}`);
}

function perceptType(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p.toLowerCase();
  const type = String(p.type ?? '').toLowerCase();
  const nade = String(p.nade ?? p.weapon ?? p.name ?? '').toLowerCase();
  return nade ? `${type} ${nade}` : type;
}

function eventMatches(percept, event) {
  const t = perceptType(percept);
  if (!event) return false;
  if (t === String(event).toLowerCase()) return true;
  if (event === SYNC_EVENT.CT_SMOKE) {
    return t.includes('smoke') || t.includes('ct_smoke');
  }
  if (event === SYNC_EVENT.FLASH) {
    return t.includes('flash');
  }
  if (event === SYNC_EVENT.DETONATE) {
    return (
      t.includes('detonate') ||
      t.includes('grenade') ||
      t.includes('smoke') ||
      t.includes('flash') ||
      t.includes('molotov') ||
      t.includes('hegrenade') ||
      t.includes('incen')
    );
  }
  return t.includes(String(event).toLowerCase());
}

/**
 * Has this body reached the pre-agreed anchor?
 *
 * Clock: |secondsLeft - atSeconds| <= tolerance.
 * Event: some percept in the list matches the event type.
 *
 * @param {object} sync  a `makeSync` result
 * @param {object} now
 * @param {number} [now.secondsLeft]
 * @param {Array<{type:string}|string>} [now.percepts]
 * @returns {{go: boolean, late: boolean, motive: string}}
 */
export function reached(sync, { secondsLeft, percepts } = {}) {
  if (!sync) return { go: false, late: false, motive: 'no sync anchor' };
  if (sync.kind === ANCHOR.CLOCK) {
    const tol = Number.isFinite(sync.toleranceSeconds) ? sync.toleranceSeconds : DEFAULT_TOLERANCE_SECONDS;
    const at = Number(sync.atSeconds);
    const left = Number(secondsLeft);
    if (!Number.isFinite(at) || !Number.isFinite(left)) {
      return { go: false, late: false, motive: 'clock anchor needs secondsLeft' };
    }
    const delta = left - at;
    const go = Math.abs(delta) <= tol;
    const late = left < at - tol;
    return {
      go,
      late,
      motive: go ? sync.motive : late ? `late for ${sync.motive}` : `waiting for ${sync.motive}`
    };
  }
  if (sync.kind === ANCHOR.EVENT) {
    const list = Array.isArray(percepts) ? percepts : [];
    const go = list.some((p) => eventMatches(p, sync.event));
    return {
      go,
      late: false,
      motive: go ? sync.motive : `waiting for ${sync.motive}`
    };
  }
  return { go: false, late: false, motive: `unknown sync kind ${sync.kind}` };
}

/**
 * A body is late past tolerance. Wait, or go short-handed?
 *
 * Priced, not scripted: the flags are what the caller hands to
 * `clearPartition` (19.5) over the remaining bodies. Default:
 * one late body and three or more still here, go short; two or more late,
 * wait. `[calibrate]`
 *
 * @param {object} args
 * @param {Array} args.lateSlots
 * @param {number} [args.tolerance]
 * @param {number|Array} args.bodies
 * @returns {{wait: boolean, goShort: boolean, remaining: number, motive?: string}}
 */
export function partialBreak({ lateSlots = [], tolerance, bodies = 0 } = {}) {
  const late = Array.isArray(lateSlots) ? lateSlots : [];
  const n = Array.isArray(bodies) ? bodies.length : Math.max(0, Number(bodies) || 0);
  const remaining = Math.max(0, n - late.length);
  const window = Number.isFinite(tolerance) ? `${tolerance}s` : 'tolerance';

  if (late.length === 0) {
    return { wait: false, goShort: false, remaining, motive: 'nobody is late' };
  }
  if (late.length >= 2) {
    return {
      wait: true,
      goShort: false,
      remaining,
      motive: `${late.length} late past ${window}: wait`
    };
  }
  if (n >= 3) {
    return {
      wait: false,
      goShort: true,
      remaining,
      motive: `one late past ${window}, ${remaining} still here: go short-handed`
    };
  }
  return {
    wait: true,
    goShort: false,
    remaining,
    motive: `one late past ${window} and only ${remaining} left: wait`
  };
}

/**
 * 6.9 mixing: sometimes clock (the readable tell), sometimes event.
 * Injected rng is required.
 *
 * @param {{next: () => number}} rng
 * @returns {'clock'|'event'}
 */
export function mixAnchor(rng) {
  if (!rng || typeof rng.next !== 'function') {
    throw new Error('mixAnchor: rng is required (6.9 mixing is seeded, never Math.random)');
  }
  return rng.next() < MIX_CLOCK_P ? ANCHOR.CLOCK : ANCHOR.EVENT;
}
