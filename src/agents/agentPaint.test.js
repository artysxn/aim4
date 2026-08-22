// Run: node src/agents/agentPaint.test.js
//
// How an agent is shaded in the trainer: the light and the paint.
//
// Three of these guard failures that produce something that still renders:
//
//   · **The light patch.** `onBeforeCompile` hands you a shader whose
//     `#include`s are NOT yet resolved, so searching it for a line from inside
//     `defaultnormal_vertex` finds nothing and the material compiles exactly as
//     it would have. That is not hypothetical — it is what the first version of
//     this did, and it measured identical brightness with the patch on and off.
//     So the test is that the patch actually reaches the shader source.
//   · **The bone split.** `arm_lower_L_TWIST` is an arm and `head_0_TWIST` is a
//     head. Classify on a loose match and a body comes out with its forearms
//     the colour of its skull, which reads as a texture rather than a bug.
//   · **The colour space.** A `color` attribute is linear; a hex is sRGB. Skip
//     the conversion and every flat colour comes out washed out — a plausible
//     looking wrong answer that no assertion on "is it coloured" would catch.

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const THREE = await import('three');
const {
  BODY_GROUPS,
  groupForBone,
  buildVertexGroups,
  applyGroupColors,
  flattenMaterial,
  staticLighting,
  STATIC_LIGHT_KEY
} = await import('./agentPaint.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const HEAD = BODY_GROUPS.indexOf('head');
const TORSO = BODY_GROUPS.indexOf('torso');
const ARMS = BODY_GROUPS.indexOf('arms');
const LEGS = BODY_GROUPS.indexOf('legs');

// ---- groupForBone -----------------------------------------------------------
{
  const expect = {
    head_0: HEAD,
    head_0_TWIST: HEAD,
    neck_0: HEAD,
    eyeball_l: HEAD,
    eye_target: HEAD,
    jiggle_hood: HEAD,

    pelvis: TORSO,
    spine_0: TORSO,
    spine_3: TORSO,
    root_motion: TORSO,
    jiggle_primary: TORSO,
    jiggle_radio: TORSO,
    jiggle_holster: TORSO,
    jiggle_front_pouch_01: TORSO,
    wpn: TORSO,
    wpnPivot: TORSO,
    // Shoulders are chest, matching the pack's hit table — its arm boxes start
    // at arm_upper_*.
    clavicle_L: TORSO,
    scapula_R: TORSO,
    scap_AIMUP: TORSO,
    scap_L_AIMAT: TORSO,

    arm_upper_L: ARMS,
    arm_lower_R: ARMS,
    arm_lower_L_TWIST1: ARMS,
    hand_R: ARMS,
    finger_thumb_2_L: ARMS,

    leg_upper_L: LEGS,
    leg_lower_R: LEGS,
    leg_upper_R_TWIST1: LEGS,
    ankle_L: LEGS,
    ball_R: LEGS,
    jiggle_climbinggear_02: LEGS
  };
  for (const [bone, want] of Object.entries(expect)) {
    const got = groupForBone(bone);
    assert(got === want, `${bone} → ${BODY_GROUPS[got]}, expected ${BODY_GROUPS[want]}`);
  }
  // Anything unrecognised is a body rather than a hole of undefined colour.
  assert(groupForBone('some_bone_valve_adds_in_2027') === TORSO, 'unknown bones are torso');
  assert(groupForBone('') === TORSO, 'an empty name is torso');
  assert(groupForBone(null) === TORSO, 'a missing name is torso');
}

// ---- buildVertexGroups ------------------------------------------------------
function fakeSkinned(boneNames, perVertex) {
  const geo = new THREE.BufferGeometry();
  const n = perVertex.length;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const idx = new Uint16Array(n * 4);
  const wgt = new Float32Array(n * 4);
  perVertex.forEach((influences, v) => {
    influences.forEach(([bone, w], c) => {
      idx[v * 4 + c] = bone;
      wgt[v * 4 + c] = w;
    });
  });
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
  const bones = boneNames.map((name) => Object.assign(new THREE.Bone(), { name }));
  return { geometry: geo, skeleton: { bones } };
}

{
  const bones = ['head_0', 'spine_1', 'arm_upper_L', 'leg_upper_R'];
  const mesh = fakeSkinned(bones, [
    [[0, 1]], // pure head
    [[1, 0.6], [0, 0.4]], // mostly spine → torso, not a blend of the two
    [[2, 0.51], [1, 0.49]], // the arm wins by a hair
    [[3, 0.8], [2, 0.2]], // leg
    [] // weighted to nothing
  ]);
  const g = buildVertexGroups(mesh);
  assert(g.length === 5, 'one entry per vertex');
  assert(g[0] === HEAD, 'pure head vertex');
  assert(g[1] === TORSO, 'the dominant bone wins, not the first');
  assert(g[2] === ARMS, 'a 51/49 split still resolves to one flat group');
  assert(g[3] === LEGS, 'leg vertex');
  assert(g[4] === TORSO, 'an unweighted vertex is torso, never undefined');

  // Cached on the geometry, because every body of a side shares it.
  assert(buildVertexGroups(mesh) === g, 'groups are computed once per geometry');
  assert(mesh.geometry.userData.agentGroups === g, 'and cached where the clones can find them');

  // A mesh with no skin at all does not throw.
  const rigid = { geometry: new THREE.BufferGeometry() };
  rigid.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const rg = buildVertexGroups(rigid);
  assert(rg && rg.length === 3 && rg.every((v) => v === TORSO), 'an unskinned mesh is all torso');
}

// ---- applyGroupColors -------------------------------------------------------
{
  const bones = ['head_0', 'spine_1', 'arm_upper_L', 'leg_upper_R'];
  const mesh = fakeSkinned(bones, [[[0, 1]], [[1, 1]], [[2, 1]], [[3, 1]]]);
  buildVertexGroups(mesh);
  const colors = { head: '#ff0000', torso: '#00ff00', arms: '#0000ff', legs: '#ffffff' };
  const attr = applyGroupColors(mesh.geometry, colors);
  assert(attr && attr.count === 4 && attr.itemSize === 3, 'one rgb triple per vertex');

  // Linear, not sRGB: three's own conversion of the same hex is the reference.
  const ref = new THREE.Color('#ff0000');
  close(attr.getX(0), ref.r, 1e-6, 'head r');
  close(attr.getY(0), ref.g, 1e-6, 'head g');
  close(attr.getZ(0), ref.b, 1e-6, 'head b');
  // A mid grey is the case that exposes a missing conversion — pure red and
  // white survive it unchanged.
  const grey = applyGroupColors(mesh.geometry, { head: '#808080', torso: '#808080', arms: '#808080', legs: '#808080' });
  const refGrey = new THREE.Color('#808080');
  close(grey.getX(0), refGrey.r, 1e-6, 'mid grey is converted out of sRGB');
  assert(Math.abs(refGrey.r - 0.5) > 0.02, 'and mid grey is genuinely not 0.5 linear (guards the guard)');

  close(applyGroupColors(mesh.geometry, colors).getY(1), new THREE.Color('#00ff00').g, 1e-6, 'torso green');
  close(applyGroupColors(mesh.geometry, colors).getZ(2), new THREE.Color('#0000ff').b, 1e-6, 'arms blue');

  // The attribute is reused rather than reallocated, so dragging a picker is
  // a buffer rewrite and not a new upload per frame.
  const versionBefore = attr.version;
  const again = applyGroupColors(mesh.geometry, colors);
  assert(again === attr, 'the colour attribute is written in place');
  // `needsUpdate` is a write-only setter on BufferAttribute; `version` is what
  // it bumps and the only thing readable from here.
  assert(again.version > versionBefore, 'and flagged for upload');

  // Geometry with no groups yet is left alone rather than half-painted.
  const bare = new THREE.BufferGeometry();
  assert(applyGroupColors(bare, colors) === null, 'no groups, no colours');
}

// ---- flattenMaterial --------------------------------------------------------
{
  const m = new THREE.MeshStandardMaterial();
  m.map = new THREE.Texture();
  m.normalMap = new THREE.Texture();
  m.aoMap = new THREE.Texture();
  m.roughnessMap = new THREE.Texture();
  m.metalnessMap = new THREE.Texture();
  m.metalness = 1;
  flattenMaterial(m, { vertexColors: true });
  assert(m.map === null, 'the colour map goes');
  assert(m.aoMap === null, 'so does the baked occlusion, which is also colour');
  assert(m.metalnessMap === null && m.metalness === 0, 'a flat body is not a mirror');
  assert(m.normalMap !== null, 'the normal map STAYS — it is form, not colour');
  assert(m.roughnessMap !== null, 'and so does roughness');
  assert(m.vertexColors === true, 'vertex colours on');
  assert(m.color.getHex() === 0xffffff, 'white, so the vertex colours are the colour');

  const solid = new THREE.MeshStandardMaterial();
  solid.map = new THREE.Texture();
  flattenMaterial(solid, { color: '#123456' });
  assert(solid.vertexColors === false, 'a single-colour flatten does not turn vertex colours on');
  assert(solid.color.getHex() === new THREE.Color('#123456').getHex(), 'and takes the colour given');
}

// ---- staticLighting ---------------------------------------------------------
{
  const m = new THREE.MeshStandardMaterial();
  const beforeKey = m.customProgramCacheKey();
  staticLighting(m);
  assert(m.customProgramCacheKey().includes(STATIC_LIGHT_KEY), 'the patched material gets its own program');
  assert(m.customProgramCacheKey() !== beforeKey, 'and does not share the unpatched one');

  // The patch has to reach the shader through the UNRESOLVED include, which is
  // all onBeforeCompile ever sees.
  const shader = { vertexShader: 'void main() {\n#include <defaultnormal_vertex>\n}' };
  m.onBeforeCompile(shader);
  assert(!shader.vertexShader.includes('#include <defaultnormal_vertex>'), 'the include was expanded');
  assert(
    shader.vertexShader.includes('transformedNormal = mat3( viewMatrix ) * transformedNormal;'),
    'and the model rotation was taken out of the lighting normal'
  );
  assert(
    !shader.vertexShader.includes('transformedNormal = normalMatrix * transformedNormal;'),
    'with nothing left carrying it back in'
  );

  // A shader that does not contain the include is left exactly as it was.
  const other = { vertexShader: 'void main() {}' };
  m.onBeforeCompile(other);
  assert(other.vertexShader === 'void main() {}', 'an unrelated shader is untouched');

  // The chunk this is built from must still say what we think it says; if
  // three rewrites it the patch is meant to disappear, not misfire.
  assert(
    typeof THREE.ShaderChunk.defaultnormal_vertex === 'string' &&
      THREE.ShaderChunk.defaultnormal_vertex.includes('normalMatrix * transformedNormal'),
    `three ${THREE.REVISION} still writes defaultnormal_vertex the way the patch expects`
  );
}

if (failures) {
  console.error(`agentPaint.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('agentPaint.test.js: ok');
