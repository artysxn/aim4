// ---------------------------------------------------------------------------
// lib/frameBudget.js
// Keep chrome interactive while data work runs.
//
// Long sync jobs on the main thread freeze the sidebar and open menus. These
// helpers force a paint (spinner) and yield before heavy work, and cancel
// superseded jobs when the user clicks again.
// ---------------------------------------------------------------------------

/**
 * How long to wait for the two frames before giving up and continuing anyway.
 * Long enough that a genuinely slow frame still gets to paint the spinner,
 * short enough that nobody reads it as a hang.
 */
const PAINT_TIMEOUT_MS = 250;

/**
 * Wait until after the next paint so a spinner can show before a long task.
 *
 * Never waits on frames that are not coming. A browser stops running rAF
 * callbacks while the page is hidden — backgrounded tab, minimised window, or
 * simply covered by another window, which Chrome also reports as hidden — so an
 * `await yieldToPaint()` in the middle of a pipeline used to stop that pipeline
 * for as long as the page stayed off screen. That is what made the Demo
 * Manager's Load more look dead: the list was replaced by "Updating…", the work
 * behind it never resumed, and only re-focusing the tab brought it back.
 *
 * Two guards: skip the frames outright when the page is already hidden, and
 * time the wait out for the case that matters more — the page was visible when
 * the frames were requested and went away before they ran.
 */
export function yieldToPaint() {
  return new Promise((resolve) => {
    if (typeof document !== 'undefined' && document.hidden) {
      setTimeout(resolve, 0);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, PAINT_TIMEOUT_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  });
}

/** Yield to the event loop (input + timers) without waiting a full frame. */
export function yieldToEventLoop() {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
      return;
    }
    setTimeout(resolve, 0);
  });
}

/**
 * Run `work` after a paint, with a generation token so a newer schedule cancels
 * the older one mid-flight.
 *
 * @template T
 * @param {{
 *   tokenRef: { current: number },
 *   beforeYield?: () => void,
 *   work: (token: number) => T | Promise<T>,
 *   isCurrent?: (token: number) => boolean
 * }} opts
 * @returns {Promise<T|undefined>}
 */
export async function scheduleUiJob(opts) {
  const token = (opts.tokenRef.current = (opts.tokenRef.current || 0) + 1);
  const still = () =>
    typeof opts.isCurrent === 'function'
      ? opts.isCurrent(token)
      : opts.tokenRef.current === token;
  try {
    opts.beforeYield?.();
  } catch {
    /* host may already be gone */
  }
  await yieldToPaint();
  if (!still()) return undefined;
  await yieldToEventLoop();
  if (!still()) return undefined;
  return opts.work(token);
}

/**
 * Slice a long loop across frames. `step(i)` runs index i; stop when it returns
 * false or when `isCurrent` fails.
 *
 * @param {{
 *   length: number,
 *   step: (i: number) => boolean | void,
 *   budgetMs?: number,
 *   isCurrent?: () => boolean
 * }} opts
 */
export async function forEachChunked(opts) {
  const budget = Math.max(2, Number(opts.budgetMs) || 5);
  const still = typeof opts.isCurrent === 'function' ? opts.isCurrent : () => true;
  let i = 0;
  while (i < opts.length) {
    if (!still()) return false;
    const start = performance.now();
    while (i < opts.length && performance.now() - start < budget) {
      if (opts.step(i) === false) return false;
      i += 1;
    }
    if (i < opts.length) {
      await yieldToPaint();
      if (!still()) return false;
    }
  }
  return true;
}
