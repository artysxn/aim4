// Run: node src/cs3d/pauseMenu.test.js

import { PAUSE_MENUS_HREF, resolutionSelectHtml } from './pauseMenu.js';
import { readFileSync } from 'node:fs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(PAUSE_MENUS_HREF === '/map-practice', 'leave goes to map practice');

const html = resolutionSelectHtml();
assert(html.includes('value="native"'), 'native option');
assert(html.includes('value="1280x960"'), '4:3 option');
assert(html.includes('value="custom"'), 'custom option');
assert(!html.includes('—'), 'no em dash in labels');

const src = readFileSync(new URL('./pauseMenu.js', import.meta.url), 'utf8');
const root = src.slice(src.indexOf('data-view="root"'), src.indexOf('data-view="import"'));
assert(root.includes('data-act="import"'), 'Import round is a root action');
assert(!root.includes('data-import'), 'picker is not on the root panel');
assert(src.includes('data-view="import"'), 'Import round is its own window');
assert(src.includes('data-embed="1"'), 'pause host embeds the picker');

console.log('pauseMenu.test.js ok');
