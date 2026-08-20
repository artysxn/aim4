// Run: node src/site/docOutline.test.js

import assert from 'node:assert/strict';
import { collectOutline, outlineLevel, readFontSize, TITLE_PX, HEADING_PX } from './docOutline.js';

assert.equal(outlineLevel({ tag: 'H1' }), 1);
assert.equal(outlineLevel({ tag: 'H2' }), 2);
assert.equal(outlineLevel({ tag: 'H3' }), 3);
assert.equal(outlineLevel({ tag: 'P', fontSize: TITLE_PX }), 1);
assert.equal(outlineLevel({ tag: 'P', fontSize: HEADING_PX }), 2);
assert.equal(outlineLevel({ tag: 'P', fontSize: 15 }), 0);
assert.equal(outlineLevel({ tag: 'H3', fontSize: HEADING_PX }), 3, 'tag beats size');

assert.equal(readFontSize({ nodeType: 1, style: { fontSize: '25px' }, children: [] }), 25);
assert.equal(
  readFontSize({
    nodeType: 1,
    style: { fontSize: '' },
    children: [{ style: { fontSize: '19px' } }]
  }),
  19
);

const kids = [];
const h1 = { nodeType: 1, tagName: 'H1', textContent: 'Antistrat: X on Cache', style: { fontSize: '25px' }, children: [], hasAttribute: () => false };
const h2 = { nodeType: 1, tagName: 'H2', textContent: 'Pistol rounds', style: { fontSize: '19px' }, children: [], hasAttribute: () => false };
const h3 = { nodeType: 1, tagName: 'H3', textContent: 'T pistols', style: {}, children: [], hasAttribute: () => false };
const p = { nodeType: 1, tagName: 'P', textContent: 'body', style: {}, children: [], hasAttribute: () => false };
const root = {
  children: [h1, h2, h3, p]
};
for (const el of root.children) el.children = el.children || [];
const items = collectOutline(root);
assert.deepEqual(
  items.map((x) => [x.level, x.text]),
  [
    [1, 'Antistrat: X on Cache'],
    [2, 'Pistol rounds'],
    [3, 'T pistols']
  ]
);

console.log('docOutline.test.js ok');
