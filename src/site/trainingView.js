// ---------------------------------------------------------------------------
// site/trainingView.js
// The trainer's gamemode menu, hosted on the aim4.io site shell. Mirrors the
// in-game Training menu: category tiles, then one row per mode whose right
// edge is a run of flush launch cells (Training / Competitive / Adaptive) and
// a leaderboard shortcut. Launching a mode navigates to its deep link
// (/gridshot, /gridshot/competitive, /gridshot/adaptive) where the trainer
// boots straight into the run.
// ---------------------------------------------------------------------------

import {
  SCENARIO_META,
  TRAINING_CATEGORIES,
  trainingCategoryModes
} from '../lib/gamemodeCatalog.js';
import {
  SCENARIO_ICONS,
  PRECISION_ICON,
  SNIPING_ICON,
  ALL_MODES_ICON,
  LEADERBOARD_ICON
} from '../aim4/icons.js';
import { DEFAULT_ELO, eloFor } from '../lib/adaptiveElo.js';

const CATEGORY_ICONS = {
  precision: PRECISION_ICON,
  tracking: () => SCENARIO_ICONS.tracking,
  speed: () => SCENARIO_ICONS.gridshot,
  flicking: () => SCENARIO_ICONS.spidershot,
  sniping: SNIPING_ICON,
  general: () => SCENARIO_ICONS.range,
  challenges: () => SCENARIO_ICONS.waves,
  all: ALL_MODES_ICON
};

function categoryIcon(id) {
  const v = CATEGORY_ICONS[id];
  return typeof v === 'function' ? v() : v;
}

export function initTrainingView({ escapeHtml, openLeaderboards }) {
  const catsEl = document.getElementById('training-cats');
  const listEl = document.getElementById('training-list');
  const searchWrap = document.getElementById('training-search-wrap');
  const searchInput = document.getElementById('training-search');

  let category = 'all';
  let query = '';

  function matchesSearch(key) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const meta = SCENARIO_META[key] || { title: key, tags: [] };
    if (meta.title.toLowerCase().includes(q)) return true;
    return (meta.tags || []).some((tag) => tag.toLowerCase().includes(q));
  }

  /** The per-mode level, shown only once it has moved off the default. */
  function adaptiveEloHtml(key) {
    const elo = eloFor(key);
    return elo === DEFAULT_ELO ? '' : `<span class="training-cell-elo">${elo}</span>`;
  }

  function rowHtml(key) {
    const meta = SCENARIO_META[key] || { title: key, tags: [] };
    const icon = SCENARIO_ICONS[key];
    const playCells = meta.dualPlay
      ? `<a class="training-cell" href="/${key}">Training</a>
         <a class="training-cell comp" href="/${key}/competitive">Competitive</a>
         <a class="training-cell adaptive" href="/${key}/adaptive" title="Competitive rules at your level">Adaptive${adaptiveEloHtml(key)}</a>`
      : `<a class="training-cell comp" href="/${key}">Play</a>`;
    return `
    <div class="training-row">
      <div class="training-row-main">
        <span class="training-row-icon">${icon ? `<img src="${icon}" alt="" width="22" height="22" />` : ''}</span>
        <span class="training-row-title">${escapeHtml(meta.title)}</span>
      </div>
      <div class="training-row-actions">
        ${playCells}
        <button type="button" class="training-cell training-cell-icon" data-lb-mode="${key}" title="${escapeHtml(meta.title)} leaderboard" aria-label="${escapeHtml(meta.title)} leaderboard">
          <img src="${LEADERBOARD_ICON}" alt="" width="15" height="15" />
        </button>
      </div>
    </div>`;
  }

  function renderCats() {
    catsEl.innerHTML = TRAINING_CATEGORIES.map((cat) => {
      const active = cat.id === category ? ' active' : '';
      return `
      <button type="button" class="cat-tile${active}" data-cat="${cat.id}">
        <img src="${categoryIcon(cat.id)}" alt="" width="26" height="26" />
        <span class="cat-tile-title">${cat.title}</span>
      </button>`;
    }).join('');
  }

  function renderList() {
    searchWrap.hidden = category !== 'all';
    const modes = trainingCategoryModes(category).filter(matchesSearch);
    listEl.innerHTML = modes.length
      ? modes.map(rowHtml).join('')
      : '<p class="view-empty">No gamemodes match your search.</p>';
  }

  catsEl.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-cat]');
    if (!tile) return;
    category = tile.dataset.cat;
    query = '';
    if (searchInput) searchInput.value = '';
    renderCats();
    renderList();
  });

  listEl.addEventListener('click', (e) => {
    const lb = e.target.closest('[data-lb-mode]');
    if (!lb) return;
    openLeaderboards(lb.dataset.lbMode);
  });

  searchInput?.addEventListener('input', () => {
    query = searchInput.value;
    renderList();
  });

  renderCats();
  renderList();

  return {
    onShow() {
      renderCats();
      renderList();
    }
  };
}
