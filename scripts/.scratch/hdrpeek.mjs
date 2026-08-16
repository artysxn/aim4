// Decode a Radiance .hdr to a tonemapped PNG and report its real luminance, so
// "is the sky texture actually dim / does it contain clouds" is answerable by
// looking rather than by inference.
//
//   node scripts/.scratch/hdrpeek.mjs inferno nuke mirage

import fs from 'node:fs';
import sharp from 'sharp';

const OUT = 'C:/Users/itsda/AppData/Local/Temp/claude/D--Dev-claude/2cc30c3f-5ace-4109-8b88-88b710cca12c/scratchpad';

function readHdr(file) {
  const buf = fs.readFileSync(file);
  let p = 0;
  const line = () => {
    let s = '';
    while (buf[p] !== 10) s += String.fromCharCode(buf[p++]);
    p++;
    return s;
  };
  let l = line();
  if (!l.startsWith('#?')) throw new Error('not radiance');
  let w = 0, h = 0;
  for (;;) {
    l = line();
    const m = /^-Y (\d+) \+X (\d+)/.exec(l);
    if (m) { h = +m[1]; w = +m[2]; break; }
    if (p > buf.length) throw new Error('no size');
  }
  const rgb = new Float32Array(w * h * 3);
  const row = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    // new-style RLE scanline
    if (buf[p] === 2 && buf[p + 1] === 2) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          let n = buf[p++];
          if (n > 128) { const v = buf[p++]; n -= 128; while (n-- > 0) row[(x++) * 4 + c] = v; }
          else { while (n-- > 0) row[(x++) * 4 + c] = buf[p++]; }
        }
      }
    } else {
      for (let x = 0; x < w; x++) { row[x * 4] = buf[p++]; row[x * 4 + 1] = buf[p++]; row[x * 4 + 2] = buf[p++]; row[x * 4 + 3] = buf[p++]; }
    }
    for (let x = 0; x < w; x++) {
      const e = row[x * 4 + 3];
      const f = e ? Math.pow(2, e - 136) : 0; // 2^(e-128) / 256
      const o = (y * w + x) * 3;
      rgb[o] = row[x * 4] * f;
      rgb[o + 1] = row[x * 4 + 1] * f;
      rgb[o + 2] = row[x * 4 + 2] * f;
    }
  }
  return { w, h, rgb };
}

for (const slug of process.argv.slice(2)) {
  const file = `server/data/cs3d/pack/${slug}/sky/sky.hdr`;
  if (!fs.existsSync(file)) { console.log(`${slug}: no sky.hdr`); continue; }
  const { w, h, rgb } = readHdr(file);
  let mn = Infinity, mx = -Infinity, sum = 0;
  // upper half only: the sky, not the ground hemisphere
  const rows = Math.floor(h / 2);
  for (let i = 0; i < rows * w; i++) {
    const l = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
    if (l < mn) mn = l;
    if (l > mx) mx = l;
    sum += l;
  }
  const mean = sum / (rows * w);
  console.log(
    `${slug.padEnd(9)} ${w}x${h}  sky-half luma  min ${mn.toFixed(3)}  mean ${mean.toFixed(3)}  max ${mx.toFixed(1)}  dynamic range ${(mx / Math.max(1e-4, mean)).toFixed(0)}x`
  );
  // exposed so the shape is visible: scale to mean 0.4, then sRGB
  const k = 0.4 / Math.max(1e-4, mean);
  const png = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, rgb[i * 3 + c] * k));
      png[i * 3 + c] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    }
  }
  await sharp(png, { raw: { width: w, height: h, channels: 3 } }).png().toFile(`${OUT}/sky_${slug}.png`);
}
