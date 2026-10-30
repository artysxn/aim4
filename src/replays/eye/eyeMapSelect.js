// ---------------------------------------------------------------------------
// replays/eye/eyeMapSelect.js
// The map overview above the eye's composer: pick a map, drag rectangles and
// lassos on it, give each a rule. What is drawn goes straight to the message
// being written as a numbered attachment; the panel owns that list and this file
// only reads it and asks to change it.
//
// Pixels stop at the pointer handlers: a point is turned into world units through
// the radar calibration as it is drawn (mapRegions.js has why).
// ---------------------------------------------------------------------------

import { MAPS, radarImage } from '../shared/roundId.js';
import { CALIBRATION, RADAR_SIZE, calibrationFor, radarToWorld, worldToRadar } from '../viewer/mapCalibration.js';
import { REGION_MAX, pointInPolygon, simplifyLasso } from './mapRegions.js';

const WHO = [['', 'Any side'], ['T', 'T'], ['CT', 'CT']];
const WHAT = [['', 'Anything'], ['smoke', 'Smoke'], ['molotov', 'Molotov'], ['flash', 'Flash'], ['he', 'HE'], ['utility', 'Any utility'], ['players', 'Players'], ['kills', 'Kills']];
/** A drag shorter than this, in pixels, is a slip and not a selection. */
const MIN_DRAG = 6;

const hasFloors = (map) => calibrationFor(map).lowerZ !== undefined;
const toRadar = (region, [x, y]) => {
  const p = worldToRadar(region.map, x, y);
  return [p.x, p.y];
};

/** Where a region's number goes: the middle of its points, or a point of its own when the middle falls outside a lasso's bend. */
function labelSpot(pts) {
  const middle = [pts.reduce((sum, p) => sum + p[0], 0) / pts.length, pts.reduce((sum, p) => sum + p[1], 0) / pts.length];
  return pointInPolygon(middle[0], middle[1], pts) ? middle : pts[0];
}

/** The regions a message carried, on their maps, for the bubble it was sent in. */
export function regionThumbs(regions, escapeHtml) {
  const groups = new Map();
  for (const r of regions || []) {
    const key = `${r.map}/${r.floor === 'lower' ? 'lower' : 'default'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups]
    .map(([key, list]) => {
      const [map, level] = key.split('/');
      const shapes = list
        .map((r) => {
          const pts = r.points.map((p) => toRadar(r, p));
          const [x, y] = labelSpot(pts);
          return `<polygon points="${pts.map((p) => p.map(Math.round).join(',')).join(' ')}" fill="rgba(255,255,255,0.18)" stroke="#f2f2f2" stroke-width="10"/><circle cx="${Math.round(x)}" cy="${Math.round(y)}" r="62" fill="#f2f2f2"/><text x="${Math.round(x)}" y="${Math.round(y)}" text-anchor="middle" dominant-baseline="central" font-size="84" font-weight="700" fill="#050505">${r.id}</text>`;
        })
        .join('');
      const name = MAPS[map]?.name || map;
      return `<svg class="eye-sent-map" viewBox="0 0 ${RADAR_SIZE} ${RADAR_SIZE}" role="img" aria-label="${escapeHtml(name)}"><image href="${escapeHtml(radarImage(map, level) || '')}" width="${RADAR_SIZE}" height="${RADAR_SIZE}"/>${shapes}</svg>`;
    })
    .join('');
}

/**
 * @param {object} opts
 * @param {(s: string) => string} opts.escapeHtml
 * @param {() => object[]} opts.drafts      the regions of the message being written
 * @param {() => object[]} opts.sent        the regions already sent in this chat, shown behind them
 * @param {() => number} opts.nextId        the number the next region takes
 * @param {(region: object) => void} opts.onAdd
 * @param {(id: number) => void} opts.onRemove
 * @param {() => void} opts.onChange        a rule changed
 * @param {(id: number) => void} opts.onInsert  put "here(id)" in the message
 * @param {(region: object) => Promise<string>} opts.placeOf  the callouts a region covers
 */
export function createMapSelect({ escapeHtml, drafts, sent, nextId, onAdd, onRemove, onChange, onInsert, placeOf }) {
  const el = document.createElement('section');
  el.className = 'eye-mapsel';
  el.hidden = true;
  el.setAttribute('aria-label', 'Map selections');
  el.innerHTML = `
    <div class="eye-mapsel-board"><canvas class="eye-mapsel-canvas" aria-label="Map overview"></canvas></div>
    <div class="eye-mapsel-side">
      <select class="site-select" data-map aria-label="Map">${Object.keys(CALIBRATION)
        .filter((code) => MAPS[code])
        .map((code) => `<option value="${code}">${escapeHtml(MAPS[code].name)}</option>`)
        .join('')}</select>
      <div class="rv-az-seg" role="group" aria-label="Tool">
        <button type="button" class="rv-az-seg-btn" data-tool="rect">Rectangle</button>
        <button type="button" class="rv-az-seg-btn" data-tool="lasso">Lasso</button>
      </div>
      <div class="rv-az-seg" role="group" aria-label="Floor" data-floors>
        <button type="button" class="rv-az-seg-btn" data-floor="upper">Upper</button>
        <button type="button" class="rv-az-seg-btn" data-floor="lower">Lower</button>
      </div>
      <div class="eye-mapsel-list" data-list></div>
      <div class="rv-az-seg" role="group" aria-label="Regions must match" data-matches>
        <button type="button" class="rv-az-seg-btn" data-match="all">Match all</button>
        <button type="button" class="rv-az-seg-btn" data-match="any">Match any</button>
      </div>
      <button type="button" class="rv-az-seg-btn eye-mapsel-done" data-done>Done</button>
    </div>`;
  const canvas = el.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const mapEl = el.querySelector('[data-map]');
  const listEl = el.querySelector('[data-list]');
  const floorsEl = el.querySelector('[data-floors]');
  const matchesEl = el.querySelector('[data-matches]');

  let map = mapEl.value;
  let tool = 'rect';
  let floor = 'upper';
  let match = 'all';
  /** The stroke being drawn, in canvas pixels. */
  let stroke = null;
  const images = new Map();

  const level = () => (hasFloors(map) && floor === 'lower' ? 'lower' : 'default');
  const onThisView = (r) => r.map === map && (!hasFloors(map) || (r.floor || 'upper') === floor);

  function imageNow() {
    const url = radarImage(map, level());
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.onload = draw;
      img.src = url;
      images.set(url, img);
    }
    return img;
  }

  function drawRegion(r, { dim = false } = {}) {
    const pts = r.points.map((p) => toRadar(r, p));
    const k = RADAR_SIZE / (canvas.clientWidth || 1);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = dim ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.16)';
    ctx.fill();
    ctx.lineWidth = 1.5 * k;
    ctx.strokeStyle = dim ? 'rgba(242,242,242,0.45)' : '#f2f2f2';
    ctx.stroke();
    const [x, y] = labelSpot(pts);
    ctx.beginPath();
    ctx.arc(x, y, 10 * k, 0, Math.PI * 2);
    ctx.fillStyle = dim ? 'rgba(242,242,242,0.45)' : '#f2f2f2';
    ctx.fill();
    ctx.fillStyle = '#050505';
    ctx.font = `700 ${12 * k}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(r.id), x, y + 0.5 * k);
  }

  function draw() {
    if (el.hidden) return;
    const size = canvas.clientWidth;
    if (!size) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    if (canvas.width !== px || canvas.height !== px) canvas.width = canvas.height = px;
    ctx.setTransform(px / RADAR_SIZE, 0, 0, px / RADAR_SIZE, 0, 0);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, RADAR_SIZE, RADAR_SIZE);
    const img = imageNow();
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, RADAR_SIZE, RADAR_SIZE);
    for (const r of sent()) if (onThisView(r)) drawRegion(r, { dim: true });
    for (const r of drafts()) if (onThisView(r)) drawRegion(r);
    if (stroke) {
      const k = RADAR_SIZE / size;
      ctx.beginPath();
      if (tool === 'rect') {
        const [a, b] = [stroke[0], stroke.at(-1)];
        ctx.rect(a[0] * k, a[1] * k, (b[0] - a[0]) * k, (b[1] - a[1]) * k);
      } else {
        stroke.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
      }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = '#f2f2f2';
      ctx.stroke();
    }
  }

  const selectOf = (kind, id, value, options) =>
    `<select class="site-select" data-rule="${kind}" data-id="${id}" aria-label="${kind === 'who' ? 'Side' : 'What'}">${options
      .map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('')}</select>`;

  function renderSide() {
    const list = drafts();
    mapEl.value = map;
    el.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    floorsEl.hidden = !hasFloors(map);
    el.querySelectorAll('[data-floor]').forEach((b) => b.classList.toggle('active', b.dataset.floor === floor));
    matchesEl.hidden = list.length < 2;
    el.querySelectorAll('[data-match]').forEach((b) => b.classList.toggle('active', b.dataset.match === match));
    canvas.classList.toggle('is-full', list.length >= REGION_MAX);
    listEl.innerHTML = list
      .map((r) => {
        const where = [r.map !== map ? MAPS[r.map]?.name || r.map : '', hasFloors(r.map) ? `${r.floor || 'upper'} floor` : '', r.place].filter(Boolean).join(', ');
        return `<div class="eye-mapsel-row">
          <button type="button" class="eye-region-num" data-here="${r.id}" title="Insert here(${r.id})" aria-label="Insert here(${r.id})">${r.id}</button>
          ${selectOf('who', r.id, r.rule.who, WHO)}
          ${selectOf('what', r.id, r.rule.what, WHAT)}
          <button type="button" class="eye-chip-x" data-remove="${r.id}" aria-label="Remove region ${r.id}">×</button>
          ${where ? `<span class="eye-mapsel-place">${escapeHtml(where)}</span>` : ''}
        </div>`;
      })
      .join('');
  }

  function refresh() {
    renderSide();
    draw();
  }

  /** A finished stroke, in canvas pixels, as a region in world units. */
  function regionFrom(points) {
    const k = RADAR_SIZE / canvas.clientWidth;
    const world = (p) => {
      const w = radarToWorld(map, p[0] * k, p[1] * k);
      return [w.x, w.y];
    };
    let shape;
    let outline;
    if (tool === 'rect') {
      const [a, b] = [points[0], points.at(-1)];
      if (Math.abs(a[0] - b[0]) < MIN_DRAG || Math.abs(a[1] - b[1]) < MIN_DRAG) return null;
      shape = 'rect';
      outline = [a, [b[0], a[1]], b, [a[0], b[1]]].map(world).map((p) => p.map(Math.round));
    } else {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      if (Math.max(...xs) - Math.min(...xs) < MIN_DRAG || Math.max(...ys) - Math.min(...ys) < MIN_DRAG) return null;
      shape = 'lasso';
      outline = simplifyLasso(points.map(world));
      if (outline.length < 3) return null;
    }
    const last = drafts().at(-1);
    return {
      id: nextId(),
      map,
      ...(hasFloors(map) ? { floor } : {}),
      shape,
      points: outline,
      // A second region is most often the same question about another place.
      rule: { who: last?.rule.who || '', what: last?.rule.what || '' },
      match,
      place: ''
    };
  }

  const pointerAt = (e) => {
    const box = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(box.width, e.clientX - box.left)), Math.max(0, Math.min(box.height, e.clientY - box.top))];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drafts().length >= REGION_MAX) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    stroke = [pointerAt(e)];
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = pointerAt(e);
    if (tool === 'rect') stroke = [stroke[0], p];
    else if (Math.hypot(p[0] - stroke.at(-1)[0], p[1] - stroke.at(-1)[1]) >= 2) stroke.push(p);
    draw();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!stroke) return;
    const region = regionFrom([...stroke, pointerAt(e)]);
    stroke = null;
    if (region) {
      onAdd(region);
      placeOf(region).then((place) => {
        region.place = place;
        onChange();
        refresh();
      });
    }
    refresh();
  });
  canvas.addEventListener('pointercancel', () => {
    stroke = null;
    draw();
  });

  el.addEventListener('change', (e) => {
    if (e.target === mapEl) {
      map = mapEl.value;
      floor = 'upper';
      return refresh();
    }
    const rule = e.target.dataset?.rule;
    if (!rule) return;
    const region = drafts().find((r) => r.id === Number(e.target.dataset.id));
    if (!region) return;
    region.rule[rule] = e.target.value;
    onChange();
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) tool = b.dataset.tool;
    else if (b.dataset.floor) floor = b.dataset.floor;
    else if (b.dataset.match) {
      match = b.dataset.match;
      for (const r of drafts()) r.match = match;
      onChange();
    } else if (b.dataset.here) return onInsert(Number(b.dataset.here));
    else if (b.dataset.remove) onRemove(Number(b.dataset.remove));
    else if ('done' in b.dataset) return close();
    else return;
    refresh();
  });
  new ResizeObserver(draw).observe(canvas);

  function close() {
    stroke = null;
    el.hidden = true;
  }

  return {
    el,
    refresh,
    close,
    open() {
      el.hidden = false;
      refresh();
    },
    /** Escape: lets go of the stroke being drawn, else closes. */
    escape() {
      if (stroke) {
        stroke = null;
        draw();
      } else close();
    },
    isOpen: () => !el.hidden
  };
}
