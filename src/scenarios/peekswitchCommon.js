// ---------------------------------------------------------------------------
// peekswitchCommon.js — shared map setup and spawn-zone helpers for Peekswitch.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BaseScenario } from './BaseScenario.js';
import { randRange } from '../utils/MathUtils.js';
import { gridLineColors } from '../utils/ColorUtils.js';
import { buildMapMeshes } from '../utils/buildMapMeshes.js';
import { mapExtent } from '../multiplayer/maps.js';
import { PEEKSWITCH_MAP } from '../maps/peekswitchMapData.js';

export const PEEKSWITCH_ZONE_KEYS = ['left', 'right'];
const PLAYER_YAW = 0;

/** Axis-aligned bounds for a spawn zone `{ pos, size }`. */
export function spawnZoneAabb(zone) {
  const [cx, cy, cz] = zone.pos;
  const [w, h, d] = zone.size;
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  return {
    minX: cx - hw,
    maxX: cx + hw,
    minY: cy - hh,
    maxY: cy + hh,
    minZ: cz - hd,
    maxZ: cz + hd
  };
}

export function randomPointInZone(zone, margin = 0) {
  const b = spawnZoneAabb(zone);
  return new THREE.Vector3(
    randRange(b.minX + margin, b.maxX - margin),
    randRange(b.minY + margin, b.maxY - margin),
    randRange(b.minZ + margin, b.maxZ - margin)
  );
}

export function randomGroundInZone(zone, margin = 0.35) {
  const b = spawnZoneAabb(zone);
  return {
    x: randRange(b.minX + margin, b.maxX - margin),
    z: randRange(b.minZ + margin, b.maxZ - margin),
    footY: 0
  };
}

export class PeekswitchBaseScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.map = PEEKSWITCH_MAP;
    this.coverMeshes = [];
    this.colliderBoxes = [];
    this._arenaObjects = [];
    this._zoneIdx = 0;
    this._buildEnvironment();
  }

  tracerRaycastExtras() {
    return this.coverMeshes.slice();
  }

  _zoneKey() {
    return PEEKSWITCH_ZONE_KEYS[this._zoneIdx];
  }

  _currentZone() {
    return this.map.spawnZones[this._zoneKey()];
  }

  _advanceZone() {
    this._zoneIdx = (this._zoneIdx + 1) % PEEKSWITCH_ZONE_KEYS.length;
  }

  _buildEnvironment() {
    const c = this.settings.data.colors;
    const [gridCenter, gridEdge] = gridLineColors(c.floor);
    const extent = mapExtent(this.map);
    const floorSize = extent * 2;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: c.floor, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);
    this._arenaObjects.push(floor);

    const gridDiv = Math.min(120, Math.max(40, Math.round(floorSize / 2)));
    const grid = new THREE.GridHelper(floorSize, gridDiv, gridCenter, gridEdge);
    grid.position.y = 0.002;
    this.root.add(grid);
    this._arenaObjects.push(grid);

    const built = buildMapMeshes(this.map, {
      coverColor: c.cover,
      floorColor: c.floor,
      root: this.root,
      onMesh: (m) => this._arenaObjects.push(m)
    });
    this.coverMeshes = built.coverMeshes;
    this.colliderBoxes = built.colliderBoxes;
    this.coverColliderBoxes = (this.map.boxes || [])
      .filter((b) => b.role !== 'clip' && b.role !== 'spawn')
      .map((b) => ({ pos: b.pos, size: b.size, rotationY: b.rotationY || 0 }));
  }

  _playerBounds() {
    const b = this.map.bounds;
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  }

  _respawnPlayer() {
    const sp = this.map.spawns.A.pos;
    this.engine.player.spawn({
      pos: sp,
      yaw: PLAYER_YAW,
      bounds: this._playerBounds(),
      colliders: this.colliderBoxes
    });
    this.engine.weapon?.reset();
  }

  onStart() {
    this._zoneIdx = 0;
    this._respawnPlayer();
  }
}
