// ---------------------------------------------------------------------------
// replays/gif/gifEncode.worker.js
// Encodes one GIF off the page's thread. Frames arrive as RGBA buffers in
// play order; palettes and LZW happen here so the viewer stays responsive
// while a long clip encodes.
//
//   { type: 'start', width, height, fps, palette }
//   { type: 'palette', frames: ArrayBuffer[] }    global palette, optional
//   { type: 'frame', data: ArrayBuffer }
//   { type: 'finish' }      -> { type: 'done', bytes: ArrayBuffer }
//   every frame             -> { type: 'progress', frames }
//   any failure             -> { type: 'error', error }
// ---------------------------------------------------------------------------

import { createGifWriter } from './gifCore.js';

let writer = null;

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'start') {
      writer = createGifWriter(msg);
    } else if (msg.type === 'palette') {
      writer?.setPalette((msg.frames || []).map((b) => new Uint8Array(b)));
    } else if (msg.type === 'frame') {
      if (!writer) throw new Error('The encoder was not started.');
      writer.addFrame(new Uint8Array(msg.data));
      self.postMessage({ type: 'progress', frames: writer.frames });
    } else if (msg.type === 'finish') {
      if (!writer) throw new Error('The encoder was not started.');
      const bytes = writer.finish();
      writer = null;
      const out = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      self.postMessage({ type: 'done', bytes: out }, [out]);
    }
  } catch (err) {
    writer = null;
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};
