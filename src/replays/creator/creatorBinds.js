// ---------------------------------------------------------------------------
// replays/creator/creatorBinds.js
// Keyboard (and mouse) bindings for the 2D Strategy Creator.
// Stored in localStorage so a coach's layout survives reloads.
// ---------------------------------------------------------------------------

export const BINDS_STORAGE_KEY = 'aim4.creator.binds';

/**
 * @typedef {object} CreatorBinds
 * @property {string} moveUp
 * @property {string} moveDown
 * @property {string} moveLeft
 * @property {string} moveRight
 * @property {string} noclip
 * @property {string} fire
 * @property {string} util1  flashbang
 * @property {string} util2  smokegrenade
 * @property {string} util3  molotov
 * @property {string} util4  hegrenade
 */

/** @type {CreatorBinds} */
export const DEFAULT_BINDS = {
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  noclip: 'Space',
  fire: 'Mouse0',
  util1: 'Digit1',
  util2: 'Digit2',
  util3: 'Digit3',
  util4: 'Digit4'
};

/** Rows shown in the settings panel, in display order. */
export const BIND_ROWS = [
  { id: 'moveUp', label: 'Move up' },
  { id: 'moveDown', label: 'Move down' },
  { id: 'moveLeft', label: 'Move left' },
  { id: 'moveRight', label: 'Move right' },
  { id: 'fire', label: 'Fire / throw' },
  { id: 'noclip', label: 'Noclip (through walls)' },
  { id: 'util1', label: 'Flash' },
  { id: 'util2', label: 'Smoke' },
  { id: 'util3', label: 'Molotov' },
  { id: 'util4', label: 'HE' }
];

const CODE_LABELS = {
  Space: 'Space',
  Mouse0: 'LMB',
  Mouse1: 'RMB',
  Mouse2: 'MMB',
  Escape: 'Esc',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Tab: 'Tab',
  CapsLock: 'Caps',
  Backspace: 'Backspace'
};

/** Human-readable label for a KeyboardEvent.code or MouseN code. */
export function formatBindCode(code) {
  if (!code) return '—';
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code.startsWith('Numpad') && code.length > 6) return `Num ${code.slice(6)}`;
  if (code.startsWith('Mouse')) return `Mouse ${code.slice(5)}`;
  return code;
}

/** @returns {CreatorBinds} */
export function loadBinds() {
  try {
    const raw = JSON.parse(localStorage.getItem(BINDS_STORAGE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_BINDS };
    const out = { ...DEFAULT_BINDS };
    for (const key of Object.keys(DEFAULT_BINDS)) {
      const v = raw[key];
      if (typeof v === 'string' && v) out[key] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_BINDS };
  }
}

/** @param {Partial<CreatorBinds>} binds */
export function saveBinds(binds) {
  const next = { ...DEFAULT_BINDS, ...binds };
  localStorage.setItem(BINDS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * Which action(s) this physical code maps to. One code can only drive one
 * action at a time in the UI, but lookup still returns every match.
 * @param {CreatorBinds} binds
 * @param {string} code
 * @returns {string[]}
 */
export function actionsForCode(binds, code) {
  if (!code) return [];
  const hits = [];
  for (const [action, bound] of Object.entries(binds)) {
    if (bound === code) hits.push(action);
  }
  return hits;
}

/** Map util slot action → grenade type (NADE_SLOTS order for 1–4). */
export const UTIL_ACTION_TYPES = {
  util1: 'flashbang',
  util2: 'smokegrenade',
  util3: 'molotov',
  util4: 'hegrenade'
};
