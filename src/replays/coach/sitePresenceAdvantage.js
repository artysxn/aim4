// ---------------------------------------------------------------------------
// Bombsite presence → win-chance term (pre-plant only).
//
// When a T core is at/near A or B, count living players inside that site rect
// and shift CT win% from even by the stack differential.
// ---------------------------------------------------------------------------

import { findCore } from './cores.js';
import {
  bombSiteAtPoint,
  bombSiteNearPoint,
  hasBombSites
} from '../zones/bombSites.js';

/**
 * CT win-pp from even for CT−T headcount gap on the contested site.
 *   ≥1 CT more → +25
 *   equal       → +10
 *   1 T more    → −5  (+5 T)
 *   ≥2 T more   → −15 (+15 T)
 */
export function sitePresencePpFromDiff(ctOnSite, tOnSite) {
  const ct = Math.max(0, ctOnSite | 0);
  const t = Math.max(0, tOnSite | 0);
  const diff = ct - t;
  if (diff >= 1) return 25;
  if (diff === 0) return 10;
  if (diff === -1) return -5;
  return -15;
}

/**
 * @param {object} opts
 * @param {object | null | undefined} opts.network
 * @param {Array<{id?: string, x: number, y: number, z?: number}>} opts.tAlive
 * @param {Array<{id?: string, x: number, y: number, z?: number}>} opts.ctAlive
 * @param {boolean} [opts.planted]
 * @returns {{
 *   pp: number,
 *   site: 'a' | 'b',
 *   ct: number,
 *   t: number,
 *   diff: number
 * } | null}
 */
export function sitePresenceAdvantage({ network, tAlive, ctAlive, planted = false }) {
  if (planted) return null;
  if (!hasBombSites(network)) return null;

  const core = findCore(tAlive || []);
  if (!core.centroid || core.size < 2) return null;

  const site = bombSiteNearPoint(core.centroid.x, core.centroid.y, network);
  if (!site) return null;

  let ct = 0;
  let t = 0;
  for (const p of ctAlive || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (bombSiteAtPoint(p.x, p.y, network) === site) ct += 1;
  }
  for (const p of tAlive || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (bombSiteAtPoint(p.x, p.y, network) === site) t += 1;
  }
  // Nobody actually on the pad yet — approaching core alone does not sway %.
  if (ct === 0 && t === 0) return null;

  const diff = ct - t;
  const pp = sitePresencePpFromDiff(ct, t);
  return { pp, site, ct, t, diff };
}

/**
 * Living player positions by side from a tick sample (scratch-safe).
 *
 * @param {object} opts
 * @param {Array} opts.players
 * @param {Array} opts.states
 * @param {Set<string>} [opts.deadIds]
 * @param {{1?: string, 2?: string}} opts.teamSides
 * @returns {{ CT: Array, T: Array }}
 */
export function alivePositionsBySide({ players, states, deadIds, teamSides }) {
  const out = { CT: [], T: [] };
  for (const p of players || []) {
    const side = teamSides?.[p.team];
    if (side !== 'CT' && side !== 'T') continue;
    if (deadIds?.has(p.id)) continue;
    const st = states?.[p.slot];
    if (!st?.alive) continue;
    if (!Number.isFinite(st.x) || !Number.isFinite(st.y)) continue;
    out[side].push({ id: p.id, x: st.x, y: st.y, z: st.z });
  }
  return out;
}
