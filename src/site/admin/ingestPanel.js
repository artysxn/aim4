// ---------------------------------------------------------------------------
// src/site/admin/ingestPanel.js
// Start, stop and watch the demo ingester.
//
// The ingester is a separate process on the server, so this panel is a remote
// control and a window, never the thing doing the work. Everything it shows
// comes from GET /api/admin/ingest, which reads the status file the running
// process writes.
//
// Polls while the panel is open and stops when it is not. A backfill runs for
// weeks; nobody watches it for weeks, and a poll left running in a background
// tab is a request every few seconds forever.
//
// Nodes only, no HTML strings: team names and event names come from demo
// filenames, which are attacker-controlled from this panel's point of view.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, bytes, date, el, input, notice, row } from './dom.js';
import { spinnerNode } from '../../lib/spinner.js';

/** Fast enough to feel live, slow enough to be free on a weeks-long run. */
const POLL_MS = 5000;
/** A probe run is minutes, not weeks, so its poll is tighter while live. */
const PROBE_POLL_MS = 1500;

/**
 * The download probe: paste a demo URL, watch the server try to fetch, parse
 * and package it, copy the step log out to report on.
 *
 * Built once and re-appended on every panel redraw, so the URL input and the
 * log keep their state while the rest of the panel repaints around them.
 */
function probeBlock() {
  const root = el('div', 'ingest-probe');
  let timer = 0;
  let st = null;
  let busy = false;

  const head = el('div', 'ingest-head');
  head.appendChild(el('h4', null, 'Download probe'));
  const chip = el('span', 'ingest-chip is-stopped', 'Idle');
  head.appendChild(chip);
  root.appendChild(head);

  const urlInput = input('text', '', 'https://www.hltv.org/download/demo/110202');
  urlInput.className = 'ingest-probe-url';
  const runBtn = button('Run probe', run, 'btn btn-primary btn-sm');
  const cancelBtn = button('Cancel', cancel, 'btn btn-danger btn-sm');
  const copyBtn = button('Copy log', copyLog, 'btn btn-sm');
  root.appendChild(row(urlInput, runBtn, cancelBtn, copyBtn));

  const out = el('div', 'ingest-probe-out');
  root.appendChild(out);

  async function run() {
    const url = urlInput.value.trim();
    if (!url) {
      notice(root, 'Paste a demo download URL first.', 'error');
      return;
    }
    if (busy) return;
    busy = true;
    draw();
    try {
      st = await adminApi.ingestProbeStart(url);
      schedule(0);
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      draw();
    }
  }

  async function cancel() {
    try {
      st = await adminApi.ingestProbeCancel();
      draw();
    } catch (err) {
      notice(root, err.message, 'error');
    }
  }

  function logText() {
    if (!st) return '';
    const lines = (st.log || []).map(
      (l) => `${l.at}  ${String(l.level || 'info').toUpperCase().padEnd(5)} ${l.text}`
    );
    return [
      `AIM4 download probe ${st.runId || ''}`,
      `URL: ${st.url || ''}`,
      `Verdict: ${st.verdict || (st.running ? 'running' : 'none')}`,
      '',
      ...lines
    ].join('\n');
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(logText());
      notice(root, 'Log copied.');
    } catch {
      notice(root, 'Could not reach the clipboard. Select the log text instead.', 'error');
    }
  }

  async function refresh() {
    try {
      st = await adminApi.ingestProbeStatus();
      draw();
    } catch {
      /* transient; the next poll answers */
    }
    schedule(st?.running ? PROBE_POLL_MS : 0);
  }

  /** Poll fast while a run is live, otherwise sit still until reopened. */
  function schedule(delay) {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    if (delay) timer = window.setTimeout(refresh, delay);
  }

  function verdictChip() {
    if (!st || (!st.running && !st.verdict)) return ['is-stopped', 'Idle'];
    if (st.running) return ['is-running', 'Running'];
    if (st.verdict === 'ok') return ['is-running', 'Pass'];
    if (st.verdict === 'blocked') return ['is-warn', 'Blocked'];
    if (st.verdict === 'cancelled') return ['is-stopped', 'Cancelled'];
    return ['is-warn', 'Failed'];
  }

  function liveLine() {
    const live = st?.live;
    if (!live) return null;
    if (live.stage === 'browser') return live.detail || 'Opening URL in CloakBrowser';
    if (live.stage === 'download') {
      const total = live.total ? ` of ${bytes(live.total)}` : '';
      return `Downloading: ${bytes(live.received || 0)}${total}`;
    }
    if (live.stage === 'unpack') return 'Unpacking the archive';
    if (live.stage === 'parse') {
      const round = live.round ? `, round ${live.round}${live.total ? `/${live.total}` : ''}` : '';
      return `Parsing ${live.detail || ''}${round} (${live.parseStage || 'working'})`;
    }
    return null;
  }

  function draw() {
    const [chipClass, chipText] = verdictChip();
    chip.className = `ingest-chip ${chipClass}`;
    chip.textContent = chipText;

    const running = Boolean(st?.running);
    runBtn.disabled = busy || running;
    runBtn.textContent = busy ? 'Starting...' : running ? 'Running...' : 'Run probe';
    cancelBtn.style.display = running ? '' : 'none';
    copyBtn.style.display = st?.log?.length ? '' : 'none';

    const wrap = el('div');
    if (st?.summary && !running) {
      wrap.appendChild(
        el('p', st.verdict === 'ok' ? 'ingest-probe-pass' : 'admin-error', st.summary)
      );
    }
    const live = liveLine();
    if (live) wrap.appendChild(el('p', 'ingest-probe-live', live));

    if (st?.log?.length) {
      const logEl = el('div', 'ingest-probe-log');
      for (const entry of st.log) {
        const lineEl = el('div', `ingest-probe-line is-${entry.level || 'info'}`);
        lineEl.appendChild(
          el('span', 'ingest-probe-time', String(entry.at || '').slice(11, 19))
        );
        lineEl.appendChild(el('span', 'ingest-probe-text', entry.text));
        logEl.appendChild(lineEl);
      }
      wrap.appendChild(logEl);
      // Keep the newest line in view while the run writes.
      queueMicrotask(() => {
        logEl.scrollTop = logEl.scrollHeight;
      });
    }
    out.replaceChildren(wrap);
  }

  draw();
  return {
    root,
    start() {
      refresh();
    },
    stop() {
      schedule(0);
    },
    hasFocus: () => document.activeElement === urlInput,
    refocus() {
      const { selectionStart, selectionEnd } = urlInput;
      urlInput.focus();
      try {
        urlInput.setSelectionRange(selectionStart, selectionEnd);
      } catch {
        /* fine, focus is what matters */
      }
    }
  };
}

export function ingestPanel() {
  const root = el('div', 'admin-ingest');
  const probe = probeBlock();
  let timer = 0;
  let busy = false;
  let lastStatus = null;

  async function refresh() {
    try {
      lastStatus = await adminApi.ingestStatus();
      draw();
    } catch (err) {
      root.replaceChildren(el('p', 'admin-error', err.message));
    }
  }

  async function act(fn, label) {
    if (busy) return;
    busy = true;
    draw();
    try {
      lastStatus = await fn();
      notice(root, label);
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      draw();
    }
  }

  /**
   * Two different facts, deliberately shown separately: whether the switch is
   * on, and whether a process is up right now. They come apart when the
   * ingester has crashed and the supervisor is waiting to retry, and "On,
   * restarting" is a much more useful thing to see than "Stopped".
   */
  function stateChip(status) {
    if (!status.enabled) return el('span', 'ingest-chip is-stopped', 'Off');
    if (!status.running) {
      return el(
        'span',
        'ingest-chip is-warn',
        status.restartBackoffMs
          ? `On, restarting in ${Math.ceil(status.restartBackoffMs / 1000)}s`
          : 'On, starting'
      );
    }
    if (status.idleUntil && !status.current) {
      return el('span', 'ingest-chip is-idle', 'On, waiting for new matches');
    }
    return el('span', 'ingest-chip is-running', 'Running');
  }

  /** Chronological position: which match, of how many, and how far in. */
  function progressBlock(status) {
    const wrap = el('div', 'ingest-progress');
    const p = status.progress || { done: 0, total: 0, percent: 0 };

    const bar = el('div', 'ingest-bar');
    const fill = el('div', 'ingest-bar-fill');
    fill.style.width = `${Math.min(100, p.percent)}%`;
    bar.appendChild(fill);
    wrap.appendChild(bar);

    wrap.appendChild(
      el('div', 'ingest-progress-meta', `${p.done} of ${p.total} matches (${p.percent}%)`)
    );

    const current = status.current;
    if (current) {
      const line = el('div', 'ingest-current');
      line.appendChild(el('strong', null, current.label || current.matchId));
      if (current.event) line.appendChild(el('span', 'ingest-dim', current.event));
      const stage = current.map
        ? `${current.stage || 'working'}: ${current.map}${
            current.round ? ` round ${current.round}/${current.totalRounds || '?'}` : ''
          }`
        : current.stage || 'working';
      line.appendChild(el('span', 'ingest-stage', stage));
      if (current.playedAt) line.appendChild(el('span', 'ingest-dim', date(current.playedAt)));
      wrap.appendChild(line);
    } else if (status.next) {
      const line = el('div', 'ingest-current');
      line.appendChild(el('span', 'ingest-dim', 'Next up'));
      line.appendChild(el('strong', null, status.next.label));
      if (status.next.playedAt) line.appendChild(el('span', 'ingest-dim', date(status.next.playedAt)));
      wrap.appendChild(line);
    }
    return wrap;
  }

  function countsBlock(counts) {
    const wrap = el('div', 'ingest-counts');
    const cells = [
      ['Queued', counts.discovered],
      ['Done', counts.cleaned],
      ['Needs review', counts.needs_review],
      ['Failed', counts.failed_permanent],
      ['Total', counts.total]
    ];
    for (const [label, value] of cells) {
      const cell = el('div', 'ingest-count');
      cell.appendChild(el('span', 'ingest-count-value', String(value ?? 0)));
      cell.appendChild(el('span', 'ingest-count-label', label));
      wrap.appendChild(cell);
    }
    return wrap;
  }

  function recentBlock(recent) {
    const wrap = el('div', 'ingest-recent');
    wrap.appendChild(el('h4', null, 'Recent'));
    if (!recent.length) {
      wrap.appendChild(el('p', 'admin-muted', 'Nothing yet.'));
      return wrap;
    }
    const list = el('ul', 'ingest-recent-list');
    for (const entry of recent.slice(0, 12)) {
      const item = el('li', `ingest-recent-item is-${entry.kind}`);
      item.appendChild(el('span', 'ingest-recent-time', date(new Date(entry.at).toISOString())));
      item.appendChild(el('span', 'ingest-recent-text', entry.text));
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function draw() {
    if (!lastStatus) {
      root.replaceChildren(spinnerNode());
      return;
    }
    const status = lastStatus;
    const wrap = el('div');

    const head = el('div', 'ingest-head');
    head.appendChild(el('h3', null, 'Demo ingest'));
    head.appendChild(stateChip(status));
    wrap.appendChild(head);

    // The button follows the switch, not the process. Turning it off while it
    // is crash-looping has to be possible, and turning it on while it is
    // already up is harmless.
    const controls = row(
      status.enabled
        ? button(
            busy ? 'Turning off...' : 'Turn off',
            () => act(adminApi.ingestStop, 'Ingest switched off.'),
            'btn btn-danger'
          )
        : button(
            busy ? 'Turning on...' : 'Turn on',
            () => act(adminApi.ingestStart, 'Ingest switched on.'),
            'btn btn-primary'
          ),
      button('Refresh', refresh, 'btn btn-sm')
    );
    if (busy) controls.querySelectorAll('button').forEach((b) => (b.disabled = true));
    wrap.appendChild(controls);

    wrap.appendChild(
      el(
        'p',
        'admin-muted',
        status.enabled
          ? 'Runs on the server. It keeps going with this page closed, and comes back by itself after a deploy or a reboot. Turning it off lets the match in progress finish first.'
          : `Off. Turning it on starts a continuous backfill from ${
              status.config?.since || 'the configured date'
            }, checking for newly finished matches every ${Math.round(
              (status.config?.pollIntervalMs || 0) / 60000
            )} minutes.`
      )
    );

    wrap.appendChild(progressBlock(status));
    if (status.counts) wrap.appendChild(countsBlock(status.counts));

    const cfg = status.config || {};
    const meta = el('div', 'ingest-config');
    meta.appendChild(el('span', null, `Source: ${cfg.source || '?'}`));
    if (cfg.inbox) meta.appendChild(el('span', null, `Inbox: ${cfg.inbox}`));
    meta.appendChild(el('span', null, `Since: ${cfg.since || '?'}`));
    meta.appendChild(el('span', null, `Batch: ${cfg.batchSize ?? '?'}`));
    meta.appendChild(
      el('span', null, `Poll: every ${Math.round((cfg.pollIntervalMs || 0) / 60000)} min`)
    );
    wrap.appendChild(meta);

    if (status.lastError) {
      wrap.appendChild(el('p', 'admin-error', `Last error: ${status.lastError}`));
    }
    wrap.appendChild(recentBlock(status.recent || []));

    if (status.updatedAt) {
      wrap.appendChild(el('p', 'admin-muted', `Status updated ${date(status.updatedAt)}`));
    }

    // The probe block is a persistent node: re-appending moves it, keeping its
    // input, log scroll and poll state across this panel's redraws.
    wrap.appendChild(probe.root);

    const hadFocus = probe.hasFocus();
    root.replaceChildren(wrap);
    if (hadFocus) probe.refocus();
  }

  function start() {
    refresh();
    probe.start();
    // Polling belongs to the open panel, not to the page.
    timer = window.setInterval(refresh, POLL_MS);
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = 0;
    probe.stop();
  }

  root.addEventListener('admin:panel-hidden', stop);
  start();
  root._stopPolling = stop;
  return root;
}
