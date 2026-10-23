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
//
// An edit changes part of the document where it stands (a section's points,
// one point, points added after another, a section's name) and keeps the rest
// of its html as it was: links, tables and layout. New text passes the same
// number check.
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

/**
 * Every number written in a text, as written ("60", "7", "1:30"). Digits inside a word are a name,
 * not a number: "p3kko", "8Juho8", "ak47", "2nd Yard" hold none, so a position line about p3kko is
 * not an unbacked number. A count written "2x" is still one.
 */
export const numbersIn = (text) => {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/\d+:\d{2}|\d+(\.\d+)?/g)) {
    const before = s[m.index - 1] || '';
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/[A-Za-z_]/.test(before)) continue;
    if (/^[A-Za-z_]/.test(after) && !/^x(?![A-Za-z])/i.test(after)) continue;
    out.push(m[0]);
  }
  return out;
};

const parseHtml = (s) => new DOMParser().parseFromString(s, 'text/html');
const textOf = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const filesOf = (node) =>
  [...node.querySelectorAll('a')].flatMap((a) => {
    const m = String(a.getAttribute('href') || '').match(/[?&]rounds=([^&#]+)/);
    return m ? decodeURIComponent(m[1]).split(',').filter(Boolean) : [];
  });

/**
 * Inside a point, what the outline reads on its own (nested lists, tables, headings, paragraphs) or
 * skips (the title). None of it is the point's own text: a sixpack box (a cell holding a heading and
 * a list) is not a point that repeats its heading.
 */
const OWN_BLOCKS = 'ul, ol, table, h1, h2, h3, h4, p';
/** The same, as tag names: what an edit to a point's own words leaves in place. */
const KEPT_BLOCKS = new Set(OWN_BLOCKS.toUpperCase().split(/,\s*/));

/** The "6 rounds" link a rewrite puts after a point: its rounds belong to the point, its words do not. */
const countLink = (a) => /[?&]rounds=/.test(String(a.getAttribute('href') || '')) && /^\d+ rounds?$/.test(textOf(a));

/** A point element's own words and rounds. */
function ownPoint(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(OWN_BLOCKS).forEach((x) => x.remove());
  const files = [...new Set(filesOf(clone))];
  clone.querySelectorAll('a').forEach((a) => countLink(a) && a.remove());
  return { text: textOf(clone), files };
}

/** The outline, each item with its element (`node`), in the order the review numbers the points. */
function outlineNodes(root) {
  const out = [];
  let side = '';
  let section = '';
  const visit = (node) => {
    for (const child of node.children) {
      const tag = child.tagName;
      if (tag === 'H1') continue;
      if (tag === 'H2') {
        side = textOf(child);
        section = '';
        out.push({ side, section: '', text: '', files: [], heading: true, node: child });
      } else if (tag === 'H3' || tag === 'H4') {
        section = textOf(child);
        out.push({ side, section, text: '', files: [], heading: true, node: child });
      } else if (tag === 'LI' || tag === 'P' || tag === 'TD') {
        const { text, files } = ownPoint(child);
        if (text) out.push({ side, section, text, files, node: child });
        visit(child);
      } else visit(child);
    }
  };
  visit(root);
  return out;
}

const withoutNodes = (items) => items.map(({ node: _node, ...p }) => p);

/**
 * A document's html as an outline. `parse` turns html into a Document
 * (DOMParser in the page; injectable for tests).
 * @returns {{ side: string, section: string, text: string, files: string[], heading?: boolean }[]}
 */
export function outlineOfHtml(html, parse = parseHtml) {
  return withoutNodes(outlineNodes(parse(`<div id="root">${html}</div>`).getElementById('root')));
}

/** A heading as the review writes it after "## ": "Nuke T side / Tells". */
export const sectionName = (p) => [p.side, p.section].filter(Boolean).join(' / ');

/**
 * An outline as sections, the shape a rewrite sends ({ side, heading, points }): a section for every
 * heading with points or a name of its own. A side heading with points straight under it is a
 * section without a heading.
 */
export function sectionsOfOutline(outline) {
  const out = [];
  let cur = null;
  for (const p of outline) {
    if (p.heading || !cur) out.push((cur = { side: p.side, heading: p.section, points: [] }));
    if (!p.heading) cur.points.push(p.text);
  }
  return out.filter((s) => s.heading || s.points.length);
}

/**
 * Review a document's outline against a fresh one.
 * @param {object[]} doc     outlineOfHtml of the document
 * @param {object[]} fresh   the same team's sheet, built now, as points (every style it can be written in)
 * @param {{ missingFrom?: object[] }} [opts]  missingFrom: the points a document of this style would
 *   have; a sixpack is short on purpose and is not "missing" what only the full sheet carries
 */
export function reviewOutline(doc, fresh, { missingFrom = fresh } = {}) {
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
  const missing = missingFrom
    .filter((f) => f.files.length >= MISSING_MIN && !points.some((p) => similarity(p.text, f.text) >= 0.6))
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, MAX_MISSING);
  for (const f of missing) issues.push({ kind: 'missing', text: `Not in the document (${f.files.length} rounds): ${f.side} / ${f.section}: "${f.text}"` });

  const counts = {};
  for (const x of issues) counts[x.kind] = (counts[x.kind] || 0) + 1;
  return { points: points.length, sections: doc.filter((h) => h.heading && h.section).length, counts, issues };
}

/** The numbers new text may use: every number in `known`, and small counts ("the 2 players", "1 smoke"), which are wording, not data. */
export function allowedNumbers(known) {
  const allowed = new Set(known.flatMap((k) => numbersIn(k.text)));
  for (let n = 0; n <= 5; n++) allowed.add(String(n));
  return allowed;
}

/** The numbers in `texts` that are not allowed: number -> the first text that holds it, so the model can fix that one point. */
export function inventedNumbers(texts, allowed) {
  const invented = new Map();
  for (const t of texts) {
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
  return invented;
}

const NOT_SEEN = 'not in the document, the review, the sheet or a query you ran this turn';

/** The link after a new point: the rounds of the known point it reads most like. */
export function roundLink(text, known) {
  // The same words, then the same numbers (the point it was copied from), then the most rounds.
  const nums = numbersIn(text).join(' ');
  const best = known
    .map((k) => ({ k, s: similarity(k.text, text), same: numbersIn(k.text).join(' ') === nums }))
    .filter((x) => x.s >= 0.5 && x.k.files.length)
    .sort((a, b) => b.s - a.s || b.same - a.same || b.k.files.length - a.k.files.length)[0];
  if (!best) return '';
  const files = best.k.files.slice(0, LINK_FILES);
  return ` <a href="/demos?rounds=${files.map(encodeURIComponent).join(',')}">${files.length} round${files.length === 1 ? '' : 's'}</a>`;
}

const pointsOf = (s) => (Array.isArray(s?.points) ? s.points : s?.points != null ? [s.points] : []);

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
  const invented = inventedNumbers(sections.flatMap(pointsOf), allowedNumbers(known));
  if (invented.size) {
    const where = [...invented].slice(0, 6).map(([n, t]) => `${n} in "${String(t).slice(0, 70)}"`).join('; ');
    throw new Error(`These numbers are ${NOT_SEEN}: ${where}. Copy the number from one of those, or leave it out.`);
  }
  let html = `<h1>${escapeHtml(plan.title || 'Antistrat')}</h1>`;
  let side = null;
  let count = 0;
  for (const s of sections) {
    if ((s.side || '') !== side) {
      side = s.side || '';
      if (side) html += `<h2>${escapeHtml(side)}</h2>`;
    }
    // A side's own points (sectionsOfOutline of a sheet with points straight under a side heading) have no heading.
    if (s.heading || !s.side) html += `<h3>${escapeHtml(s.heading || '')}</h3>`;
    html += '<ul>';
    for (const t of pointsOf(s)) {
      const text = String(t || '').trim();
      if (!text) continue;
      html += `<li>${escapeHtml(text)}${roundLink(text, known)}</li>`;
      count++;
    }
    html += '</ul>';
  }
  return { html, points: count };
}

// ---- edits -----------------------------------------------------------------

/** The edit operations, and other names a model gives them. */
const EDIT_OPS = {
  set_section: 'set_section',
  fill_section: 'set_section',
  replace_section: 'set_section',
  replace_point: 'replace_point',
  edit_point: 'replace_point',
  update_point: 'replace_point',
  delete_point: 'delete_point',
  remove_point: 'delete_point',
  add_points: 'add_points',
  add_point: 'add_points',
  insert_points: 'add_points',
  rename_section: 'rename_section',
  add_section: 'add_section',
  new_section: 'add_section',
  insert_section: 'add_section'
};

/** A point number as the model writes it: 12, "12", "#12", "12.". */
const pointNumber = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  const m = /^\s*#?(\d+)\.?\s*$/.exec(String(v ?? ''));
  return m ? Number(m[1]) : NaN;
};

/** An edit's new texts: its points, or its one text. */
const textsOfEdit = (e) =>
  (Array.isArray(e?.points) ? e.points : e?.points != null ? [e.points] : e?.text != null ? [e.text] : []).map((t) => String(t ?? '').trim()).filter(Boolean);

/** The same edit however it is written (key order, spacing): sent twice, it is made once. */
export function editKey(e) {
  const op = EDIT_OPS[String(e?.op || '').trim().toLowerCase()] || String(e?.op || '');
  const name = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // add_section's "after" is a section's name, add_points' a point number.
  const after = Number.isInteger(pointNumber(e?.after)) ? pointNumber(e.after) : name(e?.after);
  return JSON.stringify([op, pointNumber(e?.point), after, name(e?.section), name(e?.side), textsOfEdit(e), String(e?.heading || '').trim()]);
}

/** An edit as the refusal names it: "replace_point 14", "set_section \"Nuke T side / Notes\"". */
const editLabel = (e, op) => {
  if (op === 'add_section') return `add_section "${e?.heading || e?.section || ''}"`;
  const n = pointNumber(e?.point ?? e?.after);
  const where = op === 'add_points' && e?.after != null ? ` after ${e.after}` : Number.isInteger(n) ? ` ${n}` : '';
  const section = e?.section || (op === 'rename_section' ? '' : e?.heading);
  return `${op || e?.op || 'edit'}${where}${section && !where ? ` "${section}"` : ''}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Edits to a reviewed document, made in its html: everything not edited stays as it was (links,
 * tables, layout), and new text is checked and linked the way buildRewrite does it.
 *
 * Points are named by the review's numbers (outlineOfHtml order, 0 first) and sections by their
 * heading as the review writes it (sectionName). The numbers stay the review's through every edit:
 * deleting point 3 does not make point 4 point 3. Edits apply in order; one that cannot be made is
 * refused, with the reason, and the rest still apply.
 *
 *   set_section     { section, points }  the section holds these points: fills an empty one, replaces a full one
 *   replace_point   { point, text }
 *   delete_point    { point }
 *   add_points      { after, points }    after a point, or { section, points } at the end of a section
 *   rename_section  { section, heading }
 *   add_section     { side?, heading, points, after? }  a new section after the section `after` names,
 *                   else at the end of its side, else at the end of the document; a sixpack box's
 *                   section goes after the side's table, not into a box
 *
 * @param {string} html        the document as reviewed
 * @param {object[]} edits
 * @param {object[]} known     what new text may draw numbers and links from (as buildRewrite)
 * @param {(s: string) => string} escapeHtml
 * @param {{ checkFrom?: number, parse?: (s: string) => Document }} [opts]
 *   checkFrom: edits before it were checked when they were first made (an earlier call), so their
 *   numbers are not checked again and they are not described again
 * @returns {{ html: string, outline: object[], done: string[], refused: { index: number, why: string }[] }}
 */
export function editDocument(html, edits, known, escapeHtml, { checkFrom = 0, parse = parseHtml } = {}) {
  const doc = parse(`<div id="root">${html}</div>`);
  const root = doc.getElementById('root');
  const first = outlineNodes(root);
  /** The review's points by number: their elements stay the same objects through every edit. */
  const els = first.filter((p) => !p.heading).map((p) => p.node);
  /** heading element -> the name the review gave it, so a renamed section is still found by it */
  const reviewName = new Map(first.filter((p) => p.heading).map((p) => [p.node, sectionName(p)]));
  const allowed = allowedNumbers(known);
  /** point number -> why it is no longer there */
  const gone = new Map();
  const done = [];
  const refused = [];

  /** The sections as the document stands now: each heading with its points up to the next heading. */
  const sections = () => {
    const out = [];
    let cur = null;
    for (const p of outlineNodes(root)) {
      if (p.heading) out.push((cur = { node: p.node, name: sectionName(p), own: p.section || p.side, els: [] }));
      else cur?.els.push(p.node);
    }
    return out;
  };
  const norm = (s) => String(s || '').toLowerCase().replace(/^\s*#+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  /**
   * The section an edit names. Set and add also take the shape a rewrite's sections have
   * ({ side, heading }): asked again without its reasoning, the model wrote that.
   */
  const sectionNamed = (e, op) => {
    const name = e.section || (op === 'rename_section' ? '' : e.heading);
    const want = norm(name);
    const all = sections();
    if (!want) {
      const example = all.find((s) => s.name.includes(' / '))?.name || all[0]?.name;
      throw new Error(`give "section", the heading as the review writes it after "## "${example ? `, for example "${example}"` : ''}`);
    }
    const tries = [
      (s) => norm(s.name) === want || norm(reviewName.get(s.node)) === want,
      (s) => e.side && (norm(`${e.side} ${name}`) === norm(s.name) || norm(`${e.side} ${name}`) === norm(reviewName.get(s.node))),
      (s) => norm(s.own) === want,
      (s) => norm(s.name).endsWith(` ${want}`) || norm(reviewName.get(s.node)).endsWith(` ${want}`),
      (s) => norm(s.name).includes(want)
    ];
    for (const t of tries) {
      const hit = all.filter(t);
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) throw new Error(`"${name}" could be ${hit.slice(0, 6).map((s) => `"${s.name}"`).join(', ')}; name one in full`);
    }
    const names = all.slice(0, 30).map((s) => `"${s.name}"`).join(', ');
    throw new Error(`there is no section "${name}"${names ? `; the sections are ${names}${all.length > 30 ? ' …' : ''}` : ''}`);
  };
  const pointAt = (v) => {
    const n = pointNumber(v);
    if (!Number.isInteger(n)) throw new Error('give the point as its number in the review');
    if (n < 0 || n >= els.length) throw new Error(els.length ? `there is no point ${n}; the review numbers the points 0 to ${els.length - 1}` : 'the document has no points');
    if (gone.has(n)) throw new Error(`point ${n} ${gone.get(n)}`);
    return n;
  };
  const checkNumbers = (texts) => {
    const invented = inventedNumbers(texts, allowed);
    if (!invented.size) return;
    const where = [...invented].slice(0, 3).map(([n, t]) => `${n} in "${t.length > 70 ? `${t.slice(0, 70)}…` : t}"`).join(', ');
    throw new Error(`${where} ${invented.size === 1 ? 'is' : 'are'} ${NOT_SEEN}; copy the number from one of those, or leave it out`);
  };

  const pointHtml = (text) => `${escapeHtml(text)}${roundLink(text, known)}`;
  const make = (tag, inner = '') => {
    const el = doc.createElement(tag);
    if (inner) el.innerHTML = inner;
    return el;
  };
  const listOf = (texts) => {
    const ul = make('ul');
    for (const t of texts) ul.appendChild(make('li', pointHtml(t)));
    return ul;
  };
  const insertAfter = (ref, node) => ref.parentNode.insertBefore(node, ref.nextSibling);
  const tableOf = (el) => {
    let t = el;
    while (t && t.tagName !== 'TABLE') t = t.parentNode;
    return t || el;
  };
  /** The next element, when only blank text stands between. */
  const nextElement = (el) => {
    let n = el.nextSibling;
    while (n && n.nodeType !== 1) {
      if (String(n.textContent || '').trim()) return null;
      n = n.nextSibling;
    }
    return n;
  };
  /** A point's own words and links go; its nested lists and blocks stay. */
  const clearOwn = (el) => {
    for (const n of [...el.childNodes]) if (n.nodeType !== 1 || !KEPT_BLOCKS.has(n.tagName)) n.remove();
  };
  /** A list left without items, and a table left without words in its cells, go too. */
  const tidy = (el) => {
    if (!el?.parentNode) return;
    if ((el.tagName === 'UL' || el.tagName === 'OL') && !el.children.length) el.remove();
    else if (el.tagName === 'TABLE' && [...el.querySelectorAll('td')].every((td) => !textOf(td))) el.remove();
  };
  const removePoint = (el) => {
    if (el.tagName === 'TD') {
      clearOwn(el);
      return tidy(tableOf(el));
    }
    const parent = el.parentNode;
    // Only this point goes: its sub-points move up into its place.
    if (el.tagName === 'LI') {
      for (const sub of [...el.children]) if (sub.tagName === 'UL' || sub.tagName === 'OL') for (const li of [...sub.children]) parent.insertBefore(li, el);
    }
    el.remove();
    tidy(parent);
  };
  /** New points right after a point: list items beside a list item, else a list after it. */
  const addAfter = (el, texts) => {
    if (el.tagName === 'LI') {
      let at = el;
      for (const t of texts) at = insertAfter(at, make('li', pointHtml(t)));
      return;
    }
    if (el.tagName === 'TD') throw new Error(`point ${els.indexOf(el)} is a table cell; add the points at the end of its section instead`);
    // A label ("Force:") with its list right under it: the new points open that list.
    const next = nextElement(el);
    if (next && (next.tagName === 'UL' || next.tagName === 'OL')) {
      const head = next.firstChild;
      for (const t of texts) next.insertBefore(make('li', pointHtml(t)), head);
      return;
    }
    insertAfter(el, listOf(texts));
  };
  /** New points at the end of a section, or under its heading when it has none. */
  const addToSection = (s, texts) => {
    const last = s.els[s.els.length - 1];
    if (last) {
      // The end of the section's top-level list, not inside the last point's sub-list.
      let top = last;
      while (top.tagName === 'LI' && top.parentNode?.parentNode?.tagName === 'LI' && s.els.includes(top.parentNode.parentNode)) top = top.parentNode.parentNode;
      if (top.tagName === 'LI') return addAfter(top, texts);
      return insertAfter(top.tagName === 'TD' ? tableOf(top) : top, listOf(texts));
    }
    // The empty line a notes box is left with (<p><br></p>) is where the points go.
    const next = nextElement(s.node);
    if (next?.tagName === 'P' && !textOf(next) && !next.querySelectorAll('img').length) {
      next.parentNode.insertBefore(listOf(texts), next);
      next.remove();
    } else insertAfter(s.node, listOf(texts));
  };
  /** Points that went with another element (a table cell inside a deleted item) are gone too. */
  const attached = (el) => {
    for (let n = el; n; n = n.parentNode) if (n === root) return true;
    return false;
  };
  const markGone = (why) =>
    els.forEach((el, n) => {
      if (!gone.has(n) && !attached(el)) gone.set(n, why);
    });
  /** The side (h2) a name means: its whole text, or words of it ("T side", "Dust2 CT side"). Null when the document has no sides. */
  const sideNamed = (name) => {
    const all = sections().filter((s) => s.node.tagName === 'H2');
    if (!all.length) return null;
    const want = norm(name);
    const tries = [(s) => norm(s.name) === want || norm(reviewName.get(s.node)) === want, (s) => ` ${norm(s.name)} `.includes(` ${want} `) || ` ${norm(reviewName.get(s.node))} `.includes(` ${want} `)];
    for (const t of tries) {
      const hit = all.filter(t);
      if (hit.length === 1) return hit[0];
      if (hit.length > 1) throw new Error(`side "${name}" could be ${hit.slice(0, 6).map((s) => `"${s.name}"`).join(', ')}; name one in full`);
    }
    throw new Error(`there is no side "${name}"; the sides are ${all.map((s) => `"${s.name}"`).join(', ')}`);
  };
  /** The first element after `node` (at its level, then its parents') that is or holds one of `tags`: what a new section goes before. */
  const nextHolding = (node, tags) => {
    for (let n = node; n && n !== root; n = n.parentNode) {
      for (let s = n.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1 && (tags.includes(s.tagName) || s.querySelectorAll(tags.join(', ')).length)) return s;
    }
    return null;
  };
  /** Where a new section goes: after a named section (after a sixpack box's table, not in the box), at the end of a side, or at the end. */
  const sectionPlace = (after, side) => {
    if (after) {
      let box = after.node;
      while (box !== root && box.tagName !== 'TD') box = box.parentNode;
      if (box !== root) return { parent: tableOf(box).parentNode, ref: tableOf(box).nextSibling };
      const tags = after.node.tagName === 'H2' ? ['H1', 'H2'] : ['H1', 'H2', 'H3', 'H4'];
      const next = nextHolding(after.node, tags);
      return next ? { parent: next.parentNode, ref: next } : { parent: after.node.parentNode, ref: null };
    }
    const next = side && nextHolding(side.node, ['H1', 'H2']);
    return next ? { parent: next.parentNode, ref: next } : { parent: root, ref: null };
  };

  edits.forEach((e, i) => {
    const op = EDIT_OPS[String(e?.op || '').trim().toLowerCase()];
    const fresh = i >= checkFrom;
    try {
      if (!op) throw new Error(`op must be one of set_section, replace_point, delete_point, add_points, rename_section, add_section`);
      const texts = textsOfEdit(e);
      if (op === 'set_section') {
        const s = sectionNamed(e, op);
        if (!texts.length) throw new Error('give the points the section is to hold (delete_point removes single points)');
        if (fresh) checkNumbers(texts);
        const had = s.els.length;
        const at = s.els[0];
        // The new points go where the first old one stands (beside it in its list), then the old ones go.
        if (!at) addToSection(s, texts);
        else if (at.tagName === 'LI') addAfter(at, texts);
        else {
          const ref = at.tagName === 'TD' ? tableOf(at) : at;
          ref.parentNode.insertBefore(listOf(texts), ref);
        }
        for (const el of s.els) {
          const n = els.indexOf(el);
          if (n >= 0 && !gone.has(n)) gone.set(n, `was replaced when its section was set by an earlier edit`);
          if (el.parentNode) removePoint(el);
        }
        markGone('went with its section, set by an earlier edit');
        if (fresh) done.push(`${had ? 'set' : 'filled'} "${s.name}" ${had ? 'to' : 'with'} ${plural(texts.length, 'point')}`);
      } else if (op === 'replace_point') {
        const n = pointAt(e.point);
        const text = e.text != null ? String(e.text).trim() : texts.length === 1 ? texts[0] : '';
        if (!text) throw new Error('give the new text');
        if (fresh) checkNumbers([text]);
        clearOwn(els[n]);
        els[n].insertAdjacentHTML('afterbegin', pointHtml(text));
        if (fresh) done.push(`replaced point ${n}`);
      } else if (op === 'delete_point') {
        const n = pointAt(e.point);
        removePoint(els[n]);
        gone.set(n, 'was deleted by an earlier edit');
        markGone(`went with point ${n}, deleted by an earlier edit`);
        if (fresh) done.push(`deleted point ${n}`);
      } else if (op === 'add_points') {
        if (!texts.length) throw new Error('give the points to add');
        const n = e.after != null ? pointAt(e.after) : e.section || e.heading ? null : e.point != null ? pointAt(e.point) : NaN;
        if (Number.isNaN(n)) throw new Error('give "after" (a point number) or "section"');
        if (fresh) checkNumbers(texts);
        if (n === null) {
          const s = sectionNamed(e, op);
          addToSection(s, texts);
          if (fresh) done.push(`added ${plural(texts.length, 'point')} to "${s.name}"`);
        } else {
          addAfter(els[n], texts);
          if (fresh) done.push(`added ${plural(texts.length, 'point')} after point ${n}`);
        }
      } else if (op === 'rename_section') {
        const s = sectionNamed(e, op);
        const heading = String(e.heading ?? e.text ?? '').replace(/\s+/g, ' ').trim();
        if (!heading) throw new Error('give the new heading');
        if (fresh) checkNumbers([heading]);
        // A heading that is one round link (a sixpack side) keeps the link.
        const links = [...s.node.querySelectorAll('a')];
        if (links.length === 1 && textOf(links[0]) === textOf(s.node)) links[0].textContent = heading;
        else s.node.textContent = heading;
        if (fresh) done.push(`renamed "${s.name}" to "${heading}"`);
      } else if (op === 'add_section') {
        // The new heading, and where it goes; "section" stands in for whichever of the two is missing.
        let heading = String(e.heading ?? e.section ?? '').replace(/\s+/g, ' ').trim();
        let side = String(e.side || '').trim();
        const afterName = e.after ?? (e.heading != null ? e.section : null);
        if (!side && afterName == null && heading.includes(' / ')) {
          // Written as the review names sections ("HAVU: Dust2, T side / Manual review"), when that is a side;
          // else a heading of its own ("Force / Antiforce").
          const cut = heading.lastIndexOf(' / ');
          try {
            if (sideNamed(heading.slice(0, cut))) [side, heading] = [heading.slice(0, cut), heading.slice(cut + 3).trim()];
          } catch {
            // not a side
          }
        }
        if (!heading) throw new Error('give the new "heading"');
        if (!texts.length) throw new Error('give the points the new section holds');
        if (fresh) checkNumbers([heading, ...texts]);
        let after = null;
        if (afterName != null && String(afterName).trim()) {
          const n = pointNumber(afterName);
          after = Number.isInteger(n) ? sections().find((s) => s.els.includes(els[pointAt(n)])) : sectionNamed({ section: String(afterName), side }, op);
        }
        const { parent, ref } = sectionPlace(after, !after && side ? sideNamed(side) : null);
        const h3 = make('h3', escapeHtml(heading));
        const ul = listOf(texts);
        parent.insertBefore(h3, ref);
        parent.insertBefore(ul, ref);
        const all = sections();
        const name = all.find((s) => s.node === h3).name;
        if (all.some((s) => s.node !== h3 && norm(s.name) === norm(name))) {
          h3.remove();
          ul.remove();
          throw new Error(`there is already a section "${name}"; add_points {section, points} adds to it`);
        }
        if (fresh) done.push(`added the section "${name}" with ${plural(texts.length, 'point')}`);
      }
    } catch (err) {
      refused.push({ index: i, why: `${editLabel(e, op)}: ${err.message}.` });
    }
  });
  return { html: root.innerHTML, outline: withoutNodes(outlineNodes(root)), done, refused };
}
