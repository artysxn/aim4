// ---------------------------------------------------------------------------
// replays/viewer/analyzerViewer.js
// Overlay every selected round on one radar, synced from freezetime end.
// Requires a shared map + focus team; filters by that team's T/CT side, buy,
// players (each with a fixed color), and utility visibility.
// Zoom/pan, hover full-round preview, click-to-open, box-select → Timeline.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { ECONOMIES, economyLabel } from '../shared/roundId.js';
import { isGrenade } from './equipmentIcons.js';
import { RadarRenderer, grenadeWorldPos } from './radarRenderer.js';
import { Playback } from './playback.js';
import { clockAt, timingFor } from './roundClock.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const DRAG_THRESHOLD = 5;

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
 */
export function createAnalyzerViewer({
  store,
  rounds,
  escapeHtml,
  focusTeam = '',
  focusTeamIds = [],
  focusName: focusNameOpt = ''
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
        <div class="rv-az-sel-head">
          <h3>Selected rounds</h3>
          <button type="button" class="rv-az-invert" id="rv-az-invert" title="Invert selection">Invert</button>
        </div>
        <div class="rv-az-sel-cols"><span>Opponent</span><span>Rnd</span></div>
        <ul class="rv-az-sel-list" id="rv-az-sel-list"></ul>
        <p class="rv-az-sel-empty" id="rv-az-sel-empty">Drag on the map to select rounds.</p>
        <p class="rv-az-sel-summary" id="rv-az-sel-summary" hidden></p>
        <button type="button" class="rv-az-replay" id="rv-az-replay" disabled>
          <svg viewBox="0 -960 960 960" width="16" height="16"><path d="M320-200v-560l440 280-440 280Z"/></svg>
          Replay all
        </button>
        <p class="rv-az-sel-hint">Alt + click to remove · click opens round</p>
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
  const selEmptyEl = el.querySelector('#rv-az-sel-empty');
  const selSummaryEl = el.querySelector('#rv-az-sel-summary');
  const invertBtn = el.querySelector('#rv-az-invert');
  const replayBtn = el.querySelector('#rv-az-replay');

  const renderer = new RadarRenderer(canvas);
  renderer.showNames = false;
  renderer.showWeapons = false;
  renderer.onIconLoad = () => draw(playback.position);

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
  let focusName = focusNameOpt || 'Team';

  /** @type {'T'|'CT'} */
  let sideFilter = 'T';
  /** @type {Set<number>} */
  let buyFilter = new Set(BUY_OPTIONS);
  /** @type {Set<string>} */
  let enabledPlayers = new Set();
  /** @type {Record<string, string>} */
  let playerColors = {};
  /** @type {{smoke:boolean,molotov:boolean,flash:boolean,he:boolean}} */
  let utilityVisible = { smoke: true, molotov: true, flash: true, he: true };

  /** Hit targets from the last overlay draw (screen CSS px relative to map). */
  /** @type {Array<{kind:'player'|'grenade', file:string, layer:object, playerId:string, name:string, roundNum:number, sx:number, sy:number, r:number}>} */
  let hitTargets = [];
  /** @type {typeof hitTargets[0] | null} */
  let hoverHit = null;
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

  /** Make sure we always have a focus team id before filtering sides. */
  function resolveFocusFromMeta() {
    for (const L of layers) {
      const { t1, t2 } = rosterIds(L);
      if (isFocusId(t1)) focusIds.add(t1);
      if (isFocusId(t2)) focusIds.add(t2);
    }
    if (!focusId && focusIds.size) focusId = [...focusIds][0];

    if (!focusId && !focusIds.size) {
      let common = null;
      for (const L of layers) {
        const { t1, t2 } = rosterIds(L);
        const ids = new Set([t1, t2].filter(Boolean));
        if (!ids.size) continue;
        if (!common) common = ids;
        else common = new Set([...common].filter((id) => ids.has(id)));
      }
      if (common?.size === 1) {
        focusId = [...common][0];
        focusIds.add(focusId);
      } else if (common?.size > 1) {
        focusId = layers[0]?.round?.team1 || [...common][0];
        focusIds.add(focusId);
      }
    }

    if (!focusNameOpt) {
      const sample = layers.find((L) => L.meta && teamIndex(L.meta, L.round));
      if (sample?.meta) {
        focusName = focusDisplayName(sample.meta, teamIndex(sample.meta, sample.round));
      } else if (focusId) {
        focusName = focusId;
      }
    } else {
      focusName = focusNameOpt;
    }
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

  function renderFilters() {
    const ranked = rankedPlayersForSide();
    enabledPlayers = new Set([...enabledPlayers].filter((id) => ranked.some((p) => p.id === id)));
    if (!enabledPlayers.size) enabledPlayers = new Set(ranked.map((p) => p.id));
    const tCount = layers.filter((L) => L.meta && sideOfFocus(L) === 'T').length;
    const ctCount = layers.filter((L) => L.meta && sideOfFocus(L) === 'CT').length;
    teamEl.textContent = focusName || focusId || 'Team';

    panelEl.hidden = false;
    panelEl.innerHTML = `
      <div class="rv-az-group">
        <h4>Side</h4>
        <div class="rv-az-chips">
          <button type="button" class="rv-az-chip${sideFilter === 'T' ? ' active' : ''}" data-side="T">T <small>${tCount}</small></button>
          <button type="button" class="rv-az-chip${sideFilter === 'CT' ? ' active' : ''}" data-side="CT">CT <small>${ctCount}</small></button>
        </div>
      </div>
      <div class="rv-az-group">
        <h4>Buy</h4>
        <div class="rv-az-chips rv-az-buys">
          ${BUY_OPTIONS.map(
            (code) => `
            <button type="button" class="rv-az-chip${buyFilter.has(code) ? ' active' : ''}" data-buy="${code}">
              ${escapeHtml(economyLabel(code))}
            </button>`
          ).join('')}
        </div>
      </div>
      <div class="rv-az-group">
        <h4>Players</h4>
        <div class="rv-az-players">
          ${
            ranked.length
              ? ranked
                  .map(
                    (p) => `
            <label class="rv-az-player">
              <input type="checkbox" data-player="${escapeHtml(p.id)}" ${
                enabledPlayers.has(p.id) ? 'checked' : ''
              } />
              <span class="rv-az-swatch" style="background:${playerColors[p.id]}"></span>
              <span class="rv-az-pname">${escapeHtml(p.name)}</span>
              <small>${p.count}</small>
            </label>`
                  )
                  .join('')
              : `<p class="rv-az-empty">No players on ${sideFilter} for this team.</p>`
          }
        </div>
      </div>
      <div class="rv-az-group">
        <h4>Utility</h4>
        <div class="rv-az-chips">
          <button type="button" class="rv-az-chip${utilityVisible.smoke ? ' active' : ''}" data-util="smoke" title="Smokes">Smoke</button>
          <button type="button" class="rv-az-chip${utilityVisible.molotov ? ' active' : ''}" data-util="molotov" title="Molotovs">Molly</button>
          <button type="button" class="rv-az-chip${utilityVisible.flash ? ' active' : ''}" data-util="flash" title="Flashes">Flash</button>
          <button type="button" class="rv-az-chip${utilityVisible.he ? ' active' : ''}" data-util="he" title="HE">HE</button>
        </div>
      </div>`;
  }

  function visibleLayers() {
    return layers.filter((L) => {
      if (!L.meta) return false;
      if (sideOfFocus(L) !== sideFilter) return false;
      const econ = econOfFocus(L);
      if (econ == null || !buyFilter.has(econ)) return false;
      return true;
    });
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

  function pushPlayerHits(L, players, states, t) {
    const hitR = 12;
    for (const p of players) {
      const s = states[p.slot];
      if (!s?.alive) continue;
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

  function renderFullRound(L, tick, highlightId = '') {
    const track = store.track(L.round.file);
    if (!track) return false;
    track.sampleAll(tick, L.states);
    renderer.showNames = true;
    renderer.showWeapons = true;
    renderer.render({
      tick,
      tickRate: L.timing.tickRate,
      states: L.states,
      players: L.meta.players || [],
      events: L.meta.events || {},
      weapons: L.meta.weapons || [],
      teamSides: { 1: L.meta.team1Side, 2: L.meta.team2Side },
      playerColors,
      highlight: highlightId || undefined,
      compact: false,
      clear: false,
      drawMap: false
    });
    return true;
  }

  function renderOverlayRound(L, tick) {
    const track = store.track(L.round.file);
    if (!track) return;
    track.sampleAll(tick, L.states);
    const players = filterPlayers(L);
    if (!players.length) return;
    const events = filterEvents(L.meta, players);
    const { w, h } = renderer.resize();
    const t = renderer.viewTransform(w, h);
    pushPlayerHits(L, players, L.states, t);
    pushGrenadeHits(L, players, events, tick, t);

    renderer.showNames = false;
    renderer.showWeapons = false;
    renderer.render({
      tick,
      tickRate: L.timing.tickRate,
      states: L.states,
      players,
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
      hideDeaths: false
    });
  }

  function draw(pos) {
    const visible = visibleLayers();
    countEl.textContent = `${visible.length} / ${layers.length} rounds`;
    hitTargets = [];

    const mapMeta = layers.find((L) => L.meta)?.meta;
    if (!mapMeta) {
      renderer.paintMapBase({ mapAlpha: 1 });
      tipEl.hidden = true;
      return;
    }

    renderer.paintMapBase({ mapAlpha: 1 });

    const selectedLayers = selectedFiles
      .map((f) => layerByFile(f))
      .filter((L) => L?.meta && store.track(L.round.file));

    let refTiming = null;
    let refTick = 0;

    if (selectedLayers.length) {
      // Selection mode: every selected round at full Timeline fidelity.
      for (const L of selectedLayers) {
        const tick = tickForLayer(L, pos);
        if (!refTiming) {
          refTiming = L.timing;
          refTick = tick;
        }
        renderFullRound(L, tick);
        const { w, h } = renderer.resize();
        const t = renderer.viewTransform(w, h);
        pushPlayerHits(L, L.meta.players || [], L.states, t);
        pushGrenadeHits(L, L.meta.players || [], L.meta.events || {}, tick, t);
      }
    } else if (hoverHit?.layer?.meta) {
      const L = hoverHit.layer;
      const tick = tickForLayer(L, pos);
      refTiming = L.timing;
      refTick = tick;
      renderFullRound(L, tick, hoverHit.playerId);
      // Rebuild hits from the filtered overlay set so hover stays sticky.
      for (const V of visible) {
        const track = store.track(V.round.file);
        if (!track) continue;
        const vt = tickForLayer(V, pos);
        track.sampleAll(vt, V.states);
        const players = filterPlayers(V);
        if (!players.length) continue;
        const { w, h } = renderer.resize();
        const t = renderer.viewTransform(w, h);
        pushPlayerHits(V, players, V.states, t);
        pushGrenadeHits(V, players, filterEvents(V.meta, players), vt, t);
      }
    } else if (visible.length) {
      for (const L of visible) {
        const tick = tickForLayer(L, pos);
        if (!refTiming) {
          refTiming = L.timing;
          refTick = tick;
        }
        renderOverlayRound(L, tick);
      }
    }

    if (refTiming) clockEl.textContent = clockAt(refTiming, refTick).label;
    else clockEl.textContent = '—';

    const pct = playback.duration ? (pos / playback.duration) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    handleEl.style.left = `${pct}%`;
    const totalLoaded = layers.filter((L) => store.track(L.round.file)).length;
    loadEl.textContent =
      totalLoaded === layers.length ? '' : `${totalLoaded}/${layers.length} loaded`;

    updateTip();
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

  function updateTip() {
    if (!hoverHit || selecting || panning) {
      tipEl.hidden = true;
      return;
    }
    const rnd = String(hoverHit.roundNum).padStart(2, '0');
    tipEl.hidden = false;
    tipEl.innerHTML = `<strong>${escapeHtml(hoverHit.name)}</strong><span>R${rnd}</span>`;
    const pad = 14;
    tipEl.style.left = `${hoverHit.sx + pad}px`;
    tipEl.style.top = `${Math.max(8, hoverHit.sy - 28)}px`;
  }

  function openRoundTab(file) {
    if (!file) return;
    window.open(`/replays?round=${encodeURIComponent(file)}`, '_blank', 'noopener');
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
    window.open(`/replays?rounds=${q}`, '_blank', 'noopener');
  }

  function renderSelectedPanel() {
    const items = selectedFiles.map((f) => layerByFile(f)).filter(Boolean);
    if (!items.length) {
      selListEl.innerHTML = '';
      selEmptyEl.hidden = false;
      selSummaryEl.hidden = true;
      selSummaryEl.textContent = '';
      replayBtn.disabled = true;
      return;
    }
    selEmptyEl.hidden = true;
    selSummaryEl.hidden = false;
    const total = Math.max(1, visibleLayers().length || layers.length);
    selListEl.innerHTML = items
      .map((L) => {
        const opp = opponentName(L);
        const n = String(roundNum(L)).padStart(2, '0');
        return `<li class="rv-az-sel-item" data-file="${escapeHtml(L.round.file)}" title="${escapeHtml(
          L.round.file
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

  function invertSelection() {
    const vis = new Set(visibleLayers().map((L) => L.round.file));
    const cur = new Set(selectedFiles);
    selectedFiles = [...vis].filter((f) => !cur.has(f));
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
        hoverHit = null;
        tipEl.hidden = true;
        mapEl.classList.add('selecting');
      }
      if (selecting) {
        const loc = mapLocal(e);
        showMarquee(startX, startY, loc.x, loc.y);
      }
      return;
    }

    const hit = hitAt(e.clientX, e.clientY);
    const prevFile = hoverHit?.file;
    const prevPlayer = hoverHit?.playerId;
    hoverHit = hit;
    if (hit?.file !== prevFile || hit?.playerId !== prevPlayer) {
      draw(playback.position);
    } else {
      updateTip();
    }
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
      return;
    }

    hideMarquee();
    const hit = hitAt(e.clientX, e.clientY);
    if (hit) openRoundTab(hit.file);
  }

  mapEl.addEventListener('pointerup', endPointer);
  mapEl.addEventListener('pointercancel', endPointer);
  mapEl.addEventListener('pointerleave', () => {
    if (dragArmed || selecting || panning) return;
    if (hoverHit) {
      hoverHit = null;
      draw(playback.position);
    }
  });
  mapEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  mapEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // When zoomed, left-drag still selects; middle-drag pans (handled above).
  // Also allow empty-space drag at zoom>1 with Alt for pan.

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

  invertBtn.addEventListener('click', () => invertSelection());
  replayBtn.addEventListener('click', () => openRoundsInTimeline(selectedFiles));

  async function loadMeta() {
    await Promise.all(
      layers.map(async (L, i) => {
        const meta = await fetchRoundMeta(rounds[i].file).catch(() => null);
        if (destroyed || !meta) return;
        L.meta = meta;
        if (meta.team1 && typeof meta.team1 === 'object') {
          meta.team1Id = meta.team1.id;
        }
        L.timing = timingFor(meta);
        if (i === 0) await renderer.setMap(meta.map || rounds[i].map);
      })
    );
    if (destroyed) return;

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
    }

    resolveFocusFromMeta();

    const matched = layers.filter((L) => L.meta && teamIndex(L.meta, L.round));
    if (!matched.length) {
      teamEl.textContent = focusName || focusId || 'Team';
      panelEl.hidden = false;
      panelEl.innerHTML = `<p class="rv-az-empty">Could not match the focus team to these rounds. Close and open Analyzer from the library with one team selected.</p>`;
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

  panelEl.addEventListener('click', (e) => {
    const sideBtn = e.target.closest('[data-side]');
    if (sideBtn) {
      sideFilter = sideBtn.dataset.side === 'CT' ? 'CT' : 'T';
      resetPlayersForSide();
      renderFilters();
      draw(playback.position);
      return;
    }
    const buyBtn = e.target.closest('[data-buy]');
    if (buyBtn) {
      const code = Number(buyBtn.dataset.buy);
      if (buyFilter.has(code)) buyFilter.delete(code);
      else buyFilter.add(code);
      if (!buyFilter.size) buyFilter = new Set(BUY_OPTIONS);
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
    const box = e.target.closest('[data-player]');
    if (!box) return;
    const id = box.dataset.player;
    if (box.checked) enabledPlayers.add(id);
    else enabledPlayers.delete(id);
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
    if (!selectedFiles.length) return false;
    selectedFiles = [];
    hoverHit = null;
    renderSelectedPanel();
    draw(playback.position);
    return true;
  }

  const onResize = () => draw(playback.position);
  window.addEventListener('resize', onResize);

  const offStore = store.onChange((event) => {
    if (event.type === 'macro-progress' || event.type === 'full') draw(playback.position);
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
    }
  };
}

/** @deprecated Prefer createAnalyzerViewer */
export const createMacroViewer = createAnalyzerViewer;
