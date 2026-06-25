// ---------------------------------------------------------------------------
// main.js
// Composition root. Instantiates the managers, wires the single game loop and
// starts rendering. Each subsystem is decoupled — they communicate through the
// callbacks assigned here, not through direct references to one another.
// ---------------------------------------------------------------------------

import './style.css';
import { SettingsManager } from './core/SettingsManager.js';
import { AuthManager } from './core/AuthManager.js';
import { Engine } from './core/Engine.js';
import { InputManager } from './core/InputManager.js';
import { PlayerController } from './core/PlayerController.js';
import { GameAudio } from './audio/GameAudio.js';
import { Crosshair } from './components/Crosshair.js';
import { Viewmodel } from './components/Viewmodel.js';
import { WeaponController } from './weapons/WeaponController.js';
import { SceneManager } from './core/SceneManager.js';
import { UIOverlay } from './components/UIOverlay.js';

const settings = new SettingsManager();
const auth = new AuthManager(settings);
const engine = new Engine(settings);
const input = new InputManager(engine, settings);
const player = new PlayerController(engine, input);
engine.player = player; // scenarios enable/disable it via engine.player
engine.audio = new GameAudio(engine);
const crosshair = new Crosshair(settings);
const viewmodel = new Viewmodel(engine, settings);
engine.viewmodel = viewmodel; // scenarios reach it for muzzle/tracers
const sceneManager = new SceneManager(engine, input, settings, crosshair);
engine.sceneManager = sceneManager;
const weapon = new WeaponController({ engine, input, settings, sceneManager, viewmodel });
engine.weapon = weapon; // scenarios/UI reach it for ammo + reset
input.onReload = () => weapon.reload();
const ui = new UIOverlay({ engine, input, settings, crosshair, sceneManager, auth });

ui.init();
auth.init().then(() => ui.refreshAccountBar());

// One animation loop drives everything: advance the active scenario, then
// refresh the (cheap) UI read-outs.
engine.onUpdate = (dt) => {
  sceneManager.update(dt);
  // First-person weapon visuals: the viewmodel follows the camera during any
  // active weapon run (every scenario now uses the AK).
  const sc = sceneManager.current;
  const inFP = !!(sc?.usesWeapon && sc.running);
  viewmodel.setVisible(inFP);
  const motion = engine.player?.enabled
    ? {
        onGround: engine.player.onGround,
        speedHoriz: Math.hypot(engine.player.vel.x, engine.player.vel.z)
      }
    : {};
  viewmodel.update(dt, motion);
  weapon.update(dt);
  if (engine.audio && sceneManager.current?.running) {
    engine.audio.syncListener(engine.camera);
  }
  crosshair.frame(engine);
  ui.frame(dt);
};

// Surface any per-frame error in the UI (the loop keeps rendering regardless).
engine.onError = (e) => ui.showError(e);

engine.start();

// Dev-only handle for debugging/automated verification (stripped from prod).
if (import.meta.env.DEV) {
  window.__aim = { engine, input, player, settings, crosshair, sceneManager, ui, auth };
}
