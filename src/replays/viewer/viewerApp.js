// ---------------------------------------------------------------------------
// replays/viewer/viewerApp.js
// The full-screen viewer. Owns the overlay, the mode switch, and the tick
// store's lifetime.
// ---------------------------------------------------------------------------

import { TickStore } from '../tickStore.js';
import { createTimelineViewer } from './timelineViewer.js';
import { createAnalyzerViewer } from './analyzerViewer.js';
import { useMeteredFeature } from '../../lib/meteredFeature.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import backIcon from '../../icons/icon_back.svg?raw';

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
  coachTeamId = '',
  coachForceSide = 0,
  coachAutoEnable = false,
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
      <button type="button" class="rv-back" id="rv-back" aria-label="Back">
        ${backIcon}
      </button>
      <div class="rv-title">
        <strong id="rv-title-main">Viewer</strong>
      </div>
      <div class="rv-modes" hidden>
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
  /** One macro-viewer use per opened viewer, not one per mode toggle. */
  let spentMacro = false;

  /**
   * Analyzer is the macro viewer, which is metered: one session a day on Free.
   * Spent on entry rather than per interaction, so a session is a session and
   * not an allowance that drains while someone uses it.
   */
  async function setMode(next) {
    if (next === 'macro') next = 'analyzer';
    if (next === 'analyzer' && !canAnalyze) return;
    if (next === activeMode) return;
    if (next === 'analyzer' && !spentMacro) {
      if (!(await useMeteredFeature(CAP.DEMOS_MACRO_VIEWER, { host: overlay }))) return;
      spentMacro = true;
    }
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
      coachTeamId,
      coachForceSide,
      coachAutoEnable,
      onRound: syncUrl
    });
    if (next === 'analyzer') syncUrl(null);
    bodyEl.appendChild(current.el);
    titleEl.textContent = next === 'analyzer' ? 'Analyzer' : 'Viewer';
    overlay.querySelectorAll('.rv-mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === next);
    });
  }

  overlay.querySelector('.rv-modes')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn && !btn.disabled) void setMode(btn.dataset.mode);
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
  // Opening straight into Analyzer from a link still spends a use; if it is
  // refused, fall back to the timeline rather than leaving an empty overlay.
  void (async () => {
    const wanted = mode === 'analyzer' && !canAnalyze ? 'timeline' : mode;
    await setMode(wanted);
    if (!activeMode) await setMode('timeline');
  })();

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
