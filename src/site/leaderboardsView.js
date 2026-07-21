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
import { fetchAimRatingLeaderboard } from '../lib/aimRating.js';
import { OVERALL_AIM_MIN_MODES } from '../lib/aim4Ratings.js';
import { isKillLeaderboardScenario } from '../scenarios/leaderboardConfig.js';
import { supabaseConfigured } from '../lib/supabase.js';

const EMPTY = '-';

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

export function initLeaderboardsView({ auth, escapeHtml }) {
  const body = document.getElementById('lb-body');
  const tabs = document.getElementById('lb-tabs');
  const modeSelect = document.getElementById('lb-mode-select');

  let board = 'elo'; // 'elo' | 'aim-rating' | scenario id
  let renderSeq = 0;

  modeSelect.innerHTML = '<option value="" hidden>Gamemode</option>' + sortModesByTitle(GAMEMODE_IDS)
    .map((k) => `<option value="${k}">${escapeHtml(SCENARIO_META[k].title)}</option>`)
    .join('');

  const playerCell = (r) => `<td class="lb-player">${escapeHtml(r.username || 'player')}</td>`;

  function rowsHtml(list, scenario, error) {
    if (!supabaseConfigured()) {
      return '<p class="lb-hint">Account leaderboards are not configured.</p>';
    }
    if (error) {
      return `<p class="lb-hint lb-error">Could not load leaderboard: ${escapeHtml(error)}</p>`;
    }
    if (!list.length) {
      const hint = scenario === 'elo'
        ? 'No ranked accounts yet. Sign in and play matchmaking to appear here.'
        : scenario === 'aim-rating'
          ? `No aim ratings yet. Rank in at least ${OVERALL_AIM_MIN_MODES} rated modes to appear here.`
          : 'No scores for this mode yet. Finish a competitive run to appear here.';
      return `<p class="lb-hint">${hint}</p>`;
    }

    const meId = auth?.user?.id || null;
    const hl = (r) => (meId && r.user_id === meId ? ' class="hl"' : '');

    if (scenario === 'aim-rating') {
      const rows = list.map((r, i) => `<tr${hl(r)}>
        <td>${i + 1}</td>${playerCell(r)}
        <td class="score">${r.overall_aim_rating != null ? Number(r.overall_aim_rating).toFixed(2) : EMPTY}</td>
      </tr>`).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Aim Rating</th></tr></thead>
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
          <td>${i + 1}</td>${playerCell(r)}
          <td class="score">${Number(r.elo ?? 1000).toLocaleString()}</td>
          <td>${games}</td><td>${wl}</td><td>${kd}</td>
          <td>${pct(r.accuracy)}</td><td>${pct(r.hs_accuracy ?? r.headshot_accuracy)}</td>
        </tr>`;
      }).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>ELO</th><th>Games</th><th>W-L</th><th>K/D</th><th>Acc</th><th>HS%</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    if (scenario === 'reactiontime') {
      const rows = list.map((r, i) => `<tr${hl(r)}>
        <td>${i + 1}</td>${playerCell(r)}
        <td class="score">${Number(r.score ?? 0).toLocaleString()} ms</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        <td class="lb-when">${formatRunWhen(r.achieved_at)}</td>
      </tr>`).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Avg</th><th>Acc</th><th>When</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    if (isKillLeaderboardScenario(scenario)) {
      const rows = list.map((r, i) => `<tr${hl(r)}>
        <td>${i + 1}</td>${playerCell(r)}
        <td class="score">${Number(r.kills ?? r.score ?? 0).toLocaleString()}</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        <td>${formatTimePlayed(r.time_played)}</td>
        <td class="lb-when">${formatRunWhen(r.achieved_at)}</td>
      </tr>`).join('');
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Player</th><th>Kills</th><th>Acc</th><th>Time</th><th>When</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }

    const rows = list.map((r, i) => {
      const crit = scenario !== 'survival' && scenario !== 'expand'
        ? `<td>${Math.round((r.crit_ratio || 0) * 100)}%</td>`
        : `<td>${EMPTY}</td>`;
      return `<tr${hl(r)}>
        <td>${i + 1}</td>${playerCell(r)}
        <td class="score">${Number(r.score).toLocaleString()}</td>
        <td>${Math.round((r.accuracy || 0) * 100)}%</td>
        ${crit}
        <td>${r.kills ?? EMPTY}</td>
        <td class="lb-when">${formatRunWhen(r.achieved_at)}</td>
      </tr>`;
    }).join('');
    return `<table class="lb-table">
      <thead><tr><th>#</th><th>Player</th><th>Score</th><th>Acc</th><th>Crit</th><th>Kills</th><th>When</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  async function fetchBoard(scenario) {
    if (scenario === 'elo') return fetchEloLeaderboardWithMeta(50);
    if (scenario === 'aim-rating') {
      try {
        return { list: await fetchAimRatingLeaderboard(50), error: null };
      } catch (e) {
        return { list: [], error: e.message || 'Failed to load aim rating leaderboard.' };
      }
    }
    return fetchLeaderboardWithMeta(scenario, lbConfigKeyFor(scenario), 10);
  }

  function syncControls() {
    tabs.querySelectorAll('[data-lb]').forEach((t) => {
      t.classList.toggle('active', t.dataset.lb === board);
    });
    const isMode = board !== 'elo' && board !== 'aim-rating';
    modeSelect.classList.toggle('active', isMode);
    if (isMode) modeSelect.value = board;
    else modeSelect.value = '';
  }

  async function render() {
    const seq = ++renderSeq;
    syncControls();
    body.innerHTML = '<p class="lb-hint">Loading…</p>';
    const { list, error } = await fetchBoard(board);
    if (seq !== renderSeq) return;
    body.innerHTML = rowsHtml(list || [], board, error);
  }

  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-lb]');
    if (!tab) return;
    board = tab.dataset.lb;
    render();
  });

  modeSelect.addEventListener('change', () => {
    if (modeSelect.value) {
      board = modeSelect.value;
      render();
    }
  });

  return {
    onShow(params) {
      const mode = params?.mode;
      if (mode && SCENARIO_META[mode]) board = mode;
      render();
    }
  };
}
