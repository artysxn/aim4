// ---------------------------------------------------------------------------
// site/bookmarksStorage.js
// The Storage tab in Bookmarks: how much room is left, and what is using it.
// ---------------------------------------------------------------------------

import { fetchStorage } from '../replays/api.js';
import { formatBytes } from '../replays/tickStore.js';
import { spinnerHtml } from '../lib/spinner.js';

/** The meter is of what the library could reach: what it holds, and what is left. */
function usedPercent(s) {
  const room = s.bytes + s.bytesLeft;
  return room > 0 ? Math.min(100, (s.bytes / room) * 100) : 0;
}

const row = (label, value) =>
  `<div class="rp-quota-row"><span class="rp-quota-label">${label}</span><span class="rp-quota-value">${value}</span></div>`;

/**
 * @param {{ host: HTMLElement, escapeHtml: (s: string) => string }} opts
 */
export function createBookmarksStorage({ host, escapeHtml }) {
  /** Only the latest request paints: switching tabs back and forth can send two. */
  let request = 0;

  async function show() {
    const mine = ++request;
    if (!host.firstElementChild) host.innerHTML = spinnerHtml('Loading storage…');
    try {
      const s = await fetchStorage();
      if (mine !== request) return;
      host.innerHTML = `
        <div class="bm-storage">
          <p class="bm-storage-left"><strong>${formatBytes(s.bytesLeft)}</strong> left</p>
          <div class="rp-meter"><span style="width:${usedPercent(s)}%"></span></div>
          ${row('Visual notes', formatBytes(s.gifBytes))}
          ${row('Demos', formatBytes(s.demoBytes))}
          ${row('Rounds', formatBytes(s.roundBytes))}
          ${row('Comms', formatBytes(s.commsBytes))}
          ${row('Total', formatBytes(s.bytes))}
          ${row('Your notes', `${s.notes.count} of ${s.notes.max}`)}
        </div>`;
    } catch (err) {
      if (mine !== request) return;
      host.innerHTML = `<p class="rp-status error">${escapeHtml(err.message || 'Storage could not be loaded.')}</p>`;
    }
  }

  return { show };
}
