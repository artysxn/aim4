// ---------------------------------------------------------------------------
// replays/roles/teamPositions.js
// The position vocabulary the Roles & Positions table assigns from.
//
// Labels must match auto-assigned role labels in regionKeys.js (MAP_*_OPTIONS)
// for maps with painted-zone rules. Slot order is stable so stratbook
// roleNotes[i] stays aligned with each map's column.
//
// One list per map per side. AWP is always its own slot. This is the team's
// map pool, not the parsed library, so Overpass is here even with no demos.
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
    // Mid, A Lurk, Street, AWPer, B Lurk
    ANC: ['Mid', 'A Lurk', 'Street', 'AWPer', 'B Lurk'],
    // B Lower, B Upper, T Mid, AWPer, A Long
    DD2: ['B Lower', 'B Upper', 'T Mid', 'AWPer', 'A Long'],
    // Rotation, A Lurk, B / UG, AWPer, Mid
    MIR: ['Rotation', 'A Lurk', 'B / UG', 'AWPer', 'Mid'],
    // 1st Yard, Lobby, Rotation, AWPer, 2nd Yard
    NUK: ['1st Yard', 'Lobby', 'Rotation', 'AWPer', '2nd Yard'],
    // Banana, Ramp, 2nd Mid, AWPer, A Lurk
    INF: ['Banana', 'Ramp', '2nd Mid', 'AWPer', 'A Lurk'],
    OVP: ['A Site', 'B Site', 'Con', 'AWPer', 'Rotation'],
    // Mid, A Lurk, Water, AWPer, B Lurk
    ANU: ['Mid', 'A Lurk', 'Water', 'AWPer', 'B Lurk'],
    // Rotation, A Lurk, Mid, AWPer, B Lurk
    CCH: ['Rotation', 'A Lurk', 'Mid', 'AWPer', 'B Lurk']
  },
  CT: {
    // Mid, B Cave, B Site, AWPer, Mid / A
    ANC: ['Mid', 'B Cave', 'B Site', 'AWPer', 'Mid / A'],
    // A Short, A Long, B Mid, AWPer, B Anchor
    DD2: ['A Short', 'A Long', 'B Mid', 'AWPer', 'B Anchor'],
    // A Con, B Anchor, A Anchor, AWPer, B Short
    MIR: ['A Con', 'B Anchor', 'A Anchor', 'AWPer', 'B Short'],
    // Yard, A Site, Ramp, AWPer, A Door
    NUK: ['Yard', 'A Site', 'Ramp', 'AWPer', 'A Door'],
    // B Rotation, B Anchor, A Rotation, AWPer, A Anchor
    INF: ['B Rotation', 'B Anchor', 'A Rotation', 'AWPer', 'A Anchor'],
    OVP: ['A Site', 'B Monster', 'B Short', 'AWPer', 'B Rotation'],
    // B Con, A Anchor, Mid, AWPer, B Site
    ANU: ['B Con', 'A Anchor', 'Mid', 'AWPer', 'B Site'],
    // Mid, B Rotation, A Anchor, AWPer, B Anchor
    CCH: ['Mid', 'B Rotation', 'A Anchor', 'AWPer', 'B Anchor']
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
