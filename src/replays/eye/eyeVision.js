// ---------------------------------------------------------------------------
// replays/eye/eyeVision.js
// What aim4 eye sees: one moment of one round, drawn on the radar the same way
// the viewer draws it, as a picture the model can read, plus the same moment
// as text (who is alive, health, weapons, kills so far) so a model without
// vision still gets the facts.
//
// The picture is drawn on an offscreen canvas by the viewer's own
// RadarRenderer, so it can never disagree with what the person sees in the
// round viewer.
// ---------------------------------------------------------------------------

import { RadarRenderer } from '../viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../viewer/mapCalibration.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { MAPS } from '../shared/roundId.js';
import { clockLabel, parseClock } from './eyeImages.js';
import { loadRound } from './eyeRound.js';
import { momentLines } from './eyeValue.js';

/** Edge of the square picture, in pixels. Big enough to read names, small enough to stay cheap to send. */
export const SHOT_SIZE = 768;
const SHOT_QUALITY = 0.8;

const sideOf = (meta, team) => (team === 1 ? meta.team1Side : meta.team2Side) || '';
const teamName = (meta, team) => (team === 1 ? meta.team1?.name : meta.team2?.name) || `Team ${team}`;

/**
 * The moment as text: the clock, each side's players with health and weapon,
 * and the kills so far. Every line comes from the round's own record.
 */
export function describeMoment(meta, states, tick, secondsLeft) {
  const weapons = meta.weapons || [];
  const lines = [];
  lines.push(`Round ${meta.round}, ${MAPS[meta.map]?.name || meta.mapName || meta.map}, clock ${clockLabel(secondsLeft)} (${clockLabel(ROUND_SECONDS)} is the start of the live round).`);
  lines.push(`${teamName(meta, 1)} play ${sideOf(meta, 1)}, ${teamName(meta, 2)} play ${sideOf(meta, 2)}. Winner: ${teamName(meta, meta.winner)} (${meta.winnerSide || ''}).`);
  for (const team of [1, 2]) {
    const members = (meta.players || []).filter((p) => p.team === team);
    const alive = members.filter((p) => states[p.slot]?.alive).length;
    lines.push(`${teamName(meta, team)} (${sideOf(meta, team)}), ${alive} alive:`);
    for (const p of members) {
      const s = states[p.slot];
      const gun = weapons[s?.weapon] || '';
      lines.push(`  ${p.name}: ${s?.alive ? `${s.health} hp${gun && gun !== 'none' ? `, ${gun}` : ''}` : 'dead'}`);
    }
  }
  const name = new Map((meta.players || []).map((p) => [p.id, p.name]));
  const kills = (meta.events?.kills || []).filter((k) => k.tick <= tick);
  if (kills.length) {
    lines.push('Kills so far:');
    for (const k of kills) {
      const at = meta.freezeEndTick != null ? clockLabel(ROUND_SECONDS - (k.tick - meta.freezeEndTick) / (meta.tickRate || 64)) : '';
      lines.push(`  ${at} ${name.get(k.attacker) || k.attacker} killed ${name.get(k.victim) || k.victim} with ${k.weapon}${k.headshot ? ' (headshot)' : ''}`);
    }
  } else {
    lines.push('No kills yet.');
  }
  return lines.join('\n');
}

/**
 * Zoom the view onto where the players are, so names and facing are readable.
 * The radar square is mostly empty space on most maps; framing on the alive
 * players (with margin, never tighter than a quarter of the map) makes the
 * same picture several times more useful.
 */
function frameOnPlayers(renderer, states, mapCode, size) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const pt = { x: 0, y: 0 };
  for (const s of states) {
    if (!s?.alive) continue;
    worldToRadar(mapCode, s.x, s.y, pt);
    minX = Math.min(minX, pt.x);
    maxX = Math.max(maxX, pt.x);
    minY = Math.min(minY, pt.y);
    maxY = Math.max(maxY, pt.y);
  }
  if (!Number.isFinite(minX)) return;
  const pad = 70;
  const span = Math.max(maxX - minX + pad * 2, maxY - minY + pad * 2, RADAR_SIZE * 0.28);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const zoom = Math.max(1, Math.min(3.2, RADAR_SIZE / span));
  const scale = (size / RADAR_SIZE) * zoom;
  renderer.zoom = zoom;
  renderer.panX = size / 2 - cx * scale - (size - RADAR_SIZE * scale) / 2;
  renderer.panY = size / 2 - cy * scale - (size - RADAR_SIZE * scale) / 2;
}

/**
 * Draw one moment of one round.
 *
 * @param {{ round: string, clock?: string, size?: number }} args  `round` is a round file from find_rounds
 * @returns {Promise<{ content: string, display: string, images: string[], link: string }>}
 */
export async function screenshotRound(args) {
  const file = String(args.round || '').trim();
  if (!file) throw new Error('Give the round file from find_rounds.');
  const { meta, track } = await loadRound(file);
  const timing = timingFor(meta);
  const left = parseClock(args.clock ?? '1:55');
  if (left == null) throw new Error(`"${args.clock}" is not a clock time. Use a round clock such as 1:20.`);
  const secondsLeft = Math.max(0, Math.min(ROUND_SECONDS, left));
  const tick = Math.round(Math.max(timing.startTick, Math.min(timing.officialEndTick, timing.freezeEndTick + (ROUND_SECONDS - secondsLeft) * timing.tickRate)));

  const size = Math.max(256, Math.min(1024, Math.round(Number(args.size) || SHOT_SIZE)));
  const canvas = document.createElement('canvas');
  const renderer = new RadarRenderer(canvas);
  renderer.dpr = 1;
  renderer.showNames = true;
  renderer.showWeapons = true;
  await renderer.setMap(meta.map);
  const states = track.sampleAll(tick, []);
  if (args.view !== 'map') frameOnPlayers(renderer, states, meta.map, size);
  renderer.render({
    tick,
    tickRate: timing.tickRate,
    states,
    players: meta.players || [],
    allPlayers: meta.players || [],
    events: meta.events || {},
    weapons: meta.weapons || [],
    teamSides: { 1: meta.team1Side, 2: meta.team2Side },
    compact: false,
    mapAlpha: 0.9,
    pixelSize: { w: size, h: size }
  });

  // A caption in the picture, so the image carries its own context when it is read back later.
  const ctx = canvas.getContext('2d');
  const caption = `${MAPS[meta.map]?.name || meta.map}  round ${meta.round}  ${clockLabel(secondsLeft)}  ${teamName(meta, 1)} (${sideOf(meta, 1)}) vs ${teamName(meta, 2)} (${sideOf(meta, 2)})`;
  ctx.font = '600 15px sans-serif';
  const w = Math.min(size - 16, ctx.measureText(caption).width + 20);
  ctx.fillStyle = 'rgba(5,5,5,0.78)';
  ctx.fillRect(8, 8, w, 28);
  ctx.fillStyle = '#f2f2f2';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption, 18, 22, size - 36);

  const dataUrl = canvas.toDataURL('image/jpeg', SHOT_QUALITY);
  // What the models say this moment is worth, so a picture is read against numbers and not on its own.
  const worth = await momentLines(file, tick);
  return {
    content: [describeMoment(meta, states, tick, secondsLeft), ...worth].join('\n'),
    display: `Round ${meta.round} on ${MAPS[meta.map]?.name || meta.map} at ${clockLabel(secondsLeft)}`,
    images: [dataUrl],
    link: `/demos?rounds=${encodeURIComponent(file)}`
  };
}
