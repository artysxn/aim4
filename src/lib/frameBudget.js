// ---------------------------------------------------------------------------
// lib/frameBudget.js
// Keep chrome interactive while data work runs.
//
// Long sync jobs on the main thread freeze the sidebar and open menus. These
// helpers force a paint (spinner) and yield before heavy work, and cancel
// superseded jobs when the user clicks again.
// ---------------------------------------------------------------------------

/** Wait until after the next paint so a spinner can show before a long task. */
export function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
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
