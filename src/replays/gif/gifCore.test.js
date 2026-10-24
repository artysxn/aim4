// node src/replays/gif/gifCore.test.js
import assert from 'node:assert/strict';
import {
  clampFps,
  clipSeconds,
  createGifWriter,
  frameDelays,
  frameTicks,
  outputSize,
  qualityScale
} from './gifCore.js';

// ---- a small GIF decoder: enough to read back what the writer wrote ---------

function lzwDecode(minCodeSize, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let size = minCodeSize + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[end] = null;
    size = minCodeSize + 1;
  };
  reset();
  let bit = 0;
  let prev = null;
  let o = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[(bit + i) >> 3];
      if (byte === undefined) return -1;
      code |= ((byte >> ((bit + i) & 7)) & 1) << i;
    }
    bit += size;
    return code;
  };
  for (;;) {
    const code = read();
    if (code < 0 || code === end) break;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('bad LZW stream');
    for (const v of entry) if (o < pixelCount) out[o++] = v;
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return out;
}

/** Every frame, composited the way a browser shows it (disposal 0/1 only, which is all the writer uses). */
function decodeGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  assert.equal(sig, 'GIF89a');
  p = 6;
  const width = u16();
  const height = u16();
  const flags = u8();
  p += 2;
  const readTable = (n) => {
    const t = [];
    for (let i = 0; i < n; i++) t.push([u8(), u8(), u8()]);
    return t;
  };
  const global = flags & 0x80 ? readTable(1 << ((flags & 7) + 1)) : null;
  const screen = new Uint8Array(width * height * 3);
  const frames = [];
  let gce = { transparent: false, index: 0, delay: 0, dispose: 0 };
  let loops = null;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        u8();
        const f = u8();
        gce = { dispose: (f >> 2) & 7, transparent: Boolean(f & 1), delay: u16() * 10, index: u8() };
        u8();
      } else {
        const blocks = [];
        for (let n = u8(); n; n = u8()) {
          blocks.push(bytes.subarray(p, p + n));
          p += n;
        }
        if (label === 0xff && String.fromCharCode(...blocks[0]) === 'NETSCAPE2.0') loops = blocks[1][1] | (blocks[1][2] << 8);
      }
      continue;
    }
    assert.equal(b, 0x2c, 'image descriptor');
    const x = u16();
    const y = u16();
    const w = u16();
    const h = u16();
    const f = u8();
    const table = f & 0x80 ? readTable(1 << ((f & 7) + 1)) : global;
    const minCode = u8();
    const chunks = [];
    for (let n = u8(); n; n = u8()) {
      chunks.push(bytes.subarray(p, p + n));
      p += n;
    }
    const data = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
    const idx = lzwDecode(minCode, data, w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const v = idx[yy * w + xx];
        if (gce.transparent && v === gce.index) continue;
        const s = ((y + yy) * width + (x + xx)) * 3;
        screen[s] = table[v][0];
        screen[s + 1] = table[v][1];
        screen[s + 2] = table[v][2];
      }
    }
    frames.push({ pixels: screen.slice(), delay: gce.delay, local: Boolean(f & 0x80), transparent: gce.transparent, dispose: gce.dispose });
    gce = { transparent: false, index: 0, delay: 0, dispose: 0 };
  }
  return { width, height, frames, loops };
}

// ---- timing and sizes ---------------------------------------------------------

assert.equal(clampFps('2d'), 18);
assert.equal(clampFps('3d'), 24);
assert.equal(clampFps('3d', 100), 30);
assert.equal(clampFps('2d', 2), 5);

assert.equal(qualityScale('2d', 1), 0.5);
assert.equal(qualityScale('2d', 3), 1);
assert.equal(qualityScale('3d', 1), 0.75);
assert.equal(qualityScale('3d', 2), 0.875);
assert.equal(qualityScale('3d', 9), 1);
assert.deepEqual(outputSize('2d', 1, 1000, 600), { width: 500, height: 300 });
assert.deepEqual(outputSize('3d', 1, 1920, 1080), { width: 1440, height: 810 });

{
  // 2 s at 18 fps on a 64-tick demo: 37 frames, first and last tick included.
  const ticks = frameTicks({ fromTick: 1000, toTick: 1128, tickRate: 64, fps: 18 });
  assert.equal(ticks.length, 37);
  assert.equal(ticks[0], 1000);
  assert.ok(Math.abs(ticks.at(-1) - 1128) < 1e-6);
  // Reversed ends are the same clip; a 3D clip stops at 30 s.
  assert.equal(frameTicks({ fromTick: 1128, toTick: 1000, tickRate: 64, fps: 18 }).length, 37);
  assert.equal(frameTicks({ fromTick: 0, toTick: 64 * 100, tickRate: 64, fps: 24, kind: '3d' }).length, 30 * 24 + 1);
}

{
  // 18 fps does not divide 100: the delays alternate and stay on time.
  const d = frameDelays(18, 18);
  assert.ok(d.every((ms) => ms === 50 || ms === 60));
  assert.equal(d.reduce((a, b) => a + b, 0), 1000);
  assert.equal(clipSeconds(24, 24), 1);
  // Never under the 20 ms browsers honour.
  assert.ok(frameDelays(10, 30).every((ms) => ms >= 20));
}

// ---- encoding: 2D (one palette, unchanged pixels transparent) -----------------

const W = 40;
const H = 30;
const BG = [20, 24, 30];
const DOT = [230, 160, 40];

/** A dark map with a dot moving right, and a black pixel that must stay black. */
function radarFrame(i) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) rgba.set([...BG, 255], p * 4);
  rgba.set([0, 0, 0, 255], (H - 1) * W * 4);
  for (let y = 10; y < 16; y++) for (let x = 2 + i * 4; x < 8 + i * 4; x++) rgba.set([...DOT, 255], (y * W + x) * 4);
  return rgba;
}

{
  const frames = [0, 1, 2, 3, 4].map(radarFrame);
  const writer = createGifWriter({ width: W, height: H, fps: 18, palette: 'global' });
  writer.setPalette(frames);
  for (const f of frames) writer.addFrame(f);
  const gif = decodeGif(writer.finish());
  assert.equal(gif.width, W);
  assert.equal(gif.height, H);
  assert.equal(gif.frames.length, 5);
  assert.equal(gif.loops, 0, 'loops forever');
  assert.deepEqual(gif.frames.map((f) => f.delay), frameDelays(5, 18));
  assert.ok(!gif.frames[0].transparent && gif.frames.slice(1).every((f) => f.transparent && f.dispose === 1));
  assert.ok(gif.frames.every((f) => !f.local), 'one palette');
  const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) <= 8);
  gif.frames.forEach((f, i) => {
    const want = frames[i];
    for (let p = 0; p < W * H; p++) {
      const got = [f.pixels[p * 3], f.pixels[p * 3 + 1], f.pixels[p * 3 + 2]];
      assert.ok(near(got, [want[p * 4], want[p * 4 + 1], want[p * 4 + 2]]), `frame ${i} pixel ${p}: ${got}`);
    }
  });
}

// ---- encoding: 3D (a palette per frame) ---------------------------------------

{
  const frame = (i) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) rgba.set([(x * 6 + i * 20) & 255, y * 8, 128 - i * 10, 255], (y * W + x) * 4);
    }
    return rgba;
  };
  const writer = createGifWriter({ width: W, height: H, fps: 24, palette: 'local' });
  const frames = [0, 1, 2].map(frame);
  for (const f of frames) writer.addFrame(f);
  const gif = decodeGif(writer.finish());
  assert.equal(gif.frames.length, 3);
  assert.ok(gif.frames.slice(1).every((f) => f.local), 'later frames carry their own palette');
  // Every pixel within a quantization step of the source.
  gif.frames.forEach((f, i) => {
    let worst = 0;
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(f.pixels[p * 3 + c] - frames[i][p * 4 + c]));
    }
    assert.ok(worst <= 24, `frame ${i} drifts ${worst}`);
  });
}

assert.throws(() => createGifWriter({ width: 4, height: 4, fps: 18 }).addFrame(new Uint8Array(8)), /needs 64 bytes/);

console.log('gifCore.test.js ok');
