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
