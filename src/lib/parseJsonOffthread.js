// ---------------------------------------------------------------------------
// lib/parseJsonOffthread.js
// Parse multi-megabyte JSON in a worker so the sidebar stays clickable.
// ---------------------------------------------------------------------------

/** @type {Worker | null} */
let worker = null;
let nextId = 1;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./jsonParse.worker.js', import.meta.url), {
      type: 'module'
    });
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (e) => {
    const { id, ok, value, error } = e.data || {};
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (ok) job.resolve(value);
    else job.reject(new Error(error || 'JSON parse failed'));
  };
  worker.onerror = (err) => {
    for (const [, job] of pending) {
      job.reject(new Error(err?.message || 'JSON worker failed'));
    }
    pending.clear();
    worker = null;
  };
  return worker;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<any>}
 */
export function parseJsonBuffer(buffer) {
  const w = getWorker();
  if (!w) {
    const text = new TextDecoder().decode(buffer);
    return Promise.resolve(JSON.parse(text));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Transfer ownership so the main thread does not keep a copy of the bytes.
    w.postMessage({ id, buffer }, [buffer]);
  });
}

/**
 * @param {string} text
 * @returns {Promise<any>}
 */
export async function parseJsonText(text) {
  const encoded = new TextEncoder().encode(text);
  // Copy into a fresh ArrayBuffer for transfer (TextEncoder's buffer may be pooled).
  const buffer = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  );
  return parseJsonBuffer(buffer);
}
