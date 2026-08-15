// ---------------------------------------------------------------------------
// src/site/admin/perfPanel.js
// What the host is spending its time on.
//
// Built to answer one question quickly: the site feels slow, is that the
// server, and if so which part. So it leads with the two things that actually
// explain backend lag and puts them above the fold:
//
//   BAKES   files the sim read off disk and parsed. Each one is read once and
//           cached, so its cost lands on a single request and then vanishes.
//           A deploy that ships a bigger file into simdata/ shows up here and
//           nowhere else.
//   ROUTES  p50 / p95 / max per endpoint, worst p95 first. A mean would hide
//           the shape people actually notice, which is the occasional hang.
//
// Polls while the tab is open, stops when it is not.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, render, row, table } from './dom.js';
import { spinnerNode } from '../../lib/spinner.js';

const POLL_MS = 5000;
/** Above this, a single bake parse is worth a second look rather than a shrug. */
const SLOW_BAKE_MS = 250;
/** Above this, a route is slow enough that a person notices it. */
const SLOW_ROUTE_MS = 500;

function mb(bytes) {
  if (!bytes) return '0';
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} kB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function ms(value) {
  if (value == null) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function ago(at) {
  if (!at) return '';
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function stat(label, value, warn = false) {
  const node = el('div', `perf-stat${warn ? ' warn' : ''}`);
  node.appendChild(el('div', 'perf-stat-value', value));
  node.appendChild(el('div', 'perf-stat-label', label));
  return node;
}

export function perfPanel() {
  const root = el('div', 'admin-panel');
  const controls = el('div', 'admin-controls');
  const results = el('div', 'admin-results');

  let timer = null;
  let stopped = false;

  function draw(data) {
    const wrap = el('div', 'perf-wrap');
    const p = data.process || {};
    const totals = data.bakeTotals || {};

    const strip = el('div', 'perf-strip');
    strip.append(
      stat('Uptime', `${Math.floor((p.uptimeSeconds || 0) / 3600)}h ${Math.floor(((p.uptimeSeconds || 0) % 3600) / 60)}m`),
      stat('Requests', (p.requests || 0).toLocaleString()),
      stat('Heap', `${p.heapUsedMB || 0} / ${p.heapTotalMB || 0} MB`),
      stat('RSS', `${p.rssMB || 0} MB`, (p.rssMB || 0) > 1500),
      stat('Bakes loaded', `${totals.count || 0}`),
      stat('Bake bytes', mb(totals.bytes), (totals.bytes || 0) > 100e6),
      stat('Bake parse', ms(totals.parseMs), (totals.parseMs || 0) > 2000)
    );
    wrap.appendChild(strip);

    if (data.slowest) {
      const s = data.slowest;
      wrap.appendChild(
        el(
          'p',
          `perf-note${s.ms > SLOW_ROUTE_MS ? ' warn' : ''}`,
          `Slowest single request since reset: ${s.route} took ${ms(s.ms)} (${s.status}), ${ago(s.at)}`
        )
      );
    }

    // Bakes first. This is the table that shows a deploy having shipped
    // something expensive, which route timings alone will not tell you.
    wrap.appendChild(el('h3', 'perf-heading', 'Disk bakes'));
    const bakes = data.bakes || [];
    if (!bakes.length) {
      wrap.appendChild(el('p', 'empty', 'Nothing loaded off disk yet on this host.'));
    } else {
      wrap.appendChild(
        table(
          ['Kind', 'Map', 'Source', 'Size', 'Parse', 'Entries', 'Loaded'],
          bakes.map((b) => {
            const parse = el('span', b.parseMs > SLOW_BAKE_MS ? 'perf-bad' : null, ms(b.parseMs));
            const src = el('span', b.source === 'shipped' ? 'perf-shipped' : null, b.source);
            return [b.kind, b.map, src, mb(b.bytes), parse, b.entries ?? '', ago(b.at)];
          })
        )
      );
    }

    wrap.appendChild(el('h3', 'perf-heading', 'Routes by p95'));
    const routes = data.routes || [];
    if (!routes.length) {
      wrap.appendChild(el('p', 'empty', 'No requests recorded yet.'));
    } else {
      wrap.appendChild(
        table(
          ['Route', 'Calls', 'p50', 'p95', 'Max', '5xx', 'Last'],
          routes.map((r) => {
            const p95 = el('span', r.p95 > SLOW_ROUTE_MS ? 'perf-bad' : null, ms(r.p95));
            const errs = el('span', r.errors ? 'perf-bad' : null, r.errors || '');
            return [r.route, r.n.toLocaleString(), ms(r.p50), p95, ms(r.max), errs, ago(r.lastAt)];
          })
        )
      );
    }

    if (p.commit) wrap.appendChild(el('p', 'perf-note dim', `Commit ${String(p.commit).slice(0, 12)} on node ${p.node}`));

    render(results, wrap);
  }

  async function load() {
    if (stopped) return;
    try {
      draw(await adminApi.perf());
    } catch (err) {
      render(results, el('p', 'admin-error', err.message));
    }
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await load();
      if (!stopped) poll();
    }, POLL_MS);
  }

  const refresh = button('Refresh', () => load());
  const reset = button('Reset counters', async () => {
    reset.disabled = true;
    try {
      await adminApi.resetPerf();
      await load();
    } finally {
      reset.disabled = false;
    }
  });
  controls.append(row(refresh, reset));

  root.append(controls, results);
  render(results, spinnerNode());
  load().then(poll);

  // adminView calls this when the tab is left, so the panel stops polling a
  // page nobody is looking at.
  root._stopPolling = () => {
    stopped = true;
    clearTimeout(timer);
  };

  return root;
}
