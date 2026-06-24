// ---------------------------------------------------------------------------
// main.js
// Composition root. Instantiates the managers, wires the single game loop and
// starts rendering. Each subsystem is decoupled — they communicate through the
// callbacks assigned here, not through direct references to one another.
// ---------------------------------------------------------------------------

import './style.css';
import { SettingsManager } from './core/SettingsManager.js';
import { Engine } from './core/Engine.js';
import { InputManager } from './core/InputManager.js';
import { PlayerController } from './core/PlayerController.js';
import { Crosshair } from './components/Crosshair.js';
import { SceneManager } from './core/SceneManager.js';
import { UIOverlay } from './components/UIOverlay.js';

const settings = new SettingsManager();
const engine = new Engine(settings);
const input = new InputManager(engine, settings);
const player = new PlayerController(engine, input);
engine.player = player; // scenarios enable/disable it via engine.player
const crosshair = new Crosshair(settings);
const sceneManager = new SceneManager(engine, input, settings, crosshair);
const ui = new UIOverlay({ engine, input, settings, crosshair, sceneManager });

ui.init();

// One animation loop drives everything: advance the active scenario, then
// refresh the (cheap) UI read-outs.
engine.onUpdate = (dt) => {
  sceneManager.update(dt);
  ui.frame(dt);
};

// Surface any per-frame error in the UI (the loop keeps rendering regardless).
engine.onError = (e) => ui.showError(e);

engine.start();

// Dev-only handle for debugging/automated verification (stripped from prod).
if (import.meta.env.DEV) {
  window.__aim = { engine, input, player, settings, crosshair, sceneManager, ui };
}
