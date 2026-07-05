// ---------------------------------------------------------------------------
// lib/replayCodec.js — replay (de)serialization
//
// High-frequency (128 tick) telemetry codec for run replays. The format is
// designed to be tiny on the wire so Supabase Storage never balloons:
//
//   • Keyframes + deltas (anti-drift): once per second (every 128 ticks) the
//     camera's ABSOLUTE pitch/yaw/x/y/z are stored; the other 127 ticks store
//     only the change since the previous tick. Re-anchoring every second keeps
//     accumulated float error from drifting the playback.
//   • Input bitmasking: WASD / Jump / Crouch / Walk collapse into ONE integer
//     per tick (no per-key booleans) — see INPUT_BITS.
//   • Flat arrays: tick data is `[Pitch, Yaw, X, Y, Z, InputBitmask]` packed
//     back-to-back into a single integer array (no `{x:…}` JSON key bloat).
//   • Quantization + Gzip: floats are quantized to integers (angles to 1e-5
//     rad, positions to 1 mm) so deltas become small integers that gzip
//     crushes, then the whole JSON payload is gzip-compressed before upload.
//
// Entities (targets / bots) and shot events ride alongside the camera track so
// the replay reconstructs the *whole* scenario, not just a floating viewpoint.
// ---------------------------------------------------------------------------

export const TICK_RATE = 128; // ticks per second
export const TICK_DT = 1 / TICK_RATE;
export const REPLAY_VERSION = 1;

// Movement keys → one integer per tick (powers of two; never store booleans).
// SCOPE1/SCOPE2 encode the sniper zoom level (0 = unscoped) — replays predating
// them never set the high bits, so decoding stays backward compatible.
export const INPUT_BITS = Object.freeze({
  W: 1,
  A: 2,
  S: 4,
  D: 8,
  JUMP: 16,
  CROUCH: 32,
  WALK: 64,
  SCOPE1: 128,
  SCOPE2: 256
});

// Quantization: floats → integers so deltas compress as small ints under gzip.
const ANGLE_Q = 100000; // radians → 1e-5 rad (~0.0006°)
const POS_Q = 1000; // metres → 1 mm
const SCALE_Q = 10000; // unitless scale → 1e-4

const GZIP_MAGIC = [0x1f, 0x8b];

// --- gzip helpers (CompressionStream where available, raw JSON fallback) ----

async function gzipString(str) {
  const bytes = new TextEncoder().encode(str);
  if (typeof CompressionStream === 'undefined') return bytes; // raw fallback
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipToString(bytes) {
  const isGzip = bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
  if (!isGzip || typeof DecompressionStream === 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

// --- camera track (the spec's flat keyframe/delta array) --------------------

/**
 * Pack the per-tick camera samples into one flat integer array.
 * Tick i is a KEYFRAME when (i % TICK_RATE === 0): it stores absolute values.
 * Every other tick stores deltas from the previous tick (input is always the
 * absolute bitmask — it is already a compact integer).
 *
 * @param {Array<{pitch,yaw,px,py,pz,input}>} cam
 */
function packCamera(cam) {
  const out = new Array(cam.length * 6);
  let pPitch = 0, pYaw = 0, pX = 0, pY = 0, pZ = 0;
  for (let i = 0; i < cam.length; i++) {
    const s = cam[i];
    const qPitch = Math.round(s.pitch * ANGLE_Q);
    const qYaw = Math.round(s.yaw * ANGLE_Q);
    const qX = Math.round(s.px * POS_Q);
    const qY = Math.round(s.py * POS_Q);
    const qZ = Math.round(s.pz * POS_Q);
    const key = i % TICK_RATE === 0;
    const o = i * 6;
    out[o] = key ? qPitch : qPitch - pPitch;
    out[o + 1] = key ? qYaw : qYaw - pYaw;
    out[o + 2] = key ? qX : qX - pX;
    out[o + 3] = key ? qY : qY - pY;
    out[o + 4] = key ? qZ : qZ - pZ;
    out[o + 5] = s.input | 0;
    pPitch = qPitch; pYaw = qYaw; pX = qX; pY = qY; pZ = qZ;
  }
  return out;
}

/** Reverse packCamera into dequantized typed arrays for fast sampling. */
function unpackCamera(flat, totalTicks) {
  const pitch = new Float64Array(totalTicks);
  const yaw = new Float64Array(totalTicks);
  const px = new Float64Array(totalTicks);
  const py = new Float64Array(totalTicks);
  const pz = new Float64Array(totalTicks);
  const input = new Uint16Array(totalTicks);
  let qPitch = 0, qYaw = 0, qX = 0, qY = 0, qZ = 0;
  for (let i = 0; i < totalTicks; i++) {
    const o = i * 6;
    const key = i % TICK_RATE === 0;
    qPitch = key ? flat[o] : qPitch + flat[o];
    qYaw = key ? flat[o + 1] : qYaw + flat[o + 1];
    qX = key ? flat[o + 2] : qX + flat[o + 2];
    qY = key ? flat[o + 3] : qY + flat[o + 3];
    qZ = key ? flat[o + 4] : qZ + flat[o + 4];
    pitch[i] = qPitch / ANGLE_Q;
    yaw[i] = qYaw / ANGLE_Q;
    px[i] = qX / POS_Q;
    py[i] = qY / POS_Q;
    pz[i] = qZ / POS_Q;
    input[i] = flat[o + 5] & 0xffff;
  }
  return { pitch, yaw, px, py, pz, input };
}

// --- entity track (per-entity transform stream over its own lifetime) -------

/** Pack one entity's [x, y, z, scale] stream (keyframe every TICK_RATE locally). */
function packEntity(frames) {
  const out = new Array(frames.length * 4);
  let pX = 0, pY = 0, pZ = 0, pS = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const qX = Math.round(f.x * POS_Q);
    const qY = Math.round(f.y * POS_Q);
    const qZ = Math.round(f.z * POS_Q);
    const qS = Math.round(f.s * SCALE_Q);
    const key = i % TICK_RATE === 0;
    const o = i * 4;
    out[o] = key ? qX : qX - pX;
    out[o + 1] = key ? qY : qY - pY;
    out[o + 2] = key ? qZ : qZ - pZ;
    out[o + 3] = key ? qS : qS - pS;
    pX = qX; pY = qY; pZ = qZ; pS = qS;
  }
  return out;
}

function unpackEntity(flat, len) {
  const x = new Float64Array(len);
  const y = new Float64Array(len);
  const z = new Float64Array(len);
  const s = new Float64Array(len);
  let qX = 0, qY = 0, qZ = 0, qS = 0;
  for (let i = 0; i < len; i++) {
    const o = i * 4;
    const key = i % TICK_RATE === 0;
    qX = key ? flat[o] : qX + flat[o];
    qY = key ? flat[o + 1] : qY + flat[o + 1];
    qZ = key ? flat[o + 2] : qZ + flat[o + 2];
    qS = key ? flat[o + 3] : qS + flat[o + 3];
    x[i] = qX / POS_Q;
    y[i] = qY / POS_Q;
    z[i] = qZ / POS_Q;
    s[i] = qS / SCALE_Q;
  }
  return { x, y, z, s };
}

// --- public API -------------------------------------------------------------

/**
 * Serialize a raw in-memory recording (from ReplayRecorder) into a gzipped
 * Uint8Array ready for upload, plus a lightweight summary for the metadata row.
 *
 * @param {object} rec  recorder output (absolute, un-quantized samples)
 * @returns {Promise<{ bytes: Uint8Array, summary: object }>}
 */
export async function encodeReplay(rec) {
  const totalTicks = rec.cam.length;
  const container = {
    v: REPLAY_VERSION,
    tickRate: TICK_RATE,
    totalTicks,
    scenario: rec.scenario,
    configKey: rec.configKey,
    variant: rec.variant,
    config: rec.config || {},
    settings: rec.settings || {},
    weaponId: rec.weaponId,
    viewmodelRecoil: rec.viewmodelRecoil,
    showViewmodel: rec.showViewmodel,
    startedAt: rec.startedAt || new Date().toISOString(),
    durationSec: totalTicks / TICK_RATE,
    blueprints: rec.blueprints || {},
    environment: rec.environment || [],
    environmentSegments: rec.environmentSegments || (
      rec.environment?.length ? [{ start: 0, meshes: rec.environment }] : []
    ),
    cam: packCamera(rec.cam),
    entities: (rec.entities || []).map((e) => ({
      id: e.id,
      bp: e.bp,
      start: e.start,
      len: e.frames.length,
      // Aim point (head/centre) offset + radius at unit scale, for analytics.
      aim: e.aim || [0, 0, 0],
      aimR: e.aimR ?? 0,
      // Tracked-visual → root offset at unit scale (playback grounding).
      vis: e.vis || [0, 0, 0],
      data: packEntity(e.frames)
    })),
    // Shot/FX events are sparse — keep them as small flat tuples.
    events: rec.events || []
  };

  const json = JSON.stringify(container);
  const bytes = await gzipString(json);
  return {
    bytes,
    summary: {
      scenario: rec.scenario,
      configKey: rec.configKey,
      variant: rec.variant,
      durationSec: container.durationSec,
      totalTicks,
      bytes: bytes.length
    }
  };
}

/**
 * Inflate + unpack a stored replay into typed-array tracks with samplers.
 * @param {Uint8Array} bytes
 */
export async function decodeReplay(bytes) {
  const json = await gunzipToString(bytes);
  return buildReplayView(JSON.parse(json));
}

/**
 * Build a playable replay view (typed-array tracks + samplers) from an unpacked
 * container. Shared by `decodeReplay` (from storage) and `localDecode` (in-memory
 * playback of a run that just finished, no gzip round-trip).
 */
function buildReplayView(c) {
  const totalTicks = c.totalTicks ?? Math.floor((c.cam?.length || 0) / 6);
  const cam = unpackCamera(c.cam || [], totalTicks);
  const entities = (c.entities || []).map((e) => ({
    id: e.id,
    bp: e.bp,
    start: e.start,
    len: e.len,
    aim: e.aim || [0, 0, 0],
    aimR: e.aimR ?? 0,
    // Legacy replays (no vis) fall back to zero offset — same as before.
    vis: e.vis || [0, 0, 0],
    track: unpackEntity(e.data, e.len)
  }));

  return {
    version: c.v,
    tickRate: c.tickRate || TICK_RATE,
    totalTicks,
    durationSec: c.durationSec ?? totalTicks / (c.tickRate || TICK_RATE),
    scenario: c.scenario,
    configKey: c.configKey,
    variant: c.variant,
    config: c.config || {},
    settings: c.settings || {},
    weaponId: c.weaponId,
    viewmodelRecoil: c.viewmodelRecoil,
    showViewmodel: c.showViewmodel,
    blueprints: c.blueprints || {},
    environment: c.environment || [],
    environmentSegments: c.environmentSegments || (
      c.environment?.length ? [{ start: 0, meshes: c.environment }] : []
    ),
    events: c.events || [],
    cam,
    entities,
    /** Linear-interpolated camera at a fractional tick (smooth slow-mo). */
    sampleCamera(tickFloat) {
      return sampleTrackCamera(cam, totalTicks, tickFloat);
    },
    /** Interpolated entity transform at a global fractional tick, or null. */
    sampleEntity(ent, tickFloat) {
      const local = tickFloat - ent.start;
      if (local < 0 || local > ent.len - 1) return null;
      return sampleTrackEntity(ent.track, ent.len, local);
    },
    /**
     * World-space aim point (head for bots, centre for dots) + radius at a
     * global fractional tick, or null if the entity isn't live. Built from the
     * tracked visual position plus the constant unit-scale aim offset/radius.
     */
    sampleEntityAim(ent, tickFloat) {
      const s = this.sampleEntity(ent, tickFloat);
      if (!s) return null;
      const a = ent.aim || [0, 0, 0];
      // Fallback radius for legacy replays with no captured aim zone.
      const r = ent.aimR > 0 ? ent.aimR : 0.4;
      return {
        x: s.x + a[0] * s.s,
        y: s.y + a[1] * s.s,
        z: s.z + a[2] * s.s,
        radius: r * s.s
      };
    }
  };
}

/**
 * Turn a raw recorder output into a playable view WITHOUT gzip, for instant
 * playback of a just-finished run. Routes through the same pack/unpack path as
 * storage so quantization matches a downloaded replay exactly.
 */
export function localDecode(rec) {
  return buildReplayView({
    v: REPLAY_VERSION,
    tickRate: TICK_RATE,
    totalTicks: rec.cam.length,
    scenario: rec.scenario,
    configKey: rec.configKey,
    variant: rec.variant,
    config: rec.config || {},
    settings: rec.settings || {},
    weaponId: rec.weaponId,
    viewmodelRecoil: rec.viewmodelRecoil,
    showViewmodel: rec.showViewmodel,
    durationSec: rec.cam.length / TICK_RATE,
    blueprints: rec.blueprints || {},
    environment: rec.environment || [],
    environmentSegments: rec.environmentSegments || (
      rec.environment?.length ? [{ start: 0, meshes: rec.environment }] : []
    ),
    cam: packCamera(rec.cam),
    entities: (rec.entities || []).map((e) => ({
      id: e.id,
      bp: e.bp,
      start: e.start,
      len: e.frames.length,
      aim: e.aim || [0, 0, 0],
      aimR: e.aimR ?? 0,
      vis: e.vis || [0, 0, 0],
      data: packEntity(e.frames)
    })),
    events: rec.events || []
  });
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function sampleTrackCamera(cam, totalTicks, tickFloat) {
  const clamped = Math.max(0, Math.min(totalTicks - 1, tickFloat));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(totalTicks - 1, i0 + 1);
  const t = clamped - i0;
  // Yaw is unwrapped from raw mouse deltas (never wraps ±π), so plain lerp is safe.
  return {
    pitch: lerp(cam.pitch[i0], cam.pitch[i1], t),
    yaw: lerp(cam.yaw[i0], cam.yaw[i1], t),
    px: lerp(cam.px[i0], cam.px[i1], t),
    py: lerp(cam.py[i0], cam.py[i1], t),
    pz: lerp(cam.pz[i0], cam.pz[i1], t),
    input: cam.input[i0]
  };
}

function sampleTrackEntity(tr, len, localFloat) {
  const clamped = Math.max(0, Math.min(len - 1, localFloat));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(len - 1, i0 + 1);
  const t = clamped - i0;
  return {
    x: lerp(tr.x[i0], tr.x[i1], t),
    y: lerp(tr.y[i0], tr.y[i1], t),
    z: lerp(tr.z[i0], tr.z[i1], t),
    s: lerp(tr.s[i0], tr.s[i1], t)
  };
}

// --- input bitmask helpers (shared by recorder + player) --------------------

/** Build the per-tick movement bitmask from an InputManager. */
export function inputBitmask(input) {
  if (!input) return 0;
  const k = input.keys;
  let m = 0;
  if (k.has('KeyW')) m |= INPUT_BITS.W;
  if (k.has('KeyA')) m |= INPUT_BITS.A;
  if (k.has('KeyS')) m |= INPUT_BITS.S;
  if (k.has('KeyD')) m |= INPUT_BITS.D;
  if (input.jumpQueued) m |= INPUT_BITS.JUMP;
  if (input.crouchHeld) m |= INPUT_BITS.CROUCH;
  if (input.walkHeld) m |= INPUT_BITS.WALK;
  if (input.scopeLevel === 1) m |= INPUT_BITS.SCOPE1;
  else if (input.scopeLevel >= 2) m |= INPUT_BITS.SCOPE2;
  return m;
}

/** Decode a bitmask back to a flags object (used by the playback HUD). */
export function decodeInput(mask) {
  return {
    W: !!(mask & INPUT_BITS.W),
    A: !!(mask & INPUT_BITS.A),
    S: !!(mask & INPUT_BITS.S),
    D: !!(mask & INPUT_BITS.D),
    jump: !!(mask & INPUT_BITS.JUMP),
    crouch: !!(mask & INPUT_BITS.CROUCH),
    walk: !!(mask & INPUT_BITS.WALK),
    scope: mask & INPUT_BITS.SCOPE2 ? 2 : mask & INPUT_BITS.SCOPE1 ? 1 : 0
  };
}
