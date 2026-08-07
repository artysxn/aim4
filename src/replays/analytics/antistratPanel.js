// ---------------------------------------------------------------------------
// Teams antistrat: scout a library team on one map and write the findings
// into a team document.
//
// Flow: team → map (with a reliability warning under ANTISTRAT_MIN_MATCHES)
// → included matches → categories with a detail level each → generate. The
// generated document lands in the destination team's Documents tab; analysis
// content is skeleton-only until the analyzers land (see antistratConfig.js).
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
  ANTISTRAT_DETAIL,
  ANTISTRAT_GROUPS,
  ANTISTRAT_MIN_MATCHES,
  buildAntistratDocHtml
} from './antistratConfig.js';
import { spinnerHtml } from '../../lib/spinner.js';

function matchDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return '';
  }
}

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

  const state = {
    teamKey: '',
    mapCode: '',
    /** @type {Set<string>} demo ids dropped from the run */
    excluded: new Set(),
    /** @type {Set<string>} selected category keys */
    cats: new Set(ANTISTRAT_CATEGORIES.filter((c) => !c.wip).map((c) => c.key)),
    /** @type {Record<string, 'compact'|'detailed'>} */
    detail: {},
    destTeamId: '',
    busy: false,
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
    const when = matchDate(d.uploadedAt);
    return `vs ${d.opponent}${when ? `, ${when}` : ''}`;
  }

  function canGenerate() {
    return (
      !locked() &&
      !state.busy &&
      Boolean(state.teamKey && state.mapCode && state.destTeamId) &&
      includedMatches().length > 0 &&
      [...state.cats].some((k) => {
        const cat = ANTISTRAT_CATEGORIES.find((c) => c.key === k);
        return cat && !cat.wip;
      })
    );
  }

  // ---- render -------------------------------------------------------------

  function lockedHtml() {
    if (!locked()) return '';
    return `<div class="an-warn as-locked">Teams antistrat needs ${escapeHtml(
      requiredPlanName()
    )}.</div>`;
  }

  function teamStepHtml() {
    const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
    const counts = state.teamKey ? mapCounts(state.teamKey) : new Map();
    const mapOpts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(
        ([code, n]) =>
          `<option value="${escapeHtml(code)}"${code === state.mapCode ? ' selected' : ''}>${escapeHtml(
            MAPS[code]?.name || code
          )} (${n} ${n === 1 ? 'match' : 'matches'})</option>`
      )
      .join('');
    const n = state.mapCode ? matches().length : 0;
    const warn =
      state.mapCode && n < ANTISTRAT_MIN_MATCHES
        ? `<p class="an-warn">Only ${n} ${n === 1 ? 'match' : 'matches'} of ${escapeHtml(
            MAPS[state.mapCode]?.name || state.mapCode
          )} in the library. At least ${ANTISTRAT_MIN_MATCHES} are recommended for a reliable read.</p>`
        : '';
    return `<section class="an-card as-step">
      <header class="an-card-head"><h3 class="an-section-title">Team and map</h3></header>
      <div class="as-step-body">
        <div class="as-controls">
          <select class="site-select an-select" data-as-team aria-label="Team">
            <option value="">Team</option>
            ${sorted
              .map(
                (t) =>
                  `<option value="${escapeHtml(t.key)}"${t.key === state.teamKey ? ' selected' : ''}>${escapeHtml(
                    t.name
                  )}</option>`
              )
              .join('')}
          </select>
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
        <h3 class="an-section-title">Matches <small>${includedMatches().length} of ${matches().length} included</small></h3>
      </header>
      <div class="as-step-body as-match-list">${rows}</div>
    </section>`;
  }

  function categoriesStepHtml() {
    if (!state.teamKey || !state.mapCode) return '';
    const groups = ANTISTRAT_GROUPS.map((group) => {
      const rows = ANTISTRAT_CATEGORIES.filter((c) => c.group === group)
        .map((c) => {
          const on = state.cats.has(c.key) && !c.wip;
          const level = state.detail[c.key] === 'detailed' ? 'detailed' : 'compact';
          return `<div class="as-cat${c.wip ? ' wip' : ''}">
            <label class="as-cat-main">
              <input type="checkbox" data-as-cat="${escapeHtml(c.key)}" ${on ? 'checked' : ''} ${
                c.wip ? 'disabled' : ''
              } />
              <span class="as-cat-label">${escapeHtml(c.label)}${
                c.wip ? ' <span class="an-wip-chip">WIP</span>' : ''
              }</span>
            </label>
            ${c.wip ? '' : `<p class="as-cat-desc">${escapeHtml(c.desc)}</p>`}
            ${
              c.wip
                ? ''
                : `<select class="site-select an-select as-detail" data-as-detail="${escapeHtml(
                    c.key
                  )}" aria-label="Detail for ${escapeHtml(c.label)}">
                    ${ANTISTRAT_DETAIL.map(
                      (d) =>
                        `<option value="${escapeHtml(d.key)}"${d.key === level ? ' selected' : ''}>${escapeHtml(
                          d.label
                        )}</option>`
                    ).join('')}
                  </select>`
            }
          </div>`;
        })
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
      dest = `<p class="an-muted">You are not in a team. The document needs a team to land in.</p>`;
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
    const status =
      state.outcome === 'ok'
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
          }>${state.busy ? 'Generating…' : 'Generate document'}</button>
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
      el.innerHTML = `<p class="view-empty">No teams in the library yet. Upload demos with team names to scout them.</p>`;
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
  }

  // ---- generate -----------------------------------------------------------

  async function generate() {
    if (!canGenerate()) return;
    const team = selectedTeam();
    const dest = (myTeams || []).find((t) => t.id === state.destTeamId);
    if (!team || !dest) return;

    state.busy = true;
    state.outcome = '';
    state.outcomeMsg = '';
    render();

    const included = includedMatches();
    const spec = {
      teamName: team.name,
      mapCode: state.mapCode,
      matches: included.map((d) => ({ id: d.id, label: matchLabel(d) })),
      categories: [...state.cats],
      detail: { ...state.detail },
      generatedAt: Date.now()
    };
    const title = `Antistrat: ${team.name} on ${MAPS[state.mapCode]?.name || state.mapCode}`;
    try {
      await saveTeamDocument(dest.id, {
        title,
        html: buildAntistratDocHtml(spec, escapeHtml)
      });
      state.outcome = 'ok';
      state.outcomeMsg = `Saved "${title}" to ${dest.name}.`;
    } catch (err) {
      state.outcome = 'error';
      state.outcomeMsg = formatApiError(err).message || String(err);
    }
    state.busy = false;
    render();
  }

  // ---- events -------------------------------------------------------------

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-as-team]')) {
      state.teamKey = t.value || '';
      state.mapCode = '';
      state.excluded.clear();
      state.outcome = '';
      render();
      return;
    }
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
    const detail = t.closest('[data-as-detail]');
    if (detail) {
      state.detail[detail.dataset.asDetail] =
        detail.value === 'detailed' ? 'detailed' : 'compact';
      return;
    }
    if (t.matches('[data-as-dest]')) {
      state.destTeamId = t.value || '';
      render();
    }
  });

  el.addEventListener('click', (e) => {
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
