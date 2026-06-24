// ---------------------------------------------------------------------------
// ColorUtils.js
// Helpers for deriving scene accent colors from user theme settings.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const DEFAULT_FLOOR = new THREE.Color('#101010');
const DEFAULT_GRID_CENTER = new THREE.Color(0x343434);
const DEFAULT_GRID_EDGE = new THREE.Color(0x202020);

/** GridHelper center/edge line colors that track the floor tint. */
export function gridLineColors(floorHex) {
  const floor = new THREE.Color(floorHex);
  const center = floor.clone().add(DEFAULT_GRID_CENTER.clone().sub(DEFAULT_FLOOR));
  const edge = floor.clone().add(DEFAULT_GRID_EDGE.clone().sub(DEFAULT_FLOOR));
  for (const c of [center, edge]) {
    c.r = Math.min(1, Math.max(0, c.r));
    c.g = Math.min(1, Math.max(0, c.g));
    c.b = Math.min(1, Math.max(0, c.b));
  }
  return [center.getHex(), edge.getHex()];
}

const GRID_CELLS = 8; // cells per 1 m of cover surface

/** Canvas grid texture for cover boxes — matches the floor grid palette. */
function coverGridTexture(coverHex, floorHex) {
  const px = 128;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  const cover = new THREE.Color(coverHex);
  ctx.fillStyle = `#${cover.getHexString()}`;
  ctx.fillRect(0, 0, px, px);

  const [centerHex, edgeHex] = gridLineColors(floorHex);
  const step = px / GRID_CELLS;
  for (let i = 0; i <= GRID_CELLS; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.strokeStyle = `#${new THREE.Color(i % 4 === 0 ? edgeHex : centerHex).getHexString()}`;
    ctx.lineWidth = i % 4 === 0 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, px);
    ctx.moveTo(0, p);
    ctx.lineTo(px, p);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Material with a repeating grid for axis-aligned cover boxes. */
export function createCoverGridMaterial(coverHex, floorHex) {
  return new THREE.MeshStandardMaterial({
    map: coverGridTexture(coverHex, floorHex),
    roughness: 0.85,
    metalness: 0.05
  });
}

/** Tile the grid ~1 m per cell on a box face from its width/height in metres. */
export function applyCoverGridRepeat(material, width, height) {
  if (!material.map) return;
  material.map.repeat.set(Math.max(1, width), Math.max(1, height));
  material.map.needsUpdate = true;
}
