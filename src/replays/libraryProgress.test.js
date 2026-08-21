// Library-wide load progress: "N of M matches loaded".
//
// Regression: a 4100-demo library reported "300 of 300". Every page ends with a
// `packing` line (server) and a `receiving` line (api.js) whose `total` is the
// page's demo count, not the library's. Inferring the library size from `total`
// made the counter collapse to the page size at the end of each page.
import assert from 'node:assert/strict';

const PAGE = 300;
const LIBRARY = 4100;

/** The exact progress sequence one page of GET /stats emits. */
function pageEvents(offset, pageCount, { libraryTotalOnPacking = true } = {}) {
  const out = [{ phase: 'start', done: 0, total: pageCount, offset, libraryTotal: LIBRARY }];
  for (let i = 0; i < pageCount; i++) {
    out.push({ phase: 'loading', done: i, total: pageCount, offset, libraryTotal: LIBRARY });
    out.push({ phase: 'ready', done: i + 1, total: pageCount, offset, libraryTotal: LIBRARY });
  }
  // The two lines that caused the bug.
  out.push({
    phase: 'packing',
    done: pageCount,
    total: pageCount,
    offset,
    ...(libraryTotalOnPacking ? { libraryTotal: LIBRARY } : {})
  });
  out.push({ phase: 'receiving', done: pageCount, total: pageCount, offset });
  return out;
}

// --- the relay in statsCache, mirrored ------------------------------------
const DEMO_PHASES = new Set(['start', 'loading', 'building', 'rebuilding', 'enriching', 'ready']);

function runLoad({ scoped = null, dropLibraryTotal = false } = {}) {
  let libraryTotalSeen = 0;
  let libraryLoadedSeen = 0;
  const seen = [];
  const totalDemos = scoped ? scoped.length : LIBRARY;
  for (let offset = 0; offset < totalDemos; offset += PAGE) {
    const pageCount = Math.min(PAGE, totalDemos - offset);
    const pageStart = offset;
    for (const p of pageEvents(offset, pageCount, { libraryTotalOnPacking: !dropLibraryTotal })) {
      if (scoped) {
        libraryTotalSeen = scoped.length;
      } else {
        const stated = Number(p.libraryTotal) || 0;
        if (stated > 0) libraryTotalSeen = Math.max(libraryTotalSeen, stated);
      }
      const done = Math.max(0, Number(p.done) || 0);
      const within = DEMO_PHASES.has(p.phase) ? Math.min(done, pageCount) : pageCount;
      const next = pageStart + within;
      libraryLoadedSeen = Math.max(
        libraryLoadedSeen,
        libraryTotalSeen ? Math.min(next, libraryTotalSeen) : next
      );
      seen.push({ loaded: libraryLoadedSeen, total: libraryTotalSeen, phase: p.phase });
    }
  }
  return seen;
}

// --- the failure, reproduced ----------------------------------------------
{
  // What the old code did: total = max(libraryTotal ?? 0, total).
  let total = 0;
  for (const p of pageEvents(0, PAGE, { libraryTotalOnPacking: false })) {
    total = Math.max(Number(p.libraryTotal) || 0, Number(p.total) || 0);
  }
  assert.equal(total, PAGE, 'old inference collapsed to the page size — the reported bug');
}

// --- the fix ---------------------------------------------------------------
{
  const seen = runLoad();
  assert.ok(seen.every((s) => s.total === LIBRARY), 'total is the library on every event');
  const packing = seen.filter((s) => s.phase === 'packing' || s.phase === 'receiving');
  assert.ok(packing.length > 0);
  assert.ok(
    packing.every((s) => s.total === LIBRARY),
    'packing/receiving must never redefine the library size'
  );
  // Monotonic, capped, and finishing exactly on the library size.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].loaded >= seen[i - 1].loaded, `counter went backwards at ${i}`);
  }
  assert.ok(seen.every((s) => s.loaded <= LIBRARY), 'never exceeds the library');
  assert.equal(seen.at(-1).loaded, LIBRARY, 'ends at 4100');

  // The end of page one reads 300 of 4100, not 300 of 300.
  const endOfPage1 = seen.find((s) => s.phase === 'receiving');
  assert.deepEqual(
    { loaded: endOfPage1.loaded, total: endOfPage1.total },
    { loaded: 300, total: LIBRARY }
  );
}

// --- an older server that omits libraryTotal on packing --------------------
{
  const seen = runLoad({ dropLibraryTotal: true });
  assert.ok(seen.every((s) => s.total === LIBRARY), 'still correct without the new server field');
}

// --- scoped loads count against the scope, not the page --------------------
{
  const ids = Array.from({ length: 730 }, (_, i) => `d${i}`);
  const seen = runLoad({ scoped: ids });
  assert.ok(seen.every((s) => s.total === 730), 'scope size wins over any event total');
  assert.equal(seen.at(-1).loaded, 730);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].loaded >= seen[i - 1].loaded);
  }
}

// --- the panel backstop: a shrinking total is ignored ----------------------
{
  let progress = { loaded: 0, total: 0 };
  const note = ({ loaded, total }) => {
    const stated = Number(total) || 0;
    const nextTotal = Math.max(progress.total, stated);
    const nextLoaded = Math.max(0, Number(loaded) || 0);
    progress = {
      loaded: Math.min(Math.max(progress.loaded, nextLoaded), nextTotal || nextLoaded),
      total: nextTotal
    };
  };
  note({ loaded: 150, total: LIBRARY });
  note({ loaded: 300, total: PAGE }); // a bad event slipping through
  assert.equal(progress.total, LIBRARY, 'panel refuses to shrink the library mid-load');
  assert.equal(progress.loaded, 300);
}

console.log('libraryProgress.test.js: all assertions passed');
