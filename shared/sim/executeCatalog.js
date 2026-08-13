// ---------------------------------------------------------------------------
// shared/sim/executeCatalog.js
// Seed execute templates: effects and an anchor, not tapes.
//
// SIM-PLAN 19.10 / 20.13. The miner (scripts/sim-mine-executes.mjs) writes
// richer copies under AIM4_REPLAY_DIR/sim/aggregates/executes/. This file is
// the fallback the bot can load with no I/O: two Inferno hits whose steps
// are the properties chapter 16 derives (deny a sightline, grant exposure,
// deliver bodies), so assignExecute and the repair ladder have something to
// chew on the first time an execute_entry fires.
//
// A missing grenade changes the cost matrix. It does not invalidate a script,
// because there is no script.
// ---------------------------------------------------------------------------

import { EFFECT, executeTemplate } from './execute.js';
import { NADE } from './grenades.js';

function aExecute() {
  return executeTemplate({
    id: 'inf-a-exec',
    map: 'INF',
    side: 'T',
    call: 'a-execute',
    anchor: 'apps',
    steps: [
      {
        id: 's1',
        effect: EFFECT.DENY_SIGHT,
        from: { x: 1850, y: 1200 },
        to: 'apps-exit',
        means: ['inf_smoke_arch', 'inf_smoke_library'],
        nade: NADE.SMOKE,
        window: [-3, 14],
        actor: 'support'
      },
      {
        id: 's2',
        effect: EFFECT.GRANT_EXPOSURE,
        from: { x: 2100, y: 900 },
        at: 'pit',
        means: ['inf_flash_pit'],
        nade: NADE.FLASH,
        window: [-0.4, 2],
        actor: 'entry',
        requires: ['s1']
      },
      {
        id: 's3',
        effect: EFFECT.DELIVER,
        to: ['apps-exit', 'site'],
        means: [],
        window: [0, 1.6],
        actor: 'core:pack',
        requires: ['s2']
      }
    ]
  });
}

function bExecute() {
  return executeTemplate({
    id: 'inf-b-exec',
    map: 'INF',
    side: 'T',
    call: 'b-execute',
    anchor: 'banana',
    steps: [
      {
        id: 's1',
        effect: EFFECT.DENY_SIGHT,
        from: { x: 800, y: 2800 },
        to: 'ct-spawn',
        means: ['inf_smoke_ct'],
        nade: NADE.SMOKE,
        window: [-3, 12],
        actor: 'support'
      },
      {
        id: 's2',
        effect: EFFECT.GRANT_EXPOSURE,
        from: { x: 700, y: 2600 },
        at: 'car',
        means: ['inf_flash_car'],
        nade: NADE.FLASH,
        window: [-0.4, 2],
        actor: 'entry',
        requires: ['s1']
      },
      {
        id: 's3',
        effect: EFFECT.DELIVER,
        to: ['car', 'site'],
        means: [],
        window: [0, 1.6],
        actor: 'core:pack',
        requires: ['s2']
      }
    ]
  });
}

/** Templates this map knows, keyed by call. */
export function catalogFor(map) {
  const code = String(map || '').toUpperCase();
  if (code === 'INF' || code === 'DE_INFERNO') return [aExecute(), bExecute()];
  return [];
}

/** Pick the template whose call matches the target site. */
export function templateFor(catalog, { call, site } = {}) {
  const list = catalog || [];
  if (call) {
    const hit = list.find((t) => t.call === call || t.id === call);
    if (hit) return hit;
  }
  const want = String(site || '').toLowerCase();
  if (want.startsWith('b') || want.includes('banana')) {
    return list.find((t) => /b-execute|b_execute/.test(t.call)) || list[0] || null;
  }
  if (want.startsWith('a') || want.includes('apps') || want.includes('pit')) {
    return list.find((t) => /a-execute|a_execute/.test(t.call)) || list[0] || null;
  }
  return list[0] || null;
}
