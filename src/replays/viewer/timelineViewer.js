// ---------------------------------------------------------------------------
// replays/viewer/timelineViewer.js
// One round on screen at a time. Round chips + a single scrub timeline sit
// over the bottom of the stage (higher z). Full tick data is loaded for the
// active round only; switching rounds loads that round's data next. Cached
// rounds stay in memory until the viewer closes.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { RadarRenderer, SIDE_COLORS } from './radarRenderer.js';
import { Playback, RoundSequence } from './playback.js';
import { clockAt, formatClock, timingFor } from './roundClock.js';
import { economyLabel, winningSide } from '../shared/roundId.js';
import { iconImgHtml, inventoryAt } from './equipmentIcons.js';
import helmetSvg from '../../icons/helmet.svg?url';
import kevlarSvg from '../../icons/kevlar.svg?url';
import nokevlarSvg from '../../icons/nokevlar.svg?url';

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
          <div class="rv-scrub-track">
            <div class="rv-scrub-phases" id="rv-scrub-phases"></div>
            <div class="rv-scrub-fill" id="rv-scrub-fill"></div>
          </div>
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
  const phasesEl = el.querySelector('#rv-scrub-phases');
  const marksEl = el.querySelector('#rv-scrub-marks');
  const handleEl = el.querySelector('#rv-scrub-handle');
  const timeEl = el.querySelector('#rv-time');
  const playBtn = el.querySelector('#rv-play');
  const speedBtn = el.querySelector('#rv-speed');
  const team1El = el.querySelector('.rv-team-1');
  const team2El = el.querySelector('.rv-team-2');
  const chromeEl = el.querySelector('.rv-chrome');

  const renderer = new RadarRenderer(canvas);
  renderer.onIconLoad = () => {
    if (!destroyed) draw();
  };
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

  /**
   * Spacing multiplier for the gap *after* round number `n` (before n+1).
   * Half: 12→13 ×2. OT start: 24→25 ×4. Then every 3 OT rounds: ×2 / ×4.
   */
  function gapAfterRound(n) {
    const r = Number(n) || 0;
    if (r === 12) return 2;
    if (r === 24) return 4;
    if (r > 24) {
      const k = r - 24;
      if (k % 6 === 3) return 2;
      if (k % 6 === 0) return 4;
    }
    return 1;
  }

  const ROUND_GAP_PX = 3;

  /** Global timeline seconds at the end of freezetime for a round index. */
  function liveOffsetOf(index) {
    const item = sequence.at(index);
    if (!item) return sequence.offsetOf(index);
    const { timing } = item;
    const freezeSecs = Math.max(0, (timing.freezeEndTick - timing.startTick) / timing.tickRate);
    return sequence.offsetOf(index) + freezeSecs;
  }

  async function buildSequence() {
    // Boot from the demo summary only — no N-round meta waterfall.
    sequence = new RoundSequence(rounds.map((r) => fallbackMeta(r)));
    playback.setDuration(sequence.duration);
    renderRoundStrip();
    await selectRound(0, { seek: true });
  }

  function fallbackMeta(round) {
    const tickRate = round.tickRate || 64;
    return {
      ...round,
      tickRate,
      startTick: round.startTick ?? 0,
      freezeEndTick: round.freezeEndTick ?? (round.startTick ?? 0) + 3 * tickRate,
      endTick: round.endTick ?? (round.freezeEndTick ?? 0) + 115 * tickRate,
      officialEndTick: round.officialEndTick ?? (round.endTick ?? 0) + 5 * tickRate,
      players: round.players || [],
      events: round.events || { kills: [], shots: [], grenades: [], bomb: [] }
    };
  }

  // ---- round chips --------------------------------------------------------

  function renderRoundStrip() {
    roundsEl.innerHTML = rounds
      .map((r, i) => {
        const side = winningSide(r);
        const sideClass = side === 'T' ? 'wt' : 'wct';
        const gap =
          i === 0 ? 0 : gapAfterRound(rounds[i - 1].round) * ROUND_GAP_PX;
        const margin = gap ? ` style="margin-left:${gap}px"` : '';
        return `<button type="button" class="rv-round ${sideClass}" data-index="${i}"${margin} title="${escapeHtml(
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
    selectRound(Number(btn.dataset.index), { seek: true });
  });

  // ---- active round's scrubber --------------------------------------------

  function sideOfPlayer(playerId) {
    if (!playerId || !activeMeta?.players) return null;
    const p = activeMeta.players.find((x) => x.id === playerId);
    if (!p) return null;
    if (p.team === 1) return activeMeta.team1Side || 'T';
    if (p.team === 2) return activeMeta.team2Side || 'CT';
    return null;
  }

  function renderActiveMarks() {
    if (activeIndex < 0 || !sequence.at(activeIndex)) {
      marksEl.innerHTML = '';
      phasesEl.innerHTML = '';
      return;
    }
    const item = sequence.at(activeIndex);
    const timing = item.timing;
    const events = activeMeta?.events || item.round?.events || {};
    const span = Math.max(1, timing.officialEndTick - timing.startTick);
    const at = (tick) => Math.max(0, Math.min(1, (tick - timing.startTick) / span));

    // Track background: plant → end dark red; defuse → end greenish.
    const phaseParts = [];
    const plantTick =
      timing.plantTick ?? events.bomb?.find((b) => b.type === 'planted')?.tick ?? null;
    const defuseTick = events.bomb?.find((b) => b.type === 'defused')?.tick ?? null;
    if (plantTick != null) {
      const plantAt = at(plantTick);
      if (defuseTick != null) {
        const defuseAt = at(defuseTick);
        phaseParts.push(
          `<span class="rv-scrub-phase planted" style="left:${plantAt * 100}%;width:${(defuseAt - plantAt) * 100}%"></span>`,
          `<span class="rv-scrub-phase defused" style="left:${defuseAt * 100}%;width:${(1 - defuseAt) * 100}%"></span>`
        );
      } else {
        phaseParts.push(
          `<span class="rv-scrub-phase planted" style="left:${plantAt * 100}%;width:${(1 - plantAt) * 100}%"></span>`
        );
      }
    }
    phasesEl.innerHTML = phaseParts.join('');

    const parts = [];
    if (plantTick != null) {
      parts.push(
        `<span class="rv-mark plant" style="left:${at(plantTick) * 100}%" title="Bomb planted"></span>`
      );
    }
    if (defuseTick != null) {
      parts.push(
        `<span class="rv-mark defuse" style="left:${at(defuseTick) * 100}%" title="Bomb defused"></span>`
      );
    }
    for (const k of events.kills || []) {
      if (k.tick == null) continue;
      const side = sideOfPlayer(k.attacker);
      if (side !== 'T' && side !== 'CT') continue;
      const color = SIDE_COLORS[side].base;
      parts.push(
        `<span class="rv-mark kill" style="left:${at(k.tick) * 100}%;background:${color}" title="Kill"></span>`
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

  async function selectRound(index, { seek = true } = {}) {
    if (index < 0 || index >= files.length) return;
    if (index === activeIndex && store.get(files[index])?.isFull) {
      if (seek) playback.seek(liveOffsetOf(index));
      return;
    }

    activeIndex = index;
    markActiveRound();
    renderer._prevHealth?.fill?.(-1);
    renderer._damageTick?.fill?.(-1);
    renderer._prevFlash?.fill?.(0);

    // Instant chrome from the summary; ticks + meta load for this round only.
    activeMeta = fallbackMeta(rounds[index]);
    renderScoreboards();
    renderActiveMarks();
    if (seek) playback.seek(liveOffsetOf(index), { emit: false });
    syncLoading();
    clearPlayerStates();
    draw();

    const file = files[index];
    const mapCode = rounds[index].map || activeMeta.map;
    const [meta] = await Promise.all([
      metaFor(file),
      store.loadFull(file),
      mapCode ? renderer.setMap(mapCode) : Promise.resolve()
    ]);
    if (destroyed || activeIndex !== index) return;

    if (meta) {
      activeMeta = meta;
      const sideChanged =
        (meta.winnerSide && meta.winnerSide !== rounds[index].winnerSide) ||
        (meta.team1Side && meta.team1Side !== rounds[index].team1Side);
      if (meta.winnerSide) rounds[index].winnerSide = meta.winnerSide;
      if (meta.team1Side) rounds[index].team1Side = meta.team1Side;
      if (meta.team2Side) rounds[index].team2Side = meta.team2Side;
      if (meta.winner === 1 || meta.winner === 2) rounds[index].winner = meta.winner;
      // Patch this round's timing into the sequence without refetching others.
      if (meta.freezeEndTick != null || meta.tickRate) {
        const pos = playback.position;
        const list = rounds.map((r, i) => {
          if (i === index) return { ...fallbackMeta(r), ...meta };
          return sequence.at(i)?.round || fallbackMeta(r);
        });
        sequence = new RoundSequence(list);
        playback.setDuration(sequence.duration);
        playback.seek(Math.min(pos, playback.duration), { emit: false });
      }
      if (sideChanged) renderRoundStrip();
      else markActiveRound();
      renderScoreboards();
      renderActiveMarks();
    }

    if (seek) playback.seek(liveOffsetOf(index), { emit: false });
    draw();
  }

  function clearPlayerStates() {
    for (let i = 0; i < 10; i++) states[i] = null;
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
        <div class="rv-player" data-slot="${p.slot}" data-id="${escapeHtml(p.id)}" data-side="${escapeHtml(side || '')}">
          <div class="rv-player-hp-row">
            <div class="rv-player-pill">
              <span class="rv-player-hp" data-slot="${p.slot}"></span>
              <span class="rv-player-name">${escapeHtml(p.name || p.id)}</span>
            </div>
            <span class="rv-player-money">$${st.money ?? 0}</span>
          </div>
          <div class="rv-player-inv" data-slot="${p.slot}"></div>
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

  function armorIconSrc(inv) {
    if (inv?.helmet) return helmetSvg;
    if (inv?.armor) return kevlarSvg;
    return nokevlarSvg;
  }

  function armorIconKey(inv) {
    if (inv?.helmet) return 'helmet';
    if (inv?.armor) return 'kevlar';
    return 'nokevlar';
  }

  function invHtml(inv) {
    if (!inv) return '';
    const armorSrc = armorIconSrc(inv);
    const parts = [];
    parts.push(
      `<span class="rv-inv-armor"><img class="rv-inv-icon" src="${armorSrc}" alt="" data-item="${armorIconKey(inv)}" draggable="false" /></span>`
    );
    parts.push(
      `<span class="rv-inv-primary">${
        inv.primary ? iconImgHtml(inv.primary, 'rv-inv-icon rv-inv-gun') : ''
      }</span>`
    );
    const util = (inv.util || []).map((u) => iconImgHtml(u, 'rv-inv-icon rv-inv-nade')).join('');
    parts.push(`<span class="rv-inv-util">${util}</span>`);
    return parts.join('');
  }

  function syncScoreboard(tick = 0) {
    if (!activeMeta) return;
    const weapons = activeMeta.weapons || [];
    const grenades = activeMeta.events?.grenades || [];
    for (const p of activeMeta.players || []) {
      const s = states[p.slot];
      if (!s) continue;
      const root = el.querySelector(`.rv-player[data-slot="${p.slot}"]`);
      if (!root) continue;
      root.classList.toggle('dead', !s.alive);
      const side = s.side || root.dataset.side;
      if (side) root.dataset.side = side;
      const hp = root.querySelector('.rv-player-hp');
      if (hp) {
        const pct = s.alive ? Math.max(0, Math.min(100, s.health)) : 0;
        hp.style.width = `${pct}%`;
      }
      const invEl = root.querySelector('.rv-player-inv');
      if (!invEl) continue;
      const st = activeMeta.stats?.[p.id] || {};
      const inv = inventoryAt({
        loadout: st.loadout || [],
        grenades,
        playerId: p.id,
        tick,
        state: s,
        activeWeapon: weapons[s.weapon] || ''
      });
      const key = `${inv.primary}|${armorIconKey(inv)}|${(inv.util || []).join(',')}|${s.alive ? 1 : 0}`;
      if (invEl.dataset.key !== key) {
        invEl.dataset.key = key;
        invEl.innerHTML = s.alive ? invHtml(inv) : '';
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
    let loc = sequence.locate(pos);
    const live = liveOffsetOf(loc.index);
    // Entering a round (or playing through freezetime) jumps to live.
    if (playback.playing && pos < live) {
      playback.seek(live, { emit: false });
      loc = sequence.locate(live);
    }
    if (loc.index !== activeIndex) {
      selectRound(loc.index, { seek: false });
      return;
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
    else clearPlayerStates();

    renderer.render({
      tick,
      tickRate: timing.tickRate,
      states,
      players: track ? activeMeta.players || [] : [],
      events: track ? activeMeta.events || {} : { kills: [], shots: [], grenades: [], bomb: [] },
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

    syncScoreboard(tick);
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
    const live = liveOffsetOf(activeIndex);
    if (!playback.playing && playback.position < live) {
      playback.seek(live, { emit: false });
    }
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
