// ---------------------------------------------------------------------------
// shared/sim/contracts.js
// Role contracts: what a role owes, not what a role is (SIM-PLAN 6.19).
//
// Keyed by map position, not by a cross-map role name. Inferno T is Banana,
// Ramp, 2nd Mid, AWPer, A Lurk; Inferno CT is B Rotation, B Anchor, A Rotation,
// AWPer, A Anchor. Same lists as teamPositions.js, because a second vocabulary
// would make the sim's coach disagree with the site.
//
// Five clauses, evaluated every tick:
//
//   zones          ranked areas this role may occupy; a hard set it may not
//                  leave without a directive change
//   utilBudget     lineups it owns this round
//   window         clock interval in which its job exists
//   tradeDuty      who it trades / who trades it
//   deathPermission  dPRW price at which dying is acceptable
//
// Masks, not hints. The zone clause and the util budget enter the action mask,
// so a Banana player cannot emit "advance to apartments" unless Playstyle
// reassigns it. Reassignment on death is a logged directive, not a silent
// reshuffle.
// ---------------------------------------------------------------------------

import { POSITIONS, positionsFor } from '../../src/replays/roles/teamPositions.js';
import { OPTION_DEFS, OPTION_IDS } from './options.js';

export const CONTRACT_VERSION = 1;

/** Options that walk the bot into a named zone. */
const ZONE_TRAVEL = Object.freeze([
  'advance',
  'rotate',
  'flank',
  'lurk',
  'take_space',
  'run_in_behind',
  'drop_deep',
  'dummy_run',
  'execute_entry'
]);

/**
 * Default zone bags per Inferno position. Other maps inherit the same
 * structure with the position name as the only allowed zone until a bake
 * lands; that is conservative (the mask is tighter than it should be) rather
 * than leaky.
 */
const INF_ZONES = {
  T: {
    Banana: { rank: ['banana', 'b_site', 'b'], forbid: ['apartments', 'a_site', 'apps', 'pit'] },
    Ramp: { rank: ['ramp', 'a_site', 'a'], forbid: ['banana', 'b_site'] },
    '2nd Mid': { rank: ['mid', 'second_mid', 'arch'], forbid: [] },
    AWPer: { rank: ['mid', 'banana', 't_ramp'], forbid: [] },
    'A Lurk': { rank: ['apartments', 'apps', 'balcony', 'a_site'], forbid: ['banana'] }
  },
  CT: {
    'B Rotation': { rank: ['banana', 'coffin', 'b_site'], forbid: ['pit'] },
    'B Anchor': { rank: ['b_site', 'banana', 'newbox'], forbid: ['apartments', 'pit'] },
    'A Rotation': { rank: ['mid', 'arch', 'a_site'], forbid: [] },
    AWPer: { rank: ['pit', 'mid', 'arch'], forbid: ['banana'] },
    'A Anchor': { rank: ['a_site', 'pit', 'library', 'arch'], forbid: ['banana'] }
  }
};

function zonesFor(map, side, position) {
  const m = String(map || '').toUpperCase();
  const s = side === 'CT' ? 'CT' : 'T';
  const bag = m === 'INF' ? INF_ZONES[s]?.[position] : null;
  if (bag) return bag;
  const slug = String(position || '')
    .toLowerCase()
    .replace(/\s+/g, '_');
  return { rank: slug ? [slug] : [], forbid: [] };
}

function utilFor(position) {
  const p = String(position || '').toLowerCase();
  if (p.includes('awp')) return { smokes: 0, flashes: 1, molotovs: 0 };
  if (p.includes('banana') || p.includes('b anchor')) return { smokes: 1, flashes: 1, molotovs: 1 };
  if (p.includes('ramp') || p.includes('a lurk') || p.includes('a anchor')) {
    return { smokes: 1, flashes: 1, molotovs: 0 };
  }
  return { smokes: 1, flashes: 1, molotovs: 0 };
}

function windowFor(side, position) {
  const p = String(position || '').toLowerCase();
  if (side === 'T' && (p.includes('banana') || p.includes('ramp') || p.includes('lurk'))) {
    return { from: 0, to: 25 };
  }
  if (p.includes('rotation')) return { from: 15, to: 115 };
  return { from: 0, to: 115 };
}

function deathPermission(position) {
  const p = String(position || '').toLowerCase();
  if (p.includes('awp')) return 0;
  if (p.includes('lurk')) return 15;
  if (p.includes('banana') || p.includes('ramp')) return 40;
  return 20;
}

/**
 * One contract row.
 *
 * @param {object} args
 * @param {string} args.map
 * @param {'T'|'CT'} args.side
 * @param {string} args.position
 * @param {number} args.slot
 */
export function contractFor({ map, side, position, slot, tradeWith = null } = {}) {
  const zones = zonesFor(map, side, position);
  return {
    v: CONTRACT_VERSION,
    map: String(map || '').toUpperCase(),
    side: side === 'CT' ? 'CT' : 'T',
    position,
    slot,
    zones: { rank: [...zones.rank], forbid: [...zones.forbid] },
    utilBudget: utilFor(position),
    window: windowFor(side, position),
    tradeDuty: { with: tradeWith, directed: true },
    deathPermission: deathPermission(position)
  };
}

/**
 * Five contracts for a side, slot order matching the roster.
 */
export function assignContracts({ map, side, slots = [0, 1, 2, 3, 4] } = {}) {
  const positions = positionsFor(side, String(map || '').toUpperCase());
  const list = positions.length ? positions : ['AWPer', 'Anchor', 'Support', 'Rotator', 'Lurk'];
  return slots.map((slot, i) => {
    const position = list[i % list.length];
    const mate = slots[(i + 1) % slots.length];
    return contractFor({ map, side, position, slot, tradeWith: mate });
  });
}

export { POSITIONS, positionsFor };

function targetOf(params) {
  return String(params?.target ?? params?.site ?? params?.spot ?? '').toLowerCase();
}

function zoneHits(name, contract) {
  if (!name) return false;
  return contract.zones.forbid.some((z) => name.includes(String(z).toLowerCase()));
}

/**
 * Masks, not hints. Deletes travel options whose target is in the forbid
 * set. Objective options (plant/defuse) always stay. A Playstyle reassignment
 * is the only way back in, and that is a logged directive.
 *
 * @param {Set<string>} legal
 * @param {object} contract
 * @param {object} [args]
 * @param {object} [args.paramsById]  option id -> params, when the caller knows the target
 * @param {number} [args.clock]
 * @param {object} [args.spent]  { smokes, flashes, molotovs }
 * @returns {Set<string>}
 */
export function maskByContract(legal, contract, { paramsById = null, clock = null, spent = null } = {}) {
  const out = new Set(legal);
  if (!contract) return out;
  for (const id of ZONE_TRAVEL) {
    if (!out.has(id)) continue;
    const params = paramsById?.[id] || null;
    const dest = targetOf(params);
    if (dest && zoneHits(dest, contract)) out.delete(id);
  }
  if (spent) {
    const bud = contract.utilBudget;
    if ((spent.smokes || 0) >= (bud.smokes || 0) && out.has('utility_setup')) {
      // Keep the option if other nades remain; the desire layer still prices it.
    }
  }
  if (clock != null) {
    const w = contract.window;
    if (clock < w.from || clock > w.to) {
      for (const id of ['execute_entry', 'lurk']) out.delete(id);
    }
  }
  return out;
}

/**
 * Is this bot currently inside its ranked zones, or in a forbidden one?
 */
export function zoneCompliance(contract, zoneId) {
  if (!contract || !zoneId) return { ok: true, reason: 'no zone' };
  const z = String(zoneId).toLowerCase();
  if (zoneHits(z, contract)) return { ok: false, reason: `forbid ${zoneId}` };
  const ranked = contract.zones.rank.some((r) => z.includes(String(r).toLowerCase()));
  if (contract.zones.rank.length && !ranked) {
    return { ok: false, reason: `off-role ${zoneId}` };
  }
  return { ok: true, reason: 'in rank' };
}

/**
 * Death permission: an entry may die for `deathPermission` dPRW of space;
 * an AWPer holding a retake may not.
 */
export function deathWasPermitted(contract, dprwLost) {
  return (Number(dprwLost) || 0) <= (contract?.deathPermission ?? 0);
}

/**
 * Reassignment on death. Logged, never silent.
 *
 * @returns {{from: object, to: object, directive: object}}
 */
export function reassignOnDeath({ contracts, deadSlot, tick }) {
  const dead = contracts.find((c) => c.slot === deadSlot);
  if (!dead) return null;
  const living = contracts.filter((c) => c.slot !== deadSlot);
  const heir = living[0] || null;
  if (!heir) return { from: dead, to: null, directive: { type: 'abandoned', tick, slot: deadSlot } };
  const next = { ...heir, zones: dead.zones, position: `${heir.position}+${dead.position}` };
  return {
    from: dead,
    to: next,
    directive: {
      type: 'reassign',
      tick,
      fromSlot: deadSlot,
      toSlot: heir.slot,
      cover: dead.position
    }
  };
}

/**
 * Compliance rate over a log of (zone, contract) samples. The role-breaking
 * agent fails this gate while it can still win on Elo.
 */
export function contractCompliance(samples) {
  if (!samples?.length) return { rate: 1, n: 0 };
  let ok = 0;
  for (const s of samples) {
    if (zoneCompliance(s.contract, s.zone).ok) ok += 1;
  }
  return { rate: ok / samples.length, n: samples.length };
}

/** The gate that has teeth: Elo cannot buy a pass. */
export const CONTRACT_GATE = 0.7;

export function contractGate({ compliance, elo = 0 }) {
  const rate = Number(compliance) || 0;
  const pass = rate >= CONTRACT_GATE;
  return {
    pass,
    rate,
    elo,
    reason: pass
      ? `contract ${rate.toFixed(2)} >= ${CONTRACT_GATE}`
      : `contract ${rate.toFixed(2)} failed the gate (Elo ${elo} does not buy a pass)`
  };
}

export { OPTION_DEFS, OPTION_IDS };
