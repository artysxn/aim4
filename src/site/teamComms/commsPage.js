// ---------------------------------------------------------------------------
// site/teamComms/commsPage.js — the Team > Communication page
//
// Three jobs, one page:
//   1. Hand out the desktop recorder (the program that captures TeamSpeak).
//   2. Link identities: roster player <-> Steam ID <-> TeamSpeak voice, so
//      every recorded session knows who is speaking.
//   3. Measure the talking: per-player mic-time density across the round —
//      who calls in freezetime, who narrates mid-round, who goes quiet —
//      filterable by map, side, won/lost, buy type, round number and demo.
//
// The heavy inputs (comms transcripts) are fetched once per mount and every
// filter change recomputes from memory; nothing re-downloads on a click.
// ---------------------------------------------------------------------------

import {
  fetchCommsIdentities,
  fetchDemoComms,
  fetchDemoCommsManifest,
  fetchRecorderLatest,
  recorderDownloadUrl,
  setCommsIdentity
} from '../../replays/api.js';
import { ECONOMIES, MAPS } from '../../replays/shared/roundId.js';
import { getEntitlements } from '../../lib/entitlements.js';
import { upgradePrompt } from '../upgradeGate.js';
import { CAP } from '../../../shared/entitlements/keys.js';
import {
  PLAN_NAMES,
  capabilityDef,
  requiredPlanFor
} from '../../../shared/entitlements/catalogue.js';
import {
  T_MAX,
  T_MIN,
  commsMapping,
  densitySeries,
  fmtSeconds,
  roundContexts,
  roundPasses,
  speakerResolver,
  talkSegments,
  teamIndexOf
} from './model.js';

/**
 * Categorical series colors, fixed order, validated for CVD separation and
 * contrast against the site's #0c0c0c surface (dataviz six-checks). A color
 * belongs to a player for the lifetime of the mount: filters that hide a
 * player never repaint the rest.
 */
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
/** More voices than colors folds the quietest into the table only. */
const MAX_SERIES = PALETTE.length;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);

/** Fetch with a small concurrency cap; nulls for failures. */
async function fetchAll(items, fn, limit = 6) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The page's own copy of the route gate, mounted in place of the tool.
 *
 * /team/communication carries `requires: 'team.comms'`, so the router puts the
 * upgrade banner above this page. That banner is not the gate: the team view
 * owns its tabs and mounts a page directly when one is clicked, which never
 * goes through the router, so this function can be reached with no banner in
 * sight. Refusing here is also what stops an unentitled account from pulling
 * a transcript: everything below this point fetches.
 *
 * On a cold load /api/me may not have answered yet, and until it does the
 * manager reports the free tier's value. Rather than leave a paying team
 * looking at a lock, the real page replaces the prompt the moment the answer
 * arrives.
 *
 * The copy comes from the catalogue rather than from the manager: which plan
 * is cheapest for a capability is a property of the ladder, not of the account,
 * so the prompt reads the same with or without an answer in hand.
 *
 * @param {object} deps  the same deps `mountTeamComms` was called with
 * @param {import('../../lib/entitlements.js').EntitlementManager|null} ents
 */
function mountCommsLock(deps, ents) {
  const { host } = deps;
  const tier = requiredPlanFor(CAP.TEAM_COMMS);
  host.innerHTML = '';
  host.appendChild(
    upgradePrompt({
      message: `${capabilityDef(CAP.TEAM_COMMS).label} is available on ${
        PLAN_NAMES[tier] || tier
      }.`,
      requiredTier: tier
    })
  );

  let dropped = false;
  /** The real page, once entitlements say it may exist. */
  let mounted = null;
  void ents?.ready().then(() => {
    if (dropped || !ents.can(CAP.TEAM_COMMS)) return;
    mounted = mountTeamComms(deps);
  });

  return {
    destroy() {
      dropped = true;
      mounted?.destroy();
      mounted = null;
      host.innerHTML = '';
    }
  };
}

/**
 * @param {{
 *   host: HTMLElement,
 *   team: { id: string, name: string },
 *   getTeamDemos: () => Promise<object[]>
 * }} deps
 */
export function mountTeamComms({ host, team, getTeamDemos }) {
  // Communication is a team-tier feature. No manager means no answer to read,
  // and an unverified account is not one to open a team's recordings for.
  const ents = getEntitlements();
  if (!ents?.can(CAP.TEAM_COMMS)) {
    return mountCommsLock({ host, team, getTeamDemos }, ents);
  }

  let dead = false;

  // ---- state ---------------------------------------------------------------
  let release = null;
  let identities = {};
  /** @type {Array<{demo: object, sidecar: object, manifest: object|null, rounds: object[]}>} */
  let sessions = [];
  /** roster player id -> { id, name, steamId, rounds } for this team */
  let roster = new Map();
  let loadNote = 'Loading recordings…';
  let loadFailed = false;
  let demoCount = 0;
  let unsynced = 0;
  /** entity key -> color, assigned once from the full data set */
  let colorOf = new Map();
  const filter = { map: '', side: '', result: '', buy: '', round: '', demoId: '' };

  host.innerHTML = `
    <div class="tm-comms">
      <div class="tm-comms-top">
        <div class="tm-comms-card" data-dl-card>
          <h3>Recorder</h3>
          <p class="tm-comms-muted">
            The desktop program records your TeamSpeak channel during a match and
            packs voice + transcript into a file you attach to the demo.
          </p>
          <p class="tm-comms-muted" data-dl-meta>Checking for the latest build…</p>
        </div>
        <div class="tm-comms-card" data-id-card>
          <h3>Voices</h3>
          <p class="tm-comms-muted">
            Link each TeamSpeak voice to the player it belongs to. A link applies
            to every recorded session, past and future.
          </p>
          <div data-id-table></div>
        </div>
      </div>
      <div class="tm-comms-card tm-comms-graph-card">
        <h3>Who talks when</h3>
        <p class="tm-comms-muted" data-graph-note></p>
        <div class="tm-comms-filters" data-filters hidden></div>
        <div class="tm-comms-graph" data-graph></div>
        <div class="tm-comms-totals" data-totals></div>
      </div>
    </div>`;

  const el = (sel) => host.querySelector(sel);

  // ---- recorder download ---------------------------------------------------
  void fetchRecorderLatest().then((rel) => {
    if (dead) return;
    release = rel;
    const meta = el('[data-dl-meta]');
    if (!meta) return;
    if (!release) {
      meta.textContent = 'No build is published yet — ask the site admin.';
      return;
    }
    const mb = (release.sizeBytes / (1024 * 1024)).toFixed(1);
    meta.innerHTML = `
      <a class="btn btn-primary btn-sm" href="${esc(recorderDownloadUrl(release.version))}" download>
        Download recorder v${esc(release.version)}
      </a>
      <span class="tm-comms-dl-size">${esc(mb)} MB · Windows</span>`;
  });

  // ---- data load -----------------------------------------------------------
  void (async () => {
    try {
      const [demos, ids] = await Promise.all([
        getTeamDemos(),
        fetchCommsIdentities().then((r) => r.identities || {}).catch(() => ({}))
      ]);
      if (dead) return;
      identities = ids;

      // The team roster, aggregated from the demos themselves: the players
      // who actually appear on this team's side, most-seen first.
      for (const d of demos) {
        const ctxs = roundContexts(d, team.name);
        if (!ctxs.length) continue;
        const teamIdx = teamIndexOf(d, team.name);
        for (const p of d.players || []) {
          if (p.team !== teamIdx) continue;
          const cur = roster.get(p.id) || { id: p.id, name: p.name, steamId: p.steamId, rounds: 0 };
          cur.rounds += ctxs.length;
          if (!cur.steamId && p.steamId) cur.steamId = p.steamId;
          roster.set(p.id, cur);
        }
      }

      const sidecars = await fetchAll(demos, async (d) => {
        const r = await fetchDemoComms(d.id);
        return r?.comms ? { demo: d, sidecar: r.comms } : null;
      });
      if (dead) return;
      const withComms = sidecars.filter(Boolean);
      demoCount = withComms.length;

      const manifests = await fetchAll(withComms, (s) =>
        fetchDemoCommsManifest(s.demo.id).then((r) => r.manifest)
      );
      if (dead) return;

      sessions = withComms.map((s, i) => ({
        ...s,
        manifest: manifests[i],
        rounds: roundContexts(s.demo, team.name)
      }));
      unsynced = sessions.filter((s) => !commsMapping(s.sidecar, s.demo)).length;

      assignColors();
      loadNote = '';
    } catch (err) {
      loadFailed = true;
      loadNote = err?.message || 'Could not load recordings.';
    }
    if (!dead) {
      renderIdentityTable();
      renderFilters();
      recompute();
    }
  })();

  // ---- shared computation --------------------------------------------------

  const resolverFor = (s) => speakerResolver(s.sidecar, identities);

  function allSegments(f = null) {
    const rounds = [];
    const segments = [];
    for (const s of sessions) {
      if (!s.manifest) continue;
      const mapping = commsMapping(s.sidecar, s.demo);
      if (!mapping) continue;
      const passing = f ? s.rounds.filter((ctx) => roundPasses(ctx, f)) : s.rounds;
      if (!passing.length) continue;
      rounds.push(...passing);
      segments.push(...talkSegments(s.manifest, mapping, passing, resolverFor(s)));
    }
    return { rounds, segments };
  }

  function nameOf(key) {
    if (key.startsWith('uid:')) {
      const uid = key.slice(4);
      for (const s of sessions) {
        const hit = (s.sidecar.speakers || []).find((sp) => sp.uid === uid);
        if (hit) return hit.nickname;
      }
      return identities[uid]?.nickname || 'Unknown voice';
    }
    return roster.get(key)?.name || key;
  }

  /** Colors come from the UNFILTERED totals so filters never reshuffle them. */
  function assignColors() {
    const { rounds, segments } = allSegments();
    const density = densitySeries(segments, rounds.length);
    colorOf = new Map(
      density
        .sort((a, b) => b.talkSeconds - a.talkSeconds)
        .map((d, i) => [d.key, PALETTE[i % PALETTE.length]])
    );
  }

  // ---- identity table ------------------------------------------------------

  function renderIdentityTable() {
    const box = el('[data-id-table]');
    if (!box) return;
    /** every voice seen across the sessions, with how often */
    const voices = new Map();
    for (const s of sessions) {
      for (const sp of s.sidecar.speakers || []) {
        const cur = voices.get(sp.uid) || { uid: sp.uid, nickname: sp.nickname, demos: 0 };
        cur.demos++;
        cur.nickname = sp.nickname || cur.nickname;
        voices.set(sp.uid, cur);
      }
    }
    for (const [uid, v] of Object.entries(identities)) {
      if (!voices.has(uid)) voices.set(uid, { uid, nickname: v.nickname || uid, demos: 0 });
    }
    if (!voices.size) {
      box.innerHTML = `<p class="tm-comms-muted">No recorded voices yet. Attach a recording to a demo and its speakers appear here.</p>`;
      return;
    }
    const players = [...roster.values()].sort((a, b) => b.rounds - a.rounds);
    const options = (selected) =>
      [
        `<option value="">Not linked</option>`,
        ...players.map(
          (p) =>
            `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`
        )
      ].join('');
    const rows = [...voices.values()]
      .sort((a, b) => b.demos - a.demos)
      .map((v) => {
        const linked = identities[v.uid]?.playerId || '';
        const steam = linked ? roster.get(linked)?.steamId || '' : '';
        return `<tr>
          <td class="tm-comms-voice">
            ${esc(v.nickname)}
            <span class="tm-comms-uid">${esc(v.uid.slice(0, 12))}</span>
          </td>
          <td>
            <select class="site-select tm-comms-link" data-link-uid="${esc(v.uid)}" data-link-nick="${esc(v.nickname)}">
              ${options(linked)}
            </select>
          </td>
          <td class="tm-comms-steam">${steam ? esc(steam) : '<span class="tm-comms-muted">—</span>'}</td>
          <td class="tm-comms-seen">${v.demos ? `${v.demos} demo${v.demos === 1 ? '' : 's'}` : ''}</td>
        </tr>`;
      })
      .join('');
    box.innerHTML = `<table class="tm-comms-table">
      <thead><tr><th>TeamSpeak</th><th>Player</th><th>Steam ID</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  host.addEventListener('change', (e) => {
    const link = e.target.closest?.('[data-link-uid]');
    if (link) {
      const uid = link.dataset.linkUid;
      const playerId = link.value;
      void setCommsIdentity(uid, playerId, link.dataset.linkNick || '')
        .then((r) => {
          if (dead) return;
          identities = r.identities || identities;
          assignColors();
          renderIdentityTable();
          recompute();
        })
        .catch((err) => window.alert(err?.message || 'Could not save the link.'));
      return;
    }
    const f = e.target.closest?.('[data-filter]');
    if (f) {
      filter[f.dataset.filter] = f.value;
      recompute();
    }
  });

  // ---- filters -------------------------------------------------------------

  function renderFilters() {
    const box = el('[data-filters]');
    if (!box) return;
    const maps = [...new Set(sessions.flatMap((s) => (s.rounds[0] ? [s.rounds[0].map] : [])))];
    const maxRound = Math.max(0, ...sessions.flatMap((s) => s.rounds.map((r) => r.round)));
    const sel = (key, label, opts) => `
      <label class="tm-comms-filter">
        <span>${esc(label)}</span>
        <select class="site-select" data-filter="${key}">
          <option value="">All</option>
          ${opts.map(([v, t]) => `<option value="${esc(String(v))}">${esc(t)}</option>`).join('')}
        </select>
      </label>`;
    box.innerHTML = [
      sel('map', 'Map', maps.map((m) => [m, MAPS[m]?.name || m])),
      sel('side', 'Side', [['T', 'T'], ['CT', 'CT']]),
      sel('result', 'Result', [['win', 'Won'], ['loss', 'Lost']]),
      sel('buy', 'Buy', Object.entries(ECONOMIES).map(([k, v]) => [k, v.label])),
      sel(
        'round',
        'Round',
        Array.from({ length: maxRound }, (_, i) => [i + 1, `Round ${i + 1}`])
      ),
      sel('demoId', 'Match', sessions.map((s) => [
        s.demo.id,
        `${s.demo.team1?.name} vs ${s.demo.team2?.name} (${MAPS[s.demo.map]?.name || s.demo.map})`
      ]))
    ].join('');
    box.hidden = false;
  }

  // ---- graph + totals ------------------------------------------------------

  function recompute() {
    const note = el('[data-graph-note]');
    const graph = el('[data-graph]');
    const totals = el('[data-totals]');
    if (!graph) return;
    if (loadFailed) {
      note.textContent = loadNote;
      graph.innerHTML = '';
      totals.innerHTML = '';
      return;
    }
    if (!sessions.length) {
      note.textContent = loadNote || 'No recordings are attached to this team’s demos yet. Record a session, attach it to the demo in the viewer, and the analysis appears here.';
      graph.innerHTML = '';
      totals.innerHTML = '';
      return;
    }
    const f = {
      map: filter.map,
      side: filter.side,
      result: filter.result,
      buy: filter.buy === '' ? null : Number(filter.buy),
      round: filter.round === '' ? null : Number(filter.round),
      demoId: filter.demoId
    };
    const { rounds, segments } = allSegments(f);
    if (!rounds.length) {
      note.textContent = 'No rounds match these filters.';
      graph.innerHTML = '';
      totals.innerHTML = '';
      return;
    }
    const density = densitySeries(segments, rounds.length).sort(
      (a, b) => b.talkSeconds - a.talkSeconds
    );
    const shown = density.slice(0, MAX_SERIES);
    const synced = sessions.filter((s) => s.manifest && commsMapping(s.sidecar, s.demo)).length;
    note.textContent =
      `${rounds.length} round${rounds.length === 1 ? '' : 's'} across ` +
      `${synced} recorded match${synced === 1 ? '' : 'es'}.` +
      (unsynced ? ` ${unsynced} recording${unsynced === 1 ? ' is' : 's are'} not synced and cannot be counted.` : '');
    drawChart(graph, shown, rounds.length);
    renderTotals(totals, density, rounds.length);
  }

  function renderTotals(box, density, roundCount) {
    const totalAll = density.reduce((s, d) => s + d.talkSeconds, 0) || 1;
    box.innerHTML = `<table class="tm-comms-table">
      <thead><tr><th>Player</th><th>Talk time</th><th>Per round</th><th>Share</th></tr></thead>
      <tbody>${density
        .map((d, i) => {
          const color = colorOf.get(d.key);
          const swatch = i < MAX_SERIES && color
            ? `<span class="tm-comms-swatch" style="background:${color}"></span>`
            : `<span class="tm-comms-swatch tm-comms-swatch-off"></span>`;
          return `<tr>
            <td>${swatch}${esc(nameOf(d.key))}</td>
            <td>${fmtSeconds(d.talkSeconds)}</td>
            <td>${(d.talkSeconds / Math.max(1, roundCount)).toFixed(1)}s</td>
            <td>${((d.talkSeconds / totalAll) * 100).toFixed(0)}%</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;
  }

  function drawChart(box, series, roundCount) {
    if (!series.length) {
      box.innerHTML = '<p class="tm-comms-muted">Nothing was said in these rounds.</p>';
      return;
    }
    const W = 920;
    const H = 300;
    const PAD = { l: 44, r: 16, t: 30, b: 34 };
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const bins = series[0].smooth.length;
    const yMax = Math.max(0.05, ...series.map((s) => s.peak)) * 1.12;
    const x = (bin) => PAD.l + (bin / (bins - 1)) * iw;
    const y = (v) => PAD.t + ih - (v / yMax) * ih;

    const paths = series
      .map((s) => {
        const color = colorOf.get(s.key) || PALETTE[0];
        let line = `M ${x(0).toFixed(1)} ${y(s.smooth[0]).toFixed(1)}`;
        for (let b = 1; b < bins; b++) line += ` L ${x(b).toFixed(1)} ${y(s.smooth[b]).toFixed(1)}`;
        const area = `${line} L ${x(bins - 1).toFixed(1)} ${y(0)} L ${x(0).toFixed(1)} ${y(0)} Z`;
        return { s, color, line, area };
      });

    // Direct labels at each curve's peak, nudged apart when peaks collide.
    const labels = paths
      .map(({ s, color }) => {
        const peakBin = s.smooth.indexOf(s.peak);
        return { key: s.key, color, px: x(peakBin), py: y(s.peak) - 8 };
      })
      .sort((a, b) => a.px - b.px);
    for (let i = 1; i < labels.length; i++) {
      const prev = labels[i - 1];
      if (Math.abs(labels[i].px - prev.px) < 90 && Math.abs(labels[i].py - prev.py) < 16) {
        labels[i].py = prev.py - 16;
      }
    }

    // X ticks every 20s, freezetime shaded so t=0 reads as "round goes live".
    const tickEvery = 20;
    const ticks = [];
    for (let t = Math.ceil(T_MIN / tickEvery) * tickEvery; t <= T_MAX; t += tickEvery) {
      ticks.push(t);
    }
    const binFor = (t) => (t - T_MIN) / (T_MAX - T_MIN) * (bins - 1);
    const yTicks = [0.25, 0.5, 0.75, 1].map((f) => f * yMax).filter((v) => v <= yMax);

    box.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="tm-comms-svg" role="img"
           aria-label="Talk density by second of the round">
        <rect x="${x(0)}" y="${PAD.t}" width="${x(binFor(0)) - x(0)}" height="${ih}"
              fill="rgba(255,255,255,0.03)"/>
        ${yTicks
          .map(
            (v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
              stroke="rgba(255,255,255,0.06)"/>
            <text x="${PAD.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="tm-comms-axis">${Math.round(v * 100)}%</text>`
          )
          .join('')}
        ${ticks
          .map(
            (t) => `<line x1="${x(binFor(t)).toFixed(1)}" x2="${x(binFor(t)).toFixed(1)}"
              y1="${PAD.t + ih}" y2="${PAD.t + ih + 4}" stroke="rgba(255,255,255,0.25)"/>
            <text x="${x(binFor(t)).toFixed(1)}" y="${PAD.t + ih + 16}" text-anchor="middle" class="tm-comms-axis">${
              t === 0 ? 'live' : `${t}s`
            }</text>`
          )
          .join('')}
        <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${PAD.t + ih}" y2="${PAD.t + ih}"
              stroke="rgba(255,255,255,0.25)"/>
        ${paths.map((p) => `<path d="${p.area}" fill="${p.color}" fill-opacity="0.22"/>`).join('')}
        ${paths.map((p) => `<path d="${p.line}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round"/>`).join('')}
        ${labels
          .map(
            (l) => `<text x="${l.px.toFixed(1)}" y="${l.py.toFixed(1)}" text-anchor="middle"
              class="tm-comms-series-label" fill="${l.color}">${esc(nameOf(l.key))}</text>`
          )
          .join('')}
        <text x="${PAD.l + iw / 2}" y="${H - 4}" text-anchor="middle" class="tm-comms-axis-title">seconds into the round</text>
        <text x="12" y="${PAD.t + ih / 2}" text-anchor="middle" class="tm-comms-axis-title"
              transform="rotate(-90 12 ${PAD.t + ih / 2})">rounds talking</text>
        <g data-cross hidden>
          <line y1="${PAD.t}" y2="${PAD.t + ih}" stroke="rgba(255,255,255,0.35)" stroke-dasharray="3 3"/>
        </g>
      </svg>
      <div class="tm-comms-tip" data-tip hidden></div>`;

    // Hover: a crosshair plus who is talking at that second, loudest first.
    const svg = box.querySelector('svg');
    const cross = box.querySelector('[data-cross]');
    const crossLine = cross.querySelector('line');
    const tip = box.querySelector('[data-tip]');
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * W;
      if (sx < PAD.l || sx > W - PAD.r) {
        cross.hidden = true;
        tip.hidden = true;
        return;
      }
      const bin = Math.round(((sx - PAD.l) / iw) * (bins - 1));
      const t = Math.round(T_MIN + (bin / (bins - 1)) * (T_MAX - T_MIN));
      cross.hidden = false;
      crossLine.setAttribute('x1', x(bin));
      crossLine.setAttribute('x2', x(bin));
      const rows = series
        .map((s) => ({ key: s.key, v: s.smooth[bin] }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 6)
        .map(
          (r) => `<div><span class="tm-comms-swatch" style="background:${colorOf.get(r.key) || '#666'}"></span>${esc(
            nameOf(r.key)
          )} <b>${Math.round(r.v * 100)}%</b></div>`
        )
        .join('');
      tip.innerHTML = `<div class="tm-comms-tip-t">${t === 0 ? 'round live' : t < 0 ? `freeze, ${-t}s to live` : `${t}s in`} · ${roundCount} rounds</div>${rows}`;
      tip.hidden = false;
      const left = ((e.clientX - rect.left) / rect.width) * 100;
      tip.style.left = `${Math.min(78, Math.max(2, left + 2))}%`;
    });
    svg.addEventListener('mouseleave', () => {
      cross.hidden = true;
      tip.hidden = true;
    });
  }

  recompute();

  return {
    destroy() {
      dead = true;
      host.innerHTML = '';
    }
  };
}
