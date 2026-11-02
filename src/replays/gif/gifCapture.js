// ---------------------------------------------------------------------------
// replays/gif/gifCapture.js
// Turning drawn frames into a clip: draw frame i, copy the chosen part of the
// canvas down to the clip's size, stamp the round clock on it, hand it to the
// encoder. The caller decides what "draw frame i" means (the viewer's radar,
// the viewer's 3D scene, an offscreen radar for aim4 eye); this file only
// knows canvases and pixels.
//
// A clip is made as an MP4 from the frames themselves (captureClip). The server
// keeps that and makes a GIF from it when someone asks. Made as a GIF first, it
// would keep a GIF's 256 colours for good. A browser without H.264 encoding
// makes a GIF, and the server turns that into the MP4.
// ---------------------------------------------------------------------------

import { gifImageUrl, saveGif } from '../api.js';
import { MAX_GIF_BYTES } from './gifCore.js';
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

/** Paint one frame into the scratch canvas: the picture, what lies over it, the flash, the clock. */
function paintFrame(ctx, f, width, height, stamp) {
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
  if (stamp) stampClock(ctx, f.clock, width);
}

/** Frames waiting in the video encoder before the capture loop waits for it. */
const MAX_ENCODE_QUEUE = 6;
/** High, Main, then Baseline, at a level that takes any size the creator makes. */
const AVC_CODECS = ['avc1.640033', 'avc1.4D0033', 'avc1.420033'];
/**
 * Bits per pixel per frame. Generous: people read lineups off these. At 1235 x 683 and 24 FPS it is 10 Mbit/s,
 * about an eighth of what the same clip takes as a GIF.
 */
const VIDEO_BITS_PER_PIXEL = 0.5;

/** A configuration this browser can encode, or null. */
async function videoConfig(width, height, fps) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  // At most 12 Mbit/s, which 1080p does not need more of. At 20 an 8 second clip was 25 MB (encoders overshoot),
  // and 30 seconds came close to what Bookmarks keep.
  const bitrate = Math.round(Math.min(12e6, Math.max(2e6, width * height * fps * VIDEO_BITS_PER_PIXEL)));
  for (const codec of AVC_CODECS) {
    const config = { codec, width, height, framerate: fps, bitrate, bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      /* the next one */
    }
  }
  return null;
}

/**
 * Capture a clip as an MP4, or as a GIF where the browser cannot encode H.264 or the encoder gives out.
 * Takes what captureGif takes.
 *
 * @returns {Promise<Blob>} video/mp4 or image/gif
 */
export async function captureClip(opts) {
  // H.264 takes even sizes only.
  const width = Math.max(2, Math.round(opts.size.width) & ~1);
  const height = Math.max(2, Math.round(opts.size.height) & ~1);
  const config = await videoConfig(width, height, opts.fps);
  if (!config) return captureGif(opts);
  try {
    return await captureVideo(opts, config);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn('[gif] The video encoder failed, making a GIF instead:', err);
    return captureGif(opts);
  }
}

async function captureVideo(opts, config) {
  const { count, fps, drawFrame, onProgress, signal } = opts;
  const { width, height } = config;
  const { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } = await import('mediabunny');
  const canvas = scratchCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const target = new BufferTarget();
  // The index up front: a video that starts before it has all arrived.
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  let failed = null;
  let encoded = 0;
  let wake = null;
  /** Packets go into the file in order, one finished before the next starts. */
  let writing = Promise.resolve();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      writing = writing.then(() => source.add(packet, meta));
      writing.catch((err) => {
        failed ||= err;
      });
      onProgress?.(++encoded, count, 'encode');
    },
    error: (err) => {
      failed ||= err;
      wake?.();
    }
  });
  encoder.addEventListener('dequeue', () => wake?.());
  encoder.configure(config);
  const frameMicros = 1e6 / fps;

  try {
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failed) throw failed;
      const f = await drawFrame(i);
      paintFrame(ctx, f, width, height, opts.stampClock !== false);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameMicros), duration: Math.round(frameMicros) });
      // A key frame each second, so the video can be jumped around in.
      encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps)) === 0 });
      frame.close();
      onProgress?.(i + 1, count, 'draw');
      while (!failed && encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    }
    await encoder.flush();
    await writing;
    if (failed) throw failed;
    await output.finalize();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/**
 * Capture a clip as a GIF.
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
    paintFrame(ctx, await drawFrame(i), width, height, opts.stampClock !== false);
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

// ---- fitting Bookmarks ---------------------------------------------------------

/** A smaller copy aims at this share of what the server keeps, so it lands under it first time. */
const FIT_TARGET = 0.85;
/** Below this share of the original's width, every other frame goes too, so the picture keeps some size. */
const KEEP_EVERY_FRAME_ABOVE = 0.5;
const FIT_ATTEMPTS = 3;

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/**
 * A smaller copy of a GIF that fits in `maxBytes`: its frames decoded
 * (WebCodecs ImageDecoder), scaled down, and when scaling alone would leave
 * too small a picture, every other frame kept at twice the delay, so it plays
 * as long. Resolves null where the browser cannot decode GIF frames.
 *
 * @param {Blob} blob
 * @param {object} opts
 * @param {number} opts.fps          the original's frame rate
 * @param {'global'|'local'} [opts.palette]
 * @param {number} [opts.maxBytes]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<null | { blob: Blob, width: number, height: number, fps: number, frames: number }>}
 */
export async function shrinkGif(blob, { fps, palette = 'local', maxBytes = MAX_GIF_BYTES, onProgress, signal } = {}) {
  if (typeof ImageDecoder === 'undefined' || !blob) return null;
  try {
    if (ImageDecoder.isTypeSupported && !(await ImageDecoder.isTypeSupported('image/gif'))) return null;
  } catch {
    return null;
  }
  const decoder = new ImageDecoder({ data: blob.stream(), type: 'image/gif' });
  try {
    await decoder.completed;
    const count = decoder.tracks.selectedTrack?.frameCount || 0;
    if (!count) return null;
    const first = await decoder.decode({ frameIndex: 0 });
    const srcW = first.image.displayWidth;
    const srcH = first.image.displayHeight;
    first.image.close();

    let ratio = (maxBytes * FIT_TARGET) / blob.size;
    for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt++) {
      let step = 1;
      let scale = Math.sqrt(ratio);
      if (scale < KEEP_EVERY_FRAME_ABOVE && count > 2) {
        step = 2;
        scale = Math.sqrt(ratio * 2);
      }
      scale = Math.min(0.95, scale);
      const width = Math.max(64, Math.round(srcW * scale));
      const height = Math.max(36, Math.round((width * srcH) / srcW));
      const outFps = (Number(fps) || 15) / step;
      const picks = [];
      for (let i = 0; i < count; i += step) picks.push(i);

      const canvas = scratchCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const frameAt = async (i) => {
        const { image } = await decoder.decode({ frameIndex: i });
        ctx.drawImage(image, 0, 0, width, height);
        image.close();
        return ctx.getImageData(0, 0, width, height).data;
      };

      const encoder = createGifEncoder({ width, height, fps: outFps, palette });
      try {
        if (palette !== 'local' && picks.length > 1) {
          const samples = [];
          for (const k of [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => picks[Math.round(f * (picks.length - 1))]))]) {
            samples.push(new Uint8Array((await frameAt(k)).buffer.slice(0)));
          }
          encoder.setPalette(samples);
        }
        for (let n = 0; n < picks.length; n++) {
          if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
          await encoder.addFrame(await frameAt(picks[n]));
          onProgress?.(n + 1, picks.length);
        }
      } catch (err) {
        encoder.cancel();
        throw err;
      }
      const out = await encoder.finish();
      if (out.size <= maxBytes) return { blob: out, width, height, fps: outFps, frames: picks.length };
      // Bytes go roughly with pixels: aim the next try by how far this one missed.
      ratio *= (maxBytes * FIT_TARGET) / out.size;
    }
    return null;
  } finally {
    decoder.close();
  }
}

/**
 * Save a GIF to Bookmarks. One over what the server keeps is never sent as it
 * is (the upload would be cut off, and the browser only says it failed): a
 * smaller copy that fits is made and saved instead, and the full one stays
 * with the person who made it.
 *
 * @returns {Promise<{ gif: object, copy: null | { width: number, height: number, fps: number, bytes: number } }>}
 */
export async function saveGifFitting(blob, meta, { fps, palette, maxBytes = MAX_GIF_BYTES, onShrink, onProgress, signal } = {}) {
  if (blob.size <= maxBytes) return { gif: await saveGif(blob, meta), copy: null };
  if (blob.type === 'video/mp4') {
    throw Object.assign(new Error(`it is ${mb(blob.size)} MB and Bookmarks keep up to ${mb(maxBytes)} MB. Lower the quality or the FPS, or shorten the part of the round.`), { code: 'too-big' });
  }
  onShrink?.();
  const small = await shrinkGif(blob, { fps, palette, maxBytes, onProgress, signal });
  if (!small) {
    throw Object.assign(
      new Error(
        `it is ${mb(blob.size)} MB and Bookmarks keep up to ${mb(maxBytes)} MB, and a smaller copy could not be made here. Lower the quality or the FPS, or shorten the part of the round.`
      ),
      { code: 'too-big' }
    );
  }
  const gif = await saveGif(small.blob, meta);
  return { gif, copy: { width: small.width, height: small.height, fps: Math.round(small.fps * 10) / 10, bytes: small.blob.size } };
}

/** A file name that says what the clip is: aim4-mirage-r14-1m30.gif, or .mp4 with that extension. */
export function gifFileName(meta, ext = 'gif') {
  const part = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  const bits = ['aim4', part(meta?.mapName || meta?.map), meta?.round ? `r${meta.round}` : '', part(String(meta?.clockFrom || '').replace(':', 'm'))];
  return `${bits.filter(Boolean).join('-') || 'aim4'}.${ext}`;
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

/**
 * Ask for a saved clip's GIF without waiting for it. Done when its image URL is copied: the server makes the
 * GIF on the first request, so it is ready before whoever gets the link opens it, or a chat app looks at it.
 */
export function warmGif(id) {
  fetch(gifShareUrl(id), { method: 'HEAD', mode: 'no-cors' }).catch(() => {});
}

/**
 * Download a saved clip as a GIF. The server makes it now if nobody has asked before, so it can take a while.
 */
export async function downloadSavedGif(id, meta) {
  const res = await fetch(gifImageUrl(id));
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  downloadBlob(await res.blob(), gifFileName(meta));
}

/** The share page: the GIF with its title and description. */
export function gifPageUrl(id) {
  return `${publicOrigin()}/g/${id}`;
}
