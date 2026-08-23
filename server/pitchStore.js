// ---------------------------------------------------------------------------
// server/pitchStore.js
// Live wording for the pitch deck, edited from the admin panel.
//
//   {AIM4_REPLAY_DIR}/pitch/text.json
//
// Schema:
//   { updatedAt, updatedBy, text: { <slideId>: { <path>: <sentence> } } }
//
// The store holds replacement sentences and nothing else. Slide structure lives
// in src/site/pitchContent.js and is never written here, so a saved edit cannot
// add a slide, a column or a table row — it can only say something different in
// a place that already says something. That is why the shape is validated hard
// on the way in: a store that accepts arbitrary JSON from an admin panel and
// hands it to a renderer is one XSS away from being a publishing platform for
// whoever gets that session.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT as REPLAY_ROOT } from './replays/demoStore.js';

export const PITCH_DIR = process.env.AIM4_PITCH_DIR || path.join(REPLAY_ROOT, 'pitch');
const PITCH_FILE = path.join(PITCH_DIR, 'text.json');

/** Slide ids as written in pitchContent.js. */
const SLIDE_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Dotted paths into a slide: "lead", "points.2", "table.rows.0.1". */
const PATH = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/;
/**
 * Segments that are legal identifiers but reach the prototype chain. The
 * renderer refuses them too; this is the copy that runs before anything is
 * written to disk.
 */
const FORBIDDEN_SEGMENT = /(^|\.)(constructor|prototype|__proto__)(\.|$)/;

const MAX_SLIDES = 100;
const MAX_PATHS_PER_SLIDE = 300;
const MAX_VALUE_CHARS = 4000;

export function emptyPitchText() {
  return { updatedAt: 0, updatedBy: '', text: {} };
}

/**
 * Keep only what the schema allows, silently dropping the rest.
 *
 * Dropping rather than throwing is deliberate: the panel posts the whole deck
 * back, and one over-long paste should not lose the other forty edits.
 *
 * @param {unknown} payload
 * @returns {Record<string, Record<string, string>>}
 */
export function sanitizePitchText(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  let slides = 0;
  for (const [slideId, patch] of Object.entries(src)) {
    if (slides >= MAX_SLIDES) break;
    if (!SLIDE_ID.test(slideId)) continue;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;

    /** @type {Record<string, string>} */
    const clean = {};
    let count = 0;
    for (const [key, value] of Object.entries(patch)) {
      if (count >= MAX_PATHS_PER_SLIDE) break;
      if (!PATH.test(key) || key.length > 80 || FORBIDDEN_SEGMENT.test(key)) continue;
      if (typeof value !== 'string') continue;
      // Strip control characters (including newlines): every field in the deck
      // renders as a single line, and a stray \n only ever arrives by accident.
      const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_VALUE_CHARS);
      clean[key] = text;
      count += 1;
    }
    if (Object.keys(clean).length) {
      out[slideId] = clean;
      slides += 1;
    }
  }
  return out;
}

async function readFile() {
  try {
    return JSON.parse(await fsp.readFile(PITCH_FILE, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** @returns {Promise<{updatedAt: number, updatedBy: string, text: object}>} */
export async function getPitchText() {
  const raw = await readFile();
  if (!raw) return emptyPitchText();
  return {
    updatedAt: Number(raw.updatedAt) || 0,
    updatedBy: String(raw.updatedBy || '').slice(0, 64),
    text: sanitizePitchText(raw.text)
  };
}

/**
 * @param {unknown} payload  the whole override map, as the panel holds it
 * @param {string} [actorId]
 */
export async function savePitchText(payload, actorId = '') {
  const text = sanitizePitchText(payload);
  const record = {
    updatedAt: Date.now(),
    updatedBy: String(actorId || '').slice(0, 64),
    text
  };
  await fsp.mkdir(PITCH_DIR, { recursive: true });
  // Write then rename: a crash mid-write leaves the previous deck intact rather
  // than a half-written file that parses as nothing.
  const tmp = `${PITCH_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
  await fsp.rename(tmp, PITCH_FILE);
  return record;
}

/** Count of edited sentences, for the audit line. */
export function countPitchEdits(text) {
  let n = 0;
  for (const patch of Object.values(text || {})) n += Object.keys(patch || {}).length;
  return n;
}
