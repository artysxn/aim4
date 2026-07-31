// ---------------------------------------------------------------------------
// Role labels for Statistics / Charts.
// Map-specific columns use A/B Lurk, Pack, A/B Anchor, A/B Rotation, AWPer.
// Cross-map columns use Lurk / Pack / Anchor / Rotation / AWPer.
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

/** @deprecated Inferno painted-region aliases (legacy presence). */
export const AREA = {
  banana: ['banana'],
  bSite: ['b site', 'bsite'],
  tSpawn: ['t spawn', 'tspawn'],
  aps: ['aps', 'apps', 'apartments'],
  midLong: ['mid long', 'midlong'],
  aSite: ['a site', 'asite']
};

/** @deprecated */
export const ZONE = {
  topBanana: ['top banana', 'topbanana'],
  bSite: ['b site', 'bsite'],
  bCt: ['b ct', 'bct', 'ct b'],
  banana: ['banana'],
  midLong: ['mid long', 'midlong'],
  aSite: ['a site', 'asite'],
  aps: ['aps', 'apps', 'apartments']
};

/** @deprecated Compact keys for legacy region bags. */
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

/** @deprecated */
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
    how: 'Most rounds on the team with an AWP out on T (rounds held / kills / shots).'
  },
  aLurk: {
    label: 'A Lurk',
    tactical: 'Lurk',
    how: 'One of the two lowest spatial-diversity riflers on T; closer to bombsite A than B on average. Counts as Lurk.'
  },
  bLurk: {
    label: 'B Lurk',
    tactical: 'Lurk',
    how: 'One of the two lowest spatial-diversity riflers on T; closer to bombsite B than A on average. Counts as Lurk.'
  },
  lurk: {
    label: 'Lurk',
    tactical: 'Lurk',
    how: 'Low spatial diversity of mid-round positions (stable spots). Used when A/B sites are unavailable.'
  },
  pack: {
    label: 'Pack',
    tactical: 'Pack',
    how: 'One of the two highest spatial-diversity riflers on T — positions vary with the round plan.'
  }
};

/** CT positions (single-map column). */
export const CT_POSITIONS = {
  awper: {
    label: 'AWPer',
    tactical: 'AWPer',
    how: 'Most rounds on the team with an AWP out on CT (rounds held / kills / shots).'
  },
  aAnchor: {
    label: 'A Anchor',
    tactical: 'Anchor',
    how: 'One of the two lowest PSDT riflers on CT full buys; closer to bombsite A than B most rounds. Counts as Anchor.'
  },
  bAnchor: {
    label: 'B Anchor',
    tactical: 'Anchor',
    how: 'One of the two lowest PSDT riflers on CT full buys; closer to bombsite B than A most rounds. Counts as Anchor.'
  },
  anchor: {
    label: 'Anchor',
    tactical: 'Anchor',
    how: 'Low pulled-string distance travelled on CT full buys. Used when A/B sites are unavailable.'
  },
  aRotation: {
    label: 'A Rotation',
    tactical: 'Rotation',
    how: 'One of the two highest PSDT riflers on CT full buys; closer to bombsite A than B most rounds. Counts as Rotation.'
  },
  bRotation: {
    label: 'B Rotation',
    tactical: 'Rotation',
    how: 'One of the two highest PSDT riflers on CT full buys; closer to bombsite B than A most rounds. Counts as Rotation.'
  },
  rotation: {
    label: 'Rotation',
    tactical: 'Rotation',
    how: 'High pulled-string distance travelled on CT full buys. Used when A/B sites are unavailable.'
  }
};

export const T_TACTICAL = [
  {
    label: 'AWPer',
    how: 'AWPer position on a majority of maps they played on T.'
  },
  {
    label: 'Lurk',
    how: 'More Lurk map-positions (A/B Lurk) than Pack across maps on T.'
  },
  {
    label: 'Pack',
    how: 'More Pack map-positions than Lurk across maps on T.'
  }
];

export const CT_TACTICAL = [
  {
    label: 'AWPer',
    how: 'AWPer position on a majority of maps they played on CT.'
  },
  {
    label: 'Anchor',
    how: 'More Anchor map-positions (A/B Anchor) than Rotation across maps on CT.'
  },
  {
    label: 'Rotation',
    how: 'More Rotation map-positions (A/B Rotation) than Anchor across maps on CT.'
  }
];

/** Filter options for a single map (position labels, no generic fallbacks). */
export function positionRoleOptions(side) {
  if (side === 'CT') {
    return [
      CT_POSITIONS.awper,
      CT_POSITIONS.aAnchor,
      CT_POSITIONS.bAnchor,
      CT_POSITIONS.aRotation,
      CT_POSITIONS.bRotation
    ];
  }
  return [T_POSITIONS.awper, T_POSITIONS.aLurk, T_POSITIONS.bLurk, T_POSITIONS.pack];
}

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
