// ---------------------------------------------------------------------------
// Per-map starting map-control baselines (area % at round clock 01:46).
// Generated / refreshed by: node scripts/sample-map-control-bases.mjs
// Values are raw CT/T area shares (neutral ignored for the relative bias).
// ---------------------------------------------------------------------------

/**
 * @typedef {{ ct: number, t: number, samples: number }} MapControlBase
 */

/**
 * Average soft+active possession at 01:46 across sampled rounds.
 * Missing maps → map-control win term stays off until sampled.
 *
 * @type {Record<string, MapControlBase>}
 */
export const MAP_CONTROL_BASE = {
  // Seed from multi-round Inferno observation until a full library sample runs.
  INF: { ct: 33.6, t: 28.0, samples: 3 }
};
