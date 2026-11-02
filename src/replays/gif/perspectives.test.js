// node src/replays/gif/perspectives.test.js
import assert from 'node:assert/strict';
import { describePerspective, landingPose, lookPose, overviewPose, partFor, renderOptions, throwsInPart } from './perspectives.js';

const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`);

// Looking along +x is yaw 0, along +y is yaw 90, and down is a positive pitch.
near(lookPose({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }).yaw, 0, 'east');
near(lookPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }).yaw, 90, 'north');
near(lookPose({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 0 }).pitch, 45, 'down');
near(lookPose({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }).pitch, -45, 'up');

// An overview stands back from all of them, above them, and looks at the middle.
{
  const pose = overviewPose([
    { x: 0, y: 0, z: 0 },
    { x: 2000, y: 400, z: 100 }
  ]);
  assert.ok(pose.z > 100, 'above them');
  assert.ok(pose.pitch > 0, 'looking down');
  assert.equal(pose.x, 1000, 'in line with the middle');
  assert.ok(pose.y < 0, 'stood back');
  assert.equal(overviewPose([]), null, 'nothing to frame');
  assert.equal(overviewPose([{ x: NaN, y: 0 }]), null, 'a bad sample is not a place');
}

// A landing is watched from back along the grenade's flight, not through a wall beside it.
{
  const g = {
    type: 'smokegrenade',
    from: { x: 1000, y: 0, z: 200 },
    at: { x: 0, y: 0, z: 0 },
    path: [
      { x: 1000, y: 0, z: 200 },
      { x: 700, y: 0, z: 400 },
      { x: 400, y: 0, z: 300 },
      { x: 100, y: 0, z: 80 },
      { x: 0, y: 0, z: 0 }
    ]
  };
  const pose = landingPose(g);
  assert.equal(pose.x, 400, 'the first point of the flight far enough back');
  assert.ok(pose.z > 300, 'lifted off it');
  near(pose.yaw, 180, 'looking back at the landing');
  assert.ok(pose.pitch > 0, 'down at it');

  const noPath = landingPose({ at: { x: 500, y: 500, z: 10 } });
  assert.ok(noPath && Number.isFinite(noPath.x), 'a grenade with no path still gets a camera');
  assert.equal(landingPose({}), null, 'no landing, no camera');
}

// Grenades in a part, and only the picked players'.
{
  const meta = {
    events: {
      grenades: [
        { player: 'a', throwTick: 200 },
        { player: 'b', throwTick: 100 },
        { player: 'a', throwTick: 900 }
      ]
    }
  };
  assert.deepEqual(throwsInPart(meta, 0, 500).map((g) => g.throwTick), [100, 200], 'in throw order');
  assert.deepEqual(throwsInPart(meta, 0, 500, ['a']).map((g) => g.throwTick), [200], 'only that player');
  assert.deepEqual(throwsInPart(null, 0, 1), [], 'no meta');
}

// What each one is called.
{
  const meta = { players: [{ id: 'a', slot: 0, name: 'dev1ce' }] };
  assert.equal(describePerspective({ type: 'player', slot: 0, mode: 'pov' }, meta).label, 'dev1ce, first person');
  assert.equal(describePerspective({ type: 'player', slot: 0, mode: 'third' }, meta).view, 'third');
  assert.equal(describePerspective({ type: 'map' }, meta).label, '2D map');
  assert.equal(describePerspective({ type: 'camera', pose: {} }, meta).label, 'Camera');
  assert.equal(describePerspective({ type: 'camera', pose: {}, shot: 2 }, meta).label, 'Camera 2');
  assert.equal(describePerspective({ type: 'landing', kind: '3d', grenade: { player: 'a', type: 'smokegrenade' } }, meta).label, 'Smoke landing, dev1ce');
  assert.equal(describePerspective({ type: 'landing', kind: '2d', grenade: { player: 'a', type: 'flashbang' } }, meta).label, 'Flash landing, dev1ce (2D)');
}

// A landing runs past the part, to see the grenade go off. Nothing else does.
{
  const part = { fromTick: 100, toTick: 200, tickRate: 64 };
  assert.deepEqual(partFor({ type: 'player', slot: 0 }, part), { fromTick: 100, toTick: 200 });
  const late = partFor({ type: 'landing', grenade: { detonateTick: 500 } }, part);
  assert.equal(late.toTick, 500 + 3 * 64, 'runs on after it goes off');
  assert.equal(partFor({ type: 'landing', grenade: { detonateTick: 0 } }, part).toTick, 200, 'never shorter than the part');
  assert.equal(partFor({ type: 'landing', grenade: {} }, part).toTick, 200, 'no detonation known');
}

// 3D or 2D, as asked.
assert.equal(renderOptions({ type: 'map' }).kind, '2d');
assert.equal(renderOptions({ type: 'overview' }).camera.overview, true);
assert.equal(renderOptions({ type: 'landing', kind: '2d', grenade: { at: { x: 1, y: 2 } } }).view.focus.x, 1);
assert.ok(renderOptions({ type: 'landing', kind: '3d', grenade: { at: { x: 1, y: 2, z: 3 } } }).camera.pose);
assert.deepEqual(renderOptions({ type: 'player', slot: 3, mode: 'third' }).camera, { player: 3, mode: 'third' });

console.log('gif/perspectives.test.js ok');
