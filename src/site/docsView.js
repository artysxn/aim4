// ---------------------------------------------------------------------------
// src/site/docsView.js
// /docs: how to use the website, on one page.
//
// One long page with a sticky section list, not a docs site: a single page
// can be Cmd+F'd, and the search field above the list narrows both sides to
// the sections that mention every word typed. What the page says lives in
// docsContent.js; this file only lays it out.
// ---------------------------------------------------------------------------

import { DOC_GROUPS, KEYS } from './docsContent.js';

export function initDocsView(host, { escapeHtml }) {
  if (!host) return { onShow() {}, onHide() {} };
  const esc = escapeHtml;
  let rendered = false;
  /** @type {{ id: string, el: HTMLElement, link: HTMLElement, group: HTMLElement, navGroup: HTMLElement, text: string }[]} */
  let index = [];
  let observer = null;
  let emptyEl = null;

  const keysHtml = () => `
    <div class="docs-table-wrap"><table class="docs-keys">
      <tbody>
        ${KEYS.map(([k, what]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(what)}</td></tr>`).join('')}
      </tbody>
    </table></div>`;

  function render() {
    if (rendered) return;
    rendered = true;
    const nav = DOC_GROUPS.map(
      (g, gi) => `
        <div class="docs-nav-group" data-group="${gi}">
          <div class="docs-nav-label">${esc(g.label)}</div>
          ${g.sections.map((s) => `<a href="#${s.id}" data-doc="${s.id}">${esc(s.title)}</a>`).join('')}
        </div>`
    ).join('');
    const main = DOC_GROUPS.map(
      (g, gi) => `
        <div class="docs-group" data-group="${gi}">
          <div class="docs-group-label">${esc(g.label)}</div>
          ${g.sections
            .map(
              (s) => `
            <section id="${s.id}" data-doc="${s.id}">
              <h2>${esc(s.title)}</h2>
              ${s.id === 'keys' ? keysHtml() : s.html}
            </section>`
            )
            .join('')}
        </div>`
    ).join('');

    host.innerHTML = `
      <div class="view-pad docs-layout">
        <nav class="docs-nav" aria-label="Sections">
          <input type="search" class="site-input docs-search" placeholder="Search the docs"
            aria-label="Search the docs" spellcheck="false" autocomplete="off" />
          <div class="docs-nav-list">${nav}</div>
        </nav>
        <div class="docs-main page-narrow">
          <header class="page-head-block"><h1>How to use aim4</h1></header>
          ${main}
          <p class="docs-empty" hidden>Nothing found.</p>
        </div>
      </div>`;

    emptyEl = host.querySelector('.docs-empty');
    index = [...host.querySelectorAll('.docs-main section[data-doc]')].map((el) => {
      const id = el.dataset.doc;
      return {
        id,
        el,
        link: host.querySelector(`.docs-nav a[data-doc="${id}"]`),
        group: el.closest('.docs-group'),
        navGroup: host.querySelector(`.docs-nav a[data-doc="${id}"]`)?.closest('.docs-nav-group'),
        text: el.textContent.toLowerCase()
      };
    });

    const search = host.querySelector('.docs-search');
    search.addEventListener('input', () => filter(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && search.value) {
        search.value = '';
        filter('');
      }
    });
  }

  /** Show the sections that mention every word of `query`, hide the rest. */
  function filter(query) {
    const words = String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const shownGroups = new Set();
    const shownNavGroups = new Set();
    let shown = 0;
    for (const s of index) {
      const on = words.every((w) => s.text.includes(w) || s.id.includes(w));
      s.el.hidden = !on;
      if (s.link) s.link.hidden = !on;
      if (on) {
        shown++;
        shownGroups.add(s.group);
        shownNavGroups.add(s.navGroup);
      }
    }
    for (const g of host.querySelectorAll('.docs-group')) g.hidden = !shownGroups.has(g);
    for (const g of host.querySelectorAll('.docs-nav-group')) g.hidden = !shownNavGroups.has(g);
    if (emptyEl) emptyEl.hidden = shown > 0;
  }

  /** Mark one section's link as the one being read, and keep it inside the list's own scroll. */
  function setActive(id) {
    let link = null;
    for (const s of index) {
      const on = s.id === id;
      s.link?.classList.toggle('active', on);
      if (on) link = s.link;
    }
    const list = host.querySelector('.docs-nav-list');
    if (!list || !link) return;
    // By hand, not scrollIntoView: that would move the page as well.
    const above = link.offsetTop - list.offsetTop - list.scrollTop;
    if (above < 0) list.scrollTop += above - 24;
    else if (above + link.offsetHeight > list.clientHeight) list.scrollTop += above + link.offsetHeight - list.clientHeight + 24;
  }

  /**
   * A section jumped to (a link, a deep link) stays marked until the reader
   * scrolls themselves: the last few sections can never reach the top of the
   * page, so the reading band alone would mark the one above them.
   */
  let pinned = '';
  const unpin = () => {
    pinned = '';
  };
  const onHash = () => {
    const id = window.location.hash.slice(1);
    if (!index.some((s) => s.id === id)) return;
    pinned = id;
    setActive(id);
  };

  /**
   * Jump to a section on arrival. The page is still settling then (the site
   * font, the phone layout), and every section above the target that reflows
   * moves it, so for a few seconds it lands again on each change, until the
   * reader scrolls themselves. Instant, not smooth: a smooth scroll aims at
   * where the section was when it started.
   */
  let settle = null;
  function land(id) {
    const target = document.getElementById(id);
    if (!target) return;
    const jump = () => {
      try {
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
      } catch {
        target.scrollIntoView();
      }
    };
    jump();
    onHash();
    if (typeof ResizeObserver === 'undefined') return;
    settle?.disconnect();
    settle = new ResizeObserver(() => {
      if (pinned === id) jump();
    });
    settle.observe(host.querySelector('.docs-main'));
    setTimeout(() => {
      settle?.disconnect();
      settle = null;
    }, 4000);
  }

  /** The section list follows the reading position. */
  function watchPosition() {
    if (observer || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        if (pinned) return;
        const top = index.find((s) => visible.has(s.el));
        if (top) setActive(top.id);
      },
      // The band just under the sticky page header: the section read now.
      { rootMargin: '-90px 0px -65% 0px' }
    );
    for (const s of index) observer.observe(s.el);
    window.addEventListener('hashchange', onHash);
    for (const type of ['wheel', 'touchstart', 'keydown']) window.addEventListener(type, unpin, { passive: true });
  }

  return {
    onShow() {
      render();
      watchPosition();
      // Deep links to a section land on it once the content exists.
      const hash = window.location.hash.slice(1);
      // After the router's own scroll to the top, which runs once onShow returns.
      if (hash) requestAnimationFrame(() => land(hash));
    },
    onHide() {
      observer?.disconnect();
      observer = null;
      settle?.disconnect();
      settle = null;
      window.removeEventListener('hashchange', onHash);
      for (const type of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(type, unpin);
    }
  };
}
