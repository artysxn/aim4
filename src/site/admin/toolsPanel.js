// ---------------------------------------------------------------------------
// src/site/admin/toolsPanel.js
// Site-wide maintenance actions (selective field patch, full stats rebuild,
// positions/roles scan, round library rescan, Steam-id player-name merge, …).
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

/** Fallback labels if GET /refresh-fields has not answered yet. */
const DEFAULT_FIELD_GROUPS = [
  { id: 'damage', label: 'Damage' },
  { id: 'awpAcc', label: 'AWP Acc' },
  { id: 'aim', label: 'Aim' },
  { id: 'utility', label: 'Utility' },
  { id: 'phase', label: 'Phase' },
  { id: 'prw', label: 'PRW' },
  { id: 'timing', label: 'Timing' },
  { id: 'possession', label: 'Possession' },
  { id: 'duels', label: 'Duels' },
  { id: 'core', label: 'Core openings' },
  { id: 'movement', label: 'Movement' },
  { id: 'awpHold', label: 'AWP hold' },
  { id: 'roles', label: 'Roles' }
];

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

/**
 * @param {() => string[]} selectedFields
 * @returns {ToolJob[]}
 */
function buildJobs(selectedFields) {
  return [
    {
      kind: 'fields',
      idle: 'Patch selected fields',
      busy: 'Patching fields…',
      className: 'btn primary',
      confirm: '',
      running: 'Patching selected fields…',
      starting: 'Starting field patch…',
      done: 'Field patch finished.',
      start: () => adminApi.refreshFields(selectedFields()),
      status: () => adminApi.refreshFieldsStatus(),
      summary: (r, ms) => [
        `Done in ${Math.round(ms / 1000)}s.`,
        `${r.ready || 0} ready demos.`,
        `${r.updated || 0} patched`,
        `${r.built || 0} built`,
        `${r.skipped || 0} skipped`,
        (r.fields || []).length ? `(${(r.fields || []).join(', ')})` : ''
      ].filter(Boolean)
    },
    {
      kind: 'stats-stale',
      idle: 'Enrich stale statistics',
      busy: 'Enriching…',
      className: 'btn',
      confirm:
        'Backfill missing statistics columns on every stale or unindexed demo?\n\nDemos already current are skipped, so this is much cheaper than a full recalculation. Run it after a release adds a column: library pages serve the old columns until it has.',
      running: 'Enriching stale demos…',
      starting: 'Starting enrichment…',
      done: 'Enrichment finished.',
      start: () => adminApi.refreshStats({ force: false }),
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
      kind: 'stats',
      idle: 'Recalculate all statistics',
      busy: 'Recalculating…',
      className: 'btn',
      confirm:
        'Rebuild every field on every ready demo from parsed round data?\n\nPrefer Patch selected fields when only one statistic changed. A full rebuild can take a long time on a large library.',
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
}

/**
 * The pistol-round repair: trims knife rounds glued into round 1 and
 * renumbers demos whose pistol round is missing. Safe to run repeatedly —
 * checked demos are remembered and skipped.
 */
function pistolFixCard() {
  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Pistol rounds'));
  card.appendChild(
    el(
      'p',
      'admin-muted',
      'Repairs stored demos: cuts knife rounds out of round 1, and renumbers demos whose pistol round was missing so second rounds stop counting as pistols. New parses fix themselves.'
    )
  );
  const status = el('div', 'admin-tool-status');
  const runBtn = button('Fix pistol rounds', () => start(false), 'btn btn-primary btn-sm');
  const forceBtn = button('Re-check everything', () => start(true), 'btn btn-sm');
  const row = el('div', 'admin-inline');
  row.append(runBtn, forceBtn);
  card.append(row, status);

  let timer = 0;

  function paint(st) {
    if (!st) return;
    runBtn.disabled = st.running;
    forceBtn.disabled = st.running;
    if (st.running) {
      status.textContent = `Checking ${st.progress.done} / ${st.progress.total}…`;
    } else if (st.result) {
      const r = st.result;
      status.textContent =
        `Scanned ${r.scanned}. Knife rounds trimmed: ${r.knifeTrimmed}. ` +
        `Missing pistols flagged: ${r.missingPistol}. Reindexed: ${r.reindexed}.` +
        (r.failed ? ` Failed: ${r.failed}.` : '');
    } else if (st.error) {
      status.textContent = `Failed: ${st.error}`;
    } else {
      status.textContent = '';
    }
  }

  async function poll() {
    try {
      const st = await adminApi.pistolFixStatus();
      paint(st);
      if (st.running) {
        timer = window.setTimeout(poll, 1500);
      }
    } catch {
      /* quiet */
    }
  }

  async function start(force) {
    runBtn.disabled = true;
    forceBtn.disabled = true;
    try {
      paint(await adminApi.pistolFixStart(force));
      timer = window.setTimeout(poll, 1200);
    } catch (err) {
      status.textContent = err.message;
      runBtn.disabled = false;
      forceBtn.disabled = false;
    }
  }

  void poll();
  card.addEventListener('admin:panel-hidden', () => window.clearTimeout(timer));
  return card;
}

/**
 * The aim rescan.
 *
 * Its own card rather than a row in the JOBS table above, because it is the
 * one tool here that is not exclusive: it re-opens each parsed demo, measures
 * the motion half of the Aim rating, and does it in the background beside live
 * traffic for as long as the library takes. Putting it in that table would
 * disable every other button on this page for hours.
 */
function aimRescanCard() {
  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Aim rating'));
  card.appendChild(
    el(
      'p',
      'admin-muted',
      'Re-opens each parsed demo and measures the flick, tracking, reaction and tension statistics behind the v2 Aim rating. Runs in the background, one demo at a time, and pauses while any other tool on this page is running. Demos already measured are skipped. Opening a player’s Aim tab in Performance moves their demos to the front of the queue.'
    )
  );
  const status = el('div', 'admin-tool-status');
  const detail = el('div', 'admin-tool-status');
  const runBtn = button('Rescan aim rating', () => start(false), 'btn btn-primary btn-sm');
  const forceBtn = button('Re-measure everything', () => start(true), 'btn btn-sm');
  const stopBtn = button('Stop', () => stop(), 'btn btn-sm');
  const row = el('div', 'admin-inline');
  row.append(runBtn, forceBtn, stopBtn);
  card.append(row, status, detail);

  let timer = 0;

  function paint(st) {
    if (!st) return;
    runBtn.disabled = st.running;
    forceBtn.disabled = st.running;
    stopBtn.disabled = !st.running;
    const r = st.report || {};
    if (st.running) {
      const where = st.current ? `: ${st.current}` : '';
      status.textContent = st.stopping
        ? `Stopping after the current demo${where}`
        : `${st.done} of ${st.total} demos, ${st.pending} left${where}`;
    } else if (st.finishedAt) {
      status.textContent =
        `Finished in ${Math.round((st.ms || 0) / 1000)}s. ` +
        `${r.measured || 0} measured, ${r.current || 0} already current, ` +
        `${r.skipped || 0} skipped, ${r.failed || 0} failed.`;
    } else {
      status.textContent = st.scanned
        ? `${st.scanned} demos measured. Not running.`
        : 'Not running.';
    }
    const bits = [];
    if (r.rounds) bits.push(`${r.rounds} rounds measured`);
    if (st.unscannable) bits.push(`${st.unscannable} without a stats index`);
    if (st.error) bits.push(`Last error: ${st.error}`);
    detail.textContent = bits.join(' · ');
  }

  async function poll() {
    try {
      const st = await adminApi.rescanAimStatus();
      paint(st);
      if (st.running) timer = window.setTimeout(poll, 2000);
    } catch {
      /* quiet */
    }
  }

  async function start(force) {
    if (
      force &&
      !window.confirm(
        'Re-measure the aim motion statistics on every demo, including the ones already done?\n\nThe normal rescan skips those and is far quicker.'
      )
    ) {
      return;
    }
    runBtn.disabled = true;
    forceBtn.disabled = true;
    try {
      paint(await adminApi.rescanAim({ force }));
      timer = window.setTimeout(poll, 1000);
    } catch (err) {
      status.textContent = err.message;
      runBtn.disabled = false;
      forceBtn.disabled = false;
    }
  }

  async function stop() {
    stopBtn.disabled = true;
    try {
      paint(await adminApi.stopRescanAim());
      timer = window.setTimeout(poll, 1000);
    } catch (err) {
      status.textContent = err.message;
    }
  }

  void poll();
  card.addEventListener('admin:panel-hidden', () => window.clearTimeout(timer));
  return card;
}

/**
 * Duplicate matches: the same game imported twice. Marked only when map,
 * teams and all ten players are identical, the score is within ±2, 80%+ of
 * rounds were won by the same team, and at least two rounds have 90%+
 * identical player positions. The lower parser revision (or the older
 * parse) is the copy that gets deleted.
 */
function dupeScanCard() {
  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Duplicate matches'));
  card.appendChild(
    el(
      'p',
      'admin-muted',
      'Finds the same game imported twice — identical teams, players, map, score within ±2, matching round winners, and rounds with the same player positions — and deletes the copy with the lower parsed version (or the older one).'
    )
  );
  const status = el('div', 'admin-tool-status');
  const report = el('div', 'admin-tool-status');
  const runBtn = button('Scan & delete duplicates', () => start(true), 'btn btn-primary btn-sm');
  const dryBtn = button('Scan only', () => start(false), 'btn btn-sm');
  const row = el('div', 'admin-inline');
  row.append(runBtn, dryBtn);
  card.append(row, status, report);

  let timer = 0;

  function paint(st) {
    if (!st) return;
    runBtn.disabled = st.running;
    dryBtn.disabled = st.running;
    if (st.running && st.phase === 'screening') {
      status.textContent = 'Screening library metadata…';
    } else if (st.running) {
      const p = st.progress;
      const eta = p.etaSeconds != null && p.total > p.done ? ` · ~${p.etaSeconds}s left` : '';
      const del = p.deleted ? ` · ${p.deleted} deleted` : '';
      status.textContent = `Verifying candidate pair ${p.done} / ${p.total}${eta}${del}`;
    } else if (st.result) {
      const r = st.result;
      status.textContent =
        `Scanned ${r.scanned} demos, ${r.candidates} candidate pair${r.candidates === 1 ? '' : 's'}. ` +
        `Duplicates: ${r.duplicates}. ` +
        (r.dryRun ? 'Nothing deleted (scan only).' : `Deleted: ${r.deleted}.`) +
        (r.failed ? ` Failed: ${r.failed}.` : '');
      report.replaceChildren();
      for (const pair of r.pairs || []) {
        report.appendChild(
          el(
            'p',
            'admin-muted',
            `${r.dryRun ? 'Would delete' : 'Deleted'} ${pair.removed} — kept ${pair.kept} (${pair.reason}).`
          )
        );
      }
    } else if (st.error) {
      status.textContent = `Failed: ${st.error}`;
    } else {
      status.textContent = '';
    }
  }

  async function poll() {
    try {
      const st = await adminApi.dupeScanStatus();
      paint(st);
      if (st.running) {
        timer = window.setTimeout(poll, 1500);
      }
    } catch {
      /* quiet */
    }
  }

  async function start(del) {
    runBtn.disabled = true;
    dryBtn.disabled = true;
    report.replaceChildren();
    try {
      paint(await adminApi.dupeScanStart(del));
      timer = window.setTimeout(poll, 1200);
    } catch (err) {
      status.textContent = err.message;
      runBtn.disabled = false;
      dryBtn.disabled = false;
    }
  }

  void poll();
  card.addEventListener('admin:panel-hidden', () => window.clearTimeout(timer));
  return card;
}

export function toolsPanel() {
  const root = el('div', 'admin-panel');
  const status = el('p', 'admin-note', '');
  const progressWrap = el('div', 'ingest-progress');
  progressWrap.hidden = true;
  let running = false;
  /** @type {string|null} */
  let activeKind = null;
  let pollTimer = 0;
  /** @type {Set<string>} */
  const selected = new Set();
  /** @type {{ id: string, label: string }[]} */
  let fieldGroups = DEFAULT_FIELD_GROUPS.slice();

  const JOBS = buildJobs(() => [...selected]);
  const jobFor = (kind) => JOBS.find((j) => j.kind === kind) || JOBS[0];

  /** @type {Map<string, HTMLButtonElement>} */
  const buttons = new Map();
  const fieldSeg = el('div', 'admin-field-seg');
  fieldSeg.setAttribute('role', 'group');
  fieldSeg.setAttribute('aria-label', 'Stats fields to patch');

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
      if (!btn) continue;
      btn.disabled = busy;
      btn.textContent = busy && job.kind === kind ? job.busy : job.idle;
    }
    fieldSeg.querySelectorAll('button').forEach((b) => {
      b.disabled = busy;
    });
    if (!busy) activeKind = null;
  }

  function drawFieldChips() {
    fieldSeg.replaceChildren();
    for (const group of fieldGroups) {
      const on = selected.has(group.id);
      const btn = el('button', `admin-field-chip${on ? ' is-on' : ''}`, group.label);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.disabled = running;
      btn.addEventListener('click', () => {
        if (running) return;
        if (selected.has(group.id)) selected.delete(group.id);
        else selected.add(group.id);
        drawFieldChips();
      });
      fieldSeg.appendChild(btn);
    }
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
      status.textContent += `. ${sample}`;
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
      const fieldsState = states[JOBS.findIndex((j) => j.kind === 'fields')];
      if (Array.isArray(fieldsState?.fieldGroups) && fieldsState.fieldGroups.length) {
        fieldGroups = fieldsState.fieldGroups;
        drawFieldChips();
      }
      const live = states.findIndex((s) => s.running);
      if (live !== -1) {
        // Jobs can share a status endpoint (full rebuild vs stale-only
        // enrichment); the state's own kind names the one actually running.
        const liveKind = JOBS.some((j) => j.kind === states[live].kind)
          ? states[live].kind
          : JOBS[live].kind;
        drawProgress(states[live], liveKind);
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
        if (recent !== -1) {
          const recentKind = JOBS.some((j) => j.kind === states[recent].kind)
            ? states[recent].kind
            : JOBS[recent].kind;
          applyFinished(states[recent], recentKind);
        }
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
    if (spec.kind === 'fields') {
      if (!selected.size) {
        status.className = 'admin-error';
        status.textContent = 'Select at least one field to patch.';
        return;
      }
      if (
        !window.confirm(
          `Rewrite ${[...selected].join(', ')} on every ready demo from stored round files?\n\nOther fields stay as they are. Does not reparse demos.`
        )
      ) {
        return;
      }
    } else if (spec.confirm && !window.confirm(spec.confirm)) {
      return;
    }
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

  drawFieldChips();

  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Replay statistics'));
  card.appendChild(fieldSeg);
  card.appendChild(actions);
  card.appendChild(progressWrap);
  card.appendChild(status);

  const wrap = el('div');
  wrap.append(card, aimRescanCard(), pistolFixCard(), dupeScanCard());
  render(root, wrap);

  // If a rebuild is already running (other tab, prior click, deploy), show it
  // before anyone presses the button again.
  pollOnce().then((active) => {
    if (active) startPoll();
  });

  root._stopPolling = stopPoll;
  return root;
}
