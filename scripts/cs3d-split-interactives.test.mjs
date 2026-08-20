import assert from 'node:assert/strict';
import {
  nodeMatchesModel,
  claimFitsHull,
  doorLeafFits,
  claimRadiusFor,
  hullSlack,
  primMayContainHull
} from './cs3d-split-interactives.mjs';
import { DOOR_LEAF_RADIUS, DOOR_LEAF_SPAN } from '../shared/sim3d/interactives.js';

assert.equal(claimRadiusFor('door'), DOOR_LEAF_RADIUS);
assert.ok(claimRadiusFor('breakable') > DOOR_LEAF_RADIUS, 'breakables keep the looser radius');
assert.ok(DOOR_LEAF_RADIUS > 107, 'Nuke leaf reaches 107 from the hinge');
assert.ok(DOOR_LEAF_RADIUS < 200, 'and must not reach a neighbouring Mirage door');

{
  const leaf = { min: [0, -6, 0], max: [60, 6, 110] };
  assert.equal(doorLeafFits(leaf), true, 'a Nuke-sized leaf fits');
  const wall = { min: [-80, -80, -20], max: [200, 180, 140] };
  assert.equal(doorLeafFits(wall), false, 'a 280-unit claim is a wall, not a door');
}

{
  const hull = { min: [0, 0, 0], max: [40, 4, 80] };
  const pane = { min: [-1, -1, -1], max: [41, 5, 81] };
  assert.equal(claimFitsHull(pane, hull), true, 'a pane just proud of its hull is kept');
  const wall = { min: [-20, -40, -10], max: [80, 80, 120] };
  assert.equal(claimFitsHull(wall, hull), false, 'a wall named after the pane is not');
}

assert.equal(nodeMatchesModel('metal_door_001_br.metal_door_001_br_bg_body_lod0', 'metal_door_001_br'), true);
assert.equal(nodeMatchesModel('agg_merge_metal_door_001_br_wall', 'metal_door_001_br'), false);
assert.ok(60 < DOOR_LEAF_SPAN && 110 < DOOR_LEAF_SPAN);

{
  const glass = { min: [0, 0, 0], max: [0, 42, 80] };
  assert.equal(hullSlack(glass), 6, 'a paper-thin pane gets PHYS_SLACK, not 1');
  const sheet = { min: [0, 0, 0], max: [40, 3, 80] };
  assert.ok(hullSlack(sheet) <= 1, 'a 3u cover stays tight so it cannot eat the wall');
}

{
  const hull = { min: [370, -280, 1750], max: [379, -201, 1825] };
  const wallTile = { min: [-500, -800, 1600], max: [900, 200, 2100] };
  assert.equal(primMayContainHull(wallTile, hull), true, 'a vent inside a large world tile is still found');
  const elsewhere = { min: [-2000, -2000, 0], max: [-1500, -1500, 100] };
  assert.equal(primMayContainHull(elsewhere, hull), false, 'a distant tile is not walked');
  assert.equal(claimFitsHull(wallTile, hull), false, 'claiming the whole tile is still rejected');
}

console.log('cs3d-split-interactives: ok');
