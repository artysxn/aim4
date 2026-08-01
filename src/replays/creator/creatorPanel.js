// ---------------------------------------------------------------------------
// replays/creator/creatorPanel.js
// The 2D Strategy Creator stage: options on the left, the map in the middle,
// what has been recorded on the right.
//
// The middle is a RadarRenderer fed frames built by recordingFormat, which is
// what makes a synthetic round look exactly like a parsed one - the droplets,
// smokes, molotovs and flash pops are drawn by the same code that draws real
// demos, not by a lookalike.
//
// A pass works the way a team walks a strat: pick a spawn, hit record, count
// down from three, and everything already recorded plays back around you while
// you drive one body.
// ---------------------------------------------------------------------------

import { RadarRenderer } from '../viewer/radarRenderer.js';
import { RADAR_SIZE, radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';
import { MAPS } from '../shared/roundId.js';
import { fetchSpawns } from '../api.js';
import { fetchZones } from '../zones/zoneApi.js';
import { bakeLayerMask } from '../zones/visionLayers.js';
import { createCreatorEngine, COUNTDOWN_SECONDS } from './creatorEngine.js';
import { createFrameLoop } from './frameLoop.js';
import {
  BIND_ROWS,
  DEFAULT_BINDS,
  formatBindCode,
  loadBinds,
  saveBinds
} from './creatorBinds.js';
import {
  NADE_SLOTS,
  ROUND_SECONDS,
  decodeRound,
  durationMs,
  emptyRound,
  encodeRound,
  frameFor,
  makeNade,
  roundSummary,
  trackEndMs
} from './recordingFormat.js';
import backIcon from '../../icons/icon_back.svg?raw';

/** Maps that have a radar image to draw on. */
const CREATOR_MAPS = Object.entries(MAPS).map(([code, m]) => ({ code, name: m.name }));

/** Pre-thrown utility picker order (matches the stratbook utility bar). */
const PLACE_NADE_SLOTS = [
  { type: 'smokegrenade', label: 'Smoke', icon: '/icons/equipment/smokegrenade.svg' },
  { type: 'molotov', label: 'Molotov', icon: '/icons/equipment/molotov.svg' },
  { type: 'flashbang', label: 'Flash', icon: '/icons/equipment/flashbang.svg' },
  { type: 'hegrenade', label: 'HE', icon: '/icons/equipment/hegrenade.svg' }
];

const SIDE_FILL = {
  T: 'rgba(240, 196, 78, 0.28)',
  CT: 'rgba(96, 165, 250, 0.28)'
};
const SIDE_LINE = { T: '#f0c44e', CT: '#60a5fa' };

const fmtClock = (ms) => {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(
    Math.floor((s % 1) * 10)
  )}`;
};

/**
 * @param {{
 *   escapeHtml: (s: string) => string,
 *   strategies?: Array<object>,
 *   readOnly?: boolean,
 *   onSave?: (payload: {round: object, name: string}) => Promise<object>,
 *   onClose?: () => void
 * }} deps
 */
export function createCreatorPanel({
  escapeHtml,
  strategies = [],
  readOnly = false,
  onSave = null,
  onClose = null
}) {
  const el = document.createElement('div');
  el.className = 'sc-shell';
  el.innerHTML = `
    <aside class="sc-side sc-left" id="sc-left"></aside>
    <div class="sc-stage" id="sc-stage">
      <div class="sc-stage-head" id="sc-head"></div>
      <div class="sc-canvas-wrap" id="sc-canvas-wrap">
        <canvas class="sc-canvas" id="sc-canvas"></canvas>
        <div class="sc-overlay" id="sc-overlay"></div>
      </div>
      <div class="sc-transport" id="sc-transport"></div>
    </div>
    <aside class="sc-side sc-right" id="sc-right"></aside>`;

  const leftEl = el.querySelector('#sc-left');
  const rightEl = el.querySelector('#sc-right');
  const headEl = el.querySelector('#sc-head');
  const wrapEl = el.querySelector('#sc-canvas-wrap');
  const canvas = el.querySelector('#sc-canvas');
  const overlayEl = el.querySelector('#sc-overlay');
  const transportEl = el.querySelector('#sc-transport');

  const renderer = new RadarRenderer(canvas);
  let round = emptyRound({ map: '', side: 'T', name: 'New strategy round' });
  let entry = null;

  /** Real spawn points for the current map. */
  let spawns = [];
  let spawnsLoading = false;
  /** Spawn ids the author has moved, so a reload does not undo their layout. */
  let customSpawns = new Map();

  /** (x, y) -> inside a painted vision block. */
  let blockedAt = null;
  /** Bumps on every map load so a stale zones fetch cannot wipe a newer map. */
  let mapLoadGen = 0;

  let hoverSpawn = null;
  let selectedTrack = '';
  let statusText = '';
  let statusBad = false;
  let saving = false;
  let dirty = false;

  /** 'build' | 'start' - the left panel's mode. */
  let leftMode = 'build';
  /** When placing pre-thrown utility, the type being placed. */
  let placingNade = '';
  /** Dragging a spawn in start-position mode. */
  let dragSpawn = null;

  let playT = 0;
  let playing = false;
  let lastPlayAt = 0;

  let binds = loadBinds();
  let settingsOpen = false;
  /** @type {string} action id waiting for a key press, or '' */
  let rebinding = '';

  const engine = createCreatorEngine({
    blockedAt: (x, y) => Boolean(blockedAt && blockedAt(x, y)),
    binds,
    onFrame: (state) => drawFrame(state),
    onFinish: (track) => {
      round.tracks.push(track);
      dirty = true;
      selectedTrack = track.id;
      renderRight();
      renderTransport();
    }
  });

  // ---- helpers ------------------------------------------------------------

  function hudHint() {
    const m = `${formatBindCode(binds.moveUp)}${formatBindCode(binds.moveLeft)}${formatBindCode(
      binds.moveDown
    )}${formatBindCode(binds.moveRight)}`;
    const util = [binds.util1, binds.util2, binds.util3, binds.util4]
      .map(formatBindCode)
      .join('');
    return `${m} move · mouse aim · ${util} utility · ${formatBindCode(
      binds.fire
    )} fire · ${formatBindCode(binds.noclip)} through walls · Enter to stop`;
  }

  function setStatus(text, bad = false) {
    statusText = text || '';
    statusBad = Boolean(bad);
    const node = el.querySelector('#sc-status');
    if (node) {
      node.textContent = statusText;
      node.classList.toggle('bad', statusBad);
    }
  }

  const liveSpawns = () =>
    spawns.map((s) => {
      const moved = customSpawns.get(s.id);
      return moved ? { ...s, x: moved.x, y: moved.y } : s;
    });

  /** A spawn already used by a recorded body is taken. */
  const takenSpawns = () => new Set(round.tracks.map((t) => t.spawnId).filter(Boolean));

  /**
   * Pointer -> world units, or null when the canvas has no layout box yet.
   *
   * radarFromClient answers (0, 0) for a zero-sized canvas, which is a real
   * point on the map: the top-left corner. A click that arrives mid-relayout
   * would otherwise drop a grenade there, so it is refused instead.
   */
  function worldFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const px = renderer.radarFromClient(e.clientX, e.clientY, {});
    if (!Number.isFinite(px.x) || !Number.isFinite(px.y)) return null;
    return radarToWorld(renderer.mapCode, px.x, px.y, {});
  }

  /**
   * Hit test in screen space rather than world units: a spawn disc is drawn at
   * a fixed pixel size, so a fixed world radius is a different target on every
   * map (7.6 units per pixel on Ancient, 4.4 on Dust2) and never quite matches
   * the circle the cursor is over.
   *
   * @param {{x: number, y: number, scale: number}} radar  from radarFromClient
   */
  function spawnAtRadar(radar) {
    // Circles are drawn at r = 11 CSS px; a couple of pixels of slack makes
    // them feel like buttons rather than pinpoints.
    const grabPx = 14;
    const limit = radar.scale > 0 ? grabPx / radar.scale : 20;
    const pt = {};
    let best = null;
    let bestD = limit * limit;
    for (const s of liveSpawns()) {
      worldToRadar(renderer.mapCode, s.x, s.y, pt);
      const d = (pt.x - radar.x) ** 2 + (pt.y - radar.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  // ---- map + data ---------------------------------------------------------

  async function loadMap(code) {
    const gen = ++mapLoadGen;
    round.map = code;
    spawns = [];
    customSpawns = new Map();
    blockedAt = null;
    hoverSpawn = null;
    renderLeft();
    renderHead();
    if (!code) {
      drawFrame(engine.state());
      return;
    }

    spawnsLoading = true;
    renderRight();
    await renderer.setMap(code);
    if (gen !== mapLoadGen) return;

    // Watch-only shares do not record, so walls and live spawn sampling are
    // unused — skip them so a guest link is not blocked on zones/spawns.
    if (readOnly) {
      spawnsLoading = false;
      renderRight();
      drawFrame(engine.state());
      return;
    }

    // Painted vision blocks double as the map's walls for a 2D body.
    // Cache (and the other Active Duty maps) have thousands of brush pieces on
    // the API — an empty list usually means the request failed or returned a
    // fallback shell, not that the map was never painted.
    try {
      const network = await fetchZones(code);
      if (gen !== mapLoadGen) return;
      const pieces = network?.visionBlocks || [];
      if (pieces.length) {
        const baked = bakeLayerMask(code, pieces);
        if (gen !== mapLoadGen) return;
        blockedAt = baked.testWorld;
      } else {
        blockedAt = null;
      }
    } catch {
      if (gen !== mapLoadGen) return;
      blockedAt = null;
    }

    try {
      spawns = await fetchSpawns(code);
      if (gen !== mapLoadGen) return;
      if (!spawns.length) {
        setStatus('No parsed demos on this map yet, so there are no spawns to record from.', true);
      }
    } catch (err) {
      if (gen !== mapLoadGen) return;
      setStatus(err.message || 'Could not read spawns.', true);
    }
    spawnsLoading = false;
    renderRight();
    drawFrame(engine.state());
  }

  // ---- drawing ------------------------------------------------------------

  function drawFrame(state) {
    if (!renderer.mapCode) {
      const { w, h } = renderer.resize();
      const ctx = renderer.ctx;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0b0b0d';
      ctx.fillRect(0, 0, w, h);
      renderOverlay(state);
      return;
    }

    const recording = state.mode === 'recording' || state.mode === 'countdown';
    const t = recording ? Math.max(0, state.clock) : playT;

    // The body under the mouse is appended as an eleventh track so the renderer
    // draws it with the same droplet as everything else.
    const live = recording
      ? {
          id: '__live__',
          side: round.side,
          name: 'Recording',
          nades: state.track?.nades || [],
          shots: state.track?.shots || [],
          samples: [],
          t0: 0,
          liveX: state.pos.x,
          liveY: state.pos.y,
          liveYaw: state.yaw
        }
      : null;

    const frame = frameFor(round, t, {
      live,
      highlight: recording ? '__live__' : selectedTrack,
      extra: { mapAlpha: 0.92 }
    });
    renderer.render(frame);
    drawSpawnOverlay(state);
    renderOverlay(state);
  }

  /** Spawn discs, the facing line, and anything being placed. */
  function drawSpawnOverlay(state) {
    const ctx = renderer.ctx;
    const { w, h } = renderer.resize();
    const t = renderer.viewTransform(w, h);
    const dpr = renderer.dpr;
    const recording = state.mode === 'recording' || state.mode === 'countdown';
    const taken = takenSpawns();
    const pt = {};

    if (!recording) {
      for (const s of liveSpawns()) {
        // Always draw T and CT spawns. Round side only tags the strategy, it
        // does not hide the other team's spawn discs.
        worldToRadar(renderer.mapCode, s.x, s.y, pt);
        const x = pt.x * t.scale + t.ox;
        const y = pt.y * t.scale + t.oy;
        const r = 11 * dpr;
        const isHover = hoverSpawn?.id === s.id;
        const used = taken.has(s.id);

        ctx.save();
        ctx.globalAlpha = used ? 0.35 : 1;
        ctx.beginPath();
        ctx.arc(x, y, r * (isHover ? 1.25 : 1), 0, Math.PI * 2);
        ctx.fillStyle = SIDE_FILL[s.side] || SIDE_FILL.T;
        ctx.fill();
        ctx.lineWidth = (isHover ? 2.4 : 1.4) * dpr;
        ctx.strokeStyle = SIDE_LINE[s.side] || SIDE_LINE.T;
        ctx.stroke();
        if (used) {
          // A spawn that already has a body recorded on it gets a tick.
          ctx.beginPath();
          ctx.moveTo(x - r * 0.45, y);
          ctx.lineTo(x - r * 0.1, y + r * 0.4);
          ctx.lineTo(x + r * 0.5, y - r * 0.4);
          ctx.lineWidth = 2 * dpr;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    if (recording) {
      // The view line: where this body is looking, drawn from the droplet.
      worldToRadar(renderer.mapCode, state.pos.x, state.pos.y, pt);
      const x = pt.x * t.scale + t.ox;
      const y = pt.y * t.scale + t.oy;
      const rad = (-state.yaw * Math.PI) / 180;
      const len = 46 * dpr;
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = state.equipped ? '#7dff6a' : '#ffffff';
      ctx.lineWidth = 1.6 * dpr;
      ctx.setLineDash(state.equipped ? [4 * dpr, 3 * dpr] : []);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(rad) * len, y + Math.sin(rad) * len);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- overlay (countdown, hover action, HUD) -----------------------------

  function renderOverlay(state) {
    const recording = state.mode === 'recording';
    const counting = state.mode === 'countdown';
    const parts = [];

    if (counting) {
      parts.push(
        `<div class="sc-countdown"><span>${state.countdown || COUNTDOWN_SECONDS}</span></div>`
      );
    }

    if (recording || counting) {
      const held = NADE_SLOTS.find((s) => s.type === state.equipped);
      parts.push(`
        <div class="sc-hud">
          <span class="sc-hud-clock">${escapeHtml(fmtClock(Math.max(0, state.clock)))}</span>
          <span class="sc-hud-item${held ? ' on' : ''}">${escapeHtml(held ? held.label : 'Gun')}</span>
          ${state.noclip ? '<span class="sc-hud-item warn">Noclip</span>' : ''}
          <span class="sc-hud-hint">${escapeHtml(hudHint())}</span>
        </div>`);
    } else if (hoverSpawn && !readOnly) {
      const used = takenSpawns().has(hoverSpawn.id);
      parts.push(`
        <div class="sc-spawn-tip" style="left:${hoverSpawn.screenX}px; top:${hoverSpawn.screenY}px">
          <span class="sc-spawn-side ${hoverSpawn.side}">${hoverSpawn.side}</span>
          <button type="button" class="btn btn-sm primary" data-record="${escapeHtml(hoverSpawn.id)}">
            ${used ? 'Record again' : 'Record'}
          </button>
        </div>`);
    }

    overlayEl.innerHTML = parts.join('');
  }

  // ---- panels -------------------------------------------------------------

  function renderLeft() {
    const mapOptions = CREATOR_MAPS.map(
      (m) =>
        `<option value="${m.code}"${m.code === round.map ? ' selected' : ''}>${escapeHtml(
          m.name
        )}</option>`
    ).join('');

    const stratOptions = strategies
      .filter((s) => !round.map || s.map === round.map)
      .filter((s) => !round.side || s.side === round.side)
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}"${s.id === round.strategyId ? ' selected' : ''}>${escapeHtml(
            s.name || 'Untitled strategy'
          )}</option>`
      )
      .join('');

    const startPanel =
      leftMode !== 'start'
        ? ''
        : `
      <div class="sc-block sc-start-block">
        <span class="sc-label">Round start</span>
        <label class="sc-mini">Begins at
          <input class="site-input" type="number" min="0" max="${ROUND_SECONDS}" step="1"
            value="${Math.round(round.startSeconds)}" data-start-seconds /> s
        </label>
        <button type="button" class="btn btn-sm" data-reset-spawns>Reset spawn positions</button>

        <span class="sc-label">Utility</span>
        <div class="sc-util-seg" role="group" aria-label="Pre-thrown utility">
          ${PLACE_NADE_SLOTS.map(
            (s) =>
              `<button type="button" class="sc-util-btn${
                placingNade === s.type ? ' active' : ''
              }" data-place-nade="${s.type}" aria-label="${escapeHtml(s.label)}" title="${escapeHtml(
                s.label
              )}">
                <img src="${s.icon}" alt="" width="18" height="22" draggable="false" />
              </button>`
          ).join('')}
        </div>
        ${
          placingNade
            ? `<p class="sc-note">Click the map to land it there before the round starts.</p>`
            : ''
        }
        ${
          round.preNades.length
            ? `<button type="button" class="btn btn-sm danger" data-clear-prenades>Clear ${
                round.preNades.length
              } placed</button>`
            : ''
        }
      </div>`;

    leftEl.innerHTML = `
      <div class="sc-block">
        <span class="sc-label">Name</span>
        <input class="site-input" id="sc-name" type="text" maxlength="120"
          value="${escapeHtml(round.name || '')}" ${readOnly ? 'readonly' : ''} />
      </div>

      <div class="sc-block">
        <span class="sc-label">Map</span>
        <select class="site-select" data-map ${readOnly ? 'disabled' : ''}>
          <option value="">Pick a map</option>${mapOptions}
        </select>
      </div>

      <div class="sc-block">
        <span class="sc-label">Side</span>
        <div class="rp-seg rp-seg-side" role="group" aria-label="Side">
          <button type="button" class="rp-seg-btn${
            round.side === 'T' ? ' active' : ''
          }" data-side="T" aria-label="T" title="T" ${readOnly ? 'disabled' : ''}>
            <img src="/icons/icon_t.png" alt="" width="18" height="18" draggable="false" />
          </button>
          <button type="button" class="rp-seg-btn${
            round.side === 'CT' ? ' active' : ''
          }" data-side="CT" aria-label="CT" title="CT" ${readOnly ? 'disabled' : ''}>
            <img src="/icons/icon_ct.png" alt="" width="18" height="18" draggable="false" />
          </button>
        </div>
      </div>

      <div class="sc-block">
        <span class="sc-label">Stratbook entry</span>
        <select class="site-select" data-strategy ${readOnly ? 'disabled' : ''}>
          <option value="">Not linked</option>${stratOptions}
        </select>
      </div>

      <div class="sc-block">
        <button type="button" class="btn btn-sm${leftMode === 'start' ? ' primary' : ''}" data-toggle-start>
          ${leftMode === 'start' ? 'Done with starting positions' : 'Set custom starting position'}
        </button>
      </div>
      ${startPanel}

      ${
        readOnly
          ? ''
          : `<div class="sc-block sc-save-block">
              <button type="button" class="btn primary" data-save ${saving ? 'disabled' : ''}>
                ${saving ? 'Saving…' : 'Save round'}
              </button>
              <p class="sc-status${statusBad ? ' bad' : ''}" id="sc-status">${escapeHtml(statusText)}</p>
            </div>`
      }`;
  }

  function renderRight() {
    const summary = roundSummary(round);
    const tracks = round.tracks;

    rightEl.innerHTML = `
      <div class="sc-block">
        <span class="sc-label">Recordings <span class="sc-count">${tracks.length}</span></span>
        ${
          tracks.length
            ? `<ul class="sc-track-list">${tracks
                .map(
                  (t, i) => `
              <li class="sc-track${selectedTrack === t.id ? ' active' : ''}" data-track="${escapeHtml(t.id)}">
                <span class="sc-track-dot ${t.side}"></span>
                <span class="sc-track-name">${escapeHtml(t.name || `Body ${i + 1}`)}</span>
                <span class="sc-track-meta">${fmtClock(trackEndMs(t))}</span>
                <span class="sc-track-meta">${(t.nades || []).length}u</span>
                ${
                  readOnly
                    ? ''
                    : `<button type="button" class="rp-btn-icon danger" data-drop-track="${escapeHtml(
                        t.id
                      )}" title="Delete recording">×</button>`
                }
              </li>`
                )
                .join('')}</ul>`
            : `<p class="sc-note">${
                spawnsLoading
                  ? 'Reading spawns from your demos…'
                  : round.map
                    ? 'Click a spawn on the map to record.'
                    : 'Pick a map to begin.'
              }</p>`
        }
      </div>

      <div class="sc-block">
        <span class="sc-label">Utility <span class="sc-count">${summary.nadeTotal}</span></span>
        <ul class="sc-nade-list">
          ${NADE_SLOTS.map(
            (s) => `
            <li class="sc-nade ${s.type}">
              <span class="sc-nade-name">${escapeHtml(s.label)}</span>
              <span class="sc-nade-count">${summary.nades[s.type] || 0}</span>
            </li>`
          ).join('')}
        </ul>
        ${
          round.preNades.length
            ? `<p class="sc-note">${round.preNades.length} placed before the round starts.</p>`
            : ''
        }
      </div>

      <div class="sc-block">
        <span class="sc-label">Round</span>
        <ul class="sc-facts">
          <li><span>Name</span><b>${escapeHtml(round.name || 'Untitled')}</b></li>
          <li><span>Map</span><b>${escapeHtml(
            MAPS[round.map]?.name || round.map || '—'
          )}</b></li>
        </ul>
        ${
          entry?.shareId
            ? `<span class="sc-label">Share link</span>
               <div class="sc-share">
                 <input class="site-input" id="sc-share" readonly value="${escapeHtml(shareUrl())}" />
                 <button type="button" class="btn btn-sm" data-copy-share>Copy</button>
               </div>
               <p class="sc-note">Anyone with this link can watch this round.</p>`
            : ''
        }
      </div>`;
  }

  const shareUrl = () =>
    entry?.shareId ? `${window.location.origin}/s2/${entry.shareId}` : '';

  function renderHead() {
    const mapName = MAPS[round.map]?.name || 'No map';
    const bindRows = BIND_ROWS.map((row) => {
      const listening = rebinding === row.id;
      return `
        <div class="sc-bind-row">
          <span class="sc-bind-label">${escapeHtml(row.label)}</span>
          <button type="button" class="sc-bind-key${listening ? ' listening' : ''}"
            data-rebind="${row.id}" ${readOnly ? 'disabled' : ''}>
            ${listening ? 'Press key…' : escapeHtml(formatBindCode(binds[row.id]))}
          </button>
        </div>`;
    }).join('');

    headEl.innerHTML = `
      <div class="sc-head-left">
        <button type="button" class="sc-back" data-close aria-label="Back to rounds" title="Back to rounds">
          ${backIcon}
        </button>
        <h2 class="sc-title">${escapeHtml(round.name || 'Untitled round')}</h2>
        <span class="sc-head-tag ${round.side}">${round.side}</span>
        <span class="sc-head-tag">${escapeHtml(mapName)}</span>
      </div>
      <div class="sc-head-right">
        ${dirty ? '<span class="sc-dirty">Unsaved changes</span>' : ''}
        <div class="sc-settings${settingsOpen ? ' is-open' : ''}">
          <button type="button" class="sc-settings-btn" data-toggle-settings
            aria-label="Controls" title="Controls" ${readOnly ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path fill="currentColor" d="M6.5 2.5a1.5 1.5 0 0 1 3 0v.4a4.5 4.5 0 0 1 1.3.75l.35-.2a1.5 1.5 0 1 1 1.5 2.6l-.35.2c.12.42.2.86.2 1.32s-.08.9-.2 1.32l.35.2a1.5 1.5 0 1 1-1.5 2.6l-.35-.2a4.5 4.5 0 0 1-1.3.75v.4a1.5 1.5 0 1 1-3 0v-.4a4.5 4.5 0 0 1-1.3-.75l-.35.2a1.5 1.5 0 1 1-1.5-2.6l.35-.2A4.6 4.6 0 0 1 3.5 8c0-.46.08-.9.2-1.32l-.35-.2a1.5 1.5 0 1 1 1.5-2.6l.35.2A4.5 4.5 0 0 1 6.5 2.9v-.4ZM8 6.25A1.75 1.75 0 1 0 8 9.75 1.75 1.75 0 0 0 8 6.25Z"/>
            </svg>
          </button>
          <div class="sc-settings-panel" role="dialog" aria-label="Control bindings">
            <div class="sc-settings-head">
              <span class="sc-settings-title">Controls</span>
              <button type="button" class="btn btn-sm" data-reset-binds>Reset</button>
            </div>
            <div class="sc-bind-list">${bindRows}</div>
            <p class="sc-note">Click a bind, then press a key or mouse button.</p>
          </div>
        </div>
      </div>`;
  }

  function renderTransport() {
    const state = engine.state();
    const recording = state.mode === 'recording' || state.mode === 'countdown';
    const total = Math.max(1, durationMs(round));
    transportEl.innerHTML = recording
      ? `<button type="button" class="btn btn-sm danger" data-stop>Stop recording</button>
         <button type="button" class="btn btn-sm" data-cancel>Discard pass</button>`
      : `<button type="button" class="btn btn-sm" data-play>${playing ? 'Pause' : 'Play'}</button>
         <input class="sc-scrub" type="range" min="0" max="${Math.round(total)}" step="10"
           value="${Math.round(Math.min(playT, total))}" data-scrub aria-label="Round time" />
         <span class="sc-time">${fmtClock(playT)} / ${fmtClock(total)}</span>`;
  }

  function renderAll() {
    renderHead();
    renderLeft();
    renderRight();
    renderTransport();
  }

  // ---- playback -----------------------------------------------------------

  const playLoop = createFrameLoop((now) => {
    const dt = Math.min(100, now - (lastPlayAt || now));
    lastPlayAt = now;
    if (!playing) return;
    playT += dt;
    const total = durationMs(round);
    if (playT >= total) {
      playT = total;
      playing = false;
    }
    drawFrame(engine.state());
    renderTransport();
  });

  function ensurePlaybackLoop() {
    lastPlayAt = 0;
    playLoop.start();
  }

  // ---- input --------------------------------------------------------------

  canvas.addEventListener('pointermove', (e) => {
    if (!renderer.mapCode) return;
    const state = engine.state();
    const world = worldFromEvent(e);

    if (state.mode === 'recording' || state.mode === 'countdown') {
      if (world) engine.setCursorWorld(world.x, world.y);
      return;
    }

    // Everything below needs a real point on the map.
    if (!world) return;

    if (dragSpawn) {
      customSpawns.set(dragSpawn.id, { x: Math.round(world.x), y: Math.round(world.y) });
      dirty = true;
      drawFrame(state);
      return;
    }

    const near = spawnAtRadar(renderer.radarFromClient(e.clientX, e.clientY, {}));
    const changed = near?.id !== hoverSpawn?.id;
    if (near) {
      // The tip is a DOM node over the canvas, so its position is in CSS pixels.
      const px = worldToRadar(renderer.mapCode, near.x, near.y, {});
      const { w, h } = renderer.resize();
      const t = renderer.viewTransform(w, h);
      hoverSpawn = {
        ...near,
        screenX: (px.x * t.scale + t.ox) / renderer.dpr,
        screenY: (px.y * t.scale + t.oy) / renderer.dpr - 14
      };
    } else {
      hoverSpawn = null;
    }
    if (changed || near) drawFrame(state);
  });

  canvas.addEventListener('pointerleave', (e) => {
    // Leaving the canvas for the Record tip must keep the tip open.
    if (e.relatedTarget?.closest?.('.sc-spawn-tip')) return;
    if (hoverSpawn) {
      hoverSpawn = null;
      drawFrame(engine.state());
    }
  });

  overlayEl.addEventListener('pointerleave', (e) => {
    if (!hoverSpawn) return;
    if (e.relatedTarget === canvas || canvas.contains(e.relatedTarget)) return;
    if (e.relatedTarget?.closest?.('.sc-spawn-tip')) return;
    hoverSpawn = null;
    drawFrame(engine.state());
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!renderer.mapCode) return;
    const state = engine.state();

    if (state.mode === 'recording') {
      e.preventDefault();
      if (`Mouse${e.button}` !== binds.fire) return;
      const result = engine.fire();
      if (result) {
        dirty = true;
        renderRight();
      }
      return;
    }

    if (readOnly) return;

    if (placingNade) {
      const world = worldFromEvent(e);
      if (!world) return;
      // Pre-thrown: it is already on the ground when the round starts.
      round.preNades.push(
        makeNade({ type: placingNade, t: 0, from: { x: world.x, y: world.y }, to: world })
      );
      round.preNades[round.preNades.length - 1].detonateT = 0;
      dirty = true;
      renderLeft();
      renderRight();
      drawFrame(state);
      return;
    }

    if (leftMode === 'start') {
      const near = spawnAtRadar(renderer.radarFromClient(e.clientX, e.clientY, {}));
      if (near) {
        dragSpawn = near;
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    // Click a spawn disc to start recording that body.
    const near = spawnAtRadar(renderer.radarFromClient(e.clientX, e.clientY, {}));
    if (near) {
      e.preventDefault();
      startRecording(near.id);
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (dragSpawn) {
      dragSpawn = null;
      canvas.releasePointerCapture?.(e.pointerId);
      renderRight();
    }
  });

  // Right click during a pass unequips, like dropping the nade back in the bag.
  canvas.addEventListener('contextmenu', (e) => {
    const state = engine.state();
    if (state.mode === 'recording') {
      e.preventDefault();
      if (state.equipped) engine.unequip();
    }
  });

  function isBoundCode(code) {
    return Object.values(binds).includes(code);
  }

  function applyBind(action, code) {
    if (!action || !code) return;
    // One physical input → one action: steal it from whoever had it.
    const next = { ...binds };
    for (const key of Object.keys(next)) {
      if (next[key] === code) next[key] = binds[action];
    }
    next[action] = code;
    binds = saveBinds(next);
    engine.setBinds(binds);
    rebinding = '';
    renderHead();
  }

  function onKeyDown(e) {
    if (rebinding) {
      if (e.code === 'Escape') {
        e.preventDefault();
        rebinding = '';
        renderHead();
        return;
      }
      // Leave Enter for finishing a pass; do not steal Escape-only cancel.
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      applyBind(rebinding, e.code);
      return;
    }

    const state = engine.state();
    if (state.mode !== 'recording' && state.mode !== 'countdown') return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      stopRecording();
      return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      engine.cancel();
      renderAll();
      drawFrame(engine.state());
      return;
    }
    if (!isBoundCode(e.code)) return;
    e.preventDefault();
    if (e.code === binds.fire && !String(binds.fire).startsWith('Mouse')) {
      const result = engine.fire();
      if (result) {
        dirty = true;
        renderRight();
      }
      return;
    }
    engine.keyDown(e.code);
  }

  function onKeyUp(e) {
    if (rebinding) return;
    engine.keyUp(e.code);
  }

  function onRebindPointer(e) {
    if (!rebinding) return;
    e.preventDefault();
    e.stopPropagation();
    applyBind(rebinding, `Mouse${e.button}`);
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => engine.releaseKeys());
  window.addEventListener('mousedown', onRebindPointer, true);
  // ---- actions ------------------------------------------------------------

  function startRecording(spawnId) {
    const spawn = liveSpawns().find((s) => s.id === spawnId);
    if (!spawn) return;
    playing = false;
    hoverSpawn = null;
    const n = round.tracks.length + 1;
    engine.record({
      id: `b${Date.now().toString(36)}${n}`,
      side: spawn.side,
      name: `${spawn.side} body ${n}`,
      spawn,
      t0: 0
    });
    renderTransport();
  }

  function stopRecording() {
    engine.finish();
    playT = 0;
    renderAll();
    drawFrame(engine.state());
  }

  el.addEventListener('click', async (e) => {
    const t = e.target;

    // Back to the rounds list — handle before settings dismiss so a re-render
    // of the head cannot eat the click.
    if (t.closest('[data-close]')) {
      onClose?.();
      return;
    }

    if (t.closest('[data-toggle-settings]')) {
      settingsOpen = !settingsOpen;
      rebinding = '';
      renderHead();
      return;
    }
    const rebindBtn = t.closest('[data-rebind]');
    if (rebindBtn && !readOnly) {
      const action = rebindBtn.dataset.rebind;
      rebinding = rebinding === action ? '' : action;
      settingsOpen = true;
      renderHead();
      return;
    }
    if (t.closest('[data-reset-binds]')) {
      binds = saveBinds({ ...DEFAULT_BINDS });
      engine.setBinds(binds);
      rebinding = '';
      renderHead();
      return;
    }
    if (settingsOpen && !t.closest('.sc-settings')) {
      settingsOpen = false;
      rebinding = '';
      renderHead();
      return;
    }

    const rec = t.closest('[data-record]');
    if (rec) {
      startRecording(rec.dataset.record);
      return;
    }
    if (t.closest('[data-stop]')) {
      stopRecording();
      return;
    }
    if (t.closest('[data-cancel]')) {
      engine.cancel();
      renderAll();
      drawFrame(engine.state());
      return;
    }
    if (t.closest('[data-play]')) {
      playing = !playing;
      if (playing && playT >= durationMs(round)) playT = 0;
      ensurePlaybackLoop();
      renderTransport();
      return;
    }
    const side = t.closest('[data-side]');
    if (side && !readOnly) {
      round.side = side.dataset.side === 'CT' ? 'CT' : 'T';
      dirty = true;
      renderLeft();
      renderHead();
      drawFrame(engine.state());
      return;
    }
    if (t.closest('[data-toggle-start]')) {
      leftMode = leftMode === 'start' ? 'build' : 'start';
      placingNade = '';
      renderLeft();
      drawFrame(engine.state());
      return;
    }
    const place = t.closest('[data-place-nade]');
    if (place) {
      placingNade = placingNade === place.dataset.placeNade ? '' : place.dataset.placeNade;
      renderLeft();
      return;
    }
    if (t.closest('[data-clear-prenades]')) {
      round.preNades = [];
      dirty = true;
      renderLeft();
      renderRight();
      drawFrame(engine.state());
      return;
    }
    if (t.closest('[data-reset-spawns]')) {
      customSpawns = new Map();
      dirty = true;
      drawFrame(engine.state());
      return;
    }
    const drop = t.closest('[data-drop-track]');
    if (drop) {
      round.tracks = round.tracks.filter((x) => x.id !== drop.dataset.dropTrack);
      dirty = true;
      renderRight();
      renderTransport();
      drawFrame(engine.state());
      return;
    }
    const pick = t.closest('[data-track]');
    if (pick) {
      selectedTrack = selectedTrack === pick.dataset.track ? '' : pick.dataset.track;
      renderRight();
      drawFrame(engine.state());
      return;
    }
    if (t.closest('[data-copy-share]')) {
      const field = el.querySelector('#sc-share');
      if (field) {
        field.select();
        try {
          await navigator.clipboard.writeText(field.value);
          setStatus('Share link copied.');
        } catch {
          setStatus('Copy the link from the field.', true);
        }
      }
      return;
    }
    if (t.closest('[data-save]')) save();
  });

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-map]')) {
      loadMap(t.value);
      dirty = true;
      return;
    }
    if (t.matches('[data-strategy]')) {
      round.strategyId = t.value;
      const strat = strategies.find((s) => s.id === t.value);
      // Linking renames the round after the strategy, which is the point of it.
      if (strat) round.name = strat.name || round.name;
      dirty = true;
      renderLeft();
      renderHead();
      return;
    }
    if (t.matches('[data-start-seconds]')) {
      round.startSeconds = Math.max(0, Math.min(ROUND_SECONDS, Number(t.value) || 0));
      dirty = true;
      return;
    }
    if (t.matches('#sc-name')) {
      round.name = t.value;
      dirty = true;
      renderHead();
    }
  });

  el.addEventListener('input', (e) => {
    const scrub = e.target.closest('[data-scrub]');
    if (!scrub) return;
    playing = false;
    playT = Number(scrub.value) || 0;
    drawFrame(engine.state());
    renderTransport();
  });

  async function save() {
    if (!onSave || saving) return;
    if (!round.map) {
      setStatus('Pick a map first.', true);
      return;
    }
    saving = true;
    renderLeft();
    try {
      const result = await onSave({
        id: entry?.id,
        name: round.name,
        round: encodeRound({ ...round, spawns: liveSpawns() })
      });
      entry = result?.entry || entry;
      dirty = false;
      setStatus('Saved.');
      renderRight();
      renderHead();
    } catch (err) {
      setStatus(err.message || 'Could not save that round.', true);
    } finally {
      saving = false;
      renderLeft();
    }
  }

  const onResize = () => drawFrame(engine.state());
  window.addEventListener('resize', onResize);

  return {
    el,

    /** Open an existing round (or a blank one for a map). */
    async load({ entry: e = null, round: raw = null, map = '', side = 'T' } = {}) {
      entry = e;
      round = raw ? decodeRound(raw) : emptyRound({ map, side, name: 'New strategy round' });
      if (!round.name) round.name = 'New strategy round';
      selectedTrack = '';
      playT = 0;
      playing = false;
      dirty = false;
      renderAll();
      if (round.map) await loadMap(round.map);
      else drawFrame(engine.state());
      // Spawns saved with the round win over the sampled ones: the author moved
      // them on purpose.
      if (round.spawns?.length) {
        spawns = round.spawns.map((s) => ({ ...s, seen: 1 }));
        renderRight();
        drawFrame(engine.state());
      }
    },

    hasUnsavedWork: () => dirty,

    destroy() {
      engine.destroy();
      playLoop.stop();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousedown', onRebindPointer, true);
      window.removeEventListener('resize', onResize);
      el.remove();
    }
  };
}
