// ---------------------------------------------------------------------------
// replays/eye/mapRegions.js
// The places a user draws on a map overview and attaches to a message to aim4
// eye: "Ts smoke here(1) and here(2)".
//
// A region is kept in world units, never canvas pixels, so it means the same at
// any canvas size and is tested against grenade landings and player positions
// as they come. The model only ever sees its number: the points stay here (and
// in the message's `ui`, saved with the chat), and the where language in
// roundQuery.js takes "region": 1 where it takes "zone".
//
//   { id: 1, map: 'MIR', floor: 'lower'|undefined, shape: 'rect'|'lasso',
//     points: [[x, y], ...], rule: { who: 'T'|'CT'|'', what: 'smoke'|...|'' },
//     match: 'all'|'any', place: 'Top Mid, Window' }
//
// DOM-free.
// ---------------------------------------------------------------------------

import { calibrationFor } from '../viewer/mapCalibration.js';
import { MAPS } from '../shared/roundId.js';

/** Regions one message can carry. */
export const REGION_MAX = 12;
/** Points a lasso is kept to: every point of every region is a test per grenade. */
const LASSO_POINTS = 40;
const WHAT_WORDS = { smoke: 'smoke', molotov: 'molotov', flash: 'flash', he: 'HE', utility: 'any utility', players: 'players standing', kills: 'kills' };

/** Even-odd: a lasso that crosses itself still has an inside. */
export function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is a world point inside a region? A floor is checked only when the point has a height. */
export function inRegion(region, x, y, z = null) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !region?.points?.length) return false;
  if (region.floor && Number.isFinite(z)) {
    const line = calibrationFor(region.map).lowerZ;
    if (line !== undefined && (z < line) !== (region.floor === 'lower')) return false;
  }
  return pointInPolygon(x, y, region.points);
}

const distanceToLine = ([x, y], [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  return len ? Math.abs(dy * (x - ax) - dx * (y - ay)) / len : Math.hypot(x - ax, y - ay);
};

/** Douglas-Peucker on an open path. */
function simplified(points, tolerance) {
  if (points.length < 3) return points;
  let far = 0;
  let at = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToLine(points[i], points[0], points.at(-1));
    if (d > far) [far, at] = [d, i];
  }
  if (far <= tolerance) return [points[0], points.at(-1)];
  return [...simplified(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplified(points.slice(at), tolerance)];
}

/** A freehand path to the few whole-unit points that keep its shape, at most LASSO_POINTS. */
export function simplifyLasso(points, tolerance = 12) {
  let out = simplified(points, tolerance);
  for (let t = tolerance; out.length > LASSO_POINTS; t *= 1.5) out = simplified(points, t);
  return out.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

/** The callouts a region mostly covers, read off a grid over its box. */
export function placesIn(region, namesAt, most = 3) {
  const xs = region.points.map((p) => p[0]);
  const ys = region.points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const GRID = 14;
  const hits = new Map();
  let inside = 0;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = x0 + ((i + 0.5) * (x1 - x0)) / GRID;
      const y = y0 + ((j + 0.5) * (y1 - y0)) / GRID;
      if (!pointInPolygon(x, y, region.points)) continue;
      inside++;
      for (const name of namesAt(x, y).slice(0, 1)) hits.set(name, (hits.get(name) || 0) + 1);
    }
  }
  return [...hits]
    .filter(([, n]) => n >= Math.max(1, inside * 0.08))
    .sort((a, b) => b[1] - a[1])
    .slice(0, most)
    .map(([name]) => name)
    .join(', ');
}

/** "T smoke", "kills", "": what a region's rule asks, in words. */
export function ruleWords(rule) {
  return [rule?.who || '', WHAT_WORDS[rule?.what] || ''].filter(Boolean).join(' ');
}

/** A region's rule as a condition of the where language, or null when it has no "what". */
export function ruleCondition(region) {
  const { who = '', what = '' } = region.rule || {};
  const w = who ? { who } : {};
  if (['smoke', 'molotov', 'flash', 'he'].includes(what)) return { utility: { region: region.id, type: what, ...w } };
  if (what === 'utility') return { utility: { region: region.id, type: 'any', ...w } };
  if (what === 'players') return { players_in: { region: region.id, ...w } };
  if (what === 'kills') return { kill: { region: region.id, ...(who ? { by: who } : {}) } };
  return null;
}

/** The rules of a set of regions as a where list: all of them, or any one. */
export function regionWhere(regions) {
  const conds = regions.map(ruleCondition).filter(Boolean);
  if (conds.length < 2 || regions[0]?.match !== 'any') return conds;
  return [{ any: conds }];
}

/**
 * The lines of a message that carry regions. The model gets numbers and words, and the condition to
 * copy when the user set rules: it could do nothing with a polygon but pay for it on every step.
 */
export function regionLines(regions) {
  const lines = [];
  for (const map of [...new Set(regions.map((r) => r.map))]) {
    const here = regions.filter((r) => r.map === map);
    const name = MAPS[map]?.name || map;
    lines.push(`- Regions the user drew on ${name} (their "here(1)" is region 1). In a where of scout_rounds or query_rounds "region":1 goes where "zone" goes, with who "T" or "CT": {"utility":{"region":${here[0].id},"who":"T","type":"smoke"}}.`);
    for (const r of here) {
      const about = [r.place && `around ${r.place}`, r.floor && `${r.floor} floor`, ruleWords(r.rule) && `rule: ${ruleWords(r.rule)}`].filter(Boolean).join(', ');
      lines.push(`  Region ${r.id}${about ? `: ${about}` : ''}`);
    }
    const where = regionWhere(here);
    if (where.length) lines.push(`  The rules as where: ${JSON.stringify(where)}`);
  }
  return lines;
}

/** The numbers a message refers to: "here(1)", "here (2)". */
export function regionRefs(text) {
  return [...new Set([...String(text || '').matchAll(/\bhere\s*\((\d+)\)/gi)].map((m) => Number(m[1])))];
}

/** The next free number, given every region a chat has or is about to have. */
export function nextRegionId(regions) {
  return regions.reduce((most, r) => Math.max(most, r.id), 0) + 1;
}

// ---- the regions of this conversation -----------------------------------------

let known = [];

/** The regions the tools can be asked about: every one sent in this chat. */
export const chatRegions = () => known;
/** A message with regions went out. */
export function noteRegions(regions) {
  for (const r of regions || []) if (!known.some((k) => k.id === r.id)) known = [...known, r];
}
/** A new chat, or a saved one back (its messages' `ui.regions`). */
export function resetRegions(regions = []) {
  known = [];
  noteRegions(regions);
}
