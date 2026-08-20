// ---------------------------------------------------------------------------
// src/cs3d/practiceCam.js
// T / CT / Spectate for the map explorer. Spectate follows the selected
// player's eyes (demo POV or a practice dummy). X drops back to freecam.
// ---------------------------------------------------------------------------

export const CAM_MODES = ['T', 'CT', 'spectate'];

export function nextCamMode(mode) {
  const i = CAM_MODES.indexOf(mode);
  return CAM_MODES[(i < 0 ? 0 : i + 1) % CAM_MODES.length];
}

export function spectateCaption(name) {
  return `spectating (${name || 'Bot'})`;
}

/**
 * Click cycle, same wrap as view3d cyclePov: +1 left click, -1 right click,
 * skip dead, wrap. `ids` is the live list in display order.
 */
export function cycleLive(ids, current, dir = 1) {
  if (!ids.length) return current;
  if (!ids.includes(current)) return ids[0];
  const i = ids.indexOf(current);
  return ids[(i + dir + ids.length) % ids.length];
}

export function spectateTargetId(kind, id) {
  return kind === 'bot' ? `bot:${id}` : `demo:${id}`;
}

export function parseSpectateTarget(key) {
  const m = /^(demo|bot):(.+)$/.exec(String(key || ''));
  if (!m) return null;
  const id = m[1] === 'bot' ? Number(m[2]) : Number(m[2]);
  if (!Number.isFinite(id)) return null;
  return { kind: m[1], id };
}
