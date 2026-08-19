// ---------------------------------------------------------------------------
// scripts/cs3d-split-interactives.mjs
// Cut the doors, vents and glass out of the packed world geometry so they can
// move and disappear.
//
//   node scripts/cs3d-split-interactives.mjs [--map nuke] [--dry] [--restore]
//
// The problem this solves: the packer bakes entity geometry into the world
// groups, so nothing at runtime can hide one window or swing one door. What it
// CAN do is post-process the already packed files — no VRF re-extraction, no
// 17 GB intermediate, no re-pack. Only the touched .glb files change.
//
// Two rules decide which triangles belong to an interactive. Both were measured
// on Nuke first, and the ORDER between them is load-bearing:
//
//   BY MODEL NODE (first, and on Nuke it is enough for all 21). A prop the map
//   places as an entity keeps a node named after its model —
//   `metal_door_001_br.metal_door_001_br_bg_body_lod0` holds 2288 triangles,
//   which is the four Nuke doors at 572 each and nothing else. The name match
//   is a prefix of THAT node (`model.` / `model_`), not a substring of a world
//   `agg_merge_*` tile that merely shares a texture. Matching those tiles on
//   Mirage pulled palace walls and apartment interiors out with a shutter.
//   Each triangle still goes to the NEAREST interactive rather than to the
//   model that named the node: `nuke_window_93x76.unnamed_1` holds 48
//   triangles, and they are two 93x76 windows AND two 63x76 ones.
//
//   BY COLLISION HULL (fallback only). phys.glb carries one node per entity,
//   tagged `kind: entity` with the classname and surface — 17 of them on Nuke,
//   one for every breakable, with an exact world bounding box. A triangle is
//   in only when ALL THREE vertices sit in that box. Centroid-in-box with a
//   6u slack was enough, on Mirage, to swallow the wall a sheet-metal cover
//   sits in (878 triangles for a 108-triangle prop) and leave a hole through
//   the building. The hull still cannot be the primary rule: a window's hull
//   is a box around the PANE, and the FRAME is separate static geometry in
//   the same box. So it only runs for an interactive the model-node rule
//   failed to find.
//
// The hull is read either way, because it is also where the runtime's collision
// box and surface type come from.
//
// Doors have no `kind: entity` hull (a `prop_door_rotating` is spawned by the
// game, so VRF bakes its leaf into `physics_group_metal` with the wall around
// it), so a door is found by the first rule and its collision box is derived
// from the render geometry the first rule claims. See src/cs3d/interactives.js
// for what the runtime then does with it.
//
// Removing triangles from a world group is safe against the manifest: the
// renderer sizes each BatchedMesh from the manifest's per-material totals and
// only throws when the data EXCEEDS them. Vertices are left in place and only
// the index shrinks, so those totals still hold. interactives.glb is drawn as
// plain meshes outside the batches, so it needs no headroom at all.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { pathToFileURL } from 'node:url';
import { ROOT, fail } from './lib/vrf.mjs';

const TAG = 'cs3d-split-interactives';

const args = process.argv.slice(2);
let slug = 'nuke';
let dry = false;
let restore = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--map') slug = args[++i];
  else if (args[i] === '--dry') dry = true;
  else if (args[i] === '--restore') restore = true;
}

const PACK = path.join(ROOT, 'server', 'data', 'cs3d', 'pack', slug);
const GEO = path.join(PACK, 'geo');
const BACKUP = path.join(PACK, 'geo.orig');

/**
 * Outer bound on how far from its origin a triangle may sit and still belong to
 * an interactive found by the model-node rule.
 *
 * Nearest-wins does the real work — two windows in one wall cannot both take a
 * pane — so this only has to be loose enough for the largest interactive and
 * tight enough to notice when a model node also holds a distant static copy. A
 * Nuke door leaf reaches 107 units from its hinge, which is what killed the 110
 * this started at: it cut the top corners off every door.
 */
const CLAIM_RADIUS = 256;

/**
 * How far outside its collision hull an entity's render geometry may sit.
 * A pane of glass is modelled a shade proud of the brush that stops bullets.
 * Capped per-hull so a 3u-thick sheet-metal cover cannot grow into the wall.
 */
const PHYS_SLACK = 6;

/** Source frame from the pack's scene frame. */
const toSource = (x, y, z) => [x, -z, y];

/**
 * True when this packed node is the prop's own mesh, not a world material tile
 * that happens to mention the same model in an `agg_merge_*` name.
 */
export function nodeMatchesModel(nm, model) {
  if (!nm || !model) return false;
  if (nm.includes('agg_merge')) return false;
  if (nm === model || nm.startsWith(`${model}.`) || nm.startsWith(`${model}_`)) return true;
  if (nm.includes(`.${model}.`) || nm.includes(`.${model}_`)) return true;
  return false;
}

function hullSlack(box) {
  const thick = Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  if (!(thick > 0)) return 1;
  return Math.min(PHYS_SLACK, Math.max(1, thick * 0.25));
}

/** Hull fallback must not carve a world tile that merely overlaps the box. */
function primFitsHull(primBox, hull) {
  const dim = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const p = dim(primBox);
  const h = dim(hull);
  for (let i = 0; i < 3; i++) if (p[i] > h[i] * 1.5 + 24) return false;
  return true;
}

/**
 * A name-match claim that dwarfs its collision hull is a world tile named
 * after the prop, not the prop. Anubis `anubis_window_38x26` sat on a node
 * whose bounds were 52x38x125 — a wall, not a pane.
 */
export function claimFitsHull(claimed, hull) {
  if (!hull || !boxValid(claimed)) return true;
  return primFitsHull(claimed, hull);
}

/** Every attribute the packer puts on a world tile. */
const SEMANTICS = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', '_AMB', '_SUN'];
/** Which of those are directions rather than points (rotate, do not translate). */
const DIRECTIONAL = new Set(['NORMAL']);

function newIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

const emptyBox = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const boxValid = (b) => b.min[0] <= b.max[0];

function grow(box, p) {
  for (let k = 0; k < 3; k++) {
    if (p[k] < box.min[k]) box.min[k] = p[k];
    if (p[k] > box.max[k]) box.max[k] = p[k];
  }
}
const inBox = (b, p, slack) =>
  p[0] >= b.min[0] - slack &&
  p[0] <= b.max[0] + slack &&
  p[1] >= b.min[1] - slack &&
  p[1] <= b.max[1] + slack &&
  p[2] >= b.min[2] - slack &&
  p[2] <= b.max[2] + slack;

const centre = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The `kind: entity` nodes out of phys.glb: one per breakable entity, with the
 * classname and surface the packer read off the map, in the Source frame.
 */
async function readPhysEntities(io) {
  const file = path.join(PACK, 'phys.glb');
  if (!fs.existsSync(file)) return [];
  const doc = await io.read(file);
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const extras = node.getExtras() || {};
    if (extras.kind !== 'entity') continue;
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const box = emptyBox();
    let tris = 0;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) continue;
      tris += (idx?.getCount() || pos.getCount()) / 3;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        grow(
          box,
          toSource(
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
          )
        );
      }
    }
    out.push({ classname: extras.classname || '', surface: extras.surface || 'default', box, tris, taken: null });
  }
  return out;
}

/**
 * Give every collision hull to the interactive it belongs to.
 *
 * Matched on classname first and distance second, one-to-one, closest pair
 * first — so twelve identical panes of glass on one wall each end up with their
 * own hull instead of all pointing at whichever was tested first.
 */
function matchPhys(targets, physEnts) {
  const pairs = [];
  for (const t of targets) {
    for (const p of physEnts) {
      if (p.classname && t.row.class && p.classname !== t.row.class) continue;
      const d = dist3(centre(p.box), t.origin);
      // The origin of a prop is inside or beside its own hull; anything further
      // away than that is a different entity of the same class.
      if (d > 128) continue;
      pairs.push({ t, p, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const { t, p } of pairs) {
    if (t.phys || p.taken) continue;
    t.phys = p;
    p.taken = t;
  }
}

/** World-space bounds of one primitive, Source frame. */
function primBox(prim, m) {
  const pos = prim.getAttribute('POSITION');
  const box = emptyBox();
  if (!pos) return box;
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    grow(
      box,
      toSource(
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
      )
    );
  }
  return box;
}

async function main() {
  if (!fs.existsSync(PACK)) fail(TAG, `no packed map at ${PACK}`);

  // --restore puts the untouched geometry back, so a bad split is one command
  // away from undone even without git.
  if (restore) {
    if (!fs.existsSync(BACKUP)) fail(TAG, 'no geo.orig backup to restore from');
    await fsp.rm(GEO, { recursive: true, force: true });
    await fsp.cp(BACKUP, GEO, { recursive: true });
    console.log(`${TAG}: restored ${slug}/geo from geo.orig`);
    return;
  }

  const interFile = path.join(PACK, 'interactives.json');
  if (!fs.existsSync(interFile)) fail(TAG, 'run scripts/cs3d-interactives.mjs first');
  const doc = JSON.parse(await fsp.readFile(interFile, 'utf8'));

  // Work from the pristine copy every run, so re-running is idempotent rather
  // than cutting a second time out of already-cut geometry.
  if (!fs.existsSync(BACKUP)) {
    await fsp.cp(GEO, BACKUP, { recursive: true });
    console.log(`  kept a pristine copy at ${path.relative(ROOT, BACKUP)}`);
  }

  const io = newIO();

  const targets = doc.interactives
    .filter((i) => i.role === 'door' || i.role === 'breakable')
    .map((i) => ({
      row: i,
      model: (i.model || '').split('/').pop().replace(/\.vmdl$/, '').toLowerCase(),
      origin: i.origin,
      parts: [],
      phys: null,
      /** World bounds of the claimed render geometry, Source frame. */
      bounds: emptyBox()
    }));

  const physEnts = await readPhysEntities(io);
  matchPhys(targets, physEnts);

  const files = (await fsp.readdir(BACKUP)).filter((f) => f.endsWith('.glb'));
  let filesChanged = 0;
  let strays = 0;

  /**
   * One read of every world group, claiming triangles for the interactives.
   *
   * @param {Set<object>} physFor  targets allowed to claim by collision hull —
   *   only the ones the model-node rule could not find (see the header).
   * @param {boolean} write        rewrite the groups, or just work out who gets what
   */
  async function sweep(physFor, write) {
    filesChanged = 0;
    strays = 0;
    for (const t of targets) {
      t.parts = [];
      t.bounds = emptyBox();
    }

  for (const file of files) {
    const gltf = await io.read(path.join(BACKUP, file));
    let touched = false;

    for (const node of gltf.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const nm = (node.getName() || '').toLowerCase();
      const namedFor = new Set(targets.filter((t) => !t.skipName && nodeMatchesModel(nm, t.model)));
      const m = node.getWorldMatrix();

      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        if (!pos || !idx) continue;

        // Which interactives could possibly want anything in this primitive.
        const box = primBox(prim, m);
        const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
        const huge = span > CLAIM_RADIUS * 2;
        const reach = CLAIM_RADIUS + span;
        const mine = targets.filter((t) => {
          const near = dist3(t.origin, centre(box)) < reach;
          if (namedFor.has(t) && near) return true;
          if (!huge && namedFor.size && inBox(box, t.origin, 48)) return true;
          if (!physFor.has(t) || !t.phys) return false;
          const slack = hullSlack(t.phys.box) + 64;
          return inBox(box, centre(t.phys.box), slack) && primFitsHull(box, t.phys.box);
        });
        if (!mine.length) continue;

        const count = idx.getCount();
        const keep = [];
        const claimed = new Map();
        const v = [0, 0, 0];
        const c = [0, 0, 0];
        const corners = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0]
        ];

        for (let i = 0; i < count; i += 3) {
          c[0] = c[1] = c[2] = 0;
          for (let k = 0; k < 3; k++) {
            pos.getElement(idx.getScalar(i + k), v);
            const wx = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
            const wy = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
            const wz = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
            const s = toSource(wx, wy, wz);
            corners[k][0] = s[0];
            corners[k][1] = s[1];
            corners[k][2] = s[2];
            c[0] += s[0];
            c[1] += s[1];
            c[2] += s[2];
          }
          const s = [c[0] / 3, c[1] / 3, c[2] / 3];
          // Nearest wins among everything that will have it, so two windows in
          // one wall cannot both take a pane.
          let best = null;
          let bestD = Infinity;
          for (const t of mine) {
            const d = dist3(s, t.origin);
            const inHull =
              t.phys && corners.every((p) => inBox(t.phys.box, p, hullSlack(t.phys.box)));
            // A named node can still hold the wall around a pane (Anubis
            // windows). If the entity has a collision hull, only triangles
            // inside that hull belong to it.
            const wanted = namedFor.has(t)
              ? d < CLAIM_RADIUS && (!t.phys || inHull)
              : (!huge && namedFor.size > 0 && inBox(box, t.origin, 48) && d < CLAIM_RADIUS && (!t.phys || inHull)) ||
                (physFor.has(t) && inHull);
            if (wanted && d < bestD) {
              bestD = d;
              best = t;
            }
          }
          if (!best) {
            if (namedFor.size) strays++;
            keep.push(idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2));
          } else {
            let list = claimed.get(best);
            if (!list) claimed.set(best, (list = []));
            list.push(idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2));
          }
        }
        if (!claimed.size) continue;
        touched = true;

        // The claimed triangles become one part per interactive, in WORLD space
        // minus the entity origin, so the runtime can put the node at the origin
        // and rotate a door about its own hinge.
        const mat = prim.getMaterial();
        for (const [t, tri] of claimed) {
          const remap = new Map();
          const attrs = {};
          for (const sem of SEMANTICS) {
            const a = prim.getAttribute(sem);
            if (a) attrs[sem] = { src: a, out: [], size: a.getElementSize(), type: a.getType() };
          }
          const out = [];
          for (const vi of tri) {
            let mapped = remap.get(vi);
            if (mapped === undefined) {
              mapped = remap.size;
              remap.set(vi, mapped);
              for (const [sem, a] of Object.entries(attrs)) {
                const e = new Array(a.size).fill(0);
                a.src.getElement(vi, e);
                if (sem === 'POSITION') {
                  const w = [
                    m[0] * e[0] + m[4] * e[1] + m[8] * e[2] + m[12],
                    m[1] * e[0] + m[5] * e[1] + m[9] * e[2] + m[13],
                    m[2] * e[0] + m[6] * e[1] + m[10] * e[2] + m[14]
                  ];
                  grow(t.bounds, toSource(w[0], w[1], w[2]));
                  a.out.push(w[0], w[1], w[2]);
                } else if (DIRECTIONAL.has(sem)) {
                  a.out.push(
                    m[0] * e[0] + m[4] * e[1] + m[8] * e[2],
                    m[1] * e[0] + m[5] * e[1] + m[9] * e[2],
                    m[2] * e[0] + m[6] * e[1] + m[10] * e[2]
                  );
                } else {
                  for (let k = 0; k < a.size; k++) a.out.push(e[k]);
                }
              }
            }
            out.push(mapped);
          }
          t.parts.push({
            attrs: Object.fromEntries(Object.entries(attrs).map(([s, a]) => [s, { data: a.out, type: a.type }])),
            index: out,
            material: mat?.getName() || '',
            tint: mat?.getBaseColorFactor?.() || [1, 1, 1, 1]
          });
        }

        // ...and the world group keeps everything else. Only the index shrinks:
        // the vertices stay, which is what keeps the manifest's totals honest.
        idx.setArray(new Uint32Array(keep));
      }
    }

    if (touched) {
      filesChanged++;
      if (write) {
        gltf
          .createExtension(EXTMeshoptCompression)
          .setRequired(true)
          .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
        gltf.createExtension(KHRMeshQuantization).setRequired(true);
        await io.write(path.join(GEO, file), gltf);
      }
    }
  }
  }

  // The model-node rule first. Only what it misses falls through to the hull.
  const none = new Set();
  await sweep(none, false);
  for (const t of targets) {
    if (!t.parts.length || !t.phys || claimFitsHull(t.bounds, t.phys.box)) continue;
    const span = (b) => b.max.map((v, k) => (v - b.min[k]).toFixed(0)).join('x');
    console.log(`  skip ${t.row.id}: name claim ${span(t.bounds)} vs hull ${span(t.phys.box)}`);
    t.parts = [];
    t.bounds = emptyBox();
    t.skipName = true;
  }
  const needPhys = new Set(targets.filter((t) => !t.parts.length && t.phys));
  if (needPhys.size) {
    console.log(`  ${needPhys.size} interactive(s) not found by model name; trying the collision hull`);
    await sweep(needPhys, false);
    for (const t of [...needPhys]) {
      const n = t.parts.reduce((a, p) => a + p.index.length / 3, 0);
      const cap = (t.phys.tris || 0) * 4 + 16;
      if (n > cap) {
        console.log(`  skip ${t.row.id}: hull claimed ${n} tris, collision is ${t.phys.tris}`);
        t.parts = [];
        t.bounds = emptyBox();
        needPhys.delete(t);
      } else if (n && !claimFitsHull(t.bounds, t.phys.box)) {
        const span = (b) => b.max.map((v, k) => (v - b.min[k]).toFixed(0)).join('x');
        console.log(`  skip ${t.row.id}: hull claim ${span(t.bounds)} vs hull ${span(t.phys.box)}`);
        t.parts = [];
        t.bounds = emptyBox();
        needPhys.delete(t);
      }
    }
  }
  await sweep(needPhys, !dry);

  // ---- interactives.glb: one node per interactive, at its entity origin -----
  const outDoc = new Document();
  outDoc.createBuffer();
  const outScene = outDoc.createScene('interactives');
  const outMat = new Map();
  let built = 0;
  for (const t of targets) {
    const [ox, oy, oz] = t.origin;
    // Source origin → scene, the offset every vertex is expressed relative to.
    const off = [ox, oz, -oy];
    if (t.parts.length) {
      built++;
      const mesh = outDoc.createMesh(t.row.id);
      for (const part of t.parts) {
        const prim = outDoc.createPrimitive();
        for (const [sem, a] of Object.entries(part.attrs)) {
          const arr = new Float32Array(a.data);
          if (sem === 'POSITION') for (let i = 0; i < arr.length; i++) arr[i] -= off[i % 3];
          prim.setAttribute(sem, outDoc.createAccessor().setType(a.type).setArray(arr));
        }
        prim.setIndices(outDoc.createAccessor().setType('SCALAR').setArray(new Uint32Array(part.index)));
        // Keep the material NAME: the renderer resolves a manifest material id
        // straight off it (MaterialLibrary.idOf). The tint rides with it, since
        // the packer put each prop instance's rendercolor on baseColorFactor and
        // the loader reads it from there for every other tile in the map.
        const key = `${part.material}|${part.tint.join(',')}`;
        let mat = outMat.get(key);
        if (!mat) {
          mat = outDoc.createMaterial(part.material).setBaseColorFactor(part.tint);
          outMat.set(key, mat);
        }
        prim.setMaterial(mat);
        mesh.addPrimitive(prim);
      }
      const node = outDoc.createNode(t.row.id).setMesh(mesh).setTranslation(off);
      node.setExtras({ interactive: t.row.id, role: t.row.role });
      outScene.addChild(node);
    }

    // Record what the runtime needs: local render bounds (which is where a
    // door's swinging collision box comes from) and the collision hull the map
    // already had, if any.
    const b = t.bounds;
    if (boxValid(b)) {
      t.row.bounds = {
        min: [b.min[0] - ox, b.min[1] - oy, b.min[2] - oz].map((n) => +n.toFixed(3)),
        max: [b.max[0] - ox, b.max[1] - oy, b.max[2] - oz].map((n) => +n.toFixed(3))
      };
    }
    if (t.phys) {
      t.row.phys = {
        min: t.phys.box.min.map((n) => +n.toFixed(3)),
        max: t.phys.box.max.map((n) => +n.toFixed(3)),
        surface: t.phys.surface,
        triangles: t.phys.tris
      };
    }
    t.row.triangles = t.parts.reduce((a, p) => a + p.index.length / 3, 0);
  }

  const total = targets.reduce((a, t) => a + t.row.triangles, 0);
  console.log(`\n${TAG}: ${slug}`);
  console.log(`  ${physEnts.length} collision hull(s) in phys.glb, ${physEnts.filter((p) => p.taken).length} matched`);
  console.log(`  ${built} of ${targets.length} interactives found geometry (${total} triangles)`);
  console.log(`  ${filesChanged} world group file(s) ${dry ? 'would change' : 'rewritten'}`);
  if (strays) console.log(`  ${strays} triangle(s) in a model node claimed by nobody (left in the world)`);
  for (const t of targets) {
    const n = t.row.triangles;
    const size = boxValid(t.bounds) ? t.bounds.max.map((v, k) => (v - t.bounds.min[k]).toFixed(0)).join('x') : '-';
    console.log(
      `    ${n ? String(n).padStart(5) : '    -'}  ${t.row.role.padEnd(9)} ${t.row.id.padEnd(20)} ` +
        `${(t.phys ? t.phys.surface : 'no hull').padEnd(16)} ${size.padEnd(14)} ${t.model}`
    );
  }

  if (dry) {
    console.log('\n  --dry: nothing written');
    return;
  }
  outDoc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(path.join(PACK, 'interactives.glb'), outDoc);
  const bytes = fs.statSync(path.join(PACK, 'interactives.glb')).size;
  doc.geometry = { file: 'interactives.glb', bytes, triangles: total };
  await fsp.writeFile(path.join(PACK, 'interactives.json'), JSON.stringify(doc, null, 1));
  console.log(`\n  interactives.glb: ${(bytes / 1024).toFixed(0)} kB`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main();
