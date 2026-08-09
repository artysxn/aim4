// ---------------------------------------------------------------------------
// Document widgets: do they mount, and do the filters actually filter?
//
// These run against a DOM small enough to live in this file. That is enough to
// catch the failure mode that matters: a widget whose mount throws half way
// leaves its filter bar on the page and nothing else, and the catch in
// enhanceDocEmbeds means the console stays quiet about it.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';

// ---- a DOM, roughly -------------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.handlers = new Map();
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.clientWidth = 480;
  }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    this.childNodes.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  replaceChildren(...cs) {
    this.children = [];
    this.childNodes = [];
    for (const c of cs) this.appendChild(c);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  /** Fire a listener registered on this element. */
  fire(type, ev = {}) {
    for (const fn of this.handlers.get(type) || []) fn(ev);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 480, height: 480 };
  }
  getContext() {
    return {
      clearRect() {}, fillRect() {}, drawImage() {}, beginPath() {}, arc() {},
      fill() {}, stroke() {}, save() {}, restore() {}, putImageData() {},
      moveTo() {}, lineTo() {}, closePath() {}, rect() {}, clip() {},
      setTransform() {}, transform() {}, translate() {}, scale() {},
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (w, h) => ({ data: new Uint8ClampedArray(4) }),
      measureText: () => ({ width: 10 }),
      fillText() {}
    };
  }
  querySelectorAll() {
    return [];
  }
}

globalThis.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  addEventListener() {}
};
globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
globalThis.window = { getSelection: () => null, location: { origin: 'https://aim4.io' } };
globalThis.Image = class {};

const { enhanceDocEmbeds } = await import('./docEmbeds.js');

// Radar loading is a network call; the widgets all have to draw without it.
const quiet = console.warn;
let warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));

/** Mount one embed and hand back the node plus a few conveniences. */
function mount(kind, data) {
  warnings = [];
  const node = new El('div');
  node.dataset.kind = kind;
  node.dataset.embed = JSON.stringify(data);
  const surface = new El('div');
  surface.querySelectorAll = () => [node];
  enhanceDocEmbeds(surface);
  const find = (cls) => node.children.find((c) => c.className === cls) || null;
  const deep = (cls, from = node) => {
    for (const c of from.children || []) {
      if (c.className === cls) return c;
      const hit = deep(cls, c);
      if (hit) return hit;
    }
    return null;
  };
  return {
    node,
    broken: Boolean(find('doc-embed-stale')),
    why: warnings.join(' | '),
    count: () => find('doc-embed-count')?.textContent || '',
    canvas: () => find('doc-embed-canvas'),
    sliders: () => deep('doc-embed-sliders')?.children || [],
    selects: () => (deep('doc-embed-filters')?.children || []).filter((c) => c.tagName === 'SELECT')
  };
}

const UTIL = {
  map: 'ANU',
  side: 'T',
  live: {
    names: ['blue', 'palace'],
    kinds: ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'],
    rounds: [
      { f: 'r1', own: 4, opp: 4, w: 1, k: ['anu-b-exec'] },
      { f: 'r2', own: 1, opp: 3, w: 0, k: [] }
    ],
    // [nameIdx, kindIdx, x, y, t, roundIdx]
    throws: [0, 0, 100, 200, 20, 0, 1, 1, 300, 400, 90, 1],
    types: { 'anu-b-exec': 'B Exec' }
  }
};

const HEAT = {
  map: 'ANU',
  title: 'lyoli, T',
  // [x, y, t, buys] — buys is own * 8 + opp.
  points: [100, 200, 10, 4 * 8 + 4, 150, 250, 60, 4 * 8 + 4, 10, 10, 100, 1 * 8 + 4]
};

const SPREAD = {
  step: 8,
  marks: [0, 8, 16],
  rounds: [
    { own: 4, opp: 4, w: 1, c: [3, 2, 5, 2, 3, 5, -1, -1, -1] },
    { own: 1, opp: 4, w: 0, c: [4, 1, 5, 4, 1, 5, 3, 1, 4] }
  ]
};

// ---------------------------------------------------------------------------
// Every widget mounts all the way through
// ---------------------------------------------------------------------------

{
  for (const [kind, data] of [
    ['util-map', UTIL],
    ['heat', HEAT],
    ['ct-spread', SPREAD]
  ]) {
    const w = mount(kind, data);
    assert.equal(w.broken, false, `${kind} mounts`);
    assert.equal(warnings.length, 0, `${kind} mounts without complaint`);
    // The filter bar is appended first, so a half-mounted widget still shows
    // one. Anything after it is the proof the mount ran to the end.
    assert.ok(w.count(), `${kind} got as far as its own readout`);
  }

  assert.ok(mount('util-map', { map: 'ANU', side: 'T' }).broken, 'a pre-live report says so');
  assert.ok(mount('heat', { map: 'ANU', points: [] }).count().startsWith('0 of 0'), 'and so does an empty one');
}

// ---------------------------------------------------------------------------
// The two sliders bracket the data
// ---------------------------------------------------------------------------

{
  const w = mount('heat', HEAT);
  assert.equal(w.count(), '3 of 3 samples', 'wide open is the whole round');

  const [from, to] = w.sliders();
  // The first handle drops everything before it.
  from.value = '50';
  from.fire('input');
  assert.equal(w.count(), '2 of 3 samples', 'the sample at 10s is gone');

  // The second drops everything after it, leaving only the middle.
  to.value = '70';
  to.fire('input');
  assert.equal(w.count(), '1 of 3 samples', 'a window cut out of the middle of the round');

  // They cannot cross: dragging the low handle past the high one pins it.
  from.value = '110';
  from.fire('input');
  assert.equal(from.value, '70', 'the low handle stops at the high one');
  to.value = '0';
  to.fire('input');
  assert.equal(to.value, '70', 'and the high handle stops at the low one');
}

// ---------------------------------------------------------------------------
// Buy pickers
// ---------------------------------------------------------------------------

{
  const w = mount('heat', HEAT);
  const [own] = w.selects();
  own.value = '4';
  own.fire('change');
  assert.equal(w.count(), '2 of 3 samples', 'only the full-buy samples survive');
  own.value = '';
  own.fire('change');
  assert.equal(w.count(), '3 of 3 samples', 'and clearing it puts them back');
}

{
  const w = mount('util-map', UTIL);
  assert.equal(w.count(), '2 pieces over 2 rounds');
  const [own] = w.selects();
  own.value = '4';
  own.fire('change');
  assert.equal(w.count(), '1 pieces over 1 rounds', 'the eco round drops out with its grenade');

  // The utility map recomputes rather than hiding: a piece thrown late is not
  // in an early window at all.
  const w2 = mount('util-map', UTIL);
  const [, hi] = w2.sliders();
  hi.value = '30';
  hi.fire('input');
  assert.equal(w2.count(), '1 pieces over 1 rounds', 'the 1:25 throw is outside a 0-30s window');
}

{
  const w = mount('ct-spread', SPREAD);
  assert.equal(w.count(), '2 CT rounds');
  assert.equal(w.sliders().length, 0, 'the spread table IS the round over time, so no sliders');
  const [own] = w.selects();
  own.value = '4';
  own.fire('change');
  assert.equal(w.count(), '1 CT rounds', 'buys filter the table too');
}

// ---------------------------------------------------------------------------
// Grenade throw lines
// ---------------------------------------------------------------------------

{
  const w = mount('nade-paths', {
    map: 'ANU',
    title: 'lyoli, T, grenades',
    kinds: ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'],
    // [kind, fromX, fromY, toX, toY, t, buys]
    paths: [0, 10, 20, 300, 400, 25, 36, 1, 50, 60, 200, 100, 70, 1 * 8 + 4]
  });
  assert.equal(w.broken, false, `the throw lines mount: ${w.why}`);
  assert.equal(w.count(), '2 of 2 grenades');

  const [, to] = w.sliders();
  to.value = '40';
  to.fire('input');
  assert.equal(w.count(), '1 of 2 grenades', 'the late throw is outside an early window');

  const w2 = mount('nade-paths', {
    map: 'ANU',
    kinds: ['smokegrenade', 'molotov', 'flashbang', 'hegrenade'],
    paths: [0, 10, 20, 300, 400, 25, 36, 1, 50, 60, 200, 100, 70, 1 * 8 + 4]
  });
  const [own] = w2.selects();
  own.value = '1';
  own.fire('change');
  assert.equal(w2.count(), '1 of 2 grenades', 'and buys filter them the same way');
}

// ---------------------------------------------------------------------------
// The afterplant maps run on the bomb, not the round clock
// ---------------------------------------------------------------------------

{
  const span = { from: -5, to: 40 };
  const w = mount('heat', {
    map: 'ANU',
    title: 'A afterplants',
    span,
    // Five seconds before the plant, at it, and half a minute after.
    points: [10, 10, -5, 36, 20, 20, 0, 36, 30, 30, 30, 36]
  });
  assert.equal(w.count(), '3 of 3 samples', 'the whole afterplant to start');

  const [from, to] = w.sliders();
  assert.equal(from.min, '-5', 'the window opens before the plant');
  assert.equal(to.max, '40', 'and closes when the bomb does');

  from.value = '0';
  from.fire('input');
  assert.equal(w.count(), '2 of 3 samples', 'dropping the pre-plant sample');
  to.value = '10';
  to.fire('input');
  assert.equal(w.count(), '1 of 3 samples', 'and everything past ten seconds after it');
}

// ---------------------------------------------------------------------------
// Zoom and pan
// ---------------------------------------------------------------------------

{
  const w = mount('heat', HEAT);
  const c = w.canvas();
  assert.ok(c.attributes.title.includes('Scroll to zoom'), 'the map says how to drive it');

  // A wheel up over the middle zooms in; the canvas only offers a grab cursor
  // once there is somewhere to drag to.
  assert.equal(c.style.cursor || '', '', 'no grab handle at rest');
  let prevented = false;
  c.fire('wheel', {
    deltaY: -1,
    clientX: 240,
    clientY: 240,
    preventDefault: () => (prevented = true)
  });
  assert.ok(prevented, 'the page does not scroll out from under a zoom');
  assert.equal(c.style.cursor, 'grab', 'and now it can be dragged');

  // Panning is a drag, and a drag must not also count as a click: the utility
  // map pins whatever is under the cursor otherwise.
  c.fire('pointerdown', { pointerId: 1, clientX: 240, clientY: 240 });
  assert.equal(c.style.cursor, 'grabbing');
  c.fire('pointermove', { pointerId: 1, clientX: 300, clientY: 260 });
  c.fire('pointerup', { pointerId: 1 });
  assert.equal(c.style.cursor, 'grab', 'the handle comes back after the drag');

  // Double-click puts it back where it started.
  c.fire('dblclick', { preventDefault() {} });
  assert.equal(c.style.cursor || '', '', 'reset means no more panning');
}

{
  // Zooming all the way out never leaves the map off-centre, and the widget
  // keeps drawing the same data throughout: the viewport is a view, not a
  // filter.
  const w = mount('util-map', UTIL);
  const c = w.canvas();
  const before = w.count();
  for (let i = 0; i < 40; i++) {
    c.fire('wheel', { deltaY: -1, clientX: 10, clientY: 10, preventDefault() {} });
  }
  c.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  c.fire('pointermove', { pointerId: 1, clientX: 9999, clientY: 9999 });
  c.fire('pointerup', { pointerId: 1 });
  assert.equal(w.count(), before, 'zoom and pan change nothing about what is shown');
  for (let i = 0; i < 60; i++) {
    c.fire('wheel', { deltaY: 1, clientX: 10, clientY: 10, preventDefault() {} });
  }
  assert.equal(c.style.cursor || '', '', 'and it settles back to no zoom');
}

// ---------------------------------------------------------------------------
// A widget's controls stay inside the widget
// ---------------------------------------------------------------------------

{
  // The host page reads `data-kind` off its own selects. A widget mounts a div
  // carrying the same attribute, so its events must not reach the page.
  const w = mount('heat', HEAT);
  assert.ok(
    (w.node.handlers.get('change') || []).length,
    'the embed root swallows change events'
  );
  assert.ok((w.node.handlers.get('input') || []).length, 'and input events');
  let stopped = false;
  w.node.fire('change', { stopPropagation: () => (stopped = true) });
  assert.ok(stopped, 'which it does by stopping them');
}

console.warn = quiet;
console.log('docEmbeds.test.js ok');
