// ---------------------------------------------------------------------------
// site/replaysView.js
// The Replays library: upload demos, watch them parse, filter the rounds they
// produced, and open a selection in the viewer.
//
// Filtering runs against round names, never round contents, so the result
// count updates over a full library as fast as a directory listing.
// ---------------------------------------------------------------------------

import {
  deleteDemo,
  fetchDemos,
  fetchStatus,
  findRounds,
  reparseDemo,
  setAccount,
  setTokenProvider,
  uploadDemo,
  uploadImport
} from '../replays/api.js';
import { getSupabase } from '../lib/supabase.js';
import { ECONOMIES, MAPS, economyLabel } from '../replays/shared/roundId.js';
import { PACKAGE_EXT } from '../replays/shared/replayPackage.js';
import { formatBytes } from '../replays/tickStore.js';

const POLL_MS = 1500;

export function initReplaysView({ auth, escapeHtml }) {
  const uploadInput = document.getElementById('rp-file');
  const dropEl = document.getElementById('rp-drop');
  const quotaEl = document.getElementById('rp-quota');
  const listEl = document.getElementById('rp-list');
  const statusEl = document.getElementById('rp-status');
  const filtersEl = document.getElementById('rp-filters');
  const resultEl = document.getElementById('rp-result');
  const parserEl = document.getElementById('rp-parser');

  let demos = [];
  let rounds = [];
  let pollTimer = 0;
  let visible = false;
  let viewerModule = null;

  const filters = {
    maps: new Set(),
    economies: new Set(),
    teams: new Set(),
    players: new Set(),
    wonBy: '',
    roundMin: 1,
    roundMax: 99
  };

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', isError);
  }

  // ---- account ------------------------------------------------------------

  function syncAccount() {
    setAccount(auth?.user?.id || '');
  }

  // The backend verifies this token and takes the account id from it, so the
  // library a request reaches is decided by the session, not by the client.
  setTokenProvider(async () => {
    const sb = getSupabase();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data?.session?.access_token || null;
  });

  auth?.onChange?.(() => {
    syncAccount();
    if (visible) refresh();
  });
  syncAccount();

  // ---- quota + parser -----------------------------------------------------

  function renderQuota(usage) {
    if (!usage) return;
    const pctDemos = (usage.demos / usage.maxDemos) * 100;
    const pctBytes = (usage.bytes / usage.maxBytes) * 100;
    quotaEl.innerHTML = `
      <div class="rp-quota-row">
        <span class="rp-quota-label">Replays</span>
        <span class="rp-quota-value">${usage.demos} / ${usage.maxDemos}</span>
      </div>
      <div class="rp-meter"><span style="width:${Math.min(100, pctDemos)}%"></span></div>
      <div class="rp-quota-row">
        <span class="rp-quota-label">Storage</span>
        <span class="rp-quota-value">${formatBytes(usage.bytes)} / ${formatBytes(usage.maxBytes)}</span>
      </div>
      <div class="rp-meter"><span style="width:${Math.min(100, pctBytes)}%"></span></div>`;
  }

  function renderParser(parser) {
    if (!parser) return;
    // Local .aim4replay import always works; warn only that raw .dem upload
    // cannot be parsed on this host.
    parserEl.hidden = parser.available;
    if (!parser.available) {
      parserEl.textContent =
        `Server-side .dem parsing is offline (${parser.name}). ` +
        `Run tools\\parse-demo.bat on your PC (drag-and-drop GUI), then upload the ${PACKAGE_EXT} package.`;
    }
  }

  // ---- demo list ----------------------------------------------------------

  function demoRow(d) {
    const status = d.status || 'ready';
    const teams =
      d.team1 && d.team2
        ? `${escapeHtml(d.team1.name)} vs ${escapeHtml(d.team2.name)}`
        : escapeHtml(d.filename || d.id);
    const score = d.score ? `${d.score.team1} : ${d.score.team2}` : '';
    const mapName = d.mapName || (d.map ? MAPS[d.map]?.name : '') || '';

    let state = '';
    if (status === 'parsing') {
      const p = d.progress || {};
      state =
        p.stage === 'round' && p.total
          ? `Parsing round ${p.round} of ${p.total}`
          : p.stage === 'store'
            ? 'Writing rounds'
            : 'Parsing';
    } else if (status === 'error') {
      state = d.error || 'Parsing failed';
    } else {
      state = `${d.roundCount || 0} rounds`;
    }

    const pct =
      status === 'parsing' && d.progress?.total
        ? Math.round((d.progress.round / d.progress.total) * 100)
        : 0;

    return `
      <div class="rp-row ${status}" data-id="${escapeHtml(d.id)}">
        <div class="rp-row-main">
          <span class="rp-row-teams">${teams}</span>
          <span class="rp-row-meta">
            ${mapName ? `<span class="rp-tag">${escapeHtml(mapName)}</span>` : ''}
            ${score ? `<span class="rp-tag">${escapeHtml(score)}</span>` : ''}
            <span class="rp-tag">${formatBytes(d.sizeBytes || 0)}</span>
          </span>
          <span class="rp-row-state">${escapeHtml(state)}</span>
          ${status === 'parsing' ? `<span class="rp-progress"><span style="width:${pct}%"></span></span>` : ''}
        </div>
        <div class="rp-row-actions">
          ${status === 'ready' ? `<button type="button" class="btn btn-sm" data-open="${escapeHtml(d.id)}">Open</button>` : ''}
          ${status === 'error' ? `<button type="button" class="btn btn-sm" data-retry="${escapeHtml(d.id)}">Retry</button>` : ''}
          <button type="button" class="btn btn-sm" data-delete="${escapeHtml(d.id)}">Delete</button>
        </div>
      </div>`;
  }

  function renderDemos() {
    listEl.innerHTML = demos.length
      ? demos.map(demoRow).join('')
      : `<p class="view-empty">No replays yet. Upload a ${PACKAGE_EXT} package (or a .dem).</p>`;
  }

  listEl.addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    const del = e.target.closest('[data-delete]');
    const retry = e.target.closest('[data-retry]');

    if (open) {
      const demo = demos.find((d) => d.id === open.dataset.open);
      if (demo) {
        // A single match: its own rounds, in order, on the timeline.
        const list = (demo.rounds || []).map((r) => ({ ...r, map: demo.map }));
        launchViewer(list, 'timeline', `${demo.team1?.name || 'Team 1'} vs ${demo.team2?.name || 'Team 2'}`);
      }
      return;
    }
    if (retry) {
      await reparseDemo(retry.dataset.retry).catch((err) => setStatus(err.message, true));
      refresh();
      return;
    }
    if (del) {
      const demo = demos.find((d) => d.id === del.dataset.delete);
      const label = demo?.filename || 'this replay';
      if (!window.confirm(`Delete ${label} and every round parsed from it?`)) return;
      try {
        const res = await deleteDemo(del.dataset.delete);
        renderQuota(res.usage);
        setStatus('Replay deleted.');
      } catch (err) {
        setStatus(err.message, true);
      }
      refresh();
    }
  });

  // ---- upload -------------------------------------------------------------

  async function startUpload(file) {
    if (!file) return;
    const name = file.name || '';
    const isPackage = name.toLowerCase().endsWith(PACKAGE_EXT);
    const isDem = /\.dem$/i.test(name);
    if (!isPackage && !isDem) {
      setStatus(`Upload a ${PACKAGE_EXT} package (preferred) or a .dem file.`, true);
      return;
    }
    setStatus(`Uploading ${name}…`);
    dropEl.classList.add('busy');
    try {
      const upload = isPackage ? uploadImport : uploadDemo;
      const res = await upload(file, (pct) => {
        setStatus(`Uploading ${name}: ${pct}%`);
      });
      renderQuota(res.usage);
      setStatus(
        isPackage
          ? 'Import complete. Rounds are ready.'
          : 'Upload complete. Parsing started.'
      );
      refresh();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      dropEl.classList.remove('busy');
      uploadInput.value = '';
    }
  }

  uploadInput?.addEventListener('change', () => startUpload(uploadInput.files?.[0]));
  dropEl?.addEventListener('click', () => uploadInput.click());
  dropEl?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.classList.add('over');
  });
  dropEl?.addEventListener('dragleave', () => dropEl.classList.remove('over'));
  dropEl?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
    startUpload(e.dataTransfer?.files?.[0]);
  });

  // ---- filters ------------------------------------------------------------

  function knownTeams() {
    const out = new Map();
    for (const d of demos) {
      if (d.team1) out.set(d.team1.id, d.team1.name);
      if (d.team2) out.set(d.team2.id, d.team2.name);
    }
    return [...out.entries()];
  }

  function knownPlayers() {
    const out = new Map();
    for (const d of demos) {
      for (const p of d.players || []) out.set(p.id, p.name);
    }
    return [...out.entries()];
  }

  function renderFilters() {
    const chip = (group, value, label, active) =>
      `<button type="button" class="rp-chip${active ? ' active' : ''}" data-group="${group}" data-value="${escapeHtml(
        String(value)
      )}">${escapeHtml(label)}</button>`;

    const mapChips = Object.entries(MAPS)
      .map(([code, m]) => chip('maps', code, m.name, filters.maps.has(code)))
      .join('');
    const econChips = Object.entries(ECONOMIES)
      .map(([code, e]) => chip('economies', code, e.label, filters.economies.has(Number(code))))
      .join('');
    const teamChips = knownTeams()
      .map(([id, nameStr]) => chip('teams', id, nameStr, filters.teams.has(id)))
      .join('');
    const playerChips = knownPlayers()
      .map(([id, nameStr]) => chip('players', id, nameStr, filters.players.has(id)))
      .join('');
    const winnerChips = knownTeams()
      .map(([id, nameStr]) => chip('wonBy', id, nameStr, filters.wonBy === id))
      .join('');

    filtersEl.innerHTML = `
      <div class="rp-filter-group">
        <h4>Map</h4>
        <div class="rp-chips">${mapChips}</div>
      </div>
      <div class="rp-filter-group">
        <h4>Economy</h4>
        <div class="rp-chips">${econChips}</div>
      </div>
      ${teamChips ? `<div class="rp-filter-group"><h4>Team</h4><div class="rp-chips">${teamChips}</div></div>` : ''}
      ${winnerChips ? `<div class="rp-filter-group"><h4>Round won by</h4><div class="rp-chips">${winnerChips}</div></div>` : ''}
      ${playerChips ? `<div class="rp-filter-group"><h4>Players on the server</h4><div class="rp-chips">${playerChips}</div></div>` : ''}
      <div class="rp-filter-group">
        <h4>Round number</h4>
        <div class="rp-range">
          <input type="number" id="rp-round-min" class="site-input" min="1" max="99" value="${filters.roundMin}" />
          <span>to</span>
          <input type="number" id="rp-round-max" class="site-input" min="1" max="99" value="${filters.roundMax}" />
        </div>
      </div>
      <button type="button" class="btn btn-sm" id="rp-clear">Clear filters</button>`;

    filtersEl.querySelector('#rp-round-min')?.addEventListener('change', (e) => {
      filters.roundMin = Number(e.target.value) || 1;
      runQuery();
    });
    filtersEl.querySelector('#rp-round-max')?.addEventListener('change', (e) => {
      filters.roundMax = Number(e.target.value) || 99;
      runQuery();
    });
    filtersEl.querySelector('#rp-clear')?.addEventListener('click', () => {
      filters.maps.clear();
      filters.economies.clear();
      filters.teams.clear();
      filters.players.clear();
      filters.wonBy = '';
      filters.roundMin = 1;
      filters.roundMax = 99;
      renderFilters();
      runQuery();
    });
  }

  filtersEl.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-group]');
    if (!chip) return;
    const { group, value } = chip.dataset;
    if (group === 'wonBy') {
      filters.wonBy = filters.wonBy === value ? '' : value;
    } else {
      const set = filters[group];
      const v = group === 'economies' ? Number(value) : value;
      if (set.has(v)) set.delete(v);
      else set.add(v);
    }
    renderFilters();
    runQuery();
  });

  // ---- query + results ----------------------------------------------------

  function currentQuery() {
    return {
      maps: [...filters.maps],
      economies: [...filters.economies],
      teams: [...filters.teams],
      players: [...filters.players],
      wonBy: filters.wonBy || undefined,
      roundMin: filters.roundMin,
      roundMax: filters.roundMax
    };
  }

  let queryToken = 0;
  async function runQuery() {
    const token = ++queryToken;
    try {
      const res = await findRounds(currentQuery());
      if (token !== queryToken) return;
      rounds = res.rounds || [];
      renderResults();
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function renderResults() {
    if (!rounds.length) {
      resultEl.innerHTML = '<p class="view-empty">No rounds match these filters.</p>';
      return;
    }
    const byMap = {};
    for (const r of rounds) byMap[r.map] = (byMap[r.map] || 0) + 1;
    const tags = Object.entries(byMap)
      .map(([code, n]) => `<span class="rp-tag">${escapeHtml(MAPS[code]?.name || code)} ${n}</span>`)
      .join('');

    resultEl.innerHTML = `
      <div class="rp-result-head">
        <span class="rp-result-count">${rounds.length} round${rounds.length === 1 ? '' : 's'}</span>
        <span class="rp-result-tags">${tags}</span>
        <div class="rp-result-actions">
          <button type="button" class="btn btn-sm primary" id="rp-open-timeline">Timeline</button>
          <button type="button" class="btn btn-sm" id="rp-open-macro">Macro</button>
        </div>
      </div>
      <div class="rp-round-grid">
        ${rounds
          .slice(0, 200)
          .map(
            (r) => `
          <button type="button" class="rp-round-chip ${r.winner === 1 ? 'w1' : 'w2'}" data-file="${escapeHtml(r.file)}"
            title="${escapeHtml(
              `${MAPS[r.map]?.name || r.map} round ${r.round}: ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}`
            )}">
            <span class="rp-chip-map">${escapeHtml(r.map)}</span>
            <span class="rp-chip-round">${String(r.round).padStart(2, '0')}</span>
          </button>`
          )
          .join('')}
      </div>
      ${rounds.length > 200 ? `<p class="rp-more">Showing the first 200 of ${rounds.length}. All of them open in the viewer.</p>` : ''}`;

    resultEl.querySelector('#rp-open-timeline')?.addEventListener('click', () => {
      launchViewer(rounds, 'timeline', queryTitle());
    });
    resultEl.querySelector('#rp-open-macro')?.addEventListener('click', () => {
      launchViewer(rounds, 'macro', queryTitle());
    });
    resultEl.querySelectorAll('[data-file]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const one = rounds.filter((r) => r.file === btn.dataset.file);
        launchViewer(one, 'timeline', queryTitle());
      });
    });
  }

  function queryTitle() {
    const parts = [];
    if (filters.maps.size) parts.push([...filters.maps].map((c) => MAPS[c]?.name || c).join(', '));
    if (filters.economies.size) parts.push([...filters.economies].map(economyLabel).join(', '));
    return parts.join(' · ') || 'All rounds';
  }

  /** The viewer is a heavy module: it loads the first time one is opened. */
  async function launchViewer(list, mode, title) {
    if (!list.length) return;
    setStatus('');
    if (!viewerModule) {
      viewerModule = await import('../replays/viewer/viewerApp.js');
    }
    viewerModule.openViewer({ rounds: list, mode, title, escapeHtml });
  }

  // ---- polling ------------------------------------------------------------

  async function refresh() {
    try {
      const [status, list] = await Promise.all([fetchStatus(), fetchDemos()]);
      setLocked(false);
      renderParser(status.parser);
      renderQuota(list.usage || status.usage);
      demos = list.demos || [];
      renderDemos();
      renderFilters();
      await runQuery();
    } catch (err) {
      if (err.status === 401) {
        setLocked(true);
        listEl.innerHTML = `<p class="view-empty">${escapeHtml(err.message)}</p>`;
        filtersEl.innerHTML = '';
        resultEl.innerHTML = '';
        quotaEl.innerHTML = '';
        return;
      }
      setLocked(false);
      listEl.innerHTML = `<p class="view-empty">Could not reach the replay service. ${escapeHtml(
        err.message
      )}</p>`;
    }
  }

  /** A signed-out visitor has no library, so uploading is not offered. */
  function setLocked(locked) {
    dropEl.hidden = locked;
    if (locked) setStatus('');
  }

  function startPolling() {
    stopPolling();
    // Only poll while something is actually mid-parse.
    pollTimer = window.setInterval(() => {
      if (!visible) return;
      if (demos.some((d) => d.status === 'parsing')) refresh();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  return {
    onShow() {
      visible = true;
      refresh();
      startPolling();
    },
    onHide() {
      visible = false;
      stopPolling();
    }
  };
}
