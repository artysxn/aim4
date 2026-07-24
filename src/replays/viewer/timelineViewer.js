// ---------------------------------------------------------------------------
// replays/viewer/timelineViewer.js
// One round on screen at a time, with the whole selection stitched into a
// single timeline: pressing play at round 1 plays the game through.
//
// Loading follows the two-pass rule. The coarse pass (every 100th tick of
// every round) runs as soon as the viewer opens, so the scrub bar is live
// immediately and any round can be previewed. The full pass then fills in the
// round being watched first, and rounds already filled stay in memory until
// the viewer closes.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { COARSE_STRIDE } from '../tickStore.js';
import { RadarRenderer, TEAM_COLORS } from './radarRenderer.js';
import { Playback, RoundSequence } from './playback.js';
import { clockAt, formatClock, phaseMarkers, timingFor } from './roundClock.js';
import { economyLabel } from '../shared/roundId.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

export function createTimelineViewer({ store, rounds, escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'rv-timeline';
  el.innerHTML = `
    <div class="rv-stage">
      <aside class="rv-team rv-team-1" data-team="1"></aside>
      <div class="rv-map">
        <div class="rv-clock" id="rv-clock">00:00</div>
        <canvas class="rv-canvas" id="rv-canvas"></canvas>
        <div class="rv-loading" id="rv-loading"></div>
      </div>
      <aside class="rv-team rv-team-2" data-team="2"></aside>
    </div>
    <div class="rv-rounds" id="rv-rounds"></div>
    <div class="rv-transport">
      <button type="button" class="rv-speed" id="rv-speed">x1</button>
      <button type="button" class="rv-play" id="rv-play" aria-label="Play">
        <svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-200v-560l440 280-440 280Z"/></svg>
      </button>
      <div class="rv-scrub" id="rv-scrub">
        <div class="rv-scrub-track"><div class="rv-scrub-fill" id="rv-scrub-fill"></div></div>
        <div class="rv-scrub-marks" id="rv-scrub-marks"></div>
        <div class="rv-scrub-handle" id="rv-scrub-handle"></div>
      </div>
      <span class="rv-time" id="rv-time">00:00</span>
    </div>`;

  const canvas = el.querySelector('#rv-canvas');
  const clockEl = el.querySelector('#rv-clock');
  const loadingEl = el.querySelector('#rv-loading');
  const roundsEl = el.querySelector('#rv-rounds');
  const scrubEl = el.querySelector('#rv-scrub');
  const fillEl = el.querySelector('#rv-scrub-fill');
  const marksEl = el.querySelector('#rv-scrub-marks');
  const handleEl = el.querySelector('#rv-scrub-handle');
  const timeEl = el.querySelector('#rv-time');
  const playBtn = el.querySelector('#rv-play');
  const speedBtn = el.querySelector('#rv-speed');
  const team1El = el.querySelector('.rv-team-1');
  const team2El = el.querySelector('.rv-team-2');

  const renderer = new RadarRenderer(canvas);
  const metaCache = new Map();
  const files = rounds.map((r) => r.file);

  let sequence = new RoundSequence(rounds.map(() => ({})));
  let activeIndex = -1;
  let activeMeta = null;
  let speedIndex = 2;
  let destroyed = false;
  const states = [];

  const playback = new Playback((pos) => onPosition(pos));

  // ---- metadata -----------------------------------------------------------

  async function metaFor(file) {
    if (metaCache.has(file)) return metaCache.get(file);
    const p = fetchRoundMeta(file).catch(() => null);
    metaCache.set(file, p);
    return p;
  }

  /**
   * Round records carry the phase ticks the clock needs. They are fetched up
   * front for every selected round because the sequence needs each round's
   * duration before a continuous timeline can exist at all.
   */
  async function buildSequence() {
    const metas = await Promise.all(files.map(metaFor));
    if (destroyed) return;
    metas.forEach((m, i) => {
      if (m) metaCache.set(files[i], Promise.resolve(m));
    });
    sequence = new RoundSequence(metas.map((m, i) => m || fallbackMeta(rounds[i])));
    playback.setDuration(sequence.duration);
    renderRoundStrip();
    await selectRound(0, { seek: true });
  }

  function fallbackMeta(round) {
    // A round whose metadata failed to load still gets a slot on the timeline
    // at the nominal length, rather than collapsing the sequence.
    const tickRate = 64;
    return {
      ...round,
      tickRate,
      startTick: 0,
      freezeEndTick: 3 * tickRate,
      endTick: 118 * tickRate,
      officialEndTick: 125 * tickRate,
      players: [],
      events: { kills: [], shots: [], grenades: [], bomb: [] }
    };
  }

  // ---- rounds strip -------------------------------------------------------

  function renderRoundStrip() {
    roundsEl.innerHTML = rounds
      .map((r, i) => {
        const won = r.winner === 1 ? 'w1' : 'w2';
        return `<button type="button" class="rv-round ${won}" data-index="${i}" title="${escapeHtml(
          `Round ${r.round} · ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}`
        )}">${String(r.round).padStart(2, '0')}</button>`;
      })
      .join('');
    markActiveRound();
  }

  function markActiveRound() {
    roundsEl.querySelectorAll('.rv-round').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.index) === activeIndex);
    });
  }

  roundsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-index]');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    playback.seek(sequence.offsetOf(index));
    selectRound(index, { seek: false });
  });

  // ---- round selection ----------------------------------------------------

  async function selectRound(index, { seek = false } = {}) {
    if (index === activeIndex || index < 0 || index >= files.length) return;
    activeIndex = index;
    markActiveRound();

    const file = files[index];
    activeMeta = (await metaFor(file)) || fallbackMeta(rounds[index]);
    if (destroyed) return;

    await renderer.setMap(activeMeta.map || rounds[index].map);
    renderScoreboards();

    if (seek) playback.seek(sequence.offsetOf(index), { emit: false });

    // Pass two for the round now on screen. Playback continues on coarse data
    // until it lands, so selecting a round never blocks.
    store.loadFull(file);
    draw();
  }

  // ---- scoreboards --------------------------------------------------------

  function renderScoreboards() {
    if (!activeMeta) return;
    const t1 = activeMeta.team1 || { name: 'Team 1' };
    const t2 = activeMeta.team2 || { name: 'Team 2' };
    const wins = countWins();
    team1El.innerHTML = teamHtml(1, t1, wins.team1);
    team2El.innerHTML = teamHtml(2, t2, wins.team2);
  }

  function countWins() {
    // Score as of the round on screen, which is what a viewer expects to see.
    let team1 = 0;
    let team2 = 0;
    for (let i = 0; i < activeIndex; i++) {
      if (rounds[i].winner === 1) team1++;
      else team2++;
    }
    return { team1, team2 };
  }

  function teamHtml(team, info, score) {
    const players = (activeMeta.players || []).filter((p) => p.team === team);
    const rows = players
      .map((p) => {
        const st = activeMeta.stats?.[p.id] || {};
        return `
        <div class="rv-player" data-slot="${p.slot}">
          <div class="rv-player-row">
            <span class="rv-player-name">${escapeHtml(p.name || p.id)}</span>
            <span class="rv-player-money">$${st.money ?? 0}</span>
          </div>
          <div class="rv-player-bar"><span class="rv-player-hp" data-slot="${p.slot}"></span></div>
          <div class="rv-player-gear" data-slot="${p.slot}"></div>
        </div>`;
      })
      .join('');
    return `
      <div class="rv-team-head">
        <span class="rv-team-name">${escapeHtml(info.name || `Team ${team}`)}</span>
        <span class="rv-team-score">${score}</span>
      </div>
      <div class="rv-players">${rows}</div>`;
  }

  /** Per-frame scoreboard updates: health bar, weapon, alive state. */
  function syncScoreboard() {
    if (!activeMeta) return;
    const weapons = activeMeta.weapons || [];
    for (const p of activeMeta.players || []) {
      const s = states[p.slot];
      if (!s) continue;
      const root = el.querySelector(`.rv-player[data-slot="${p.slot}"]`);
      if (!root) continue;
      root.classList.toggle('dead', !s.alive);
      const hp = root.querySelector('.rv-player-hp');
      if (hp) {
        hp.style.width = `${Math.max(0, Math.min(100, s.health))}%`;
        hp.style.background = TEAM_COLORS[p.team]?.base || '#888';
      }
      const gear = root.querySelector('.rv-player-gear');
      if (gear) {
        const w = weapons[s.weapon] || '';
        if (gear.dataset.weapon !== w) {
          gear.dataset.weapon = w;
          gear.textContent = s.alive ? w.replace(/_/g, ' ') : '';
        }
      }
    }
  }

  // ---- frame --------------------------------------------------------------

  function onPosition(pos) {
    const loc = sequence.locate(pos);
    if (loc.index !== activeIndex) {
      selectRound(loc.index, { seek: false });
    }
    draw(loc);
  }

  function draw(loc = null) {
    if (!activeMeta) return;
    const at = loc || sequence.locate(playback.position);
    // Rolling into the next round swaps activeMeta asynchronously. Skip the
    // frame rather than drawing this round's players at another round's time.
    if (at.index !== activeIndex) return;
    const timing = timingFor(activeMeta);
    const tick = at.tick;

    const track = store.track(files[activeIndex]);
    if (track) track.sampleAll(tick, states);

    renderer.render({
      tick,
      tickRate: timing.tickRate,
      states,
      players: activeMeta.players || [],
      events: activeMeta.events || {}
    });

    const clock = clockAt(timing, tick);
    clockEl.textContent = clock.label;
    clockEl.dataset.phase = clock.phase;
    timeEl.textContent = formatClock(playback.position);

    const pct = playback.duration ? (playback.position / playback.duration) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    handleEl.style.left = `${pct}%`;

    syncScoreboard();
    syncLoading(track);
  }

  function syncLoading(track) {
    const entry = store.get(files[activeIndex]);
    if (entry?.isFull) {
      loadingEl.hidden = true;
      return;
    }
    loadingEl.hidden = false;
    loadingEl.textContent = track
      ? `Preview at 1/${COARSE_STRIDE} detail, loading full round…`
      : 'Loading round…';
  }

  function renderMarks() {
    if (!sequence.length) return;
    const parts = [];
    for (let i = 0; i < sequence.length; i++) {
      const item = sequence.at(i);
      const base = sequence.offsetOf(i);
      for (const m of phaseMarkers(item.timing)) {
        if (m.key !== 'plant') continue;
        const at = ((base + m.at * item.seconds) / sequence.duration) * 100;
        parts.push(`<span class="rv-mark plant" style="left:${at}%" title="Bomb planted"></span>`);
      }
      if (i > 0) {
        const at = (base / sequence.duration) * 100;
        parts.push(`<span class="rv-mark round" style="left:${at}%"></span>`);
      }
    }
    marksEl.innerHTML = parts.join('');
  }

  // ---- transport ----------------------------------------------------------

  playBtn.addEventListener('click', () => {
    playback.toggle();
    syncPlayButton();
  });

  function syncPlayButton() {
    playBtn.classList.toggle('playing', playback.playing);
    playBtn.setAttribute('aria-label', playback.playing ? 'Pause' : 'Play');
    playBtn.innerHTML = playback.playing
      ? '<svg viewBox="0 -960 960 960" width="18" height="18"><path d="M520-200v-560h240v560H520Zm-320 0v-560h240v560H200Z"/></svg>'
      : '<svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-200v-560l440 280-440 280Z"/></svg>';
  }

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

  function onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playback.toggle();
      syncPlayButton();
    } else if (e.code === 'ArrowLeft') {
      playback.nudge(e.shiftKey ? -10 : -2);
    } else if (e.code === 'ArrowRight') {
      playback.nudge(e.shiftKey ? 10 : 2);
    }
  }
  window.addEventListener('keydown', onKey);

  const onResize = () => draw();
  window.addEventListener('resize', onResize);

  const offStore = store.onChange((event) => {
    if (event.type === 'coarse-done') renderMarks();
    if (event.type === 'full' && event.file === files[activeIndex]) draw();
  });

  // ---- boot ---------------------------------------------------------------

  (async () => {
    await buildSequence();
    if (destroyed) return;
    renderMarks();
    // Pass one over the whole selection, then pass two starting where the
    // viewer is looking.
    await store.coarsePass(files, COARSE_STRIDE);
    if (destroyed) return;
    draw();
    store.fullPass(files, Math.max(0, activeIndex));
  })();

  return {
    el,
    destroy() {
      destroyed = true;
      playback.destroy();
      offStore();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    }
  };
}
