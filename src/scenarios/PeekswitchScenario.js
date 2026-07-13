// ---------------------------------------------------------------------------
// PeekswitchScenario.js  ("Peekswitch (Static)")
//
// Fixed peek arena (peekswitch.json). One dot at a time spawns in the left or
// right spawn zone; killing it forces the next dot into the opposite zone.
// Invisible clip barriers block movement but not shots. Training settings can
// vary dot size and add pasu-style drift or bounce movement inside the zone.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { beep } from './BaseScenario.js';
import { Target } from '../components/Target.js';
import { randRange, clamp } from '../utils/MathUtils.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';
import {
  PeekswitchBaseScenario,
  randomPointInZone,
  spawnZoneAabb
} from './peekswitchCommon.js';

const GRAVITY = 12;

export class PeekswitchScenario extends PeekswitchBaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'pistol';
    this.usesWeapon = false;
    const preset = this.competitive ? competitivePresetFor(this.name) : null;
    const s = (this.competitive ? DEFAULTS[this.name] : this.settings.data[this.name]) ?? DEFAULTS.peekswitch;
    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? s.targetSize;
    this.sizeVariance = clamp(preset?.sizeVariance ?? this.config.sizeVariance ?? s.sizeVariance ?? 0.35, 0, 0.75);
    this.movement = preset?.movement ?? this.config.movement ?? s.movement ?? 'none';
    this.travelSpeed = preset?.travelSpeed ?? this.config.travelSpeed ?? s.travelSpeed ?? 2.5;
    this.bounceStrength = preset?.bounceStrength ?? this.config.bounceStrength ?? s.bounceStrength ?? 6;
    this.infiniteAmmo = this.config.infiniteAmmo ?? s.infiniteAmmo !== false;
    this.weaponBloom = false;
    this.viewmodelRecoil =
      preset?.viewmodelRecoil ?? this.config.viewmodelRecoil ?? s.viewmodelRecoil ?? false;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;
  }

  get name() {
    return 'peekswitch';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return PeekswitchScenario.configKeyFor(this.settings, this.variant);
  }

  _rollTargetSize() {
    const spread = this.targetSize * this.sizeVariance;
    return Math.max(0.06, this.targetSize + randRange(-spread, spread));
  }

  _initMovement(target, size) {
    const zone = this._currentZone();
    const b = spawnZoneAabb(zone);
    const speed = randRange(this.travelSpeed * 0.45, this.travelSpeed);

    if (this.movement === 'pasu') {
      const angle = randRange(0, Math.PI * 2);
      target._move = {
        kind: 'pasu',
        bounds: b,
        size,
        velX: Math.cos(angle) * speed,
        velY: Math.sin(angle) * speed,
        velZ: Math.cos(angle + 1.1) * speed * 0.65
      };
      return;
    }

    if (this.movement === 'bounce') {
      target._move = {
        kind: 'bounce',
        bounds: b,
        size,
        velX: randRange(-speed, speed) * 0.5,
        velZ: randRange(-speed, speed) * 0.5,
        vy: Math.sqrt(2 * GRAVITY * this.bounceStrength * 0.45) * randRange(0.75, 1)
      };
      return;
    }

    target._move = null;
  }

  _spawnDot() {
    const size = this._rollTargetSize();
    const margin = size + 0.05;
    const pos = randomPointInZone(this._currentZone(), margin);

    const target = new Target();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 24, 18),
      new THREE.MeshStandardMaterial({
        color: this.settings.data.colors.target,
        emissive: this.settings.data.colors.target,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.1
      })
    );
    target._mesh = mesh;
    target._dotSize = size;
    target.addCollider(mesh, { zone: 'body', points: 1, crit: false });
    target.object.position.copy(pos);
    this._initMovement(target, size);
    this.addTarget(target);
  }

  _updatePasu(target, dt) {
    const m = target._move;
    if (!m || m.kind !== 'pasu') return;
    const pos = target.object.position;
    pos.x += m.velX * dt;
    pos.y += m.velY * dt;
    pos.z += m.velZ * dt;

    const pad = m.size;
    if (pos.x < m.bounds.minX + pad) {
      pos.x = m.bounds.minX + pad;
      m.velX = Math.abs(m.velX);
    } else if (pos.x > m.bounds.maxX - pad) {
      pos.x = m.bounds.maxX - pad;
      m.velX = -Math.abs(m.velX);
    }
    if (pos.y < m.bounds.minY + pad) {
      pos.y = m.bounds.minY + pad;
      m.velY = Math.abs(m.velY);
    } else if (pos.y > m.bounds.maxY - pad) {
      pos.y = m.bounds.maxY - pad;
      m.velY = -Math.abs(m.velY);
    }
    if (pos.z < m.bounds.minZ + pad) {
      pos.z = m.bounds.minZ + pad;
      m.velZ = Math.abs(m.velZ);
    } else if (pos.z > m.bounds.maxZ - pad) {
      pos.z = m.bounds.maxZ - pad;
      m.velZ = -Math.abs(m.velZ);
    }
  }

  _updateBounce(target, dt) {
    const m = target._move;
    if (!m || m.kind !== 'bounce') return;
    const pos = target.object.position;
    const pad = m.size;

    pos.x += m.velX * dt;
    pos.z += m.velZ * dt;
    m.vy -= GRAVITY * dt;
    pos.y += m.vy * dt;

    if (pos.x < m.bounds.minX + pad) {
      pos.x = m.bounds.minX + pad;
      m.velX = Math.abs(m.velX);
    } else if (pos.x > m.bounds.maxX - pad) {
      pos.x = m.bounds.maxX - pad;
      m.velX = -Math.abs(m.velX);
    }
    if (pos.z < m.bounds.minZ + pad) {
      pos.z = m.bounds.minZ + pad;
      m.velZ = Math.abs(m.velZ);
    } else if (pos.z > m.bounds.maxZ - pad) {
      pos.z = m.bounds.maxZ - pad;
      m.velZ = -Math.abs(m.velZ);
    }

    const floorY = m.bounds.minY + pad;
    const ceilY = m.bounds.maxY - pad;
    if (pos.y < floorY) {
      pos.y = floorY;
      m.vy = Math.sqrt(2 * GRAVITY * this.bounceStrength * 0.45) * randRange(0.85, 1.1);
    } else if (pos.y > ceilY) {
      pos.y = ceilY;
      m.vy = -Math.abs(m.vy) * 0.5;
    }
  }

  _updateMovement(dt) {
    if (this.movement === 'none') return;
    for (const t of this.targets) {
      if (t.state === 'dying') continue;
      if (this.movement === 'pasu') this._updatePasu(t, dt);
      else if (this.movement === 'bounce') this._updateBounce(t, dt);
    }
  }

  _penalizeMiss() {
    this.misses++;
    if (!this.competitive) return;
    this.kills = Math.max(0, this.kills - 1);
    this.score = Math.max(0, this.score - 1);
  }

  onStart() {
    super.onStart();
    this._spawnDot();
  }

  onUpdate(dt) {
    this._updateMovement(dt);
  }

  onShoot(raycaster) {
    const hit = this.raycastTargets(raycaster, this.coverMeshes);
    const target = hit?.object?.userData?.target;
    if (!target || target.state === 'dying') {
      this._penalizeMiss();
      return;
    }
    this.hits++;
    this.kills++;
    this.score += 1;
    target.startDying(0x35e06a);
    beep(820, 0.04, 'square', 0.05);
    this.crosshair?.hit();
    this._advanceZone();
    this._spawnDot();
  }
}
