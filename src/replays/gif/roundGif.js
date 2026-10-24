// ---------------------------------------------------------------------------
// replays/gif/roundGif.js
// A GIF of part of a round without the viewer open: what aim4 eye and the
// antistrat creator call to put a highlight in a chat or a document.
//
// 2D draws the round on an offscreen radar with the viewer's own
// RadarRenderer, framed on where the players go during the clip, the same
// way screenshot_round frames a single moment. 3D boots the viewer's 3D scene
// in an offscreen box at a fixed size, follows a player in first or third
// person, and captures it on the clip's own clock. Either way the result is
// saved to Bookmarks > Saved GIFs with the round's metadata.
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundTicks } from '../api.js';
import { TickTrack } from '../tickStore.js';
import { RadarRenderer } from '../viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { ROUND_SECONDS, clockAt, timingFor } from '../viewer/roundClock.js';
import { cs3dMap } from '../../../shared/cs3d/maps.js';
import { MAX_SECONDS, clampFps, frameTicks, outputSize } from './gifCore.js';
import { gifMetaFromRound, mapNameOf } from './gifMeta.js';
import { captureGif, saveGifFitting } from './gifCapture.js';

/** The radar's own pixel size: an offscreen 2D GIF's full resolution. */
const RADAR_PX = 1024;
/** The offscreen 3D view, in canvas pixels (pixel ratio 1): a 3D GIF's full resolution. */
const VIEW_3D = { width: 1280, height: 720 };
const DEFAULT_SECONDS = 8;

/** Full-detail rounds, a few kept: a document's highlights often come from one match. */
const cache = new Map();
async function loadFullRound(file) {
  if (cache.has(file)) return cache.get(file);
  const job = (async () => {
    const [meta, buf] = await Promise.all([fetchRoundMeta(file), fetchRoundTicks(file, 1)]);
    if (!meta || !buf) throw new Error(`Round "${file}" could not be loaded.`);
    return { meta: { ...meta, file: meta.file || file }, track: new TickTrack(buf) };
  })();
  cache.set(file, job);
  job.catch(() => cache.delete(file));
  while (cache.size > 3) cache.delete(cache.keys().next().value);
  return job;
}

/** "1:20" -> seconds left on the clock, or null. */
function parseClock(text) {
  const t = String(text ?? '').trim().replace('.', ':');
  if (!t) return null;
  const m = /^(\d+):(\d{1,2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The tick a live-round clock reading falls on (1:55 is the start of the round). */
export function tickAtClock(meta, clock) {
  const left = parseClock(clock);
  if (left == null) return null;
  const t = timingFor(meta);
  const s = Math.max(0, Math.min(ROUND_SECONDS, left));
  return t.freezeEndTick + (ROUND_SECONDS - s) * t.tickRate;
}

/**
 * Zoom the radar onto everywhere the players go during the clip, so names
 * stay readable and the map's empty corners stay out.
 */
function frameOnClip(renderer, track, ticks, mapCode, size) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const pt = { x: 0, y: 0 };
  const states = [];
  const step = Math.max(1, Math.floor(ticks.length / 24));
  for (let i = 0; i < ticks.length; i += step) {
    track.sampleAll(ticks[i], states);
    for (const s of states) {
      if (!s?.alive) continue;
      worldToRadar(mapCode, s.x, s.y, pt);
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }
  }
  if (!Number.isFinite(minX)) return;
  const pad = 70;
  const span = Math.max(maxX - minX + pad * 2, maxY - minY + pad * 2, RADAR_SIZE * 0.3);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const zoom = Math.max(1, Math.min(3, RADAR_SIZE / span));
  const scale = (size / RADAR_SIZE) * zoom;
  renderer.zoom = zoom;
  renderer.panX = size / 2 - cx * scale - (size - RADAR_SIZE * scale) / 2;
  renderer.panY = size / 2 - cy * scale - (size - RADAR_SIZE * scale) / 2;
}

/** A player by slot or by name (any part of it, any case). */
function playerOf(meta, who) {
  const players = meta.players || [];
  if (who === undefined || who === null || who === '') return null;
  const n = Number(who);
  if (Number.isInteger(n) && players.some((p) => p.slot === n)) return players.find((p) => p.slot === n);
  const q = String(who).trim().toLowerCase();
  return players.find((p) => String(p.name || '').toLowerCase() === q) || players.find((p) => String(p.name || '').toLowerCase().includes(q)) || null;
}

const sideOfPlayer = (meta, p) => (p ? (p.team === 1 ? meta.team1Side : meta.team2Side) || '' : '');

/** With nobody named, a 3D clip follows whoever gets the first kill in it, else the first T. */
function defaultPlayer(meta, fromTick, toTick) {
  const kill = (meta.events?.kills || []).find((k) => k.tick >= fromTick && k.tick <= toTick);
  const players = meta.players || [];
  if (kill) {
    const p = players.find((x) => x.id === kill.attacker);
    if (p) return p;
  }
  return players.find((p) => sideOfPlayer(meta, p) === 'T') || players[0] || null;
}

/**
 * Make a GIF of part of a round, and save it to Bookmarks.
 *
 * @param {object} opts
 * @param {string} opts.file          a round file
 * @param {'2d'|'3d'} [opts.kind]
 * @param {number} [opts.fromTick]    or `from` as a round clock ("1:20")
 * @param {number} [opts.toTick]      or `to`
 * @param {string} [opts.from]
 * @param {string} [opts.to]
 * @param {number} [opts.fps]
 * @param {number} [opts.quality]     1, 2 or 3
 * @param {'players'|'map'} [opts.view]   2D: frame on the players (default) or the whole map
 * @param {{ player?: string|number, mode?: 'pov'|'third' }} [opts.camera]  3D
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 * @param {'viewer'|'eye'|'antistrat'} [opts.source]
 * @param {boolean} [opts.save]       false: make it, do not keep it
 * @param {(text: string) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function makeRoundGif(opts) {
  const file = String(opts.file || '').trim();
  if (!file) throw new Error('Name the round.');
  const kind = opts.kind === '3d' ? '3d' : '2d';
  const { meta, track } = await loadFullRound(file);
  const timing = timingFor(meta);
  const clamp = (t) => Math.max(timing.startTick, Math.min(timing.officialEndTick, t));
  let fromTick = Number.isFinite(opts.fromTick) ? opts.fromTick : tickAtClock(meta, opts.from);
  if (fromTick == null) fromTick = timing.freezeEndTick;
  let toTick = Number.isFinite(opts.toTick) ? opts.toTick : tickAtClock(meta, opts.to);
  if (toTick == null) toTick = fromTick + DEFAULT_SECONDS * timing.tickRate;
  fromTick = clamp(fromTick);
  toTick = clamp(toTick);
  if (toTick < fromTick) [fromTick, toTick] = [toTick, fromTick];
  if (toTick - fromTick < timing.tickRate / 2) toTick = clamp(fromTick + DEFAULT_SECONDS * timing.tickRate);
  const fps = clampFps(kind, opts.fps);
  const quality = Math.max(1, Math.min(3, Math.round(Number(opts.quality) || 1)));
  const ticks = frameTicks({ fromTick, toTick, tickRate: timing.tickRate, fps, kind });
  const label = (t) => clockAt(timing, t).label;
  const progress = (done, total, phase) =>
    opts.onProgress?.(phase === 'draw' ? `Drawing frame ${done} of ${total}` : `Encoding frame ${done} of ${total}`);

  let blob;
  let size;
  let follow = null;
  if (kind === '2d') {
    const canvas = document.createElement('canvas');
    const renderer = new RadarRenderer(canvas);
    renderer.dpr = 1;
    renderer.showNames = true;
    renderer.showWeapons = true;
    await renderer.setMap(meta.map);
    if (opts.view !== 'map') frameOnClip(renderer, track, ticks, meta.map, RADAR_PX);
    size = outputSize('2d', quality, RADAR_PX, RADAR_PX);
    const states = [];
    blob = await captureGif({
      count: ticks.length,
      fps,
      palette: 'global',
      size,
      signal: opts.signal,
      onProgress: progress,
      drawFrame: async (i) => {
        track.sampleAll(ticks[i], states);
        renderer.render({
          tick: ticks[i],
          tickRate: timing.tickRate,
          states,
          players: meta.players || [],
          allPlayers: meta.players || [],
          events: meta.events || {},
          weapons: meta.weapons || [],
          teamSides: { 1: meta.team1Side, 2: meta.team2Side },
          compact: false,
          mapAlpha: 0.9,
          pixelSize: { w: RADAR_PX, h: RADAR_PX }
        });
        return { source: canvas, sx: 0, sy: 0, sw: RADAR_PX, sh: RADAR_PX, clock: label(ticks[i]) };
      }
    });
  } else {
    const slug = cs3dMap(meta.map)?.slug;
    if (!slug) throw new Error(`${mapNameOf(meta.map)} has no 3D map.`);
    follow = playerOf(meta, opts.camera?.player) || defaultPlayer(meta, fromTick, toTick);
    opts.onProgress?.('Loading the 3D map');
    const shot = await capture3d({ meta, track, timing, ticks, fps, quality, slug, follow, camMode: opts.camera?.mode, label, progress, signal: opts.signal });
    blob = shot.blob;
    size = shot.size;
  }

  const gifMeta = gifMetaFromRound(meta, {
    kind,
    file,
    fromTick: ticks[0],
    toTick: ticks[ticks.length - 1],
    clockFrom: label(ticks[0]),
    clockTo: label(ticks[ticks.length - 1]),
    side: sideOfPlayer(meta, follow),
    player: follow?.name || '',
    title: opts.title,
    description: opts.description,
    source: opts.source || 'eye'
  });
  let gif = null;
  let saveError = null;
  if (opts.save !== false) {
    opts.onProgress?.('Saving to Bookmarks');
    try {
      ({ gif } = await saveGifFitting(blob, gifMeta, {
        fps,
        palette: kind === '3d' ? 'local' : 'global',
        onShrink: () => opts.onProgress?.('Making a smaller copy for Bookmarks'),
        signal: opts.signal
      }));
    } catch (err) {
      saveError = err;
    }
  }
  return { blob, meta: gifMeta, gif, saveError, frames: ticks.length, size, seconds: (ticks[ticks.length - 1] - ticks[0]) / timing.tickRate, capped: toTick - fromTick > MAX_SECONDS[kind] * timing.tickRate };
}

/** The 3D scene in an offscreen box, one frame per tick on the clip's own clock. */
async function capture3d({ meta, track, timing, ticks, fps, quality, slug, follow, camMode, label, progress, signal }) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-${VIEW_3D.width * 4}px;top:0;width:${VIEW_3D.width}px;height:${VIEW_3D.height}px;pointer-events:none;overflow:hidden;`;
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  const { createView3d } = await import('../viewer/view3d.js');
  const v3 = createView3d({
    slug,
    pixelRatio: 1,
    sampleSlot: (slot, at, out) => track.sample(slot, at, out || {}),
    tickRange: () => ({ first: track.firstTick, last: track.lastTick, stride: track.stride })
  });
  const states = [];
  const frameAt = (tick) => {
    track.sampleAll(tick, states);
    return {
      tick,
      tickRate: timing.tickRate,
      states,
      players: meta.players || [],
      events: meta.events || {},
      weapons: meta.weapons || [],
      teamSides: { 1: meta.team1Side, 2: meta.team2Side },
      roundKey: meta.file || '',
      stats: meta.stats || {},
      clock: clockAt(timing, tick).seconds,
      scoreT: 0,
      scoreCt: 0
    };
  };
  try {
    const starting = v3.start(host);
    v3.show();
    await starting;
    if (v3.failed || !v3.ready) throw new Error(`The 3D view could not start${v3.failed ? `: ${v3.failed}` : ''}.`);
    v3.setFrame(frameAt(ticks[0]));
    if (follow) {
      v3.spectateSlot(follow.slot);
      v3.setMode(camMode === 'third' ? 'third' : 'pov');
    }
    v3.beginCapture();
    const size = outputSize('3d', quality, v3.canvas.width || VIEW_3D.width, v3.canvas.height || VIEW_3D.height);
    let clock = 1000;
    const blob = await captureGif({
      count: ticks.length,
      fps,
      palette: 'local',
      size,
      signal,
      onProgress: progress,
      drawFrame: async (i) => {
        v3.setFrame(frameAt(ticks[i]));
        const src = v3.captureFrame(clock);
        clock += 1000 / fps;
        return { source: src, sx: 0, sy: 0, sw: src.width, sh: src.height, clock: label(ticks[i]), flash: v3.flash, overlays: [v3.crosshairCanvas] };
      }
    });
    return { blob, size };
  } finally {
    v3.endCapture?.();
    v3.dispose();
    host.remove();
  }
}
