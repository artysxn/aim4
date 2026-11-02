// ---------------------------------------------------------------------------
// replays/gif/perspectivePicker.js
// Choosing what a visual note is seen from: any players, each first or third
// person, and any of the other cameras, in one note. The note creator in the
// viewer and the editor in Bookmarks both use it.
//
// Players sit in a dropdown, since ten names take the whole panel. A name turns
// that player on or off; 1st and 3rd beside it choose the view, so one note can
// hold one player's eyes and another's shoulder.
//
// Camera goes into 3D and flies. Each shot keeps where the camera is, and a
// screenshot to tell them apart; the note is then filmed from each of them.
// ---------------------------------------------------------------------------

import { MAX_PERSPECTIVES } from './gifMeta.js';
import { throwsInPart } from './perspectives.js';

/** The buttons under the players. `camera` only shows where there is a 3D view to fly it in. */
const OTHERS = [
  { key: 'map', label: '2D map' },
  { key: 'overview', label: 'Overview' },
  { key: 'camera', label: 'Camera', title: 'Fly to a spot in 3D and film from there' },
  { key: 'landing3d', label: 'Landing 3D', title: 'Where each grenade comes down, in 3D' },
  { key: 'landing2d', label: 'Landing 2D', title: 'Where each grenade comes down, on the map' }
];

const VIEWS = [
  { key: 'pov', tag: '1st', title: 'First person' },
  { key: 'third', tag: '3rd', title: 'Third person' }
];
const viewTag = (mode) => VIEWS.find((v) => v.key === mode)?.tag || '';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {(s: string) => string} opts.escapeHtml
 * @param {() => void} [opts.onChange]
 * @param {{ available: () => boolean, open: () => Promise<boolean>, pose: () => object|null,
 *            screenshot: () => string|null }} [opts.camera]  the 3D view to fly; without one there is no Camera
 */
export function createPerspectivePicker({ host, escapeHtml, onChange = () => {}, camera = null }) {
  host.classList.add('rv-pp');
  /** slot -> 'pov' | 'third' */
  const players = new Map();
  const others = new Set();
  /** Where the camera was each time a shot was taken. */
  let shots = [];
  let roster = [];
  let meta = null;
  /** Paints rebuild the dropdown, so whether it is open lives here. */
  let menuOpen = false;

  /** The closed dropdown: the one player and their view, or how many. */
  function playersLabel(picked) {
    if (!picked.length) return 'Players';
    if (picked.length === 1) return `${picked[0].name} ${viewTag(players.get(picked[0].slot))}`;
    return `${picked.length} players`;
  }

  function paintPlayers() {
    const picked = roster.filter((p) => players.has(p.slot));
    const group = (side) => {
      const list = roster.filter((p) => p.side === side);
      if (!list.length) return '';
      return `<div class="rv-pp-group" role="group" aria-label="${side} players">${list
        .map((p) => {
          const mode = players.get(p.slot) || '';
          const views = VIEWS.map(
            (v) => `<button type="button" class="rp-seg-btn${mode === v.key ? ' active' : ''}" data-pp-slot="${p.slot}" data-pp-view="${v.key}" aria-pressed="${mode === v.key}" title="${v.title}">${v.tag}</button>`
          ).join('');
          return `<div class="rv-pp-opt side-${side.toLowerCase()}${mode ? ' active' : ''}"><button type="button" class="rv-pp-opt-name" data-pp-slot="${p.slot}" aria-pressed="${Boolean(mode)}">${escapeHtml(p.name)}</button><div class="rp-seg rv-pp-views">${views}</div></div>`;
        })
        .join('')}</div>`;
    };
    const names = picked.map((p) => `${p.name} ${viewTag(players.get(p.slot))}`).join(', ');
    return `<details class="rv-pp-dd"${menuOpen ? ' open' : ''}>
      <summary class="rv-pp-summary${picked.length ? ' has-picks' : ''}" aria-label="Players"${names ? ` title="${escapeHtml(names)}"` : ''}><span class="rv-pp-name">${escapeHtml(playersLabel(picked))}</span></summary>
      <div class="rv-pp-menu" role="group" aria-label="Players">${group('T')}${group('CT')}</div>
    </details>`;
  }

  /** Fixed, so the panel's own scrolling cannot clip it. Opens upward when there is no room below. */
  function placeMenu() {
    const menu = host.querySelector('.rv-pp-menu');
    const summary = host.querySelector('.rv-pp-summary');
    if (!menu || !summary) return;
    const box = summary.getBoundingClientRect();
    menu.style.width = `${Math.round(box.width)}px`;
    // Measured at 0,0: an open note in Bookmarks is transformed, which moves where fixed starts from.
    menu.style.top = '0';
    menu.style.left = '0';
    const origin = menu.getBoundingClientRect();
    const fits = box.bottom + 4 + origin.height <= window.innerHeight - 8;
    const top = fits ? box.bottom + 4 : Math.max(8, box.top - 4 - origin.height);
    menu.style.top = `${Math.round(top - origin.top)}px`;
    menu.style.left = `${Math.round(box.left - origin.left)}px`;
  }

  function closeMenu() {
    menuOpen = false;
    const dd = host.querySelector('.rv-pp-dd');
    if (dd) dd.open = false;
    listenWhileOpen(false);
  }

  const closeIfOutside = (e) => {
    if (!host.querySelector('.rv-pp-dd')?.contains(e.target)) closeMenu();
  };
  const closeOnEscape = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closeMenu();
  };
  const followSummary = (e) => {
    if (!host.querySelector('.rv-pp-menu')?.contains(e.target)) placeMenu();
  };

  /** Only while open, so a picker that is gone leaves nothing behind: the next click outside takes them off. */
  function listenWhileOpen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', closeIfOutside, true);
    document[method]('keydown', closeOnEscape, true);
    window[method]('scroll', followSummary, true);
    window[method]('resize', placeMenu);
  }

  host.addEventListener('toggle', (e) => {
    if (!e.target.matches?.('.rv-pp-dd')) return;
    menuOpen = e.target.open;
    listenWhileOpen(menuOpen);
    if (menuOpen) placeMenu();
  }, true);

  function paint() {
    const hasCamera = Boolean(camera?.available());
    if (!hasCamera) others.delete('camera');
    const other = OTHERS.filter((o) => o.key !== 'camera' || hasCamera)
      .map((o) => {
        const on = others.has(o.key);
        return `<button type="button" class="rv-pp-chip${on ? ' active' : ''}" data-pp-other="${o.key}" aria-pressed="${on ? 'true' : 'false'}"${o.title ? ` title="${escapeHtml(o.title)}"` : ''}><span class="rv-pp-name">${o.label}</span></button>`;
      })
      .join('');
    const shotRow = others.has('camera')
      ? `<div class="rv-pp-shots" role="group" aria-label="Camera shots"><button type="button" class="rv-pp-chip rv-pp-shoot" data-pp-shoot title="Keep where the camera is now">Take shot<span class="rv-pp-key">T</span></button>${shots
          .map((s, i) => `<span class="rv-pp-shot"><img src="${s.image}" alt="Shot ${i + 1}" draggable="false" /><button type="button" data-pp-unshoot="${i}" aria-label="Remove shot ${i + 1}" title="Remove">×</button></span>`)
          .join('')}</div>`
      : '';
    host.innerHTML = `${roster.length ? paintPlayers() : ''}<div class="rv-pp-row" role="group" aria-label="Other cameras">${other}</div>${shotRow}`;
    if (menuOpen) placeMenu();
  }

  /** Keep where the camera is now. False when there is no 3D view on screen to take it from. */
  function takeShot() {
    const pose = camera?.pose();
    if (!pose) return false;
    shots.push({ pose, image: camera.screenshot() || '' });
    paint();
    onChange();
    return true;
  }

  /** Camera on: into 3D and flying. If that is not possible after all, it goes back off. */
  async function openCamera() {
    if (await camera.open()) return;
    others.delete('camera');
    paint();
    onChange();
  }

  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-pp-shoot]')) {
      takeShot();
      return;
    }
    const unshoot = e.target.closest('[data-pp-unshoot]');
    if (unshoot) {
      shots.splice(Number(unshoot.dataset.ppUnshoot), 1);
      paint();
      onChange();
      return;
    }
    const chip = e.target.closest('[data-pp-slot], [data-pp-other]');
    if (!chip || chip.disabled) return;
    if (chip.dataset.ppSlot !== undefined) {
      const slot = Number(chip.dataset.ppSlot);
      const view = chip.dataset.ppView;
      const now = players.get(slot);
      if (view ? now === view : now) players.delete(slot);
      else players.set(slot, view || 'pov');
    } else {
      const key = chip.dataset.ppOther;
      if (others.has(key)) others.delete(key);
      else {
        others.add(key);
        if (key === 'camera') void openCamera();
      }
    }
    paint();
    onChange();
    // onChange can change the panel's height, which moves the dropdown.
    if (menuOpen) placeMenu();
  });

  /** The player ids picked: whose grenades the landings and setpos lines are about. */
  const pickedIds = () => roster.filter((p) => players.has(p.slot)).map((p) => String(p.id));

  return {
    /** The round whose players these are. Keeps the choices that still mean something in it. */
    setRound(nextMeta) {
      // A shot is a place on one map.
      if (nextMeta?.map !== meta?.map) shots = [];
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
      shots = [];
      paint();
    },
    pickedIds,
    /** The T key, while Camera is on. */
    takeShot: () => others.has('camera') && takeShot(),
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
        if (shots.length) shots.forEach((s, i) => out.push({ type: 'camera', pose: s.pose, shot: shots.length > 1 ? i + 1 : 0 }));
        else {
          // No shot taken: where it is now, which is what pressing Create after flying there means.
          const pose = camera?.pose();
          if (pose) out.push({ type: 'camera', pose });
        }
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
