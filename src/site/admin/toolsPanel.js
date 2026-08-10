// ---------------------------------------------------------------------------
// src/site/admin/toolsPanel.js
// Site-wide maintenance actions (stats rebuild, positions/roles scan, round
// library rescan, Steam-id player-name merge, …).
//
// Every action is the same shape: POST to start, GET to poll, one at a time
// across the whole library. They are kept in one table rather than three
// copies of the same handler, because the only things that actually differ are
// the wording and how the finished report reads.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, render } from './dom.js';

/** Fast enough to feel live, slow enough not to hammer a long rebuild. */
const POLL_MS = 1000;

/**
 * @typedef {object} ToolJob
 * @property {string} kind    matches the `kind` the server stamps on the job
 * @property {string} idle    button label at rest
 * @property {string} busy    button label while it runs
 * @property {string} confirm the window.confirm text
 * @property {string} running the status line while it runs
 * @property {string} starting the status line between the click and the first poll
 * @property {string} done    the status line when there is no report
 * @property {() => Promise<object>} start
 * @property {() => Promise<object>} status
 * @property {(report: object, ms: number) => string[]} summary
 */

/** @type {ToolJob[]} */
const JOBS = [
  {
    kind: 'stats',
    idle: 'Recalculate all statistics',
    busy: 'Recalculating…',
    className: 'btn primary',
    confirm:
      'Rebuild statistics for every ready demo from parsed round data?\n\nThis can take several minutes on a large library.',
    running: 'Recalculating…',
    starting: 'Starting recalculation…',
    done: 'Recalculation finished.',
    start: () => adminApi.refreshStats({ force: true }),
    status: () => adminApi.refreshStatsStatus(),
    summary: (r, ms) => [
      `Done in ${Math.round(ms / 1000)}s.`,
      `${r.ready || 0} ready demos.`,
      `${r.built || 0} rebuilt`,
      `${r.enriched || 0} enriched`,
      `${r.current || 0} already current`
    ]
  },
  {
    kind: 'positions',
    idle: 'Reload positions',
    busy: 'Scanning positions…',
    className: 'btn',
    confirm:
      'Rescan player positions on every ready demo from 3D tick data and rebuild roles only?\n\nDoes not recalculate kills, PRW, possession, or other stats. Can take a while on a large library.',
    running: 'Scanning player positions…',
    starting: 'Starting positions scan…',
    done: 'Positions scan finished.',
    start: () => adminApi.refreshPositions(),
    status: () => adminApi.refreshPositionsStatus(),
    summary: (r, ms) => [
      `Done in ${Math.round(ms / 1000)}s.`,
      `${r.ready || 0} ready demos.`,
      `${r.updated || 0} roles updated`,
      `${r.skipped || 0} skipped`
    ]
  },
  {
    kind: 'ratings',
    idle: 'Recalculate ratings',
    busy: 'Recalculating ratings…',
    className: 'btn',
    confirm:
      'Re-derive Rating 3.0 for every ready demo and refresh the rating shown on each demo card?\n\nReads the statistics already on disk, so it is much quicker than a full recalculation. Does not touch kills, PRW, possession or round tags.',
    running: 'Recalculating ratings…',
    starting: 'Starting rating recalculation…',
    done: 'Rating recalculation finished.',
    start: () => adminApi.refreshRatings(),
    status: () => adminApi.refreshRatingsStatus(),
    summary: (r, ms) => [
      `Done in ${Math.round(ms / 1000)}s.`,
      `${r.rated || 0} of ${r.ready || 0} demos rated.`,
      `${r.topPlayers || 0} card ratings updated`,
      `${r.enriched || 0} indexes filled in`,
      `${r.skipped || 0} skipped`
    ]
  },
  {
    kind: 'rounds',
    idle: 'Rescan round types',
    busy: 'Rescanning rounds…',
    className: 'btn',
    confirm:
      'Rewatch every round of every ready demo and re-tag it against the round library?\n\nStored tags are dropped first, so this picks up edited definitions, newly painted zones and newly named utility spots. Does not touch kills, PRW or possession.',
    running: 'Rewatching rounds…',
    starting: 'Starting round scan…',
    done: 'Round scan finished.',
    start: () => adminApi.rescanRounds(),
    status: () => adminApi.rescanRoundsStatus(),
    summary: (r, ms) => {
      const parts = [
        `Done in ${Math.round(ms / 1000)}s.`,
        `${r.scanned || 0} of ${r.ready || 0} demos on library maps.`,
        `${r.tagged || 0} of ${r.rounds || 0} rounds matched a named type`
      ];
      // Per map, because a map with zero matches is the whole finding: it
      // means the ground or the utility spots are not named yet.
      const maps = Object.entries(r.maps || {}).sort((a, b) => b[1] - a[1]);
      if (maps.length) parts.push(`(${maps.map(([m, n]) => `${m} ${n}`).join(', ')})`);
      return parts;
    }
  },
  {
    kind: 'player-names',
    idle: 'Rescan player names',
    busy: 'Rescanning names…',
    className: 'btn',
    confirm:
      'Merge every player by Steam ID and set their display name to the one they used most often?\n\nRewrites demo/round rosters, then rebuilds statistics. Aquwo/aRTYSAN-style aliases collapse to the majority name.',
    running: 'Merging player names by Steam ID…',
    starting: 'Starting player-name rescan…',
    done: 'Player-name rescan finished.',
    start: () => adminApi.rescanPlayerNames(),
    status: () => adminApi.rescanPlayerNamesStatus(),
    summary: (r, ms) => {
      const parts = [
        `Done in ${Math.round(ms / 1000)}s.`,
        `${r.steamIds || 0} Steam IDs across ${r.ready || 0} demos.`,
        `${r.withAliases || 0} had multiple names`,
        `${r.demosUpdated || 0} demos / ${r.roundsUpdated || 0} rounds rewritten`
      ];
      const sample = (r.renames || [])
        .slice(0, 5)
        .map((x) => {
          const alts = (x.aliases || []).map((a) => `${a.name}×${a.count}`).join(', ');
          return `${x.name}←${alts || '?'}`;
        });
      if (sample.length) parts.push(`(${sample.join('; ')})`);
      return parts;
    }
  }
];

const jobFor = (kind) => JOBS.find((j) => j.kind === kind) || JOBS[0];

export function toolsPanel() {
  const root = el('div', 'admin-panel');
  const status = el('p', 'admin-note', '');
  const progressWrap = el('div', 'ingest-progress');
  progressWrap.hidden = true;
  let running = false;
  /** @type {string|null} */
  let activeKind = null;
  let pollTimer = 0;

  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function setButtonsBusy(busy, kind = null) {
    running = busy;
    for (const job of JOBS) {
      const btn = buttons.get(job.kind);
      btn.disabled = busy;
      btn.textContent = busy && job.kind === kind ? job.busy : job.idle;
    }
    if (!busy) activeKind = null;
  }

  function drawProgress(job, kind) {
    const active = Boolean(job?.running);
    if (active) {
      activeKind = kind;
      setButtonsBusy(true, kind);
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
        total ? `${done} of ${total} demos (${pct}%)` : active ? 'Starting…' : 'Done'
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
      status.textContent = `${jobFor(kind).running} ${secs}s elapsed. Safe to leave this page; progress stays on the server.`;
    }
  }

  function applyFinished(job, kind) {
    const spec = jobFor(kind);
    drawProgress(job, kind);
    const report = job?.report;
    if (job?.error) {
      status.className = 'admin-error';
      status.textContent = job.error;
      return;
    }
    if (!report) {
      status.className = 'admin-note';
      status.textContent = spec.done;
      return;
    }
    const failed = report.failed || 0;
    const parts = spec.summary(report, report.ms || job.ms || 0);
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

  /**
   * Status for every job, tolerating ones the backend does not serve.
   *
   * A single missing route must not blank the panel: these are independent
   * jobs, and a backend that predates one of them still has to report the
   * other two. An unreachable job reads as idle and its own button surfaces
   * the real error when someone presses it.
   */
  async function allStatuses() {
    const settled = await Promise.allSettled(JOBS.map((j) => j.status()));
    if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
    return settled.map((r) => (r.status === 'fulfilled' ? r.value : { running: false }));
  }

  async function pollOnce() {
    try {
      const states = await allStatuses();
      const live = states.findIndex((s) => s.running);
      if (live !== -1) {
        drawProgress(states[live], JOBS[live].kind);
        return true;
      }
      const mine = JOBS.findIndex((j) => j.kind === activeKind);
      if (mine !== -1 && states[mine].finished && !states[mine].stale) {
        stopPoll();
        applyFinished(states[mine], activeKind);
        setButtonsBusy(false);
        return false;
      }
      // Attach to a finished job that another tab just completed.
      if (!activeKind) {
        const recent = states.findIndex((s) => s.finished && !s.stale && s.report);
        if (recent !== -1) applyFinished(states[recent], JOBS[recent].kind);
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

  async function run(spec) {
    if (running) return;
    if (!window.confirm(spec.confirm)) return;
    setButtonsBusy(true, spec.kind);
    activeKind = spec.kind;
    status.className = 'admin-note';
    status.textContent = spec.starting;
    try {
      let job;
      try {
        job = await spec.start();
      } catch (err) {
        // 409: somebody else's job holds the library. Show theirs, not ours.
        if (err.status !== 409) throw err;
        const states = await allStatuses();
        const live = states.findIndex((s) => s.running);
        job = live === -1 ? states[0] : states[live];
      }
      const kind = JOBS.some((j) => j.kind === job.kind) ? job.kind : spec.kind;
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
      status.textContent = err.message || `${spec.idle} failed.`;
    }
  }

  const actions = el('div', 'admin-inline');
  for (const spec of JOBS) {
    const btn = button(spec.idle, () => run(spec), spec.className);
    buttons.set(spec.kind, btn);
    actions.appendChild(btn);
  }

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
  card.appendChild(
    el(
      'p',
      'admin-note',
      'Rescan round types rewatches every round against the round library and rewrites its tags. Run it after editing a round definition, painting a map, or naming a utility spot.'
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
