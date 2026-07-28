import { appendBlockingLedgeSegs, sanitizeLedges, simplifyStrokePts } from './ledges.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const pts = simplifyStrokePts(
    [
      [0, 0],
      [1, 0],
      [5, 0],
      [5.5, 0],
      [10, 0]
    ],
    2.5
  );
  assert(pts.length >= 3, 'simplify keeps spaced points');
  assert(pts[0][0] === 0 && pts[pts.length - 1][0] === 10, 'keeps endpoints');
}

{
  const ledges = sanitizeLedges([
    { type: 'ledge', pts: [[0, 0], [10, 0]], open: 'R' },
    { type: 'ledge', pts: [[0]], open: 'R' },
    { junk: true }
  ]);
  assert(ledges.length === 1, 'sanitize keeps valid ledges');
  assert(ledges[0].open === 'R', 'default open R');
}

{
  // Explicit open normal +Y: upper/open is +Y, drop is −Y.
  const ledge = {
    type: 'ledge',
    pts: [
      [0, 0],
      [100, 0]
    ],
    open: 'R',
    openN: [[0, 1]]
  };
  const out = new Float32Array(16);
  const fromDrop = appendBlockingLedgeSegs([ledge], 50, -20, -10, -50, 110, 50, out, 0);
  assert(fromDrop === 1, 'drop side blocks');
  const fromUpper = appendBlockingLedgeSegs([ledge], 50, 20, -10, -50, 110, 50, out, 0);
  assert(fromUpper === 0, 'upper side open');
}

console.log('ledges.test.js: ok');
