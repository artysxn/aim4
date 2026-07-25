// ---------------------------------------------------------------------------
// replays/viewer/timelineViewer.js
// One round on screen at a time. Each selected round has its own scrub
// timeline above the radar; play advances through rounds in order.
//
// Loading follows the two-pass rule. The coarse pass (every 100th tick of
// every round) runs as soon as the viewer opens, so scrub bars are live
// immediately. The full pass then fills in the round being watched first.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { COARSE_STRIDE } from '../tickStore.js';
import { RadarRenderer, TEAM_COLORS } from './radarRenderer.js';
import { Playback, RoundSequence } from './playback.js';
import { clockAt, formatClock, phaseMarkers, timingFor } from './roundClock.js';
import { economyLabel, winningSide } from '../shared/roundId.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

export function createTimelineViewer({ store, rounds, escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'rv-timeline';
  el.innerHTML = `
    <div class="rv-chrome">
      <div class="rv-transport">
        <button type="button" class="rv-speed" id="rv-speed">x1</button>
        <button type="button" class="rv-play" id="rv-play" aria-label="Play">
          <svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-200v-560l440 280-440 280Z"/></svg>
        </button>
        <span class="rv-time" id="rv-time">00:00</span>
      </div>
      <div class="rv-round-timelines" id="rv-round-timelines"></div>
    </div>
    <div class="rv-stage">
      <aside class="rv-team rv-team-1" data-team="1"></aside>
      <div class="rv-map">
        <div class="rv-clock" id="rv-clock">00:00</div>
        <canvas class="rv-canvas" id="rv-canvas"></canvas>
        <div class="rv-loading" id="rv-loading"></div>
      </div>
      <aside class="rv-team rv-team-2" data-team="2"></aside>
    </div>`;

  const canvas = el.querySelector('#rv-canvas');
  const clockEl = el.querySelector('#rv-clock');
  const loadingEl = el.querySelector('#rv-loading');
  const timelinesEl = el.querySelector('#rv-round-timelines');
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

  async function metaFor(file) {
    if (metaCache.has(file)) return metaCache.get(file);
    const p = fetchRoundMeta(file).catch(() => null);
    metaCache.set(file, p);
    return p;
  }

  async function buildSequence() {
    const metas = await Promise.all(files.map(metaFor));
    if (destroyed) return;
    metas.forEach((m, i) => {
      if (m) metaCache.set(files[i], Promise.resolve(m));
    });
    sequence = new RoundSequence(metas.map((m, i) => m || fallbackMeta(rounds[i])));
    playback.setDuration(sequence.duration);
    renderRoundTimelines();
    await selectRound(0, { seek: true });
  }

  function fallbackMeta(round) {
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

  // ---- per-round timelines (above the map) --------------------------------

  function renderRoundTimelines() {
    timelinesEl.innerHTML = rounds
      .map((r, i) => {
        const side = winningSide(r);
        const sideClass = side === 'T' ? 'wt' : 'wct';
        return `
        <div class="rv-round-row ${sideClass}" data-index="${i}">
          <button type="button" class="rv-round ${sideClass}" data-index="${i}" title="${escapeHtml(
            `Round ${r.round} · ${side} win · ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}`
          )}">${String(r.round).padStart(2, '0')}</button>
          <div class="rv-scrub" data-scrub="${i}">
            <div class="rv-scrub-track"><div class="rv-scrub-fill" data-fill="${i}"></div></div>
            <div class="rv-scrub-marks" data-marks="${i}"></div>
            <div class="rv-scrub-handle" data-handle="${i}"></div>
          </div>
          <span class="rv-round-clock" data-clock="${i}">0:00</span>
        </div>`;
      })
      .join('');
    markActiveRound();
    renderAllMarks();
  }

  function markActiveRound() {
    timelinesEl.querySelectorAll('.rv-round-row').forEach((row) => {
      row.classList.toggle('active', Number(row.dataset.index) === activeIndex);
    });
  }

  function renderAllMarks() {
    if (!sequence.length) return;
    for (let i = 0; i < sequence.length; i++) {
      const marksEl = timelinesEl.querySelector(`[data-marks="${i}"]`);
      if (!marksEl) continue;
      const item = sequence.at(i);
      const parts = [];
      for (const m of phaseMarkers(item.timing)) {
        if (m.key !== 'plant') continue;
        parts.push(
          `<span class="rv-mark plant" style="left:${m.at * 100}%" title="Bomb planted"></span>`
        );
      }
      marksEl.innerHTML = parts.join('');
    }
  }

  timelinesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    playback.seek(sequence.offsetOf(index));
    selectRound(index, { seek: false });
  });

  // Scrub within one round's own timeline.
  let scrubbingIndex = -1;
  const seekRoundFromEvent = (index, e) => {
    const scrub = timelinesEl.querySelector(`[data-scrub="${index}"]`);
    if (!scrub) return;
    const item = sequence.at(index);
    if (!item) return;
    const rect = scrub.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playback.seek(sequence.offsetOf(index) + f * item.seconds);
    if (index !== activeIndex) selectRound(index, { seek: false });
  };

  timelinesEl.addEventListener('pointerdown', (e) => {
    const scrub = e.target.closest('[data-scrub]');
    if (!scrub) return;
    scrubbingIndex = Number(scrub.dataset.scrub);
    scrub.setPointerCapture(e.pointerId);
    seekRoundFromEvent(scrubbingIndex, e);
  });
  timelinesEl.addEventListener('pointermove', (e) => {
    if (scrubbingIndex >= 0) seekRoundFromEvent(scrubbingIndex, e);
  });
  timelinesEl.addEventListener('pointerup', (e) => {
    if (scrubbingIndex < 0) return;
    const scrub = timelinesEl.querySelector(`[data-scrub="${scrubbingIndex}"]`);
    scrub?.releasePointerCapture?.(e.pointerId);
    scrubbingIndex = -1;
  });

  // ---- round selection ----------------------------------------------------

  async function selectRound(index, { seek = false } = {}) {
    if (index === activeIndex || index < 0 || index >= files.length) return;
    activeIndex = index;
    markActiveRound();
    renderer._prevHealth?.fill?.(-1);

    const file = files[index];
    activeMeta = (await metaFor(file)) || fallbackMeta(rounds[index]);
    if (destroyed) return;

    await renderer.setMap(activeMeta.map || rounds[index].map);
    renderScoreboards();

    if (seek) playback.seek(sequence.offsetOf(index), { emit: false });

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
          gear.textContent = s.alive ? w.replace(/^weapon_/, '').replace(/_/g, ' ') : '';
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
      events: activeMeta.events || {},
      weapons: activeMeta.weapons || []
    });

    const clock = clockAt(timing, tick);
    clockEl.textContent = clock.label;
    clockEl.dataset.phase = clock.phase;
    timeEl.textContent = formatClock(playback.position);

    syncRoundScrubs(at);
    syncScoreboard();
    syncLoading(track);
  }

  function syncRoundScrubs(at) {
    for (let i = 0; i < sequence.length; i++) {
      const item = sequence.at(i);
      const fill = timelinesEl.querySelector(`[data-fill="${i}"]`);
      const handle = timelinesEl.querySelector(`[data-handle="${i}"]`);
      const clock = timelinesEl.querySelector(`[data-clock="${i}"]`);
      if (!item || !fill) continue;

      let pct = 0;
      let localSec = 0;
      if (i < at.index) {
        pct = 100;
        localSec = item.seconds;
      } else if (i === at.index) {
        localSec = at.local;
        pct = item.seconds ? (at.local / item.seconds) * 100 : 0;
      }
      fill.style.width = `${pct}%`;
      if (handle) handle.style.left = `${pct}%`;
      if (clock) clock.textContent = formatClock(localSec);
    }
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
    if (event.type === 'coarse-done') renderAllMarks();
    if (event.type === 'full' && event.file === files[activeIndex]) draw();
  });

  (async () => {
    await buildSequence();
    if (destroyed) return;
    renderAllMarks();
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
