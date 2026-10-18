// ---------------------------------------------------------------------------
// replays/eye/eyeRoundPlayer.js
// A round, playable inside the aim4 eye chat: the radar the viewer draws, a
// play button, a scrubber, speed, and a link to the full viewer. A still (a
// "screenshot" the model shows) is the same player paused at one clock, so a
// picture in the chat can always be played on from where it stands.
//
// Drawn by the viewer's own RadarRenderer from the same round packs the eye's
// screenshots use (eyeRound.js), so it never disagrees with the viewer. Loaded
// only when it scrolls into view, and only one plays at a time.
// ---------------------------------------------------------------------------

import { RadarRenderer } from '../viewer/radarRenderer.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { MAPS } from '../shared/roundId.js';
import { loadRound } from './eyeRound.js';

const SPEEDS = [1, 2, 4];

/** The player that is playing; starting another pauses it. */
let playing = null;

const clockOf = (secondsLeft) => {
  const s = Math.max(0, Math.round(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "1:30" (or 90) -> seconds left on the round clock, or null. */
export function parseClockArg(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v));
  const n = m ? Number(m[1]) * 60 + Number(m[2]) : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(ROUND_SECONDS, n)) : null;
}

/**
 * @param {object} spec
 * @param {string} spec.file        the round
 * @param {string} [spec.label]     "The Golden Horde vs ynkesu, Cache, round 4"
 * @param {string} [spec.caption]   what the model wants the user to look at
 * @param {string} [spec.from]      clock to start from (default 1:55)
 * @param {string} [spec.to]        clock to stop at (default the end)
 * @param {string} [spec.at]        a still: open paused at this clock
 * @param {(s: string) => string} escapeHtml
 * @returns {HTMLElement}
 */
export function createRoundPlayer(spec, escapeHtml) {
  const el = document.createElement('figure');
  el.className = 'eye-player';
  const still = parseClockArg(spec.at);
  el.innerHTML = `
    <div class="eye-player-roster" hidden></div>
    <div class="eye-player-stage"><canvas class="eye-player-canvas"></canvas><div class="eye-player-msg">Loading the round…</div></div>
    <div class="eye-player-bar">
      <button type="button" class="eye-player-btn" data-act="play" aria-label="Play">▶</button>
      <input type="range" class="eye-player-seek" min="0" max="1000" value="0" aria-label="Round time" disabled>
      <span class="eye-player-clock">${escapeHtml(clockOf(still ?? parseClockArg(spec.from) ?? ROUND_SECONDS))}</span>
      <button type="button" class="eye-player-btn eye-player-speed" data-act="speed" aria-label="Speed">1x</button>
      <a class="eye-player-open" href="/demos?rounds=${encodeURIComponent(spec.file)}" target="_blank" rel="noopener">Open</a>
    </div>
    <figcaption class="eye-player-cap">${escapeHtml(spec.label || '')}${spec.caption ? `<span>${escapeHtml(spec.caption)}</span>` : ''}</figcaption>`;
  const canvas = el.querySelector('canvas');
  const msg = el.querySelector('.eye-player-msg');
  const playBtn = el.querySelector('[data-act="play"]');
  const speedBtn = el.querySelector('[data-act="speed"]');
  const seek = el.querySelector('.eye-player-seek');
  const clockEl = el.querySelector('.eye-player-clock');
  const rosterEl = el.querySelector('.eye-player-roster');
  let rosterKey = '';

  let round = null;
  let renderer = null;
  let timing = null;
  let fromTick = 0;
  let toTick = 0;
  let tick = 0;
  let speed = 1;
  let raf = 0;
  let last = 0;
  const states = [];

  /** Both teams' players above the radar, with their health at this tick. */
  const drawRoster = () => {
    const players = round.meta.players || [];
    const teams = [1, 2].map((team) => {
      const side = (s) => s.side || (team === 1 ? round.meta.team1Side : round.meta.team2Side);
      return players
        .filter((p) => p.team === team)
        .map((p) => {
          const st = states[p.slot];
          const alive = Boolean(st && st.alive);
          const hp = alive ? Math.max(0, Math.round(st.health)) : 0;
          return { name: p.name || p.id, hp, alive, side: st ? side(st) : '' };
        });
    });
    const html = teams
      .map((list) => {
        const side = list.find((x) => x.side)?.side || '';
        return `<div class="eye-player-team${side ? ` is-${String(side).toLowerCase()}` : ''}">${list
          .map((x) => `<span class="eye-player-pl${x.alive ? '' : ' is-dead'}"><b>${escapeHtml(x.name)}</b><i>${x.alive ? x.hp : 'dead'}</i></span>`)
          .join('')}</div>`;
      })
      .join('');
    if (html === rosterKey) return;
    rosterKey = html;
    rosterEl.innerHTML = html;
    rosterEl.hidden = false;
  };

  const draw = () => {
    if (!round) return;
    round.track.sampleAll(tick, states);
    renderer.render({
      tick,
      tickRate: timing.tickRate,
      states,
      players: round.meta.players || [],
      allPlayers: round.meta.players || [],
      events: round.meta.events || {},
      weapons: round.meta.weapons || [],
      teamSides: { 1: round.meta.team1Side, 2: round.meta.team2Side },
      // Names and weapons only when there is room for them.
      compact: !el.classList.contains('is-large'),
      mapAlpha: 0.9
    });
    drawRoster();
    const left = ROUND_SECONDS - (tick - timing.freezeEndTick) / timing.tickRate;
    clockEl.textContent = clockOf(left);
    seek.value = String(Math.round(((tick - fromTick) / Math.max(1, toTick - fromTick)) * 1000));
  };

  const pause = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
    if (playing === api) playing = null;
  };
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick = Math.min(toTick, tick + dt * timing.tickRate * speed);
    draw();
    if (tick >= toTick) return pause();
    raf = requestAnimationFrame(frame);
  };
  const play = () => {
    if (!round) return;
    if (playing && playing !== api) playing.pause();
    playing = api;
    if (tick >= toTick) tick = fromTick;
    last = performance.now();
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    raf = requestAnimationFrame(frame);
  };
  const api = { pause };

  async function load() {
    try {
      round = await loadRound(spec.file);
      timing = timingFor(round.meta);
      renderer = new RadarRenderer(canvas);
      await renderer.setMap(round.meta.map);
      const toLive = (secondsLeft) => Math.round(timing.freezeEndTick + (ROUND_SECONDS - secondsLeft) * timing.tickRate);
      const from = parseClockArg(spec.from);
      const to = parseClockArg(spec.to);
      fromTick = Math.max(timing.startTick, from != null ? toLive(from) : timing.freezeEndTick);
      toTick = Math.min(timing.officialEndTick || timing.endTick, to != null ? toLive(to) : timing.officialEndTick || timing.endTick);
      if (toTick <= fromTick) toTick = timing.officialEndTick || timing.endTick;
      tick = still != null ? Math.max(fromTick, Math.min(toTick, toLive(still))) : fromTick;
      msg.remove();
      seek.disabled = false;
      draw();
      if (!el.querySelector('.eye-player-cap').textContent.trim()) {
        el.querySelector('.eye-player-cap').textContent = `${MAPS[round.meta.map]?.name || round.meta.map}, round ${round.meta.round}`;
      }
    } catch (err) {
      msg.textContent = `This round could not be loaded${err?.message ? `: ${err.message}` : '.'}`;
      msg.classList.add('is-error');
    }
  }

  playBtn.addEventListener('click', () => (raf ? pause() : play()));
  speedBtn.addEventListener('click', () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    speedBtn.textContent = `${speed}x`;
  });
  seek.addEventListener('input', () => {
    if (!round) return;
    tick = fromTick + (Number(seek.value) / 1000) * (toTick - fromTick);
    draw();
  });
  // Click the picture to make it larger, again to make it smaller.
  canvas.addEventListener('click', () => {
    el.classList.toggle('is-large');
    requestAnimationFrame(draw);
  });

  // Load on first sight, not when the chat is opened.
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        void load();
      }
    });
    io.observe(el);
  } else {
    void load();
  }
  return el;
}
