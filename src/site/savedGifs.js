// ---------------------------------------------------------------------------
// site/savedGifs.js
// Bookmarks > Saved GIFs: every GIF made with the GIF creator (in the round
// viewer, by aim4 eye, or by the antistrat creator), as a wall of pins.
//
// The wall: each GIF at its own height with one line under it (its title and
// a menu), packed into columns left to right. A row of filters sits above it.
//
// A pin opens in place at the top of the wall, four columns wide: the GIF on
// the left; on the right the two link buttons (Page link: the share page
// with the GIF, its title and its description; Image link: the GIF's own
// address on aim4, so it embeds wherever it is pasted), the title, the
// description and what the GIF shows (map, round, both teams' sides and
// buys, who won). The rest of
// the wall keeps flowing to the right of it and below it.
//
// In a description, text between < and > is a copy link: <setpos ...> copies
// the setpos. The public share page reads descriptions the same way.
//
// Layout: one CSS grid with 2px rows. Every pin spans as many rows as its
// height needs (known from the GIF's stored size), and the open one spans
// more columns, so dense placement packs the rest around it.
// ---------------------------------------------------------------------------

import { deleteGif, fetchGifs, gifImageUrl, updateGif } from '../replays/api.js';
import {
  GIF_DESCRIPTION_MAX,
  GIF_TITLE_MAX,
  descriptionParts,
  filterGifs,
  gifDisplayTitle,
  gifFilterOptions
} from '../replays/gif/gifMeta.js';
import { downloadBlob, gifFileName, gifPageUrl, gifShareUrl } from '../replays/gif/gifCapture.js';
import { spinnerHtml } from '../lib/spinner.js';

/** Narrowest column, gap between pins, the grid's row unit and the one line under each pin. */
const MIN_COL = 236;
const GAP = 16;
const UNIT = 2;
const CAPTION = 34;

const svg = (d) => `<svg viewBox="0 -960 960 960" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  back: svg('M313-440l224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z'),
  link: svg('M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z'),
  download: svg('M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z'),
  play: svg('M320-200v-560l440 280-440 280Z'),
  more: svg('M240-400q-33 0-56.5-23.5T160-480q0-33 23.5-56.5T240-560q33 0 56.5 23.5T320-480q0 33-23.5 56.5T240-400Zm240 0q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm240 0q-33 0-56.5-23.5T640-480q0-33 23.5-56.5T720-560q33 0 56.5 23.5T800-480q0 33-23.5 56.5T720-400Z')
};

const SEGS = {
  kind: [
    ['', 'All'],
    ['2d', '2D'],
    ['3d', '3D']
  ],
  side: [
    ['', 'Any side'],
    ['T', 'T'],
    ['CT', 'CT']
  ],
  winner: [
    ['', 'Any winner'],
    ['T', 'T won'],
    ['CT', 'CT won']
  ]
};

const EMPTY_FILTERS = { q: '', kind: '', map: '', team: '', side: '', buy: '', winner: '' };

const SOURCE_LABEL = { viewer: 'Round viewer', eye: 'aim4 eye', antistrat: 'Antistrat creator' };

/**
 * @param {{ host: HTMLElement, escapeHtml: (s: string) => string,
 *           openRound: (file: string, tick?: number) => void }} opts
 */
export function createSavedGifs({ host, escapeHtml, openRound }) {
  host.innerHTML = `
    <div class="bm-gifs">
      <div class="bm-filterbar" role="search" aria-label="Filter saved GIFs">
        <input type="search" class="site-input bm-search" data-f="q" placeholder="Search saved GIFs" aria-label="Search saved GIFs" />
        ${segHtml('kind', 'View')}
        <select class="site-select" data-f="map" aria-label="Map"></select>
        <select class="site-select" data-f="team" aria-label="Team"></select>
        ${segHtml('side', 'Side')}
        <select class="site-select" data-f="buy" aria-label="Buy"></select>
        ${segHtml('winner', 'Round won by')}
        <button type="button" class="bm-clear" data-f-clear hidden>Clear</button>
        <span class="bm-gif-status" data-status></span>
      </div>
      <div class="bm-wall" data-grid></div>
    </div>`;

  function segHtml(key, label) {
    return `<div class="rp-seg bm-seg" role="group" aria-label="${label}">${SEGS[key]
      .map(([v, t]) => `<button type="button" class="rp-seg-btn${v ? '' : ' active'}" data-seg="${key}" data-v="${v}" aria-pressed="${v ? 'false' : 'true'}">${t}</button>`)
      .join('')}</div>`;
  }

  const grid = host.querySelector('[data-grid]');
  const statusEl = host.querySelector('[data-status]');
  const clearBtn = host.querySelector('[data-f-clear]');
  const searchEl = host.querySelector('[data-f="q"]');
  const selects = {
    map: host.querySelector('[data-f="map"]'),
    team: host.querySelector('[data-f="team"]'),
    buy: host.querySelector('[data-f="buy"]')
  };

  let gifs = null;
  let filters = { ...EMPTY_FILTERS };
  let loading = null;
  /** The open pin's id, or ''. */
  let openId = '';
  let editing = false;
  let menu = null;
  let visible = false;

  function setStatus(text, bad = false) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('is-error', Boolean(bad));
  }

  // ---- filters -----------------------------------------------------------------

  function fillSelects() {
    const opts = gifFilterOptions(gifs || []);
    const fill = (sel, any, list, key) => {
      const keep = filters[key];
      sel.innerHTML =
        `<option value="">${any}</option>` +
        list.map((o) => `<option value="${escapeHtml(o.value ?? o)}">${escapeHtml(o.label ?? o)}</option>`).join('');
      sel.value = list.some((o) => (o.value ?? o) === keep) ? keep : '';
      filters[key] = sel.value;
    };
    fill(selects.map, 'Any map', opts.maps, 'map');
    fill(selects.team, 'Any team', opts.teams, 'team');
    fill(selects.buy, 'Any buy', opts.buys, 'buy');
  }

  function syncSegs() {
    host.querySelectorAll('[data-seg]').forEach((b) => {
      const on = (filters[b.dataset.seg] || '') === b.dataset.v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    clearBtn.hidden = Object.keys(EMPTY_FILTERS).every((k) => !filters[k]);
  }

  searchEl.addEventListener('input', () => {
    filters.q = searchEl.value;
    render();
  });
  for (const [key, sel] of Object.entries(selects)) {
    sel.addEventListener('change', () => {
      filters[key] = sel.value;
      render();
    });
  }
  host.querySelector('.bm-filterbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-seg]');
    if (!b) return;
    filters[b.dataset.seg] = b.dataset.v;
    render();
  });
  clearBtn.addEventListener('click', () => {
    filters = { ...EMPTY_FILTERS };
    searchEl.value = '';
    for (const sel of Object.values(selects)) sel.value = '';
    render();
  });

  // ---- pieces ------------------------------------------------------------------------

  const ratioOf = (g) => (g.width > 0 && g.height > 0 ? Math.max(0.35, Math.min(2.5, g.height / g.width)) : 0.75);

  /** A description with its <...> copy links as buttons. */
  function descriptionHtml(text) {
    return descriptionParts(text)
      .map((p) =>
        p.copy
          ? // An anchor rather than a button: a button cannot wrap inside a line of text.
            `<a href="#" class="bm-copy" data-copy="${escapeHtml(p.copy)}" title="Copy">${escapeHtml(p.text)}</a>`
          : escapeHtml(p.text)
      )
      .join('');
  }

  function pinHtml(g) {
    const size = g.width && g.height ? ` width="${g.width}" height="${g.height}"` : '';
    return `
      <article class="bm-pin${g.id === openId ? ' is-open' : ''}" data-id="${escapeHtml(g.id)}" data-ratio="${ratioOf(g)}">
        <button type="button" class="bm-pin-img" data-act="open" aria-label="Open ${escapeHtml(gifDisplayTitle(g))}">
          <img src="${escapeHtml(gifImageUrl(g.id))}" alt=""${size} loading="lazy" decoding="async" />
        </button>
        <div class="bm-pin-line">
          <span class="bm-pin-title">${escapeHtml(gifDisplayTitle(g))}</span>
          <button type="button" class="bm-icon-btn bm-pin-more" data-act="menu" aria-label="More" title="More">${ICON.more}</button>
        </div>
      </article>`;
  }

  function metaRows(g) {
    const rows = [];
    const add = (k, v) => v && rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
    const team = (t) =>
      t?.name
        ? `<span class="bm-team${t.side ? ` side-${t.side.toLowerCase()}` : ''}">${escapeHtml(t.name)}</span>${t.side ? ` (${t.side})` : ''}${t.buy ? `, ${escapeHtml(t.buy)}` : ''}`
        : '';
    add('Map', escapeHtml(g.mapName || g.map || ''));
    add('Round', g.round ? String(g.round) : '');
    add('Side', g.side ? `<span class="bm-team side-${g.side.toLowerCase()}">${g.side}</span>` : '');
    add('Team 1', team(g.teams?.[0]));
    add('Team 2', team(g.teams?.[1]));
    add(
      'Won by',
      g.winnerSide
        ? `<span class="bm-team side-${g.winnerSide.toLowerCase()}">${g.winnerTeam ? escapeHtml(g.winnerTeam) : g.winnerSide}</span>${g.winnerTeam ? ` (${g.winnerSide})` : ''}`
        : ''
    );
    add('Size', g.width ? `${g.width} x ${g.height}, ${g.frames || '?'} frames, ${((g.bytes || 0) / 1024 / 1024).toFixed(1)} MB` : '');
    add('Made in', escapeHtml(SOURCE_LABEL[g.source] || ''));
    return rows.join('');
  }

  function detailHtml(g) {
    const text = editing
      ? `<input type="text" class="site-input bm-edit-title" data-edit="title" maxlength="${GIF_TITLE_MAX}" placeholder="Title" aria-label="Title" value="${escapeHtml(g.title || '')}" />
         <textarea class="site-input bm-edit-desc" data-edit="desc" maxlength="${GIF_DESCRIPTION_MAX}" rows="5" placeholder="Description. <setpos ...> becomes a copy link." aria-label="Description">${escapeHtml(g.description || '')}</textarea>
         <div class="bm-edit-actions">
           <button type="button" class="btn btn-sm" data-act="edit-cancel">Cancel</button>
           <button type="button" class="btn btn-sm primary" data-act="edit-save">Save</button>
         </div>`
      : `<h2 class="bm-detail-title">${escapeHtml(gifDisplayTitle(g))}</h2>
         ${g.description ? `<p class="bm-detail-desc">${descriptionHtml(g.description)}</p>` : ''}`;
    return `
      <section class="bm-detail" data-detail="${escapeHtml(g.id)}" aria-label="${escapeHtml(gifDisplayTitle(g))}">
        <div class="bm-detail-card">
          <div class="bm-detail-media">
            <img src="${escapeHtml(gifImageUrl(g.id))}" alt="${escapeHtml(gifDisplayTitle(g))}"${g.width ? ` width="${g.width}" height="${g.height}"` : ''} />
            <button type="button" class="bm-round-btn bm-detail-back" data-act="close" aria-label="Close" title="Close">${ICON.back}</button>
          </div>
          <div class="bm-detail-side">
            <div class="bm-detail-bar">
              <button type="button" class="bm-icon-btn" data-act="download" aria-label="Download" title="Download">${ICON.download}</button>
              ${g.file ? `<button type="button" class="bm-icon-btn" data-act="round" aria-label="Open the round" title="Open the round">${ICON.play}</button>` : ''}
              <button type="button" class="bm-icon-btn" data-act="menu" aria-label="More" title="More">${ICON.more}</button>
              <div class="bm-link-split" role="group" aria-label="Copy link">
                <button type="button" class="bm-link-btn" data-act="copy-page" title="Copy a link to a page with the GIF, its title and its description, setpos links included">${ICON.link}<span>Page link</span></button>
                <button type="button" class="bm-link-btn" data-act="copy-image" title="Copy the link to the GIF file itself, which plays wherever it is pasted"><span>Image link</span></button>
              </div>
            </div>
            ${text}
            <dl class="bm-detail-meta">${metaRows(g)}</dl>
            <span class="bm-detail-msg" data-msg></span>
          </div>
        </div>
      </section>`;
  }

  // ---- the wall ------------------------------------------------------------------------

  function render() {
    syncSegs();
    closeMenu();
    if (!gifs) return;
    if (!gifs.length) {
      grid.innerHTML = '<p class="view-empty bm-wall-empty">No saved GIFs yet. Make one with the GIF button in the round viewer.</p>';
      setStatus('');
      return;
    }
    const shown = filterGifs(gifs, filters);
    const open = gifs.find((g) => g.id === openId) || null;
    setStatus(shown.length === gifs.length ? `${gifs.length} GIF${gifs.length === 1 ? '' : 's'}` : `${shown.length} of ${gifs.length}`);
    const pins = shown.filter((g) => g.id !== openId).map(pinHtml).join('');
    grid.innerHTML = (open ? detailHtml(open) : '') + (pins || (open ? '' : '<p class="view-empty bm-wall-empty">No saved GIF fits these filters.</p>'));
    observeDetail();
    layout();
  }

  /** Columns from the wall's width, then every pin's row span from its height. */
  function layout() {
    const width = grid.clientWidth;
    if (!width) return;
    const cols = Math.max(1, Math.floor((width + GAP) / (MIN_COL + GAP)));
    const colW = (width - GAP * (cols - 1)) / cols;
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    for (const pin of grid.querySelectorAll('.bm-pin')) {
      const h = colW * Number(pin.dataset.ratio || 0.75) + CAPTION;
      pin.style.gridRowEnd = `span ${Math.ceil((h + GAP) / UNIT)}`;
    }
    const detail = grid.querySelector('.bm-detail');
    if (detail) {
      const span = cols >= 3 ? Math.min(4, cols - 1) : cols;
      detail.classList.toggle('is-narrow', span * colW + (span - 1) * GAP < 680);
      detail.style.gridColumn = `1 / span ${span}`;
      const h = detail.firstElementChild.offsetHeight;
      detail.style.gridRow = `1 / span ${Math.ceil((h + GAP) / UNIT)}`;
    }
  }

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  resize?.observe(grid);
  let detailObserver = null;
  function observeDetail() {
    detailObserver?.disconnect();
    const card = grid.querySelector('.bm-detail-card');
    if (!card || typeof ResizeObserver !== 'function') return;
    detailObserver = new ResizeObserver(() => layout());
    detailObserver.observe(card);
  }

  async function load() {
    if (loading) return loading;
    if (!gifs) grid.innerHTML = spinnerHtml('Loading saved GIFs…');
    loading = (async () => {
      try {
        gifs = await fetchGifs();
        fillSelects();
        const wanted = new URLSearchParams(window.location.search).get('gif');
        if (wanted && gifs.some((g) => g.id === wanted)) openId = wanted;
        render();
      } catch (err) {
        grid.innerHTML = `<p class="view-empty bm-wall-empty">${escapeHtml(err.message || 'Could not load saved GIFs.')}</p>`;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  // ---- opening and actions ---------------------------------------------------------------

  /** The open pin rides in the address (?gif=<id>), so a link to it opens it. */
  function syncUrl() {
    try {
      const url = new URL(window.location.href);
      if (openId) url.searchParams.set('gif', openId);
      else url.searchParams.delete('gif');
      window.history.replaceState(window.history.state, '', url.pathname + url.search);
    } catch {
      /* the address stays as it was */
    }
  }

  function openPin(id) {
    openId = id;
    editing = false;
    syncUrl();
    render();
    // The filter row's top, clear of the page's sticky header (scroll-margin in CSS).
    host.querySelector('.bm-gifs')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function closePin() {
    openId = '';
    editing = false;
    syncUrl();
    render();
  }

  function say(text, bad = false) {
    const msg = grid.querySelector('[data-msg]');
    if (msg) {
      msg.textContent = text || '';
      msg.classList.toggle('bad', Boolean(bad));
    } else {
      setStatus(text, bad);
    }
  }

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      done?.();
    } catch {
      window.prompt('Copy:', text);
    }
  }

  async function download(g) {
    try {
      const res = await fetch(gifImageUrl(g.id));
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      downloadBlob(await res.blob(), gifFileName(g));
    } catch (err) {
      say(err.message || 'Download failed.', true);
    }
  }

  async function remove(g) {
    if (!window.confirm(`Delete "${gifDisplayTitle(g)}"? Its link stops working.`)) return;
    try {
      await deleteGif(g.id);
      gifs = gifs.filter((x) => x.id !== g.id);
      if (openId === g.id) openId = '';
      syncUrl();
      fillSelects();
      render();
      setStatus('GIF deleted.');
    } catch (err) {
      say(err.message || 'Could not delete.', true);
    }
  }

  async function saveEdit(g) {
    try {
      const next = await updateGif(g.id, {
        title: grid.querySelector('[data-edit="title"]')?.value ?? g.title,
        description: grid.querySelector('[data-edit="desc"]')?.value ?? g.description
      });
      Object.assign(g, next);
      editing = false;
      render();
      say('Saved.');
    } catch (err) {
      say(err.message || 'Could not save.', true);
    }
  }

  // A small menu under a "..." button: on a pin, what you would otherwise
  // have to open it for; on the open one, editing and deleting.
  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  function openMenu(btn, g, inDetail) {
    closeMenu();
    const items = inDetail
      ? [
          ['edit', 'Edit title and description'],
          ['delete', 'Delete']
        ]
      : [
          ['copy-page', 'Copy page link'],
          ['copy-image', 'Copy image link'],
          ['download', 'Download'],
          ...(g.file ? [['round', 'Open the round']] : []),
          ['delete', 'Delete']
        ];
    menu = document.createElement('div');
    menu.className = 'bm-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items
      .map(([act, label]) => `<button type="button" role="menuitem" class="bm-menu-item${act === 'delete' ? ' danger' : ''}" data-menu="${act}">${label}</button>`)
      .join('');
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6)}px`;
    menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-menu]')?.dataset.menu;
      closeMenu();
      if (act) act === 'edit' ? startEdit() : run(act, g, btn);
    });
  }

  function startEdit() {
    editing = true;
    render();
    grid.querySelector('[data-edit="title"]')?.focus();
  }

  function run(act, g, btn) {
    if (act === 'copy-page' || act === 'copy-image') {
      const page = act === 'copy-page';
      copyText(page ? gifPageUrl(g.id) : gifShareUrl(g.id), () => {
        const msg = page ? 'Page link copied.' : 'Image link copied.';
        if (openId === g.id) say(msg);
        else setStatus(msg);
      });
    } else if (act === 'download') download(g);
    else if (act === 'round') openRound(g.file, g.fromTick);
    else if (act === 'delete') remove(g);
    else if (act === 'menu') openMenu(btn, g, Boolean(btn.closest('.bm-detail')));
  }

  grid.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      copyText(copy.dataset.copy, () => {
        copy.classList.add('is-copied');
        setTimeout(() => copy.classList.remove('is-copied'), 1200);
        say(`Copied: ${copy.dataset.copy}`);
      });
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id || btn.closest('[data-detail]')?.dataset.detail;
    const g = gifs?.find((x) => x.id === id);
    if (!g) return;
    const act = btn.dataset.act;
    if (act === 'open') openPin(g.id);
    else if (act === 'close') closePin();
    else if (act === 'edit-cancel') {
      editing = false;
      render();
    } else if (act === 'edit-save') saveEdit(g);
    else run(act, g, btn);
  });

  const onDocClick = (e) => {
    if (menu && !menu.contains(e.target) && !e.target.closest('[data-act="menu"]')) closeMenu();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || !visible) return;
    if (menu) closeMenu();
    else if (editing) {
      editing = false;
      render();
    } else if (openId && !e.target.matches?.('input, textarea')) closePin();
  };
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKey);
  // The menu is fixed to the window; a scroll would leave it behind its button.
  document.addEventListener('scroll', closeMenu, true);

  return {
    show() {
      visible = true;
      host.hidden = false;
      void load();
    },
    hide() {
      visible = false;
      closeMenu();
    }
  };
}
