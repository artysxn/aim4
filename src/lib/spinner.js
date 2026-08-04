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
  const text = label ? `<span>${escapeHtml(label)}</span>` : '';
  return `<div class="is-loading${extra}" role="status" aria-live="polite"><span class="spinner${size}" aria-hidden="true"></span>${text}<span class="sr-only">Loading</span></div>`;
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

  if (label) {
    const text = document.createElement('span');
    text.textContent = label;
    wrap.appendChild(text);
  }
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
  'This is taking longer than usual. The API may be starting, rebuilding stats, or unreachable. Check the server and your connection.';

/**
 * After `delayMs`, append a hint under the first `.is-loading` in `host`
 * (or replace `host` contents if it is the loader). Cleared via the return value.
 *
 * @param {ParentNode|null} host
 * @param {{ delayMs?: number, message?: string }} [opts]
 * @returns {() => void} cancel
 */
export function watchSlowLoad(host, opts = {}) {
  if (!host) return () => {};
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : SLOW_LOAD_MS;
  const message = opts.message || SLOW_LOAD_HINT;
  const timer = globalThis.setTimeout?.(() => {
    try {
      if (typeof host.isConnected === 'boolean' && !host.isConnected) return;
      const loading = host.querySelector?.('.is-loading') || host;
      if (!loading || loading.querySelector?.('.load-slow-hint')) return;
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
