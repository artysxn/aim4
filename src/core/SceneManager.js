// ---------------------------------------------------------------------------
// SceneManager.js
// Owns the active scenario instance and the run timer. Routes shoot events from
// the InputManager to the scenario and emits onFinish when the run duration is
// reached. Knows nothing about the DOM/UI — the UIOverlay subscribes to it.
// ---------------------------------------------------------------------------

import { GridshotScenario } from '../scenarios/GridshotScenario.js';
import { ArenaScenario } from '../scenarios/ArenaScenario.js';
import { DuelsScenario } from '../scenarios/DuelsScenario.js';
import { RangeScenario } from '../scenarios/RangeScenario.js';
import { MultiplayerDuelScenario } from '../scenarios/MultiplayerDuelScenario.js';

// Singleplayer scenarios — these are the ones shown as menu cards + leaderboards.
export const SCENARIOS = {
  gridshot: GridshotScenario,
  arena: ArenaScenario,
  duels: DuelsScenario,
  range: RangeScenario
};

// Scenarios launched outside the card grid (e.g. multiplayer).
const EXTRA_SCENARIOS = {
  mpduel: MultiplayerDuelScenario
};

export class SceneManager {
  constructor(engine, input, settings, crosshair) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.crosshair = crosshair;

    this.current = null;
    this.duration = settings.data.runDuration;
    this.finished = false;
    this.onFinish = null; // (results) => void

    // A shot fired only matters if a scenario is actively running.
    input.onShoot = () => {
      if (this.current && this.current.running) this.current.shoot();
    };
  }

  /** Instantiate a scenario and reset the camera, but do not start the timer. */
  load(name, config = {}) {
    this.unload();
    const Cls = SCENARIOS[name] || EXTRA_SCENARIOS[name];
    if (!Cls) throw new Error(`Unknown scenario "${name}"`);

    this.engine.resetCamera();
    this.input.syncFromCamera();

    this.current = new Cls({
      engine: this.engine,
      settings: this.settings,
      config,
      crosshair: this.crosshair
    });
    // A scenario may opt out of the fixed run timer (e.g. multiplayer "first to X").
    this.duration = this.current.runDuration ?? this.settings.data.runDuration;
    this.finished = false;
  }

  begin() {
    if (this.current) this.current.start();
  }
  pause() {
    if (this.current) this.current.pause();
  }
  resume() {
    if (this.current) this.current.resume();
  }

  unload() {
    if (this.current) {
      this.current.dispose();
      this.current = null;
    }
  }

  update(dt) {
    if (!this.current) return;
    this.current.update(dt);
    if (this.current.running && !this.finished && this.current.elapsed >= this.duration) {
      this.finished = true;
      this.current.pause();
      if (this.onFinish) this.onFinish(this.current.results());
    }
  }

  get timeRemaining() {
    if (!this.current) return this.duration;
    return Math.max(0, this.duration - this.current.elapsed);
  }
}
