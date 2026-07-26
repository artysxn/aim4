// ---------------------------------------------------------------------------
// Sample a tick buffer at ~1 Hz and accumulate region seconds + CT pair times.
// Used when building the stats index for maps with a ready zone network.
// ---------------------------------------------------------------------------

import { readHeader, readRecord } from '../shared/tickFormat.js';
import { RK } from './regionKeys.js';
import { buildZoneIndex, regionKeysAt } from './zoneIndex.js';

const loadoutHasAwp = (items) =>
  (items || []).some((w) => /awp/i.test(String(w).replace(/^weapon_/, '')));

/**
 * @param {ArrayBuffer|Buffer} buffer
 * @param {object} meta
 * @param {object} network
 * @param {Array<{id:string, team:number, slot?:number}>} players
 * @returns {{ z: Record<string, {awp:number, r:Record<string,number>}>, ctTB: Record<string, number> } | null}
 */
export function presenceFromTicks(buffer, meta, network, players) {
  if (!buffer || !network?.zones?.length || !players?.length) return null;
  let header;
  try {
    header = readHeader(buffer);
  } catch {
    return null;
  }
  const view = buffer instanceof DataView ? buffer : new DataView(
    buffer instanceof ArrayBuffer
      ? buffer
      : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );
  const tickRate = header.tickRate || meta.tickRate || 64;
  const from = meta.freezeEndTick ?? header.firstTick;
  const to = Math.max(from, meta.endTick ?? from);
  const zIndex = buildZoneIndex(network);

  /** @type {Map<string, {id:string, team:number, slot:number}>} */
  const bySlot = new Map();
  for (const p of players) {
    if (p.slot == null || p.slot < 0) continue;
    bySlot.set(p.slot, p);
  }
  // Fall back: meta.players order often matches slots 0..n
  if (!bySlot.size) {
    (meta.players || players).forEach((p, i) => {
      bySlot.set(i, { id: p.id, team: p.team, slot: i });
    });
  }

  /** @type {Record<string, { awp: number, r: Record<string, number> }>} */
  const z = {};
  for (const p of bySlot.values()) {
    const st = meta.stats?.[p.id] || {};
    const awp =
      loadoutHasAwp(st.loadout) || (st.awpShots || 0) > 0 || (st.awpHits || 0) > 0
        ? 1
        : 0;
    z[p.id] = { awp, r: {} };
  }

  /** @type {Record<string, number>} */
  const ctTB = {};
  const scratch = {};
  const step = Math.max(1, tickRate); // ~1 demo-second between samples

  for (let tick = from; tick <= to; tick += step) {
    const raw = (tick - header.firstTick) / Math.max(1, header.stride);
    const row = Math.max(0, Math.min(header.tickCount - 1, Math.floor(raw)));
    /** CT players in top banana / b site / b ct this sample */
    const ctTopBanana = [];
    const ctOnBAnchor = [];

    for (const [slot, p] of bySlot) {
      readRecord(view, row, slot, scratch);
      if (!scratch.alive) continue;
      const keys = regionKeysAt(scratch.x, scratch.y, zIndex);
      if (!keys.size) continue;
      const bag = z[p.id];
      if (!bag) continue;
      for (const k of keys) {
        bag.r[k] = (bag.r[k] || 0) + 1;
      }
      const side = p.team === 1 ? meta.team1Side : meta.team2Side;
      if (side === 'CT') {
        if (keys.has(RK.TOP_BANANA)) ctTopBanana.push(p.id);
        if (keys.has(RK.B_SITE) || keys.has(RK.B_CT)) ctOnBAnchor.push(p.id);
      }
    }

    for (const watcher of ctTopBanana) {
      for (const anchor of ctOnBAnchor) {
        if (watcher === anchor) continue;
        const key = `${watcher}>${anchor}`;
        ctTB[key] = (ctTB[key] || 0) + 1;
      }
    }
  }

  // Drop empty region maps to keep the index small.
  for (const id of Object.keys(z)) {
    if (!Object.keys(z[id].r).length && !z[id].awp) {
      // keep awp:0 entries only if we still want round counting — keep minimal
      if (!z[id].awp) delete z[id].r;
    }
  }

  return { z, ctTB };
}

/** Sum region seconds from a player presence blob. */
export function sec(bag, ...keys) {
  if (!bag?.r) return 0;
  let n = 0;
  for (const k of keys) n += bag.r[k] || 0;
  return n;
}
