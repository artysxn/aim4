// ---------------------------------------------------------------------------
// src/cs3d/pauseMenu.js
// Esc on a practice map: pause overlay with Resume, Settings, and a way back
// to Map Practice. Settings write the same store the trainer uses.
// ---------------------------------------------------------------------------

import { RESOLUTIONS, clampResolutionDim } from '../core/SettingsManager.js';
import { SENSITIVITY_DEFAULT } from '../utils/MathUtils.js';

export const PAUSE_MENUS_HREF = '/map-practice';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function resolutionSelectHtml() {
  const presets = Object.entries(RESOLUTIONS)
    .map(([key, spec]) => `<option value="${esc(key)}">${esc(spec.label)}</option>`)
    .join('');
  return `${presets}<option value="custom">Custom</option>`;
}

function row(id, label, min, max, step) {
  return `<label class="c3-pause-row"><span>${esc(label)}</span>` +
    `<input type="range" data-set="${id}" min="${min}" max="${max}" step="${step}">` +
    `<b data-out="${id}"></b></label>`;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.root
 * @param {import('../core/SettingsManager.js').SettingsManager} o.settings
 * @param {import('../components/Crosshair.js').Crosshair} [o.crosshair]
 * @param {(open: boolean) => void} [o.onToggle]
 * @param {() => void} [o.onResume]
 * @param {() => void} [o.onLookSync]
 */
export function createPauseMenu({
  root,
  settings,
  crosshair,
  onToggle,
  onResume,
  onLookSync,
  onFlatView,
  onThirdPerson,
  getFlatView,
  getThirdPerson,
  onImportMount
}) {
  const el = document.createElement('div');
  el.className = 'c3-pause';
  el.hidden = true;
  el.innerHTML = `
    <div class="c3-pause-stack">
    <div class="c3-pause-panel" data-view="root">
      <div class="c3-pause-title">Paused</div>
      <div class="c3-pause-actions">
        <button type="button" class="c3-pause-btn is-primary" data-act="resume">Resume</button>
        <button type="button" class="c3-pause-btn" data-act="settings">Settings</button>
        <a class="c3-pause-btn" data-act="menus" href="${PAUSE_MENUS_HREF}">Return to menus</a>
      </div>
    </div>
    <div class="c3-pause-panel c3-pause-settings" data-view="settings" hidden>
      <div class="c3-pause-seg" role="tablist">
        <button type="button" class="is-on" data-tab="game">Game</button>
        <button type="button" data-tab="crosshair">Crosshair</button>
      </div>
      <div class="c3-pause-pane" data-pane="game">
        <label class="c3-pause-row"><span>Sensitivity</span>
          <input type="number" data-set="sensitivity" step="0.001" min="0.001">
        </label>
        <div class="c3-import" data-import></div>
        ${row('hFov', 'Horizontal FOV', 60, 130, 1)}
        <label class="c3-pause-row"><span>Resolution</span>
          <select data-set="resolution">${resolutionSelectHtml()}</select>
        </label>
        <div class="c3-pause-custom" data-custom-res hidden>
          <label class="c3-pause-row"><span>Width</span>
            <input type="number" data-set="resolutionWidth" min="320" max="7680" step="1">
          </label>
          <label class="c3-pause-row"><span>Height</span>
            <input type="number" data-set="resolutionHeight" min="320" max="7680" step="1">
          </label>
        </div>
        <label class="c3-pause-check"><input type="checkbox" data-set="rawInput"> Raw input</label>
      </div>
      <div class="c3-pause-pane" data-pane="crosshair" hidden>
        <div class="c3-pause-xh">
          <canvas id="xh-preview-canvas" width="216" height="216"></canvas>
        </div>
        <label class="c3-pause-row"><span>Color</span>
          <input type="color" data-set="xh.color">
        </label>
        ${row('xh.innerGap', 'Gap', 0, 30, 1)}
        ${row('xh.length', 'Length', 0, 30, 1)}
        ${row('xh.thickness', 'Thickness', 1, 8, 1)}
        ${row('xh.dotPercentage', 'Dot %', 0, 100, 5)}
        ${row('xh.outlineThickness', 'Outline', 0, 4, 0.5)}
        <label class="c3-pause-row"><span>Outline color</span>
          <input type="color" data-set="xh.outlineColor">
        </label>
      </div>
      <button type="button" class="c3-pause-btn" data-act="back">Back</button>
    </div>
    <div class="c3-pause-tools" data-tools>
      <button type="button" class="c3-pause-icon" data-act="flat" aria-label="Flat view" title="Flat view">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 8.5L12 4l8 4.5-8 4.5z"/><path fill="currentColor" opacity=".75" d="M4 13.2l8 4.5 8-4.5M4 17.8l8 4.5 8-4.5"/></svg>
      </button>
      <button type="button" class="c3-pause-icon" data-act="third" aria-label="Third person" title="Third person">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle fill="currentColor" cx="12" cy="7" r="3.2"/><path fill="currentColor" d="M6.2 20.5c.4-3.8 2.6-6 5.8-6s5.4 2.2 5.8 6z"/></svg>
      </button>
    </div>
    </div>
  `;
  root.appendChild(el);
  onImportMount?.(el.querySelector('[data-import]'));

  let open = false;
  let view = 'root';

  const $ = (sel) => el.querySelector(sel);
  const setView = (next) => {
    view = next;
    el.querySelectorAll('[data-view]').forEach((n) => {
      n.hidden = n.dataset.view !== next;
    });
    if (next === 'settings') {
      populate();
      crosshair?.drawPreview();
    }
    const tools = $('[data-tools]');
    if (tools) tools.hidden = next === 'settings';
    syncTools();
  };

  function syncTools() {
    $('[data-act="flat"]')?.classList.toggle('is-on', !!getFlatView?.());
    $('[data-act="third"]')?.classList.toggle('is-on', !!getThirdPerson?.());
  }

  const setTab = (tab) => {
    el.querySelectorAll('[data-tab]').forEach((n) => n.classList.toggle('is-on', n.dataset.tab === tab));
    el.querySelectorAll('[data-pane]').forEach((n) => {
      n.hidden = n.dataset.pane !== tab;
    });
    if (tab === 'crosshair') crosshair?.drawPreview();
  };

  const customRow = () => $('[data-custom-res]');

  function populate() {
    const s = settings.activeSettings();
    const xh = s.crosshair || {};
    const resKey = s.resolution === 'custom' || !RESOLUTIONS[s.resolution] ? (s.resolution === 'custom' ? 'custom' : 'native') : s.resolution;
    $('[data-set="sensitivity"]').value = s.sensitivity;
    $('[data-set="hFov"]').value = s.hFov;
    $('[data-out="hFov"]').textContent = String(s.hFov);
    $('[data-set="resolution"]').value = resKey;
    $('[data-set="resolutionWidth"]').value = s.resolutionWidth ?? RESOLUTIONS[s.resolution]?.size?.[0] ?? 1920;
    $('[data-set="resolutionHeight"]').value = s.resolutionHeight ?? RESOLUTIONS[s.resolution]?.size?.[1] ?? 1080;
    customRow().hidden = resKey !== 'custom';
    $('[data-set="rawInput"]').checked = s.rawInput !== false;
    $('[data-set="xh.color"]').value = xh.color || '#f52525';
    $('[data-set="xh.innerGap"]').value = xh.innerGap;
    $('[data-out="xh.innerGap"]').textContent = String(xh.innerGap);
    $('[data-set="xh.length"]').value = xh.length;
    $('[data-out="xh.length"]').textContent = String(xh.length);
    $('[data-set="xh.thickness"]').value = xh.thickness;
    $('[data-out="xh.thickness"]').textContent = String(xh.thickness);
    $('[data-set="xh.dotPercentage"]').value = xh.dotPercentage;
    $('[data-out="xh.dotPercentage"]').textContent = String(xh.dotPercentage);
    $('[data-set="xh.outlineThickness"]').value = xh.outlineThickness ?? 0;
    $('[data-out="xh.outlineThickness"]').textContent = String(xh.outlineThickness ?? 0);
    $('[data-set="xh.outlineColor"]').value = xh.outlineColor || '#000000';
  }

  function patch(fn) {
    fn(settings.data);
    settings.save();
    onLookSync?.();
    crosshair?.drawPreview();
  }

  function applyField(key, raw) {
    if (key === 'sensitivity') {
      const n = Number(raw);
      patch((d) => {
        d.sensitivity = Number.isFinite(n) && n > 0 ? n : SENSITIVITY_DEFAULT;
      });
      return;
    }
    if (key === 'hFov') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      patch((d) => { d.hFov = n; });
      $('[data-out="hFov"]').textContent = String(n);
      return;
    }
    if (key === 'resolution') {
      patch((d) => {
        if (raw === 'custom') {
          d.resolution = 'custom';
          d.resolutionWidth = clampResolutionDim(d.resolutionWidth, 1920);
          d.resolutionHeight = clampResolutionDim(d.resolutionHeight, 1080);
        } else {
          d.resolution = raw;
          const preset = RESOLUTIONS[raw];
          if (preset?.size) {
            d.resolutionWidth = preset.size[0];
            d.resolutionHeight = preset.size[1];
          }
        }
      });
      customRow().hidden = raw !== 'custom';
      return;
    }
    if (key === 'resolutionWidth' || key === 'resolutionHeight') {
      const n = parseInt(raw, 10);
      patch((d) => {
        d.resolution = 'custom';
        if (key === 'resolutionWidth') d.resolutionWidth = clampResolutionDim(n, 1920);
        else d.resolutionHeight = clampResolutionDim(n, 1080);
      });
      $('[data-set="resolution"]').value = 'custom';
      customRow().hidden = false;
      return;
    }
    if (key === 'rawInput') {
      patch((d) => { d.rawInput = !!raw; });
      return;
    }
    if (key.startsWith('xh.')) {
      const field = key.slice(3);
      patch((d) => {
        if (!d.crosshair) d.crosshair = {};
        if (field === 'color' || field === 'outlineColor') d.crosshair[field] = String(raw);
        else d.crosshair[field] = Number(raw);
      });
      const out = $(`[data-out="${key}"]`);
      if (out) out.textContent = String(raw);
    }
  }

  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const tab = e.target.closest?.('[data-tab]');
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'resume') {
      onResume?.();
      return;
    }
    if (act === 'settings') {
      setView('settings');
      return;
    }
    if (act === 'back') {
      setView('root');
      return;
    }
    if (act === 'flat') {
      onFlatView?.();
      syncTools();
      return;
    }
    if (act === 'third') {
      onThirdPerson?.();
      syncTools();
      return;
    }
  });
  el.addEventListener('input', (e) => {
    const field = e.target.closest?.('[data-set]');
    if (!field) return;
    const key = field.dataset.set;
    if (field.type === 'checkbox') applyField(key, field.checked);
    else applyField(key, field.value);
  });
  el.querySelectorAll('input, select').forEach((n) => {
    n.addEventListener('keydown', (e) => e.stopPropagation());
  });

  const api = {
    el,
    get open() {
      return open;
    },
    get view() {
      return view;
    },
    setOpen(next) {
      next = !!next;
      if (next === open) return;
      open = next;
      if (open) setView('root');
      else view = 'root';
      el.hidden = !open;
      if (open) syncTools();
      onToggle?.(open);
    },
    openMenu() {
      api.setOpen(true);
    },
    close() {
      api.setOpen(false);
    },
    syncTools,
    /** Esc: open if shut, settings back to pause, pause root stays up. */
    handleEsc() {
      if (!open) {
        api.setOpen(true);
        return;
      }
      if (view === 'settings') setView('root');
    }
  };
  return api;
}
