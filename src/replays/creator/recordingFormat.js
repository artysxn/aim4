// ---------------------------------------------------------------------------
// replays/creator/recordingFormat.js
// The synthetic 2D round file: what the Strategy Creator writes and what the
// player reads back.
//
// Size is a feature here. A real parsed demo is 1-2 MB for a whole match, so a
// single hand-built round has no business being bigger than a fraction of that.
// Three things keep a ten-body round around 60 KB:
//
//   1. Samples are evenly spaced, so time is not stored at all - a sample's
//      index IS its timestamp (t0 + i / SAMPLE_HZ).
//   2. x, y and yaw are written as separate columns rather than interleaved, so
//      each stream is one quantity moving smoothly.
//   3. Each column is zigzag varint deltas, exactly like the .tickz blocks in
//      shared/tickPacked.js: a body moving 13 units between samples costs one
//      byte, and a body standing still costs one byte per sample.
//
// `framesFor()` turns a round back into the frame shape RadarRenderer already
// draws for real demos, which is what makes a synthetic round look identical to
// a parsed one: there is no second renderer to keep in sync.
// ---------------------------------------------------------------------------

/**
 * Samples per second. Playback interpolates between them, so this is fidelity
 * rather than frame rate: a body moves at most ~14 units between samples, well
 * inside the width of a droplet.
 */
export const SAMPLE_HZ = 16;
export const SAMPLE_MS = 1000 / SAMPLE_HZ;

/** The tick rate a synthetic round reports to the renderer. */
export const SYNTHETIC_TICKRATE = 64;

/** Round length, matching the live clock the phase model assumes. */
export const ROUND_SECONDS = 115;

/** Movement cap for a recorded body, in world units per second. */
export const MOVE_SPEED_UNITS = 220;

/** How fast a thrown grenade travels to its detonation point, units/second. */
export const NADE_SPEED_UNITS = 300;

/** Grenade slots, in the order the number keys select them. */
export const NADE_SLOTS = [
  { key: '1', type: 'flashbang', label: 'Flash' },
  { key: '2', type: 'smokegrenade', label: 'Smoke' },
  { key: '3', type: 'molotov', label: 'Molotov' },
  { key: '4', type: 'hegrenade', label: 'HE' }
];

export const NADE_TYPES = NADE_SLOTS.map((s) => s.type);

/** Ceilings that keep one round inside its size budget. */
export const MAX_SAMPLES_PER_TRACK = SAMPLE_HZ * (ROUND_SECONDS + 15);
export const MAX_TRACKS = 12;
export const MAX_NADES_PER_TRACK = 20;
export const MAX_SHOTS_PER_TRACK = 200;

const clampNum = (v, lo, hi, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

const int = (v) => Math.round(Number(v) || 0);

/** Wrap a yaw into (-180, 180]. */
export function normalizeYaw(deg) {
  let d = Number(deg) || 0;
  d = (((d + 180) % 360) + 360) % 360 - 180;
  return d;
}

// ---------------------------------------------------------------------------
// Column codec: zigzag varint deltas, one column at a time
// ---------------------------------------------------------------------------

function writeVarint(bytes, value) {
  let z = ((value << 1) ^ (value >> 31)) >>> 0;
  while (z >= 0x80) {
    bytes.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  bytes.push(z);
}

function readVarints(bytes, at, count, out) {
  let p = at;
  let prev = 0;
  for (let i = 0; i < count; i++) {
    let z = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[p++];
      if (b === undefined) throw new Error('Truncated sample stream.');
      z |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    z >>>= 0;
    prev += (z >>> 1) ^ -(z & 1);
    out[i] = prev;
  }
  return p;
}

const B64 =
  typeof btoa === 'function'
    ? {
        to: (bytes) => {
          let s = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return btoa(s);
        },
        from: (text) => {
          const raw = atob(text);
          const out = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
          return out;
        }
      }
    : {
        to: (bytes) => Buffer.from(bytes).toString('base64'),
        from: (text) => new Uint8Array(Buffer.from(text, 'base64'))
      };

/**
 * Pack a track's samples into the wire form. Yaw is stored in whole degrees:
 * a droplet's facing is drawn as a 12 pixel line, so a degree is already finer
 * than the screen can show.
 */
export function encodeSamples(samples) {
  const n = Math.floor(samples.length / 3);
  const bytes = [];
  for (let col = 0; col < 3; col++) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i * 3 + col];
      writeVarint(bytes, v - prev);
      prev = v;
    }
  }
  return { n, p: B64.to(new Uint8Array(bytes)) };
}

export function decodeSamples(n, packed) {
  const count = Math.max(0, Math.min(MAX_SAMPLES_PER_TRACK, Number(n) || 0));
  if (!count || !packed) return [];
  const bytes = B64.from(String(packed));
  const out = new Array(count * 3);
  const col = new Array(count);
  let p = 0;
  for (let c = 0; c < 3; c++) {
    p = readVarints(bytes, p, count, col);
    for (let i = 0; i < count; i++) out[i * 3 + c] = col[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Round + track shapes (in memory: plain arrays, decoded)
// ---------------------------------------------------------------------------

/** A blank round for a map and side. */
export function emptyRound({ map = '', side = 'T', name = '' } = {}) {
  return {
    v: 2,
    map,
    side: side === 'CT' ? 'CT' : 'T',
    name,
    strategyId: '',
    sampleHz: SAMPLE_HZ,
    /** Live seconds after freeze end where the round begins. */
    startSeconds: 0,
    /** @type {Array<{id: string, side: 'T'|'CT', x: number, y: number, z: number}>} */
    spawns: [],
    /** Grenades already thrown when the round starts. */
    preNades: [],
    /** @type {Array<object>} */
    tracks: [],
    updatedAt: Date.now()
  };
}

/**
 * One recorded body. `samples` is a flat [x, y, yaw] triple list; sample i sits
 * at t0 + i * SAMPLE_MS, which is why no time column is stored.
 *
 * @param {{id: string, side: 'T'|'CT', name?: string, spawnId?: string, t0?: number}} seed
 */
export function emptyTrack(seed) {
  return {
    id: seed.id,
    side: seed.side === 'CT' ? 'CT' : 'T',
    name: seed.name || seed.id,
    spawnId: seed.spawnId || '',
    t0: int(seed.t0),
    samples: [],
    /** @type {Array<{t: number, yaw: number, x: number, y: number}>} */
    shots: [],
    /** @type {Array<object>} */
    nades: []
  };
}

/** Append one sample. Time comes from the index, so it is not passed. */
export function pushSample(track, x, y, yaw) {
  if (track.samples.length >= MAX_SAMPLES_PER_TRACK * 3) return false;
  track.samples.push(int(x), int(y), int(normalizeYaw(yaw)));
  return true;
}

export const sampleCount = (track) => Math.floor((track?.samples?.length || 0) / 3);

export const trackEndMs = (track) => {
  const n = sampleCount(track);
  return n ? (track.t0 || 0) + (n - 1) * SAMPLE_MS : track.t0 || 0;
};

/**
 * Interpolated position and facing at time `t` (ms from round start), or null
 * before the body's first sample.
 */
export function sampleAt(track, t, out = {}) {
  const n = sampleCount(track);
  if (!n) return null;
  const s = track.samples;
  const local = (t - (track.t0 || 0)) / SAMPLE_MS;
  if (local <= 0) {
    out.x = s[0];
    out.y = s[1];
    out.yaw = s[2];
    return out;
  }
  if (local >= n - 1) {
    const base = (n - 1) * 3;
    out.x = s[base];
    out.y = s[base + 1];
    out.yaw = s[base + 2];
    return out;
  }
  const i = Math.floor(local);
  const f = local - i;
  const a = i * 3;
  const b = a + 3;
  out.x = s[a] + (s[b] - s[a]) * f;
  out.y = s[a + 1] + (s[b + 1] - s[a + 1]) * f;
  // Shortest way round, so spinning past 180 does not whip the marker.
  const d = normalizeYaw(s[b + 2] - s[a + 2]);
  out.yaw = normalizeYaw(s[a + 2] + d * f);
  return out;
}

/** Total round length in ms: the last sample or detonation, whichever is later. */
export function durationMs(round) {
  let end = 0;
  for (const track of round?.tracks || []) {
    end = Math.max(end, trackEndMs(track));
    for (const g of track.nades || []) end = Math.max(end, g.detonateT || g.t || 0);
  }
  for (const g of round?.preNades || []) end = Math.max(end, g.detonateT || 0);
  return end;
}

/**
 * A grenade throw, resolved from the click that made it: it leaves `from`,
 * travels at NADE_SPEED_UNITS and detonates exactly where the cursor was.
 */
export function makeNade({ type, t, from, to }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const travelMs = (Math.hypot(dx, dy) / NADE_SPEED_UNITS) * 1000;
  return {
    type,
    t: int(t),
    from: { x: int(from.x), y: int(from.y) },
    to: { x: int(to.x), y: int(to.y) },
    detonateT: int(t + travelMs)
  };
}

// ---------------------------------------------------------------------------
// Wire form
// ---------------------------------------------------------------------------

const packNade = (g) => ({
  type: g.type,
  t: int(g.t),
  f: [int(g.from.x), int(g.from.y)],
  d: [int(g.to.x), int(g.to.y)],
  dt: int(g.detonateT ?? g.t),
  ...(g.player ? { player: g.player } : {})
});

const unpackNade = (g) => {
  if (!g || !NADE_TYPES.includes(g.type)) return null;
  const from = Array.isArray(g.f) ? g.f : [g.from?.x, g.from?.y];
  const to = Array.isArray(g.d) ? g.d : [g.to?.x, g.to?.y];
  if (![from[0], from[1], to[0], to[1]].every((n) => Number.isFinite(Number(n)))) return null;
  const out = {
    type: g.type,
    t: clampNum(g.t, 0, 1000 * 60 * 20),
    from: { x: int(from[0]), y: int(from[1]) },
    to: { x: int(to[0]), y: int(to[1]) },
    detonateT: clampNum(g.dt ?? g.detonateT ?? g.t, 0, 1000 * 60 * 20)
  };
  if (g.player) out.player = String(g.player).slice(0, 40);
  return out;
};

/** In-memory round -> the compact object that gets stored and sent. */
export function encodeRound(round) {
  return {
    v: 2,
    map: round.map,
    side: round.side,
    name: round.name || '',
    strategyId: round.strategyId || '',
    sampleHz: SAMPLE_HZ,
    startSeconds: int(round.startSeconds),
    spawns: (round.spawns || []).map((s) => ({
      id: s.id,
      side: s.side,
      p: [int(s.x), int(s.y), int(s.z)]
    })),
    preNades: (round.preNades || []).map(packNade),
    tracks: (round.tracks || []).map((t) => {
      const { n, p } = encodeSamples(t.samples || []);
      return {
        id: t.id,
        side: t.side,
        name: t.name || '',
        spawnId: t.spawnId || '',
        t0: int(t.t0),
        n,
        p,
        shots: (t.shots || []).map((s) => [int(s.t), int(s.yaw), int(s.x), int(s.y)]),
        nades: (t.nades || []).map(packNade)
      };
    }),
    updatedAt: Date.now()
  };
}

/** The inverse. Tolerates the v1 shape so early saves keep opening. */
export function decodeRound(raw) {
  const round = emptyRound({
    map: String(raw?.map || '').toUpperCase().slice(0, 4),
    side: raw?.side === 'CT' ? 'CT' : 'T',
    name: String(raw?.name || '').slice(0, 120)
  });
  round.strategyId = String(raw?.strategyId || '').slice(0, 40);
  round.startSeconds = clampNum(raw?.startSeconds, 0, ROUND_SECONDS);

  round.spawns = (Array.isArray(raw?.spawns) ? raw.spawns : [])
    .slice(0, 64)
    .map((s) => {
      const p = Array.isArray(s?.p) ? s.p : [s?.x, s?.y, s?.z];
      if (!Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))) return null;
      return {
        id: String(s.id || '').slice(0, 32) || `sp_${int(p[0])}_${int(p[1])}`,
        side: s.side === 'CT' ? 'CT' : 'T',
        x: int(p[0]),
        y: int(p[1]),
        z: int(p[2])
      };
    })
    .filter(Boolean);

  round.preNades = (Array.isArray(raw?.preNades) ? raw.preNades : [])
    .slice(0, 40)
    .map(unpackNade)
    .filter(Boolean);

  round.tracks = (Array.isArray(raw?.tracks) ? raw.tracks : [])
    .slice(0, MAX_TRACKS)
    .map((t) => {
      let samples = [];
      try {
        samples = t?.p ? decodeSamples(t.n, t.p) : [];
      } catch {
        samples = [];
      }
      // v1 stored [t, x, y, yaw] quadruples inline; drop the time column.
      if (!samples.length && Array.isArray(t?.samples) && t.samples.length) {
        for (let i = 0; i + 3 < t.samples.length; i += 4) {
          samples.push(int(t.samples[i + 1]), int(t.samples[i + 2]), int(t.samples[i + 3]));
        }
      }
      return {
        id: String(t?.id || '').slice(0, 40) || `tr_${samples.length}`,
        side: t?.side === 'CT' ? 'CT' : 'T',
        name: String(t?.name || '').slice(0, 60),
        spawnId: String(t?.spawnId || '').slice(0, 32),
        t0: clampNum(t?.t0, 0, 1000 * 60 * 20),
        samples,
        shots: (Array.isArray(t?.shots) ? t.shots : [])
          .slice(0, MAX_SHOTS_PER_TRACK)
          .map((s) =>
            Array.isArray(s)
              ? { t: int(s[0]), yaw: normalizeYaw(s[1]), x: int(s[2]), y: int(s[3]) }
              : { t: int(s?.t), yaw: normalizeYaw(s?.yaw), x: int(s?.x), y: int(s?.y) }
          ),
        nades: (Array.isArray(t?.nades) ? t.nades : [])
          .slice(0, MAX_NADES_PER_TRACK)
          .map(unpackNade)
          .filter(Boolean)
      };
    });

  round.updatedAt = Number(raw?.updatedAt) || Date.now();
  return round;
}

/**
 * Decode then re-encode, which is how the server validates a round without
 * trusting any field on the way in: anything that does not survive the round
 * trip is not stored.
 */
export function sanitizeEncodedRound(raw) {
  return encodeRound(decodeRound(raw));
}

// ---------------------------------------------------------------------------
// Playback: synthetic round -> renderer frames
// ---------------------------------------------------------------------------

const msToTick = (ms) => Math.round((ms / 1000) * SYNTHETIC_TICKRATE);

/** The roster the renderer expects, slots handed out in track order. */
export function rosterFor(round) {
  return (round?.tracks || []).slice(0, 10).map((track, slot) => ({
    id: track.id,
    slot,
    name: track.name || `Player ${slot + 1}`,
    team: track.side === 'CT' ? 2 : 1,
    side: track.side
  }));
}

/**
 * Build the exact frame object RadarRenderer.render() takes, for time `t` (ms).
 *
 * @param {object} round
 * @param {number} t
 * @param {{highlight?: string, compact?: boolean, live?: object, extra?: object}} [opts]
 *   `live` is the body currently being recorded, drawn alongside the rest.
 */
export function frameFor(round, t, opts = {}) {
  const tracks = (round?.tracks || []).slice(0, 10);
  const all = opts.live ? [...tracks, opts.live] : tracks;
  const players = all.slice(0, 10).map((track, slot) => ({
    id: track.id,
    slot,
    name: track.name || `Player ${slot + 1}`,
    team: track.side === 'CT' ? 2 : 1,
    side: track.side
  }));

  const states = [];
  const scratch = {};
  players.forEach((p, slot) => {
    const track = all[slot];
    const live = opts.live && track === opts.live;
    const s = live
      ? { x: opts.live.liveX, y: opts.live.liveY, yaw: opts.live.liveYaw }
      : sampleAt(track, t, scratch);
    states[slot] =
      s && Number.isFinite(s.x)
        ? {
            x: s.x,
            y: s.y,
            z: 0,
            yaw: s.yaw,
            health: 100,
            alive: true,
            side: track.side,
            flags: 0,
            weapon: ''
          }
        : { x: 0, y: 0, z: 0, yaw: 0, health: 0, alive: false, side: track.side, flags: 0 };
  });

  const grenades = [];
  const addNade = (g, playerId) => {
    const throwTick = msToTick(g.t);
    const detTick = msToTick(g.detonateT ?? g.t);
    grenades.push({
      player: playerId,
      type: g.type,
      throwTick,
      detonateTick: detTick,
      from: g.from,
      at: g.to,
      // Two points is all a straight synthetic throw needs; the renderer draws
      // the same fading trajectory it draws for a parsed one.
      path: [
        { tick: throwTick, x: g.from.x, y: g.from.y, z: 0 },
        { tick: detTick, x: g.to.x, y: g.to.y, z: 0 }
      ]
    });
  };
  for (const track of all) {
    for (const g of track.nades || []) addNade(g, track.id);
  }
  for (const g of round?.preNades || []) addNade(g, g.player || '');

  const tick = msToTick(t);
  const shots = [];
  for (const track of all) {
    for (const s of track.shots || []) {
      const st = msToTick(s.t);
      if (tick < st || tick - st > 6) continue;
      shots.push({ player: track.id, tick: st, yaw: s.yaw, x: s.x, y: s.y });
    }
  }

  return {
    players,
    states,
    tick,
    tickRate: SYNTHETIC_TICKRATE,
    teamSides: { 1: 'T', 2: 'CT' },
    events: { grenades, kills: [], shots, bomb: [] },
    highlight: opts.highlight || '',
    compact: Boolean(opts.compact),
    hideBomb: true,
    ...opts.extra
  };
}

/** Headline numbers for the list and the summary panel. */
export function roundSummary(round) {
  const counts = Object.fromEntries(NADE_TYPES.map((t) => [t, 0]));
  let shots = 0;
  for (const track of round?.tracks || []) {
    for (const g of track.nades || []) if (counts[g.type] !== undefined) counts[g.type]++;
    shots += (track.shots || []).length;
  }
  for (const g of round?.preNades || []) if (counts[g.type] !== undefined) counts[g.type]++;
  const tracks = round?.tracks || [];
  return {
    tracks: tracks.length,
    tSide: tracks.filter((t) => t.side === 'T').length,
    ctSide: tracks.filter((t) => t.side === 'CT').length,
    nades: counts,
    nadeTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    shots,
    durationMs: durationMs(round)
  };
}
