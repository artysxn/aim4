// ---------------------------------------------------------------------------
// replays/viewer/analyzerViewer.js
// Overlay every selected round on one radar, synced from freezetime end.
// Requires a shared map + focus team; filters by that team's T/CT side, buy,
// players (each with a fixed color), and utility visibility.
// Zoom/pan, hover full-round preview, click-to-open, box-select → Timeline.
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchZones } from '../api.js';
import { findRoundDecided } from '../coach/roundDecided.js';
import { ECONOMIES, buyBucket, econHasAwp, economyLabel, isEqualBuyRound } from '../shared/roundId.js';
import { openingSituation } from '../shared/openingSituation.js';
import { iconImgHtml, isGrenade } from './equipmentIcons.js';
import { RADAR_SIZE, worldToRadar } from './mapCalibration.js';
import { RadarRenderer, grenadeWorldPos } from './radarRenderer.js';
import { Playback } from './playback.js';
import { clockAt, timingFor } from './roundClock.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const DRAG_THRESHOLD = 5;
/** Selected rounds at rest — fully drawn, then blitted dim. */
const SELECTION_GHOST_ALPHA = 0.3;
/** Heatmap intensity resolution (matches radar for crisp upscale). */
const HEAT_RES = 1024;
/** Small white stamp radius in radar px; blur does the soft falloff. */
const HEAT_STAMP_R = 5;

/** Most-played players on the focus team. */
const PRIMARY_COLORS = ['#e8913c', '#5ad17a', '#5b9fd4', '#a855f7', '#e8b84a'];
/** Stand-ins / least-played extras. */
const RESERVE_COLORS = ['#8B4513', '#800000', '#1e3a8a', '#808080', '#c43c3c'];

const BUY_OPTIONS = ECONOMY_CODES_SAFE();

function ECONOMY_CODES_SAFE() {
  return Object.keys(ECONOMIES).map(Number);
}

/**
 * @param {object} opts
 * @param {import('../tickStore.js').TickStore} opts.store
 * @param {object[]} opts.rounds
 * @param {(s: string) => string} opts.escapeHtml
 * @param {string} [opts.focusTeam]  short id of the team being analyzed
 * @param {string[]} [opts.focusTeamIds] aliases for the focus team (cluster)
 * @param {string} [opts.focusName]  display name for the focus team
 * @param {Array<{key?:string,focusTeam:string,focusTeamIds:string[],name:string}>} [opts.teamOptions]
 */
export function createAnalyzerViewer({
  store,
  rounds,
  escapeHtml,
  focusTeam = '',
  focusTeamIds = [],
  focusName: focusNameOpt = '',
  teamOptions: teamOptionsOpt = []
}) {
  const el = document.createElement('div');
  el.className = 'rv-analyzer';
  el.innerHTML = `
    <div class="rv-analyzer-stage">
      <aside class="rv-analyzer-panel" id="rv-az-panel">
        <div class="rv-analyzer-team" id="rv-az-team">Loading…</div>
        <div class="rv-analyzer-filters" id="rv-az-filters" hidden></div>
      </aside>
      <div class="rv-analyzer-map" id="rv-az-map">
        <canvas id="rv-az-canvas"></canvas>
        <div class="rv-analyzer-clock" id="rv-az-clock">1:55</div>
        <div class="rv-az-marquee" id="rv-az-marquee" hidden></div>
        <div class="rv-az-tip" id="rv-az-tip" hidden></div>
      </div>
      <aside class="rv-analyzer-selected" id="rv-az-selected">
        <ul class="rv-az-sel-list" id="rv-az-sel-list"></ul>
        <p class="rv-az-sel-summary" id="rv-az-sel-summary" hidden></p>
        <button type="button" class="rv-az-replay" id="rv-az-replay" disabled>
          <svg viewBox="0 -960 960 960" width="16" height="16"><path d="M320-200v-560l440 280-440 280Z"/></svg>
          Replay all
        </button>
      </aside>
    </div>
    <div class="rv-analyzer-bar">
      <span class="rv-analyzer-count" id="rv-az-count">${rounds.length} rounds</span>
      <button type="button" class="rv-speed" id="rv-az-speed">x1</button>
      <button type="button" class="rv-play" id="rv-az-play" aria-label="Play">
        <svg viewBox="0 -960 960 960" width="18" height="18"><path d="M320-200v-560l440 280-440 280Z"/></svg>
      </button>
      <div class="rv-scrub" id="rv-az-scrub">
        <div class="rv-scrub-track"><div class="rv-scrub-fill" id="rv-az-fill"></div></div>
        <div class="rv-scrub-handle" id="rv-az-handle"></div>
      </div>
      <span class="rv-analyzer-load" id="rv-az-load"></span>
    </div>`;

  const panelEl = el.querySelector('#rv-az-filters');
  const teamEl = el.querySelector('#rv-az-team');
  const countEl = el.querySelector('#rv-az-count');
  const clockEl = el.querySelector('#rv-az-clock');
  const loadEl = el.querySelector('#rv-az-load');
  const playBtn = el.querySelector('#rv-az-play');
  const speedBtn = el.querySelector('#rv-az-speed');
  const scrubEl = el.querySelector('#rv-az-scrub');
  const fillEl = el.querySelector('#rv-az-fill');
  const handleEl = el.querySelector('#rv-az-handle');
  const mapEl = el.querySelector('#rv-az-map');
  const canvas = el.querySelector('#rv-az-canvas');
  const marqueeEl = el.querySelector('#rv-az-marquee');
  const tipEl = el.querySelector('#rv-az-tip');
  const selListEl = el.querySelector('#rv-az-sel-list');
  const selSummaryEl = el.querySelector('#rv-az-sel-summary');
  const replayBtn = el.querySelector('#rv-az-replay');

  const renderer = new RadarRenderer(canvas);
  renderer.showNames = false;
  renderer.showWeapons = false;
  renderer.onIconLoad = () => draw(playback.position);

  // Offscreen round compositor for selection ghost / focus blits.
  const ghostCanvas = document.createElement('canvas');
  const ghostRenderer = new RadarRenderer(ghostCanvas);
  ghostRenderer.showNames = true;
  ghostRenderer.showWeapons = true;
  ghostRenderer.onIconLoad = () => draw(playback.position);

  /** @type {Array<{round: object, meta: object|null, timing: object, states: Array}>} */
  const layers = rounds.map((round) => ({
    round,
    meta: null,
    timing: timingFor(round),
    states: []
  }));

  let destroyed = false;
  let speedIndex = 2;
  const focusIds = new Set(
    (focusTeamIds?.length ? focusTeamIds : focusTeam ? [focusTeam] : []).filter(Boolean)
  );
  let focusId = focusTeam || [...focusIds][0] || '';
  let focusName = focusNameOpt || '';
  /** @type {Array<{key:string,focusTeam:string,focusTeamIds:string[],name:string}>} */
  let teamOptions = normalizeTeamOptions(teamOptionsOpt);

  /** @type {'T'|'CT'} */
  let sideFilter = 'T';
  /** @type {Set<number>} */
  let buyFilter = new Set(BUY_OPTIONS);
  /** When true, focus team must have had an AWP (filename digit 5). */
  let hasAwpFilter = false;
  /** Situation chips: empty = any. Values: '5v4' | '4v4' | '4v5'. */
  /** @type {Set<string>} */
  let situationFilter = new Set();
  /** Result chips: empty = any. Values: 'won' | 'lost'. */
  /** @type {Set<string>} */
  let resultFilter = new Set();
  /** When true, only rounds where the bomb was planted. */
  let afterplantOnly = false;
  /**
   * Round-decided phase chips (zone network). Empty = off.
   * Values: 'early' | 'mid' | 'late'. Implies equal-buy rounds only.
   * @type {Set<string>}
   */
  let decidedPhaseFilter = new Set();
  /** Round-decided filters are always available (meta win% only). */
  let zoneNetworkReady = true;
  /** @type {'regular'|'heatmap'} */
  let viewMode = 'regular';
  /** Heatmap blur strength (slider); mapped to canvas Gaussian blur. */
  let heatmapSmooth = 18;
  /** @type {Set<string>} */
  let enabledPlayers = new Set();
  /** @type {Record<string, string>} */
  let playerColors = {};
  /** @type {{smoke:boolean,molotov:boolean,flash:boolean,he:boolean}} */
  let utilityVisible = { smoke: true, molotov: true, flash: true, he: true };

  /** Offscreen heat accumulation → blur → colorized layer. */
  const heatAcc = document.createElement('canvas');
  heatAcc.width = HEAT_RES;
  heatAcc.height = HEAT_RES;
  const heatAccCtx = heatAcc.getContext('2d');
  const heatBlur = document.createElement('canvas');
  heatBlur.width = HEAT_RES;
  heatBlur.height = HEAT_RES;
  const heatBlurCtx = heatBlur.getContext('2d', { willReadFrequently: true });
  const heatColor = document.createElement('canvas');
  heatColor.width = HEAT_RES;
  heatColor.height = HEAT_RES;
  const heatColorCtx = heatColor.getContext('2d');
  /** @type {Map<string, HTMLCanvasElement>} mapCode -> alpha mask of radar playable area */
  const radarMaskByMap = new Map();
  /** @type {{ key: string, canvas: HTMLCanvasElement } | null} */
  let heatLayerCache = null;

  /** Hit targets from the last overlay draw (screen CSS px relative to map). */
  /** @type {Array<{kind:'player'|'grenade', file:string, layer:object, playerId:string, name:string, roundNum:number, sx:number, sy:number, r:number}>} */
  let hitTargets = [];
  /** @type {typeof hitTargets[0] | null} */
  let hoverHit = null;
  /** Round file hovered in the right-hand selection list (same focus as canvas). */
  let menuHoverFile = '';
  /** Last pointer position over the map (client coords), for tip revalidation. */
  let lastMapPointer = null;
  /** Selected round files (order = selection order). */
  /** @type {string[]} */
  let selectedFiles = [];

  // Seconds since freezetime end (live), shared across every round.
  const playback = new Playback((pos) => draw(pos));

  function liveSeconds(timing) {
    return Math.max(1, (timing.officialEndTick - timing.freezeEndTick) / timing.tickRate);
  }

  function longestLive() {
    return layers.reduce((max, L) => Math.max(max, liveSeconds(L.timing)), 1);
  }

  function shortTeamId(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.id || '';
  }

  function teamDisplayName(value, fallback = '') {
    if (!value) return fallback;
    if (typeof value === 'string') return value;
    return value.name || value.id || fallback;
  }

  function isFocusId(id) {
    return Boolean(id && (id === focusId || focusIds.has(id)));
  }

  /** List-round ids win: filename tokens are what the library filtered on. */
  function rosterIds(L) {
    const meta = L.meta || {};
    return {
      t1: L.round?.team1 || shortTeamId(meta.team1) || '',
      t2: L.round?.team2 || shortTeamId(meta.team2) || ''
    };
  }

  function teamIndex(meta, listRound) {
    if ((!focusId && !focusIds.size) || !meta) return 0;
    const t1 = listRound?.team1 || shortTeamId(meta.team1) || '';
    const t2 = listRound?.team2 || shortTeamId(meta.team2) || '';
    if (isFocusId(t1)) return 1;
    if (isFocusId(t2)) return 2;
    return 0;
  }

  function sideForIndex(meta, idx) {
    if (idx === 1 && (meta.team1Side === 'T' || meta.team1Side === 'CT')) return meta.team1Side;
    if (idx === 2 && (meta.team2Side === 'T' || meta.team2Side === 'CT')) return meta.team2Side;
    if (idx === 1 && (meta.team2Side === 'T' || meta.team2Side === 'CT')) {
      return meta.team2Side === 'T' ? 'CT' : 'T';
    }
    if (idx === 2 && (meta.team1Side === 'T' || meta.team1Side === 'CT')) {
      return meta.team1Side === 'T' ? 'CT' : 'T';
    }
    const round = Number(meta.round) || Number(meta.roundNum) || 1;
    const team1IsT = round <= 12;
    if (idx === 1) return team1IsT ? 'T' : 'CT';
    if (idx === 2) return team1IsT ? 'CT' : 'T';
    return '';
  }

  function sideOfFocus(L) {
    if (!L.meta) return '';
    const idx = teamIndex(L.meta, L.round);
    if (!idx) return '';
    return sideForIndex(L.meta, idx);
  }

  function econOfFocus(L) {
    if (!L.meta) return null;
    const idx = teamIndex(L.meta, L.round);
    if (idx === 1) return L.meta.econ1;
    if (idx === 2) return L.meta.econ2;
    return null;
  }

  /** Focus team won / lost this round (`''` if unknown). */
  function resultOfFocus(L) {
    if (!L.meta?.winner) return '';
    const idx = teamIndex(L.meta, L.round);
    if (!idx) return '';
    return L.meta.winner === idx ? 'won' : 'lost';
  }

  function isAfterplant(L) {
    if (!L.meta) return false;
    if (L.meta.plantTick != null && Number.isFinite(L.meta.plantTick)) return true;
    return (L.meta.events?.bomb || []).some((b) => b.type === 'planted');
  }

  /** Cached on the layer after meta load (`null` = not equal-buy / not decided). */
  function decidedOf(L) {
    if (!L.meta) return null;
    if (L.decided !== undefined) return L.decided;
    L.decided = findRoundDecided(L.meta);
    return L.decided;
  }

  /**
   * Opening man-advantage for the focus team over the next 3 seconds
   * (see `openingSituation`). Empty when the focus team is unknown.
   */
  function situationOfFocus(L) {
    if (!L.meta) return '';
    const idx = teamIndex(L.meta, L.round);
    if (!idx) return '';
    return openingSituation(L.meta, idx);
  }

  function focusDisplayName(meta, idx) {
    if (idx === 1) {
      return (typeof meta.team1 === 'object' ? meta.team1?.name : null) || focusNameOpt || focusId;
    }
    if (idx === 2) {
      return (typeof meta.team2 === 'object' ? meta.team2?.name : null) || focusNameOpt || focusId;
    }
    return focusNameOpt || focusId;
  }

  function opponentName(L) {
    if (!L.meta) return '—';
    const idx = teamIndex(L.meta, L.round);
    if (idx === 1) return teamDisplayName(L.meta.team2, L.round.team2 || 'Opponent');
    if (idx === 2) return teamDisplayName(L.meta.team1, L.round.team1 || 'Opponent');
    return '—';
  }

  function roundNum(L) {
    return Number(L.round?.round ?? L.meta?.round ?? L.meta?.roundNum ?? 0) || 0;
  }

  function normalizeTeamOptions(list) {
    if (!Array.isArray(list) || !list.length) return [];
    return list
      .map((o) => ({
        key: o.key || o.focusTeam || '',
        focusTeam: o.focusTeam || (o.focusTeamIds && o.focusTeamIds[0]) || '',
        focusTeamIds: [...(o.focusTeamIds || []).filter(Boolean)],
        name: o.name || o.focusTeam || ''
      }))
      .filter((o) => o.focusTeam || o.focusTeamIds.length);
  }

  /** Common short-ids across all rounds (list-round ids preferred). */
  function commonShortIds() {
    let common = null;
    for (const L of layers) {
      const { t1, t2 } = rosterIds(L);
      const ids = new Set([t1, t2].filter(Boolean));
      if (!ids.size) continue;
      if (!common) common = ids;
      else common = new Set([...common].filter((id) => ids.has(id)));
    }
    return [...(common || [])];
  }

  function nameForShortId(id) {
    for (const L of layers) {
      if (!L.meta) continue;
      const { t1, t2 } = rosterIds(L);
      if (t1 === id) return teamDisplayName(L.meta.team1, id);
      if (t2 === id) return teamDisplayName(L.meta.team2, id);
    }
    return id;
  }

  /** Fill teamOptions from rounds when the library did not pass any. */
  function ensureTeamOptions() {
    if (teamOptions.length) return;
    const common = commonShortIds();
    teamOptions = common.map((id) => ({
      key: id,
      focusTeam: id,
      focusTeamIds: [id],
      name: nameForShortId(id)
    }));
  }

  function applyFocusOption(opt) {
    focusIds.clear();
    for (const id of opt.focusTeamIds?.length ? opt.focusTeamIds : [opt.focusTeam]) {
      if (id) focusIds.add(id);
    }
    focusId = opt.focusTeam || [...focusIds][0] || '';
    focusName = opt.name || focusId;
    for (const L of layers) {
      const { t1, t2 } = rosterIds(L);
      if (isFocusId(t1)) focusIds.add(t1);
      if (isFocusId(t2)) focusIds.add(t2);
    }
  }

  /** Resolve focus when unambiguous; leave empty when the user must pick. */
  function resolveFocusFromMeta() {
    ensureTeamOptions();

    for (const L of layers) {
      const { t1, t2 } = rosterIds(L);
      if (isFocusId(t1)) focusIds.add(t1);
      if (isFocusId(t2)) focusIds.add(t2);
    }
    if (!focusId && focusIds.size) focusId = [...focusIds][0];

    if (!focusId && !focusIds.size) {
      if (teamOptions.length === 1) applyFocusOption(teamOptions[0]);
      else {
        const common = commonShortIds();
        if (common.length === 1) {
          applyFocusOption({
            key: common[0],
            focusTeam: common[0],
            focusTeamIds: [common[0]],
            name: nameForShortId(common[0])
          });
        }
      }
    }

    if (focusId && !focusName) {
      const opt = teamOptions.find(
        (o) => o.focusTeam === focusId || o.focusTeamIds.includes(focusId)
      );
      if (opt) focusName = opt.name;
      else {
        const sample = layers.find((L) => L.meta && teamIndex(L.meta, L.round));
        if (sample?.meta) {
          focusName = focusDisplayName(sample.meta, teamIndex(sample.meta, sample.round));
        } else {
          focusName = focusId;
        }
      }
    }
  }

  function needsTeamPick() {
    return !focusId;
  }

  function renderTeamPicker() {
    teamEl.textContent = 'Select team';
    panelEl.hidden = false;
    ensureTeamOptions();
    const opts = teamOptions.length
      ? teamOptions
      : commonShortIds().map((id) => ({
          key: id,
          focusTeam: id,
          focusTeamIds: [id],
          name: nameForShortId(id)
        }));
    if (!opts.length) {
      panelEl.innerHTML = `<p class="rv-az-empty">No shared team across these rounds.</p>`;
      return;
    }
    panelEl.innerHTML = `
      <div class="rv-az-group">
        <h4>Team</h4>
        <p class="rv-az-pick-hint">These rounds share more than one team. Choose which side to analyze.</p>
        <div class="rv-az-seg rv-az-teams">
          ${opts
            .map(
              (o) => `
            <button type="button" class="rv-az-seg-btn rv-az-team-pick" data-team-key="${escapeHtml(
              o.key || o.focusTeam
            )}">${escapeHtml(o.name || o.focusTeam)}</button>`
            )
            .join('')}
        </div>
      </div>`;
  }

  function finishFocusSetup() {
    const matched = layers.filter((L) => L.meta && teamIndex(L.meta, L.round));
    if (!matched.length) {
      teamEl.textContent = focusName || focusId || 'Team';
      panelEl.hidden = false;
      panelEl.innerHTML = `<p class="rv-az-empty">Could not match that team to these rounds.</p>`;
      draw(0);
      return;
    }

    const tN = layers.filter((L) => L.meta && sideOfFocus(L) === 'T').length;
    const ctN = layers.filter((L) => L.meta && sideOfFocus(L) === 'CT').length;
    sideFilter = tN >= ctN ? 'T' : 'CT';
    if (!tN && !ctN) sideFilter = 'T';

    assignStablePlayerColors();
    resetPlayersForSide();
    renderFilters();
    renderSelectedPanel();
    playback.setDuration(longestLive());
    playback.seek(0);
    draw(0);
  }

  /** Stable palette for every focus-team player (both sides). Assigned once. */
  function assignStablePlayerColors() {
    /** @type {Map<string, {id:string,name:string,count:number}>} */
    const byId = new Map();
    for (const L of layers) {
      if (!L.meta) continue;
      const idx = teamIndex(L.meta, L.round);
      if (!idx) continue;
      for (const p of L.meta.players || []) {
        if (p.team !== idx) continue;
        const cur = byId.get(p.id) || { id: p.id, name: p.name || p.id, count: 0 };
        cur.count += 1;
        if (p.name) cur.name = p.name;
        byId.set(p.id, cur);
      }
    }
    const ranked = [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    playerColors = {};
    ranked.forEach((p, i) => {
      if (i < PRIMARY_COLORS.length) playerColors[p.id] = PRIMARY_COLORS[i];
      else {
        const r = i - PRIMARY_COLORS.length;
        playerColors[p.id] = RESERVE_COLORS[r % RESERVE_COLORS.length];
      }
    });
  }

  function rankedPlayersForSide() {
    /** @type {Map<string, {id:string,name:string,count:number}>} */
    const byId = new Map();
    for (const L of layers) {
      if (!L.meta) continue;
      if (sideOfFocus(L) !== sideFilter) continue;
      const idx = teamIndex(L.meta, L.round);
      if (!idx) continue;
      for (const p of L.meta.players || []) {
        if (p.team !== idx) continue;
        const cur = byId.get(p.id) || { id: p.id, name: p.name || p.id, count: 0 };
        cur.count += 1;
        if (p.name) cur.name = p.name;
        byId.set(p.id, cur);
      }
    }
    return [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function resetPlayersForSide() {
    const ranked = rankedPlayersForSide();
    enabledPlayers = new Set(ranked.map((p) => p.id));
    return ranked;
  }

  function buySelectValue() {
    if (buyFilter.size === BUY_OPTIONS.length) return 'all';
    if (buyFilter.size === 1) return String([...buyFilter][0]);
    return 'all';
  }

  /** Heatmap mode always inspects exactly one player. */
  function ensureHeatmapPlayer(ranked = rankedPlayersForSide()) {
    if (viewMode !== 'heatmap') return;
    const kept = [...enabledPlayers].filter((id) => ranked.some((p) => p.id === id));
    if (kept.length === 1) {
      enabledPlayers = new Set(kept);
      return;
    }
    const pick = kept[0] || ranked[0]?.id;
    enabledPlayers = pick ? new Set([pick]) : new Set();
  }

  function heatmapPlayerId() {
    if (enabledPlayers.size !== 1) return '';
    return [...enabledPlayers][0];
  }

  /**
   * Whether a layer passes the current filters. Pass `ignoreX` so chip counts
   * reflect rounds remaining under every *other* constraint.
   */
  function matchesFilters(
    L,
    {
      side = sideFilter,
      ignoreBuy = false,
      ignoreAwp = false,
      ignoreSituation = false,
      ignoreResult = false,
      ignoreAfterplant = false,
      ignoreDecided = false
    } = {}
  ) {
    if (!L.meta) return false;
    if (sideOfFocus(L) !== side) return false;
    const econ = econOfFocus(L);
    if (!ignoreBuy && (econ == null || !buyFilter.has(buyBucket(econ)))) return false;
    if (!ignoreAwp && hasAwpFilter && !econHasAwp(econ)) return false;
    if (!ignoreSituation && situationFilter.size) {
      const sit = situationOfFocus(L);
      if (!sit || !situationFilter.has(sit)) return false;
    }
    if (!ignoreResult && resultFilter.size) {
      const res = resultOfFocus(L);
      if (!res || !resultFilter.has(res)) return false;
    }
    if (!ignoreAfterplant && afterplantOnly && !isAfterplant(L)) return false;
    if (!ignoreDecided && zoneNetworkReady && decidedPhaseFilter.size) {
      if (!isEqualBuyRound(L.meta.econ1, L.meta.econ2)) return false;
      const d = decidedOf(L);
      if (!d || !decidedPhaseFilter.has(d.phase)) return false;
    }
    return true;
  }

  function renderFilters() {
    const ranked = rankedPlayersForSide();
    enabledPlayers = new Set([...enabledPlayers].filter((id) => ranked.some((p) => p.id === id)));
    if (viewMode === 'heatmap') ensureHeatmapPlayer(ranked);
    else if (!enabledPlayers.size) enabledPlayers = new Set(ranked.map((p) => p.id));

    // Counts ignore their own chip group so numbers show what remains if you pick them.
    const tCount = layers.filter((L) => matchesFilters(L, { side: 'T' })).length;
    const ctCount = layers.filter((L) => matchesFilters(L, { side: 'CT' })).length;
    const sitCount = (key) =>
      layers.filter(
        (L) => matchesFilters(L, { ignoreSituation: true }) && situationOfFocus(L) === key
      ).length;
    const wonCount = layers.filter(
      (L) => matchesFilters(L, { ignoreResult: true }) && resultOfFocus(L) === 'won'
    ).length;
    const lostCount = layers.filter(
      (L) => matchesFilters(L, { ignoreResult: true }) && resultOfFocus(L) === 'lost'
    ).length;
    const plantCount = layers.filter(
      (L) => matchesFilters(L, { ignoreAfterplant: true }) && isAfterplant(L)
    ).length;
    const decidedCount = (phase) =>
      layers.filter(
        (L) =>
          matchesFilters(L, { ignoreDecided: true }) &&
          isEqualBuyRound(L.meta.econ1, L.meta.econ2) &&
          decidedOf(L)?.phase === phase
      ).length;
    teamEl.textContent = focusName || focusId || 'Team';

    const teamSwitcher =
      teamOptions.length > 1
        ? `<div class="rv-az-group">
        <h4>Team</h4>
        <div class="rv-az-seg rv-az-teams">
          ${teamOptions
            .map((o) => {
              const active =
                o.focusTeam === focusId || o.focusTeamIds.some((id) => focusIds.has(id));
              return `<button type="button" class="rv-az-seg-btn rv-az-team-pick${
                active ? ' active' : ''
              }" data-team-key="${escapeHtml(o.key || o.focusTeam)}">${escapeHtml(
                o.name || o.focusTeam
              )}</button>`;
            })
            .join('')}
        </div>
      </div>`
        : '';

    const utilIcons = [
      { key: 'smoke', weapon: 'smokegrenade', title: 'Smokes' },
      { key: 'molotov', weapon: 'molotov', title: 'Molotovs' },
      { key: 'flash', weapon: 'flashbang', title: 'Flashes' },
      { key: 'he', weapon: 'hegrenade', title: 'HE' }
    ];

    const sitBtn = (key, label) =>
      `<button type="button" class="rv-az-seg-btn${
        situationFilter.has(key) ? ' active' : ''
      }" data-situation="${key}" title="${label}">${label} <small>${sitCount(key)}</small></button>`;

    panelEl.hidden = false;
    panelEl.innerHTML = `
      <div class="rv-az-group">
        <h4>View</h4>
        <div class="rv-az-seg" role="group" aria-label="Analyzer view">
          <button type="button" class="rv-az-seg-btn${
            viewMode === 'regular' ? ' active' : ''
          }" data-view="regular">Regular</button>
          <button type="button" class="rv-az-seg-btn${
            viewMode === 'heatmap' ? ' active' : ''
          }" data-view="heatmap">Heatmap</button>
        </div>
      </div>
      ${teamSwitcher}
      <div class="rv-az-group">
        <h4>Side</h4>
        <div class="rv-az-seg rv-az-sides">
          <button type="button" class="rv-az-seg-btn${sideFilter === 'T' ? ' active' : ''}" data-side="T">T <small>${tCount}</small></button>
          <button type="button" class="rv-az-seg-btn${sideFilter === 'CT' ? ' active' : ''}" data-side="CT">CT <small>${ctCount}</small></button>
        </div>
      </div>
      <div class="rv-az-group">
        <h4>Buy</h4>
        <select class="site-input rv-az-buy-select" id="rv-az-buy" aria-label="Buy type">
          <option value="all"${buySelectValue() === 'all' ? ' selected' : ''}>All buys</option>
          ${BUY_OPTIONS.map(
            (code) =>
              `<option value="${code}"${
                buySelectValue() === String(code) ? ' selected' : ''
              }>${escapeHtml(economyLabel(code))}</option>`
          ).join('')}
        </select>
        <label class="rp-awp-toggle${hasAwpFilter ? ' active' : ''}" title="Has AWP">
          <input type="checkbox" id="rv-az-awp" ${hasAwpFilter ? 'checked' : ''} aria-label="Has AWP" />
          <span>AWP</span>
        </label>
      </div>
      <div class="rv-az-group">
        <h4>Situation</h4>
        <div class="rv-az-seg rv-az-multi" role="group" aria-label="Opening situation">
          ${sitBtn('5v5', '5v5')}
          ${sitBtn('5v4', '5v4')}
          ${sitBtn('5v3', '5v3')}
          ${sitBtn('4v4', '4v4')}
          ${sitBtn('4v5', '4v5')}
          ${sitBtn('3v5', '3v5')}
        </div>
      </div>
      <div class="rv-az-group">
        <h4>Result</h4>
        <div class="rv-az-seg rv-az-multi" role="group" aria-label="Round result">
          <button type="button" class="rv-az-seg-btn${
            resultFilter.has('won') ? ' active' : ''
          }" data-result="won">Won <small>${wonCount}</small></button>
          <button type="button" class="rv-az-seg-btn${
            resultFilter.has('lost') ? ' active' : ''
          }" data-result="lost">Lost <small>${lostCount}</small></button>
        </div>
      </div>
      ${`<div class="rv-az-group">
        <h4>Round decided <span class="rv-az-hint">(equal buy)</span></h4>
        <div class="rv-az-seg rv-az-multi" role="group" aria-label="Round decided phase">
          <button type="button" class="rv-az-seg-btn${
            decidedPhaseFilter.has('early') ? ' active' : ''
          }" data-decided-phase="early" title="Decided in early round (before 1:15 and 5v5)">Early <small>${decidedCount(
            'early'
          )}</small></button>
          <button type="button" class="rv-az-seg-btn${
            decidedPhaseFilter.has('mid') ? ' active' : ''
          }" data-decided-phase="mid" title="Decided in mid round">Mid <small>${decidedCount(
            'mid'
          )}</small></button>
          <button type="button" class="rv-az-seg-btn${
            decidedPhaseFilter.has('late') ? ' active' : ''
          }" data-decided-phase="late" title="Decided in late round (0:40 or ≤3v3)">Late <small>${decidedCount(
            'late'
          )}</small></button>
        </div>
      </div>`}
      <div class="rv-az-group">
        <h4>Bomb</h4>
        <div class="rv-az-seg rv-az-multi" role="group" aria-label="Afterplant">
          <button type="button" class="rv-az-seg-btn${
            afterplantOnly ? ' active' : ''
          }" data-afterplant="1">Afterplant <small>${plantCount}</small></button>
        </div>
      </div>
      <div class="rv-az-group">
        <h4>Players${viewMode === 'heatmap' ? ' <span class="rv-az-hint">(pick one)</span>' : ''}</h4>
        <div class="rv-az-players">
          ${
            ranked.length
              ? ranked
                  .map((p) => {
                    const on = enabledPlayers.has(p.id);
                    return `
            <button type="button" class="rv-az-player${on ? ' selected' : ''}" data-player="${escapeHtml(
              p.id
            )}" aria-pressed="${on ? 'true' : 'false'}">
              <span class="rv-az-swatch" style="background:${playerColors[p.id]}"></span>
              <span class="rv-az-pname">${escapeHtml(p.name)}</span>
              <small>${p.count}</small>
            </button>`;
                  })
                  .join('')
              : `<p class="rv-az-empty">No players on ${sideFilter} for this team.</p>`
          }
        </div>
      </div>
      ${
        viewMode === 'heatmap'
          ? `<div class="rv-az-group">
        <h4>Blur <span class="rv-az-hint" id="rv-az-smooth-val">${heatmapSmooth}</span></h4>
        <input type="range" class="rv-az-smooth" id="rv-az-smooth" min="6" max="48" step="1" value="${heatmapSmooth}" aria-label="Heatmap blur" />
      </div>`
          : `<div class="rv-az-group">
        <h4>Utility</h4>
        <div class="rv-az-util-bar" role="group" aria-label="Utility">
          ${utilIcons
            .map(
              (u) => `
            <button type="button" class="rv-az-util-btn${
              utilityVisible[u.key] ? ' active' : ''
            }" data-util="${u.key}" title="${u.title}" aria-pressed="${
                utilityVisible[u.key] ? 'true' : 'false'
              }">${iconImgHtml(u.weapon, 'rv-az-util-icon')}</button>`
            )
            .join('')}
        </div>
      </div>`
      }`;
  }

  function pruneSelectionToVisible() {
    if (!selectedFiles.length) return;
    const ok = new Set(visibleLayers().map((L) => L.round.file));
    const next = selectedFiles.filter((f) => ok.has(f));
    if (next.length !== selectedFiles.length) {
      selectedFiles = next;
      renderSelectedPanel();
    }
  }

  function visibleLayers() {
    return layers.filter((L) => matchesFilters(L));
  }

  function filterPlayers(L) {
    const idx = teamIndex(L.meta, L.round);
    return (L.meta.players || []).filter((p) => p.team === idx && enabledPlayers.has(p.id));
  }

  function filterEvents(meta, players) {
    const allow = new Set(players.map((p) => p.id));
    const events = meta.events || {};
    const grenades = (events.grenades || []).filter((g) => {
      if (!allow.has(g.player)) return false;
      if (!isGrenade(g.type)) return false;
      return true;
    });
    const kills = (events.kills || []).filter(
      (k) => allow.has(k.victim) || allow.has(k.attacker)
    );
    const shots = (events.shots || []).filter((s) => allow.has(s.player));
    return { ...events, grenades, kills, shots };
  }

  function layerByFile(file) {
    return layers.find((L) => L.round.file === file) || null;
  }

  function tickForLayer(L, pos) {
    return Math.min(
      L.timing.freezeEndTick + pos * L.timing.tickRate,
      L.timing.officialEndTick
    );
  }

  function cssFromCanvas(pt) {
    const rect = canvas.getBoundingClientRect();
    const { w, h } = renderer.resize();
    return {
      x: (pt.x / w) * rect.width,
      y: (pt.y / h) * rect.height
    };
  }

  function playerDeadAt(events, playerId, tick) {
    return (events?.kills || []).some((k) => k.victim === playerId && k.tick <= tick);
  }

  function pushPlayerHits(L, players, states, t, tick) {
    const hitR = 12;
    const events = L.meta?.events || {};
    for (const p of players) {
      const s = states[p.slot];
      if (!s?.alive || playerDeadAt(events, p.id, tick)) continue;
      const pt = renderer.project(t, s.x, s.y, { x: 0, y: 0 });
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      const css = cssFromCanvas(pt);
      hitTargets.push({
        kind: 'player',
        file: L.round.file,
        layer: L,
        playerId: p.id,
        name: p.name || p.id,
        roundNum: roundNum(L),
        sx: css.x,
        sy: css.y,
        r: hitR
      });
    }
  }

  function pushGrenadeHits(L, players, events, tick, t) {
    const allow = new Set(players.map((p) => p.id));
    for (const g of events?.grenades || []) {
      if (!allow.has(g.player) || !isGrenade(g.type)) continue;
      const throwTick = Number(g.throwTick);
      if (!Number.isFinite(throwTick) || tick < throwTick) continue;
      const pos = grenadeWorldPos(g, tick);
      if (!pos || !Number.isFinite(pos.x)) continue;
      const pt = renderer.project(t, pos.x, pos.y, { x: 0, y: 0 });
      const css = cssFromCanvas(pt);
      const thrower = players.find((p) => p.id === g.player);
      hitTargets.push({
        kind: 'grenade',
        file: L.round.file,
        layer: L,
        playerId: g.player,
        name: thrower?.name || g.player,
        roundNum: roundNum(L),
        sx: css.x,
        sy: css.y,
        r: 12
      });
    }
  }

  function syncGhostView() {
    ghostRenderer.mapCode = renderer.mapCode;
    ghostRenderer.image = renderer.image;
    ghostRenderer.zoom = renderer.zoom;
    ghostRenderer.panX = renderer.panX;
    ghostRenderer.panY = renderer.panY;
    ghostRenderer.viewInset = { ...renderer.viewInset };
    ghostRenderer.dpr = renderer.dpr;
  }

  /** Freeze each kill's world position at the death tick (once per round). */
  function freezeKillPositions(L) {
    const track = store.track(L.round.file);
    const kills = L.meta?.events?.kills;
    if (!kills?.length) return;
    const tmp = L._killSample || (L._killSample = []);
    for (const k of kills) {
      if (Number.isFinite(k._wx) && Number.isFinite(k._wy)) continue;
      if (track) {
        track.sampleAll(k.tick, tmp);
        const victim = (L.meta.players || []).find((p) => p.id === k.victim);
        const s = victim ? tmp[victim.slot] : null;
        if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) {
          k._wx = s.x;
          k._wy = s.y;
          continue;
        }
      }
      if (Number.isFinite(k.x) && Number.isFinite(k.y)) {
        k._wx = k.x;
        k._wy = k.y;
      }
    }
  }

  /**
   * Draw one full round. When `alpha` < 1, composite via offscreen so utility
   * and labels dim together. Kill marks are drawn separately at full opacity.
   * Hover focus uses default T/CT colors; multi-round ghosts keep analyzer swatches.
   */
  function renderFullRound(
    L,
    tick,
    { highlightId = '', alpha = 1, names = true, customColors = true } = {}
  ) {
    const track = store.track(L.round.file);
    if (!track) return false;
    freezeKillPositions(L);
    track.sampleAll(tick, L.states);
    const frame = {
      tick,
      tickRate: L.timing.tickRate,
      states: L.states,
      players: L.meta.players || [],
      allPlayers: L.meta.players || [],
      events: L.meta.events || {},
      weapons: L.meta.weapons || [],
      teamSides: { 1: L.meta.team1Side, 2: L.meta.team2Side },
      playerColors: customColors ? playerColors : undefined,
      highlight: highlightId || undefined,
      compact: false,
      clear: false,
      drawMap: false,
      // Marks painted in a later full-opacity pass so ghosts don't fade them.
      hideDeaths: true
    };

    if (alpha >= 0.99) {
      renderer.showNames = names;
      renderer.showWeapons = names;
      renderer.render(frame);
      return true;
    }

    const { w, h } = renderer.resize();
    syncGhostView();
    if (ghostCanvas.width !== w || ghostCanvas.height !== h) {
      ghostCanvas.width = w;
      ghostCanvas.height = h;
    }
    ghostRenderer.showNames = false;
    ghostRenderer.showWeapons = false;
    ghostRenderer.render({
      ...frame,
      clear: true,
      clearStyle: 'transparent',
      pixelSize: { w, h }
    });
    const ctx = renderer.ctx;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(ghostCanvas, 0, 0);
    ctx.restore();
    return true;
  }

  /** Full-opacity X/O for every kill/death up to `tick` (never ghosted). */
  function paintKillMarks(L, tick, players) {
    if (!L.meta) return;
    freezeKillPositions(L);
    const track = store.track(L.round.file);
    if (track) track.sampleAll(tick, L.states);
    renderer.render({
      tick,
      tickRate: L.timing.tickRate,
      states: L.states,
      players: players || L.meta.players || [],
      allPlayers: L.meta.players || [],
      events: L.meta.events || {},
      clear: false,
      drawMap: false,
      marksOnly: true,
      marksKey: L.round.file,
      compact: false
    });
  }

  function hideTip() {
    tipEl.classList.remove('is-on');
    tipEl.hidden = true;
    tipEl.setAttribute('aria-hidden', 'true');
    tipEl.textContent = '';
    tipEl.style.left = '';
    tipEl.style.top = '';
  }

  /** Live pointer only — never call from draw()/playback ticks (causes sticky tips). */
  function placeTip(hit) {
    if (!hit) {
      hideTip();
      return;
    }
    const rnd = String(hit.roundNum).padStart(2, '0');
    tipEl.innerHTML = `<strong>${escapeHtml(hit.name)}</strong><span>R${rnd}</span>`;
    const pad = 14;
    tipEl.style.left = `${hit.sx + pad}px`;
    tipEl.style.top = `${Math.max(8, hit.sy - 28)}px`;
    tipEl.hidden = false;
    tipEl.classList.add('is-on');
    tipEl.setAttribute('aria-hidden', 'false');
  }

  function clearHover() {
    const had = Boolean(hoverHit);
    hoverHit = null;
    hideTip();
    return had;
  }

  function clearSelection() {
    if (!selectedFiles.length) return;
    selectedFiles = [];
    clearHover();
    renderSelectedPanel();
    draw(playback.position);
  }

  function sampleOverlayHits(L, tick) {
    const track = store.track(L.round.file);
    if (!track) return null;
    track.sampleAll(tick, L.states);
    const players = filterPlayers(L);
    if (!players.length) return null;
    const events = filterEvents(L.meta, players);
    const { w, h } = renderer.resize();
    const t = renderer.viewTransform(w, h);
    pushPlayerHits(L, players, L.states, t, tick);
    pushGrenadeHits(L, players, events, tick, t);
    return { players, events };
  }

  function paintOverlayRound(L, tick, players, events) {
    freezeKillPositions(L);
    renderer.showNames = false;
    renderer.showWeapons = false;
    renderer.render({
      tick,
      tickRate: L.timing.tickRate,
      states: L.states,
      players,
      allPlayers: L.meta.players || players,
      events,
      weapons: L.meta.weapons || [],
      teamSides: { 1: L.meta.team1Side, 2: L.meta.team2Side },
      playerColors,
      utilityVisible,
      compact: false,
      clear: false,
      drawMap: false,
      hideBomb: true,
      hideTracers: false,
      hideDeaths: true
    });
  }

  /** White mask of playable radar pixels (drops black/transparent padding). */
  function radarPlayableMask(mapCode, img) {
    let mask = radarMaskByMap.get(mapCode);
    if (mask) return mask;
    const w = img.naturalWidth || img.width || RADAR_SIZE;
    const h = img.naturalHeight || img.height || RADAR_SIZE;
    mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    const ctx = mask.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] + d[i + 1] + d[i + 2];
      const on = d[i + 3] > 20 && lum > 36;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = on ? 255 : 0;
    }
    ctx.putImageData(imgData, 0, 0);
    radarMaskByMap.set(mapCode, mask);
    return mask;
  }

  /**
   * Gradient map for intensity 0..1 after blur.
   * Black (0) stays black so Screen blend hides the field background;
   * low = cold purple, high = hot yellow/white.
   */
  function heatColorAt(t) {
    const stops = [
      [0, 0, 0, 0],
      [0.08, 40, 0, 70],
      [0.22, 90, 10, 140],
      [0.4, 180, 20, 160],
      [0.58, 240, 50, 90],
      [0.75, 255, 130, 30],
      [0.9, 255, 220, 50],
      [1, 255, 250, 200]
    ];
    const x = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
    const a = stops[i];
    const b = stops[i + 1];
    const u = (x - a[0]) / Math.max(1e-6, b[0] - a[0]);
    const s = u * u * (3 - 2 * u);
    return [
      a[1] + (b[1] - a[1]) * s,
      a[2] + (b[2] - a[2]) * s,
      a[3] + (b[3] - a[3]) * s
    ];
  }

  /**
   * One radar point per visible round: the chosen player's position at the
   * current scrub tick (not a trail of earlier ticks).
   */
  function collectHeatRadarPoints(pos) {
    const playerId = heatmapPlayerId();
    if (!playerId) return [];
    const mapCode = renderer.mapCode;
    const pts = [];
    const state = {};
    const radar = { x: 0, y: 0 };

    for (const L of visibleLayers()) {
      const track = store.track(L.round.file);
      if (!track || !L.meta) continue;
      const player = (L.meta.players || []).find((p) => p.id === playerId);
      if (!player) continue;
      const tick = tickForLayer(L, pos);
      if (tick < L.timing.freezeEndTick) continue;
      const events = L.meta.events || {};
      if (playerDeadAt(events, playerId, tick)) continue;
      track.sample(player.slot, tick, state);
      if (!state.alive || !Number.isFinite(state.x) || !Number.isFinite(state.y)) continue;
      worldToRadar(mapCode, state.x, state.y, radar);
      if (radar.x < -8 || radar.y < -8 || radar.x > RADAR_SIZE + 8 || radar.y > RADAR_SIZE + 8) {
        continue;
      }
      pts.push(radar.x, radar.y);
    }
    return pts;
  }

  /**
   * Heat pipeline:
   *   1) black field + additive white stamps (one Z / intensity layer)
   *   2) Gaussian blur (slider)
   *   3) gradient-map luminance → cool…hot (black stays black)
   *   4) clip to radar mask
   * Painted with Screen so the black field disappears over the map.
   */
  function buildHeatLayer(pos) {
    const playerId = heatmapPlayerId();
    const visible = visibleLayers();
    const files = visible.map((L) => L.round.file).join('\0');
    const posKey = Math.round(pos * 8);
    const key = [renderer.mapCode, playerId, files, posKey, heatmapSmooth, visible.length].join(
      '|'
    );
    if (heatLayerCache?.key === key) return heatLayerCache.canvas;

    const pts = collectHeatRadarPoints(pos);
    if (!pts.length) {
      const empty = document.createElement('canvas');
      empty.width = HEAT_RES;
      empty.height = HEAT_RES;
      const emptyCtx = empty.getContext('2d');
      emptyCtx.fillStyle = '#000';
      emptyCtx.fillRect(0, 0, HEAT_RES, HEAT_RES);
      heatLayerCache = { key, canvas: empty };
      return empty;
    }

    const scale = HEAT_RES / RADAR_SIZE;
    const stampR = Math.max(2, HEAT_STAMP_R * scale);
    const blurPx = Math.max(6, heatmapSmooth * scale * 1.15);
    const stampAlpha = Math.min(1, 0.55 + 0.35 / Math.sqrt(Math.max(1, pts.length / 2)));

    // 1) Black field, white dots (additive where they stack).
    heatAccCtx.setTransform(1, 0, 0, 1, 0, 0);
    heatAccCtx.globalCompositeOperation = 'source-over';
    heatAccCtx.filter = 'none';
    heatAccCtx.fillStyle = '#000';
    heatAccCtx.fillRect(0, 0, HEAT_RES, HEAT_RES);
    heatAccCtx.globalCompositeOperation = 'lighter';
    heatAccCtx.fillStyle = `rgba(255,255,255,${stampAlpha})`;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * scale;
      const y = pts[i + 1] * scale;
      heatAccCtx.beginPath();
      heatAccCtx.arc(x, y, stampR, 0, Math.PI * 2);
      heatAccCtx.fill();
    }
    heatAccCtx.globalCompositeOperation = 'source-over';

    // 2) Blur the whole intensity layer.
    heatBlurCtx.setTransform(1, 0, 0, 1, 0, 0);
    heatBlurCtx.globalCompositeOperation = 'source-over';
    heatBlurCtx.fillStyle = '#000';
    heatBlurCtx.fillRect(0, 0, HEAT_RES, HEAT_RES);
    heatBlurCtx.filter = `blur(${blurPx}px)`;
    heatBlurCtx.drawImage(heatAcc, 0, 0);
    heatBlurCtx.filter = 'none';

    // 3) Gradient-map: luminance → color. Keep RGB black where cold so Screen
    //    compositing hides the field; always opaque (alpha 255).
    const src = heatBlurCtx.getImageData(0, 0, HEAT_RES, HEAT_RES);
    const out = heatColorCtx.createImageData(HEAT_RES, HEAT_RES);
    const s = src.data;
    const d = out.data;
    let maxV = 1;
    for (let i = 0; i < s.length; i += 4) {
      if (s[i] > maxV) maxV = s[i];
    }
    const inv = 1 / maxV;
    for (let i = 0; i < s.length; i += 4) {
      const t = s[i] * inv;
      const [r, g, b] = heatColorAt(t);
      d[i] = r + 0.5;
      d[i + 1] = g + 0.5;
      d[i + 2] = b + 0.5;
      d[i + 3] = 255;
    }
    heatColorCtx.putImageData(out, 0, 0);

    // 4) Clip to playable radar (outside → transparent; Screen ignores it).
    if (renderer.image && renderer.mapCode) {
      const mask = radarPlayableMask(renderer.mapCode, renderer.image);
      heatColorCtx.globalCompositeOperation = 'destination-in';
      heatColorCtx.drawImage(mask, 0, 0, HEAT_RES, HEAT_RES);
      heatColorCtx.globalCompositeOperation = 'source-over';
    }

    const snap = document.createElement('canvas');
    snap.width = HEAT_RES;
    snap.height = HEAT_RES;
    snap.getContext('2d').drawImage(heatColor, 0, 0);
    heatLayerCache = { key, canvas: snap };
    return snap;
  }

  function paintHeatmap(pos) {
    const playerId = heatmapPlayerId();
    renderer.paintMapBase({ mapAlpha: 1 });
    if (!playerId) {
      clockEl.textContent = 'Pick one player';
      return;
    }
    if (!renderer.image) return;
    const layer = buildHeatLayer(pos);
    const { w, h } = renderer.resize();
    const t = renderer.viewTransform(w, h);
    const ctx = renderer.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    // Screen: black field vanishes; purple→yellow lightens the radar.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 1;
    ctx.drawImage(layer, t.ox, t.oy, RADAR_SIZE * t.scale, RADAR_SIZE * t.scale);
    ctx.restore();

    const first = visibleLayers()[0];
    if (first) {
      const tick = tickForLayer(first, pos);
      clockEl.textContent = clockAt(first.timing, tick).label;
    } else {
      clockEl.textContent = '—';
    }
  }

  function draw(pos) {
    const visible = visibleLayers();
    countEl.textContent = `${visible.length} / ${layers.length} rounds`;
    hitTargets = [];

    const mapMeta = layers.find((L) => L.meta)?.meta;
    if (!mapMeta) {
      renderer.paintMapBase({ mapAlpha: 1 });
      hideTip();
      return;
    }

    if (viewMode === 'heatmap') {
      hideTip();
      hoverHit = null;
      paintHeatmap(pos);
      const pct = playback.duration ? (pos / playback.duration) * 100 : 0;
      fillEl.style.width = `${pct}%`;
      handleEl.style.left = `${pct}%`;
      const totalLoaded = layers.filter((L) => store.track(L.round.file)).length;
      loadEl.textContent =
        totalLoaded === layers.length ? '' : `${totalLoaded}/${layers.length} loaded`;
      return;
    }

    renderer.paintMapBase({ mapAlpha: 1 });

    const selectedLayers = selectedFiles
      .map((f) => layerByFile(f))
      .filter((L) => L?.meta && store.track(L.round.file));

    let refTiming = null;
    let refTick = 0;
    /** Layers that should receive persistent kill marks this frame. */
    const markLayers = [];

    if (selectedLayers.length) {
      // Hits for canvas picking (all selected rounds).
      for (const L of selectedLayers) {
        const tick = tickForLayer(L, pos);
        const track = store.track(L.round.file);
        if (track) track.sampleAll(tick, L.states);
        const { w, h } = renderer.resize();
        const t = renderer.viewTransform(w, h);
        pushPlayerHits(L, L.meta.players || [], L.states, t, tick);
        pushGrenadeHits(L, L.meta.players || [], L.meta.events || {}, tick, t);
      }

      // Drop stale canvas hover (never re-assign hoverHit from draw — only
      // live pointermove sets it; otherwise tips/focus stick after leave).
      if (menuHoverFile) {
        hoverHit = null;
        hideTip();
      } else if (hoverHit) {
        const still =
          lastMapPointer &&
          (() => {
            const hit = hitAt(lastMapPointer.x, lastMapPointer.y);
            return hit && hit.file === hoverHit.file && hit.playerId === hoverHit.playerId;
          })();
        if (!still) {
          hoverHit = null;
          hideTip();
        }
      }

      const focusFile = menuHoverFile || hoverHit?.file || '';
      for (const L of selectedLayers) {
        const tick = tickForLayer(L, pos);
        markLayers.push({ L, tick, players: L.meta.players || [] });
        if (focusFile) {
          if (L.round.file !== focusFile) continue;
          refTiming = L.timing;
          refTick = tick;
          renderFullRound(L, tick, {
            highlightId: menuHoverFile ? '' : hoverHit?.playerId || '',
            alpha: 1,
            names: true,
            customColors: false
          });
        } else {
          if (!refTiming) {
            refTiming = L.timing;
            refTick = tick;
          }
          renderFullRound(L, tick, { alpha: SELECTION_GHOST_ALPHA, names: false });
        }
      }
    } else if (visible.length) {
      /** @type {Array<{L:object,tick:number,players:object[],events:object}>} */
      const overlay = [];
      for (const L of visible) {
        const tick = tickForLayer(L, pos);
        const sampled = sampleOverlayHits(L, tick);
        if (!sampled) continue;
        overlay.push({ L, tick, ...sampled });
        markLayers.push({ L, tick, players: sampled.players });
      }

      if (hoverHit) {
        const still =
          lastMapPointer &&
          (() => {
            const hit = hitAt(lastMapPointer.x, lastMapPointer.y);
            return hit && hit.file === hoverHit.file && hit.playerId === hoverHit.playerId;
          })();
        if (!still) {
          hoverHit = null;
          hideTip();
        }
      }

      if (hoverHit?.layer?.meta) {
        const L = hoverHit.layer;
        const tick = tickForLayer(L, pos);
        refTiming = L.timing;
        refTick = tick;
        renderFullRound(L, tick, {
          highlightId: hoverHit.playerId,
          alpha: 1,
          names: true,
          customColors: false
        });
      } else {
        for (const row of overlay) {
          if (!refTiming) {
            refTiming = row.L.timing;
            refTick = row.tick;
          }
          paintOverlayRound(row.L, row.tick, row.players, row.events);
        }
      }
    }

    // Kill/death marks on top, full opacity, for every involved round.
    for (const row of markLayers) {
      paintKillMarks(row.L, row.tick, row.players);
    }

    if (refTiming) clockEl.textContent = clockAt(refTiming, refTick).label;
    else clockEl.textContent = '—';

    const pct = playback.duration ? (pos / playback.duration) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    handleEl.style.left = `${pct}%`;
    const totalLoaded = layers.filter((L) => store.track(L.round.file)).length;
    loadEl.textContent =
      totalLoaded === layers.length ? '' : `${totalLoaded}/${layers.length} loaded`;

    // Never placeTip here — playback redraws would pin a sticky tip at the
    // last hover coords after the mouse has already left.
    if (!hoverHit || menuHoverFile) hideTip();
  }

  function hitAt(clientX, clientY) {
    const rect = mapEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const h of hitTargets) {
      const dx = h.sx - x;
      const dy = h.sy - y;
      const d = Math.hypot(dx, dy);
      if (d <= h.r && d < bestD) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }


  function openRoundTab(file) {
    if (!file) return;
    window.open(`/demos?round=${encodeURIComponent(file)}`, '_blank', 'noopener');
  }

  /** Open one or more rounds in Timeline in a new browser tab. */
  function openRoundsInTimeline(files) {
    const list = [...new Set(files.filter(Boolean))];
    if (!list.length) return;
    if (list.length === 1) {
      openRoundTab(list[0]);
      return;
    }
    const q = list.map(encodeURIComponent).join(',');
    window.open(`/demos?rounds=${q}`, '_blank', 'noopener');
  }

  function setMenuHover(file) {
    const next = file || '';
    if (next === menuHoverFile) return;
    menuHoverFile = next;
    if (menuHoverFile) {
      hoverHit = null;
      hideTip();
      lastMapPointer = null;
    }
    selListEl.querySelectorAll('.rv-az-sel-item').forEach((row) => {
      row.classList.toggle('is-focus', row.dataset.file === menuHoverFile);
    });
    draw(playback.position);
  }

  function renderSelectedPanel() {
    const items = selectedFiles.map((f) => layerByFile(f)).filter(Boolean);
    if (!items.length) {
      selListEl.innerHTML = '';
      selSummaryEl.hidden = true;
      selSummaryEl.textContent = '';
      replayBtn.disabled = true;
      if (menuHoverFile) setMenuHover('');
      return;
    }
    selSummaryEl.hidden = false;
    const total = Math.max(1, visibleLayers().length || layers.length);
    selListEl.innerHTML = items
      .map((L) => {
        const opp = opponentName(L);
        const n = String(roundNum(L)).padStart(2, '0');
        const file = L.round.file;
        const focus = file === menuHoverFile ? ' is-focus' : '';
        // data-file must be the raw path (dataset decodes entities).
        return `<li class="rv-az-sel-item${focus}" data-file="${escapeHtml(file)}" title="${escapeHtml(
          file
        )}">
          <span class="rv-az-sel-team">${escapeHtml(opp)}</span>
          <span class="rv-az-sel-rnd">${n}</span>
        </li>`;
      })
      .join('');
    const pct = Math.round((items.length / total) * 100);
    selSummaryEl.textContent = `${items.length} round${items.length === 1 ? '' : 's'} (${pct}%)`;
    replayBtn.disabled = false;
  }

  function addSelected(files) {
    const seen = new Set(selectedFiles);
    for (const f of files) {
      if (!f || seen.has(f)) continue;
      seen.add(f);
      selectedFiles.push(f);
    }
    renderSelectedPanel();
    draw(playback.position);
  }

  function removeSelected(file) {
    selectedFiles = selectedFiles.filter((f) => f !== file);
    renderSelectedPanel();
    draw(playback.position);
  }

  // ---- zoom / pan / select ------------------------------------------------

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
    draw(playback.position);
  }

  function syncPanCursor() {
    mapEl.classList.toggle('can-pan', renderer.zoom > MIN_ZOOM);
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
  let selecting = false;
  let dragArmed = false;
  let panBtn = -1;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let startClientX = 0;
  let startClientY = 0;

  function mapLocal(e) {
    const rect = mapEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function showMarquee(x0, y0, x1, y1) {
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    marqueeEl.hidden = false;
    marqueeEl.style.left = `${left}px`;
    marqueeEl.style.top = `${top}px`;
    marqueeEl.style.width = `${w}px`;
    marqueeEl.style.height = `${h}px`;
  }

  function hideMarquee() {
    marqueeEl.hidden = true;
  }

  function filesInMarquee(x0, y0, x1, y1) {
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const files = new Set();
    for (const h of hitTargets) {
      if (h.sx >= left && h.sx <= right && h.sy >= top && h.sy <= bottom) {
        files.add(h.file);
      }
    }
    return [...files];
  }

  mapEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.rv-analyzer-clock, .rv-az-tip')) return;
    // Middle / right / Alt+left pan when zoomed; left-drag is box select.
    const wantPan =
      e.button === 1 ||
      e.button === 2 ||
      (e.button === 0 && e.altKey && renderer.zoom > MIN_ZOOM);
    if (wantPan && renderer.zoom > MIN_ZOOM) {
      panning = true;
      panBtn = e.button;
      lastX = e.clientX;
      lastY = e.clientY;
      mapEl.classList.add('panning');
      mapEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    dragArmed = true;
    selecting = false;
    const loc = mapLocal(e);
    startX = loc.x;
    startY = loc.y;
    startClientX = e.clientX;
    startClientY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    mapEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  mapEl.addEventListener('pointermove', (e) => {
    lastMapPointer = { x: e.clientX, y: e.clientY };

    if (panning) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.panX += dx;
      renderer.panY += dy;
      draw(playback.position);
      return;
    }

    if (dragArmed) {
      const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
      if (!selecting && dist >= DRAG_THRESHOLD) {
        selecting = true;
        clearHover();
        mapEl.classList.add('selecting');
      }
      if (selecting) {
        const loc = mapLocal(e);
        showMarquee(startX, startY, loc.x, loc.y);
      }
      return;
    }

    if (menuHoverFile) {
      hideTip();
      return;
    }

    const hit = hitAt(e.clientX, e.clientY);
    const prevFile = hoverHit?.file || '';
    const prevPlayer = hoverHit?.playerId || '';
    if (!hit) {
      if (hoverHit) {
        clearHover();
        draw(playback.position);
      } else {
        hideTip();
      }
      return;
    }
    const changed = hit.file !== prevFile || hit.playerId !== prevPlayer;
    hoverHit = hit;
    placeTip(hit);
    if (changed) draw(playback.position);
  });

  function endPointer(e) {
    if (panning) {
      if (e.button !== undefined && e.button !== panBtn && e.type === 'pointerup') return;
      panning = false;
      panBtn = -1;
      mapEl.classList.remove('panning');
      try {
        mapEl.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      return;
    }

    if (!dragArmed) return;
    dragArmed = false;
    mapEl.classList.remove('selecting');
    try {
      mapEl.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }

    if (selecting) {
      const loc = mapLocal(e);
      const files = filesInMarquee(startX, startY, loc.x, loc.y);
      hideMarquee();
      selecting = false;
      if (files.length) addSelected(files);
      else clearSelection();
      return;
    }

    hideMarquee();
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) openRoundTab(hit.file);
    else clearSelection();
  }

  mapEl.addEventListener('pointerup', endPointer);
  mapEl.addEventListener('pointercancel', endPointer);
  mapEl.addEventListener('pointerleave', () => {
    lastMapPointer = null;
    hideTip();
    if (dragArmed || selecting || panning) return;
    if (hoverHit) {
      clearHover();
      draw(playback.position);
    }
  });
  mapEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  mapEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // Document-level: drop sticky tip/hover whenever the pointer is not on a
  // live map hit (covers leaving into side panels, chrome, or other windows).
  const onDocPointerMove = (e) => {
    if (!mapEl.isConnected || menuHoverFile || selecting || panning || dragArmed) return;
    const overMap = e.target === mapEl || mapEl.contains(e.target);
    if (overMap) {
      // Map has its own handler; still kill a tip if we're not on a hit.
      if (tipEl.classList.contains('is-on') && !hitAt(e.clientX, e.clientY)) {
        hideTip();
        if (hoverHit) {
          clearHover();
          draw(playback.position);
        }
      }
      return;
    }
    if (lastMapPointer || hoverHit || tipEl.classList.contains('is-on')) {
      lastMapPointer = null;
      if (hoverHit) {
        clearHover();
        draw(playback.position);
      } else {
        hideTip();
      }
    }
  };
  document.addEventListener('pointermove', onDocPointerMove);

  // Right-panel round hover → same focus as hovering a player on the map.
  selListEl.addEventListener('pointerover', (e) => {
    const row = e.target.closest('.rv-az-sel-item');
    if (!row || !selListEl.contains(row)) return;
    const file = row.dataset.file || '';
    if (file) setMenuHover(file);
  });
  selListEl.addEventListener('pointerleave', () => {
    if (menuHoverFile) setMenuHover('');
  });

  selListEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-file]');
    if (!row) return;
    const file = row.dataset.file;
    if (e.altKey) {
      removeSelected(file);
      return;
    }
    openRoundTab(file);
  });

  replayBtn.addEventListener('click', () => openRoundsInTimeline(selectedFiles));

  async function loadMeta() {
    const mapCode = rounds[0]?.map || '';
    const zonesPromise = mapCode
      ? fetchZones(mapCode)
          .then(() => {
            zoneNetworkReady = true;
          })
          .catch(() => {
            zoneNetworkReady = true;
          })
      : Promise.resolve();

    await Promise.all([
      zonesPromise,
      ...layers.map(async (L, i) => {
        const meta = await fetchRoundMeta(rounds[i].file).catch(() => null);
        if (destroyed || !meta) return;
        L.meta = meta;
        if (meta.team1 && typeof meta.team1 === 'object') {
          meta.team1Id = meta.team1.id;
        }
        L.timing = timingFor(meta);
        if (i === 0) await renderer.setMap(meta.map || rounds[i].map);
      })
    ]);
    if (destroyed) return;

    // Round-decided uses win% from meta only — always available.
    zoneNetworkReady = true;

    for (const L of layers) {
      if (!L.meta) continue;
      // Keep meta {id,name} objects for labels; list-round ids still win in teamIndex().
      if (L.round.team1 && typeof L.meta.team1 === 'object' && L.meta.team1) {
        L.meta.team1 = { ...L.meta.team1, id: L.round.team1 };
      }
      if (L.round.team2 && typeof L.meta.team2 === 'object' && L.meta.team2) {
        L.meta.team2 = { ...L.meta.team2, id: L.round.team2 };
      }
      if (L.round.round != null && L.meta.round == null) L.meta.round = L.round.round;
      if (L.round.econ1 != null && L.meta.econ1 == null) L.meta.econ1 = L.round.econ1;
      if (L.round.econ2 != null && L.meta.econ2 == null) L.meta.econ2 = L.round.econ2;
      // Precompute equal-buy decide moment (meta-only; no tick buffer).
      L.decided = findRoundDecided(L.meta);
    }

    resolveFocusFromMeta();

    if (needsTeamPick()) {
      renderTeamPicker();
      renderSelectedPanel();
      playback.setDuration(longestLive());
      draw(0);
      return;
    }

    finishFocusSetup();
  }

  panelEl.addEventListener('click', (e) => {
    const teamBtn = e.target.closest('[data-team-key]');
    if (teamBtn) {
      ensureTeamOptions();
      const key = teamBtn.dataset.teamKey;
      const opt =
        teamOptions.find((o) => (o.key || o.focusTeam) === key) ||
        teamOptions.find((o) => o.focusTeamIds.includes(key));
      if (!opt) return;
      applyFocusOption(opt);
      finishFocusSetup();
      return;
    }
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
      const next = viewBtn.dataset.view === 'heatmap' ? 'heatmap' : 'regular';
      if (next === viewMode) return;
      viewMode = next;
      heatLayerCache = null;
      if (viewMode === 'heatmap') ensureHeatmapPlayer();
      hideTip();
      hoverHit = null;
      renderFilters();
      draw(playback.position);
      return;
    }
    const sideBtn = e.target.closest('[data-side]');
    if (sideBtn) {
      sideFilter = sideBtn.dataset.side === 'CT' ? 'CT' : 'T';
      resetPlayersForSide();
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const sitBtn = e.target.closest('[data-situation]');
    if (sitBtn) {
      const key = sitBtn.dataset.situation;
      if (situationFilter.has(key)) situationFilter.delete(key);
      else situationFilter.add(key);
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const resultBtn = e.target.closest('[data-result]');
    if (resultBtn) {
      const key = resultBtn.dataset.result;
      if (resultFilter.has(key)) resultFilter.delete(key);
      else resultFilter.add(key);
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const plantBtn = e.target.closest('[data-afterplant]');
    if (plantBtn) {
      afterplantOnly = !afterplantOnly;
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const decidedBtn = e.target.closest('[data-decided-phase]');
    if (decidedBtn && zoneNetworkReady) {
      const key = decidedBtn.dataset.decidedPhase;
      if (decidedPhaseFilter.has(key)) decidedPhaseFilter.delete(key);
      else decidedPhaseFilter.add(key);
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const playerBtn = e.target.closest('[data-player]');
    if (playerBtn) {
      const id = playerBtn.dataset.player;
      if (viewMode === 'heatmap') {
        enabledPlayers = new Set([id]);
      } else if (enabledPlayers.has(id)) {
        enabledPlayers.delete(id);
      } else {
        enabledPlayers.add(id);
      }
      heatLayerCache = null;
      renderFilters();
      draw(playback.position);
      return;
    }
    const utilBtn = e.target.closest('[data-util]');
    if (utilBtn) {
      const key = utilBtn.dataset.util;
      if (key in utilityVisible) utilityVisible[key] = !utilityVisible[key];
      renderFilters();
      draw(playback.position);
    }
  });

  panelEl.addEventListener('change', (e) => {
    const buy = e.target.closest('#rv-az-buy');
    if (buy) {
      const v = buy.value;
      if (v === 'all') buyFilter = new Set(BUY_OPTIONS);
      else buyFilter = new Set([Number(v)]);
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const awp = e.target.closest('#rv-az-awp');
    if (awp) {
      hasAwpFilter = Boolean(awp.checked);
      heatLayerCache = null;
      renderFilters();
      pruneSelectionToVisible();
      draw(playback.position);
      return;
    }
    const smooth = e.target.closest('#rv-az-smooth');
    if (smooth) {
      heatmapSmooth = Number(smooth.value) || 18;
      heatLayerCache = null;
      const hint = panelEl.querySelector('#rv-az-smooth-val');
      if (hint) hint.textContent = String(heatmapSmooth);
      draw(playback.position);
    }
  });

  panelEl.addEventListener('input', (e) => {
    const smooth = e.target.closest('#rv-az-smooth');
    if (!smooth) return;
    heatmapSmooth = Number(smooth.value) || 18;
    heatLayerCache = null;
    const hint = panelEl.querySelector('#rv-az-smooth-val');
    if (hint) hint.textContent = String(heatmapSmooth);
    draw(playback.position);
  });

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

  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    }
  };
  document.addEventListener('keydown', onKey);

  function handleEscape() {
    if (selectedFiles.length) {
      clearSelection();
      return true;
    }
    if (hoverHit || menuHoverFile) {
      menuHoverFile = '';
      clearHover();
      draw(playback.position);
      return true;
    }
    return false;
  }

  const onResize = () => draw(playback.position);
  window.addEventListener('resize', onResize);

  const offStore = store.onChange((event) => {
    if (event.type === 'macro-progress' || event.type === 'full') {
      heatLayerCache = null;
      draw(playback.position);
    }
  });

  (async () => {
    await loadMeta();
    if (destroyed) return;
    store.macroPass(rounds.map((r) => r.file));
  })();

  return {
    el,
    handleEscape,
    destroy() {
      destroyed = true;
      playback.destroy();
      offStore();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointermove', onDocPointerMove);
      hideTip();
    }
  };
}

/** @deprecated Prefer createAnalyzerViewer */
export const createMacroViewer = createAnalyzerViewer;
