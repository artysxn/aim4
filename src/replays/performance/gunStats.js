// ---------------------------------------------------------------------------
// replays/performance/gunStats.js
// Per-gun numbers for one player, from the stats index already in memory.
//
// Player matches are selected first. Each round's `hg` field names the gun
// held longest while alive. Rating 3.0 / swing / accuracy / KPR / xK re-aggregate
// those rounds. The file→gun map is cached against the player's demo set.
// ---------------------------------------------------------------------------

import { aggregatePlayers } from '../shared/statsMath.js';
import { bareWeapon } from '../viewer/equipmentIcons.js';
import { kprOf } from './performanceMath.js';

const CACHE_KEY = 'aim4:perf:guns:v4';

const GUN_LABELS = {
  ak47: 'AK-47',
  m4a1: 'M4A4',
  m4a1_silencer: 'M4A1-S',
  awp: 'AWP',
  galilar: 'Galil AR',
  famas: 'FAMAS',
  sg556: 'SG 553',
  aug: 'AUG',
  ssg08: 'SSG 08',
  g3sg1: 'G3SG1',
  scar20: 'SCAR-20',
  mac10: 'MAC-10',
  mp9: 'MP9',
  mp7: 'MP7',
  mp5sd: 'MP5-SD',
  ump45: 'UMP-45',
  p90: 'P90',
  bizon: 'PP-Bizon',
  deagle: 'Desert Eagle',
  revolver: 'R8 Revolver',
  glock: 'Glock-18',
  usp_silencer: 'USP-S',
  hkp2000: 'P2000',
  p250: 'P250',
  fiveseven: 'Five-SeveN',
  tec9: 'Tec-9',
  cz75a: 'CZ75-Auto',
  elite: 'Dual Berettas',
  nova: 'Nova',
  xm1014: 'XM1014',
  mag7: 'MAG-7',
  sawedoff: 'Sawed-Off',
  m249: 'M249',
  negev: 'Negev'
};

export function gunLabel(stem) {
  const id = bareWeapon(stem);
  return GUN_LABELS[id] || id.replace(/_/g, ' ').toUpperCase();
}

export function demoSetStamp(demoIds) {
  const ids = [...demoIds].map(String).sort();
  const s = ids.join(',');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${ids.length}:${h}`;
}

/**
 * Gun held longest this round (`row.hg` from tick hold time).
 * Empty when that round was not measured.
 */
export function primaryGunFromRow(row, playerId) {
  return bareWeapon(row?.hg?.[playerId] || '') || '';
}

/**
 * Map round file → primary gun for this player.
 * @param {object[]} rows
 * @param {string} playerId
 */
export function gunMapFromRows(rows, playerId) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const row of rows || []) {
    const file = String(row.f || '');
    if (!file) continue;
    const gun = primaryGunFromRow(row, playerId);
    if (gun) files[file] = gun;
  }
  return files;
}

function memoryStore() {
  /** @type {Record<string, string>} */
  const mem = {};
  return {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => {
      mem[k] = String(v);
    }
  };
}

function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* private mode */
  }
  return memoryStore();
}

export function readGunCache(playerId, stamp, store = storage()) {
  try {
    const raw = store.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.playerId !== playerId || parsed.stamp !== stamp) return null;
    if (!parsed.files || typeof parsed.files !== 'object') return null;
    return parsed.files;
  } catch {
    return null;
  }
}

export function writeGunCache(playerId, stamp, files, store = storage()) {
  try {
    store.setItem(CACHE_KEY, JSON.stringify({ playerId, stamp, files }));
  } catch {
    /* quota */
  }
}

/**
 * File→gun for this player. Reuses the cache when the demo set is unchanged.
 */
export function gunMapForPlayer(rows, playerId, demoIds, store = storage()) {
  const stamp = demoSetStamp(demoIds);
  const hit = readGunCache(playerId, stamp, store);
  if (hit && Object.keys(hit).length) return hit;
  const files = gunMapFromRows(rows, playerId);
  if (Object.keys(files).length) writeGunCache(playerId, stamp, files, store);
  return files;
}

/**
 * Aggregate one player's filtered rounds by primary gun.
 *
 * @param {object[]} rows  already filtered to this player
 * @param {string} playerId
 * @param {Map} players
 * @param {Map} demos
 * @param {Record<string, string>} gunByFile
 */
export function aggregateGuns(rows, playerId, players, demos, gunByFile) {
  /** @type {Map<string, object[]>} */
  const byGun = new Map();
  let attributed = 0;
  for (const row of rows) {
    const gun = gunByFile[row.f];
    if (!gun) continue;
    attributed++;
    if (!byGun.has(gun)) byGun.set(gun, []);
    byGun.get(gun).push(row);
  }
  const out = [];
  for (const [gun, gunRows] of byGun) {
    const p = aggregatePlayers(gunRows, players, {}, demos).find((x) => x.id === playerId);
    if (!p?.rounds) continue;
    let gunKills = 0;
    let gunDeaths = 0;
    for (const row of gunRows) {
      for (const k of row.kt || []) {
        if (k.a === playerId && k.g && bareWeapon(k.w) === gun) gunKills++;
        if (k.v === playerId && k.g) gunDeaths++;
      }
    }
    const shots = p.shots || 0;
    out.push({
      gun,
      label: gunLabel(gun),
      rounds: p.rounds,
      used: attributed ? p.rounds / attributed : 0,
      rating: p.rating,
      swing: p.prwSwing,
      accuracy: shots > 0 ? p.accuracy : null,
      kpr: kprOf(p),
      xk: p.xk,
      kills: gunKills,
      deaths: gunDeaths,
      stats: p
    });
  }
  out.sort((a, b) => b.used - a.used || b.rounds - a.rounds || a.label.localeCompare(b.label));
  return out;
}