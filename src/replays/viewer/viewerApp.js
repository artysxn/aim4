// ---------------------------------------------------------------------------
// replays/viewer/viewerApp.js
// The full-screen viewer. Owns the overlay, the mode switch, and the tick
// store's lifetime.
//
// The store is the reason this layer exists: rounds loaded in one session
// stay loaded while the viewer is open, and are dropped when it closes or a
// different set of rounds is opened. Switching between timeline and macro on
// the same selection keeps everything already downloaded.
// ---------------------------------------------------------------------------

import { TickStore, formatBytes } from '../tickStore.js';
import { createTimelineViewer } from './timelineViewer.js';
import { createMacroViewer } from './macroViewer.js';
import { MAPS } from '../shared/roundId.js';

export function openViewer({ rounds, mode = 'timeline', title = '', escapeHtml, onClose }) {
  const store = new TickStore();

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
        <button type="button" class="rv-mode" data-mode="macro">Macro</button>
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
    if (next === activeMode) return;
    activeMode = next;
    current?.destroy();
    bodyEl.innerHTML = '';
    const factory = next === 'macro' ? createMacroViewer : createTimelineViewer;
    current = factory({ store, rounds, escapeHtml });
    bodyEl.appendChild(current.el);
    overlay.querySelectorAll('.rv-mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === next);
    });
  }

  overlay.querySelector('.rv-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) setMode(btn.dataset.mode);
  });

  const offStore = store.onChange(() => {
    memEl.textContent = formatBytes(store.bytes);
  });

  function close() {
    offStore();
    current?.destroy();
    // Leaving the viewer is one of the two moments rounds are unloaded.
    store.clear();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.classList.remove('rv-open');
    onClose?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  overlay.querySelector('#rv-back').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  document.body.classList.add('rv-open');
  setMode(mode);

  return { close };
}
