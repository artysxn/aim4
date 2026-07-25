// ---------------------------------------------------------------------------
// replays/viewer/viewerApp.js
// The full-screen viewer. Owns the overlay, the mode switch, and the tick
// store's lifetime.
// ---------------------------------------------------------------------------

import { TickStore, formatBytes } from '../tickStore.js';
import { createTimelineViewer } from './timelineViewer.js';
import { createAnalyzerViewer } from './analyzerViewer.js';
import { MAPS } from '../shared/roundId.js';

/**
 * Point the address bar at the round on screen so it can be copied and sent.
 * replaceState, not pushState: scrubbing through twenty rounds must not bury
 * the page the viewer was opened from under twenty history entries.
 */
function syncUrl(round) {
  const target = round?.file
    ? `/replays?round=${encodeURIComponent(round.file)}`
    : '/replays';
  if (window.location.pathname + window.location.search === target) return;
  try {
    window.history.replaceState(window.history.state, '', target);
  } catch {
    /* a sandboxed frame; the viewer still works, the link just is not shareable */
  }
}

/**
 * @param {object} opts
 * @param {object[]} opts.rounds
 * @param {'timeline'|'analyzer'|'macro'} [opts.mode]
 * @param {string} [opts.title]
 * @param {(s: string) => string} opts.escapeHtml
 * @param {string} [opts.focusTeam] short id for Analyzer
 * @param {() => void} [opts.onClose]
 */
export function openViewer({
  rounds,
  mode = 'timeline',
  title = '',
  escapeHtml,
  focusTeam = '',
  focusName = '',
  onClose
}) {
  const store = new TickStore();
  if (mode === 'macro') mode = 'analyzer';

  const canAnalyze = analyzerEligible(rounds, focusTeam);

  const overlay = document.createElement('div');
  overlay.className = 'rv-overlay';
  overlay.innerHTML = `
    <header class="rv-top">
      <button type="button" class="rv-back" id="rv-back">
        <svg viewBox="0 -960 960 960" width="18" height="18"><path d="M400-80 0-480l400-400 71 71-329 329 329 329-71 71Z"/></svg>
        Library
      </button>
      <div class="rv-title">
        <strong id="rv-title-main"></strong>
        <span id="rv-title-sub"></span>
      </div>
      <div class="rv-modes">
        <button type="button" class="rv-mode" data-mode="timeline">Timeline</button>
        <button type="button" class="rv-mode" data-mode="analyzer" ${
          canAnalyze ? '' : 'disabled title="Same map and one shared team required"'
        }>Analyzer</button>
      </div>
      <span class="rv-mem" id="rv-mem"></span>
    </header>
    <div class="rv-body" id="rv-body"></div>`;

  const bodyEl = overlay.querySelector('#rv-body');
  const memEl = overlay.querySelector('#rv-mem');
  const mapCodes = [...new Set(rounds.map((r) => r.map))];
  overlay.querySelector('#rv-title-main').textContent = title || 'Selection';
  overlay.querySelector('#rv-title-sub').textContent = `${rounds.length} round${
    rounds.length === 1 ? '' : 's'
  } · ${mapCodes.map((c) => MAPS[c]?.name || c).join(', ')}`;

  let current = null;
  let activeMode = null;

  function setMode(next) {
    if (next === 'macro') next = 'analyzer';
    if (next === 'analyzer' && !canAnalyze) return;
    if (next === activeMode) return;
    activeMode = next;
    current?.destroy();
    bodyEl.innerHTML = '';
    const factory = next === 'analyzer' ? createAnalyzerViewer : createTimelineViewer;
    current = factory({
      store,
      rounds,
      escapeHtml,
      focusTeam,
      focusName,
      onRound: syncUrl
    });
    if (next === 'analyzer') syncUrl(null);
    bodyEl.appendChild(current.el);
    overlay.querySelectorAll('.rv-mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === next);
    });
  }

  overlay.querySelector('.rv-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn && !btn.disabled) setMode(btn.dataset.mode);
  });

  const offStore = store.onChange(() => {
    memEl.textContent = formatBytes(store.bytes);
  });

  function close() {
    offStore();
    current?.destroy();
    store.clear();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.classList.remove('rv-open');
    syncUrl(null);
    onClose?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  overlay.querySelector('#rv-back').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  document.body.classList.add('rv-open');
  setMode(mode === 'analyzer' && !canAnalyze ? 'timeline' : mode);

  return { close };
}

/** Same map + at least one team shared by every round (optionally pinned). */
export function analyzerEligible(rounds, focusTeam = '') {
  if (!rounds?.length) return false;
  const maps = new Set(rounds.map((r) => r.map).filter(Boolean));
  if (maps.size !== 1) return false;
  let common = null;
  for (const r of rounds) {
    const ids = new Set([r.team1, r.team2].filter(Boolean));
    if (!common) common = ids;
    else common = new Set([...common].filter((id) => ids.has(id)));
  }
  if (!common?.size) return false;
  if (focusTeam) return common.has(focusTeam);
  return common.size >= 1;
}
