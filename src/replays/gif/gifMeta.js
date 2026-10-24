// ---------------------------------------------------------------------------
// replays/gif/gifMeta.js
// What a saved GIF says about itself: the round it came from (map, both
// teams with their side and buy, who won), the part of the round, 2D or 3D,
// and the title and description someone gave it. Built in the page from the
// round's meta, cleaned again on the server before it is stored, and read by
// the Saved GIFs filters. Plain data both ways, so the server imports this file
// as it is.
// ---------------------------------------------------------------------------

import { MAPS, economyLabel, winningSide } from '../shared/roundId.js';

export const GIF_TITLE_MAX = 80;
export const GIF_DESCRIPTION_MAX = 500;
/** Ids are random hex: the share link is the id, so it must not be guessable. */
export const GIF_ID = /^[a-f0-9]{16}$/;

const SIDES = new Set(['T', 'CT']);
const KINDS = new Set(['2d', '3d']);

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (v, max) =>
  String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
const side = (v) => (SIDES.has(v) ? v : '');
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

/** The round clock as the game shows it, from seconds left. */
export function clockText(secondsLeft) {
  const s = Math.max(0, Math.round(Number(secondsLeft) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A map's name from its code (MIR) or its file name (de_mirage). */
export function mapNameOf(code) {
  return MAPS[code]?.name || Object.values(MAPS).find((m) => m.file === code)?.name || String(code || '');
}

/** A team's name off a round's meta, whichever shape the meta carries it in. */
function teamNameOf(meta, team) {
  const t = team === 1 ? meta.team1 : meta.team2;
  if (t && typeof t === 'object') return t.name || '';
  return (team === 1 ? meta.team1Name : meta.team2Name) || '';
}

/**
 * The metadata for a GIF of one round.
 *
 * @param {object} meta  the round's meta (fetchRoundMeta / loadRound)
 * @param {object} opts
 * @param {'2d'|'3d'} opts.kind
 * @param {string} [opts.file]       the round file
 * @param {number} opts.fromTick
 * @param {number} opts.toTick
 * @param {string} [opts.clockFrom]  round clock at the first frame
 * @param {string} [opts.clockTo]    round clock at the last frame
 * @param {string} [opts.side]       whose view it is (the followed player's side in 3D)
 * @param {string} [opts.player]     the followed player's name, in 3D
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 * @param {string} [opts.source]     'viewer' | 'eye' | 'antistrat'
 */
export function gifMetaFromRound(meta, opts = {}) {
  const winner = winningSide(meta);
  const teams = [1, 2].map((n) => {
    const code = n === 1 ? meta.econ1 : meta.econ2;
    return {
      name: teamNameOf(meta, n),
      side: side(n === 1 ? meta.team1Side : meta.team2Side),
      buy: code === undefined || code === null || code === '' ? '' : economyLabel(Number(code))
    };
  });
  const winnerTeam = teams.find((t) => t.side === winner)?.name || '';
  return cleanGifMeta({
    kind: opts.kind,
    title: opts.title,
    description: opts.description,
    map: meta.map,
    mapName: meta.mapName || mapNameOf(meta.map),
    round: meta.round,
    file: opts.file || meta.file || '',
    fromTick: opts.fromTick,
    toTick: opts.toTick,
    clockFrom: opts.clockFrom,
    clockTo: opts.clockTo,
    side: opts.side,
    player: opts.player,
    teams,
    winnerSide: winner,
    winnerTeam,
    source: opts.source
  });
}

/**
 * The stored shape, from anything: every field bounded and typed. Runs in the
 * page before an upload and on the server again, which is the one that counts.
 */
export function cleanGifMeta(input = {}) {
  const m = input && typeof input === 'object' ? input : {};
  const teams = (Array.isArray(m.teams) ? m.teams : []).slice(0, 2).map((t) => ({
    name: text(t?.name, 60),
    side: side(t?.side),
    buy: text(t?.buy, 30)
  }));
  while (teams.length < 2) teams.push({ name: '', side: '', buy: '' });
  const file = String(m.file || '').replace(/\.[a-z0-9]+$/i, '');
  return {
    kind: KINDS.has(m.kind) ? m.kind : '2d',
    title: text(m.title, GIF_TITLE_MAX),
    description: multiline(m.description, GIF_DESCRIPTION_MAX),
    map: text(m.map, 40),
    mapName: text(m.mapName, 40),
    round: Math.max(0, int(m.round)),
    file: /^[A-Za-z0-9_~-]{1,200}$/.test(file) ? file : '',
    fromTick: Math.max(0, int(m.fromTick)),
    toTick: Math.max(0, int(m.toTick)),
    clockFrom: text(m.clockFrom, 8),
    clockTo: text(m.clockTo, 8),
    side: side(m.side),
    player: text(m.player, 60),
    teams,
    winnerSide: side(m.winnerSide),
    winnerTeam: text(m.winnerTeam, 60),
    source: ['viewer', 'eye', 'antistrat'].includes(m.source) ? m.source : 'viewer'
  };
}

/**
 * A description as text and copy links. Anything between < and > is a link
 * that copies what is inside it, so a setpos can ride in a description:
 * "smoke from <setpos -1.5 2.0 64; setang 0 90 0>" shows the setpos as a link.
 *
 * @returns {Array<{ text: string, copy?: string }>}
 */
export function descriptionParts(text) {
  const s = String(text ?? '');
  const parts = [];
  const re = /<([^<>\n]{1,300})>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    const inner = m[1].trim();
    if (!inner) continue;
    if (m.index > last) parts.push({ text: s.slice(last, m.index) });
    parts.push({ text: inner, copy: inner });
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts;
}

/** The description as plain text: copy links lose their brackets. */
export const descriptionPlain = (text) => descriptionParts(text).map((p) => p.text).join('');

/** What a GIF is called when nobody named it. */
export function gifDisplayTitle(g) {
  if (g?.title) return g.title;
  const [a, b] = g?.teams || [];
  const vs = a?.name && b?.name ? `${a.name} vs ${b.name}` : '';
  return [g?.mapName || g?.map, g?.round ? `round ${g.round}` : '', vs].filter(Boolean).join(', ') || 'GIF';
}

/**
 * The Saved GIFs filters. `q` matches the title, description, map, team and
 * player names. `side` matches the side a GIF was seen from, and for a 2D GIF
 * (seen from neither) any GIF where that side's team is named. `buy` matches
 * either team's buy, `team` either team's name.
 *
 * @param {object[]} list
 * @param {{ q?: string, map?: string, side?: string, team?: string, buy?: string, winner?: string, kind?: string }} f
 */
export function filterGifs(list, f = {}) {
  const q = String(f.q || '').trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const team = String(f.team || '').trim().toLowerCase();
  return (Array.isArray(list) ? list : []).filter((g) => {
    if (f.kind && g.kind !== f.kind) return false;
    if (f.map && g.map !== f.map) return false;
    if (f.winner && g.winnerSide !== f.winner) return false;
    if (f.buy && !(g.teams || []).some((t) => t.buy === f.buy)) return false;
    if (team && !(g.teams || []).some((t) => String(t.name || '').toLowerCase() === team)) return false;
    if (f.side) {
      if (g.side) {
        if (g.side !== f.side) return false;
      } else if (!(g.teams || []).some((t) => t.side === f.side && t.name)) return false;
    }
    if (words.length) {
      const hay = [g.title, g.description, g.mapName, g.map, g.player, ...(g.teams || []).map((t) => t.name)]
        .join(' ')
        .toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** The values each filter can take in this list, for the filter menu. */
export function gifFilterOptions(list) {
  const maps = new Map();
  const teams = new Set();
  const buys = new Set();
  for (const g of Array.isArray(list) ? list : []) {
    if (g.map) maps.set(g.map, g.mapName || g.map);
    for (const t of g.teams || []) {
      if (t.name) teams.add(t.name);
      if (t.buy) buys.add(t.buy);
    }
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return {
    maps: [...maps].map(([value, label]) => ({ value, label })).sort((a, b) => byName(a.label, b.label)),
    teams: [...teams].sort(byName),
    buys: [...buys].sort(byName)
  };
}
