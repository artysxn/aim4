// ---------------------------------------------------------------------------
// replays/gif/gifEncoder.js
// The page's side of encoding: hand frames to the worker as they are drawn,
// hold back when it falls behind, and get a Blob at the end. Without a worker
// (an old browser, a test page) the same writer runs here instead.
// ---------------------------------------------------------------------------

import { createGifWriter } from './gifCore.js';

/** Frames in flight before the capture loop waits for the encoder. Each is a full RGBA frame. */
const MAX_QUEUED = 6;

/**
 * @param {{ width: number, height: number, fps: number, palette?: 'global'|'local',
 *           onProgress?: (framesEncoded: number) => void }} opts
 */
export function createGifEncoder(opts) {
  const { onProgress } = opts;
  let worker = null;
  try {
    if (typeof Worker !== 'undefined') {
      worker = new Worker(new URL('./gifEncode.worker.js', import.meta.url), { type: 'module' });
    }
  } catch {
    worker = null;
  }

  if (!worker) {
    // Same writer on this thread; yields between frames so the page can paint.
    const writer = createGifWriter(opts);
    return {
      setPalette(frames) {
        writer.setPalette(frames);
      },
      async addFrame(rgba) {
        writer.addFrame(rgba);
        onProgress?.(writer.frames);
        await new Promise((r) => setTimeout(r, 0));
      },
      async finish() {
        return new Blob([writer.finish()], { type: 'image/gif' });
      },
      cancel() {}
    };
  }

  let sent = 0;
  let encoded = 0;
  let failed = null;
  let waiters = [];
  let done = null;
  const wake = () => {
    const list = waiters;
    waiters = [];
    for (const w of list) w();
  };
  worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') {
      encoded = msg.frames;
      onProgress?.(encoded);
      wake();
    } else if (msg.type === 'done') {
      done?.resolve(new Blob([msg.bytes], { type: 'image/gif' }));
    } else if (msg.type === 'error') {
      failed = new Error(msg.error || 'The GIF could not be encoded.');
      done?.reject(failed);
      wake();
    }
  };
  worker.onerror = (err) => {
    failed = new Error(err?.message || 'The GIF encoder stopped.');
    done?.reject(failed);
    wake();
  };
  worker.postMessage({
    type: 'start',
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    palette: opts.palette
  });

  return {
    /** Global palette mode: frames from across the clip to build it from. */
    setPalette(frames) {
      const buffers = frames.map((f) => f.slice().buffer);
      worker.postMessage({ type: 'palette', frames: buffers }, buffers);
    },
    /** Resolves once the worker has room for another frame. */
    async addFrame(rgba) {
      if (failed) throw failed;
      const buf = rgba.buffer.byteLength === rgba.byteLength ? rgba.buffer : rgba.slice().buffer;
      worker.postMessage({ type: 'frame', data: buf }, [buf]);
      sent++;
      while (!failed && sent - encoded > MAX_QUEUED) await new Promise((r) => waiters.push(r));
      if (failed) throw failed;
    },
    finish() {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        done = {
          resolve: (blob) => {
            worker.terminate();
            resolve(blob);
          },
          reject: (err) => {
            worker.terminate();
            reject(err);
          }
        };
        worker.postMessage({ type: 'finish' });
      });
    },
    cancel() {
      failed = failed || new Error('Cancelled.');
      worker.terminate();
      wake();
    }
  };
}
