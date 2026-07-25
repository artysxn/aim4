// ---------------------------------------------------------------------------
// replays/viewer/analyzerViewer.js
// Overlay every selected round on one radar, synced from freezetime end.
// Requires a shared map + focus team; filters by that team's T/CT side, buy,
// players (each with a fixed color), and utility visibility.
// ---------------------------------------------------------------------------

import { fetchRoundMeta } from '../api.js';
import { ECONOMIES, economyLabel } from '../shared/roundId.js';
import { isGrenade } from './equipmentIcons.js';
import { RadarRenderer } from './radarRenderer.js';
import { Playback } from './playback.js';
import { clockAt, timingFor } from './roundClock.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

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
      <div class="rv-analyzer-map">
        <canvas id="rv-az-canvas"></canvas>
        <div class="rv-analyzer-clock" id="rv-az-clock">1:55</div>
      </div>
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
  const canvas = el.querySelector('#rv-az-canvas');

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

  /** Make sure we always have a focus team id before filtering sides. */
  function resolveFocusFromMeta() {
    // Expand aliases from every list round that already matches focus.
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
        // Two teams in every round — pick team1 of the first round so the
        // view is not empty when opened without a library team pin.
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
    const ranked = [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    playerColors = {};
    ranked.forEach((p, i) => {
      if (i < PRIMARY_COLORS.length) playerColors[p.id] = PRIMARY_COLORS[i];
      else {
        const r = i - PRIMARY_COLORS.length;
        playerColors[p.id] = RESERVE_COLORS[r % RESERVE_COLORS.length];
      }
    });
    return ranked;
  }

  function resetPlayersForSide() {
    const ranked = rankedPlayersForSide();
    enabledPlayers = new Set(ranked.map((p) => p.id));
    return ranked;
  }

  function renderFilters() {
    const ranked = rankedPlayersForSide();
    // Drop enables for players not on this side.
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

  function draw(pos) {
    const visible = visibleLayers();
    countEl.textContent = `${visible.length} / ${layers.length} rounds`;

    const mapMeta = layers.find((L) => L.meta)?.meta;
    if (!mapMeta) {
      renderer.paintMapBase({ mapAlpha: 1 });
      return;
    }

    // ONE cached map blit, then only per-round entities on top.
    renderer.paintMapBase({ mapAlpha: 1 });

    if (!visible.length) {
      clockEl.textContent = '—';
      return;
    }

    let refTiming = null;
    let refTick = 0;

    for (const L of visible) {
      const track = store.track(L.round.file);
      const tick = Math.min(
        L.timing.freezeEndTick + pos * L.timing.tickRate,
        L.timing.officialEndTick
      );
      if (!refTiming) {
        refTiming = L.timing;
        refTick = tick;
      }
      if (track) track.sampleAll(tick, L.states);
      else continue;

      const players = filterPlayers(L);
      if (!players.length) continue;

      renderer.render({
        tick,
        tickRate: L.timing.tickRate,
        states: L.states,
        players,
        events: filterEvents(L.meta, players),
        weapons: L.meta.weapons || [],
        teamSides: { 1: L.meta.team1Side, 2: L.meta.team2Side },
        playerColors,
        utilityVisible,
        compact: true,
        clear: false,
        drawMap: false,
        hideBomb: true,
        hideTracers: false,
        hideDeaths: false
      });
    }

    if (refTiming) clockEl.textContent = clockAt(refTiming, refTick).label;
    const pct = playback.duration ? (pos / playback.duration) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    handleEl.style.left = `${pct}%`;
    const totalLoaded = layers.filter((L) => store.track(L.round.file)).length;
    loadEl.textContent =
      totalLoaded === layers.length ? '' : `${totalLoaded}/${layers.length} loaded`;
  }

  async function loadMeta() {
    await Promise.all(
      layers.map(async (L, i) => {
        const meta = await fetchRoundMeta(rounds[i].file).catch(() => null);
        if (destroyed || !meta) return;
        L.meta = meta;
        // Prefer short ids from the list round for team matching.
        if (!meta.team1 || typeof meta.team1 !== 'string') {
          /* team1 may be {id,name} object in JSON */
        }
        // Normalize team ids onto meta for teamIndex().
        if (meta.team1 && typeof meta.team1 === 'object') {
          meta.team1Id = meta.team1.id;
        }
        L.timing = timingFor(meta);
        if (i === 0) await renderer.setMap(meta.map || rounds[i].map);
      })
    );
    if (destroyed) return;

    // Always pin roster short-ids from the filename — display names in meta
    // may have been renamed and no longer hash to the same token.
    for (const L of layers) {
      if (!L.meta) continue;
      if (L.round.team1) L.meta.team1 = L.round.team1;
      if (L.round.team2) L.meta.team2 = L.round.team2;
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

    // Default side to whichever has more rounds for this team.
    const tN = layers.filter((L) => L.meta && sideOfFocus(L) === 'T').length;
    const ctN = layers.filter((L) => L.meta && sideOfFocus(L) === 'CT').length;
    sideFilter = tN >= ctN ? 'T' : 'CT';
    if (!tN && !ctN) sideFilter = 'T';

    resetPlayersForSide();
    renderFilters();
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
