// ---------------------------------------------------------------------------
// Named Inferno (and future) regions for role assignment.
// Matching is fuzzy on normalized names from the Position Editor.
// ---------------------------------------------------------------------------

/** Lowercase, collapse punctuation → spaces. */
export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when a zone/area/position name matches any alias.
 * @param {string} name
 * @param {string[]} aliases  already-normalized aliases
 */
export function nameMatches(name, aliases) {
  const n = normName(name);
  if (!n) return false;
  for (const a of aliases) {
    if (!a) continue;
    if (n === a || n.includes(a) || a.includes(n)) return true;
  }
  return false;
}

/** Area-level aliases (JSON `areas`). */
export const AREA = {
  banana: ['banana'],
  bSite: ['b site', 'bsite'],
  tSpawn: ['t spawn', 'tspawn'],
  aps: ['aps', 'apps', 'apartments'],
  midLong: ['mid long', 'midlong'],
  aSite: ['a site', 'asite']
};

/** Zone-level aliases (JSON `sections`). */
export const ZONE = {
  topBanana: ['top banana', 'topbanana'],
  bSite: ['b site', 'bsite'],
  bCt: ['b ct', 'bct', 'ct b'],
  banana: ['banana'],
  midLong: ['mid long', 'midlong'],
  aSite: ['a site', 'asite'],
  aps: ['aps', 'apps', 'apartments']
};

/** Compact keys stored on stats rows. */
export const RK = {
  BANANA: 'bn',
  B_SITE: 'bs',
  T_SPAWN: 'ts',
  APS: 'ap',
  MID_LONG: 'ml',
  A_SITE: 'as',
  TOP_BANANA: 'tb',
  B_CT: 'bc'
};

/**
 * Map area/section name → storage keys to increment.
 * @param {'area'|'zone'} kind
 * @param {string} name
 * @returns {string[]}
 */
export function keysForName(kind, name) {
  const out = [];
  if (kind === 'area') {
    if (nameMatches(name, AREA.banana)) out.push(RK.BANANA);
    if (nameMatches(name, AREA.bSite)) out.push(RK.B_SITE);
    if (nameMatches(name, AREA.tSpawn)) out.push(RK.T_SPAWN);
    if (nameMatches(name, AREA.aps)) out.push(RK.APS);
    if (nameMatches(name, AREA.midLong)) out.push(RK.MID_LONG);
    if (nameMatches(name, AREA.aSite)) out.push(RK.A_SITE);
  } else {
    if (nameMatches(name, ZONE.topBanana)) out.push(RK.TOP_BANANA);
    if (nameMatches(name, ZONE.bSite)) out.push(RK.B_SITE);
    if (nameMatches(name, ZONE.bCt)) out.push(RK.B_CT);
    if (nameMatches(name, ZONE.banana)) out.push(RK.BANANA);
    if (nameMatches(name, ZONE.midLong)) out.push(RK.MID_LONG);
    if (nameMatches(name, ZONE.aSite)) out.push(RK.A_SITE);
    if (nameMatches(name, ZONE.aps)) out.push(RK.APS);
  }
  return out;
}

/** T positions (single-map column). */
export const T_POSITIONS = {
  awper: {
    label: 'AWPer',
    tactical: 'AWPer',
    how: 'Most rounds on the team with an AWP on T.'
  },
  bSite: {
    label: 'B Site',
    tactical: 'Lurker',
    how: 'Most rounds spent in the Banana and/or B Site areas on T. Counts as Lurker.'
  },
  bRotation: {
    label: 'B Rotation',
    tactical: 'Rotation',
    how: '2nd-most rounds in T Spawn & Banana (behind B Site), with fewer AWP rounds than the AWPer. Counts as Rotation.'
  },
  aRotation: {
    label: 'A Rotation',
    tactical: 'Rotation',
    how: '2nd-most rounds in Aps, Mid Long, and A Site (behind A Site). Counts as Rotation.'
  },
  aSite: {
    label: 'A Site',
    tactical: 'Lurker',
    how: 'Most rounds spent in the Aps area on T. Counts as Lurker.'
  }
};

/** CT positions (single-map column). */
export const CT_POSITIONS = {
  awper: {
    label: 'AWPer',
    tactical: 'AWPer',
    how: 'Most rounds on the team with an AWP on CT.'
  },
  bAggro: {
    label: 'B Aggro',
    tactical: 'Rotation',
    how: 'One of the two players with the most time in B Site + Banana. More opening duels and more time in Top Banana while the other holds B Site / B CT. Counts as Rotation.'
  },
  bSite: {
    label: 'B Site',
    tactical: 'Anchor',
    how: 'The other B duo player — fewer openings, more time on B Site / B CT. Counts as Anchor.'
  },
  aRotation: {
    label: 'A Rotation',
    tactical: 'Rotation',
    how: 'Less AWP than the AWPer; less time on Mid Long + A Site than the A Site player. Counts as Rotation.'
  },
  aSite: {
    label: 'A Site',
    tactical: 'Anchor',
    how: 'Less AWP than the AWPer; most time on A Site, Mid Long, and Aps, least on B. Counts as Anchor.'
  }
};

export const T_TACTICAL = [
  {
    label: 'AWPer',
    how: 'AWPer position on a majority of maps they played on T.'
  },
  {
    label: 'Lurker',
    how: 'More Lurker map-positions (A Site / B Site) than Rotation across maps on T.'
  },
  {
    label: 'Rotation',
    how: 'More Rotation map-positions (A / B Rotation) than Lurker across maps on T.'
  }
];

export const CT_TACTICAL = [
  {
    label: 'AWPer',
    how: 'AWPer position on a majority of maps they played on CT.'
  },
  {
    label: 'Anchor',
    how: 'More Anchor map-positions (A Site / B Site) than Rotation across maps on CT.'
  },
  {
    label: 'Rotation',
    how: 'More Rotation map-positions (A Rotation / B Aggro) than Anchor across maps on CT.'
  }
];

/** Lookup how-text for a position or tactical label. */
export function roleHowText(side, label, mode = 'position') {
  const want = String(label || '').trim();
  if (!want) return '';
  if (mode === 'tactical') {
    const list = side === 'CT' ? CT_TACTICAL : T_TACTICAL;
    return list.find((r) => r.label === want)?.how || '';
  }
  const map = side === 'CT' ? CT_POSITIONS : T_POSITIONS;
  for (const def of Object.values(map)) {
    if (def.label === want) return def.how;
  }
  return '';
}
