// ---------------------------------------------------------------------------
// replays/savedViews.js
// The save / load / share strip that sits above Charts, Pattern Finder and the
// Database.
//
// All three pages are a small spec object over one cached payload: a chart is
// its axes and filters, a pattern query is its shapes and subjects, a database
// view is its filters and sort. So all three want the same things, and they
// want them to look and behave identically:
//
//   url     the current view encoded into a shareable link (always visible)
//   load    put a named saved one back on screen
//   share   hand someone a link to a named saved view
//
// The host page supplies two functions and knows nothing else: `read()` returns
// its current spec, `apply(spec)` puts one back. Everything between those two
// lives here.
// ---------------------------------------------------------------------------

import {
  deleteSavedView,
  fetchSavedViews,
  fetchSharedView
} from './api.js';

function encodeViewSpec(spec) {
  try {
    const json = JSON.stringify(spec || {});
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  } catch {
    return '';
  }
}

function decodeViewSpec(raw) {
  try {
    const pad = raw.length % 4 === 0 ? '' : '='.repeat(4 - (raw.length % 4));
    const b64 = String(raw || '').replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {'charts'|'patterns'|'database'} opts.page
 * @param {() => object} opts.read      current spec, from the host page
 * @param {(spec: object) => void} opts.apply  put a spec back on the page
 * @param {(s: string) => string} opts.escapeHtml
 * @param {(msg: string, bad?: boolean) => void} [opts.onStatus]
 */
export function createSavedViews({ page, read, apply, escapeHtml, onStatus }) {
  const el = document.createElement('div');
  el.className = 'sv-bar';

  /** @type {Array<object>} */
  let views = [];
  let loaded = false;

  const say = (msg, bad = false) => onStatus?.(msg, bad);

  const mine = () => views.filter((v) => v.page === page);

  /** Live link for whatever is on screen right now. */
  function liveUrl() {
    const url = new URL(window.location.href);
    // Database already mirrors filters into the address bar; charts / patterns
    // pack the whole spec into `v` so a pasted link restores them.
    if (page === 'database') {
      url.searchParams.delete('v');
      return url.toString();
    }
    url.searchParams.delete('view');
    const packed = encodeViewSpec(read() || {});
    if (packed) url.searchParams.set('v', packed);
    else url.searchParams.delete('v');
    return url.toString();
  }

  /** Keep the address bar in sync for charts / patterns (database already does). */
  function syncAddressBar(href) {
    if (page === 'database') return;
    try {
      const next = new URL(href, window.location.origin);
      const cur = window.location.pathname + window.location.search;
      const want = next.pathname + next.search;
      if (cur === want) return;
      window.history.replaceState(window.history.state, '', want);
    } catch {
      /* ignore */
    }
  }

  function render() {
    const list = mine();
    const href = liveUrl();
    el.innerHTML = `
      <div class="sv-row">
        <input class="site-input sv-url" type="text" readonly data-sv-url
          value="${escapeHtml(href)}" aria-label="View URL" title="Link with the current filters" />
        <button type="button" class="btn btn-sm" data-sv-copy title="Copy view URL">Copy</button>
        <select class="site-select sv-pick" data-sv-pick ${
          list.length ? '' : 'disabled'
        } title="Saved views">
          <option value="">${list.length ? 'Saved views' : 'No saved views'}</option>
          ${list
            .map(
              (v) =>
                `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}${
                  v.scope === 'team' ? ' (team)' : ''
                }</option>`
            )
            .join('')}
        </select>
        <button type="button" class="btn btn-sm" data-sv-share ${
          list.length ? '' : 'disabled'
        } title="Copy a link to the selected saved view">Share</button>
        <button type="button" class="btn btn-sm danger" data-sv-delete ${
          list.length ? '' : 'disabled'
        } title="Delete the selected view">Delete</button>
      </div>`;
  }

  const selectedId = () => el.querySelector('[data-sv-pick]')?.value || '';
  const selected = () => mine().find((v) => v.id === selectedId()) || null;

  async function refresh() {
    if (loaded) return;
    try {
      views = await fetchSavedViews();
    } catch {
      views = [];
    }
    loaded = true;
    render();
  }

  /** Refresh the URL field (and address bar) from the host's current spec. */
  function touch() {
    const href = liveUrl();
    syncAddressBar(href);
    if (!loaded && !el.querySelector('[data-sv-url]')) {
      render();
      return;
    }
    const input = el.querySelector('[data-sv-url]');
    if (input) input.value = href;
    else render();
  }

  async function doDelete() {
    const view = selected();
    if (!view) return;
    if (!window.confirm(`Delete "${view.name}"?`)) return;
    try {
      views = await deleteSavedView(view.id);
      say('Deleted.');
    } catch (err) {
      say(err?.message || 'Could not delete that view.', true);
    }
    render();
  }

  async function doShare() {
    const view = selected();
    if (!view?.shareId) return;
    const url = new URL(window.location.pathname, window.location.origin);
    url.searchParams.set('view', view.shareId);
    try {
      await navigator.clipboard.writeText(url.toString());
      say('Link copied.');
    } catch {
      say(url.toString());
    }
  }

  async function doCopy() {
    const href = el.querySelector('[data-sv-url]')?.value || liveUrl();
    try {
      await navigator.clipboard.writeText(href);
      say('View link copied.');
    } catch {
      say(href);
    }
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-sv-copy]')) return void doCopy();
    if (e.target.closest('[data-sv-delete]')) return void doDelete();
    if (e.target.closest('[data-sv-share]')) return void doShare();
    if (e.target.closest('[data-sv-url]')) {
      e.target.select?.();
    }
  });

  el.addEventListener('change', (e) => {
    if (!e.target.closest('[data-sv-pick]')) return;
    const view = selected();
    if (view?.spec) {
      apply(view.spec);
      touch();
    }
  });

  render();

  return {
    el,
    /** Load the list. Safe to call on every page entry. */
    refresh,
    /** Recompute the live URL from `read()`. */
    touch,
    /**
     * Apply `?view=<shareId>` or `?v=<encoded spec>` if present.
     * Returns true when one was applied.
     */
    async applyShareParam(params = {}) {
      const packed = String(params.v || '').trim();
      if (packed) {
        const spec = decodeViewSpec(packed);
        if (spec && typeof spec === 'object') {
          apply(spec);
          say('Opened shared view.');
          touch();
          return true;
        }
      }
      const shareId = String(params.view || '').trim();
      if (!shareId) return false;
      try {
        const view = await fetchSharedView(shareId);
        if (!view || view.page !== page) return false;
        apply(view.spec || {});
        say(`Opened "${view.name}".`);
        touch();
        return true;
      } catch (err) {
        say(err?.message || 'That shared view could not be opened.', true);
        return false;
      }
    }
  };
}
