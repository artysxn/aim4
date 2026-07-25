// ---------------------------------------------------------------------------
// replays/viewer/viewerApp.js
// The full-screen viewer. Owns the overlay, the mode switch, and the tick
// store's lifetime.
// ---------------------------------------------------------------------------

import { TickStore } from '../tickStore.js';
import { createTimelineViewer } from './timelineViewer.js';
import { createAnalyzerViewer } from './analyzerViewer.js';

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
  focusTeamIds = [],
  focusName = '',
  onClose
}) {
  const store = new TickStore();
  if (mode === 'macro') mode = 'analyzer';

  /** Full set opened from the library (Analyzer always uses this). */
  const allRounds = rounds;
  /** Rounds currently loaded in Timeline (may shrink via Analyzer "Replay all"). */
  let timelineRounds = rounds;

  let focusIds = focusTeamIds?.length
    ? [...focusTeamIds]
    : focusTeam
      ? [focusTeam]
      : inferFocusTeamIds(allRounds);
  const canAnalyze = analyzerEligible(allRounds, focusIds);

  const overlay = document.createElement('div');
  overlay.className = 'rv-overlay';
  overlay.innerHTML = `
    <header class="rv-top">
      <button type="button" class="rv-back" id="rv-back">
        <svg viewBox="0 -960 960 960" width="18" height="18"><path d="M400-80 0-480l400-400 71 71-329 329 329 329-71 71Z"/></svg>
        Back
      </button>
      <div class="rv-title">
        <strong id="rv-title-main">Analyzer</strong>
      </div>
      <div class="rv-modes">
        <button type="button" class="rv-mode" data-mode="timeline">Timeline</button>
        <button type="button" class="rv-mode" data-mode="analyzer" ${
          canAnalyze ? '' : 'disabled title="Same map and one shared team required"'
        }>Analyzer</button>
      </div>
    </header>
    <div class="rv-body" id="rv-body"></div>`;

  const bodyEl = overlay.querySelector('#rv-body');
  const titleEl = overlay.querySelector('#rv-title-main');

  let current = null;
  let activeMode = null;

  function setMode(next, { force = false } = {}) {
    if (next === 'macro') next = 'analyzer';
    if (next === 'analyzer' && !canAnalyze) return;
    if (!force && next === activeMode) return;
    activeMode = next;
    current?.destroy();
    bodyEl.innerHTML = '';
    const list = next === 'analyzer' ? allRounds : timelineRounds;
    const factory = next === 'analyzer' ? createAnalyzerViewer : createTimelineViewer;
    current = factory({
      store,
      rounds: list,
      escapeHtml,
      focusTeam: focusIds[0] || focusTeam,
      focusTeamIds: focusIds,
      focusName,
      onRound: syncUrl,
      onLoadTimeline: (subset) => {
        if (!subset?.length) return;
        timelineRounds = subset;
        setMode('timeline', { force: true });
      }
    });
    if (next === 'analyzer') syncUrl(null);
    bodyEl.appendChild(current.el);
    titleEl.textContent = next === 'analyzer' ? 'Analyzer' : 'Timeline';
    overlay.querySelectorAll('.rv-mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === next);
    });
  }

  overlay.querySelector('.rv-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn && !btn.disabled) setMode(btn.dataset.mode);
  });

  function close() {
    current?.destroy();
    store.clear();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.classList.remove('rv-open');
    syncUrl(null);
    onClose?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (current?.handleEscape?.()) return;
      close();
    }
  }

  overlay.querySelector('#rv-back').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  document.body.classList.add('rv-open');
  setMode(mode === 'analyzer' && !canAnalyze ? 'timeline' : mode);

  return { close };
}

/** Team ids shared by every round. Empty when the set is ambiguous (both sides). */
export function inferFocusTeamIds(rounds) {
  if (!rounds?.length) return [];
  let common = null;
  for (const r of rounds) {
    const ids = new Set([r.team1, r.team2].filter(Boolean));
    if (!ids.size) continue;
    if (!common) common = ids;
    else common = new Set([...common].filter((id) => ids.has(id)));
  }
  if (!common?.size) return [];
  // A match always shares both teams — only treat a single leftover id as focus.
  if (common.size === 1) return [...common];
  return [];
}

/** Same map + a focus team present in every round. */
export function analyzerEligible(rounds, focusTeamIds = []) {
  if (!rounds?.length) return false;
  const maps = new Set(rounds.map((r) => r.map).filter(Boolean));
  if (maps.size !== 1) return false;
  const focus = (Array.isArray(focusTeamIds) ? focusTeamIds : focusTeamIds ? [focusTeamIds] : []).filter(
    Boolean
  );
  const ids = focus.length ? focus : inferFocusTeamIds(rounds);
  if (!ids.length) return false;
  return rounds.every((r) => ids.some((id) => r.team1 === id || r.team2 === id));
}
