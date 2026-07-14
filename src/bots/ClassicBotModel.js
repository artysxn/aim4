// ---------------------------------------------------------------------------
// ClassicBotModel.js
// Static cylinder + sphere bot matching CSBotModel proportions (same body
// width and head size). No gait or aim-matrix animation — the root slides and
// yaws; crouch only adjusts body height and head position.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  HEAD_CENTER_STAND,
  bodyTopY,
  headCenterY
} from '../multiplayer/constants.js';

/** Body cylinder radius — matches CSBotModel chest capsule (0.15 m). */
export const CLASSIC_BODY_R = 0.15;
/** Head sphere radius — matches CSBotModel head capsule (0.105 m). */
export const CLASSIC_HEAD_R = 0.105;

const _wp = new THREE.Vector3();

const _eye = new THREE.Vector3();

export class ClassicBotModel {
  /**
   * @param {object} opts
   * @param {number|string} opts.bodyColor
   * @param {number|string} opts.headColor
   * @param {number} opts.widthScale  multiplies radii (tracking difficulty)
   * @param {number} opts.scale       uniform scale of the whole model
   */
  constructor({
    bodyColor = 0xff5544,
    headColor = 0xffd24a,
    widthScale = 1,
    scale = 1
  } = {}) {
    this._w = widthScale;
    this._crouch = 0;
    this._pitchTarget = 0;

    this.root = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: bodyColor,
      emissive: bodyColor,
      emissiveIntensity: 0.4,
      roughness: 0.5
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: headColor,
      emissive: headColor,
      emissiveIntensity: 0.5,
      roughness: 0.4
    });

    const bodyR = CLASSIC_BODY_R * this._w;
    const headR = CLASSIC_HEAD_R * this._w;
    const standBodyH = bodyTopY(0);

    this._bodyMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(bodyR, bodyR, standBodyH, 16, 1),
      bodyMat
    );
    this._bodyMesh.position.y = standBodyH / 2;
    this._bodyMesh.userData.zone = 'body';
    this.root.add(this._bodyMesh);

    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(headR, 16, 12), headMat);
    this.headMesh.position.y = HEAD_CENTER_STAND;
    this.headMesh.userData.zone = 'head';
    this.root.add(this.headMesh);

    this.colliders = [this._bodyMesh, this.headMesh];
    this.visualMeshes = [this._bodyMesh, this.headMesh];

    if (scale !== 1) this.root.scale.setScalar(scale);

    this._applyCrouch(0);
  }

  _applyCrouch(crouch) {
    const c = THREE.MathUtils.clamp(crouch, 0, 1);
    const bodyH = bodyTopY(c);
    const headY = headCenterY(c);
    const standBodyH = bodyTopY(0);
    this._bodyMesh.scale.y = bodyH / standBodyH;
    this._bodyMesh.position.y = bodyH / 2;
    this.headMesh.position.y = headY;
  }

  aimAt(x, y, z) {
    this.root.getWorldPosition(_wp);
    const dx = x - _wp.x;
    const dz = z - _wp.z;
    this.root.rotation.y = Math.atan2(dx, dz);
    const eyeY = this.headMesh.getWorldPosition(_eye).y - 0.03;
    this._pitchTarget = Math.atan2(y - eyeY, Math.hypot(dx, dz) || 1e-6);
  }

  setYaw(yaw) {
    this.root.rotation.y = yaw;
  }

  setPitch(pitch) {
    this._pitchTarget = pitch;
  }

  update(dt, { crouch = this._crouch } = {}) {
    if (dt <= 0) return;
    this._crouch = THREE.MathUtils.clamp(crouch, 0, 1);
    this._applyCrouch(this._crouch);
  }
}
