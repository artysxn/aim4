// ---------------------------------------------------------------------------
// site/strategyCreatorView.js
// The 2D Strategy Creator page: the team's synthetic rounds, and the full-stage
// editor they open into.
//
// The list is the landing view - rounds grouped by map and side, plus a tile
// for a new one. Opening a round hands the whole page to the creator stage, the
// way the Analyzer takes over when a replay opens.
//
// /s2/<shareId> lands here too, signed in or not: a shared round opens straight
// into the stage in read-only mode.
// ---------------------------------------------------------------------------

import {
  deleteStrategyRound,
  fetchSharedStrategyRound,
  fetchStatus,
  fetchStrategyRound,
  fetchStrategyRounds,
  fetchTeams,
  saveStrategyRound
} from '../replays/api.js';
import { MAPS } from '../replays/shared/roundId.js';
import { createCreatorPanel } from '../replays/creator/creatorPanel.js';
import { spinnerHtml } from '../lib/spinner.js';

const MAX_PER_MAP = 8;

function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * @param {{auth: object, escapeHtml: (s: string) => string}} deps
 */
export function initStrategyCreatorView({ auth, escapeHtml }) {
  const shellEl = document.getElementById('sc-shell-host');
  if (!shellEl) return { onShow() {}, onHide() {} };

  let account = { signedIn: false, id: '', username: '', admin: false, verifies: true };
  /** @type {object[]} */
  let teams = [];
  let team = null;
  /** @type {object[]} index entries */
  let rounds = [];
  let loaded = false;
  let loadToken = 0;
  let status = '';
  let statusBad = false;

  let mapFilter = '';
  let sideFilter = '';

  /** @type {ReturnType<typeof createCreatorPanel>|null} */
  let panel = null;
  let pendingShare = '';
  /** True while a share link is being fetched/mounted — blocks auth reloads. */
  let openingShare = false;
  /** Guest opened a share (success or error) — do not replace with "Sign in". */
  let shareView = false;

  const setStatus = (text, bad = false) => {
    status = text || '';
    statusBad = Boolean(bad);
    const node = shellEl.querySelector('#sc-list-status');
    if (node) {
      node.textContent = status;
      node.classList.toggle('bad', statusBad);
    }
  };

  // ---- data ---------------------------------------------------------------

  async function load() {
    const token = ++loadToken;

    // Share links are public: open the round without waiting on account status.
    // Auth onChange used to restart load() mid-fetch, clear pendingShare, and
    // leave guests on "Sign in to build…" after a long Loading… hang.
    const share = pendingShare;
    if (share) {
      if (openingShare) return;
      openingShare = true;
      loaded = false;
      render();
      try {
        await openShared(share);
        if (token !== loadToken) return;
        pendingShare = '';
        loaded = true;
      } finally {
        openingShare = false;
      }
      return;
    }

    const statusBody = await fetchStatus().catch(() => null);
    if (token !== loadToken) return;
    account = { ...account, ...(statusBody?.account || { signedIn: false }) };

    if (!account.signedIn) {
      teams = [];
      team = null;
      rounds = [];
      loaded = true;
      render();
      return;
    }

    teams = await fetchTeams().catch(() => []);
    if (token !== loadToken) return;
    team = teams.find((t) => t.id === team?.id) || teams[0] || null;
    rounds = team ? await fetchStrategyRounds(team.id).catch(() => []) : [];
    loaded = true;
    render();
  }

  // ---- list ---------------------------------------------------------------

  function filtered() {
    return rounds.filter(
      (r) => (!mapFilter || r.map === mapFilter) && (!sideFilter || r.side === sideFilter)
    );
  }

  function roundCard(r) {
    const mapName = MAPS[r.map]?.name || r.map || 'Unknown';
    const s = r.summary || {};
    const mine = r.authorId === account.id || account.admin || team?.isOwner || team?.isAdmin;
    return `
      <article class="sc-card" data-open="${escapeHtml(r.id)}">
        <header class="sc-card-head">
          <span class="sc-card-map">${escapeHtml(mapName)}</span>
          <span class="sc-card-side ${r.side}">${escapeHtml(r.side)}</span>
        </header>
        <h3 class="sc-card-name">${escapeHtml(r.name)}</h3>
        <ul class="sc-card-facts">
          <li>${s.tracks || 0} bodies</li>
          <li>${s.nadeTotal || 0} utility</li>
          <li>${fmtDuration(s.durationMs)}</li>
        </ul>
        <footer class="sc-card-foot">
          <span>by @${escapeHtml(r.authorName || '')} · ${escapeHtml(formatWhen(r.updatedAt))}</span>
          ${
            mine
              ? `<button type="button" class="rp-btn-icon danger" data-drop="${escapeHtml(
                  r.id
                )}" title="Delete round">×</button>`
              : ''
          }
        </footer>
      </article>`;
  }

  function listHtml() {
    const list = filtered();
    const maps = [...new Set(rounds.map((r) => r.map))].sort();
    const perMap = mapFilter ? rounds.filter((r) => r.map === mapFilter).length : 0;

    return `
      <div class="sc-list">
        <div class="sc-list-head">
          <div class="sc-list-filters">
            <select class="site-select" data-filter-map>
              <option value="">All maps</option>
              ${maps
                .map(
                  (m) =>
                    `<option value="${escapeHtml(m)}"${m === mapFilter ? ' selected' : ''}>${escapeHtml(
                      MAPS[m]?.name || m
                    )}</option>`
                )
                .join('')}
            </select>
            <div class="rp-chips">
              <button type="button" class="rp-chip${sideFilter === 'T' ? ' active' : ''}" data-filter-side="T">T</button>
              <button type="button" class="rp-chip${sideFilter === 'CT' ? ' active' : ''}" data-filter-side="CT">CT</button>
            </div>
          </div>
        </div>
        <p class="sc-status${statusBad ? ' bad' : ''}" id="sc-list-status">${escapeHtml(status)}</p>
        ${
          mapFilter
            ? `<p class="sc-note">${perMap} of ${MAX_PER_MAP} rounds used on ${escapeHtml(
                MAPS[mapFilter]?.name || mapFilter
              )}.</p>`
            : ''
        }
        <div class="sc-grid">
          <button type="button" class="sc-card sc-card-new" data-new>
            <span class="sc-plus">+</span>
            <span>New round</span>
          </button>
          ${list.map(roundCard).join('')}
        </div>
        ${
          rounds.length && !list.length
            ? '<p class="view-empty">Nothing matches those filters.</p>'
            : ''
        }
      </div>`;
  }

  function render() {
    if (!loaded) {
      shellEl.innerHTML = spinnerHtml();
      return;
    }
    if (panel || shareView) return;
    if (!account.signedIn) {
      shellEl.innerHTML = `<div class="tm-empty">
        <p class="view-empty">${escapeHtml(
          auth?.isLoggedIn
            ? 'Your session did not reach the backend. Reload the page and try again.'
            : 'Sign in to build strategy rounds.'
        )}</p>
      </div>`;
      return;
    }
    if (!team) {
      shellEl.innerHTML = `<div class="tm-empty">
        <p class="view-empty">Join or create a team first: strategy rounds belong to a team.</p>
      </div>`;
      return;
    }
    shellEl.innerHTML = listHtml();
  }

  // ---- stage --------------------------------------------------------------

  function closeStage() {
    panel?.destroy();
    panel = null;
    shareView = false;
    shellEl.classList.remove('sc-hosting');
    // Drop ?share= so Back from a shared round does not reopen it forever.
    if (new URLSearchParams(window.location.search).has('share')) {
      window.history.replaceState(null, '', '/team/creator');
    }
    render();
  }

  function mountStage({ entry = null, round = null, map = '', side = 'T', readOnly = false }) {
    panel?.destroy();
    panel = createCreatorPanel({
      escapeHtml,
      strategies: team?.stratbook || [],
      readOnly,
      onClose: () => {
        if (panel?.hasUnsavedWork() && !window.confirm('Leave without saving this round?')) return;
        closeStage();
        // Reload so Back always lands on the rounds overview (account/teams may
        // never have been fetched when the stage was opened from a share link).
        load();
      },
      onSave: async (payload) => {
        const res = await saveStrategyRound(team.id, payload);
        rounds = res.rounds || rounds;
        return res;
      }
    });
    shellEl.innerHTML = '';
    shellEl.classList.add('sc-hosting');
    shellEl.appendChild(panel.el);
    panel.load({ entry, round, map, side });
  }

  async function openRound(id) {
    try {
      const res = await fetchStrategyRound(team.id, id);
      mountStage({ entry: res.entry, round: res.round });
    } catch (err) {
      setStatus(err.message || 'Could not open that round.', true);
    }
  }

  async function openShared(shareId) {
    shareView = true;
    try {
      const res = await fetchSharedStrategyRound(shareId);
      mountStage({ entry: res.entry, round: res.round, readOnly: true });
    } catch (err) {
      panel = null;
      shellEl.classList.remove('sc-hosting');
      shellEl.innerHTML = `<div class="tm-empty">
        <p class="view-empty">${escapeHtml(err.message || 'That link is not valid.')}</p>
      </div>`;
    }
  }

  // ---- events -------------------------------------------------------------

  shellEl.addEventListener('click', async (e) => {
    if (panel) return;
    const t = e.target;

    if (t.closest('[data-new]')) {
      mountStage({ map: mapFilter, side: sideFilter || 'T' });
      return;
    }
    const drop = t.closest('[data-drop]');
    if (drop) {
      e.stopPropagation();
      const id = drop.dataset.drop;
      const target = rounds.find((r) => r.id === id);
      if (!window.confirm(`Delete "${target?.name || 'this round'}"?`)) return;
      try {
        const res = await deleteStrategyRound(team.id, id);
        rounds = res.rounds || rounds.filter((r) => r.id !== id);
        render();
      } catch (err) {
        setStatus(err.message || 'Could not delete that round.', true);
      }
      return;
    }
    const open = t.closest('[data-open]');
    if (open) openRound(open.dataset.open);
  });

  shellEl.addEventListener('change', (e) => {
    const m = e.target.closest('[data-filter-map]');
    if (m) {
      mapFilter = m.value;
      render();
    }
  });

  shellEl.addEventListener('click', (e) => {
    const side = e.target.closest('[data-filter-side]');
    if (!side || panel) return;
    sideFilter = sideFilter === side.dataset.filterSide ? '' : side.dataset.filterSide;
    render();
  });

  auth?.onChange?.(() => {
    if (panel || openingShare || pendingShare || shareView) return;
    loaded = false;
    load();
  });

  return {
    onShow(params = {}) {
      const share = String(params.share || '').trim();
      if (share) {
        pendingShare = share;
        if (panel || openingShare) return;
        loaded = false;
        load();
        return;
      }
      if (panel) return;
      if (!loaded || !account.signedIn) load();
      else render();
    },
    onHide() {
      if (panel?.hasUnsavedWork()) return;
      if (panel) closeStage();
    },
    /** Called by the router for /s2/<code> landings. */
    setShare(code) {
      pendingShare = code;
    }
  };
}
