// ---------------------------------------------------------------------------
// SceneManager.js
// Owns the active scenario instance and the run timer. Routes shoot events from
// the InputManager to the scenario and emits onFinish when the run duration is
// reached. Knows nothing about the DOM/UI — the UIOverlay subscribes to it.
// ---------------------------------------------------------------------------

import { GridshotScenario } from '../scenarios/GridshotScenario.js';
import { StarsScenario } from '../scenarios/StarsScenario.js';
import { MicroflicksScenario } from '../scenarios/MicroflicksScenario.js';
import { PasuScenario } from '../scenarios/PasuScenario.js';
import { SpidershotScenario } from '../scenarios/SpidershotScenario.js';
import { SurvivalScenario } from '../scenarios/SurvivalScenario.js';
import { ArenaScenario } from '../scenarios/ArenaScenario.js';
import { DuelsScenario } from '../scenarios/DuelsScenario.js';
import { RangeScenario } from '../scenarios/RangeScenario.js';
import { TrackingScenario } from '../scenarios/TrackingScenario.js';
import { DeathmatchScenario } from '../scenarios/DeathmatchScenario.js';
import { BounceScenario } from '../scenarios/BounceScenario.js';
import { MultiplayerDuelScenario } from '../scenarios/MultiplayerDuelScenario.js';
import { DURATION_MODES, resolveModeDuration } from './SettingsManager.js';
import { isKillLeaderboardScenario } from '../scenarios/leaderboardConfig.js';

// Singleplayer scenarios — these are the ones shown as menu cards + leaderboards.
export const SCENARIOS = {
  gridshot: GridshotScenario,
  stars: StarsScenario,
  bounce: BounceScenario,
  microflicks: MicroflicksScenario,
  pasu: PasuScenario,
  spidershot: SpidershotScenario,
  survival: SurvivalScenario,
  arena: ArenaScenario,
  duels: DuelsScenario,
  range: RangeScenario,
  tracking: TrackingScenario,
  deathmatch: DeathmatchScenario
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

    // A click only fires single-shot scenarios; weapon scenarios (full-auto)
    // are driven by the WeaponController from the held trigger instead.
    input.onShoot = () => {
      const sc = this.current;
      if (sc && sc.running && !sc.usesWeapon) sc.shoot();
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
      crosshair: this.crosshair,
      requestFinish: () => this.finishRun()
    });
    this._applyDuration(name, config);
    this.finished = false;
  }

  /**
   * Resolve the run length. Competitive runs and non-SP scenarios (multiplayer)
   * keep the scenario's own runDuration. Practice runs of the standard modes use
   * the per-mode duration (config code first, else settings): time ends on the
   * clock, kills ends when the kill target is hit (timer disabled, HUD counts up).
   */
  _applyDuration(name, config) {
    const sc = this.current;
    if (sc.competitive || !DURATION_MODES.includes(name)) {
      this.duration = sc.runDuration ?? this.settings.data.runDuration;
      return;
    }
    const cd = config?.duration;
    const dur = (cd && (cd.type === 'time' || cd.type === 'kills') && Number(cd.value) > 0)
      ? { type: cd.type, value: Number(cd.value) }
      : resolveModeDuration(this.settings.data?.[name], this.settings.data.runDuration);
    // A kills target only makes sense where kills accrue; otherwise the run
    // would never end. Fall back to the clock for non-kill modes.
    if (dur.type === 'kills' && isKillLeaderboardScenario(name)) {
      sc.killTarget = Math.max(1, Math.round(dur.value));
      sc.showElapsedTime = true; // HUD counts elapsed up instead of a remaining clock
      this.duration = Infinity;
    } else {
      // For a demoted kills config the value is a kill count, not seconds —
      // fall back to the global run duration rather than mis-reading it.
      const seconds = dur.type === 'time' ? dur.value : (Number(this.settings.data.runDuration) || 60);
      this.duration = seconds;
      sc.runDuration = seconds;
    }
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

  /** End the active run early (e.g. Survival game-over). */
  finishRun() {
    if (!this.current?.running || this.finished) return;
    this.finished = true;
    this.current.pause();
    if (this.onFinish) this.onFinish(this.current.results());
  }

  update(dt) {
    if (!this.current) return;
    this.current.update(dt);
    if (this.current.running && !this.finished) {
      const timeUp = Number.isFinite(this.duration) && this.current.elapsed >= this.duration;
      const killsUp = this.current.killTarget > 0 && this.current.kills >= this.current.killTarget;
      if (timeUp || killsUp) {
        this.finished = true;
        this.current.pause();
        if (this.onFinish) this.onFinish(this.current.results());
      }
    }
  }

  get timeRemaining() {
    if (!this.current) return this.duration;
    if (!Number.isFinite(this.duration)) return Infinity;
    return Math.max(0, this.duration - this.current.elapsed);
  }
}
