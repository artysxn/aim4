// ---------------------------------------------------------------------------
// server/perf.js
// In-process performance counters, read by /api/admin/perf.
//
// This exists because "the site is lagging" is not a diagnosis, and the only
// honest way to answer it is to have the host say which of its own routes are
// slow and what it loaded off disk to serve them.
//
// Two things are measured, because backend slowness has two shapes:
//
//   ROUTES   how long each endpoint takes, as p50/p95/max rather than a mean.
//            A mean hides the shape that matters: one 4-second route in a
//            hundred fast ones is exactly what "sometimes it hangs" is.
//
//   BAKES    what the sim loaded off disk, how big it was and how long it
//            took to parse. A bake is read once and cached forever, so its
//            cost lands on ONE unlucky request and then disappears, which
//            makes it invisible to route averages and to anyone watching a
//            dashboard afterwards. It is exactly the kind of cost that a
//            deploy can quietly add: ship a bigger file into simdata/ and the
//            first request per map now parses tens of megabytes.
//
// Everything is bounded and in-memory. Nothing here is persisted, nothing
// here is a metric anyone should page on; it is a window on one process.
// ---------------------------------------------------------------------------

/** Samples kept per route. 200 is enough for a stable p95 and costs ~1.6 kB. */
const SAMPLES = 200;
/** Hard cap on tracked routes, so an attacker cannot grow this map with 404s. */
const MAX_ROUTES = 200;

const routes = new Map();
const bakes = new Map();
const startedAt = Date.now();
let requests = 0;
let slowest = null;

/**
 * Collapse a concrete path to a route shape.
 *
 * Without this, /api/replays/<uuid> is a thousand routes with one sample each
 * and the table is unreadable. Ids are anything that looks like a uuid, a
 * hex blob, a number, or a steam id.
 */
export function routeKey(method, pathname) {
  const parts = String(pathname || '/')
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      if (/^[0-9]+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return ':uuid';
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ':hash';
      if (/^7656[0-9]{13}$/.test(seg)) return ':steamid';
      return seg;
    });
  // Four segments is enough to tell /api/admin/users from /api/sim/models and
  // short enough that deep paths do not each become their own row.
  return `${method} /${parts.slice(0, 4).join('/')}`;
}

/**
 * Record one finished request.
 *
 * @param {string} method
 * @param {string} pathname
 * @param {number} ms
 * @param {number} status
 */
export function recordRequest(method, pathname, ms, status) {
  requests += 1;
  if (!slowest || ms > slowest.ms) slowest = { route: routeKey(method, pathname), ms, status, at: Date.now() };

  const key = routeKey(method, pathname);
  let r = routes.get(key);
  if (!r) {
    if (routes.size >= MAX_ROUTES) return;
    r = { key, n: 0, errors: 0, max: 0, samples: [], cursor: 0, lastAt: 0 };
    routes.set(key, r);
  }
  r.n += 1;
  r.lastAt = Date.now();
  if (status >= 500) r.errors += 1;
  if (ms > r.max) r.max = ms;
  if (r.samples.length < SAMPLES) r.samples.push(ms);
  else {
    r.samples[r.cursor] = ms;
    r.cursor = (r.cursor + 1) % SAMPLES;
  }
}

/**
 * Record a bake load: a file read off disk and parsed into memory.
 *
 * @param {object} info
 * @param {string} info.kind      'playbook' | 'knowledge' | 'model' | 'navcache' | ...
 * @param {string} info.map
 * @param {number} info.bytes     size on disk
 * @param {number} info.parseMs   read + parse, the number that stalls the loop
 * @param {string} info.source    'local' | 'shipped'
 * @param {number} [info.entries]
 */
export function recordBake({ kind, map, bytes, parseMs, source, entries }) {
  bakes.set(`${kind}:${map}`, {
    kind,
    map,
    bytes: Math.round(bytes || 0),
    parseMs: Math.round(parseMs || 0),
    source: source || 'unknown',
    entries: entries ?? null,
    at: Date.now()
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Everything the admin panel draws. */
export function snapshot() {
  const mem = process.memoryUsage();
  const rows = [];
  for (const r of routes.values()) {
    const sorted = [...r.samples].sort((a, b) => a - b);
    rows.push({
      route: r.key,
      n: r.n,
      errors: r.errors,
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      max: Math.round(r.max),
      lastAt: r.lastAt
    });
  }
  // Worst first: p95 is what a user calls "the site is lagging", not the mean.
  rows.sort((a, b) => b.p95 - a.p95 || b.n - a.n);

  const bakeRows = [...bakes.values()].sort((a, b) => b.parseMs - a.parseMs);
  const bakeBytes = bakeRows.reduce((sum, b) => sum + b.bytes, 0);
  const bakeMs = bakeRows.reduce((sum, b) => sum + b.parseMs, 0);

  return {
    process: {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      requests,
      rssMB: Math.round(mem.rss / 1e6),
      heapUsedMB: Math.round(mem.heapUsed / 1e6),
      heapTotalMB: Math.round(mem.heapTotal / 1e6),
      externalMB: Math.round(mem.external / 1e6),
      node: process.version,
      pid: process.pid,
      commit:
        process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.RENDER_GIT_COMMIT ||
        process.env.GIT_COMMIT ||
        null
    },
    slowest,
    routes: rows,
    bakes: bakeRows,
    bakeTotals: { count: bakeRows.length, bytes: bakeBytes, parseMs: bakeMs }
  };
}

/** Drop everything. Used by the panel's reset, so a fix can be seen working. */
export function resetPerf() {
  routes.clear();
  bakes.clear();
  requests = 0;
  slowest = null;
}
