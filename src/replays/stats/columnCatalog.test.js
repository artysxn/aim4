// ---------------------------------------------------------------------------
// The Columns picker must stay honest against the real tables and the real
// wire contract: every entry names a column that exists, every group it
// declares exists, and no contract it can produce is one the server refuses.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import {
  PLAYER_COLUMN_INFO,
  TEAM_COLUMN_INFO,
  STATS_ALWAYS_GROUPS,
  STATS_UNUSED_GROUPS,
  columnPrefId,
  databaseColumnGroups,
  dropHiddenColumns,
  hiddenColumnKeys,
  normalizeDisabledColumns
} from './columnCatalog.js';
import {
  COLUMN_GROUP_IDS,
  RATING_CORE,
  resolveColumns
} from '../shared/statsColumns.js';
import {
  PLAYER_COLUMNS,
  PLAYER_FIXED_BASE,
  TEAM_COLUMNS,
  playerColumnsWithRoles
} from './statsTables.js';

// --- every entry controls a real table column --------------------------------
{
  const playerKeys = new Set(playerColumnsWithRoles('tactical').columns.map((c) => c.key));
  for (const info of PLAYER_COLUMN_INFO) {
    for (const key of info.keys || [info.key]) {
      assert.ok(playerKeys.has(key), `player entry ${info.key} controls unknown column ${key}`);
    }
    assert.ok(info.about.length > 20, `player entry ${info.key} needs a real description`);
    assert.ok(!info.about.includes('—'), `no em dashes in UI copy (${info.key})`);
  }
  const teamKeys = new Set(TEAM_COLUMNS.map((c) => c.key));
  for (const info of TEAM_COLUMN_INFO) {
    for (const key of info.keys || [info.key]) {
      assert.ok(teamKeys.has(key), `team entry ${info.key} controls unknown column ${key}`);
    }
    assert.ok(info.about.length > 10, `team entry ${info.key} needs a real description`);
    assert.ok(!info.about.includes('—'), `no em dashes in UI copy (${info.key})`);
  }
}

// --- every metric column is coverable, identity columns are not listed -------
{
  const covered = new Set();
  for (const info of PLAYER_COLUMN_INFO) for (const k of info.keys || [info.key]) covered.add(k);
  const fixed = new Set(PLAYER_FIXED_BASE.map((c) => c.key));
  for (const col of PLAYER_COLUMNS) {
    if (fixed.has(col.key)) {
      assert.ok(!covered.has(col.key), `identity column ${col.key} must not be hideable`);
    } else {
      assert.ok(covered.has(col.key), `metric column ${col.key} missing from the picker`);
    }
  }
}

// --- groups named by entries exist, and the unused ones are truly unused -----
{
  const known = new Set(COLUMN_GROUP_IDS);
  const referenced = new Set(STATS_ALWAYS_GROUPS);
  for (const info of [...PLAYER_COLUMN_INFO, ...TEAM_COLUMN_INFO]) {
    for (const g of info.groups) {
      assert.ok(known.has(g), `entry ${info.key} names unknown group ${g}`);
      referenced.add(g);
    }
  }
  for (const g of STATS_UNUSED_GROUPS) {
    assert.ok(!referenced.has(g), `${g} is declared unused but an entry references it`);
  }
}

// --- the default contract: everything on, minus the groups nothing reads -----
{
  const groups = databaseColumnGroups([]);
  for (const g of STATS_UNUSED_GROUPS) {
    assert.ok(!groups.includes(g), `default contract must not carry ${g}`);
  }
  for (const g of STATS_ALWAYS_GROUPS) {
    assert.ok(groups.includes(g), `default contract must carry ${g}`);
  }
  const resolved = resolveColumns(groups);
  assert.ok(resolved.ratingReady, 'default contract computes honest ratings');
}

// --- no reachable contract is refused by the server --------------------------
{
  const allIds = [
    ...PLAYER_COLUMN_INFO.map((i) => columnPrefId('players', i.key)),
    ...TEAM_COLUMN_INFO.map((i) => columnPrefId('teams', i.key))
  ];
  // Each single toggle, and everything off at once.
  for (const disabled of [...allIds.map((id) => [id]), allIds]) {
    const groups = databaseColumnGroups(disabled);
    const resolved = resolveColumns(groups);
    const carriesCore = RATING_CORE.some((g) => groups.includes(g));
    if (carriesCore) {
      assert.ok(resolved.ratingReady, `partial rating core for ${disabled[0] || 'all-off'}`);
    }
  }
  // Everything off still keeps the filter groups and nothing rating-bearing.
  const bare = databaseColumnGroups(allIds);
  assert.deepEqual(
    bare,
    COLUMN_GROUP_IDS.filter((g) => STATS_ALWAYS_GROUPS.includes(g)),
    'all-off contract is filters only'
  );
}

// --- unknown ids are dropped, order kept, duplicates removed -----------------
{
  assert.deepEqual(normalizeDisabledColumns(['players:psdt', 'nope', 'players:psdt']), [
    'players:psdt'
  ]);
  assert.deepEqual(normalizeDisabledColumns('players:psdt'), []);
}

// --- hiding drops the right table keys and repairs the sticky boundary -------
{
  const { players, teams } = hiddenColumnKeys([
    'players:multikills',
    'players:roleT',
    'teams:utilDmg'
  ]);
  for (const k of ['mk5', 'mk4', 'mk3', 'mk2', 'mk1', 'mk0', 'roleT']) {
    assert.ok(players.has(k), `expected hidden player key ${k}`);
  }
  assert.ok(teams.has('utilDmg') && !players.has('utilDmg'), 'utilDmg hidden per table');

  const withRoles = playerColumnsWithRoles('tactical');
  const dropped = dropHiddenColumns(withRoles, players);
  assert.ok(!dropped.columns.some((c) => players.has(c.key)), 'hidden columns are gone');
  assert.equal(
    dropped.fixedCount,
    withRoles.fixedCount - 1,
    'hiding a sticky role column shrinks the sticky boundary'
  );
  const untouched = dropHiddenColumns(withRoles, new Set());
  assert.equal(untouched.columns.length, withRoles.columns.length, 'empty set is a no-op');
}

console.log('columnCatalog.test.js: all assertions passed');
