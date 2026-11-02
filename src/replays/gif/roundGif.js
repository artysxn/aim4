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
// saved to Bookmarks > Visual Notes with the round's metadata.
//
// Nothing here touches the viewer on screen, so a 3D clip can be made while the
// person stays in 2D. Several clips of one round can share a scene
// (openRoundScene), since booting the map is most of the wait.
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundTicks } from '../api.js';
import { TickTrack } from '../tickStore.js';
import { RadarRenderer } from '../viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { ROUND_SECONDS, clockAt, timingFor } from '../viewer/roundClock.js';
import { cs3dMap } from '../../../shared/cs3d/maps.js';
import { DEFAULT_QUALITY, MAX_SECONDS, clampFps, frameTicks, outputSize } from './gifCore.js';
import { gifMetaFromRound, mapNameOf } from './gifMeta.js';
import { captureClip, saveGifFitting } from './gifCapture.js';
import { overviewPose } from './perspectives.js';

/** The radar's own pixel size: an offscreen 2D GIF's full resolution. */
const RADAR_PX = 1024;
/** The offscreen 3D view, in canvas pixels (pixel ratio 1): a 3D GIF's full resolution. */
export const VIEW_3D = { width: 1920, height: 1080 };
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

/** Close in on one place on the map: where a grenade came down. */
function frameOnPoint(renderer, at, mapCode, size) {
  const pt = worldToRadar(mapCode, at.x, at.y, { x: 0, y: 0 });
  const zoom = 2.6;
  const scale = (size / RADAR_SIZE) * zoom;
  renderer.zoom = zoom;
  renderer.panX = size / 2 - pt.x * scale - (size - RADAR_SIZE * scale) / 2;
  renderer.panY = size / 2 - pt.y * scale - (size - RADAR_SIZE * scale) / 2;
}

/** Where everyone alive is during the clip, a couple of dozen samples across it. */
function clipPoints(track, ticks) {
  const points = [];
  const states = [];
  const step = Math.max(1, Math.floor(ticks.length / 24));
  for (let i = 0; i < ticks.length; i += step) {
    track.sampleAll(ticks[i], states);
    for (const s of states) {
      if (s?.alive) points.push({ x: s.x, y: s.y, z: s.z });
    }
  }
  return points;
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
 * @param {{ meta: object, track: object }} [opts.round]  the round already loaded, every tick of it
 * @param {object} [opts.scene]       from openRoundScene: this round's 3D scene, left open afterwards
 * @param {boolean} [opts.clock]      false: no round clock on the picture
 * @param {string} [opts.from]
 * @param {string} [opts.to]
 * @param {number} [opts.fps]
 * @param {number} [opts.quality]     1, 2 or 3
 * @param {'players'|'map'|{ focus: { x: number, y: number } }} [opts.view]
 *   2D: frame on the players (default), the whole map, or close in on one place
 * @param {{ player?: string|number, mode?: 'pov'|'third', pose?: object, overview?: boolean }} [opts.camera]
 *   3D: a player, a camera held at a pose (view3d.setFreeCamera), or one above the action
 * @param {{ view?: string, label?: string }} [opts.perspective]  what this clip is called in its note
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
  const { meta, track } = opts.round || (await loadFullRound(file));
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
  const quality = Math.max(1, Math.min(3, Math.round(Number(opts.quality) || DEFAULT_QUALITY)));
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
    if (opts.view?.focus) frameOnPoint(renderer, opts.view.focus, meta.map, RADAR_PX);
    else if (opts.view !== 'map') frameOnClip(renderer, track, ticks, meta.map, RADAR_PX);
    size = outputSize('2d', quality, RADAR_PX, RADAR_PX);
    const states = [];
    blob = await captureClip({
      count: ticks.length,
      fps,
      palette: 'global',
      size,
      stampClock: opts.clock,
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
    const pose = opts.camera?.overview ? overviewPose(clipPoints(track, ticks)) : opts.camera?.pose || null;
    if ((opts.camera?.overview || opts.camera?.pose) && !pose) throw new Error('There is nothing to point that camera at.');
    follow = pose ? null : playerOf(meta, opts.camera?.player) || defaultPlayer(meta, fromTick, toTick);
    if (follow && !track.sample(follow.slot, ticks[0], {})?.alive) {
      throw new Error(`${follow.name || 'That player'} is already dead at ${label(ticks[0])}.`);
    }
    const scene = opts.scene || (opts.onProgress?.('Loading the 3D map'), await openRoundScene({ meta, track }));
    let shot;
    try {
      shot = await capture3d({
        scene,
        ticks,
        fps,
        quality,
        follow,
        camMode: opts.camera?.mode,
        pose,
        xray: Boolean(opts.camera?.overview),
        label,
        progress,
        clock: opts.clock,
        signal: opts.signal
      });
    } finally {
      if (!opts.scene) scene.close();
    }
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
    view: opts.perspective?.view || (kind === '2d' ? 'map' : follow ? (opts.camera?.mode === 'third' ? 'third' : 'pov') : 'free'),
    label: opts.perspective?.label || '',
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

/**
 * A round's 3D scene in an offscreen box, for one clip or several.
 *
 * @param {{ meta: object, track: object }} round
 * @returns {Promise<{ v3: object, frameAt: (tick: number) => object, close: () => void }>}
 */
export async function openRoundScene({ meta, track }) {
  const slug = cs3dMap(meta.map)?.slug;
  if (!slug) throw new Error(`${mapNameOf(meta.map)} has no 3D map.`);
  const timing = timingFor(meta);
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
  const close = () => {
    v3.endCapture?.();
    v3.dispose();
    host.remove();
  };
  const states = [];
  /** Each clip reads as a round of its own to the scene, which clears what the last one left on the walls. */
  let clipIndex = 0;
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
      roundKey: `${meta.file || ''}#${clipIndex}`,
      stats: meta.stats || {},
      clock: clockAt(timing, tick).seconds,
      scoreT: 0,
      scoreCt: 0
    };
  };
  /** What a player holds over these ticks, first held first. */
  const weaponsOf = (slot, ticks) => {
    const seen = new Set();
    const out = {};
    for (const tick of ticks) {
      const s = track.sample(slot, tick, out);
      const name = s?.alive ? meta.weapons?.[s.weapon] : '';
      if (name) seen.add(name);
    }
    return [...seen];
  };
  const sideOf = (slot, tick) => track.sample(slot, tick, {})?.side || '';
  try {
    const starting = v3.start(host);
    v3.show();
    await starting;
    if (v3.failed || !v3.ready) throw new Error(`The 3D view could not start${v3.failed ? `: ${v3.failed}` : ''}.`);
    return { v3, frameAt, weaponsOf, sideOf, nextClip: () => clipIndex++, close };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * One clip from a scene: one frame per tick, on the clip's own clock, through one player's eyes when there is one,
 * or from a camera held in one place.
 */
async function capture3d({ scene, ticks, fps, quality, follow, camMode, pose, xray, label, progress, clock: stampClock, signal }) {
  const { v3, frameAt, weaponsOf, sideOf, nextClip } = scene;
  // Bullet holes and bodies from the clip before do not carry into this one.
  nextClip();
  v3.setFrame(frameAt(ticks[0]));
  if (pose) {
    v3.setFreeCamera(pose);
  } else if (follow) {
    v3.setMode(camMode === 'third' ? 'third' : 'pov');
    await v3.prepareCapture({ weapons: weaponsOf(follow.slot, ticks), side: sideOf(follow.slot, ticks[0]) });
  }
  v3.setXray(xray);
  v3.beginCapture({ pov: follow ? follow.slot : null });
  try {
    const size = outputSize('3d', quality, v3.canvas.width || VIEW_3D.width, v3.canvas.height || VIEW_3D.height);
    let clock = 1000;
    const blob = await captureClip({
      count: ticks.length,
      fps,
      palette: 'local',
      size,
      stampClock,
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
    v3.endCapture();
    v3.setXray(false);
  }
}
