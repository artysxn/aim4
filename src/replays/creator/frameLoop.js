// ---------------------------------------------------------------------------
// replays/creator/frameLoop.js
// A frame driver that keeps running when requestAnimationFrame does not.
//
// rAF is the right clock while the page is on screen: it matches the display
// and never runs ahead of what is drawn. But it stops dead in an occluded or
// backgrounded view, and a recording tool that silently freezes mid-pass is
// worse than one that keeps a steady clock. So: start on rAF, and if no frame
// arrives within STALL_MS, fall back to a timer until frames come back.
// ---------------------------------------------------------------------------

/** No rAF callback within this long means something is throttling it. */
const STALL_MS = 250;
/** Fallback cadence, close enough to 60 Hz for a 16 Hz sample rate. */
const FALLBACK_MS = 1000 / 60;

/**
 * @param {(now: number) => void} onFrame  called with a high-resolution time
 * @returns {{start: () => void, stop: () => void, running: () => boolean, usingFallback: () => boolean}}
 */
export function createFrameLoop(onFrame) {
  let raf = 0;
  let timer = 0;
  let watchdog = 0;
  let running = false;
  let fallback = false;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function fire(t) {
    onFrame(t);
  }

  function rafStep(t) {
    if (!running) return;
    // A frame arrived, so rAF is alive: drop the fallback if it was on.
    if (fallback) {
      fallback = false;
      clearInterval(timer);
      timer = 0;
    }
    armWatchdog();
    raf = requestAnimationFrame(rafStep);
    fire(t);
  }

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (!running || fallback) return;
      fallback = true;
      timer = setInterval(() => {
        if (!running) return;
        fire(now());
      }, FALLBACK_MS);
    }, STALL_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      fallback = false;
      raf = requestAnimationFrame(rafStep);
      armWatchdog();
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(watchdog);
      clearInterval(timer);
      raf = 0;
      timer = 0;
      watchdog = 0;
      fallback = false;
    },
    running: () => running,
    usingFallback: () => fallback
  };
}
