// ---------------------------------------------------------------------------
// replays/gif/gifCreator.js
// The GIF creator in the round viewer's side panel.
//
// 2D: drag a rectangle over the radar (or keep the whole map), pick the part
// of the round, and every frame is the viewer's own radar drawn at that tick,
// so zones, POV, duels and drawings come out exactly as they are on screen.
// 3D: pick a player to follow (first or third person) or keep the camera
// where it is, pick the part of the round, and every frame is the 3D scene
// drawn at that tick on the clip's own clock.
//
// The finished GIF downloads straight away and goes to Bookmarks > Saved GIFs
// with what it shows (map, both teams' sides and buys, who won) and the
// title and description given here, ready to share by link.
// ---------------------------------------------------------------------------

import { createRangeSlider } from '../../lib/rangeSlider.js';
import { clockAt, timingFor, totalSeconds } from '../viewer/roundClock.js';
import { DEFAULT_FPS, MAX_FPS, MAX_SECONDS, MIN_FPS, clampFps, frameTicks, outputSize, qualityScale } from './gifCore.js';
import { GIF_DESCRIPTION_MAX, GIF_TITLE_MAX, gifMetaFromRound } from './gifMeta.js';
import { captureGif, downloadBlob, gifFileName, gifShareUrl, saveGifFitting } from './gifCapture.js';

/** Smallest area worth a GIF, in screen pixels. */
const MIN_AREA_PX = 40;

/**
 * @param {object} opts
 * @param {HTMLElement} opts.panel   the dock slot the form lives in
 * @param {HTMLElement} opts.mapEl   the map pane (the area picker sits over it)
 * @param {HTMLCanvasElement} opts.canvas  the radar canvas
 * @param {string} opts.photoIcon    the button icon's markup
 * @param {(s: string) => string} opts.escapeHtml
 * @param {object} opts.viewer  the timeline viewer's side of it:
 *   round(): { file, meta } | null
 *   playheadTick(): number
 *   can3d(): boolean
 *   is3d(): boolean
 *   set3d(on): Promise<boolean>   resolves true once the 3D scene is up
 *   view3d(): object | null
 *   drawAt(tick): void            draws the radar (and feeds the 3D scene) at a tick
 *   beginCapture(): object        pauses playback, returns what endCapture restores
 *   endCapture(state): void
 *   seekLocal(seconds): void      pauses and shows the round at seconds from its start
 *
 * The part of the round and the viewer's timeline move together: dragging an
 * end of the part shows the round there, and moving the round (the timeline,
 * the skip buttons) carries the part along, its length kept, starting where
 * the round now is. The round's position is drawn on the part's track.
 * @param {(gif: object) => void} [opts.onSaved]
 */
export function createGifCreator({ panel, mapEl, canvas, photoIcon = '', escapeHtml, viewer, onSaved }) {
  panel.innerHTML = `
    <p class="rv-playlist-label">Create GIF</p>
    <div class="rv-gif-form">
      <div class="rp-seg rv-gif-kind" role="group" aria-label="View">
        <button type="button" class="rp-seg-btn active" data-gif-kind="2d" aria-pressed="true">2D</button>
        <button type="button" class="rp-seg-btn" data-gif-kind="3d" aria-pressed="false">3D</button>
      </div>
      <div class="rv-gif-row" data-gif-only="2d">
        <button type="button" class="btn btn-sm" data-gif-area>Select area</button>
        <span class="rv-gif-read" data-gif-area-read>Whole map</span>
        <button type="button" class="rv-gif-link" data-gif-area-reset hidden>Reset</button>
      </div>
      <div class="rv-gif-row" data-gif-only="3d" hidden>
        <select class="site-select rv-gif-camera" data-gif-camera aria-label="Camera"></select>
      </div>
      <div class="rv-gif-row" data-gif-only="3d-player" hidden>
        <div class="rp-seg" role="group" aria-label="Camera mode">
          <button type="button" class="rp-seg-btn active" data-gif-cam-mode="pov" aria-pressed="true">First person</button>
          <button type="button" class="rp-seg-btn" data-gif-cam-mode="third" aria-pressed="false">Third person</button>
        </div>
      </div>
      <div class="rv-strat-window">
        <div class="rv-strat-range" data-gif-range></div>
        <div class="rv-strat-range-read" data-gif-range-read></div>
      </div>
      <div class="rv-gif-row">
        <span class="rv-gif-label">Quality</span>
        <div class="rp-seg" role="group" aria-label="Quality">
          <button type="button" class="rp-seg-btn active" data-gif-quality="1" aria-pressed="true">1</button>
          <button type="button" class="rp-seg-btn" data-gif-quality="2" aria-pressed="false">2</button>
          <button type="button" class="rp-seg-btn" data-gif-quality="3" aria-pressed="false">3</button>
        </div>
        <label class="rv-gif-fps"><span>FPS</span>
          <input type="number" class="site-input" data-gif-fps min="${MIN_FPS}" max="${MAX_FPS}" step="1" value="${DEFAULT_FPS['2d']}" />
        </label>
      </div>
      <input type="text" class="site-input" data-gif-title maxlength="${GIF_TITLE_MAX}" placeholder="Title" aria-label="Title" />
      <textarea class="site-input rv-gif-desc" data-gif-desc maxlength="${GIF_DESCRIPTION_MAX}" rows="3" placeholder="Description. <setpos ...> becomes a copy link." aria-label="Description"></textarea>
      <label class="rv-strat-check">
        <input type="checkbox" data-gif-clock checked />
        <span>Round clock</span>
      </label>
      <p class="rv-gif-est" data-gif-est></p>
      <button type="button" class="rv-playlist-strategy rv-gif-go" data-gif-go>${photoIcon}<span>CREATE GIF</span></button>
      <div class="rv-gif-progress" data-gif-progress hidden><span></span></div>
      <span class="rv-popover-msg" data-gif-msg></span>
      <div class="rv-gif-result" data-gif-result hidden>
        <img alt="" data-gif-preview />
        <div class="rv-gif-actions">
          <button type="button" class="btn btn-sm" data-gif-copy hidden>Copy link</button>
          <button type="button" class="btn btn-sm" data-gif-download>Download</button>
          <a class="btn btn-sm" href="/bookmarks?tab=gifs" data-gif-bookmarks hidden>Saved GIFs</a>
        </div>
      </div>
    </div>`;

  const $ = (sel) => panel.querySelector(sel);
  const kindBtns = [...panel.querySelectorAll('[data-gif-kind]')];
  const qualityBtns = [...panel.querySelectorAll('[data-gif-quality]')];
  const camModeBtns = [...panel.querySelectorAll('[data-gif-cam-mode]')];
  const areaBtn = $('[data-gif-area]');
  const areaRead = $('[data-gif-area-read]');
  const areaReset = $('[data-gif-area-reset]');
  const cameraSel = $('[data-gif-camera]');
  const rangeSlot = $('[data-gif-range]');
  const rangeRead = $('[data-gif-range-read]');
  const fpsInput = $('[data-gif-fps]');
  const titleInput = $('[data-gif-title]');
  const descInput = $('[data-gif-desc]');
  const clockInput = $('[data-gif-clock]');
  const estEl = $('[data-gif-est]');
  const goBtn = $('[data-gif-go]');
  const goLabel = goBtn.querySelector('span');
  const progressEl = $('[data-gif-progress]');
  const progressBar = progressEl.querySelector('span');
  const msgEl = $('[data-gif-msg]');
  const resultEl = $('[data-gif-result]');
  const previewImg = $('[data-gif-preview]');
  const copyBtn = $('[data-gif-copy]');
  const downloadBtn = $('[data-gif-download]');
  const bookmarksLink = $('[data-gif-bookmarks]');

  let kind = '2d';
  let quality = 1;
  let camMode = 'pov';
  /** Fractions of the radar canvas; null is the whole map. */
  let area = null;
  let open = false;
  let busy = null;
  let roundKey = '';
  let lastBlob = null;
  let lastName = '';
  let lastUrl = '';
  let savedId = '';
  /** fps the user typed for each view, so flipping 2D/3D keeps both. */
  const fpsFor = { '2d': DEFAULT_FPS['2d'], '3d': DEFAULT_FPS['3d'] };

  /** Rebuilt for each round: a slider's ends are fixed when it is made, and rounds differ in length. */
  let rangeTotal = 1;
  let range = makeRange(1);

  function makeRange(total) {
    rangeTotal = total;
    const r = createRangeSlider({ min: 0, max: total, from: 0, to: total, step: 0.25, label: 'Part of the round', onChange: rangeMoved });
    rangeSlot.replaceChildren(r.el);
    return r;
  }

  /** An end of the part was dragged: the round shows that moment. */
  function rangeMoved(from, to, moved) {
    paintRange();
    if (!busy && open) viewer.seekLocal?.(moved === 'to' ? to : from);
  }

  // ---- the area picker over the radar ---------------------------------------

  const layer = document.createElement('div');
  layer.className = 'rv-gif-area-layer';
  layer.hidden = true;
  const box = document.createElement('div');
  box.className = 'rv-gif-area-box';
  box.hidden = true;
  layer.appendChild(box);
  mapEl.appendChild(layer);
  let picking = false;
  let drag = null;

  /** The canvas's box inside the map pane, where fractions are measured from. */
  function canvasBox() {
    const c = canvas.getBoundingClientRect();
    const m = mapEl.getBoundingClientRect();
    return { left: c.left - m.left, top: c.top - m.top, width: c.width, height: c.height, rect: c };
  }

  function paintBox(frac) {
    if (!frac) {
      box.hidden = true;
      return;
    }
    const c = canvasBox();
    box.hidden = false;
    box.style.left = `${c.left + frac.x * c.width}px`;
    box.style.top = `${c.top + frac.y * c.height}px`;
    box.style.width = `${frac.w * c.width}px`;
    box.style.height = `${frac.h * c.height}px`;
  }

  function syncLayer() {
    layer.hidden = !open || kind !== '2d' || (!picking && !area);
    layer.classList.toggle('is-picking', picking);
    paintBox(picking ? drag?.frac || null : area);
    areaBtn.classList.toggle('active', picking);
    areaBtn.textContent = picking ? 'Drag over the map' : 'Select area';
    const px = areaPixels();
    areaRead.textContent = area ? `${px.sw} x ${px.sh}` : 'Whole map';
    areaReset.hidden = !area;
  }

  function fracAt(e) {
    const c = canvasBox().rect;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - c.left) / c.width)),
      y: Math.max(0, Math.min(1, (e.clientY - c.top) / c.height))
    };
  }

  layer.addEventListener('pointerdown', (e) => {
    if (!picking || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    layer.setPointerCapture?.(e.pointerId);
    const p = fracAt(e);
    drag = { x0: p.x, y0: p.y, frac: { x: p.x, y: p.y, w: 0, h: 0 } };
    syncLayer();
  });
  layer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.stopPropagation();
    const p = fracAt(e);
    drag.frac = {
      x: Math.min(drag.x0, p.x),
      y: Math.min(drag.y0, p.y),
      w: Math.abs(p.x - drag.x0),
      h: Math.abs(p.y - drag.y0)
    };
    paintBox(drag.frac);
  });
  layer.addEventListener('pointerup', (e) => {
    if (!drag) return;
    e.stopPropagation();
    const c = canvasBox();
    const f = drag.frac;
    drag = null;
    picking = false;
    // A click without a drag keeps whatever was chosen before.
    if (f.w * c.width >= MIN_AREA_PX && f.h * c.height >= MIN_AREA_PX) area = f;
    syncLayer();
    paintEstimate();
  });
  // The map's own handlers (pan, draw, 3D clicks) never see a pick.
  for (const type of ['click', 'contextmenu', 'wheel', 'auxclick']) {
    layer.addEventListener(type, (e) => {
      if (picking) e.stopPropagation();
    });
  }

  areaBtn.addEventListener('click', () => {
    picking = !picking;
    drag = null;
    syncLayer();
  });
  areaReset.addEventListener('click', () => {
    area = null;
    syncLayer();
    paintEstimate();
  });

  /** The chosen part of the radar canvas in its own pixels. */
  function areaPixels() {
    const w = canvas.width || 1;
    const h = canvas.height || 1;
    if (!area) return { sx: 0, sy: 0, sw: w, sh: h };
    const sx = Math.round(area.x * w);
    const sy = Math.round(area.y * h);
    return {
      sx,
      sy,
      sw: Math.max(1, Math.min(w - sx, Math.round(area.w * w))),
      sh: Math.max(1, Math.min(h - sy, Math.round(area.h * h)))
    };
  }

  // ---- round, range and estimate --------------------------------------------

  function timing() {
    const r = viewer.round();
    return r?.meta ? timingFor(r.meta) : null;
  }

  function tickOf(seconds) {
    const t = timing();
    return t ? t.startTick + seconds * t.tickRate : 0;
  }

  function clockLabel(tick) {
    const t = timing();
    return t ? clockAt(t, tick).label : '';
  }

  /** The range goes over the whole round, buy time and after the end included. */
  function resetRange() {
    const r = viewer.round();
    const t = timing();
    if (!r || !t) return;
    roundKey = r.file;
    const total = totalSeconds(t);
    const at = Math.max(0, Math.min(total, (viewer.playheadTick() - t.startTick) / t.tickRate));
    const from = Math.max(0, at - 2);
    const to = Math.min(total, from + Math.min(8, MAX_SECONDS[kind]));
    range = makeRange(total);
    range.set(from, to);
    const kills = (r.meta.events?.kills || [])
      .map((k) => ({ at: (k.tick - t.startTick) / t.tickRate, color: '#e9e9ea' }))
      .filter((k) => k.at >= 0 && k.at <= total);
    range.setMarks(kills);
    paintRange();
  }

  function paintRange() {
    const { from, to } = range.get();
    const secs = Math.max(0, to - from);
    rangeRead.textContent = `${clockLabel(tickOf(from))} to ${clockLabel(tickOf(to))}, ${secs.toFixed(1)} s`;
    paintEstimate();
  }

  function frameSize() {
    if (kind === '3d') {
      const c = viewer.view3d()?.canvas;
      return outputSize('3d', quality, c?.width || 1280, c?.height || 720);
    }
    const px = areaPixels();
    return outputSize('2d', quality, px.sw, px.sh);
  }

  function paintEstimate() {
    const t = timing();
    if (!t) {
      estEl.textContent = '';
      return;
    }
    const { from, to } = range.get();
    const fps = clampFps(kind, fpsInput.value);
    const ticks = frameTicks({ fromTick: tickOf(from), toTick: tickOf(to), tickRate: t.tickRate, fps, kind });
    const size = frameSize();
    const capped = to - from > MAX_SECONDS[kind] + 1e-6;
    estEl.textContent = `${ticks.length} frames at ${fps} FPS, ${size.width} x ${size.height} (${Math.round(qualityScale(kind, quality) * 100)}%)${
      capped ? `. ${kind.toUpperCase()} GIFs stop at ${MAX_SECONDS[kind]} s` : ''
    }`;
  }

  // ---- 2D / 3D, camera, quality -----------------------------------------------

  function setSeg(btns, attr, value) {
    for (const b of btns) {
      const on = b.dataset[attr] === String(value);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function syncKindRows() {
    panel.querySelectorAll('[data-gif-only]').forEach((row) => {
      const only = row.dataset.gifOnly;
      row.hidden = only === '3d-player' ? kind !== '3d' || cameraSel.value === 'view' : only !== kind;
    });
    const can3d = viewer.can3d();
    const btn3d = kindBtns.find((b) => b.dataset.gifKind === '3d');
    btn3d.disabled = !can3d;
    btn3d.title = can3d ? '' : 'This round has no 3D view';
  }

  async function setKind(next) {
    if (busy) return;
    if (next === '3d' && !viewer.can3d()) return;
    fpsFor[kind] = clampFps(kind, fpsInput.value);
    kind = next;
    setSeg(kindBtns, 'gifKind', kind);
    fpsInput.value = String(fpsFor[kind]);
    picking = false;
    syncKindRows();
    syncLayer();
    if (kind === '3d') {
      fillCameras();
      if (!viewer.is3d()) {
        setMsg('Opening 3D…');
        const ok = await viewer.set3d(true);
        setMsg(ok ? '' : 'The 3D view could not open here.', !ok);
        if (!ok) {
          await setKind('2d');
          return;
        }
      }
      applyCamera();
    } else if (viewer.is3d()) {
      await viewer.set3d(false);
    }
    paintEstimate();
  }

  function fillCameras() {
    const r = viewer.round();
    const keep = cameraSel.value || 'view';
    const players = (r?.meta?.players || []).map((p) => ({
      slot: p.slot,
      name: p.name || `Player ${p.slot}`,
      side: (p.team === 1 ? r.meta.team1Side : r.meta.team2Side) || ''
    }));
    const group = (side) =>
      players
        .filter((p) => p.side === side)
        .map((p) => `<option value="slot:${p.slot}">${escapeHtml(p.name)}</option>`)
        .join('');
    cameraSel.innerHTML =
      '<option value="view">Camera where it is</option>' +
      ['T', 'CT']
        .map((s) => {
          const opts = group(s);
          return opts ? `<optgroup label="${s}">${opts}</optgroup>` : '';
        })
        .join('');
    cameraSel.value = [...cameraSel.options].some((o) => o.value === keep) ? keep : 'view';
    syncKindRows();
  }

  /** Show the chosen camera now, so what is on screen is what gets captured. */
  function applyCamera() {
    const v3 = viewer.view3d();
    if (!v3 || kind !== '3d') return;
    const m = /^slot:(\d+)$/.exec(cameraSel.value);
    if (!m) return;
    v3.spectateSlot(Number(m[1]));
    v3.setMode(camMode);
  }

  /** Whose side the 3D GIF is seen from, and whose eyes, for its metadata. */
  function perspective() {
    const r = viewer.round();
    const v3 = viewer.view3d();
    if (kind !== '3d' || !r?.meta || !v3 || v3.isFree) return { side: '', player: '' };
    const p = (r.meta.players || []).find((x) => x.slot === v3.povSlot);
    if (!p) return { side: '', player: '' };
    return { side: (p.team === 1 ? r.meta.team1Side : r.meta.team2Side) || '', player: p.name || '' };
  }

  kindBtns.forEach((b) => b.addEventListener('click', () => void setKind(b.dataset.gifKind)));
  qualityBtns.forEach((b) =>
    b.addEventListener('click', () => {
      quality = Number(b.dataset.gifQuality) || 1;
      setSeg(qualityBtns, 'gifQuality', quality);
      paintEstimate();
    })
  );
  camModeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      camMode = b.dataset.gifCamMode === 'third' ? 'third' : 'pov';
      setSeg(camModeBtns, 'gifCamMode', camMode);
      applyCamera();
    })
  );
  cameraSel.addEventListener('change', () => {
    syncKindRows();
    applyCamera();
  });
  fpsInput.addEventListener('input', paintEstimate);
  fpsInput.addEventListener('change', () => {
    fpsInput.value = String(clampFps(kind, fpsInput.value));
    paintEstimate();
  });

  // ---- making it ----------------------------------------------------------------

  function setMsg(text, isError = false) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('bad', Boolean(isError));
  }

  function setBusy(on) {
    goLabel.textContent = on ? 'CANCEL' : 'CREATE GIF';
    goBtn.classList.toggle('is-busy', on);
    progressEl.hidden = !on;
    panel.querySelectorAll('input, textarea, select, .rp-seg-btn, [data-gif-area], [data-gif-area-reset]').forEach((n) => {
      n.disabled = on || (n.dataset.gifKind === '3d' && !viewer.can3d());
    });
  }

  function showResult(blob, name) {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastBlob = blob;
    lastName = name;
    lastUrl = URL.createObjectURL(blob);
    previewImg.src = lastUrl;
    resultEl.hidden = false;
  }

  async function run() {
    const r = viewer.round();
    const t = timing();
    if (!r?.meta || !t) {
      setMsg('Open a round first.', true);
      return;
    }
    const { from, to } = range.get();
    const fps = clampFps(kind, fpsInput.value);
    const ticks = frameTicks({ fromTick: tickOf(from), toTick: tickOf(to), tickRate: t.tickRate, fps, kind });
    const v3 = kind === '3d' ? viewer.view3d() : null;
    if (kind === '3d' && !v3?.ready) {
      setMsg('The 3D view is still loading.', true);
      return;
    }
    const size = frameSize();
    const px = areaPixels();
    const look = perspective();
    const controller = new AbortController();
    busy = controller;
    savedId = '';
    copyBtn.hidden = true;
    bookmarksLink.hidden = true;
    setBusy(true);
    setMsg('');
    const state = viewer.beginCapture();
    let clock = 1000;
    let blankChecked = false;
    v3?.beginCapture();
    let blob = null;
    try {
      blob = await captureGif({
        count: ticks.length,
        fps,
        palette: kind === '3d' ? 'local' : 'global',
        size,
        stampClock: clockInput.checked,
        signal: controller.signal,
        onProgress: (done, total, phase) => {
          const k = phase === 'draw' ? done / total / 2 : 0.5 + done / total / 2;
          progressBar.style.width = `${Math.round(Math.min(1, k) * 100)}%`;
          setMsg(phase === 'draw' ? `Drawing frame ${done} of ${total}` : `Encoding frame ${done} of ${total}`);
        },
        drawFrame: async (i) => {
          viewer.drawAt(ticks[i]);
          const label = clockLabel(ticks[i]);
          if (!v3) return { source: canvas, ...px, clock: label };
          const src = v3.captureFrame(clock);
          clock += 1000 / fps;
          if (!blankChecked) {
            blankChecked = true;
            if (canvasIsBlank(src)) throw new Error('This browser does not let the 3D view be captured. Try 2D, or another browser.');
          }
          return { source: src, sx: 0, sy: 0, sw: src.width, sh: src.height, clock: label, flash: v3.flash, overlays: [v3.crosshairCanvas] };
        }
      });
    } catch (err) {
      if (err?.name !== 'AbortError') setMsg(err?.message || 'The GIF could not be made.', true);
      else setMsg('Cancelled.');
    } finally {
      v3?.endCapture();
      viewer.endCapture(state);
      busy = null;
      setBusy(false);
      progressBar.style.width = '0%';
    }
    if (!blob) return;

    const meta = gifMetaFromRound(r.meta, {
      kind,
      file: r.file,
      fromTick: ticks[0],
      toTick: ticks[ticks.length - 1],
      clockFrom: clockLabel(ticks[0]),
      clockTo: clockLabel(ticks[ticks.length - 1]),
      side: look.side,
      player: look.player,
      title: titleInput.value,
      description: descInput.value,
      source: 'viewer'
    });
    const name = gifFileName(meta);
    downloadBlob(blob, name);
    showResult(blob, name);
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    setMsg(`Downloaded ${name} (${mb} MB). Saving to Bookmarks…`);
    try {
      const { gif, copy } = await saveGifFitting(blob, meta, {
        fps,
        palette: kind === '3d' ? 'local' : 'global',
        onShrink: () => setMsg(`Downloaded (${mb} MB). That is more than Bookmarks keep, so a smaller copy is being made for them…`),
        onProgress: (done, total) => setMsg(`Downloaded (${mb} MB). Making a smaller copy for Bookmarks: frame ${done} of ${total}`)
      });
      savedId = gif.id;
      copyBtn.hidden = false;
      bookmarksLink.hidden = false;
      setMsg(
        copy
          ? `Downloaded (${mb} MB). Saved a smaller copy to Bookmarks: ${(copy.bytes / 1024 / 1024).toFixed(1)} MB, ${copy.width} x ${copy.height}, ${copy.fps} FPS.`
          : `Downloaded (${mb} MB) and saved to Bookmarks.`
      );
      onSaved?.(gif);
    } catch (err) {
      setMsg(
        err?.status === 401
          ? `Downloaded (${mb} MB). Sign in to keep GIFs in Bookmarks.`
          : `Downloaded (${mb} MB). Not saved to Bookmarks: ${err?.message || 'the upload failed'}`,
        true
      );
    }
  }

  /** A WebGPU or WebGL canvas that would not give its picture up reads as all zeros. */
  function canvasIsBlank(src) {
    try {
      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 18;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) return false;
      return true;
    } catch {
      return false;
    }
  }

  goBtn.addEventListener('click', () => {
    if (busy) busy.abort();
    else void run();
  });
  downloadBtn.addEventListener('click', () => {
    if (lastBlob) downloadBlob(lastBlob, lastName);
  });
  copyBtn.addEventListener('click', async () => {
    if (!savedId) return;
    const link = gifShareUrl(savedId);
    try {
      await navigator.clipboard.writeText(link);
      setMsg('Link copied.');
    } catch {
      window.prompt('Copy the link:', link);
    }
  });

  // ---- open / close -------------------------------------------------------------

  return {
    get isOpen() {
      return open;
    },
    get busy() {
      return Boolean(busy);
    },
    open() {
      open = true;
      panel.hidden = false;
      const r = viewer.round();
      // Opened in 3D, it makes a 3D GIF; the 2D/3D switch takes it from there.
      if (viewer.is3d() && kind !== '3d') {
        kind = '3d';
        setSeg(kindBtns, 'gifKind', kind);
        fpsInput.value = String(fpsFor['3d']);
      }
      if (kind === '3d') fillCameras();
      syncKindRows();
      if (r?.file !== roundKey) resetRange();
      else paintRange();
      const t = timing();
      if (t) range.setCursor((viewer.playheadTick() - t.startTick) / t.tickRate);
      syncLayer();
    },
    close() {
      open = false;
      picking = false;
      drag = null;
      panel.hidden = true;
      syncLayer();
    },
    /** Where the round on screen is now, in seconds from its start: drawn on the part's track. */
    playhead(seconds) {
      if (open && !busy) range.setCursor(seconds);
    },
    /**
     * The round was moved by hand (the timeline, the skip buttons): the part
     * moves with it, keeping its length, starting where the round now is.
     */
    followPlayhead(seconds) {
      if (!open || busy || !Number.isFinite(seconds)) return;
      const { from, to } = range.get();
      const len = Math.max(0, to - from);
      const start = Math.max(0, Math.min(seconds, rangeTotal - len));
      range.set(start, start + len);
      range.setCursor(seconds);
      paintRange();
    },
    /** The round on screen changed: the range belongs to the old one. */
    roundChanged() {
      if (!open || busy) return;
      resetRange();
      if (kind === '3d') fillCameras();
    },
    /** The viewer left 3D on its own (the 3D button): follow it. */
    viewChanged() {
      if (busy || !open) return;
      const next = viewer.is3d() ? '3d' : '2d';
      if (next !== kind) {
        fpsFor[kind] = clampFps(kind, fpsInput.value);
        kind = next;
        setSeg(kindBtns, 'gifKind', kind);
        fpsInput.value = String(fpsFor[kind]);
        if (kind === '3d') fillCameras();
        syncKindRows();
        syncLayer();
        paintEstimate();
      }
    },
    /** Resize: keep the picked area's outline over the same part of the map. */
    relayout() {
      if (open) syncLayer();
    },
    /** Escape ends an area pick before it closes anything else. */
    handleEscape() {
      if (picking) {
        picking = false;
        drag = null;
        syncLayer();
        return true;
      }
      if (busy) {
        busy.abort();
        return true;
      }
      return false;
    },
    destroy() {
      busy?.abort();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      layer.remove();
    }
  };
}
