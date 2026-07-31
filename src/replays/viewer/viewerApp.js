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
    ? `/demos?round=${encodeURIComponent(round.file)}`
    : '/demos';
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
 * @param {Array<{key?:string,focusTeam:string,focusTeamIds:string[],name:string}>} [opts.teamOptions]
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
  teamOptions = [],
  statsDemoId = '',
  onClose
}) {
  const store = new TickStore();
  if (mode === 'macro') mode = 'analyzer';

  let focusIds = focusTeamIds?.length
    ? [...focusTeamIds]
    : focusTeam
      ? [focusTeam]
      : [];
  // Same map + at least one team shared by every round (team can be picked in Analyzer).
  const canAnalyze = analyzerEligible(rounds, focusIds);

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
          canAnalyze ? '' : 'disabled title="Same map and at least one shared team required"'
        }>Analyzer</button>
      </div>
    </header>
    <div class="rv-body" id="rv-body"></div>`;

  const bodyEl = overlay.querySelector('#rv-body');
  const titleEl = overlay.querySelector('#rv-title-main');

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
      focusTeam: focusIds[0] || focusTeam,
      focusTeamIds: focusIds,
      focusName,
      teamOptions,
      statsDemoId,
      onRound: syncUrl
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

/** Team ids shared by every round (may be 1 or 2 in a typical match). */
export function commonTeamIds(rounds) {
  if (!rounds?.length) return [];
  let common = null;
  for (const r of rounds) {
    const ids = new Set([r.team1, r.team2].filter(Boolean));
    if (!ids.size) continue;
    if (!common) common = ids;
    else common = new Set([...common].filter((id) => ids.has(id)));
  }
  return [...(common || [])];
}

/** @deprecated Prefer commonTeamIds; returns a single id only when unambiguous. */
export function inferFocusTeamIds(rounds) {
  const common = commonTeamIds(rounds);
  return common.length === 1 ? common : [];
}

/**
 * Analyzer is available when every round shares one map and at least one team.
 * Focus team may be chosen later inside Analyzer when multiple teams are shared.
 */
export function analyzerEligible(rounds, focusTeamIds = []) {
  if (!rounds?.length) return false;
  const maps = new Set(rounds.map((r) => r.map).filter(Boolean));
  if (maps.size !== 1) return false;
  const focus = (Array.isArray(focusTeamIds) ? focusTeamIds : focusTeamIds ? [focusTeamIds] : []).filter(
    Boolean
  );
  if (focus.length) {
    return rounds.every((r) => focus.some((id) => r.team1 === id || r.team2 === id));
  }
  return commonTeamIds(rounds).length >= 1;
}
