// ---------------------------------------------------------------------------
// src/site/admin/toolsPanel.js
// Site-wide maintenance actions (stats rebuild, positions/roles scan, …).
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
  /** @type {'stats'|'positions'|null} */
  let activeKind = null;
  let pollTimer = 0;

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function setButtonsBusy(busy) {
    running = busy;
    runBtn.disabled = busy;
    posBtn.disabled = busy;
    if (!busy) {
      runBtn.textContent = 'Recalculate all statistics';
      posBtn.textContent = 'Reload positions';
      activeKind = null;
    }
  }

  function drawProgress(job, kind) {
    const active = Boolean(job?.running);
    if (active) {
      activeKind = kind;
      running = true;
      runBtn.disabled = true;
      posBtn.disabled = true;
      if (kind === 'positions') {
        posBtn.textContent = 'Scanning positions…';
        runBtn.textContent = 'Recalculate all statistics';
      } else {
        runBtn.textContent = 'Recalculating…';
        posBtn.textContent = 'Reload positions';
      }
    }

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
      status.textContent =
        kind === 'positions'
          ? `Scanning player positions… ${secs}s elapsed. Safe to leave this page.`
          : `Recalculating… ${secs}s elapsed. Safe to leave this page; progress stays on the server.`;
    }
  }

  function applyFinished(job, kind) {
    drawProgress(job, kind);
    const report = job?.report;
    if (job?.error) {
      status.className = 'admin-error';
      status.textContent = job.error;
      return;
    }
    if (!report) {
      status.className = 'admin-note';
      status.textContent = kind === 'positions' ? 'Positions scan finished.' : 'Recalculation finished.';
      return;
    }
    const failed = report.failed || 0;
    let parts;
    if (kind === 'positions') {
      parts = [
        `Done in ${Math.round((report.ms || job.ms || 0) / 1000)}s.`,
        `${report.ready || 0} ready demos.`,
        `${report.updated || 0} roles updated`,
        `${report.skipped || 0} skipped`
      ];
    } else {
      parts = [
        `Done in ${Math.round((report.ms || job.ms || 0) / 1000)}s.`,
        `${report.ready || 0} ready demos.`,
        `${report.built || 0} rebuilt`,
        `${report.enriched || 0} enriched`,
        `${report.current || 0} already current`
      ];
    }
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
      const [statsJob, posJob] = await Promise.all([
        adminApi.refreshStatsStatus(),
        adminApi.refreshPositionsStatus()
      ]);
      if (statsJob.running) {
        drawProgress(statsJob, 'stats');
        return true;
      }
      if (posJob.running) {
        drawProgress(posJob, 'positions');
        return true;
      }
      if (activeKind === 'stats' && statsJob.finished && !statsJob.stale) {
        stopPoll();
        applyFinished(statsJob, 'stats');
        setButtonsBusy(false);
        return false;
      }
      if (activeKind === 'positions' && posJob.finished && !posJob.stale) {
        stopPoll();
        applyFinished(posJob, 'positions');
        setButtonsBusy(false);
        return false;
      }
      // Attach to a finished job that another tab just completed.
      if (!activeKind && statsJob.finished && !statsJob.stale && statsJob.report) {
        applyFinished(statsJob, 'stats');
      } else if (!activeKind && posJob.finished && !posJob.stale && posJob.report) {
        applyFinished(posJob, 'positions');
      }
      stopPoll();
      if (!running) drawProgress(null, null);
      return false;
    } catch (err) {
      stopPoll();
      status.className = 'admin-error';
      status.textContent = err.message || 'Could not read recalculation status.';
      setButtonsBusy(false);
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
      setButtonsBusy(true);
      activeKind = 'stats';
      runBtn.textContent = 'Recalculating…';
      status.className = 'admin-note';
      status.textContent = 'Starting recalculation…';
      try {
        let job;
        try {
          job = await adminApi.refreshStats({ force: true });
        } catch (err) {
          if (err.status === 409) {
            job = await adminApi.refreshStatsStatus();
            if (!job.running) job = await adminApi.refreshPositionsStatus();
          } else {
            throw err;
          }
        }
        const kind = job.kind === 'positions' ? 'positions' : 'stats';
        activeKind = kind;
        drawProgress(job, kind);
        if (job.running) startPoll();
        else if (job.finished) {
          applyFinished(job, kind);
          setButtonsBusy(false);
        }
      } catch (err) {
        setButtonsBusy(false);
        progressWrap.hidden = true;
        status.className = 'admin-error';
        status.textContent = err.message || 'Recalculation failed.';
      }
    },
    'btn primary'
  );

  const posBtn = button(
    'Reload positions',
    async () => {
      if (running) return;
      if (
        !window.confirm(
          'Rescan player positions on every ready demo from 3D tick data and rebuild roles only?\n\nDoes not recalculate kills, PRW, possession, or other stats. Can take a while on a large library.'
        )
      ) {
        return;
      }
      setButtonsBusy(true);
      activeKind = 'positions';
      posBtn.textContent = 'Scanning positions…';
      status.className = 'admin-note';
      status.textContent = 'Starting positions scan…';
      try {
        let job;
        try {
          job = await adminApi.refreshPositions();
        } catch (err) {
          if (err.status === 409) {
            job = await adminApi.refreshPositionsStatus();
            if (!job.running) job = await adminApi.refreshStatsStatus();
          } else {
            throw err;
          }
        }
        const kind = job.kind === 'stats' ? 'stats' : 'positions';
        activeKind = kind;
        drawProgress(job, kind);
        if (job.running) startPoll();
        else if (job.finished) {
          applyFinished(job, kind);
          setButtonsBusy(false);
        }
      } catch (err) {
        setButtonsBusy(false);
        progressWrap.hidden = true;
        status.className = 'admin-error';
        status.textContent = err.message || 'Positions scan failed.';
      }
    },
    'btn'
  );

  const actions = el('div', 'admin-inline');
  actions.appendChild(runBtn);
  actions.appendChild(posBtn);

  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Replay statistics'));
  card.appendChild(
    el(
      'p',
      'admin-note',
      'Rebuild every demo’s compact stats index from already-parsed round files (rating inputs, PRW, possession, swing, duel PFW/PFO, and related fields). Use this after a stats schema change or if Database / Pattern Finder numbers look stale.'
    )
  );
  card.appendChild(
    el(
      'p',
      'admin-note',
      'Reload positions walks 3D tick tracks only, to reassign map roles from where players stood. It does not rebuild the rest of the stats index.'
    )
  );
  card.appendChild(actions);
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
