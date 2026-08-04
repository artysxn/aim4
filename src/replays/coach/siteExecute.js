// ---------------------------------------------------------------------------
// Site execute: T core holds mid/late at a bomb-site zone for HOLD_SECONDS,
// then coach the CT stack vs per-map default site defense numbers.
// ---------------------------------------------------------------------------

import { findCore } from './cores.js';
import { coachText } from './coachMessages.js';
import { phaseAtTick, phaseBounds } from './roundPhases.js';
import {
  bombSiteAtPoint,
  bombSiteNearPoint,
  hasBombSites
} from '../zones/bombSites.js';

/** Seconds the T core must sit at/near a site before we compare CT numbers. */
export const SITE_EXECUTE_HOLD_SECONDS = 3;

/**
 * Default CT bodies expected on each bombsite for a standard defense.
 * Keys are map codes; values are { a, b } headcounts.
 */
export const CT_SITE_DEFAULTS = {
  INF: { a: 2, b: 2 },
  CCH: { a: 2, b: 2 },
  DD2: { a: 2, b: 2 },
  MIR: { a: 2, b: 2 },
  NUK: { a: 3, b: 1 },
  ANC: { a: 1, b: 2 },
  ANU: { a: 2, b: 2 }
};

/**
 * @param {string} map
 * @param {'a' | 'b'} site
 * @returns {number | null}
 */
export function defaultCtOnSite(map, site) {
  const row = CT_SITE_DEFAULTS[String(map || '').toUpperCase()];
  if (!row) return null;
  const n = row[site];
  return Number.isFinite(n) ? n : null;
}

function siteLabel(site) {
  return site === 'a' ? 'A' : 'B';
}

/**
 * Walk the 1 Hz series and emit at most one under/over note per bombsite.
 *
 * @param {object} opts
 * @param {object} opts.meta
 * @param {object} opts.network
 * @param {Array} opts.series  samples with states + deadIds still attached
 * @param {(sample: object, side: string) => Array} opts.positionsOf
 * @param {(tick: number) => boolean} opts.inCoachWindow
 * @param {number | null} [opts.defusedTick]
 * @param {{ CT?: boolean }} [opts.gate]
 * @returns {Array<{ tick: number, playerId: string, rule: string, text: string }>}
 */
export function findSiteExecuteFlags({
  meta,
  network,
  series,
  positionsOf,
  inCoachWindow,
  defusedTick = null,
  gate = null
}) {
  if (!hasBombSites(network) || !series?.length) return [];
  if (gate && gate.CT === false) return [];

  const defaults = CT_SITE_DEFAULTS[String(meta?.map || '').toUpperCase()];
  if (!defaults) return [];

  const bounds = phaseBounds(meta);
  const fired = { a: false, b: false };
  const streak = { a: 0, b: 0 };
  /** @type {Array<{ tick: number, playerId: string, rule: string, text: string }>} */
  const out = [];

  for (const sample of series) {
    if (!inCoachWindow(sample.tick)) {
      streak.a = 0;
      streak.b = 0;
      continue;
    }
    if (defusedTick != null && sample.tick >= defusedTick) break;

    const phase = phaseAtTick(sample.tick, bounds);
    if (phase === 'early') {
      streak.a = 0;
      streak.b = 0;
      continue;
    }

    const tAlive = positionsOf(sample, 'T');
    const core = findCore(tAlive);
    if (!core.centroid || core.size < 2) {
      streak.a = 0;
      streak.b = 0;
      continue;
    }

    const site = bombSiteNearPoint(core.centroid.x, core.centroid.y, network);
    if (!site) {
      streak.a = 0;
      streak.b = 0;
      continue;
    }

    const other = site === 'a' ? 'b' : 'a';
    streak[other] = 0;
    streak[site] += 1;

    if (fired[site] || streak[site] < SITE_EXECUTE_HOLD_SECONDS) continue;

    const defaultN = defaults[site];
    if (!Number.isFinite(defaultN)) continue;

    const cts = positionsOf(sample, 'CT');
    let ctOnSite = 0;
    /** @type {string | null} */
    let ctOnSiteId = null;
    for (const p of cts) {
      if (bombSiteAtPoint(p.x, p.y, network) === site) {
        ctOnSite += 1;
        if (!ctOnSiteId) ctOnSiteId = p.id;
      }
    }

    // Pin to a CT so the note only appears when coaching CT.
    const teamSides = {
      1: meta.team1Side || 'T',
      2: meta.team2Side || 'CT'
    };
    const pin =
      ctOnSiteId ||
      cts[0]?.id ||
      (meta.players || []).find((p) => teamSides[p.team] === 'CT')?.id;
    if (!pin) continue;

    fired[site] = true;
    const sideName = siteLabel(site);

    if (ctOnSite > defaultN) {
      out.push({
        tick: sample.tick,
        playerId: pin,
        rule: `${site}-overstack`,
        text: coachText('overstack', sample.tick, {
          n: ctOnSite - defaultN,
          site: sideName
        })
      });
    } else {
      // Matches or below default → ask whether an earlier rotate was possible.
      out.push({
        tick: sample.tick,
        playerId: pin,
        rule: `${site}-understack`,
        text: coachText('understack', sample.tick, { n: ctOnSite, site: sideName })
      });
    }
  }

  return out;
}
