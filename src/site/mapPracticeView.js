// ---------------------------------------------------------------------------
// site/mapPracticeView.js
// Map Practice: the front door to the 3D map explorer. One card per map on the
// roster; opening one navigates to /<slug>, which is a separate document
// (cs3d.html) rather than a view in this shell — the explorer owns the whole
// window, its own pointer lock and its own WebGPU context, so it is a real
// navigation and not a data-nav swap.
// ---------------------------------------------------------------------------

import { CS3D_MAPS } from '../../shared/cs3d/maps.js';

/** The explorer answers to /de_<name> for every map; bare /<slug> is opt-out. */
function hrefFor(map) {
  return map.bareRoute === false ? `/de_${map.slug}` : `/${map.slug}`;
}

export function initMapPracticeView({ escapeHtml }) {
  const listEl = document.getElementById('map-practice-list');
  if (!listEl) return { onShow() {}, onHide() {} };

  let painted = false;

  function render() {
    listEl.innerHTML = CS3D_MAPS.map((m) => {
      const href = escapeHtml(hrefFor(m));
      const name = escapeHtml(m.name);
      return `<div class="mp-row">
        <span class="mp-row-title">${name}</span>
        <a class="btn btn-sm mp-play" href="${href}">Play</a>
      </div>`;
    }).join('');
  }

  return {
    onShow() {
      // The roster is a compile-time constant, so one paint is enough.
      if (painted) return;
      painted = true;
      render();
    },
    onHide() {}
  };
}
