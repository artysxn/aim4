// Run: node shared/sim3d/interactives.test.js
//
// The door and breakable state machines against the data the maps actually
// carry. Where a number is asserted it is the one extracted from the game, so
// editing a constant by hand should fail this file rather than silently
// redefine what CS2 does.
//
// The rows below are copied from the real
// server/data/cs3d/pack/nuke/interactives.json, and the last test reads that
// file directly so a re-extraction that changes shape is caught here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInteractive,
  linkDoors,
  stepInteractive,
  applyDamage,
  applyBlast,
  applyFire,
  openDoor,
  closeDoor,
  toggleDoor,
  doorAngle,
  poseAngle,
  carveDoor,
  holeRadius,
  holeStage,
  inHole,
  DOOR_HOLE_MAX,
  DOOR_HOLE_STAGES,
  grenadeThrough,
  breakKeep,
  GRENADE_BREAK_KEEP,
  doorSwingSeconds,
  DOOR,
  DAMAGE_TYPES,
  boxCorners,
  boxTriangles,
  boxBounds
} from './interactives.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const DOOR_ROW = {
  id: 'nuke:door:2',
  class: 'prop_door_rotating',
  role: 'door',
  origin: [1047, -920, -768],
  angles: [0, 180, 0],
  name: 'door_02',
  door: { distance: 89, speed: 200, openDir: 0, forceClosed: false, slave: 'door_01' },
  // The Nuke door's own model: base "Door.Standard", and the 100 hit points its
  // break piece is worth.
  break: { health: 100, mult: { bullets: 1, club: 1.25, explosive: 1.5 }, base: 'Door.Standard', pieces: [] }
};
const DOOR_MASTER = { ...DOOR_ROW, id: 'nuke:door:1', name: 'door_01', door: { ...DOOR_ROW.door, slave: '' } };
const VENT_ROW = {
  id: 'nuke:breakable:8',
  class: 'prop_dynamic',
  role: 'breakable',
  origin: [448, -1403, -416],
  name: 'nuke_vent',
  break: { health: 1, mult: { bullets: 1, club: 1, explosive: 1 }, base: 'Metal.Medium', pieces: [{ model: 'x' }] }
};
const GLASS_ROW = {
  id: 'nuke:breakable:9',
  class: 'prop_dynamic',
  role: 'breakable',
  origin: [0, 0, 0],
  break: { health: 1, mult: { bullets: 0.5, club: 1, explosive: 1 }, base: 'Glass.Window', pieces: [] }
};

// ---- the door swings at the speed the lump says ---------------------------
{
  const d = createInteractive(DOOR_ROW);
  close(doorSwingSeconds(d), 89 / 200, 1e-9, 'a Nuke door swings in 0.445 s');
  assert(d.state === DOOR.CLOSED, 'starts closed');
  close(doorAngle(d), 0, 1e-9, 'and at zero degrees');

  assert(openDoor(d), 'opening a closed door does something');
  assert(!openDoor(d), 'opening it again does not');
  // Half the swing time gets it half open.
  stepInteractive(d, 0.445 / 2);
  close(d.frac, 0.5, 1e-6, 'half way after half the swing');
  close(doorAngle(d), 44.5, 1e-4, 'which is 44.5 degrees');
  stepInteractive(d, 0.445 / 2);
  assert(d.state === DOOR.OPEN, 'fully open after the full swing');
  close(doorAngle(d), 89, 1e-6, 'at 89 degrees');
  // ...and it stays there, because this door is not forceclosed.
  stepInteractive(d, 60);
  assert(d.state === DOOR.OPEN, 'a door that is not forceclosed stays open');

  assert(closeDoor(d), 'and can be closed again');
  stepInteractive(d, 1);
  assert(d.state === DOOR.CLOSED && d.frac === 0, 'back to closed');
  assert(toggleDoor(d) && d.state === DOOR.OPENING, 'toggle opens a closed door');
}

// ---- forceclosed does NOT shut itself -------------------------------------
// `forceclosed` on a prop_door_rotating means "shut even if something is in the
// way", not "shut yourself after a while". Reading it as a timer made Nuke's
// two forceclosed doors reverse themselves a second or two after every use.
{
  const d = createInteractive({ ...DOOR_ROW, door: { ...DOOR_ROW.door, forceClosed: true, slave: '' } });
  openDoor(d);
  stepInteractive(d, 1);
  assert(d.state === DOOR.OPEN, 'reached open');
  stepInteractive(d, 60);
  assert(d.state === DOOR.OPEN, 'and stays open, forceclosed or not');
  closeDoor(d);
  stepInteractive(d, 1);
  assert(d.state === DOOR.CLOSED, 'shuts when asked');
  stepInteractive(d, 60);
  assert(d.state === DOOR.CLOSED, '...and stays shut too');
}

// ---- the geometry is baked OPEN, so the pose is offset --------------------
// The split measured each leaf where the map has it standing, which for a
// Source door is fully open. Drawing by doorAngle therefore leaves a shut door
// standing open, which is exactly what a freshly loaded Nuke looked like.
{
  const d = createInteractive({ ...DOOR_ROW, door: { ...DOOR_ROW.door, slave: '' } });
  close(doorAngle(d), 0, 1e-9, 'shut is zero swing');
  close(poseAngle(d), 89, 1e-9, '...but the geometry turns the full swing INTO the doorway');
  openDoor(d);
  stepInteractive(d, 1);
  close(doorAngle(d), 89, 1e-9, 'open is the full swing');
  close(poseAngle(d), 0, 1e-9, '...and the geometry sits exactly as baked');
  // The sign matters, not just the magnitude: shut has to be on the far side
  // of the baked pose from open, or the leaf ends up swung out flat against
  // the wall, which is neither state and 178 degrees from the right one.
  const half = createInteractive({ ...DOOR_ROW, door: { ...DOOR_ROW.door, slave: '' } });
  openDoor(half);
  stepInteractive(half, 0.445 / 2);
  close(poseAngle(half), 44.5, 1e-4, 'half open is half way back to the baked pose');
  assert(poseAngle(half) > 0 && poseAngle(half) < 89, 'and never overshoots it');

  // A pack whose geometry really was measured shut needs no offset.
  const plain = createInteractive({ ...DOOR_ROW, bakedOpen: false, door: { ...DOOR_ROW.door, slave: '' } });
  close(poseAngle(plain), doorAngle(plain), 1e-9, 'bakedOpen false means pose is swing');
}

// ---- shooting a door carves a hole in it ----------------------------------
// Rounds do not swing a door and do not delete it. They open a hole where they
// land, and it grows with the damage put through it — but never to the edges,
// so the leaf is always a frame and never an empty doorway.
{
  const row = { ...DOOR_ROW, door: { ...DOOR_ROW.door, slave: '' } };
  // A 60 x 11 x 110 leaf, hinged at the origin: the Nuke door.
  row.bounds = { min: [0, -5.5, 0], max: [60, 5.5, 110] };
  const d = createInteractive(row);
  assert(d.health === 100, 'a door has the 100 hit points its break piece is worth');
  close(holeRadius(d), 0, 1e-9, 'an untouched door has no hole');
  assert(!inHole(d, 30, 55), 'and nothing is inside it');

  // It never swings and it never dies from gunfire.
  const frac = d.frac;
  carveDoor(d, 36, 30, 55);
  close(d.frac, frac, 1e-9, 'the leaf does not move when shot');
  assert(d.health === 100, 'and loses no health');
  assert(!applyDamage(d, 1000, 'bullets'), 'bullets cannot damage a door at all');
  assert(!d.broken, 'however many of them');

  // ...and one round is not yet a hole: the first stage is 420 damage in.
  close(holeRadius(d), 0, 1e-9, 'one AK round leaves the leaf intact');
  assert(holeStage(d) === 0, 'stage 0');

  // Every stage, and it stops short of the edges. Half the leaf's narrow side
  // is 30, so the biggest hole is 30 x DOOR_HOLE_MAX.
  for (let i = 0; i < 60; i++) carveDoor(d, 36, 30, 55);
  assert(holeStage(d) === 3, 'a magazine and a half takes it all the way');
  const full = holeRadius(d);
  close(full, 30 * DOOR_HOLE_MAX, 1e-9, 'the last stage is the full hole');
  assert(full < 30, 'which is short of the edge, so a border always survives');
  assert(!carveDoor(d, 36, 30, 55), 'and further rounds change nothing');
  assert(!d.broken, 'a door can never be shot away entirely');

  // What is inside the hole is through it; what is outside is still door.
  assert(inHole(d, 30, 55), 'the middle is gone');
  assert(inHole(d, 30 + full * 0.9, 55), '...and so is most of the way out');
  assert(!inHole(d, 2, 55), 'but the edge of the leaf is not');
  assert(!inHole(d, 30, 108), '...nor the top');

  // The hole opens where the rounds land, not in the middle by default.
  const low = createInteractive({ ...row, id: 'test:low' });
  carveDoor(low, 50, 12, 20);
  close(low.hole.u, 12, 1e-9, 'the hole centres on the shots');
  close(low.hole.v, 20, 1e-9, 'both ways');
  // ...and walking the spray drags it, weighted by damage.
  carveDoor(low, 50, 48, 20);
  close(low.hole.u, 30, 1e-9, 'two equal bursts either side centre it between them');

  // ---- the counts, weapon by weapon -------------------------------------
  // Six weapons measured in game. Every threshold below is one of those counts,
  // so moving DOOR_HOLE_STAGES fails this block rather than drifting quietly.
  const shotsTo = (perShot, stage) => {
    const o = createInteractive({ ...row, id: `t:${perShot}:${stage}` });
    let n = 0;
    while (holeStage(o) < stage && n < 500) {
      carveDoor(o, perShot, 30, 55);
      n++;
    }
    return n;
  };
  // damage x pellets, straight out of the weapons pack.
  for (const [name, perShot, counts] of [
    ['p2000', 35 * 1, [12, 18, 24]],
    ['ak47', 36 * 1, [12, 18, 24]],
    ['m4a1', 33 * 1, [13, 20, 26]],
    ['deagle', 53 * 1, [8, 12, 16]],
    ['awp', 115 * 1, [4, 6, 8]],
    ['nova', 26 * 9, [2, 3, 4]]
  ]) {
    for (let stage = 1; stage <= 3; stage++) {
      const got = shotsTo(perShot, stage);
      assert(got === counts[stage - 1], `${name}: ${counts[stage - 1]} shots to stage ${stage}, got ${got}`);
    }
  }
  // The counted stage-to-stage deltas: 12 then 6 then 6 on a p2000 and an AK,
  // and the Deagle's 8 then half of that.
  close(DOOR_HOLE_STAGES[1] - DOOR_HOLE_STAGES[0], 210, 1e-9, 'stage 2 costs half of stage 1');
  close(DOOR_HOLE_STAGES[2] - DOOR_HOLE_STAGES[1], 210, 1e-9, '...and stage 3 the same again');

  // Penetration power explains none of it: the AWP is 2.5 and the p2000 is 1,
  // and both counts fall out of damage alone.
  close(115 * 4, 460, 1e-9, 'the AWP clears 420 in four');
  close(35 * 12, 420, 1e-9, 'and the p2000 in exactly twelve');

  // An HE still destroys the door outright; that is the other damage type.
  const wrecked = createInteractive(row);
  assert(applyDamage(wrecked, 99 * 1.5, 'explosive'), 'an HE destroys it');
  assert(!carveDoor(wrecked, 36, 30, 55), 'and there is nothing left to shoot');
}

// ---- master and slave move together ---------------------------------------
{
  const pair = linkDoors([createInteractive(DOOR_MASTER), createInteractive(DOOR_ROW)]);
  const [master, slave] = pair;
  assert(master.linked === slave && slave.linked === master, 'the link resolves both ways');
  openDoor(slave);
  assert(master.state === DOOR.OPENING, 'opening one leaf opens the other');
  stepInteractive(master, 1);
  stepInteractive(slave, 1);
  assert(master.state === DOOR.OPEN && slave.state === DOOR.OPEN, 'both end open');
}

// ---- breaking ---------------------------------------------------------------
{
  const vent = createInteractive(VENT_ROW);
  assert(!vent.broken, 'starts intact');
  // One AK bullet is far more than a vent's single hit point.
  assert(applyDamage(vent, 36, 'bullets'), 'a bullet breaks it');
  assert(vent.broken, 'and it stays broken');
  assert(!applyDamage(vent, 36, 'bullets'), 'breaking twice reports false');

  // Glass takes half damage from bullets, and one bullet is still plenty.
  const glass = createInteractive(GLASS_ROW);
  assert(applyDamage(glass, 4, 'bullets'), 'glass breaks: 4 * 0.5 clears 1 hp');
  const tough = createInteractive({ ...GLASS_ROW, break: { ...GLASS_ROW.break, health: 10 } });
  assert(!applyDamage(tough, 4, 'bullets'), '4 * 0.5 does not clear 10 hp');
  close(tough.health, 8, 1e-9, 'and the multiplier was applied, not ignored');
}

// ---- a grenade smashes through what it hits -------------------------------
// It breaks the thing and carries on at a fraction of its speed, in the
// direction it arrived on. It does not bounce off a pane of glass.
{
  const glass = createInteractive({ ...GLASS_ROW, phys: { surface: 'glass', min: [0, 0, 0], max: [1, 1, 1] } });
  const velIn = { x: 600, y: -200, z: -100 };
  const out = grenadeThrough(glass, velIn);
  assert(out, 'the pane gives way');
  assert(glass.broken, 'and it is broken');
  // 0.926 measured on the one clean Nuke observation; see the constant.
  const keep = GRENADE_BREAK_KEEP.glass;
  close(keep, 0.93, 1e-9, 'glass costs a grenade about 7% of its speed');
  assert(keep > GRENADE_BREAK_KEEP.default, 'and less than a metal vent does');
  close(out.x, velIn.x * keep, 1e-9, 'the grenade keeps its heading');
  close(out.y, velIn.y * keep, 1e-9, '...on every axis');
  close(out.z, velIn.z * keep, 1e-9, '...including down');
  const before = Math.hypot(velIn.x, velIn.y, velIn.z);
  const after = Math.hypot(out.x, out.y, out.z);
  close(after / before, keep, 1e-9, 'and loses exactly the pane share of its speed');
  assert(after < before, 'which is a stagger, not a bounce');

  // Nothing goes through twice.
  assert(!grenadeThrough(glass, velIn), 'a broken pane is not there to break again');

  // Metal costs more than glass, and that split comes from the collision hull.
  const vent = createInteractive({ ...VENT_ROW, phys: { surface: 'metal_ventslat', min: [0, 0, 0], max: [1, 1, 1] } });
  assert(breakKeep(vent) < breakKeep(glass), 'a vent slat takes more out of a throw than glass does');
  close(breakKeep(vent), GRENADE_BREAK_KEEP.default, 1e-9, 'metal falls to the default');
  close(breakKeep(glass), GRENADE_BREAK_KEEP.glass, 1e-9, 'and glass has its own');

  // A door is not something a grenade smashes through.
  const d = createInteractive({ ...DOOR_ROW, door: { ...DOOR_ROW.door, slave: '' } });
  assert(!grenadeThrough(d, velIn), 'a grenade bounces off a door');
  assert(!d.broken, 'and leaves it standing');
}

// ---- fire does nothing, and that is the point -----------------------------
{
  const vent = createInteractive(VENT_ROW);
  assert(!applyDamage(vent, 1000, 'fire'), 'fire is not a damage type');
  assert(!vent.broken, 'a molotov leaves a vent intact');
  assert(!DAMAGE_TYPES.includes('fire'), 'and fire is not in the type list either');
  const out = applyFire();
  assert(!out.broken.length && !out.opened.length, 'a molotov breaks nothing and opens nothing');
}

// ---- an HE destroys a door rather than opening it -------------------------
{
  const at = { x: 448, y: -1403, z: -416 };
  const list = linkDoors([
    createInteractive(VENT_ROW),
    createInteractive({ ...DOOR_ROW, origin: [448, -1403, -416], door: { ...DOOR_ROW.door, slave: '' } })
  ]);
  // hegrenade: m_nDamage 99, m_flRange 350, from weapons.vdata.
  const { broken } = applyBlast(list, at, 350, 99);
  assert(broken.length === 2, 'the blast broke both things in its radius');
  assert(broken.some((o) => o.role === 'breakable'), 'the vent went');
  // A door is destroyed by an HE, not opened by one: 100 hit points against
  // 99 damage times its 1.5 explosive multiplier.
  const blown = broken.find((o) => o.role === 'door');
  assert(blown && blown.broken, 'and so did the door');
  close(99 * 1.5, 148.5, 1e-9, 'an HE lands 148.5 on a door, against its 100 hit points');

  // Out of range, nothing happens.
  const far = linkDoors([createInteractive(VENT_ROW)]);
  const none = applyBlast(far, { x: 448 + 500, y: -1403, z: -416 }, 350, 99);
  assert(!none.broken.length, 'a blast beyond the radius does nothing');

  // ...and falloff is real: at the very edge the damage is near zero, so a
  // tough prop survives what a vent does not.
  const edge = [createInteractive({ ...VENT_ROW, break: { ...VENT_ROW.break, health: 90 } })];
  const grazed = applyBlast(edge, { x: 448 + 340, y: -1403, z: -416 }, 350, 99);
  assert(!grazed.broken.length, 'a 90 hp prop survives the edge of a blast');
}

// ---- the extracted data is the shape this file expects --------------------
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = path.join(root, 'server', 'data', 'cs3d', 'pack', 'nuke', 'interactives.json');
  if (fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(doc.version === 1, 'interactives.json is v1');
    assert(
      JSON.stringify(doc.damageTypes) === JSON.stringify(DAMAGE_TYPES),
      'the extractor and the sim agree on the damage types'
    );
    const all = linkDoors(doc.interactives.map(createInteractive));
    assert(all.length > 0, 'nuke has interactives');
    const doors = all.filter((o) => o.role === 'door');
    assert(doors.length === 4, `nuke has 4 doors, found ${doors.length}`);
    for (const d of doors) close(doorSwingSeconds(d), 0.445, 1e-3, `${d.id} swings in 0.445 s`);
    // The double doors found each other.
    assert(doors.some((d) => d.linked), 'at least one Nuke door is half of a pair');
    // Every breakable can be broken by something.
    for (const b of all.filter((o) => o.role === 'breakable')) {
      assert(b.health > 0, `${b.id} has health`);
      assert(DAMAGE_TYPES.some((t) => b.mult[t] > 0), `${b.id} is vulnerable to something`);
    }
    console.log(`  (checked against the real pack: ${all.length} interactives on nuke)`);
  } else {
    console.log('  (no packed interactives.json; run scripts/cs3d-interactives.mjs to check against real data)');
  }
}

// ---- where a door physically is -------------------------------------------
// The drawing and the collision are the same box (src/cs3d/interactives.js
// hands `boxTriangles` straight to the tracer), so if this box is wrong the
// door is solid where it is not drawn — which is the worst failure available
// here and the one worth a test of its own.
{
  // A leaf hinged at the origin, 60 wide along +x, 11 thick, 110 tall — the
  // shape the split measured on all four Nuke doors.
  const row = { ...DOOR_ROW, id: 'test:door', origin: [0, 0, 0], door: { ...DOOR_ROW.door, slave: '' } };
  row.bounds = { min: [0, -5.5, 0], max: [60, 5.5, 110] };
  const d = createInteractive(row);

  // OPEN is the baked pose, so that is where the box is axis-aligned: the
  // bounds the split measured, unrotated.
  openDoor(d);
  stepInteractive(d, 1);
  assert(d.state === DOOR.OPEN, 'fully open');
  const corners = boxCorners(d);
  assert(corners.length === 24, 'eight corners');
  const xs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => corners[i * 3]);
  close(Math.min(...xs), 0, 1e-9, 'open, the leaf starts at the hinge');
  close(Math.max(...xs), 60, 1e-9, 'and reaches 60 units out');

  const open = boxBounds(d, { min: [0, 0, 0], max: [0, 0, 0] });
  // Scene frame: (x, z, −y). The leaf is 60 along x and 110 up.
  close(open.max[0] - open.min[0], 60, 1e-6, 'open: 60 units wide in the scene too');
  close(open.max[1] - open.min[1], 110, 1e-6, '...and 110 tall');
  close(open.max[2] - open.min[2], 11, 1e-6, '...and 11 thick');

  // Shut it and the leaf has turned back through 89 degrees: it now lies
  // almost entirely the other way, which is the doorway it fills.
  closeDoor(d);
  stepInteractive(d, 1);
  assert(d.state === DOOR.CLOSED, 'fully shut');
  const shut = boxBounds(d, { min: [0, 0, 0], max: [0, 0, 0] });
  close(shut.max[1] - shut.min[1], 110, 1e-6, 'shut: still 110 tall');
  assert(shut.max[0] - shut.min[0] < 20, 'but barely 60 units wide any more');
  assert(shut.max[2] - shut.min[2] > 55, 'because it now lies the other way');
  // The far corner is still 60-ish from the hinge whichever way it points.
  const swung = boxCorners(d);
  const far = Math.max(
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => Math.hypot(swung[i * 3], swung[i * 3 + 1]))
  );
  close(far, Math.hypot(60, 5.5), 1e-4, 'a hinge does not stretch the leaf');

  // 12 triangles, and every vertex of them is one of the eight corners.
  const tris = boxTriangles(d);
  assert(tris.length === 12 * 9, '12 triangles');
  const cornerSet = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${swung[i * 3].toFixed(4)},${swung[i * 3 + 2].toFixed(4)},${(-swung[i * 3 + 1]).toFixed(4)}`));
  for (let i = 0; i < tris.length; i += 3) {
    const key = `${tris[i].toFixed(4)},${tris[i + 1].toFixed(4)},${tris[i + 2].toFixed(4)}`;
    assert(cornerSet.has(key), `triangle vertex ${i / 3} is a corner of the box`);
  }

  // A thing with no measured bounds has no box, and must not pretend to.
  const noBounds = createInteractive({ ...row, bounds: undefined });
  assert(!boxCorners(noBounds), 'no bounds, no corners');
  assert(boxTriangles(noBounds).length === 0, 'and no triangles either');
}

// ---- the split wrote what the runtime needs -------------------------------
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = path.join(root, 'server', 'data', 'cs3d', 'pack', 'nuke', 'interactives.json');
  if (fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const all = doc.interactives.filter((r) => r.role === 'door' || r.role === 'breakable');
    const withGeo = all.filter((r) => r.triangles > 0);
    assert(withGeo.length === all.length, `every Nuke interactive found geometry (${withGeo.length}/${all.length})`);
    for (const r of all) {
      assert(r.bounds, `${r.id} has measured bounds`);
      const size = r.bounds.max.map((v, k) => v - r.bounds.min[k]);
      assert(size.every((s) => s > 0 && s < 600), `${r.id} is a plausible size: ${size.map((s) => s.toFixed(0))}`);
    }
    // The window models are named after their own dimensions, which is a free
    // check that the geometry claimed for each one is really that window.
    for (const r of all) {
      const m = /nuke_window_(\d+)x(\d+)/.exec(r.model || '');
      if (!m) continue;
      // The thin axis is the glass; the other two are the model's dimensions,
      // whichever way round the prop happens to be turned.
      const size = r.bounds.max.map((v, k) => v - r.bounds.min[k]).sort((a, b) => b - a);
      const named = [+m[1], +m[2]].sort((a, b) => b - a);
      close(size[0], named[0], 1.5, `${r.id}: the pane measures ${named[0]} as its model name says`);
      close(size[1], named[1], 1.5, `${r.id}: ...and ${named[1]} the other way`);
    }
    // Every breakable had a collision hull in phys.glb; doors, by design, did not.
    const breakables = all.filter((r) => r.role === 'breakable');
    assert(breakables.every((r) => r.phys), 'every breakable carries its collision hull');
    assert(all.filter((r) => r.role === 'door').every((r) => !r.phys), 'and no door does');
    const glass = breakables.filter((r) => r.phys.surface === 'glass');
    assert(glass.length === 14, `14 glass hulls on Nuke, found ${glass.length}`);
    console.log(`  (split geometry: ${all.reduce((a, r) => a + r.triangles, 0)} triangles across ${all.length})`);
  }
}

console.log('interactives.test: ok');
