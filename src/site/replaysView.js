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
  fetchDemo,
  fetchDemos,
  fetchPlaylists,
  fetchRoundMeta,
  fetchStats,
  fetchStatus,
  fetchUploadBatch,
  findRounds,
  formatApiError,
  renameDemoTeams,
  reparseDemo,
  savePlaylist,
  setDemoTags,
  setDemoVisibility,
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
import { clusterTeams } from '../replays/shared/teamClusters.js';
import { openingSituation, SITUATION_OPTIONS } from '../replays/shared/openingSituation.js';
import { findRoundDecided } from '../replays/coach/roundDecided.js';
import { hasRoundLibrary, roundTypeRows } from '../replays/analytics/roundLibrary.js';
import { PACKAGE_EXT } from '../replays/shared/replayPackage.js';
import { formatBytes } from '../replays/tickStore.js';
import { createStatsPanel, defaultMinRounds } from '../replays/stats/statsPanel.js';
import { createAnalyticsPanel } from '../replays/analytics/analyticsPanel.js';
import { createChartsPanel } from '../replays/charts/chartsPanel.js';
import commentsIcon from '../icons/demos_comments.svg?raw';
import bookmarkIcon from '../icons/demos_bookmarks_added.svg?raw';
import { spinnerHtml, watchSlowLoad } from '../lib/spinner.js';

const POLL_MS = 1500;

function svgIcon(raw) {
  return raw.replace('<svg', '<svg class="rp-mark-svg" aria-hidden="true"');
}

export function initReplaysView({ auth = null, escapeHtml, pathForPage = null, onNavigate = null }) {
  const uploadInput = document.getElementById('rp-file');
  const dropEl = document.getElementById('rp-drop');
  const quotaEl = document.getElementById('rp-quota');
  const progressEl = document.getElementById('rp-upload-progress');
  const statusEl = document.getElementById('rp-status');
  const filtersEl = document.getElementById('rp-filters');
  const resultEl = document.getElementById('rp-result');
  const parserEl = document.getElementById('rp-parser');
  const libraryEl = document.getElementById('rp-library');
  const uploadPageEl = document.getElementById('rp-upload-page');
  const playlistsPageEl = document.getElementById('rp-playlists-page');
  const playlistsBody = document.getElementById('rp-pl-body');
  const playlistStatusEl = document.getElementById('rp-pl-status');
  const statsPageEl = document.getElementById('rp-stats-page');
  const statsBodyEl = document.getElementById('rp-stats-body');
  const analyticsPageEl = document.getElementById('rp-analytics-page');
  const analyticsBodyEl = document.getElementById('rp-analytics-body');
  const chartsPageEl = document.getElementById('rp-charts-page');
  const chartsBodyEl = document.getElementById('rp-charts-body');

  const PAGE_PATHS = {
    library: '/demos',
    playlists: '/playlists',
    stats: '/database',
    analytics: '/patterns',
    charts: '/charts',
    upload: '/uploads'
  };

  function pagePath(page) {
    return pathForPage?.(page) || PAGE_PATHS[page] || '/demos';
  }

  /** Page size for the /demos library browser (not stats/charts/analytics). */
  const LIBRARY_PAGE = 50;
  /** How many stored demos the library page currently requests (grows via Load more). */
  let libraryLimit = LIBRARY_PAGE;
  /** Total stored demos on the server (from the last library fetch). */
  let demoTotal = 0;
  let demoHasMore = false;

  let demos = [];
  /**
   * Demo records fetched for library-wide team/player filters when those demos
   * are not on the current library page (pagination).
   * @type {Map<string, object>}
   */
  let extraDemos = new Map();
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
  /** @type {'library' | 'upload' | 'playlists' | 'stats' | 'analytics' | 'charts'} */
  let subpage = 'library';
  /** Built on first use; payloads reused across visits. */
  let analyticsPanel = null;
  let chartsPanel = null;
  let statsPanel = null;
  /** @type {{demos?: string[], files?: string[], title?: string}} */
  let statsScope = {};
  /**
   * The library scope statsPanel currently holds, as a comparable key.
   *
   * Kept separately from statsScope because statsScope is written by callers
   * before navigation and rewritten again on arrival, so it never describes
   * what the panel actually has. This does.
   */
  let loadedStatsKey = '';
  const libraryKeyOf = (s) =>
    JSON.stringify([s?.demos || null, s?.files || null, String(s?.teamName || '')]);
  /** From /status: who the backend thinks is calling, and what they may do. */
  let account = {
    signedIn: false,
    id: '',
    username: '',
    admin: false,
    maxDemos: 5,
    verifies: true
  };
  /** Selected demo ids on My Uploads (bulk visibility / click-to-select). */
  const selectedMine = new Set();
  const MINE_PAGE_SIZE = 100;
  let minePage = 1;
  /**
   * Full list of demos for My Uploads (not capped by the library’s 50-page fetch).
   * @type {object[]}
   */
  let mineDemos = [];
  let mineDemosLoaded = false;
  /**
   * Owned-demo count as counted by the server. The quota meter reads this
   * rather than `myDemos().length`, which is only correct once the full owned
   * list has landed and reported "50 / 50" against the library page before it.
   * @type {number|null}
   */
  let mineOwnedCount = null;
  const mineEl = document.getElementById('rp-mine');
  let teamSearch = '';
  let playerSearch = '';
  let roundOwnSearch = '';
  let roundOppSearch = '';
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
    decidedPhases: new Set(),
    /**
     * Round-library keys the selected side ran / faced (any match).
     * Requires one map with a library and a side.
     * @type {Set<string>}
     */
    roundOwn: new Set(),
    /** @type {Set<string>} */
    roundOpp: new Set(),
    /** Library visibility scope: public catalog vs own + team-unlisted. */
    /** @type {'public'|'mine'} */
    libraryScope: 'public',
    /** Demo tags, lowercased. A demo must carry every one that is picked. */
    /** @type {Set<string>} */
    tags: new Set()
  };
  /** @type {Map<string, object|null>} */
  const roundMetaCache = new Map();
  /** Round-library tags from the stats index, keyed by round file. */
  /** @type {Map<string, { t: string[], ct: string[] }>|null} */
  let roundTagByFile = null;
  let roundTagToken = 0;

  /**
   * The status line is shared between uploading and filtering, and an upload
   * refreshes the library as it goes. Without this the filter's "nothing to
   * report" would wipe the upload's progress on every poll.
   */
  let uploadOwnsStatus = false;

  function setStatus(msg, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', isError);
  }

  /** setStatus for the filter, which yields to an upload in progress. */
  function setQueryStatus(msg) {
    if (uploadOwnsStatus) return;
    setStatus(msg);
  }

  // ---- quota + parser -----------------------------------------------------

  function renderQuota(usage) {
    if (!usage || !quotaEl) return;
    const demoCount = mineOwnedCount ?? myDemos().length;
    const demoCap = account.admin ? 0 : account.maxDemos || 5;
    const pctDemos = demoCap > 0 ? (demoCount / demoCap) * 100 : 0;
    const pctBytes = usage.maxBytes ? (usage.bytes / usage.maxBytes) * 100 : 0;
    const demosLine = demoCap
      ? `${demoCount} / ${demoCap} demos`
      : `${demoCount} demos`;
    quotaEl.innerHTML = `
      <div class="rp-quota-row">
        <span class="rp-quota-label">Demos</span>
        <span class="rp-quota-value">${escapeHtml(demosLine)}</span>
      </div>
      <div class="rp-meter"><span style="width:${Math.min(100, pctDemos)}%"></span></div>
      <div class="rp-quota-row">
        <span class="rp-quota-label">Storage</span>
        <span class="rp-quota-value">${formatBytes(usage.bytes)} / ${formatBytes(usage.maxBytes)}</span>
      </div>
      <div class="rp-meter"><span style="width:${Math.min(100, pctBytes)}%"></span></div>`;
  }

  /**
   * Warn about anything this host cannot do, before it is attempted.
   *
   * Both of these are properties of the machine rather than of the site, so
   * they are worth saying up front. Finding out that .rar is unsupported only
   * after transferring a few gigabytes is the worst possible moment.
   */
  function renderCapabilities(status) {
    if (status?.account) account = { ...account, ...status.account };
    if (!parserEl) return;
    const notes = [];
    const parser = status?.parser;
    if (parser && !parser.available) {
      notes.push(
        `Server-side .dem parsing is offline (${parser.name}). ` +
          `Run tools\\parse-demo.bat on your PC (drag-and-drop GUI), then upload the ${PACKAGE_EXT} package.`
      );
    }
    parserEl.hidden = notes.length === 0;
    parserEl.textContent = notes.join(' ');
  }

  // ---- demo list helpers --------------------------------------------------

  const TEAM_COLOR_KEY = 'aim4.teamColors';

  /** @type {Record<string, { h: number, s: number, v: number }> | null} */
  let teamColorCache = null;

  function loadTeamColors() {
    if (teamColorCache) return teamColorCache;
    try {
      const raw = localStorage.getItem(TEAM_COLOR_KEY);
      teamColorCache = raw ? JSON.parse(raw) : {};
      if (!teamColorCache || typeof teamColorCache !== 'object') teamColorCache = {};
    } catch {
      teamColorCache = {};
    }
    return teamColorCache;
  }

  function saveTeamColors() {
    try {
      localStorage.setItem(TEAM_COLOR_KEY, JSON.stringify(loadTeamColors()));
    } catch {
      /* quota / private mode */
    }
  }

  /**
   * Stable id for a team's crest colors — preferred by display name so the
   * palette survives cluster-key reshuffles as the library grows.
   * @param {string} [teamId]
   * @param {string} [teamName]
   */
  function teamColorKey(teamId, teamName) {
    const id = String(teamId || '').trim().toLowerCase();
    let name = String(teamName || '').trim().toLowerCase();
    if (id) {
      for (const c of teamClusters) {
        if (c.shortIds.some((s) => String(s).toLowerCase() === id)) {
          name = c.name.trim().toLowerCase() || name;
          break;
        }
      }
    } else if (name) {
      for (const c of teamClusters) {
        if (c.name.trim().toLowerCase() === name) {
          name = c.name.trim().toLowerCase();
          break;
        }
      }
    }
    if (name) return `name:${name}`;
    if (id) return `id:${id}`;
    return 'unknown';
  }

  /** HSV → CSS hsl(); s/v are 0–100. */
  function hslCss(h, s, v) {
    return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(v)}%)`;
  }

  /**
   * Persistent random crest palette per team.
   * BG: H 0–360, S 25–90%, V 15–30%. Text: same H, S 30%, V 90%.
   */
  function teamCrestColors(key) {
    const store = loadTeamColors();
    let c = store[key];
    if (!c || !Number.isFinite(c.h)) {
      c = {
        h: Math.random() * 360,
        s: 25 + Math.random() * 65,
        v: 15 + Math.random() * 15
      };
      store[key] = c;
      saveTeamColors();
    }
    return {
      bg: hslCss(c.h, c.s, c.v),
      fg: hslCss(c.h, 30, 90)
    };
  }

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

  /**
   * @param {string} t1
   * @param {string} t2
   * @param {string} score
   * @param {{ id1?: string, id2?: string }} [ids]
   */
  function matchBlockHtml(t1, t2, score, ids = {}) {
    const resolveFilterKey = (teamId, teamName) => {
      const colorKey = teamColorKey(teamId, teamName);
      if (teamClustersByKey.has(colorKey)) return colorKey;
      const id = String(teamId || '').trim().toLowerCase();
      if (id) {
        const hit = teamClusters.find((c) =>
          c.shortIds.some((s) => String(s).toLowerCase() === id)
        );
        if (hit) return hit.key;
      }
      const name = String(teamName || '').trim().toLowerCase();
      if (name) {
        const hit = teamClusters.find((c) => c.name.trim().toLowerCase() === name);
        if (hit) return hit.key;
      }
      return colorKey;
    };
    const key1 = teamColorKey(ids.id1, t1);
    const key2 = teamColorKey(ids.id2, t2);
    const c1 = teamCrestColors(key1);
    const c2 = teamCrestColors(key2);
    const fk1 = resolveFilterKey(ids.id1, t1);
    const fk2 = resolveFilterKey(ids.id2, t2);
    return `
      <div class="rp-row-match">
        <div class="rp-side home">
          <span class="rp-crest" style="background:${c1.bg};color:${c1.fg}">${escapeHtml(
            initials(t1)
          )}</span>
          <button type="button" class="rp-side-name" data-filter-team="${escapeHtml(
            fk1
          )}" title="Filter by ${escapeHtml(t1)}">${escapeHtml(t1)}</button>
        </div>
        <div class="rp-score">${escapeHtml(score)}</div>
        <div class="rp-side away">
          <span class="rp-crest" style="background:${c2.bg};color:${c2.fg}">${escapeHtml(
            initials(t2)
          )}</span>
          <button type="button" class="rp-side-name" data-filter-team="${escapeHtml(
            fk2
          )}" title="Filter by ${escapeHtml(t2)}">${escapeHtml(t2)}</button>
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
    const label = mapName || MAPS[mapCode]?.name || mapCode || 'Map';
    if (!src) {
      return mapCode
        ? `<button type="button" class="rp-map-filter rp-map-fallback" data-filter-map="${escapeHtml(
            mapCode
          )}" title="Filter by ${escapeHtml(label)}">${escapeHtml(label)}</button>`
        : '';
    }
    return `<button type="button" class="rp-map-filter" data-filter-map="${escapeHtml(
      mapCode
    )}" title="Filter by ${escapeHtml(label)}">
      <img class="rp-map-icon" src="${escapeHtml(src)}" alt="${escapeHtml(
        label
      )}" width="20" height="20" loading="lazy" draggable="false" />
    </button>`;
  }

  /**
   * Uploader line under the date. The colour is the visibility: gray public,
   * green unlisted, red private, which is the fastest way to read a library
   * where most rows are someone else's.
   */
  function byLineHtml(owner) {
    const visibility = owner?.visibility || 'public';
    const name = owner?.username || 'artysan';
    const title =
      visibility === 'private'
        ? 'Private: only the uploader can open this'
        : visibility === 'unlisted'
          ? 'Unlisted: the uploader, their team, and anyone with the link'
          : 'Public: anyone on the site';
    return `<span class="rp-by ${visibility}" title="${escapeHtml(title)}">by @${escapeHtml(
      name
    )}</span>`;
  }

  function rowMetaHtml(when, mapCode, mapName, owner = null) {
    return `
      <div class="rp-row-meta">
        <span class="rp-row-when-block">
          <span class="rp-row-when">${escapeHtml(when)}</span>
          ${byLineHtml(owner)}
        </span>
        ${mapIconHtml(mapCode, mapName)}
      </div>`;
  }

  /**
   * The two facts that ride on a demo row: who played best, and how much this
   * match has been looked at.
   *
   * Deliberately short. A card is for picking a match out of a list, and every
   * extra number on it makes that harder rather than easier.
   */
  function demoFactsHtml(d) {
    const parts = [];
    const top = d?.topPlayer;
    if (top?.name && Number.isFinite(top.rating)) {
      parts.push(
        `<span class="rp-demo-fact top" title="Best rating in this match">
          <span class="rp-demo-fact-name">${escapeHtml(top.name)}</span>
          <span class="rp-demo-fact-value">${top.rating.toFixed(2)}</span>
        </span>`
      );
    }
    const views = Number(d?.views) || 0;
    if (views > 0) {
      parts.push(
        `<span class="rp-demo-fact views" title="Rounds opened from this match">${views}</span>`
      );
    }
    const tags = Array.isArray(d?.tags) ? d.tags : [];
    for (const t of tags) {
      parts.push(`<span class="rp-demo-tag">${escapeHtml(t)}</span>`);
    }
    if (!parts.length) return '<div class="rp-demo-facts"></div>';
    return `<div class="rp-demo-facts">${parts.join('')}</div>`;
  }

  const VISIBILITY_OPTIONS = [
    { key: 'public', label: 'Public', note: 'Anyone on the site can watch it.' },
    { key: 'unlisted', label: 'Unlisted', note: 'Your team, and anyone with the link.' },
    { key: 'private', label: 'Private', note: 'Only you, link or not.' }
  ];

  /** Demos this account uploaded. Admins see the whole library here. */
  function myDemos() {
    if (!account.signedIn) return [];
    // Already filtered by the server, and re-filtering would empty the list
    // whenever this runs before /status has told us our own account id.
    if (mineDemosLoaded) return mineDemos;
    if (account.admin) return demos;
    return demos.filter((d) => (d.owner?.id || '') === account.id);
  }

  /**
   * Load every demo the uploads page needs.
   *
   * `mine=1` is resolved server-side, so this no longer depends on the library
   * page size, and no longer re-downloads the whole shared library to throw
   * most of it away.
   *
   * Coalesced: onShow fires this from setSubpage and again from refresh(), and
   * two full listings racing is both wasted work and a way for the older
   * response to overwrite the newer one.
   */
  let mineInFlight = null;
  async function refreshMineDemos() {
    if (!auth?.isLoggedIn && !account.signedIn) {
      mineDemos = [];
      mineDemosLoaded = false;
      return;
    }
    if (mineInFlight) return mineInFlight;
    mineInFlight = (async () => {
      try {
        const list = await fetchDemos({ mine: true });
        mineDemos = list.demos || [];
        if (Number.isFinite(list.owned)) mineOwnedCount = Number(list.owned);
        mineDemosLoaded = true;
      } catch {
        // Keep whatever we had; fall back to the paged library list in myDemos().
        mineDemosLoaded = mineDemos.length > 0;
      } finally {
        mineInFlight = null;
      }
    })();
    return mineInFlight;
  }

  /**
   * The parse's version, as plain numbers: our adapter revision, then the
   * parser package it ran on.
   *
   * Round files are only as current as the parse that produced them. When the
   * adapter is fixed, everything already on disk keeps the old answer until it
   * is parsed again, and without this stamp there is nothing on the page that
   * says so.
   */
  function parserStampHtml(d) {
    const rev = Number(d?.parser?.revision);
    const ver = String(d?.parser?.version || '').trim();
    const parts = [];
    if (Number.isFinite(rev) && rev > 0) parts.push(String(rev));
    if (ver && ver !== 'unknown') parts.push(ver);
    if (!parts.length) return '';
    return `<span class="rp-mine-parser" title="Adapter revision and parser version">${escapeHtml(
      parts.join(' · ')
    )}</span>`;
  }

  function renderMine() {
    if (!mineEl) return;
    if (!account.signedIn) {
      // Being signed in here but not there is a server configuration problem,
      // not something the user can fix by signing in again.
      const sessionButNoServer = Boolean(auth?.isLoggedIn);
      mineEl.innerHTML = sessionButNoServer
        ? `<p class="view-empty">${escapeHtml(
            account.verifies === false
              ? 'The replay backend cannot verify sign-ins yet. Set SUPABASE_URL and SUPABASE_ANON_KEY on the server, then reload.'
              : 'Your session did not reach the replay backend. Reload the page, and sign in again if that does not help.'
          )}</p>`
        : '<p class="view-empty">Sign in to upload demos and manage your own uploads.</p>';
      return;
    }
    const mine = myDemos();
    const mineIds = new Set(mine.map((d) => d.id));
    for (const id of [...selectedMine]) {
      if (!mineIds.has(id)) selectedMine.delete(id);
    }
    const selCount = selectedMine.size;

    const sorted = mine
      .slice()
      .sort((a, b) => (b.uploadedAt || b.parsedAt || 0) - (a.uploadedAt || a.parsedAt || 0));
    const total = sorted.length;
    const pages = Math.max(1, Math.ceil(total / MINE_PAGE_SIZE) || 1);
    if (minePage > pages) minePage = pages;
    if (minePage < 1) minePage = 1;
    const usePages = total > MINE_PAGE_SIZE;
    const pageItems = usePages
      ? sorted.slice((minePage - 1) * MINE_PAGE_SIZE, minePage * MINE_PAGE_SIZE)
      : sorted;
    const allSelected =
      pageItems.length > 0 && pageItems.every((d) => selectedMine.has(d.id));

    const rows = pageItems
      .map((d) => {
        const id = escapeHtml(d.id);
        const mapName = d.mapName || (d.map ? MAPS[d.map]?.name : '') || '';
        const visibility = d.owner?.visibility || 'public';
        const checked = selectedMine.has(d.id);
        return `
        <tr data-id="${id}" class="${checked ? 'is-selected' : ''}" tabindex="0">
          <td class="rp-mine-check">
            <input type="checkbox" data-mine-check="${id}" ${checked ? 'checked' : ''} aria-label="Select demo" />
          </td>
          <td class="rp-mine-when">
            ${escapeHtml(formatWhen(d.uploadedAt || d.parsedAt))}
            ${parserStampHtml(d)}
          </td>
          <td class="rp-mine-match">${escapeHtml(d.team1?.name || 'Team 1')} vs ${escapeHtml(
            d.team2?.name || 'Team 2'
          )}</td>
          <td class="rp-mine-map">${escapeHtml(mapName)}</td>
          <td class="rp-mine-tags">
            <input class="site-input rp-mine-tag-input" data-set-tags="${id}"
              value="${escapeHtml((d.tags || []).join(', '))}"
              placeholder="Tags" title="Comma separated. Your own labels." />
          </td>
          <td class="rp-mine-vis">
            <select class="site-select rp-mine-vis-select" data-set-visibility="${id}" title="Who can see this demo">
              ${VISIBILITY_OPTIONS.map(
                (o) =>
                  `<option value="${o.key}"${visibility === o.key ? ' selected' : ''}>${escapeHtml(
                    o.label
                  )}</option>`
              ).join('')}
            </select>
          </td>
          <td class="rp-mine-actions">
            <button type="button" class="rp-btn-icon" data-rename="${id}" title="Rename teams">Aa</button>
            <button type="button" class="rp-btn-icon danger" data-delete="${id}" title="Delete">${deleteIconHtml()}</button>
          </td>
        </tr>`;
      })
      .join('');

    const bulk =
      selCount > 0
        ? `<div class="rp-mine-bulk">
            <span class="rp-mine-bulk-count">${selCount} selected</span>
            <span class="rp-vis-label">Set to</span>
            <div class="rp-chips">
              ${VISIBILITY_OPTIONS.map(
                (o) =>
                  `<button type="button" class="rp-chip vis-${o.key}" data-bulk-visibility="${o.key}" title="${escapeHtml(
                    o.note
                  )}">${escapeHtml(o.label)}</button>`
              ).join('')}
            </div>
            <button type="button" class="btn btn-sm" data-mine-deselect>Deselect</button>
          </div>`
        : '';

    const from = total ? (minePage - 1) * MINE_PAGE_SIZE + 1 : 0;
    const to = Math.min(minePage * MINE_PAGE_SIZE, total);
    const pager = usePages
      ? `<div class="rp-mine-pager">
          <span class="rp-mine-pager-meta">${from}–${to} of ${total}</span>
          <div class="rp-mine-pager-btns">
            <button type="button" class="btn btn-sm" data-mine-page="1"${
              minePage <= 1 ? ' disabled' : ''
            }>First</button>
            <button type="button" class="btn btn-sm" data-mine-page="${minePage - 1}"${
              minePage <= 1 ? ' disabled' : ''
            }>Prev</button>
            <span class="rp-mine-pager-page">Page ${minePage} / ${pages}</span>
            <button type="button" class="btn btn-sm" data-mine-page="${minePage + 1}"${
              minePage >= pages ? ' disabled' : ''
            }>Next</button>
            <button type="button" class="btn btn-sm" data-mine-page="${pages}"${
              minePage >= pages ? ' disabled' : ''
            }>Last</button>
          </div>
        </div>`
      : '';

    mineEl.innerHTML = `
      <div class="rp-mine-head">
        <h3 class="rp-mine-title">My uploads</h3>
      </div>
      ${bulk}
      ${
        rows
          ? `<table class="rp-mine-table">
              <thead><tr>
                <th class="rp-mine-check">
                  <input type="checkbox" data-mine-select-all ${allSelected ? 'checked' : ''} title="${
                    allSelected ? 'Deselect page' : 'Select page'
                  }" aria-label="${allSelected ? 'Deselect page' : 'Select page'}" />
                </th>
                <th>Uploaded</th><th>Match</th><th>Map</th><th>Tags</th><th>Visibility</th><th></th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>${pager}`
          : '<p class="view-empty">You have not uploaded anything yet.</p>'
      }`;
  }

  async function applyMineVisibility(ids, visibility) {
    const list = [...ids];
    if (!list.length) return;
    let ok = 0;
    let lastErr = '';
    for (const id of list) {
      try {
        const res = await setDemoVisibility(id, visibility);
        const demo = res?.demo;
        if (demo) {
          const patch = (arr) => {
            const i = arr.findIndex((d) => d.id === id);
            const next = {
              ...(i >= 0 ? arr[i] : {}),
              ...demo,
              visibility: demo.owner?.visibility || demo.visibility || visibility,
              owner: demo.owner || {
                ...(i >= 0 ? arr[i]?.owner : {}),
                visibility
              }
            };
            if (i >= 0) arr[i] = next;
            else arr.push(next);
          };
          patch(demos);
          if (mineDemosLoaded) patch(mineDemos);
        }
        ok++;
      } catch (err) {
        lastErr = err?.message || 'Failed to update visibility.';
      }
    }
    if (ok) {
      setStatus(
        ok === 1
          ? `Visibility set to ${visibility}.`
          : `Set ${ok} demos to ${visibility}.${lastErr ? ` (${list.length - ok} failed)` : ''}`
      );
    } else if (lastErr) {
      setStatus(lastErr, true);
    }
    renderMine();
  }

  /**
   * Who may rename or delete a demo. The server enforces uploader-or-admin;
   * this is the narrower UI rule.
   *
   * @param {object} d
   * @param {boolean} [own]  true on the My Uploads page, where the uploader's
   *   own rows carry the controls. The library list keeps them for site admins
   *   only, so a shared library does not sprout a delete button on every row.
   */
  function canManageDemo(d, own = false) {
    if (account.admin) return true;
    if (!own) return false;
    return Boolean(account.id) && (d?.owner?.id || '') === account.id;
  }

  function demoActionsHtml(d) {
    const status = d.status || 'ready';
    const id = escapeHtml(d.id);
    const mine = canManageDemo(d);
    return `
      <div class="rp-row-actions">
        ${status === 'error' ? `<button type="button" class="btn btn-sm" data-retry="${id}">Retry</button>` : ''}
        ${
          status === 'ready' && mine
            ? `<button type="button" class="rp-btn-icon" data-rename="${id}" title="Rename teams">Aa</button>`
            : ''
        }
        ${
          mine
            ? `<button type="button" class="rp-btn-icon danger" data-delete="${id}" title="Delete">
          ${deleteIconHtml()}
        </button>`
            : ''
        }
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
        ${rowMetaHtml(formatWhen(d.uploadedAt || d.parsedAt), d.map, mapName, d.owner)}
        ${matchBlockHtml(t1, t2, demoScoreText(d), {
          id1: d.team1?.id,
          id2: d.team2?.id
        })}
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
      const id = open.dataset.open;
      let demo = demos.find((d) => d.id === id);
      if (!demo) {
        try {
          demo = (await fetchDemo(id))?.demo || null;
        } catch {
          demo = null;
        }
      }
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
      const id = demoStats.dataset.demoStats;
      let demo = demos.find((d) => d.id === id);
      if (!demo) {
        try {
          demo = (await fetchDemo(id))?.demo || null;
        } catch {
          demo = null;
        }
      }
      if (demo) {
        showStats({
          demos: [demo.id],
          title: `${demo.team1?.name || 'Team 1'} vs ${demo.team2?.name || 'Team 2'}`
        });
      }
      return true;
    }
    if (rename) {
      const id = rename.dataset.rename;
      let demo = demos.find((d) => d.id === id);
      if (!demo) {
        try {
          demo = (await fetchDemo(id))?.demo || null;
        } catch {
          demo = null;
        }
      }
      if (demo) await promptTeamNames(demo);
      return true;
    }
    if (retry) {
      await reparseDemo(retry.dataset.retry).catch((err) => setStatus(err.message, true));
      refresh();
      return true;
    }
    if (del) {
      const id = del.dataset.delete;
      const demo = demoById(id);
      const label =
        demo?.team1 && demo?.team2
          ? `${demo.team1.name} vs ${demo.team2.name}`
          : demo?.filename || 'this replay';
      if (!window.confirm(`Delete ${label} and every round parsed from it?`)) return true;
      try {
        const res = await deleteDemo(id);
        extraDemos.delete(id);
        mineDemos = mineDemos.filter((d) => d.id !== id);
        demos = demos.filter((d) => d.id !== id);
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

  /**
   * Ask who may see a freshly uploaded demo. Uploads land as private; if this
   * prompt never runs (tab closed / offline), they stay private.
   */
  function promptDemoVisibility(demoOrId) {
    const id = typeof demoOrId === 'string' ? demoOrId : demoOrId?.id;
    if (!id) return Promise.resolve();
    const label =
      typeof demoOrId === 'object' && demoOrId
        ? `${demoOrId.team1?.name || 'Team 1'} vs ${demoOrId.team2?.name || 'Team 2'}`
        : id;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'rp-name-dialog';
      overlay.innerHTML = `
        <div class="rp-name-card" role="dialog" aria-label="Demo visibility">
          <h3>Who can see this demo?</h3>
          <p>${escapeHtml(label)} is private until you pick. If you close this without choosing, it stays private.</p>
          <div class="rp-vis-prompt-chips">
            ${VISIBILITY_OPTIONS.map(
              (o) =>
                `<button type="button" class="btn btn-sm vis-pick vis-${o.key}" data-pick="${o.key}" title="${escapeHtml(
                  o.note
                )}">${escapeHtml(o.label)}</button>`
            ).join('')}
          </div>
          <p class="rp-vis-prompt-note">Public: anyone · Unlisted: team + link · Private: only you</p>
          <div class="rp-name-actions">
            <button type="button" class="btn btn-sm" data-skip>Keep private</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const close = () => {
        overlay.remove();
        resolve();
      };

      overlay.querySelector('[data-skip]').addEventListener('click', close);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      overlay.querySelectorAll('[data-pick]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const visibility = btn.dataset.pick;
          try {
            await applyMineVisibility([id], visibility);
          } catch (err) {
            setStatus(err?.message || 'Could not set visibility.', true);
          }
          close();
        });
      });
    });
  }

  // ---- upload -------------------------------------------------------------

  /**
   * What the server will accept. Archives may hold several demos each; .gz and
   * .zst are single-stream compressors and can only ever carry one.
   */
  const UPLOAD_RE = /\.(dem|zip|rar|tar|tar\.gz|tgz|tar\.zst|tzst|gz|zst)$/i;

  /** Overwritten from /api/replays/status; this is only the pre-first-load guess. */
  let maxUploadBytes = 5 * 1024 ** 3;

  function pickUploadFiles(fileList) {
    const files = [...(fileList || [])];
    const ok = [];
    const skipped = [];
    const tooBig = [];
    for (const file of files) {
      const name = file.name || '';
      const lower = name.toLowerCase();
      if (!lower.endsWith(PACKAGE_EXT) && !UPLOAD_RE.test(name)) {
        skipped.push(name || 'unnamed');
      } else if (file.size > maxUploadBytes) {
        // Caught here so a rejection does not cost the user the whole transfer
        // first. The server enforces the same limit regardless.
        tooBig.push(name || 'unnamed');
      } else {
        ok.push(file);
      }
    }
    return { ok, skipped, tooBig };
  }

  // ---- upload progress ----------------------------------------------------

  /**
   * The four phases the backend moves each demo through. An archive can hold
   * several, so these are counts, not steps.
   */
  const PHASE_LABELS = [
    ['unpacked', 'Unpacked'],
    ['parsed', 'Parsed'],
    ['analyzed', 'Analyzed']
  ];

  function clearProgress() {
    if (!progressEl) return;
    progressEl.hidden = true;
    progressEl.innerHTML = '';
  }

  /**
   * @param {number} uploadPct  0-100 for the transfer itself
   * @param {object|null} batch  server-side batch status, once there is one
   */
  function renderProgress(uploadPct, batch) {
    if (!progressEl) return;
    const files = batch?.totals?.files || 0;
    // Before unpacking finishes there is no file count, so the transfer is the
    // only honest thing to show. Weight it as a quarter of the whole job.
    const done = files
      ? batch.totals.unpacked + batch.totals.parsed + batch.totals.analyzed
      : 0;
    const backendPct = files ? (done / (files * 3)) * 100 : 0;
    const pct = files ? 25 + backendPct * 0.75 : Math.min(25, uploadPct * 0.25);

    const counts = files
      ? PHASE_LABELS.map(
          ([key, label]) =>
            `<span class="rp-phase${batch.totals[key] === files ? ' is-done' : ''}">
               ${label} ${batch.totals[key]}/${files}
             </span>`
        ).join('')
      : `<span class="rp-phase">Uploaded ${uploadPct}%</span>`;

    const failed = batch?.totals?.failed
      ? `<span class="rp-phase is-error">Failed ${batch.totals.failed}</span>`
      : '';

    progressEl.hidden = false;
    progressEl.innerHTML = `
      <div class="rp-meter"><span style="width:${Math.min(100, Math.max(0, pct))}%"></span></div>
      <div class="rp-phases">${counts}${failed}</div>`;
  }

  /**
   * Follow one upload until the server is finished with it.
   *
   * The batch is polled rather than pushed: parsing is serialized on the
   * backend and takes minutes, which is far too long to hold a connection open
   * for on a host that will time it out.
   */
  async function followBatch(batchId, label) {
    for (;;) {
      let batch;
      try {
        ({ batch } = await fetchUploadBatch(batchId));
      } catch (err) {
        // The batch is dropped some time after it settles, so a 404 here means
        // it finished rather than that anything went wrong.
        if (err.status === 404) return null;
        throw err;
      }
      renderProgress(100, batch);

      const t = batch.totals;
      if (batch.stage === 'unpacking') setStatus(`${label}Unpacking…`);
      else if (batch.stage === 'error' && !t.files) setStatus(batch.error, true);
      else {
        const current = batch.files.find((f) => !f.failed && f.phase === 'unpacked');
        const where = current?.total
          ? ` (${current.name}, round ${current.round}/${current.total})`
          : current
            ? ` (${current.name})`
            : '';
        setStatus(`${label}Parsed ${t.parsed}/${t.files}, analyzed ${t.analyzed}/${t.files}${where}`);
      }

      if (batch.stage === 'done' || batch.stage === 'error') return batch;
      await refresh();
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  // ---- surviving a page leave ---------------------------------------------
  // Once the bytes have landed the server is on its own: unpacking, parsing and
  // indexing all run detached from the request that started them, and the batch
  // is snapshotted to the volume as it goes. So the only thing a reload used to
  // cost was the WATCHING — and, worse, a multi-file drop would abandon the
  // files it had not sent yet, because it waited for each parse before
  // uploading the next. Both are fixed here: every file is uploaded up front,
  // and the batch ids are remembered so a returning tab picks them back up.

  const PENDING_KEY = 'aim4.replays.pendingUploads';
  /** True while bytes are actually moving — the one thing a reload really kills. */
  let transferring = false;
  /** True while resumePendingUploads is already following what it found. */
  let resuming = false;

  function readPending() {
    try {
      const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((b) => b && typeof b.id === 'string') : [];
    } catch {
      return [];
    }
  }

  function writePending(list) {
    try {
      if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
      else localStorage.removeItem(PENDING_KEY);
    } catch {
      /* private mode / full quota: following still works for this tab */
    }
  }

  function rememberBatch(id, name) {
    const list = readPending().filter((b) => b.id !== id);
    list.push({ id, name, at: Date.now() });
    writePending(list);
  }

  function forgetBatch(id) {
    writePending(readPending().filter((b) => b.id !== id));
  }

  /**
   * Re-attach to uploads that were still running when the page went away.
   *
   * A batch the server no longer knows about is dropped quietly rather than
   * reported: it finished, and the library listing is where its result lives.
   */
  async function resumePendingUploads() {
    // onShow fires on every navigation back into the view; one follower is enough.
    if (resuming || transferring) return;
    const pending = readPending();
    if (!pending.length) return;
    // Older than the server's snapshot window is not worth asking about.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const live = pending.filter((b) => (b.at || 0) > cutoff);
    if (live.length !== pending.length) writePending(live);
    if (!live.length) return;

    // Set only once there is something to follow, and released in the finally
    // below: an early return that left this true would disable resume for the
    // rest of the session.
    resuming = true;
    uploadOwnsStatus = true;
    try {
      for (const entry of live) {
        let batch;
        try {
          ({ batch } = await fetchUploadBatch(entry.id));
        } catch {
          forgetBatch(entry.id);
          continue;
        }
        if (batch.stage === 'done' || batch.stage === 'error') {
          forgetBatch(entry.id);
          continue;
        }
        setStatus(`Still working on ${entry.name || 'your upload'}…`);
        await followBatch(entry.id, '');
        forgetBatch(entry.id);
      }
      await refresh();
    } finally {
      resuming = false;
      uploadOwnsStatus = false;
      clearProgress();
    }
  }

  // Only a transfer in progress is worth interrupting someone for; anything
  // past that finishes on the server whether the tab is open or not.
  window.addEventListener('beforeunload', (e) => {
    if (!transferring) return;
    e.preventDefault();
    e.returnValue = '';
  });

  mineEl?.addEventListener('click', async (e) => {
    const pageBtn = e.target.closest('[data-mine-page]');
    if (pageBtn) {
      const next = Number(pageBtn.dataset.minePage);
      if (Number.isFinite(next) && next >= 1) {
        minePage = next;
        renderMine();
        mineEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      return;
    }
    const bulkVis = e.target.closest('[data-bulk-visibility]');
    if (bulkVis) {
      await applyMineVisibility([...selectedMine], bulkVis.dataset.bulkVisibility);
      return;
    }
    if (e.target.closest('[data-mine-deselect]')) {
      selectedMine.clear();
      renderMine();
      return;
    }
    const selectAll = e.target.closest('[data-mine-select-all]');
    if (selectAll) {
      const sorted = myDemos()
        .slice()
        .sort((a, b) => (b.uploadedAt || b.parsedAt || 0) - (a.uploadedAt || a.parsedAt || 0));
      const usePages = sorted.length > MINE_PAGE_SIZE;
      const pageItems = usePages
        ? sorted.slice((minePage - 1) * MINE_PAGE_SIZE, minePage * MINE_PAGE_SIZE)
        : sorted;
      const allOn = pageItems.length > 0 && pageItems.every((d) => selectedMine.has(d.id));
      if (allOn) for (const d of pageItems) selectedMine.delete(d.id);
      else for (const d of pageItems) selectedMine.add(d.id);
      renderMine();
      return;
    }
    const check = e.target.closest('[data-mine-check]');
    if (check) {
      const id = check.dataset.mineCheck;
      if (check.checked) selectedMine.add(id);
      else selectedMine.delete(id);
      renderMine();
      return;
    }
    if (e.target.closest('[data-rename], [data-delete], [data-retry], [data-open], [data-demo-stats]')) {
      await handleDemoAction(e.target);
      return;
    }
    // Clicking the row (not controls) toggles selection.
    if (e.target.closest('select, button, a, input, label')) return;
    const row = e.target.closest('tr[data-id]');
    if (row?.dataset.id) {
      const id = row.dataset.id;
      if (selectedMine.has(id)) selectedMine.delete(id);
      else selectedMine.add(id);
      renderMine();
    }
  });

  mineEl?.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-set-visibility]');
    if (sel) {
      applyMineVisibility([sel.dataset.setVisibility], sel.value);
      return;
    }
    // Tags commit on blur / Enter, which is what `change` is on a text input.
    const tagInput = e.target.closest('[data-set-tags]');
    if (tagInput) void applyDemoTags(tagInput.dataset.setTags, tagInput.value);
  });

  /**
   * Save one demo's tags from the comma-separated field.
   *
   * The server normalizes (trim, dedupe, cap), so what comes back is what is
   * stored and the field is repainted from it rather than from what was typed.
   */
  async function applyDemoTags(id, raw) {
    const tags = String(raw || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const res = await setDemoTags(id, tags);
      const next = res?.demo;
      if (!next) return;
      const apply = (list) => {
        const at = (list || []).findIndex((d) => d.id === id);
        if (at >= 0) list[at] = { ...list[at], tags: next.tags || [] };
      };
      apply(demos);
      apply(mineDemos);
      renderMine();
      renderResults();
    } catch (err) {
      setStatus(err?.message || 'Could not save tags.', true);
    }
  }

  async function startUpload(fileList) {
    if (!account.signedIn) {
      setStatus(
        auth?.isLoggedIn
          ? 'The replay backend did not accept your session, so uploading is blocked. Reload the page and try again.'
          : 'Sign in to upload demos.',
        true
      );
      return;
    }
    const cap0 = account.admin ? 0 : account.maxDemos || 5;
    if (cap0 && myDemos().length >= cap0) {
      setStatus(
        `You already have ${myDemos().length} demos uploaded. Delete one first (limit ${cap0}).`,
        true
      );
      return;
    }
    const { ok, skipped, tooBig } = pickUploadFiles(fileList);
    const cap = `${Math.round(maxUploadBytes / 1024 ** 3)} GB`;
    if (!ok.length) {
      setStatus(
        tooBig.length
          ? `One upload can be up to ${cap}, however many demos it holds. Split the archive and try again.`
          : `Upload .dem files, .zip / .rar / .tar.gz / .gz / .zst archives, or ${PACKAGE_EXT} packages.`,
        true
      );
      return;
    }
    const notes = [];
    if (skipped.length) {
      notes.push(`Skipped ${skipped.length} unsupported file${skipped.length === 1 ? '' : 's'}.`);
    }
    if (tooBig.length) {
      notes.push(`Skipped ${tooBig.length} over ${cap}.`);
    }
    if (notes.length) setStatus(notes.join(' '), true);

    dropEl?.classList.add('busy');
    uploadOwnsStatus = true;
    let imported = 0;
    let parsed = 0;
    let failed = 0;
    /**
     * Reasons an upload died before it produced a single demo.
     *
     * These live on the batch rather than on any file, because there were no
     * files. Counting only per-file outcomes made a whole-upload failure look
     * like "nothing succeeded and nothing failed", which then reported itself
     * as "Upload complete." over the top of the real error.
     */
    const batchErrors = [];
    const namingQueue = [];
    /** @type {string[]} */
    const visibilityQueue = [];
    /** @type {{id: string, name: string, label: string}[]} */
    const queued = [];
    try {
      // Pass one: get every file onto the server. Nothing here waits on a parse,
      // so dropping ten demos and walking away leaves all ten queued rather than
      // one uploaded and nine abandoned in the browser.
      // Visibility starts private; the prompt after parse is what opens it up.
      // If the tab is gone when parsing finishes, demos stay private.
      transferring = true;
      for (let i = 0; i < ok.length; i++) {
        const file = ok[i];
        const name = file.name || `file ${i + 1}`;
        const isPackage = name.toLowerCase().endsWith(PACKAGE_EXT);
        const label = ok.length > 1 ? `(${i + 1}/${ok.length}) ` : '';

        setStatus(`Uploading ${label}${name}…`);
        renderProgress(0, null);
        const onProgress = (pct) => {
          setStatus(`Uploading ${label}${name}: ${pct}%`);
          renderProgress(pct, null);
        };

        if (isPackage) {
          // A package is already parsed, so it lands ready and skips the queue.
          const res = await uploadImport(file, onProgress);
          renderQuota(res.usage);
          imported++;
          if (res.demo) {
            namingQueue.push(res.demo);
            if (res.demo.id) visibilityQueue.push(res.demo.id);
          }
          continue;
        }

        const res = await uploadDemo(file, onProgress, 'private');
        renderQuota(res.usage);
        rememberBatch(res.batch.id, name);
        queued.push({ id: res.batch.id, name, label });
      }
      transferring = false;

      // Pass two: watch what the server is doing with them. Leaving at any
      // point from here on is safe.
      if (queued.length) await refresh();
      for (const item of queued) {
        const batch = await followBatch(item.id, item.label);
        forgetBatch(item.id);
        if (batch) {
          parsed += batch.totals.parsed;
          failed += batch.totals.failed;
          if (batch.stage === 'error' && !batch.totals.files) {
            batchErrors.push(batch.error || `Could not unpack ${item.name}.`);
          }
          for (const f of batch.files || []) {
            if (!f.failed && f.demoId) visibilityQueue.push(f.demoId);
          }
        } else {
          // The batch is dropped once it settles, so losing track of it is not
          // proof of success either.
          batchErrors.push(`Lost track of ${item.name} before it finished.`);
        }
      }

      const parts = [];
      if (imported) parts.push(imported === 1 ? '1 package imported.' : `${imported} packages imported.`);
      if (parsed) parts.push(parsed === 1 ? '1 demo parsed.' : `${parsed} demos parsed.`);
      if (failed) parts.push(failed === 1 ? '1 demo failed.' : `${failed} demos failed.`);
      parts.push(...batchErrors);

      const nothingLanded = !imported && !parsed;
      setStatus(
        parts.join(' ') || 'Upload complete.',
        nothingLanded && (failed > 0 || batchErrors.length > 0)
      );
      await refresh();

      const seenVis = new Set();
      for (const id of visibilityQueue) {
        if (!id || seenVis.has(id)) continue;
        seenVis.add(id);
        const demo = demos.find((d) => d.id === id);
        await promptDemoVisibility(demo || id);
      }
      for (const demo of namingQueue) {
        await promptTeamNames(demo);
      }
    } catch (err) {
      setStatus(err.message, true);
      await refresh();
    } finally {
      transferring = false;
      // Released last, after the closing refresh, so the result the user needs
      // to read survives the library reload that follows it.
      uploadOwnsStatus = false;
      dropEl?.classList.remove('busy');
      if (uploadInput) uploadInput.value = '';
      if (!failed && !batchErrors.length) clearProgress();
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

  /** Full-library clusters from the last demos fetch (not just the current page). */
  let libraryTeamClusters = [];

  function rebuildTeamClusters() {
    teamClusters = libraryTeamClusters.length
      ? libraryTeamClusters
      : clusterTeams(demos.filter((d) => (d.status || 'ready') === 'ready'));
    teamClustersByKey = new Map(teamClusters.map((c) => [c.key, c]));
    for (const key of [...filters.teams]) {
      if (!teamClustersByKey.has(key)) filters.teams.delete(key);
    }
    if (!filters.teams.size) filters.wonByMode = '';
  }

  /** Team / player filters must search the whole library, not the demo page. */
  function libraryWideFilters() {
    return Boolean(filters.teams.size || filters.players.size);
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

  function econSelectHtml(id, selected, placeholder) {
    const opts = [
      `<option value=""${selected == null ? ' selected' : ''}>${escapeHtml(placeholder)}</option>`,
      ...Object.entries(ECONOMIES).map(
        ([code, e]) =>
          `<option value="${code}"${selected === Number(code) ? ' selected' : ''}>${escapeHtml(
            e.label
          )}</option>`
      )
    ];
    return `<select id="${id}" class="site-input rp-econ-select" aria-label="${escapeHtml(
      placeholder
    )}">${opts.join('')}</select>`;
  }

  function hasAwpCheckHtml(id, checked) {
    return `<label class="rp-awp-toggle${checked ? ' active' : ''}" title="Has AWP">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} aria-label="Has AWP" />
      <span>AWP</span>
    </label>`;
  }

  /** Opening situations shown in the library filter (no 5v5). */
  const FILTER_SITUATIONS = [
    { key: '4v4', label: '4v4' },
    { key: '5v4', label: '5v4' },
    { key: '5v3', label: '5v3' },
    { key: '4v5', label: '4v5' },
    { key: '3v5', label: '3v5' }
  ];

  function demoVisibility(d) {
    return String(d?.owner?.visibility || d?.visibility || 'public').toLowerCase();
  }

  function demoOwnerId(d) {
    return d?.owner?.id || d?.uploaderId || '';
  }

  function isOwnDemo(d) {
    return Boolean(account.signedIn && account.id && demoOwnerId(d) === account.id);
  }

  /**
   * Public: every public demo, plus everything you uploaded, plus the unlisted
   * demos you have been given access to.
   * My Uploads: only your uploads and team-visible unlisted demos.
   *
   * An unlisted demo only ever reaches the client when the server decided the
   * caller may browse it, which means it is theirs or a teammate's. Dropping it
   * here was the whole reason "unlisted" looked broken to a teammate: the demo
   * arrived, the default scope threw it away, and nothing said so.
   */
  function demoMatchesScope(d) {
    if (!d) return false;
    if (!demoMatchesTags(d)) return false;
    const mine = isOwnDemo(d);
    const vis = demoVisibility(d);
    if (filters.libraryScope === 'mine') return mine || vis === 'unlisted';
    return vis === 'public' || vis === 'unlisted' || mine;
  }

  /** Picked tags are ANDed: narrowing is the only thing a tag filter is for. */
  function demoMatchesTags(d) {
    if (!filters.tags.size) return true;
    const held = new Set((d?.tags || []).map((t) => String(t).toLowerCase()));
    for (const want of filters.tags) if (!held.has(want)) return false;
    return true;
  }

  /** Every tag in the library, with how many demos carry it. */
  function tagCounts() {
    const out = new Map();
    for (const d of demos) {
      for (const raw of d?.tags || []) {
        const key = String(raw).toLowerCase();
        const held = out.get(key);
        if (held) held.count += 1;
        else out.set(key, { key, label: String(raw), count: 1 });
      }
    }
    return [...out.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    );
  }

  function tagFilterHtml() {
    const all = tagCounts();
    if (!all.length) return '';
    return `<div class="rp-filter-group">
      <div class="rp-tag-filter">
        ${all
          .map(
            (t) =>
              `<button type="button" class="rp-chip rp-tag-chip${
                filters.tags.has(t.key) ? ' active' : ''
              }" data-tag-filter="${escapeHtml(t.key)}">${escapeHtml(t.label)}<span class="rp-tag-count">${
                t.count
              }</span></button>`
          )
          .join('')}
      </div>
    </div>`;
  }

  function scopedDemos(list = demos) {
    return list.filter(demoMatchesScope);
  }

  function roundMatchesScope(r) {
    const id = r?.demoId || splitStoredName(r?.file)?.demoId;
    if (!id) return false;
    const d = demoById(id);
    if (!d) return false;
    return demoMatchesScope(d);
  }

  function libraryScopeHtml() {
    const btn = (key, label) =>
      `<button type="button" class="rp-seg-btn${
        filters.libraryScope === key ? ' active' : ''
      }" data-library-scope="${key}">${label}</button>`;
    return `<div class="rp-filter-group">
      <div class="rp-seg rp-seg-scope" role="group" aria-label="Library scope">
        ${btn('public', 'Public')}
        ${btn('mine', 'My Uploads')}
      </div>
    </div>`;
  }

  function sideSegHtml(enabled) {
    if (!enabled) return '';
    const btn = (side, src, label) =>
      `<button type="button" class="rp-seg-btn${
        filters.side === side ? ' active' : ''
      }" data-adv-side="${side}" aria-label="${label}" title="${label}">
        <img src="${src}" alt="" width="18" height="18" draggable="false" />
      </button>`;
    return `<div class="rp-filter-group">
      <div class="rp-seg rp-seg-side" role="group" aria-label="Side">
        ${btn('T', '/icons/icon_t.png', 'T')}
        ${btn('CT', '/icons/icon_ct.png', 'CT')}
      </div>
    </div>`;
  }

  function situationSegHtml(enabled) {
    if (!enabled) return '';
    return `<div class="rp-filter-group">
      <div class="rp-seg rp-seg-sit" role="group" aria-label="Situation">
        ${FILTER_SITUATIONS.map(
          (s) =>
            `<button type="button" class="rp-seg-btn${
              filters.situations.has(s.key) ? ' active' : ''
            }" data-adv-sit="${s.key}">${escapeHtml(s.label)}</button>`
        ).join('')}
      </div>
    </div>`;
  }

  /** One map with a round library + a side → round-type search is available. */
  function roundFilterMap() {
    if (filters.maps.size !== 1) return '';
    const code = [...filters.maps][0];
    return hasRoundLibrary(code) ? code : '';
  }

  function roundFiltersEnabled() {
    return Boolean(roundFilterMap() && (filters.side === 'T' || filters.side === 'CT'));
  }

  function clearRoundTypeFilters() {
    filters.roundOwn.clear();
    filters.roundOpp.clear();
    roundOwnSearch = '';
    roundOppSearch = '';
  }

  /** Drop round-type picks that no longer apply (map/side changed). */
  function pruneRoundTypeFilters() {
    if (!roundFiltersEnabled()) {
      clearRoundTypeFilters();
      // Side without a focused team only exists to drive round-type search.
      if (filters.teams.size !== 1) filters.side = '';
      return;
    }
    const map = roundFilterMap();
    const ownSide = filters.side;
    const oppSide = ownSide === 'T' ? 'CT' : 'T';
    const ownKeys = new Set(roundTypeRows(map, ownSide).map((r) => r.key));
    const oppKeys = new Set(roundTypeRows(map, oppSide).map((r) => r.key));
    for (const k of [...filters.roundOwn]) if (!ownKeys.has(k)) filters.roundOwn.delete(k);
    for (const k of [...filters.roundOpp]) if (!oppKeys.has(k)) filters.roundOpp.delete(k);
  }

  function roundTypeFilterHtml() {
    if (!roundFiltersEnabled()) return '';
    const map = roundFilterMap();
    const ownSide = filters.side;
    const oppSide = ownSide === 'T' ? 'CT' : 'T';
    const ownRows = roundTypeRows(map, ownSide);
    const oppRows = roundTypeRows(map, oppSide);
    if (!ownRows.length && !oppRows.length) return '';

    const ownOptions = ownRows
      .filter((r) => !filters.roundOwn.has(r.key))
      .map((r) => [r.key, r.label]);
    const oppOptions = oppRows
      .filter((r) => !filters.roundOpp.has(r.key))
      .map((r) => [r.key, r.label]);
    const ownSelected = ownRows
      .filter((r) => filters.roundOwn.has(r.key))
      .map((r) => [r.key, r.label]);
    const oppSelected = oppRows
      .filter((r) => filters.roundOpp.has(r.key))
      .map((r) => [r.key, r.label]);
    const ownOpen = Boolean(roundOwnSearch.trim());
    const oppOpen = Boolean(roundOppSearch.trim());

    return `
      <div class="rp-filter-group${ownOpen ? ' menu-open' : ''}">
        <div class="rp-typeahead" id="rp-round-own-typeahead">
          <input type="search" class="site-input rp-filter-search" id="rp-round-own-search"
            placeholder="${escapeHtml(ownSide)} rounds…" spellcheck="false" autocomplete="off"
            value="${escapeHtml(roundOwnSearch)}" aria-label="${escapeHtml(ownSide)} rounds" />
          ${typeaheadMenuHtml('roundOwn', ownOptions, roundOwnSearch)}
        </div>
        ${selectedChipsHtml('roundOwn', ownSelected)}
      </div>
      <div class="rp-filter-group${oppOpen ? ' menu-open' : ''}">
        <div class="rp-typeahead" id="rp-round-opp-typeahead">
          <input type="search" class="site-input rp-filter-search" id="rp-round-opp-search"
            placeholder="vs ${escapeHtml(oppSide)} rounds…" spellcheck="false" autocomplete="off"
            value="${escapeHtml(roundOppSearch)}" aria-label="vs ${escapeHtml(oppSide)} rounds" />
          ${typeaheadMenuHtml('roundOpp', oppOptions, roundOppSearch)}
        </div>
        ${selectedChipsHtml('roundOpp', oppSelected)}
      </div>`;
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
        aria-label="Round winner" title="${hasTeams ? '' : 'Select a team first'}">
        <option value=""${mode === '' ? ' selected' : ''}>Round winner...</option>
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

    const teamMenuOpen = Boolean(teamSearch.trim());
    const teamPicked = filters.teams.size === 1;
    // Side is needed for round-type search even with no team: tags are absolute
    // T/CT. Situations stay team-scoped (opening duel from a subject side).
    const sideEnabled = teamPicked || Boolean(roundFilterMap());

    filtersEl.innerHTML = `
      ${libraryScopeHtml()}
      ${tagFilterHtml()}
      <div class="rp-filter-group${mapMenuOpen ? ' menu-open' : ''}">
        ${mapMenuHtml()}
      </div>
      <div class="rp-filter-group">
        <div class="rp-econ-pair">
          <div class="rp-econ-side">
            ${econSelectHtml('rp-econ-a', filters.econA, "Team 1's buy")}
            ${hasAwpCheckHtml('rp-awp-a', filters.hasAwpA)}
          </div>
          <div class="rp-econ-side">
            ${econSelectHtml('rp-econ-b', filters.econB, "Team 2's buy")}
            ${hasAwpCheckHtml('rp-awp-b', filters.hasAwpB)}
          </div>
        </div>
      </div>
      ${
        teamClusters.length
          ? `<div class="rp-filter-group${teamMenuOpen ? ' menu-open' : ''}">
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
              ${wonBySelectHtml()}
            </div>`
          : ''
      }
      ${sideSegHtml(sideEnabled)}
      ${roundTypeFilterHtml()}
      ${situationSegHtml(teamPicked)}
      <div class="rp-filter-group rp-advanced-wrap">
        <div class="rp-advanced-body" id="rp-advanced-body">
          <div class="rp-filter-group">
            <div class="rp-seg rp-seg-decided" role="group" aria-label="Round decided phase">
              ${[
                ['mid', 'Decided Midround'],
                ['late', 'Decided Lateround']
              ]
                .map(
                  ([p, label]) =>
                    `<button type="button" class="rp-seg-btn${
                      filters.decidedPhases.has(p) ? ' active' : ''
                    }" data-adv-decided="${p}">${label}</button>`
                )
                .join('')}
            </div>
          </div>
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
      clearRoundTypeFilters();
      filters.libraryScope = 'public';
      filters.tags.clear();
      // Early is not a valid decided filter anymore.
      teamSearch = '';
      playerSearch = '';
      mapMenuOpen = false;
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
    if (kind === 'roundOwn' || kind === 'roundOpp') {
      const map = roundFilterMap();
      if (!map || (filters.side !== 'T' && filters.side !== 'CT')) return;
      const ownSide = filters.side;
      const forSide = kind === 'roundOpp' ? (ownSide === 'T' ? 'CT' : 'T') : ownSide;
      const selected = kind === 'roundOpp' ? filters.roundOpp : filters.roundOwn;
      const query = kind === 'roundOpp' ? roundOppSearch : roundOwnSearch;
      const wrapId = kind === 'roundOpp' ? 'rp-round-opp-typeahead' : 'rp-round-own-typeahead';
      const wrap = filtersEl.querySelector(`#${wrapId}`);
      const group = wrap?.closest('.rp-filter-group');
      if (!wrap) return;
      wrap.querySelector('.rp-typeahead-menu')?.remove();
      const options = roundTypeRows(map, forSide)
        .filter((r) => !selected.has(r.key))
        .map((r) => [r.key, r.label]);
      wrap.insertAdjacentHTML('beforeend', typeaheadMenuHtml(kind, options, query));
      group?.classList.toggle('menu-open', Boolean(query.trim()));
    }
  }

  filtersEl?.addEventListener('input', (e) => {
    const teamInput = e.target.closest('#rp-team-search');
    if (teamInput) {
      teamSearch = teamInput.value;
      refreshTypeaheadMenu('teams');
      return;
    }
    const ownInput = e.target.closest('#rp-round-own-search');
    if (ownInput) {
      roundOwnSearch = ownInput.value;
      refreshTypeaheadMenu('roundOwn');
      return;
    }
    const oppInput = e.target.closest('#rp-round-opp-search');
    if (oppInput) {
      roundOppSearch = oppInput.value;
      refreshTypeaheadMenu('roundOpp');
    }
  });

  filtersEl?.addEventListener('change', (e) => {
    const mapBox = e.target.closest('[data-map]');
    if (!mapBox) return;
    const code = mapBox.dataset.map;
    if (mapBox.checked) filters.maps.add(code);
    else filters.maps.delete(code);
    pruneRoundTypeFilters();
    const toggle = filtersEl.querySelector('#rp-map-toggle');
    if (toggle) toggle.textContent = mapToggleLabel();
    renderFilters();
    runQuery();
  });

  filtersEl?.addEventListener('click', (e) => {
    const tagBtn = e.target.closest('[data-tag-filter]');
    if (tagBtn) {
      const key = tagBtn.dataset.tagFilter;
      if (filters.tags.has(key)) filters.tags.delete(key);
      else filters.tags.add(key);
      renderFilters();
      runQuery();
      return;
    }
    const scopeBtn = e.target.closest('[data-library-scope]');
    if (scopeBtn) {
      const next = scopeBtn.dataset.libraryScope === 'mine' ? 'mine' : 'public';
      if (filters.libraryScope === next) return;
      filters.libraryScope = next;
      renderFilters();
      runQuery();
      return;
    }
    const sideBtn = e.target.closest('[data-adv-side]');
    if (sideBtn && !sideBtn.disabled) {
      const side = sideBtn.dataset.advSide === 'CT' ? 'CT' : 'T';
      filters.side = filters.side === side ? '' : side;
      pruneRoundTypeFilters();
      renderFilters();
      runQuery();
      return;
    }
    const sitBtn = e.target.closest('[data-adv-sit]');
    if (sitBtn && !sitBtn.disabled) {
      const key = sitBtn.dataset.advSit;
      if (filters.situations.has(key)) filters.situations.delete(key);
      else filters.situations.add(key);
      // Drop legacy 5v5 picks — that option is no longer in the filter UI.
      filters.situations.delete('5v5');
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
      const key = decidedBtn.dataset.advDecided;
      if (key !== 'mid' && key !== 'late') return;
      filters.decidedPhases.delete('early');
      if (filters.decidedPhases.has(key)) filters.decidedPhases.delete(key);
      else filters.decidedPhases.add(key);
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
        if (!filters.teams.size) filters.wonByMode = '';
        // Situations need a single subject team. Side + round types do not.
        if (filters.teams.size !== 1) {
          filters.situations.clear();
          if (!roundFilterMap()) {
            filters.side = '';
            clearRoundTypeFilters();
          } else {
            pruneRoundTypeFilters();
          }
        }
      }
      if (group === 'players') playerSearch = '';
      renderFilters();
      runQuery();
      return;
    }
    if (group === 'roundOwn' || group === 'roundOpp') {
      const set = filters[group];
      if (set.has(value)) set.delete(value);
      else set.add(value);
      if (group === 'roundOwn') roundOwnSearch = '';
      else roundOppSearch = '';
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

  function needsMetaFilters() {
    return Boolean(
      filters.side ||
        filters.situations.size ||
        filters.afterplant ||
        filters.decidedPhases.size ||
        filters.roundOwn.size ||
        filters.roundOpp.size
    );
  }

  function needsRoundTypeFilters() {
    return Boolean(filters.roundOwn.size || filters.roundOpp.size);
  }

  function hasActiveFilters() {
    return Boolean(
      filters.libraryScope !== 'public' ||
        filters.tags.size ||
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
        filters.decidedPhases.size ||
        filters.roundOwn.size ||
        filters.roundOpp.size
    );
  }

  /**
   * Load round-library tags from the stats index for the demos in `list`.
   * Tags are not on round meta — they ride on the compact stats rows.
   */
  async function ensureRoundTags(list) {
    if (!needsRoundTypeFilters()) return;
    const demoIds = [
      ...new Set(
        (list || [])
          .map((r) => r.demoId || splitStoredName(r.file)?.demoId)
          .filter(Boolean)
      )
    ];
    if (!demoIds.length) {
      roundTagByFile = new Map();
      return;
    }
    const token = ++roundTagToken;
    try {
      const payload = await fetchStats(demoIds);
      if (token !== roundTagToken) return;
      const next = new Map();
      for (const d of payload?.demos || []) {
        for (const row of d.rounds || []) {
          if (!row?.f || !row.rl) continue;
          next.set(row.f, {
            t: (row.rl.t || []).map((x) => x.k).filter(Boolean),
            ct: (row.rl.ct || []).map((x) => x.k).filter(Boolean)
          });
        }
      }
      roundTagByFile = next;
    } catch {
      if (token === roundTagToken) roundTagByFile = new Map();
    }
  }

  function roundKeysOnSide(tags, side) {
    if (!tags) return [];
    return side === 'CT' ? tags.ct || [] : tags.t || [];
  }

  function roundHasAnyKey(keys, wanted) {
    if (!wanted.size) return true;
    for (const k of wanted) if (keys.includes(k)) return true;
    return false;
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

    if (filters.side && idx) {
      // With a focused team, side means "that team is T/CT this round".
      // Without a team, side only names which absolute tags round-types use.
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
    if (needsRoundTypeFilters()) {
      // Absolute T/CT tags on the stats row. Subject side is the filter side.
      // No team required: "T rounds: Long pop" matches any round whose T side
      // ran that call.
      const ownSide = filters.side === 'CT' ? 'CT' : filters.side === 'T' ? 'T' : '';
      if (ownSide !== 'T' && ownSide !== 'CT') return false;
      const oppSide = ownSide === 'T' ? 'CT' : 'T';
      const tags = roundTagByFile?.get(listRound?.file) || null;
      if (!tags) return false;
      if (!roundHasAnyKey(roundKeysOnSide(tags, ownSide), filters.roundOwn)) return false;
      if (!roundHasAnyKey(roundKeysOnSide(tags, oppSide), filters.roundOpp)) return false;
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
    for (const d of scopedDemos()) {
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
    if (needsMetaFilters()) setQueryStatus('Applying advanced filters…');
    else setQueryStatus('');
    renderResults();

    try {
      const [res, playlists] = await Promise.all([
        findRounds(query).catch(() => null),
        fetchPlaylists().catch(() => [])
      ]);
      if (token !== queryToken) return;
      const wide = libraryWideFilters();
      // Default: keep results on the loaded demo page. Team/player filters
      // search the whole library via the rounds collector.
      const loadedIds = new Set(demos.map((d) => d.id));
      const fromApi = (res?.rounds || []).filter((r) => {
        if (wide) return true;
        const id = r.demoId || splitStoredName(r.file)?.demoId;
        return id && loadedIds.has(id);
      });
      if (wide && fromApi.length) {
        rounds = fromApi;
      } else if (fromApi.length > rounds.length) {
        rounds = fromApi;
      } else if (!rounds.length && fromApi.length) {
        rounds = fromApi;
      } else if (!rounds.length) {
        const names = scopedDemos().flatMap((d) => (d.rounds || []).map((r) => r.file).filter(Boolean));
        rounds = collectRounds(names, query);
      }

      // Wide filters can surface demos outside the loaded page — pull their
      // records so heads show real names / scores / dates instead of short ids.
      // Scope filtering also needs owner/visibility on every round's demo.
      if (rounds.length) {
        await ensureDemosForRounds(rounds);
        if (token !== queryToken) return;
      }
      rounds = rounds.filter(roundMatchesScope);
      if (token !== queryToken) return;

      if (needsMetaFilters()) {
        if (needsRoundTypeFilters()) {
          setQueryStatus('Loading round types…');
          await ensureRoundTags(rounds);
          if (token !== queryToken) return;
        }
        setQueryStatus('Applying advanced filters…');
        rounds = await applyAdvancedMetaFilters(rounds, token);
        if (token !== queryToken) return;
        setQueryStatus('');
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
    if (!id) return null;
    return demos.find((d) => d.id === id) || extraDemos.get(id) || null;
  }

  /** Fetch demo records missing from the current page (and extra cache). */
  async function ensureDemosForRounds(list) {
    const missing = [];
    const seen = new Set();
    for (const r of list || []) {
      const id = r.demoId || splitStoredName(r.file)?.demoId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!demoById(id)) missing.push(id);
    }
    if (!missing.length) return;
    await Promise.all(
      missing.map(async (id) => {
        try {
          const res = await fetchDemo(id);
          if (res?.demo?.id) extraDemos.set(res.demo.id, res.demo);
        } catch {
          /* header stays degraded for that demo */
        }
      })
    );
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
        ${rowMetaHtml(when, mapCode, mapName, d?.owner)}
        ${matchBlockHtml(t1, t2, score, {
          id1: d?.team1?.id || sample?.team1,
          id2: d?.team2?.id || sample?.team2
        })}
        ${demoFactsHtml(d)}
        <div class="rp-row-actions">
          <button type="button" class="rp-btn-icon" data-demo-stats="${id}" title="Database for this match">${statsIconHtml()}</button>
          ${
            canManageDemo(d)
              ? `<button type="button" class="rp-btn-icon" data-rename="${id}" title="Rename teams">Aa</button>
          <button type="button" class="rp-btn-icon danger" data-delete="${id}" title="Delete">
            ${deleteIconHtml()}
          </button>`
              : ''
          }
          <button type="button" class="rp-btn-play" data-open="${id}" title="Replay">${playIconHtml()}</button>
        </div>
      </div>`;
  }

  function renderResults() {
    if (!resultEl) return;
    if (!demos.length && !demoTotal) {
      resultEl.innerHTML = `<p class="view-empty">No replays yet. Upload a ${PACKAGE_EXT} package (or a .dem).</p>`;
      return;
    }

    const roundsByFile = new Map(rounds.map((r) => [r.file, r]));
    const sortedDemos = scopedDemos().sort((a, b) => {
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

    function demoGroupBlock(g) {
      const d = g.demo;
      const demoRounds = g.rounds || [];
      if (!demoRounds.length) return '';
      const open = expandedDemos.has(g.demoId);
      const allSelected =
        demoRounds.length > 0 && demoRounds.every((r) => selectedFiles.has(r.file));
      return `
        <section class="rp-demo-group${open ? ' open' : ''}" data-demo="${escapeHtml(g.demoId)}">
          ${demoGroupHeadHtml(g)}
          <div class="rp-demo-rounds" ${open ? '' : 'hidden'}>
            <div class="rp-demo-rounds-tools">
              <button type="button" class="rp-select-demo-rounds" data-select-demo="${escapeHtml(
                g.demoId
              )}">${allSelected ? 'Deselect all' : 'Select all'}</button>
              <span class="rp-demo-rounds-meta">${demoRounds.length} round${
                demoRounds.length === 1 ? '' : 's'
              }</span>
            </div>
            ${demoRounds.map((r) => roundRowHtml(r, d)).join('')}
          </div>
        </section>`;
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
            selCount ? `Database for the ${selCount} selected round${selCount === 1 ? '' : 's'}` : 'Open Database for every round that matches these filters'
          )}">Database${selCount ? ` (${selCount})` : ''}</button>
          <button type="button" class="btn btn-sm primary" id="rp-load-rounds" ${
            selCount ? '' : 'disabled'
          }>${loadLabel}</button>
          <button type="button" class="btn btn-sm rp-btn-analyzer" id="rp-analyzer" ${
            analyze.ok ? '' : 'disabled'
          } title="${escapeHtml(analyzeTitle)}">${analyzeLabel}</button>
        </div>
      </div>`
        : '';

    const wide = libraryWideFilters();
    const demoBlocks = wide
      ? groupRoundsByDemo(rounds)
          .map((g) => demoGroupBlock(g))
          .filter(Boolean)
          .join('')
      : sortedDemos
          .map((d) => {
            const status = d.status || 'ready';
            if (status !== 'ready') return demoRow(d);
            const demoRounds = roundsForDemo(d);
            if (!demoRounds.length) return '';
            return demoGroupBlock({ demoId: d.id, demo: d, rounds: demoRounds });
          })
          .filter(Boolean)
          .join('');

    const shownStored = Math.min(libraryLimit, demoTotal);
    const loadMoreBtn = demoHasMore
      ? `<button type="button" class="btn btn-sm" data-load-more-demos>Load more</button>`
      : '';
    const pageNote =
      demoTotal > 0 && !wide
        ? `<div class="rp-library-page">
        <span class="rp-library-page-count">Showing ${shownStored} of ${demoTotal} demo${
          demoTotal === 1 ? '' : 's'
        }</span>
        ${loadMoreBtn}
      </div>`
        : wide && rounds.length
          ? `<div class="rp-library-page">
        <span class="rp-library-page-count">Filtered across the whole library</span>
      </div>`
          : '';

    resultEl.innerHTML = `
      ${head}
      ${pageNote}
      <div class="rp-demo-groups rp-list">
        ${
          demoBlocks ||
          `<p class="view-empty">${
            hasActiveFilters()
              ? 'No demos match these filters.'
              : 'No replays yet. Upload a package (or a .dem).'
          }</p>`
        }
      </div>
      ${demoHasMore && demoBlocks ? pageNote : ''}`;

    resultEl.querySelectorAll('[data-load-more-demos]').forEach((btn) => {
      btn.addEventListener('click', () => loadMoreDemos());
    });

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

    const filterTeam = e.target.closest('[data-filter-team]');
    if (filterTeam) {
      e.preventDefault();
      e.stopPropagation();
      let key = filterTeam.dataset.filterTeam || '';
      if (!key || key === 'unknown') return;
      if (key.startsWith('id:')) {
        const shortId = key.slice(3);
        key =
          teamClusters.find((c) =>
            c.shortIds.some((s) => String(s).toLowerCase() === shortId)
          )?.key || shortId;
      } else if (key.startsWith('name:')) {
        const name = key.slice(5);
        const hit = teamClusters.find((c) => c.name.trim().toLowerCase() === name);
        if (!hit) return;
        key = hit.key;
      }
      filters.teams.clear();
      filters.teams.add(key);
      filters.side = '';
      filters.situations.clear();
      teamSearch = '';
      renderFilters();
      runQuery();
      return;
    }

    const filterMap = e.target.closest('[data-filter-map]');
    if (filterMap) {
      e.preventDefault();
      e.stopPropagation();
      const code = filterMap.dataset.filterMap;
      if (!code || !MAPS[code]) return;
      filters.maps.clear();
      filters.maps.add(code);
      mapMenuOpen = false;
      renderFilters();
      runQuery();
      return;
    }

    const selectDemo = e.target.closest('[data-select-demo]');
    if (selectDemo) {
      e.preventDefault();
      e.stopPropagation();
      const demoId = selectDemo.dataset.selectDemo;
      // Use the rounds currently shown for this demo (query results), not the
      // paged library record — that miss is why Select all often did nothing.
      let files = rounds
        .filter((r) => (r.demoId || splitStoredName(r.file)?.demoId) === demoId)
        .map((r) => r.file)
        .filter(Boolean);
      if (!files.length) {
        const demo = demoById(demoId);
        files = (demo?.rounds || []).map((r) => r.file).filter(Boolean);
      }
      if (!files.length) return;
      const allOn = files.every((f) => selectedFiles.has(f));
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
      statsDemoId: focus.statsDemoId || '',
      startAt: focus.startAt || null
    });
  }

  // ---- playlists page -----------------------------------------------------

  /** Status line on the playlists page (upload-page #rp-status is hidden here). */
  function setPlaylistStatus(msg, isError = false) {
    if (playlistStatusEl) {
      playlistStatusEl.textContent = msg || '';
      playlistStatusEl.classList.toggle('is-error', isError);
    }
    // Keep the shared status in sync for anywhere else that reads it.
    setStatus(msg, isError);
  }

  /**
   * A playlist stores round file stems only. Resolve each one with meta fetch
   * (same path Analytics uses) so a large library or a visibility-filtered
   * collector listing cannot drop rounds the playlist still names.
   */
  async function roundsForPlaylist(playlist) {
    const wanted = [...new Set((playlist.rounds || []).map((f) => String(f || '').trim()).filter(Boolean))];
    if (!wanted.length) return [];
    const rounds = [];
    const concurrency = 6;
    let i = 0;
    async function worker() {
      while (i < wanted.length) {
        const idx = i++;
        const file = wanted[idx];
        const meta = await fetchRoundMeta(file).catch(() => null);
        if (!meta) continue;
        rounds[idx] = { ...meta, file: meta.file || file };
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, () => worker()));
    return rounds.filter(Boolean);
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
          <tr><th>Playlist</th><th>Owner</th><th>Shared with</th><th>Last modified</th><th>Rounds</th><th></th></tr>
        </thead>
        <tbody>
          ${playlistLists
            .map((p) => {
              const scope = p.scope === 'team' ? 'team' : 'private';
              // The server already decided this (owner or site admin); it also
              // answers before /status has necessarily been read on this page.
              const mine =
                p.mine === undefined
                  ? !p.ownerId || p.ownerId === account.id || account.admin
                  : Boolean(p.mine);
              return `
            <tr data-id="${escapeHtml(p.id)}">
              <td class="rp-pl-name">${escapeHtml(p.name)}</td>
              <td class="rp-pl-owner">@${escapeHtml(p.ownerName || 'artysan')}</td>
              <td class="rp-pl-scope">
                ${
                  mine
                    ? `<select class="site-select rp-pl-scope-select" data-scope="${escapeHtml(p.id)}">
                        <option value="private"${scope === 'private' ? ' selected' : ''}>Only me</option>
                        <option value="team"${scope === 'team' ? ' selected' : ''}>My team</option>
                      </select>`
                    : scope === 'team'
                      ? 'My team'
                      : 'Only me'
                }
              </td>
              <td class="rp-pl-when">${escapeHtml(formatWhen(p.updatedAt || p.createdAt))}</td>
              <td class="rp-pl-count">${(p.rounds || []).length}</td>
              <td class="rp-pl-actions">
                <button type="button" class="rp-btn-replay" data-play="${escapeHtml(p.id)}">▶ Replay</button>
                ${
                  mine
                    ? `<button type="button" class="rp-btn-icon danger" data-drop="${escapeHtml(
                        p.id
                      )}" title="Delete playlist">${deleteIconHtml()}</button>`
                    : ''
                }
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;
  }

  async function loadPlaylistsPage() {
    if (!playlistsBody) return;
    setPlaylistStatus('');
    playlistsBody.innerHTML = spinnerHtml();
    try {
      playlistLists = await fetchPlaylists();
      renderPlaylistsPage();
    } catch (err) {
      playlistsBody.innerHTML = `<p class="view-empty">${escapeHtml(err.message)}</p>`;
    }
  }

  function setSubpage(name, { push = false } = {}) {
    const next =
      name === 'upload' ||
      name === 'playlists' ||
      name === 'stats' ||
      name === 'analytics' ||
      name === 'charts'
        ? name
        : 'library';
    subpage = next;
    if (libraryEl) libraryEl.hidden = next !== 'library';
    if (uploadPageEl) uploadPageEl.hidden = next !== 'upload';
    if (playlistsPageEl) playlistsPageEl.hidden = next !== 'playlists';
    if (statsPageEl) statsPageEl.hidden = next !== 'stats';
    if (analyticsPageEl) analyticsPageEl.hidden = next !== 'analytics';
    if (chartsPageEl) chartsPageEl.hidden = next !== 'charts';

    if (push) {
      if (onNavigate) {
        onNavigate(next);
        return;
      }
      const path = pagePath(next);
      if (window.location.pathname.replace(/\/+$/, '') !== path) {
        window.history.pushState({ page: next }, '', path);
      }
    }

    if (next === 'playlists') {
      stopPolling();
      loadPlaylistsPage();
    } else if (next === 'stats') {
      stopPolling();
      openStatsPage(statsScope, Object.fromEntries(new URLSearchParams(window.location.search)));
    } else if (next === 'analytics') {
      stopPolling();
      openAnalyticsPage();
    } else if (next === 'charts') {
      stopPolling();
      openChartsPage();
    } else if (next === 'upload') {
      void refreshMineDemos().then(() => renderMine());
      if (visible) startPolling();
    } else if (visible) {
      startPolling();
    }
  }
  playlistsBody?.addEventListener('change', async (e) => {
    const scope = e.target.closest('[data-scope]');
    if (!scope) return;
    try {
      playlistLists = await savePlaylist({ id: scope.dataset.scope, scope: scope.value });
      renderPlaylistsPage();
      setStatus(scope.value === 'team' ? 'Playlist shared with your team.' : 'Playlist is private.');
    } catch (err) {
      setStatus(err.message, true);
      renderPlaylistsPage();
    }
  });

  playlistsBody?.addEventListener('click', async (e) => {
    const play = e.target.closest('[data-play]');
    const drop = e.target.closest('[data-drop]');
    if (play) {
      const pl = playlistLists.find((p) => p.id === play.dataset.play);
      if (!pl) return;
      play.disabled = true;
      setPlaylistStatus('Opening playlist…');
      try {
        const list = await roundsForPlaylist(pl);
        if (!list.length) {
          setPlaylistStatus('That playlist has no rounds left to play.', true);
          return;
        }
        await launchViewer(list, 'timeline', pl.name);
        setPlaylistStatus('');
      } catch (err) {
        setPlaylistStatus(err?.message || 'Could not open the playlist.', true);
      } finally {
        play.disabled = false;
      }
      return;
    }
    if (drop) {
      const pl = playlistLists.find((p) => p.id === drop.dataset.drop);
      if (!pl || !window.confirm(`Delete the playlist "${pl.name}"?`)) return;
      try {
        playlistLists = await deletePlaylist(pl.id);
        renderPlaylistsPage();
        setPlaylistStatus('Playlist deleted.');
      } catch (err) {
        setPlaylistStatus(err.message, true);
      }
    }
  });

  // ---- statistics ---------------------------------------------------------

  /** Last player/team detail key written to the URL (for push vs replace). */
  let lastStatsDetailKey = '';

  /** Encode database view state into query params (shareable). */
  function statsViewToParams(state = {}) {
    const q = new URLSearchParams();
    if (state.tab === 'teams' || state.tab === 'players') q.set('tab', state.tab);
    const map = Array.isArray(state.maps) && state.maps[0] ? state.maps[0] : state.map;
    if (map) q.set('map', String(map));
    if (state.side === 'T' || state.side === 'CT') q.set('side', state.side);
    if (state.result === 'won' || state.result === 'lost') q.set('result', state.result);
    if (state.advantage) q.set('adv', String(state.advantage));
    if (state.econ != null && Number.isFinite(Number(state.econ))) q.set('econ', String(state.econ));
    if (state.oppEcon != null && Number.isFinite(Number(state.oppEcon))) {
      q.set('oppEcon', String(state.oppEcon));
    }
    if (state.hasAwp) q.set('awp', '1');
    if (state.oppHasAwp) q.set('oppAwp', '1');
    // Always write minR when it differs from this view's default, including 0
    // on a match scope, 80 on clean Any-map Database, or 5 with a map selected.
    const minR = Math.max(0, Math.floor(Number(state.minRounds) || 0));
    if (minR !== defaultMinRounds(state)) q.set('minR', String(minR));
    if (state.dateFrom) q.set('from', String(state.dateFrom));
    if (state.dateTo) q.set('to', String(state.dateTo));
    if (state.role?.side && state.role?.value) {
      q.set('role', `${state.role.side}:${state.role.value}`);
    }
    if (state.roundOwn) q.set('round', String(state.roundOwn));
    if (state.roundOpp) q.set('vsRound', String(state.roundOpp));
    if (state.sortKey) q.set('sort', String(state.sortKey));
    if (state.sortDir === 'asc' || state.sortDir === 'desc') q.set('dir', state.sortDir);
    if (Number(state.page) > 1) q.set('page', String(Math.floor(Number(state.page))));
    if (state.player) {
      q.set('player', String(state.player));
      if (state.playerLabel && state.playerLabel !== state.player) {
        q.set('label', String(state.playerLabel));
      }
    } else if (state.team) {
      q.set('team', String(state.team));
      if (state.teamLabel && state.teamLabel !== state.team) {
        q.set('label', String(state.teamLabel));
      }
    }
    if (state.teamName) q.set('teamName', String(state.teamName));
    if (state.title) q.set('title', String(state.title));
    if (Array.isArray(state.demos) && state.demos.length) {
      q.set('demos', state.demos.map(String).join(','));
    }
    if (Array.isArray(state.files) && state.files.length) {
      q.set('files', state.files.map(String).join(','));
    }
    return q;
  }

  /** Parse /database query params into a statsPanel view object. */
  function statsViewFromParams(params = {}) {
    const out = {};
    if (params.tab === 'players' || params.tab === 'teams') out.tab = params.tab;
    if (params.map) out.maps = [String(params.map)];
    if (params.side === 'T' || params.side === 'CT') out.side = params.side;
    if (params.result === 'won' || params.result === 'lost') out.result = params.result;
    if (params.adv) out.advantage = String(params.adv);
    if (params.advantage) out.advantage = String(params.advantage);
    if (params.econ !== undefined && params.econ !== '') {
      const n = Number(params.econ);
      if (Number.isFinite(n)) out.econ = n;
    }
    if (params.oppEcon !== undefined && params.oppEcon !== '') {
      const n = Number(params.oppEcon);
      if (Number.isFinite(n)) out.oppEcon = n;
    }
    if (params.awp === '1' || params.awp === 'true') out.hasAwp = true;
    if (params.oppAwp === '1' || params.oppAwp === 'true') out.oppHasAwp = true;
    if (params.minR !== undefined && params.minR !== '') {
      out.minRounds = Math.max(0, Math.floor(Number(params.minR) || 0));
    }
    if (params.from && /^\d{4}-\d{2}-\d{2}$/.test(String(params.from))) {
      out.dateFrom = String(params.from);
    }
    if (params.to && /^\d{4}-\d{2}-\d{2}$/.test(String(params.to))) {
      out.dateTo = String(params.to);
    }
    if (params.role) {
      const raw = String(params.role);
      const i = raw.indexOf(':');
      if (i > 0) {
        const side = raw.slice(0, i);
        const value = raw.slice(i + 1);
        if ((side === 'T' || side === 'CT') && value) out.role = { side, value };
      }
    }
    if (params.round) out.roundOwn = String(params.round);
    if (params.vsRound) out.roundOpp = String(params.vsRound);
    if (params.roundOwn) out.roundOwn = String(params.roundOwn);
    if (params.roundOpp) out.roundOpp = String(params.roundOpp);
    if (params.sort) out.sortKey = String(params.sort);
    if (params.dir === 'asc' || params.dir === 'desc') out.sortDir = params.dir;
    if (params.page) out.page = Math.max(1, Math.floor(Number(params.page) || 1));
    if (params.player) {
      out.player = String(params.player);
      if (params.label) out.playerLabel = String(params.label);
    } else if (params.team) {
      out.team = String(params.team);
      if (params.label) out.teamLabel = String(params.label);
    } else {
      out.player = '';
      out.team = '';
    }
    if (params.teamName) out.teamName = String(params.teamName);
    if (params.title) out.title = String(params.title);
    if (params.demos) {
      out.demos = String(params.demos)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (params.files) {
      out.files = String(params.files)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return out;
  }

  function syncStatsUrl(state, { push = false } = {}) {
    if (subpage !== 'stats') return;
    const path = pagePath('stats');
    const q = statsViewToParams(state);
    const search = q.toString();
    const target = path + (search ? `?${search}` : '');
    const current = window.location.pathname.replace(/\/+$/, '') + window.location.search;
    if (current === target) {
      const detailKey =
        state.player ? `p:${state.player}` : state.team ? `t:${state.team}` : '';
      lastStatsDetailKey = detailKey;
      return;
    }
    const detailKey = state.player ? `p:${state.player}` : state.team ? `t:${state.team}` : '';
    const enteringDetail = Boolean(detailKey) && detailKey !== lastStatsDetailKey;
    const leavingDetail = !detailKey && Boolean(lastStatsDetailKey);
    lastStatsDetailKey = detailKey;
    // Entering a player/team pushes so Back can pop. Leaving or filter-only
    // edits replace so we do not stack a duplicate list entry on top of detail.
    const usePush = push || enteringDetail;
    if (leavingDetail && !push) {
      window.history.replaceState({ page: 'stats' }, '', target);
      return;
    }
    if (usePush) window.history.pushState({ page: 'stats' }, '', target);
    else window.history.replaceState({ page: 'stats' }, '', target);
  }

  /** Mount the panel on first use and point it at a scope. */
  function openStatsPage(scope = {}, urlParams = null) {
    if (!statsBodyEl) return;
    const rawParams = urlParams || Object.fromEntries(new URLSearchParams(window.location.search));
    const fromUrl = scope.__fresh ? {} : statsViewFromParams(rawParams);
    const merged = { ...scope, ...fromUrl };
    delete merged.__fresh;
    // Scope demos/files from the caller win over a stale URL when opening from
    // a selection; otherwise URL demos keep a shared link intact.
    if (Array.isArray(scope.demos)) merged.demos = scope.demos;
    if (Array.isArray(scope.files)) merged.files = scope.files;
    if (scope.title) merged.title = scope.title;
    if (scope.teamName) merged.teamName = scope.teamName;
    // Fresh sidebar Database: drop sticky match/team scope and URL filters.
    if (scope.__fresh) {
      delete merged.demos;
      delete merged.files;
      delete merged.teamName;
      delete merged.title;
      delete merged.maps;
      delete merged.map;
      delete merged.side;
      delete merged.result;
      delete merged.advantage;
      delete merged.econ;
      delete merged.oppEcon;
      delete merged.hasAwp;
      delete merged.oppHasAwp;
      delete merged.role;
      delete merged.roundOwn;
      delete merged.roundOpp;
      delete merged.player;
      delete merged.team;
      delete merged.minRounds;
      delete merged.dateFrom;
      delete merged.dateTo;
      lastStatsDetailKey = '';
    }
    statsScope = merged;

    let created = false;
    if (!statsPanel) {
      created = true;
      statsPanel = createStatsPanel({
        escapeHtml,
        onViewChange(state) {
          if (subpage !== 'stats') return;
          syncStatsUrl(state);
        },
        onBack() {
          const q = new URLSearchParams(window.location.search);
          if (!q.has('player') && !q.has('team')) return false;
          // Pop the detail entry; popstate re-applies the previous list URL.
          window.history.back();
          return true;
        },
        onPlayRounds: playAnalyticsRounds
      });
      statsBodyEl.appendChild(statsPanel.el);
    }

    // Same library scope + only the view (detail/filters) changed: apply without
    // refetching. Needed so Back (history.back) is instant and reliable.
    //
    // Compared against what the panel actually holds, NOT against the previous
    // `statsScope`. Every caller that opens a scoped Database assigns statsScope
    // before navigating, and onShow assigns it again, so by the time this runs
    // `prevScope` is already the incoming scope and this test was comparing the
    // new scope with itself. It answered "same library" for every match, the
    // load was skipped, and the Database went on showing whichever match the
    // session had cached first.
    const sameLibrary = !created && !scope.__fresh && loadedStatsKey === libraryKeyOf(merged);
    if (sameLibrary) {
      statsPanel.applyViewState(merged);
      syncStatsUrl(statsPanel.viewState());
      return;
    }
    const key = libraryKeyOf(merged);
    loadedStatsKey = key;
    void Promise.resolve(statsPanel.load(merged)).catch(() => {
      // A failed load holds nothing, so the next visit must fetch again rather
      // than trust this key.
      if (loadedStatsKey === key) loadedStatsKey = '';
    });
  }

  /**
   * @param {{demos?: string[], files?: string[], title?: string, teamName?: string}} scope
   */
  function showStats(scope) {
    // Mark so onShow keeps this scope even though the pushed URL is clean /database
    // until syncStatsUrl runs — without the mark, a bare Database sidebar click
    // would correctly clear sticky match demos.
    statsScope = { ...(scope || {}), __open: true };
    lastStatsDetailKey = '';
    setSubpage('stats', { push: true });
  }

  async function playAnalyticsRounds(files, title) {
    const list = [...new Set((files || []).map((f) => String(f || '').trim()).filter(Boolean))];
    if (!list.length) return;
    const rounds = [];
    for (const file of list) {
      const meta = await fetchRoundMeta(file).catch(() => null);
      if (!meta) continue;
      rounds.push({ ...meta, file });
    }
    if (!rounds.length) {
      setStatus('Those rounds are not in this library.', true);
      return;
    }
    launchViewer(rounds, 'timeline', title || `${rounds.length} rounds`);
  }

  function openAnalyticsPage() {
    if (!analyticsBodyEl) return;
    if (!analyticsPanel) {
      analyticsPanel = createAnalyticsPanel({
        escapeHtml,
        onPlayRounds: playAnalyticsRounds
      });
      analyticsBodyEl.appendChild(analyticsPanel.el);
    }
    // Chapter before load so antistrat mounts before the shared fetch finishes
    // (and so a failed pattern-finder spend cannot strand it on "Loading teams…").
    const chapter = new URLSearchParams(window.location.search).get('chapter');
    if (chapter) analyticsPanel.setChapter(chapter);
    analyticsPanel.load();
  }

  /** Mount the chart builder on first use; the payload is reused after that. */
  function openChartsPage() {
    if (!chartsBodyEl) return;
    if (!chartsPanel) {
      chartsPanel = createChartsPanel({ escapeHtml });
      chartsBodyEl.appendChild(chartsPanel.el);
    }
    // `params` carries ?view=<shareId> through to the saved-views strip.
    chartsPanel.load({
      ...statsScope,
      params: Object.fromEntries(new URLSearchParams(window.location.search))
    });
  }

  // ---- deep links ---------------------------------------------------------

  /**
   * A moment out of the URL: `tick` plus an optional camera.
   *
   * Only meaningful alongside `round`, which is why it is read here rather than
   * folded into the general param handling.
   */
  function momentFromParams(params) {
    const tick = Number(params?.tick);
    if (!Number.isFinite(tick)) return null;
    const zoom = Number(params?.zoom);
    return {
      tick,
      zoom: Number.isFinite(zoom) ? zoom : 0,
      panX: Number(params?.px) || 0,
      panY: Number(params?.py) || 0
    };
  }

  /** /demos?round=<name> opens straight into that round. */
  async function openSharedRound(file, startAt = null) {
    if (!file) return;
    return openSharedRounds([file], startAt);
  }

  /** /demos?rounds=a,b,c opens those rounds in Timeline. */
  /**
   * @param {string[]} files
   * @param {object|null} [startAt]
   * @param {{ mode?: string, focusTeamIds?: string[], focusName?: string }} [opts]
   *   mode 'analyzer' opens the macro analyzer instead of the timeline
   *   (antistrat documents link full-buy sets this way, with the scouted
   *   team's short ids as focus).
   */
  async function openSharedRounds(files, startAt = null, opts = {}) {
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
      const analyzer = opts.mode === 'analyzer';
      const focusIds = (opts.focusTeamIds || []).filter(Boolean);
      // The analyzer resolves its focus against round.team1/team2 as SHORT
      // IDS (library rows carry them that way); a meta carries team objects,
      // so flatten them before handing the list over.
      const shortId = (t) => (typeof t === 'string' ? t : t?.id || '');
      const list2 = analyzer
        ? rounds.map((r) => ({ ...r, team1: shortId(r.team1), team2: shortId(r.team2) }))
        : rounds;
      // A moment names one round, so it only rides along on a single-round open.
      launchViewer(list2, analyzer ? 'analyzer' : 'timeline', opts.focusName || title, {
        startAt: !analyzer && rounds.length === 1 ? startAt : null,
        focusTeam: analyzer ? focusIds[0] || '' : '',
        focusTeamIds: analyzer ? focusIds : [],
        focusName: analyzer ? opts.focusName || '' : ''
      });
    } catch (err) {
      setStatus(`Could not open that round. ${err.message}`, true);
    }
  }

  // ---- polling ------------------------------------------------------------

  /**
   * Single-flight guard.
   *
   * refresh() is fired by the 1.5s parse poll, by every mutation, and by every
   * arrival on the view. Each call is several requests, and none of them was
   * cancelled or awaited by the next one, so on a slow backend the poll stacked
   * refreshes faster than they completed. That saturates the browser's six
   * connections per host, and once it does, nothing else on the site can load:
   * navigating away appears to hang because the new page's requests are queued
   * behind a backlog of stale library listings.
   *
   * A refresh already in flight is returned as-is. A request that arrives while
   * one is running sets a flag so exactly one more runs afterwards, which keeps
   * "reload after upload" correct without letting the queue grow.
   */
  let refreshInFlight = null;
  let refreshAgain = false;

  async function refresh() {
    if (refreshInFlight) {
      refreshAgain = true;
      return refreshInFlight;
    }
    refreshInFlight = refreshOnce().finally(() => {
      refreshInFlight = null;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    });
    return refreshInFlight;
  }

  async function refreshOnce() {
    const showLibraryChrome = subpage === 'library' || !subpage;
    const cancelSlow =
      showLibraryChrome && filtersEl && resultEl
        ? (() => {
            if (!filtersEl.innerHTML.trim()) filtersEl.innerHTML = spinnerHtml();
            if (!resultEl.innerHTML.trim()) resultEl.innerHTML = spinnerHtml('Loading demos…');
            const a = watchSlowLoad(filtersEl);
            const b = watchSlowLoad(resultEl, {
              message:
                'Still loading demos after 4s. The API may be down, starting, or blocked. Check the server console and retry.'
            });
            return () => {
              a();
              b();
            };
          })()
        : () => {};
    try {
      const [status, list] = await Promise.all([
        fetchStatus(),
        fetchDemos({ limit: libraryLimit, offset: 0 })
      ]);
      cancelSlow();
      setLocked(false);
      if (status.limits?.maxUploadBytes) maxUploadBytes = status.limits.maxUploadBytes;
      renderCapabilities(status);
      demoTotal = Number(list.total) || list.usage?.demos || 0;
      demoHasMore = Boolean(list.hasMore);
      // Server-counted, so the meter is right on the first paint rather than
      // reading the library page and claiming the cap is already full.
      if (Number.isFinite(list.owned)) mineOwnedCount = Number(list.owned);
      renderQuota(list.usage || status.usage);
      demos = list.demos || [];
      // Drop extras that are now on the page; keep the rest for active filters.
      for (const d of demos) extraDemos.delete(d.id);
      libraryTeamClusters = Array.isArray(list.teams) ? list.teams : [];
      rebuildTeamClusters();
      renderDemos();
      renderFilters();
      // My Uploads needs the full owned list — libraryLimit is only for /demos paging.
      if (subpage === 'upload' || mineDemosLoaded) {
        await refreshMineDemos();
      }
      renderMine();
      await runQuery();
    } catch (err) {
      cancelSlow();
      setLocked(false);
      const msg = formatApiError(err).message || 'Could not reach the replay service.';
      setStatus(msg, true);
      // First paint / empty library: surface the error in the panels. A later
      // poll failure keeps the last good list and only updates the status line.
      const blank = !demos.length;
      if (blank && filtersEl) {
        filtersEl.innerHTML = `<p class="view-empty">${escapeHtml(msg)}</p>
          <button type="button" class="btn btn-sm" data-rp-retry-load>Retry</button>`;
        filtersEl.querySelector('[data-rp-retry-load]')?.addEventListener('click', () => refresh());
      }
      if (blank && resultEl) {
        resultEl.innerHTML = `<p class="view-empty">Could not load demos. ${escapeHtml(msg)}</p>
          <button type="button" class="btn btn-sm" data-rp-retry-load>Retry</button>`;
        resultEl.querySelector('[data-rp-retry-load]')?.addEventListener('click', () => refresh());
      }
    }
  }

  function loadMoreDemos() {
    if (!demoHasMore) return;
    libraryLimit += LIBRARY_PAGE;
    refresh();
  }

  function setLocked(locked) {
    if (dropEl) dropEl.hidden = locked;
    if (locked) setStatus('');
  }

  function startPolling() {
    stopPolling();
    // Only poll while something is actually mid-parse.
    pollTimer = window.setInterval(() => {
      if (
        !visible ||
        subpage === 'playlists' ||
        subpage === 'stats' ||
        subpage === 'analytics' ||
        subpage === 'charts'
      )
        return;
      // A poll tick is skippable by definition: if one is still running, the
      // answer it is about to deliver is the one this tick wanted.
      if (refreshInFlight) return;
      if (demos.some((d) => d.status === 'parsing')) refresh();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  // Signing in (or out) changes what the library contains, whether uploading is
  // allowed, and which rows carry a rename button. Re-read rather than leaving
  // the page showing the previous session's answer.
  auth?.onChange?.(() => {
    if (visible) refresh();
  });

  return {
    onShow(params = {}) {
      visible = true;
      // Prefer the explicit page from the router. Never re-derive from the
      // previous pathname — that is what stuck Playlists/Database/Charts.
      const page =
        params.page === 'upload' ||
        params.page === 'playlists' ||
        params.page === 'stats' ||
        params.page === 'analytics' ||
        params.page === 'charts' ||
        params.page === 'library'
          ? params.page
          : 'library';
      if (page === 'stats') {
        const fromUrl = statsViewFromParams(params);
        const urlScoped =
          (Array.isArray(fromUrl.demos) && fromUrl.demos.length > 0) ||
          (Array.isArray(fromUrl.files) && fromUrl.files.length > 0) ||
          Boolean(fromUrl.teamName);
        if (statsScope?.__open) {
          // Explicit open from match / selection — keep caller scope, fold URL filters.
          const { __open: _mark, ...kept } = statsScope;
          statsScope = { ...kept, ...fromUrl };
          if (Array.isArray(kept.demos)) statsScope.demos = kept.demos;
          if (Array.isArray(kept.files)) statsScope.files = kept.files;
          if (kept.title) statsScope.title = kept.title;
          if (kept.teamName) statsScope.teamName = kept.teamName;
        } else if (urlScoped) {
          statsScope = { ...fromUrl };
        } else {
          const hasViewFilters = Boolean(
            fromUrl.maps?.length ||
              fromUrl.side ||
              fromUrl.result ||
              fromUrl.advantage ||
              fromUrl.econ != null ||
              fromUrl.oppEcon != null ||
              fromUrl.hasAwp ||
              fromUrl.oppHasAwp ||
              fromUrl.role ||
              fromUrl.roundOwn ||
              fromUrl.roundOpp ||
              fromUrl.player ||
              fromUrl.team ||
              (fromUrl.minRounds != null && fromUrl.minRounds !== '')
          );
          if (hasViewFilters) {
            // Browser Back / shared link — restore list filters, do not wipe.
            statsScope = { ...fromUrl };
          } else {
            // Bare sidebar Database — reset sticky filters from the prior visit.
            statsScope = { __fresh: true };
            lastStatsDetailKey = '';
          }
        }
      }
      setSubpage(page, { push: false });
      if (
        page === 'playlists' ||
        page === 'stats' ||
        page === 'analytics' ||
        page === 'charts'
      ) {
        stopPolling();
      } else {
        // Paint loaders before the network wait so the page never sits blank.
        if (page === 'library') {
          if (filtersEl && !filtersEl.innerHTML.trim()) filtersEl.innerHTML = spinnerHtml();
          if (resultEl && !resultEl.innerHTML.trim()) {
            resultEl.innerHTML = spinnerHtml('Loading demos…');
          }
        }
        refresh();
        startPolling();
        // Uploads that were still parsing when the page went away: pick the
        // progress back up rather than leaving the user guessing.
        resumePendingUploads().catch(() => {});
      }
      // Only on the first arrival: a viewer close rewrites the URL back to
      // /demos, and re-entering the view must not reopen what was closed.
      if (page === 'library') {
        if (params.rounds) {
          const key = `rounds:${params.rounds}:${params.mode || ''}`;
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
            openSharedRounds(files, null, {
              mode: params.mode === 'analyzer' ? 'analyzer' : '',
              focusTeamIds: String(params.team || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              focusName: params.name || ''
            });
          }
        } else if (params.round && params.round !== openedRound) {
          openedRound = params.round;
          openSharedRound(params.round, momentFromParams(params));
        }
      }
    },
    onHide() {
      visible = false;
      stopPolling();
    }
  };
}
