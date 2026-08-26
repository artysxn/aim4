// ---------------------------------------------------------------------------
// site/profileModal.js
// Public player profile dialog opened from site leaderboard name clicks.
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
import { spinnerHtml } from '../lib/spinner.js';

/**
 * @param {{ escapeHtml: (s: string) => string }} opts
 * @returns {{ openProfile: (userId: string, username?: string) => void, closeProfile: () => void }}
 */
export function initProfileModal({ escapeHtml }) {
  const modal = document.getElementById('profile-modal');
  const backdrop = document.getElementById('profile-modal-backdrop');
  const closeBtn = document.getElementById('profile-close');
  const titleEl = document.getElementById('profile-title');
  const metaEl = document.getElementById('profile-meta');
  const bodyEl = document.getElementById('profile-body');

  if (!modal || !bodyEl) {
    return { openProfile() {}, closeProfile() {} };
  }

  let loadSeq = 0;

  function closeProfile() {
    modal.hidden = true;
    document.body.classList.remove('profile-open');
  }

  function openProfile(userId, username = 'Player') {
    if (!userId) return;
    const seq = ++loadSeq;
    modal.hidden = false;
    document.body.classList.add('profile-open');
    if (titleEl) titleEl.textContent = username || 'Player';
    if (metaEl) metaEl.textContent = '';
    bodyEl.innerHTML = spinnerHtml('Loading profile…');
    loadProfile(userId, username, seq);
  }

  async function loadProfile(userId, fallbackName, seq) {
    try {
      const [profile, stats] = await Promise.all([
        fetchPublicProfile(userId),
        fetchAllAccountStats(userId)
      ]);
      if (seq !== loadSeq) return;
      if (!profile) throw new Error('Player not found.');

      const name = profile.username || fallbackName || 'Player';
      if (titleEl) {
        const flag = profile.country_code ? `${flagEmoji(profile.country_code)} ` : '';
        titleEl.textContent = `${flag}${name}`;
      }
      if (metaEl) {
        const bits = [];
        if (profile.elo != null) bits.push(`${Number(profile.elo).toLocaleString()} ELO`);
        if (profile.play_time_sec != null) {
          bits.push(`Played ${formatPlayTime(profile.play_time_sec)}`);
        }
        metaEl.textContent = bits.join(' · ');
      }
      bodyEl.innerHTML = statsHtml(stats, escapeHtml);
    } catch (e) {
      if (seq !== loadSeq) return;
      bodyEl.innerHTML = `<p class="lb-hint lb-error">${escapeHtml(e.message || 'Could not load profile.')}</p>`;
    }
  }

  function statsHtml(stats, esc) {
    const rows = [];
    const eloRank = formatRankLabel(stats.elo.rank, stats.elo.total);
    const eloVal = stats.elo.elo != null ? `${stats.elo.elo} ELO` : '—';
    rows.push(
      `<tr><td>Ranked matchmaking</td><td class="profile-rank">${esc(eloRank)}</td><td>${esc(eloVal)}</td></tr>`
    );
    for (const m of stats.modes || []) {
      const title = SCENARIO_META[m.scenario]?.title ?? m.scenario;
      rows.push(
        `<tr><td>${esc(title)}</td><td class="profile-rank">${esc(formatRankLabel(m.rank, m.total))}</td><td>${esc(formatModeStat(m.scenario, m))}</td></tr>`
      );
    }
    return `<table class="profile-stats-table">
      <thead><tr><th>Mode</th><th>Rank</th><th>Best</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
  }

  closeBtn?.addEventListener('click', closeProfile);
  backdrop?.addEventListener('click', closeProfile);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeProfile();
  });

  return { openProfile, closeProfile };
}
