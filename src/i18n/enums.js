// ---------------------------------------------------------------------------
// i18n/enums.js
// The English words the code chooses and then drops into a sentence.
//
// Most of what a slot captures is a nickname, a callout, a number or a clock,
// and those pass through a translation untouched because they do not inflect
// in any language the site speaks. These do not have that property. They are
// ordinary nouns, picked by a branch in the source rather than written into the
// sentence, and left alone they would leave English inside a Russian line:
//
//     shotMistakes.js       noGunLabel() -> "a knife"  ->  "{player} had a knife out"
//     tacticalMistakes.js   `${n} units`
//     playerScoutScan.js    NADE_WORD    -> "Molo"
//
// So each set is declared here with its English members, and a catalogue gives
// those members their forms in each language. A pattern then writes
// `{enum:item}` where the source wrote `{item}`, and the translation can put
// the noun in whatever case the sentence around it needs.
//
// Every member listed here must exist in every catalogue: catalogue.test.js
// fails the build otherwise, because a missing member is exactly the bug this
// file exists to prevent.
// ---------------------------------------------------------------------------

/**
 * @type {Record<string, {members: string[], from: string, note: string}>}
 */
export const ENUM_SETS = Object.freeze({
  /** `src/replays/coach/shotMistakes.js` noGunLabel(), substituted as {item}. */
  item: {
    members: ['the bomb', 'the zeus', 'a knife', 'a grenade'],
    from: 'src/replays/coach/shotMistakes.js',
    note: 'What the player had out instead of a gun. Carries an English article, so translations should give the noun in the case the sentence needs, article and all.'
  },

  /** `src/replays/coach/siteExecute.js` siteLabel(), substituted as {site}. */
  site: {
    members: ['A', 'B'],
    from: 'src/replays/coach/siteExecute.js',
    note: 'Bombsite letter. Stays A and B in every language: it is the in-game callout, not a word.'
  },

  /** `src/replays/analytics/playerScoutScan.js` and `strategy/utilityImport.js`. */
  nadeShort: {
    members: ['Smoke', 'Molo', 'Flash', 'Nade'],
    from: 'src/replays/analytics/playerScoutScan.js',
    note: 'Grenade words as they appear in a strategy note, e.g. "Smoke Jungle". Short is the point: these sit inside a line a player reads mid-round.'
  },

  /** `src/replays/analytics/antistratConfig.js` NADE_WORD, lowercase in prose. */
  nadeWord: {
    members: ['smoke', 'molotov', 'flash', 'HE'],
    from: 'src/replays/analytics/antistratConfig.js',
    note: 'Grenade words inside a sentence, e.g. "Throws A Ramp smoke". Lowercase except HE.'
  },

  /** `src/replays/strategy/roundNarrative.js` syncWord(). */
  syncWord: {
    members: ['HE', 'flash'],
    from: 'src/replays/strategy/roundNarrative.js',
    note: 'Used only inside "synced with X from Y".'
  },

  /** `src/replays/analytics/playerScoutScan.js` defaultName(). */
  defaultName: {
    members: ['A default', 'B default'],
    from: 'src/replays/analytics/playerScoutScan.js',
    note: 'The name of a side default. "default" is the tactical sense: the round the team runs when nothing is called.'
  },

  /** `src/replays/analytics/antistratConfig.js` PHASE_LABEL. */
  phase: {
    members: ['Early round', 'Midround', 'Late round'],
    from: 'src/replays/analytics/antistratConfig.js',
    note: 'When in the round something happens.'
  },

  /** `src/replays/analytics/antistratScan.js` weapon classes. */
  weaponClass: {
    members: ['Pistol', 'Shotgun', 'Grenade', 'Rifle', 'SMG', 'Sniper'],
    from: 'src/replays/analytics/antistratScan.js',
    note: 'Weapon categories in a buy table.'
  }
});

/** The set names, for validation on both sides. */
export const ENUM_NAMES = Object.freeze(Object.keys(ENUM_SETS));

/** English members of one set. */
export function enumMembers(set) {
  return ENUM_SETS[set]?.members || [];
}

/**
 * The English-to-English table, which is what a catalogue for English would
 * hold and what every other catalogue is checked against for completeness.
 */
export function englishEnums() {
  const out = {};
  for (const [name, def] of Object.entries(ENUM_SETS)) {
    out[name] = Object.fromEntries(def.members.map((m) => [m, m]));
  }
  return out;
}
