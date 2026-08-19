// ---------------------------------------------------------------------------
// src/cs3d/threePatches.test.js
// The node-material lookup repair, which only matters in a build nobody runs
// tests against — so this reproduces that build's shape by hand.
//
// three registers `MeshStandardNodeMaterial` under `MeshStandardMaterial.name`
// and looks it up by `material.type`. In dev those are the same string. In a
// minified bundle the class binding is renamed (`uy`, `ul`, `ly`…) and the
// `type` string is not, so every lookup misses and every plain material draws
// as an empty NodeMaterial. That is the black boxes on the deployed maps.
//
// Run: node src/cs3d/threePatches.test.js
// ---------------------------------------------------------------------------

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const assert = (await import('node:assert/strict')).default;
const THREE = await import('three/webgpu');
const { patchNodeMaterialTypeLookup } = await import('./threePatches.js');

/** three's own lookup, so the test asserts on the code path the renderer takes. */
const lookup = (renderer, material) => renderer.nodes.library.getMaterialNodeClass(material.type) || null;

const fakeRenderer = (entries) => ({
  nodes: { library: { materialNodes: new Map(entries), getMaterialNodeClass(t) { return this.materialNodes.get(t) || null; } } }
});

// ---- a minified build: every lookup misses, then none do -------------------
{
  // What `addMaterial(MeshStandardNodeMaterial, MeshStandardMaterial)` writes
  // once esbuild has renamed the material classes.
  const renderer = fakeRenderer([
    ['uy', THREE.MeshStandardNodeMaterial],
    ['pr', THREE.MeshBasicNodeMaterial],
    ['hl', THREE.MeshLambertNodeMaterial],
    ['cy', THREE.LineBasicNodeMaterial]
  ]);

  const basic = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  assert.equal(lookup(renderer, basic), null, 'sanity: the minified table cannot be hit by type');

  const fixed = patchNodeMaterialTypeLookup(renderer, THREE);
  assert.ok(fixed >= 4, `expected the table to be repaired, got ${fixed}`);

  assert.equal(lookup(renderer, basic), THREE.MeshBasicNodeMaterial);
  assert.equal(lookup(renderer, new THREE.MeshStandardMaterial()), THREE.MeshStandardNodeMaterial);
  assert.equal(lookup(renderer, new THREE.MeshLambertMaterial()), THREE.MeshLambertNodeMaterial);
  assert.equal(lookup(renderer, new THREE.LineBasicMaterial()), THREE.LineBasicNodeMaterial);
  assert.equal(lookup(renderer, new THREE.SpriteMaterial()), THREE.SpriteNodeMaterial);

  // The mangled keys are left where they were: this adds, it does not rewrite.
  assert.equal(renderer.nodes.library.materialNodes.get('uy'), THREE.MeshStandardNodeMaterial);
}

// ---- an unminified build is left completely alone --------------------------
// The patch must become a no-op the day three keys the table by `type`, or the
// day a build stops renaming classes. Nothing is overwritten either way.
{
  const marker = class NotOurs {};
  const renderer = fakeRenderer([
    ['MeshStandardMaterial', marker],
    ['MeshBasicMaterial', marker],
    ['MeshLambertMaterial', marker],
    ['MeshPhongMaterial', marker],
    ['MeshPhysicalMaterial', marker],
    ['MeshToonMaterial', marker],
    ['MeshNormalMaterial', marker],
    ['MeshMatcapMaterial', marker],
    ['LineBasicMaterial', marker],
    ['LineDashedMaterial', marker],
    ['PointsMaterial', marker],
    ['SpriteMaterial', marker],
    ['ShadowMaterial', marker]
  ]);
  assert.equal(patchNodeMaterialTypeLookup(renderer, THREE), 0, 'a healthy table must be left alone');
  assert.equal(lookup(renderer, new THREE.MeshStandardMaterial()), marker, 'the existing entry must survive');
}

// ---- it must never throw on a renderer it does not recognise ---------------
// It runs on the boot path, before anything is on screen.
assert.equal(patchNodeMaterialTypeLookup(null, THREE), 0);
assert.equal(patchNodeMaterialTypeLookup({}, THREE), 0);
assert.equal(patchNodeMaterialTypeLookup({ nodes: {} }, THREE), 0);
assert.equal(patchNodeMaterialTypeLookup(fakeRenderer([]), null), 0);

console.log('threePatches.test.js OK');
