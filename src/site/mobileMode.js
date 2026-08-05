// ---------------------------------------------------------------------------
// site/mobileMode.js
// Chrome for the mobile layout. There is one site on one URL: detection lives
// in the inline <head> script in index.html, which sets <html data-mobile="1">
// on phones and on anyone who picked the mobile layout. This module reads that
// flag and reshapes the shell around it: the sidebar becomes a slide-in drawer
// behind a hamburger button, the demo browser's filter column folds behind a
// toggle, and the drawer and footer carry the switch to the desktop layout.
// ---------------------------------------------------------------------------

export function isMobileSite() {
  return document.documentElement.getAttribute('data-mobile') === '1';
}

/** True when the device itself looks like a phone, whatever layout is showing. */
export function isPhoneDevice() {
  return document.documentElement.getAttribute('data-phone') === '1';
}

/**
 * The current page with ?view= set. The inline bootstrap consumes it on the
 * next load: it stores the choice for this device and browser, then strips the
 * parameter back out of the address bar.
 *
 * @param {'mobile'|'desktop'|'auto'} view
 */
export function viewSwitchUrl(view) {
  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  return url.toString();
}

const MENU_ICON =
  '<svg viewBox="0 -960 960 960" width="22" height="22"><path d="M120-240v-80h720v80H120Zm0-200v-80h720v80H120Zm0-200v-80h720v80H120Z"/></svg>';
const DESKTOP_ICON =
  '<svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-120v-80h80v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H560v80h80v80H320ZM160-360h640v-400H160v400Z"/></svg>';

/**
 * Hamburger + drawer + backdrop. The sidebar markup is untouched; mobile.css
 * turns it into the drawer, this wires open/close.
 */
export function initMobileChrome({ shell }) {
  const setOpen = (open) => {
    shell.dataset.drawer = open ? 'open' : 'closed';
    document.body.classList.toggle('drawer-open', open);
  };

  const burger = document.createElement('button');
  burger.type = 'button';
  burger.className = 'mobile-menu-btn';
  burger.setAttribute('aria-label', 'Open menu');
  burger.innerHTML = MENU_ICON;
  burger.addEventListener('click', () => setOpen(shell.dataset.drawer !== 'open'));
  document.querySelector('.page-head')?.prepend(burger);

  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.addEventListener('click', () => setOpen(false));
  document.body.appendChild(backdrop);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  // Any nav tap closes the drawer; the router still handles the click itself.
  const nav = document.querySelector('.side-nav');
  nav?.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });
  document.querySelector('.side-logo')?.addEventListener('click', () => setOpen(false));
  document.getElementById('side-account-btn')?.addEventListener('click', () => setOpen(false));

  // Way out to the full layout, in the drawer and in the footer.
  if (nav) {
    const link = document.createElement('a');
    link.className = 'side-link side-desktop-link';
    link.href = viewSwitchUrl('desktop');
    link.innerHTML = `<span class="side-icon">${DESKTOP_ICON}</span><span class="side-label">Desktop site</span>`;
    nav.appendChild(link);
  }
  addFooterViewSwitch('desktop', 'Desktop site');

  setOpen(false);
  return { close: () => setOpen(false) };
}

/**
 * The footer switch between layouts. Also used by the desktop shell, so a
 * phone that chose the desktop layout is not stranded there.
 *
 * @param {'mobile'|'desktop'} view
 * @param {string} label
 */
export function addFooterViewSwitch(view, label) {
  const footBottom = document.querySelector('.foot-bottom');
  if (!footBottom) return;
  const link = document.createElement('a');
  link.href = viewSwitchUrl(view);
  link.textContent = label;
  footBottom.appendChild(link);
}

/**
 * The demo browser's filter column is a desktop sidebar; on a phone it folds
 * behind this toggle (mobile.css hides #rp-filters until .filters-open).
 */
export function initMobileFilterToggle() {
  const library = document.getElementById('rp-library');
  const filters = document.getElementById('rp-filters');
  if (!library || !filters) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm rp-filters-toggle';
  btn.textContent = 'Filters';
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    const open = library.classList.toggle('filters-open');
    btn.textContent = open ? 'Hide filters' : 'Filters';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  filters.before(btn);
}
