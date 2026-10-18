// Run: node src/replays\eye\eyeDocuments.test.js
//
// The document tools against a fake team API: documents that share a title,
// reading them by id, the date on a title, a rewrite sent in parts, and the
// numbers a rewrite may quote.

import assert from 'node:assert/strict';
import { resetTurnFacts, runTool, shortDate } from './eyeTools.js';

// There is no DOM in node: a parser for the flat documents below (h1/h2/h3 and ul > li).
const node = (tagName, textContent, children = []) => ({
  tagName,
  textContent,
  children,
  cloneNode: () => node(tagName, textContent, children),
  querySelectorAll: () => [],
  getAttribute: () => null
});
globalThis.DOMParser = class {
  parseFromString(src) {
    const children = [...src.matchAll(/<(h[1-6]|ul)>(.*?)<\/\1>/g)].map(([, tag, inner]) =>
      tag === 'ul' ? node('UL', '', [...inner.matchAll(/<li>(.*?)<\/li>/g)].map((m) => node('LI', m[1]))) : node(tag.toUpperCase(), inner)
    );
    return { getElementById: () => ({ children }) };
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

console.log('eyeDocuments.test.js ok');
