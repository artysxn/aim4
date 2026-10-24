// ---------------------------------------------------------------------------
// replays/eye/eyeValue.js
// The value tools' side of the page: load a round and its map, price it once
// (roundValue.js), keep the result for the rest of the conversation, and
// answer questions about it.
// ---------------------------------------------------------------------------

import { loadMapContext } from '../analytics/antistratScan.js';
import { MAPS } from '../shared/roundId.js';
import { RadarRenderer } from '../viewer/radarRenderer.js';
import { prepareControlField } from '../zones/zoneOverlay.js';
import { parseClock } from './eyeImages.js';
import { loadRound } from './eyeRound.js';
import { repairedNote, resolveRound, seenRounds } from './roundRefs.js';
import { momentAtTick, momentReport, roundValueReport, valueRound } from './roundValue.js';

const CACHE_SIZE = 4;

/** @type {Map<string, Promise<{ network: object|null, utilDb: object|null }>>} */
const maps = new Map();

/** The map's zone network, baked for sight lines, and its utility archive. Once per map. */
function mapFor(code) {
  if (!maps.has(code)) {
    maps.set(
      code,
      (async () => {
        const { network, utilDb } = await loadMapContext(code);
        if (network) {
          const renderer = new RadarRenderer(document.createElement('canvas'));
          await renderer.setMap(code);
          prepareControlField(network, code, renderer.image);
        }
        return { network, utilDb };
      })().catch(() => ({ network: null, utilDb: null }))
    );
  }
  return maps.get(code);
}

/** @type {Map<string, Promise<object>>} */
const valued = new Map();

/** A round, priced. Kept for the next questions about it. */
async function valueFor(file) {
  if (valued.has(file)) {
    const hit = valued.get(file);
    valued.delete(file);
    valued.set(file, hit);
    return hit;
  }
  const job = (async () => {
    const { meta, track } = await loadRound(file);
    const { network, utilDb } = await mapFor(meta.map);
    const value = valueRound({ meta, track, network, coachSmokes: utilDb });
    if (!value) throw new Error('That round could not be priced (no movement data).');
    return value;
  })();
  valued.set(file, job);
  job.catch(() => valued.delete(file));
  while (valued.size > CACHE_SIZE) valued.delete(valued.keys().next().value);
  return job;
}

const mapName = (value) => MAPS[value.meta.map]?.name || value.meta.mapName || value.meta.map;

/**
 * What every moment of a round was worth.
 * @param {{ round: string, moments?: number }} args
 */
export async function roundValueTool(args) {
  const { file, repaired } = roundOf(args);
  const value = await valueFor(file);
  const out = roundValueReport(value, args.moments);
  return { file, out: repaired ? { round_used: repairedNote(file), ...out } : out, display: `Priced round ${value.meta.round} on ${mapName(value)}` };
}

/** The round a call names, repaired against the ids this conversation has seen when it is not exact. */
function roundOf(args) {
  const given = String(args.round || '').trim();
  if (!given) throw new Error('Give the round file from find_rounds.');
  const hit = resolveRound(given, seenRounds());
  return hit ? { file: hit.round, repaired: hit.repaired } : { file: given, repaired: false };
}

/**
 * One moment of a round: win chance, what makes it up, open fights, xK.
 * @param {{ round: string, clock: string }} args
 */
export async function momentValueTool(args) {
  const { file, repaired } = roundOf(args);
  const left = parseClock(args.clock ?? '1:55');
  if (left == null) throw new Error(`"${args.clock}" is not a clock time. Use a round clock such as 1:20.`);
  const value = await valueFor(file);
  const out = momentReport(value, left);
  return { file, out: repaired ? { round_used: repairedNote(file), ...out } : out, display: `Priced round ${value.meta.round} on ${mapName(value)} at ${out.clock}` };
}

/**
 * The same moment as plain lines, for a screenshot to carry: win chance and the
 * fights open in it. Empty when the round cannot be priced.
 */
export async function momentLines(file, tick) {
  try {
    const value = await valueFor(file);
    const m = momentAtTick(value, tick);
    const lines = [`Round win chance here: CT ${m.ct_win_pct}%, T ${m.t_win_pct}%.`];
    if (m.what_makes_it_up.length) lines.push(`What separates the sides: ${m.what_makes_it_up.join('; ')}.`);
    if (m.open_fights.length) {
      lines.push('Open gunfights (win chance of each in this moment):');
      for (const f of m.open_fights) lines.push(`  ${f.a} ${f.a_win_pct}% vs ${f.b} ${f.b_win_pct}%`);
      if (m.xk.length) lines.push(`xK now: ${m.xk.map((x) => `${x.player} ${x.xk}`).join(', ')}.`);
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * The autocoach's flags for a round, with their cost and the second of the
 * round each came at: what play_review falls back on when there are too few
 * similar rounds to measure a play. Empty when the round cannot be priced.
 */
export async function coachFlagsFor(file) {
  try {
    const value = await valueFor(file);
    const { freezeEndTick, tickRate } = value.timing;
    return value.flags.map((f) => ({ e: (f.tick - freezeEndTick) / tickRate, player: f.player, side: f.side, rule: f.rule, text: f.text, cost_pp: f.cost_pp }));
  } catch {
    return [];
  }
}
