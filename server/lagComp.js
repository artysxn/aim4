// ---------------------------------------------------------------------------
// lagComp.js
// Per-player transform history + sampling for server-side lag compensation.
// ---------------------------------------------------------------------------

export const HISTORY_MS = 600;

export function pushTransformHistory(player, now = Date.now()) {
  if (!player.history) player.history = [];
  const tr = player.transform;
  const h = player.history;
  const last = h[h.length - 1];
  if (last && now - last.t < 4) {
    last.x = tr.x;
    last.y = tr.y;
    last.z = tr.z;
    last.crouch = tr.crouch || 0;
    last.t = now;
  } else {
    h.push({ t: now, x: tr.x, y: tr.y, z: tr.z, crouch: tr.crouch || 0 });
  }
  while (h.length > 1 && h[0].t < now - HISTORY_MS) h.shift();
}

export function sampleTransformAt(player, targetTime) {
  const h = player.history;
  const tr = player.transform;
  if (!h?.length) {
    return { x: tr.x, y: tr.y, z: tr.z, crouch: tr.crouch || 0 };
  }
  if (targetTime <= h[0].t) return h[0];
  if (targetTime >= h[h.length - 1].t) return h[h.length - 1];
  for (let i = 0; i < h.length - 1; i++) {
    const a = h[i];
    const b = h[i + 1];
    if (targetTime >= a.t && targetTime <= b.t) {
      const span = b.t - a.t || 1;
      const f = (targetTime - a.t) / span;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        crouch: a.crouch + (b.crouch - a.crouch) * f
      };
    }
  }
  return h[h.length - 1];
}

/** Rewind window from client RTT (ms). */
export function lagRewindMs(rttMs) {
  const rtt = Number.isFinite(rttMs) ? rttMs : 0;
  return Math.min(280, Math.max(80, rtt * 0.5 + 40));
}
