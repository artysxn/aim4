// ---------------------------------------------------------------------------
// site/trainingView.js
// The trainer's gamemode menu, hosted on the aim4.io site shell. Mirrors the
// in-game Training menu: category tiles, then mode rows with Training /
// Competitive launch buttons and a per-mode leaderboard shortcut. Launching a
// mode navigates to its deep link (/gridshot, /gridshot/competitive) where the
// trainer boots straight into the run.
// ---------------------------------------------------------------------------

import {
  SCENARIO_META,
  TRAINING_CATEGORIES,
  trainingCategoryModes,
  modeCountLabel
} from '../lib/gamemodeCatalog.js';
import {
  SCENARIO_ICONS,
  PRECISION_ICON,
  SNIPING_ICON,
  ALL_MODES_ICON,
  LEADERBOARD_ICON
} from '../aim4/icons.js';

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

  function rowHtml(key) {
    const meta = SCENARIO_META[key] || { title: key, tags: [] };
    const icon = SCENARIO_ICONS[key];
    const playBtns = meta.dualPlay
      ? `<a class="btn btn-sm training-play" href="/${key}">Training</a>
         <a class="btn btn-sm training-play comp" href="/${key}/competitive">Competitive</a>`
      : `<a class="btn btn-sm training-play comp" href="/${key}">Play</a>`;
    const tags = (meta.tags || [])
      .map((t) => `<span class="training-row-tag">${escapeHtml(t)}</span>`)
      .join('');
    return `
    <div class="training-row">
      <div class="training-row-main">
        <span class="training-row-icon">${icon ? `<img src="${icon}" alt="" width="22" height="22" />` : ''}</span>
        <span class="training-row-title">${escapeHtml(meta.title)}</span>
        ${tags ? `<span class="training-row-tags">${tags}</span>` : ''}
      </div>
      <div class="training-row-actions">
        ${playBtns}
        <button type="button" class="training-row-lb" data-lb-mode="${key}" title="${escapeHtml(meta.title)} leaderboard" aria-label="${escapeHtml(meta.title)} leaderboard">
          <img src="${LEADERBOARD_ICON}" alt="" width="15" height="15" />
        </button>
      </div>
    </div>`;
  }

  function renderCats() {
    catsEl.innerHTML = TRAINING_CATEGORIES.map((cat) => {
      const count = trainingCategoryModes(cat.id).length;
      const active = cat.id === category ? ' active' : '';
      return `
      <button type="button" class="cat-tile${active}" data-cat="${cat.id}">
        <img src="${categoryIcon(cat.id)}" alt="" width="26" height="26" />
        <span class="cat-tile-title">${cat.title}</span>
        <span class="cat-tile-sub">${modeCountLabel(count)}</span>
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
