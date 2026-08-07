// ---------------------------------------------------------------------------
// replays/viewer/timelineViewer.js
// One round on screen at a time. Round chips + a single scrub timeline sit
// over the bottom of the stage (higher z). Full tick data is loaded for the
// active round only; switching rounds loads that round's data next. Cached
// rounds stay in memory until the viewer closes.
// ---------------------------------------------------------------------------

import {
  NOTE_MAX,
  countDemoView,
  fetchPlaylists,
  fetchRoundMeta,
  fetchTeams,
  fetchZones,
  markTeamAutocoachDemo,
  saveRoundNotes,
  savePlaylist,
  fetchStats
} from '../api.js';
import { teamNameKey } from '../shared/statsMath.js';
import { useMeteredFeature } from '../../lib/meteredFeature.js';
import { getEntitlements } from '../../lib/entitlements.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { aggregatePlayers, allRows, indexMaps } from '../shared/statsMath.js';
import {
  PLAYER_COLUMNS_WITH_DUELS,
  PLAYER_FIXED_BASE,
  attachTips,
  bindStatsHScroll,
  statsTableHtml
} from '../stats/statsTables.js';
import { RadarRenderer, SIDE_COLORS } from './radarRenderer.js';
import { Playback, RoundSequence } from './playback.js';
import { clockAt, formatClock, timingFor } from './roundClock.js';
import { economyLabel, winningSide } from '../shared/roundId.js';
import { iconImgHtml, inventoryAt } from './equipmentIcons.js';
import { DRAW_COLORS, DrawingLayer } from './drawing.js';
import { analyseRound, coachSampleStride, flagToNote } from '../coach/coach.js';
import { loadCoachSmokes } from '../coach/coachSmokes.js';
import { explainRoundLines } from '../rounds/roundExplain.js';
import { phaseBounds } from '../coach/roundPhases.js';
import {
  buildZonePresence,
  computeZonePaint,
  createConeCaster,
  createZoneVisionCache,
  hasControlField,
  prepareControlField,
  resetZoneVisionCache
} from '../zones/zoneOverlay.js';
import { buildMapControlSeries } from '../zones/mapControl.js';
import { RADAR_SIZE, worldToRadar } from './mapCalibration.js';
import helmetSvg from '../../icons/helmet.svg?url';
import kevlarSvg from '../../icons/kevlar.svg?url';
import nokevlarSvg from '../../icons/nokevlar.svg?url';
import pencilIcon from '../../icons/demos_drawing.svg?raw';
import eraseIcon from '../../icons/demos_erase.svg?raw';
import commentsIcon from '../../icons/demos_comments.svg?raw';
import bookmarkAddIcon from '../../icons/demos_bookmarks_add.svg?raw';
import bookmarkAddedIcon from '../../icons/demos_bookmarks_added.svg?raw';
import coachIcon from '../../icons/demos_coach.svg?raw';
import chartIcon from '../../icons/demos_chart.svg?raw';
import zonesIcon from '../../icons/demos_zones.svg?raw';
import duelsIcon from '../../icons/demos_duels.svg?raw';
import povIcon from '../../icons/demo_pov.svg?raw';
import rosterIcon from '../../icons/icon_multiplayer.svg?raw';
import { createPovVision, povDuelOverlay, povZonePaint } from './teamPov.js';
import { rememberRound } from '../../site/homeView.js';
import { createDuelOverlay } from '../duels/duelOverlay.js';
import { createDuelScanner, scanTickFor } from '../duels/duelScanner.js';
import {
  addRoundDuels,
  createDuelStats,
  summarizeDuelStats
} from '../duels/duelStats.js';
import { spinnerHtml } from '../../lib/spinner.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
/** Mild map zoom when jumping to a coach mistake. */
const COACH_FOCUS_ZOOM = 2.15;
/** View travel duration (ms). Quick, but ease-out so it does not feel snapped. */
const COACH_FOCUS_MS = 300;

const statsIconSvg =
  '<svg viewBox="0 -960 960 960" width="19" height="19" fill="currentColor" aria-hidden="true">' +
  '<path d="M640-160v-280h120v280H640Zm-220 0v-640h120v640H420Zm-220 0v-440h120v440H200Z"/></svg>';

/** The shipped SVGs are a fixed light grey; let CSS drive the colour instead. */
const icon = (raw) => String(raw).replace(/fill="#[0-9a-fA-F]{3,8}"/g, 'fill="currentColor"');

export function createTimelineViewer({
  store,
  rounds,
  escapeHtml,
  onRound,
  statsDemoId = '',
  coachTeamId = '',
  coachForceSide = 0,
  coachAutoEnable = false,
  /** When set, coach notes are generated for the team but only this player is shown. */
  coachReviewPlayerId = '',
  /** `{ tick, zoom, panX, panY }` from a shared moment link, or null. */
  startAt = null
}) {
  /**
   * True when the viewer was opened from the team's Autocoach page.
   *
   * The ok / x marks belong to that review: they are a team's record of which
   * flagged moments have been accepted and which were dismissed, and the team
   * page tallies them per player. Opening the same demo from the Demo Manager
   * is not that review, so the marks are neither shown nor settable there -
   * a stray red cross on someone else's library round says nothing useful and
   * would land in the team's tally if it could be clicked.
   */
  const teamReview = Boolean(coachTeamId);

  const el = document.createElement('div');
  el.className = 'rv-timeline';
  el.innerHTML = `
    <div class="rv-stage">
      <div class="rv-team-col">
        <aside class="rv-team rv-team-1" data-team="1"></aside>
      </div>
      <div class="rv-map">
        <div class="rv-clock-row" id="rv-clock-row">
          <span class="rv-match-score" id="rv-score-left" data-side="T">0</span>
          <div class="rv-clock" id="rv-clock">00:00</div>
          <span class="rv-match-score" id="rv-score-right" data-side="CT">0</span>
        </div>
        <div class="rv-feed-stack" id="rv-feed-stack">
          <div class="rv-killfeed" id="rv-killfeed" aria-live="polite"></div>
          <div class="rv-duel-feed" id="rv-duel-feed" hidden></div>
        </div>
        <canvas class="rv-canvas" id="rv-canvas"></canvas>
        <div class="rv-loading" id="rv-loading"></div>
      </div>
      <div class="rv-team-col">
        <aside class="rv-team rv-team-2" data-team="2"></aside>
      </div>
    </div>
    <aside class="rv-charts" id="rv-charts" hidden>
      <div class="rv-mapgraph">
        <div class="rv-wingraph-head">
          <span class="rv-wingraph-label ct" id="rv-mapgraph-ct">CT</span>
          <span class="rv-wingraph-label" id="rv-mapgraph-neu">Map control</span>
          <span class="rv-wingraph-label t" id="rv-mapgraph-t">T</span>
        </div>
        <canvas class="rv-wingraph-canvas" id="rv-mapgraph-canvas"></canvas>
        <div class="rv-wingraph-tip" id="rv-mapgraph-tip" hidden></div>
      </div>
      <div class="rv-wingraph" id="rv-wingraph">
        <div class="rv-wingraph-head">
          <span class="rv-wingraph-label ct" id="rv-wingraph-ct">-</span>
          <span class="rv-wingraph-label t" id="rv-wingraph-t">-</span>
        </div>
        <canvas class="rv-wingraph-canvas" id="rv-wingraph-canvas"></canvas>
        <div class="rv-wingraph-tip" id="rv-wingraph-tip" hidden></div>
      </div>
    </aside>
    <aside class="rv-coach-pick" id="rv-coach-pick" hidden>
      <div class="rv-coach-pick-head">
        <span class="rv-coach-pick-title" id="rv-coach-pick-title">Coach which team?</span>
        <button type="button" class="rp-btn-icon" id="rv-coach-pick-close" title="Cancel" aria-label="Cancel">✕</button>
      </div>
      <div id="rv-coach-pick-teams">
        <p class="rv-coach-pick-hint">Mistakes are noted for one side only.</p>
        <button type="button" class="rv-coach-pick-team" data-team="1" id="rv-coach-pick-t1">Team 1</button>
        <button type="button" class="rv-coach-pick-team" data-team="2" id="rv-coach-pick-t2">Team 2</button>
      </div>
      <div id="rv-coach-pick-players" hidden>
        <p class="rv-coach-pick-hint">Watch mistakes for</p>
        <div class="rv-coach-pick-player-list" id="rv-coach-pick-player-list"></div>
        <div class="rv-coach-pick-actions">
          <button type="button" class="btn btn-sm" id="rv-coach-pick-back">Back</button>
          <button type="button" class="btn btn-sm" id="rv-coach-pick-all">All</button>
          <button type="button" class="btn btn-sm primary" id="rv-coach-pick-go">Continue</button>
        </div>
      </div>
    </aside>
    <aside class="rv-note-dock" id="rv-note-panel" hidden>
      <div class="rv-note-head" id="rv-note-head-list" hidden>
        <span class="rv-note-stamp">Notes</span>
        <button type="button" class="rp-btn-icon" id="rv-note-add" title="New note" aria-label="New note">+</button>
        <button type="button" class="rp-btn-icon rv-note-close" id="rv-note-close-list" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="rv-note-list" id="rv-note-list" hidden></div>
      <div class="rv-note-editor" id="rv-note-editor">
        <div class="rv-note-head">
          <button type="button" class="rp-btn-icon" id="rv-note-prev" title="Previous note" aria-label="Previous note">‹</button>
          <span class="rv-note-stamp" id="rv-note-stamp">00:00</span>
          <span class="rv-note-pos" id="rv-note-pos"></span>
          <span class="rv-note-marks" id="rv-note-marks" hidden>
            <button type="button" class="rv-note-mark-btn ok" id="rv-note-mark-ok"
              title="Accept this note" aria-label="Accept this note">✓</button>
            <button type="button" class="rv-note-mark-btn x" id="rv-note-mark-x"
              title="Dismiss this note" aria-label="Dismiss this note">✗</button>
          </span>
          <button type="button" class="rp-btn-icon" id="rv-note-next" title="Next note" aria-label="Next note">›</button>
          <button type="button" class="rp-btn-icon" id="rv-note-add-edit" title="New note" aria-label="New note">+</button>
          <button type="button" class="rp-btn-icon rv-note-close" id="rv-note-close" title="Close" aria-label="Close">✕</button>
        </div>
        <textarea id="rv-note-text" maxlength="${NOTE_MAX}" rows="6"
          placeholder="What happens here?"></textarea>
        <div class="rv-popover-foot">
          <span class="rv-note-count" id="rv-note-count">0 / ${NOTE_MAX}</span>
          <span class="rv-popover-msg" id="rv-note-msg"></span>
        </div>
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
        <button type="button" class="rv-share" id="rv-share"
          title="Copy a link to this moment" aria-label="Copy a link to this moment">
          <svg viewBox="0 -960 960 960" width="16" height="16"><path d="M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z"/></svg>
        </button>
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
          <!-- Starts inactive to match chartOn: the tiers that hold the chart
               outright switch it on below, and syncWinChart lights the button
               when they do. Hardcoding active here left every other tier with
               a lit button and no panel. -->
          <button type="button" class="rv-tool" id="rv-chart" title="Win chance chart">${icon(chartIcon)}</button>
          <button type="button" class="rv-tool" id="rv-coach" title="Coach: mistake notes for one team" ${
            statsDemoId ? '' : 'hidden'
          }>${icon(coachIcon)}</button>
          <button type="button" class="rv-tool" id="rv-rosters"
            title="Player sidebars">${icon(rosterIcon)}</button>
          <button type="button" class="rv-tool" id="rv-zones"
            title="Map positions: active / controlled / contested">${icon(zonesIcon)}</button>
          <button type="button" class="rv-tool" id="rv-duels"
            title="Duel stats: xK beside fighters; hover a player or line for win %">${icon(duelsIcon)}</button>
          <button type="button" class="rv-tool" id="rv-pov"
            title="Team POV: one team's map control and only the enemies they can see">${icon(povIcon)}</button>
          <button type="button" class="rv-tool" id="rv-draw" title="Draw (right click always draws)">${icon(pencilIcon)}</button>
          <button type="button" class="rv-tool" id="rv-note" title="Notes">${icon(commentsIcon)}</button>
          <button type="button" class="rv-tool" id="rv-bookmark" title="Save to a playlist">${icon(bookmarkAddIcon)}</button>
        </div>
      </div>
      <div class="rv-popover" id="rv-playlist-panel" hidden>
        <div class="rv-playlist-list" id="rv-playlist-list"></div>
        <div class="rv-popover-foot">
          <input type="text" id="rv-playlist-new" class="site-input" maxlength="60" placeholder="New playlist" />
          <select class="site-select rv-playlist-scope" id="rv-playlist-scope" title="Who can see this playlist">
            <option value="private">Private</option>
            <option value="team">Team</option>
          </select>
          <button type="button" class="btn btn-sm primary" id="rv-playlist-add">Create</button>
        </div>
        <span class="rv-popover-msg" id="rv-playlist-msg"></span>
      </div>
    </div>`;

  const canvas = el.querySelector('#rv-canvas');
  const mapEl = el.querySelector('.rv-map');
  const clockEl = el.querySelector('#rv-clock');
  const scoreLeftEl = el.querySelector('#rv-score-left');
  const scoreRightEl = el.querySelector('#rv-score-right');
  const killfeedEl = el.querySelector('#rv-killfeed');
  const duelFeedEl = el.querySelector('#rv-duel-feed');
  const loadingEl = el.querySelector('#rv-loading');
  const roundsEl = el.querySelector('#rv-rounds');
  const scrubEl = el.querySelector('#rv-scrub');
  const fillEl = el.querySelector('#rv-scrub-fill');
  const phasesEl = el.querySelector('#rv-scrub-phases');
  const marksEl = el.querySelector('#rv-scrub-marks');
  const handleEl = el.querySelector('#rv-scrub-handle');
  const timeEl = el.querySelector('#rv-time');
  const shareBtn = el.querySelector('#rv-share');
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
  const noteListHead = el.querySelector('#rv-note-head-list');
  const noteListEl = el.querySelector('#rv-note-list');
  const noteEditorEl = el.querySelector('#rv-note-editor');
  const noteText = el.querySelector('#rv-note-text');
  const noteCount = el.querySelector('#rv-note-count');
  const noteMsg = el.querySelector('#rv-note-msg');
  const noteStampEl = el.querySelector('#rv-note-stamp');
  const notePosEl = el.querySelector('#rv-note-pos');
  const notePrevBtn = el.querySelector('#rv-note-prev');
  const noteNextBtn = el.querySelector('#rv-note-next');
  const noteMarksEl = el.querySelector('#rv-note-marks');
  const noteMarkOkBtn = el.querySelector('#rv-note-mark-ok');
  const noteMarkXBtn = el.querySelector('#rv-note-mark-x');
  const noteAddBtn = el.querySelector('#rv-note-add');
  const noteAddEditBtn = el.querySelector('#rv-note-add-edit');
  const chartBtn = el.querySelector('#rv-chart');
  const zonesBtn = el.querySelector('#rv-zones');
  const duelsBtn = el.querySelector('#rv-duels');
  const povBtn = el.querySelector('#rv-pov');
  const coachBtn = el.querySelector('#rv-coach');
  const rostersBtn = el.querySelector('#rv-rosters');
  const coachPick = el.querySelector('#rv-coach-pick');
  const coachPickTitle = el.querySelector('#rv-coach-pick-title');
  const coachPickTeams = el.querySelector('#rv-coach-pick-teams');
  const coachPickPlayers = el.querySelector('#rv-coach-pick-players');
  const coachPickPlayerList = el.querySelector('#rv-coach-pick-player-list');
  const coachPickT1 = el.querySelector('#rv-coach-pick-t1');
  const coachPickT2 = el.querySelector('#rv-coach-pick-t2');
  const coachPickBack = el.querySelector('#rv-coach-pick-back');
  const coachPickAll = el.querySelector('#rv-coach-pick-all');
  const coachPickGo = el.querySelector('#rv-coach-pick-go');
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
  /** file -> resolved meta, so selectRound can tell resident rounds apart. */
  const metaReady = new Map();
  const files = rounds.map((r) => r.file);

  let sequence = new RoundSequence(rounds.map(() => ({})));
  let activeIndex = -1;
  let activeMeta = null;
  let speedIndex = 2;
  let destroyed = false;
  /** Last rendered kill-feed signature (skip DOM work when unchanged). */
  let killFeedKey = '';
  /** Last rendered live-duel feed signature. */
  let duelFeedKey = '';
  /** @type {{ id: string, tick: number, text: string, updatedAt: number }[]} */
  let roundNotes = [];
  /** Index into roundNotes for the dock (one note visible at a time). */
  let noteIndex = 0;
  /** 'list' shows every note; 'editor' shows one note's text. */
  let noteView = 'editor';
  /**
   * Win% graph + side badges (independent of coach notes).
   *
   * This is the round win prediction, which the pricing matrix puts on Team
   * Premium and up. It used to be on by default for everyone. It now starts off
   * and is switched on automatically only for tiers that hold it outright;
   * metered tiers spend a use when they turn it on.
   */
  let chartOn = false;
  /**
   * Narrow layout: the rosters move under the map and the docked panels span
   * the width, so anything that opens on its own would land on top of the
   * rosters. Matches the breakpoint the stacked layout uses in replays.css.
   */
  const stackedQuery = window.matchMedia('(max-width: 860px)');
  let coachOn = false;
  /**
   * Under-map player sidebars on the stacked (phone) layout. On by default;
   * coach flips this off so the radar can fill, and the roster tool toggles it.
   */
  let rostersOn = true;
  /** Position overlay on the radar (control / contested). */
  let zonesOn = false;
  /** Duel network on the radar: xK beside fighters, win % on hover. */
  let duelsOn = false;
  let spentDuelStats = false;
  const duelOverlay = createDuelOverlay();
  /**
   * Feeds the win chart, not the radar: the round win chance has to know about
   * the fights that are open whether or not the Duels tool is switched on, so
   * it keeps its own trackers on its own cadence.
   */
  const winDuelScanner = createDuelScanner();
  /** @type {{aSlot:number,bSlot:number}|null} */
  let duelHover = null;
  /** Projected duel geometry in CSS pixels, rebuilt each paint for hit tests. */
  let duelHitLines = [];
  /**
   * Daily allowances are spent once per opened viewer, not once per toggle.
   * Otherwise turning an overlay off and on again would bill twice for what
   * the user experiences as one sitting with one demo.
   */
  let spentCoach = false;
  let spentMapControl = false;
  let spentRoundWin = false;
  /** @type {object | null} */
  let zoneNetwork = null;
  let zoneNetworkMap = '';
  /** @type {{ map: string, smokes: Array }|null} */
  let coachSmokesArchive = null;
  let coachSmokesMap = '';

  /** Bake vision / segments for the radar floor currently on screen (Nuke). */
  function prepareZones(network, mapCode, radarImage = renderer.image) {
    prepareControlField(network, mapCode, radarImage, renderer.radarLevel || 'default');
  }
  /** file -> presence { firstT, firstCT } */
  const zonePresenceCache = new Map();
  let zonePresence = null;
  /** Round-robin per-player LOS cache (one viewer recomputed per paint). */
  const zoneVisionCache = createZoneVisionCache();
  let zoneLoadId = 0;
  /**
   * Roster team (1|2) the viewer is restricted to, or 0 for the omniscient
   * default. Held as a team rather than a side because sides swap at half and
   * the choice is meant to follow the team across the whole demo.
   */
  let povTeam = 0;
  /** Side the eye tool is following across halves ('T'|'CT'|''). */
  let povFollowSide = '';
  const povVision = createPovVision();
  /** Roster team (1|2) whose mistakes coach notes; null until picked. */
  let coachTeam = null;
  /** Player ids whose coach notes are shown; null = no filter yet. */
  let coachFocusPlayers = null;
  /** Team chosen in the pick UI before Continue. */
  let pendingCoachTeam = null;
  /** True when the team step is skipped (already analyzed / forced side). */
  let coachPickTeamLocked = false;
  /** Team-picker dock is open; coach not enabled yet. */
  let coachPicking = false;
  /** Active view pan/zoom animation frame id. */
  let viewAnimRaf = 0;
  /** Round files that currently carry at least one coach note. */
  const coachNotedFiles = new Set();
  /** Bumps when a full-demo coach pass is superseded (toggle off / re-pick). */
  let coachPassId = 0;
  /**
   * True while the initial full-match load+analyse is running. Round clicks
   * must not trigger per-round coaching until this finishes — that was the
   * "click round 6, then coach speaks" bug.
   */
  let coachScanning = false;
  /**
   * Coach needs the whole unspliced match (same signal as the live scoreboard).
   * Pick-and-choose / playlist / deep-link subsets leave this empty.
   */
  const coachAvailable = Boolean(statsDemoId);
  const states = [];

  const playback = new Playback((pos) => onPosition(pos));

  async function metaFor(file) {
    if (metaCache.has(file)) return metaCache.get(file);
    const p = fetchRoundMeta(file)
      .catch(() => null)
      .then((meta) => {
        if (meta) metaReady.set(file, meta);
        return meta;
      });
    metaCache.set(file, p);
    return p;
  }

  /**
   * A round's meta if it is already in hand, without awaiting.
   *
   * selectRound uses this to tell "everything for this round is resident" from
   * "some of it has to be fetched". The distinction is what lets a switch
   * between two rounds already loaded happen in one pass instead of painting
   * once from the summary and again from the real meta a microtask later.
   */
  function peekMeta(file) {
    return metaReady.get(file) || null;
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
        const noted = coachOn && coachNotedFiles.has(r.file);
        const coachClass = noted ? ' has-coach' : '';
        const gap =
          i === 0 ? 0 : gapAfterRound(rounds[i - 1].round) * ROUND_GAP_PX;
        const margin = gap ? ` style="margin-left:${gap}px"` : '';
        const coachHint = noted ? ' · coach notes' : '';
        return `<button type="button" class="rv-round ${sideClass}${coachClass}" data-index="${i}"${margin} title="${escapeHtml(
          `Round ${r.round} · ${side} win · ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}${coachHint}`
        )}">${String(r.round).padStart(2, '0')}</button>`;
      })
      .join('');
    markActiveRound();
  }

  function syncCoachRoundChips() {
    roundsEl.querySelectorAll('.rv-round').forEach((b) => {
      const file = files[Number(b.dataset.index)];
      // Coach off means the notes are hidden, so the chips must not advertise
      // rounds the user cannot open anything on.
      const on = coachOn && coachNotedFiles.has(file);
      b.classList.toggle('has-coach', on);
      if (!file || !rounds[Number(b.dataset.index)]) return;
      const r = rounds[Number(b.dataset.index)];
      const side = winningSide(r);
      const coachHint = on ? ' · coach notes' : '';
      b.title = `Round ${r.round} · ${side} win · ${economyLabel(r.econ1)} vs ${economyLabel(r.econ2)}${coachHint}`;
    });
  }

  /** Normalize + expand focus ids (same display name on the roster shares focus). */
  function focusPlayerIdSet() {
    if (!coachFocusPlayers || !coachFocusPlayers.size) return null;
    const set = new Set([...coachFocusPlayers].map((id) => String(id || '')).filter(Boolean));
    if (!set.size) return null;
    const roster = activeMeta?.players || [];
    const names = new Set();
    for (const p of roster) {
      if (set.has(String(p.id || '')) && p.name) names.add(String(p.name));
    }
    if (names.size) {
      for (const p of roster) {
        if (p.id && names.has(String(p.name || ''))) set.add(String(p.id));
      }
    }
    return set;
  }

  /** Keep single-player Autocoach review pinned to that player. */
  function ensureReviewFocus() {
    const id = String(coachReviewPlayerId || '');
    if (!id) return;
    coachFocusPlayers = new Set([id]);
  }

  /** Coach notes that count for the green round chip under the current player filter. */
  function coachNoteVisibleOnChip(n) {
    if (!n || n.kind !== 'coach' || !String(n.text || '').trim()) return false;
    return noteInCoachFocus(n);
  }

  function setCoachNoted(file, notes) {
    if (!file) return;
    const has = (notes || []).some(coachNoteVisibleOnChip);
    if (has) coachNotedFiles.add(file);
    else coachNotedFiles.delete(file);
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
    // Marks are the team review's record; outside it a note is just a note.
    const markClassFor = (n, coach) => {
      if (!teamReview || !coach) return '';
      return n.mark === 'ok' ? ' mark-ok' : n.mark === 'x' ? ' mark-x' : '';
    };
    for (const n of noteList) {
      if (n.tick == null) continue;
      if (!noteInCoachFocus(n)) continue;
      const label = noteClockLabel(n.tick);
      // Coach notes get the green diamond so they read apart from the round
      // marks around them at a glance.
      const coach = n.kind === 'coach';
      const markCls = markClassFor(n, coach);
      parts.push(
        `<span class="rv-mark ${coach ? 'coach' : 'note'}${markCls}" data-note="${escapeHtml(
          n.id
        )}" style="left:${at(n.tick) * 100}%" title="${
          coach ? 'Coach' : 'Note'
        } · ${escapeHtml(label)}"></span>`
      );
    }
    marksEl.innerHTML = parts.join('');
  }

  let scrubbing = false;
  /** Round index locked for the active drag — scrub never crosses rounds mid-drag. */
  let scrubRoundIndex = -1;
  /** Transport was running when the drag started, so it can be put back. */
  let scrubResume = false;
  /**
   * Whether entering freezetime should still skip forward to the live tick.
   *
   * On by default — playing into a round is meant to land on the first live
   * moment rather than sit through the buy. A drag that deliberately lands in
   * freezetime disarms it for that round, otherwise the frame right after the
   * release would pull the position straight back out from under the user.
   */
  let freezeSkip = true;

  /** Last instant that still belongs to this round (not the next round's t=0). */
  function roundLocalMax(item) {
    if (!item) return 0;
    const tick = 1 / Math.max(1, item.timing?.tickRate || 64);
    return Math.max(0, item.seconds - tick);
  }

  const seekFromEvent = (e) => {
    const index = scrubbing && scrubRoundIndex >= 0 ? scrubRoundIndex : activeIndex;
    const item = sequence.at(index);
    if (!item) return;
    const rect = scrubEl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // Cap below the round boundary so locate() does not flip to the next round
    // while the pointer sits on the right edge (that used to cascade every move).
    const local = Math.min(roundLocalMax(item), f * item.seconds);
    // Landing in the buy means the user wants the buy, so stop skipping it.
    const timing = item.timing;
    const freezeSecs = Math.max(
      0,
      (timing.freezeEndTick - timing.startTick) / timing.tickRate
    );
    if (local < freezeSecs) freezeSkip = false;
    playback.seek(sequence.offsetOf(index) + local);
  };
  /** End a drag: put the transport back the way it was found. */
  const endScrub = () => {
    scrubbing = false;
    scrubRoundIndex = -1;
    if (scrubResume) {
      scrubResume = false;
      playback.play();
    }
  };
  scrubEl.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    scrubRoundIndex = activeIndex;
    // The transport is held for the drag. Without this the wall clock keeps
    // pushing the position forward between pointer moves, and a backwards drag
    // is a tug of war against it that the pointer loses.
    scrubResume = playback.playing;
    if (scrubResume) playback.pause();
    scrubEl.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  scrubEl.addEventListener('pointermove', (e) => {
    if (scrubbing) seekFromEvent(e);
  });
  scrubEl.addEventListener('pointerup', (e) => {
    const from = scrubRoundIndex;
    endScrub();
    try {
      scrubEl.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // Released at the end of a round → enter the next at its start (once).
    const item = sequence.at(from);
    if (!item || from < 0) return;
    const loc = sequence.locate(playback.position);
    if (loc.index !== from) return;
    if (loc.local < roundLocalMax(item) - 1e-6) return;
    if (from + 1 < files.length) selectRound(from + 1, { seek: true });
  });
  scrubEl.addEventListener('pointercancel', endScrub);

  // ---- round selection ----------------------------------------------------

  /** Rounds already counted this session, so a re-entry is not a second view. */
  const viewedFiles = new Set();

  /**
   * Report one round open.
   *
   * Counted per round rather than per demo: watching six rounds of a match is
   * six looks at it. Counted once per round per open viewer, so bouncing
   * between two rounds does not inflate the number.
   */
  function countRoundView(file) {
    // Home's Continue card reads this. Written for every round, counted once.
    if (file) {
      rememberRound({
        file,
        demoId: statsDemoId || '',
        map: rounds[activeIndex]?.map || '',
        title: `${rounds[activeIndex]?.team1 || 'Team 1'} vs ${
          rounds[activeIndex]?.team2 || 'Team 2'
        }`
      });
    }
    if (!statsDemoId || !file || viewedFiles.has(file)) return;
    viewedFiles.add(file);
    void countDemoView(statsDemoId);
  }

  async function selectRound(index, { seek = true } = {}) {
    if (index < 0 || index >= files.length) return;
    if (index === activeIndex && store.get(files[index])?.isFull) {
      if (seek) {
        if (coachOn) {
          if (!coachScanning) {
            await mergeCoachNotesFor(index);
            renderActiveMarks();
            syncCoachRoundChips();
          }
          enterCoachRoundMoment();
        } else {
          seekRoundEntry(index);
        }
        draw();
      }
      return;
    }

    const file = files[index];
    // A round whose meta AND ticks are both already in hand needs no waterfall:
    // the whole switch runs in one pass below. Without this the provisional
    // paint from fallbackMeta and the real one from meta a microtask later BOTH
    // run, which is two scoreboard rebuilds, two marks rebuilds and two canvas
    // draws on every visit to a round that was already loaded.
    const resident = store.get(file)?.isFull ? peekMeta(file) : null;

    activeIndex = index;
    // A new round arms the buy skip again — it is only ever disarmed for the
    // round the user dragged into.
    freezeSkip = true;
    countRoundView(file);
    drawing.setRound(file);
    onRound?.(rounds[index]);
    syncBookmark();
    renderer._prevHealth?.fill?.(-1);
    renderer._damageTick?.fill?.(-1);
    killFeedKey = '';
    duelFeedKey = '';
    if (killfeedEl) killfeedEl.innerHTML = '';
    if (duelFeedEl) {
      duelFeedEl.innerHTML = '';
      duelFeedEl.hidden = true;
    }
    // Drop previous-round presence immediately so the first draw after a skip
    // cannot soft-paint with another round's visit log.
    zonePresence = null;
    resetZoneVisionCache(zoneVisionCache);
    // Same class of sticky-cache bug as zone vision: a holding draw with
    // fallbackMeta can poison per-round duel windows under this file key.
    if (duelsOn) duelOverlay.reset();
    notePanel.hidden = true;
    noteBtn.classList.remove('active');
    if (coachPicking) hideCoachPick();
    // Pause early in coach mode so freezetime auto-skip can't race the seek.
    if (coachOn && seek) {
      playback.pause();
      syncPlayButton();
    }

    // Chrome from the real meta when it is resident, from the summary when it
    // is not. Coach still waits for the full pair — analysing earlier caches a
    // series built from the previous round's meta against this round's track.
    activeMeta = resident || fallbackMeta(rounds[index]);
    if (resident) adoptRoundMeta(index, resident);
    else markActiveRound();
    realignPovToFollowSide();
    renderScoreboards();
    loadNotesFromMeta(true);
    renderActiveMarks();
    if (!boardEl.hidden) renderScoreboard();
    if (resident && !coachOn) autoOpenNotesIfPresent();

    if (seek) playback.seek(liveOffsetOf(index), { emit: false });
    syncLoading();
    clearPlayerStates();
    if (chartOn) {
      chartsEl.hidden = false;
      syncSideWinrates(null);
    }
    // Only the not-yet-resident path needs a holding frame; the resident path
    // draws once at the end with everything already correct.
    if (!resident) draw();

    // Re-aim the background prefetch at where the user now is.
    store.warm(files, index);

    if (resident) {
      // Map is per-selection and normally already loaded, but a mixed-map
      // selection must not draw this round onto the previous round's radar.
      const want = rounds[index].map || activeMeta.map;
      if (want && renderer.mapCode !== want) {
        await renderer.setMap(want);
        if (destroyed || activeIndex !== index) return;
      }
    } else {
      const mapCode = rounds[index].map || activeMeta.map;
      const [meta] = await Promise.all([
        metaFor(file),
        store.loadFull(file),
        mapCode ? renderer.setMap(mapCode) : Promise.resolve()
      ]);
      if (destroyed || activeIndex !== index) return;

      if (meta) {
        activeMeta = meta;
        // The holding draw may have built a control sim from fallbackMeta (often
        // with empty players). That sim key can match the full meta's
        // ticks/sides, so soft control would stay empty until the zone overlay
        // is toggled. Drop it.
        resetZoneVisionCache(zoneVisionCache);
        // Same for duel fight windows cached under this round key.
        if (duelsOn) duelOverlay.reset();
        adoptRoundMeta(index, meta);
        realignPovToFollowSide();
        renderScoreboards();
        loadNotesFromMeta(true);
        renderActiveMarks();
        if (!coachOn) autoOpenNotesIfPresent();
      }
    }

    // Zones / chart / duels all need the map network; duels also need a clean
    // overlay pass once real meta is in place (flag stays on across rounds).
    if (zonesOn || chartOn) await refreshZonePresence();
    else if (duelsOn) await ensureZoneNetwork();
    if (chartOn) {
      mapControlCache.delete(file);
      coachCache.delete(file);
      syncWinChart();
    }
    if (coachOn) {
      // During the initial full-match scan, do not analyse on click — wait for
      // the preload→analyse pass to finish so every round is covered once.
      if (!coachScanning) {
        await mergeCoachNotesFor(index);
        renderActiveMarks();
        syncCoachRoundChips();
      } else {
        loadNotesFromMeta(true);
        renderActiveMarks();
        syncCoachRoundChips();
      }
      if (seek) enterCoachRoundMoment();
    } else if (seek) {
      seekRoundEntry(index);
    }
    draw();
    // Last, so nothing above can seek back over the moment the link asked for.
    applyStartAt();
  }

  /**
   * Fold a round's real meta into the strip and the timeline.
   *
   * Shared by both halves of selectRound so a resident round and a freshly
   * fetched one end up in exactly the same state.
   */
  function adoptRoundMeta(index, meta) {
    const sideChanged =
      (meta.winnerSide && meta.winnerSide !== rounds[index].winnerSide) ||
      (meta.team1Side && meta.team1Side !== rounds[index].team1Side);
    if (meta.winnerSide) rounds[index].winnerSide = meta.winnerSide;
    if (meta.team1Side) rounds[index].team1Side = meta.team1Side;
    if (meta.team2Side) rounds[index].team2Side = meta.team2Side;
    if (meta.winner === 1 || meta.winner === 2) rounds[index].winner = meta.winner;
    if (meta.freezeEndTick != null || meta.tickRate) syncSequenceTiming(index, meta);
    if (sideChanged) renderRoundStrip();
    else markActiveRound();
  }

  /**
   * Patch one round's timing into the sequence without refetching the others.
   *
   * Skipped when this round's timing is already what the sequence holds, which
   * is the case for every round visited a second time: rebuilding it there cost
   * a fresh RoundSequence over the whole match plus a re-seek, to arrive at
   * exactly the offsets already in place.
   */
  function syncSequenceTiming(index, meta) {
    const merged = { ...fallbackMeta(rounds[index]), ...meta };
    const held = sequence.at(index)?.round;
    if (held && sameTiming(timingFor(held), timingFor(merged))) return;
    const pos = playback.position;
    const list = rounds.map((r, i) =>
      i === index ? merged : sequence.at(i)?.round || fallbackMeta(r)
    );
    sequence = new RoundSequence(list);
    playback.setDuration(sequence.duration);
    playback.seek(Math.min(pos, playback.duration), { emit: false });
  }

  const sameTiming = (a, b) =>
    a.tickRate === b.tickRate &&
    a.startTick === b.startTick &&
    a.freezeEndTick === b.freezeEndTick &&
    a.plantTick === b.plantTick &&
    a.endTick === b.endTick &&
    a.officialEndTick === b.officialEndTick;

  function syncZonesBtn() {
    zonesBtn?.classList.toggle('active', zonesOn);
  }

  function syncDuelsBtn() {
    duelsBtn?.classList.toggle('active', duelsOn);
  }

  /**
   * The duel network for this tick, or null when the tool is off or the map
   * geometry it needs has not loaded.
   *
   * Also rebuilds the hit-test geometry in CSS pixels, because that is only
   * knowable once the view transform for this frame is known, and doing it here
   * means hovering never has to project anything itself.
   */
  function duelOverlayForTick(tick, pov = null) {
    duelHitLines = [];
    if (!duelsOn || !zoneNetwork || !activeMeta?.players?.length) return null;
    const mapCode = renderer.mapCode || activeMeta.map || '';
    prepareZones(zoneNetwork, mapCode);
    if (!hasControlField(zoneNetwork)) return null;
    const file = files[activeIndex];
    const entry = store.get(file);
    // Coarse tick data interpolates over a second and a half, which makes
    // movement speed and view angles meaningless. Better to draw nothing than
    // to draw confident numbers derived from them.
    if (!entry?.isFull) return null;
    const track = entry.full;
    if (!track) return null;

    const overlay = duelOverlay.compute({
      meta: activeMeta,
      track,
      tick,
      network: zoneNetwork,
      mapCode,
      roundKey: file,
      hover: duelHover,
      radarLevel: renderer.radarLevel || 'default'
    });
    if (!overlay) return null;
    // Team POV: a pair line to an enemy nobody can see is the position the
    // droplet was withheld to protect. Filtered here rather than at the
    // renderer so the hit test below inherits it and hovering cannot get it
    // back either.
    const shown = pov ? povDuelOverlay(overlay, pov.side, pov.seen) : overlay;

    const { w, h } = renderer.resize();
    const t = renderer.viewTransform(w, h);
    const toCss = (wx, wy) => {
      const p = renderer.project(t, wx, wy, {});
      return { x: p.x / renderer.dpr, y: p.y / renderer.dpr };
    };
    for (const line of shown.lines) {
      const a = toCss(line.ax, line.ay);
      const b = toCss(line.bx, line.by);
      duelHitLines.push({ aSlot: line.aSlot, bSlot: line.bSlot, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
    return shown;
  }

  /** Distance from a point to a segment, in the same units as both. */
  function distToSegment(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
  }

  /**
   * Which duel the cursor is on, if any.
   *
   * A pair is hit either by its line or by sitting on one of its two players,
   * which is what makes "hover a player" work without a separate player hit
   * test: a player's own position is the endpoint of every line they are in,
   * and the nearest of those wins.
   */
  function duelAt(clientX, clientY) {
    if (!duelHitLines.length) return null;
    const rect = mapEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = null;
    // Droplets are larger than a line stroke; give endpoints more reach so
    // "hover the player" reliably picks a fight without needing the line.
    let bestDist = 14;
    for (const line of duelHitLines) {
      const dLine = distToSegment(px, py, line.ax, line.ay, line.bx, line.by);
      const dA = Math.hypot(px - line.ax, py - line.ay);
      const dB = Math.hypot(px - line.bx, py - line.by);
      const d = Math.min(dLine, dA, dB);
      if (d < bestDist) {
        bestDist = d;
        best = line;
      }
    }
    return best ? { aSlot: best.aSlot, bSlot: best.bSlot } : null;
  }

  /** Load map positions (shared zone network) when the overlay is on. */
  async function ensureZoneNetwork() {
    const map = activeMeta?.map || rounds[activeIndex]?.map || '';
    if (!map) {
      zoneNetwork = null;
      zoneNetworkMap = '';
      coachSmokesArchive = null;
      coachSmokesMap = '';
      return null;
    }
    if (zoneNetwork && zoneNetworkMap === map) {
      if (coachSmokesMap !== map) await ensureCoachSmokes(map);
      return zoneNetwork;
    }
    const load = ++zoneLoadId;
    try {
      const [net] = await Promise.all([fetchZones(map), ensureCoachSmokes(map)]);
      if (destroyed || load !== zoneLoadId) return zoneNetwork;
      zoneNetwork = net;
      zoneNetworkMap = map;
      zonePresenceCache.clear();
      mapControlCache.clear();
      // Win% series may have been built without map-control; rebuild with it.
      coachCache.clear();
      return zoneNetwork;
    } catch {
      if (load === zoneLoadId) {
        // Still allow dynamic map control with an empty slim network.
        zoneNetwork = {
          map,
          visionBlocks: [],
          elevated: [],
          underpasses: [],
          ledges: [],
          bombSites: { a: [], b: [] },
          keyZones: { a: [], b: [] },
          updatedAt: 0
        };
        zoneNetworkMap = map;
        await ensureCoachSmokes(map);
      }
      return zoneNetwork;
    }
  }

  async function ensureCoachSmokes(map) {
    const code = String(map || '').toUpperCase();
    if (!code) {
      coachSmokesArchive = null;
      coachSmokesMap = '';
      return null;
    }
    if (coachSmokesArchive && coachSmokesMap === code) return coachSmokesArchive;
    try {
      coachSmokesArchive = await loadCoachSmokes(code);
      coachSmokesMap = code;
    } catch {
      coachSmokesArchive = { map: code, smokes: [] };
      coachSmokesMap = code;
    }
    return coachSmokesArchive;
  }

  /** Recompute first-visit ticks for the active round (cached once the round is full). */
  async function refreshZonePresence() {
    zonePresence = null;
    // Needed for the positions overlay and for map-control win% (chart / coach).
    if (!zonesOn && !chartOn) return;
    const net = await ensureZoneNetwork();
    if (!net || !activeMeta) return;
    const mapCode = renderer.mapCode || activeMeta.map || '';
    prepareZones(net, mapCode);
    if (!hasControlField(net)) return;
    const file = files[activeIndex];
    const entry = store.get(file);
    if (entry?.isFull && zonePresenceCache.has(file)) {
      zonePresence = zonePresenceCache.get(file);
      return;
    }
    const track = entry?.full || store.track(file);
    if (!track) return;
    const presence = buildZonePresence({
      meta: activeMeta,
      track,
      network: net,
      mapCode,
      radarImage: renderer.image
    });
    if (!presence) return;
    zonePresence = presence;
    // Only cache full-resolution presence so a coarse pass is not sticky.
    if (entry?.isFull) zonePresenceCache.set(file, presence);
  }

  function zoneOverlayForTick(tick) {
    if (!zonesOn || !zoneNetwork) return null;
    const mapCode = renderer.mapCode || activeMeta?.map || '';
    prepareZones(zoneNetwork, mapCode);
    if (!hasControlField(zoneNetwork)) return null;
    const file = files[activeIndex];
    const track = store.get(file)?.full || store.track(file) || null;
    const paint = computeZonePaint({
      meta: activeMeta,
      states,
      network: zoneNetwork,
      tick,
      presence: zonePresence,
      mapCode,
      radarImage: renderer.image,
      grenades: activeMeta.events?.grenades || [],
      visionCache: zoneVisionCache,
      track,
      level: renderer.radarLevel || 'default'
    });
    // Under POV, possession is only ever the chosen team's own. Ground the
    // other side is taking is not something this team can see happening.
    const side = povSideNow();
    return { network: zoneNetwork, paint: side ? povZonePaint(paint, side) : paint };
  }

  // ---- team POV -----------------------------------------------------------

  /** The chosen team's side in the active round, or '' when POV is off. */
  function povSideNow() {
    if (!povTeam || !activeMeta) return '';
    const side = povTeam === 1 ? activeMeta.team1Side : activeMeta.team2Side;
    return side === 'T' || side === 'CT' ? side : '';
  }

  /** The name of the team POV is following, for the button's tooltip. */
  function povTeamName() {
    if (!povTeam) return '';
    const info = povTeam === 1 ? activeMeta?.team1 : activeMeta?.team2;
    return info?.name || `Team ${povTeam}`;
  }

  /**
   * Enemy slots the chosen team can see right now, or null when POV is off.
   *
   * Needs the zone network for line of sight. Without it every line is clear,
   * which is a worse answer than none but not a wrong one: the field of view
   * and range tests still apply, and the network is normally in hand by the
   * time the first frame with a POV team is drawn.
   */
  function povFrameFor(tick) {
    const side = povSideNow();
    if (!side) return null;
    return {
      side,
      seen: povVision.seenAt({
        meta: activeMeta,
        states,
        network: zoneNetwork,
        mapCode: renderer.mapCode || activeMeta?.map || '',
        tick,
        tickRate: activeMeta?.tickRate || 64,
        povSide: side,
        roundKey: files[activeIndex] || ''
      })
    };
  }

  /** Team number (1|2) playing `side` this round, or 0 if unknown. */
  function teamForSide(side) {
    if (!activeMeta || (side !== 'T' && side !== 'CT')) return 0;
    if (activeMeta.team1Side === side) return 1;
    if (activeMeta.team2Side === side) return 2;
    return 0;
  }

  /**
   * Keep the eye on the same side through halftime. When T↔CT swap, the
   * selected team flips so yellow stays T and blue stays CT.
   */
  function realignPovToFollowSide() {
    if (!povFollowSide) return;
    const next = teamForSide(povFollowSide);
    if (!next) return;
    if (next !== povTeam) {
      povTeam = next;
      povVision.reset();
    }
    syncPovBtn();
  }

  function syncPovBtn() {
    if (!povBtn) return;
    const side = povSideNow();
    povBtn.classList.toggle('active', Boolean(povTeam));
    povBtn.classList.toggle('pov-t', side === 'T');
    povBtn.classList.toggle('pov-ct', side === 'CT');
    povBtn.title = povTeam
      ? `Team POV: ${povTeamName()} (${side}). Click for the other team, again to turn it off.`
      : 'Team POV: one team’s map control and only the enemies they can see';
  }

  /** Stacked (phone) layout: sidebars optional; when off the map fills. */
  function syncRostersLayout() {
    const stacked = stackedQuery.matches;
    if (rostersBtn) {
      // Always available on the under-map roster layout, not only while coach runs.
      rostersBtn.hidden = !stacked;
      rostersBtn.classList.toggle('active', stacked && rostersOn);
      rostersBtn.title = rostersOn
        ? 'Hide player sidebars (map fills the screen)'
        : 'Show player sidebars';
    }
    const hideRosters = stacked && !rostersOn;
    el.classList.toggle('rosters-hidden', hideRosters);
    // Force the columns off in the DOM too: display:flex on .rv-team-col
    // outranks the UA [hidden] rule without an explicit [hidden] override.
    for (const col of el.querySelectorAll('.rv-team-col')) {
      col.hidden = hideRosters;
    }
    syncChromeInset();
    if (!destroyed) draw();
  }

  function clearPlayerStates() {
    for (let i = 0; i < 10; i++) states[i] = null;
  }

  // ---- scoreboards --------------------------------------------------------

  /**
   * Scoreboard rows by slot, rebuilt whenever the panels are.
   *
   * syncScoreboard runs on every frame and used to reach for each row and its
   * three children with el.querySelector, which is ~40 tree walks a frame for
   * nodes that only change when renderScoreboards replaces the markup.
   *
   * @type {Map<number, {root: HTMLElement, hp: HTMLElement|null, inv: HTMLElement|null}>}
   */
  const playerRows = new Map();

  function indexPlayerRows() {
    playerRows.clear();
    for (const root of el.querySelectorAll('.rv-player')) {
      const slot = Number(root.dataset.slot);
      if (!Number.isFinite(slot)) continue;
      playerRows.set(slot, {
        root,
        hp: root.querySelector('.rv-player-hp'),
        inv: root.querySelector('.rv-player-inv')
      });
    }
  }

  function renderScoreboards() {
    if (!activeMeta) return;
    const t1 = activeMeta.team1 || { name: 'Team 1' };
    const t2 = activeMeta.team2 || { name: 'Team 2' };
    const wins = countWins();
    // Panels follow live sides when known (T left / CT right like most 2D viewers).
    const s1 = activeMeta.team1Side;
    const s2 = activeMeta.team2Side;
    let leftScore;
    let rightScore;
    let leftSide;
    let rightSide;
    // Which roster team each panel ended up holding, so POV can hide the other
    // one. The panels swap with the sides, so the markup's data-team is not it.
    let leftTeam;
    let rightTeam;
    if (s1 === 'CT' && s2 === 'T') {
      team1El.innerHTML = teamHtml(2, t2, 'T');
      team2El.innerHTML = teamHtml(1, t1, 'CT');
      leftScore = wins.team2;
      rightScore = wins.team1;
      leftSide = 'T';
      rightSide = 'CT';
      leftTeam = 2;
      rightTeam = 1;
    } else {
      team1El.innerHTML = teamHtml(1, t1, s1 || 'T');
      team2El.innerHTML = teamHtml(2, t2, s2 || 'CT');
      leftScore = wins.team1;
      rightScore = wins.team2;
      leftSide = s1 || 'T';
      rightSide = s2 || 'CT';
      leftTeam = 1;
      rightTeam = 2;
    }
    scoreLeftEl.textContent = String(leftScore);
    scoreRightEl.textContent = String(rightScore);
    scoreLeftEl.dataset.side = leftSide;
    scoreRightEl.dataset.side = rightSide;
    // Team POV: one roster on the sidebar. The other side's HP, buy and
    // inventory are exactly the information the mode exists to withhold, so the
    // panel is emptied rather than hidden and syncScoreboard stops feeding it.
    // The grid column stays where it is: the map should not resize on a toggle.
    const hideLeft = Boolean(povTeam) && leftTeam !== povTeam;
    const hideRight = Boolean(povTeam) && rightTeam !== povTeam;
    if (hideLeft) team1El.innerHTML = '';
    if (hideRight) team2El.innerHTML = '';
    team1El.hidden = hideLeft;
    team2El.hidden = hideRight;
    // Team names arrive with the round, so the POV tooltip is refreshed here
    // rather than only when the button is clicked.
    syncPovBtn();
    indexPlayerRows();
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

  function teamHtml(team, info, side) {
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
        <span class="rv-team-name">${escapeHtml(info.name || `Team ${team}`)}</span>
        <span class="rv-team-side" data-side-wp="${escapeHtml(side || '')}">${escapeHtml(
          side || ''
        )}</span>
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
    const gunClass = inv.holdingPrimary
      ? 'rv-inv-icon rv-inv-gun is-held'
      : 'rv-inv-icon rv-inv-gun is-dim';
    parts.push(
      `<span class="rv-inv-primary">${
        inv.primary ? iconImgHtml(inv.primary, gunClass) : ''
      }</span>`
    );
    let heldUtilMarked = false;
    const util = (inv.util || [])
      .map((u) => {
        const held = !heldUtilMarked && inv.holdingUtil && u === inv.holdingUtil;
        if (held) heldUtilMarked = true;
        return iconImgHtml(u, held ? 'rv-inv-icon rv-inv-nade is-held' : 'rv-inv-icon rv-inv-nade is-dim');
      })
      .join('');
    parts.push(`<span class="rv-inv-util">${util}</span>`);
    return parts.join('');
  }

  // ---- kill feed ----------------------------------------------------------

  const KILLFEED_MAX = 6;

  function playerRecord(id) {
    if (!id || !activeMeta?.players) return null;
    return activeMeta.players.find((p) => p.id === id) || null;
  }

  function killfeedNameClass(playerId) {
    const side = sideOfPlayer(playerId);
    if (side === 'T') return 'side-t';
    if (side === 'CT') return 'side-ct';
    return '';
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
      ? `<span class="rv-killfeed-name ${killfeedNameClass(k.attacker)}">${escapeHtml(
          attackerName
        )}</span>`
      : '';
    return `<div class="rv-killfeed-row">
      ${left}
      <span class="rv-killfeed-weapon">${gun}${hs}</span>
      <span class="rv-killfeed-name ${killfeedNameClass(k.victim)}">${escapeHtml(victimName)}</span>
    </div>`;
  }

  function syncKillFeed(tick = 0) {
    if (!killfeedEl || !activeMeta) return;
    const all = activeMeta.events?.kills || [];
    const happened = [];
    for (const k of all) {
      if (k.tick <= tick) happened.push(k);
    }
    // Oldest of the recent kills at the top; newest appears at the bottom.
    const recent = happened.slice(-KILLFEED_MAX);
    // Include sides so colors refresh when round meta lands (roster team ≠ live side).
    const key = `${activeMeta.team1Side}|${activeMeta.team2Side}|${recent
      .map((k) => `${k.tick}:${k.attacker}:${k.victim}:${k.weapon}`)
      .join('|')}`;
    if (key === killFeedKey) return;
    killFeedKey = key;
    killfeedEl.innerHTML = recent.map((k) => killRowHtml(k)).join('');
  }

  /**
   * Live engagements in their own panel below the kill-feed slot: each active
   * duel and the model's win chances, updating as the fight develops. Anchored
   * independently so kill rows do not shove this block up and down.
   */
  function syncDuelFeed(overlay) {
    if (!duelFeedEl) return;
    if (!duelsOn || !overlay || !activeMeta) {
      if (duelFeedKey !== '') {
        duelFeedKey = '';
        duelFeedEl.innerHTML = '';
        duelFeedEl.hidden = true;
      }
      return;
    }
    const active = (overlay.lines || []).filter((l) => l.active);
    const key = active
      .map(
        (l) =>
          `${l.aSlot}:${l.bSlot}:${Math.round(l.pa * 1000)}:${Math.round(l.pb * 1000)}`
      )
      .join('|');
    if (key === duelFeedKey) return;
    duelFeedKey = key;
    if (!active.length) {
      duelFeedEl.innerHTML = '';
      duelFeedEl.hidden = true;
      return;
    }
    const bySlot = new Map((activeMeta.players || []).map((p) => [p.slot, p]));
    const sideClass = (side) => (side === 'T' ? 'side-t' : side === 'CT' ? 'side-ct' : '');
    duelFeedEl.hidden = false;
    duelFeedEl.innerHTML = `<div class="rv-duel-feed-label">Engagements</div>${active
      .map((l) => {
        const a = bySlot.get(l.aSlot);
        const b = bySlot.get(l.bSlot);
        const aName = escapeHtml(a?.name || `P${l.aSlot}`);
        const bName = escapeHtml(b?.name || `P${l.bSlot}`);
        const pa = Math.round(l.pa * 100);
        const pb = Math.round(l.pb * 100);
        return `<div class="rv-duel-feed-row">
          <span class="rv-duel-feed-name ${sideClass(l.aSide)}">${aName}</span>
          <span class="rv-duel-feed-odds" title="Predicted win chance">
            <b class="${sideClass(l.aSide)}">${pa}%</b>
            <span class="rv-duel-feed-sep">–</span>
            <b class="${sideClass(l.bSide)}">${pb}%</b>
          </span>
          <span class="rv-duel-feed-name ${sideClass(l.bSide)}">${bName}</span>
        </div>`;
      })
      .join('')}`;
  }

  function syncScoreboard(tick = 0) {
    if (!activeMeta) return;
    const weapons = activeMeta.weapons || [];
    const grenades = activeMeta.events?.grenades || [];
    for (const p of activeMeta.players || []) {
      const s = states[p.slot];
      if (!s) continue;
      const row = playerRows.get(p.slot);
      if (!row) continue;
      const { root, hp, inv: invEl } = row;
      root.classList.toggle('dead', !s.alive);
      const side = s.side || root.dataset.side;
      if (side) root.dataset.side = side;
      if (hp) {
        const pct = s.alive ? Math.max(0, Math.min(100, s.health)) : 0;
        hp.style.width = `${pct}%`;
      }
      if (!invEl) continue;
      const st = activeMeta.stats?.[p.id] || {};
      const inv = inventoryAt({
        loadout: st.loadout || [],
        grenades,
        itemEvents: activeMeta.events?.items || [],
        playerId: p.id,
        tick,
        state: s,
        activeWeapon: weapons[s.weapon] || ''
      });
      const key = `${inv.primary}|${inv.holdingPrimary ? 1 : 0}|${inv.holdingUtil || ''}|${armorIconKey(inv)}|${(inv.util || []).join(',')}|${s.alive ? 1 : 0}`;
      if (invEl.dataset.key !== key) {
        invEl.dataset.key = key;
        invEl.innerHTML = s.alive ? invHtml(inv) : '';
      }
    }
  }

  // ---- zoom / pan ---------------------------------------------------------

  function cancelViewAnim() {
    if (viewAnimRaf) {
      cancelAnimationFrame(viewAnimRaf);
      viewAnimRaf = 0;
    }
  }

  function easeOutCubic(t) {
    return 1 - (1 - t) ** 3;
  }

  /** Pan offsets that place radar pixel (rx, ry) at the canvas center at `zoom`. */
  function panToCenterRadar(rx, ry, zoom) {
    const { w, h } = renderer.resize();
    const dpr = renderer.dpr;
    const top = (renderer.viewInset.top || 0) * dpr;
    const right = (renderer.viewInset.right || 0) * dpr;
    const bottom = (renderer.viewInset.bottom || 0) * dpr;
    const left = (renderer.viewInset.left || 0) * dpr;
    const boxW = Math.max(1, w - left - right);
    const boxH = Math.max(1, h - top - bottom);
    const scale = (Math.min(boxW, boxH) / RADAR_SIZE) * zoom;
    const ox = w / 2 - rx * scale;
    const oy = h / 2 - ry * scale;
    return {
      panX: (ox - left - (boxW - RADAR_SIZE * scale) / 2) / dpr,
      panY: (oy - top - (boxH - RADAR_SIZE * scale) / 2) / dpr
    };
  }

  function animateViewTo({ zoom, panX, panY }, ms = COACH_FOCUS_MS) {
    cancelViewAnim();
    const fromZ = renderer.zoom;
    const fromX = renderer.panX;
    const fromY = renderer.panY;
    const toZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    const t0 = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - t0) / Math.max(1, ms));
      const e = easeOutCubic(u);
      renderer.zoom = fromZ + (toZ - fromZ) * e;
      renderer.panX = fromX + (panX - fromX) * e;
      renderer.panY = fromY + (panY - fromY) * e;
      syncPanCursor();
      draw();
      if (u < 1) viewAnimRaf = requestAnimationFrame(step);
      else viewAnimRaf = 0;
    };
    viewAnimRaf = requestAnimationFrame(step);
  }

  /**
   * Soft-zoom toward the given player ids at `tick` (radar centroid).
   * Used when opening a coach mistake so the map settles on the people involved.
   */
  function focusPlayersAtTick(playerIds, tick) {
    const ids = (playerIds || []).filter(Boolean);
    if (!ids.length || !activeMeta || activeIndex < 0) return;
    const file = files[activeIndex];
    const track = store.get(file)?.full || store.track(file);
    if (!track) return;
    const byId = new Map((activeMeta.players || []).map((p) => [p.id, p]));
    const scratch = [];
    track.sampleAll(tick, scratch);
    const radarPts = [];
    const tmp = {};
    const mapCode = renderer.mapCode || activeMeta.map || '';
    for (const id of ids) {
      const p = byId.get(id);
      if (!p || p.slot == null) continue;
      const s = scratch[p.slot];
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      worldToRadar(mapCode, s.x, s.y, tmp);
      if (!Number.isFinite(tmp.x) || !Number.isFinite(tmp.y)) continue;
      radarPts.push({ x: tmp.x, y: tmp.y });
    }
    if (!radarPts.length) return;
    let cx = 0;
    let cy = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of radarPts) {
      cx += p.x;
      cy += p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    cx /= radarPts.length;
    cy /= radarPts.length;
    const span = Math.max(maxX - minX, maxY - minY, 1);
    let zoom = COACH_FOCUS_ZOOM;
    if (radarPts.length > 1) {
      // Keep the group framed without crushing the mild single-player zoom.
      zoom = Math.max(1.45, Math.min(COACH_FOCUS_ZOOM, (0.42 * RADAR_SIZE) / span));
    }
    const pan = panToCenterRadar(cx, cy, zoom);
    animateViewTo({ zoom, panX: pan.panX, panY: pan.panY });
  }

  function setZoom(next, anchorX, anchorY) {
    cancelViewAnim();
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

  /** Left-click (no drag) toggles Nuke upper/lower radar. */
  let pendingClick = null;
  const CLICK_SLOP = 6;

  function startInk(e) {
    inkPointer = e.pointerId;
    mapEl.setPointerCapture(e.pointerId);
    const pt = radarAt(e);
    if (drawing.erasing) drawing.eraseAt(pt, pt.scale);
    else drawing.begin(pt);
    e.preventDefault();
  }

  mapEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.rv-clock-row, .rv-loading')) return;
    closePopovers();

    // Right click always draws, whatever mode the toolbar is in. Left click
    // only draws while drawing mode is on, so it stays a pan otherwise.
    if (e.button === 2 || (e.button === 0 && drawing.enabled)) {
      pendingClick = null;
      startInk(e);
      return;
    }

    if (e.button === 0) {
      pendingClick = { x: e.clientX, y: e.clientY, id: e.pointerId };
    } else {
      pendingClick = null;
    }

    const isPanBtn = e.button === 0 || e.button === 1;
    if (!isPanBtn || renderer.zoom <= MIN_ZOOM) {
      if (pendingClick) {
        mapEl.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      return;
    }
    cancelViewAnim();
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
    if (
      pendingClick &&
      e.pointerId === pendingClick.id &&
      Math.hypot(e.clientX - pendingClick.x, e.clientY - pendingClick.y) > CLICK_SLOP
    ) {
      pendingClick = null;
    }
    if (!panning) {
      if (!duelsOn) return;
      const hit = duelAt(e.clientX, e.clientY);
      const same =
        (!hit && !duelHover) ||
        (hit && duelHover && hit.aSlot === duelHover.aSlot && hit.bSlot === duelHover.bSlot);
      if (same) return;
      duelHover = hit;
      draw();
      return;
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    renderer.panX += dx;
    renderer.panY += dy;
    draw();
  });

  mapEl.addEventListener('pointerleave', () => {
    if (!duelHover) return;
    duelHover = null;
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
    if (endStroke(e)) {
      pendingClick = null;
      return;
    }
    if (
      pendingClick &&
      e.pointerId === pendingClick.id &&
      (e.button === undefined || e.button === 0) &&
      e.type === 'pointerup'
    ) {
      if (renderer.toggleRadarLevel()) draw();
    }
    pendingClick = null;
    if (!panning) {
      try {
        mapEl.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      return;
    }
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

  function syncCoachBtn() {
    if (!coachBtn) return;
    coachBtn.hidden = !coachAvailable;
    coachBtn.classList.toggle('active', coachAvailable && (coachOn || coachPicking));
    coachBtn.title = coachAvailable
      ? 'Coach: mistake notes for one team'
      : 'Coach needs a full match — open a demo, not a round selection';
  }

  function closePopovers(except = null) {
    if (notePanel !== except) notePanel.hidden = true;
    if (playlistPanel !== except) playlistPanel.hidden = true;
    if (coachPick && coachPick !== except) {
      coachPick.hidden = true;
      coachPicking = false;
    }
    noteBtn.classList.toggle('active', !notePanel.hidden);
    bookmarkBtn.classList.toggle('open', !playlistPanel.hidden);
    syncCoachBtn();
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
          playerId: String(n.playerId || ''),
          rule: String(n.rule || ''),
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
          playerId: '',
          rule: '',
          updatedAt: Number(meta.noteUpdatedAt) || 0
        }
      ];
    }
    return [];
  }

  function currentNote() {
    return roundNotes[noteIndex] || null;
  }

  /** Same readout as the round clock above the map (countdown / bomb / etc.). */
  function noteClockLabel(tick) {
    if (!activeMeta) return formatClock(0);
    return clockAt(timingFor(activeMeta), tick).label;
  }

  function playheadTick() {
    const at = sequence.locate(playback.position);
    if (at.index !== activeIndex) {
      const timing = timingFor(activeMeta || {});
      return timing.freezeEndTick || timing.startTick || 0;
    }
    return Math.round(at.tick);
  }

  // ---- moment links -------------------------------------------------------
  //
  // A round already has a URL. A moment needs the tick as well, and the camera
  // with it: "watch this" and "watch this, zoomed on B site" are different
  // things to send someone, and the second one is most of why anyone shares a
  // position at all.

  /** `/demos?round=<file>&tick=<n>` plus the camera when it has been moved. */
  function momentLink() {
    const file = files[activeIndex];
    if (!file) return '';
    const url = new URL('/demos', window.location.origin);
    url.searchParams.set('round', file);
    url.searchParams.set('tick', String(playheadTick()));
    // A default camera is not worth putting in the link.
    if (renderer.zoom > 1.001) {
      url.searchParams.set('zoom', renderer.zoom.toFixed(2));
      url.searchParams.set('px', String(Math.round(renderer.panX)));
      url.searchParams.set('py', String(Math.round(renderer.panY)));
    }
    return url.toString();
  }

  async function copyMomentLink() {
    const link = momentLink();
    if (!link) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      ok = false;
    }
    if (!shareBtn) return;
    shareBtn.classList.toggle('copied', ok);
    shareBtn.title = ok ? 'Link copied' : 'Could not copy. Check clipboard permissions.';
    window.setTimeout(() => {
      if (destroyed || !shareBtn) return;
      shareBtn.classList.remove('copied');
      shareBtn.title = 'Copy a link to this moment';
    }, 1600);
  }

  shareBtn?.addEventListener('click', () => void copyMomentLink());

  /**
   * Land on a shared moment, once the round it belongs to is loaded.
   *
   * Consumed on first use: a link opens the viewer where it says, and every
   * scrub afterwards is the user's own.
   */
  function applyStartAt() {
    if (!startAt || !activeMeta) return;
    const tick = Number(startAt.tick);
    const item = sequence.at(activeIndex);
    if (!item || !Number.isFinite(tick)) {
      startAt = null;
      return;
    }
    const timing = timingFor(activeMeta);
    const local = Math.max(0, (tick - timing.startTick) / (timing.tickRate || 64));
    playback.pause();
    syncPlayButton();
    // A link into the buy is a deliberate choice, same as dragging there.
    freezeSkip = false;
    playback.seek(sequence.offsetOf(activeIndex) + Math.min(local, roundLocalMax(item)));
    const zoom = Number(startAt.zoom);
    if (Number.isFinite(zoom) && zoom > 1) {
      renderer.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      renderer.panX = Number(startAt.panX) || 0;
      renderer.panY = Number(startAt.panY) || 0;
    }
    startAt = null;
    draw();
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
    const has = visibleNoteIndices().some((i) => String(roundNotes[i]?.text || '').trim());
    noteBtn.classList.toggle('has-note', has);
  }

  function syncNoteView() {
    const listing = noteView === 'list';
    if (noteListHead) noteListHead.hidden = !listing;
    if (noteListEl) noteListEl.hidden = !listing;
    if (noteEditorEl) noteEditorEl.hidden = listing;
  }

  function notePreview(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return 'Empty note';
    return t.length > 72 ? `${t.slice(0, 71)}…` : t;
  }

  function renderNoteList() {
    if (!noteListEl) return;
    if (!roundNotes.length) {
      noteListEl.innerHTML = '<p class="rv-popover-empty">No notes yet.</p>';
      return;
    }
    noteListEl.innerHTML = roundNotes
      .map((n, i) => {
        if (!noteInCoachFocus(n)) return '';
        const coach = n.kind === 'coach';
        // Same rule as the scrub markers: marks only read inside a team review.
        const markCls =
          !teamReview || !coach
            ? ''
            : n.mark === 'ok'
              ? ' mark-ok'
              : n.mark === 'x'
                ? ' mark-x'
                : '';
        return `<button type="button" class="rv-note-item${coach ? ' coach' : ''}${markCls}" data-note-index="${i}">
          <span class="rv-note-item-mark" aria-hidden="true"></span>
          <span class="rv-note-item-body">
            <span class="rv-note-item-time">${escapeHtml(noteClockLabel(n.tick))}</span>
            <span class="rv-note-item-text">${escapeHtml(notePreview(n.text))}</span>
          </span>
        </button>`;
      })
      .join('');
    if (!noteListEl.innerHTML) {
      noteListEl.innerHTML = '<p class="rv-popover-empty">No notes for selected players.</p>';
    }
  }

  /**
   * Coach notes for players outside the pick are hidden from marks / nav.
   * Autocoach "Review as" is strict: only that player's coach notes.
   */
  function noteInCoachFocus(n) {
    if (!n) return false;
    const reviewId = String(coachReviewPlayerId || '');
    // A user note is always a user note; the review view is coach-only.
    if (n.kind !== 'coach') return !reviewId;
    // Coach notes belong to coach mode. Turning it off puts them away along
    // with the round chips and scrub markers that point at them, rather than
    // leaving flags on the timeline with nothing behind them.
    if (!coachOn) return false;
    if (reviewId) {
      const focus = focusPlayerIdSet() || new Set([reviewId]);
      const pid = String(n.playerId || '');
      return Boolean(pid) && focus.has(pid);
    }
    if (!coachFocusPlayers || !coachFocusPlayers.size) return true;
    const focus = focusPlayerIdSet();
    if (!focus?.size) return true;
    const pid = String(n.playerId || '');
    return Boolean(pid) && focus.has(pid);
  }

  function visibleNoteIndices() {
    const out = [];
    for (let i = 0; i < roundNotes.length; i++) {
      if (noteInCoachFocus(roundNotes[i])) out.push(i);
    }
    return out;
  }

  function firstVisibleNoteIndex() {
    const vis = visibleNoteIndices();
    return vis.length ? vis[0] : -1;
  }

  function renderNoteDock({ forceText = false } = {}) {
    syncNoteView();
    if (noteView === 'list') {
      renderNoteList();
      syncNoteHasBadge();
      return;
    }
    const n = currentNote();
    const vis = visibleNoteIndices();
    const visPos = vis.indexOf(noteIndex);
    const total = vis.length || roundNotes.length;
    if (!n) {
      noteStampEl.textContent = '—';
      notePosEl.textContent = '';
      noteText.value = '';
      notePrevBtn.disabled = true;
      noteNextBtn.disabled = true;
      syncNoteCount();
      syncNoteHasBadge();
      return;
    }
    noteStampEl.textContent = noteClockLabel(n.tick);
    const pos = visPos >= 0 ? visPos + 1 : noteIndex + 1;
    notePosEl.textContent = total > 1 ? `${pos} / ${total}` : '';
    if (forceText || document.activeElement !== noteText) noteText.value = n.text || '';
    notePrevBtn.disabled = !vis.length || (visPos >= 0 ? visPos <= 0 : noteIndex <= vis[0]);
    noteNextBtn.disabled =
      !vis.length || (visPos >= 0 ? visPos >= vis.length - 1 : noteIndex >= vis[vis.length - 1]);
    syncNoteMarks(n);
    syncNoteCount();
    syncNoteHasBadge();
  }

  /** The accept / dismiss pair: team review only, and only on a coach note. */
  function syncNoteMarks(n) {
    if (!noteMarksEl) return;
    const show = teamReview && n?.kind === 'coach';
    noteMarksEl.hidden = !show;
    if (!show) return;
    noteMarkOkBtn?.classList.toggle('active', n.mark === 'ok');
    noteMarkXBtn?.classList.toggle('active', n.mark === 'x');
  }

  /** Toggle a coach note's mark and save. Clicking the set one clears it. */
  function setNoteMark(mark) {
    if (!teamReview) return;
    const n = currentNote();
    if (!n || n.kind !== 'coach') return;
    n.mark = n.mark === mark ? '' : mark;
    n.updatedAt = Date.now();
    syncNoteMarks(n);
    renderNoteList();
    renderActiveMarks();
    void persistNotes({ quiet: true });
  }

  function loadNotesFromMeta(force = false) {
    if (!force && document.activeElement === noteText) return;
    ensureReviewFocus();
    roundNotes = notesFromMeta(activeMeta);
    const vis = visibleNoteIndices();
    if (vis.length) {
      noteIndex = vis.includes(noteIndex) ? noteIndex : vis[0];
    } else {
      noteIndex = -1;
    }
    noteMsg.textContent = '';
    renderNoteDock();
    renderActiveMarks();
  }

  function seekToNoteTick(tick, { leadSeconds = 0, focusPlayerIds = null } = {}) {
    if (activeIndex < 0 || !activeMeta) return;
    const timing = timingFor(activeMeta);
    const item = sequence.at(activeIndex);
    if (!item) return;
    const rate = timing.tickRate || 64;
    const leadTicks = Math.max(0, Math.round(leadSeconds * rate));
    const floor = timing.freezeEndTick ?? timing.startTick;
    const seekTick = Math.max(floor, tick - leadTicks);
    const local = Math.max(0, (seekTick - timing.startTick) / rate);
    playback.seek(sequence.offsetOf(activeIndex) + Math.min(local, roundLocalMax(item)));
    if (focusPlayerIds?.length) {
      // Seek paints first; focus on the next frame so the canvas has size and
      // the tick sample matches the playhead.
      const ids = [...focusPlayerIds];
      const at = seekTick;
      requestAnimationFrame(() => {
        if (destroyed) return;
        focusPlayersAtTick(ids, at);
      });
    }
  }

  /** Land at freezetime end (coach entry uses enterCoachRoundMoment instead). */
  function seekRoundEntry(index = activeIndex) {
    playback.seek(liveOffsetOf(index), { emit: false });
  }

  /**
   * Coach mode round entry: open the earliest coach note, jump to 1s before,
   * and pause so the moment can be reviewed.
   */
  function enterCoachRoundMoment() {
    ensureReviewFocus();
    // Prefer the earliest focused coach note; otherwise the first visible note.
    let at = -1;
    for (let i = 0; i < roundNotes.length; i++) {
      const n = roundNotes[i];
      if (n?.kind === 'coach' && noteInCoachFocus(n)) {
        at = i;
        break;
      }
    }
    if (at < 0) at = firstVisibleNoteIndex();
    playback.pause();
    syncPlayButton();
    if (at < 0) {
      seekRoundEntry(activeIndex);
      return;
    }
    noteView = 'editor';
    closePopovers(notePanel);
    notePanel.hidden = false;
    noteBtn.classList.add('active');
    showNoteAt(at, { seek: true });
  }

  function showNoteAt(index, { seek = false } = {}) {
    noteView = 'editor';
    if (!roundNotes.length) {
      noteIndex = -1;
      renderNoteDock({ forceText: true });
      return;
    }
    noteIndex = Math.max(0, Math.min(roundNotes.length - 1, index));
    renderNoteDock({ forceText: true });
    if (!seek) return;
    const n = roundNotes[noteIndex];
    const coach = n?.kind === 'coach';
    seekToNoteTick(n.tick, {
      leadSeconds: coach ? 1 : 0,
      focusPlayerIds: coach && n.playerId ? [n.playerId] : null
    });
  }

  function showAdjacentVisibleNote(dir) {
    flushNoteText();
    const vis = visibleNoteIndices();
    if (!vis.length) return;
    let at = vis.indexOf(noteIndex);
    if (at < 0) {
      // Current note filtered out: jump to nearest in the travel direction.
      if (dir > 0) {
        at = vis.findIndex((i) => i > noteIndex);
        if (at < 0) return;
        showNoteAt(vis[at], { seek: true });
        return;
      }
      for (let i = vis.length - 1; i >= 0; i--) {
        if (vis[i] < noteIndex) {
          showNoteAt(vis[i], { seek: true });
          return;
        }
      }
      return;
    }
    const next = at + dir;
    if (next < 0 || next >= vis.length) return;
    showNoteAt(vis[next], { seek: true });
  }

  /** Open the dock on the first chronological note when the round has any. */
  function autoOpenNotesIfPresent() {
    loadNotesFromMeta(true);
    const vis = visibleNoteIndices();
    if (!vis.length) return;
    noteView = 'editor';
    closePopovers(notePanel);
    notePanel.hidden = false;
    noteBtn.classList.add('active');
    showNoteAt(vis[0], { seek: false });
  }

  /** Comment button with existing notes: list first, + to create another. */
  function openNoteList() {
    flushNoteText();
    noteView = 'list';
    closePopovers(notePanel);
    notePanel.hidden = false;
    noteBtn.classList.add('active');
    renderNoteDock();
  }

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

  noteListEl?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-note-index]');
    if (!item) return;
    const index = Number(item.dataset.noteIndex);
    if (!Number.isFinite(index)) return;
    showNoteAt(index, { seek: true });
  });

  function setNoteOpen(open) {
    closePopovers(open ? notePanel : null);
    notePanel.hidden = !open;
    noteBtn.classList.toggle('active', open);
    if (open) {
      if (noteView !== 'list') noteView = 'editor';
      renderNoteDock();
      if (noteView === 'editor') noteText.focus();
    }
  }

  /** Stamp a new note at the scrubber time and show it. */
  function createNoteAtPlayhead() {
    // Don't flush while the list is showing — the textarea still holds the
    // previously edited note and would overwrite it with stale text.
    if (noteView === 'editor' && !notePanel.hidden) flushNoteText();
    const tick = playheadTick();
    const note = {
      id: newNoteId(),
      tick,
      text: '',
      kind: 'user',
      mark: '',
      playerId: '',
      rule: '',
      updatedAt: Date.now()
    };
    roundNotes.push(note);
    roundNotes.sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt);
    noteIndex = roundNotes.findIndex((n) => n.id === note.id);
    noteMsg.textContent = '';
    noteView = 'editor';
    setNoteOpen(true);
    renderNoteDock({ forceText: true });
    renderActiveMarks();
    noteText.focus();
  }

  async function persistNotes({ quiet = false } = {}) {
    const file = files[activeIndex];
    if (!file) return;
    flushNoteText();
    // Empty drafts stay local until they have text; do not wipe them on autosave.
    const emptyDrafts = roundNotes.filter(
      (n) => n.kind !== 'coach' && !String(n.text || '').trim()
    );
    const payload = roundNotes
      .map((n) => ({
        id: n.id,
        tick: n.tick,
        text: String(n.text || '').trim(),
        kind: n.kind === 'coach' ? 'coach' : 'user',
        mark: n.mark || '',
        playerId: n.playerId || '',
        rule: n.rule || '',
        updatedAt: n.updatedAt || Date.now()
      }))
      .filter((n) => n.text);
    if (!quiet) noteMsg.textContent = 'Saving…';
    try {
      const res = await saveRoundNotes(file, payload);
      const saved = Array.isArray(res.notes) ? res.notes : payload;
      const curId = currentNote()?.id;
      roundNotes = notesFromMeta({ notes: saved });
      for (const n of emptyDrafts) {
        if (!roundNotes.some((x) => x.id === n.id)) roundNotes.push(n);
      }
      roundNotes.sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt);
      if (curId) {
        const idx = roundNotes.findIndex((n) => n.id === curId);
        if (idx >= 0) noteIndex = idx;
      }
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
        if (!quiet) noteMsg.textContent = 'Notes cleared.';
        setNoteOpen(false);
      } else {
        if (noteIndex < 0 || noteIndex >= roundNotes.length) noteIndex = 0;
        if (!quiet) noteMsg.textContent = 'Saved.';
        else if (noteMsg.textContent === 'Saving…') noteMsg.textContent = '';
        renderNoteDock();
      }
      setCoachNoted(file, roundNotes);
      syncCoachRoundChips();
      syncNoteHasBadge();
      renderActiveMarks();
    } catch (err) {
      noteMsg.textContent = err.message || 'Could not save.';
    }
  }

  let noteSaveTimer = 0;
  function schedulePersistNotes() {
    if (noteSaveTimer) clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
      noteSaveTimer = 0;
      void persistNotes({ quiet: true });
    }, 450);
  }

  noteText.addEventListener('input', () => {
    flushNoteText();
    syncNoteCount();
    syncNoteHasBadge();
    schedulePersistNotes();
  });
  noteText.addEventListener('blur', () => {
    if (noteSaveTimer) {
      clearTimeout(noteSaveTimer);
      noteSaveTimer = 0;
    }
    void persistNotes({ quiet: true });
  });
  noteBtn.addEventListener('click', () => {
    if (!notePanel.hidden) {
      setNoteOpen(false);
      return;
    }
    if (visibleNoteIndices().length) openNoteList();
    else createNoteAtPlayhead();
  });
  const onAddNote = () => createNoteAtPlayhead();
  noteAddBtn?.addEventListener('click', onAddNote);
  noteAddEditBtn?.addEventListener('click', onAddNote);
  notePrevBtn.addEventListener('click', () => showAdjacentVisibleNote(-1));
  noteNextBtn.addEventListener('click', () => showAdjacentVisibleNote(1));
  noteMarkOkBtn?.addEventListener('click', () => setNoteMark('ok'));
  noteMarkXBtn?.addEventListener('click', () => setNoteMark('x'));
  el.querySelector('#rv-note-close').addEventListener('click', () => setNoteOpen(false));
  el.querySelector('#rv-note-close-list')?.addEventListener('click', () => setNoteOpen(false));
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
      playlistListEl.innerHTML = spinnerHtml('', { size: 'sm' });
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
      const scope = el.querySelector('#rv-playlist-scope')?.value === 'team' ? 'team' : 'private';
      playlists = await savePlaylist({ name, rounds: [file], scope });
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
      boardBody.innerHTML = spinnerHtml();
      return;
    }
    const demo = statsPayload.demos?.[0];
    if (!demo) {
      boardBody.innerHTML = '<p class="view-empty">No stats for this match yet.</p>';
      return;
    }
    const upTo = rounds[activeIndex]?.round ?? 0;
    const rows = allRows(statsPayload).filter((r) => r.n <= upTo);
    const { players, demos } = indexMaps(statsPayload);
    const all = aggregatePlayers(rows, players, {}, demos);
    const teamOf = new Map(demo.players.map((p) => [p.id, p.team]));

    // Duel numbers are merged in by player id when they are ready. Until then
    // the columns render as dashes rather than zeroes, so a match still loading
    // never reads as a team that lost every fight.
    const duels = duelSummary;
    for (const p of all) {
      const d = duels?.get(p.id);
      if (d) {
        p.pfw = d.pfw;
        p.pfo = d.pfo;
        p.duels = d.duels;
        p.pfoBuckets = d.buckets;
      }
      const fights = (p.kills || 0) + (p.deaths || 0);
      p.tfw = fights > 0 ? ((p.kills || 0) / fights) * 100 : NaN;
    }

    boardTitle.textContent = `Rounds 1-${upTo}${duelStatsPending ? ' · computing duels…' : ''}`;
    const board = (team, name) => {
      const list = all.filter((p) => teamOf.get(p.id) === team);
      return `<div class="rv-board">
        <h4 class="rv-board-name team${team}">${escapeHtml(name)}</h4>
        ${statsTableHtml(list, {
          columns: PLAYER_COLUMNS_WITH_DUELS,
          fixedCount: PLAYER_FIXED_BASE.length,
          escapeHtml,
          sortKey: 'rating',
          sortDir: 'desc'
        })}
      </div>`;
    };
    boardBody.innerHTML = board(1, demo.name1) + board(2, demo.name2);
    bindStatsHScroll(boardBody);
  }

  /** @type {Map<string, object> | null} per-player duel numbers, once computed */
  let duelSummary = null;
  /** Retires an in-flight pass when the selection changes underneath it. */
  let duelStatsPass = 0;
  let duelStatsPending = false;
  let duelStatsDone = false;

  /**
   * Run the duel model over every round of this match, once.
   *
   * The scoreboard is a whole-match view, so the numbers behind it have to come
   * from every round rather than the one on screen. Rounds are pulled at full
   * detail through the same store the timeline uses, so anything already warmed
   * in the background costs nothing, and the work is yielded between rounds to
   * keep the transport responsive while it runs.
   */
  async function ensureDuelStats() {
    if (duelStatsDone || duelStatsPending) return;
    if (!activeMeta || !files.length) return;
    duelStatsPending = true;
    const pass = ++duelStatsPass;
    try {
      const network = await ensureZoneNetwork();
      const mapCode = renderer.mapCode || activeMeta.map || '';
      if (!network || !mapCode) return;
      prepareZones(network, mapCode);
      if (!hasControlField(network)) return;

      const stats = createDuelStats();
      for (const file of files) {
        if (destroyed || pass !== duelStatsPass) return;
        const track = store.get(file)?.full || (await store.loadFull(file));
        if (!track) continue;
        const meta = await metaFor(file);
        if (!meta?.players?.length) continue;
        addRoundDuels(stats, { meta, track, network, mapCode });
        // Hand the frame back between rounds; a full match is a second or so of
        // work and blocking straight through it would stall playback.
        await new Promise((r) => setTimeout(r, 0));
      }
      if (destroyed || pass !== duelStatsPass) return;
      duelSummary = summarizeDuelStats(stats);
      duelStatsDone = true;
    } catch {
      // Leave the columns as dashes; nothing else on the board depends on this.
    } finally {
      if (pass === duelStatsPass) duelStatsPending = false;
      if (!destroyed && !boardEl.hidden) renderScoreboard();
    }
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
    // Duel numbers are the viewer's own work rather than the stats API's, so
    // they start as soon as the board is opened and fill in when they land.
    ensureDuelStats();
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

  const chartsEl = el.querySelector('#rv-charts');
  const graphEl = el.querySelector('#rv-wingraph');
  const graphCanvas = el.querySelector('#rv-wingraph-canvas');
  const graphCtLabel = el.querySelector('#rv-wingraph-ct');
  const graphTLabel = el.querySelector('#rv-wingraph-t');
  const graphTip = el.querySelector('#rv-wingraph-tip');
  const mapGraphEl = el.querySelector('.rv-mapgraph');
  const mapCanvas = el.querySelector('#rv-mapgraph-canvas');
  const mapCtLabel = el.querySelector('#rv-mapgraph-ct');
  const mapTLabel = el.querySelector('#rv-mapgraph-t');
  const mapNeuLabel = el.querySelector('#rv-mapgraph-neu');
  const mapTip = el.querySelector('#rv-mapgraph-tip');
  /** CSS-pixel playhead on the canvas (for hit-testing + tip anchor). */
  let graphPlayhead = null;
  let graphHoverDot = false;
  let graphShift = false;
  let mapPlayhead = null;
  let mapHoverDot = false;
  /** round file -> { series, flags, gate } */
  const coachCache = new Map();
  /** round file -> map control series [{tick,t,ct,neu}] */
  const mapControlCache = new Map();

  /**
   * A duel lookup for one round's analysis pass, or null when the model has
   * nothing to work with.
   *
   * Stride matches `coachSampleStride` so each series point gets a duel scan
   * at the same tick rather than inheriting a stale answer from a coarser grid.
   */
  function seriesDuelsAt(index, roundMeta, track) {
    const file = files[index];
    if (!zoneNetwork || !file || !store.get(file)?.isFull) return null;
    const mapCode = renderer.mapCode || roundMeta.map || '';
    prepareZones(zoneNetwork, mapCode);
    if (!hasControlField(zoneNetwork)) return null;
    // Same baseline stride as the coach series (event ticks still sample
    // exactly; the scanner walks up to that tick).
    const scanner = createDuelScanner({
      stride: coachSampleStride(roundMeta.tickRate || 64)
    });
    return (tick) =>
      scanner.at({
        meta: roundMeta,
        track,
        tick,
        network: zoneNetwork,
        mapCode,
        roundKey: file
      });
  }

  /**
   * Analyse one round. `meta` must be that round's own full meta (never reuse
   * another round's). Results are cached per file for the session.
   */
  function coachFor(index, meta = null) {
    const file = files[index];
    if (!file) return null;
    if (coachCache.has(file)) return coachCache.get(file);
    const roundMeta = meta || (index === activeIndex ? activeMeta : null);
    if (!roundMeta?.players?.length) return null;
    // Full ticks only — never analyse against a missing / coarse buffer.
    const track = store.get(file)?.full || null;
    if (!track) return null;
    const scratch = [];
    let result;
    try {
      // Pass zones for bombsites and/or dynamic map-control.
      result = analyseRound({
        meta: roundMeta,
        track,
        network: zoneNetwork,
        coachSmokes: coachSmokesArchive,
        sampleAt: (tick) => {
          track.sampleAll(tick, scratch);
          return scratch;
        },
        duelsAt: seriesDuelsAt(index, roundMeta, track)
      });
    } catch {
      return null;
    }
    coachCache.set(file, result);
    return result;
  }

  /**
   * A series point as the chart shows it.
   *
   * Each point carries two readings: the body-count win chance the coach
   * measures deaths against, and the same moment with the fights that were open
   * in it resolved forward. Everything on screen wants the second one, so the
   * promotion happens once, here, rather than at every label and tip.
   */
  function displaySample(point) {
    if (!point || !Number.isFinite(point.ctDuel)) return point;
    return {
      ...point,
      ct: point.ctDuel,
      t: point.tDuel,
      parts: point.duelParts || point.parts
    };
  }

  /** Win chance sample at (or just before) a tick from the cached series. */
  function coachSampleAt(result, tick) {
    if (!result?.series?.length) return null;
    let best = result.series[0];
    for (const s of result.series) {
      if (s.tick <= tick) best = s;
      else break;
    }
    return displaySample(best);
  }

  /**
   * The fights open at (or just before) `tick`, for the win chance.
   *
   * The tick is snapped to the scan grid so playback asks for the same answer
   * for several ticks running and pays for one scan, rather than recomputing
   * every pairing on the map on every rendered frame.
   *
   * Requires the same things the Duels tool does: map geometry, and full tick
   * data. Coarse data interpolates over a second and a half, which makes view
   * angles and movement speed meaningless — and a duel model reading those is
   * not conservative about it, it is confidently wrong.
   */
  function liveDuelsAt(tick) {
    if (!zoneNetwork || !activeMeta) return null;
    const file = files[activeIndex];
    const entry = store.get(file);
    if (!entry?.isFull || !entry.full) return null;
    const mapCode = renderer.mapCode || activeMeta.map || '';
    prepareZones(zoneNetwork, mapCode);
    if (!hasControlField(zoneNetwork)) return null;
    return winDuelScanner.at({
      meta: activeMeta,
      track: entry.full,
      tick: scanTickFor(tick),
      network: zoneNetwork,
      mapCode,
      roundKey: file
    });
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
      if (!chartOn || !now || (side !== 'T' && side !== 'CT')) {
        badge.textContent = side || '';
        badge.classList.toggle('is-wp', false);
        continue;
      }
      const pct = Math.round(side === 'CT' ? now.ct : now.t);
      badge.textContent = `${pct}%`;
      badge.classList.toggle('is-wp', true);
    }
  }

  function drawWinGraph(result, tick) {
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
    // Always CT share on Y: top = CT 100% (blue), bottom = T 100% (yellow).
    // `ctDuel` is the same moment with the fights that were open in it resolved
    // forward; it is what the badges and the playhead read, so the line has to
    // read it too or the dot would sit off its own curve during every fight.
    const ctShare = (p) => (Number(p?.ctDuel ?? p?.ct) || 0) / 100;
    const xAt = (i) => (i / span) * w;
    const yAt = (i) => h - ctShare(series[i]) * h;

    // Early / mid / late bands (freeze-end → end), behind the win% fill.
    const meta = activeMeta;
    if (meta && series.length > 1) {
      const bounds = phaseBounds(meta);
      const t0 = series[0].tick;
      const t1 = series[series.length - 1].tick;
      const xOfTick = (t) => {
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        return Math.max(0, Math.min(1, f)) * w;
      };
      const midX = xOfTick(bounds.midStartTick);
      const lateX = xOfTick(bounds.lateStartTick);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1 * dpr;
      for (const x of [midX, lateX]) {
        if (x <= 0 || x >= w) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      const labels = [
        { x0: 0, x1: midX, label: 'Early' },
        { x0: midX, x1: lateX, label: 'Mid' },
        { x0: lateX, x1: w, label: 'Late' }
      ];
      ctx.fillStyle = 'rgba(180, 186, 196, 0.7)';
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      for (const b of labels) {
        if (b.x1 - b.x0 < 28 * dpr) continue;
        ctx.fillText(b.label, b.x0 + 4 * dpr, 3 * dpr);
      }
      ctx.restore();
    }

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
    ctx.fillStyle = 'rgba(91, 159, 212, 0.42)'; // CT
    fillTo(mid, true);
    ctx.fillStyle = 'rgba(232, 184, 74, 0.42)'; // T
    fillTo(mid, false);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(180, 186, 196, 0.95)';
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = xAt(i);
      const y = yAt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Playhead follows the series curve (half-second / event samples), not a
    // per-tick recompute.
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
    const py = yAt(i0) * (1 - f) + yAt(i1) * f;
    // Badge / tip text steps on series points; playhead Y lerps between them.
    const sample = coachSampleAt(result, tick);
    const r = 4 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r + 1.2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#b5b5b5';
    ctx.fill();

    graphPlayhead = { x: px / dpr, y: py / dpr, tick, sample };

    if (sample) {
      if (graphCtLabel) graphCtLabel.textContent = `${Math.round(sample.ct)}%`;
      if (graphTLabel) graphTLabel.textContent = `${Math.round(sample.t)}%`;
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
    if (!chartOn || !graphHoverDot || !graphPlayhead) {
      graphTip.hidden = true;
      return;
    }
    const sample =
      graphPlayhead.sample ||
      coachSampleAt(coachFor(activeIndex), graphPlayhead.tick);
    if (!sample) {
      graphTip.hidden = true;
      return;
    }
    const map = activeMeta?.map || '';
    const ctPct = Number.isFinite(sample.ct) ? sample.ct : 50;
    const summary = `CT ${ctPct.toFixed(0)}%  T ${(100 - ctPct).toFixed(0)}%`;
    const detail = explainRoundLines(sample, map);
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

  function updateMapControlTip() {
    if (!mapTip) return;
    if (!chartOn || !mapHoverDot || !mapPlayhead?.sample) {
      mapTip.hidden = true;
      return;
    }
    const s = mapPlayhead.sample;
    mapTip.innerHTML =
      `<strong>Map control</strong><br>` +
      `T ${Math.round(s.t)}% · Neutral ${Math.round(s.neu)}% · CT ${Math.round(s.ct)}%`;
    mapTip.hidden = false;
    if (!mapCanvas || !mapGraphEl) return;
    const canvasRect = mapCanvas.getBoundingClientRect();
    const hostRect = mapGraphEl.getBoundingClientRect();
    mapTip.style.left = `${canvasRect.left - hostRect.left + mapPlayhead.x}px`;
    mapTip.style.top = `${canvasRect.top - hostRect.top + mapPlayhead.y}px`;
  }

  function onMapGraphPointerMove(e) {
    if (!mapPlayhead || !mapCanvas) {
      mapHoverDot = false;
      updateMapControlTip();
      return;
    }
    const rect = mapCanvas.getBoundingClientRect();
    const near =
      Math.hypot(e.clientX - rect.left - mapPlayhead.x, e.clientY - rect.top - mapPlayhead.y) <=
      16;
    if (near !== mapHoverDot) {
      mapHoverDot = near;
      mapCanvas.classList.toggle('is-dot-hover', near);
    }
    updateMapControlTip();
  }

  function onMapGraphPointerLeave() {
    mapHoverDot = false;
    mapCanvas?.classList.remove('is-dot-hover');
    updateMapControlTip();
  }

  mapCanvas?.addEventListener('pointermove', onMapGraphPointerMove);
  mapCanvas?.addEventListener('pointerleave', onMapGraphPointerLeave);

  function syncChartBtn() {
    chartBtn?.classList.toggle('active', chartOn);
  }

  /** Win% + map-control graphs — driven by the Chart tool, not coach mode. */
  function syncWinChart(tick = null) {
    if (chartsEl) chartsEl.hidden = !chartOn;
    syncChartBtn();
    if (!chartOn) {
      syncSideWinrates(null);
      graphPlayhead = null;
      mapPlayhead = null;
      graphHoverDot = false;
      mapHoverDot = false;
      if (graphTip) graphTip.hidden = true;
      if (mapTip) mapTip.hidden = true;
      return;
    }
    const at = tick ?? sequence.locate(playback.position).tick;
    const result = coachFor(activeIndex);
    if (result) drawWinGraph(result, at);
    syncSideWinrates(coachProbabilityAt(coachSampleAt(result, at)));
    syncMapControlChart(at);
  }

  function mapControlFor(index) {
    const file = files[index];
    if (!file) return null;
    if (mapControlCache.has(file)) return mapControlCache.get(file);
    const roundMeta = index === activeIndex ? activeMeta : null;
    if (!roundMeta?.players?.length) return null;
    const track = store.get(file)?.full || null;
    if (!track) return null;
    const net = zoneNetwork;
    if (!net) return null;
    const mapCode = renderer.mapCode || roundMeta.map || '';
    if (!renderer.image || !mapCode) return null;
    prepareZones(net, mapCode);
    if (!hasControlField(net)) return null;
    let series;
    try {
      series = buildMapControlSeries({
        meta: roundMeta,
        track,
        geom: net._fieldGeom,
        castCone: createConeCaster({
          meta: roundMeta,
          network: net,
          mapCode,
          radarImage: renderer.image
        })
      });
    } catch {
      return null;
    }
    if (series?.length) mapControlCache.set(file, series);
    return series;
  }

  function mapSampleAt(series, tick) {
    if (!series?.length) return null;
    let best = series[0];
    for (const s of series) {
      if (s.tick <= tick) best = s;
      else break;
    }
    return best;
  }

  function drawMapControlGraph(series, tick) {
    if (!mapCanvas || !series?.length) {
      mapPlayhead = null;
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = mapCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (mapCanvas.width !== w || mapCanvas.height !== h) {
      mapCanvas.width = w;
      mapCanvas.height = h;
    }
    const ctx = mapCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const span = Math.max(1, series.length - 1);
    const xAt = (i) => (i / span) * w;
    // Stacked: bottom CT, middle neutral, top T (y=0 is top of canvas).
    const yCt = (i) => h - (series[i].ct / 100) * h;
    const yNeuTop = (i) => h - ((series[i].ct + series[i].neu) / 100) * h;

    const fillBand = (yBottomFn, yTopFn, color) => {
      ctx.beginPath();
      ctx.moveTo(0, yBottomFn(0));
      for (let i = 0; i < series.length; i++) ctx.lineTo(xAt(i), yBottomFn(i));
      for (let i = series.length - 1; i >= 0; i--) ctx.lineTo(xAt(i), yTopFn(i));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    // Bottom band = CT (up from canvas bottom).
    fillBand(
      () => h,
      yCt,
      'rgba(91, 159, 212, 0.72)'
    );
    // Middle = neutral.
    fillBand(
      yCt,
      yNeuTop,
      'rgba(150, 156, 168, 0.38)'
    );
    // Top = T.
    fillBand(
      yNeuTop,
      () => 0,
      'rgba(232, 184, 74, 0.72)'
    );

    // Jagged separators.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = xAt(i);
      const y = yCt(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = xAt(i);
      const y = yNeuTop(i);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

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
    const sample = mapSampleAt(series, tick);
    const ct = sample?.ct ?? 0;
    const neu = sample?.neu ?? 0;
    const tShare = sample?.t ?? 0;
    const py = h - ((ct + neu / 2) / 100) * h;
    const r = 3.5 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, r + 1.2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = '#b5b5b5';
    ctx.fill();

    mapPlayhead = { x: px / dpr, y: py / dpr, tick, sample };
    if (mapCtLabel) mapCtLabel.textContent = `CT ${Math.round(ct)}%`;
    if (mapTLabel) mapTLabel.textContent = `T ${Math.round(tShare)}%`;
    if (mapNeuLabel) mapNeuLabel.textContent = `Neutral ${Math.round(neu)}%`;
  }

  function syncMapControlChart(tick) {
    if (!chartOn || !mapCanvas) return;
    const series = mapControlFor(activeIndex);
    if (series) {
      drawMapControlGraph(series, tick);
      return;
    }
    mapPlayhead = null;
    if (mapCtLabel) mapCtLabel.textContent = 'CT';
    if (mapTLabel) mapTLabel.textContent = 'T';
    if (mapNeuLabel) mapNeuLabel.textContent = 'Map control';
    // Chart works without the positions overlay — load the zone network on demand.
    const file = files[activeIndex];
    const wantTick = tick;
    ensureZoneNetwork().then(() => {
      if (destroyed || !chartOn || files[activeIndex] !== file) return;
      mapControlCache.delete(file);
      const built = mapControlFor(activeIndex);
      if (built) drawMapControlGraph(built, wantTick);
    });
  }

  function hideCoachPick() {
    if (coachPick) coachPick.hidden = true;
    coachPicking = false;
    pendingCoachTeam = null;
    coachPickTeamLocked = false;
    syncCoachBtn();
  }

  function rosterForCoachTeam(team) {
    const byId = new Map();
    const add = (meta) => {
      for (const p of meta?.players || []) {
        if (p.team === team && p.id) byId.set(p.id, p);
      }
    };
    add(activeMeta);
    for (const r of rounds || []) add(r);
    return [...byId.values()].sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''))
    );
  }

  function showCoachTeamStep() {
    if (!coachAvailable) return;
    coachPickTeamLocked = false;
    pendingCoachTeam = null;
    const t1 = activeMeta?.team1?.name || rounds[activeIndex]?.team1?.name || 'Team 1';
    const t2 = activeMeta?.team2?.name || rounds[activeIndex]?.team2?.name || 'Team 2';
    if (coachPickTitle) coachPickTitle.textContent = 'Coach which team?';
    if (coachPickT1) coachPickT1.textContent = t1;
    if (coachPickT2) coachPickT2.textContent = t2;
    if (coachPickTeams) coachPickTeams.hidden = false;
    if (coachPickPlayers) coachPickPlayers.hidden = true;
    if (coachPickBack) coachPickBack.hidden = true;
    closePopovers(coachPick);
    coachPicking = true;
    if (coachPick) coachPick.hidden = false;
    syncCoachBtn();
  }

  function showCoachPick() {
    showCoachTeamStep();
  }

  function showCoachPlayerStep(team, { lockedTeam = false } = {}) {
    if (!coachAvailable) return;
    if (team !== 1 && team !== 2) return;
    pendingCoachTeam = team;
    coachPickTeamLocked = lockedTeam;
    const roster = rosterForCoachTeam(team);
    if (coachPickTitle) coachPickTitle.textContent = 'Which players?';
    if (coachPickTeams) coachPickTeams.hidden = true;
    if (coachPickPlayers) coachPickPlayers.hidden = false;
    if (coachPickBack) coachPickBack.hidden = lockedTeam;
    if (coachPickPlayerList) {
      if (!roster.length) {
        coachPickPlayerList.innerHTML =
          '<p class="rv-popover-empty">No players found for this team.</p>';
      } else {
        coachPickPlayerList.innerHTML = roster
          .map(
            (p) => `<label class="rv-coach-pick-player">
              <input type="checkbox" data-player-id="${escapeHtml(p.id)}" checked />
              <span>${escapeHtml(p.name || p.id)}</span>
            </label>`
          )
          .join('');
      }
    }
    closePopovers(coachPick);
    coachPicking = true;
    if (coachPick) coachPick.hidden = false;
    syncCoachBtn();
  }

  function selectedCoachPlayerIds() {
    if (!coachPickPlayerList) return [];
    return [...coachPickPlayerList.querySelectorAll('input[type="checkbox"][data-player-id]')]
      .filter((el) => el.checked)
      .map((el) => el.dataset.playerId)
      .filter(Boolean);
  }

  async function demoAlreadyCoached() {
    // Any persisted coach note locks the demo: notes stay and never regenerate.
    for (const file of files) {
      try {
        let meta = null;
        if (file === files[activeIndex] && activeMeta) meta = activeMeta;
        else if (metaCache.has(file)) meta = await metaCache.get(file);
        else meta = await metaFor(file);
        if (notesFromMeta(meta).some((n) => n.kind === 'coach')) return true;
      } catch {
        /* keep scanning */
      }
    }
    return false;
  }

  async function hydrateCoachNotedFromDisk() {
    coachNotedFiles.clear();
    for (const file of files) {
      try {
        let meta = null;
        if (file === files[activeIndex] && activeMeta) meta = activeMeta;
        else if (metaCache.has(file)) meta = await metaCache.get(file);
        else meta = await metaFor(file);
        setCoachNoted(file, notesFromMeta(meta));
      } catch {
        /* skip */
      }
    }
    syncCoachRoundChips();
  }

  async function registerTeamAutocoach(side) {
    const demoId = String(statsDemoId || '');
    if (!demoId) return;
    try {
      let teamId = String(coachTeamId || '');
      if (!teamId) {
        const teams = await fetchTeams().catch(() => []);
        const list = Array.isArray(teams) ? teams : teams?.teams || [];
        const meta = activeMeta || rounds[0] || {};
        const n1 = teamNameKey(meta.team1?.name || meta.name1 || '');
        const n2 = teamNameKey(meta.team2?.name || meta.name2 || '');
        const hit = list.find((t) => {
          const key = teamNameKey(t.name);
          return key && (key === n1 || key === n2);
        });
        teamId = hit?.id || '';
      }
      if (!teamId) return;
      await markTeamAutocoachDemo(teamId, demoId, side);
    } catch {
      /* team registry is best-effort; notes already persist on the rounds */
    }
  }

  function defaultCoachFocusPlayers(team) {
    const reviewId = String(coachReviewPlayerId || '');
    if (reviewId) return new Set([reviewId]);
    return new Set(
      rosterForCoachTeam(team)
        .map((p) => String(p.id || ''))
        .filter(Boolean)
    );
  }

  async function enableCoachForTeam(team, { force = false, players = null } = {}) {
    if (!coachAvailable) return;
    if (team !== 1 && team !== 2) return;
    const locked = !force && (await demoAlreadyCoached());
    // Metered only when generating fresh notes — restoring an analyzed demo is free.
    if (!locked && !spentCoach) {
      if (!(await useMeteredFeature(CAP.DEMOS_AUTO_COACH, { host: el }))) {
        hideCoachPick();
        return;
      }
      spentCoach = true;
    }
    coachTeam = team;
    const reviewId = String(coachReviewPlayerId || '');
    if (reviewId) {
      coachFocusPlayers = new Set([reviewId]);
    } else if (players instanceof Set) {
      coachFocusPlayers = new Set([...players].map((id) => String(id || '')).filter(Boolean));
    } else if (Array.isArray(players)) {
      coachFocusPlayers = new Set(players.map((id) => String(id || '')).filter(Boolean));
    } else {
      coachFocusPlayers = defaultCoachFocusPlayers(team);
    }
    hideCoachPick();
    coachOn = true;
    // Phone coach starts map-first; the roster tool brings the sidebars back.
    if (stackedQuery.matches) rostersOn = false;
    syncCoachBtn();
    syncRostersLayout();
    if (locked) {
      spentCoach = true;
      await hydrateCoachNotedFromDisk();
      renderActiveMarks();
      enterCoachRoundMoment();
      return;
    }
    coachScanning = true;
    try {
      await ensureZoneNetwork();
      const mapCode = renderer.mapCode || activeMeta?.map || '';
      if (zoneNetwork && mapCode && renderer.image) {
        prepareZones(zoneNetwork, mapCode);
      }
      await analyseAllCoachRounds();
      await registerTeamAutocoach(team);
    } finally {
      coachScanning = false;
    }
    renderActiveMarks();
    syncCoachRoundChips();
    enterCoachRoundMoment();
  }

  chartBtn?.addEventListener('click', async () => {
    if (!chartOn && !spentRoundWin) {
      if (!(await useMeteredFeature(CAP.DEMOS_ROUND_WIN_PREDICTION, { host: el }))) return;
      spentRoundWin = true;
    }
    chartOn = !chartOn;
    if (chartOn) {
      coachCache.clear();
      await refreshZonePresence();
    }
    syncWinChart();
    draw();
  });

  /**
   * Turn the win chart on without spending anything for tiers that hold the
   * capability outright (Elite). A metered tier is left to ask for it, so a
   * Team Premium account does not silently burn its one daily use by opening
   * a demo.
   */
  void (async () => {
    const ents = getEntitlements();
    if (!ents) return;
    await ents.ready();
    if (destroyed || chartOn) return;
    // On the stacked layout the chart dock covers the rosters, so it waits to
    // be asked for rather than opening over them on arrival.
    if (stackedQuery.matches) return;
    if (!ents.quota(CAP.DEMOS_ROUND_WIN_PREDICTION).unlimited) return;
    spentRoundWin = true;
    chartOn = true;
    coachCache.clear();
    await refreshZonePresence();
    syncWinChart();
    draw();
  })();

  zonesBtn?.addEventListener('click', async () => {
    // Map control is Team Premium and up, metered at one a day there and
    // unlimited on Elite. Only charged on the way on, never on the way off.
    if (!zonesOn && !spentMapControl) {
      if (!(await useMeteredFeature(CAP.DEMOS_MAP_CONTROL, { host: el }))) return;
      spentMapControl = true;
    }
    zonesOn = !zonesOn;
    syncZonesBtn();
    if (zonesOn) {
      await refreshZonePresence();
      coachCache.clear();
    } else {
      if (!chartOn) zonePresence = null;
      resetZoneVisionCache(zoneVisionCache);
    }
    draw();
  });

  rostersBtn?.addEventListener('click', () => {
    if (!stackedQuery.matches) return;
    rostersOn = !rostersOn;
    syncRostersLayout();
    // POV may have emptied a panel; rebuild so shown sidebars are current.
    if (rostersOn) renderScoreboards();
  });

  // Off → team 1 → team 2 → off. A cycle rather than a picker: there are only
  // ever two answers, and the tooltip names the one currently in force.
  povBtn?.addEventListener('click', async () => {
    povTeam = povTeam === 0 ? 1 : povTeam === 1 ? 2 : 0;
    povFollowSide = povSideNow();
    povVision.reset();
    syncPovBtn();
    // Line of sight is what the mode is built on, same as the duels tool.
    if (povTeam) await ensureZoneNetwork();
    renderScoreboards();
    draw();
  });

  duelsBtn?.addEventListener('click', async () => {
    // Same metering shape as map control: charged once per opened viewer, on
    // the way on only, never again when it is toggled back off and on.
    if (!duelsOn && !spentDuelStats) {
      if (!(await useMeteredFeature(CAP.DEMOS_DUEL_WIN_PREDICTION, { host: el }))) return;
      spentDuelStats = true;
    }
    duelsOn = !duelsOn;
    syncDuelsBtn();
    if (duelsOn) {
      // The duel sight test needs the painted geometry, same as the zones tool.
      await ensureZoneNetwork();
    } else {
      duelOverlay.reset();
      duelHover = null;
      duelHitLines = [];
      duelFeedKey = '';
      if (duelFeedEl) {
        duelFeedEl.innerHTML = '';
        duelFeedEl.hidden = true;
      }
    }
    draw();
  });

  coachBtn?.addEventListener('click', async () => {
    if (!coachAvailable) return;
    if (coachOn) {
      // Notes stay on disk; what goes away is every trace of them on screen -
      // the notes themselves, the scrub markers, and the round chips that said
      // a round had something to look at.
      coachOn = false;
      coachScanning = false;
      coachPassId += 1;
      coachFocusPlayers = null;
      cancelViewAnim();
      hideCoachPick();
      // Leaving coach restores the under-map rosters on phones.
      if (stackedQuery.matches) rostersOn = true;
      syncCoachBtn();
      syncRostersLayout();
      const vis = visibleNoteIndices();
      noteIndex = vis.includes(noteIndex) ? noteIndex : (vis[0] ?? -1);
      if (noteIndex < 0) setNoteOpen(false);
      renderNoteDock({ forceText: true });
      renderActiveMarks();
      syncCoachRoundChips();
      return;
    }
    if (coachPicking) {
      hideCoachPick();
      return;
    }
    // Reviewing one player: skip the pickers and show only their notes.
    if (coachReviewPlayerId) {
      const side =
        coachForceSide === 1 || coachForceSide === 2
          ? coachForceSide
          : coachTeam === 1 || coachTeam === 2
            ? coachTeam
            : 1;
      await enableCoachForTeam(side || 1, { players: [coachReviewPlayerId] });
      return;
    }
    // Already analyzed: skip team pick, still choose which players to watch.
    if (await demoAlreadyCoached()) {
      const side =
        coachForceSide === 1 || coachForceSide === 2
          ? coachForceSide
          : coachTeam === 1 || coachTeam === 2
            ? coachTeam
            : 1;
      showCoachPlayerStep(side, { lockedTeam: true });
      return;
    }
    showCoachPick();
  });

  coachPickT1?.addEventListener('click', () => showCoachPlayerStep(1));
  coachPickT2?.addEventListener('click', () => showCoachPlayerStep(2));
  coachPickBack?.addEventListener('click', () => {
    if (coachPickTeamLocked) {
      hideCoachPick();
      return;
    }
    showCoachTeamStep();
  });
  coachPickAll?.addEventListener('click', () => {
    coachPickPlayerList
      ?.querySelectorAll('input[type="checkbox"][data-player-id]')
      .forEach((el) => {
        el.checked = true;
      });
  });
  coachPickGo?.addEventListener('click', async () => {
    const team = pendingCoachTeam;
    if (team !== 1 && team !== 2) return;
    let players = selectedCoachPlayerIds();
    if (!players.length) {
      players = rosterForCoachTeam(team).map((p) => p.id);
    }
    await enableCoachForTeam(team, { players });
  });
  el.querySelector('#rv-coach-pick-close')?.addEventListener('click', () => hideCoachPick());

  /**
   * Coach flags become notes in the round's own list, so they persist and can
   * be marked exactly like anything a person wrote. Existing coach notes are
   * left alone: a flag that has already been reviewed keeps its verdict.
   * Only the selected roster team's mistakes are written.
   */
  async function mergeCoachNotesFor(index) {
    if (!coachAvailable) return;
    if (coachTeam !== 1 && coachTeam !== 2) return;
    if (index < 0 || index >= files.length) return;
    const file = files[index];
    if (!file) return;

    try {
      let meta =
        index === activeIndex && activeMeta?.players?.length ? activeMeta : await metaFor(file);
      if (!store.get(file)?.full) await store.loadFull(file);
      if (destroyed || !coachOn) return;
      if (!meta?.players?.length) return;
      if (!store.get(file)?.full) return;

      const mapCode = String(meta.map || '').toUpperCase();
      if (mapCode && coachSmokesMap !== mapCode) {
        await ensureCoachSmokes(mapCode);
        coachCache.delete(file);
      }

      const result = coachFor(index, meta);
      if (!result) return;

      const teamOf = new Map((meta.players || []).map((p) => [p.id, p.team]));
      const existing =
        index === activeIndex && roundNotes.length ? roundNotes : notesFromMeta(meta);
      const have = new Set(existing.filter((n) => n.kind === 'coach').map((n) => n.id));
      // Only the selected roster team's mistakes are written.
      const fresh = result.flags
        .filter((f) => teamOf.get(f.playerId) === coachTeam)
        .map(flagToNote)
        .filter((n) => !have.has(n.id));

      const next = fresh.length
        ? [...existing, ...fresh].sort((a, b) => a.tick - b.tick || a.updatedAt - b.updatedAt)
        : existing;

      meta.notes = next;
      delete meta.note;
      delete meta.noteUpdatedAt;
      setCoachNoted(file, next);

      if (index === activeIndex) {
        roundNotes = next;
        activeMeta = meta;
        ensureReviewFocus();
        const vis = visibleNoteIndices();
        if (!vis.length) noteIndex = -1;
        else if (!vis.includes(noteIndex)) noteIndex = vis[0];
        renderNoteDock();
        renderActiveMarks();
        if (fresh.length) {
          try {
            await persistNotes();
          } catch {
            /* notes still show for this session even if the save failed */
          }
        } else {
          syncCoachRoundChips();
        }
        return;
      }

      if (!fresh.length) {
        syncCoachRoundChips();
        return;
      }

      const payload = next
        .map((n) => ({
          id: n.id,
          tick: n.tick,
          text: String(n.text || '').trim(),
          kind: n.kind === 'coach' ? 'coach' : 'user',
          mark: n.mark || '',
          playerId: n.playerId || '',
          rule: n.rule || '',
          updatedAt: n.updatedAt || Date.now()
        }))
        .filter((n) => n.text);
      try {
        const res = await saveRoundNotes(file, payload);
        const saved = Array.isArray(res.notes)
          ? notesFromMeta({ notes: res.notes })
          : notesFromMeta({ notes: payload });
        meta.notes = saved;
        setCoachNoted(file, saved);
      } catch {
        /* keep local merge for strip marking */
      }
      syncCoachRoundChips();
    } catch {
      /* one bad round must not abort the full-match scan */
    }
  }

  /**
   * When coach turns on: load EVERY round's full ticks first, then analyse.
   * Never interleave those phases — analysing before the match is resident is
   * what left later rounds unmarked until you clicked them.
   */
  async function analyseAllCoachRounds() {
    if (!coachAvailable) return;
    const pass = ++coachPassId;
    const total = files.length;

    // Phase 1 — preload only.
    for (let i = 0; i < total; i++) {
      if (destroyed || !coachOn || pass !== coachPassId) return;
      if (loadingEl) {
        loadingEl.hidden = false;
        loadingEl.textContent = `Coach loading ${i + 1}/${total}…`;
      }
      try {
        await store.loadFull(files[i]);
      } catch {
        /* retry once below */
      }
      if (!store.get(files[i])?.full) {
        try {
          await store.loadFull(files[i]);
        } catch {
          /* analysed phase will skip if still missing */
        }
      }
    }
    if (destroyed || !coachOn || pass !== coachPassId) return;

    // Phase 2 — analyse only after every load attempt finished.
    for (let i = 0; i < total; i++) {
      if (destroyed || !coachOn || pass !== coachPassId) return;
      if (loadingEl) {
        loadingEl.hidden = false;
        loadingEl.textContent = `Coach analysing ${i + 1}/${total}…`;
      }
      await mergeCoachNotesFor(i);
    }
    if (pass !== coachPassId) return;
    syncCoachRoundChips();
    syncLoading();
  }

  /**
   * Turning coach off drops every coach note in this demo. User notes stay.
   */
  async function clearAllCoachNotes() {
    flushNoteText();
    coachCache.clear();
    coachTeam = null;
    coachFocusPlayers = null;
    cancelViewAnim();
    coachNotedFiles.clear();
    syncCoachRoundChips();

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
      setCoachNoted(file, next);
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
    coachNotedFiles.clear();
    syncCoachRoundChips();
  }

  // ---- frame --------------------------------------------------------------

  function onPosition(pos) {
    let at = pos;
    let loc = sequence.locate(at);
    // Scrub is clamped to one round; ignore any stray cross-round position.
    if (scrubbing && scrubRoundIndex >= 0 && loc.index !== scrubRoundIndex) {
      const item = sequence.at(scrubRoundIndex);
      if (item) {
        at = sequence.offsetOf(scrubRoundIndex) + roundLocalMax(item);
        playback.seek(at, { emit: false });
        loc = sequence.locate(at);
      }
    }
    const live = liveOffsetOf(loc.index);
    // Entering a round (or playing through freezetime) jumps to live, unless a
    // drag put the position in the buy on purpose.
    if (playback.playing && freezeSkip && at < live) {
      playback.seek(live, { emit: false });
      at = live;
      loc = sequence.locate(live);
    }
    if (loc.index !== activeIndex) {
      // Playing: keep wall-clock position (freezetime skip above). Paused seek
      // across a boundary (e.g. nudge) lands at the next round's entry instead
      // of leaving the scrubber pinned at 100% and chaining advances.
      selectRound(loc.index, { seek: !playback.playing });
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

    const pov = povFrameFor(tick);
    const zoneOverlay = zoneOverlayForTick(tick);
    const duelOverlayFrame = duelOverlayForTick(tick, pov);
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
      hideDeaths: false,
      zoneOverlay,
      duelOverlay: duelOverlayFrame,
      pov
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
    syncDuelFeed(duelOverlayFrame);
    if (chartOn) syncWinChart(tick);
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
    if (!playback.playing && freezeSkip && playback.position < live) {
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
  //
  // The measurement is also published as --rv-chrome-h: the narrow layout puts
  // the rosters under the map, where the chrome would cover them, so the stage
  // turns this into bottom padding. Once it does, the map box already stops
  // above the chrome and insetting the drawing again would only shrink the
  // radar into the top of an empty box.
  function syncChromeInset() {
    const chromeH = chromeEl.offsetHeight;
    el.style.setProperty('--rv-chrome-h', `${chromeH}px`);
    const stageH = el.querySelector('.rv-stage')?.clientHeight || 0;
    // Stacked + sidebars: chrome sits over the roster row (padding), not the map.
    // Stacked + sidebars hidden (mobile coach): map fills; chrome overlays it.
    const rosterRow = stackedQuery.matches && !el.classList.contains('rosters-hidden');
    const overlap = rosterRow
      ? 0
      : Math.max(0, Math.min(chromeH - 12, stageH * 0.35));
    if (renderer.viewInset.bottom !== overlap) {
      renderer.viewInset.bottom = overlap;
      return true;
    }
    return false;
  }

  const onStackedChange = () => {
    syncRostersLayout();
  };
  if (typeof stackedQuery.addEventListener === 'function') {
    stackedQuery.addEventListener('change', onStackedChange);
  } else {
    stackedQuery.addListener?.(onStackedChange);
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

  async function restorePersistedCoach() {
    if (!coachAvailable || destroyed) return;
    let side = coachForceSide === 1 || coachForceSide === 2 ? coachForceSide : 0;
    let should = Boolean(coachAutoEnable);
    if (!should || !side) {
      try {
        const teams = await fetchTeams().catch(() => []);
        const list = Array.isArray(teams) ? teams : teams?.teams || [];
        const meta = activeMeta || rounds[0] || {};
        const n1 = teamNameKey(meta.team1?.name || '');
        const n2 = teamNameKey(meta.team2?.name || '');
        for (const t of list) {
          const key = teamNameKey(t.name);
          if (!key) continue;
          const entry = t.autocoach?.demos?.[statsDemoId];
          if (entry && (key === n1 || key === n2)) {
            should = true;
            side = entry.side === 2 ? 2 : 1;
            break;
          }
          if (coachTeamId && t.id === coachTeamId && (key === n1 || key === n2)) {
            should = true;
            side = key === n1 ? 1 : 2;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!should && (await demoAlreadyCoached())) {
      should = true;
      side = side || 1;
    }
    if (!should || destroyed) return;
    const players = coachReviewPlayerId ? [coachReviewPlayerId] : null;
    await enableCoachForTeam(side || 1, { players });
  }

  (async () => {
    // buildSequence → selectRound(0) full-loads round 1 and starts the
    // background prefetch of the rest behind it.
    syncRostersLayout();
    syncChromeInset();
    loadPlaylists();
    await buildSequence();
    await restorePersistedCoach();
  })();

  return {
    el,
    destroy() {
      destroyed = true;
      if (noteSaveTimer) {
        clearTimeout(noteSaveTimer);
        noteSaveTimer = 0;
      }
      cancelViewAnim();
      playback.destroy();
      // The store outlives this view (the mode switch reuses it), so retire the
      // prefetch rather than clearing what it loaded.
      store.stopWarm();
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
      mapCanvas?.removeEventListener('pointermove', onMapGraphPointerMove);
      mapCanvas?.removeEventListener('pointerleave', onMapGraphPointerLeave);
    }
  };
}
