// ---------------------------------------------------------------------------
// site/leaderboardsView.js
// The trainer's leaderboard menu, hosted on the aim4.io site shell. Same
// structure as in-game: Ranked ELO and Aim Rating tabs plus a per-gamemode
// board picker, rendered with the same table columns.
// ---------------------------------------------------------------------------

import {
  SCENARIO_META,
  GAMEMODE_IDS,
  sortModesByTitle,
  lbConfigKeyFor
} from '../lib/gamemodeCatalog.js';
import {
  fetchLeaderboardWithMeta,
  fetchEloLeaderboardWithMeta
} from '../lib/cloudScores.js';
import { fetchAimCategoryLeaderboard, fetchAimRatingLeaderboard } from '../lib/aimRating.js';
import { OVERALL_AIM_MIN_MODES, RATING_CATEGORIES, RATING_COLUMN, RATING_LABELS } from '../lib/aim4Ratings.js';
import {
  isKillLeaderboardScenario,
  isLowerScoreLeaderboardScenario
} from '../scenarios/leaderboardConfig.js';
import { assignRanks } from '../lib/aimRanks.js';
import { clampPage, pageCount, pageOf, pageWithUser } from '../lib/leaderboardPaging.js';
import { supabaseConfigured } from '../lib/supabase.js';
import { spinnerHtml } from '../lib/spinner.js';

const EMPTY = '-';

/**
 * What a board ranks on. One number per row, the same one the Score column
 * shows, so a rank can never disagree with the table it sits in.
 */
function boardValue(row, scenario) {
  if (scenario === 'elo') return row.elo;
  // A category board returns the score as `rating`; the overall one names its
  // own column. Both are the number that board is sorted on.
  if (String(scenario || '').startsWith('aim:')) return row.rating;
  if (scenario === 'aim-rating') return row.overall_aim_rating;
  if (isKillLeaderboardScenario(scenario)) return row.kills ?? row.score;
  return row.score;
}

/**
 * How many rows a board is ranked over, and how many it shows.
 *
 * These are different numbers on purpose. Ranks are cut between the worst and
 * the best score on the board, so the board sets BOTH ends of the scale: rank
 * the ten rows on screen and the tenth best score becomes the floor, which
 * puts every rank on the board in the wrong place. The whole board is pulled,
 * cut into ranks, and then the top of it is drawn.
 *
 * Past RANK_OVER players a board stops fitting in one read and the ranks below
 * the cut drift low. Moving the percentile to the server is the fix; until a
 * board is anywhere near this, one read is the whole truth.
 */
const RANK_OVER = 500;
const SHOW_ROWS = { elo: 50, 'aim-rating': 50, mode: 10 };

/**
 * The seven aiming categories as their own boards, keyed `aim:<column>`.
 *
 * The overall rating is the MEAN of these, and a mean hides the thing a player
 * came to the board for: two people on the same overall can be opposites, and
 * one board says they are equal.
 */
const AIM_BOARDS = RATING_CATEGORIES.map((key) => ({
  board: `aim:${RATING_COLUMN[key]}`,
  column: RATING_COLUMN[key],
  label: RATING_LABELS[key]
}));

const isAimCategory = (board) => String(board || '').startsWith('aim:');
const aimColumnOf = (board) => String(board || '').slice(4);

/**
 * Ranks for one board, over every row of it.
 *
 * @param {Array} list the whole board, not a page of it
 */
function ranksFor(list, scenario) {
  return assignRanks(
    list.map((r) => boardValue(r, scenario)),
    { higherIsBetter: !isLowerScoreLeaderboardScenario(scenario) }
  );
}

function rankCell(rank) {
  if (!rank) return `<td class="lb-rank">${EMPTY}</td>`;
  return `<td class="lb-rank"><span class="lb-rank-badge" data-tier="${rank.tier}" title="Top ${rank.top}%">${rank.name}</span></td>`;
}

function formatTimePlayed(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return EMPTY;
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  return `${seconds.toFixed(1)}s`;
}

/** Run timestamp in the viewer's local timezone, e.g. `12.34 CEST, 29.06.2026`. */
function formatRunWhen(iso) {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY;
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
    timeZoneName: 'short'
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}.${get('minute')} ${get('timeZoneName')}, ${get('day')}.${get('month')}.${get('year')}`;
}

export function initLeaderboardsView({ auth, escapeHtml, openProfile }) {
  const body = document.getElementById('lb-body');
  const tabs = document.getElementById('lb-tabs');
  const modeSelect = document.getElementById('lb-mode-select');
  const catSelect = document.getElementById('lb-cat-select');
  const pager = document.getElementById('lb-pager');

  let board = 'elo'; // 'elo' | 'aim:<category>' | scenario id
  let renderSeq = 0;
  /** Page of the current board, 0 based. Reset whenever the board changes. */
  let page = 0;
  /** Set once per board load, so arriving lands on the viewer's own page. */
  let pageSetForBoard = '';

  if (catSelect) {
    catSelect.innerHTML = AIM_BOARDS.map(
      (c) => `<option value="${c.board}">${escapeHtml(c.label)}</option>`
    ).join('');
  }

  modeSelect.innerHTML = '<option value="" hidden>Gamemode</option>' + sortModesByTitle(GAMEMODE_IDS)
    .map((k) => `<option value="${k}">${escapeHtml(SCENARIO_META[k].title)}</option>`)
    .join('');

  const playerCell = (r) => {
    const name = escapeHtml(r.username || 'player');
    if (!r.user_id || !openProfile) return `<td class="lb-player">${name}</td>`;
    return `<td class="lb-player"><button type="button" class="lb-player-link" data-lb-user-id="${escapeHtml(r.user_id)}" data-lb-username="${name}">${name}</button></td>`;
  };

  function rowsHtml(list, scenario, error, offset = 0) {
    if (!supabaseConfigured()) {
      return '<p class="lb-hint">Account leaderboards are not configured.</p>';
    }
    if (error) {
      return `<p class="lb-hint lb-error">Could not load leaderboard: ${escapeHtml(error)}</p>`;
    }
    if (!list.length) {
      const hint = scenario === 'elo'
        ? 'No ranked accounts yet. Sign in and play matchmaking to appear here.'
        : scenario === 'aim-rating' || isAimCategory(scenario)
          ? `No ratings here yet. Rank in at least ${OVERALL_AIM_MIN_MODES} rated modes to appear.`
          : 'No scores for this mode yet. Finish a competitive run to appear here.';
      return `<p class="lb-hint">${hint}</p>`;
    }

    const meId = auth?.user?.id || null;
    const hl = (r) => (meId && r.user_id === meId ? ' class="hl"' : '');
    // Ranked over everyone, drawn for one page. Slicing first would rank the
    // page instead of the board.
    const allRanks = ranksFor(list, scenario);
    const show = pageSize(scenario);
    const ranks = allRanks.slice(offset, offset + show);
    list = list.slice(offset, offset + show);

    if (scenario === 'aim-rating' || isAimCategory(scenario)) {
      const title = isAimCategory(scenario)
        ? AIM_BOARDS.find((c) => c.board === scenario)?.label || 'Rating'
        : 'Aim Rating';
      const rows = list.map((r, i) => {
        const v = boardValue(r, scenario);
        return `<tr${hl(r)}>
        <td>${offset + i + 1}</td>${playerCell(r)}${rankCell(ranks[i])}
        <td class="score">${v != null ? Number(v).toFixed(2) : EMPTY}</td>
      </tr>`;
      }).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Rank</th><th>${escapeHtml(title)}</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    if (scenario === 'elo') {
      const pct = (v) => (v != null && Number.isFinite(v) ? Math.round(v * 100) + '%' : EMPTY);
      const rows = list.map((r, i) => {
        const games = r.games ?? r.games_played ?? EMPTY;
        const wl = r.wins != null && r.losses != null ? `${r.wins}-${r.losses}` : EMPTY;
        const kd = r.kd != null
          ? Number(r.kd).toFixed(2)
          : (r.kills != null && r.deaths != null
            ? (r.kills / Math.max(1, r.deaths)).toFixed(2)
            : EMPTY);
        return `<tr${hl(r)}>
          <td>${offset + i + 1}</td>${playerCell(r)}${rankCell(ranks[i])}
          <td class="score">${Number(r.elo ?? 1000).toLocaleString()}</td>
          <td>${games}</td><td>${wl}</td><td>${kd}</td>
          <td>${pct(r.accuracy)}</td><td>${pct(r.hs_accuracy ?? r.headshot_accuracy)}</td>
        </tr>`;
      }).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Rank</th><th>ELO</th><th>Games</th><th>W-L</th><th>K/D</th><th>Acc</th><th>HS%</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    if (scenario === 'reactiontime') {
      const rows = list.map((r, i) => `<tr${hl(r)}>
        <td>${offset + i + 1}</td>${playerCell(r)}${rankCell(ranks[i])}
        <td class="score">${Number(r.score ?? 0).toLocaleString()} ms</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        <td class="lb-when">${formatRunWhen(r.achieved_at)}</td>
      </tr>`).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Rank</th><th>Avg</th><th>Acc</th><th>When</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    if (isKillLeaderboardScenario(scenario)) {
      const rows = list.map((r, i) => `<tr${hl(r)}>
        <td>${offset + i + 1}</td>${playerCell(r)}${rankCell(ranks[i])}
        <td class="score">${Number(r.kills ?? r.score ?? 0).toLocaleString()}</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        <td>${formatTimePlayed(r.time_played)}</td>
        <td class="lb-when">${formatRunWhen(r.achieved_at)}</td>
      </tr>`).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Rank</th><th>Kills</th><th>Acc</th><th>Time</th><th>When</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    const rows = list.map((r, i) => {
      const crit = scenario !== 'survival' && scenario !== 'expand'
        ? `<td>${Math.round((r.crit_ratio || 0) * 100)}%</td>`
        : `<td>${EMPTY}</td>`;
      return `<tr${hl(r)}>
        <td>${offset + i + 1}</td>${playerCell(r)}${rankCell(ranks[i])}
        <td class="score">${Number(r.score).toLocaleString()}</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        ${crit}
        <td>${r.kills ?? EMPTY}</td>
        <td class="lb-when">${formatRunWhen(r.achieved_at)}</td>
      </tr>`;
    }).join('');
    return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Rank</th><th>Score</th><th>Acc</th><th>Crit</th><th>Kills</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  async function fetchBoard(scenario) {
    // RANK_OVER rows, not a screenful: the rank on every row is a position in
    // the whole board, so the whole board has to be here to cut it up.
    if (scenario === 'elo') return fetchEloLeaderboardWithMeta(RANK_OVER);
    if (isAimCategory(scenario)) {
      try {
        const list = await fetchAimCategoryLeaderboard(aimColumnOf(scenario), RANK_OVER);
        return { list, error: null };
      } catch (e) {
        return { list: [], error: e.message || 'Failed to load that aim leaderboard.' };
      }
    }
    if (scenario === 'aim-rating') {
      try {
        return { list: await fetchAimRatingLeaderboard(RANK_OVER), error: null };
      } catch (e) {
        return { list: [], error: e.message || 'Failed to load aim rating leaderboard.' };
      }
    }
    return fetchLeaderboardWithMeta(scenario, lbConfigKeyFor(scenario), RANK_OVER);
  }

  /** Rows drawn per page for a board. */
  function pageSize(scenario) {
    if (scenario === 'elo' || scenario === 'aim-rating' || isAimCategory(scenario)) {
      return SHOW_ROWS['aim-rating'];
    }
    return SHOW_ROWS.mode;
  }

  /**
   * The page the signed-in player is on, or 0.
   *
   * Opening a leaderboard to look for yourself and finding page one of nine is
   * the whole friction this removes. Set once per board: paging away and back
   * to the same board keeps where you were, changing board looks you up again.
   */
  function pageWithMe(list, scenario) {
    return pageWithUser(list, auth?.user?.id || null, pageSize(scenario));
  }

  function renderPager(total, scenario) {
    if (!pager) return;
    const size = pageSize(scenario);
    const pages = pageCount(total, size);
    pager.hidden = pages <= 1;
    if (pages <= 1) {
      pager.innerHTML = '';
      return;
    }
    const meId = auth?.user?.id;
    const mine = meId ? list_pageOf(meId) : -1;
    pager.innerHTML = `
      <button type="button" class="lb-page-btn" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Previous</button>
      <span class="lb-page-at">Page ${page + 1} of ${pages}</span>
      <button type="button" class="lb-page-btn" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
      ${mine >= 0 && mine !== page ? `<button type="button" class="lb-page-btn lb-page-me" data-page="${mine}">Jump to me</button>` : ''}`;
  }

  /** The board currently loaded, whole. Pages are cut from it, never fetched. */
  let loaded = [];

  /** Which page a user sits on in the loaded board, or -1 if they are absent. */
  function list_pageOf(userId) {
    const at = loaded.findIndex((r) => r.user_id === userId);
    return at < 0 ? -1 : pageOf(at, pageSize(board));
  }

  function syncControls() {
    const isAim = isAimCategory(board) || board === 'aim-rating';
    tabs.querySelectorAll('[data-lb]').forEach((t) => {
      const on = t.dataset.lb === board || (t.dataset.lb === 'aim-rating' && isAim);
      t.classList.toggle('active', on);
    });
    const isMode = board !== 'elo' && !isAim;
    modeSelect.classList.toggle('active', isMode);
    modeSelect.value = isMode ? board : '';
    if (catSelect) {
      catSelect.classList.toggle('active', isAim);
      catSelect.value = isAimCategory(board) ? board : AIM_BOARDS[0].board;
    }
  }

  async function render() {
    const seq = ++renderSeq;
    syncControls();
    body.innerHTML = spinnerHtml('Loading leaderboard…');
    const { list, error } = await fetchBoard(board);
    if (seq !== renderSeq) return;
    loaded = list || [];
    // Land on the viewer's own row the first time a board is opened.
    if (pageSetForBoard !== board) {
      pageSetForBoard = board;
      page = pageWithMe(loaded, board);
    }
    const size = pageSize(board);
    page = clampPage(page, loaded.length, size);
    body.innerHTML = rowsHtml(loaded, board, error, page * size);
    renderPager(loaded.length, board);
  }

  pager?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    const next = Number(btn.dataset.page);
    if (!Number.isFinite(next) || next === page) return;
    page = next;
    const size = pageSize(board);
    body.innerHTML = rowsHtml(loaded, board, null, page * size);
    renderPager(loaded.length, board);
    body.scrollIntoView({ block: 'nearest' });
  });

  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-lb]');
    if (!tab) return;
    // The Aim tab opens the first category rather than the mean of them: there
    // is no overall board any more, there are seven.
    board = tab.dataset.lb === 'aim-rating' ? AIM_BOARDS[0].board : tab.dataset.lb;
    render();
  });

  catSelect?.addEventListener('change', () => {
    if (!catSelect.value) return;
    board = catSelect.value;
    render();
  });

  modeSelect.addEventListener('change', () => {
    if (modeSelect.value) {
      board = modeSelect.value;
      render();
    }
  });

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lb-user-id]');
    if (!btn || !openProfile) return;
    openProfile(btn.dataset.lbUserId, btn.dataset.lbUsername || 'Player');
  });

  return {
    onShow(params) {
      const mode = params?.mode;
      if (mode && SCENARIO_META[mode]) board = mode;
      render();
    }
  };
}
