// Run: node server/sim/jobs.test.js
//
// The two rails from SIM-PLAN 9.2b that are worth a test are the two that are
// invisible when they work and catastrophic when they do not:
//
//   Heavy work is opt-in per host. A prod box that quietly accepted a training
//   job would starve the parser, which is the exact failure this design exists
//   to prevent, and it would do it silently.
//
//   Parse work preempts sim work. Not "is deprioritized"; a queued parse means
//   nothing sim-side starts, and when the parse is done the sim job goes on its
//   own without anyone pressing anything.
//
// Plus the registry's one non-obvious rule (models.js): a local model beats a
// shipped one of the same name, because that override is the entire local
// training loop.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// A throwaway replay root, set before the modules that read it are imported.
const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-simjobs-'));
process.env.AIM4_REPLAY_DIR = ROOT;
process.env.AIM4_SIM_WORKERS = '0';

const jobs = await import('./jobs.js');
const models = await import('./models.js');

// ---- heavy jobs are opt-in -------------------------------------------------

{
  const r = await jobs.startJob('collect', { map: 'INF' });
  assert(r.error, 'a host with AIM4_SIM_WORKERS=0 refuses collection');
  assert(/AIM4_SIM_WORKERS/.test(r.error), 'and says how to turn it on');

  const t = await jobs.startJob('train', { dataset: 'nope.jsonl' });
  assert(t.error, 'and refuses training');

  const ex = await jobs.startJob('extract', { demos: 'abc' });
  assert(ex.error, 'and refuses demo extract');
  assert(/AIM4_SIM_WORKERS/.test(ex.error), 'extract is heavy');

  const roll = await jobs.startJob('rollout', { map: 'INF' });
  assert(roll.error, 'rollout is heavy and refused when workers=0');
  assert(/AIM4_SIM_WORKERS/.test(roll.error), 'and says how to turn it on');

  const bogus = await jobs.startJob('not-a-kind', {});
  assert(bogus.error, 'an unknown kind is refused rather than spawned');
}

// ---- parse work preempts sim work ------------------------------------------

{
  jobs._reset();
  let parsing = true;
  jobs.setParserBusyProbe(() => parsing);

  const started = await jobs.startJob('match', { map: 'INF', rounds: 1 });
  assert(started.ok, 'a match is accepted even on a host that refuses heavy work');
  await new Promise((r) => setTimeout(r, 50));
  assert(
    jobs.getJob(started.job.id).state === 'queued',
    'but it waits while the parser holds the box'
  );

  const status = jobs.hostStatus();
  assert(status.parserBusy === true, 'and the panel can see why it is waiting');
  assert(status.queued === 1, 'and how many are behind it');

  // Stopping a queued job is legal and immediate: nothing has been spawned.
  const stopped = jobs.stopJob(started.job.id);
  assert(stopped.ok, 'a queued job can be stopped');
  assert(jobs.getJob(started.job.id).state === 'error', 'and lands terminal, not lost');
  parsing = false;
}

// ---- parameters are clamped server-side ------------------------------------

{
  jobs._reset();
  jobs.setParserBusyProbe(() => true); // keep it queued; we only inspect params
  const r = await jobs.startJob('match', { map: 'inf', rounds: 9999, seed: 3 });
  assert(r.ok, 'the job is accepted');
  assert(r.job.params.rounds === 60, 'rounds are clamped to the engine ceiling');
  assert(r.job.params.map === 'INF', 'the map is normalized');
  assert(r.job.budgetSeconds > 0, 'and the job carries a wall-clock budget');
  jobs.stopJob(r.job.id);

  // Everything knowable before the fork is refused before it: a typo comes
  // back as an answer, not as a job that dies in a log somewhere.
  const badMap = await jobs.startJob('match', { map: 'ZZZ' });
  assert(badMap.error && /bake/.test(badMap.error), 'an unbaked map refuses with a reason');

  const badBrain = await jobs.startJob('match', { map: 'INF', brainA: '../etc' });
  assert(badBrain.error, 'a path-shaped brain name never reaches a spawn');
  assert(/etc/.test(badBrain.error) && !badBrain.error.includes('..'), 'and is sanitized on the way out');
}

// ---- the registry: local beats shipped -------------------------------------

{
  const localDir = path.join(ROOT, 'sim', 'models');
  await fsp.mkdir(localDir, { recursive: true });

  const shipped = await models.listModels();
  const bc0 = shipped.find((m) => m.name === 'bc0');
  assert(bc0, 'bc0 ships with the repo, so an empty host still has a brain');
  assert(bc0.source === 'shipped', 'and reports where it came from');
  assert(bc0.ok && bc0.vocab > 0, 'and it loads');

  // A local file of the same name wins, which is what makes training on the
  // PC and playing immediately work without a deploy.
  const json = JSON.parse(
    await fsp.readFile(path.join(models.SHIPPED_DIR, 'bc0.json'), 'utf8')
  );
  json.teacher = 'local-copy';
  await fsp.writeFile(path.join(localDir, 'bc0.json'), JSON.stringify(json));
  models.clearModelCache();

  const after = await models.loadModel('bc0');
  assert(!after.error, 'the local copy loads');
  assert(after.meta.source === 'local', 'and it is the one that wins');
  assert(after.meta.teacher === 'local-copy', 'reading the local bytes, not the shipped ones');

  // A model that exists and does not load is an error with a reason, never a
  // silent fallback to different weights.
  await fsp.writeFile(path.join(localDir, 'broken.json'), '{"v":1}');
  models.clearModelCache();
  const broken = await models.loadModel('broken');
  assert(broken.error, 'a malformed model is an error');
  const listed = (await models.listModels()).find((m) => m.name === 'broken');
  assert(listed && listed.ok === false && listed.error, 'and the panel gets to see why');

  assert((await models.isBrain('scripted')) === true, 'built-in brains need no file');
  assert((await models.isBrain('ghost')) === false, 'an unregistered brain is not playable');
}

await fsp.rm(ROOT, { recursive: true, force: true });
console.log('sim jobs: ok (heavy work opt-in, parse preemption, clamps, model override)');
