// ---------------------------------------------------------------------------
// replays/gif/perspectivePicker.js
// Choosing what a visual note is seen from: any players, each first or third
// person, and any of the other cameras, in one note. The note creator in the
// viewer and the editor in Bookmarks both use it.
//
// A player's button goes first person, third person, off, so one note can hold
// one player's eyes and another's shoulder without a second control for it.
// ---------------------------------------------------------------------------

import { MAX_PERSPECTIVES } from './gifMeta.js';
import { throwsInPart } from './perspectives.js';

/** The buttons under the players. `camera` only shows while there is a 3D view to take a camera from. */
const OTHERS = [
  { key: 'map', label: '2D map' },
  { key: 'overview', label: 'Overview' },
  { key: 'camera', label: 'Free camera', title: 'Where the 3D view on screen is now' },
  { key: 'landing3d', label: 'Landing 3D', title: 'Where each grenade comes down, in 3D' },
  { key: 'landing2d', label: 'Landing 2D', title: 'Where each grenade comes down, on the map' }
];

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {(s: string) => string} opts.escapeHtml
 * @param {() => void} [opts.onChange]
 * @param {() => object|null} [opts.cameraPose]  the 3D view's camera, when there is one
 */
export function createPerspectivePicker({ host, escapeHtml, onChange = () => {}, cameraPose = () => null }) {
  host.classList.add('rv-pp');
  /** slot -> 'pov' | 'third' */
  const players = new Map();
  const others = new Set();
  let roster = [];
  let meta = null;

  function paint() {
    const row = (side) => {
      const list = roster.filter((p) => p.side === side);
      if (!list.length) return '';
      return `<div class="rv-pp-row" role="group" aria-label="${side} players">${list
        .map((p) => {
          const mode = players.get(p.slot) || '';
          const tag = mode === 'third' ? '3rd' : mode === 'pov' ? '1st' : '';
          return `<button type="button" class="rv-pp-chip side-${side.toLowerCase()}${mode ? ' active' : ''}" data-pp-slot="${p.slot}" aria-pressed="${mode ? 'true' : 'false'}" title="Click: first person, third person, off"><span class="rv-pp-name">${escapeHtml(p.name)}</span>${tag ? `<span class="rv-pp-tag">${tag}</span>` : ''}</button>`;
        })
        .join('')}</div>`;
    };
    const hasCamera = Boolean(cameraPose());
    if (!hasCamera) others.delete('camera');
    const other = OTHERS.filter((o) => o.key !== 'camera' || hasCamera)
      .map((o) => {
        const on = others.has(o.key);
        return `<button type="button" class="rv-pp-chip${on ? ' active' : ''}" data-pp-other="${o.key}" aria-pressed="${on ? 'true' : 'false'}"${o.title ? ` title="${escapeHtml(o.title)}"` : ''}><span class="rv-pp-name">${o.label}</span></button>`;
      })
      .join('');
    host.innerHTML = `${row('T')}${row('CT')}<div class="rv-pp-row" role="group" aria-label="Other cameras">${other}</div>`;
  }

  host.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-pp-slot], [data-pp-other]');
    if (!chip || chip.disabled) return;
    if (chip.dataset.ppSlot !== undefined) {
      const slot = Number(chip.dataset.ppSlot);
      const now = players.get(slot);
      if (!now) players.set(slot, 'pov');
      else if (now === 'pov') players.set(slot, 'third');
      else players.delete(slot);
    } else {
      const key = chip.dataset.ppOther;
      if (others.has(key)) others.delete(key);
      else others.add(key);
    }
    paint();
    onChange();
  });

  /** The player ids picked: whose grenades the landings and setpos lines are about. */
  const pickedIds = () => roster.filter((p) => players.has(p.slot)).map((p) => String(p.id));

  return {
    /** The round whose players these are. Keeps the choices that still mean something in it. */
    setRound(nextMeta) {
      meta = nextMeta || null;
      roster = (meta?.players || []).map((p) => ({
        slot: p.slot,
        id: p.id,
        name: p.name || `Player ${p.slot}`,
        side: (p.team === 1 ? meta.team1Side : meta.team2Side) || ''
      }));
      for (const slot of [...players.keys()]) {
        if (!roster.some((p) => p.slot === slot)) players.delete(slot);
      }
      paint();
    },
    repaint: paint,
    /** Set one up in code: the first choice when the creator opens, say. */
    choose({ slot, mode = 'pov', other } = {}) {
      if (Number.isInteger(slot)) players.set(slot, mode);
      if (other) others.add(other);
      paint();
      onChange();
    },
    clear() {
      players.clear();
      others.clear();
      paint();
    },
    pickedIds,
    /** Whether the 2D map is one of the choices. */
    get wantsMap() {
      return others.has('map');
    },
    /**
     * The choices as perspectives, in the order they are rendered: the first is what the note's tile shows.
     * Landings need the part of the round, since one is made per grenade thrown in it.
     *
     * @param {{ fromTick: number, toTick: number }} part
     * @returns {{ specs: object[], over: number }}  over: how many did not fit in a note
     */
    specs({ fromTick, toTick }) {
      const out = [];
      for (const p of roster) {
        const mode = players.get(p.slot);
        if (mode) out.push({ type: 'player', slot: p.slot, mode });
      }
      if (others.has('overview')) out.push({ type: 'overview' });
      if (others.has('camera')) {
        const pose = cameraPose();
        if (pose) out.push({ type: 'camera', pose });
      }
      if (others.has('landing3d') || others.has('landing2d')) {
        for (const grenade of throwsInPart(meta, fromTick, toTick, pickedIds())) {
          if (others.has('landing3d')) out.push({ type: 'landing', kind: '3d', grenade });
          if (others.has('landing2d')) out.push({ type: 'landing', kind: '2d', grenade });
        }
      }
      if (others.has('map')) out.push({ type: 'map' });
      return { specs: out.slice(0, MAX_PERSPECTIVES), over: Math.max(0, out.length - MAX_PERSPECTIVES) };
    }
  };
}
