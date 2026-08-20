// ---------------------------------------------------------------------------
// src/cs3d/shooting.test.js
// Wallbang traces used to allocate a Line + LineBasicMaterial per segment.
// WebGPU compiled each one on the shot, which froze a spray. The path is one
// LineSegments pair, capped, and off unless traces are on.
//
// Run: node src/cs3d/shooting.test.js
// ---------------------------------------------------------------------------

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const assert = (await import('node:assert/strict')).default;
const { Shooting, TRACE_MAX } = await import('./shooting.js');

const eye = { x: 0, y: 0, z: 0 };
const dir = { x: 1, y: 0, z: 0 };
const out = {
  impacts: [{ point: { x: 100, y: 0, z: 0 }, penetrated: false }],
  end: { x: 100, y: 0, z: 0 }
};

{
  const s = new Shooting({
    traces: false,
    getWeapon: () => ({ name: 'ak47', damage: 36, penetration: 0, range: 8192, rangeModifier: 0.98 })
  });
  s.world = {
    trace: () => ({
      point: { x: 80, y: 0, z: 0 },
      normal: { x: -1, y: 0, z: 0 },
      distance: 80,
      triangle: 0,
      surface: 'concrete'
    })
  };
  s.fire(eye, dir);
  assert.equal(s.lines.length, 0, 'traces off must not record segments');
  assert.equal(s.root.children.length, 0, 'traces off must not create GPU lines');
  const shot = s.fire(eye, dir);
  assert.equal(shot.dir, dir, 'the shot carries the bullet direction');
  s.dispose();
}

{
  const s = new Shooting({ traces: true });
  for (let i = 0; i < 80; i++) s._draw(eye, dir, out);
  assert.ok(s.lines.length <= TRACE_MAX, `cap ${s.lines.length} > ${TRACE_MAX}`);
  assert.equal(s.root.children.length, 2, 'air + through LineSegments only');
  const mats = new Set(s.root.children.map((c) => c.material));
  assert.equal(mats.size, 2, 'two shared materials, not one per shot');
  s.update(5);
  assert.equal(s.lines.length, 0, 'aged past TRACE_SECONDS');
  s.dispose();
  assert.equal(s.root.parent, null);
}

console.log('shooting: ok');
