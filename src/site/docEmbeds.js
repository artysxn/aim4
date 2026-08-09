// ---------------------------------------------------------------------------
// site/docEmbeds.js
// Interactive widgets inside team documents.
//
// A document stores only an inert <div data-kind="…" data-embed="json">; the
// sanitizer keeps those two attributes and drops any children, so what is
// saved stays plain data. On every load the editor calls enhanceDocEmbeds,
// which mounts the live widget into the div (contenteditable off, children
// are runtime-only and never survive a save).
//
// Kinds:
//   util-map  radar with the team's named utility as hoverable dots.
//   heat      radar heatmap painted from the samples stored in the document.
//   nade-paths one throw line per grenade, origin to landing.
//   spacing   average player spacing after the opening kill: every round as a
//             low-opacity line, the average as the trendline, kill/death
//             ticks, hover to read values, click a line to open the round.
//
// The map widgets carry their rounds with them: the document holds the points
// and the throws, not a picture of them, so the two round-clock sliders and
// the buy pickers recompute rather than reload. Nothing here fetches.
// ---------------------------------------------------------------------------

import { loadRadar } from '../replays/viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { NADE_COLORS, paintPanel } from '../replays/analytics/heatImage.js';
import { createRangeSlider } from '../lib/rangeSlider.js';

const NADE_WORD = {
  smokegrenade: 'smoke',
  molotov: 'molotov',
  flashbang: 'flash',
  hegrenade: 'HE'
};

/** The round goes live at 1:55 and the clock runs to 0:00. */
const ROUND_SECONDS = 115;

const BUYS = [
  { key: '', label: 'Any buy' },
  { key: '0', label: 'Pistol' },
  { key: '1', label: 'Eco' },
  { key: '2', label: 'Half' },
  { key: '3', label: 'Force' },
  { key: '4', label: 'Full' }
];

/** Seconds since the round went live, written the way a coach reads it. */
function clockAt(seconds) {
  const left = Math.max(0, Math.min(ROUND_SECONDS, Math.round(ROUND_SECONDS - seconds)));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/**
 * The round-clock range, plus optional buy pickers.
 *
 * One track with two handles: the first drops everything before it, the second
 * everything after, so a reader can cut a stretch out of the middle of the
 * round and see only what happened inside it.
 *
 * @param {(state: {from: number, to: number, own: string, opp: string}) => void} onChange
 */
function filterBar(root, { buys = true, sliders = true, span = null, onChange }) {
  // Most widgets run on the round clock; the afterplant ones run on the bomb,
  // from five seconds before the plant to the forty it takes to go off.
  const lo = span ? span.from : 0;
  const hi = span ? span.to : ROUND_SECONDS;
  const readAt = span ? (s) => `${s > 0 ? '+' : ''}${s}s` : clockAt;
  const state = { from: lo, to: hi, own: '', opp: '' };
  const bar = document.createElement('div');
  bar.className = 'doc-embed-filters';

  const readout = document.createElement('span');
  readout.className = 'doc-embed-readout';

  if (sliders) {
    const pair = createRangeSlider({
      min: lo,
      max: hi,
      label: span ? 'Time from the plant' : 'Point in the round',
      onChange(a, b) {
        state.from = a;
        state.to = b;
        sync();
      }
    });
    bar.append(pair.el, readout);
  }

  if (buys) {
    for (const [key, label] of [
      ['own', 'Team buy'],
      ['opp', 'Opp buy']
    ]) {
      const sel = document.createElement('select');
      sel.className = 'doc-embed-select';
      sel.setAttribute('aria-label', label);
      for (const b of BUYS) {
        const opt = document.createElement('option');
        opt.value = b.key;
        opt.textContent = b.key === '' ? label : b.label;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        state[key] = sel.value;
        sync();
      });
      bar.appendChild(sel);
    }
  }

  function label() {
    readout.textContent =
      state.from === lo && state.to === hi
        ? span
          ? 'Whole afterplant'
          : 'Whole round'
        : `${readAt(state.from)} to ${readAt(state.to)}`;
  }

  function sync() {
    label();
    onChange({ ...state });
  }

  // The bar does NOT paint on construction. Callers finish wiring themselves
  // up and draw once, which is what keeps this from reaching into a widget
  // that is still half-built: `const` members declared below the filter bar
  // are in their dead zone while it runs.
  root.appendChild(bar);
  label();
  return state;
}

/** Does a round's pair of buys pass the pickers? */
const buyPasses = (state, own, opp) =>
  (!state.own || String(own) === state.own) && (!state.opp || String(opp) === state.opp);

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

/**
 * Zoom and pan over a square canvas, on the macro analyzer's model: wheel
 * zooms about the cursor, drag pans once zoomed in, double-click resets.
 *
 * Everything a widget draws stays in base coordinates (0..size). The viewport
 * is a transform applied around the drawing and undone for hit-testing, so a
 * dot is picked where it looks like it is however far in the reader has gone.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} size  the canvas's own coordinate space
 * @param {() => void} redraw
 */
function viewport(canvas, size, redraw) {
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  const clamp = () => {
    // Never drag the map off its own frame: the scaled square always covers.
    const max = Math.max(0, (size * zoom - size) / 2);
    panX = Math.max(-max, Math.min(max, panX));
    panY = Math.max(-max, Math.min(max, panY));
  };
  const originX = () => (size - size * zoom) / 2 + panX;
  const originY = () => (size - size * zoom) / 2 + panY;

  /** Canvas-space point of an event; the canvas is usually displayed smaller. */
  const canvasAt = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / (rect.width || 1)) * size,
      y: ((ev.clientY - rect.top) / (rect.height || 1)) * size
    };
  };

  const cursor = () => {
    canvas.style.cursor = dragging ? 'grabbing' : zoom > 1.001 ? 'grab' : '';
  };

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const before = zoom;
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (ev.deltaY > 0 ? 0.9 : 1.12)));
      if (zoom === before) return;
      const k = zoom / before;
      const at = canvasAt(ev);
      // Keep whatever is under the cursor under the cursor.
      panX = (at.x - size / 2) * (1 - k) + panX * k;
      panY = (at.y - size / 2) * (1 - k) + panY * k;
      if (zoom <= 1.001) {
        zoom = 1;
        panX = 0;
        panY = 0;
      }
      clamp();
      cursor();
      redraw();
    },
    { passive: false }
  );

  canvas.addEventListener('pointerdown', (ev) => {
    if (zoom <= 1.001) return;
    dragging = true;
    moved = false;
    const at = canvasAt(ev);
    lastX = at.x;
    lastY = at.y;
    canvas.setPointerCapture?.(ev.pointerId);
    cursor();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const at = canvasAt(ev);
    if (Math.abs(at.x - lastX) > 1 || Math.abs(at.y - lastY) > 1) moved = true;
    panX += at.x - lastX;
    panY += at.y - lastY;
    lastX = at.x;
    lastY = at.y;
    clamp();
    redraw();
  });

  const stop = (ev) => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture?.(ev.pointerId);
    cursor();
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  canvas.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    zoom = 1;
    panX = 0;
    panY = 0;
    cursor();
    redraw();
  });

  canvas.setAttribute('title', 'Scroll to zoom, drag to pan, double-click to reset');

  return {
    /** True when the last pointer press turned into a drag, not a click. */
    get panned() {
      return moved;
    },
    apply(ctx) {
      ctx.setTransform(zoom, 0, 0, zoom, originX(), originY());
    },
    reset(ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
    /** Base coordinates of an event, with zoom and pan undone. */
    at(ev) {
      const p = canvasAt(ev);
      return { x: (p.x - originX()) / zoom, y: (p.y - originY()) / zoom };
    }
  };
}

const mounted = new WeakSet();

/** Mount every embed under `surface`. Safe to call repeatedly. */
export function enhanceDocEmbeds(surface) {
  if (!surface) return;
  for (const node of surface.querySelectorAll('div[data-kind][data-embed]')) {
    if (mounted.has(node)) continue;
    mounted.add(node);
    let data = null;
    try {
      data = JSON.parse(node.dataset.embed || '');
    } catch {
      continue;
    }
    node.contentEditable = 'false';
    node.classList.add('doc-embed');
    node.replaceChildren();
    // A widget's own controls belong to the widget. Without this their events
    // bubble into whatever page is hosting the document, where a `data-kind`
    // on this very div reads as a team member id.
    for (const type of ['change', 'input']) {
      node.addEventListener(type, (e) => e.stopPropagation());
    }
    try {
      if (node.dataset.kind === 'util-map') mountUtilMap(node, data);
      else if (node.dataset.kind === 'heat') mountHeat(node, data);
      else if (node.dataset.kind === 'nade-paths') mountNadePaths(node, data);
      else if (node.dataset.kind === 'ct-spread') mountCtSpread(node, data);
      else if (node.dataset.kind === 'spacing') mountSpacing(node, data);
    } catch (err) {
      // A broken embed must not take the document down, but it must not
      // disappear in silence either: half a widget on the page and nothing in
      // the console is the worst of both.
      console.warn('doc embed failed to mount', node.dataset.kind, err);
      node.replaceChildren();
      const note = document.createElement('p');
      note.className = 'doc-embed-stale';
      note.textContent = 'This widget could not be drawn.';
      node.appendChild(note);
    }
  }
}

function tooltipFor(root) {
  const tip = document.createElement('div');
  tip.className = 'doc-embed-tip';
  tip.hidden = true;
  root.appendChild(tip);
  const place = (x, y) => {
    tip.hidden = false;
    const w = root.clientWidth || 1;
    tip.style.left = `${Math.min(x + 12, Math.max(0, w - tip.offsetWidth - 4))}px`;
    tip.style.top = `${y + 14}px`;
  };
  return {
    show(text, x, y) {
      tip.textContent = text;
      place(x, y);
    },
    /** @param {Node[]} nodes  built by the caller, never parsed from a string */
    showNodes(nodes, x, y) {
      tip.replaceChildren(...nodes);
      place(x, y);
    },
    hide() {
      tip.hidden = true;
    }
  };
}

/** A timeline link over round files, or plain text when there are none. */
function roundsLink(label, files) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return document.createTextNode(label);
  const a = document.createElement('a');
  a.href = `/demos?rounds=${list.map(encodeURIComponent).join(',')}`;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}

// ---- heat -----------------------------------------------------------------

/**
 * A live heatmap over samples stored in the document.
 *
 * Points arrive flat as `[x, y, t, buys, ...]`, which is what keeps a report
 * with ten of these inside its size budget. Painting is the same pipeline the
 * static pictures used, so a widget and the image it replaced look identical
 * with the sliders wide open.
 *
 * @param {HTMLElement} node
 * @param {{ map: string, title?: string, points: number[] }} data
 */
function mountHeat(node, data) {
  const size = 480;
  const pts = Array.isArray(data.points) ? data.points : [];
  const total = Math.floor(pts.length / 4);

  if (data.title) {
    const head = document.createElement('div');
    head.className = 'doc-embed-title';
    head.textContent = data.title;
    node.appendChild(head);
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'doc-embed-canvas';
  const count = document.createElement('span');
  count.className = 'doc-embed-count';
  let radar = null;
  const span = data.span || null;
  let state = { from: span ? span.from : 0, to: span ? span.to : ROUND_SECONDS, own: '', opp: '' };

  filterBar(node, {
    span,
    onChange(next) {
      state = next;
      draw();
    }
  });
  node.append(canvas, count);

  /** The samples inside the window and the picked buys. */
  function visible() {
    const out = [];
    for (let i = 0; i < pts.length; i += 4) {
      const t = pts[i + 2];
      if (t < state.from || t > state.to) continue;
      const buys = pts[i + 3];
      if (!buyPasses(state, Math.floor(buys / 8), buys % 8)) continue;
      out.push({ x: pts[i], y: pts[i + 1] });
    }
    return out;
  }

  const view = viewport(canvas, size, () => draw());

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    view.reset(ctx);
    ctx.clearRect(0, 0, size, size);
    const list = visible();
    count.textContent = `${list.length} of ${total} samples`;
    if (!radar) return;
    ctx.save();
    view.apply(ctx);
    paintPanel(ctx, radar, data.map, list, 0, 0, size);
    ctx.restore();
  }

  draw();
  loadRadar(data.map)
    .then((img) => {
      radar = img;
      draw();
    })
    .catch(() => {});
}

// ---- nade-paths -----------------------------------------------------------

/**
 * A player's grenades as throw lines: where it left the hand, where it landed.
 *
 * Throws arrive flat as `[kind, fromX, fromY, toX, toY, t, buys, ...]`. The
 * sliders replace what the Early / Mid / Late panels used to do and do it
 * better: the phases were three fixed cuts, this is any cut.
 *
 * @param {HTMLElement} node
 * @param {{ map: string, title?: string, kinds: string[], paths: number[] }} data
 */
function mountNadePaths(node, data) {
  const size = 480;
  const paths = Array.isArray(data.paths) ? data.paths : [];
  const kinds = Array.isArray(data.kinds) ? data.kinds : [];
  const total = Math.floor(paths.length / 7);

  if (data.title) {
    const head = document.createElement('div');
    head.className = 'doc-embed-title';
    head.textContent = data.title;
    node.appendChild(head);
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'doc-embed-canvas';
  const count = document.createElement('span');
  count.className = 'doc-embed-count';
  let radar = null;
  let state = { from: 0, to: ROUND_SECONDS, own: '', opp: '' };

  filterBar(node, {
    onChange(next) {
      state = next;
      draw();
    }
  });
  node.append(canvas, count);

  const project = (wx, wy) => {
    const pt = {};
    worldToRadar(data.map, wx, wy, pt);
    return { x: (pt.x / RADAR_SIZE) * size, y: (pt.y / RADAR_SIZE) * size };
  };

  function visible() {
    const out = [];
    for (let i = 0; i < paths.length; i += 7) {
      const t = paths[i + 5];
      if (t < state.from || t > state.to) continue;
      const buys = paths[i + 6];
      if (!buyPasses(state, Math.floor(buys / 8), buys % 8)) continue;
      out.push({
        type: kinds[paths[i]] || '',
        fx: paths[i + 1],
        fy: paths[i + 2],
        x: paths[i + 3],
        y: paths[i + 4]
      });
    }
    return out;
  }

  const view = viewport(canvas, size, () => draw());

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    view.reset(ctx);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    view.apply(ctx);
    if (radar) ctx.drawImage(radar, 0, 0, size, size);
    const list = visible();
    count.textContent = `${list.length} of ${total} grenades`;
    for (const p of list) {
      const color = NADE_COLORS[p.type] || '#cccccc';
      const to = project(p.x, p.y);
      if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) continue;
      const from = project(p.fx, p.fy);
      if (Number.isFinite(from.x) && Number.isFinite(from.y)) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(from.x, from.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(to.x, to.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  draw();
  loadRadar(data.map)
    .then((img) => {
      radar = img;
      draw();
    })
    .catch(() => {});
}

// ---- ct-spread ------------------------------------------------------------

/**
 * How many CTs are pointed at each site, every 8 seconds.
 *
 * The document carries one row per round rather than a finished table, so the
 * averages recompute for whichever pair of buys the reader picks. Counts are
 * "toward" a site rather than standing in it: a CT on his way to B is
 * defending B before he gets there.
 *
 * @param {HTMLElement} node
 * @param {{ step: number, marks: number[],
 *   rounds: Array<{ own: number, opp: number, w: number, c: number[] }> }} data
 */
function mountCtSpread(node, data) {
  const marks = Array.isArray(data.marks) ? data.marks : [];
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  if (!marks.length || !rounds.length) return;

  const holder = document.createElement('div');
  holder.className = 'doc-embed-table';
  const count = document.createElement('span');
  count.className = 'doc-embed-count';
  let state = { from: 0, to: ROUND_SECONDS, own: '', opp: '' };

  // No sliders here: the table IS the round over time, so cutting rows out of
  // it would only hide the shape it exists to show.
  filterBar(node, {
    sliders: false,
    onChange(next) {
      state = next;
      render();
    }
  });
  node.append(count, holder);

  function render() {
    const picked = rounds.filter((r) => buyPasses(state, r.own, r.opp));
    count.textContent = `${picked.length} CT rounds`;
    const head = ['Clock', 'A', 'B', 'Elsewhere', 'Alive'];
    const body = [];
    for (let i = 0; i < marks.length; i++) {
      const sec = marks[i];
      // The sliders bound which rows of the round the table shows at all.
      if (sec < state.from || sec > state.to) continue;
      let a = 0;
      let b = 0;
      let alive = 0;
      let n = 0;
      for (const r of picked) {
        const va = r.c[i * 3];
        // -1 marks a sample past the end of that round, which is not a zero.
        if (va < 0) continue;
        a += va;
        b += r.c[i * 3 + 1];
        alive += r.c[i * 3 + 2];
        n++;
      }
      if (!n) continue;
      const avg = (x) => (x / n).toFixed(1);
      body.push([
        clockAt(sec),
        avg(a),
        avg(b),
        avg(Math.max(0, alive - a - b)),
        avg(alive),
        String(n)
      ]);
    }
    holder.replaceChildren(buildTable([...head, 'Rounds'], body));
  }

  render();
}

/** A plain table element from already-plain strings. */
function buildTable(head, rows) {
  const t = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of head) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.append(thead, tbody);
  return t;
}

// ---- util-map -------------------------------------------------------------

/** Round files behind one round type of a utility item. */
function typeFiles(item, t) {
  return (t.idx || []).map((i) => item.files?.[i]).filter(Boolean);
}

/**
 * The team's named utility, recomputed inside the window and the picked buys.
 *
 * The document carries one record per throw rather than a finished picture, so
 * everything on screen — which pieces show, how big each dot is, the round
 * breakdown behind it — is worked out here against whatever the sliders and
 * the buy pickers currently say.
 *
 * @param {HTMLElement} node
 * @param {{ map: string, side: string, live?: {
 *   names: string[], kinds: string[], throws: number[],
 *   rounds: Array<{ f: string, own: number, opp: number, w: number, k: string[] }>,
 *   types: Record<string, string>
 * } }} data
 */
function mountUtilMap(node, data) {
  const size = 480;
  const live = data.live;
  if (!live?.throws?.length) {
    const note = document.createElement('p');
    note.className = 'doc-embed-stale';
    note.textContent = 'Regenerate this report to make the utility map live.';
    node.appendChild(note);
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'doc-embed-canvas';
  const tip = tooltipFor(node);
  const picked = document.createElement('div');
  picked.className = 'doc-embed-picked';
  picked.hidden = true;
  const count = document.createElement('span');
  count.className = 'doc-embed-count';

  let state = { from: 0, to: ROUND_SECONDS, own: '', opp: '' };
  let items = [];
  let pinned = null;
  let hovered = null;
  let radar = null;

  filterBar(node, {
    onChange(next) {
      state = next;
      rebuild();
    }
  });
  node.append(canvas, count, picked);

  /**
   * Fold the throws inside the window into one item per piece of utility.
   *
   * A round counts once however many of the same grenade landed there, which
   * is the question the map answers: which rounds does this piece show up in.
   */
  function rebuild() {
    const byKey = new Map();
    const rounds = new Set();
    for (let i = 0; i < live.throws.length; i += 6) {
      const t = live.throws[i + 4];
      if (t < state.from || t > state.to) continue;
      const round = live.rounds[live.throws[i + 5]];
      if (!round || !buyPasses(state, round.own, round.opp)) continue;
      rounds.add(round.f);
      const nameIdx = live.throws[i];
      const kindIdx = live.throws[i + 1];
      const key = `${nameIdx}:${kindIdx}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          name: live.names[nameIdx] || '',
          type: live.kinds[kindIdx] || '',
          xs: [],
          ys: [],
          ts: [],
          seen: new Set(),
          files: [],
          byType: new Map()
        });
      }
      const rec = byKey.get(key);
      rec.xs.push(live.throws[i + 2]);
      rec.ys.push(live.throws[i + 3]);
      rec.ts.push(t);
      if (rec.seen.has(round.f)) continue;
      rec.seen.add(round.f);
      const at = rec.files.push(round.f) - 1;
      for (const k of round.k || []) {
        if (!rec.byType.has(k)) rec.byType.set(k, []);
        rec.byType.get(k).push(at);
      }
    }

    const basis = rounds.size || 1;
    const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
    items = [...byKey.values()]
      .map((rec) => ({
        name: rec.name,
        type: rec.type,
        rounds: rec.seen.size,
        share: Math.round((rec.seen.size / basis) * 100),
        clock: clockAt(avg(rec.ts)),
        x: Math.round(avg(rec.xs)),
        y: Math.round(avg(rec.ys)),
        files: rec.files,
        types: [...rec.byType.entries()]
          .map(([key, idx]) => ({
            key,
            label: live.types[key] || key,
            rounds: idx.length,
            share: Math.round((idx.length / rec.seen.size) * 100),
            idx
          }))
          .sort((a, b) => b.rounds - a.rounds || a.label.localeCompare(b.label))
          .slice(0, 6)
      }))
      .sort((a, b) => b.share - a.share);

    count.textContent = `${items.length} pieces over ${rounds.size} rounds`;
    // Whatever was pinned may not exist in the new slice.
    const keep = pinned && items.find((it) => it.name === pinned.name && it.type === pinned.type);
    showPicked(keep || null);
  }

  const radiusOf = (it) => 3.5 + Math.min(7, it.share / 12);

  const project = (it) => {
    const pt = {};
    worldToRadar(data.map, it.x, it.y, pt);
    return { x: (pt.x / RADAR_SIZE) * size, y: (pt.y / RADAR_SIZE) * size };
  };

  const view = viewport(canvas, size, () => draw(hovered));

  function draw(hot = null) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    hovered = hot;
    view.reset(ctx);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    view.apply(ctx);
    if (radar) ctx.drawImage(radar, 0, 0, size, size);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, size, size);
    for (const it of items) {
      const p = project(it);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const r = radiusOf(it);
      const lit = it === hot || it === pinned;
      ctx.globalAlpha = lit ? 1 : 0.85;
      ctx.fillStyle = NADE_COLORS[it.type] || '#ccc';
      ctx.beginPath();
      ctx.arc(p.x, p.y, lit ? r + 2 : r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = it === pinned ? '#fff' : 'rgba(0,0,0,0.6)';
      ctx.lineWidth = it === pinned ? 1.5 : 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The hover card: what this grenade is, and which calls it belongs to. */
  function tipNodes(it) {
    const head = document.createElement('strong');
    head.textContent = `${it.name} ${NADE_WORD[it.type] || ''}`.trim();
    const sub = document.createElement('div');
    sub.textContent = `${it.rounds} rounds, ${it.share}%, avg ${it.clock}`;
    const nodes = [head, sub];
    for (const t of it.types) {
      const row = document.createElement('div');
      row.textContent = `${t.rounds} ${t.rounds === 1 ? 'round' : 'rounds'} ${t.label} (${t.share}%)`;
      nodes.push(row);
    }
    return nodes;
  }

  /** The pinned card under the map: the same breakdown, as round links. */
  function showPicked(it) {
    pinned = it && it.files.length ? it : null;
    picked.replaceChildren();
    if (!pinned) {
      picked.hidden = true;
      draw();
      return;
    }
    const head = document.createElement('div');
    head.className = 'doc-embed-picked-head';
    head.append(
      roundsLink(
        `${`${pinned.name} ${NADE_WORD[pinned.type] || ''}`.trim()}, ${pinned.rounds} rounds`,
        pinned.files
      )
    );
    picked.appendChild(head);
    for (const t of pinned.types) {
      const row = document.createElement('div');
      row.append(
        roundsLink(
          `${t.label} (${t.rounds})`,
          t.idx.map((i) => pinned.files[i]).filter(Boolean)
        )
      );
      picked.appendChild(row);
    }
    picked.hidden = false;
    draw();
  }

  function pick(ev) {
    const { x, y } = view.at(ev);
    let best = null;
    // The grab radius is in base coordinates, so zooming in makes the dots
    // easier to hit on screen rather than keeping them the same size to click.
    let bestD = 16;
    for (const it of items) {
      const p = project(it);
      const d = Math.hypot(p.x - x, p.y - y) - radiusOf(it);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  canvas.addEventListener('mousemove', (ev) => {
    const it = pick(ev);
    draw(it);
    canvas.style.cursor = it ? 'pointer' : '';
    if (it) {
      const rect = canvas.getBoundingClientRect();
      tip.showNodes(tipNodes(it), ev.clientX - rect.left, ev.clientY - rect.top);
    } else {
      tip.hide();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    tip.hide();
    draw();
  });
  canvas.addEventListener('click', (ev) => {
    if (view.panned) return;
    const it = pick(ev);
    showPicked(it && it !== pinned ? it : null);
  });

  rebuild();
  loadRadar(data.map)
    .then((img) => {
      radar = img;
      draw();
    })
    .catch(() => {});
}

// ---- spacing --------------------------------------------------------------

/**
 * @param {HTMLElement} node
 * @param {{ title: string, avg: Array<number|null>, kills: number[], deaths: number[],
 *           rounds: Array<{label: string, file: string, values: Array<number|null>}> }} data
 */
function mountSpacing(node, data) {
  const width = 640;
  const height = 240;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'doc-embed-canvas';
  node.appendChild(canvas);
  const tip = tooltipFor(node);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const avg = data.avg || [];
  const secs = avg.length;
  const rounds = data.rounds || [];
  const padL = 46;
  const padR = 12;
  const padT = data.title ? 26 : 12;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let maxY = 1;
  for (const v of avg) if (Number.isFinite(v) && v > maxY) maxY = v;
  for (const r of rounds) {
    for (const v of r.values || []) if (Number.isFinite(v) && v > maxY) maxY = v;
  }
  maxY *= 1.08;

  const xAt = (i) => padL + (i / Math.max(1, secs - 1)) * plotW;
  const yAt = (v) => padT + plotH - (v / maxY) * plotH;

  function line(values, color, widthPx, alpha) {
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    let started = false;
    for (let s = 0; s < values.length; s++) {
      const v = values[s];
      if (!Number.isFinite(v)) continue;
      if (!started) {
        ctx.moveTo(xAt(s), yAt(v));
        started = true;
      } else {
        ctx.lineTo(xAt(s), yAt(v));
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function draw(hotRound = null) {
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (const frac of [0, 0.5, 1]) {
      const v = maxY * frac;
      const y = yAt(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(width - padR, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(v)), 6, y + 3);
    }
    for (let s = 0; s < secs; s += 5) ctx.fillText(`${s}s`, xAt(s) - 6, height - 10);

    for (let s = 0; s < secs; s++) {
      const k = data.kills?.[s] || 0;
      const d = data.deaths?.[s] || 0;
      if (k) {
        ctx.fillStyle = 'rgba(88, 214, 141, 0.9)';
        ctx.fillRect(xAt(s) - 1.5, padT + plotH + 4, 3, Math.min(10, 3 + k * 2));
      }
      if (d) {
        ctx.fillStyle = 'rgba(231, 76, 60, 0.9)';
        ctx.fillRect(xAt(s) + 2, padT + plotH + 4, 3, Math.min(10, 3 + d * 2));
      }
    }

    for (const r of rounds) {
      if (r === hotRound) continue;
      line(r.values || [], '#8b93a5', 1, 0.14);
    }
    if (hotRound) line(hotRound.values || [], '#e6ecf5', 1.6, 0.9);
    line(avg, '#e8b84a', 2.2, 1);

    if (data.title) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(data.title, padL, 16);
    }
  }

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * width;
    const y = ((ev.clientY - rect.top) / rect.height) * height;
    const sec = Math.round(((x - padL) / Math.max(1, plotW)) * (secs - 1));
    if (sec < 0 || sec >= secs) return { sec: null, round: null };
    let best = null;
    let bestD = 14;
    for (const r of rounds) {
      const v = r.values?.[sec];
      if (!Number.isFinite(v)) continue;
      const d = Math.abs(yAt(v) - y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return { sec, round: best };
  }

  canvas.addEventListener('mousemove', (ev) => {
    const { sec, round } = pick(ev);
    draw(round);
    if (sec === null) {
      tip.hide();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const avgV = avg[sec];
    const bits = [`${sec}s`];
    if (Number.isFinite(avgV)) bits.push(`avg ${avgV}u`);
    if (round && Number.isFinite(round.values?.[sec])) {
      bits.push(`${round.label} ${round.values[sec]}u`);
    }
    tip.show(bits.join(', '), ev.clientX - rect.left, ev.clientY - rect.top);
  });
  canvas.addEventListener('mouseleave', () => {
    tip.hide();
    draw();
  });
  canvas.addEventListener('click', (ev) => {
    const { round } = pick(ev);
    if (round?.file) {
      window.open(`/demos?rounds=${encodeURIComponent(round.file)}`, '_blank', 'noopener');
    }
  });

  draw();
}
