// ---------------------------------------------------------------------------
// src/cs3d/throwing.js
// The grenade in your hand: pin, charge, release, redraw.
//
// What the mouse means, measured rather than remembered. CS2 networks
// `m_flThrowStrength` on the weapon and it is a CONTINUOUS field, not a
// three-way switch — but across a match it sits at 1.0, 0.5 or 0.0 for all but
// a few hundred ticks, and those three produce release speeds of exactly
// 675.00, 438.75 and 202.50 u/s (shared/sim3d/grenade.js `throwSpeed`):
//
//   left button           strength 1.0    the long throw
//   both buttons          strength 0.5    the medium throw
//   right button          strength 0.0    the short underhand toss
//
// The in-between values are the field TRAVELLING between two of those, which is
// what happens when a player adds or drops a button mid-hold — one recorded
// throw steps 1.00, 0.98, 0.96 ... 0.50 at about 0.02 a tick and is then flat
// until the projectile appears. So the strength eases toward the target rather
// than snapping, and the value at RELEASE is the one that flies.
//
// The throw is on the button coming UP, not going down. Pressing pulls the pin
// and starts the charge; releasing throws. Between the release and the
// projectile existing there is a throw animation: measured at 6 ticks
// (median of 37 throws, mode 24/37), which is why a grenade does not appear
// at the crosshair the instant you click.
//
// Ammunition: the explorer hands out grenades without limit. That is a
// deliberate departure — it is a place to practise lineups, not a round of
// competitive — and it is the ONLY thing in this file that is not the game's
// behaviour.
// ---------------------------------------------------------------------------

import { THROW_STRENGTH, THROW_STRENGTH_RATE, GRENADE_SPEC, throwSpeed } from '../../shared/sim3d/grenade.js';
import { TICK_DT } from '../../shared/sim3d/constants.js';

/**
 * [measured] Seconds between the button coming up and the projectile existing.
 * weapon_fire to the projectile's first tick: median 6 ticks over 37 throws,
 * 24 of them exactly 6 and 8 at 7. The stragglers at 13-14 are throws whose
 * weapon_fire and release did not land on the same tick.
 */
export const THROW_RELEASE_TICKS = 6;

/**
 * [guessed] Seconds after the throw before the next grenade is in hand. CS2
 * re-deploys the next one of the same type; the weapon table's deploy duration
 * is 1.0 s for every grenade, which is what this uses.
 */
const REDRAW_AFTER = 0.2;

/** Which strength a set of held buttons is charging toward. */
function targetStrength(primary, secondary) {
  if (primary && secondary) return THROW_STRENGTH.medium;
  if (secondary) return THROW_STRENGTH.short;
  return THROW_STRENGTH.full;
}

export class ThrowControl {
  /**
   * @param {object} o
   * @param {(o: {type: string, strength: number}) => void} o.onThrow  fires when
   *   the projectile should exist, already delayed by the throw animation
   * @param {(action: string, o?: object) => void} [o.onAnim]  'pullpin' |
   *   'throw_overhand' | 'throw_underhand' | 'draw'
   */
  constructor({ onThrow, onAnim } = {}) {
    this.onThrow = onThrow || (() => {});
    this.onAnim = onAnim || (() => {});
    /** The grenade in hand, or null when holding a gun. */
    this.type = null;
    this.held = { primary: false, secondary: false };
    this.pinPulled = false;
    this.strength = THROW_STRENGTH.full;
    /** Seconds left of the throw animation before the projectile appears. */
    this._release = 0;
    this._pending = null;
    /** Seconds until the next one is in hand. */
    this._redraw = 0;
  }

  /** True while this is the thing the mouse is driving. */
  get active() {
    return !!this.type;
  }

  /** Hold a grenade by type, or pass a non-grenade / null to stand down. */
  setWeapon(name) {
    const bare = String(name || '').replace(/^weapon_/, '');
    const type = GRENADE_SPEC[bare] ? bare : null;
    if (type === this.type) return this.type;
    this.type = type;
    this.pinPulled = false;
    this.strength = THROW_STRENGTH.full;
    this._release = 0;
    this._pending = null;
    this._redraw = 0;
    this.held.primary = false;
    this.held.secondary = false;
    return this.type;
  }

  /**
   * A mouse button went down or came up.
   * @returns {boolean} true when this consumed the event (a grenade is in hand)
   */
  button(which, down) {
    if (!this.type) return false;
    const key = which === 'secondary' ? 'secondary' : 'primary';
    const was = this.held[key];
    this.held[key] = down;
    if (down) {
      if (was || this._release > 0 || this._redraw > 0) return true;
      if (!this.pinPulled) {
        // The pin comes out on the press, and the charge starts at whatever
        // this button combination asks for.
        this.pinPulled = true;
        this.strength = targetStrength(this.held.primary, this.held.secondary);
        this.onAnim('pullpin');
      }
      return true;
    }
    // Coming up. Releasing ANY held button throws, at the strength the charge
    // has reached — which is why "hold both, let go" is a medium throw and not
    // whatever the button still down would ask for on its own.
    if (this.pinPulled) this._throw();
    return true;
  }

  _throw() {
    this.pinPulled = false;
    this.held.primary = false;
    this.held.secondary = false;
    this._pending = { type: this.type, strength: this.strength };
    this._release = THROW_RELEASE_TICKS * TICK_DT;
    // Underhand below the midpoint: the game authors both clips and the short
    // toss is visibly a different motion, not a weaker version of the same one.
    this.onAnim(this.strength <= THROW_STRENGTH.medium ? 'throw_underhand' : 'throw_overhand');
  }

  /** Everything drops: pointer lock lost, weapon switched, respawn. */
  cancel() {
    this.pinPulled = false;
    this.held.primary = false;
    this.held.secondary = false;
    this._release = 0;
    this._pending = null;
    this.strength = THROW_STRENGTH.full;
  }

  update(dt) {
    if (!this.type) return;
    if (this.pinPulled) {
      const target = targetStrength(this.held.primary, this.held.secondary);
      const step = THROW_STRENGTH_RATE * dt;
      const d = target - this.strength;
      this.strength = Math.abs(d) <= step ? target : this.strength + Math.sign(d) * step;
    }
    if (this._release > 0) {
      this._release -= dt;
      if (this._release <= 0) {
        const p = this._pending;
        this._pending = null;
        this._release = 0;
        this._redraw = REDRAW_AFTER;
        if (p) this.onThrow(p);
      }
      return;
    }
    if (this._redraw > 0) {
      this._redraw -= dt;
      if (this._redraw <= 0) {
        this._redraw = 0;
        this.onAnim('draw');
      }
    }
  }

  /** What the HUD shows: null, or the charge state. */
  status() {
    if (!this.type) return null;
    return {
      type: this.type,
      pinPulled: this.pinPulled,
      strength: this.strength,
      speed: throwSpeed(this.strength),
      throwing: this._release > 0
    };
  }
}
