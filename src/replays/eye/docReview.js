// ---------------------------------------------------------------------------
// replays/eye/docReview.js
// Checking an antistrat document against the data, and writing it back.
//
// A document is read as an outline: side (h2), section (h3) and points (list
// items and paragraphs), each point with the rounds it links to. The review
// compares that outline with the same team's sheet built fresh from the
// demos, and with itself:
//
//   arithmetic   "7 of 10 (60%)": the percentage does not follow from the counts
//   impossible   "12 of 10": more than all
//   thin         a point resting on fewer than 5 rounds
//   duplicate    two points about the same rounds and the same thing, however
//                each is worded (one merged point is enough)
//   same-words   two points worded alike about different rounds: not a
//                duplicate, but the reader cannot tell them apart
//   changed      the fresh sheet says the same thing with other numbers
//   unbacked     numbers the fresh sheet does not have (old data, or written by hand)
//   missing      a point the fresh sheet has on 8+ rounds that the document lacks
//   empty        a section with nothing under it
//
// The rewrite takes the model's reorganised outline and refuses numbers that
// are in neither the document nor the fresh sheet, so a rewrite can reorder,
// merge, cut and reword, but cannot make a number up.
// ---------------------------------------------------------------------------

import { editDistance } from './roundRefs.js';

const THIN = 5;
const MISSING_MIN = 8;
const MAX_MISSING = 12;
const LINK_FILES = 150;

/**
 * A point's words, numbers left out. Short words are dropped, except the site
 * and side letters ("A", "B", "T", "CT", written in capitals): "A contact" and
 * "B contact" are different points, not one point written twice.
 */
const words = (text) => {
  const s = String(text || '');
  const set = new Set(
    s
      .toLowerCase()
      .replace(/\d+(\.\d+)?%?/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2)
  );
  for (const m of s.matchAll(/(?<![A-Za-z])(A|B|T|CT)(?![A-Za-z])/g)) set.add(`@${m[1].toLowerCase()}`);
  return set;
};

/** The site a point is about: the first lone "A" or "B" in it, or ''. */
const leadSite = (text) => /(?<![A-Za-z])(A|B)(?![A-Za-z])/.exec(String(text || ''))?.[1] || '';

/**
 * Overlap of two points' words, numbers left out: 1 is the same sentence.
 * Two points that lead with different sites ("A contact ..." and "B contact
 * ...", which may each mention the other site later) count as half as alike.
 */
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const sim = both / (x.size + y.size - both);
  const sa = leadSite(a);
  const sb = leadSite(b);
  return sa && sb && sa !== sb ? sim / 2 : sim;
}

/**
 * A point's rounds as one key each: a link's file, or a mangled copy of one of
 * the other links (a repeated segment, a dropped hash character), is the same round.
 */
export function roundKeys(points) {
  const all = [...new Set(points.flatMap((p) => p.files || []))];
  // Group each file with the one it repairs to; a group is named by its first member.
  const group = new Map(all.map((f) => [f, f]));
  const find = (f) => (group.get(f) === f ? f : find(group.get(f)));
  // The same round: the round's own prefix (it holds the round number) exactly, and the demo hash
  // within two characters. A neighbouring round differs in its prefix, so it never joins.
  const prefix = (id) => String(id).split('_')[0];
  const hash = (id) => /~([0-9a-z]+)$/i.exec(String(id))?.[1] || '';
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (prefix(all[i]) !== prefix(all[j]) || editDistance(hash(all[i]), hash(all[j])) > 2) continue;
      const [x, y] = [find(all[i]), find(all[j])].sort();
      group.set(y, x);
    }
  }
  return points.map((p) => new Set((p.files || []).map(find)));
}

/** Shared rounds over all rounds of two sets: 1 is the same rounds. */
export function roundOverlap(a, b) {
  if (!a.size || !b.size) return null;
  let both = 0;
  for (const k of a) if (b.has(k)) both++;
  return both / (a.size + b.size - both);
}

/** The side a point is on, from its heading ("T side", "CT", "Nuke CT ..."). */
const sideWord = (p) => /(?<![A-Za-z])(CT|T)(?![A-Za-z])/.exec(`${p.side} ${p.section}`)?.[1] || '';

/**
 * Two points as one point or two:
 *   'same'       the same rounds (80%+ shared) and about the same thing, or the
 *                same words over overlapping (or unlinked) rounds
 *   'different'  alike in words, but over different rounds (under 20% shared)
 *   null         nothing to say
 * Points on different sides are never the same.
 */
export function samePoint(a, b, ra, rb) {
  const sa = sideWord(a);
  const sb = sideWord(b);
  if (sa && sb && sa !== sb) return null;
  const text = similarity(a.text, b.text);
  const rounds = roundOverlap(ra, rb);
  // Over the same rounds a rewording shares few words ("fast execute through main" / "main taken quickly
  // with utility"): the same site and a little overlap is enough. Two claims about other things in those
  // rounds (a smoke thrown, a site won) share less.
  const site = leadSite(a.text) === leadSite(b.text);
  if (rounds !== null && rounds >= 0.8 && Math.min(ra.size, rb.size) >= 3 && site && text >= 0.2) return 'same';
  if (text >= 0.8) return rounds === null || rounds >= 0.2 ? 'same' : 'different';
  return null;
}

/**
 * The percentages a text states for a count right next to them, the only
 * pairs where one must follow from the other:
 *   "5 of 8 (63%)", "5 of 8, 63%", "63% (5 of 8)", "Win 45% against A hits (9 of 20)".
 * A percentage about something else ("thrown in 81% of rounds): ... (3 of 4)")
 * is not paired: a bracket or another number stands between them.
 */
export function statedShares(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/(\d+)\s*(?:of|\/)\s*(\d+)(?:\s+[A-Za-z]+){0,2}\)?\s*[(,]\s*(\d+(?:\.\d+)?)\s*%/g)) out.push({ a: Number(m[1]), b: Number(m[2]), pct: Number(m[3]) });
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*%[^()%\d]{0,40}\(\s*(?:won\s+)?(\d+)\s*(?:of|\/)\s*(\d+)\s*\)/g)) out.push({ a: Number(m[2]), b: Number(m[3]), pct: Number(m[1]) });
  return out;
}

/** Every number written in a text, as written ("60", "7", "1:30"). */
export const numbersIn = (text) => String(text || '').match(/\d+:\d{2}|\d+(\.\d+)?/g) || [];

/**
 * A document's html as an outline. `parse` turns html into a Document
 * (DOMParser in the page; injectable for tests).
 * @returns {{ side: string, section: string, text: string, files: string[] }[]}
 */
export function outlineOfHtml(html, parse = (s) => new DOMParser().parseFromString(s, 'text/html')) {
  const doc = parse(`<div id="root">${html}</div>`);
  const root = doc.getElementById('root');
  const out = [];
  let side = '';
  let section = '';
  const filesOf = (node) =>
    [...node.querySelectorAll('a')].flatMap((a) => {
      const m = String(a.getAttribute('href') || '').match(/[?&]rounds=([^&#]+)/);
      return m ? decodeURIComponent(m[1]).split(',').filter(Boolean) : [];
    });
  const visit = (node) => {
    for (const child of node.children) {
      const tag = child.tagName;
      if (tag === 'H1') continue;
      if (tag === 'H2') {
        side = child.textContent.replace(/\s+/g, ' ').trim();
        section = '';
        out.push({ side, section: '', text: '', files: [], heading: true });
      } else if (tag === 'H3' || tag === 'H4') {
        section = child.textContent.replace(/\s+/g, ' ').trim();
        out.push({ side, section, text: '', files: [], heading: true });
      } else if (tag === 'LI' || tag === 'P' || tag === 'TD') {
        const clone = child.cloneNode(true);
        clone.querySelectorAll('ul, ol').forEach((x) => x.remove());
        const text = clone.textContent.replace(/\s+/g, ' ').trim();
        if (text) out.push({ side, section, text, files: [...new Set(filesOf(clone))] });
        visit(child);
      } else visit(child);
    }
  };
  visit(root);
  return out;
}

/**
 * Review a document's outline against a fresh one.
 * @param {object[]} doc     outlineOfHtml of the document
 * @param {object[]} fresh   the same team's sheet, built now, as points
 */
export function reviewOutline(doc, fresh) {
  const issues = [];
  const points = doc.filter((p) => !p.heading);
  const keys = roundKeys(points);
  const at = (p) => `${p.side}${p.section ? ` / ${p.section}` : ''}: "${p.text.length > 140 ? `${p.text.slice(0, 140)}…` : p.text}"`;

  // Sections with nothing under them.
  doc.forEach((h, i) => {
    if (!h.heading || !h.section) return;
    const next = doc[i + 1];
    if (!next || next.heading) issues.push({ kind: 'empty', text: `The section "${h.section}" (${h.side}) has no points.` });
  });

  points.forEach((p, i) => {
    // "a of b" and a percentage that has to follow from it.
    const counts = [...p.text.matchAll(/(\d+)\s*(?:of|\/)\s*(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (const [a, b] of counts) {
      if (a > b) issues.push({ kind: 'impossible', point: i, text: `${at(p)} says ${a} of ${b}.` });
    }
    for (const { a, b, pct } of statedShares(p.text)) {
      if (b > 0 && Math.abs((a / b) * 100 - pct) > 1.5) issues.push({ kind: 'arithmetic', point: i, text: `${at(p)}: ${a} of ${b} is ${Math.round((a / b) * 100)}%, not ${pct}%.` });
    }
    const n = Math.max(p.files.length, ...counts.map(([, b]) => b), 0);
    if (n && n < THIN) issues.push({ kind: 'thin', point: i, text: `${at(p)} rests on ${n} round${n === 1 ? '' : 's'}.` });

    for (let j = 0; j < i; j++) {
      const same = samePoint(points[j], p, keys[j], keys[i]);
      if (same === 'same') issues.push({ kind: 'duplicate', point: i, text: `${at(p)} repeats ${at(points[j])}${similarity(points[j].text, p.text) < 0.8 ? ' in other words, over the same rounds' : ''}: merge them into one point.` });
      else if (same === 'different') issues.push({ kind: 'same-words', point: i, text: `${at(p)} reads like ${at(points[j])} but is about other rounds: keep both, and say what tells them apart (side, buy, timing, map).` });
    }

    // Nothing to compare: no numbers, or only zeros ("Contact: 0% (0)"), which the fresh sheet leaves out.
    if (!numbersIn(p.text).some((n) => Number(n) !== 0) || !fresh.length) return;
    const best = fresh.map((f) => ({ f, s: similarity(f.text, p.text) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.6) {
      const mine = numbersIn(p.text).join(' ');
      const now = numbersIn(best.f.text).join(' ');
      if (mine !== now) issues.push({ kind: 'changed', point: i, text: `${at(p)} now reads: "${best.f.text}"` });
    } else {
      issues.push({ kind: 'unbacked', point: i, text: `${at(p)} is not in the current data (old numbers, or written by hand).` });
    }
  });

  // What the data shows strongly that the document does not have.
  const missing = fresh
    .filter((f) => f.files.length >= MISSING_MIN && !points.some((p) => similarity(p.text, f.text) >= 0.6))
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, MAX_MISSING);
  for (const f of missing) issues.push({ kind: 'missing', text: `Not in the document (${f.files.length} rounds): ${f.side} / ${f.section}: "${f.text}"` });

  const counts = {};
  for (const x of issues) counts[x.kind] = (counts[x.kind] || 0) + 1;
  return { points: points.length, sections: doc.filter((h) => h.heading && h.section).length, counts, issues };
}

/**
 * The model's rewritten outline, checked and turned into a document.
 *
 * @param {{ title: string, sections: { side?: string, heading: string, points: string[] }[] }} plan
 * @param {object[]} known  every point the rewrite may draw on (document + fresh), with files
 * @param {(s: string) => string} escapeHtml
 * @returns {{ html: string, points: number }}
 * @throws {Error} with the numbers that came from nowhere
 */
export function buildRewrite(plan, known, escapeHtml) {
  const sections = Array.isArray(plan?.sections) ? plan.sections : [];
  if (!sections.length) throw new Error('The rewrite needs sections, each with a heading and points.');
  const allowed = new Set(known.flatMap((k) => numbersIn(k.text)));
  // Small counts ("the 2 players", "1 smoke") are wording, not data.
  for (let n = 0; n <= 5; n++) allowed.add(String(n));
  /** number -> the first point that holds it, so the model can fix that one point */
  const invented = new Map();
  for (const s of sections) {
    for (const t of s.points || []) {
      // A percentage worked out from counts in the same point ("5 of 8 (63%)") is arithmetic, not a made-up number.
      const worked = new Set();
      for (const m of String(t).matchAll(/(\d+)\s*(?:of|\/)\s*(\d+)/g)) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (b > 0) {
          worked.add(String(Math.round((a / b) * 100)));
          worked.add(String(Math.round((a / b) * 1000) / 10));
        }
      }
      for (const n of numbersIn(t)) if (!allowed.has(n) && !worked.has(n) && !invented.has(n)) invented.set(n, t);
    }
  }
  if (invented.size) {
    const where = [...invented].slice(0, 6).map(([n, t]) => `${n} in "${String(t).slice(0, 70)}"`).join('; ');
    throw new Error(
      `These numbers are not in the document, the review, the sheet or a query you ran this turn: ${where}. Copy the number from one of those, or leave it out.`
    );
  }
  const linkOf = (text) => {
    // The same words, then the same numbers (the point it was copied from), then the most rounds.
    const nums = numbersIn(text).join(' ');
    const best = known
      .map((k) => ({ k, s: similarity(k.text, text), same: numbersIn(k.text).join(' ') === nums }))
      .filter((x) => x.s >= 0.5 && x.k.files.length)
      .sort((a, b) => b.s - a.s || b.same - a.same || b.k.files.length - a.k.files.length)[0];
    if (!best) return '';
    const files = best.k.files.slice(0, LINK_FILES);
    return ` <a href="/demos?rounds=${files.map(encodeURIComponent).join(',')}">${files.length} round${files.length === 1 ? '' : 's'}</a>`;
  };
  let html = `<h1>${escapeHtml(plan.title || 'Antistrat')}</h1>`;
  let side = null;
  let count = 0;
  for (const s of sections) {
    if ((s.side || '') !== side) {
      side = s.side || '';
      if (side) html += `<h2>${escapeHtml(side)}</h2>`;
    }
    html += `<h3>${escapeHtml(s.heading || '')}</h3><ul>`;
    for (const t of s.points || []) {
      const text = String(t || '').trim();
      if (!text) continue;
      html += `<li>${escapeHtml(text)}${linkOf(text)}</li>`;
      count++;
    }
    html += '</ul>';
  }
  return { html, points: count };
}
