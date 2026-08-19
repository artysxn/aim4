import assert from 'node:assert/strict';
import { createPerfFlags, parseOnOff, dumpFlags, displayHzHint, PERF_HELP } from './perfToggles.js';

assert.equal(parseOnOff(undefined, true), false);
assert.equal(parseOnOff('', false), true);
assert.equal(parseOnOff('1', false), true);
assert.equal(parseOnOff('0', true), false);
assert.equal(parseOnOff('off', true), false);
assert.equal(parseOnOff('nope', true), null);

{
  const seen = [];
  const p = createPerfFlags({ msaa: true, dpr: 2, bloom: true, shadows: true }, (f) => seen.push({ ...f }));
  assert.equal(p.command('r_msaa', ['0']), 'r_msaa 0 (reload)');
  assert.equal(p.flags.msaa, false);
  assert.equal(p.command('r_dpr', ['0.5']), 'r_dpr 0.5');
  assert.equal(p.flags.dpr, 0.5);
  assert.equal(p.command('god', []), null);
  const cheap = p.command('r_perf', ['1']);
  assert.ok(Array.isArray(cheap) && cheap[0] === 'r_perf 1');
  assert.equal(p.flags.msaa, false);
  assert.equal(p.flags.simple, true);
  assert.equal(p.flags.skyPass, false);
  assert.equal(p.flags.shadows, false);
  assert.equal(p.flags.dpr, 0.5);
  p.command('r_perf', ['0']);
  assert.equal(p.flags.msaa, true);
  assert.equal(p.flags.simple, false);
  assert.equal(p.flags.dpr, 2);
  assert.ok(seen.length >= 3);
}

{
  const lines = dumpFlags({
    profile: true,
    msaa: false,
    dpr: 1,
    bloom: false,
    shadows: false,
    shadowBodies: false,
    simple: true,
    skyPass: false,
    fpsMax: 240
  });
  assert.ok(lines.includes('r_simple 1'));
  assert.ok(lines.includes('fps_max 240'));
  assert.ok(PERF_HELP.some((l) => l.startsWith('r_simple')));
  assert.ok(PERF_HELP.some((l) => l.startsWith('fps_max')));
}

{
  const p = createPerfFlags({ fpsMax: 240 });
  assert.equal(p.flags.fpsMax, 240);
  assert.equal(p.command('fps_max', []), 'fps_max 240');
  assert.equal(p.command('fps_max', ['0']), 'fps_max 0');
  assert.equal(p.flags.fpsMax, 0);
  p.command('r_perf', ['1']);
  assert.equal(p.flags.fpsMax, 0);
  p.command('r_perf', ['0']);
  assert.equal(p.flags.fpsMax, 0);
  assert.equal(p.command('fps_max', ['1001']), 'fps_max 0..1000');
}

{
  assert.equal(displayHzHint(16.67), 'display ~60 Hz');
  assert.equal(displayHzHint(4.166), 'display ~240 Hz');
  assert.equal(displayHzHint(21), '');
}

console.log('perfToggles: ok');
