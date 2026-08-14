// ---------------------------------------------------------------------------
// src/site/prwChart.js
// The two PRWs on one clock (SIM-PLAN 18.6b, last paragraph).
//
// The believed curve is what the hivemind acted on at each logged decision;
// the true curve is what the same model says the round was actually worth at
// the same ticks. Where they part is a perception problem, and that is the one
// thing the motive string cannot say by itself: a motive explains the choice,
// not whether the board it was chosen on was real.
//
// Its own module because it is the inspector's only piece of real drawing and
// because a chart nobody can render outside the admin-gated page is a chart
// nobody checks. Takes its canvas and its DOM helper, touches no globals.
// ---------------------------------------------------------------------------

/** Believed is the side's own colour on the radar; true is the honest green. */
export const PRW_BELIEF_COLOUR = '#f0b43c';
export const PRW_TRUE_COLOUR = '#5ad18a';

const PAD = 4;
const HEIGHT = 96;

/**
 * The last row at or before `tick`, which is what the scrub is looking at.
 */
export function rowAt(rows, tick) {
  let at = null;
  for (const r of rows) {
    if (r.tick > tick) break;
    at = r;
  }
  return at;
}

/**
 * @param {object} args
 * @param {HTMLCanvasElement} args.canvas
 * @param {HTMLElement} [args.legend]
 * @param {Array<object>} args.rows      graded PRW rows for one side
 * @param {number} args.tick             the scrub position, in engine ticks
 * @param {number} [args.live]           freeze-end tick, for the seconds label
 * @param {number} [args.rate]           tick rate
 * @param {(tag:string, cls?:string, text?:string) => HTMLElement} args.node
 * @returns {object|null} the row under the scrub
 */
export function drawPrwChart({ canvas, legend = null, rows = [], tick = 0, live = 0, rate = 64, node }) {
  const points = (rows || [])
    .filter((r) => Number.isFinite(r?.tick) && Number.isFinite(r?.pWin_belief))
    .sort((a, b) => a.tick - b.tick);
  if (!canvas || !points.length) return null;

  const cssW = canvas.clientWidth || 260;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, HEIGHT);

  const t0 = points[0].tick;
  const t1 = Math.max(points[points.length - 1].tick, t0 + 1);
  const xOf = (t) => PAD + ((t - t0) / (t1 - t0)) * (cssW - PAD * 2);
  const yOf = (p) => HEIGHT - PAD - Math.min(1, Math.max(0, p)) * (HEIGHT - PAD * 2);

  // The coin-flip line: above it, the side is winning the round.
  ctx.strokeStyle = '#26262b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, yOf(0.5));
  ctx.lineTo(cssW - PAD, yOf(0.5));
  ctx.stroke();

  const line = (key, style, dash) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (const r of points) {
      const v = r[key];
      if (!Number.isFinite(v)) continue;
      const x = xOf(r.tick);
      const y = yOf(v);
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line('pWin_true', PRW_TRUE_COLOUR, []);
  line('pWin_belief', PRW_BELIEF_COLOUR, [4, 3]);

  // Every row that is not a team frame is something that HAPPENED: a recall, a
  // plant, a death. Ticking them makes the curve readable as a round.
  ctx.fillStyle = '#6a6a72';
  for (const r of points) {
    if (!r.reason || r.reason === 'frame') continue;
    ctx.fillRect(xOf(r.tick) - 0.5, HEIGHT - PAD - 3, 1, 3);
  }

  // Where the scrub is.
  const cursor = xOf(Math.min(Math.max(tick, t0), t1));
  ctx.strokeStyle = '#6a6a72';
  ctx.beginPath();
  ctx.moveTo(cursor, PAD);
  ctx.lineTo(cursor, HEIGHT - PAD);
  ctx.stroke();

  const at = rowAt(points, tick);
  if (legend && node) {
    legend.replaceChildren();
    const key = (label, cls, colour) => {
      const wrap = node('span', 'sim-prw-key');
      const sw = node('span', `sim-prw-swatch${cls}`);
      sw.style.color = colour;
      wrap.append(sw, node('span', null, label));
      return wrap;
    };
    legend.append(
      key('believed', ' is-belief', PRW_BELIEF_COLOUR),
      key('true', '', PRW_TRUE_COLOUR)
    );
    if (at) {
      const resid = Number.isFinite(at.residual) ? at.residual : null;
      const secs = ((at.tick - live) / (rate || 64)).toFixed(1);
      const truth = Number.isFinite(at.pWin_true) ? (at.pWin_true * 100).toFixed(0) : '--';
      legend.append(
        node(
          'span',
          'sim-prw-now',
          `${secs}s  ${(at.pWin_belief * 100).toFixed(0)} vs ${truth}` +
            (resid === null ? '' : `  (${resid > 0 ? '+' : ''}${(resid * 100).toFixed(0)})`)
        )
      );
      if (at.motive) legend.append(node('span', 'sim-dim', at.motive));
    }
  }
  return at;
}
