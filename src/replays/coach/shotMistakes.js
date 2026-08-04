// ---------------------------------------------------------------------------
// replays/coach/shotMistakes.js
// The mistakes that live in the shot log.
//
// Section 8 of the plan: mechanical error cannot be a death rule. A spray that
// stopped landing six bullets ago is the same mistake whether the fight was
// then won, lost, or walked away from, so none of the death-side gates apply
// here. What does still apply is the buy gate, because a missed spray on a
// full eco is not worth a note, and the coach window, because nothing before
// freezetime ends or after the round is decided is coachable.
//
// Every rule reads `events.shots` and `events.damage` against the tick buffer.
// No geometry and no duel model, so this runs in the team-page batch pass as
// well as in the viewer.
//
// Hits are matched to shots by time alone. Damage carries no shot id, so a
// short window after the shot is the only link available and it is kept tight.
// ---------------------------------------------------------------------------

import { coachText } from './coachMessages.js';
import {
  FIRST_BULLET_CONE_DEG,
  classifyFlickMiss,
  isAimWeapon,
  yawDeltaDeg,
  yawTowardPoint
} from '../shared/aimMetrics.js';
import { FLAG_DEFUSING, FLAG_PLANTING } from '../shared/tickFormat.js';
import { weaponInfo } from '../shared/weaponTable.js';

/** The fight that ended in a death is the shots fired this long before it. */
const ENGAGEMENT_SECONDS = 5;
/** How long after a shot a hit may land and still belong to it. */
const HIT_WINDOW_SECONDS = 0.2;
/** Yaw this far before the shot is the pre-flick angle. Matches aimMetrics. */
const FLICK_LOOKBACK_SECONDS = 0.2;

/** Whiffed the whole fight: this many shots with nothing landing at all. */
const MISS_ALL_SHOTS = 3;
/** Or this many shots with at least this share of them missing. */
const MISS_MOST_SHOTS = 4;
const MISS_MOST_SHARE = 0.66;
/** Flick errors need a real sample before a share means anything. */
const FLICK_MIN_SHOTS = 4;
const FLICK_SHARE = 0.5;
/** Bullets after the last one that did damage, at or above which it is spray. */
const SPRAY_PAST_BULLETS = 6;
/** A burst ends when the gap since the last shot passes this many re-fires. */
const BURST_GAP_CYCLES = 3;
/** Weapons that can spray at all. Pistols and bolt guns cannot. */
const AUTOMATIC = new Set(['rifle', 'smg', 'lmg']);

const bare = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^weapon_/, '');

/** Anything you cannot shoot back with. */
function noGunLabel(weapon) {
  const b = bare(weapon);
  if (!b) return '';
  if (b === 'c4') return 'the bomb';
  if (b === 'taser') return 'the zeus';
  if (b === 'knife' || b.startsWith('knife') || b.startsWith('bayonet')) return 'a knife';
  if (/grenade|molotov|incgrenade|firebomb|decoy|flash/.test(b)) return 'a grenade';
  return '';
}

/**
 * @param {object} args
 * @param {object} args.meta
 * @param {number} args.tickRate
 * @param {Map<string, object>} args.byId
 * @param {(id: string) => ('CT'|'T'|undefined)} args.sideOf
 * @param {{CT: boolean, T: boolean}} args.gate
 * @param {(tick: number) => boolean} args.inCoachWindow
 * @param {number|null} args.defusedTick
 * @param {Array} args.kills
 * @param {(slot: number, tick: number) => (object|null)} args.stateAt
 * @returns {Array<{tick: number, playerId: string, rule: string, text: string}>}
 */
export function findShotFlags({
  meta,
  tickRate,
  byId,
  sideOf,
  gate,
  inCoachWindow,
  defusedTick,
  kills,
  stateAt
}) {
  const flags = [];
  const players = meta?.players || [];
  if (!players.length) return flags;

  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const nameOf = (id) => byId.get(id)?.name || id;
  const shots = (meta.events?.shots || []).filter((s) => s.player && isAimWeapon(s.weapon));
  const damages = meta.events?.damage || [];

  const coachable = (id, tick) => {
    const side = sideOf(id);
    if (!side || !gate[side]) return false;
    if (!inCoachWindow(tick)) return false;
    if (defusedTick != null && tick >= defusedTick) return false;
    return true;
  };

  // ---- indexes ------------------------------------------------------------

  /** player -> shots, in tick order. */
  const shotsBy = new Map();
  for (const s of shots) {
    if (!shotsBy.has(s.player)) shotsBy.set(s.player, []);
    shotsBy.get(s.player).push(s);
  }
  for (const list of shotsBy.values()) list.sort((a, b) => a.tick - b.tick);

  /** player -> enemy damage they dealt, in tick order. */
  const hitsBy = new Map();
  for (const d of damages) {
    if (!d.attacker || !d.victim || !(Number(d.hp) > 0)) continue;
    if (!isAimWeapon(d.weapon)) continue;
    if (teamOf.get(d.attacker) === teamOf.get(d.victim)) continue;
    if (!hitsBy.has(d.attacker)) hitsBy.set(d.attacker, []);
    hitsBy.get(d.attacker).push(d);
  }
  for (const list of hitsBy.values()) list.sort((a, b) => a.tick - b.tick);

  const hitWindow = Math.max(1, Math.round(HIT_WINDOW_SECONDS * tickRate));
  const hitsIn = (playerId, from, to) => {
    const list = hitsBy.get(playerId);
    if (!list) return 0;
    let n = 0;
    for (const d of list) {
      if (d.tick < from) continue;
      if (d.tick > to) break;
      n++;
    }
    return n;
  };

  const deathTick = new Map();
  for (const k of kills) {
    if (k.victim && !deathTick.has(k.victim)) deathTick.set(k.victim, k.tick);
  }
  const killerOf = new Map();
  for (const k of kills) {
    if (k.victim && !killerOf.has(k.victim)) killerOf.set(k.victim, k.attacker || '');
  }

  // ---- the fight that ended in a death ------------------------------------

  const engagement = ENGAGEMENT_SECONDS * tickRate;
  const flickLookback = Math.max(1, Math.round(FLICK_LOOKBACK_SECONDS * tickRate));

  for (const [victim, tick] of deathTick) {
    if (!coachable(victim, tick)) continue;
    const list = shotsBy.get(victim);
    if (!list?.length) continue;
    const from = tick - engagement;
    const fired = list.filter((s) => s.tick >= from && s.tick <= tick);
    if (fired.length < MISS_ALL_SHOTS) continue;

    const landed = hitsIn(victim, from, tick + hitWindow);
    const missed = Math.max(0, fired.length - landed);

    const whiffedAll = fired.length >= MISS_ALL_SHOTS && landed === 0;
    const whiffedMost =
      fired.length >= MISS_MOST_SHOTS && missed / fired.length >= MISS_MOST_SHARE;

    if (whiffedAll || whiffedMost) {
      flags.push({
        tick,
        playerId: victim,
        rule: 'missed-everything',
        text: coachText('missed-everything', tick, {
          player: nameOf(victim),
          shots: fired.length,
          hits: landed,
          missed
        })
      });
      continue;
    }

    // Flicks are the softer read on the same fight: the shots were near the
    // target on one side or the other rather than nowhere at all, so it only
    // runs when the blunt rule above did not already claim the death.
    if (fired.length < FLICK_MIN_SHOTS) continue;
    const shooter = byId.get(victim);
    if (shooter?.slot == null) continue;

    let flicks = 0;
    let judged = 0;
    for (const shot of fired) {
      const at = stateAt(shooter.slot, shot.tick);
      if (!at) continue;
      const before = stateAt(shooter.slot, shot.tick - flickLookback);
      if (!before || !Number.isFinite(before.yaw)) continue;
      const fromPos = {
        x: Number.isFinite(shot.x) && (shot.x !== 0 || shot.y !== 0) ? shot.x : at.x,
        y: Number.isFinite(shot.y) && (shot.x !== 0 || shot.y !== 0) ? shot.y : at.y
      };
      const endYaw = Number.isFinite(shot.yaw) ? shot.yaw : at.yaw;

      // The enemy the shot was aimed at: nearest living one inside the cone.
      let target = null;
      let best = Infinity;
      for (const other of players) {
        if (other.id === victim || other.slot == null) continue;
        if (teamOf.get(other.id) === teamOf.get(victim)) continue;
        const e = stateAt(other.slot, shot.tick);
        if (!e?.alive) continue;
        const d = Math.hypot(e.x - fromPos.x, e.y - fromPos.y);
        if (d >= best) continue;
        if (yawDeltaDeg(endYaw, yawTowardPoint(fromPos, e)) > FIRST_BULLET_CONE_DEG) continue;
        target = e;
        best = d;
      }
      if (!target) continue;

      judged++;
      if (classifyFlickMiss(before.yaw, endYaw, yawTowardPoint(fromPos, target))) flicks++;
    }

    if (judged >= FLICK_MIN_SHOTS && flicks / judged >= FLICK_SHARE) {
      flags.push({
        tick,
        playerId: victim,
        rule: 'flick-error',
        text: coachText('flick-error', tick, {
          player: nameOf(victim),
          share: `${Math.round((flicks / judged) * 100)}%`
        })
      });
    }
  }

  // ---- bursts that kept going after they stopped landing ------------------

  const judgeBurst = (playerId, weapon, burst) => {
    if (burst.length <= SPRAY_PAST_BULLETS) return;
    if (!AUTOMATIC.has(weaponInfo(weapon).category)) return;
    const end = burst[burst.length - 1].tick;
    if (!coachable(playerId, end)) return;

    // The last bullet that did anything. Without one this is a whiffed fight,
    // which `missed-everything` already has an opinion about.
    let lastLanded = -1;
    for (let i = 0; i < burst.length; i++) {
      if (hitsIn(playerId, burst[i].tick, burst[i].tick + hitWindow) > 0) lastLanded = i;
    }
    if (lastLanded < 0) return;

    const after = burst.length - 1 - lastLanded;
    if (after < SPRAY_PAST_BULLETS) return;

    flags.push({
      tick: end,
      playerId,
      rule: 'spray-past-control',
      text: coachText('spray-past-control', end, {
        player: nameOf(playerId),
        n: after
      })
    });
  };

  for (const [playerId, list] of shotsBy) {
    let burst = [];
    let burstWeapon = '';

    const closeBurst = () => {
      if (burst.length) judgeBurst(playerId, burstWeapon, burst);
      burst = [];
      burstWeapon = '';
    };

    for (const shot of list) {
      const weapon = bare(shot.weapon);
      const gap = Math.max(
        2,
        Math.round(weaponInfo(weapon).cycleSeconds * BURST_GAP_CYCLES * tickRate)
      );
      const last = burst[burst.length - 1];
      if (!last || weapon !== burstWeapon || shot.tick - last.tick > gap) {
        closeBurst();
        burstWeapon = weapon;
      }
      burst.push(shot);
    }
    closeBurst();
  }

  // ---- died with nothing to shoot back with -------------------------------

  const weapons = meta.weapons || [];
  if (weapons.length) {
    for (const [victim, tick] of deathTick) {
      if (!coachable(victim, tick)) continue;
      const slot = byId.get(victim)?.slot;
      if (slot == null) continue;
      const at = stateAt(slot, tick - 1);
      if (!at?.alive) continue;
      // Planting and defusing are the job, not a mistake.
      if (at.flags & (FLAG_PLANTING | FLAG_DEFUSING)) continue;
      const label = noGunLabel(weapons[at.weapon]);
      if (!label) continue;
      flags.push({
        tick,
        playerId: victim,
        rule: 'knife-out',
        text: coachText('knife-out', tick, {
          player: nameOf(victim),
          item: label,
          enemy: nameOf(killerOf.get(victim) || '')
        })
      });
    }
  }

  return flags;
}
