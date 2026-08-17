// ---------------------------------------------------------------------------
// src/cs3d/vmTuner.js
// The viewmodel panel (U): hand, FOV and where the hands sit, live, while you
// are looking at them.
//
// These are the ACCOUNT's settings, the same `viewmodel` block the trainer's
// settings screen edits and AuthManager syncs to the profile — not a local copy.
// Moving a slider here changes it everywhere and it survives a reload, because
// it is the same store either way.
//
// Offsets are the trainer's metres on the trainer's axes (right / up /
// forward); viewModel.js converts them to Source units and reads them as a
// delta from their defaults, so a fresh account gets the placement the pack
// solved and nothing else.
//
// The gun rows below the divider are a different thing: a scratch nudge on the
// held weapon, not saved anywhere, for checking a single model against the
// placement cs3d-weapons.mjs computed for it.
// ---------------------------------------------------------------------------

import { VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX } from '../core/SettingsManager.js';

/** [label, group, key, min, max, step] — `set` rows persist, `wpn`/`rot` do not. */
const ROWS = [
  ['fov', 'set', 'fov', VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX, 1],
  ['hands right', 'set', 'offsetX', -0.5, 0.5, 0.01],
  ['hands up', 'set', 'offsetY', -0.5, 0.5, 0.01],
  ['hands forward', 'set', 'offsetZ', -0.5, 1, 0.01],
  ['gun forward', 'wpn', 'x', -30, 30, 0.25],
  ['gun up', 'wpn', 'y', -20, 20, 0.25],
  ['gun right', 'wpn', 'z', -20, 20, 0.25],
  ['gun roll°', 'rot', 'x', -180, 180, 1],
  ['gun yaw°', 'rot', 'y', -180, 180, 1],
  ['gun pitch°', 'rot', 'z', -180, 180, 1],
  // How much sky the gun reflects. Metal has no diffuse term, so with none of
  // this it renders black; with too much it is a mirror. Scratch, not saved.
  ['sky reflect', 'env', 'v', 0, 1.5, 0.05]
];

const DECIMALS = { fov: 0, offsetX: 2, offsetY: 2, offsetZ: 2, v: 2 };

/**
 * @param {object} o
 * @param {import('./viewModel.js').ViewModel} o.viewModel
 * @param {{setFov: (v: number) => void}} o.vmPass
 * @param {import('../core/SettingsManager.js').SettingsManager} o.settings
 * @param {() => void} o.apply  re-reads the settings onto the viewmodel
 */
export function createViewModelTuner({ viewModel, vmPass, settings, apply }) {
  const scratch = { wpn: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, env: { v: 1 } };
  const vm = () => settings.data.viewmodel;

  const pushScratch = () => {
    viewModel.tune.wpn.set(scratch.wpn.x, scratch.wpn.y, scratch.wpn.z);
    viewModel.tune.rot.set(scratch.rot.x, scratch.rot.y, scratch.rot.z);
    viewModel.applyWeaponTune();
  };

  const el = document.createElement('div');
  el.className = 'cs3d-vmtune';
  el.hidden = true;
  el.innerHTML =
    '<header>viewmodel<span class="cs3d-vmtune-w"></span></header>' +
    '<div class="cs3d-vmtune-hand"><button data-hand="right">Right hand</button><button data-hand="left">Left hand</button></div>' +
    ROWS.map(
      ([label, g, k, min, max, step], i) =>
        (i === 4 ? '<hr>' : '') +
        `<label data-g="${g}" data-k="${k}"><span>${label}</span>` +
        `<input type="range" min="${min}" max="${max}" step="${step}"><b></b></label>`
    ).join('') +
    '<footer><button data-act="reset">Reset</button><button data-act="defaults">Defaults</button></footer>';

  const valueOf = (g, k) => (g === 'set' ? Number(vm()[k]) : scratch[g][k]);

  const sync = () => {
    for (const row of el.querySelectorAll('label')) {
      const { g, k } = row.dataset;
      const v = valueOf(g, k);
      row.querySelector('input').value = String(v);
      row.querySelector('b').textContent = Number(v).toFixed(DECIMALS[k] ?? 2);
    }
    for (const b of el.querySelectorAll('[data-hand]')) b.classList.toggle('on', b.dataset.hand === vm().hand);
    el.querySelector('.cs3d-vmtune-w').textContent = viewModel.weaponName ? ` — ${viewModel.weaponName}` : '';
  };

  el.addEventListener('input', (e) => {
    const row = e.target.closest('label');
    if (!row) return;
    const { g, k } = row.dataset;
    const v = Number(e.target.value);
    row.querySelector('b').textContent = v.toFixed(DECIMALS[k] ?? 2);
    if (g === 'set') {
      vm()[k] = v;
      settings.save(); // localStorage now, profile on the debounce
      apply();
    } else if (g === 'env') {
      scratch.env.v = v;
      vmPass.setEnvironment(vmPass.scene.environment, v);
    } else {
      scratch[g][k] = v;
      pushScratch();
    }
  });

  el.addEventListener('click', (e) => {
    const hand = e.target.dataset?.hand;
    if (hand) {
      vm().hand = hand;
      settings.save();
      apply();
      sync();
      return;
    }
    const act = e.target.dataset?.act;
    if (act === 'reset') {
      scratch.wpn = { x: 0, y: 0, z: 0 };
      scratch.rot = { x: 0, y: 0, z: 0 };
      scratch.env.v = 1;
      vmPass.setEnvironment(vmPass.scene.environment, 1);
      pushScratch();
      sync();
    } else if (act === 'defaults') {
      Object.assign(vm(), { hand: 'right', fov: VIEWMODEL_FOV_MAX, offsetX: 0.16, offsetY: -0.15, offsetZ: 0.5 });
      settings.save();
      apply();
      sync();
    }
  });

  document.body.appendChild(el);
  sync();

  return {
    el,
    get open() {
      return !el.hidden;
    },
    toggle() {
      el.hidden = !el.hidden;
      // The sliders need the cursor, so drop the pointer lock while it is up.
      if (!el.hidden) {
        sync();
        document.exitPointerLock?.();
      }
      return !el.hidden;
    },
    close() {
      el.hidden = true;
    },
    dispose() {
      el.remove();
    }
  };
}
