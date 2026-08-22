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
import { ReplayRecorder } from './core/ReplayRecorder.js';
import { ReplayPlayer } from './core/ReplayPlayer.js';
import { UIOverlay } from './components/UIOverlay.js';
import { getEntitlements } from './lib/entitlements.js';
import { sharedAgentModels, setAgentPaint } from './agents/agentModels.js';
import { sharedWeaponAssets } from './agents/weaponAssets.js';
import { BOT_WEAPON } from './bots/buildBotTarget.js';
import { TRAINER_WEAPONS } from './agents/weaponAssets.js';

const settings = new SettingsManager();
const auth = new AuthManager(settings);
// The trainer is its own entry point, so it has to build the entitlement
// manager itself. Without this, getEntitlements() inside UIOverlay returns null
// and every aim trainer gate silently passes. :)
const entitlements = getEntitlements(auth);
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
input.onAltFire = () => weapon.cycleScope();
input.onUnscope = () => weapon.unscope();
const replayRecorder = new ReplayRecorder(engine, input);
engine.replayRecorder = replayRecorder; // BaseScenario.shoot records shots through it
const replayPlayer = new ReplayPlayer(engine);
engine.replayPlayer = replayPlayer;
const ui = new UIOverlay({
  engine, input, settings, crosshair, sceneManager, auth, replayRecorder, replayPlayer
});

// CS2's own agent and weapon models, off the same CDN the 3D map explorer
// reads. Started here and never awaited: everything that draws them checks
// `ready` and keeps the built-in blocky models until the pack lands, so a slow
// (or absent) CDN costs the first run of a session its fidelity and nothing
// else. See src/agents/packBase.js.
sharedAgentModels().load();

// The agent bots' paint, pushed from settings rather than read by them: a bot
// is built by whatever scenario is running and a colour picker is dragged
// rather than submitted, so this is the one place that knows both.
function pushAgentPaint() {
  const s = settings.activeSettings();
  setAgentPaint({
    flat: s.bots?.flatColors === true,
    head: s.colors?.agentHead,
    torso: s.colors?.agentTorso,
    arms: s.colors?.agentArms,
    legs: s.colors?.agentLegs
  });
}
pushAgentPaint();
settings.onChange(pushAgentPaint);
sharedWeaponAssets()
  .preload([...Object.values(TRAINER_WEAPONS), BOT_WEAPON])
  .catch(() => {});

ui.init();
auth.init().then(() => {
  ui.refreshAccountBar();
  entitlements.refresh();
});

// One animation loop drives everything: advance the active scenario, then
// refresh the (cheap) UI read-outs.
engine.onUpdate = (dt) => {
  // Replay playback fully owns the camera + scene; the live scenario is paused.
  if (ui.replaying) {
    const motion = replayPlayer.getMotion();
    engine.viewmodel?.update(dt, motion);
    replayPlayer.update(dt);
    engine.audio?.syncListener(engine.camera);
    crosshair.frame(engine);
    return;
  }
  sceneManager.update(dt);
  const sc = sceneManager.current;
  const inFP = !!(sc?.usesWeapon && sc.running && sc.showViewmodel !== false);
  // The gun model is hidden while looking through the scope (CS behaviour).
  viewmodel.setVisible(inFP && weapon.scopeLevel === 0);
  const motion = engine.player?.enabled
    ? {
        onGround: engine.player.onGround,
        speedHoriz: Math.hypot(engine.player.vel.x, engine.player.vel.z)
      }
    : {};
  viewmodel.update(dt, motion);
  weapon.update(dt);
  // Sample telemetry after the viewmodel so camera punch/kick is captured.
  if (replayRecorder.active && sceneManager.current?.running) {
    replayRecorder.sample(dt);
  }
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
  window.__aim = { engine, input, player, settings, crosshair, sceneManager, ui, auth, weapon, viewmodel, agents: sharedAgentModels(), guns: sharedWeaponAssets() };
}
