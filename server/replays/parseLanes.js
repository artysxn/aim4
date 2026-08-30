// ---------------------------------------------------------------------------
// replays/parseLanes.js
// The parse queue's order: one lane per uploader, served round-robin.
//
// A single FIFO made one person's bulk drop everyone else's wait: a 20-demo
// zip parked every other account's single upload behind all twenty of them.
// Lanes fix the ORDER without touching the throughput — whoever has waited
// longest for a turn goes next, and a lane only competes for turns, not for
// a share proportional to how much it dropped. The 20-demo drop still parses
// all 20; it just stops being able to make a stranger wait for them.
//
// Deliberately knows nothing about jobs, workers, or what a demo is. jobs.js
// owns starting work and how much of it runs at once; this owns only who is
// next. That split is what makes the order testable without forking parsers.
// ---------------------------------------------------------------------------

/**
 * @template T
 * @returns {{
 *   push(key: string, item: T): void,
 *   requeue(key: string, item: T): void,
 *   next(): T|null,
 *   size(): number
 * }}
 */
export function createLanes() {
  /** @type {Map<string, T[]>} */
  const lanes = new Map();
  /** Rotation of lane keys that currently hold work, longest-waiting first. */
  const order = [];

  function laneFor(key) {
    const k = String(key || '');
    let lane = lanes.get(k);
    if (!lane) {
      lane = [];
      lanes.set(k, lane);
    }
    if (!lane.length && !order.includes(k)) order.push(k);
    return lane;
  }

  return {
    /** Append to the back of this uploader's lane. */
    push(key, item) {
      laneFor(key).push(item);
    },

    /**
     * Put an item at the FRONT of its lane and the lane at the front of the
     * rotation. For retries: the job already waited its turn once and was
     * running, so sending it to the back would charge it the whole queue
     * again for a failure that was the host's, not the demo's.
     */
    requeue(key, item) {
      const k = String(key || '');
      laneFor(k).unshift(item);
      const at = order.indexOf(k);
      if (at > 0) {
        order.splice(at, 1);
        order.unshift(k);
      }
    },

    /** The next item in fair order, or null when nothing is queued. */
    next() {
      while (order.length) {
        const key = order.shift();
        const lane = lanes.get(key);
        if (!lane || !lane.length) {
          // An emptied lane costs nothing to keep in the map; the rotation is
          // what has to stay honest.
          continue;
        }
        const item = lane.shift();
        // Back of the rotation only while it still holds work, so a drained
        // lane cannot buy a free turn by having been busy earlier.
        if (lane.length) order.push(key);
        return item;
      }
      return null;
    },

    /** How many items are queued across every lane. */
    size() {
      let n = 0;
      for (const lane of lanes.values()) n += lane.length;
      return n;
    }
  };
}
