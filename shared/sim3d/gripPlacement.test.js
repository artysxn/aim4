// Run: node shared/sim3d/gripPlacement.test.js
//
// The viewmodel grip fallback (shared/sim3d/gripPlacement.js), and — where the
// pack is on disk — the claim it rests on: that a weapon's grip marker lands
// in the same place for every weapon of a class the packer DID solve, tightly
// enough that a class-wide target places the ones it missed.
//
// The pack read below is server/data/cs3d/pack/weapons, the same files the
// runtime fetches. It is skipped when that directory is absent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gripFallbackOffset, GRIP_BONE, GRIP_TARGET } from './gripPlacement.js';

let failures = 0;
function assert(ok, msg) {
  if (ok) return;
  failures++;
  console.error('  FAIL:', msg);
}
function close(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg} (${a} vs ${b}, tolerance ${eps})`);
}

// ---- a stand-in for the Object3D the runtime hands in ----------------------
// The module deliberately imports no `three` (the two viewmodels are built
// against different entry points), so a fake with the two methods it calls is
// a fair test of the real path rather than a mock of it.
function fakeModel(gripAt) {
  const grip = gripAt && {
    name: GRIP_BONE,
    matrixWorld: {
      elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, gripAt[0], gripAt[1], gripAt[2], 1]
    }
  };
  return {
    updated: 0,
    updateMatrixWorld() {
      this.updated++;
    },
    getObjectByName(n) {
      return grip && n === grip.name ? grip : null;
    }
  };
}

const PISTOL = { class: 'pistol', muzzle: [22.8, -2.8, -2.2], vmOffset: [0, 0, 0] };

// ---- the rule fires only where it should -----------------------------------
{
  const at = [3.271, 1.033, 0];
  const solved = gripFallbackOffset(fakeModel(at), PISTOL);
  assert(Array.isArray(solved), 'an unplaced gun with a grip marker gets an offset');
  // grip + offset must land exactly on the class target — that IS the rule.
  for (let i = 0; i < 3; i++) {
    close(at[i] + solved[i], GRIP_TARGET.pistol[i], 1e-9, `axis ${i} lands on the target`);
  }

  assert(
    gripFallbackOffset(fakeModel([1, 2, 3]), { ...PISTOL, vmOffset: [-1.9, -1.9, 0] }) === null,
    'a weapon the pack placed is left alone'
  );
  assert(
    gripFallbackOffset(fakeModel([1, 2, 3]), { ...PISTOL, vmOffset: null }) !== null,
    'a missing vmOffset counts as unplaced, not as a reason to bail'
  );
  // The C4 and the healthshot are filed under `rifle` and have no barrel; the
  // packer zeroes them for that honest reason and this must not move them.
  assert(
    gripFallbackOffset(fakeModel([1, 2, 3]), { class: 'rifle', vmOffset: [0, 0, 0] }) === null,
    'a weapon with no muzzle is not a gun and is left alone'
  );
  assert(
    gripFallbackOffset(fakeModel([1, 2, 3]), { ...PISTOL, class: 'knife' }) === null,
    'a class with no target is left alone'
  );
  assert(gripFallbackOffset(fakeModel(null), PISTOL) === null, 'no grip bone, no guess');
  assert(gripFallbackOffset(null, PISTOL) === null, 'no model, no guess');
  assert(gripFallbackOffset(fakeModel([1, 2, 3]), null) === null, 'no weapon row, no guess');

  const m = fakeModel([1, 2, 3]);
  gripFallbackOffset(m, PISTOL);
  assert(m.updated === 1, 'the world matrix is brought up to date before it is read');
}

// ---- and against the real pack ---------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(here, '..', '..', 'server', 'data', 'cs3d', 'pack', 'weapons');

/** The glTF JSON chunk out of a .glb. */
function readGlb(file) {
  const d = fs.readFileSync(file);
  let off = 12;
  while (off < d.length) {
    const len = d.readUInt32LE(off);
    const type = d.readUInt32LE(off + 4);
    off += 8;
    if (type === 0x4e4f534a) return JSON.parse(d.subarray(off, off + len).toString('utf8'));
    off += len;
  }
  return null;
}

/** Column-major 4x4 product, three's own convention. */
function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  }
  return r;
}

function localMatrix(n) {
  if (n.matrix) return [...n.matrix];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1
  ];
}

/** Where a named node sits in the file's own space. */
function worldOf(gltf, name) {
  const nodes = gltf.nodes || [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const idx = nodes.findIndex((n) => n.name === name);
  if (idx < 0) return null;
  const chain = [];
  for (let j = idx; j !== undefined; j = parent.get(j)) chain.push(j);
  let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const j of chain.reverse()) m = mul(m, localMatrix(nodes[j]));
  return [m[12], m[13], m[14]];
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/**
 * Interquartile range, not max minus min.
 *
 * The rifle class holds 25 weapons and a couple of genuine oddities — the MP7
 * grips 1.7 units short of the rest, the sawed-off 1.4 high — so the full range
 * says 3.1 while the middle half of the class agrees to within 0.5. The middle
 * half is the thing the claim is about.
 */
function iqr(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return median(s.slice((n + 1) >> 1)) - median(s.slice(0, n >> 1));
}

const manifestFile = path.join(PACK, 'manifest.json');
if (!fs.existsSync(manifestFile)) {
  console.log('  (no weapons pack on disk — the pack checks are skipped)');
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const rows = Object.entries(manifest.weapons || {});
  assert(rows.length > 0, 'the manifest lists weapons');

  /** class → the grip points of the weapons the packer solved. */
  const placedByClass = new Map();
  /** the guns it did not. */
  const unplaced = [];

  for (const [name, w] of rows) {
    const file = path.join(PACK, w.file || '');
    if (!w.file || !fs.existsSync(file)) continue;
    const grip = worldOf(readGlb(file), GRIP_BONE);
    if (!grip) continue;
    const vm = w.vmOffset || [0, 0, 0];
    if (vm[0] || vm[1] || vm[2]) {
      if (!placedByClass.has(w.class)) placedByClass.set(w.class, []);
      placedByClass.get(w.class).push({ name, at: grip.map((v, i) => v + vm[i]) });
    } else if (Array.isArray(w.muzzle) && GRIP_TARGET[w.class]) {
      unplaced.push({ name, w, grip });
    }
  }

  // The premise: within a class, every solved weapon's grip lands in the same
  // small box. If this ever stops being true the class target is meaningless
  // and the fallback should go, not be re-tuned.
  for (const [cls, items] of placedByClass) {
    const target = GRIP_TARGET[cls];
    if (!target || items.length < 3) continue;
    for (let axis = 0; axis < 3; axis++) {
      const vals = items.map((it) => it.at[axis]);
      const spread = iqr(vals);
      assert(
        spread <= 1,
        `${cls} grips agree on axis ${axis} across ${items.length} weapons (iqr ${spread.toFixed(2)})`
      );
      // ...and the constant sits inside that agreement rather than off to one
      // side of it, which is the whole licence for applying it to a weapon
      // whose own placement was never solved.
      close(target[axis], median(vals), 0.4, `GRIP_TARGET.${cls}[${axis}] sits at the class median`);
    }
  }

  // The three guns this exists for. Named, because a re-pack that solves them
  // should retire the fallback rather than leave a rule firing on nothing.
  const names = unplaced.map((u) => u.name).sort();
  assert(
    names.join(',') === 'elite,revolver,usp_silencer',
    `the packer misses exactly the three known guns, found: ${names.join(',') || '(none)'}`
  );

  for (const { name, w, grip } of unplaced) {
    const solved = gripFallbackOffset(fakeModel(grip), w);
    assert(Array.isArray(solved), `${name} is placed by the fallback`);
    if (!solved) continue;
    const target = GRIP_TARGET[w.class];
    for (let axis = 0; axis < 3; axis++) {
      close(
        grip[axis] + solved[axis],
        target[axis],
        1e-9,
        `${name} lands on the ${w.class} grip point, axis ${axis}`
      );
    }
    // The correction is the size of a hand, not of a room: a solve that came
    // out at 20 units would mean the grip marker is not what we think it is.
    const size = Math.hypot(...solved);
    assert(size < 12, `${name}'s correction is a plausible size (${size.toFixed(2)} units)`);
  }

  // And nothing the packer placed is touched.
  for (const [, items] of placedByClass) {
    for (const { name } of items) {
      assert(
        gripFallbackOffset(fakeModel([0, 0, 0]), manifest.weapons[name]) === null,
        `${name} keeps the pack's own placement`
      );
    }
  }
  const summary = [...placedByClass].map(([c, i]) => `${i.length} ${c}`).join(', ');
  console.log(`  (pack: ${summary} solved, ${unplaced.length} placed by grip)`);
}

if (failures) {
  console.error(`gripPlacement.test: ${failures} failure(s)`);
  process.exit(1);
}
console.log('gripPlacement.test: ok');
