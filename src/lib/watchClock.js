// ---------------------------------------------------------------------------
// lib/watchClock.js
// Time spent looking at a demo.
//
// Started when the Timeline or Analyzer opens and stopped when it closes, so
// what it counts is time with a demo actually on screen. Two things stop it
// besides closing: the tab going to the background, and the mouse and keyboard
// going quiet. Without those, "watch time" would really be "time the tab was
// left open", which is the number that makes every activity graph a lie.
//
// Accrues into per-day buckets locally first. Local is the source of truth for
// the running total because it has to work signed out and offline; the flush
// to the server is what makes the calendar public per account, and a failed
// flush costs nothing because the day is still on disk to send next time.
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import { dayKey } from './activityCalendar.js';

const STORAGE_KEY = 'demoWatch';
/** Quiet for this long and the clock parks until something happens again. */
export const IDLE_MS = 90 * 1000;
/** Days kept locally. Comfortably past the calendar's window. */
const KEEP_DAYS = 120;
/** How often the accrued time is written down and pushed. */
const TICK_MS = 15 * 1000;

/** A single accrual: seconds onto a day, capped so one bad clock cannot lie. */
export function accrue(days, atMs, seconds) {
  const key = dayKey(atMs);
  const s = Number(seconds);
  if (!key || !Number.isFinite(s) || s <= 0) return days;
  // A tick longer than a tick means the tab was throttled or the machine
  // slept. Count what a tick is worth, not the wall gap.
  const capped = Math.min(s, TICK_MS / 1000);
  days[key] = Math.round((Number(days[key]) || 0) + capped);
  return days;
}

/** Drop days past the keep window so this cannot grow without bound. */
export function prune(days, today = Date.now()) {
  const cutoff = dayKey(today - KEEP_DAYS * 24 * 60 * 60 * 1000);
  const out = {};
  for (const [key, value] of Object.entries(days || {})) {
    if (key >= cutoff) out[key] = value;
  }
  return out;
}

function load() {
  const raw = Storage.read(STORAGE_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** Every day's watch seconds, `YYYY-MM-DD` to seconds. */
export function watchDays() {
  return load();
}

/**
 * The clock.
 *
 * One instance per page. `start(label)` is idempotent for the same label, so
 * switching Timeline to Analyzer keeps one continuous session rather than
 * ending and restarting it.
 */
export function createWatchClock({ onFlush = null, now = () => Date.now() } = {}) {
  let active = null;
  let lastTick = 0;
  let lastInput = 0;
  let timer = null;
  let days = prune(load(), now());

  const idle = () => now() - lastInput > IDLE_MS;

  function persist() {
    days = prune(days, now());
    Storage.write(STORAGE_KEY, days);
  }

  /** Fold the time since the last tick into today, if it should count. */
  function settle() {
    if (!active) return;
    const t = now();
    const elapsed = (t - lastTick) / 1000;
    lastTick = t;
    if (elapsed <= 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (idle()) return;
    accrue(days, t, elapsed);
  }

  function tick() {
    settle();
    persist();
    onFlush?.(days);
  }

  function markInput() {
    // A first input after being idle restarts the clock from now, so the quiet
    // stretch is not paid out retroactively.
    if (idle()) lastTick = now();
    lastInput = now();
  }

  const listeners = [
    ['mousemove', markInput],
    ['mousedown', markInput],
    ['keydown', markInput],
    ['wheel', markInput],
    ['touchstart', markInput]
  ];

  function bind(on) {
    if (typeof window === 'undefined') return;
    for (const [type, fn] of listeners) {
      if (on) window.addEventListener(type, fn, { passive: true });
      else window.removeEventListener(type, fn);
    }
    const vis = () => {
      // Coming back from a background tab must not bank the time it spent
      // there, so settle first (which discards it) then restart the window.
      settle();
      lastTick = now();
    };
    if (on) document?.addEventListener?.('visibilitychange', vis);
    // The same handler identity is needed to remove it; kept on the closure.
    bind._vis = on ? vis : (document?.removeEventListener?.('visibilitychange', bind._vis), null);
  }

  return {
    /** Begin, or continue, counting. */
    start(label = 'viewer') {
      if (active === label) return;
      if (!active) {
        lastTick = now();
        lastInput = now();
        bind(true);
        timer = setInterval(tick, TICK_MS);
        if (timer?.unref) timer.unref();
      }
      active = label;
    },

    /** Stop, banking whatever the last partial tick earned. */
    stop() {
      if (!active) return;
      settle();
      persist();
      onFlush?.(days);
      active = null;
      bind(false);
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** Seconds accrued today so far. For tests and for a live readout. */
    todaySeconds() {
      return Number(days[dayKey(now())]) || 0;
    },

    days() {
      return { ...days };
    },

    get running() {
      return Boolean(active);
    }
  };
}
