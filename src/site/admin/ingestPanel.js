// ---------------------------------------------------------------------------
// src/site/admin/ingestPanel.js
// Remote control for sequential HLTV demo ingest.
//
// Layout: power + progress, live console, then compact proxy / disk tools.
// Persistent nodes keep console scroll and field focus across status redraws.
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, bytes, el, input, notice, row } from './dom.js';

const STATUS_POLL_MS = 2000;
const LOG_POLL_MS = 1500;
const LOG_TAIL = 999;

const STAGES = [
  { id: 'download', label: 'Download' },
  { id: 'unpack', label: 'Unpack' },
  { id: 'parse', label: 'Parse' },
  { id: 'store', label: 'Store' },
  { id: 'waiting', label: 'Wait' }
];

function stageIndex(stage) {
  if (!stage) return -1;
  if (stage === 'clean' || stage === 'cleaned') return STAGES.length;
  if (stage === 'challenge') return 0;
  const i = STAGES.findIndex((s) => s.id === stage);
  return i;
}

function powerSeg(enabled, busy, onToggle) {
  const seg = el('div', 'ingest-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Ingest power');
  const off = el('button', `ingest-seg-btn${!enabled ? ' is-on' : ''}`, 'Off');
  off.type = 'button';
  const on = el('button', `ingest-seg-btn${enabled ? ' is-on' : ''}`, 'On');
  on.type = 'button';
  off.disabled = busy;
  on.disabled = busy;
  off.addEventListener('click', () => {
    if (enabled) onToggle(false);
  });
  on.addEventListener('click', () => {
    if (!enabled) onToggle(true);
  });
  seg.append(off, on);
  return seg;
}

function metric(label, value, tone = '') {
  const node = el('div', `ingest-metric${tone ? ` is-${tone}` : ''}`);
  node.appendChild(el('div', 'ingest-metric-value', value));
  node.appendChild(el('div', 'ingest-metric-label', label));
  return node;
}

function classifyLogLine(text) {
  const t = String(text || '');
  if (/FAILED|ERROR|Error:|exited with code/i.test(t)) return 'error';
  if (/frontier|missing|waiting for demo/i.test(t)) return 'warn';
  if (/ingested|cleaned|cursor:|OK |duplicate/i.test(t)) return 'ok';
  return '';
}

/** Live tail of server/data/hltv-ingest/ingest.log */
function consoleBlock() {
  const root = el('div', 'ingest-console');
  let timer = 0;
  let lines = [];
  let pinnedBottom = true;
  let lastFingerprint = '';

  const head = el('div', 'ingest-console-head');
  const title = el('span', 'ingest-console-title', 'Console');
  const count = el('span', 'ingest-console-count', '0');
  head.append(title, count);
  const clearBtn = button('Clear', clearLog, 'btn btn-sm');
  const copyBtn = button('Copy', copyLog, 'btn btn-sm');
  head.append(clearBtn, copyBtn);
  root.appendChild(head);

  const view = el('div', 'ingest-console-view');
  view.setAttribute('aria-label', 'Ingest console');
  view.addEventListener('scroll', () => {
    const gap = view.scrollHeight - view.scrollTop - view.clientHeight;
    pinnedBottom = gap < 48;
  });
  root.appendChild(view);

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      notice(root, 'Log copied.');
    } catch {
      notice(root, 'Could not copy log.', 'error');
    }
  }

  async function clearLog() {
    clearBtn.disabled = true;
    try {
      await adminApi.ingestLogClear();
      lines = [];
      lastFingerprint = '';
      paint();
      await refresh();
      notice(root, 'Console cleared.');
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      clearBtn.disabled = false;
    }
  }

  function paint() {
    count.textContent = String(lines.length);
    const frag = document.createDocumentFragment();
    if (!lines.length) {
      frag.appendChild(el('div', 'ingest-console-empty', 'No log output yet.'));
    } else {
      for (const line of lines) {
        const tone = classifyLogLine(line);
        frag.appendChild(el('div', `ingest-console-line${tone ? ` is-${tone}` : ''}`, line));
      }
    }
    view.replaceChildren(frag);
    if (pinnedBottom) view.scrollTop = view.scrollHeight;
  }

  async function refresh() {
    try {
      const data = await adminApi.ingestLog(LOG_TAIL);
      const next = Array.isArray(data.lines) ? data.lines : [];
      const fingerprint = `${data.mtime || ''}:${next.length}:${next[next.length - 1] || ''}`;
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lines = next;
        paint();
      }
    } catch {
      /* keep last paint during brief API blips */
    }
  }

  function schedule() {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      await refresh();
      schedule();
    }, LOG_POLL_MS);
  }

  return {
    root,
    start() {
      refresh();
      schedule();
    },
    stop() {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    }
  };
}

function proxiesBlock() {
  const root = el('div', 'ingest-tools-card');
  let st = null;
  let busy = false;

  const head = el('div', 'ingest-tools-head');
  head.appendChild(el('span', null, 'Proxies'));
  const chip = el('span', 'ingest-chip is-stopped', '0');
  head.appendChild(chip);
  root.appendChild(head);

  const attemptsInput = input('number', '5', '');
  attemptsInput.className = 'ingest-field ingest-field-narrow';
  attemptsInput.min = '1';
  attemptsInput.max = '50';
  attemptsInput.setAttribute('aria-label', 'Proxy attempts');
  attemptsInput.title = 'Attempts';

  const randomCheck = document.createElement('input');
  randomCheck.type = 'checkbox';
  randomCheck.checked = true;
  randomCheck.className = 'ingest-proxy-check';
  randomCheck.id = 'ingest-proxy-random';
  const randomLabel = el('label', 'ingest-toggle');
  randomLabel.htmlFor = 'ingest-proxy-random';
  randomLabel.append(randomCheck, document.createTextNode(' Random'));

  const saveBtn = button('Save', save, 'btn btn-sm');
  const refreshBtn = button('Refresh', refreshList, 'btn btn-sm');
  root.appendChild(row(attemptsInput, randomLabel, saveBtn, refreshBtn));

  const meta = el('div', 'ingest-tools-meta');
  root.appendChild(meta);

  function applyForm() {
    if (!st?.settings) return;
    attemptsInput.value = String(st.settings.attempts ?? 5);
    randomCheck.checked = st.settings.random !== false;
  }

  async function save() {
    if (busy) return;
    busy = true;
    try {
      st = await adminApi.ingestProxiesSave({
        attempts: Number(attemptsInput.value) || 5,
        random: randomCheck.checked
      });
      applyForm();
      paint();
      notice(root, 'Saved.');
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
    }
  }

  async function refreshList() {
    if (busy) return;
    busy = true;
    refreshBtn.textContent = '…';
    try {
      st = await adminApi.ingestProxiesRefresh();
      applyForm();
      paint();
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      refreshBtn.textContent = 'Refresh';
      paint();
    }
  }

  function paint() {
    const n = st?.workingCount ?? 0;
    chip.textContent = String(n);
    chip.className = `ingest-chip ${n ? 'is-running' : 'is-stopped'}`;
    const refreshing = Boolean(st?.refresh?.running);
    refreshBtn.disabled = busy || refreshing;
    if (refreshing) {
      meta.textContent = `Verifying ${st.refresh.verified || 0}/${st.refresh.candidates || '?'}`;
      return;
    }
    if (st?.refresh?.summary) meta.textContent = st.refresh.summary;
    else {
      const tested = st?.testedCount ?? 0;
      const target = st?.testTarget ?? 40;
      const best = st?.confirmedCount ?? 0;
      const need = st?.rotationSize ?? 5;
      const sticky = st?.sticky
        ? `Sticky ${st.sticky.host}${st.sticky.mbps != null ? ` ${Number(st.sticky.mbps).toFixed(0)}MB/s` : ''}`
        : st?.rotationOnly
          ? `Top ${best}/${need} by speed`
          : `Tested ${tested}/${target}`;
      const gray = st?.graylistCount ? ` · Gray ${st.graylistCount}` : '';
      const banned = st?.blacklistCount ? ` · Banned ${st.blacklistCount}` : '';
      meta.textContent = `${sticky} · Working ${n} · Cache ${st?.cacheCount ?? 0}${gray}${banned}`;
    }
  }

  return {
    root,
    async refresh() {
      try {
        st = await adminApi.ingestProxies();
        if (document.activeElement !== attemptsInput) applyForm();
        paint();
      } catch (err) {
        meta.textContent = err.message || 'Unavailable';
      }
    }
  };
}

function diskBlock() {
  const root = el('div', 'ingest-tools-card');
  let st = null;
  let busy = false;
  const selected = new Set();

  const head = el('div', 'ingest-tools-head');
  head.appendChild(el('span', null, 'Disk'));
  const chip = el('span', 'ingest-chip is-stopped', '0');
  head.appendChild(chip);
  root.appendChild(head);

  const meta = el('div', 'ingest-tools-meta');
  root.appendChild(meta);

  const refreshBtn = button('Refresh', () => refresh(), 'btn btn-sm');
  const deleteBtn = button('Delete', deleteSelected, 'btn btn-danger btn-sm');
  const deleteAllBtn = button('Delete all', deleteAll, 'btn btn-danger btn-sm');
  root.appendChild(row(refreshBtn, deleteBtn, deleteAllBtn));

  const tableWrap = el('div', 'ingest-disk-table-wrap');
  root.appendChild(tableWrap);

  function syncButtons() {
    deleteBtn.disabled = busy || selected.size === 0;
    deleteAllBtn.disabled = busy || !(st?.files || []).length;
    refreshBtn.disabled = busy;
  }

  async function deleteIds(ids) {
    if (!ids.length || busy) return;
    busy = true;
    syncButtons();
    try {
      st = await adminApi.ingestDiskDelete(ids);
      for (const id of ids) selected.delete(id);
      notice(root, `Freed ${bytes(st.freed || 0)}.`);
      paint();
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      syncButtons();
    }
  }

  function deleteSelected() {
    return deleteIds([...selected]);
  }

  function deleteAll() {
    return deleteIds((st?.files || []).map((f) => f.id));
  }

  function paint() {
    const files = st?.files || [];
    chip.textContent = String(files.length);
    chip.className = `ingest-chip ${files.length ? 'is-running' : 'is-stopped'}`;
    meta.textContent = [
      `Used ${bytes(st?.usedBytes || 0)}`,
      st?.freeBytes != null ? `Free ${bytes(st.freeBytes)}` : null
    ]
      .filter(Boolean)
      .join(' · ');

    tableWrap.replaceChildren();
    if (!files.length) {
      tableWrap.appendChild(el('div', 'ingest-tools-meta', 'Empty'));
      syncButtons();
      return;
    }

    const table = el('table', 'admin-table ingest-disk-table');
    const thead = el('thead');
    const hr = el('tr');
    const thCheck = el('th');
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.checked = files.every((f) => selected.has(f.id));
    all.addEventListener('change', () => {
      if (all.checked) files.forEach((f) => selected.add(f.id));
      else files.forEach((f) => selected.delete(f.id));
      paint();
    });
    thCheck.appendChild(all);
    hr.append(thCheck, el('th', null, 'File'), el('th', null, 'Size'));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const file of files.slice(0, 80)) {
      const tr = el('tr');
      const tdCheck = el('td');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(file.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(file.id);
        else selected.delete(file.id);
        syncButtons();
        all.checked = files.every((f) => selected.has(f.id));
      });
      tdCheck.appendChild(box);
      const tdName = el('td');
      tdName.appendChild(el('div', 'ingest-disk-name', file.name));
      tdName.appendChild(el('div', 'ingest-dim', file.kind));
      tr.append(tdCheck, tdName, el('td', 'ingest-disk-size', bytes(file.bytes)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    syncButtons();
  }

  async function refresh() {
    try {
      st = await adminApi.ingestDisk();
      paint();
    } catch (err) {
      meta.textContent = err.message || 'Unavailable';
      tableWrap.replaceChildren();
    }
  }

  return { root, refresh };
}

function probeBlock() {
  const root = el('div', 'ingest-tools-card');
  let timer = 0;
  let st = null;
  let busy = false;

  const head = el('div', 'ingest-tools-head');
  head.appendChild(el('span', null, 'Probe'));
  const chip = el('span', 'ingest-chip is-stopped', 'Idle');
  head.appendChild(chip);
  root.appendChild(head);

  const urlInput = input('text', '', 'https://www.hltv.org/download/demo/110202');
  urlInput.className = 'ingest-field ingest-probe-url';
  urlInput.setAttribute('aria-label', 'Demo URL');
  const runBtn = button('Run', run, 'btn btn-primary btn-sm');
  const cancelBtn = button('Cancel', cancel, 'btn btn-danger btn-sm');
  root.appendChild(row(urlInput, runBtn, cancelBtn));
  const meta = el('div', 'ingest-tools-meta');
  root.appendChild(meta);

  async function run() {
    const url = urlInput.value.trim();
    if (!url) {
      notice(root, 'Paste a demo URL.', 'error');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      st = await adminApi.ingestProbeStart(url);
      schedule(1500);
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      paint();
    }
  }

  async function cancel() {
    try {
      st = await adminApi.ingestProbeCancel();
      paint();
    } catch (err) {
      notice(root, err.message, 'error');
    }
  }

  function paint() {
    const running = Boolean(st?.running);
    chip.textContent = running ? 'Live' : st?.verdict || 'Idle';
    chip.className = `ingest-chip ${
      running ? 'is-running' : st?.verdict === 'ok' ? 'is-running' : st?.verdict ? 'is-warn' : 'is-stopped'
    }`;
    if (running && st.live) {
      meta.textContent = `${st.live.stage || 'working'}${
        st.live.received ? ` · ${bytes(st.live.received)}` : ''
      }`;
    } else if (st?.summary) meta.textContent = st.summary;
    else meta.textContent = '';
  }

  async function poll() {
    try {
      st = await adminApi.ingestProbeStatus();
      paint();
    } catch {
      /* ignore */
    }
    schedule(st?.running ? 1500 : 0);
  }

  function schedule(delay) {
    if (timer) window.clearTimeout(timer);
    timer = delay ? window.setTimeout(poll, delay) : 0;
  }

  return {
    root,
    start() {
      poll();
    },
    stop() {
      schedule(0);
    },
    hasFocus: () => document.activeElement === urlInput,
    refocus() {
      urlInput.focus();
    }
  };
}

export function ingestPanel() {
  const root = el('div', 'admin-ingest');
  const consoleUi = consoleBlock();
  const proxies = proxiesBlock();
  const disk = diskBlock();
  const probe = probeBlock();

  let timer = 0;
  let busy = false;
  let lastStatus = null;

  const shell = el('div', 'ingest-shell');
  const hero = el('div', 'ingest-hero');
  const seekRow = el('div', 'ingest-seek');
  const seekInput = input('number', '', '110101');
  seekInput.className = 'ingest-field ingest-field-narrow';
  seekInput.setAttribute('aria-label', 'Demo id');
  seekInput.min = '1';
  const seekBtn = button('Seek', () => seek(), 'btn btn-sm');
  seekRow.append(seekInput, seekBtn);
  const metrics = el('div', 'ingest-metrics');
  const stages = el('div', 'ingest-stages');
  const barWrap = el('div', 'ingest-progress');
  const errorSlot = el('div');
  const tools = el('div', 'ingest-tools');
  tools.append(proxies.root, disk.root, probe.root);

  shell.append(hero, seekRow, metrics, stages, barWrap, errorSlot, consoleUi.root, tools);
  root.appendChild(shell);

  async function refresh() {
    try {
      lastStatus = await adminApi.ingestStatus();
      paint();
    } catch (err) {
      errorSlot.replaceChildren(el('p', 'admin-error', err.message));
    }
  }

  async function seek() {
    const nextId = Number(seekInput.value);
    if (!Number.isFinite(nextId) || nextId < 1) {
      notice(root, 'Enter a demo id.', 'error');
      return;
    }
    if (busy) return;
    busy = true;
    seekBtn.disabled = true;
    try {
      lastStatus = await adminApi.ingestSeek(nextId);
      notice(root, `Cursor at demo/${nextId}.`);
      paint();
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      seekBtn.disabled = false;
    }
  }

  async function toggle(on) {
    if (busy) return;
    busy = true;
    paint();
    try {
      lastStatus = on ? await adminApi.ingestStart() : await adminApi.ingestStop();
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      paint();
      proxies.refresh();
      disk.refresh();
    }
  }

  async function hardRestart() {
    if (busy) return;
    busy = true;
    paint();
    try {
      lastStatus = await adminApi.ingestHardRestart();
      notice(root, 'Hard restart done.');
    } catch (err) {
      notice(root, err.message, 'error');
    } finally {
      busy = false;
      paint();
      proxies.refresh();
      disk.refresh();
    }
  }

  function paint() {
    if (!shell.isConnected) root.replaceChildren(shell);
    if (!lastStatus) {
      hero.replaceChildren(el('div', 'ingest-focus-detail', 'Loading…'));
      return;
    }

    const status = lastStatus;
    const p = status.progress || {};
    const counts = status.counts || {};
    const demoId = p.nextId ?? status.config?.demoStart ?? 109575;
    // Never show live stage chrome when the switch is Off.
    const current = status.enabled ? status.current : null;

    hero.replaceChildren();
    const titleRow = el('div', 'ingest-hero-top');
    titleRow.appendChild(el('h3', 'ingest-title', 'Ingest'));
    titleRow.appendChild(powerSeg(Boolean(status.enabled), busy, toggle));
    const hardBtn = el('button', 'ingest-hard-btn', 'Hard Restart');
    hardBtn.type = 'button';
    hardBtn.disabled = busy;
    hardBtn.setAttribute('aria-label', 'Hard restart ingest');
    hardBtn.addEventListener('click', () => hardRestart());
    titleRow.appendChild(hardBtn);
    let stateTone = 'is-stopped';
    let stateLabel = 'Off';
    if (status.enabled) {
      if (!status.running) {
        stateTone = 'is-warn';
        stateLabel = status.restartBackoffMs
          ? `Restart ${Math.ceil(status.restartBackoffMs / 1000)}s`
          : 'Starting';
      } else if (current?.stage === 'waiting' || p.atFrontier) {
        stateTone = 'is-idle';
        stateLabel = 'Waiting';
      } else {
        stateTone = 'is-running';
        stateLabel = 'Running';
      }
    } else if (status.running) {
      stateTone = 'is-warn';
      stateLabel = 'Stopping';
    }
    titleRow.appendChild(el('span', `ingest-chip ${stateTone}`, stateLabel));
    hero.appendChild(titleRow);

    if (document.activeElement !== seekInput) {
      seekInput.value = String(demoId);
    }

    const focus = el('div', 'ingest-focus');
    focus.appendChild(el('div', 'ingest-focus-id', `demo/${demoId}`));
    let detail = '';
    if (current?.stage === 'waiting') {
      const secs = status.idleUntil
        ? Math.max(0, Math.ceil((status.idleUntil - Date.now()) / 1000))
        : 0;
      detail =
        `Last ok ${p.lastSuccessId ?? 'none'}` + (secs ? ` · retry ${secs}s` : '');
    } else if (current?.stage === 'download') {
      detail = current.received
        ? `${bytes(current.received)}${current.totalBytes ? ` / ${bytes(current.totalBytes)}` : ''}`
        : current.downloadPhase || 'download';
    } else if (current?.map) {
      detail = `${current.stage}: ${current.map}${
        current.round ? ` ${current.round}/${current.totalRounds || '?'}` : ''
      }`;
    } else if (current?.stage) {
      detail = current.stage;
    } else if (status.enabled) {
      detail = `${p.loopsPerHour || 0}/h`;
    }
    if (detail) focus.appendChild(el('div', 'ingest-focus-detail', detail));
    hero.appendChild(focus);

    metrics.replaceChildren(
      metric('Rate', `${p.loopsPerHour || 0}/h`),
      metric('Left', String(p.atFrontier ? 0 : p.left ?? 0)),
      metric('Done', String(counts.cleaned ?? p.done ?? 0), 'ok'),
      metric('Failed', String(counts.failed_permanent ?? 0), 'bad'),
      metric('Dupes', String(counts.filtered_out ?? 0))
    );

    stages.replaceChildren();
    const active = stageIndex(current?.stage);
    for (let i = 0; i < STAGES.length; i++) {
      const s = STAGES[i];
      let cls = 'ingest-stage-step';
      if (i < active) cls += ' is-done';
      if (i === active) cls += ' is-active';
      if (s.id === 'waiting' && current?.stage === 'waiting') cls += ' is-wait';
      const step = el('div', cls);
      step.appendChild(el('span', 'ingest-stage-dot'));
      step.appendChild(el('span', 'ingest-stage-label', s.label));
      stages.appendChild(step);
      if (i < STAGES.length - 1) stages.appendChild(el('div', 'ingest-stage-line'));
    }

    barWrap.replaceChildren();
    const bar = el('div', 'ingest-bar');
    const fill = el('div', 'ingest-bar-fill');
    fill.style.width = `${Math.min(100, Math.max(0, p.percent || 0))}%`;
    bar.appendChild(fill);
    barWrap.appendChild(bar);
    barWrap.appendChild(
      el(
        'div',
        'ingest-progress-meta',
        `${p.done || 0} / ${p.total || 0} · ${p.percent || 0}%` +
          (p.lastSuccessId != null ? ` · last ${p.lastSuccessId}` : '')
      )
    );

    errorSlot.replaceChildren();
    if (status.lastError) {
      errorSlot.appendChild(el('div', 'ingest-error', status.lastError));
    }
  }

  function start() {
    refresh();
    consoleUi.start();
    probe.start();
    proxies.refresh();
    disk.refresh();
    timer = window.setInterval(() => {
      refresh();
      proxies.refresh();
      disk.refresh();
    }, STATUS_POLL_MS);
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = 0;
    consoleUi.stop();
    probe.stop();
  }

  root.addEventListener('admin:panel-hidden', stop);
  start();
  root._stopPolling = stop;
  return root;
}
