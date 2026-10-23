// Run: node src/replays\eye\eyeDocuments.test.js
//
// The document tools against a fake team API: documents that share a title,
// reading them by id, the date on a title, a rewrite sent in parts, the
// numbers a rewrite may quote, and edits made in a document by the review's numbers.

import assert from 'node:assert/strict';
import { resetTurnFacts, runTool, shortDate } from './eyeTools.js';
import { editDocument, outlineOfHtml } from './docReview.js';

// There is no DOM in node: a small one, enough to read an outline and make edits (parse, walk,
// change, serialize). It throws where a browser would, so a wrong insert fails here too.
const VOID = new Set(['BR', 'HR', 'IMG']);
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITY[e]);
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
class Node {
  get nextSibling() {
    const list = this.parentNode?.childNodes;
    return list ? list[list.indexOf(this) + 1] || null : null;
  }
  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
}
class Text extends Node {
  constructor(data) {
    super();
    Object.assign(this, { nodeType: 3, data, parentNode: null });
  }
  get textContent() {
    return this.data;
  }
  cloneNode() {
    return new Text(this.data);
  }
}
class Element extends Node {
  constructor(tag, attrs = []) {
    super();
    Object.assign(this, { nodeType: 1, tagName: tag.toUpperCase(), attrs, childNodes: [], parentNode: null });
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    for (const n of [...this.childNodes]) n.remove();
    if (String(v)) this.appendChild(new Text(String(v)));
  }
  get innerHTML() {
    return this.childNodes.map(serialize).join('');
  }
  set innerHTML(src) {
    for (const n of [...this.childNodes]) n.remove();
    for (const n of parseFragment(src)) this.appendChild(n);
  }
  getAttribute(name) {
    return this.attrs.find(([k]) => k === name)?.[1] ?? null;
  }
  querySelectorAll(selector) {
    const tags = selector.split(',').map((s) => s.trim().toUpperCase());
    const out = [];
    const walk = (n) => n.children.forEach((c) => (tags.includes(c.tagName) && out.push(c), walk(c)));
    walk(this);
    return out;
  }
  cloneNode(deep) {
    const copy = new Element(this.tagName, this.attrs.map((a) => [...a]));
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }
  appendChild(n) {
    return this.insertBefore(n, null);
  }
  insertBefore(n, ref) {
    if (ref && ref.parentNode !== this) throw new Error('NotFoundError: the reference is not a child of this node');
    n.remove();
    n.parentNode = this;
    if (ref) this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
    else this.childNodes.push(n);
    return n;
  }
  insertAdjacentHTML(where, src) {
    assert.equal(where, 'afterbegin', 'only afterbegin is used');
    const head = this.firstChild;
    for (const n of parseFragment(src)) this.insertBefore(n, head);
  }
}
function parseFragment(src) {
  const top = new Element('#fragment');
  let cur = top;
  for (const m of String(src).matchAll(/<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>|([^<]+)/gi)) {
    if (m[1]) {
      let n = cur;
      while (n !== top && n.tagName !== m[1].toUpperCase()) n = n.parentNode;
      if (n !== top) cur = n.parentNode;
    } else if (m[2]) {
      const el = cur.appendChild(new Element(m[2], [...m[3].matchAll(/([a-z-]+)="([^"]*)"/gi)].map((a) => [a[1].toLowerCase(), decode(a[2])])));
      if (!VOID.has(el.tagName)) cur = el;
    } else cur.appendChild(new Text(decode(m[4])));
  }
  const nodes = [...top.childNodes];
  nodes.forEach((n) => n.remove());
  return nodes;
}
function serialize(n) {
  if (n.nodeType === 3) return escText(n.data);
  const tag = n.tagName.toLowerCase();
  const open = `<${tag}${n.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}>`;
  return VOID.has(n.tagName) ? open : `${open}${n.innerHTML}</${tag}>`;
}
globalThis.DOMParser = class {
  parseFromString(src) {
    const body = new Element('body');
    body.innerHTML = src;
    const byId = (n, id) => (n.getAttribute('id') === id ? n : n.children.map((c) => byId(c, id)).find(Boolean) || null);
    return { body, getElementById: (id) => byId(body, id), createElement: (tag) => new Element(tag) };
  }
};

const NOW = Date.UTC(2026, 9, 17, 19, 30);
const html = (title, point) => `<h1>${title}</h1><h2>Nuke T side</h2><h3>Tells</h3><ul><li>${point}</li></ul>`;
const docs = [
  { id: 'old1', title: 'Outline: HAVU on Nuke (16 Oct)', updatedAt: NOW - 86400000, html: html('Outline', 'Garage flash then A, 5 of 6.') },
  { id: 'old2', title: 'Outline: HAVU on Nuke (17 Oct)', updatedAt: NOW - 7200000, html: html('Outline', 'Garage flash then A, 4 of 6.') },
  { id: 'new1', title: 'Outline: HAVU on Nuke (17 Oct)', updatedAt: NOW, html: html('Outline', 'Garage flash then A, 5 of 6.') },
  { id: 'note', title: 'Practice notes', updatedAt: NOW - 1000, html: html('Notes', 'Warm up first.') }
];
const saved = [];
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url), 'http://x').pathname;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path === '/api/teams' && !init.method) return json({ teams: [{ id: 't1', name: 'The Golden Horde', documents: docs.map(({ html: _h, ...d }) => d) }] });
  const one = /^\/api\/teams\/t1\/documents\/(\w+)$/.exec(path);
  if (one) return json({ document: docs.find((d) => d.id === one[1]) });
  if (path === '/api/teams/t1/documents' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    saved.push(body);
    return json({ document: { id: body.id || `copy${saved.length}` } });
  }
  return new Response('{}', { status: 404 });
};

// shortDate: people's dates, not timestamps.
assert.match(shortDate(NOW), /^\d{1,2} Oct \d\d:\d\d$/);
assert.match(shortDate(NOW, false), /^\d{1,2} Oct$/);
assert.equal(shortDate(0), '');

// The list: newest first, with ids and written dates, no raw timestamps.
let r = await runTool('team_documents', {});
let list = JSON.parse(r.content);
assert.deepEqual(list.documents.map((d) => d.id), ['new1', 'note', 'old2', 'old1']);
assert.ok(list.documents.every((d) => /Oct \d\d:\d\d$/.test(d.updated)));
assert.doesNotMatch(r.content, /\d{12,}/);

// Same title twice: the newest is read, and the result says so.
r = await runTool('team_documents', { title: 'Outline: HAVU on Nuke (17 Oct)' });
let read = JSON.parse(r.content);
assert.equal(read.id, 'new1');
assert.match(read.note, /3 documents have this title \(dates aside\); used the newest, "Outline: HAVU on Nuke \(17 Oct\)"/);

// C11: the title without its date finds the newest dated copy, not an older undated
// document whose title matches it exactly.
docs.push({ id: 'undated', title: 'Outline: HAVU on Nuke', updatedAt: NOW - 5 * 86400000, html: html('Outline', 'Old.') });
r = await runTool('team_documents', { title: 'Outline: HAVU on Nuke' });
assert.equal(JSON.parse(r.content).id, 'new1');
docs.pop();

// By id: exactly that one, no note.
r = await runTool('team_documents', { id: 'old2' });
read = JSON.parse(r.content);
assert.equal(read.id, 'old2');
assert.equal(read.note, undefined);
assert.match(read.text, /4 of 6/);

// Copies that differ only by date are one document: part of the title finds the newest.
r = await runTool('team_documents', { title: 'HAVU on Nuke' });
assert.equal(JSON.parse(r.content).id, 'new1');

// Different documents that all contain the words: refused, with dates and ids to tell them apart.
docs.push({ id: 'sum1', title: 'Summary: HAVU on Nuke (15 Oct)', updatedAt: NOW - 2 * 86400000, html: html('Summary', 'x') });
r = await runTool('team_documents', { title: 'HAVU on Nuke' });
assert.match(r.content, /^Error: "HAVU on Nuke" matches different documents/);
assert.match(r.content, /id new1/);
assert.match(r.content, /id sum1/);
assert.match(r.content, /Call again with the id/);
docs.pop();

// A missing id says so.
r = await runTool('team_documents', { id: 'nope' });
assert.match(r.content, /^Error: No document with id "nope"/);

// Review by id (the title has no map to compare with, so no data comparison, but the review is kept).
r = await runTool('review_antistrat_document', { id: 'note' });
let review = JSON.parse(r.content);
assert.equal(review.id, 'note');
assert.match(review.note, /Not compared with the data/);

// "Review this doc: HAVU: Nuke": the words of the ask, not the title as written, find it (newest copy).
r = await runTool('team_documents', { title: 'HAVU: Nuke' });
assert.equal(JSON.parse(r.content).id, 'new1');
assert.match((await runTool('team_documents', { title: 'HAVU: Inferno' })).content, /^Error: No document called/);

// Long answers come in parts on line ends, and say how to get the next.
{
  const { partOf, styleOfTitle } = await import('./eyeTools.js');
  const lines = Array.from({ length: 50 }, (_, i) => `${i}. ${'x'.repeat(390)}`);
  const first = partOf(lines, 1, 4000);
  assert.equal(first.parts, 5);
  assert.equal(first.lines.length, 10);
  assert.equal(partOf(lines, 9, 4000).part, 5, 'a part past the end is the last one');
  assert.deepEqual(partOf(lines, 1, 4000).lines.concat(...[2, 3, 4, 5].map((n) => partOf(lines, n, 4000).lines)), lines, 'nothing lost between parts');
  assert.equal(styleOfTitle('Sixpack: HAVU on Dust2 (18 Oct)'), 'sixpack');
  assert.equal(styleOfTitle('Reviewed: Outline: BC.Game on Cache (19 Oct)'), 'outline');
  assert.equal(styleOfTitle('Summary: Drama on Nuke'), 'full');
}

// Rewrite without a review: refused.
r = await runTool('rewrite_antistrat_document', { id: 'old1', sections: [{ heading: 'Tells', points: ['x'] }] });
assert.match(r.content, /Review the document first/);

// Rewrite in parts: nothing is saved until the final call, and parts join in order.
resetTurnFacts();
r = await runTool('rewrite_antistrat_document', { id: 'note', final: false, sections: [{ side: 'Nuke T side', heading: 'Tells', points: ['Warm up first.'] }] });
assert.match(r.content, /Kept 1 section \(1 so far\).*Nothing is saved yet/);
assert.equal(saved.length, 0);
r = await runTool('rewrite_antistrat_document', { id: 'note', final: false, sections: [{ side: 'Nuke T side', heading: 'Pistols', points: ['Rush B.'] }] });
assert.match(r.content, /\(2 so far\)/);
r = await runTool('rewrite_antistrat_document', { id: 'note', sections: [{ side: 'Nuke CT side', heading: 'Notes', points: ['Stack A.'] }] });
assert.match(r.content, /^Saved "Reviewed: Practice notes" \(id copy1\): 3 sections, 3 points/);
assert.equal(saved.length, 1);
const order = [...saved[0].html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
assert.deepEqual(order, ['Tells', 'Pistols', 'Notes']);

// C15: more sections sent later (no final false, even in a later question) go into the
// same copy, not a second partial document. A heading sent again replaces its section.
resetTurnFacts();
r = await runTool('rewrite_antistrat_document', { id: 'note', sections: [{ side: 'Nuke CT side', heading: 'Retakes', points: ['Retake B together.'] }, { side: 'Nuke T side', heading: 'Pistols', points: ['Rush A.'] }] });
assert.match(r.content, /^Updated "Reviewed: Practice notes" \(id copy1\): 4 sections/);
assert.equal(saved.length, 2);
assert.equal(saved[1].id, 'copy1', 'the copy is overwritten, not a new one');
assert.deepEqual([...saved[1].html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Tells', 'Pistols', 'Notes', 'Retakes']);
assert.ok(saved[1].html.includes('Rush A.') && !saved[1].html.includes('Rush B.'));

// Numbers: one the model never saw is refused, naming the point; the sections stay kept.
resetTurnFacts();
await runTool('review_antistrat_document', { id: 'note' });
r = await runTool('rewrite_antistrat_document', { id: 'note', sections: [{ side: 'Nuke T side', heading: 'Tells', points: ['Garage flash, 95 of 99.'] }] });
assert.match(r.content, /^Error: These numbers are not in .*95 in "Garage flash, 95 of 99\."/);
assert.match(r.content, /kept/);

// A number that is in the document passes. (Numbers from this turn's data tools, such as
// query_rounds, pass too; those tools need the demo library, so they are not run here.)
resetTurnFacts();
await runTool('review_antistrat_document', { id: 'old2' });
const before = saved.length;
r = await runTool('rewrite_antistrat_document', { id: 'old2', mode: 'copy', sections: [{ side: 'Nuke T side', heading: 'Tells', points: ['Garage flash then A, 4 of 6.'] }] });
assert.match(r.content, /^Saved "Reviewed: /, 'numbers from the document itself still pass');
assert.equal(saved.length, before + 1);

// ---- edits: part of a document changed where it stands -------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shape = (outline) => outline.map((p) => (p.heading ? `## ${[p.side, p.section].filter(Boolean).join(' / ')}` : p.text));

// A sixpack box (a cell with a heading and a list) is not a point that repeats its heading, and the
// "6 rounds" link a rewrite adds after a point is not part of its words (its rounds still are).
assert.deepEqual(
  shape(outlineOfHtml('<table><tbody><tr><td><h3>T Positions</h3><ul><li>alxc = B Upper</li></ul></td><td><h3>General notes</h3><p><br></p></td></tr></tbody></table>')),
  ['## T Positions', 'alxc = B Upper', '## General notes']
);
assert.deepEqual(outlineOfHtml('<h3>Tells</h3><ul><li>Doors smoke: 81% <a href="/demos?rounds=u1,u2">2 rounds</a></li></ul>')[1], {
  side: '',
  section: 'Tells',
  text: 'Doors smoke: 81%',
  files: ['u1', 'u2']
});

// The operations on their own, in a summary sheet's section: a label, a list with a sub-point, a second label.
{
  const sheet = '<h2>T Force / Antiforce</h2><p>Force:</p><ul><li>2x B rush (won 1)<ul><li>both through Upper</li></ul></li><li>1x A pop</li></ul><p>Antiforce:</p><ul><li>3x default</li></ul>';
  // 0 Force:  1 2x B rush (won 1)  2 both through Upper  3 1x A pop  4 Antiforce:  5 3x default
  const known = outlineOfHtml(sheet);
  let out = editDocument(sheet, [{ op: 'delete_point', point: 1 }], known, esc);
  assert.equal(out.html, '<h2>T Force / Antiforce</h2><p>Force:</p><ul><li>both through Upper</li><li>1x A pop</li></ul><p>Antiforce:</p><ul><li>3x default</li></ul>', 'only that point goes: its sub-point moves up');
  out = editDocument(sheet, [{ op: 'add_points', after: 0, points: ['1x A split (won 1)'] }], known, esc);
  assert.ok(out.html.includes('<p>Force:</p><ul><li>1x A split (won 1)</li><li>2x B rush'), 'after a label, the new point opens its list');
  out = editDocument(sheet, [{ op: 'add_points', after: 1, points: ['1x B split'] }], known, esc);
  assert.ok(out.html.includes('both through Upper</li></ul></li><li>1x B split</li><li>1x A pop'), 'after a point with a sub-point, after both');
  out = editDocument(sheet, [{ op: 'set_section', section: 'T Force / Antiforce', points: ['Force: 2x B rush, 1x A pop.'] }], known, esc);
  assert.equal(out.html, '<h2>T Force / Antiforce</h2><ul><li>Force: 2x B rush, 1x A pop.</li></ul>', 'set_section replaces every point, labels and lists');
  out = editDocument(sheet, [{ op: 'replace_point', point: 1, text: '2x B rush (won 1), both fast' }], known, esc);
  assert.ok(out.html.includes('<li>2x B rush (won 1), both fast<ul><li>both through Upper</li></ul></li>'), 'a replaced point keeps its sub-points');
  // Numbers stay the review's: deleting 1 does not make 3 point 2, and a deleted point cannot be edited.
  out = editDocument(sheet, [{ op: 'delete_point', point: 1 }, { op: 'replace_point', point: 3, text: '1x A pop (won 0)' }, { op: 'delete_point', point: 1 }], known, esc);
  assert.ok(out.html.includes('<li>1x A pop (won 0)</li>'));
  assert.deepEqual(out.refused, [{ index: 2, why: 'delete_point 1: point 1 was deleted by an earlier edit.' }]);
  assert.match(editDocument(sheet, [{ op: 'replace_point', point: 9, text: 'x' }], known, esc).refused[0].why, /there is no point 9; the review numbers the points 0 to 5/);
  assert.match(editDocument(sheet, [{ op: 'move_point', point: 1 }], known, esc).refused[0].why, /op must be one of/);

  // A table's cells are points; a section that is only a table is replaced by the new list.
  const table = '<h3>T Round list</h3><table><thead><tr><th>Round</th><th>Call</th></tr></thead><tbody><tr><td>R3</td><td>A exec</td></tr></tbody></table><h3>Notes</h3><p>Fast.</p>';
  assert.match(editDocument(table, [{ op: 'add_points', after: 1, points: ['x'] }], [], esc).refused[0].why, /point 1 is a table cell; add the points at the end of its section/);
  assert.equal(editDocument(table, [{ op: 'set_section', section: 'T Round list', points: ['Mostly A executes.'] }], [], esc).html, '<h3>T Round list</h3><ul><li>Mostly A executes.</li></ul><h3>Notes</h3><p>Fast.</p>');
  assert.ok(editDocument(table, [{ op: 'delete_point', point: 0 }], [], esc).html.includes('<tr><td></td><td>A exec</td></tr>'), 'a deleted cell is emptied; the table stays');
}

// The sixpack the 19 Oct HAVU chat asked to fill in: through the tool, with the review's numbers.
const SIX_NOTES = '<td><h3>General notes</h3><p><br></p></td>';
const SIX = [
  '<h1 style="font-size: 25px">HAVU: Dust2</h1>',
  '<h2 style="font-size: 19px"><a href="/demos?rounds=t1,t2">HAVU: Dust2, T side</a></h2>',
  '<table data-layout="sixpack"><tbody>',
  '<tr><td><h3>T Positions</h3><ul><li>alxc = B Upper</li><li>p3kko = T Mid</li></ul></td>',
  '<td><h3>T Default utility</h3><ul><li><a href="/demos?rounds=u1,u2,u3">Doors smoke</a>: 81% (usually 1:48)</li><li>Catwalk molo: 62% (usually 1:44, ottob)</li></ul></td></tr>',
  '<tr><td><h3>T Biggest tells</h3><ul><li><a href="/demos?rounds=b1,b2">B flash and B Doors smoke</a> → <a href="/demos?rounds=b1">most likely B</a> (14 of 17)</li><li>Jumper smoke → most likely short pop (9 of 11)</li></ul></td>',
  `${SIX_NOTES}</tr></tbody></table>`,
  '<h2 style="font-size: 19px"><a href="/demos?rounds=c1">HAVU: Dust2, CT side</a></h2>',
  `<table data-layout="sixpack"><tbody><tr><td><h3>CT Positions</h3><ul><li>Uli = B Anchor</li></ul></td>${SIX_NOTES}</tr></tbody></table>`
].join('');
// A section named the way a rewrite's sections are ({ side, heading }), as the model wrote it when it
// was asked again without its reasoning in the bench of this chat; a section not named at all is
// refused with one from the document to copy.
{
  const known = outlineOfHtml(SIX);
  const out = editDocument(SIX, [{ op: 'set_section', side: 'HAVU: Dust2, CT side', heading: 'General notes', points: ['Uli anchors B: hit A.'] }], known, esc);
  assert.deepEqual(out.refused, []);
  assert.ok(out.html.endsWith('<td><h3>General notes</h3><ul><li>Uli anchors B: hit A.</li></ul></td></tr></tbody></table>'), 'the CT notes, not the T ones');
  assert.equal(
    editDocument(SIX, [{ op: 'set_section', points: ['x'] }], known, esc).refused[0].why,
    'set_section: give "section", the heading as the review writes it after "## ", for example "HAVU: Dust2, T side / T Positions".'
  );
}

// add_section: a new section after a named one, at the end of a side, or at the end; the rest stays byte for byte.
{
  const plain = '<h1>Outline</h1><h2>Nuke T side</h2><h3>Tells</h3><ul><li>Garage flash then A, 5 of 6.</li></ul><h3>Pistols</h3><ul><li>Rush B.</li></ul><h2>Nuke CT side</h2><h3>Notes</h3><ul><li>Stack A.</li></ul>';
  const known = outlineOfHtml(plain);
  const mr = (t) => `<h3>Manual review</h3><ul><li>${t}</li></ul>`;
  let out = editDocument(plain, [{ op: 'add_section', after: 'Nuke T side / Tells', heading: 'Manual review', points: ['Garage flash early: 5 of 6 go A.'] }], known, esc);
  assert.deepEqual(out.refused, []);
  assert.equal(out.html, plain.replace('<h3>Pistols', `${mr('Garage flash early: 5 of 6 go A.')}<h3>Pistols`), 'after the named section, before the next');
  assert.deepEqual(out.done, ['added the section "Nuke T side / Manual review" with 1 point']);
  out = editDocument(plain, [{ op: 'add_section', side: 'T side', heading: 'Manual review', points: ['Slow defaults.'] }, { op: 'add_section', side: 'Nuke CT side', heading: 'Manual review', points: ['Late rotations.'] }], known, esc);
  assert.equal(out.html, plain.replace('<h2>Nuke CT side', `${mr('Slow defaults.')}<h2>Nuke CT side`) + mr('Late rotations.'), 'at the end of each side');
  assert.deepEqual(shape(out.outline).filter((s) => s.startsWith('## ')), ['## Nuke T side', '## Nuke T side / Tells', '## Nuke T side / Pistols', '## Nuke T side / Manual review', '## Nuke CT side', '## Nuke CT side / Notes', '## Nuke CT side / Manual review']);
  // Without a side, at the end; a heading with " / " that is no side is a heading of its own.
  assert.equal(editDocument(plain, [{ op: 'add_section', heading: 'Force / Antiforce', points: ['Rush B.'] }], known, esc).html, `${plain}<h3>Force / Antiforce</h3><ul><li>Rush B.</li></ul>`);
  // The same heading twice under one side, a side that is not there, a number nobody measured: refused by name.
  out = editDocument(plain, [{ op: 'add_section', side: 'T side', heading: 'Manual review', points: ['Slow defaults.'] }, { op: 'add_section', side: 'Nuke T side', heading: 'Manual review', points: ['Fast B.'] }], known, esc);
  assert.deepEqual(out.refused, [{ index: 1, why: 'add_section "Manual review": there is already a section "Nuke T side / Manual review"; add_points {section, points} adds to it.' }]);
  assert.equal(out.html, plain.replace('<h2>Nuke CT side', `${mr('Slow defaults.')}<h2>Nuke CT side`), 'the refused one leaves nothing behind');
  assert.match(editDocument(plain, [{ op: 'add_section', side: 'Inferno T side', heading: 'Manual review', points: ['x'] }], known, esc).refused[0].why, /there is no side "Inferno T side"; the sides are "Nuke T side", "Nuke CT side"\./);
  out = editDocument(plain, [{ op: 'add_section', side: 'T side', heading: 'Manual review', points: ['Garage flash then A, 37 of 40.'] }], known, esc);
  assert.deepEqual(out.refused, [{ index: 0, why: 'add_section "Manual review": 37 in "Garage flash then A, 37 of 40.", 40 in "Garage flash then A, 37 of 40." are not in the document, the review, the sheet or a query you ran this turn; copy the number from one of those, or leave it out.' }]);
  assert.equal(out.html, plain);

  // A sixpack: the new section goes after the side's table, never into a box, and a point gets the
  // rounds of the point it reads like.
  const sixKnown = outlineOfHtml(SIX);
  const [tEnd, ctStart] = [SIX.indexOf('</table>') + '</table>'.length, SIX.indexOf('<h2', SIX.indexOf('</table>'))];
  assert.equal(tEnd, ctStart);
  const atTEnd = (s) => SIX.slice(0, tEnd) + s + SIX.slice(tEnd);
  const doors = '<h3>Manual review</h3><ul><li>Doors smoke: 81% (usually 1:48), always first <a href="/demos?rounds=u1,u2,u3">3 rounds</a></li></ul>';
  for (const e of [{ side: 'HAVU: Dust2, T side' }, { side: 'T side' }, { after: 'HAVU: Dust2, T side / T Biggest tells' }, { after: 3 }, { heading: 'HAVU: Dust2, T side / Manual review' }]) {
    out = editDocument(SIX, [{ op: 'add_section', heading: 'Manual review', points: ['Doors smoke: 81% (usually 1:48), always first'], ...e }], sixKnown, esc);
    assert.deepEqual(out.refused, [], JSON.stringify(e));
    assert.equal(out.html, atTEnd(doors), `after the T table: ${JSON.stringify(e)}`);
  }
  out = editDocument(SIX, [{ op: 'add_section', side: 'CT side', heading: 'Manual review', points: ['Uli anchors B.'] }], sixKnown, esc);
  assert.equal(out.html, `${SIX}<h3>Manual review</h3><ul><li>Uli anchors B.</li></ul>`, 'the last side: at the end');
  assert.deepEqual(out.done, ['added the section "HAVU: Dust2, CT side / Manual review" with 1 point']);
}
docs.push({ id: 'six', title: 'Sixpack: HAVU on Dust2 (18 Oct)', updatedAt: NOW - 3000, html: SIX });
resetTurnFacts();
review = JSON.parse((await runTool('review_antistrat_document', { id: 'six' })).content);
assert.deepEqual(review.lines.slice(review.lines.indexOf('OUTLINE (numbered points):') + 1), [
  '## HAVU: Dust2, T side',
  '## HAVU: Dust2, T side / T Positions',
  '0. alxc = B Upper',
  '1. p3kko = T Mid',
  '## HAVU: Dust2, T side / T Default utility',
  '2. Doors smoke: 81% (usually 1:48)',
  '3. Catwalk molo: 62% (usually 1:44, ottob)',
  '## HAVU: Dust2, T side / T Biggest tells',
  '4. B flash and B Doors smoke → most likely B (14 of 17)',
  '5. Jumper smoke → most likely short pop (9 of 11)',
  '## HAVU: Dust2, T side / General notes',
  '## HAVU: Dust2, CT side',
  '## HAVU: Dust2, CT side / CT Positions',
  '6. Uli = B Anchor',
  '## HAVU: Dust2, CT side / General notes'
]);
assert.equal(review.issue_counts.empty, 2, 'both notes boxes are empty');

// Fill both notes boxes, and fix a tell with a number nobody measured: the invented number is refused
// by name, an unclear section is refused, nothing is saved, and the good edits are kept.
const n0 = saved.length;
const tNotes = ['Stack B when the Doors smoke lands early (14 of 17 go B).', 'Their B executes come through Tunnels.'];
r = await runTool('rewrite_antistrat_document', {
  id: 'six',
  edits: [
    { op: 'set_section', section: 'HAVU: Dust2, T side / General notes', points: tNotes },
    { op: 'set_section', section: '## HAVU: Dust2, CT side / General notes', points: ['Uli anchors B: hit A.'] },
    { op: 'replace_point', point: 5, text: 'Jumper smoke → most likely short pop (37 of 40)' },
    { op: 'add_points', section: 'General notes', points: ['Save the AWP for B.'] }
  ]
});
assert.match(r.content, /^Error: Not made: replace_point 5: 37 in "Jumper smoke → most likely short pop \(37 of 40\)", 40 in .* are not in the document, the review, the sheet or a query you ran this turn/);
assert.match(r.content, /add_points "General notes": "General notes" could be "HAVU: Dust2, T side \/ General notes", "HAVU: Dust2, CT side \/ General notes"; name one in full\./);
assert.match(r.content, /The other 2 edits are kept and nothing is saved yet/);
assert.equal(saved.length, n0, 'nothing is saved while an edit is refused');

// Only the fixed edit is sent again; the kept ones are saved with it, once (one sent twice is made once).
r = await runTool('rewrite_antistrat_document', {
  id: 'six',
  edits: [{ op: 'replace_point', point: 5, text: 'Jumper smoke → most likely short pop (9 of 11, thin)' }, { op: 'set_section', section: 'HAVU: Dust2, T side / General notes', points: tNotes }]
});
assert.match(
  r.content,
  /^Saved "Reviewed: Sixpack: HAVU on Dust2 \(18 Oct\)" \(id (copy\d+)\): filled "HAVU: Dust2, T side \/ General notes" with 2 points; filled "HAVU: Dust2, CT side \/ General notes" with 1 point; replaced point 5\. 10 points in all/
);
const sixCopy = /\(id (copy\d+)\)/.exec(r.content)[1];
assert.equal(saved.length, n0 + 1);
// Everything not edited is the document as it was, byte for byte: links, the sixpack table, the styles.
const filled = SIX.replace(SIX_NOTES, `<td><h3>General notes</h3><ul>${tNotes.map((t) => `<li>${t}</li>`).join('')}</ul></td>`)
  .replace(SIX_NOTES, '<td><h3>General notes</h3><ul><li>Uli anchors B: hit A.</li></ul></td>')
  .replace('(9 of 11)</li>', '(9 of 11, thin)</li>');
assert.equal(saved.at(-1).html, filled);
assert.equal(saved.at(-1).title, 'Reviewed: Sixpack: HAVU on Dust2 (18 Oct)');

// A later question edits the same copy: the earlier edits stay, numbers are still the review's,
// and a new point gets the rounds of the point it reads like.
resetTurnFacts();
r = await runTool('rewrite_antistrat_document', {
  id: 'six',
  edits: [
    { op: 'delete_point', point: 1 },
    { op: 'add_points', after: 3, points: ['Doors smoke: 81% (usually 1:48), from T spawn'] },
    { op: 'add_points', section: 'HAVU: Dust2, CT side / CT Positions', points: ['peku = A Site'] },
    { op: 'rename_section', section: 'HAVU: Dust2, CT side / General notes', heading: 'Notes and preparation (our T)' },
    { op: 'rename_section', section: 'HAVU: Dust2, T side', heading: 'HAVU T side' }
  ]
});
assert.match(
  r.content,
  /^Updated "Reviewed: Sixpack: HAVU on Dust2 \(18 Oct\)" \(id copy\d+\): deleted point 1; added 1 point after point 3; added 1 point to "HAVU: Dust2, CT side \/ CT Positions"; renamed "HAVU: Dust2, CT side \/ General notes" to "Notes and preparation \(our T\)"; renamed "HAVU: Dust2, T side" to "HAVU T side"\./
);
assert.equal(saved.at(-1).id, sixCopy, 'the same copy, not a new document');
const edited = filled
  .replace('<li>p3kko = T Mid</li>', '')
  .replace('(usually 1:44, ottob)</li>', '(usually 1:44, ottob)</li><li>Doors smoke: 81% (usually 1:48), from T spawn <a href="/demos?rounds=u1,u2,u3">3 rounds</a></li>')
  .replace('<li>Uli = B Anchor</li>', '<li>Uli = B Anchor</li><li>peku = A Site</li>')
  .replace('<h3>General notes</h3><ul><li>Uli', '<h3>Notes and preparation (our T)</h3><ul><li>Uli')
  .replace('rounds=t1,t2">HAVU: Dust2, T side</a>', 'rounds=t1,t2">HAVU T side</a>');
assert.equal(saved.at(-1).html, edited, 'a side heading that is a round link keeps the link');

// A deleted point cannot be edited again, and a section is found by its old name after a rename.
r = await runTool('rewrite_antistrat_document', { id: 'six', edits: [{ op: 'replace_point', point: 1, text: 'p3kko = Mid' }] });
assert.match(r.content, /^Error: Not made: replace_point 1: point 1 was deleted by an earlier edit\. Nothing is saved\.$/);
r = await runTool('rewrite_antistrat_document', { id: 'six', edits: [{ op: 'add_points', section: 'HAVU: Dust2, T side / General notes', points: ['Save the AWP for B.'] }] });
assert.match(r.content, /added 1 point to "HAVU T side \/ General notes"/);
assert.ok(saved.at(-1).html.includes('<li>Their B executes come through Tunnels.</li><li>Save the AWP for B.</li></ul></td>'));

// Mode replace overwrites the document itself; final false keeps edits without saving.
resetTurnFacts();
await runTool('review_antistrat_document', { id: 'old2' });
r = await runTool('rewrite_antistrat_document', { id: 'old2', final: false, edits: [{ op: 'replace_point', point: 0, text: 'Garage flash then A, 4 of 6 (thin).' }] });
assert.match(r.content, /^Kept 1 edit \(1 so far\)\. .*Nothing is saved yet\./);
const n1 = saved.length;
r = await runTool('rewrite_antistrat_document', { id: 'old2', mode: 'replace', edits: [{ op: 'rename_section', section: 'Tells', heading: 'T Tells' }] });
assert.match(r.content, /^Saved "Outline: HAVU on Nuke \(17 Oct\)" \(id old2\): replaced point 0; renamed "Nuke T side \/ Tells" to "T Tells"\./);
assert.equal(saved.length, n1 + 1);
assert.equal(saved.at(-1).id, 'old2');
assert.equal(saved.at(-1).html, '<h1>Outline</h1><h2>Nuke T side</h2><h3>T Tells</h3><ul><li>Garage flash then A, 4 of 6 (thin).</li></ul>');

// The document changed after the review: its numbers may point elsewhere now, so edits wait for a new review.
docs.find((d) => d.id === 'six').html = SIX.replace('alxc', 'Jamppi');
r = await runTool('rewrite_antistrat_document', { id: 'six', edits: [{ op: 'delete_point', point: 0 }] });
assert.match(r.content, /^Error: The document changed after the review/);
docs.find((d) => d.id === 'six').html = SIX;

// Sections after edits rebuild the same copy from what the edits made (the notes stay); edits
// after that are refused, since the review's numbers no longer fit a rebuilt copy.
r = await runTool('rewrite_antistrat_document', { id: 'six', sections: [{ side: 'HAVU T side', heading: 'T Positions', points: ['alxc = B Upper', 'Jamppi = T Mid'] }] });
assert.match(r.content, /^Updated "Reviewed: Sixpack: HAVU on Dust2 \(18 Oct\)" \(id copy\d+\): 6 sections, 13 points/);
assert.equal(saved.at(-1).id, sixCopy);
assert.ok(saved.at(-1).html.includes('<h3>T Positions</h3><ul><li>alxc = B Upper</li><li>Jamppi = T Mid</li></ul>'));
assert.ok(saved.at(-1).html.includes('<li>Stack B when the Doors smoke lands early (14 of 17 go B).</li>'), 'the filled notes are kept');
r = await runTool('rewrite_antistrat_document', { id: 'six', edits: [{ op: 'delete_point', point: 0 }] });
assert.match(r.content, /^Error: "Reviewed: Sixpack: HAVU on Dust2 \(18 Oct\)" was rebuilt from whole sections/);
r = await runTool('rewrite_antistrat_document', { id: 'six', edits: [{ op: 'delete_point', point: 0 }], sections: [{ heading: 'x', points: ['y'] }] });
assert.match(r.content, /^Error: Send edits or sections, not both/);

// The manual-review step through the tool: one add_section per side, saved as a "Reviewed:" copy with
// the original kept byte for byte around the new sections.
docs.push({ id: 'six2', title: 'Sixpack: HAVU on Dust2 (19 Oct)', updatedAt: NOW - 2000, html: SIX });
resetTurnFacts();
await runTool('review_antistrat_document', { id: 'six2' });
r = await runTool('rewrite_antistrat_document', {
  id: 'six2',
  edits: [
    { op: 'add_section', side: 'HAVU: Dust2, T side', heading: 'Manual review', points: ['Jumper smoke → most likely short pop (9 of 11).'] },
    { op: 'add_section', side: 'HAVU: Dust2, CT side', heading: 'Manual review', points: ['Uli anchors B: hit A.'] }
  ]
});
assert.match(r.content, /^Saved "Reviewed: Sixpack: HAVU on Dust2 \(19 Oct\)" \(id copy\d+\): added the section "HAVU: Dust2, T side \/ Manual review" with 1 point; added the section "HAVU: Dust2, CT side \/ Manual review" with 1 point\. 9 points in all/);
{
  const tEnd = SIX.indexOf('</table>') + '</table>'.length;
  assert.equal(saved.at(-1).html, `${SIX.slice(0, tEnd)}<h3>Manual review</h3><ul><li>Jumper smoke → most likely short pop (9 of 11).</li></ul>${SIX.slice(tEnd)}<h3>Manual review</h3><ul><li>Uli anchors B: hit A.</li></ul>`);
}

console.log('eyeDocuments.test.js ok');
