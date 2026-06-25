// ---------------------------------------------------------------------------
// audio/GameAudio.js — FPS SFX: gunshots (2D + spatial), footsteps, jumps
// ---------------------------------------------------------------------------

import { RUN_SPEED, WALK_SPEED } from '../utils/SourceMovement.js';

const STEP_DIST = 1.65; // metres between run footsteps at full speed
const REMOTE_SILENT_SPEED = WALK_SPEED * 1.12; // shift-walk / crouch band

export class GameAudio {
  constructor(engine) {
    this.engine = engine;
    this.ctx = null;
    this._localFootDist = 0;
    this._localFootIdx = 0;
    this._localWasOnGround = true;
  }

  _ensure() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Call on user gesture (pointer lock) so audio is allowed to play. */
  resume() {
    this._ensure();
  }

  /** Keep the Web Audio listener aligned with the FPS camera. */
  syncListener(camera) {
    const ctx = this._ensure();
    if (!ctx || !camera) return;

    const p = camera.position;
    const yaw = camera.rotation.y;
    const pitch = camera.rotation.x;
    const cosP = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cosP;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cosP;
    const ux = 0;
    const uy = 1;
    const uz = 0;

    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = ux;
      l.upY.value = uy;
      l.upZ.value = uz;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _connectOutput(node, gainNode) {
    if (node) {
      gainNode.connect(node);
      node.connect(this.ctx.destination);
    } else {
      gainNode.connect(this.ctx.destination);
    }
  }

  _makePanner(x, y, z) {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.4;
    panner.maxDistance = 70;
    panner.rolloffFactor = 1.15;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else {
      panner.setPosition(x, y, z);
    }
    return panner;
  }

  /** Local first-person gunshot (non-spatial). */
  playLocalShot() {
    this._playGunshot(null, 0.26);
  }

  /** Enemy / remote gunshot at world position. */
  playRemoteShot(x, y, z) {
    const ctx = this._ensure();
    if (!ctx) return;
    const panner = this._makePanner(x, y, z);
    this._playGunshot(panner, 0.34);
  }

  _playGunshot(outNode, peakGain) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 0.11;

    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.07));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2100;
    bp.Q.value = 0.65;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(peakGain, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noise.connect(bp);
    bp.connect(ng);
    this._connectOutput(outNode, ng);
    noise.start(t);
    noise.stop(t + dur + 0.02);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(peakGain * 0.55, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(og);
    this._connectOutput(outNode, og);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /**
   * Local footsteps — silent while shift-walking or crouching (CS2-style).
   */
  updateLocalFootsteps(dt, { onGround, crouchAmt, walkHeld, spawnGrace, speedHoriz }) {
    if (spawnGrace > 0 || !onGround || walkHeld || crouchAmt > 0.35 || speedHoriz < 0.45) {
      this._localFootDist = 0;
      return;
    }

    this._localFootDist += speedHoriz * dt;
    const scale = RUN_SPEED / Math.max(speedHoriz, RUN_SPEED * 0.35);
    const need = STEP_DIST * scale;
    if (this._localFootDist >= need) {
      this._localFootDist -= need;
      this._localFootIdx = (this._localFootIdx + 1) % 2;
      this._playFootstep(null, this._localFootIdx, 0.2);
    }
  }

  /** Local jump leave-ground cue. */
  playLocalJump() {
    this._playJump(null, 0.22);
  }

  /** Remote player footstep at world position. */
  playRemoteFootstep(x, y, z, variant = 0) {
    const ctx = this._ensure();
    if (!ctx) return;
    const panner = this._makePanner(x, y, z);
    this._playFootstep(panner, variant, 0.26);
  }

  playRemoteJump(x, y, z) {
    const ctx = this._ensure();
    if (!ctx) return;
    const panner = this._makePanner(x, y, z);
    this._playJump(panner, 0.24);
  }

  _playFootstep(outNode, variant, peakGain) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const dur = 0.055;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.22));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = variant === 0 ? 420 : 340;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peakGain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    this._connectOutput(outNode, g);
    src.start(t);
    src.stop(t + dur + 0.01);
  }

  _playJump(outNode, peakGain) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.ceil(ctx.sampleRate * 0.09);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / (len * 0.35));
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(280, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.06);
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peakGain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(bp);
    bp.connect(g);
    this._connectOutput(outNode, g);
    src.start(t);
    src.stop(t + 0.1);
  }

  /**
   * Track a remote player's motion and emit spatial steps / jumps.
   * @param {number} id
   * @param {{ cur: object, dead: boolean, _sfx?: object }} remote
   * @param {number} dt
   */
  updateRemotePlayer(id, remote, dt) {
    if (remote.dead) return;
    const ctx = this._ensure();
    if (!ctx || dt <= 0) return;

    const state = remote.cur;
    let sfx = remote._sfx;
    if (!sfx) {
      remote._sfx = sfx = {
        x: state.x,
        y: state.y,
        z: state.z,
        footDist: 0,
        footIdx: 0,
        wasOnGround: true
      };
      return;
    }

    const dx = state.x - sfx.x;
    const dz = state.z - sfx.z;
    const dy = state.y - sfx.y;
    const horizSpeed = Math.hypot(dx, dz) / dt;
    const vy = dy / dt;

    if (sfx.wasOnGround && vy > 2.8) {
      this.playRemoteJump(state.x, state.y - 0.9, state.z);
    }

    const crouching = (state.crouch ?? 0) > 0.35;
    const silent = crouching || horizSpeed < REMOTE_SILENT_SPEED;
    if (!silent && horizSpeed > 0.55) {
      sfx.footDist += horizSpeed * dt;
      const scale = RUN_SPEED / Math.max(horizSpeed, RUN_SPEED * 0.35);
      const need = STEP_DIST * scale;
      if (sfx.footDist >= need) {
        sfx.footDist -= need;
        sfx.footIdx = (sfx.footIdx + 1) % 2;
        this.playRemoteFootstep(state.x, state.y - 1.5, state.z, sfx.footIdx);
      }
    } else {
      sfx.footDist = 0;
    }

    sfx.x = state.x;
    sfx.y = state.y;
    sfx.z = state.z;
    sfx.wasOnGround = vy <= 1.5;
  }
}
