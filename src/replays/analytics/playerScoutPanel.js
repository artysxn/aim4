// ---------------------------------------------------------------------------
// Players scout: pick one body on one map and write the findings into a team
// document.
//
// The same flow as the Teams chapter, one step at a time: player (typeahead
// search) → map (warns under PLAYER_MIN_MATCHES) → included matches →
// categories → generate. Generate runs the scan (playerScoutScan.js), writes
// the rounds it picked out as strategies (playerScoutNotes.js) and saves the
// rendered report into the destination team's Documents tab.
//
// It spends from the same anti-strat allowance the Teams chapter does, and
// that allowance belongs to the subscription: every seat on a team draws from
// one pot. Generate spends a use with the server before it scans anything.
// ---------------------------------------------------------------------------

import { fetchRoster, fetchTeams, saveTeamDocument, formatApiError } from '../api.js';
import { getStatsPayload } from '../statsCache.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { PLAN_NAMES } from '../../../shared/entitlements/catalogue.js';
import { getEntitlements } from '../../lib/entitlements.js';
import { useMeteredFeature } from '../../lib/meteredFeature.js';
import { quotaBadge } from '../../site/upgradeGate.js';
import { MAPS } from '../shared/roundId.js';
import { listPlayers } from './analyticsMath.js';
import {
  PLAYER_CATEGORIES,
  PLAYER_GROUPS,
  PLAYER_MIN_MATCHES,
  buildPlayerDocHtml,
  notePicks,
  shortDate
} from './playerScoutConfig.js';
import { runPlayerScan } from './playerScoutScan.js';
import { writeScoutNotes } from './playerScoutNotes.js';
import { spinnerHtml, statsProgressLabel } from '../../lib/spinner.js';
import { mbWrap } from '../../icons/menubuttons.js';

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createPlayerScoutPanel({ escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'as-panel';
  el.innerHTML = spinnerHtml('Loading players…');

  let payload = null;
  let loadError = '';
  let loadToken = 0;
  let fetching = false;
  /** @type {ReturnType<typeof listPlayers>} */
  let players = [];
  /** @type {Array<{id: string, name: string}>|null} own teams; null until fetched */
  let myTeams = null;
  let myTeamsError = '';
  let playerSearch = '';
  let playerMenuOpen = false;

  const state = {
    playerId: '',
    mapCode: '',
    /** @type {Set<string>} demo ids dropped from the run */
    excluded: new Set(),
    /** @type {Set<string>} selected category keys */
    cats: new Set(PLAYER_CATEGORIES.map((c) => c.key)),
    destTeamId: '',
    linkUtility: true,
    busy: false,
    progress: '',
    /** '' | 'ok' | 'error' */
    outcome: '',
    outcomeMsg: ''
  };

  function ent() {
    return getEntitlements();
  }

  /**
   * No allowance at all on this plan. A tier that has one but has spent it is
   * NOT locked: the button stays live and the server's 402 explains itself,
   * which is also the only way a seat finds out a teammate spent today's run.
   */
  function locked() {
    const e = ent();
    return e ? !e.can(CAP.ANALYTICS_ANTISTRAT) : false;
  }

  /** The cheapest plan that includes the scout, read off the catalogue. */
  function requiredPlanName() {
    const e = ent();
    const plan = e?.requiredPlan?.(CAP.ANALYTICS_ANTISTRAT);
    return (plan && PLAN_NAMES[plan]) || '';
  }

  /**
   * Runs left today, next to the button that spends one.
   *
   * The allowance is metered against the subscription, so on a team the number
   * is the roster's, not the reader's: the first player to click spends it for
   * everybody. /api/me marks which quotas work that way, so the wording follows
   * the server rather than a list of keys kept here.
   */
  function allowanceHtml() {
    const e = ent();
    if (!e || locked()) return '';
    const badge = quotaBadge(e, CAP.ANALYTICS_ANTISTRAT);
    if (!badge) return '';
    const text = e.quota(CAP.ANALYTICS_ANTISTRAT).shared
      ? `${badge}, shared across the team`
      : badge;
    return `<span class="an-muted as-allowance">${escapeHtml(text)}</span>`;
  }

  function selectedPlayer() {
    return players.find((p) => p.id === state.playerId) || null;
  }

  /** Library demos this player appears in, newest first. */
  function playerDemos(id) {
    const out = [];
    for (const demo of payload?.demos || []) {
      const seat = (demo.players || []).find((p) => p.id === id);
      const team = seat?.team === 1 ? 1 : seat?.team === 2 ? 2 : 0;
      if (!team) continue;
      out.push({
        id: demo.id,
        map: demo.map || '',
        team: (team === 1 ? demo.name1 : demo.name2) || 'Unknown',
        opponent: (team === 1 ? demo.name2 : demo.name1) || 'Unknown',
        uploadedAt: demo.uploadedAt || 0
      });
    }
    return out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  }

  function mapCounts(id) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const d of playerDemos(id)) {
      if (!d.map) continue;
      counts.set(d.map, (counts.get(d.map) || 0) + 1);
    }
    return counts;
  }

  function matches() {
    if (!state.playerId || !state.mapCode) return [];
    return playerDemos(state.playerId).filter((d) => d.map === state.mapCode);
  }

  function includedMatches() {
    return matches().filter((d) => !state.excluded.has(d.id));
  }

  function matchLabel(d) {
    const when = shortDate(d.uploadedAt);
    return `${d.team} vs ${d.opponent}${when ? ` (${when})` : ''}`;
  }

  function canGenerate() {
    return (
      !locked() &&
      !state.busy &&
      Boolean(state.playerId && state.mapCode && state.destTeamId) &&
      includedMatches().length > 0 &&
      [...state.cats].some((k) => PLAYER_CATEGORIES.some((c) => c.key === k))
    );
  }

  // ---- render -------------------------------------------------------------

  function lockedHtml() {
    if (!locked()) return '';
    const plan = requiredPlanName();
    return `<div class="an-warn as-locked">${
      plan
        ? `Player scout is available on ${escapeHtml(plan)}.`
        : 'Player scout is not available on your plan.'
    }</div>`;
  }

  function playerSuggestions() {
    const q = playerSearch.trim().toLowerCase();
    if (!q) return [];
    return players
      .filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .sort((a, b) => b.maps.length - a.maps.length || a.name.localeCompare(b.name))
      .slice(0, 12);
  }

  function refreshPlayerMenu() {
    const menu = el.querySelector('#ps-player-menu');
    if (!menu) return;
    const opts = playerSuggestions();
    const q = playerSearch.trim();
    menu.hidden = !playerMenuOpen || (!opts.length && !q);
    if (menu.hidden) return;
    menu.innerHTML = opts.length
      ? opts
          .map(
            (p) => `<button type="button" class="an-suggest" data-ps-pick-player="${escapeHtml(p.id)}">
              <span class="an-suggest-main"><strong>${escapeHtml(p.name)}</strong>
              <span class="an-muted">${p.maps.length} ${p.maps.length === 1 ? 'map' : 'maps'}</span></span>
            </button>`
          )
          .join('')
      : `<p class="rp-typeahead-empty">No matches</p>`;
  }

  function playerStepHtml() {
    const picked = selectedPlayer();
    const counts = state.playerId ? mapCounts(state.playerId) : new Map();
    const mapOpts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(
        ([code, n]) =>
          `<option value="${escapeHtml(code)}"${code === state.mapCode ? ' selected' : ''}>${escapeHtml(
            MAPS[code]?.name || code
          )} (${n})</option>`
      )
      .join('');
    const n = state.mapCode ? matches().length : 0;
    const warn =
      state.mapCode && n < PLAYER_MIN_MATCHES
        ? `<p class="an-warn">Only ${n} ${n === 1 ? 'match' : 'matches'} on this map. At least ${PLAYER_MIN_MATCHES} are recommended.</p>`
        : '';
    return `<section class="an-card as-step">
      <header class="an-card-head"><h3 class="an-section-title">Player and map</h3></header>
      <div class="as-step-body">
        <div class="as-controls">
          <div class="as-team-box" id="ps-player-box">
            ${
              picked
                ? `<button type="button" class="as-picked" data-ps-clear-player title="Change player">${escapeHtml(
                    picked.name
                  )} <span>change</span></button>`
                : `${mbWrap(
                    'search',
                    `<input type="search" class="site-input" id="ps-player-search"
                    placeholder="Search players…" spellcheck="false" autocomplete="off"
                    value="${escapeHtml(playerSearch)}" aria-label="Search players" />`
                  )}
                  <div class="rp-typeahead-menu as-team-menu" id="ps-player-menu" hidden></div>`
            }
          </div>
          ${mbWrap(
            'map',
            `<select class="site-select an-select" data-ps-map aria-label="Map" ${
              state.playerId ? '' : 'disabled'
            }>
            <option value="">Map</option>
            ${mapOpts}
          </select>`
          )}
        </div>
        ${warn}
      </div>
    </section>`;
  }

  function matchesStepHtml() {
    if (!state.playerId || !state.mapCode) return '';
    const rows = matches()
      .map((d) => {
        const on = !state.excluded.has(d.id);
        return `<label class="as-match${on ? '' : ' off'}">
          <input type="checkbox" data-ps-match="${escapeHtml(d.id)}" ${on ? 'checked' : ''} />
          <span>${escapeHtml(matchLabel(d))}</span>
        </label>`;
      })
      .join('');
    return `<section class="an-card as-step">
      <header class="an-card-head">
        <h3 class="an-section-title">Matches <small>${includedMatches().length} of ${matches().length}</small></h3>
      </header>
      <div class="as-step-body as-match-list">${rows}</div>
    </section>`;
  }

  function categoriesStepHtml() {
    if (!state.playerId || !state.mapCode) return '';
    const groups = PLAYER_GROUPS.map((group) => {
      const rows = PLAYER_CATEGORIES.filter((c) => c.group === group)
        .map(
          (c) => `<label class="as-cat-main">
            <input type="checkbox" data-ps-cat="${escapeHtml(c.key)}" ${
              state.cats.has(c.key) ? 'checked' : ''
            } />
            <span>${escapeHtml(c.label)}</span>
          </label>`
        )
        .join('');
      return `<div class="as-cat-group">
        <p class="an-side-title">${escapeHtml(group)}</p>
        ${rows}
      </div>`;
    }).join('');
    return `<section class="an-card as-step">
      <header class="an-card-head"><h3 class="an-section-title">Categories</h3></header>
      <div class="as-step-body as-cats">${groups}</div>
    </section>`;
  }

  function outputStepHtml() {
    if (!state.playerId || !state.mapCode) return '';
    let dest;
    if (myTeams === null) {
      dest = `<p class="an-muted">${myTeamsError ? escapeHtml(myTeamsError) : 'Loading your teams…'}</p>`;
    } else if (!myTeams.length) {
      dest = `<p class="an-muted">You are not in a team.</p>`;
    } else {
      dest = `<select class="site-select an-select" data-ps-dest aria-label="Destination team">
        ${myTeams
          .map(
            (t) =>
              `<option value="${escapeHtml(t.id)}"${t.id === state.destTeamId ? ' selected' : ''}>${escapeHtml(
                t.name
              )}</option>`
          )
          .join('')}
      </select>`;
    }
    const status = state.busy
      ? `<p class="as-status">${escapeHtml(state.progress || 'Scanning…')}</p>`
      : state.outcome === 'ok'
        ? `<p class="as-status ok">${escapeHtml(state.outcomeMsg)} <a href="/team/documents">Open Documents</a></p>`
        : state.outcome === 'error'
          ? `<p class="as-status error">${escapeHtml(state.outcomeMsg)}</p>`
          : '';
    return `<section class="an-card as-step">
      <header class="an-card-head"><h3 class="an-section-title">Document</h3></header>
      <div class="as-step-body">
        <div class="as-controls">
          ${dest}
          <button type="button" class="btn primary btn-sm" data-ps-generate ${
            canGenerate() ? '' : 'disabled'
          }>${state.busy ? 'Analyzing…' : 'Analyze and save'}</button>
          ${allowanceHtml()}
        </div>
        <label class="as-cat-main">
          <input type="checkbox" data-ps-linkutil ${state.linkUtility ? 'checked' : ''} />
          <span>Add the grenades to this team's utility archive and link them</span>
        </label>
        ${status}
      </div>
    </section>`;
  }

  function render() {
    if (!payload) {
      if (loadError) {
        el.innerHTML = `<p class="view-empty">${escapeHtml(loadError)}</p>
          <button type="button" class="btn btn-sm" data-ps-retry>Retry</button>`;
        return;
      }
      el.innerHTML = spinnerHtml('Loading players…');
      return;
    }
    if (!players.length) {
      el.innerHTML = `<p class="view-empty">No players in the library yet.</p>`;
      return;
    }
    el.innerHTML = `
      ${lockedHtml()}
      <div class="as-flow">
        ${playerStepHtml()}
        ${matchesStepHtml()}
        ${categoriesStepHtml()}
        ${outputStepHtml()}
      </div>`;
    if (playerMenuOpen) refreshPlayerMenu();
  }

  /** Update only the status line while a scan runs; a full render would drop focus. */
  function renderProgress() {
    const line = el.querySelector('.as-status');
    if (line) line.textContent = state.progress;
    else render();
  }

  function setProgress(text) {
    state.progress = text;
    renderProgress();
  }

  // ---- generate -----------------------------------------------------------

  async function generate() {
    if (!canGenerate()) return;
    const player = selectedPlayer();
    const dest = (myTeams || []).find((t) => t.id === state.destTeamId);
    if (!player || !dest) return;

    state.busy = true;
    state.progress = 'Checking the allowance…';
    state.outcome = '';
    state.outcomeMsg = '';
    render();

    // Spend the use here, not when the panel opens: picking a player and
    // reading the match list is free, running the report is what costs. A
    // refusal puts the shared upgrade dialog up and nothing is scanned. Re-read
    // /api/me either way, so the badge above shows what is actually left,
    // including what a teammate spent while this page was open.
    const granted = await useMeteredFeature(CAP.ANALYTICS_ANTISTRAT);
    await ent()?.refresh?.();
    if (!granted) {
      state.busy = false;
      state.progress = '';
      render();
      return;
    }

    setProgress('Preparing scan…');

    const included = includedMatches();
    const title = `Player: ${player.name} on ${MAPS[state.mapCode]?.name || state.mapCode}`;
    try {
      // The picker runs on the catalogue, which carries no rounds. Fetch them
      // now, scoped to the matches this run actually covers.
      let scanPayload = payload;
      if (payload?.identityOnly) {
        setProgress('Loading rounds for these matches…');
        scanPayload = await getStatsPayload(
          included.map((d) => d.id),
          {
            // Round-library tags name what the team ran; roles name the four
            // bodies around him. Nothing else is read.
            columns: ['roundLibrary', 'roles'],
            onProgress: (p) => setProgress(statsProgressLabel(p))
          }
        );
      }
      const results = await runPlayerScan({
        payload: scanPayload,
        playerId: state.playerId,
        mapCode: state.mapCode,
        demoIds: included.map((d) => d.id),
        onProgress: (done, total) => setProgress(`Scanning round ${done} of ${total}…`)
      });

      // Second pass: the rounds the scan picked out, written the way a
      // strategy is written. Its failure is not the report's failure.
      let notes = new Map();
      let utilityNote = '';
      const picks = notePicks(results);
      if (picks.length) {
        setProgress('Writing strategies…');
        const written = await writeScoutNotes({
          mapCode: state.mapCode,
          playerId: state.playerId,
          playerName: results.playerName,
          teamId: dest.id,
          linkUtility: state.linkUtility,
          picks,
          onProgress: setProgress
        }).catch((err) => ({
          notes: new Map(),
          utilityError: formatApiError(err).message || String(err)
        }));
        notes = written.notes || new Map();
        if (written.utilityError) {
          utilityNote = `Utility is not linked in this report: ${written.utilityError}`;
        } else if (written.utilityDropped) {
          utilityNote = `${written.utilityDropped} throws did not fit the utility archive and are unlinked.`;
        }
      }

      setProgress('Writing document…');
      await saveTeamDocument(dest.id, {
        title,
        html: buildPlayerDocHtml(
          {
            playerName: results.playerName,
            playerId: state.playerId,
            teamName: results.teamName,
            mapCode: state.mapCode,
            roles: results.roles,
            mates: results.mates,
            matches: included.map((d) => ({ label: matchLabel(d) })),
            categories: [...state.cats],
            results,
            notes,
            utilityNote
          },
          escapeHtml
        )
      });
      state.outcome = 'ok';
      state.outcomeMsg = `Saved "${title}" to ${dest.name}. ${results.rounds} rounds scanned.`;
    } catch (err) {
      state.outcome = 'error';
      state.outcomeMsg = formatApiError(err).message || String(err);
    }
    state.busy = false;
    state.progress = '';
    render();
  }

  // ---- events -------------------------------------------------------------

  el.addEventListener('input', (e) => {
    if (e.target.id === 'ps-player-search') {
      playerSearch = e.target.value;
      playerMenuOpen = true;
      refreshPlayerMenu();
    }
  });

  el.addEventListener('focusin', (e) => {
    if (e.target.id === 'ps-player-search') {
      playerMenuOpen = true;
      refreshPlayerMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#ps-player-box') && playerMenuOpen) {
      playerMenuOpen = false;
      refreshPlayerMenu();
    }
  });

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-ps-map]')) {
      state.mapCode = t.value || '';
      state.excluded.clear();
      state.outcome = '';
      render();
      return;
    }
    const match = t.closest('[data-ps-match]');
    if (match) {
      const id = match.dataset.psMatch;
      if (match.checked) state.excluded.delete(id);
      else state.excluded.add(id);
      render();
      return;
    }
    const cat = t.closest('[data-ps-cat]');
    if (cat) {
      const key = cat.dataset.psCat;
      if (cat.checked) state.cats.add(key);
      else state.cats.delete(key);
      render();
      return;
    }
    if (t.matches('[data-ps-linkutil]')) {
      state.linkUtility = Boolean(t.checked);
      return;
    }
    if (t.matches('[data-ps-dest]')) {
      state.destTeamId = t.value || '';
      render();
    }
  });

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-ps-retry]')) {
      void load(null);
      return;
    }
    const pick = e.target.closest('[data-ps-pick-player]');
    if (pick) {
      state.playerId = pick.dataset.psPickPlayer;
      state.mapCode = '';
      state.excluded.clear();
      state.outcome = '';
      playerSearch = '';
      playerMenuOpen = false;
      render();
      return;
    }
    if (e.target.closest('[data-ps-clear-player]')) {
      state.playerId = '';
      state.mapCode = '';
      state.excluded.clear();
      state.outcome = '';
      render();
      el.querySelector('#ps-player-search')?.focus();
      return;
    }
    if (e.target.closest('[data-ps-generate]')) void generate();
  });

  // ---- load ---------------------------------------------------------------

  function ensureMyTeams() {
    if (myTeams !== null || myTeamsError) return;
    void fetchTeams()
      .then((list) => {
        myTeams = (list || []).map((t) => ({ id: t.id, name: t.name }));
        if (!state.destTeamId && myTeams.length) state.destTeamId = myTeams[0].id;
        render();
      })
      .catch((err) => {
        myTeamsError = formatApiError(err).message || 'Could not load your teams.';
        render();
      });
  }

  /**
   * The roster catalogue in the shape the picker already reads. Identity only,
   * and `rounds` is deliberately empty: `identityOnly` marks it so generate()
   * knows to fetch the real rounds for the demos it is about to scan.
   */
  function catalogFromRoster(roster) {
    const rosterPlayers = roster?.players || [];
    const demos = (roster?.demos || []).map((d) => {
      const seats = [];
      const pairs = d.p || [];
      for (let i = 0; i < pairs.length; i += 2) {
        const p = rosterPlayers[pairs[i]];
        if (p?.i) seats.push({ id: p.i, name: p.n || p.i, team: pairs[i + 1] === 2 ? 2 : 1 });
      }
      return {
        id: d.id,
        map: d.m || '',
        t1: d.t1 || '',
        t2: d.t2 || '',
        name1: d.n1 || '',
        name2: d.n2 || '',
        uploadedAt: d.u || 0,
        players: seats,
        rounds: []
      };
    });
    return { demos, identityOnly: true };
  }

  function applyPayload(statsPayload) {
    payload = statsPayload;
    loadError = '';
    players = payload ? listPlayers(payload) : [];
    if (state.playerId && !players.some((p) => p.id === state.playerId)) {
      state.playerId = '';
      state.mapCode = '';
      state.excluded.clear();
    }
    render();
    ensureMyTeams();
  }

  /**
   * @param {object|null|undefined} statsPayload  shared pattern-finder payload, or
   *   null/undefined to keep the current one / self-fetch when still empty
   */
  async function load(statsPayload) {
    if (statsPayload) {
      loadToken += 1;
      fetching = false;
      applyPayload(statsPayload);
      return;
    }
    if (payload) {
      render();
      ensureMyTeams();
      return;
    }
    if (fetching) return;
    const token = ++loadToken;
    loadError = '';
    fetching = true;
    el.innerHTML = spinnerHtml('Loading players…');
    try {
      // The roster catalogue, NOT the library's stats payload: this step picks
      // a player and then a match, and all of that is identity.
      const roster = await fetchRoster();
      if (token !== loadToken) return;
      applyPayload(catalogFromRoster(roster));
    } catch (err) {
      if (token !== loadToken) return;
      loadError = formatApiError(err).message || 'Could not load players.';
      render();
    } finally {
      if (token === loadToken) fetching = false;
    }
  }

  return {
    el,
    load,
    destroy() {
      loadToken += 1;
      el.remove();
    }
  };
}
