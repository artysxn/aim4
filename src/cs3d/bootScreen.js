// ---------------------------------------------------------------------------
// src/cs3d/bootScreen.js
// The Map Practice boot overlay: opaque grey, map name, percent bar.
// Used by /<map> (via Hud) and by the timeline 3D switch.
// ---------------------------------------------------------------------------

/**
 * Bytes / phase label the explorer already shows.
 * @param {object} p  MapPack onProgress payload
 */
export function packProgress(p) {
  const total = (p.bytesTotal || 0) + (p.texBytesTotal || 0);
  const loaded = (p.bytesLoaded || 0) + (p.texBytesLoaded || 0);
  const streaming = p.phase !== 'manifest' && p.phase !== 'phys';
  const geoDone = streaming && p.groupsLoaded >= p.groupsTotal;
  const texDone = !p.texTotal || p.texLoaded >= p.texTotal;
  const done = !!(geoDone && texDone);
  const frac = total ? loaded / total : p.groupsTotal ? p.groupsLoaded / p.groupsTotal : 0;
  const pct = Math.round(frac * 100);
  const mb = (loaded / 1e6).toFixed(0);
  const mbT = (total / 1e6).toFixed(0);
  const label =
    p.phase === 'manifest' || p.phase === 'phys'
      ? 'collision'
      : p.groupsLoaded < p.groupsTotal
        ? `${mb} / ${mbT} MB`
        : `textures ${p.texLoaded} / ${p.texTotal}`;
  return { done, pct, label };
}

export function createBootScreen(parent, name) {
  const el = document.createElement('div');
  el.className = 'c3-boot';
  el.innerHTML =
    `<div class="c3-boot-name"></div>` +
    `<div class="c3-boot-bar"><span></span></div>` +
    `<div class="c3-boot-text">Loading</div>`;
  el.querySelector('.c3-boot-name').textContent = name || '';
  parent.appendChild(el);
  const bar = el.querySelector('.c3-boot-bar span');
  const text = el.querySelector('.c3-boot-text');
  let booted = false;

  function finish() {
    if (booted) return;
    booted = true;
    bar.style.width = '100%';
    el.classList.add('is-done');
  }

  return {
    el,
    setProgress(p) {
      const { done, pct, label } = packProgress(p);
      if (done) {
        finish();
        return;
      }
      bar.style.width = `${pct}%`;
      text.textContent = `${pct}% · ${label}`;
    },
    finish,
    remove() {
      el.remove();
    }
  };
}
