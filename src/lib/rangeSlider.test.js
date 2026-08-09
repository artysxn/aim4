// ---------------------------------------------------------------------------
// The two-handle range slider, used by the document widgets and the analyzer's
// grenade timeline. One track, two grips, the selection lit between them.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.classes = new Set();
    this.handlers = new Map();
    this.value = '';
    this.className = '';
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c))
    };
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) this.appendChild(c);
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.handlers.get(type) || []) fn(ev);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 18 };
  }
}

globalThis.document = { createElement: (tag) => new El(tag) };

const { createRangeSlider } = await import('./rangeSlider.js');

/** The two inputs and the lit segment of a freshly built slider. */
function build(opts) {
  const seen = [];
  const rs = createRangeSlider({ ...opts, onChange: (a, b) => seen.push([a, b]) });
  const [lo, hi] = rs.el.children.filter((c) => c.tagName === 'INPUT');
  const fill = rs.el.children[0].children[0];
  return { rs, lo, hi, fill, seen };
}

// ---------------------------------------------------------------------------
// It starts wide open, and the fill spans the selection
// ---------------------------------------------------------------------------

{
  const { rs, lo, hi, fill } = build({ min: 0, max: 100 });
  assert.deepEqual(rs.get(), { from: 0, to: 100 }, 'both ends by default');
  assert.equal(fill.style.left, '0%');
  assert.equal(fill.style.width, '100%', 'the whole track is lit');
  assert.equal(lo.value, '0');
  assert.equal(hi.value, '100');
  assert.equal(lo.attributes['aria-label'], 'Range, start');
  assert.equal(hi.attributes['aria-label'], 'Range, end');
}

// ---------------------------------------------------------------------------
// Each handle moves its own end, and reports
// ---------------------------------------------------------------------------

{
  const { rs, lo, hi, fill, seen } = build({ min: 0, max: 100 });

  lo.value = '25';
  lo.fire('input');
  assert.deepEqual(rs.get(), { from: 25, to: 100 });
  assert.equal(fill.style.left, '25%', 'the lit segment starts at the low handle');
  assert.equal(fill.style.width, '75%');

  hi.value = '75';
  hi.fire('input');
  assert.deepEqual(rs.get(), { from: 25, to: 75 });
  assert.equal(fill.style.width, '50%', 'and ends at the high one');
  assert.deepEqual(seen, [[25, 100], [25, 75]], 'each move is reported once');
}

// ---------------------------------------------------------------------------
// The handles cannot cross
// ---------------------------------------------------------------------------

{
  const { rs, lo, hi } = build({ min: 0, max: 100, from: 40, to: 60 });

  lo.value = '90';
  lo.fire('input');
  assert.deepEqual(rs.get(), { from: 60, to: 60 }, 'the low handle stops at the high one');
  assert.equal(lo.value, '60', 'and the input is pulled back to match');

  hi.value = '10';
  hi.fire('input');
  assert.deepEqual(rs.get(), { from: 60, to: 60 }, 'and the same the other way');
  assert.equal(hi.value, '60');
}

// ---------------------------------------------------------------------------
// Whichever handle is nearer comes to the front
// ---------------------------------------------------------------------------

{
  // Two handles sitting on top of each other are useless if the same one
  // always wins the pointer: the pair can never be pulled apart again.
  const { rs, lo, hi } = build({ min: 0, max: 100, from: 50, to: 50 });

  rs.el.fire('pointermove', { clientX: 10 });
  assert.ok(lo.classes.has('is-front'), 'a grab to the left takes the low handle');
  assert.equal(hi.classes.has('is-front'), false);

  rs.el.fire('pointermove', { clientX: 90 });
  assert.ok(hi.classes.has('is-front'), 'and to the right, the high one');
  assert.equal(lo.classes.has('is-front'), false);
}

// ---------------------------------------------------------------------------
// Ranges that do not start at zero
// ---------------------------------------------------------------------------

{
  // The afterplant window runs from five seconds before the plant to forty
  // after, so the track has to place a negative low end correctly.
  const { rs, lo, hi, fill } = build({ min: -5, max: 40 });
  assert.deepEqual(rs.get(), { from: -5, to: 40 });
  assert.equal(lo.min, '-5', 'the rail spans the negative end');
  assert.equal(hi.max, '40');

  lo.value = '0';
  lo.fire('input');
  assert.equal(fill.style.left, `${(5 / 45) * 100}%`, 'the plant sits where it should on the track');

  rs.set(-5, 40);
  assert.deepEqual(rs.get(), { from: -5, to: 40 }, 'and it can be put back programmatically');
  rs.set(100, 200);
  assert.deepEqual(rs.get(), { from: 40, to: 40 }, 'out of range clamps rather than throwing');
}

console.log('rangeSlider.test.js ok');
