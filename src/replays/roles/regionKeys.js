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
  awper: { label: 'AWPer', tactical: 'AWPer' },
  bSite: { label: 'B Site', tactical: 'Lurker' },
  bRotation: { label: 'B Rotation', tactical: 'Rotation' },
  aRotation: { label: 'A Rotation', tactical: 'Rotation' },
  aSite: { label: 'A Site', tactical: 'Lurker' }
};

/** CT positions (single-map column). */
export const CT_POSITIONS = {
  awper: { label: 'AWPer', tactical: 'AWPer' },
  bAggro: { label: 'B Aggro', tactical: 'Rotation' },
  bSite: { label: 'B Site', tactical: 'Anchor' },
  aRotation: { label: 'A Rotation', tactical: 'Rotation' },
  aSite: { label: 'A Site', tactical: 'Anchor' }
};

export const T_TACTICAL = ['AWPer', 'Lurker', 'Rotation'];
export const CT_TACTICAL = ['AWPer', 'Anchor', 'Rotation'];
