// ---------------------------------------------------------------------------
// lib/gamemodeCatalog.js
// Pure gamemode metadata shared by the trainer UI and the aim4.io site menus.
// No engine imports here: the landing page bundles this without Three.js.
// The scenario ids must stay in sync with SCENARIOS in core/SceneManager.js.
// ---------------------------------------------------------------------------

export const SCENARIO_META = {
  gridshot: { title: 'Gridshot', dualPlay: true, tags: ['Speed', 'Accuracy'] },
  stars: { title: 'Stars', dualPlay: true, tags: ['Accuracy'] },
  bounce: { title: 'Bounce (Clicks)', dualPlay: true, tags: ['Speed', 'Reactions'] },
  microflicks: { title: 'Microflicks', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  pasu: { title: 'Pasu (Clicks)', dualPlay: true, tags: ['Accuracy', 'Reactions', 'Control'] },
  spidershot: { title: 'Spidershot', dualPlay: true, tags: ['Speed', 'Reactions'] },
  survival: { title: 'Survival', dualPlay: true, tags: ['Speed', 'Control'] },
  expand: { title: 'Expand', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  arena: { title: 'Crossfire (Clicks)', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  snipercrossfire: { title: 'Crossfire (AWP)', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  duels: { title: 'Duels', dualPlay: true, tags: ['Movement', 'Reactions'] },
  range: { title: 'Range', dualPlay: true, tags: ['Movement'] },
  tracking: { title: 'Strafes', dualPlay: true, tags: ['Accuracy'] },
  rapidtrack: { title: 'Rapidtrack', dualPlay: true, tags: ['Movement', 'Control', 'Reactions'] },
  deathmatch: { title: 'Deathmatch', dualPlay: true, tags: ['Movement', 'Speed', 'Control'] },
  sequence: { title: 'Sequence (Clicks)', dualPlay: true, tags: ['Speed', 'Accuracy', 'Reactions'] },
  sequencespeed: { title: 'Sequence (Speed)', dualPlay: true, tags: ['Accuracy', 'Speed'] },
  sequencetracking: { title: 'Sequence (Tracking)', dualPlay: true, tags: ['Control', 'Speed'] },
  double: { title: 'Double (Clicks)', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  doubletracking: { title: 'Double (Tracking)', dualPlay: true, tags: ['Control', 'Speed'] },
  ball: { title: 'Ball', dualPlay: true, tags: ['Accuracy', 'Control'] },
  bouncetracking: { title: 'Bounce (Tracking)', dualPlay: true, tags: ['Control', 'Reactions'] },
  pasutracking: { title: 'Pasu (Tracking)', dualPlay: true, tags: ['Accuracy', 'Control'] },
  turn: { title: 'Turn', dualPlay: true, tags: ['Accuracy', 'Reactions'] },
  box: { title: 'Box', dualPlay: true, tags: ['Accuracy', 'Control'] },
  circle: { title: 'Circle', dualPlay: true, tags: ['Accuracy', 'Control'] },
  threeshot: { title: 'Threeshot', dualPlay: true, tags: ['Speed', 'Accuracy'] },
  cover: { title: 'Cover (Rifle)', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  coverawp: { title: 'Cover (AWP)', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  drone: { title: 'Drone', dualPlay: true, tags: ['Accuracy', 'Control'] },
  line: { title: 'Line', dualPlay: true, tags: ['Control', 'Speed'] },
  loops: { title: 'Loops (Static)', dualPlay: true, tags: ['Speed', 'Control'] },
  loopstracking: { title: 'Loops (Tracking)', dualPlay: true, tags: ['Control', 'Accuracy'] },
  galaxy: { title: 'Galaxy', dualPlay: false, challenge: true, tags: ['Control', 'Speed', 'Accuracy'] },
  waves: { title: 'Waves', dualPlay: false, challenge: true, tags: ['Control', 'Speed', 'Accuracy'] },
  sequenceultra: { title: 'Sequence (Ultra)', dualPlay: false, challenge: true, tags: ['Control', 'Reactions', 'Accuracy'] },
  reactiontime: { title: 'Reaction time', dualPlay: false, challenge: true, tags: ['Speed', 'Reactions'] },
  sniperholds: { title: 'Duels (AWP)', dualPlay: true, tags: ['Accuracy', 'Control'] },
  sniperquickscopes: { title: 'Pit (AWP)', dualPlay: true, tags: ['Reactions', 'Control'] },
  pitrifle: { title: 'Pit (Rifle)', dualPlay: true, tags: ['Reactions', 'Control'] },
  sniperflicks: { title: 'Flicks (AWP)', dualPlay: true, tags: ['Reactions', 'Accuracy'] },
  snipertracking: { title: 'Tracking (AWP)', dualPlay: true, tags: ['Control'] },
  doorsawp: { title: 'Doors (AWP)', dualPlay: true, tags: ['Speed', 'Reactions'] },
  peekswitch: { title: 'Peekswitch (Static)', dualPlay: true, tags: ['Movement', 'Speed', 'Reactions'] },
  peekswitchbots: { title: 'Peekswitch (Bots)', dualPlay: true, tags: ['Movement', 'Speed', 'Reactions'] }
};

// Training sub-menus. A mode may appear in several categories; any registered
// non-challenge mode not placed anywhere is appended to General so nothing
// goes missing. "all" browses every non-challenge mode; "challenges" houses
// the hard fixed-rule variants and only ever shows those.
export const TRAINING_CATEGORIES = [
  { id: 'precision', title: 'Precision', modes: ['microflicks', 'stars', 'threeshot', 'survival', 'expand', 'pasu', 'arena', 'snipercrossfire', 'turn', 'sequencespeed', 'sequencetracking', 'sniperholds', 'peekswitch', 'peekswitchbots'] },
  { id: 'tracking', title: 'Tracking', modes: ['tracking', 'rapidtrack', 'ball', 'drone', 'line', 'loops', 'loopstracking', 'box', 'circle', 'bouncetracking', 'pasutracking', 'doubletracking', 'sequencetracking', 'snipertracking'] },
  { id: 'speed', title: 'Speed', modes: ['gridshot', 'stars', 'threeshot', 'bounce', 'spidershot', 'sequence', 'sequencespeed', 'line', 'loops', 'sniperquickscopes', 'pitrifle', 'doorsawp'] },
  { id: 'flicking', title: 'Flicking', modes: ['spidershot', 'microflicks', 'sequence', 'sequencespeed', 'double', 'doubletracking', 'cover', 'coverawp', 'sniperflicks', 'snipercrossfire', 'expand'] },
  { id: 'sniping', title: 'Sniping', modes: ['sniperquickscopes', 'coverawp', 'sniperholds', 'sniperflicks', 'snipertracking', 'snipercrossfire', 'doorsawp'] },
  { id: 'general', title: 'General', modes: ['deathmatch', 'range', 'duels', 'cover', 'coverawp', 'sniperholds', 'sniperquickscopes', 'pitrifle', 'sniperflicks', 'snipertracking', 'snipercrossfire', 'doorsawp', 'peekswitch', 'peekswitchbots', 'rapidtrack'] },
  { id: 'challenges', title: 'Challenges', modes: ['galaxy', 'sequenceultra', 'waves', 'reactiontime'] },
  { id: 'all', title: 'All', modes: [] }
];

export const GAMEMODE_IDS = Object.keys(SCENARIO_META);

export const isChallengeMode = (m) => !!SCENARIO_META[m]?.challenge;

export function gamemodeTitle(id) {
  return SCENARIO_META[id]?.title || id;
}

export function sortModesByTitle(modes) {
  return [...modes].sort((a, b) =>
    gamemodeTitle(a).toLowerCase().localeCompare(gamemodeTitle(b).toLowerCase())
  );
}

/** Mode ids for a category tile, resolved exactly like the in-game menu. */
export function trainingCategoryModes(id, registered = GAMEMODE_IDS) {
  const cat = TRAINING_CATEGORIES.find((c) => c.id === id);
  if (!cat) return [];
  const known = new Set(registered);
  if (id === 'all') {
    return sortModesByTitle(registered.filter((m) => !isChallengeMode(m)));
  }
  if (id !== 'general') {
    return sortModesByTitle(cat.modes.filter((m) => known.has(m)));
  }
  const placed = new Set(TRAINING_CATEGORIES.flatMap((c) => c.modes));
  const strays = registered.filter((m) => !placed.has(m) && !isChallengeMode(m));
  return sortModesByTitle([...cat.modes.filter((m) => known.has(m)), ...strays]);
}

export function modeCountLabel(n) {
  return `${n} mode${n === 1 ? '' : 's'}`;
}

/** Config key of the public leaderboard for a mode (mirrors scenario classes). */
export function lbConfigKeyFor(id) {
  return isChallengeMode(id) ? 'challenge' : 'competitive';
}
