// ---------------------------------------------------------------------------
// src/site/changelogView.js
// /changelog: what changed, in user language, newest first.
// Content lives in changelogData.js and is edited by hand — see its header.
// ---------------------------------------------------------------------------

import { CHANGELOG } from './changelogData.js';

export function initChangelogView(host, { escapeHtml }) {
  if (!host) return { onShow() {}, onHide() {} };
  let rendered = false;

  function render() {
    if (rendered) return;
    rendered = true;
    const esc = escapeHtml;
    host.innerHTML = `
      <div class="view-pad page-narrow">
        <header class="page-head-block">
          <h1>Changelog</h1>
          <p class="page-lede">What changed on aim4, written for the people using it. Newest first.</p>
        </header>
        <div class="changelog">
          ${CHANGELOG.map(
            (entry) => `
            <article class="changelog-entry">
              <div class="changelog-when">
                <time datetime="${esc(entry.date)}">${esc(entry.date)}</time>
                ${entry.tag ? `<span class="changelog-tag is-${esc(entry.tag)}">${esc(entry.tag)}</span>` : ''}
              </div>
              <div class="changelog-body">
                <h2>${esc(entry.title)}</h2>
                <ul>
                  ${entry.points.map((p) => `<li>${esc(p)}</li>`).join('')}
                </ul>
              </div>
            </article>`
          ).join('')}
        </div>
        <p class="page-foot-note">Something broken, or missing from here? <a href="/contact">Tell us.</a></p>
      </div>`;
  }

  return {
    onShow() {
      render();
    },
    onHide() {}
  };
}
