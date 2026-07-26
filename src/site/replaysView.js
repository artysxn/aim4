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
import {
  ECONOMIES,
  MAPS,
  economyLabel,
  mapIcon,
  parseRoundId,
  winningSide
} from '../replays/shared/roundId.js';
import { collectRounds, matchesQuery, splitStoredName } from '../replays/shared/roundFilter.js';
import { openingSituation, SITUATION_OPTIONS } from '../replays/shared/openingSituation.js';
import { findRoundDecided } from '../replays/coach/roundDecided.js';
import { PACKAGE_EXT } from '../replays/shared/replayPackage.js';
import { formatBytes } from '../replays/tickStore.js';
import { createStatsPanel } from '../replays/stats/statsPanel.js';
import commentsIcon from '../icons/demos_comments.svg?raw';
import bookmarkIcon from '../icons/demos_bookmarks_added.svg?raw';

const POLL_MS = 1500;

function svgIcon(raw) {
  return raw.replace('<svg', '<svg class="rp-mark-svg" aria-hidden="true"');
}

export function initReplaysView({ escapeHtml }) {
  const uploadInput = document.getElementById('rp-file');
  const dropEl = document.getElementById('rp-drop');
  const quotaEl = document.getElementById('rp-quota');
  const statusEl = document.getElementById('rp-status');
  const filtersEl = document.getElementById('rp-filters');
  const resultEl = document.getElementById('rp-result');
  const parserEl = document.getElementById('rp-parser');
  const headActions = document.getElementById('rp-head-actions');
  const uploadBtn = document.getElementById('rp-upload-btn');
  const playlistsBtn = document.getElementById('rp-playlists-btn');
  const statsBtn = document.getElementById('rp-stats-btn');
  const libraryBtn = document.getElementById('rp-library-btn');
  const libraryEl = document.getElementById('rp-library');
  const uploadPageEl = document.getElementById('rp-upload-page');
  const playlistsPageEl = document.getElementById('rp-playlists-page');
  const playlistsBody = document.getElementById('rp-pl-body');
  const statsPageEl = document.getElementById('rp-stats-page');
  const statsBodyEl = document.getElementById('rp-stats-body');
  const pageTitleEl = document.getElementById('page-title');

  let demos = [];
  let rounds = [];
  /** @type {Set<string>} */
  let notedFiles = new Set();
  /** @type {Set<string>} rounds that appear in any playlist */
  let bookmarkedFiles = new Set();
  /** @type {Set<string>} selected round files */
  let selectedFiles = new Set();
  /** @type {Set<string>} collapsed demo ids */
  /** Demo ids the user has expanded; everything else stays closed. */
  let expandedDemos = new Set();
  let pollTimer = 0;
  let visible = false;
  let viewerModule = null;
  /** Round name already opened from the URL, so it opens once per link. */
  let openedRound = '';
  /** @type {'library' | 'upload' | 'playlists' | 'stats'} */
  let subpage = 'library';
  /** Built on first use; the payload it holds is reused across scopes. */
  let statsPanel = null;
  /** @type {{demos?: string[], files?: string[], title?: string}} */
  let statsScope = {};
  let teamSearch = '';
  let playerSearch = '';
  let mapMenuOpen = false;
  /** @type {{ key: string, name: string, shortIds: string[] }[]} */
  let teamClusters = [];
  /** @type {Map<string, { key: string, name: string, shortIds: string[] }>} */
  let teamClustersByKey = new Map();
  let playlistLists = [];

  const filters = {
    maps: new Set(),
    teams: new Set(),
    players: new Set(),
    /** @type {''|'selected'|'opponent'} */
    wonByMode: '',
    /** @type {number|null} */
    econA: null,
    /** @type {number|null} */
    econB: null,
    hasAwpA: false,
    hasAwpB: false,
    /** Advanced (meta) filters */
    /** @type {''|'T'|'CT'} */
    side: '',
    /** @type {Set<string>} */
    situations: new Set(),
    afterplant: false,
    /** @type {Set<string>} early|mid|late */
    decidedPhases: new Set()
  };
  let advancedOpen = false;
  /** @type {Map<string, object|null>} */
  const roundMetaCache = new Map();

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', isError);
  }

  // ---- quota + parser -----------------------------------------------------

  function renderQuota(usage) {
    if (!usage || !quotaEl) return;
    const pctBytes = usage.maxBytes ? (usage.bytes / usage.maxBytes) * 100 : 0;
    quotaEl.innerHTML = `
      <div class="rp-quota-row">
        <span class="rp-quota-label">Storage (shared)</span>
        <span class="rp-quota-value">${formatBytes(usage.bytes)} / ${formatBytes(usage.maxBytes)}</span>
      </div>
      <div class="rp-meter"><span style="width:${Math.min(100, pctBytes)}%"></span></div>`;
  }

  function renderParser(parser) {
    if (!parser || !parserEl) return;
    // Local .aim4replay import always works; warn only that raw .dem upload
    // cannot be parsed on this host.
    parserEl.hidden = parser.available;
    if (!parser.available) {
      parserEl.textContent =
        `Server-side .dem parsing is offline (${parser.name}). ` +
        `Run tools\\parse-demo.bat on your PC (drag-and-drop GUI), then upload the ${PACKAGE_EXT} package.`;
    }
  }

  // ---- demo list helpers --------------------------------------------------

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
    const yy = String(d.getFullYear()).slice(-2);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${yy}`;
  }

  function matchBlockHtml(t1, t2, score) {
    return `
      <div class="rp-row-match">
        <div class="rp-side home">
          <span class="rp-crest">${escapeHtml(initials(t1))}</span>
          <span class="rp-side-name">${escapeHtml(t1)}</span>
        </div>
        <div class="rp-score">${escapeHtml(score)}</div>
        <div class="rp-side away">
          <span class="rp-crest">${escapeHtml(initials(t2))}</span>
          <span class="rp-side-name">${escapeHtml(t2)}</span>
        </div>
      </div>`;
  }

  function demoScoreText(d) {
    const status = d?.status || 'ready';
    if (d?.score && status === 'ready') return `${d.score.team1} - ${d.score.team2}`;
    if (status === 'ready') return '0 - 0';
    return '…';
  }

  function deleteIconHtml() {
    return `<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>`;
  }

  function statsIconHtml() {
    return `<svg viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M640-160v-280h120v280H640Zm-220 0v-640h120v640H420Zm-220 0v-440h120v440H200Z"/></svg>`;
  }

  function playIconHtml() {
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7L8 5z"/></svg>`;
  }

  function mapIconHtml(mapCode, mapName) {
    const src = mapIcon(mapCode);
    if (!src) {
      return mapName
        ? `<span class="rp-map-fallback" title="${escapeHtml(mapName)}">${escapeHtml(mapName)}</span>`
        : '';
    }
    const label = mapName || MAPS[mapCode]?.name || mapCode || 'Map';
    return `<img class="rp-map-icon" src="${escapeHtml(src)}" alt="${escapeHtml(
      label
    )}" title="${escapeHtml(label)}" width="28" height="28" loading="lazy" />`;
  }

  function rowMetaHtml(when, mapCode, mapName) {
    return `
      <div class="rp-row-meta">
        <span class="rp-row-when">${escapeHtml(when)}</span>
        ${mapIconHtml(mapCode, mapName)}
      </div>`;
  }

  function demoActionsHtml(d) {
    const status = d.status || 'ready';
    const id = escapeHtml(d.id);
    return `
      <div class="rp-row-actions">
        ${status === 'error' ? `<button type="button" class="btn btn-sm" data-retry="${id}">Retry</button>` : ''}
        ${
          status === 'ready'
            ? `<button type="button" class="rp-btn-icon" data-rename="${id}" title="Rename teams">Aa</button>`
            : ''
        }
        <button type="button" class="rp-btn-icon danger" data-delete="${id}" title="Delete">
          ${deleteIconHtml()}
        </button>
        ${
          status === 'ready'
            ? `<button type="button" class="rp-btn-play" data-open="${id}" title="Replay">${playIconHtml()}</button>`
            : ''
        }
      </div>`;
  }

  function demoRow(d) {
    const status = d.status || 'ready';
    const t1 = d.team1?.name || 'Team 1';
    const t2 = d.team2?.name || 'Team 2';
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
        ${rowMetaHtml(formatWhen(d.uploadedAt || d.parsedAt), d.map, mapName)}
        ${matchBlockHtml(t1, t2, demoScoreText(d))}
        ${demoActionsHtml(d)}
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
    // Demos live in the results column (expandable groups + parsing rows).
    renderResults();
  }

  async function handleDemoAction(target) {
    const open = target.closest('[data-open]');
    const del = target.closest('[data-delete]');
    const retry = target.closest('[data-retry]');
    const rename = target.closest('[data-rename]');
    const demoStats = target.closest('[data-demo-stats]');

    if (open) {
      const demo = demos.find((d) => d.id === open.dataset.open);
      if (demo) {
        const list = (demo.rounds || []).map((r) => ({
          ...r,
          map: demo.map,
          tickRate: r.tickRate || demo.tickRate
        }));
        // statsDemoId marks a full unspliced match: live scoreboard + coach.
        // Round picks / playlists omit it so those tools stay unavailable.
        launchViewer(
          list,
          'timeline',
          `${demo.team1?.name || 'Team 1'} vs ${demo.team2?.name || 'Team 2'}`,
          { statsDemoId: demo.id }
        );
      }
      return true;
    }
    if (demoStats) {
      const demo = demos.find((d) => d.id === demoStats.dataset.demoStats);
      if (demo) {
        showStats({
          demos: [demo.id],
          title: `${demo.team1?.name || 'Team 1'} vs ${demo.team2?.name || 'Team 2'}`
        });
      }
      return true;
    }
    if (rename) {
      const demo = demos.find((d) => d.id === rename.dataset.rename);
      if (demo) await promptTeamNames(demo);
      return true;
    }
    if (retry) {
      await reparseDemo(retry.dataset.retry).catch((err) => setStatus(err.message, true));
      refresh();
      return true;
    }
    if (del) {
      const demo = demos.find((d) => d.id === del.dataset.delete);
      const label =
        demo?.team1 && demo?.team2
          ? `${demo.team1.name} vs ${demo.team2.name}`
          : demo?.filename || 'this replay';
      if (!window.confirm(`Delete ${label} and every round parsed from it?`)) return true;
      try {
        const res = await deleteDemo(del.dataset.delete);
        renderQuota(res.usage);
        setStatus('Replay deleted.');
      } catch (err) {
        setStatus(err.message, true);
      }
      refresh();
      return true;
    }
    return false;
  }

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

  function pickUploadFiles(fileList) {
    const files = [...(fileList || [])];
    const ok = [];
    const skipped = [];
    for (const file of files) {
      const name = file.name || '';
      const isPackage = name.toLowerCase().endsWith(PACKAGE_EXT);
      const isDem = /\.dem$/i.test(name);
      if (isPackage || isDem) ok.push(file);
      else skipped.push(name || 'unnamed');
    }
    return { ok, skipped };
  }

  async function startUpload(fileList) {
    const { ok, skipped } = pickUploadFiles(fileList);
    if (!ok.length) {
      setStatus(`Upload ${PACKAGE_EXT} packages (preferred) or .dem files.`, true);
      return;
    }
    if (skipped.length) {
      setStatus(`Skipped ${skipped.length} unsupported file${skipped.length === 1 ? '' : 's'}.`, true);
    }

    dropEl?.classList.add('busy');
    let imported = 0;
    let demUploads = 0;
    const namingQueue = [];
    try {
      for (let i = 0; i < ok.length; i++) {
        const file = ok[i];
        const name = file.name || `file ${i + 1}`;
        const isPackage = name.toLowerCase().endsWith(PACKAGE_EXT);
        const upload = isPackage ? uploadImport : uploadDemo;
        const label = ok.length > 1 ? `(${i + 1}/${ok.length}) ` : '';
        setStatus(`Uploading ${label}${name}…`);
        const res = await upload(file, (pct) => {
          setStatus(`Uploading ${label}${name}: ${pct}%`);
        });
        renderQuota(res.usage);
        if (isPackage) {
          imported++;
          if (res.demo) namingQueue.push(res.demo);
        } else {
          demUploads++;
        }
      }

      const parts = [];
      if (imported) {
        parts.push(
          imported === 1 ? '1 package imported.' : `${imported} packages imported.`
        );
      }
      if (demUploads) {
        parts.push(
          demUploads === 1
            ? '1 .dem uploaded; parsing started.'
            : `${demUploads} .dem files uploaded; parsing started.`
        );
      }
      setStatus(parts.join(' ') || 'Upload complete.');
      await refresh();

      for (const demo of namingQueue) {
        await promptTeamNames(demo);
      }
    } catch (err) {
      setStatus(err.message, true);
      await refresh();
    } finally {
      dropEl?.classList.remove('busy');
      if (uploadInput) uploadInput.value = '';
    }
  }

  uploadInput?.addEventListener('change', () => startUpload(uploadInput.files));
  dropEl?.addEventListener('click', () => uploadInput?.click());
  dropEl?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropEl.classList.add('over');
  });
  dropEl?.addEventListener('dragleave', () => dropEl.classList.remove('over'));
  dropEl?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
    startUpload(e.dataTransfer?.files);
  });

  // ---- team clustering ----------------------------------------------------

  function clusterTeams(demoList) {
    /** @type {{ shortId: string, name: string, players: Set<string> }[]} */
    const appearances = [];
    for (const d of demoList) {
      for (const side of [1, 2]) {
        const team = side === 1 ? d.team1 : d.team2;
        if (!team?.id) continue;
        const players = new Set();
        for (const p of d.players || []) {
          if (Number(p.team) !== side) continue;
          const key = p.steamId || p.id;
          if (key) players.add(String(key));
        }
        appearances.push({
          shortId: String(team.id),
          name: String(team.name || ''),
          players
        });
      }
    }
    if (!appearances.length) return [];

    const parent = appearances.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const byNormName = new Map();
    for (let i = 0; i < appearances.length; i++) {
      const norm = appearances[i].name.trim().toLowerCase();
      if (!norm) continue;
      if (byNormName.has(norm)) union(byNormName.get(norm), i);
      else byNormName.set(norm, i);
    }

    for (let i = 0; i < appearances.length; i++) {
      for (let j = i + 1; j < appearances.length; j++) {
        if (find(i) === find(j)) continue;
        const a = appearances[i].players;
        const b = appearances[j].players;
        if (a.size < 3 || b.size < 3) continue;
        let shared = 0;
        for (const p of a) {
          if (b.has(p)) {
            shared++;
            if (shared >= 3) {
              union(i, j);
              break;
            }
          }
        }
      }
    }

    const groups = new Map();
    for (let i = 0; i < appearances.length; i++) {
      const root = find(i);
      let g = groups.get(root);
      if (!g) {
        g = { shortIds: new Set(), nameCounts: new Map() };
        groups.set(root, g);
      }
      g.shortIds.add(appearances[i].shortId);
      const name = appearances[i].name.trim();
      if (name) g.nameCounts.set(name, (g.nameCounts.get(name) || 0) + 1);
    }

    const clusters = [];
    for (const g of groups.values()) {
      const shortIds = [...g.shortIds].sort();
      let bestName = shortIds[0];
      let bestCount = -1;
      for (const [name, count] of g.nameCounts) {
        if (count > bestCount || (count === bestCount && name.localeCompare(bestName) < 0)) {
          bestName = name;
          bestCount = count;
        }
      }
      clusters.push({
        key: shortIds.join('|'),
        name: bestName || shortIds[0],
        shortIds
      });
    }
    clusters.sort((a, b) => a.name.localeCompare(b.name));
    return clusters;
  }

  function rebuildTeamClusters() {
    teamClusters = clusterTeams(demos);
    teamClustersByKey = new Map(teamClusters.map((c) => [c.key, c]));
    for (const key of [...filters.teams]) {
      if (!teamClustersByKey.has(key)) filters.teams.delete(key);
    }
    if (!filters.teams.size) filters.wonByMode = '';
  }

  function knownPlayers() {
    const out = new Map();
    for (const d of demos) {
      for (const p of d.players || []) {
        if (p.id) out.set(p.id, p.name || p.id);
      }
    }
    return [...out.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }

  function econSelectHtml(id, selected) {
    const opts = [
      `<option value=""${selected == null ? ' selected' : ''}>Any</option>`,
      ...Object.entries(ECONOMIES).map(
        ([code, e]) =>
          `<option value="${code}"${selected === Number(code) ? ' selected' : ''}>${escapeHtml(
            e.label
          )}</option>`
      )
    ];
    return `<select id="${id}" class="site-input rp-econ-select" aria-label="${
      id === 'rp-econ-a' ? 'Team 1 economy' : 'Team 2 economy'
    }">${opts.join('')}</select>`;
  }

  function hasAwpCheckHtml(id, checked) {
    return `<label class="rp-awp-toggle${checked ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  function selectedChipsHtml(group, items) {
    if (!items.length) return '';
    return `<div class="rp-chips rp-selected-chips">${items
      .map(
        ([value, label]) =>
          `<button type="button" class="rp-chip active" data-group="${group}" data-value="${escapeHtml(
            String(value)
          )}" title="Remove">${escapeHtml(label)}</button>`
      )
      .join('')}</div>`;
  }

  function typeaheadMenuHtml(group, options, query) {
    const needle = String(query || '')
      .trim()
      .toLowerCase();
    if (!needle) return '';
    const hits = options.filter(([, label]) => String(label).toLowerCase().includes(needle));
    if (!hits.length) {
      return `<div class="rp-typeahead-menu"><p class="rp-typeahead-empty">No matches</p></div>`;
    }
    return `<div class="rp-typeahead-menu">${hits
      .map(
        ([value, label]) =>
          `<button type="button" class="rp-typeahead-option" data-group="${group}" data-value="${escapeHtml(
            String(value)
          )}">${escapeHtml(label)}</button>`
      )
      .join('')}</div>`;
  }

  function mapToggleLabel() {
    const n = filters.maps.size;
    if (!n) return 'Any map';
    if (n === 1) {
      const code = [...filters.maps][0];
      return MAPS[code]?.name || code;
    }
    return `${n} maps`;
  }

  function mapMenuHtml() {
    const items = Object.entries(MAPS)
      .map(
        ([code, m]) => `
      <label class="rp-check-option">
        <input type="checkbox" data-map="${escapeHtml(code)}" ${
          filters.maps.has(code) ? 'checked' : ''
        } />
        <span>${escapeHtml(m.name)}</span>
      </label>`
      )
      .join('');
    return `
      <div class="rp-multi${mapMenuOpen ? ' open' : ''}" id="rp-map-multi">
        <button type="button" class="site-input rp-multi-toggle" id="rp-map-toggle"
          aria-expanded="${mapMenuOpen ? 'true' : 'false'}">${escapeHtml(mapToggleLabel())}</button>
        <div class="rp-multi-menu" ${mapMenuOpen ? '' : 'hidden'}>${items}</div>
      </div>`;
  }

  function wonBySelectHtml() {
    const hasTeams = filters.teams.size > 0;
    const mode = filters.wonByMode;
    return `
      <select id="rp-won-by" class="site-input rp-econ-select" ${hasTeams ? '' : 'disabled'}
        aria-label="Round won by" title="${hasTeams ? '' : 'Select a team first'}">
        <option value=""${mode === '' ? ' selected' : ''}>Any</option>
        <option value="selected"${mode === 'selected' ? ' selected' : ''}>Selected team</option>
        <option value="opponent"${mode === 'opponent' ? ' selected' : ''}>Opponent</option>
      </select>`;
  }

  function renderFilters() {
    if (!filtersEl) return;

    const teamOptions = teamClusters
      .filter((c) => !filters.teams.has(c.key))
      .map((c) => [c.key, c.name]);
    const selectedTeams = teamClusters
      .filter((c) => filters.teams.has(c.key))
      .map((c) => [c.key, c.name]);

    const playerEntries = knownPlayers();
    const playerOptions = playerEntries.filter(([id]) => !filters.players.has(id));
    const selectedPlayers = playerEntries.filter(([id]) => filters.players.has(id));
    const teamMenuOpen = Boolean(teamSearch.trim());
    const playerMenuOpen = Boolean(playerSearch.trim());

    filtersEl.innerHTML = `
      <div class="rp-filter-group${mapMenuOpen ? ' menu-open' : ''}">
        <h4>Map</h4>
        ${mapMenuHtml()}
      </div>
      <div class="rp-filter-group">
        <h4>Economy</h4>
        <div class="rp-econ-pair">
          <div class="rp-econ-side">
            <span>Team 1</span>
            ${econSelectHtml('rp-econ-a', filters.econA)}
            ${hasAwpCheckHtml('rp-awp-a', filters.hasAwpA)}
          </div>
          <div class="rp-econ-side">
            <span>Team 2</span>
            ${econSelectHtml('rp-econ-b', filters.econB)}
            ${hasAwpCheckHtml('rp-awp-b', filters.hasAwpB)}
          </div>
        </div>
      </div>
      ${
        teamClusters.length
          ? `<div class="rp-filter-group${teamMenuOpen ? ' menu-open' : ''}">
              <h4>Team</h4>
              <div class="rp-typeahead" id="rp-team-typeahead">
                <input type="search" class="site-input rp-filter-search" id="rp-team-search"
                  placeholder="Search teams" spellcheck="false" autocomplete="off"
                  value="${escapeHtml(teamSearch)}" aria-label="Search teams" />
                ${typeaheadMenuHtml('teams', teamOptions, teamSearch)}
              </div>
              ${selectedChipsHtml('teams', selectedTeams)}
            </div>`
          : ''
      }
      ${
        teamClusters.length
          ? `<div class="rp-filter-group">
              <h4>Round won by</h4>
              ${wonBySelectHtml()}
            </div>`
          : ''
      }
      <div class="rp-filter-group rp-advanced-wrap">
        <button type="button" class="btn btn-sm rp-advanced-toggle${
          advancedOpen ? ' open' : ''
        }${advancedFilterCount() ? ' has-active' : ''}" id="rp-advanced-toggle" aria-expanded="${
          advancedOpen ? 'true' : 'false'
        }">
          Advanced Filters${
            advancedFilterCount() ? ` · ${advancedFilterCount()}` : ''
          }
        </button>
        <div class="rp-advanced-body" id="rp-advanced-body" ${advancedOpen ? '' : 'hidden'}>
          <div class="rp-filter-group">
            <h4>Side${
              filters.teams.size !== 1
                ? ' <span class="rp-filter-hint">(pick one team)</span>'
                : ''
            }</h4>
            <div class="rp-chips">
              <button type="button" class="rp-chip${
                filters.side === 'T' ? ' active' : ''
              }" data-adv-side="T" ${filters.teams.size !== 1 ? 'disabled' : ''}>T</button>
              <button type="button" class="rp-chip${
                filters.side === 'CT' ? ' active' : ''
              }" data-adv-side="CT" ${filters.teams.size !== 1 ? 'disabled' : ''}>CT</button>
            </div>
          </div>
          <div class="rp-filter-group">
            <h4>Situation${
              filters.teams.size !== 1
                ? ' <span class="rp-filter-hint">(pick one team)</span>'
                : ''
            }</h4>
            <div class="rp-chips rp-chips-wrap">
              ${SITUATION_OPTIONS.map(
                (s) =>
                  `<button type="button" class="rp-chip${
                    filters.situations.has(s.key) ? ' active' : ''
                  }" data-adv-sit="${s.key}" ${
                    filters.teams.size !== 1 ? 'disabled' : ''
                  }>${escapeHtml(s.label)}</button>`
              ).join('')}
            </div>
          </div>
          <div class="rp-filter-group">
            <h4>Bomb</h4>
            <div class="rp-chips">
              <button type="button" class="rp-chip${
                filters.afterplant ? ' active' : ''
              }" data-adv-afterplant="1">Afterplant</button>
            </div>
          </div>
          <div class="rp-filter-group">
            <h4>Round decided <span class="rp-filter-hint">(equal buy)</span></h4>
            <div class="rp-chips">
              ${['early', 'mid', 'late']
                .map(
                  (p) =>
                    `<button type="button" class="rp-chip${
                      filters.decidedPhases.has(p) ? ' active' : ''
                    }" data-adv-decided="${p}">${p[0].toUpperCase()}${p.slice(1)}</button>`
                )
                .join('')}
            </div>
          </div>
          ${
            playerEntries.length
              ? `<div class="rp-filter-group${playerMenuOpen ? ' menu-open' : ''}">
              <h4>Players on the server</h4>
              <div class="rp-typeahead" id="rp-player-typeahead">
                <input type="search" class="site-input rp-filter-search" id="rp-player-search"
                  placeholder="Search players" spellcheck="false" autocomplete="off"
                  value="${escapeHtml(playerSearch)}" aria-label="Search players" />
                ${typeaheadMenuHtml('players', playerOptions, playerSearch)}
              </div>
              ${selectedChipsHtml('players', selectedPlayers)}
            </div>`
              : ''
          }
        </div>
      </div>
      <button type="button" class="btn btn-sm" id="rp-clear">Clear filters</button>`;

    const bindEcon = (id, key) => {
      filtersEl.querySelector(`#${id}`)?.addEventListener('change', (e) => {
        const raw = e.target.value;
        filters[key] = raw === '' ? null : Number(raw);
        runQuery();
      });
    };
    bindEcon('rp-econ-a', 'econA');
    bindEcon('rp-econ-b', 'econB');

    const bindAwp = (id, key) => {
      filtersEl.querySelector(`#${id}`)?.addEventListener('change', (e) => {
        filters[key] = Boolean(e.target.checked);
        e.target.closest('.rp-awp-toggle')?.classList.toggle('active', e.target.checked);
        runQuery();
      });
    };
    bindAwp('rp-awp-a', 'hasAwpA');
    bindAwp('rp-awp-b', 'hasAwpB');

    filtersEl.querySelector('#rp-won-by')?.addEventListener('change', (e) => {
      const v = e.target.value;
      filters.wonByMode = v === 'selected' || v === 'opponent' ? v : '';
      runQuery();
    });

    filtersEl.querySelector('#rp-map-toggle')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      mapMenuOpen = !mapMenuOpen;
      const multi = filtersEl.querySelector('#rp-map-multi');
      multi?.classList.toggle('open', mapMenuOpen);
      const menu = multi?.querySelector('.rp-multi-menu');
      if (menu) menu.hidden = !mapMenuOpen;
      multi?.querySelector('#rp-map-toggle')?.setAttribute('aria-expanded', mapMenuOpen ? 'true' : 'false');
      multi?.closest('.rp-filter-group')?.classList.toggle('menu-open', mapMenuOpen);
    });

    filtersEl.querySelector('#rp-advanced-toggle')?.addEventListener('click', () => {
      advancedOpen = !advancedOpen;
      renderFilters();
    });

    filtersEl.querySelector('#rp-clear')?.addEventListener('click', () => {
      filters.maps.clear();
      filters.teams.clear();
      filters.players.clear();
      filters.wonByMode = '';
      filters.econA = null;
      filters.econB = null;
      filters.hasAwpA = false;
      filters.hasAwpB = false;
      filters.side = '';
      filters.situations.clear();
      filters.afterplant = false;
      filters.decidedPhases.clear();
      teamSearch = '';
      playerSearch = '';
      mapMenuOpen = false;
      advancedOpen = false;
      renderFilters();
      runQuery();
    });
  }

  function refreshTypeaheadMenu(kind) {
    if (!filtersEl) return;
    if (kind === 'teams') {
      const group = filtersEl.querySelector('#rp-team-typeahead')?.closest('.rp-filter-group');
      const wrap = filtersEl.querySelector('#rp-team-typeahead');
      if (!wrap) return;
      wrap.querySelector('.rp-typeahead-menu')?.remove();
      const options = teamClusters
        .filter((c) => !filters.teams.has(c.key))
        .map((c) => [c.key, c.name]);
      wrap.insertAdjacentHTML('beforeend', typeaheadMenuHtml('teams', options, teamSearch));
      group?.classList.toggle('menu-open', Boolean(teamSearch.trim()));
      return;
    }
    const group = filtersEl.querySelector('#rp-player-typeahead')?.closest('.rp-filter-group');
    const wrap = filtersEl.querySelector('#rp-player-typeahead');
    if (!wrap) return;
    wrap.querySelector('.rp-typeahead-menu')?.remove();
    const options = knownPlayers().filter(([id]) => !filters.players.has(id));
    wrap.insertAdjacentHTML('beforeend', typeaheadMenuHtml('players', options, playerSearch));
    group?.classList.toggle('menu-open', Boolean(playerSearch.trim()));
  }

  filtersEl?.addEventListener('input', (e) => {
    const teamInput = e.target.closest('#rp-team-search');
    if (teamInput) {
      teamSearch = teamInput.value;
      refreshTypeaheadMenu('teams');
      return;
    }
    const playerInput = e.target.closest('#rp-player-search');
    if (playerInput) {
      playerSearch = playerInput.value;
      refreshTypeaheadMenu('players');
    }
  });

  filtersEl?.addEventListener('change', (e) => {
    const mapBox = e.target.closest('[data-map]');
    if (!mapBox) return;
    const code = mapBox.dataset.map;
    if (mapBox.checked) filters.maps.add(code);
    else filters.maps.delete(code);
    const toggle = filtersEl.querySelector('#rp-map-toggle');
    if (toggle) toggle.textContent = mapToggleLabel();
    runQuery();
  });

  filtersEl?.addEventListener('click', (e) => {
    const sideBtn = e.target.closest('[data-adv-side]');
    if (sideBtn && !sideBtn.disabled) {
      const side = sideBtn.dataset.advSide === 'CT' ? 'CT' : 'T';
      filters.side = filters.side === side ? '' : side;
      renderFilters();
      runQuery();
      return;
    }
    const sitBtn = e.target.closest('[data-adv-sit]');
    if (sitBtn && !sitBtn.disabled) {
      const key = sitBtn.dataset.advSit;
      if (filters.situations.has(key)) filters.situations.delete(key);
      else filters.situations.add(key);
      renderFilters();
      runQuery();
      return;
    }
    const plantBtn = e.target.closest('[data-adv-afterplant]');
    if (plantBtn) {
      filters.afterplant = !filters.afterplant;
      renderFilters();
      runQuery();
      return;
    }
    const decidedBtn = e.target.closest('[data-adv-decided]');
    if (decidedBtn) {
      const phase = decidedBtn.dataset.advDecided;
      if (filters.decidedPhases.has(phase)) filters.decidedPhases.delete(phase);
      else filters.decidedPhases.add(phase);
      renderFilters();
      runQuery();
      return;
    }

    const chipEl = e.target.closest('[data-group]');
    if (!chipEl) return;
    const { group, value } = chipEl.dataset;
    if (group === 'teams' || group === 'players') {
      const set = filters[group];
      if (set.has(value)) set.delete(value);
      else set.add(value);
      if (group === 'teams') {
        teamSearch = '';
        if (!filters.teams.size) {
          filters.wonByMode = '';
          filters.side = '';
          filters.situations.clear();
        }
        if (filters.teams.size !== 1) {
          filters.side = '';
          filters.situations.clear();
        }
      }
      if (group === 'players') playerSearch = '';
      renderFilters();
      runQuery();
    }
  });

  document.addEventListener('click', (e) => {
    if (!mapMenuOpen) return;
    if (e.target.closest?.('#rp-map-multi')) return;
    mapMenuOpen = false;
    const multi = filtersEl?.querySelector('#rp-map-multi');
    if (!multi) return;
    multi.classList.remove('open');
    const menu = multi.querySelector('.rp-multi-menu');
    if (menu) menu.hidden = true;
    multi.querySelector('#rp-map-toggle')?.setAttribute('aria-expanded', 'false');
    multi.closest('.rp-filter-group')?.classList.remove('menu-open');
  });

  // ---- query + results ----------------------------------------------------

  function expandClusterKeys(keys) {
    const out = new Set();
    for (const key of keys) {
      const cluster = teamClustersByKey.get(key);
      if (cluster) for (const id of cluster.shortIds) out.add(id);
      else out.add(key);
    }
    return [...out];
  }

  function currentQuery() {
    const teams = expandClusterKeys(filters.teams);
    return {
      maps: [...filters.maps],
      teams,
      players: [...filters.players],
      wonByMode: teams.length && filters.wonByMode ? filters.wonByMode : undefined,
      econA: Number.isFinite(filters.econA) ? filters.econA : undefined,
      econB: Number.isFinite(filters.econB) ? filters.econB : undefined,
      hasAwpA: filters.hasAwpA || undefined,
      hasAwpB: filters.hasAwpB || undefined
    };
  }

  function advancedFilterCount() {
    return (
      (filters.side ? 1 : 0) +
      filters.situations.size +
      (filters.afterplant ? 1 : 0) +
      filters.decidedPhases.size +
      filters.players.size
    );
  }

  function needsMetaFilters() {
    return Boolean(
      filters.side ||
        filters.situations.size ||
        filters.afterplant ||
        filters.decidedPhases.size
    );
  }

  function hasActiveFilters() {
    return Boolean(
      filters.maps.size ||
        filters.teams.size ||
        filters.players.size ||
        filters.wonByMode ||
        Number.isFinite(filters.econA) ||
        Number.isFinite(filters.econB) ||
        filters.hasAwpA ||
        filters.hasAwpB ||
        filters.side ||
        filters.situations.size ||
        filters.afterplant ||
        filters.decidedPhases.size
    );
  }

  function shortTeamId(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.toLowerCase();
    return String(value.id || value.shortId || '').toLowerCase();
  }

  /** Selected cluster short-ids when exactly one team is picked (for side/situation). */
  function focusTeamIds() {
    if (filters.teams.size !== 1) return new Set();
    const key = [...filters.teams][0];
    const cluster = teamClustersByKey.get(key);
    if (cluster) return new Set([...cluster.shortIds].map((id) => String(id).toLowerCase()));
    return new Set([String(key).toLowerCase()]);
  }

  function focusTeamIndex(meta, listRound, focusIds) {
    if (!focusIds.size || !meta) return 0;
    const t1 = String(listRound?.team1 || shortTeamId(meta.team1) || '').toLowerCase();
    const t2 = String(listRound?.team2 || shortTeamId(meta.team2) || '').toLowerCase();
    if (focusIds.has(t1)) return 1;
    if (focusIds.has(t2)) return 2;
    return 0;
  }

  function sideForIndex(meta, idx) {
    if (idx === 1 && (meta.team1Side === 'T' || meta.team1Side === 'CT')) return meta.team1Side;
    if (idx === 2 && (meta.team2Side === 'T' || meta.team2Side === 'CT')) return meta.team2Side;
    if (idx === 1 && (meta.team2Side === 'T' || meta.team2Side === 'CT')) {
      return meta.team2Side === 'T' ? 'CT' : 'T';
    }
    if (idx === 2 && (meta.team1Side === 'T' || meta.team1Side === 'CT')) {
      return meta.team1Side === 'T' ? 'CT' : 'T';
    }
    const round = Number(meta.round) || Number(meta.roundNum) || 1;
    const team1IsT = round <= 12;
    if (idx === 1) return team1IsT ? 'T' : 'CT';
    if (idx === 2) return team1IsT ? 'CT' : 'T';
    return '';
  }

  function isAfterplantMeta(meta) {
    if (!meta) return false;
    if (meta.plantTick != null && Number.isFinite(meta.plantTick)) return true;
    return (meta.events?.bomb || []).some((b) => b.type === 'planted');
  }

  function matchesAdvancedMeta(meta, listRound) {
    if (!needsMetaFilters()) return true;
    if (!meta) return false;

    const focusIds = focusTeamIds();
    const idx = focusTeamIndex(meta, listRound, focusIds);

    if (filters.side) {
      if (!idx) return false;
      if (sideForIndex(meta, idx) !== filters.side) return false;
    }
    if (filters.situations.size) {
      if (!idx) return false;
      const sit = openingSituation(meta, idx);
      if (!sit || !filters.situations.has(sit)) return false;
    }
    if (filters.afterplant && !isAfterplantMeta(meta)) return false;
    if (filters.decidedPhases.size) {
      const d = findRoundDecided(meta);
      if (!d || !filters.decidedPhases.has(d.phase)) return false;
    }
    return true;
  }

  async function getCachedRoundMeta(file) {
    if (!file) return null;
    if (roundMetaCache.has(file)) return roundMetaCache.get(file);
    try {
      const meta = await fetchRoundMeta(file);
      roundMetaCache.set(file, meta || null);
      return meta || null;
    } catch {
      roundMetaCache.set(file, null);
      return null;
    }
  }

  /** Load metas with limited concurrency, then keep rounds that pass advanced filters. */
  async function applyAdvancedMetaFilters(list, token) {
    if (!needsMetaFilters()) return list;
    const out = [];
    const concurrency = 6;
    let i = 0;
    async function worker() {
      while (i < list.length) {
        if (token !== queryToken) return;
        const idx = i++;
        const r = list[idx];
        const meta = await getCachedRoundMeta(r.file);
        if (token !== queryToken) return;
        if (matchesAdvancedMeta(meta, r)) out.push(r);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));
    if (token !== queryToken) return list;
    // Preserve original order
    const keep = new Set(out.map((r) => r.file));
    return list.filter((r) => keep.has(r.file));
  }

  /**
   * Filter rounds from demo records. Empty query ⇒ every round. demoId is taken
   * from the parent demo so rows never orphan when the "~id" suffix is missing.
   */
  function filterLibraryRounds(query) {
    const out = [];
    for (const d of demos) {
      for (const r of d.rounds || []) {
        const file = r.file || (r.id && d.id ? `${r.id}~${d.id}` : '');
        if (!file && !r.id) continue;
        const stem = file ? splitStoredName(file).stem : r.id;
        const parsed = parseRoundId(stem) || parseRoundId(r.id);
        const meta = parsed || {
          id: r.id || stem,
          team1: d.team1?.id,
          team2: d.team2?.id,
          winner: r.winner,
          econ1: r.econ1,
          econ2: r.econ2,
          map: d.map,
          round: r.round,
          players: []
        };
        if (!matchesQuery(meta, query)) continue;
        out.push({ ...meta, demoId: d.id, file: file || meta.id });
      }
    }
    return out;
  }

  let queryToken = 0;
  async function runQuery() {
    const token = ++queryToken;
    const query = currentQuery();
    // Filter against the demo index immediately so an empty filter always
    // shows every round, even if the rounds API is slow or empty.
    rounds = filterLibraryRounds(query);
    if (needsMetaFilters()) setStatus('Applying advanced filters…');
    else setStatus('');
    renderResults();

    try {
      const [res, playlists] = await Promise.all([
        findRounds(query).catch(() => null),
        fetchPlaylists().catch(() => [])
      ]);
      if (token !== queryToken) return;
      const fromApi = res?.rounds || [];
      // Prefer the larger set: directory listing can include rounds a stale
      // demo record omitted; the demo index covers the common import path.
      if (fromApi.length > rounds.length) {
        rounds = fromApi;
      } else if (!rounds.length && fromApi.length) {
        rounds = fromApi;
      } else if (!rounds.length) {
        const names = demos.flatMap((d) => (d.rounds || []).map((r) => r.file).filter(Boolean));
        rounds = collectRounds(names, query);
      }

      if (needsMetaFilters()) {
        rounds = await applyAdvancedMetaFilters(rounds, token);
        if (token !== queryToken) return;
        setStatus('');
      }

      notedFiles = new Set(res?.noted || []);
      bookmarkedFiles = new Set();
      for (const pl of playlists || []) {
        for (const f of pl.rounds || []) bookmarkedFiles.add(f);
      }
      // Drop selections that filters removed from the current result set.
      const visibleFiles = new Set(rounds.map((r) => r.file));
      selectedFiles = new Set([...selectedFiles].filter((f) => visibleFiles.has(f)));
      renderResults();
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function demoById(id) {
    return demos.find((d) => d.id === id) || null;
  }

  function teamName(demo, team, shortId) {
    if (team === 1) return demo?.team1?.name || shortId || 'Team 1';
    return demo?.team2?.name || shortId || 'Team 2';
  }

  function groupRoundsByDemo(list) {
    const groups = new Map();
    for (const r of list) {
      const key = r.demoId || '_';
      let g = groups.get(key);
      if (!g) {
        g = { demoId: key, demo: demoById(key), rounds: [] };
        groups.set(key, g);
      }
      g.rounds.push(r);
    }
    for (const g of groups.values()) {
      g.rounds.sort((a, b) => (a.round || 0) - (b.round || 0));
    }
    // Newest demos first when we know upload time.
    return [...groups.values()].sort((a, b) => {
      const ta = a.demo?.uploadedAt || a.demo?.parsedAt || 0;
      const tb = b.demo?.uploadedAt || b.demo?.parsedAt || 0;
      return tb - ta;
    });
  }

  function roundRowHtml(r, demo) {
    const selected = selectedFiles.has(r.file);
    const side = winningSide(r);
    const winTeam = r.winner === 1 ? 1 : 2;
    const winnerName = teamName(demo, winTeam, winTeam === 1 ? r.team1 : r.team2);
    const t1 = teamName(demo, 1, r.team1);
    const t2 = teamName(demo, 2, r.team2);
    const marks = [];
    if (notedFiles.has(r.file)) {
      marks.push(
        `<span class="rp-round-mark note" title="Has a note">${svgIcon(commentsIcon)}</span>`
      );
    }
    if (bookmarkedFiles.has(r.file)) {
      marks.push(
        `<span class="rp-round-mark bookmark" title="In a playlist">${svgIcon(bookmarkIcon)}</span>`
      );
    }
    return `
      <button type="button" class="rp-round-row${selected ? ' selected' : ''} side-${side.toLowerCase()}"
        data-file="${escapeHtml(r.file)}" aria-pressed="${selected ? 'true' : 'false'}">
        <span class="rp-round-num">${String(r.round).padStart(2, '0')}</span>
        <span class="rp-round-econ">
          <span class="rp-econ" title="${escapeHtml(t1)}">${escapeHtml(economyLabel(r.econ1))}</span>
          <span class="rp-econ-vs">vs</span>
          <span class="rp-econ" title="${escapeHtml(t2)}">${escapeHtml(economyLabel(r.econ2))}</span>
        </span>
        <span class="rp-round-winner side-${side.toLowerCase()}" title="Winner">
          ${escapeHtml(winnerName)}
          <span class="rp-winner-side">${side}</span>
        </span>
        <span class="rp-round-marks">${marks.join('')}</span>
      </button>`;
  }

  function demoGroupHeadHtml(g) {
    const d = g.demo;
    const sample = g.rounds[0];
    const open = expandedDemos.has(g.demoId);
    const t1 = teamName(d, 1, sample?.team1);
    const t2 = teamName(d, 2, sample?.team2);
    const when = formatWhen(d?.uploadedAt || d?.parsedAt);
    const mapCode = d?.map || sample?.map || '';
    const mapName =
      d?.mapName || (mapCode ? MAPS[mapCode]?.name : '') || mapCode || '';
    const score = d ? demoScoreText(d) : '…';
    const id = escapeHtml(g.demoId);

    return `
      <div class="rp-row rp-demo-head" data-toggle-demo="${id}" role="button" tabindex="0"
        aria-expanded="${open ? 'true' : 'false'}">
        ${rowMetaHtml(when, mapCode, mapName)}
        ${matchBlockHtml(t1, t2, score)}
        <div class="rp-row-actions">
          ${
            d
              ? `<button type="button" class="rp-btn-icon" data-demo-stats="${id}" title="Statistics for this match">${statsIconHtml()}</button>
                 <button type="button" class="rp-btn-icon" data-rename="${id}" title="Rename teams">Aa</button>`
              : ''
          }
          <button type="button" class="rp-btn-icon danger" data-delete="${id}" title="Delete">
            ${deleteIconHtml()}
          </button>
          <button type="button" class="rp-btn-play" data-open="${id}" title="Replay">${playIconHtml()}</button>
        </div>
      </div>`;
  }

  function renderResults() {
    if (!resultEl) return;
    if (!demos.length) {
      resultEl.innerHTML = `<p class="view-empty">No replays yet. Upload a ${PACKAGE_EXT} package (or a .dem).</p>`;
      return;
    }

    const roundsByFile = new Map(rounds.map((r) => [r.file, r]));
    const sortedDemos = [...demos].sort((a, b) => {
      const ta = a.uploadedAt || a.parsedAt || 0;
      const tb = b.uploadedAt || b.parsedAt || 0;
      return tb - ta;
    });

    /** Prefer the demo record's own file list so rounds never orphan by demoId. */
    function roundsForDemo(d) {
      const files = (d.rounds || []).map((r) => r.file).filter(Boolean);
      if (files.length) {
        return files.map((f) => roundsByFile.get(f)).filter(Boolean);
      }
      return rounds.filter((r) => r.demoId === d.id || r.file?.endsWith(`~${d.id}`));
    }

    const selCount = selectedFiles.size;
    const picked = rounds.filter((r) => selectedFiles.has(r.file));
    const analyze = analyzerGate(picked);
    const loadLabel = selCount ? `Load rounds (${selCount})` : 'Load rounds';
    const analyzeLabel = selCount ? `Analyzer (${selCount})` : 'Analyzer';
    const analyzeTitle = analyze.ok
      ? analyze.needsTeamPick
        ? 'Open Analyzer (pick a team inside)'
        : 'Open Analyzer overlay'
      : analyze.reason || 'Select rounds from one map that share a team';
    const allMatchingSelected =
      rounds.length > 0 && rounds.every((r) => selectedFiles.has(r.file));
    const selectAllBtn =
      rounds.length && !allMatchingSelected
        ? `<button type="button" class="btn btn-sm" id="rp-select-all" title="Select every round that matches these filters">Select all</button>`
        : '';
    const deselectBtn = selCount
      ? `<button type="button" class="btn btn-sm" id="rp-deselect-all" title="Clear the current selection">Deselect all</button>`
      : '';
    const head =
      rounds.length || selCount
        ? `<div class="rp-result-head">
        <span class="rp-result-count">${rounds.length} round${rounds.length === 1 ? '' : 's'} match</span>
        <span class="rp-result-bulk">${selectAllBtn}${deselectBtn}</span>
        <div class="rp-result-actions">
          <button type="button" class="btn btn-sm" id="rp-stats-selected" title="${escapeHtml(
            selCount ? `Statistics for the ${selCount} selected round${selCount === 1 ? '' : 's'}` : 'Statistics for every round that matches these filters'
          )}">Statistics${selCount ? ` (${selCount})` : ''}</button>
          <button type="button" class="btn btn-sm primary" id="rp-load-rounds" ${
            selCount ? '' : 'disabled'
          }>${loadLabel}</button>
          <button type="button" class="btn btn-sm rp-btn-analyzer" id="rp-analyzer" ${
            analyze.ok ? '' : 'disabled'
          } title="${escapeHtml(analyzeTitle)}">${analyzeLabel}</button>
        </div>
      </div>`
        : '';

    const demoBlocks = sortedDemos
      .map((d) => {
        const status = d.status || 'ready';
        if (status !== 'ready') return demoRow(d);
        const demoRounds = roundsForDemo(d);
        // No matching rounds for the current filters → omit the demo entirely.
        if (!demoRounds.length) return '';
        const g = { demoId: d.id, demo: d, rounds: demoRounds };
        const open = expandedDemos.has(d.id);
        const allSelected =
          demoRounds.length > 0 && demoRounds.every((r) => selectedFiles.has(r.file));
        return `
          <section class="rp-demo-group${open ? ' open' : ''}" data-demo="${escapeHtml(d.id)}">
            ${demoGroupHeadHtml(g)}
            <div class="rp-demo-rounds" ${open ? '' : 'hidden'}>
              <div class="rp-demo-rounds-tools">
                <button type="button" class="rp-select-demo-rounds" data-select-demo="${escapeHtml(
                  d.id
                )}">${allSelected ? 'Deselect all' : 'Select all'}</button>
                <span class="rp-demo-rounds-meta">${demoRounds.length} round${
                  demoRounds.length === 1 ? '' : 's'
                }</span>
              </div>
              ${demoRounds.map((r) => roundRowHtml(r, d)).join('')}
            </div>
          </section>`;
      })
      .filter(Boolean)
      .join('');

    resultEl.innerHTML = `
      ${head}
      <div class="rp-demo-groups rp-list">
        ${
          demoBlocks ||
          `<p class="view-empty">${
            hasActiveFilters()
              ? 'No demos match these filters.'
              : 'No replays yet. Upload a package (or a .dem).'
          }</p>`
        }
      </div>`;

    resultEl.querySelector('#rp-select-all')?.addEventListener('click', () => {
      selectedFiles = new Set(rounds.map((r) => r.file).filter(Boolean));
      renderResults();
    });
    resultEl.querySelector('#rp-deselect-all')?.addEventListener('click', () => {
      selectedFiles = new Set();
      renderResults();
    });
    resultEl.querySelector('#rp-stats-selected')?.addEventListener('click', () => {
      // Selected rounds when there are any, otherwise whatever the filters left.
      const list = picked.length ? picked : rounds;
      const files = list.map((r) => r.file);
      const demoIds = [...new Set(list.map((r) => r.demoId || splitStoredName(r.file)?.demoId).filter(Boolean))];
      showStats({
        files,
        demos: demoIds.length ? demoIds : null,
        title: `${files.length} round${files.length === 1 ? '' : 's'}`
      });
    });
    resultEl.querySelector('#rp-load-rounds')?.addEventListener('click', () => {
      const ordered = groupRoundsByDemo(picked).flatMap((g) => g.rounds);
      launchViewer(ordered, 'timeline', queryTitle(ordered));
    });
    resultEl.querySelector('#rp-analyzer')?.addEventListener('click', () => {
      const gate = analyzerGate(picked);
      if (!gate.ok) return;
      const ordered = groupRoundsByDemo(picked).flatMap((g) => g.rounds);
      const mapName = MAPS[ordered[0]?.map]?.name || ordered[0]?.map || 'Map';
      const title = gate.focusName ? `${gate.focusName} · ${mapName}` : mapName;
      launchViewer(ordered, 'analyzer', title, {
        focusTeam: gate.focusTeam,
        focusTeamIds: gate.focusTeamIds,
        focusName: gate.focusName || '',
        teamOptions: gate.teamOptions || []
      });
    });
  }

  /** Team short-ids present in every selected round. */
  function commonTeamIds(picked) {
    let common = null;
    for (const r of picked) {
      const ids = new Set([r.team1, r.team2].filter(Boolean));
      if (!ids.size) continue;
      if (!common) common = ids;
      else common = new Set([...common].filter((id) => ids.has(id)));
    }
    return [...(common || [])];
  }

  /**
   * Build pickable focus options from short-ids (cluster-aware, deduped).
   * @param {string[]} shortIds
   */
  function teamOptionsFromIds(shortIds) {
    /** @type {Map<string, {key:string, focusTeam:string, focusTeamIds:string[], name:string}>} */
    const byKey = new Map();
    for (const id of shortIds) {
      const cover = teamClusters.find((c) => c.shortIds.includes(id));
      const key = cover?.key || id;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        key,
        focusTeam: id,
        focusTeamIds: cover?.shortIds ? [...cover.shortIds] : [id],
        name: cover?.name || id
      });
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Analyzer needs: ≥1 selected round, one map, and at least one team shared
   * by every round. Prefer the Team filter when set; otherwise open Analyzer
   * and let the user pick when more than one shared team exists.
   */
  function analyzerGate(picked) {
    if (!picked.length) return { ok: false, reason: 'Select at least one round' };
    const maps = new Set(picked.map((r) => r.map).filter(Boolean));
    if (maps.size !== 1) return { ok: false, reason: 'All rounds must share one map' };

    if (filters.teams.size === 1) {
      const clusterKey = [...filters.teams][0];
      const shortIds = expandClusterKeys([clusterKey]);
      if (!shortIds.length) return { ok: false, reason: 'No shared team across selected rounds' };
      const inFocus = (r) => shortIds.some((id) => r.team1 === id || r.team2 === id);
      if (!picked.every(inFocus)) {
        return { ok: false, reason: 'Selected team must be in every round' };
      }
      const counts = new Map(shortIds.map((id) => [id, 0]));
      for (const r of picked) {
        for (const id of shortIds) {
          if (r.team1 === id || r.team2 === id) counts.set(id, (counts.get(id) || 0) + 1);
        }
      }
      const focusTeam = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        ok: true,
        focusTeam,
        focusTeamIds: shortIds,
        clusterKey,
        focusName: teamClustersByKey.get(clusterKey)?.name || '',
        teamOptions: [],
        needsTeamPick: false
      };
    }

    if (filters.teams.size > 1) {
      return { ok: false, reason: 'Filter exactly one team (or clear Team)' };
    }

    const common = commonTeamIds(picked);
    if (!common.length) return { ok: false, reason: 'No shared team across selected rounds' };

    const teamOptions = teamOptionsFromIds(common);
    if (teamOptions.length === 1) {
      const only = teamOptions[0];
      return {
        ok: true,
        focusTeam: only.focusTeam,
        focusTeamIds: only.focusTeamIds,
        clusterKey: only.key,
        focusName: only.name,
        teamOptions: [],
        needsTeamPick: false
      };
    }

    // Multiple shared teams (typical match) — Analyzer will ask which one.
    return {
      ok: true,
      focusTeam: '',
      focusTeamIds: [],
      clusterKey: '',
      focusName: '',
      teamOptions,
      needsTeamPick: true
    };
  }

  resultEl?.addEventListener('click', async (e) => {
    if (await handleDemoAction(e.target)) return;

    const selectDemo = e.target.closest('[data-select-demo]');
    if (selectDemo) {
      e.preventDefault();
      e.stopPropagation();
      const demoId = selectDemo.dataset.selectDemo;
      const demo = demos.find((d) => d.id === demoId);
      if (!demo) return;
      const files = (demo.rounds || [])
        .map((r) => r.file)
        .filter((f) => f && rounds.some((r) => r.file === f));
      const allOn = files.length > 0 && files.every((f) => selectedFiles.has(f));
      if (allOn) for (const f of files) selectedFiles.delete(f);
      else for (const f of files) selectedFiles.add(f);
      renderResults();
      return;
    }

    const toggle = e.target.closest('[data-toggle-demo]');
    if (toggle && !e.target.closest('.rp-row-actions, button, a')) {
      const id = toggle.dataset.toggleDemo;
      if (expandedDemos.has(id)) expandedDemos.delete(id);
      else expandedDemos.add(id);
      renderResults();
      return;
    }

    const row = e.target.closest('.rp-round-row[data-file]');
    if (!row) return;
    const file = row.dataset.file;
    if (selectedFiles.has(file)) selectedFiles.delete(file);
    else selectedFiles.add(file);
    renderResults();
  });

  resultEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const toggle = e.target.closest('[data-toggle-demo]');
    if (!toggle || e.target.closest('.rp-row-actions, button, a')) return;
    e.preventDefault();
    const id = toggle.dataset.toggleDemo;
    if (expandedDemos.has(id)) expandedDemos.delete(id);
    else expandedDemos.add(id);
    renderResults();
  });

  function queryTitle(list = rounds) {
    const parts = [];
    if (filters.maps.size) parts.push([...filters.maps].map((c) => MAPS[c]?.name || c).join(', '));
    if (
      filters.econA != null ||
      filters.econB != null ||
      filters.hasAwpA ||
      filters.hasAwpB
    ) {
      const a =
        (filters.econA != null ? economyLabel(filters.econA) : 'Any') +
        (filters.hasAwpA ? ' +AWP' : '');
      const b =
        (filters.econB != null ? economyLabel(filters.econB) : 'Any') +
        (filters.hasAwpB ? ' +AWP' : '');
      parts.push(`${a} / ${b}`);
    }
    if (list?.length && list.length <= 3) {
      parts.push(list.map((r) => `R${r.round}`).join(', '));
    } else if (selectedFiles.size) {
      parts.push(`${selectedFiles.size} rounds`);
    }
    return parts.join(' · ') || 'Selected rounds';
  }

  /** The viewer is a heavy module: it loads the first time one is opened. */
  async function launchViewer(list, mode, title, opts = {}) {
    if (!list.length) return;
    setStatus('');
    if (!viewerModule) {
      viewerModule = await import('../replays/viewer/viewerApp.js');
    }
    const focus =
      typeof opts === 'string' ? { focusTeam: opts } : opts && typeof opts === 'object' ? opts : {};
    viewerModule.openViewer({
      rounds: list,
      mode,
      title,
      escapeHtml,
      focusTeam: focus.focusTeam || '',
      focusTeamIds: focus.focusTeamIds || [],
      focusName: focus.focusName || '',
      teamOptions: focus.teamOptions || [],
      statsDemoId: focus.statsDemoId || ''
    });
  }

  // ---- playlists page -----------------------------------------------------

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
                  ${deleteIconHtml()}
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

  function syncHeadNav(next) {
    const active = next === 'library' ? 'library' : next;
    const map = [
      [uploadBtn, 'upload'],
      [playlistsBtn, 'playlists'],
      [statsBtn, 'stats'],
      [libraryBtn, 'library']
    ];
    for (const [btn, key] of map) {
      btn?.classList.toggle('active', key === active);
    }
  }

  function setSubpage(name, { push = false } = {}) {
    const next =
      name === 'upload' || name === 'playlists' || name === 'stats' ? name : 'library';
    subpage = next;
    if (libraryEl) libraryEl.hidden = next !== 'library';
    if (uploadPageEl) uploadPageEl.hidden = next !== 'upload';
    if (playlistsPageEl) playlistsPageEl.hidden = next !== 'playlists';
    if (statsPageEl) statsPageEl.hidden = next !== 'stats';
    if (headActions) headActions.hidden = !visible;
    if (pageTitleEl) pageTitleEl.textContent = 'Replays';
    document.title = 'AIM4.io - Replays';
    syncHeadNav(next);

    const path =
      next === 'upload'
        ? '/replays/upload'
        : next === 'playlists'
          ? '/replays/playlists'
          : next === 'stats'
            ? '/replays/stats'
            : '/replays';
    if (push && window.location.pathname.replace(/\/+$/, '') !== path) {
      window.history.pushState({ view: 'replays' }, '', path);
    }

    if (next === 'playlists') {
      stopPolling();
      loadPlaylistsPage();
    } else if (next === 'stats') {
      stopPolling();
      openStatsPage(statsScope);
    } else if (visible) {
      startPolling();
    }
  }

  uploadBtn?.addEventListener('click', () => setSubpage('upload', { push: true }));
  playlistsBtn?.addEventListener('click', () => setSubpage('playlists', { push: true }));
  statsBtn?.addEventListener('click', () => showStats({}));
  libraryBtn?.addEventListener('click', () => setSubpage('library', { push: true }));

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

  // ---- statistics ---------------------------------------------------------

  /** Mount the panel on first use and point it at a scope. */
  function openStatsPage(scope) {
    if (!statsBodyEl) return;
    if (!statsPanel) {
      statsPanel = createStatsPanel({ escapeHtml });
      statsBodyEl.appendChild(statsPanel.el);
    }
    statsPanel.load(scope);
  }

  /**
   * @param {{demos?: string[], files?: string[], title?: string}} scope
   */
  function showStats(scope) {
    statsScope = scope || {};
    setSubpage('stats', { push: true });
  }

  // ---- deep links ---------------------------------------------------------

  /** /replays?round=<name> opens straight into that round. */
  async function openSharedRound(file) {
    if (!file) return;
    return openSharedRounds([file]);
  }

  /** /replays?rounds=a,b,c opens those rounds in Timeline. */
  async function openSharedRounds(files) {
    const list = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
    if (!list.length) return;
    try {
      const rounds = [];
      for (const file of list) {
        const meta = await fetchRoundMeta(file);
        if (!meta) continue;
        rounds.push({ ...meta, file });
      }
      if (!rounds.length) throw new Error('Those rounds are not in this library.');
      const title =
        rounds.length === 1
          ? `${rounds[0].team1?.name || 'Team 1'} vs ${rounds[0].team2?.name || 'Team 2'}`
          : `${rounds.length} rounds`;
      launchViewer(rounds, 'timeline', title);
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
      rebuildTeamClusters();
      renderDemos();
      renderFilters();
      await runQuery();
    } catch (err) {
      setLocked(false);
      if (resultEl) {
        resultEl.innerHTML = `<p class="view-empty">Could not reach the replay service. ${escapeHtml(
          err.message
        )}</p>`;
      }
    }
  }

  function setLocked(locked) {
    if (dropEl) dropEl.hidden = locked;
    if (locked) setStatus('');
  }

  function startPolling() {
    stopPolling();
    // Only poll while something is actually mid-parse.
    pollTimer = window.setInterval(() => {
      if (!visible || subpage === 'playlists') return;
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
      const path = window.location.pathname.replace(/\/+$/, '');
      const wantUpload =
        params.upload === '1' || params.upload === true || path === '/replays/upload';
      const wantPlaylists =
        params.playlists === '1' ||
        params.playlists === true ||
        path === '/replays/playlists';
      const wantStats = params.stats === '1' || params.stats === true || path === '/replays/stats';
      const page = wantUpload
        ? 'upload'
        : wantPlaylists
          ? 'playlists'
          : wantStats
            ? 'stats'
            : 'library';
      setSubpage(page, { push: false });
      if (page === 'playlists' || page === 'stats') {
        stopPolling();
      } else {
        refresh();
        startPolling();
      }
      // Only on the first arrival: a viewer close rewrites the URL back to
      // /replays, and re-entering the view must not reopen what was closed.
      if (page === 'library') {
        if (params.rounds) {
          const key = `rounds:${params.rounds}`;
          if (key !== openedRound) {
            openedRound = key;
            const files = String(params.rounds)
              .split(',')
              .map((s) => {
                try {
                  return decodeURIComponent(s.trim());
                } catch {
                  return s.trim();
                }
              })
              .filter(Boolean);
            openSharedRounds(files);
          }
        } else if (params.round && params.round !== openedRound) {
          openedRound = params.round;
          openSharedRound(params.round);
        }
      }
    },
    onHide() {
      visible = false;
      if (headActions) headActions.hidden = true;
      stopPolling();
    }
  };
}
