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
//   duplicate    two points saying nearly the same thing
//   changed      the fresh sheet says the same thing with other numbers
//   unbacked     numbers the fresh sheet does not have (old data, or written by hand)
//   missing      a point the fresh sheet has on 8+ rounds that the document lacks
//   empty        a section with nothing under it
//
// The rewrite takes the model's reorganised outline and refuses numbers that
// are in neither the document nor the fresh sheet, so a rewrite can reorder,
// merge, cut and reword, but cannot make a number up.
// ---------------------------------------------------------------------------

const THIN = 5;
const MISSING_MIN = 8;
const MAX_MISSING = 12;
const LINK_FILES = 150;

const words = (text) =>
  new Set(
    String(text || '')
      .toLowerCase()
      .replace(/\d+(\.\d+)?%?/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2)
  );

/** Overlap of two points' words, numbers left out: 1 is the same sentence. */
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
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
    const pcts = [...p.text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
    for (const [a, b] of counts) {
      if (a > b) issues.push({ kind: 'impossible', point: i, text: `${at(p)} says ${a} of ${b}.` });
    }
    if (counts.length === 1 && pcts.length === 1) {
      const [a, b] = counts[0];
      if (b > 0 && Math.abs((a / b) * 100 - pcts[0]) > 1.5) issues.push({ kind: 'arithmetic', point: i, text: `${at(p)}: ${a} of ${b} is ${Math.round((a / b) * 100)}%, not ${pcts[0]}%.` });
    }
    const n = Math.max(p.files.length, ...counts.map(([, b]) => b), 0);
    if (n && n < THIN) issues.push({ kind: 'thin', point: i, text: `${at(p)} rests on ${n} round${n === 1 ? '' : 's'}.` });

    for (let j = 0; j < i; j++) {
      if (similarity(points[j].text, p.text) >= 0.8) issues.push({ kind: 'duplicate', point: i, text: `${at(p)} repeats ${at(points[j])}.` });
    }

    if (!numbersIn(p.text).length || !fresh.length) return;
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
  const invented = new Set();
  for (const s of sections) for (const t of s.points || []) for (const n of numbersIn(t)) if (!allowed.has(n)) invented.add(n);
  if (invented.size) {
    throw new Error(
      `These numbers are in neither the document nor the current data: ${[...invented].join(', ')}. Copy numbers from the review or the sheet, or leave them out.`
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
