// ---------------------------------------------------------------------------
// replays/gif/gifCreator.js
// The visual note creator in the round viewer's side panel.
//
// A note is seen from any number of perspectives (perspectivePicker.js), each its
// own render: players in first or third person, the 2D map, a camera over the
// action or held where the 3D view is, where each grenade lands. Those render in
// the background from a scene of their own (visualNote.js), one note at a time in
// a queue, while the viewer stays where it is or goes on playing. A note of only
// the 2D map, or one with an area of it picked, is the one thing drawn here instead:
// every frame is the viewer's own radar, so zones, POV, duels and drawings come
// out exactly as they are on screen.
//
// The finished note goes to Bookmarks > Visual Notes with what it shows (map,
// both teams' sides and buys, who won) and the title and description given
// here, ready to share by link. "Automatically append setpos" adds a line per
// grenade thrown in the part, by the players picked when any are, with the
// thrower's setpos as a copy link (gifSetpos.js).
// ---------------------------------------------------------------------------

import { createRangeSlider } from '../../lib/rangeSlider.js';
import { clockAt, timingFor, totalSeconds } from '../viewer/roundClock.js';
import { DEFAULT_QUALITY, MAX_FPS, MAX_SECONDS, MIN_FPS, clampFps, frameTicks, outputSize, qualityScale } from './gifCore.js';
import { GIF_CREATOR_DESCRIPTION_MAX, GIF_DESCRIPTION_MAX, GIF_TITLE_MAX, gifMetaFromRound } from './gifMeta.js';
import { captureClip, downloadBlob, downloadSavedGif, gifFileName, gifPageUrl, gifShareUrl, saveGifFitting, warmGif } from './gifCapture.js';
import { appendSetposLines, utilitySetposLines } from './gifSetpos.js';
import { VIEW_3D } from './roundGif.js';
import { createPerspectivePicker } from './perspectivePicker.js';
import { renderOptions } from './perspectives.js';
import { failuresText, noteHref, openNoteTab, renderPerspectives } from './visualNote.js';
import { enqueueEyeJob } from '../eye/eyeJobs.js';
import { updateGif } from '../api.js';

/** Smallest area worth a clip, in screen pixels. */
const MIN_AREA_PX = 40;
/** "Automatically append setpos": remembered, because whoever wants it once wants it every time. */
const SETPOS_KEY = 'aim4.gif.appendSetpos';
/** What the field starts at. One value for every perspective: a 2D clip clamps it to its own range. */
const START_FPS = 24;

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
 *   view3d(): object | null
 *   openCamera(): Promise<boolean>  into 3D and flying, false if this round has no 3D
 *   drawAt(tick): void            draws the radar at a tick
 *   beginCapture(): object        pauses playback, returns what endCapture restores
 *   endCapture(state): void
 *   seekLocal(seconds): void      pauses and shows the round at seconds from its start
 *   fullTrack(): TickTrack | Promise<TickTrack|null>  the round's every-tick data, for setpos
 *
 * The part of the round and the viewer's timeline move together: dragging an
 * end of the part shows the round there, and moving the round (the timeline,
 * the skip buttons) carries the part along, its length kept, starting where
 * the round now is. The round's position is drawn on the part's track.
 * @param {(gif: object) => void} [opts.onSaved]
 */
export function createGifCreator({ panel, mapEl, canvas, photoIcon = '', escapeHtml, viewer, onSaved }) {
  panel.innerHTML = `
    <p class="rv-playlist-label">Create visual note</p>
    <div class="rv-gif-form">
      <div data-gif-picker></div>
      <div class="rv-gif-row" data-gif-area-row hidden>
        <button type="button" class="btn btn-sm" data-gif-area>Select area</button>
        <span class="rv-gif-read" data-gif-area-read>Whole map</span>
        <button type="button" class="rv-gif-link" data-gif-area-reset hidden>Reset</button>
      </div>
      <div class="rv-strat-window">
        <div class="rv-strat-range" data-gif-range></div>
        <div class="rv-strat-range-read" data-gif-range-read></div>
      </div>
      <div class="rv-gif-row">
        <span class="rv-gif-label">Quality</span>
        <div class="rp-seg" role="group" aria-label="Quality">
          <button type="button" class="rp-seg-btn" data-gif-quality="1" aria-pressed="false">1</button>
          <button type="button" class="rp-seg-btn" data-gif-quality="2" aria-pressed="false">2</button>
          <button type="button" class="rp-seg-btn active" data-gif-quality="3" aria-pressed="true">3</button>
        </div>
        <label class="rv-gif-fps"><span>FPS</span>
          <input type="number" class="site-input" data-gif-fps min="${MIN_FPS}" max="${MAX_FPS}" step="1" value="${START_FPS}" />
        </label>
      </div>
      <input type="text" class="site-input" data-gif-title maxlength="${GIF_TITLE_MAX}" placeholder="Title" aria-label="Title" />
      <textarea class="site-input rv-gif-desc" data-gif-desc maxlength="${GIF_CREATOR_DESCRIPTION_MAX}" rows="3" placeholder="Description. <setpos ...> becomes a copy link." aria-label="Description"></textarea>
      <div class="rv-gif-checks">
        <label class="rv-strat-check">
          <input type="checkbox" data-gif-clock checked />
          <span>Round clock</span>
        </label>
        <label class="rv-strat-check">
          <input type="checkbox" data-gif-setpos />
          <span>Automatically append setpos</span>
        </label>
      </div>
      <p class="rv-gif-est" data-gif-est></p>
      <button type="button" class="rv-playlist-strategy rv-gif-go" data-gif-go>${photoIcon}<span>CREATE NOTE</span></button>
      <div class="rv-gif-progress" data-gif-progress hidden><span></span></div>
      <span class="rv-popover-msg" data-gif-msg></span>
      <button type="button" class="rv-gif-link" data-gif-bg-cancel hidden>Cancel it</button>
      <div class="rv-gif-result" data-gif-result hidden>
        <div class="rv-gif-result-head">
          <a class="rv-gif-result-title" href="/bookmarks?tab=gifs" data-gif-bookmarks hidden>Saved to Visual Notes</a>
          <span class="rv-gif-result-title" data-gif-unsaved hidden>Not saved</span>
          <span class="rv-gif-result-facts" data-gif-facts></span>
          <span class="rv-gif-result-facts" data-gif-note hidden></span>
        </div>
        <button type="button" class="rv-gif-action" data-gif-copy="page" hidden>
          <span class="rv-gif-action-name">Copy page link</span>
          <span class="rv-gif-action-detail" data-detail="Page with every perspective, title, description and setpos links">Page with every perspective, title, description and setpos links</span>
        </button>
        <button type="button" class="rv-gif-action" data-gif-copy="image" hidden>
          <span class="rv-gif-action-name">Copy image link</span>
          <span class="rv-gif-action-detail" data-detail="The first perspective as a GIF. Plays when pasted in Discord">The first perspective as a GIF. Plays when pasted in Discord</span>
        </button>
        <button type="button" class="rv-gif-action" data-gif-download>
          <span class="rv-gif-action-name">Download</span>
          <span class="rv-gif-action-detail" data-gif-download-detail></span>
        </button>
      </div>
    </div>`;

  const $ = (sel) => panel.querySelector(sel);
  const qualityBtns = [...panel.querySelectorAll('[data-gif-quality]')];
  const areaRow = $('[data-gif-area-row]');
  const areaBtn = $('[data-gif-area]');
  const areaRead = $('[data-gif-area-read]');
  const areaReset = $('[data-gif-area-reset]');
  const rangeSlot = $('[data-gif-range]');
  const rangeRead = $('[data-gif-range-read]');
  const fpsInput = $('[data-gif-fps]');
  const titleInput = $('[data-gif-title]');
  const descInput = $('[data-gif-desc]');
  const clockInput = $('[data-gif-clock]');
  const setposInput = $('[data-gif-setpos]');
  const estEl = $('[data-gif-est]');
  const goBtn = $('[data-gif-go]');
  const goLabel = goBtn.querySelector('span');
  const progressEl = $('[data-gif-progress]');
  const progressBar = progressEl.querySelector('span');
  const msgEl = $('[data-gif-msg]');
  const bgCancelBtn = $('[data-gif-bg-cancel]');
  const resultEl = $('[data-gif-result]');
  const factsEl = $('[data-gif-facts]');
  const noteEl = $('[data-gif-note]');
  const unsavedEl = $('[data-gif-unsaved]');
  const copyBtns = [...panel.querySelectorAll('[data-gif-copy]')];
  const downloadBtn = $('[data-gif-download]');
  const downloadDetail = $('[data-gif-download-detail]');
  const bookmarksLink = $('[data-gif-bookmarks]');

  let quality = DEFAULT_QUALITY;
  /** Fractions of the radar canvas; null is the whole map. */
  let area = null;
  let open = false;
  let busy = null;
  let roundKey = '';
  let lastBlob = null;
  let lastName = '';
  let lastMeta = null;
  let savedId = '';
  /** The latest note being made in the background, until it is done. */
  let backgroundJob = null;

  const picker = createPerspectivePicker({
    host: $('[data-gif-picker]'),
    escapeHtml,
    camera: {
      available: () => Boolean(viewer.can3d?.()),
      open: () => viewer.openCamera(),
      pose: () => viewer.view3d()?.cameraPose?.() || null,
      screenshot: () => viewer.view3d()?.screenshot?.() || null
    },
    onChange: () => {
      if (!picker.wantsMap) {
        picking = false;
        area = null;
      }
      syncLayer();
      paintEstimate();
    }
  });

  try {
    setposInput.checked = localStorage.getItem(SETPOS_KEY) === '1';
  } catch {
    /* storage blocked: off */
  }
  setposInput.addEventListener('change', () => {
    try {
      localStorage.setItem(SETPOS_KEY, setposInput.checked ? '1' : '0');
    } catch {
      /* storage blocked: this session only */
    }
    paintEstimate();
  });

  /** Grenades thrown between two ticks: what "Automatically append setpos" would write a line for. */
  function throwsBetween(fromTick, toTick) {
    const r = viewer.round();
    const only = new Set(picker.pickedIds());
    return (r?.meta?.events?.grenades || []).filter((g) => {
      const t = Number(g.throwTick);
      return Number.isFinite(t) && t >= fromTick && t <= toTick && (!only.size || only.has(String(g.player)));
    }).length;
  }

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
    areaRow.hidden = !picker.wantsMap || viewer.is3d();
    layer.hidden = !open || !picker.wantsMap || viewer.is3d() || (!picking && !area);
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
    picker.setRound(r.meta);
    const total = totalSeconds(t);
    const at = Math.max(0, Math.min(total, (viewer.playheadTick() - t.startTick) / t.tickRate));
    const from = Math.max(0, at - 2);
    const to = Math.min(total, from + Math.min(8, MAX_SECONDS['3d']));
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

  /** The part as ticks. */
  function part() {
    const { from, to } = range.get();
    return { fromTick: tickOf(from), toTick: tickOf(to) };
  }

  /** The map drawn here rather than off screen: when it is the only choice, or an area of it was picked. */
  function mapOnScreen(specs) {
    return picker.wantsMap && !viewer.is3d() && (specs.length === 1 || Boolean(area));
  }

  function paintEstimate() {
    const t = timing();
    if (!t) {
      estEl.textContent = '';
      return;
    }
    const p = part();
    const { specs, over } = picker.specs(p);
    const fps = clampFps('3d', fpsInput.value);
    if (!specs.length) {
      estEl.textContent = 'Pick at least one perspective';
      return;
    }
    const ticks = frameTicks({ ...p, tickRate: t.tickRate, fps, kind: '3d' });
    const has3d = specs.some((s) => renderOptions(s).kind === '3d');
    const capped = has3d && p.toTick - p.fromTick > MAX_SECONDS['3d'] * t.tickRate;
    const seen = `${specs.length} ${specs.length === 1 ? 'perspective' : 'perspectives'}`;
    const lines = setposInput.checked ? throwsBetween(ticks[0], ticks[ticks.length - 1]) : -1;
    estEl.textContent = [
      `${seen}, ${ticks.length} frames at ${fps} FPS`,
      has3d ? `${outputSize('3d', quality, VIEW_3D.width, VIEW_3D.height).width} x ${outputSize('3d', quality, VIEW_3D.width, VIEW_3D.height).height} (${Math.round(qualityScale('3d', quality) * 100)}%)` : '',
      capped ? `3D stops at ${MAX_SECONDS['3d']} s` : '',
      over ? `${over} more did not fit in one note` : '',
      lines >= 0 ? `Setpos for ${lines} ${lines === 1 ? 'grenade' : 'grenades'}` : ''
    ]
      .filter(Boolean)
      .join('. ');
  }

  // ---- quality -----------------------------------------------------------------

  function setSeg(btns, attr, value) {
    for (const b of btns) {
      const on = b.dataset[attr] === String(value);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  qualityBtns.forEach((b) =>
    b.addEventListener('click', () => {
      quality = Number(b.dataset.gifQuality) || 1;
      setSeg(qualityBtns, 'gifQuality', quality);
      paintEstimate();
    })
  );
  bgCancelBtn.addEventListener('click', () => {
    backgroundJob?.abort();
    setMsg('Cancelled.');
  });
  fpsInput.addEventListener('input', paintEstimate);
  fpsInput.addEventListener('change', () => {
    fpsInput.value = String(clampFps('3d', fpsInput.value));
    paintEstimate();
  });

  // ---- making it ----------------------------------------------------------------

  function setMsg(text, isError = false) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('bad', Boolean(isError));
  }

  function setBusy(on) {
    goLabel.textContent = on ? 'CANCEL' : 'CREATE NOTE';
    goBtn.classList.toggle('is-busy', on);
    progressEl.hidden = !on;
    panel.querySelectorAll('input, textarea, select, .rp-seg-btn, .rv-pp-chip, [data-gif-area], [data-gif-area-reset]').forEach((n) => {
      n.disabled = on;
    });
  }

  function setNote(text) {
    noteEl.textContent = text || '';
    noteEl.hidden = !text;
  }

  /**
   * The finished note, as what can be done with it. Not a preview of it: whoever made it just watched that part of
   * the round. The links wait for the save.
   *
   * @param {Blob} blob   the first clip
   * @param {string} name
   * @param {string} facts
   */
  function showResult(blob, name, facts) {
    lastBlob = blob;
    lastName = name;
    factsEl.textContent = facts;
    setNote('');
    setSaved(false);
    resultEl.hidden = false;
  }

  /** Links exist once it is saved; until then, or if that fails, Download is the only copy. */
  function setSaved(saved) {
    for (const b of copyBtns) b.hidden = !saved;
    bookmarksLink.hidden = !saved;
    unsavedEl.hidden = saved;
    paintDownloadDetail();
  }

  const paintDownloadDetail = () => {
    downloadDetail.textContent = savedId ? 'The first perspective as a GIF. Made on the first download' : `This copy, as ${lastBlob?.type === 'video/mp4' ? 'a video' : 'a GIF'}`;
  };

  /** Says so on the button pressed, then goes back to saying what the button does. */
  function flashDetail(btn, text) {
    const el = btn.querySelector('.rv-gif-action-detail');
    el.textContent = text;
    el.classList.add('is-done');
    clearTimeout(btn.flashTimer);
    btn.flashTimer = setTimeout(() => {
      el.textContent = el.dataset.detail;
      el.classList.remove('is-done');
    }, 2000);
  }

  /** The description with its setpos lines, as a separate edit. Says how it went on the result. */
  async function addSetposLines(gif, description, lines) {
    const { text, added, left } = appendSetposLines(description, lines, GIF_DESCRIPTION_MAX);
    try {
      const kept = await updateGif(gif.id, { description: text });
      setNote(
        `Setpos for ${added} ${added === 1 ? 'grenade' : 'grenades'} in its description${
          left ? `, ${left} more did not fit` : ''
        }`
      );
      return kept;
    } catch (err) {
      setMsg(`The setpos lines could not be added: ${err?.message || 'the edit failed'}`, true);
      return gif;
    }
  }

  /**
   * Queue the perspectives. `open` takes the note to a new tab when it is done.
   *
   * @param {object} job
   * @param {object} job.round     { file, meta }
   * @param {object} job.part      { fromTick, toTick }
   * @param {object[]} job.specs
   * @param {string} [job.noteId]  add these to a note that already exists
   * @param {string[]} [job.setposOf]  whose grenades get setpos lines, null for none, [] for everyone's
   * @param {string} job.label     what the notifications call it
   * @param {boolean} [job.openWhenDone]
   */
  async function queueNote({ round, part: span, specs, noteId = '', setposOf = null, title = '', description = '', fps, quality: level, clock = true, label, openWhenDone = false }) {
    const track = await viewer.fullTrack?.();
    if (!track) throw new Error("The round's positions are still loading. Try again in a moment.");
    const t = timingFor(round.meta);
    const lines = setposOf ? utilitySetposLines(round.meta, track, { ...span, timing: t, player: setposOf }) : [];
    const controller = new AbortController();
    backgroundJob = controller;
    bgCancelBtn.hidden = false;
    const finished = () => {
      if (backgroundJob !== controller) return;
      backgroundJob = null;
      bgCancelBtn.hidden = true;
    };
    const queued = enqueueEyeJob({
      label,
      name: 'Visual note',
      run: async (task) => {
        const cancelled = { title: `Visual note cancelled: ${label}` };
        if (controller.signal.aborted) {
          finished();
          return cancelled;
        }
        try {
          const res = await renderPerspectives({
            file: round.file,
            round: { meta: round.meta, track },
            ...span,
            specs,
            noteId,
            fps,
            quality: level,
            clock,
            title,
            description,
            source: 'viewer',
            signal: controller.signal,
            onProgress: (text) => task.setStatus(text)
          });
          const problem = failuresText(res.failed);
          if (res.first && !noteId) {
            lastMeta = res.first.meta;
            savedId = '';
            const seconds = res.first.seconds.toFixed(1);
            showResult(res.first.blob, gifFileName(res.first.meta, res.first.blob.type === 'video/mp4' ? 'mp4' : 'gif'), `${res.made} ${res.made === 1 ? 'perspective' : 'perspectives'}, ${seconds} s, ${(res.first.blob.size / 1024 / 1024).toFixed(1)} MB for the first`);
          }
          if (!res.note?.id) {
            const unsigned = res.failed.some((f) => f.status === 401);
            const why = unsigned ? 'Sign in to keep visual notes in Bookmarks.' : problem || 'Nothing could be made.';
            setMsg(why, true);
            return { title: `Visual note not saved: ${label}`, body: why };
          }
          savedId = res.note.id;
          setSaved(true);
          setMsg(problem, Boolean(problem));
          const kept = lines.length && !noteId ? await addSetposLines(res.note, description, lines) : res.note;
          if (setposOf && !lines.length && !noteId) setNote('No grenades were thrown in this part, so no setpos was added');
          onSaved?.(kept);
          const opened = openWhenDone && openNoteTab(res.note.id);
          return {
            title: `Visual note saved: ${label}`,
            body: problem || (opened ? '' : 'Open it in Visual Notes.'),
            href: noteHref(res.note.id)
          };
        } catch (err) {
          if (err?.name === 'AbortError') return cancelled;
          throw err;
        } finally {
          finished();
        }
      }
    });
    return queued;
  }

  /** The 2D map drawn from the viewer's own radar, as it is on screen. Resolves the saved note, or null. */
  async function runOnScreen(r, t, description) {
    const fps = clampFps('2d', fpsInput.value);
    const p = part();
    const ticks = frameTicks({ ...p, tickRate: t.tickRate, fps, kind: '2d' });
    const px = areaPixels();
    const size = outputSize('2d', quality, px.sw, px.sh);
    const controller = new AbortController();
    busy = controller;
    savedId = '';
    resultEl.hidden = true;
    setBusy(true);
    setMsg('');
    const state = viewer.beginCapture();
    let blob = null;
    try {
      blob = await captureClip({
        count: ticks.length,
        fps,
        palette: 'global',
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
          return { source: canvas, ...px, clock: clockLabel(ticks[i]) };
        }
      });
    } catch (err) {
      if (err?.name !== 'AbortError') setMsg(err?.message || 'The clip could not be made.', true);
      else setMsg('Cancelled.');
    } finally {
      viewer.endCapture(state);
      busy = null;
      setBusy(false);
      progressBar.style.width = '0%';
    }
    if (!blob) return null;

    const meta = gifMetaFromRound(r.meta, {
      kind: '2d',
      file: r.file,
      fromTick: ticks[0],
      toTick: ticks[ticks.length - 1],
      clockFrom: clockLabel(ticks[0]),
      clockTo: clockLabel(ticks[ticks.length - 1]),
      view: 'map',
      label: '2D map',
      title: titleInput.value,
      description,
      source: 'viewer'
    });
    const name = gifFileName(meta, blob.type === 'video/mp4' ? 'mp4' : 'gif');
    lastMeta = meta;
    const seconds = (ticks[ticks.length - 1] - ticks[0]) / t.tickRate;
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    showResult(blob, name, `1 perspective, ${seconds.toFixed(1)} s, ${size.width} x ${size.height}, ${mb} MB`);
    unsavedEl.textContent = 'Saving to Visual Notes…';
    try {
      const { gif, copy } = await saveGifFitting(blob, meta, {
        fps,
        palette: 'global',
        onShrink: () => setMsg('That is more than Bookmarks keep, so a smaller copy is being made for them…'),
        onProgress: (done, total) => setMsg(`Making a smaller copy for Bookmarks: frame ${done} of ${total}`)
      });
      savedId = gif.id;
      setSaved(true);
      setMsg('');
      if (copy) factsEl.textContent = `1 perspective, ${seconds.toFixed(1)} s, ${copy.width} x ${copy.height}, ${copy.fps} FPS, ${(copy.bytes / 1024 / 1024).toFixed(1)} MB`;
      onSaved?.(gif);
      return gif;
    } catch (err) {
      setMsg(err?.status === 401 ? 'Sign in to keep visual notes in Bookmarks.' : `Not saved to Bookmarks: ${err?.message || 'the upload failed'}.`, true);
      return null;
    } finally {
      unsavedEl.textContent = 'Not saved';
    }
  }

  async function run() {
    const r = viewer.round();
    const t = timing();
    if (!r?.meta || !t) {
      setMsg('Open a round first.', true);
      return;
    }
    const p = part();
    const { specs } = picker.specs(p);
    if (!specs.length) {
      setMsg('Pick at least one perspective.', true);
      return;
    }
    const description = descInput.value;
    const setposOf = setposInput.checked ? picker.pickedIds() : null;
    const onScreen = mapOnScreen(specs);
    const rest = onScreen ? specs.filter((s) => s.type !== 'map') : specs;
    resultEl.hidden = true;
    let note = null;
    if (onScreen) {
      note = await runOnScreen(r, t, description);
      if (!note && rest.length) return;
    }
    const fps = clampFps('3d', fpsInput.value);
    if (!rest.length) {
      if (note && setposOf) {
        const track = await viewer.fullTrack?.();
        const lines = track ? utilitySetposLines(r.meta, track, { ...p, timing: t, player: setposOf }) : [];
        if (lines.length) onSaved?.(await addSetposLines(note, description, lines));
        else setNote('No grenades were thrown in this part, so no setpos was added');
      }
      return;
    }
    try {
      const queued = await queueNote({
        round: r,
        part: p,
        specs: rest,
        noteId: note?.id || '',
        setposOf: note ? null : setposOf,
        title: titleInput.value,
        description,
        fps,
        quality: level(),
        clock: clockInput.checked,
        label: `${rest.length} ${rest.length === 1 ? 'perspective' : 'perspectives'} from ${clockLabel(p.fromTick)}`
      });
      setMsg(
        queued.position
          ? `Queued behind ${queued.position} other${queued.position === 1 ? '' : 's'}. A notice says when it is saved.`
          : 'Making it in the background. A notice says when it is saved.'
      );
    } catch (err) {
      setMsg(err?.message || 'It could not be queued.', true);
    }
  }

  const level = () => quality;

  goBtn.addEventListener('click', () => {
    if (busy) busy.abort();
    else void run();
  });
  downloadBtn.addEventListener('click', async () => {
    if (!savedId) {
      // Not saved, so there is no GIF to ask for: what was made is what there is.
      if (lastBlob) downloadBlob(lastBlob, lastName);
      return;
    }
    downloadBtn.disabled = true;
    downloadDetail.textContent = 'Making the GIF…';
    try {
      await downloadSavedGif(savedId, lastMeta);
      paintDownloadDetail();
    } catch (err) {
      paintDownloadDetail();
      setMsg(err?.message || 'The download failed.', true);
    } finally {
      downloadBtn.disabled = false;
    }
  });
  for (const btn of copyBtns) {
    btn.addEventListener('click', async () => {
      if (!savedId) return;
      const page = btn.dataset.gifCopy === 'page';
      const link = page ? gifPageUrl(savedId) : gifShareUrl(savedId);
      if (!page) warmGif(savedId);
      try {
        await navigator.clipboard.writeText(link);
        flashDetail(btn, 'Copied');
      } catch {
        window.prompt('Copy the link:', link);
      }
    });
  }

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
      if (r?.file !== roundKey) resetRange();
      else {
        picker.repaint();
        paintRange();
      }
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
    },
    /** The T key: a shot for the Camera perspective, when that is what is being picked. */
    takeShot() {
      return open && !busy && picker.takeShot();
    },
    /** The viewer went in or out of 3D: the free camera comes and goes with it. */
    viewChanged() {
      if (busy || !open) return;
      picker.repaint();
      syncLayer();
      paintEstimate();
    },
    /** Resize: keep the picked area's outline over the same part of the map. */
    relayout() {
      if (open) syncLayer();
    },
    /**
     * A note of one player made in one go: the Q shortcut. Quality 3 at 20 FPS, first person, in the queue, and in
     * a new tab when it is done. The panel does not have to be open.
     *
     * @param {{ slot: number, fromTick: number, toTick: number }} what
     * @returns {Promise<{ position: number }>}
     */
    queueQuick({ slot, fromTick, toTick }) {
      const r = viewer.round();
      if (!r?.meta) return Promise.reject(new Error('Open a round first.'));
      const who = (r.meta.players || []).find((p) => p.slot === slot);
      const from = clockLabel(fromTick);
      const to = clockLabel(toTick);
      const name = who?.name || `Player ${slot}`;
      return queueNote({
        round: r,
        part: { fromTick, toTick },
        specs: [{ type: 'player', slot, mode: 'pov' }],
        title: `${name} ${from} to ${to}`,
        fps: 20,
        quality: 3,
        clock: true,
        label: `${name} ${from} to ${to}`,
        openWhenDone: true
      });
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
      layer.remove();
    }
  };
}
