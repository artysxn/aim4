// ---------------------------------------------------------------------------
// replays/viewer/macroViewer.js
// Every selected round on screen at once, each on its own small radar, all
// playing the same moment of their own round. Filter to "every A-site full
// buy on Ancient" and you get one grid where the shared habits are obvious.
//
// Loading is deliberately not the timeline's two-pass scheme: a grid shows
// all rounds all the time, so a coarse pass would just be a worse picture of
// everything. It loads every tick of one round, then the next, in order, and
// tiles light up as their data lands.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { RadarRenderer } from './radarRenderer.js';
import { Playback } from './playback.js';
import { clockAt, timingFor, totalSeconds } from './roundClock.js';
import { economyLabel } from '../shared/roundId.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

export function createMacroViewer({ store, rounds, escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'rv-macro';
  el.innerHTML = `
    <div class="rv-macro-bar">
      <span class="rv-macro-count">${rounds.length} rounds</span>
      <button type="button" class="rv-speed" id="rv-macro-speed">x1</button>
      <button type="button" class="rv-play" id="rv-macro-play" aria-label="Play">
        <svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-200v-560l440 280-440 280Z"/></svg>
      </button>
      <div class="rv-scrub" id="rv-macro-scrub">
        <div class="rv-scrub-track"><div class="rv-scrub-fill" id="rv-macro-fill"></div></div>
        <div class="rv-scrub-handle" id="rv-macro-handle"></div>
      </div>
      <span class="rv-macro-clock" id="rv-macro-clock">00:00</span>
      <span class="rv-macro-load" id="rv-macro-load"></span>
    </div>
    <div class="rv-grid" id="rv-grid"></div>`;

  const gridEl = el.querySelector('#rv-grid');
  const clockEl = el.querySelector('#rv-macro-clock');
  const loadEl = el.querySelector('#rv-macro-load');
  const playBtn = el.querySelector('#rv-macro-play');
  const speedBtn = el.querySelector('#rv-macro-speed');
  const scrubEl = el.querySelector('#rv-macro-scrub');
  const fillEl = el.querySelector('#rv-macro-fill');
  const handleEl = el.querySelector('#rv-macro-handle');

  /** @type {Array<{round: object, meta: object|null, renderer: RadarRenderer, states: Array, timing: object}>} */
  const tiles = [];
  let speedIndex = 2;
  let destroyed = false;

  // All tiles share one position, measured from each round's own start, so
  // "20 seconds in" lines up across rounds of different lengths.
  const playback = new Playback((pos) => draw(pos));

  gridEl.innerHTML = rounds
    .map(
      (r, i) => `
      <figure class="rv-tile" data-index="${i}">
        <canvas class="rv-tile-canvas"></canvas>
        <figcaption class="rv-tile-cap">
          <span class="rv-tile-round ${r.winner === 1 ? 'w1' : 'w2'}">R${String(r.round).padStart(2, '0')}</span>
          <span class="rv-tile-econ">${escapeHtml(
            `${economyLabel(r.econ1)} / ${economyLabel(r.econ2)}`
          )}</span>
        </figcaption>
        <span class="rv-tile-state">queued</span>
      </figure>`
    )
    .join('');

  rounds.forEach((round, i) => {
    const fig = gridEl.querySelector(`.rv-tile[data-index="${i}"]`);
    tiles.push({
      round,
      meta: null,
      renderer: new RadarRenderer(fig.querySelector('canvas')),
      states: [],
      timing: timingFor(round),
      stateEl: fig.querySelector('.rv-tile-state')
    });
  });

  function longestRound() {
    return tiles.reduce((max, t) => Math.max(max, totalSeconds(t.timing)), 1);
  }

  async function loadMeta() {
    await Promise.all(
      tiles.map(async (tile, i) => {
        const meta = await fetchRoundMeta(rounds[i].file).catch(() => null);
        if (destroyed || !meta) return;
        tile.meta = meta;
        tile.timing = timingFor(meta);
        await tile.renderer.setMap(meta.map || rounds[i].map);
      })
    );
    if (destroyed) return;
    playback.setDuration(longestRound());
    draw(playback.position);
  }

  function draw(pos) {
    let loadedTiles = 0;
    for (const tile of tiles) {
      const track = store.track(tile.round.file);
      if (!tile.meta) continue;
      if (track) loadedTiles++;

      const tick = tile.timing.startTick + pos * tile.timing.tickRate;
      const past = tick > tile.timing.officialEndTick;
      if (track) track.sampleAll(Math.min(tick, tile.timing.officialEndTick), tile.states);

      tile.renderer.render({
        tick,
        tickRate: tile.timing.tickRate,
        states: tile.states,
        players: tile.meta.players || [],
        events: tile.meta.events || {},
        weapons: tile.meta.weapons || [],
        compact: true
      });

      if (tile.stateEl) {
        const label = !track ? 'loading' : past ? 'ended' : '';
        if (tile.stateEl.textContent !== label) tile.stateEl.textContent = label;
        tile.stateEl.hidden = !label;
      }
    }

    const reference = tiles.find((t) => t.meta) || tiles[0];
    if (reference?.meta) {
      const tick = reference.timing.startTick + pos * reference.timing.tickRate;
      clockEl.textContent = clockAt(reference.timing, tick).label;
    }
    const pct = playback.duration ? (pos / playback.duration) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    handleEl.style.left = `${pct}%`;
    loadEl.textContent =
      loadedTiles === tiles.length ? '' : `${loadedTiles}/${tiles.length} rounds loaded`;
  }

  // ---- transport ----------------------------------------------------------

  playBtn.addEventListener('click', () => {
    playback.toggle();
    playBtn.classList.toggle('playing', playback.playing);
    playBtn.innerHTML = playback.playing
      ? '<svg viewBox="0 -960 960 960" width="18" height="18"><path d="M520-200v-560h240v560H520Zm-320 0v-560h240v560H200Z"/></svg>'
      : '<svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-200v-560l440 280-440 280Z"/></svg>';
  });

  speedBtn.addEventListener('click', () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    playback.setSpeed(SPEEDS[speedIndex]);
    speedBtn.textContent = `x${SPEEDS[speedIndex]}`;
  });

  let scrubbing = false;
  const seekFromEvent = (e) => {
    const rect = scrubEl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playback.seek(f * playback.duration);
  };
  scrubEl.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    scrubEl.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  scrubEl.addEventListener('pointermove', (e) => {
    if (scrubbing) seekFromEvent(e);
  });
  scrubEl.addEventListener('pointerup', (e) => {
    scrubbing = false;
    scrubEl.releasePointerCapture(e.pointerId);
  });

  const onResize = () => draw(playback.position);
  window.addEventListener('resize', onResize);

  const offStore = store.onChange((event) => {
    if (event.type === 'macro-progress' || event.type === 'full') draw(playback.position);
  });

  (async () => {
    await loadMeta();
    if (destroyed) return;
    // Full detail, one round at a time, in order.
    store.macroPass(rounds.map((r) => r.file));
  })();

  return {
    el,
    destroy() {
      destroyed = true;
      playback.destroy();
      offStore();
      window.removeEventListener('resize', onResize);
    }
  };
}
