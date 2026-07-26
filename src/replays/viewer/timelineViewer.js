// ---------------------------------------------------------------------------
// replays/viewer/timelineViewer.js
// One round on screen at a time. Round chips + a single scrub timeline sit
// over the bottom of the stage (higher z). Full tick data is loaded for the
// active round only; switching rounds loads that round's data next. Cached
// rounds stay in memory until the viewer closes.
// ---------------------------------------------------------------------------

import {
  NOTE_MAX,
  fetchPlaylists,
  fetchRoundMeta,
  saveRoundNotes,
  savePlaylist
} from '../api.js';
import { fetchStats } from '../api.js';
import { aggregatePlayers, allRows, indexMaps } from '../shared/statsMath.js';
import { PLAYER_COLUMNS, attachTips, statsTableHtml } from '../stats/statsTables.js';
import { RadarRenderer, SIDE_COLORS } from './radarRenderer.js';
import { Playback, RoundSequence } from './playback.js';
import { clockAt, formatClock, timingFor } from './roundClock.js';
import { economyLabel, winningSide } from '../shared/roundId.js';
import { iconImgHtml, inventoryAt } from './equipmentIcons.js';
import { DRAW_COLORS, DrawingLayer } from './drawing.js';
import { analyseRound, flagToNote } from '../coach/coach.js';
import { explainProbability, winProbabilityAtTick } from '../coach/winProbability.js';
import helmetSvg from '../../icons/helmet.svg?url';
import kevlarSvg from '../../icons/kevlar.svg?url';
import nokevlarSvg from '../../icons/nokevlar.svg?url';
import pencilIcon from '../../icons/demos_drawing.svg?raw';
import eraseIcon from '../../icons/demos_erase.svg?raw';
import commentsIcon from '../../icons/demos_comments.svg?raw';
import bookmarkAddIcon from '../../icons/demos_bookmarks_add.svg?raw';
import bookmarkAddedIcon from '../../icons/demos_bookmarks_added.svg?raw';
import coachIcon from '../../icons/demos_coach.svg?raw';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

const statsIconSvg =
  '<svg viewBox="0 -960 960 960" width="19" height="19" fill="currentColor" aria-hidden="true">' +
  '<path d="M640-160v-280h120v280H640Zm-220 0v-640h120v640H420Zm-220 0v-440h120v440H200Z"/></svg>';

/** The shipped SVGs are a fixed light grey; let CSS drive the colour instead. */
const icon = (raw) => String(raw).replace(/fill="#[0-9a-fA-F]{3,8}"/g, 'fill="currentColor"');

export function createTimelineViewer({ store, rounds, escapeHtml, onRound, statsDemoId = '' }) {
  const el = document.createElement('div');
  el.className = 'rv-timeline';
  el.innerHTML = `
    <div class="rv-stage">
      <div class="rv-team-col">
        <aside class="rv-team rv-team-1" data-team="1"></aside>
        <div class="rv-wingraph" id="rv-wingraph" hidden>
          <div class="rv-wingraph-head">
            <span class="rv-wingraph-label" id="rv-wingraph-t1">-</span>
            <span class="rv-wingraph-label right" id="rv-wingraph-t2">-</span>
          </div>
          <canvas class="rv-wingraph-canvas" id="rv-wingraph-canvas"></canvas>
          <div class="rv-wingraph-tip" id="rv-wingraph-tip" hidden></div>
        </div>
      </div>
      <div class="rv-map">
        <div class="rv-clock" id="rv-clock">00:00</div>
        <div class="rv-killfeed" id="rv-killfeed" aria-live="polite"></div>
        <canvas class="rv-canvas" id="rv-canvas"></canvas>
        <div class="rv-loading" id="rv-loading"></div>
      </div>
      <div class="rv-team-col">
        <aside class="rv-team rv-team-2" data-team="2"></aside>
      </div>
    </div>
    <aside class="rv-note-dock" id="rv-note-panel" hidden>
      <div class="rv-note-head">
        <button type="button" class="rp-btn-icon" id="rv-note-prev" title="Previous note" aria-label="Previous note">‹</button>
        <span class="rv-note-stamp" id="rv-note-stamp">00:00</span>
        <span class="rv-note-pos" id="rv-note-pos"></span>
        <button type="button" class="rp-btn-icon" id="rv-note-next" title="Next note" aria-label="Next note">›</button>
        <button type="button" class="rp-btn-icon rv-note-close" id="rv-note-close" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="rv-note-coach" id="rv-note-coach" hidden>
        <span class="rv-note-diamond"></span>
        <span class="rv-note-coach-label">Coach</span>
        <button type="button" class="rv-note-mark" data-mark="ok" title="Agree">✓</button>
        <button type="button" class="rv-note-mark" data-mark="x" title="Dismiss">✗</button>
      </div>
      <textarea id="rv-note-text" maxlength="${NOTE_MAX}" rows="6"
        placeholder="What happens here?"></textarea>
      <div class="rv-popover-foot">
        <span class="rv-note-count" id="rv-note-count">0 / ${NOTE_MAX}</span>
        <span class="rv-popover-msg" id="rv-note-msg"></span>
        <button type="button" class="btn btn-sm" id="rv-note-delete" title="Delete this note">Delete</button>
        <button type="button" class="btn btn-sm primary" id="rv-note-save">Save</button>
      </div>
    </aside>
    <div class="rv-scoreboard" id="rv-scoreboard" hidden>
      <div class="rv-scoreboard-head">
        <span id="rv-scoreboard-title">Match stats</span>
        <button type="button" class="rp-btn-icon" id="rv-scoreboard-close" aria-label="Close">✕</button>
      </div>
      <div class="rv-scoreboard-body" id="rv-scoreboard-body"></div>
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
      <div class="rv-tools-anchor">
        <div class="rv-tools rv-tools-draw" id="rv-draw-tools" hidden>
          <button type="button" class="rv-tool" id="rv-erase" title="Eraser: drag over a line to remove it">${icon(eraseIcon)}</button>
          <span class="rv-tool-sep"></span>
          ${DRAW_COLORS.map(
            (c) => `<button type="button" class="rv-swatch" data-color="${c.value}" title="${c.label}"
              style="--swatch:${c.value}"><span></span></button>`
          ).join('')}
        </div>
        <div class="rv-tools" id="rv-tools">
          <button type="button" class="rv-tool" id="rv-stats" title="Match stats up to this round (hold Tab)" ${
            statsDemoId ? '' : 'hidden'
          }>${statsIconSvg}</button>
          <button type="button" class="rv-tool" id="rv-coach" title="Coach: win chance and round notes">${icon(coachIcon)}</button>
          <button type="button" class="rv-tool" id="rv-draw" title="Draw (right click always draws)">${icon(pencilIcon)}</button>
          <button type="button" class="rv-tool" id="rv-note" title="Add note at current time">${icon(commentsIcon)}</button>
          <button type="button" class="rv-tool" id="rv-bookmark" title="Save to a playlist">${icon(bookmarkAddIcon)}</button>
        </div>
      </div>
      <div class="rv-popover" id="rv-playlist-panel" hidden>
        <div class="rv-playlist-list" id="rv-playlist-list"></div>
        <div class="rv-popover-foot">
          <input type="text" id="rv-playlist-new" class="site-input" maxlength="60" placeholder="New playlist" />
          <button type="button" class="btn btn-sm primary" id="rv-playlist-add">Create</button>
        </div>
        <span class="rv-popover-msg" id="rv-playlist-msg"></span>
      </div>
    </div>`;

  const canvas = el.querySelector('#rv-canvas');
  const mapEl = el.querySelector('.rv-map');
  const clockEl = el.querySelector('#rv-clock');
  const killfeedEl = el.querySelector('#rv-killfeed');
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

  const drawToolsEl = el.querySelector('#rv-draw-tools');
  const toolsEl = el.querySelector('#rv-tools');
  const drawBtn = el.querySelector('#rv-draw');
  const eraseBtn = el.querySelector('#rv-erase');
  const noteBtn = el.querySelector('#rv-note');
  const notePanel = el.querySelector('#rv-note-panel');
  const noteText = el.querySelector('#rv-note-text');
  const noteCount = el.querySelector('#rv-note-count');
  const noteMsg = el.querySelector('#rv-note-msg');
  const noteStampEl = el.querySelector('#rv-note-stamp');
  const noteCoachEl = el.querySelector('#rv-note-coach');
  const notePosEl = el.querySelector('#rv-note-pos');
  const notePrevBtn = el.querySelector('#rv-note-prev');
  const noteNextBtn = el.querySelector('#rv-note-next');
  const bookmarkBtn = el.querySelector('#rv-bookmark');
  const playlistPanel = el.querySelector('#rv-playlist-panel');
  const playlistListEl = el.querySelector('#rv-playlist-list');
  const playlistNewEl = el.querySelector('#rv-playlist-new');
  const playlistMsg = el.querySelector('#rv-playlist-msg');

  const renderer = new RadarRenderer(canvas);
  renderer.onIconLoad = () => {
    if (!destroyed) draw();
  };

  const drawing = new DrawingLayer();
  drawing.onChange = () => {
    if (!destroyed) draw();
  };
  const metaCache = new Map();
  const files = rounds.map((r) => r.file);

  let sequence = new RoundSequence(rounds.map(() => ({})));
  let activeIndex = -1;
  let activeMeta = null;
  let speedIndex = 2;
  let destroyed = false;
  /** Last rendered kill-feed signature (skip DOM work when unchanged). */
  let killFeedKey = '';
  /** @type {{ id: string, tick: number, text: string, updatedAt: number }[]} */
  let roundNotes = [];
  /** Index into roundNotes for the dock (one note visible at a time). */
  let noteIndex = 0;
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
    let activeBtn = null;
    roundsEl.querySelectorAll('.rv-round').forEach((b) => {
      const on = Number(b.dataset.index) === activeIndex;
      b.classList.toggle('active', on);
      if (on) activeBtn = b;
    });
    const side = activeIndex >= 0 ? winningSide(rounds[activeIndex]) : null;
    chromeEl.classList.toggle('wt', side === 'T');
    chromeEl.classList.toggle('wct', side === 'CT');
    activeBtn?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
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
    const noteList = roundNotes.length ? roundNotes : notesFromMeta(activeMeta);
    for (const n of noteList) {
      if (n.tick == null) continue;
      const label = noteClockLabel(n.tick);
      // Coach notes get the green diamond so they read apart from the round
      // marks around them at a glance.
      const coach = n.kind === 'coach';
      parts.push(
        `<span class="rv-mark ${coach ? 'coach' : 'note'}${
          coach && n.mark ? ` marked-${n.mark}` : ''
        }" data-note="${escapeHtml(n.id)}" style="left:${at(n.tick) * 100}%" title="${
          coach ? 'Coach' : 'Note'
        } · ${escapeHtml(label)}"></span>`
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
    drawing.setRound(files[index]);
    onRound?.(rounds[index]);
    if (!boardEl.hidden) renderScoreboard();
    syncBookmark();
    renderer._prevHealth?.fill?.(-1);
    renderer._damageTick?.fill?.(-1);
    killFeedKey = '';
    if (killfeedEl) killfeedEl.innerHTML = '';

    // Instant chrome from the summary; ticks + meta load for this round only.
    // Coach waits until full meta + ticks land — analysing earlier caches a
    // series built from the previous round's meta against this round's track.
    activeMeta = fallbackMeta(rounds[index]);
    renderScoreboards();
    loadNotesFromMeta(true);
    renderActiveMarks();
    notePanel.hidden = true;
    noteBtn.classList.remove('active');
    if (seek) playback.seek(liveOffsetOf(index), { emit: false });
    syncLoading();
    clearPlayerStates();
    if (coachOn) {
      graphEl.hidden = false;
      syncSideWinrates(null);
    }
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
      loadNotesFromMeta(true);
      renderActiveMarks();
      autoOpenNotesIfPresent();
    }

    if (seek) playback.seek(liveOffsetOf(index), { emit: false });
    if (coachOn) {
      coachCache.delete(file);
      syncCoach();
      mergeCoachNotes();
      renderActiveMarks();
    }
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
        <span class="rv-team-side" data-side-wp="${escapeHtml(side || '')}">${escapeHtml(
          side || ''
        )}</span>
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

  // ---- kill feed ----------------------------------------------------------

  const KILLFEED_MAX = 6;

  function playerRecord(id) {
    if (!id || !activeMeta?.players) return null;
    return activeMeta.players.find((p) => p.id === id) || null;
  }

  function killfeedNameClass(player) {
    if (!player) return '';
    return player.team === 2 ? 'team2' : 'team1';
  }

  function killRowHtml(k) {
    const attacker = playerRecord(k.attacker);
    const victim = playerRecord(k.victim);
    const attackerName = attacker?.name || k.attacker || '';
    const victimName = victim?.name || k.victim || '?';
    const gun = iconImgHtml(k.weapon || 'knife', 'rv-killfeed-gun');
    const hs = k.headshot
      ? '<span class="rv-killfeed-hs" title="Headshot">HS</span>'
      : '';
    const left = attackerName
      ? `<span class="rv-killfeed-name ${killfeedNameClass(attacker)}">${escapeHtml(
          attackerName
        )}</span>`
      : '';
    return `<div class="rv-killfeed-row">
      ${left}
      <span class="rv-killfeed-weapon">${gun}${hs}</span>
      <span class="rv-killfeed-name ${killfeedNameClass(victim)}">${escapeHtml(victimName)}</span>
    </div>`;
  }

  function syncKillFeed(tick = 0) {
    if (!killfeedEl || !activeMeta) return;
    const all = activeMeta.events?.kills || [];
    const happened = [];
    for (const k of all) {
      if (k.tick <= tick) happened.push(k);
    }
    const recent = happened.slice(-KILLFEED_MAX).reverse();
    const key = recent.map((k) => `${k.tick}:${k.attacker}:${k.victim}:${k.weapon}`).join('|');
    if (key === killFeedKey) return;
    killFeedKey = key;
    killfeedEl.innerHTML = recent.map((k) => killRowHtml(k)).join('');
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
    const canPan = renderer.zoom > MIN_ZOOM && !drawing.enabled;
    mapEl.classList.toggle('can-pan', canPan);
    mapEl.classList.toggle('drawing', drawing.enabled && !drawing.erasing);
    mapEl.classList.toggle('erasing', drawing.enabled && drawing.erasing);
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

  // ---- drawing / pan ------------------------------------------------------

  let panning = false;
  let panBtn = -1;
  let lastX = 0;
  let lastY = 0;
  /** Pointer id currently laying down (or rubbing out) ink, or -1. */
  let inkPointer = -1;

  function setDrawMode(on) {
    drawing.enabled = on;
    if (!on) {
      drawing.erasing = false;
      eraseBtn.classList.remove('active');
    }
    drawBtn.classList.toggle('active', on);
    drawToolsEl.hidden = !on;
    syncPanCursor();
  }

  function setColor(value) {
    drawing.color = value;
    drawToolsEl.querySelectorAll('.rv-swatch').forEach((b) => {
      b.classList.toggle('active', b.dataset.color === value);
    });
  }

  const radarAt = (e) => renderer.radarFromClient(e.clientX, e.clientY);

  function startInk(e) {
    inkPointer = e.pointerId;
    mapEl.setPointerCapture(e.pointerId);
    const pt = radarAt(e);
    if (drawing.erasing) drawing.eraseAt(pt, pt.scale);
    else drawing.begin(pt);
    e.preventDefault();
  }

  mapEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.rv-clock, .rv-loading')) return;
    closePopovers();

    // Right click always draws, whatever mode the toolbar is in. Left click
    // only draws while drawing mode is on, so it stays a pan otherwise.
    if (e.button === 2 || (e.button === 0 && drawing.enabled)) {
      startInk(e);
      return;
    }

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
    if (inkPointer === e.pointerId) {
      const pt = radarAt(e);
      if (drawing.erasing) drawing.eraseAt(pt, pt.scale);
      else drawing.extend(pt, pt.scale);
      return;
    }
    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    renderer.panX += dx;
    renderer.panY += dy;
    draw();
  });

  const endStroke = (e) => {
    if (inkPointer !== e.pointerId) return false;
    inkPointer = -1;
    if (e.type === 'pointercancel') drawing.cancel();
    else drawing.end();
    try {
      mapEl.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    return true;
  };

  const endPan = (e) => {
    if (endStroke(e)) return;
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
  // Always swallowed: right-drag is the draw gesture at every zoom level.
  mapEl.addEventListener('contextmenu', (e) => e.preventDefault());

  drawBtn.addEventListener('click', () => setDrawMode(!drawing.enabled));
  eraseBtn.addEventListener('click', () => {
    drawing.erasing = !drawing.erasing;
    eraseBtn.classList.toggle('active', drawing.erasing);
    syncPanCursor();
  });
  drawToolsEl.addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;
    // Picking a pen is also the way out of erasing.
    drawing.erasing = false;
    eraseBtn.classList.remove('active');
    setColor(swatch.dataset.color);
    syncPanCursor();
  });
  setColor(DRAW_COLORS[0].value);

  // ---- notes (timestamped, many per round, one visible at a time) ---------

  function closePopovers(except = null) {
    if (notePanel !== except) notePanel.hidden = true;
    if (playlistPanel !== except) playlistPanel.hidden = true;
    noteBtn.classList.toggle('active', !notePanel.hidden);
    bookmarkBtn.classList.toggle('open', !playlistPanel.hidden);
  }

  function newNoteId() {
    return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Legacy `meta.note` + `meta.notes` → sorted list. */
  function notesFromMeta(meta) {
    if (!meta) return [];
    if (Array.isArray(meta.notes) && meta.notes.length) {
      return [...meta.notes]
        .map((n) => ({
          id: String(n.id || newNoteId()),
          tick: Math.max(0, Math.round(Number(n.tick) || 0)),
          text: String(n.text ?? ''),
          kind: n.kind === 'coach' ? 'coach' : 'user',
          mark: n.mark === 'ok' || n.mark === 'x' ? n.mark : '',
          updatedAt: Number(n.updatedAt) || 0
        }))
        .sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt);
    }
    if (meta.note) {
      const tick = Number(meta.freezeEndTick);
      return [
        {
          id: 'legacy',
          tick: Number.isFinite(tick) ? tick : 0,
          text: String(meta.note),
          kind: 'user',
          mark: '',
          updatedAt: Number(meta.noteUpdatedAt) || 0
        }
      ];
    }
    return [];
  }

  function currentNote() {
    return roundNotes[noteIndex] || null;
  }

  function noteClockLabel(tick) {
    if (!activeMeta) return formatClock(0);
    const timing = timingFor(activeMeta);
    const local = Math.max(0, (tick - timing.startTick) / (timing.tickRate || 64));
    return formatClock(local);
  }

  function playheadTick() {
    const at = sequence.locate(playback.position);
    if (at.index !== activeIndex) {
      const timing = timingFor(activeMeta || {});
      return timing.freezeEndTick || timing.startTick || 0;
    }
    return Math.round(at.tick);
  }

  function flushNoteText() {
    const n = currentNote();
    if (!n) return;
    n.text = noteText.value;
  }

  function syncNoteCount() {
    noteCount.textContent = `${noteText.value.length} / ${NOTE_MAX}`;
  }

  function syncNoteHasBadge() {
    const has = roundNotes.some((n) => String(n.text || '').trim());
    noteBtn.classList.toggle('has-note', has);
  }

  function renderNoteDock({ forceText = false } = {}) {
    const n = currentNote();
    const total = roundNotes.length;
    if (!n) {
      noteCoachEl.hidden = true;
      noteStampEl.textContent = '—';
      notePosEl.textContent = '';
      noteText.value = '';
      notePrevBtn.disabled = true;
      noteNextBtn.disabled = true;
      syncNoteCount();
      syncNoteHasBadge();
      return;
    }
    noteCoachEl.hidden = n.kind !== 'coach';
    noteCoachEl.querySelectorAll('[data-mark]').forEach((b) => {
      b.classList.toggle('active', n.mark === b.dataset.mark);
    });
    noteStampEl.textContent = noteClockLabel(n.tick);
    notePosEl.textContent = total > 1 ? `${noteIndex + 1} / ${total}` : '';
    if (forceText || document.activeElement !== noteText) noteText.value = n.text || '';
    notePrevBtn.disabled = noteIndex <= 0;
    noteNextBtn.disabled = noteIndex >= total - 1;
    syncNoteCount();
    syncNoteHasBadge();
  }

  function loadNotesFromMeta(force = false) {
    if (!force && document.activeElement === noteText) return;
    roundNotes = notesFromMeta(activeMeta);
    noteIndex = roundNotes.length ? 0 : -1;
    noteMsg.textContent = '';
    renderNoteDock();
    renderActiveMarks();
  }

  function seekToNoteTick(tick) {
    if (activeIndex < 0 || !activeMeta) return;
    const timing = timingFor(activeMeta);
    const item = sequence.at(activeIndex);
    if (!item) return;
    const local = Math.max(0, (tick - timing.startTick) / (timing.tickRate || 64));
    playback.seek(sequence.offsetOf(activeIndex) + Math.min(local, item.seconds));
  }

  function showNoteAt(index, { seek = false } = {}) {
    if (!roundNotes.length) {
      noteIndex = -1;
      renderNoteDock({ forceText: true });
      return;
    }
    noteIndex = Math.max(0, Math.min(roundNotes.length - 1, index));
    renderNoteDock({ forceText: true });
    if (seek) seekToNoteTick(roundNotes[noteIndex].tick);
  }

  /** Open the dock on the first chronological note when the round has any. */
  function autoOpenNotesIfPresent() {
    loadNotesFromMeta(true);
    if (!roundNotes.length) return;
    closePopovers(notePanel);
    notePanel.hidden = false;
    noteBtn.classList.add('active');
    showNoteAt(0, { seek: false });
  }

  /**
   * A verdict on a coach note. Saved straight away rather than on the Save
   * button: a tick or a cross is a decision, not a draft.
   */
  async function markCurrentNote(mark) {
    const n = currentNote();
    if (!n || n.kind !== 'coach') return;
    n.mark = n.mark === mark ? '' : mark;
    n.updatedAt = Date.now();
    renderNoteDock();
    renderActiveMarks();
    await persistNotes();
  }

  noteCoachEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mark]');
    if (btn) markCurrentNote(btn.dataset.mark);
  });

  /** Clicking a mark on the scrub jumps to it and opens what it is about. */
  marksEl.addEventListener('click', (e) => {
    const mark = e.target.closest('[data-note]');
    if (!mark) return;
    const index = roundNotes.findIndex((n) => n.id === mark.dataset.note);
    if (index < 0) return;
    closePopovers(notePanel);
    notePanel.hidden = false;
    noteBtn.classList.add('active');
    showNoteAt(index, { seek: true });
  });

  function setNoteOpen(open) {
    closePopovers(open ? notePanel : null);
    notePanel.hidden = !open;
    noteBtn.classList.toggle('active', open);
    if (open) {
      renderNoteDock();
      noteText.focus();
    }
  }

  /** Stamp a new note at the scrubber time and show it. */
  function createNoteAtPlayhead() {
    flushNoteText();
    const tick = playheadTick();
    const note = { id: newNoteId(), tick, text: '', updatedAt: Date.now() };
    roundNotes.push(note);
    roundNotes.sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt);
    noteIndex = roundNotes.findIndex((n) => n.id === note.id);
    noteMsg.textContent = '';
    setNoteOpen(true);
    renderNoteDock({ forceText: true });
    renderActiveMarks();
    noteText.focus();
  }

  async function persistNotes() {
    const file = files[activeIndex];
    if (!file) return;
    flushNoteText();
    const payload = roundNotes
      .map((n) => ({
        id: n.id,
        tick: n.tick,
        text: String(n.text || '').trim(),
        kind: n.kind === 'coach' ? 'coach' : 'user',
        mark: n.mark || '',
        updatedAt: n.updatedAt || Date.now()
      }))
      .filter((n) => n.text);
    noteMsg.textContent = 'Saving…';
    try {
      const res = await saveRoundNotes(file, payload);
      const saved = Array.isArray(res.notes) ? res.notes : payload;
      roundNotes = notesFromMeta({ notes: saved });
      if (activeMeta) {
        activeMeta.notes = roundNotes;
        delete activeMeta.note;
        delete activeMeta.noteUpdatedAt;
      }
      const cached = await metaCache.get(file);
      if (cached) {
        cached.notes = roundNotes;
        delete cached.note;
        delete cached.noteUpdatedAt;
      }
      if (!roundNotes.length) {
        noteIndex = -1;
        noteMsg.textContent = 'Notes cleared.';
        setNoteOpen(false);
      } else {
        if (noteIndex < 0 || noteIndex >= roundNotes.length) noteIndex = 0;
        noteMsg.textContent = 'Saved.';
        renderNoteDock();
      }
      syncNoteHasBadge();
      renderActiveMarks();
    } catch (err) {
      noteMsg.textContent = err.message || 'Could not save.';
    }
  }

  noteText.addEventListener('input', () => {
    flushNoteText();
    syncNoteCount();
    syncNoteHasBadge();
  });
  noteBtn.addEventListener('click', () => createNoteAtPlayhead());
  notePrevBtn.addEventListener('click', () => {
    flushNoteText();
    showNoteAt(noteIndex - 1, { seek: true });
  });
  noteNextBtn.addEventListener('click', () => {
    flushNoteText();
    showNoteAt(noteIndex + 1, { seek: true });
  });
  el.querySelector('#rv-note-close').addEventListener('click', () => setNoteOpen(false));
  el.querySelector('#rv-note-delete').addEventListener('click', () => {
    const n = currentNote();
    if (!n) return;
    roundNotes = roundNotes.filter((x) => x.id !== n.id);
    if (!roundNotes.length) {
      noteIndex = -1;
      noteText.value = '';
      noteMsg.textContent = 'Deleted. Save to confirm.';
      renderNoteDock();
      syncNoteHasBadge();
      renderActiveMarks();
      return;
    }
    noteIndex = Math.min(noteIndex, roundNotes.length - 1);
    noteMsg.textContent = 'Deleted. Save to confirm.';
    renderNoteDock();
    renderActiveMarks();
  });
  el.querySelector('#rv-note-save').addEventListener('click', () => persistNotes());

  // ---- playlists ----------------------------------------------------------

  let playlists = null;

  function inPlaylists(file) {
    if (!playlists || !file) return [];
    return playlists.filter((p) => (p.rounds || []).includes(file));
  }

  function syncBookmark() {
    const on = inPlaylists(files[activeIndex]).length > 0;
    bookmarkBtn.innerHTML = icon(on ? bookmarkAddedIcon : bookmarkAddIcon);
    bookmarkBtn.classList.toggle('has-note', on);
    bookmarkBtn.title = on ? 'In a playlist' : 'Save to a playlist';
  }

  function renderPlaylists() {
    const file = files[activeIndex];
    if (!playlists) {
      playlistListEl.innerHTML = '<p class="rv-popover-empty">Loading…</p>';
      return;
    }
    if (!playlists.length) {
      playlistListEl.innerHTML = '<p class="rv-popover-empty">No playlists yet.</p>';
      return;
    }
    playlistListEl.innerHTML = playlists
      .map((p) => {
        const has = (p.rounds || []).includes(file);
        return `<button type="button" class="rv-playlist-item${has ? ' on' : ''}" data-playlist="${escapeHtml(p.id)}">
          <span class="rv-playlist-check">${has ? '✓' : ''}</span>
          <span class="rv-playlist-name">${escapeHtml(p.name)}</span>
          <span class="rv-playlist-count">${(p.rounds || []).length}</span>
        </button>`;
      })
      .join('');
  }

  async function loadPlaylists() {
    try {
      playlists = await fetchPlaylists();
    } catch {
      playlists = [];
    }
    if (destroyed) return;
    renderPlaylists();
    syncBookmark();
  }

  async function togglePlaylist(id) {
    const file = files[activeIndex];
    const target = playlists?.find((p) => p.id === id);
    if (!file || !target) return;
    const has = (target.rounds || []).includes(file);
    const next = has
      ? (target.rounds || []).filter((r) => r !== file)
      : [...(target.rounds || []), file];
    playlistMsg.textContent = '';
    try {
      playlists = await savePlaylist({ id, rounds: next });
      renderPlaylists();
      syncBookmark();
    } catch (err) {
      playlistMsg.textContent = err.message || 'Could not save.';
    }
  }

  playlistListEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-playlist]');
    if (item) togglePlaylist(item.dataset.playlist);
  });

  async function createPlaylist() {
    const name = playlistNewEl.value.trim();
    const file = files[activeIndex];
    if (!name || !file) return;
    playlistMsg.textContent = '';
    try {
      playlists = await savePlaylist({ name, rounds: [file] });
      playlistNewEl.value = '';
      renderPlaylists();
      syncBookmark();
    } catch (err) {
      playlistMsg.textContent = err.message || 'Could not create the playlist.';
    }
  }

  el.querySelector('#rv-playlist-add').addEventListener('click', createPlaylist);
  playlistNewEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPlaylist();
  });

  bookmarkBtn.addEventListener('click', () => {
    const open = playlistPanel.hidden;
    closePopovers(open ? playlistPanel : null);
    playlistPanel.hidden = !open;
    bookmarkBtn.classList.toggle('open', open);
    if (open) {
      renderPlaylists();
      if (!playlists) loadPlaylists();
    }
  });

  // ---- live scoreboard ----------------------------------------------------
  //
  // Everything up to the round on screen, as two boards. The index is fetched
  // once for this demo and re-aggregated locally on every open, so stepping
  // from round 14 to round 20 costs no request.

  const statsBtn = el.querySelector('#rv-stats');
  const boardEl = el.querySelector('#rv-scoreboard');
  const boardBody = el.querySelector('#rv-scoreboard-body');
  const boardTitle = el.querySelector('#rv-scoreboard-title');
  let statsPayload = null;
  let statsPending = null;
  const detachBoardTips = attachTips(boardEl);

  function renderScoreboard() {
    if (!statsPayload) {
      boardBody.innerHTML = '<p class="view-empty">Loading…</p>';
      return;
    }
    const demo = statsPayload.demos?.[0];
    if (!demo) {
      boardBody.innerHTML = '<p class="view-empty">No stats for this match yet.</p>';
      return;
    }
    const upTo = rounds[activeIndex]?.round ?? 0;
    const rows = allRows(statsPayload).filter((r) => r.n <= upTo);
    const { players } = indexMaps(statsPayload);
    const all = aggregatePlayers(rows, players, {});
    const teamOf = new Map(demo.players.map((p) => [p.id, p.team]));

    boardTitle.textContent = `Rounds 1-${upTo}`;
    const board = (team, name) => {
      const list = all.filter((p) => teamOf.get(p.id) === team);
      return `<div class="rv-board">
        <h4 class="rv-board-name team${team}">${escapeHtml(name)}</h4>
        ${statsTableHtml(list, {
          columns: PLAYER_COLUMNS,
          escapeHtml,
          sortKey: 'rating',
          sortDir: 'desc'
        })}
      </div>`;
    };
    boardBody.innerHTML = board(1, demo.name1) + board(2, demo.name2);
  }

  /** When true, Tab is holding the board open; release always closes it. */
  let tabHoldingStats = false;

  function setScoreboardOpen(open) {
    const next = Boolean(open);
    boardEl.hidden = !next;
    statsBtn?.classList.toggle('active', next);
    if (!next) return;
    if (!statsDemoId) {
      boardBody.innerHTML = '<p class="view-empty">Load a full match to see live stats.</p>';
      return;
    }
    renderScoreboard();
    if (statsPayload || statsPending) return;
    statsPending = fetchStats([statsDemoId])
      .then((res) => {
        statsPayload = res;
        if (!destroyed && !boardEl.hidden) renderScoreboard();
      })
      .catch(() => {
        if (!destroyed) boardBody.innerHTML = '<p class="view-empty">Could not load stats.</p>';
      })
      .finally(() => {
        statsPending = null;
      });
  }

  function toggleScoreboard(force = null) {
    const open = force === null ? boardEl.hidden : force;
    // Clicking the tool button cancels a Tab-hold claim.
    if (force === null) tabHoldingStats = false;
    setScoreboardOpen(open);
  }

  statsBtn?.addEventListener('click', () => toggleScoreboard());
  el.querySelector('#rv-scoreboard-close').addEventListener('click', () => {
    tabHoldingStats = false;
    setScoreboardOpen(false);
  });

  function onTabDown(e) {
    if (e.key !== 'Tab' && e.code !== 'Tab') return;
    if (e.target.matches?.('input, textarea, select')) return;
    if (!statsDemoId) return;
    e.preventDefault();
    if (e.repeat) return;
    // Hold Tab shows the board; overrides a click-opened sticky board.
    tabHoldingStats = true;
    setScoreboardOpen(true);
  }

  function onTabUp(e) {
    if (e.key !== 'Tab' && e.code !== 'Tab') return;
    if (!tabHoldingStats) return;
    e.preventDefault();
    tabHoldingStats = false;
    setScoreboardOpen(false);
  }

  function onTabCancel() {
    if (!tabHoldingStats) return;
    tabHoldingStats = false;
    setScoreboardOpen(false);
  }

  window.addEventListener('keydown', onTabDown);
  window.addEventListener('keyup', onTabUp);
  window.addEventListener('blur', onTabCancel);

  // ---- coach --------------------------------------------------------------
  //
  // The analysis is pure and cheap (a couple of milliseconds a round), so it is
  // run once per round on demand and cached. Everything the coach shows — the
  // graph, the readout, the diamonds — reads off that one result.

  const coachBtn = el.querySelector('#rv-coach');
  const graphEl = el.querySelector('#rv-wingraph');
  const graphCanvas = el.querySelector('#rv-wingraph-canvas');
  const graphT1 = el.querySelector('#rv-wingraph-t1');
  const graphT2 = el.querySelector('#rv-wingraph-t2');
  const graphTip = el.querySelector('#rv-wingraph-tip');
  let coachOn = false;
  /** CSS-pixel playhead on the canvas (for hit-testing + tip anchor). */
  let graphPlayhead = null;
  let graphHoverDot = false;
  let graphShift = false;
  /** round file -> { series, flags, gate } */
  const coachCache = new Map();

  const coachScratch = [];

  function coachFor(index) {
    const file = files[index];
    // Only analyse the active round with its own full meta — never the prior
    // round's meta against this file's ticks.
    if (!file || index !== activeIndex || !activeMeta?.players?.length) return null;
    if (coachCache.has(file)) return coachCache.get(file);
    const track = store.track(file);
    if (!track) return null;
    const scratch = [];
    const result = analyseRound({
      meta: activeMeta,
      sampleAt: (tick) => {
        track.sampleAll(tick, scratch);
        return scratch;
      }
    });
    coachCache.set(file, result);
    return result;
  }

  /** Win chance sample at (or just before) a tick from the cached series. */
  function coachSampleAt(result, tick) {
    if (!result?.series?.length) return null;
    let best = result.series[0];
    for (const s of result.series) {
      if (s.tick <= tick) best = s;
      else break;
    }
    return best;
  }

  /** Fresh win% at this tick (kill log + live equip), for badges / playhead. */
  function liveCoachSample(tick) {
    const file = files[activeIndex];
    const track = file ? store.track(file) : null;
    if (!track || !activeMeta?.players?.length) return null;
    track.sampleAll(tick, coachScratch);
    return winProbabilityAtTick({ meta: activeMeta, states: coachScratch, tick });
  }

  /** Win chance for the side each roster team is playing this round. */
  function coachProbabilityAt(sample) {
    if (!sample) return null;
    const s1 = activeMeta?.team1Side === 'CT' ? sample.ct : sample.t;
    return { team1: s1, team2: 100 - s1, t: sample.t, ct: sample.ct };
  }

  /** Put T/CT win% in the side badges (or restore T/CT when coach is off). */
  function syncSideWinrates(now) {
    for (const badge of el.querySelectorAll('[data-side-wp]')) {
      const side = badge.dataset.sideWp;
      if (!coachOn || !now || (side !== 'T' && side !== 'CT')) {
        badge.textContent = side || '';
        badge.classList.toggle('is-wp', false);
        continue;
      }
      const pct = Math.round(side === 'CT' ? now.ct : now.t);
      badge.textContent = `${pct}%`;
      badge.classList.toggle('is-wp', true);
    }
  }

  function drawWinGraph(result, tick, live = null) {
    if (!graphCanvas || !result?.series?.length) {
      graphPlayhead = null;
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = graphCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (graphCanvas.width !== w || graphCanvas.height !== h) {
      graphCanvas.width = w;
      graphCanvas.height = h;
    }
    const ctx = graphCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const series = result.series;
    const span = Math.max(1, series.length - 1);
    const t1Side = activeMeta?.team1Side === 'CT';
    const share = (p) => (t1Side ? p.ct : p.t) / 100;
    const xAt = (i) => (i / span) * w;
    // Team 1 above the midline, team 2 below: the further from centre, the
    // more one side is winning, the same way a chess eval bar reads.
    const yAt = (i) => h - share(series[i]) * h;

    const fillTo = (baseline, above) => {
      ctx.beginPath();
      ctx.moveTo(0, baseline);
      for (let i = 0; i < series.length; i++) {
        const y = yAt(i);
        ctx.lineTo(xAt(i), above ? Math.min(y, baseline) : Math.max(y, baseline));
      }
      ctx.lineTo(w, baseline);
      ctx.closePath();
      ctx.fill();
    };

    const mid = h / 2;
    ctx.fillStyle = 'rgba(56, 163, 232, 0.42)';
    fillTo(mid, true);
    ctx.fillStyle = 'rgba(232, 145, 60, 0.42)';
    fillTo(mid, false);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    ctx.strokeStyle = '#e8913c';
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = xAt(i);
      const y = yAt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Playhead X follows time along the series; Y uses the live sample so the
    // dot tracks bodies/utility every tick, not only on 1 Hz series points.
    let i0 = 0;
    for (let i = 0; i < series.length; i++) if (series[i].tick <= tick) i0 = i;
    const i1 = Math.min(series.length - 1, i0 + 1);
    let f = 0;
    if (i1 > i0) {
      const t0 = series[i0].tick;
      const t1 = series[i1].tick;
      f = t1 > t0 ? Math.min(1, Math.max(0, (tick - t0) / (t1 - t0))) : 0;
    }
    const px = xAt(i0) * (1 - f) + xAt(i1) * f;
    const sample = live || coachSampleAt(result, tick);
    const py = sample
      ? h - share(sample) * h
      : yAt(i0) * (1 - f) + yAt(i1) * f;
    const r = 4 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r + 1.2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    graphPlayhead = { x: px / dpr, y: py / dpr, tick, sample };

    const now = coachProbabilityAt(sample);
    if (now) {
      graphT1.textContent = `${Math.round(now.team1)}%`;
      graphT2.textContent = `${Math.round(now.team2)}%`;
    }
    updateWinGraphTip();
  }

  function escapeTip(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function updateWinGraphTip() {
    if (!graphTip) return;
    if (!coachOn || !graphHoverDot || !graphPlayhead) {
      graphTip.hidden = true;
      return;
    }
    const sample =
      graphPlayhead.sample ||
      liveCoachSample(graphPlayhead.tick) ||
      coachSampleAt(coachFor(activeIndex), graphPlayhead.tick);
    if (!sample) {
      graphTip.hidden = true;
      return;
    }
    const map = activeMeta?.map || '';
    const { summary, detail } = explainProbability(sample, map);
    if (graphShift && detail.length) {
      graphTip.innerHTML = `<strong>${escapeTip(summary)}</strong><br>${detail
        .map(escapeTip)
        .join('<br>')}`;
    } else {
      graphTip.textContent = summary;
    }
    graphTip.hidden = false;
    const canvasRect = graphCanvas.getBoundingClientRect();
    const hostRect = graphEl.getBoundingClientRect();
    const left = canvasRect.left - hostRect.left + graphPlayhead.x;
    const top = canvasRect.top - hostRect.top + graphPlayhead.y;
    graphTip.style.left = `${left}px`;
    graphTip.style.top = `${top}px`;
  }

  function onGraphPointerMove(e) {
    if (!graphPlayhead || !graphCanvas) {
      graphHoverDot = false;
      updateWinGraphTip();
      return;
    }
    const rect = graphCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const near =
      Math.hypot(x - graphPlayhead.x, y - graphPlayhead.y) <= 16;
    if (near !== graphHoverDot) {
      graphHoverDot = near;
      graphCanvas.classList.toggle('is-dot-hover', near);
    }
    updateWinGraphTip();
  }

  function onGraphPointerLeave() {
    graphHoverDot = false;
    graphCanvas?.classList.remove('is-dot-hover');
    updateWinGraphTip();
  }

  function onGraphShiftKey(e) {
    if (e.key !== 'Shift') return;
    graphShift = e.type === 'keydown';
    if (graphHoverDot) updateWinGraphTip();
  }

  graphCanvas?.addEventListener('pointermove', onGraphPointerMove);
  graphCanvas?.addEventListener('pointerleave', onGraphPointerLeave);
  window.addEventListener('keydown', onGraphShiftKey);
  window.addEventListener('keyup', onGraphShiftKey);

  function syncCoach(tick = null) {
    graphEl.hidden = !coachOn;
    coachBtn?.classList.toggle('active', coachOn);
    if (!coachOn) {
      syncSideWinrates(null);
      graphPlayhead = null;
      graphHoverDot = false;
      if (graphTip) graphTip.hidden = true;
      return;
    }
    const at = tick ?? sequence.locate(playback.position).tick;
    const live = liveCoachSample(at);
    const result = coachFor(activeIndex);
    if (result) drawWinGraph(result, at, live);
    syncSideWinrates(coachProbabilityAt(live || coachSampleAt(result, at)));
  }

  coachBtn?.addEventListener('click', () => {
    coachOn = !coachOn;
    syncCoach();
    if (coachOn) {
      mergeCoachNotes();
      renderActiveMarks();
    } else {
      clearAllCoachNotes();
    }
  });

  /**
   * Coach flags become notes in the round's own list, so they persist and can
   * be marked exactly like anything a person wrote. Existing coach notes are
   * left alone: a flag that has already been reviewed keeps its verdict.
   */
  async function mergeCoachNotes() {
    const file = files[activeIndex];
    const result = coachFor(activeIndex);
    if (!file || !result) return;
    // Work from the dock's list, not the meta: the user may have added or
    // edited notes since the round loaded, and those must survive the merge.
    const existing = roundNotes.length ? roundNotes : notesFromMeta(activeMeta);
    const have = new Set(existing.filter((n) => n.kind === 'coach').map((n) => n.id));
    const fresh = result.flags.map(flagToNote).filter((n) => !have.has(n.id));
    if (!fresh.length) return;
    const next = [...existing, ...fresh].sort((a, b) => a.tick - b.tick);
    roundNotes = next;
    activeMeta.notes = next;
    if (noteIndex < 0 && roundNotes.length) noteIndex = 0;
    renderNoteDock();
    renderActiveMarks();
    try {
      await persistNotes();
    } catch {
      /* the notes still show for this session even if the save failed */
    }
  }

  /**
   * Turning coach off drops every coach note in this demo. User notes stay.
   */
  async function clearAllCoachNotes() {
    flushNoteText();
    coachCache.clear();

    const strip = (list) => list.filter((n) => n.kind !== 'coach');

    // Active round first so diamonds / dock update immediately.
    roundNotes = strip(roundNotes);
    if (activeMeta) activeMeta.notes = roundNotes;
    if (!roundNotes.length) {
      noteIndex = -1;
      if (!notePanel.hidden) setNoteOpen(false);
    } else if (noteIndex < 0 || noteIndex >= roundNotes.length) {
      noteIndex = 0;
    }
    renderNoteDock({ forceText: true });
    renderActiveMarks();

    for (const file of files) {
      let meta = null;
      if (file === files[activeIndex] && activeMeta) meta = activeMeta;
      else if (metaCache.has(file)) {
        try {
          meta = await metaCache.get(file);
        } catch {
          meta = null;
        }
      } else {
        try {
          meta = await metaFor(file);
        } catch {
          continue;
        }
      }
      if (!meta) continue;
      const before = notesFromMeta(meta);
      if (!before.some((n) => n.kind === 'coach')) {
        // Still persist the active round if we already stripped it locally.
        if (file === files[activeIndex]) {
          try {
            await saveRoundNotes(file, roundNotes);
          } catch {
            /* ignore */
          }
        }
        continue;
      }
      const next = strip(before);
      meta.notes = next;
      delete meta.note;
      delete meta.noteUpdatedAt;
      if (file === files[activeIndex]) {
        roundNotes = next;
        if (!roundNotes.length) noteIndex = -1;
        else if (noteIndex >= roundNotes.length) noteIndex = 0;
        renderNoteDock({ forceText: true });
        renderActiveMarks();
      }
      try {
        await saveRoundNotes(file, next);
        if (metaCache.has(file)) {
          const cached = await metaCache.get(file);
          if (cached) {
            cached.notes = next;
            delete cached.note;
            delete cached.noteUpdatedAt;
          }
        }
      } catch {
        /* local strip still stands for this session */
      }
    }
  }

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

  function freezeKillPositions(meta, track) {
    const kills = meta?.events?.kills;
    if (!track || !kills?.length) return;
    const tmp = [];
    for (const k of kills) {
      if (Number.isFinite(k._wx) && Number.isFinite(k._wy)) continue;
      track.sampleAll(k.tick, tmp);
      const victim = (meta.players || []).find((p) => p.id === k.victim);
      const s = victim ? tmp[victim.slot] : null;
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
        k._wx = s.x;
        k._wy = s.y;
      }
    }
  }

  function draw(loc = null) {
    if (!activeMeta) return;
    const at = loc || sequence.locate(playback.position);
    if (at.index !== activeIndex) return;
    const timing = timingFor(activeMeta);
    const tick = at.tick;

    const track = store.track(files[activeIndex]);
    if (track) {
      freezeKillPositions(activeMeta, track);
      track.sampleAll(tick, states);
    } else clearPlayerStates();

    renderer.render({
      tick,
      tickRate: timing.tickRate,
      states,
      players: track ? activeMeta.players || [] : [],
      allPlayers: track ? activeMeta.players || [] : [],
      events: track ? activeMeta.events || {} : { kills: [], shots: [], grenades: [], bomb: [] },
      weapons: activeMeta.weapons || [],
      teamSides: { 1: activeMeta.team1Side, 2: activeMeta.team2Side },
      drawings: drawing.visible(),
      marksKey: files[activeIndex] || '',
      hideDeaths: false
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
    syncKillFeed(tick);
    if (coachOn) syncCoach(tick);
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

  /** Slot currently under the pointer in a side panel, or -1. */
  let hoverSlot = -1;

  team1El.addEventListener('pointerover', (e) => {
    const row = e.target.closest('.rv-player[data-slot]');
    if (row) hoverSlot = Number(row.dataset.slot);
  });
  team1El.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget || !team1El.contains(e.relatedTarget)) hoverSlot = -1;
  });
  team2El.addEventListener('pointerover', (e) => {
    const row = e.target.closest('.rv-player[data-slot]');
    if (row) hoverSlot = Number(row.dataset.slot);
  });
  team2El.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget || !team2El.contains(e.relatedTarget)) hoverSlot = -1;
  });

  function fmtCoord(n) {
    return (Math.round(n * 1e6) / 1e6).toFixed(6);
  }

  /** getpos-style string: setpos x y z; setang pitch yaw 0 */
  function setposForSlot(slot) {
    const s = states[slot];
    if (!s || !Number.isFinite(s.x)) return '';
    return `setpos ${fmtCoord(s.x)} ${fmtCoord(s.y)} ${fmtCoord(s.z)}; setang ${fmtCoord(s.pitch)} ${fmtCoord(s.yaw)} 0`;
  }

  async function copySetpos(slot) {
    const cmd = setposForSlot(slot);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      flashPlayerCopied(slot);
    } catch {
      // Fallback for non-secure contexts.
      window.prompt('Copy setpos:', cmd);
    }
  }

  function flashPlayerCopied(slot) {
    const row = el.querySelector(`.rv-player[data-slot="${slot}"]`);
    if (!row) return;
    row.classList.add('copied');
    window.setTimeout(() => row.classList.remove('copied'), 700);
  }

  function onKey(e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (e.code === 'Space' || key === ' ') {
      e.preventDefault();
      playback.toggle();
      syncPlayButton();
      return;
    }
    if (e.code === 'ArrowLeft') {
      playback.nudge(e.shiftKey ? -10 : -2);
      return;
    }
    if (e.code === 'ArrowRight') {
      playback.nudge(e.shiftKey ? 10 : 2);
      return;
    }
    if (key === 'e') {
      e.preventDefault();
      drawing.clear();
      draw();
      return;
    }
    if (key === 'j') {
      e.preventDefault();
      if (activeIndex > 0) selectRound(activeIndex - 1, { seek: true });
      return;
    }
    if (key === 'k') {
      e.preventDefault();
      if (activeIndex < files.length - 1) selectRound(activeIndex + 1, { seek: true });
      return;
    }
    if (key === 's') {
      if (hoverSlot < 0) return;
      e.preventDefault();
      copySetpos(hoverSlot);
    }
  }
  window.addEventListener('keydown', onKey);

  // The round strip + transport float over the bottom of the stage, so the map
  // fits itself above them. The strip wraps to two rows on narrow windows, so
  // the inset is measured rather than assumed.
  function syncChromeInset() {
    const chromeH = chromeEl.offsetHeight;
    const stageH = el.querySelector('.rv-stage')?.clientHeight || 0;
    const overlap = Math.max(0, Math.min(chromeH - 12, stageH * 0.35));
    if (renderer.viewInset.bottom !== overlap) {
      renderer.viewInset.bottom = overlap;
      return true;
    }
    return false;
  }

  const chromeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (syncChromeInset() && !destroyed) draw();
        })
      : null;
  chromeObserver?.observe(chromeEl);

  const onResize = () => {
    syncChromeInset();
    draw();
  };
  window.addEventListener('resize', onResize);

  const offStore = store.onChange((event) => {
    if (event.type === 'full' && event.file === files[activeIndex]) draw();
  });

  (async () => {
    // buildSequence → selectRound(0) already full-loads round 1 only.
    syncChromeInset();
    loadPlaylists();
    await buildSequence();
  })();

  return {
    el,
    destroy() {
      destroyed = true;
      playback.destroy();
      detachBoardTips();
      offStore();
      chromeObserver?.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onTabDown);
      window.removeEventListener('keyup', onTabUp);
      window.removeEventListener('blur', onTabCancel);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onGraphShiftKey);
      window.removeEventListener('keyup', onGraphShiftKey);
      graphCanvas?.removeEventListener('pointermove', onGraphPointerMove);
      graphCanvas?.removeEventListener('pointerleave', onGraphPointerLeave);
    }
  };
}
