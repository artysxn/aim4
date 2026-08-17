// ---------------------------------------------------------------------------
// src/cs3d/buyMenu.js
// The explorer's buy menu (B): every gun and every grenade, grouped the way the
// game groups them, picked with the mouse.
//
// There is no economy here. The explorer is a map you walk around in, not a
// round, so nothing is deducted and nothing is denied — the prices are printed
// because a buy menu without them does not read as one, and because they are
// the fastest way to recognise a gun in a list. `[verify]` on every number: they
// are CS2's shipped prices as of writing, typed from the game rather than read
// out of a file, and nothing in this repo depends on them being right.
//
// What a pick actually does is what the explorer can do: the viewmodel draws
// that weapon and the body's speed cap becomes that weapon's. Utility is a
// weapon like any other here — CS2 holds a grenade in the same hand with the
// same rig, and the pack ships those models and clips (scripts/cs3d-weapons.mjs
// CLIP_SETS 'grenade'), so picking a smoke puts a smoke in your hand.
//
// Side matters twice. Half the guns are one side's only, and the incendiary is
// the CT's molotov at a different price — so the list is rebuilt whenever the
// spawn side changes (1 / 2 in the explorer), and a weapon the other side
// cannot hold is simply not in it.
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * One row: the bare weapon stem the rest of the repo uses (`ak47`, never
 * `weapon_ak47`), its display name, its price and whose it is.
 *
 * `side` null means both sides carry it.
 */
const CATALOGUE = [
  {
    key: 'secondary',
    title: 'Pistols',
    items: [
      { name: 'glock', label: 'Glock-18', price: 200, side: 'T' },
      { name: 'usp_silencer', label: 'USP-S', price: 200, side: 'CT' },
      { name: 'hkp2000', label: 'P2000', price: 200, side: 'CT' },
      { name: 'p250', label: 'P250', price: 300, side: null },
      { name: 'elite', label: 'Dual Berettas', price: 300, side: null },
      { name: 'tec9', label: 'Tec-9', price: 500, side: 'T' },
      { name: 'fiveseven', label: 'Five-SeveN', price: 500, side: 'CT' },
      { name: 'cz75a', label: 'CZ75-Auto', price: 500, side: null },
      { name: 'revolver', label: 'R8 Revolver', price: 600, side: null },
      { name: 'deagle', label: 'Desert Eagle', price: 700, side: null }
    ]
  },
  {
    key: 'smg',
    title: 'SMGs',
    items: [
      { name: 'mac10', label: 'MAC-10', price: 1050, side: 'T' },
      { name: 'mp9', label: 'MP9', price: 1250, side: 'CT' },
      { name: 'ump45', label: 'UMP-45', price: 1200, side: null },
      { name: 'bizon', label: 'PP-Bizon', price: 1400, side: null },
      { name: 'mp7', label: 'MP7', price: 1500, side: null },
      { name: 'mp5sd', label: 'MP5-SD', price: 1500, side: null },
      { name: 'p90', label: 'P90', price: 2350, side: null }
    ]
  },
  {
    key: 'heavy',
    title: 'Heavy',
    items: [
      { name: 'nova', label: 'Nova', price: 1050, side: null },
      { name: 'sawedoff', label: 'Sawed-Off', price: 1100, side: 'T' },
      { name: 'mag7', label: 'MAG-7', price: 1300, side: 'CT' },
      { name: 'xm1014', label: 'XM1014', price: 2000, side: null },
      { name: 'negev', label: 'Negev', price: 1700, side: null },
      { name: 'm249', label: 'M249', price: 5200, side: null }
    ]
  },
  {
    key: 'primary',
    title: 'Rifles',
    items: [
      { name: 'galilar', label: 'Galil AR', price: 1800, side: 'T' },
      { name: 'famas', label: 'FAMAS', price: 2050, side: 'CT' },
      { name: 'ssg08', label: 'SSG 08', price: 1700, side: null },
      { name: 'ak47', label: 'AK-47', price: 2700, side: 'T' },
      { name: 'm4a1_silencer', label: 'M4A1-S', price: 2900, side: 'CT' },
      { name: 'sg556', label: 'SG 553', price: 3000, side: 'T' },
      { name: 'm4a1', label: 'M4A4', price: 3100, side: 'CT' },
      { name: 'aug', label: 'AUG', price: 3300, side: 'CT' },
      { name: 'awp', label: 'AWP', price: 4750, side: null },
      { name: 'g3sg1', label: 'G3SG1', price: 5000, side: 'T' },
      { name: 'scar20', label: 'SCAR-20', price: 5000, side: 'CT' }
    ]
  },
  {
    key: 'utility',
    title: 'Utility',
    items: [
      { name: 'flashbang', label: 'Flashbang', price: 200, side: null },
      { name: 'smokegrenade', label: 'Smoke Grenade', price: 300, side: null },
      { name: 'hegrenade', label: 'HE Grenade', price: 300, side: null },
      { name: 'molotov', label: 'Molotov', price: 400, side: 'T' },
      { name: 'incgrenade', label: 'Incendiary', price: 600, side: 'CT' },
      { name: 'decoy', label: 'Decoy Grenade', price: 50, side: null },
      { name: 'taser', label: 'Zeus x27', price: 200, side: null },
      { name: 'knife', label: 'Knife', price: 0, side: null }
    ]
  }
];

/**
 * The menu.
 *
 * @param {object} o
 * @param {HTMLElement} o.root          where the panel mounts (the HUD root)
 * @param {(name: string) => void} o.onPick
 * @param {() => 'T'|'CT'} o.getSide    whose list to show
 * @param {(side: 'T'|'CT') => void} [o.onSide]  the T / CT switch in the header.
 *   The explorer's 1 and 2 are weapon slots once you are walking, so without
 *   this there is no way to see the other side's half of the list from inside
 *   the game — which is most of the point of showing utility per side.
 * @param {(name: string) => boolean} [o.has]  does the weapons pack carry it?
 *   Anything it says no to is still listed and still pickable — the speed cap
 *   is real either way — but marked, so an empty pair of hands is expected
 *   rather than a bug.
 * @param {() => string} [o.getHeld]    the weapon in hand, for the highlight
 * @param {(open: boolean) => void} [o.onToggle]
 */
export function createBuyMenu({ root, onPick, getSide, onSide, has, getHeld, onToggle }) {
  const el = document.createElement('div');
  el.className = 'c3-buy';
  el.hidden = true;
  root.appendChild(el);

  let open = false;
  let side = null;

  function render() {
    const s = getSide?.() === 'CT' ? 'CT' : 'T';
    side = s;
    const held = String(getHeld?.() || '').replace(/^weapon_/, '');
    const cols = CATALOGUE.map((group) => {
      const rows = group.items
        .filter((it) => !it.side || it.side === s)
        .map((it) => {
          const missing = has && !has(it.name);
          const cls = ['c3-buy-item'];
          if (it.name === held) cls.push('is-held');
          if (missing) cls.push('is-missing');
          const price = it.price > 0 ? `$${it.price}` : '';
          return (
            `<button type="button" class="${cls.join(' ')}" data-w="${esc(it.name)}"` +
            `${missing ? ' title="no model in the weapons pack"' : ''}>` +
            `<span>${esc(it.label)}</span><b>${price}</b></button>`
          );
        })
        .join('');
      return `<div class="c3-buy-col"><div class="c3-buy-head">${esc(group.title)}</div>${rows}</div>`;
    }).join('');
    const sides = onSide
      ? `<div class="c3-buy-sides">` +
        ['T', 'CT']
          .map((x) => `<button type="button" class="c3-buy-side${x === s ? ' is-on' : ''}" data-side="${x}">${x}</button>`)
          .join('') +
        `</div>`
      : `<span>${esc(s)}</span>`;
    el.innerHTML =
      `<div class="c3-buy-panel">` +
      `<div class="c3-buy-title">Buy ${sides}<span>B or Esc to close</span></div>` +
      `<div class="c3-buy-cols">${cols}</div>` +
      `</div>`;
  }

  el.addEventListener('mousedown', (e) => {
    // The canvas listens for mousedown to fire the gun; a click in here is not
    // a trigger pull.
    e.stopPropagation();
  });
  el.addEventListener('click', (e) => {
    const sideBtn = e.target.closest?.('.c3-buy-side');
    if (sideBtn) {
      onSide?.(sideBtn.dataset.side === 'CT' ? 'CT' : 'T');
      render();
      return;
    }
    const btn = e.target.closest?.('.c3-buy-item');
    if (!btn) {
      // Clicking the backdrop closes, the way every other panel on this page does.
      if (e.target === el) api.close();
      return;
    }
    onPick?.(btn.dataset.w);
    api.close();
  });

  const api = {
    el,
    get open() {
      return open;
    },
    /** Rebuild if the side changed under us (1 / 2 respawn while it is shut). */
    refresh() {
      if (open) render();
    },
    setOpen(next) {
      next = !!next;
      if (next === open) return;
      open = next;
      if (open) render();
      el.hidden = !open;
      onToggle?.(open);
    },
    toggle() {
      api.setOpen(!open);
    },
    close() {
      api.setOpen(false);
    },
    /** The side the currently drawn list belongs to. */
    get side() {
      return side;
    }
  };
  return api;
}
