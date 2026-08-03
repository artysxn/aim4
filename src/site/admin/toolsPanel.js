// ---------------------------------------------------------------------------
// src/site/admin/toolsPanel.js
// Site-wide maintenance actions (stats rebuild, …).
// ---------------------------------------------------------------------------

import { adminApi } from './adminApi.js';
import { button, el, render } from './dom.js';

export function toolsPanel() {
  const root = el('div', 'admin-panel');
  const status = el('p', 'admin-note', '');
  let running = false;

  const runBtn = button('Recalculate all statistics', async () => {
    if (running) return;
    if (
      !window.confirm(
        'Rebuild statistics for every ready demo from parsed round data?\n\nThis can take several minutes on a large library.'
      )
    ) {
      return;
    }
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = 'Recalculating…';
    status.className = 'admin-note';
    status.textContent =
      'Running… The page will wait until every demo’s stats index is rebuilt.';
    try {
      const report = await adminApi.refreshStats({ force: true });
      const failed = report.failed || 0;
      const parts = [
        `Done in ${Math.round((report.ms || 0) / 1000)}s.`,
        `${report.ready || 0} ready demos.`,
        `${report.built || 0} rebuilt`,
        `${report.enriched || 0} enriched`,
        `${report.current || 0} already current`
      ];
      if (failed) parts.push(`${failed} failed`);
      status.className = failed ? 'admin-error' : 'admin-note';
      status.textContent = parts.join(' ');
      if (failed && report.errors?.length) {
        const sample = report.errors
          .slice(0, 5)
          .map((e) => `${e.filename || e.id}: ${e.error}`)
          .join(' · ');
        status.textContent += ` — ${sample}`;
      }
    } catch (err) {
      status.className = 'admin-error';
      status.textContent = err.message || 'Recalculation failed.';
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.textContent = 'Recalculate all statistics';
    }
  }, 'btn primary');

  const card = el('div', 'admin-tool-card');
  card.appendChild(el('h3', 'admin-tool-title', 'Replay statistics'));
  card.appendChild(
    el(
      'p',
      'admin-note',
      'Rebuild every demo’s compact stats index from already-parsed round files (rating inputs, PRW, possession, swing, and related fields). Use this after a stats schema change or if Database / Pattern Finder numbers look stale.'
    )
  );
  card.appendChild(runBtn);
  card.appendChild(status);

  render(root, card);
  return root;
}
