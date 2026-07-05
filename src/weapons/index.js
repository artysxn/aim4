// ---------------------------------------------------------------------------
// weapons/index.js — weapon registry
// Normalises each weapon module (rifle = AK, pistol = USP) into a single spec
// object the WeaponController and Viewmodel consume. Adding a new weapon means
// writing a module with the same exports and registering it here.
// ---------------------------------------------------------------------------

import * as rifle from './ak47.js';
import * as pistol from './pistol.js';
import * as tracking from './tracking.js';
import * as sniper from './sniper.js';

function toSpec(id, label, model, automatic, m) {
  return {
    id,
    label,
    model, // which viewmodel mesh to show
    automatic, // true = hold to fire (rifle); false = one click, one bullet (pistol)
    zoom: m.ZOOM || null, // scope tuning (sniper) — null for unscoped weapons
    magSize: m.MAG_SIZE,
    reloadTime: m.RELOAD_TIME,
    shotInterval: m.SHOT_INTERVAL,
    burstBreakMs: m.BURST_BREAK_MS,
    sustainCap: m.SUSTAIN_CAP_SHOTS,
    sustainRecoveryPerShot: m.SUSTAIN_RECOVERY_PER_SHOT,
    punchTauSpray: m.PUNCH_TAU_SPRAY,
    punchTauRecover: m.PUNCH_TAU_RECOVER,
    viewPunchStrength: m.VIEW_PUNCH_STRENGTH,
    patternOffset: m.patternOffset,
    bloomRad: m.bloomRad,
    viewPunchImpulse: m.viewPunchImpulse
  };
}

export const WEAPONS = {
  rifle: toSpec('rifle', 'Rifle', 'rifle', true, rifle),
  pistol: toSpec('pistol', 'Pistol', 'pistol', false, pistol),
  tracking: toSpec('tracking', 'Tracking', 'rifle', true, tracking),
  sniper: toSpec('sniper', 'Sniper', 'sniper', false, sniper)
};

export const DEFAULT_WEAPON = 'rifle';

/** Resolve a weapon spec by id, falling back to the rifle. */
export function getWeapon(id) {
  return WEAPONS[id] || WEAPONS[DEFAULT_WEAPON];
}
