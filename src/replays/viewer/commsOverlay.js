// ---------------------------------------------------------------------------
// replays/viewer/commsOverlay.js — recorded TeamSpeak comms inside the viewer
//
// Two things live here:
//
//   createCommsController  owns the attached recording for one demo: fetching
//                          it, aligning it to the demo's ticks, and answering
//                          "who is saying what at tick N" for both renderers.
//   openCommsDialog        the microphone button's dialog: drop a file, map
//                          the speakers to players, confirm the sync.
//
// Alignment is one anchor (see shared/comms/sync.js): the recorder wrote down
// which millisecond of the recording was round 1's freeze end, and the demo
// knows the tick. Resolving that tick needs round 1 specifically, which the
// viewer may not have loaded — someone can open round 14 on its own — so the
// resolved tick is saved with the attachment the first time and reused after.
// ---------------------------------------------------------------------------

import {
  deleteDemoComms,
  fetchDemo,
  fetchDemoComms,
  fetchDemoCommsFile,
  fetchRecorderLatest,
  recorderDownloadUrl,
  saveDemoCommsAttachment,
  uploadDemoComms
} from '../api.js';
import { decodeComms } from '../../../shared/comms/format.js';
import { findCountdowns } from '../../../shared/comms/countdown.js';
import { anchorRoundFrom, buildTimeline, speakerLines, utterancesAtTick } from '../../../shared/comms/sync.js';

/** Captions fade out over the last stretch of their linger. */
const FADE_TICKS = 40;

/**
 * @param {object} opts
 * @param {string} opts.demoId
 * @param {Array} opts.rounds        rounds loaded in the viewer
 * @param {() => Array} opts.players current round's players
 * @param {() => void} [opts.onChange] redraw hook
 */
export function createCommsController({ demoId, rounds, players, onChange }) {
  const state = {
    /** Sidecar from the server: null when nothing is attached. */
    meta: null,
    /** Decoded container, once the user is actually watching. */
    file: null,
    timeline: null,
    identities: {},
    loading: false,
    error: '',
    /** User toggle. Comms are opt-out per session, like the other overlays. */
    enabled: true
  };

  /** Cache: rounds fetched only to find round 1's freeze end. */
  let demoRoundsOnce = null;

  async function demoRounds() {
    if (demoRoundsOnce) return demoRoundsOnce;
    demoRoundsOnce = (async () => {
      // The loaded rounds are usually the whole demo and already carry what
      // the anchor needs; only a partial selection has to ask the server.
      if (anchorRoundFrom(rounds)) return rounds;
      try {
        const res = await fetchDemo(demoId);
        return res?.demo?.rounds || rounds;
      } catch {
        return rounds;
      }
    })();
    return demoRoundsOnce;
  }

  /** The demo tick the recording's anchor maps onto. */
  async function resolveAnchorTick() {
    if (Number.isFinite(state.meta?.anchorTick)) return state.meta.anchorTick;
    const found = anchorRoundFrom(await demoRounds());
    return found ? found.anchorTick : null;
  }

  function tickRate() {
    return rounds?.[0]?.tickRate || 64;
  }

  /** Rebuild the tick-space timeline from the manifest and saved mapping. */
  async function rebuild() {
    const manifest = state.file?.manifest;
    if (!manifest) {
      state.timeline = null;
      return;
    }
    const anchorTick = await resolveAnchorTick();
    const anchorMs = manifest.sync?.anchorMs;
    if (anchorTick === null || anchorMs === null || anchorMs === undefined) {
      state.timeline = null;
      // Not an error the user has to act on unless they open the dialog: an
      // unanchored file is attached and readable, just not placeable yet.
      return;
    }
    const mapping = state.meta?.mapping || {};
    state.timeline = buildTimeline(
      manifest,
      {
        anchorMs,
        anchorTick,
        tickRate: tickRate(),
        offsetMs: state.meta?.offsetMs || 0
      },
      (speakerIndex) => mapping[manifest.speakers[speakerIndex]?.uid] || null
    );
  }

  /** Fetch the sidecar. Cheap: a few hundred bytes, no audio, no transcript. */
  async function loadMeta() {
    if (!demoId) return null;
    try {
      const res = await fetchDemoComms(demoId);
      state.meta = res?.comms || null;
      state.identities = res?.identities || {};
    } catch {
      state.meta = null;
    }
    return state.meta;
  }

  /** Fetch and decode the container. Only when something will render it. */
  async function loadFile() {
    if (!state.meta || state.file || state.loading) return state.file;
    state.loading = true;
    state.error = '';
    try {
      // uploadedAt, not updatedAt: the bytes change when a file is replaced,
      // not when someone re-maps a speaker or nudges the sync.
      const bytes = await fetchDemoCommsFile(demoId, state.meta.uploadedAt);
      state.file = await decodeComms(bytes);
      await rebuild();
    } catch (err) {
      state.error = err?.message || 'Could not read the comms file.';
      state.file = null;
    } finally {
      state.loading = false;
      onChange?.();
    }
    return state.file;
  }

  async function load() {
    await loadMeta();
    if (state.meta) await loadFile();
    onChange?.();
  }

  /**
   * Captions for the 2D map: player id -> what they are saying now.
   *
   * Only mapped speakers appear. An unmapped voice has no droplet to sit above,
   * and guessing one would put a stranger's words on a player's head.
   */
  function linesAt(tick) {
    if (!state.enabled || !state.timeline) return null;
    const live = utterancesAtTick(state.timeline, tick);
    if (!live.length) return null;
    const out = new Map();
    for (const u of live) {
      if (!u.playerId || out.has(u.playerId)) continue;
      const speaking = tick <= u.endTick;
      const remaining = u.fadeTick - tick;
      out.set(u.playerId, {
        text: u.text,
        speaking,
        alpha: speaking ? 1 : Math.max(0, Math.min(1, remaining / FADE_TICKS))
      });
    }
    return out.size ? out : null;
  }

  /**
   * Rows for the 3D sidebar: one per speaker, in roster order where mapped.
   *
   * Unmapped speakers are kept here (unlike the map captions) because a coach
   * who is not on the server still belongs in a list of who is talking.
   */
  function sidebarRows(tick) {
    if (!state.enabled || !state.timeline || !state.file) return null;
    const speakers = state.file.manifest.speakers;
    const lines = speakerLines(state.timeline, tick, speakers.length);
    const mapping = state.meta?.mapping || {};
    const roster = players?.() || [];
    return speakers.map((s, i) => {
      const playerId = mapping[s.uid] || null;
      const player = playerId ? roster.find((p) => p.id === playerId) : null;
      return {
        uid: s.uid,
        name: player?.name || s.nickname,
        team: player?.team ?? null,
        playerId,
        text: lines[i]?.text || '',
        speaking: Boolean(lines[i]?.speaking),
        ageTicks: lines[i]?.ageTicks ?? Infinity
      };
    });
  }

  return {
    state,
    load,
    loadMeta,
    loadFile,
    rebuild,
    linesAt,
    sidebarRows,
    resolveAnchorTick,
    demoRounds,
    tickRate,
    get attached() {
      return Boolean(state.meta);
    },
    /** Loaded and aligned, so the renderers have something to draw. */
    get placed() {
      return Boolean(state.timeline);
    },
    /**
     * Attached and loaded, but with nowhere to put it.
     *
     * The countdown was not found and nobody has picked one by hand. Worth
     * distinguishing from "off": the button must not claim comms are on while
     * the map stays silent, or the feature reads as broken rather than as one
     * click from working.
     */
    get needsSync() {
      return Boolean(state.meta) && Boolean(state.file) && !state.timeline;
    },
    setEnabled(on) {
      state.enabled = Boolean(on);
      onChange?.();
    },
    /** Replace local state after the dialog changes something server-side. */
    applyMeta(meta) {
      state.meta = meta || null;
      if (!meta) {
        state.file = null;
        state.timeline = null;
      }
      return rebuild();
    },
    reset() {
      state.file = null;
      state.timeline = null;
      state.error = '';
    }
  };
}

/**
 * The 3D comms sidebar, as HTML.
 *
 * A function rather than inline markup in the viewer so it can be tested: this
 * is the only place comms appear in 3D, and "did the right name end up on the
 * right row" is not a question a screenshot answers well.
 *
 * @param {ReturnType<createCommsController>['sidebarRows']} rows
 * @param {(s: string) => string} escapeHtml
 * @param {{1?: string, 2?: string}} [teamSides] team number -> 'T' | 'CT'
 */
export function commsSidebarHtml(rows, escapeHtml, teamSides = {}) {
  return (rows || [])
    .map((r) => {
      const side = r.team ? teamSides[r.team] || '' : '';
      return `
        <div class="rv-comms-row${r.speaking ? ' is-live' : ''}"${
          side ? ` data-side="${escapeHtml(side)}"` : ''
        }>
          <span class="rv-comms-dot"></span>
          <span class="rv-comms-name">${escapeHtml(r.name)}</span>
          <span class="rv-comms-said">${escapeHtml(r.text)}</span>
        </div>`;
    })
    .join('');
}

/** Cheap identity for the sidebar: only rebuild the DOM when this changes. */
export function commsSidebarKey(rows) {
  return (rows || []).map((r) => `${r.uid}|${r.speaking ? 1 : 0}|${r.text}`).join('');
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const mmss = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** A transcript-only session is kilobytes; one with voice is megabytes. */
const fileSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

/**
 * Open the attach dialog.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host      where to mount the dialog
 * @param {ReturnType<createCommsController>} opts.controller
 * @param {string} opts.demoId
 * @param {() => Array} opts.players
 * @param {() => void} [opts.onDone]
 */
export function openCommsDialog({ host, controller, demoId, players, onDone }) {
  const wrap = document.createElement('div');
  wrap.className = 'rv-comms-dialog';
  wrap.innerHTML = `
    <div class="rv-comms-panel" role="dialog" aria-label="Voice comms">
      <div class="rv-comms-head">
        <span class="rv-comms-title">Voice comms</span>
        <button type="button" class="rp-btn-icon" data-comms-close aria-label="Close">✕</button>
      </div>
      <div class="rv-comms-body" data-comms-body></div>
    </div>`;

  const body = wrap.querySelector('[data-comms-body]');
  let busy = false;

  function close() {
    wrap.remove();
    onDone?.();
  }

  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-comms-close]')) close();
  });

  function setBusy(on, msg = '') {
    busy = on;
    wrap.classList.toggle('is-busy', on);
    if (msg) status(msg);
  }

  function status(msg, isError = false) {
    const el = body.querySelector('[data-comms-status]');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', Boolean(isError));
  }

  // ---- empty state: the drop zone -----------------------------------------

  function renderDropZone() {
    body.innerHTML = `
      <div class="rv-comms-drop" data-comms-drop tabindex="0" role="button">
        <strong>Drop a recording here</strong>
        <span>.aim4comms from the recorder</span>
      </div>
      <input type="file" accept=".aim4comms" hidden data-comms-input />
      <p class="rv-comms-get" data-comms-get hidden></p>
      <p class="rv-comms-status" data-comms-status></p>`;

    const drop = body.querySelector('[data-comms-drop]');
    const input = body.querySelector('[data-comms-input]');
    void offerRecorder();

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', () => {
      if (input.files?.[0]) void upload(input.files[0]);
    });
    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.remove('is-over');
      });
    }
    drop.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) void upload(file);
    });
  }

  /**
   * Point whoever has no recording at the thing that makes one.
   *
   * This dialog is where someone finds out they need the recorder, so it is
   * where the download belongs. Stays hidden when no build is published rather
   * than showing a dead link, and the whole thing is best-effort: failing to
   * reach the update feed must never get in the way of dropping a file.
   */
  async function offerRecorder() {
    const el = body.querySelector('[data-comms-get]');
    if (!el) return;
    const latest = await fetchRecorderLatest().catch(() => null);
    if (!latest || !el.isConnected) return;
    const mb = latest.sizeBytes ? ` · ${(latest.sizeBytes / 1024 / 1024).toFixed(0)} MB` : '';
    el.hidden = false;
    el.innerHTML = `No recording yet? <a href="${esc(
      recorderDownloadUrl()
    )}" download>Get the recorder</a> <span>v${esc(latest.version)}${mb}</span>`;
  }

  async function upload(file) {
    if (busy) return;
    setBusy(true);
    status(`Uploading ${file.name}…`);
    try {
      const res = await uploadDemoComms(demoId, file);
      controller.state.identities = res?.identities || controller.state.identities;
      controller.reset();
      await controller.applyMeta(res.comms);
      await controller.loadFile();
      // A file whose anchor the recorder already found, with speakers we have
      // seen before, needs nothing from the user: resolve and save it now so
      // the common case is drop-and-done.
      await autoAttach();
      renderAttached();
    } catch (err) {
      status(err?.message || 'That file could not be read.', true);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fill in what can be known without asking: the anchor tick, and any speaker
   * this library has mapped before.
   */
  async function autoAttach() {
    const meta = controller.state.meta;
    if (!meta) return;
    const patch = {};
    if (!Number.isFinite(meta.anchorTick)) {
      const tick = await controller.resolveAnchorTick();
      if (tick !== null) patch.anchorTick = tick;
    }
    if (!Object.keys(meta.mapping || {}).length) {
      const remembered = controller.state.identities || {};
      const known = {};
      for (const s of meta.speakers) {
        if (remembered[s.uid]?.playerId) known[s.uid] = remembered[s.uid].playerId;
      }
      if (Object.keys(known).length) patch.mapping = known;
    }
    if (!Object.keys(patch).length) return;
    const res = await saveDemoCommsAttachment(demoId, patch);
    await controller.applyMeta(res.comms);
  }

  // ---- attached state ------------------------------------------------------

  function renderAttached() {
    const meta = controller.state.meta;
    if (!meta) {
      renderDropZone();
      return;
    }
    const manifest = controller.state.file?.manifest || null;
    const roster = players?.() || [];
    const mapping = meta.mapping || {};
    const anchored = Number.isFinite(meta.anchorTick) && meta.sync?.anchorMs !== null;

    const speakerRows = meta.speakers
      .map((s, i) => {
        const options = [`<option value="">Not mapped</option>`]
          .concat(
            roster.map(
              (p) =>
                `<option value="${esc(p.id)}"${mapping[s.uid] === p.id ? ' selected' : ''}>${esc(
                  p.name || p.id
                )}</option>`
            )
          )
          .join('');
        return `
          <div class="rv-comms-row">
            <span class="rv-comms-speaker">
              <strong>${esc(s.nickname)}</strong>
              <span class="rv-comms-talk">${mmss(s.talkMs)} talking</span>
            </span>
            <select class="site-select" data-comms-map="${esc(s.uid)}" data-index="${i}">
              ${options}
            </select>
          </div>`;
      })
      .join('');

    body.innerHTML = `
      <div class="rv-comms-file">
        <strong>${esc(meta.name)}</strong>
        <span>${esc(meta.lang || 'auto')} · ${meta.utteranceCount} lines · ${fileSize(
          meta.sizeBytes
        )}${meta.hasAudio ? ' · with audio' : ''}</span>
      </div>

      <div class="rv-comms-sync ${anchored ? 'is-ok' : 'is-warn'}">
        <span class="rv-comms-sync-label">Sync</span>
        <span data-comms-sync-text>${
          anchored
            ? `Countdown at ${mmss(meta.sync.anchorMs)}, pinned to round 1 going live.`
            : 'No countdown found. Pick the moment below.'
        }</span>
        <span class="rv-comms-nudge">
          <button type="button" class="btn btn-sm" data-comms-nudge="-1000">-1s</button>
          <button type="button" class="btn btn-sm" data-comms-nudge="-100">-0.1s</button>
          <span data-comms-offset>${((meta.offsetMs || 0) / 1000).toFixed(1)}s</span>
          <button type="button" class="btn btn-sm" data-comms-nudge="100">+0.1s</button>
          <button type="button" class="btn btn-sm" data-comms-nudge="1000">+1s</button>
        </span>
      </div>

      ${manifest ? candidatesHtml(manifest, meta) : ''}

      <div class="rv-comms-map">${speakerRows}</div>

      <div class="rv-comms-actions">
        <button type="button" class="btn" data-comms-detach>Remove</button>
        <button type="button" class="btn" data-comms-replace>Replace</button>
        <button type="button" class="btn primary" data-comms-close>Done</button>
      </div>
      <p class="rv-comms-status" data-comms-status></p>`;

    body.querySelectorAll('[data-comms-map]').forEach((sel) => {
      sel.addEventListener('change', () => void saveMapping());
    });
    body.querySelectorAll('[data-comms-nudge]').forEach((btn) => {
      btn.addEventListener('click', () => void nudge(Number(btn.dataset.commsNudge)));
    });
    body.querySelector('[data-comms-detach]')?.addEventListener('click', () => void detach());
    body.querySelector('[data-comms-replace]')?.addEventListener('click', renderDropZone);
    body.querySelectorAll('[data-comms-pick]').forEach((btn) => {
      btn.addEventListener('click', () => void pickAnchor(Number(btn.dataset.commsPick)));
    });
  }

  /**
   * Other countdowns in the recording, offered when the automatic pick is
   * missing or wrong. Nothing is listed when the recorder found a cued
   * countdown and there is only one: a chooser with one option is noise.
   */
  function candidatesHtml(manifest, meta) {
    const words = [];
    for (const u of manifest.utterances) {
      // Rebuild an approximate word stream from utterance text so the viewer
      // can offer candidates even though it never sees Whisper's word timings.
      const parts = String(u.text).split(/\s+/).filter(Boolean);
      const step = (u.endMs - u.startMs) / Math.max(1, parts.length);
      parts.forEach((w, i) => words.push({ word: w, startMs: u.startMs + i * step }));
    }
    const found = findCountdowns(words, manifest.lang || 'en');
    if (found.length < 2 && meta.sync?.detected) return '';
    if (!found.length) return '';
    const rows = found
      .map(
        (c) =>
          `<button type="button" class="rv-comms-cand${
            Math.abs((meta.sync?.anchorMs ?? -1) - c.anchorMs) < 200 ? ' is-active' : ''
          }" data-comms-pick="${c.anchorMs}">
             ${mmss(c.atMs)} <span>${esc(c.text)}${c.cued ? '' : ' (no cue)'}</span>
           </button>`
      )
      .join('');
    return `<div class="rv-comms-cands"><span>Countdowns found</span>${rows}</div>`;
  }

  async function pickAnchor(anchorMs) {
    if (busy) return;
    setBusy(true);
    try {
      const tick = await controller.resolveAnchorTick();
      const res = await saveDemoCommsAttachment(demoId, {
        anchorMs,
        anchorTick: tick,
        offsetMs: 0
      });
      await controller.applyMeta(res.comms);
      // The manifest's own anchor moved, so the decoded file has to follow.
      if (controller.state.file) controller.state.file.manifest.sync.anchorMs = anchorMs;
      await controller.rebuild();
      renderAttached();
    } catch (err) {
      status(err?.message || 'Could not set the sync point.', true);
    } finally {
      setBusy(false);
    }
  }

  async function saveMapping() {
    const mapping = {};
    body.querySelectorAll('[data-comms-map]').forEach((sel) => {
      if (sel.value) mapping[sel.dataset.commsMap] = sel.value;
    });
    setBusy(true);
    try {
      const res = await saveDemoCommsAttachment(demoId, { mapping });
      await controller.applyMeta(res.comms);
      status('Saved.');
    } catch (err) {
      status(err?.message || 'Could not save the mapping.', true);
    } finally {
      setBusy(false);
    }
  }

  async function nudge(deltaMs) {
    const next = (controller.state.meta?.offsetMs || 0) + deltaMs;
    setBusy(true);
    try {
      const res = await saveDemoCommsAttachment(demoId, { offsetMs: next });
      await controller.applyMeta(res.comms);
      const el = body.querySelector('[data-comms-offset]');
      if (el) el.textContent = `${((res.comms.offsetMs || 0) / 1000).toFixed(1)}s`;
    } catch (err) {
      status(err?.message || 'Could not nudge the sync.', true);
    } finally {
      setBusy(false);
    }
  }

  async function detach() {
    setBusy(true);
    try {
      await deleteDemoComms(demoId);
      controller.reset();
      await controller.applyMeta(null);
      renderDropZone();
    } catch (err) {
      status(err?.message || 'Could not remove the comms.', true);
    } finally {
      setBusy(false);
    }
  }

  host.appendChild(wrap);
  if (controller.attached) {
    renderAttached();
    void controller.loadFile().then(() => {
      if (wrap.isConnected) renderAttached();
    });
  } else {
    renderDropZone();
  }

  return { close, el: wrap };
}
