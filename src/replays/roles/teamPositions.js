// ---------------------------------------------------------------------------
// replays/roles/teamPositions.js
// The position vocabulary the Roles & Positions table assigns from.
//
// One list per map per side, in the order a coach reads them (entry side
// first, AWP always its own slot). This is the team's map pool, not the parsed
// library, so Overpass is here even though no demo has been indexed on it.
// ---------------------------------------------------------------------------

/** Map pool for the roles table, in the order the columns appear. */
export const POSITION_MAPS = [
  { code: 'ANC', name: 'Ancient' },
  { code: 'DD2', name: 'Dust2' },
  { code: 'MIR', name: 'Mirage' },
  { code: 'NUK', name: 'Nuke' },
  { code: 'INF', name: 'Inferno' },
  { code: 'OVP', name: 'Overpass' },
  { code: 'ANU', name: 'Anubis' },
  { code: 'CCH', name: 'Cache' }
];

/** @type {Record<'T'|'CT', Record<string, string[]>>} */
export const POSITIONS = {
  T: {
    ANC: ['Mid', 'A Site', 'B Street', 'AWP', 'B Site'],
    DD2: ['B Lower', 'B Upper', 'Mid', 'AWP', 'A Long'],
    MIR: ['Rotation', 'A Site', 'B / UG', 'AWP', 'Mid'],
    NUK: ['1. Yard', 'Lobby', 'Rotation', 'AWP', '2. Yard'],
    INF: ['Banana', 'Rotation', 'Mid', 'AWP', 'A Site'],
    OVP: ['A Site', 'B Site', 'Con', 'AWP', 'Rotation'],
    ANU: ['Mid', 'A Site', 'Water', 'AWP', 'B Site'],
    CCH: ['Rotation', 'A Site', 'Mid', 'AWP', 'B Site']
  },
  CT: {
    ANC: ['Mid', 'B Cave', 'B Site', 'AWP', 'A / Mid'],
    DD2: ['A Short', 'A Long', 'B / Mid', 'AWP', 'B Site'],
    MIR: ['A Con', 'B Site', 'A Site', 'AWP', 'B Short'],
    NUK: ['Yard', 'A Site', 'Ramp', 'AWP', 'A Door'],
    INF: ['B Banana', 'B Site', 'A Rotation', 'AWP', 'A Pit'],
    OVP: ['A Site', 'B Monster', 'B Short', 'AWP', 'B Rotation'],
    ANU: ['B Con', 'A Site', 'Mid', 'AWP', 'B Site'],
    CCH: ['A / Mid', 'B Rotation', 'A Site', 'AWP', 'B Site']
  }
};

/**
 * @param {'T'|'CT'} side
 * @param {string} mapCode
 * @returns {string[]}
 */
export function positionsFor(side, mapCode) {
  return POSITIONS[side === 'CT' ? 'CT' : 'T'][mapCode] || [];
}

/** The map name shown in a column heading. */
export function positionMapName(code) {
  return POSITION_MAPS.find((m) => m.code === code)?.name || code;
}
