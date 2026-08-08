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
//   util-map  radar with the team's named utility as hoverable dots,
//             filterable by round phase.
//   spacing   average player spacing after the opening kill: every round as a
//             low-opacity line, the average as the trendline, kill/death
//             ticks, hover to read values, click a line to open the round.
// ---------------------------------------------------------------------------

import { loadRadar } from '../replays/viewer/radarRenderer.js';
import { RADAR_SIZE, worldToRadar } from '../replays/viewer/mapCalibration.js';
import { NADE_COLORS } from '../replays/analytics/heatImage.js';

const NADE_WORD = {
  smokegrenade: 'smoke',
  molotov: 'molotov',
  flashbang: 'flash',
  hegrenade: 'HE'
};

const PHASES = [
  { key: '', label: 'All' },
  { key: 'early', label: 'Early' },
  { key: 'mid', label: 'Mid' },
  { key: 'late', label: 'Late' }
];

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
    try {
      if (node.dataset.kind === 'util-map') mountUtilMap(node, data);
      else if (node.dataset.kind === 'spacing') mountSpacing(node, data);
    } catch {
      /* a broken embed must not take the document down */
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

// ---- util-map -------------------------------------------------------------

/** Round files behind one round type of a utility item. */
function typeFiles(item, t) {
  return (t.idx || []).map((i) => item.files?.[i]).filter(Boolean);
}

/**
 * @param {HTMLElement} node
 * @param {{ map: string, side: string, items: Array<{
 *   name, type, phase, rounds, share, clock, x, y, files?: string[],
 *   types?: Array<{ key: string, label: string, rounds: number, share: number, idx: number[] }>
 * }> }} data
 */
function mountUtilMap(node, data) {
  const size = 480;
  let phase = '';

  const chips = document.createElement('div');
  chips.className = 'doc-embed-chips';
  for (const p of PHASES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = p.label;
    btn.className = p.key === phase ? 'active' : '';
    btn.addEventListener('click', () => {
      phase = p.key;
      for (const b of chips.children) b.classList.toggle('active', b === btn);
      showPicked(null);
    });
    chips.appendChild(btn);
  }
  node.appendChild(chips);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'doc-embed-canvas';
  node.appendChild(canvas);
  const tip = tooltipFor(node);
  // Clicking a dot pins its rounds under the map. The tooltip follows the
  // cursor, so its links can never be clicked; this panel holds still.
  const picked = document.createElement('div');
  picked.className = 'doc-embed-picked';
  picked.hidden = true;
  node.appendChild(picked);
  const ctx = canvas.getContext('2d');
  let radar = null;
  let pinned = null;

  const visible = () => (data.items || []).filter((it) => !phase || it.phase === phase);
  const radiusOf = (it) => 3.5 + Math.min(7, it.share / 12);

  const project = (it) => {
    const pt = {};
    worldToRadar(data.map, it.x, it.y, pt);
    return { x: (pt.x / RADAR_SIZE) * size, y: (pt.y / RADAR_SIZE) * size };
  };

  function draw(hot = null) {
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    if (radar) ctx.drawImage(radar, 0, 0, size, size);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, size, size);
    for (const it of visible()) {
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
  }

  /** The hover card: what this grenade is, and which calls it belongs to. */
  function tipNodes(it) {
    const head = document.createElement('strong');
    head.textContent = `${it.name} ${NADE_WORD[it.type] || ''}`.trim();
    const sub = document.createElement('div');
    const count = it.rounds ? `${it.rounds} rounds, ` : '';
    sub.textContent = `${count}${it.share}%${it.clock ? `, avg ${it.clock}` : ''}${
      it.phase ? `, ${it.phase}` : ''
    }`;
    const nodes = [head, sub];
    for (const t of it.types || []) {
      const row = document.createElement('div');
      row.textContent = `${t.rounds} ${t.rounds === 1 ? 'round' : 'rounds'} ${t.label} (${t.share}%)`;
      nodes.push(row);
    }
    return nodes;
  }

  /** The pinned card under the map: the same breakdown, as round links. */
  function showPicked(it) {
    pinned = it;
    picked.replaceChildren();
    if (!it) {
      picked.hidden = true;
      draw();
      return;
    }
    const head = document.createElement('div');
    head.className = 'doc-embed-picked-head';
    head.append(
      roundsLink(
        `${`${it.name} ${NADE_WORD[it.type] || ''}`.trim()}, ${it.rounds || it.files?.length || 0} rounds`,
        it.files
      )
    );
    picked.appendChild(head);
    for (const t of it.types || []) {
      const row = document.createElement('div');
      row.append(roundsLink(`${t.label} (${t.rounds})`, typeFiles(it, t)));
      picked.appendChild(row);
    }
    picked.hidden = false;
    draw();
  }

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * size;
    const y = ((ev.clientY - rect.top) / rect.height) * size;
    let best = null;
    let bestD = 16;
    for (const it of visible()) {
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
    const it = pick(ev);
    showPicked(it && it !== pinned ? it : null);
  });

  draw();
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
