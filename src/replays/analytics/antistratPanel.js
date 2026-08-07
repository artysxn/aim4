// ---------------------------------------------------------------------------
// Teams antistrat: scout a library team on one map and write the findings
// into a team document.
//
// Flow: team (typeahead search) → map (warns under ANTISTRAT_MIN_MATCHES) →
// included matches → categories → generate. Generate runs the scan engine
// over the selected demos (antistratScan.js) and saves the rendered report
// into the destination team's Documents tab.
// ---------------------------------------------------------------------------

import { fetchTeams, saveTeamDocument, formatApiError } from '../api.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import { PLAN_NAMES } from '../../../shared/entitlements/catalogue.js';
import { getEntitlements } from '../../lib/entitlements.js';
import { MAPS } from '../shared/roundId.js';
import { teamNameKey } from '../shared/statsMath.js';
import { listTeams } from './analyticsMath.js';
import {
  ANTISTRAT_CATEGORIES,
  ANTISTRAT_GROUPS,
  ANTISTRAT_MIN_MATCHES,
  buildAntistratDocHtml,
  shortDate
} from './antistratConfig.js';
import { runAntistratScan } from './antistratScan.js';
import { heatDataUri, heatGridDataUri, spacingChartDataUri } from './heatImage.js';
import { PACE_TYPES } from './patternDefs.js';
import { spinnerHtml } from '../../lib/spinner.js';

/**
 * @param {{ escapeHtml: (s: string) => string }} deps
 */
export function createAntistratPanel({ escapeHtml }) {
  const el = document.createElement('div');
  el.className = 'as-panel';
  el.innerHTML = spinnerHtml('Loading teams…');

  let payload = null;
  /** @type {ReturnType<typeof listTeams>} */
  let teams = [];
  /** @type {Array<{id: string, name: string}>|null} own teams; null until fetched */
  let myTeams = null;
  let myTeamsError = '';
  let teamSearch = '';
  let teamMenuOpen = false;

  const state = {
    teamKey: '',
    mapCode: '',
    /** @type {Set<string>} demo ids dropped from the run */
    excluded: new Set(),
    /** @type {Set<string>} selected category keys */
    cats: new Set(ANTISTRAT_CATEGORIES.map((c) => c.key)),
    destTeamId: '',
    busy: false,
    progress: '',
    /** '' | 'ok' | 'error' */
    outcome: '',
    outcomeMsg: ''
  };

  function ent() {
    return getEntitlements();
  }

  function locked() {
    const e = ent();
    return e ? !e.can(CAP.ANALYTICS_ANTISTRAT) : false;
  }

  function requiredPlanName() {
    const e = ent();
    const plan = e?.requiredPlan?.(CAP.ANALYTICS_ANTISTRAT);
    return (plan && PLAN_NAMES[plan]) || PLAN_NAMES.team_premium;
  }

  function selectedTeam() {
    return teams.find((t) => t.key === state.teamKey) || null;
  }

  /** Library demos where the scouted team plays, newest first. */
  function teamDemos(key) {
    const out = [];
    for (const demo of payload?.demos || []) {
      const k1 = teamNameKey(demo.name1, demo.t1);
      const k2 = teamNameKey(demo.name2, demo.t2);
      if (k1 !== key && k2 !== key) continue;
      const opponent = k1 === key ? demo.name2 : demo.name1;
      out.push({
        id: demo.id,
        map: demo.map || '',
        opponent: opponent || 'Unknown',
        uploadedAt: demo.uploadedAt || 0
      });
    }
    return out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  }

  function mapCounts(key) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const d of teamDemos(key)) {
      if (!d.map) continue;
      counts.set(d.map, (counts.get(d.map) || 0) + 1);
    }
    return counts;
  }

  function matches() {
    if (!state.teamKey || !state.mapCode) return [];
    return teamDemos(state.teamKey).filter((d) => d.map === state.mapCode);
  }

  function includedMatches() {
    return matches().filter((d) => !state.excluded.has(d.id));
  }

  function matchLabel(d) {
    const when = shortDate(d.uploadedAt);
    return `vs ${d.opponent}${when ? ` (${when})` : ''}`;
  }

  function canGenerate() {
    return (
      !locked() &&
      !state.busy &&
      Boolean(state.teamKey && state.mapCode && state.destTeamId) &&
      includedMatches().length > 0 &&
      [...state.cats].some((k) => ANTISTRAT_CATEGORIES.some((c) => c.key === k))
    );
  }

  // ---- render -------------------------------------------------------------

  function lockedHtml() {
    if (!locked()) return '';
    return `<div class="an-warn as-locked">Teams antistrat needs ${escapeHtml(
      requiredPlanName()
    )}.</div>`;
  }

  function teamSuggestions() {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return [];
    return teams
      .filter((t) => t.name.toLowerCase().includes(q) || t.key.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 12);
  }

  function refreshTeamMenu() {
    const menu = el.querySelector('#as-team-menu');
    if (!menu) return;
    const opts = teamSuggestions();
    const q = teamSearch.trim();
    menu.hidden = !teamMenuOpen || (!opts.length && !q);
    if (menu.hidden) return;
    menu.innerHTML = opts.length
      ? opts
          .map(
            (t) => `<button type="button" class="an-suggest" data-as-pick-team="${escapeHtml(t.key)}">
              <span class="an-suggest-main"><strong>${escapeHtml(t.name)}</strong>
              <span class="an-muted">${t.maps.length} ${t.maps.length === 1 ? 'map' : 'maps'}</span></span>
            </button>`
          )
          .join('')
      : `<p class="rp-typeahead-empty">No matches</p>`;
  }

  function teamStepHtml() {
    const picked = selectedTeam();
    const counts = state.teamKey ? mapCounts(state.teamKey) : new Map();
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
      state.mapCode && n < ANTISTRAT_MIN_MATCHES
        ? `<p class="an-warn">Only ${n} ${n === 1 ? 'match' : 'matches'} on this map. At least ${ANTISTRAT_MIN_MATCHES} are recommended.</p>`
        : '';
    return `<section class="an-card as-step">
      <header class="an-card-head"><h3 class="an-section-title">Team and map</h3></header>
      <div class="as-step-body">
        <div class="as-controls">
          <div class="as-team-box" id="as-team-box">
            ${
              picked
                ? `<button type="button" class="an-sel-chip" data-as-clear-team title="Change team">${escapeHtml(
                    picked.name
                  )} <span aria-hidden="true">×</span></button>`
                : `<input type="search" class="site-input" id="as-team-search"
                    placeholder="Search teams…" spellcheck="false" autocomplete="off"
                    value="${escapeHtml(teamSearch)}" aria-label="Search teams" />
                  <div class="rp-typeahead-menu as-team-menu" id="as-team-menu" hidden></div>`
            }
          </div>
          <select class="site-select an-select" data-as-map aria-label="Map" ${state.teamKey ? '' : 'disabled'}>
            <option value="">Map</option>
            ${mapOpts}
          </select>
        </div>
        ${warn}
      </div>
    </section>`;
  }

  function matchesStepHtml() {
    if (!state.teamKey || !state.mapCode) return '';
    const rows = matches()
      .map((d) => {
        const on = !state.excluded.has(d.id);
        return `<label class="as-match${on ? '' : ' off'}">
          <input type="checkbox" data-as-match="${escapeHtml(d.id)}" ${on ? 'checked' : ''} />
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
    if (!state.teamKey || !state.mapCode) return '';
    const groups = ANTISTRAT_GROUPS.map((group) => {
      const rows = ANTISTRAT_CATEGORIES.filter((c) => c.group === group)
        .map(
          (c) => `<label class="as-cat-main">
            <input type="checkbox" data-as-cat="${escapeHtml(c.key)}" ${
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
    if (!state.teamKey || !state.mapCode) return '';
    let dest;
    if (myTeams === null) {
      dest = `<p class="an-muted">${myTeamsError ? escapeHtml(myTeamsError) : 'Loading your teams…'}</p>`;
    } else if (!myTeams.length) {
      dest = `<p class="an-muted">You are not in a team.</p>`;
    } else {
      dest = `<select class="site-select an-select" data-as-dest aria-label="Destination team">
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
          <button type="button" class="btn primary btn-sm" data-as-generate ${
            canGenerate() ? '' : 'disabled'
          }>${state.busy ? 'Analyzing…' : 'Analyze and save'}</button>
        </div>
        ${status}
      </div>
    </section>`;
  }

  function render() {
    if (!payload) {
      el.innerHTML = spinnerHtml('Loading teams…');
      return;
    }
    if (!teams.length) {
      el.innerHTML = `<p class="view-empty">No teams in the library yet.</p>`;
      return;
    }
    el.innerHTML = `
      ${lockedHtml()}
      <div class="as-flow">
        ${teamStepHtml()}
        ${matchesStepHtml()}
        ${categoriesStepHtml()}
        ${outputStepHtml()}
      </div>`;
    if (teamMenuOpen) refreshTeamMenu();
  }

  /** Update only the status line while a scan runs; a full render would drop focus. */
  function renderProgress() {
    const line = el.querySelector('.as-status');
    if (line) line.textContent = state.progress;
    else render();
  }

  // ---- generate -----------------------------------------------------------

  async function generate() {
    if (!canGenerate()) return;
    const team = selectedTeam();
    const dest = (myTeams || []).find((t) => t.id === state.destTeamId);
    if (!team || !dest) return;

    state.busy = true;
    state.progress = 'Preparing scan…';
    state.outcome = '';
    state.outcomeMsg = '';
    render();

    const included = includedMatches();
    const title = `Antistrat: ${team.name} on ${MAPS[state.mapCode]?.name || state.mapCode}`;
    try {
      const results = await runAntistratScan({
        payload,
        teamKey: state.teamKey,
        mapCode: state.mapCode,
        demoIds: included.map((d) => d.id),
        paceKeys: PACE_TYPES.map((p) => p.key),
        onProgress: (done, total) => {
          state.progress = `Scanning round ${done} of ${total}…`;
          renderProgress();
        }
      });
      state.progress = 'Rendering images…';
      renderProgress();

      const images = {};
      const sections = results.sections;
      if (state.cats.has('firstEngagement')) {
        images.firstEngagement = {};
        for (const side of ['T', 'CT']) {
          const points = sections.firstEngagement?.[side]?.points;
          if (points?.length) {
            images.firstEngagement[side] = await heatDataUri(state.mapCode, points, {
              label: `First engagements, ${side}`
            });
          }
        }
      }
      images.spacing = {};
      for (const key of ['fiveVfour', 'fourVfive']) {
        if (!state.cats.has(key)) continue;
        images.spacing[key] = {};
        for (const side of ['T', 'CT']) {
          const block = sections[key]?.[side];
          if (block?.spacing?.n) {
            images.spacing[key][side] = spacingChartDataUri(block.spacing, {
              title: `Avg spacing after the opening kill, ${side} (${block.spacing.n} rounds)`
            });
          }
        }
      }
      if (state.cats.has('players')) {
        images.players = {};
        for (const p of sections.players || []) {
          images.players[p.name] = {};
          for (const side of ['T', 'CT']) {
            const bag = p.sides[side];
            if (!bag) continue;
            const uri = await heatGridDataUri(state.mapCode, [
              { label: 'Early', points: bag.phases.early.points },
              { label: 'Mid', points: bag.phases.mid.points },
              { label: 'Late', points: bag.phases.late.points },
              { label: 'All', points: bag.phases.all.points }
            ]);
            if (uri) images.players[p.name][side] = uri;
          }
        }
      }

      state.progress = 'Writing document…';
      renderProgress();
      await saveTeamDocument(dest.id, {
        title,
        html: buildAntistratDocHtml(
          {
            teamName: team.name,
            mapCode: state.mapCode,
            matches: included.map((d) => ({ label: matchLabel(d) })),
            categories: [...state.cats],
            results,
            images
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
    if (e.target.id === 'as-team-search') {
      teamSearch = e.target.value;
      teamMenuOpen = true;
      refreshTeamMenu();
    }
  });

  el.addEventListener('focusin', (e) => {
    if (e.target.id === 'as-team-search') {
      teamMenuOpen = true;
      refreshTeamMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('#as-team-box') && teamMenuOpen) {
      teamMenuOpen = false;
      refreshTeamMenu();
    }
  });

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-as-map]')) {
      state.mapCode = t.value || '';
      state.excluded.clear();
      state.outcome = '';
      render();
      return;
    }
    const match = t.closest('[data-as-match]');
    if (match) {
      const id = match.dataset.asMatch;
      if (match.checked) state.excluded.delete(id);
      else state.excluded.add(id);
      render();
      return;
    }
    const cat = t.closest('[data-as-cat]');
    if (cat) {
      const key = cat.dataset.asCat;
      if (cat.checked) state.cats.add(key);
      else state.cats.delete(key);
      render();
      return;
    }
    if (t.matches('[data-as-dest]')) {
      state.destTeamId = t.value || '';
      render();
    }
  });

  el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-as-pick-team]');
    if (pick) {
      state.teamKey = pick.dataset.asPickTeam;
      state.mapCode = '';
      state.excluded.clear();
      state.outcome = '';
      teamSearch = '';
      teamMenuOpen = false;
      render();
      return;
    }
    if (e.target.closest('[data-as-clear-team]')) {
      state.teamKey = '';
      state.mapCode = '';
      state.excluded.clear();
      state.outcome = '';
      render();
      const input = el.querySelector('#as-team-search');
      input?.focus();
      return;
    }
    if (e.target.closest('[data-as-generate]')) void generate();
  });

  // ---- load ---------------------------------------------------------------

  /** @param {object} statsPayload  the shared pattern finder payload */
  function load(statsPayload) {
    payload = statsPayload || payload;
    teams = payload ? listTeams(payload) : [];
    if (state.teamKey && !teams.some((t) => t.key === state.teamKey)) {
      state.teamKey = '';
      state.mapCode = '';
      state.excluded.clear();
    }
    render();
    if (myTeams === null && !myTeamsError) {
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
  }

  return {
    el,
    load,
    destroy() {
      el.remove();
    }
  };
}
