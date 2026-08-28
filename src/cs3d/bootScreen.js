// ---------------------------------------------------------------------------
// src/cs3d/bootScreen.js
// The 3D boot overlay: map screenshot, name, percent bar, rotating tips.
// Used by /<map> (via Hud) and by the timeline 3D switch.
//
// Two layers of purpose: the bar answers "is it working", and the tips make
// the wait cost something back — a map pack is tens of MB, and thirty seconds
// of reading beats thirty seconds of watching a number climb. The screenshot
// is the map itself, so the reveal underneath lands as "that, but live".
// ---------------------------------------------------------------------------

import { loadingShotUrl, tipCycle } from './loadingTips.js';

/** How long one tip stays up. Long enough to read twice, short enough that a
 *  typical load shows a few. */
const TIP_MS = 6000;

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

/**
 * Dress an existing `.c3-boot` element: screenshot, scrim, rotating tip.
 *
 * Shared with Hud, which builds its own boot markup: the screenshot layer and
 * the tip clock must behave identically on both screens, and two copies of a
 * timer that must never outlive its element is one copy too many.
 *
 * @returns {{ stop(): void }} stop the tip clock; called on reveal/removal.
 */
export function decorateBoot(el, slug) {
  const shotUrl = loadingShotUrl(slug);
  if (shotUrl) {
    const shot = document.createElement('div');
    shot.className = 'c3-boot-shot';
    // Behind the name/bar/tip, whatever order the caller built them in.
    shot.style.backgroundImage = `url(${JSON.stringify(shotUrl)})`;
    el.prepend(shot);
    el.classList.add('has-shot');
  }

  const tip = document.createElement('div');
  tip.className = 'c3-boot-tip';
  tip.innerHTML = `<span class="c3-boot-tip-label">Tip</span><span class="c3-boot-tip-text"></span>`;
  el.appendChild(tip);
  const text = tip.querySelector('.c3-boot-tip-text');

  const next = tipCycle();
  text.textContent = next();

  // Fade out, swap, fade in. The swap waits for the fade so the text never
  // changes mid-read in front of the reader's eyes.
  let timer = window.setInterval(() => {
    tip.classList.add('is-swapping');
    window.setTimeout(() => {
      text.textContent = next();
      tip.classList.remove('is-swapping');
    }, 300);
  }, TIP_MS);

  return {
    stop() {
      if (timer) {
        window.clearInterval(timer);
        timer = 0;
      }
    }
  };
}

export function createBootScreen(parent, name, slug = '') {
  const el = document.createElement('div');
  el.className = 'c3-boot';
  // Same flat children as the Hud's boot markup, so one stylesheet rules both.
  el.innerHTML =
    `<div class="c3-boot-name"></div>` +
    `<div class="c3-boot-bar"><span></span></div>` +
    `<div class="c3-boot-text">Loading</div>`;
  el.querySelector('.c3-boot-name').textContent = name || '';
  parent.appendChild(el);
  const tips = decorateBoot(el, slug);
  const bar = el.querySelector('.c3-boot-bar span');
  const text = el.querySelector('.c3-boot-text');
  let booted = false;

  function finish() {
    if (booted) return;
    booted = true;
    bar.style.width = '100%';
    el.classList.add('is-done');
    tips.stop();
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
      tips.stop();
      el.remove();
    }
  };
}
