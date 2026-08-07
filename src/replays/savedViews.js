// ---------------------------------------------------------------------------
// replays/savedViews.js
// URL sync + optional named saved views for Charts, Pattern Finder and the
// Database.
//
// Filter state lives in the address bar the same way Database already did:
// change a filter (or draw a pattern rectangle) and `touch()` rewrites the
// query string. There is no Copy / Share button — the browser URL is the link.
//
// Charts and Pattern Finder pack the whole spec into `?v=…`. Database keeps
// its own flat query params and only uses this module for named saved views.
//
// The host page supplies `read()` / `apply(spec)`. Everything else lives here.
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
    // pack the whole spec (axes, filters, drawn shapes) into `v`.
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
    // Named views are optional; the URL sync does not need chrome.
    if (!list.length) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <div class="sv-row">
        <select class="site-select sv-pick" data-sv-pick title="Saved views">
          <option value="">Saved views</option>
          ${list
            .map(
              (v) =>
                `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}${
                  v.scope === 'team' ? ' (team)' : ''
                }</option>`
            )
            .join('')}
        </select>
        <button type="button" class="btn btn-sm danger" data-sv-delete
          title="Delete the selected view">Delete</button>
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

  /** Refresh the address bar from the host's current spec. */
  function touch() {
    syncAddressBar(liveUrl());
    if (!loaded) return;
    // Keep the pick list mounted if it was already showing.
    if (!el.hidden && !el.querySelector('[data-sv-pick]')) render();
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

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-sv-delete]')) return void doDelete();
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
    /** Recompute the live URL from `read()` and write it to the address bar. */
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
