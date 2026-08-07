// ---------------------------------------------------------------------------
// Role labels for Statistics / Charts.
// Map-specific columns use painted-zone roles on INF/DD2/ANU/CCH, and the
// generic Pack/Lurk + Anchor/Rotation set elsewhere.
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

function def(label, tactical, how) {
  return { label, tactical, how };
}

/** T positions (single-map column). */
export const T_POSITIONS = {
  awper: def(
    'AWPer',
    'AWPer',
    'Most rounds on the team with an AWP out on T (rounds held / kills / shots).'
  ),
  aLurk: def(
    'A Lurk',
    'Lurk',
    'A-side lurk. Generic maps: low spatial diversity, closer to bombsite A. Map rules use painted zones.'
  ),
  bLurk: def(
    'B Lurk',
    'Lurk',
    'B-side lurk. Generic maps: low spatial diversity, closer to bombsite B. Map rules use painted zones.'
  ),
  lurk: def(
    'Lurk',
    'Lurk',
    'Low spatial diversity of mid-round positions (stable spots). Used when A/B sites are unavailable.'
  ),
  pack: def(
    'Pack',
    'Pack',
    'One of the two highest spatial-diversity riflers on T. Map rules split Pack into named roles.'
  ),
  // Inferno
  banana: def('Banana', 'Lurk', 'Inferno: most Banana, least T Aps and 2nd Mid.'),
  ramp: def('Ramp', 'Pack', 'Inferno: more Ramp and Banana; less 2nd Mid and T Aps than 2nd Mid.'),
  secondMid: def('2nd Mid', 'Pack', 'Inferno: more 2nd Mid and T Aps than Ramp.'),
  // Dust2
  aLong: def('A Long', 'Lurk', 'Dust2: most A Long; strong T Long.'),
  bUpper: def('B Upper', 'Lurk', 'Dust2: most B Tunnels; least elsewhere.'),
  bLower: def('B Lower', 'Pack', 'Dust2: B Tunnels lean plus T Mid / CT Mid / A Short.'),
  tMid: def('T Mid', 'Pack', 'Dust2: most T Mid; often T Spawn and T Long.'),
  // Anubis / Cache / Ancient pack splits
  packMid: def('Mid', 'Pack', 'Pack Mid: most T Mid (and map Mid zones) among the pack.'),
  water: def('Water', 'Pack', 'Anubis: most T Con; sometimes A Water.'),
  packRotation: def(
    'Rotation',
    'Pack',
    'Pack Rotation leftover (Cache / Mirage): usually not most in any one zone.'
  ),
  street: def('Street', 'Pack', 'Ancient: most B Street; often B Ramp and B Cave.'),
  bUg: def(
    'B / UG',
    'Lurk',
    'Mirage: most Underground; often T Spawn, B Aps, Mid, sometimes T Mid.'
  ),
  // Nuke
  lobby: def('Lobby', 'Lurk', 'Nuke: most Lobby.'),
  firstYard: def(
    '1st Yard',
    'Lurk',
    'Nuke: most T Yard / Yard; often CT Yard or Secret.'
  ),
  secondYard: def(
    '2nd Yard',
    'Pack',
    'Nuke: most Silo; often Lobby and Yard / Secret.'
  )
};

/** CT positions (single-map column). */
export const CT_POSITIONS = {
  awper: def(
    'AWPer',
    'AWPer',
    'Most rounds on the team with an AWP out on CT (rounds held / kills / shots).'
  ),
  aAnchor: def(
    'A Anchor',
    'Anchor',
    'A-site anchor. Generic maps: low PSDT with A affinity. Map rules use painted zones.'
  ),
  bAnchor: def(
    'B Anchor',
    'Anchor',
    'B-site anchor. Generic maps: low PSDT with B affinity. Map rules use painted zones.'
  ),
  anchor: def(
    'Anchor',
    'Anchor',
    'Low pulled-string distance travelled on CT full buys. Used when A/B sites are unavailable.'
  ),
  aRotation: def(
    'A Rotation',
    'Rotation',
    'A-side rotation. Generic maps: high PSDT with A affinity. Map rules use painted zones.'
  ),
  bRotation: def(
    'B Rotation',
    'Rotation',
    'B-side rotation. Generic maps: high PSDT with B affinity. Map rules use painted zones.'
  ),
  rotation: def(
    'Rotation',
    'Rotation',
    'High pulled-string distance travelled on CT full buys. Used when A/B sites are unavailable.'
  ),
  // Dust2
  aLong: def('A Long', 'Anchor', 'Dust2: most A Long + A CT.'),
  aShort: def('A Short', 'Rotation', 'Dust2: 2nd most A Long + A CT; A Site / A Short lean.'),
  bMid: def('B Mid', 'Rotation', 'Dust2: most CT Mid; 2nd most B Site.'),
  // Anubis / Cache / Ancient Mid
  mid: def(
    'Mid',
    'Rotation',
    'CT Mid role (Anubis: A Mid; Cache: CT Mid; Ancient: CT Mid / Donut lean).'
  ),
  midA: def(
    'Mid / A',
    'Anchor',
    'Ancient: Mid-side rifler with more A Site and CT Spawn than Mid.'
  ),
  // Anubis / Ancient B rename
  bSite: def('B Site', 'Anchor', 'Most B Site (Anubis / Ancient).'),
  bCon: def('B Con', 'Rotation', 'Anubis: most CT Con; usually 2nd most B Site.'),
  bCave: def('B Cave', 'Rotation', 'Ancient: most B Cave; sometimes B Site and B Street.'),
  // Mirage
  bShort: def(
    'B Short',
    'Rotation',
    'Mirage: most B Short; sometimes A Jungle, Mid, and B Site.'
  ),
  aCon: def(
    'A Con',
    'Rotation',
    'Mirage: most A Jungle; sometimes A Site, Mid, B Short, CT Spawn.'
  ),
  // Nuke
  aSiteNuke: def(
    'A Site',
    'Anchor',
    'Nuke: most A Anchor zone; often shares A Door / Heaven / Hell.'
  ),
  aDoor: def(
    'A Door',
    'Rotation',
    'Nuke: most A Door; sometimes Lobby or CT Yard.'
  ),
  ramp: def(
    'Ramp',
    'Anchor',
    'Nuke: most Ramp (upper and lower); sometimes CT Heaven / Hell.'
  ),
  outside: def(
    'Yard',
    'Rotation',
    'Nuke: most CT Yard / Yard (Outside); sometimes A Door and Heaven / Hell.'
  )
};

export const T_TACTICAL = [
  {
    label: 'AWPer',
    how: 'AWPer position on a majority of maps they played on T.'
  },
  {
    label: 'Lurk',
    how: 'More Lurk map-positions (A/B Lurk and map lurk aliases) than Pack across maps on T.'
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
    how: 'More Anchor map-positions than Rotation across maps on CT.'
  },
  {
    label: 'Rotation',
    how: 'More Rotation map-positions than Anchor across maps on CT.'
  }
];

const GENERIC_T = [T_POSITIONS.awper, T_POSITIONS.aLurk, T_POSITIONS.bLurk, T_POSITIONS.pack];
const GENERIC_CT = [
  CT_POSITIONS.awper,
  CT_POSITIONS.aAnchor,
  CT_POSITIONS.bAnchor,
  CT_POSITIONS.aRotation,
  CT_POSITIONS.bRotation
];

/** Per-map filter chips (position labels). */
const MAP_T_OPTIONS = {
  INF: [T_POSITIONS.awper, T_POSITIONS.aLurk, T_POSITIONS.banana, T_POSITIONS.ramp, T_POSITIONS.secondMid],
  DD2: [T_POSITIONS.awper, T_POSITIONS.aLong, T_POSITIONS.tMid, T_POSITIONS.bLower, T_POSITIONS.bUpper],
  ANU: [T_POSITIONS.awper, T_POSITIONS.aLurk, T_POSITIONS.bLurk, T_POSITIONS.packMid, T_POSITIONS.water],
  CCH: [
    T_POSITIONS.awper,
    T_POSITIONS.aLurk,
    T_POSITIONS.bLurk,
    T_POSITIONS.packMid,
    T_POSITIONS.packRotation
  ],
  ANC: [
    T_POSITIONS.awper,
    T_POSITIONS.aLurk,
    T_POSITIONS.bLurk,
    T_POSITIONS.packMid,
    T_POSITIONS.street
  ],
  MIR: [
    T_POSITIONS.awper,
    T_POSITIONS.aLurk,
    T_POSITIONS.bUg,
    T_POSITIONS.packMid,
    T_POSITIONS.packRotation
  ],
  NUK: [
    T_POSITIONS.awper,
    T_POSITIONS.lobby,
    T_POSITIONS.firstYard,
    T_POSITIONS.secondYard,
    T_POSITIONS.packRotation
  ]
};

const MAP_CT_OPTIONS = {
  INF: GENERIC_CT,
  DD2: [
    CT_POSITIONS.awper,
    CT_POSITIONS.aLong,
    CT_POSITIONS.aShort,
    CT_POSITIONS.bMid,
    CT_POSITIONS.bAnchor
  ],
  ANU: [
    CT_POSITIONS.awper,
    CT_POSITIONS.aAnchor,
    CT_POSITIONS.mid,
    CT_POSITIONS.bSite,
    CT_POSITIONS.bCon
  ],
  CCH: [
    CT_POSITIONS.awper,
    CT_POSITIONS.aAnchor,
    CT_POSITIONS.mid,
    CT_POSITIONS.bAnchor,
    CT_POSITIONS.bRotation
  ],
  ANC: [
    CT_POSITIONS.awper,
    CT_POSITIONS.midA,
    CT_POSITIONS.mid,
    CT_POSITIONS.bSite,
    CT_POSITIONS.bCave
  ],
  MIR: [
    CT_POSITIONS.awper,
    CT_POSITIONS.aAnchor,
    CT_POSITIONS.bAnchor,
    CT_POSITIONS.aCon,
    CT_POSITIONS.bShort
  ],
  NUK: [
    CT_POSITIONS.awper,
    CT_POSITIONS.aSiteNuke,
    CT_POSITIONS.aDoor,
    CT_POSITIONS.ramp,
    CT_POSITIONS.outside
  ]
};

/**
 * Filter options for a single map (position labels).
 * @param {'T'|'CT'} side
 * @param {string} [mapCode]
 */
export function positionRoleOptions(side, mapCode = '') {
  const map = String(mapCode || '').toUpperCase();
  if (side === 'CT') return MAP_CT_OPTIONS[map] || GENERIC_CT;
  return MAP_T_OPTIONS[map] || GENERIC_T;
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
