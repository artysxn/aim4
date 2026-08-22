// ---------------------------------------------------------------------------
// src/agents/trainerWeapons.js
// Which CS2 weapon each of the trainer's three stands for.
//
// Its own module, and free of any import, for two reasons: the mapping is the
// one place that decides what an "AK" means here and it should not be spread
// across the files that consume it, and everything downstream of it (the
// ballistics, the viewmodel, the tests) can then read it without dragging in
// the pack loader — which imports the glTF addons through a Vite-only
// specifier and cannot be loaded under node at all.
// ---------------------------------------------------------------------------

/**
 * Trainer weapon model id (`src/weapons/index.js` `model`) → the CS2 weapon.
 *
 *     rifle    → ak47           (src/weapons/ak47.js is the AK's own table)
 *     pistol   → usp_silencer   (pistol.js: "USP-style semi-automatic")
 *     sniper   → awp            (sniper.js: "Copies the CS AWP")
 */
export const TRAINER_WEAPONS = Object.freeze({
  rifle: 'ak47',
  pistol: 'usp_silencer',
  sniper: 'awp'
});

/** The CS2 weapon a trainer weapon spec should be drawn and fired as. */
export function weaponNameFor(spec) {
  return TRAINER_WEAPONS[spec?.model] || TRAINER_WEAPONS.rifle;
}
