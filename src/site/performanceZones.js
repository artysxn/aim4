// ---------------------------------------------------------------------------
// site/performanceZones.js
// Performance > Zones: the map, every painted position (or zone) on it, and
// the subject's rating in each.
//
// The page owns the toolbar and decides which rounds pass it; this module owns
// the map. `update(context)` is called after every paint and every filter
// change, and only the first call for a subject and map waits on the network:
// the round records are kept, so a filter is a re-aggregation in memory.
// ---------------------------------------------------------------------------

import { fetchZones } from '../replays/api.js';
import { MAPS, mapHasLowerRadar, radarImage } from '../replays/shared/roundId.js';
import { RADAR_SIZE, radarToWorld, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { pieceToRing, pointInPiece } from '../replays/zones/zoneGeom.js';
import {
  ZONE_BANDS,
  ZONE_MIN_ROUNDS,
  loadZoneRecords,
  zoneColor,
  zoneRegions,
  zoneTotals
} from '../replays/performance/zoneStats.js';
import { LINK_FILES_MAX } from '../replays/performance/mapRoundStats.js';
import { roundsHref } from '../replays/performance/mapRoundTables.js';
import { f2, pct } from '../replays/performance/performanceMath.js';
import { setSpinnerLabel, spinnerHtml } from '../lib/spinner.js';

const PLAY_ICON =
  '<svg class="pf-rt-play" viewBox="0 -960 960 960" aria-hidden="true">' +
  '<path d="M364.31-279.08v-401.84L679.39-480 364.31-279.08Z" /></svg>';

/** How many regions the Best / Worst lists name. */
const HIGHLIGHTS = 3;

function hexA(hex, a) {
  const n = parseInt(String(hex).slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Shoelace area and centroid of a radar-space ring. */
function ringShape(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return {
      area: 0,
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2
    };
  }
  return { area: Math.abs(a / 2), x: cx / (3 * a), y: cy / (3 * a) };
}

const images = new Map();
function loadImage(src) {
  if (!images.has(src)) {
    images.set(
      src,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Could not load ${src}`));
        img.src = src;
      })
    );
  }
  return images.get(src);
}

/**
 * @param {{
 *   host: HTMLElement,
 *   escapeHtml: (s: string) => string,
 *   ddOpen: (key: string, fallback: boolean) => boolean
 * }} deps
 */
export function createZonesChapter({ host, escapeHtml, ddOpen }) {
  const esc = escapeHtml;
  const state = { grain: 'position', level: 'default', selected: '', hover: '' };
  /** map code -> Promise<network> */
  const networks = new Map();
  /** file -> record, for `recordsFor` (the subject) */
  let records = new Map();
  let recordsFor = '';
  /** The one load running, so a filter change mid-load joins it. */
  let inflight = null;
  let token = 0;
  /** What the last paint drew: the context, regions and their totals. */
  let view = null;
  let image = null;
  let resizeObs = null;

  function ensureNetwork(code) {
    if (!networks.has(code)) {
      const p = fetchZones(code).catch((err) => {
        networks.delete(code);
        throw err;
      });
      networks.set(code, p);
    }
    return networks.get(code);
  }

  // ---- markup --------------------------------------------------------------

  function html() {
    return `<div class="pf-zones">
      <div class="pf-zones-map">
        <canvas class="pf-zones-canvas" aria-label="Map"></canvas>
        <div class="pf-zones-tip" hidden></div>
        <div class="pf-zones-status" hidden></div>
      </div>
      <aside class="pf-zones-side" data-pf-zones-side></aside>
    </div>
    <details class="pf-dd" data-pf-dd="zones-table"${ddOpen('zones-table', false) ? ' open' : ''}>
      <summary class="pf-dd-summary" data-pf-zones-table-title>${state.grain === 'zone' ? 'Zones' : 'Positions'}</summary>
      <div class="pf-dd-body" data-pf-zones-table></div>
    </details>`;
  }

  function status(text, { spin = false } = {}) {
    const el = host.querySelector('.pf-zones-status');
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    if (spin) {
      if (el.querySelector('.is-loading')) setSpinnerLabel(el, text);
      else el.innerHTML = spinnerHtml(text);
    } else {
      el.innerHTML = `<p class="view-empty">${esc(text)}</p>`;
    }
  }

  function statLine(label, value) {
    return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  }

  function opening(c) {
    const duels = c.openKills + c.openDeaths;
    if (!duels) return '–';
    return `${c.openKills}-${c.openDeaths} <span class="an-muted">${pct(c.opkRate)}</span>`;
  }

  function ratingHtml(c) {
    if (!c || !Number.isFinite(c.rating)) return '–';
    const color = c.rounds >= ZONE_MIN_ROUNDS ? zoneColor(c.rating) : '';
    return color ? `<span style="color:${color}">${f2(c.rating)}</span>` : f2(c.rating);
  }

  function filesOf(c) {
    return [...(c?.files || [])]
      .sort((a, b) => b.at - a.at)
      .map((x) => x.file)
      .slice(0, LINK_FILES_MAX);
  }

  function regionName(id) {
    return view?.regions.find((r) => r.id === id)?.name || '';
  }

  function cardHtml() {
    const id = state.selected;
    const c = id ? view.totals.regions.get(id) : null;
    if (!id || !c) return overviewHtml();
    const href = roundsHref(filesOf(c));
    const players = view.ctx.perPlayer
      ? [...c.players.entries()]
          .map(([pid, mine]) => ({ pid, mine, name: view.ctx.nameOf(pid) }))
          .sort((a, b) => b.mine.rounds - a.mine.rounds || (b.mine.rating ?? 0) - (a.mine.rating ?? 0))
      : [];
    return `<div class="pf-zcard">
      <div class="pf-zcard-head">
        <h3 class="pf-zcard-name">${esc(regionName(id))}</h3>
        <button type="button" class="pf-zcard-close" data-pf-zsel="" aria-label="Close">×</button>
      </div>
      <div class="pf-zcard-rating">${ratingHtml(c)}</div>
      <dl class="pf-zcard-stats">
        ${statLine('Rounds', String(c.rounds))}
        ${statLine('K-D', `${c.kills}-${c.deaths}`)}
        ${statLine('ADR', Number.isFinite(c.adr) ? String(Math.round(c.adr)) : '–')}
        ${statLine('KAST', pct(c.kastPct))}
        ${statLine('Opening', opening(c))}
      </dl>
      ${
        players.length
          ? `<table class="st-table pf-zcard-players">
          <thead><tr><th class="left">Player</th><th>Rating</th><th>Rounds</th></tr></thead>
          <tbody>${players
            .map(
              (p) => `<tr><td class="left">${esc(p.name)}</td><td>${ratingHtml(p.mine)}</td><td>${p.mine.rounds}</td></tr>`
            )
            .join('')}</tbody>
        </table>`
          : ''
      }
      ${href ? `<a class="pf-zcard-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Rounds${PLAY_ICON}</a>` : ''}
    </div>`;
  }

  function rankedRegions() {
    return view.regions
      .map((r) => ({ r, c: view.totals.regions.get(r.id) }))
      .filter((x) => x.c && x.c.rounds >= ZONE_MIN_ROUNDS && Number.isFinite(x.c.rating))
      .sort((a, b) => b.c.rating - a.c.rating);
  }

  function overviewHtml() {
    const ranked = rankedRegions();
    const list = (items) =>
      items
        .map(
          (x) => `<li><button type="button" class="pf-zlist-btn" data-pf-zsel="${esc(x.r.id)}">
            <span>${esc(x.r.name)}</span>${ratingHtml(x.c)}</button></li>`
        )
        .join('');
    if (!ranked.length) {
      return `<div class="pf-zcard"><p class="view-empty">Not enough rounds in this selection.</p></div>`;
    }
    const best = ranked.slice(0, HIGHLIGHTS);
    const worst = ranked.slice(-HIGHLIGHTS).reverse().filter((x) => !best.includes(x));
    return `<div class="pf-zcard">
      <h3 class="pf-zcard-name">${esc(MAPS[view.ctx.mapCode]?.name || view.ctx.mapCode)}</h3>
      <p class="pf-zcard-sub">${view.totals.rounds} rounds</p>
      <p class="pf-zlist-title">Best</p><ul class="pf-zlist">${list(best)}</ul>
      ${worst.length ? `<p class="pf-zlist-title">Worst</p><ul class="pf-zlist">${list(worst)}</ul>` : ''}
    </div>`;
  }

  function legendHtml() {
    return `<div class="pf-zlegend" aria-label="Rating">
      ${ZONE_BANDS.map(
        (b) => `<span class="pf-zlegend-item"><i style="background:${b.color}"></i>${esc(b.label)}</span>`
      ).join('')}
    </div>`;
  }

  function controlsHtml() {
    const seg = (attr, value, items) =>
      `<div class="rp-seg pf-zseg" role="group">${items
        .map(
          ([key, label]) =>
            `<button type="button" class="rp-seg-btn${value === key ? ' active' : ''}" ${attr}="${key}">${esc(label)}</button>`
        )
        .join('')}</div>`;
    return `<div class="pf-zcontrols">
      ${seg('data-pf-zgrain', state.grain, [
        ['position', 'Positions'],
        ['zone', 'Zones']
      ])}
      ${
        mapHasLowerRadar(view.ctx.mapCode)
          ? seg('data-pf-zlevel', state.level, [
              ['default', 'Upper'],
              ['lower', 'Lower']
            ])
          : ''
      }
    </div>`;
  }

  function paintSide() {
    const side = host.querySelector('[data-pf-zones-side]');
    if (!side || !view) return;
    side.innerHTML = `${controlsHtml()}${cardHtml()}${legendHtml()}`;
  }

  function paintTable() {
    const slot = host.querySelector('[data-pf-zones-table]');
    const title = host.querySelector('[data-pf-zones-table-title]');
    if (title) title.textContent = state.grain === 'zone' ? 'Zones' : 'Positions';
    if (!slot || !view) return;
    const rows = view.regions
      .map((r) => ({ r, c: view.totals.regions.get(r.id) }))
      .filter((x) => x.c)
      .sort((a, b) => {
        const ea = a.c.rounds >= ZONE_MIN_ROUNDS ? 1 : 0;
        const eb = b.c.rounds >= ZONE_MIN_ROUNDS ? 1 : 0;
        return eb - ea || (b.c.rating ?? -9) - (a.c.rating ?? -9);
      });
    if (!rows.length) {
      slot.innerHTML = '<p class="view-empty">No rounds in this selection.</p>';
      return;
    }
    slot.innerHTML = `<table class="st-table pf-ztable">
      <thead><tr>
        <th class="left">${state.grain === 'zone' ? 'Zone' : 'Position'}</th>
        <th>Rating</th><th>Rounds</th><th>K-D</th><th>ADR</th><th>KAST</th><th>Opening</th>
      </tr></thead>
      <tbody>${rows
        .map(
          ({ r, c }) => `<tr class="pf-ztable-row${c.rounds < ZONE_MIN_ROUNDS ? ' is-thin' : ''}${
            r.id === state.selected ? ' is-selected' : ''
          }" data-pf-zsel="${esc(r.id)}">
            <td class="left">${esc(r.name)}</td>
            <td>${ratingHtml(c)}</td>
            <td>${c.rounds}</td>
            <td>${c.kills}-${c.deaths}</td>
            <td>${Number.isFinite(c.adr) ? Math.round(c.adr) : '–'}</td>
            <td>${pct(c.kastPct)}</td>
            <td>${opening(c)}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table>`;
  }

  // ---- the map -------------------------------------------------------------

  /** Regions with their radar-space rings and label points, per level. */
  function buildShapes(network, code) {
    const stacked = mapHasLowerRadar(code);
    const pt = {};
    return zoneRegions(network, state.grain).map((r) => {
      const pieces = r.pieces.map((piece) => {
        const ring = pieceToRing(piece).map(([x, y]) => {
          worldToRadar(code, x, y, pt);
          return [pt.x, pt.y];
        });
        const level = stacked ? (piece.level || r.level || 'default') : 'default';
        return { piece, ring, level, shape: ringShape(ring) };
      });
      return { ...r, pieces };
    });
  }

  function visiblePieces(region) {
    return region.pieces.filter((p) => p.level === state.level);
  }

  /** Scratch canvas for outlines. */
  let scratch = null;

  /**
   * The outer edge of a region only.
   *
   * A zone is several positions, and stroking each one draws the seams
   * between them too. Stroked at twice the width on a scratch layer, with the
   * region's own fill then cut out of it, only the outside half of the line is
   * left: the region's border and nothing inside it.
   */
  function outlineInto(g, canvas, path, width, k) {
    if (!scratch) scratch = document.createElement('canvas');
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) {
      scratch.width = canvas.width;
      scratch.height = canvas.height;
    }
    const s = scratch.getContext('2d');
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, scratch.width, scratch.height);
    s.setTransform(k, 0, 0, k, 0, 0);
    s.lineJoin = 'round';
    s.lineWidth = width * 2;
    s.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    s.stroke(path);
    s.globalCompositeOperation = 'destination-out';
    s.fill(path);
    s.globalCompositeOperation = 'source-over';
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(scratch, 0, 0);
    g.restore();
  }

  function draw() {
    const canvas = host.querySelector('.pf-zones-canvas');
    if (!canvas || !view) return;
    const css = Math.max(1, Math.round(canvas.parentElement.getBoundingClientRect().width));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    canvas.style.height = `${css}px`;
    const g = canvas.getContext('2d');
    const k = px / RADAR_SIZE;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.setTransform(k, 0, 0, k, 0, 0);
    if (image) {
      g.globalAlpha = 0.85;
      g.drawImage(image, 0, 0, RADAR_SIZE, RADAR_SIZE);
      g.globalAlpha = 1;
    }
    const font = getComputedStyle(host).fontFamily || 'sans-serif';
    const labels = [];
    /** Hovered and picked regions, outlined once everything is filled. */
    const marks = [];
    for (const region of view.shapes) {
      const pieces = visiblePieces(region);
      if (!pieces.length) continue;
      const c = view.totals.regions.get(region.id);
      const solid = c && c.rounds >= ZONE_MIN_ROUNDS && Number.isFinite(c.rating);
      const color = solid ? zoneColor(c.rating) : null;
      const path = new Path2D();
      for (const p of pieces) {
        if (p.ring.length < 3) continue;
        path.moveTo(p.ring[0][0], p.ring[0][1]);
        for (let i = 1; i < p.ring.length; i++) path.lineTo(p.ring[i][0], p.ring[i][1]);
        path.closePath();
      }
      const hot = region.id === state.hover;
      const picked = region.id === state.selected;
      g.fillStyle = color ? hexA(color, hot || picked ? 0.72 : 0.52) : `rgba(255, 255, 255, ${c ? 0.1 : 0.04})`;
      g.fill(path);
      g.lineJoin = 'round';
      g.lineWidth = 1.5;
      g.strokeStyle = `rgba(255, 255, 255, ${state.grain === 'zone' ? 0.14 : 0.28})`;
      g.stroke(path);
      if (picked || hot) marks.push({ path, width: picked ? 5 : 3.5 });
      if (solid) {
        const big = pieces.reduce((a, b) => (b.shape.area > a.shape.area ? b : a));
        labels.push({ x: big.shape.x, y: big.shape.y, text: f2(c.rating) });
      }
    }
    for (const m of marks) outlineInto(g, canvas, m.path, m.width, k);
    g.font = `600 19px ${font}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    g.fillStyle = '#fff';
    for (const l of labels) {
      g.strokeText(l.text, l.x, l.y);
      g.fillText(l.text, l.x, l.y);
    }
  }

  function regionAt(e) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * RADAR_SIZE;
    const ry = ((e.clientY - rect.top) / rect.height) * RADAR_SIZE;
    const w = radarToWorld(view.ctx.mapCode, rx, ry, {});
    let best = null;
    for (const region of view.shapes) {
      for (const p of visiblePieces(region)) {
        if (!pointInPiece(w.x, w.y, p.piece)) continue;
        if (!best || p.shape.area < best.area) best = { id: region.id, area: p.shape.area };
      }
    }
    return best?.id || '';
  }

  function showTip(e, id) {
    const tip = host.querySelector('.pf-zones-tip');
    if (!tip) return;
    const c = id ? view.totals.regions.get(id) : null;
    if (!id) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `<strong>${esc(regionName(id))}</strong>${
      c
        ? `<span>${ratingHtml(c)} · ${c.rounds} round${c.rounds === 1 ? '' : 's'} · ${c.kills}-${c.deaths}</span>`
        : '<span class="an-muted">No rounds</span>'
    }`;
    tip.hidden = false;
    const wrap = tip.parentElement.getBoundingClientRect();
    const x = e.clientX - wrap.left;
    const y = e.clientY - wrap.top;
    const flip = x > wrap.width - 180;
    tip.style.left = `${flip ? x - 12 : x + 14}px`;
    tip.style.top = `${y + 14}px`;
    tip.style.transform = flip ? 'translateX(-100%)' : '';
  }

  function bindCanvas() {
    const canvas = host.querySelector('.pf-zones-canvas');
    if (!canvas || canvas.dataset.bound) return;
    canvas.dataset.bound = '1';
    canvas.addEventListener('pointermove', (e) => {
      if (!view) return;
      const id = regionAt(e);
      if (id !== state.hover) {
        state.hover = id;
        canvas.style.cursor = id ? 'pointer' : '';
        draw();
      }
      showTip(e, id);
    });
    canvas.addEventListener('pointerleave', () => {
      if (!state.hover) return;
      state.hover = '';
      draw();
      const tip = host.querySelector('.pf-zones-tip');
      if (tip) tip.hidden = true;
    });
    canvas.addEventListener('click', (e) => {
      if (!view) return;
      const id = regionAt(e);
      select(id && id !== state.selected ? id : '');
    });
    resizeObs?.disconnect();
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(() => draw());
      resizeObs.observe(canvas.parentElement);
    }
  }

  function select(id) {
    state.selected = id;
    draw();
    paintSide();
    paintTable();
  }

  async function ensureImage(code) {
    const level = mapHasLowerRadar(code) ? state.level : 'default';
    const src = radarImage(code, level);
    if (!src) {
      image = null;
      return;
    }
    try {
      image = await loadImage(src);
    } catch {
      image = null;
    }
  }

  // ---- data ----------------------------------------------------------------

  function aggregate() {
    if (!view) return;
    view.totals = zoneTotals({
      rounds: view.ctx.rounds,
      records,
      network: view.network,
      mapCode: view.ctx.mapCode,
      grain: state.grain,
      phase: view.ctx.phase,
      perPlayer: view.ctx.perPlayer
    });
    view.regions = zoneRegions(view.network, state.grain);
    if (state.selected && !view.regions.some((r) => r.id === state.selected)) state.selected = '';
  }

  function repaintAll() {
    if (!view) return;
    bindCanvas();
    draw();
    paintSide();
    paintTable();
  }

  /**
   * @param {{
   *   subject: string,                 stamp of the player or team
   *   mapCode: string,
   *   jobs: Array<{ file: string, ids: string[] }>,  every round of the subject on the map
   *   rounds: Array<{ file: string, ids: string[], at: number }>,  the ones that pass
   *   phase: string,
   *   perPlayer: boolean,
   *   nameOf: (id: string) => string
   * }} ctx
   */
  async function update(ctx) {
    const my = ++token;
    bindCanvas();
    if (!ctx?.mapCode) {
      view = null;
      status('No rounds on any map with positions.');
      return;
    }
    if (recordsFor !== ctx.subject) {
      records = new Map();
      recordsFor = ctx.subject;
      inflight = null;
    }
    const sameMap = view?.ctx.mapCode === ctx.mapCode;
    if (!sameMap) {
      state.selected = '';
      state.hover = '';
      if (!mapHasLowerRadar(ctx.mapCode)) state.level = 'default';
    }

    let network;
    try {
      if (!sameMap || !view?.network) status('Loading positions…', { spin: true });
      network = await ensureNetwork(ctx.mapCode);
    } catch {
      if (my === token) {
        view = null;
        status('No positions for this map.');
      }
      return;
    }
    if (my !== token) return;

    const missing = ctx.jobs.filter((j) => !records.has(j.file));
    if (missing.length) {
      const key = `${ctx.subject}|${ctx.mapCode}`;
      if (!inflight || inflight.key !== key) {
        const run = { key, promise: null };
        // Before the call: the loader asks isStale() on its first step.
        inflight = run;
        run.promise = loadZoneRecords(missing, records, {
          onProgress: (p) => {
            if (my === token && p.total) {
              status(`Loading rounds ${p.done} of ${p.total}`, { spin: true });
            }
          },
          isStale: () => inflight !== run
        }).finally(() => {
          if (inflight === run) inflight = null;
        });
      }
      status('Loading rounds…', { spin: true });
      try {
        await inflight?.promise;
      } catch {
        /* the rounds that did load still paint */
      }
      if (my !== token) return;
    }

    await ensureImage(ctx.mapCode);
    if (my !== token) return;
    status('');
    view = { ctx, network, totals: null, regions: [], shapes: buildShapes(network, ctx.mapCode) };
    aggregate();
    repaintAll();
  }

  host.addEventListener('click', (e) => {
    if (!view) return;
    const grain = e.target.closest('[data-pf-zgrain]');
    if (grain) {
      const next = grain.dataset.pfZgrain === 'zone' ? 'zone' : 'position';
      if (next === state.grain) return;
      state.grain = next;
      state.selected = '';
      view.shapes = buildShapes(view.network, view.ctx.mapCode);
      aggregate();
      repaintAll();
      return;
    }
    const level = e.target.closest('[data-pf-zlevel]');
    if (level) {
      const next = level.dataset.pfZlevel === 'lower' ? 'lower' : 'default';
      if (next === state.level) return;
      state.level = next;
      state.hover = '';
      void ensureImage(view.ctx.mapCode).then(() => {
        draw();
        paintSide();
      });
      return;
    }
    const sel = e.target.closest('[data-pf-zsel]');
    if (sel) {
      const id = sel.dataset.pfZsel || '';
      // A picked region on the other floor brings that floor with it.
      const region = view.shapes.find((r) => r.id === id);
      if (region && !visiblePieces(region).length && region.pieces.length) {
        state.level = region.pieces[0].level;
        void ensureImage(view.ctx.mapCode).then(draw);
      }
      select(id);
    }
  });

  return {
    html,
    update,
    /** The page is leaving the chapter: stop watching a canvas that is gone. */
    detach() {
      resizeObs?.disconnect();
      resizeObs = null;
      token++;
    }
  };
}
