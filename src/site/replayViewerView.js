// ---------------------------------------------------------------------------
// site/replayViewerView.js
// Aim-trainer profile + last/best replays (same idea as the in-game account
// screen). Playback opens /train?replayPath=… so the Three.js player can run.
// ---------------------------------------------------------------------------

import { fetchPublicProfile } from '../lib/userProfile.js';
import {
  fetchAllAccountStats,
  formatModeStat,
  formatRankLabel
} from '../lib/accountStats.js';
import { SCENARIO_META } from '../lib/gamemodeCatalog.js';
import { formatPlayTime } from '../lib/playTime.js';
import { flagEmoji } from '../lib/countries.js';
import { listAccountReplays } from '../lib/replayStore.js';
import { supabaseConfigured } from '../lib/supabase.js';
import { isKillLeaderboardScenario } from '../scenarios/leaderboardConfig.js';

/**
 * @param {{
 *   auth: import('../core/AuthManager.js').AuthManager,
 *   escapeHtml: (s: string) => string,
 *   openSelf?: () => void
 * }} opts
 */
export function initReplayViewerView({ auth, escapeHtml, openSelf = null }) {
  const root = document.getElementById('rvw-root');
  if (!root) {
    return { onShow() {}, onHide() {} };
  }

  let loadSeq = 0;

  function playHref(path, title) {
    const u = new URL('/train', window.location.origin);
    u.searchParams.set('replayPath', path);
    if (title) u.searchParams.set('replayTitle', title);
    return u.pathname + u.search;
  }

  function formatScore(scenario, row) {
    if (!row) return '—';
    if (isKillLeaderboardScenario(scenario)) {
      const k = row.kills ?? row.score ?? 0;
      const acc = Number(row.accuracy);
      return Number.isFinite(acc) ? `${k} kills · ${(acc * 100).toFixed(1)}%` : `${k} kills`;
    }
    return `${Math.round(Number(row.score) || 0)}`;
  }

  function statsHtml(stats) {
    const rows = [];
    const eloRank = formatRankLabel(stats.elo.rank, stats.elo.total);
    const eloVal = stats.elo.elo != null ? `${stats.elo.elo} ELO` : '—';
    rows.push(
      `<tr><td>Ranked matchmaking</td><td class="profile-rank">${escapeHtml(eloRank)}</td><td>${escapeHtml(eloVal)}</td></tr>`
    );
    for (const m of stats.modes || []) {
      const title = SCENARIO_META[m.scenario]?.title ?? m.scenario;
      rows.push(
        `<tr><td>${escapeHtml(title)}</td><td class="profile-rank">${escapeHtml(
          formatRankLabel(m.rank, m.total)
        )}</td><td>${escapeHtml(formatModeStat(m.scenario, m))}</td></tr>`
      );
    }
    return `<table class="profile-stats-table">
      <thead><tr><th>Mode</th><th>Rank</th><th>Best</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
  }

  function replayBtn(row, label, modeTitle) {
    const title = `${modeTitle} — ${label}`;
    const href = playHref(row.replay_file_path, title);
    const score = formatScore(row.scenario, row);
    return `<a class="btn btn-sm rvw-replay-btn" href="${escapeHtml(href)}" title="${escapeHtml(
      score
    )}">${escapeHtml(label)}</a>`;
  }

  function replaysHtml(rows, viewingOther) {
    if (!rows.length) {
      return `<p class="view-empty">${
        viewingOther ? 'No replays yet.' : 'No replays yet — finish a run in Training to record one.'
      }</p>`;
    }
    const byScenario = new Map();
    for (const r of rows) {
      if (!r?.scenario || !r?.replay_file_path) continue;
      if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, {});
      byScenario.get(r.scenario)[`${r.variant}:${r.slot}`] = r;
    }
    const items = [];
    for (const [scenario, slots] of byScenario) {
      const title = SCENARIO_META[scenario]?.title ?? scenario;
      const last = slots['competitive:last'] || slots['practice:last'];
      const best = slots['competitive:best'];
      const btns = [];
      if (last) btns.push(replayBtn(last, 'Last run', title));
      if (best) btns.push(replayBtn(best, 'Best run', title));
      if (!btns.length) continue;
      items.push(`<div class="rvw-replay-row">
        <span class="rvw-replay-name">${escapeHtml(title)}</span>
        <span class="rvw-replay-btns">${btns.join('')}</span>
      </div>`);
    }
    return items.length
      ? `<div class="rvw-replays">${items.join('')}</div>`
      : `<p class="view-empty">${viewingOther ? 'No replays yet.' : 'No replays yet.'}</p>`;
  }

  async function render(userId, fallbackName = 'Player') {
    const seq = ++loadSeq;
    const selfId = auth?.user?.id || null;
    const uid = userId || selfId;
    const viewingOther = !!(uid && selfId && uid !== selfId);

    if (!uid) {
      root.innerHTML = `
        <div class="rvw-empty">
          <h2>Replay Viewer</h2>
          <p class="view-empty">Sign in to see your profile and saved last / best runs, or open a player from Leaderboards.</p>
          <button type="button" class="btn primary" id="rvw-signin">Sign in</button>
        </div>`;
      root.querySelector('#rvw-signin')?.addEventListener('click', () => {
        document.getElementById('side-account-btn')?.click();
      });
      return;
    }

    root.innerHTML = `
      <div class="rvw-loading"><p class="view-empty">Loading profile…</p></div>`;

    try {
      const [profile, stats, rows] = await Promise.all([
        fetchPublicProfile(uid),
        fetchAllAccountStats(uid),
        supabaseConfigured()
          ? listAccountReplays(uid).catch(() => [])
          : Promise.resolve([])
      ]);
      if (seq !== loadSeq) return;
      if (!profile) throw new Error('Player not found.');

      const name = profile.username || fallbackName || 'Player';
      const flag = profile.country_code ? `${flagEmoji(profile.country_code)} ` : '';
      const bits = [];
      if (profile.elo != null) bits.push(`${Number(profile.elo).toLocaleString()} ELO`);
      if (profile.play_time_sec != null) {
        bits.push(`Played ${formatPlayTime(profile.play_time_sec)}`);
      }
      const you = !viewingOther && selfId === uid;

      root.innerHTML = `
        <header class="rvw-head">
          <div>
            <p class="rvw-kicker">${you ? 'Your profile' : 'Player profile'}</p>
            <h2 class="rvw-name">${flag}${escapeHtml(name)}</h2>
            <p class="rvw-meta">${escapeHtml(bits.join(' · ') || '—')}</p>
          </div>
          ${
            viewingOther && selfId
              ? `<button type="button" class="btn btn-sm" id="rvw-mine">View my replays</button>`
              : ''
          }
        </header>

        <section class="rvw-section">
          <h3 class="rvw-section-title">Placements</h3>
          ${statsHtml(stats)}
        </section>

        <section class="rvw-section">
          <h3 class="rvw-section-title">Replays</h3>
          <p class="rvw-section-hint">Last and best runs open in the trainer player.</p>
          ${
            supabaseConfigured()
              ? replaysHtml(rows, viewingOther)
              : '<p class="view-empty">Replays are not configured.</p>'
          }
        </section>`;

      root.querySelector('#rvw-mine')?.addEventListener('click', () => {
        if (openSelf) openSelf();
        else render(selfId, auth?.displayName || 'Player');
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      root.innerHTML = `<p class="view-empty">${escapeHtml(err.message || 'Could not load profile.')}</p>`;
    }
  }

  return {
    onShow(params = {}) {
      const user = params.user ? String(params.user) : '';
      const name = params.name ? String(params.name) : 'Player';
      render(user || null, name);
    },
    onHide() {
      loadSeq++;
    }
  };
}
