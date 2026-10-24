// ---------------------------------------------------------------------------
// replays/gif/gifHighlights.js
// GIF highlights for an antistrat document: a few rounds the sheet was
// written from, each as a short radar GIF of the moment that matters, saved
// to Bookmarks and embedded at the end of the document.
//
// Which rounds: the first round behind each T site section (its execute, up
// to the plant), each side's dangerous rounds (the opening kill) and the CT
// retakes (after the plant), taken in turn so one section cannot fill the
// whole set. The moment comes from the round's own record, never a guess.
// ---------------------------------------------------------------------------

import { makeRoundGif } from './roundGif.js';
import { timingFor } from '../viewer/roundClock.js';

/** The most a document carries: each one is a few seconds of scanning and encoding. */
export const MAX_HIGHLIGHTS = 6;

/**
 * Which rounds become GIFs, and which moment of each.
 *
 * @param {object} report  buildSummaryReport(...) or a scan's report()
 * @param {{ max?: number, categories?: string[] }} [opts]  only the sections the document has
 * @returns {Array<{ file: string, label: string, moment: 'plant'|'opening'|'retake', side: 'T'|'CT' }>}
 */
export function highlightPicks(report, { max = 4, categories = null } = {}) {
  const has = (key) => !categories || categories.includes(key);
  const lists = [];
  for (const side of ['T', 'CT']) {
    const bag = report?.sides?.[side];
    if (!bag || !has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    if (side === 'T' && has('sites')) {
      for (const s of bag.sites || []) lists.push({ label: `T ${s.site} execute`, moment: 'plant', side, files: s.files });
    }
    if (has('danger')) lists.push({ label: `${side} opening`, moment: 'opening', side, files: bag.danger?.files });
    if (side === 'CT' && has('sites')) lists.push({ label: 'CT retake', moment: 'retake', side, files: bag.retakes?.files });
  }
  const limit = Math.max(0, Math.min(MAX_HIGHLIGHTS, Math.round(Number(max) || 0)));
  const seen = new Set();
  const picks = [];
  for (let depth = 0; picks.length < limit && depth < 4; depth++) {
    for (const l of lists) {
      const file = (l.files || [])[depth];
      if (!file || seen.has(file)) continue;
      seen.add(file);
      picks.push({ file, label: l.label, moment: l.moment, side: l.side });
      if (picks.length >= limit) break;
    }
  }
  return picks;
}

/**
 * The part of a round a highlight shows, in demo ticks.
 *   plant    the last 8 seconds before the bomb goes down, and 2 after
 *   retake   the 10 seconds after the plant
 *   opening  4 seconds before the first kill, 3 after
 * Without a plant or a kill: 10 to 18 seconds into the round.
 */
export function momentWindow(meta, moment) {
  const t = timingFor(meta);
  const r = t.tickRate;
  const plant = Number.isFinite(t.plantTick)
    ? t.plantTick
    : (meta.events?.bomb || []).find((b) => b?.type === 'planted')?.tick;
  if (moment === 'plant' && Number.isFinite(plant)) return { fromTick: plant - 8 * r, toTick: plant + 2 * r };
  if (moment === 'retake' && Number.isFinite(plant)) return { fromTick: plant + r, toTick: Math.min(t.endTick, plant + 11 * r) };
  const first = (meta.events?.kills || [])
    .filter((k) => k.tick >= t.freezeEndTick)
    .reduce((a, k) => (!a || k.tick < a.tick ? k : a), null);
  if (first) return { fromTick: first.tick - 4 * r, toTick: first.tick + 3 * r };
  return { fromTick: t.freezeEndTick + 10 * r, toTick: t.freezeEndTick + 18 * r };
}

/** The embed a document stores for a saved GIF: an inert div that docEmbeds mounts. */
export function gifEmbedHtml(gif, caption, esc) {
  const data = JSON.stringify({ id: gif.id, caption: String(caption || '').slice(0, 200), width: gif.width || 0, height: gif.height || 0 });
  return `<div data-kind="gif" data-embed="${esc(data)}"></div>`;
}

/**
 * Make the highlights and return the document section that shows them.
 *
 * @param {object} opts
 * @param {Array<{ teamName: string, mapCode: string, report: object, categories?: string[] }>} opts.specs
 * @param {number} opts.count       highlights per map
 * @param {(s: string) => string} opts.esc
 * @param {(fetchMeta: string) => Promise<object>} [opts.metaOf]  round meta loader (for the moment)
 * @param {(text: string) => void} [opts.onProgress]
 * @returns {Promise<{ html: string, made: number, failed: string[] }>}
 */
export async function buildHighlights({ specs, count, esc, metaOf, onProgress }) {
  const parts = [];
  const failed = [];
  let made = 0;
  for (const spec of specs) {
    const picks = highlightPicks(spec.report, { max: count, categories: spec.categories });
    if (!picks.length) continue;
    const blocks = [];
    for (const [i, pick] of picks.entries()) {
      onProgress?.(`GIF ${i + 1} of ${picks.length} (${spec.teamName}): ${pick.label}`);
      try {
        const meta = metaOf ? await metaOf(pick.file) : null;
        const win = meta ? momentWindow(meta, pick.moment) : {};
        const title = `${spec.teamName}: ${pick.label}`;
        const res = await makeRoundGif({
          file: pick.file,
          kind: '2d',
          ...win,
          title,
          description: `From the antistrat sheet for ${spec.teamName}.`,
          source: 'antistrat',
          onProgress: (text) => onProgress?.(`GIF ${i + 1} of ${picks.length}: ${text}`)
        });
        if (!res.gif) throw res.saveError || new Error('not saved');
        made++;
        const when = res.meta.clockFrom && res.meta.clockTo ? ` (${res.meta.clockFrom} to ${res.meta.clockTo})` : '';
        blocks.push(gifEmbedHtml(res.gif, `${pick.label}, round ${res.meta.round}${when}`, esc));
      } catch (err) {
        failed.push(`${pick.label}: ${err?.message || err}`);
      }
    }
    if (blocks.length) parts.push(`<h2>${esc(`${spec.teamName}: highlights`)}</h2>${blocks.join('')}`);
  }
  return { html: parts.join(''), made, failed };
}
