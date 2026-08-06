// ---------------------------------------------------------------------------
// replays/savedViews.js
// The save / load / share strip that sits above Charts, Pattern Finder and the
// Database.
//
// All three pages are a small spec object over one cached payload: a chart is
// its axes and filters, a pattern query is its shapes and subjects, a database
// view is its filters and sort. So all three want the same three things, and
// they want them to look and behave identically:
//
//   save    turn what is on screen into something that survives the session
//   load    put a saved one back on screen
//   share   hand someone a link that opens exactly this
//
// The host page supplies two functions and knows nothing else: `read()` returns
// its current spec, `apply(spec)` puts one back. Everything between those two
// lives here.
// ---------------------------------------------------------------------------

import {
  deleteSavedView,
  fetchSavedViews,
  fetchSharedView,
  saveSavedView
} from './api.js';

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
  let busy = false;

  const say = (msg, bad = false) => onStatus?.(msg, bad);

  const mine = () => views.filter((v) => v.page === page);

  function render() {
    const list = mine();
    el.innerHTML = `
      <div class="sv-row">
        <button type="button" class="btn btn-sm" data-sv-save ${busy ? 'disabled' : ''}>
          Save view
        </button>
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
        } title="Copy a link to the selected view">Share</button>
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

  async function doSave() {
    const name = window.prompt('Name this view');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    // Team scope is the useful default for a finding; a private view is one
    // nobody else can act on.
    const team = window.confirm('Share with your team? Cancel keeps it private.');
    busy = true;
    render();
    try {
      views = await saveSavedView({
        name: trimmed,
        page,
        spec: read() || {},
        scope: team ? 'team' : 'private'
      });
      say(`Saved "${trimmed}".`);
    } catch (err) {
      say(err?.message || 'Could not save that view.', true);
    } finally {
      busy = false;
      render();
    }
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

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-sv-save]')) return void doSave();
    if (e.target.closest('[data-sv-delete]')) return void doDelete();
    if (e.target.closest('[data-sv-share]')) return void doShare();
  });

  el.addEventListener('change', (e) => {
    if (!e.target.closest('[data-sv-pick]')) return;
    const view = selected();
    if (view?.spec) apply(view.spec);
  });

  render();

  return {
    el,
    /** Load the list. Safe to call on every page entry. */
    refresh,
    /**
     * Apply `?view=<shareId>` if present. Returns true when one was applied, so
     * the host can skip whatever it would otherwise have restored.
     */
    async applyShareParam(params = {}) {
      const shareId = String(params.view || '').trim();
      if (!shareId) return false;
      try {
        const view = await fetchSharedView(shareId);
        if (!view || view.page !== page) return false;
        apply(view.spec || {});
        say(`Opened "${view.name}".`);
        return true;
      } catch (err) {
        say(err?.message || 'That shared view could not be opened.', true);
        return false;
      }
    }
  };
}
