// ---------------------------------------------------------------------------
// src/site/tabs.js
// Browser-style tabs for the desktop app, which has no browser chrome of its
// own (entry.js mounts them only there). The top window holds a strip of tabs
// and one frame per tab; each frame runs the whole site on its own, so a tab
// keeps its scroll, its page and any work in progress (an aim4 eye answer
// keeps streaming in the background) while you look at another one.
// ---------------------------------------------------------------------------

const STORE = 'aim4.tabs';
const HOME = '/';
const MAX_TABS = 12;

const read = () => {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (v && Array.isArray(v.tabs) && v.tabs.length) return v;
  } catch {
    /* no saved tabs */
  }
  return null;
};

const pathOf = (loc) => `${loc.pathname}${loc.search}${loc.hash}`;

/** A site URL (same origin) as path+search+hash, or null for anything else. */
const siteUrl = (href, base) => {
  try {
    const u = new URL(href, base || window.location.href);
    return u.origin === window.location.origin ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
};

const css = `
html.tabs-host, html.tabs-host body { margin: 0; height: 100%; overflow: hidden; background: #000; }
html.tabs-host .site-shell { display: none !important; }
.tabs-bar { position: fixed; inset: 0 0 auto 0; height: 38px; display: flex; align-items: stretch; gap: 2px; padding: 4px 6px 0; background: #0c0c0c; border-bottom: 1px solid #242424; z-index: 10; font: 13px/1 'PP Mori', system-ui, sans-serif; color: #f2f2f2; user-select: none; }
.tabs-nav { display: flex; align-items: center; gap: 2px; padding-right: 6px; }
.tabs-btn { width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: #9c9ca2; font-size: 15px; cursor: pointer; }
.tabs-btn:hover:not(:disabled) { background: #1c1c1c; color: #f2f2f2; }
.tabs-btn:disabled { opacity: 0.35; cursor: default; }
.tabs-list { display: flex; align-items: stretch; gap: 2px; min-width: 0; flex: 0 1 auto; overflow: hidden; }
.tabs-tab { position: relative; display: flex; align-items: center; gap: 6px; min-width: 60px; max-width: 220px; flex: 1 1 180px; padding: 0 6px 0 12px; border-radius: 8px 8px 0 0; background: transparent; color: #9c9ca2; cursor: default; }
.tabs-tab:hover { background: #141414; color: #f2f2f2; }
.tabs-tab.is-active { background: #000; color: #f2f2f2; box-shadow: inset 0 2px 0 #e60611; }
.tabs-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs-close { width: 20px; height: 20px; display: grid; place-items: center; border: 0; border-radius: 5px; background: transparent; color: inherit; font-size: 14px; cursor: pointer; opacity: 0.7; }
.tabs-close:hover { background: #2a2a2a; opacity: 1; }
.tabs-new { align-self: center; margin-left: 4px; }
.tabs-frames { position: fixed; inset: 38px 0 0 0; background: #000; }
.tabs-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; display: none; }
.tabs-frame.is-active { display: block; }
`;

export function mountTabs() {
  document.documentElement.classList.add('tabs-host');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'tabs-bar';
  bar.innerHTML = `
    <div class="tabs-nav">
      <button type="button" class="tabs-btn" data-nav="back" aria-label="Back" title="Back">&#8592;</button>
      <button type="button" class="tabs-btn" data-nav="forward" aria-label="Forward" title="Forward">&#8594;</button>
      <button type="button" class="tabs-btn" data-nav="reload" aria-label="Reload" title="Reload">&#8635;</button>
    </div>
    <div class="tabs-list" role="tablist"></div>
    <button type="button" class="tabs-btn tabs-new" aria-label="New tab" title="New tab (Ctrl+T)">+</button>`;
  const frames = document.createElement('div');
  frames.className = 'tabs-frames';
  document.body.append(bar, frames);
  const listEl = bar.querySelector('.tabs-list');

  /** @type {Array<{ id: number, url: string, title: string, el: HTMLElement, frame: HTMLIFrameElement | null, poll: number }>} */
  const tabs = [];
  let active = null;
  let nextId = 1;

  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ tabs: tabs.map((t) => ({ url: t.url, title: t.title })), active: tabs.indexOf(active) }));
    } catch {
      /* private window: tabs just are not remembered */
    }
  };

  const titleOf = (doc) => {
    const raw = String(doc?.title || '').trim();
    if (!raw) return '';
    if (raw === 'AIM4.io') return 'Home';
    return raw.replace(/^AIM4\.io\s*-\s*/i, '');
  };

  const setTitle = (tab, text) => {
    if (!text || text === tab.title) return;
    tab.title = text;
    tab.el.querySelector('.tabs-title').textContent = text;
    tab.el.title = text;
    if (tab === active) document.title = `${text} - aim4`;
    save();
  };

  const syncNav = () => {
    let back = true;
    try {
      back = active.frame.contentWindow.history.length > 1;
    } catch {
      /* not ready: leave enabled */
    }
    bar.querySelector('[data-nav="back"]').disabled = !back;
  };

  function select(tab) {
    if (!tab) return;
    active = tab;
    for (const t of tabs) {
      t.el.classList.toggle('is-active', t === tab);
      t.el.setAttribute('aria-selected', String(t === tab));
      t.frame?.classList.toggle('is-active', t === tab);
    }
    if (!tab.frame) load(tab);
    tab.frame.classList.add('is-active');
    document.title = `${tab.title || 'aim4'} - aim4`;
    tab.el.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    save();
    syncNav();
    try {
      tab.frame.contentWindow?.focus();
    } catch {
      /* not ready yet */
    }
  }

  function close(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tabs.splice(i, 1);
    tab.el.remove();
    tab.frame?.remove();
    clearInterval(tab.poll);
    if (!tabs.length) {
      open(HOME);
      return;
    }
    if (tab === active) select(tabs[Math.min(i, tabs.length - 1)]);
    else save();
  }

  const step = (n) => {
    const i = tabs.indexOf(active);
    select(tabs[(i + n + tabs.length) % tabs.length]);
  };

  /** Keys a browser would handle, wherever the focus is (the strip or a frame). */
  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 't' && !e.shiftKey) {
      e.preventDefault();
      open(HOME);
    } else if (k === 'w') {
      e.preventDefault();
      close(active);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      select(e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1]);
    }
  };
  window.addEventListener('keydown', onKey);
  // Frames hand the window off-site (a sign-in) through the top page, so the navigation starts here.
  window.__aim4Leave = (url) => window.location.assign(url);

  /** Everything a frame hands to the strip: its title, new-tab links, its keys. */
  function hook(tab) {
    const win = tab.frame.contentWindow;
    let doc;
    try {
      doc = win.document;
    } catch {
      return;
    }
    const base = win.location.href;
    if (base === 'about:blank') return;
    setTitle(tab, titleOf(doc));
    tab.url = pathOf(win.location);
    save();
    syncNav();
    new MutationObserver(() => setTitle(tab, titleOf(doc))).observe(doc.head || doc.documentElement, { subtree: true, childList: true, characterData: true });
    win.addEventListener('keydown', onKey);
    win.open = (href) => {
      const url = href ? siteUrl(href, base) : null;
      if (url) open(url);
      return null;
    };
    const fromLink = (e) => {
      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      const url = siteUrl(a.getAttribute('href'), base);
      if (!url || a.hasAttribute('download')) return;
      const newTab = a.target === '_blank' || e.ctrlKey || e.metaKey || e.button === 1;
      if (!newTab) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click' || e.button === 1) open(url);
    };
    doc.addEventListener('click', fromLink, true);
    doc.addEventListener('auxclick', fromLink, true);
  }

  function load(tab) {
    const frame = document.createElement('iframe');
    frame.className = 'tabs-frame';
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; autoplay');
    frame.addEventListener('load', () => hook(tab));
    tab.frame = frame;
    frame.src = tab.url;
    frames.appendChild(frame);
    // The site routes without reloading, so the address is read back now and then.
    tab.poll = setInterval(() => {
      try {
        const now = pathOf(frame.contentWindow.location);
        if (now !== tab.url && frame.contentWindow.location.href !== 'about:blank') {
          tab.url = now;
          save();
          syncNav();
        }
      } catch {
        /* mid-navigation */
      }
    }, 1500);
  }

  function open(url, activate = true, title = '') {
    if (tabs.length >= MAX_TABS) {
      select(tabs[tabs.length - 1]);
      return null;
    }
    const el = document.createElement('div');
    el.className = 'tabs-tab';
    el.setAttribute('role', 'tab');
    el.innerHTML = '<span class="tabs-title"></span><button type="button" class="tabs-close" aria-label="Close tab">&times;</button>';
    const tab = { id: nextId++, url: siteUrl(url) || HOME, title, el, frame: null, poll: 0 };
    el.querySelector('.tabs-title').textContent = title || 'Loading';
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tabs-close')) close(tab);
      else select(tab);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        close(tab);
      }
    });
    listEl.appendChild(el);
    tabs.push(tab);
    if (activate) select(tab);
    else save();
    return tab;
  }

  bar.querySelector('.tabs-new').addEventListener('click', () => open(HOME));
  bar.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]')?.dataset.nav;
    const win = active?.frame?.contentWindow;
    if (!nav || !win) return;
    try {
      if (nav === 'back') win.history.back();
      else if (nav === 'forward') win.history.forward();
      else win.location.reload();
    } catch {
      /* frame not ready */
    }
  });

  // Start: the tabs from last time, plus the address this window was opened on when it is a deep link.
  const saved = read();
  if (saved) {
    for (const t of saved.tabs.slice(0, MAX_TABS)) open(t.url || HOME, false, t.title || '');
  }
  const first = siteUrl(window.location.href);
  // A sign-in coming home carries its session in the address: a tab finishes it.
  const isLanding = () => /access_token=|[?&#]code=|error_description=/.test(window.location.search + window.location.hash);
  const landing = isLanding();
  if (!saved || landing || (window.location.pathname !== '/' && first)) {
    open(first || HOME);
  } else {
    select(tabs[Math.max(0, Math.min(tabs.length - 1, Number(saved.active) || 0))]);
  }
  if (window.location.pathname !== '/' || window.location.search || window.location.hash) window.history.replaceState(null, '', '/');
  // The desktop app hands a finished sign-in back to this same page ("/#access_token=..."):
  // only the hash changes, so the page does not reload and the check above never runs again.
  // Catch it here too, or the session sits in the address and nobody signs in.
  window.addEventListener('hashchange', () => {
    if (!isLanding()) return;
    open(siteUrl(window.location.href) || HOME);
    window.history.replaceState(null, '', '/');
  });
}
