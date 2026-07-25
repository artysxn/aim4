// ---------------------------------------------------------------------------
// replays/viewer/timelineViewer.js
// One round on screen at a time. Round chips + a single scrub timeline sit
// over the bottom of the stage (higher z). Full tick data is loaded for the
// active round only; switching rounds loads that round's data next. Cached
// rounds stay in memory until the viewer closes.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { RadarRenderer, SIDE_COLORS, TEAM_COLORS } from './radarRenderer.js';
import { Playback, RoundSequence } from './playback.js';
import { clockAt, formatClock, phaseMarkers, timingFor } from './roundClock.js';
import { economyLabel, winningSide } from '../shared/roundId.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

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
    <div class="rv-chrome">
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
      </div>
    </div>`;

  const canvas = el.querySelector('#rv-canvas');
  const mapEl = el.querySelector('.rv-map');
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
  const chromeEl = el.querySelector('.rv-chrome');

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
    // Prefer sides from round JSON (source of truth) over the demo summary.
    metas.forEach((m, i) => {
      if (!m || !rounds[i]) return;
      if (m.winnerSide) rounds[i].winnerSide = m.winnerSide;
      if (m.team1Side) rounds[i].team1Side = m.team1Side;
      if (m.team2Side) rounds[i].team2Side = m.team2Side;
      if (m.winner === 1 || m.winner === 2) rounds[i].winner = m.winner;
    });
    renderRoundStrip();
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

  // ---- round chips --------------------------------------------------------

  function renderRoundStrip() {
    roundsEl.innerHTML = rounds
      .map((r, i) => {
        const side = winningSide(r);
        const sideClass = side === 'T' ? 'wt' : 'wct';
        return `<button type="button" class="rv-round ${sideClass}" data-index="${i}" title="${escapeHtml(
          `Round ${r.round} · ${side} win · ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}`
        )}">${String(r.round).padStart(2, '0')}</button>`;
      })
      .join('');
    markActiveRound();
  }

  function markActiveRound() {
    roundsEl.querySelectorAll('.rv-round').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.index) === activeIndex);
    });
    const side = activeIndex >= 0 ? winningSide(rounds[activeIndex]) : null;
    chromeEl.classList.toggle('wt', side === 'T');
    chromeEl.classList.toggle('wct', side === 'CT');
  }

  roundsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-index]');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    playback.seek(sequence.offsetOf(index));
    selectRound(index, { seek: false });
  });

  // ---- active round's scrubber --------------------------------------------

  function renderActiveMarks() {
    if (activeIndex < 0 || !sequence.at(activeIndex)) {
      marksEl.innerHTML = '';
      return;
    }
    const item = sequence.at(activeIndex);
    const parts = [];
    for (const m of phaseMarkers(item.timing)) {
      if (m.key !== 'plant') continue;
      parts.push(
        `<span class="rv-mark plant" style="left:${m.at * 100}%" title="Bomb planted"></span>`
      );
    }
    marksEl.innerHTML = parts.join('');
  }

  let scrubbing = false;
  const seekFromEvent = (e) => {
    const item = sequence.at(activeIndex);
    if (!item) return;
    const rect = scrubEl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playback.seek(sequence.offsetOf(activeIndex) + f * item.seconds);
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
    renderActiveMarks();

    if (seek) playback.seek(sequence.offsetOf(index), { emit: false });

    // Full ticks for this round only. Already-loaded rounds stay cached.
    syncLoading();
    draw();
    await store.loadFull(file);
    if (destroyed || activeIndex !== index) return;
    draw();
  }

  // ---- scoreboards --------------------------------------------------------

  function renderScoreboards() {
    if (!activeMeta) return;
    const t1 = activeMeta.team1 || { name: 'Team 1' };
    const t2 = activeMeta.team2 || { name: 'Team 2' };
    const wins = countWins();
    // Panels follow live sides when known (T left / CT right like most 2D viewers).
    const s1 = activeMeta.team1Side;
    const s2 = activeMeta.team2Side;
    if (s1 === 'CT' && s2 === 'T') {
      team1El.innerHTML = teamHtml(2, t2, wins.team2, 'T');
      team2El.innerHTML = teamHtml(1, t1, wins.team1, 'CT');
    } else {
      team1El.innerHTML = teamHtml(1, t1, wins.team1, s1 || 'T');
      team2El.innerHTML = teamHtml(2, t2, wins.team2, s2 || 'CT');
    }
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

  function teamHtml(team, info, score, side) {
    const players = (activeMeta.players || []).filter((p) => p.team === team);
    const rows = players
      .map((p) => {
        const st = activeMeta.stats?.[p.id] || {};
        return `
        <div class="rv-player" data-slot="${p.slot}" data-side="${escapeHtml(side || '')}">
          <div class="rv-player-row">
            <span class="rv-player-name">${escapeHtml(p.name || p.id)}</span>
            <span class="rv-player-money">$${st.money ?? 0}</span>
          </div>
          <div class="rv-player-bar"><span class="rv-player-hp" data-slot="${p.slot}"></span></div>
          <div class="rv-player-gear" data-slot="${p.slot}"></div>
        </div>`;
      })
      .join('');
    const sideClass = side === 'T' ? 'side-t' : side === 'CT' ? 'side-ct' : '';
    return `
      <div class="rv-team-head ${sideClass}">
        <span class="rv-team-side">${escapeHtml(side || '')}</span>
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
        const side = s.side || root.dataset.side;
        hp.style.background =
          (side && SIDE_COLORS[side]?.base) || TEAM_COLORS[p.team]?.base || '#888';
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

  // ---- zoom / pan ---------------------------------------------------------

  function setZoom(next, anchorX, anchorY) {
    const prev = renderer.zoom;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (z === prev) {
      if (z <= MIN_ZOOM) {
        renderer.panX = 0;
        renderer.panY = 0;
      }
      return;
    }

    if (z <= MIN_ZOOM) {
      renderer.zoom = MIN_ZOOM;
      renderer.panX = 0;
      renderer.panY = 0;
    } else if (Number.isFinite(anchorX) && Number.isFinite(anchorY)) {
      // Keep the world point under the cursor stable while zooming.
      const rect = canvas.getBoundingClientRect();
      const { w, h } = renderer.resize();
      const t0 = renderer.viewTransform(w, h);
      const cx = ((anchorX - rect.left) / rect.width) * w;
      const cy = ((anchorY - rect.top) / rect.height) * h;
      const worldX = (cx - t0.ox) / t0.scale;
      const worldY = (cy - t0.oy) / t0.scale;
      renderer.zoom = z;
      const t1 = renderer.viewTransform(w, h);
      renderer.panX += (cx - (worldX * t1.scale + t1.ox)) / renderer.dpr;
      renderer.panY += (cy - (worldY * t1.scale + t1.oy)) / renderer.dpr;
    } else {
      renderer.zoom = z;
    }
    syncPanCursor();
    draw();
  }

  function syncPanCursor() {
    const canPan = renderer.zoom > MIN_ZOOM;
    mapEl.classList.toggle('can-pan', canPan);
  }

  mapEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setZoom(renderer.zoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  let panning = false;
  let panBtn = -1;
  let lastX = 0;
  let lastY = 0;

  mapEl.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas && !canvas.contains(e.target) && e.target !== mapEl) {
      // Allow pan only from the map surface / canvas, not the clock label.
      if (e.target.closest?.('.rv-clock, .rv-loading')) return;
    }
    if (e.target.closest?.('.rv-clock, .rv-loading')) return;
    const isPanBtn = e.button === 0 || e.button === 1;
    if (!isPanBtn || renderer.zoom <= MIN_ZOOM) return;
    panning = true;
    panBtn = e.button;
    lastX = e.clientX;
    lastY = e.clientY;
    mapEl.classList.add('panning');
    mapEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  mapEl.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    renderer.panX += dx;
    renderer.panY += dy;
    draw();
  });
  const endPan = (e) => {
    if (!panning) return;
    if (e.button !== undefined && e.button !== panBtn && e.type === 'pointerup') return;
    panning = false;
    panBtn = -1;
    mapEl.classList.remove('panning');
    try {
      mapEl.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  mapEl.addEventListener('pointerup', endPan);
  mapEl.addEventListener('pointercancel', endPan);
  mapEl.addEventListener('auxclick', (e) => {
    // Stop middle-click autofocus / autoscroll.
    if (e.button === 1) e.preventDefault();
  });
  mapEl.addEventListener('contextmenu', (e) => {
    if (renderer.zoom > MIN_ZOOM) e.preventDefault();
  });

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

    const item = sequence.at(activeIndex);
    const local = at.local;
    timeEl.textContent = formatClock(local);
    const pct = item?.seconds ? (local / item.seconds) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    handleEl.style.left = `${pct}%`;

    syncScoreboard();
    syncLoading();
  }

  function syncLoading() {
    const entry = store.get(files[activeIndex]);
    if (entry?.isFull) {
      loadingEl.hidden = true;
      return;
    }
    loadingEl.hidden = false;
    loadingEl.textContent = 'Loading round…';
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
    if (event.type === 'full' && event.file === files[activeIndex]) draw();
  });

  (async () => {
    // buildSequence → selectRound(0) already full-loads round 1 only.
    await buildSequence();
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
