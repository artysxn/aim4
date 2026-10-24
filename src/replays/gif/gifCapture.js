// ---------------------------------------------------------------------------
// replays/gif/gifCapture.js
// Turning drawn frames into a GIF: draw frame i, copy the chosen part of the
// canvas down to the GIF's size, stamp the round clock on it, hand it to the
// encoder. The caller decides what "draw frame i" means (the viewer's radar,
// the viewer's 3D scene, an offscreen radar for aim4 eye); this file only
// knows canvases and pixels.
// ---------------------------------------------------------------------------

import { createGifEncoder } from './gifEncoder.js';
import { publicOrigin } from '../../site/publicOrigin.js';

/** A canvas to scale frames into: offscreen when the browser has one. */
function scratchCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * The round clock in the top left corner: a GIF passed around on its own still
 * says when in the round it is.
 */
export function stampClock(ctx, text, width) {
  if (!text) return;
  const size = Math.max(11, Math.round(width / 42));
  ctx.save();
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  const padX = Math.round(size * 0.6);
  const h = Math.round(size * 1.7);
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const m = Math.round(size * 0.6);
  ctx.fillStyle = 'rgba(5, 5, 5, 0.72)';
  ctx.fillRect(m, m, w, h);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillText(text, m + padX, m + h / 2 + 1);
  ctx.restore();
}

/**
 * Capture a clip.
 *
 * @param {object} opts
 * @param {number} opts.count           how many frames
 * @param {number} opts.fps
 * @param {'global'|'local'} opts.palette  global for the radar, local for 3D
 * @param {{ width: number, height: number }} opts.size  the GIF's size
 * @param {(i: number) => Promise<{ source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number,
 *          clock?: string, flash?: number, overlays?: CanvasImageSource[] }>} opts.drawFrame
 *        draws frame i and says where it is; called in order, and the copy
 *        happens in the same task as the draw (a WebGL/WebGPU canvas keeps its
 *        picture only until the task ends)
 * @param {boolean} [opts.stampClock]   write the round clock on each frame
 * @param {(done: number, total: number, phase: 'draw'|'encode') => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Blob>}
 */
export async function captureGif(opts) {
  const { count, fps, palette, size, drawFrame, onProgress, signal } = opts;
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const canvas = scratchCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  let encoded = 0;
  const encoder = createGifEncoder({
    width,
    height,
    fps,
    palette,
    onProgress: (n) => {
      encoded = n;
      onProgress?.(n, count, 'encode');
    }
  });
  const aborted = () => {
    if (!signal?.aborted) return false;
    encoder.cancel();
    return true;
  };

  /** Draw frame i into the scratch canvas and read it back. */
  const frameAt = async (i) => {
    const f = await drawFrame(i);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(f.source, f.sx, f.sy, f.sw, f.sh, 0, 0, width, height);
    for (const o of f.overlays || []) {
      if (o) ctx.drawImage(o, 0, 0, width, height);
    }
    if (f.flash > 0.002) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, f.flash);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    if (opts.stampClock !== false) stampClock(ctx, f.clock, width);
    return ctx.getImageData(0, 0, width, height).data;
  };

  try {
    if (palette !== 'local' && count > 1) {
      // One palette for the whole radar clip, from five frames across it, so a
      // smoke or a bomb that appears late still has its colours.
      const picks = [...new Set([0, 0.25, 0.5, 0.75, 1].map((k) => Math.round(k * (count - 1))))];
      const samples = [];
      for (const i of picks) {
        if (aborted()) throw new DOMException('Cancelled', 'AbortError');
        samples.push(new Uint8Array((await frameAt(i)).buffer.slice(0)));
      }
      encoder.setPalette(samples);
    }
    for (let i = 0; i < count; i++) {
      if (aborted()) throw new DOMException('Cancelled', 'AbortError');
      const rgba = await frameAt(i);
      onProgress?.(i + 1, count, 'draw');
      await encoder.addFrame(rgba);
    }
    if (aborted()) throw new DOMException('Cancelled', 'AbortError');
    onProgress?.(encoded, count, 'encode');
    return await encoder.finish();
  } catch (err) {
    encoder.cancel();
    throw err;
  }
}

/** A file name that says what the GIF is: aim4-mirage-r14-1m30.gif */
export function gifFileName(meta) {
  const part = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const bits = ['aim4', part(meta?.mapName || meta?.map), meta?.round ? `r${meta.round}` : '', part(String(meta?.clockFrom || '').replace(':', 'm'))];
  return `${bits.filter(Boolean).join('-') || 'aim4'}.gif`;
}

/** Hand a Blob to the browser's downloads. */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The share link: the GIF itself, on aim4's own address, so it embeds wherever it is pasted. */
export function gifShareUrl(id) {
  return `${publicOrigin()}/g/${id}.gif`;
}

/** The share page: the GIF with its title and description. */
export function gifPageUrl(id) {
  return `${publicOrigin()}/g/${id}`;
}
