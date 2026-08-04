// ---------------------------------------------------------------------------
// src/site/admin/toolsPanel.js
// Site-wide maintenance actions (stats rebuild, …).
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, render } from './dom.js';

/** Fast enough to feel live, slow enough not to hammer a long rebuild. */
const POLL_MS = 1000;

export function toolsPanel() {
  const root = el('div', 'admin-panel');
  const status = el('p', 'admin-note', '');
  const progressWrap = el('div', 'ingest-progress');
  progressWrap.hidden = true;
  let running = false;
  let pollTimer = 0;
  /** @type {object | null} */
  let lastJob = null;

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function drawProgress(job) {
    lastJob = job;
    const active = Boolean(job?.running);
    running = active;
    runBtn.disabled = active;
    runBtn.textContent = active ? 'Recalculating…' : 'Recalculate all statistics';

    if (!job || (!job.running && !job.finished)) {
      progressWrap.hidden = true;
      progressWrap.replaceChildren();
      return;
    }

    progressWrap.hidden = false;
    progressWrap.replaceChildren();
    const bar = el('div', 'ingest-bar');
    const fill = el('div', 'ingest-bar-fill');
    fill.style.width = `${Math.min(100, Math.max(0, job.percent || 0))}%`;
    bar.appendChild(fill);
    progressWrap.appendChild(bar);

    const total = job.total || 0;
    const done = job.done || 0;
    const pct = job.percent || 0;
    progressWrap.appendChild(
      el(
        'div',
        'ingest-progress-meta',
        total
          ? `${done} of ${total} demos (${pct}%)`
          : active
            ? 'Starting…'
            : 'Done'
      )
    );

    if (job.current) {
      const line = el('div', 'ingest-current');
      line.appendChild(el('span', 'ingest-dim', 'Working on'));
      line.appendChild(el('strong', null, String(job.current)));
      progressWrap.appendChild(line);
    }

    if (job.running) {
      const secs = Math.max(0, Math.round((job.ms || 0) / 1000));
      status.className = 'admin-note';
      status.textContent = `Recalculating… ${secs}s elapsed. Safe to leave this page; progress stays on the server.`;
    }
  }

  function applyFinished(job) {
    drawProgress(job);
    const report = job?.report;
    if (job?.error) {
      status.className = 'admin-error';
      status.textContent = job.error;
      return;
    }
    if (!report) {
      status.className = 'admin-note';
      status.textContent = 'Recalculation finished.';
      return;
    }
    const failed = report.failed || 0;
    const parts = [
      `Done in ${Math.round((report.ms || job.ms || 0) / 1000)}s.`,
      `${report.ready || 0} ready demos.`,
      `${report.built || 0} rebuilt`,
      `${report.enriched || 0} enriched`,
      `${report.current || 0} already current`
    ];
    if (failed) parts.push(`${failed} failed`);
    status.className = failed ? 'admin-error' : 'admin-note';
    status.textContent = parts.join(' ');
    if (failed && report.errors?.length) {
      const sample = report.errors
        .slice(0, 5)
        .map((e) => `${e.filename || e.id}: ${e.error}`)
        .join(' · ');
      status.textContent += ` — ${sample}`;
    }
  }

  async function pollOnce() {
    try {
      const job = await adminApi.refreshStatsStatus();
      if (job.running) {
        drawProgress(job);
        return true;
      }
      if (job.finished && !job.stale) {
        stopPoll();
        applyFinished(job);
        running = false;
        runBtn.disabled = false;
        runBtn.textContent = 'Recalculate all statistics';
        return false;
      }
      stopPoll();
      drawProgress(null);
      return false;
    } catch (err) {
      stopPoll();
      status.className = 'admin-error';
      status.textContent = err.message || 'Could not read recalculation status.';
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = 'Recalculate all statistics';
      return false;
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => {
      pollOnce();
    }, POLL_MS);
  }

  const runBtn = button(
    'Recalculate all statistics',
    async () => {
      if (running) return;
      if (
        !window.confirm(
          'Rebuild statistics for every ready demo from parsed round data?\n\nThis can take several minutes on a large library.'
        )
      ) {
        return;
      }
      running = true;
      runBtn.disabled = true;
      runBtn.textContent = 'Recalculating…';
      status.className = 'admin-note';
      status.textContent = 'Starting recalculation…';
      try {
        let job;
        try {
          job = await adminApi.refreshStats({ force: true });
        } catch (err) {
          // Another admin (or a previous tab) already started it — attach to that run.
          if (err.status === 409) {
            job = await adminApi.refreshStatsStatus();
          } else {
            throw err;
          }
        }
        drawProgress(job);
        if (job.running) startPoll();
        else if (job.finished) applyFinished(job);
      } catch (err) {
        running = false;
        runBtn.disabled = false;
        runBtn.textContent = 'Recalculate all statistics';
        progressWrap.hidden = true;
        status.className = 'admin-error';
        status.textContent = err.message || 'Recalculation failed.';
      }
    },
    'btn primary'
  );

  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Replay statistics'));
  card.appendChild(
    el(
      'p',
      'admin-note',
      'Rebuild every demo’s compact stats index from already-parsed round files (rating inputs, PRW, possession, swing, duel PFW/PFO, and related fields). Use this after a stats schema change or if Database / Pattern Finder numbers look stale.'
    )
  );
  card.appendChild(runBtn);
  card.appendChild(progressWrap);
  card.appendChild(status);

  render(root, card);

  // If a rebuild is already running (other tab, prior click, deploy), show it
  // before anyone presses the button again.
  pollOnce().then((active) => {
    if (active) startPoll();
  });

  root._stopPolling = stopPoll;
  return root;
}
