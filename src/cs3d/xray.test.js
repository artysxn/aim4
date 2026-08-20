// Run: node src/cs3d/xray.test.js
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

import assert from 'node:assert/strict';
import { EYE_DUCK, EYE_STAND } from '../../shared/sim3d/constants.js';

const { xrayFillColor, xrayHeadOffset, xrayIconList, meshBelongsTo, XRAY_FILL_T, XRAY_FILL_CT } = await import('./xray.js');

assert.equal(xrayFillColor('T'), XRAY_FILL_T);
assert.equal(xrayFillColor('CT'), XRAY_FILL_CT);
assert.equal(xrayFillColor(''), XRAY_FILL_T, 'unknown side uses T red');
assert.equal(xrayFillColor(null), XRAY_FILL_T);

assert.equal(xrayHeadOffset(0), EYE_STAND + 14);
assert.equal(xrayHeadOffset(1), EYE_DUCK + 14);

{
  const icons = xrayIconList({
    util: ['flashbang', 'hegrenade'],
    primary: 'ak47',
    items: ['ak47', 'glock', 'flashbang', 'hegrenade', 'knife'],
    active: 'ak47'
  });
  assert.deepEqual(icons, ['flashbang', 'hegrenade', 'ak47', 'glock']);
}

{
  const icons = xrayIconList({
    util: [],
    primary: 'knife',
    items: ['knife', 'glock'],
    active: 'glock'
  });
  assert.deepEqual(icons, ['glock'], 'knife is omitted from the overhead stack');
}

{
  const icons = xrayIconList({
    util: ['c4'],
    primary: 'awp',
    items: ['awp', 'deagle', 'c4'],
    active: 'awp'
  });
  assert.deepEqual(icons, ['c4', 'awp', 'deagle']);
}

{
  const root = { parent: null };
  const child = { parent: root };
  const other = { parent: null };
  assert.equal(meshBelongsTo(child, [root]), true);
  assert.equal(meshBelongsTo(root, [root]), true);
  assert.equal(meshBelongsTo(other, [root]), false);
}

console.log('xray.test.js ok');
