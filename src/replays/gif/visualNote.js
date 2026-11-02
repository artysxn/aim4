// ---------------------------------------------------------------------------
// replays/gif/visualNote.js
// A visual note made of several renders: each perspective rendered in turn, the
// first saved as the note and the rest added to it.
//
// Everything renders off screen, so a queue of these leaves the viewer alone. 3D
// perspectives share one scene, since booting the map is most of the wait. One
// perspective failing (a player already dead when the part starts) costs that
// perspective and not the note.
// ---------------------------------------------------------------------------

import { makeRoundGif, openRoundScene } from './roundGif.js';
import { describePerspective, partFor, renderOptions } from './perspectives.js';
import { saveGifFitting } from './gifCapture.js';
import { timingFor } from '../viewer/roundClock.js';
import { fetchRoundMeta, fetchRoundTicks } from '../api.js';
import { TickTrack } from '../tickStore.js';

/**
 * Render perspectives into a note, a new one or one that exists.
 *
 * @param {object} opts
 * @param {string} opts.file
 * @param {{ meta: object, track: object }} [opts.round]  the round already loaded, every tick of it
 * @param {number} opts.fromTick
 * @param {number} opts.toTick
 * @param {object[]} opts.specs       perspectives.js
 * @param {string} [opts.noteId]      add to this note rather than starting one
 * @param {number} [opts.fps]
 * @param {number} [opts.quality]
 * @param {boolean} [opts.clock]
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 * @param {string} [opts.source]
 * @param {AbortSignal} [opts.signal]
 * @param {(text: string) => void} [opts.onProgress]
 * @param {(note: object) => void} [opts.onSaved]  after each clip is kept, with the note as it now stands
 * @returns {Promise<{ note: object|null, made: number, failed: Array<{ label: string, error: string }>,
 *                     first: null | { blob: Blob, meta: object, size: object, seconds: number } }>}
 */
export async function renderPerspectives(opts) {
  const { file, specs, signal } = opts;
  const round = opts.round || (await loadRound(file));
  const timing = timingFor(round.meta);
  let note = opts.noteId ? { id: opts.noteId } : null;
  let made = 0;
  let first = null;
  const failed = [];
  let scene = null;
  const many = specs.length > 1;
  try {
    for (let i = 0; i < specs.length; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const spec = specs[i];
      const { view, label } = describePerspective(spec, round.meta);
      const say = (text) => opts.onProgress?.(many ? `${i + 1} of ${specs.length}, ${label}: ${text}` : text);
      try {
        const options = renderOptions(spec);
        if (options.kind === '3d' && !scene) {
          say('Loading the 3D map');
          scene = await openRoundScene(round);
        }
        const res = await makeRoundGif({
          ...options,
          ...partFor(spec, { fromTick: opts.fromTick, toTick: opts.toTick, tickRate: timing.tickRate }),
          file,
          round,
          scene: options.kind === '3d' ? scene : undefined,
          fps: opts.fps,
          quality: opts.quality,
          clock: opts.clock,
          perspective: { view, label },
          title: opts.title,
          description: opts.description,
          source: opts.source || 'viewer',
          save: false,
          signal,
          onProgress: say
        });
        first ||= { blob: res.blob, meta: res.meta, size: res.size, seconds: res.seconds };
        say('Saving');
        const { gif } = await saveGifFitting(res.blob, res.meta, {
          noteId: note?.id,
          fps: opts.fps,
          palette: options.kind === '3d' ? 'local' : 'global',
          signal
        });
        note = gif;
        made++;
        opts.onSaved?.(note);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        failed.push({ label, error: err?.message || 'It could not be made.', status: err?.status });
      }
    }
  } finally {
    scene?.close();
  }
  return { note: made || opts.noteId ? note : null, made, failed, first };
}

/** What went wrong, in a line: the same reason for six perspectives is one sentence. */
export function failuresText(failed) {
  if (!failed?.length) return '';
  const [first] = failed;
  return `${first.label}: ${first.error}${failed.length > 1 ? ` And ${failed.length - 1} more.` : ''}`;
}

async function loadRound(file) {
  const [meta, buf] = await Promise.all([fetchRoundMeta(file), fetchRoundTicks(file, 1)]);
  if (!meta || !buf) throw new Error('That round could not be loaded.');
  return { meta: { ...meta, file: meta.file || file }, track: new TickTrack(buf) };
}

/** Where a note opens: Bookmarks, on it. */
export const noteHref = (id) => `/bookmarks?tab=gifs&gif=${encodeURIComponent(id)}`;

/**
 * Open a note in a new tab, once it is done. In the desktop app that is a tab of its own strip. In a browser a tab
 * opened with no click behind it can be refused, so the caller keeps a link in its notice for that case.
 *
 * @returns {boolean} whether a tab opened
 */
export function openNoteTab(id) {
  const href = noteHref(id);
  try {
    if (window.top?.__aim4OpenTab) {
      window.top.__aim4OpenTab(new URL(href, window.location.origin).href);
      return true;
    }
  } catch {
    /* a cross-origin parent: an ordinary browser tab, then */
  }
  const opened = window.open(href, '_blank');
  if (!opened) return false;
  opened.opener = null;
  return true;
}
