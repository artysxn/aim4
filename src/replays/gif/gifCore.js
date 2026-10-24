// ---------------------------------------------------------------------------
// replays/gif/gifCore.js
// The GIF creator's arithmetic and bytes: which ticks become frames, how big a
// frame is at each quality level, how long each frame stays up, and the
// encoder (gifenc, palettes and LZW). No DOM, so the same code encodes in the
// worker, in the page when there is no worker, and in the Node tests.
//
// Two palette modes, because the two views are different pictures:
//
//   global  2D. A radar is a few dozen flat colours, so one palette sampled
//           across the clip serves every frame, and a pixel that did not change
//           is written as transparent: the frame before shows through. Most of
//           a radar frame is the map, which never changes, so most of each
//           frame costs almost nothing.
//   local   3D. Every frame gets its own palette: a moving camera changes
//           every pixel, and one palette for a whole clip of a 3D scene bands.
// ---------------------------------------------------------------------------

// gifenc ships CommonJS as its main: a default import reads the same in Node and in esbuild's bundle.
import gifenc from 'gifenc';

const { GIFEncoder, applyPalette, quantize } = gifenc;

export const DEFAULT_FPS = { '2d': 18, '3d': 24 };
export const MIN_FPS = 5;
export const MAX_FPS = 30;

/**
 * Share of the native resolution at quality 1, 2 and 3. Level 1 is the floor:
 * half the radar's pixels, three quarters of the 3D view's.
 */
export const QUALITY_SCALE = { '2d': [0.5, 0.75, 1], '3d': [0.75, 0.875, 1] };

/** The longest clip each view takes, in seconds. A 3D frame is a full picture; a radar frame is mostly unchanged map. */
export const MAX_SECONDS = { '2d': 120, '3d': 30 };

/** What the server keeps. A bigger GIF still downloads; it just is not saved to Bookmarks. */
export const MAX_GIF_BYTES = 40 * 1024 * 1024;

/** Two 100ths of a second is the shortest delay browsers honour; below it they show the frame for 10. */
const MIN_DELAY_CS = 2;

export const kindOf = (kind) => (kind === '3d' ? '3d' : '2d');

/** The fps a clip is made at: the view's default unless a sane one is asked for. */
export function clampFps(kind, fps) {
  const n = Math.round(Number(fps));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FPS[kindOf(kind)];
  return Math.max(MIN_FPS, Math.min(MAX_FPS, n));
}

/** Quality 1, 2 or 3 as a share of the native resolution. */
export function qualityScale(kind, level) {
  const scales = QUALITY_SCALE[kindOf(kind)];
  const i = Math.max(1, Math.min(3, Math.round(Number(level) || 1))) - 1;
  return scales[i];
}

/** The GIF's pixel size for a region of `width` x `height` native pixels. */
export function outputSize(kind, level, width, height) {
  const s = qualityScale(kind, level);
  return {
    width: Math.max(16, Math.min(4096, Math.round(width * s))),
    height: Math.max(16, Math.min(4096, Math.round(height * s)))
  };
}

/**
 * The demo ticks the frames are drawn at, one per 1/fps second of the round,
 * first and last included. Capped at the view's longest clip.
 */
export function frameTicks({ fromTick, toTick, tickRate = 64, fps, kind = '2d' }) {
  const rate = Number(tickRate) > 0 ? Number(tickRate) : 64;
  const f = clampFps(kind, fps);
  const a = Math.min(Number(fromTick) || 0, Number(toTick) || 0);
  let b = Math.max(Number(fromTick) || 0, Number(toTick) || 0);
  b = Math.min(b, a + MAX_SECONDS[kindOf(kind)] * rate);
  const step = rate / f;
  const out = [];
  for (let t = a; t <= b + 1e-6; t += step) out.push(t);
  if (!out.length) out.push(a);
  return out;
}

/**
 * Each frame's delay in milliseconds. A GIF counts in 100ths of a second, and
 * 18 fps is 5.56 of them: rounding every frame to 6 would play the clip 7%
 * slow, so the delays alternate to keep the running total on time.
 */
export function frameDelays(count, fps) {
  const f = Math.max(1, Number(fps) || 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const cs = Math.round(((i + 1) * 100) / f) - Math.round((i * 100) / f);
    out.push(Math.max(MIN_DELAY_CS, cs) * 10);
  }
  return out;
}

/** Seconds of playback a clip of `count` frames lasts. */
export const clipSeconds = (count, fps) => frameDelays(count, fps).reduce((a, b) => a + b, 0) / 1000;

/**
 * Pixels for building one palette from several frames: every `stride`-th pixel
 * of each, so a long clip's palette costs no more than a short one's.
 */
export function paletteSample(frames, budget = 1 << 20) {
  const list = frames.filter((f) => f && f.length >= 4);
  if (!list.length) return new Uint8Array(4);
  const pixels = list.reduce((n, f) => n + f.length / 4, 0);
  const stride = Math.max(1, Math.ceil(pixels / budget));
  const out = new Uint8Array(Math.ceil(pixels / stride) * 4 + 4);
  let o = 0;
  for (const f of list) {
    for (let p = 0; p < f.length; p += stride * 4) {
      out[o++] = f[p];
      out[o++] = f[p + 1];
      out[o++] = f[p + 2];
      out[o++] = 255;
    }
  }
  return out.subarray(0, o);
}

/** RGBA bytes as gifenc wants them: a Uint8Array on its own 4-aligned buffer. */
function asBytes(rgba) {
  if (rgba instanceof Uint8Array && rgba.byteOffset % 4 === 0) return rgba;
  if (rgba instanceof Uint8ClampedArray && rgba.byteOffset % 4 === 0) {
    return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  }
  if (rgba instanceof ArrayBuffer) return new Uint8Array(rgba);
  return new Uint8Array(rgba);
}

/**
 * An encoder for one clip.
 *
 * @param {{ width: number, height: number, fps: number, palette?: 'global'|'local', repeat?: number }} opts
 */
export function createGifWriter({ width, height, fps, palette = 'global', repeat = 0 }) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const n = w * h;
  const gif = GIFEncoder();
  const mode = palette === 'local' ? 'local' : 'global';
  /** The 255 colours frames are mapped onto, and the table written: those plus the transparent slot. */
  let shared = null;
  let table = null;
  let clear = 0;
  /** The palette index each pixel shows right now, after every frame so far. */
  let shown = null;
  let index = 0;
  const delayCs = (i) => {
    const f = Math.max(1, Number(fps) || 1);
    return Math.max(MIN_DELAY_CS, Math.round(((i + 1) * 100) / f) - Math.round((i * 100) / f));
  };

  function setSharedPalette(sample) {
    // 255 colours and one more slot that no pixel maps to: the transparent one.
    // Mapping onto the table itself would send a black pixel to that slot.
    shared = quantize(asBytes(sample), 255, { format: 'rgb565' });
    clear = shared.length;
    table = [...shared, [0, 0, 0]];
  }

  return {
    get frames() {
      return index;
    },
    /** Global mode: the palette from frames across the clip. Without it, the first frame decides. */
    setPalette(frames) {
      if (mode === 'global' && !shared) setSharedPalette(paletteSample(frames.map(asBytes)));
    },
    addFrame(rgba) {
      const bytes = asBytes(rgba);
      if (bytes.length < n * 4) throw new Error(`A frame needs ${n * 4} bytes, got ${bytes.length}.`);
      const delay = delayCs(index) * 10;
      if (mode === 'local') {
        const pal = quantize(bytes, 256, { format: 'rgb565' });
        const idx = applyPalette(bytes, pal, 'rgb565');
        gif.writeFrame(idx, w, h, { palette: pal, delay, repeat, dispose: 1 });
      } else {
        if (!shared) setSharedPalette(bytes);
        const idx = applyPalette(bytes, shared, 'rgb565');
        let out = idx;
        if (shown) {
          out = new Uint8Array(n);
          for (let p = 0; p < n; p++) {
            const v = idx[p];
            out[p] = v === shown[p] ? clear : v;
          }
        }
        shown = idx;
        gif.writeFrame(out, w, h, {
          palette: index === 0 ? table : undefined,
          delay,
          repeat,
          transparent: index > 0,
          transparentIndex: clear,
          dispose: 1
        });
      }
      index++;
    },
    /** The finished file. */
    finish() {
      gif.finish();
      return gif.bytes();
    }
  };
}
