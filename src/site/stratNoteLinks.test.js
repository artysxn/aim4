import assert from 'node:assert/strict';
import {
  classifyTag,
  renderStratNoteLinks,
  safeHref,
  stratNoteToDocHtml,
  takeLinkCluster,
  utilArchiveHref
} from './stratNoteLinks.js';

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const html = (raw) => renderStratNoteLinks(raw, { escapeHtml });

assert.equal(classifyTag('!x9fS').kind, 'util');
assert.equal(classifyTag('!x9fS').value, 'x9fS');
assert.equal(classifyTag('URL=https://aim4.io').kind, 'url');
assert.equal(classifyTag('smoke').kind, 'label');

assert.equal(safeHref('javascript:alert(1)'), '');
assert.equal(safeHref('https://aim4.io/x'), 'https://aim4.io/x');
assert.ok(safeHref('/team/utility-archive?u=x9fS').startsWith('/team/'));

assert.equal(utilArchiveHref('x9fS', 'INF'), '/team/utility-archive?map=INF&u=x9fS');

const smoke = html('<smoke><!x9fS>');
assert.match(smoke, />smoke<\/button>/);
assert.match(smoke, /data-ua-copy="x9fS"/);
assert.equal(smoke.includes('target="_blank"'), false);

const reverse = html('<!x9fS><smoke>');
assert.match(reverse, />smoke<\/button>/);
assert.match(reverse, /data-ua-copy="x9fS"/);

const urlPair = html('<demo><URL=https://aim4.io/x>');
assert.match(urlPair, />demo<\/a>/);
assert.match(urlPair, /href="https:\/\/aim4.io\/x"/);

const urlFirst = html('<URL=https://aim4.io/x><demo>');
assert.match(urlFirst, />demo<\/a>/);

const both = html('<Smoke top car><!iDiD><URL=https://aim4.io/round>');
assert.match(both, />Smoke top car<\/a>/);
assert.match(both, /data-ua-copy="iDiD"/);
assert.match(both, /href="https:\/\/aim4.io\/round"/);
assert.match(both, /target="_blank"/);

const bothOrder = html('<URL=https://aim4.io/r><Smoke><!abcd>');
assert.match(bothOrder, />Smoke<\/a>/);
assert.match(bothOrder, /data-ua-copy="abcd"/);

const leftover = html('go <smoke><!x9fS> now');
assert.match(leftover, /^go /);
assert.match(leftover, / now$/);

const spaced = html('<Smoke top car> <!iDiD> <URL=https://aim4.io/r>');
assert.match(spaced, />Smoke top car<\/a>/);
assert.match(spaced, /data-ua-copy="iDiD"/);

assert.equal(html('<smoke>').includes('ua-link'), false);

const badUrl = html('<Smoke><!abcd><URL=javascript:alert(1)>');
assert.match(badUrl, /data-ua-copy="abcd"/);
assert.equal(badUrl.includes('javascript:'), false);
assert.equal(badUrl.includes('<a '), false);

const standalone = html('see <!abcd>');
assert.match(standalone, />abcd<\/button>/);
assert.match(standalone, /data-ua-copy="abcd"/);

const escaped = html('<b>plain');
assert.equal(escaped.includes('<b>'), false);
assert.ok(escaped.includes('&lt;b&gt;'));

// ---- the same note inside a team document ----------------------------------
// No buttons and no data attributes: a document has no stratbook around it to
// copy a setpos, so a throw id becomes a link into the archive entry instead.
const doc = (raw) => stratNoteToDocHtml(raw, { escapeHtml, mapCode: 'MIR' });

const docSmoke = doc('Smoke <Smoke top car><!iDiD> at 1:47');
assert.match(docSmoke, /<a href="\/team\/utility-archive\?map=MIR&amp;u=iDiD">Smoke top car<\/a>/);
assert.match(docSmoke, /^Smoke /);
assert.match(docSmoke, / at 1:47$/);
assert.equal(docSmoke.includes('data-ua-copy'), false);
assert.equal(docSmoke.includes('<button'), false);

// A label with nothing to link is left as the text it was written as, the same
// as the stratbook leaves it. An unsafe URL loses the link and keeps the label.
assert.equal(doc('<smoke>'), '&lt;smoke&gt;');
const docBad = doc('<Smoke><URL=javascript:alert(1)>');
assert.equal(docBad, 'Smoke');
assert.equal(docBad.includes('javascript:'), false);
assert.equal(docBad.includes('<a '), false);
assert.equal(doc('<b>plain').includes('<b>'), false);

const tags = [
  { start: 0, end: 16, ...classifyTag('Smoke top car') },
  { start: 16, end: 23, ...classifyTag('!iDiD') },
  { start: 23, end: 50, ...classifyTag('URL=https://aim4.io/r') }
];
const cluster = takeLinkCluster(tags, 0, '<Smoke top car><!iDiD><URL=https://aim4.io/r>');
assert.equal(cluster.linked, true);
assert.equal(cluster.parts.label, 'Smoke top car');
assert.equal(cluster.parts.util, 'iDiD');
assert.equal(cluster.parts.url, 'https://aim4.io/r');
assert.equal(cluster.consumed, 3);

console.log('stratNoteLinks.test.js: ok');
