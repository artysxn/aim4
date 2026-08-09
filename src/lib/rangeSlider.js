// ---------------------------------------------------------------------------
// A two-handle range slider: one track, two grips, the selection lit between.
//
// Two stacked <input type="range"> elements share one drawn track. The inputs
// themselves are transparent and pass pointer events straight through; only
// their thumbs take input, so a click anywhere on the track still grabs the
// nearer handle rather than whichever input happens to be on top.
//
// Used by the document widgets and by the analyzer's grenade timeline, so a
// window over a round is set the same way wherever it appears.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {number} [opts.step]
 * @param {string} [opts.label]  what the pair is selecting, for screen readers
 * @param {(from: number, to: number) => void} [opts.onChange]
 * @returns {{ el: HTMLElement, get: () => {from: number, to: number},
 *   set: (from: number, to: number) => void }}
 */
export function createRangeSlider({
  min = 0,
  max = 100,
  from = min,
  to = max,
  step = 1,
  label = 'Range',
  onChange = () => {}
} = {}) {
  const span = Math.max(1e-6, max - min);
  let lo = Math.max(min, Math.min(max, from));
  let hi = Math.max(lo, Math.min(max, to));

  const el = document.createElement('div');
  el.className = 'rs';

  const track = document.createElement('div');
  track.className = 'rs-track';
  const fill = document.createElement('div');
  fill.className = 'rs-fill';
  track.appendChild(fill);

  const input = (which) => {
    const node = document.createElement('input');
    node.type = 'range';
    node.className = `rs-input rs-${which}`;
    node.min = String(min);
    node.max = String(max);
    node.step = String(step);
    node.setAttribute(
      'aria-label',
      which === 'lo' ? `${label}, start` : `${label}, end`
    );
    node.addEventListener('input', () => {
      const v = Number(node.value);
      // The handles never cross; each one stops at the other.
      if (which === 'lo') lo = Math.min(v, hi);
      else hi = Math.max(v, lo);
      node.value = String(which === 'lo' ? lo : hi);
      paint();
      onChange(lo, hi);
    });
    return node;
  };

  const loEl = input('lo');
  const hiEl = input('hi');
  el.append(track, loEl, hiEl);

  // Whichever handle the pointer is nearer to comes to the front, so a pair
  // sitting on top of each other can still be pulled apart in either
  // direction. Without this the top input always wins and one end sticks.
  el.addEventListener('pointermove', (ev) => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const at = min + ((ev.clientX - rect.left) / rect.width) * span;
    const dLo = Math.abs(at - lo);
    const dHi = Math.abs(at - hi);
    // Handles sitting on top of each other tie on distance. Break it by which
    // side the pointer is on, so the one that can actually move towards it
    // wins: otherwise a collapsed pair can only ever be pulled one way.
    const nearLo = dLo === dHi ? at < lo : dLo < dHi;
    loEl.classList.toggle('is-front', nearLo);
    hiEl.classList.toggle('is-front', !nearLo);
  });

  function paint() {
    const a = ((lo - min) / span) * 100;
    const b = ((hi - min) / span) * 100;
    fill.style.left = `${a}%`;
    fill.style.width = `${Math.max(0, b - a)}%`;
    loEl.value = String(lo);
    hiEl.value = String(hi);
  }

  paint();

  return {
    el,
    get: () => ({ from: lo, to: hi }),
    set(nextFrom, nextTo) {
      lo = Math.max(min, Math.min(max, nextFrom));
      hi = Math.max(lo, Math.min(max, nextTo));
      paint();
    }
  };
}
