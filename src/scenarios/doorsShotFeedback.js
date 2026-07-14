// ---------------------------------------------------------------------------
// doorsShotFeedback.js — practice shot feedback for Doors (AWP).
// Drawn in a dedicated overlay scene (second render pass) so it always shows
// through cover. Bot X/Y come from the shot tick; Z is pinned on the door plane.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { HEAD_R, HEAD_CENTER_STAND, BODY_TOP_STAND } from '../multiplayer/constants.js';

const BODY_R = 0.35;
const BODY_H = BODY_TOP_STAND; // silhouette matches the skeletal bot's shoulder line
const HEAD_Y = HEAD_CENTER_STAND;
const HIT_RADIUS = 0.18;
/** Open lane between spawn platform and door volumes (player at z ≈ -20, doors ≈ -1.25). */
const FEEDBACK_PLANE_Z = -5.5;

const _worldPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();

function solidMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: true,
    depthWrite: true,
    fog: false
  });
}

function makeBotSnapshotGroup() {
  const g = new THREE.Group();
  g.frustumCulled = false;

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H, 18),
    solidMat(0xff1a1a)
  );
  body.position.y = BODY_H / 2;
  body.frustumCulled = false;
  g.add(body);

  const bodyWire = new THREE.Mesh(
    new THREE.CylinderGeometry(BODY_R * 1.12, BODY_R * 1.12, BODY_H * 1.04, 18),
    solidMat(0xff6666, 0.45)
  );
  bodyWire.position.y = BODY_H / 2;
  bodyWire.frustumCulled = false;
  g.add(bodyWire);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD_R, 20, 16),
    solidMat(0xff4444)
  );
  head.position.y = HEAD_Y;
  head.frustumCulled = false;
  g.add(head);

  return g;
}

function makeHitMarker() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(HIT_RADIUS * 0.5, HIT_RADIUS, 32),
    solidMat(0xffd400)
  );
  ring.frustumCulled = false;
  return ring;
}

/** @returns {{ root: THREE.Group, items: object[] }} */
export function createDoorsShotFeedback(overlayScene) {
  const fxRoot = new THREE.Group();
  fxRoot.name = 'doors-shot-feedback';
  overlayScene.add(fxRoot);
  return { root: fxRoot, items: [] };
}

export function spawnBotSnapshot(fx, botObject, duration) {
  botObject.getWorldPosition(_worldPos);
  const snap = makeBotSnapshotGroup();
  snap.position.set(_worldPos.x, _worldPos.y, FEEDBACK_PLANE_Z);
  snap.rotation.set(0, botObject.rotation.y, 0);
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
