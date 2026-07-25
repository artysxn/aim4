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
  deletePlaylist,
  fetchDemos,
  fetchPlaylists,
  fetchRoundMeta,
  fetchStatus,
  findRounds,
  renameDemoTeams,
  reparseDemo,
  uploadDemo,
  uploadImport
} from '../replays/api.js';
import { ECONOMIES, MAPS, economyLabel } from '../replays/shared/roundId.js';
import { PACKAGE_EXT } from '../replays/shared/replayPackage.js';
import { formatBytes } from '../replays/tickStore.js';

const POLL_MS = 1500;

export function initReplaysView({ escapeHtml }) {
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
  /** Round name already opened from the URL, so it opens once per link. */
  let openedRound = '';

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

  // ---- quota + parser -----------------------------------------------------

  function renderQuota(usage) {
    if (!usage) return;
    const pctDemos = (usage.demos / usage.maxDemos) * 100;
    const pctBytes = (usage.bytes / usage.maxBytes) * 100;
    quotaEl.innerHTML = `
      <div class="rp-quota-row">
        <span class="rp-quota-label">Demos (shared)</span>
        <span class="rp-quota-value">${usage.demos} / ${usage.maxDemos}</span>
      </div>
      <div class="rp-meter"><span style="width:${Math.min(100, pctDemos)}%"></span></div>
      <div class="rp-quota-row">
        <span class="rp-quota-label">Storage (shared)</span>
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

  function initials(name) {
    const s = String(name || '?').trim();
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase() || '?';
  }

  function formatWhen(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function demoRow(d) {
    const status = d.status || 'ready';
    const t1 = d.team1?.name || 'Team 1';
    const t2 = d.team2?.name || 'Team 2';
    const score =
      d.score && status === 'ready' ? `${d.score.team1} - ${d.score.team2}` : status === 'ready' ? '—' : '';
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
    }

    const pct =
      status === 'parsing' && d.progress?.total
        ? Math.round((d.progress.round / d.progress.total) * 100)
        : 0;

    return `
      <div class="rp-row ${status}" data-id="${escapeHtml(d.id)}">
        <div class="rp-row-when">${escapeHtml(formatWhen(d.uploadedAt || d.parsedAt))}</div>
        <div class="rp-row-match">
          <div class="rp-side home">
            <span class="rp-crest">${escapeHtml(initials(t1))}</span>
            <span class="rp-side-name">${escapeHtml(t1)}</span>
          </div>
          <div class="rp-score">${escapeHtml(score || (status === 'ready' ? '0 - 0' : '…'))}</div>
          <div class="rp-side away">
            <span class="rp-crest">${escapeHtml(initials(t2))}</span>
            <span class="rp-side-name">${escapeHtml(t2)}</span>
          </div>
        </div>
        <div class="rp-row-actions">
          ${
            status === 'ready'
              ? `<button type="button" class="rp-btn-replay" data-open="${escapeHtml(d.id)}">▶ Replay</button>`
              : ''
          }
          ${
            status === 'error'
              ? `<button type="button" class="btn btn-sm" data-retry="${escapeHtml(d.id)}">Retry</button>`
              : ''
          }
          ${
            status === 'ready'
              ? `<button type="button" class="rp-btn-icon" data-rename="${escapeHtml(d.id)}" title="Rename teams">Aa</button>`
              : ''
          }
          <button type="button" class="rp-btn-icon danger" data-delete="${escapeHtml(d.id)}" title="Delete">
            <svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>
          </button>
        </div>
        <div class="rp-maps">
          ${mapName ? `<span class="rp-map-pill">${escapeHtml(mapName)}</span>` : ''}
          ${status === 'ready' && d.roundCount ? `<span class="rp-map-pill">${d.roundCount} rounds</span>` : ''}
        </div>
        ${
          state
            ? `<div class="rp-row-state">${escapeHtml(state)}${
                status === 'parsing' ? `<span class="rp-progress"><span style="width:${pct}%"></span></span>` : ''
              }</div>`
            : ''
        }
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
    const rename = e.target.closest('[data-rename]');

    if (open) {
      const demo = demos.find((d) => d.id === open.dataset.open);
      if (demo) {
        const list = (demo.rounds || []).map((r) => ({
          ...r,
          map: demo.map,
          tickRate: r.tickRate || demo.tickRate
        }));
        launchViewer(list, 'timeline', `${demo.team1?.name || 'Team 1'} vs ${demo.team2?.name || 'Team 2'}`);
      }
      return;
    }
    if (rename) {
      const demo = demos.find((d) => d.id === rename.dataset.rename);
      if (demo) await promptTeamNames(demo);
      return;
    }
    if (retry) {
      await reparseDemo(retry.dataset.retry).catch((err) => setStatus(err.message, true));
      refresh();
      return;
    }
    if (del) {
      const demo = demos.find((d) => d.id === del.dataset.delete);
      const label = demo?.team1 && demo?.team2
        ? `${demo.team1.name} vs ${demo.team2.name}`
        : demo?.filename || 'this replay';
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

  // ---- team naming --------------------------------------------------------

  function promptTeamNames(demo) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'rp-name-dialog';
      overlay.innerHTML = `
        <div class="rp-name-card" role="dialog" aria-label="Name teams">
          <h3>Name the teams</h3>
          <p>These names show up in the match list and the viewer. Round ids stay the same.</p>
          <div class="rp-name-fields">
            <label>Team 1
              <input type="text" id="rp-name-t1" maxlength="48" value="${escapeHtml(demo.team1?.name || '')}" />
            </label>
            <label>Team 2
              <input type="text" id="rp-name-t2" maxlength="48" value="${escapeHtml(demo.team2?.name || '')}" />
            </label>
          </div>
          <div class="rp-name-actions">
            <button type="button" class="btn btn-sm" data-skip>Skip</button>
            <button type="button" class="btn btn-sm primary" data-save>Save</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const t1 = overlay.querySelector('#rp-name-t1');
      const t2 = overlay.querySelector('#rp-name-t2');
      t1.focus();
      t1.select();

      const close = () => {
        overlay.remove();
        resolve();
      };

      overlay.querySelector('[data-skip]').addEventListener('click', close);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      overlay.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          const res = await renameDemoTeams(demo.id, t1.value, t2.value);
          renderQuota(res.usage);
          setStatus('Team names saved.');
          await refresh();
        } catch (err) {
          setStatus(err.message, true);
        }
        close();
      });
    });
  }

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
      await refresh();
      if (isPackage && res.demo) {
        await promptTeamNames(res.demo);
      }
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
            (r) => {
              const side = r.winner === 1 ? 'w1' : 'w2';
              return `
          <button type="button" class="rp-round-chip ${side}" data-file="${escapeHtml(r.file)}"
            title="${escapeHtml(
              `${MAPS[r.map]?.name || r.map} round ${r.round}: ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}`
            )}">
            <span class="rp-chip-map">${escapeHtml(r.map)}</span>
            <span class="rp-chip-round">${String(r.round).padStart(2, '0')}</span>
          </button>`;
            }
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

  // ---- playlists page -----------------------------------------------------

  const playlistsBtn = document.getElementById('rp-playlists-btn');
  const libraryEl = document.getElementById('rp-library');
  const playlistsPageEl = document.getElementById('rp-playlists-page');
  const playlistsBody = document.getElementById('rp-pl-body');
  const playlistsBack = document.getElementById('rp-playlists-back');
  const pageTitleEl = document.getElementById('page-title');

  let onPlaylistsPage = false;
  let playlistLists = [];

  /**
   * A playlist stores round names only, so it is turned back into rounds by
   * matching against one collector call. Rounds that have since been deleted
   * simply do not come back, which is why a playlist can never point at a
   * round that no longer plays.
   */
  async function roundsForPlaylist(playlist) {
    const wanted = playlist.rounds || [];
    if (!wanted.length) return [];
    const res = await findRounds({}, 5000);
    const byFile = new Map((res.rounds || []).map((r) => [r.file, r]));
    return wanted.map((f) => byFile.get(f)).filter(Boolean);
  }

  function renderPlaylistsPage() {
    if (!playlistsBody) return;
    if (!playlistLists.length) {
      playlistsBody.innerHTML =
        '<p class="view-empty">No playlists yet. Open a round and use the bookmark button to start one.</p>';
      return;
    }
    playlistsBody.innerHTML = `
      <table class="rp-playlist-table">
        <thead>
          <tr><th>Playlist</th><th>Last modified</th><th>Rounds</th><th></th></tr>
        </thead>
        <tbody>
          ${playlistLists
            .map(
              (p) => `
            <tr data-id="${escapeHtml(p.id)}">
              <td class="rp-pl-name">${escapeHtml(p.name)}</td>
              <td class="rp-pl-when">${escapeHtml(formatWhen(p.updatedAt || p.createdAt))}</td>
              <td class="rp-pl-count">${(p.rounds || []).length}</td>
              <td class="rp-pl-actions">
                <button type="button" class="rp-btn-replay" data-play="${escapeHtml(p.id)}">▶ Replay</button>
                <button type="button" class="rp-btn-icon danger" data-drop="${escapeHtml(p.id)}" title="Delete playlist">
                  <svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>
                </button>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  async function loadPlaylistsPage() {
    if (!playlistsBody) return;
    playlistsBody.innerHTML = '<p class="view-empty">Loading…</p>';
    try {
      playlistLists = await fetchPlaylists();
      renderPlaylistsPage();
    } catch (err) {
      playlistsBody.innerHTML = `<p class="view-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  function setPlaylistsPage(on, { push = false } = {}) {
    onPlaylistsPage = on;
    if (libraryEl) libraryEl.hidden = on;
    if (playlistsPageEl) playlistsPageEl.hidden = !on;
    if (playlistsBtn) playlistsBtn.hidden = on || !visible;
    if (pageTitleEl) pageTitleEl.textContent = on ? 'Playlists' : 'Replays';
    document.title = on ? 'AIM4.io - Playlists' : 'AIM4.io - Replays';
    const path = on ? '/replays/playlists' : '/replays';
    if (push && window.location.pathname.replace(/\/+$/, '') !== path) {
      window.history.pushState({ view: 'replays', playlists: on }, '', path);
    }
    if (on) loadPlaylistsPage();
  }

  playlistsBtn?.addEventListener('click', () => setPlaylistsPage(true, { push: true }));
  playlistsBack?.addEventListener('click', () => setPlaylistsPage(false, { push: true }));

  playlistsBody?.addEventListener('click', async (e) => {
    const play = e.target.closest('[data-play]');
    const drop = e.target.closest('[data-drop]');
    if (play) {
      const pl = playlistLists.find((p) => p.id === play.dataset.play);
      if (!pl) return;
      play.disabled = true;
      const list = await roundsForPlaylist(pl).catch(() => []);
      play.disabled = false;
      if (!list.length) {
        setStatus('That playlist has no rounds left to play.', true);
        return;
      }
      launchViewer(list, 'timeline', pl.name);
      return;
    }
    if (drop) {
      const pl = playlistLists.find((p) => p.id === drop.dataset.drop);
      if (!pl || !window.confirm(`Delete the playlist "${pl.name}"?`)) return;
      try {
        playlistLists = await deletePlaylist(pl.id);
        renderPlaylistsPage();
      } catch (err) {
        setStatus(err.message, true);
      }
    }
  });

  // ---- deep links ---------------------------------------------------------

  /** /replays?round=<name> opens straight into that round. */
  async function openSharedRound(file) {
    if (!file) return;
    try {
      const meta = await fetchRoundMeta(file);
      if (!meta) throw new Error('That round is not in this library.');
      const title = `${meta.team1?.name || 'Team 1'} vs ${meta.team2?.name || 'Team 2'}`;
      launchViewer([{ ...meta, file }], 'timeline', title);
    } catch (err) {
      setStatus(`Could not open that round. ${err.message}`, true);
    }
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
      setLocked(false);
      listEl.innerHTML = `<p class="view-empty">Could not reach the replay service. ${escapeHtml(
        err.message
      )}</p>`;
    }
  }

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
    onShow(params = {}) {
      visible = true;
      const wantPlaylists =
        params.playlists === '1' ||
        params.playlists === true ||
        window.location.pathname.replace(/\/+$/, '') === '/replays/playlists';
      setPlaylistsPage(wantPlaylists, { push: false });
      if (!wantPlaylists) {
        if (playlistsBtn) playlistsBtn.hidden = false;
        refresh();
        startPolling();
      } else {
        stopPolling();
      }
      // Only on the first arrival: a viewer close rewrites the URL back to
      // /replays, and re-entering the view must not reopen what was closed.
      if (!wantPlaylists && params.round && params.round !== openedRound) {
        openedRound = params.round;
        openSharedRound(params.round);
      }
    },
    onHide() {
      visible = false;
      if (playlistsBtn) playlistsBtn.hidden = true;
      stopPolling();
    }
  };
}
