// ---------------------------------------------------------------------------
// doorsShotFeedback.js — practice shot feedback for Doors (AWP):
// red bot snapshot at fire time (x-ray on the door plane) + yellow hit marker.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { HEAD_R, HEAD_OFFSET } from '../multiplayer/constants.js';

const BODY_R = 0.35;
const BODY_H = 1.3;
const HEAD_Y = BODY_H + HEAD_R + HEAD_OFFSET;
const RENDER_ORDER = 2000;
const HIT_RADIUS = 0.14;
/** Player-side plane in front of door geometry — ghosts draw here for x-ray feedback. */
const FEEDBACK_PLANE_Z = -2.85;

const _camPos = new THREE.Vector3();

function glowMat(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false
  });
}

function makeBotSnapshotGroup() {
  const g = new THREE.Group();
  g.renderOrder = RENDER_ORDER;

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 16),
    glowMat(0xff2200)
  );
  body.position.y = BODY_H / 2;
  body.renderOrder = RENDER_ORDER;
  g.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_R, 18, 14),
    glowMat(0xff5533)
  );
  head.position.y = HEAD_Y;
  head.renderOrder = RENDER_ORDER + 1;
  g.add(head);

  return g;
}

function makeHitMarker() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(HIT_RADIUS * 0.55, HIT_RADIUS, 28),
    glowMat(0xffd400)
  );
  ring.renderOrder = RENDER_ORDER + 2;
  return ring;
}

/** @returns {{ root: THREE.Group, items: object[] }} */
export function createDoorsShotFeedback(scene) {
  const fxRoot = new THREE.Group();
  fxRoot.name = 'doors-shot-feedback';
  fxRoot.renderOrder = RENDER_ORDER;
  scene.add(fxRoot);
  return { root: fxRoot, items: [] };
}

export function spawnBotSnapshot(fx, botObject, duration) {
  const snap = makeBotSnapshotGroup();
  snap.position.set(
    botObject.position.x,
    botObject.position.y,
    FEEDBACK_PLANE_Z
  );
  snap.quaternion.copy(botObject.rotation);
  fx.root.add(snap);
  fx.items.push({ kind: 'snap', obj: snap, t: 0, duration });
}

export function spawnHitMarker(fx, point, duration) {
  const mark = makeHitMarker();
  mark.position.set(point.x, point.y, FEEDBACK_PLANE_Z);
  fx.root.add(mark);
  fx.items.push({ kind: 'hit', obj: mark, t: 0, duration });
}

export function updateDoorsShotFeedback(fx, camera, dt) {
  if (!fx?.items.length) return;
  camera.getWorldPosition(_camPos);

  fx.items = fx.items.filter((item) => {
    item.t += dt;
    if (item.kind === 'hit') item.obj.lookAt(_camPos);

    if (item.t >= item.duration) {
      fx.root.remove(item.obj);
      item.obj.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      return false;
    }
    return true;
  });
}

export function disposeDoorsShotFeedback(fx) {
  if (!fx) return;
  for (const item of fx.items) {
    fx.root.remove(item.obj);
    item.obj.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
  fx.items.length = 0;
  fx.root.parent?.remove(fx.root);
}
