// Run: node shared/sim/angles.test.js
//
// The catalogue is built from the viewer's own visibility code, so this file
// does not re-test line of sight. What it tests is that the derived structure
// is trustworthy:
//
//   the exposure transpose really is the transpose of the visible sets
//   visibility is reciprocal, because line of sight is a symmetric relation
//     and a cone is only an aperture over it
//   the numbers agree with facts about the maps that are true independently
//     of this code (Dust2 is open, Inferno is not, long is long)
//   threat does not double count an enemy who happens to hold two angles
//
// Skips when the catalogue has not been baked, so the suite runs anywhere.

import { AngleCatalogue, loadAngles } from './angles.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

let bakes = {};
try {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('../../server/replays/demoStore.js');
  const path = await import('node:path');
  for (const map of ['INF', 'DD2', 'ANU']) {
    bakes[map] = JSON.parse(
      await readFile(path.join(ROOT, 'sim', 'angles', `${map}.json`), 'utf8')
    );
  }
} catch {
  bakes = {};
}

// ---- version guard ----------------------------------------------------------

{
  let threw = false;
  try {
    new AngleCatalogue({ v: 99 });
  } catch {
    threw = true;
  }
  assert(threw, 'a catalogue from another version is refused rather than half-read');
}

let checked = false;

if (bakes.INF && bakes.DD2 && bakes.ANU) {
  const inf = loadAngles(bakes.INF);
  const dd2 = loadAngles(bakes.DD2);
  const anu = loadAngles(bakes.ANU);

  // ---- structure ----

  assert(inf.entries.length > 500, `Inferno has a real catalogue (${inf.entries.length})`);
  assert(inf.byAnchor.size > 40, `covering its anchors (${inf.byAnchor.size})`);
  assert(inf.at('banana').length === inf.yaws, 'every anchor carries every yaw sector');

  {
    // Coordinates round-trip through the control field's grid.
    for (const cell of [0, 100, 5000, inf.geom.count - 1]) {
      const w = inf.worldAt(cell);
      assert(inf.cellAt(w.x, w.y) === cell, `cell ${cell} round-trips`);
    }
    assert(inf.cellAt(1e9, 1e9) === -1, 'a point off the map is not a cell');
  }

  // ---- the transpose is a transpose ----

  {
    // Every (entry, cell) in a visible set must appear in that cell's exposure
    // list, and nothing else may. A transpose that has drifted from its source
    // is the kind of bug that makes bots hold angles nobody is watching.
    let checkedPairs = 0;
    for (let i = 0; i < inf.entries.length; i += 37) {
      const e = inf.entries[i];
      for (const cell of e.cells) {
        const list = inf.exposure.get(cell);
        assert(list && list.includes(i), `entry ${i} is in cell ${cell}'s exposure list`);
        checkedPairs += 1;
      }
    }
    assert(checkedPairs > 500, `checked a real sample of pairs (${checkedPairs})`);

    for (const [cell, list] of inf.exposure) {
      for (const i of list.slice(0, 2)) {
        assert(inf.visibleSet(i).has(cell), `exposure claims entry ${i} sees cell ${cell}`);
      }
    }
  }

  // ---- visibility is reciprocal, except where it should not be ----

  {
    // Line of sight is symmetric and a cone is only an aperture over it, so
    // two spots that can see each other should each have SOME yaw that does.
    // But `castViewerCone` deliberately picks its blocking geometry from where
    // the VIEWER stands: a body on elevated ground ignores elevated blockers,
    // and painted ledges block one way only. That is a real property of these
    // maps (a balcony sees over a wall that hides the player below it) and it
    // is one of the more valuable things the viewer's geometry already models.
    //
    // So this is a two-sided check, and both sides matter. On a map with
    // almost no elevated paint, near-total reciprocity says the underlying
    // geometry is sound. On a map full of it, substantial asymmetry says the
    // elevated layer is actually doing something; if that came back at 100%
    // the one-way sightlines would silently not exist.
    const reciprocity = (c) => {
      const anchors = [...c.byAnchor.keys()];
      const seesSpot = (id, x, y) => c.byAnchor.get(id).some((i) => c.sees(i, x, y));
      let pairs = 0;
      let rec = 0;
      for (let a = 0; a < anchors.length; a += 1) {
        const from = c.at(anchors[a])[0];
        for (let b = a + 1; b < anchors.length; b += 1) {
          const to = c.at(anchors[b])[0];
          if (!seesSpot(anchors[a], to.world.x, to.world.y)) continue;
          pairs += 1;
          if (seesSpot(anchors[b], from.world.x, from.world.y)) rec += 1;
        }
      }
      return { pairs, rec, pct: rec / pairs };
    };

    const flat = reciprocity(anu);
    assert(flat.pairs > 40, `Anubis gives enough pairs to judge (${flat.pairs})`);
    assert(
      flat.pct > 0.9,
      `on a map with 11 elevated pieces, sightlines are near-symmetric (${(100 * flat.pct).toFixed(0)}%)`
    );

    const stacked = reciprocity(inf);
    assert(stacked.pairs > 100, `Inferno gives enough pairs to judge (${stacked.pairs})`);
    assert(
      stacked.pct < flat.pct - 0.1,
      `and on one with 763, one-way sightlines really exist (${(100 * stacked.pct).toFixed(0)}% vs ${(100 * flat.pct).toFixed(0)}%)`
    );
    assert(stacked.pct > 0.5, 'though most sightlines are still mutual');
  }

  // ---- the numbers match the maps ----

  {
    const avg = (c) => c.entries.reduce((a, e) => a + e.area, 0) / c.entries.length;
    assert(
      avg(dd2) > avg(inf) * 1.5,
      `Dust2 is a far more open map than Inferno (${avg(dd2).toFixed(0)} vs ${avg(inf).toFixed(0)} cells seen)`
    );

    const longest = (c) => c.entries.reduce((a, e) => Math.max(a, e.depth), 0);
    assert(longest(dd2) > 2500, `Dust2 has a sightline over 2500u (${longest(dd2)})`);
    assert(longest(dd2) > longest(inf), 'and a longer one than Inferno has');

    // The AWP shortlist should surface spots a player would name.
    const spots = dd2.sniperSpots(10).map((s) => s.anchor);
    assert(spots.length === 10, 'the sniper shortlist has entries');
    assert(dd2.depthAt(spots[0]) >= dd2.depthAt(spots[9]), 'and is sorted by sightline length');
  }

  // ---- threat does not double count ----

  {
    const banana = inf.at('banana')[0];
    // One enemy, believed at one anchor, holding however many of its yaws see
    // the point: it is still one enemy.
    const oneEnemy = (anchorId) => (anchorId === 'car' ? 0.8 : 0);
    const t = inf.threatAt(banana.world.x, banana.world.y, oneEnemy);
    assert(t <= 0.8 + 1e-9, `a single hypothesis contributes at most its mass (${t})`);

    const nobody = inf.threatAt(banana.world.x, banana.world.y, () => 0);
    assert(nobody === 0, 'an empty belief is zero threat');

    // A point nothing overlooks has no threat and no exposure.
    assert(inf.exposedTo(1e9, 1e9).length === 0, 'off-map points expose nothing');
  }

  checked = true;
}

console.log(`angles: ok${checked ? ' (INF, DD2, ANU catalogues)' : ' (no bake, version guard only)'}`);
