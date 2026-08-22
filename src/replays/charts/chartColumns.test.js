// A chart must never plot from a column it did not fetch.
//
// The mapping here is hand-written, so the risk is forgetting to extend it when
// a metric is added: the chart would then read a field the fetch left out and
// draw blanks, or worse, zeros. These assertions make that a failing test.
import assert from 'node:assert/strict';
import {
  DIMENSION_COLUMNS,
  METRIC_COLUMNS,
  allDimensionKeys,
  allMetricKeys,
  columnsForChart
} from './chartColumns.js';
import { COLUMN_GROUP_IDS, RATING_CORE, resolveColumns } from '../shared/statsColumns.js';

// --- every registered key is mapped ----------------------------------------
{
  const missing = allMetricKeys().filter((k) => !(k in METRIC_COLUMNS));
  assert.deepEqual(missing, [], `metrics with no column mapping: ${missing.join(', ')}`);
  const missingDims = allDimensionKeys().filter((k) => !(k in DIMENSION_COLUMNS));
  assert.deepEqual(missingDims, [], `dimensions with no column mapping: ${missingDims.join(', ')}`);
}

// --- and every mapping names real groups ------------------------------------
{
  const known = new Set(COLUMN_GROUP_IDS);
  for (const [key, cols] of Object.entries(METRIC_COLUMNS)) {
    for (const c of cols) assert.ok(known.has(c), `metric "${key}" names unknown group "${c}"`);
  }
  for (const [key, cols] of Object.entries(DIMENSION_COLUMNS)) {
    for (const c of cols) assert.ok(known.has(c), `dimension "${key}" names unknown group "${c}"`);
  }
}

// --- every mapping resolves; none trips the rating guard ---------------------
for (const key of allMetricKeys()) {
  for (const dim of allDimensionKeys()) {
    const cols = columnsForChart({ metric: key, dimension: dim });
    if (cols === null) continue;
    assert.doesNotThrow(
      () => resolveColumns(cols),
      `chart ${key}/${dim} produced a contract the server would refuse: ${cols.join(',')}`
    );
  }
}

// --- anything unrecognised falls back to everything -------------------------
assert.equal(columnsForChart({ metric: 'notAMetric' }), null);
assert.equal(columnsForChart({ metric: 'kills', dimension: 'notADimension' }), null);
assert.equal(columnsForChart({ metric: 'kills', series: 'notASeries' }), null);

// --- A4R pulls its whole input set, never part of it ------------------------
{
  const cols = columnsForChart({ metric: 'a4r', dimension: 'map' });
  for (const g of RATING_CORE) assert.ok(cols.includes(g), `a4r must carry "${g}"`);
  // A metric needing only swing still gets the full set, because a partial one
  // is refused — and would otherwise mean a rating built from league averages.
  const swingCols = columnsForChart({ metric: 'swing', dimension: 'side' });
  for (const g of RATING_CORE) assert.ok(swingCols.includes(g), `swing must carry "${g}"`);
}

// --- kill-source charts always carry the kill list --------------------------
assert.ok(columnsForChart({ metric: 'kills', dimension: 'map', source: 'kill' }).includes('kills'));

// --- and the point of all this: narrow charts are actually narrow -----------
{
  const full = resolveColumns(null).bytesPerRound;
  const cheap = resolveColumns(columnsForChart({ metric: 'kills', dimension: 'roundNo' })).bytesPerRound;
  const killTime = resolveColumns(columnsForChart({ metric: 'killTime', dimension: 'time', source: 'kill' })).bytesPerRound;
  assert.ok(cheap < full * 0.1, `a scoreboard chart should be under a tenth of full, got ${cheap}/${full}`);
  assert.ok(killTime < full * 0.15, `a kill-time chart should be well under full, got ${killTime}/${full}`);
}

console.log(
  `chartColumns.test.js: ${allMetricKeys().length} metrics x ${allDimensionKeys().length} dimensions mapped and resolvable`
);
