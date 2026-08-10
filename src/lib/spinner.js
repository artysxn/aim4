// ---------------------------------------------------------------------------
// lib/spinner.js
// The one loading indicator.
//
// Every panel used to render the literal string "Loading…" and leave it there
// until data arrived. Static text is indistinguishable from a page that has
// given up, which is exactly the wrong signal on the screens that take longest.
// A ring is still visibly turning while a slow request finishes.
//
// Styles live in src/site/site.css (`.spinner`, `.is-loading`), which the
// replays bundle also loads.
// ---------------------------------------------------------------------------

/**
 * Markup for an inline loading block. Label is optional and usually omitted:
 * the ring says "working" on its own.
 *
 * @param {string} [label]
 * @param {{size?: 'sm'|'md'|'lg', className?: string}} [opts]
 */
export function spinnerHtml(label = '', opts = {}) {
  const size = opts.size === 'sm' ? ' spinner-sm' : opts.size === 'lg' ? ' spinner-lg' : '';
  const extra = opts.className ? ` ${opts.className}` : '';
  const text = label
    ? `<span data-load-label>${escapeHtml(label)}</span>`
    : '<span data-load-label hidden></span>';
  return `<div class="is-loading${extra}" role="status" aria-live="polite"><span class="spinner${size}" aria-hidden="true"></span>${text}<span class="sr-only">Loading</span></div>`;
}

/**
 * Update the visible label on an in-place spinner (and clear a stale slow hint).
 * @param {ParentNode|null} host
 * @param {string} label
 */
export function setSpinnerLabel(host, label) {
  if (!host) return;
  const text = String(label || '').trim();
  if (!text) return;
  try {
    const loading = host.classList?.contains('is-loading')
      ? host
      : host.querySelector?.('.is-loading');
    if (!loading) return;
    let el = loading.querySelector('[data-load-label]');
    if (!el) {
      el = document.createElement('span');
      el.setAttribute('data-load-label', '');
      loading.appendChild(el);
    }
    el.hidden = false;
    el.textContent = text;
    host.querySelector?.('.load-slow-hint')?.remove();
    loading.parentElement?.querySelector?.('.load-slow-hint')?.remove();
  } catch {
    /* host may have been replaced mid-load */
  }
}

/**
 * The same thing as a DOM node, for the panels that build with createElement
 * rather than innerHTML.
 *
 * @param {string} [label]
 * @param {{size?: 'sm'|'md'|'lg', className?: string}} [opts]
 */
export function spinnerNode(label = '', opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `is-loading${opts.className ? ` ${opts.className}` : ''}`;
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');

  const ring = document.createElement('span');
  ring.className = `spinner${opts.size === 'sm' ? ' spinner-sm' : opts.size === 'lg' ? ' spinner-lg' : ''}`;
  ring.setAttribute('aria-hidden', 'true');
  wrap.appendChild(ring);

  const text = document.createElement('span');
  text.setAttribute('data-load-label', '');
  if (label) text.textContent = label;
  else text.hidden = true;
  wrap.appendChild(text);
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** Default copy when a load is still running after SLOW_LOAD_MS. */
export const SLOW_LOAD_MS = 4000;

export const SLOW_LOAD_HINT =
  'No response from the server yet. Check that the API is running and your connection is up.';

/**
 * After `delayMs`, append a hint under the first `.is-loading` in `host`
 * (or replace `host` contents if it is the loader). Cleared via the return value.
 *
 * Skips the hint when the spinner label has already been updated with real
 * progress (that label is the honest status; a second vague line is noise).
 *
 * @param {ParentNode|null} host
 * @param {{ delayMs?: number, message?: string }} [opts]
 * @returns {() => void} cancel
 */
export function watchSlowLoad(host, opts = {}) {
  if (!host) return () => {};
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : SLOW_LOAD_MS;
  const message = opts.message || SLOW_LOAD_HINT;
  const initialLabel = (() => {
    try {
      return host.querySelector?.('[data-load-label]')?.textContent || '';
    } catch {
      return '';
    }
  })();
  const timer = globalThis.setTimeout?.(() => {
    try {
      if (typeof host.isConnected === 'boolean' && !host.isConnected) return;
      const loading = host.querySelector?.('.is-loading') || host;
      if (!loading || loading.querySelector?.('.load-slow-hint')) return;
      const labelNow = loading.querySelector?.('[data-load-label]')?.textContent || '';
      // Progress already replaced the placeholder. Do not stack a second hint.
      if (labelNow && labelNow !== initialLabel) return;
      const hint = document.createElement('p');
      hint.className = 'view-empty load-slow-hint';
      hint.textContent = message;
      if (loading.classList?.contains('is-loading')) {
        loading.insertAdjacentElement('afterend', hint);
      } else {
        loading.appendChild(hint);
      }
    } catch {
      /* host may have been replaced */
    }
  }, delayMs);
  return () => {
    if (timer) globalThis.clearTimeout?.(timer);
  };
}

/**
 * Human label for a stats-stream progress event.
 * @param {{ done?: number, total?: number, current?: string|null, phase?: string }} p
 */
export function statsProgressLabel(p) {
  if (!p || !Number(p.total)) {
    if (p?.phase === 'packing') return 'Packing database…';
    if (p?.phase === 'receiving') return 'Receiving database…';
    if (p?.phase === 'building-table') return 'Building table…';
    return 'Loading stats…';
  }
  const done = Math.max(0, Number(p.done) || 0);
  const total = Math.max(0, Number(p.total) || 0);
  // `done` is completed count; while a demo is in flight show the current index.
  const shown =
    p.phase === 'ready' || p.phase === 'start' || p.phase === 'packing'
      ? `${done}/${total}`
      : `${Math.min(done + 1, total)}/${total}`;
  const name = p.current ? ` · ${String(p.current)}` : '';
  switch (p.phase) {
    case 'building':
      return `Building stats ${shown}${name}`;
    case 'rebuilding':
      return `Rebuilding stats ${shown}${name}`;
    case 'enriching':
      return `Updating stats ${shown}${name}`;
    case 'start':
      return total ? `Loading stats · ${total} demos` : 'Loading stats…';
    case 'ready':
      return done < total ? `Loading stats ${shown}${name}` : `Indexed ${total} demos`;
    case 'packing':
      return total ? `Packing database · ${total} demos` : 'Packing database…';
    case 'receiving':
      return total ? `Receiving database · ${total} demos` : 'Receiving database…';
    case 'building-table':
      return 'Building table…';
    default:
      return `Loading stats ${shown}${name}`;
  }
}
