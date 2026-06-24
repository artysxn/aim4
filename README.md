# Aim Trainer (Three.js)

A web-based aim trainer in the style of Aim Lab, built with **Three.js**, the
**Pointer Lock API** and **Vite**. Features true `cm/360` sensitivity, a fully
configurable crosshair, resolution scaling, two scenarios, and local
leaderboards.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

Build for production:

```bash
npm run build
npm run preview
```

## How to play

- Click **Play** on a scenario card to lock the mouse and begin a timed run.
- **Left-click** to shoot (a ray is cast from the crosshair / screen center).
- **WASD** to move and **Ctrl / C** to crouch — active in **Duels** and **Range**
  (Gridshot and Crossfire keep you stationary).
- Press **Esc** to release the mouse and pause; **Resume** to re-lock.
- Scores are saved per scenario *and per configuration* to `localStorage`.

## Scenarios

| Mode | Description |
| --- | --- |
| **Gridshot** | Three spheres on a wall; destroy one and a new one spawns. Optional per-target time limit. |
| **Crossfire (80°)** | Hit the circle to arm; after a 0.33–2 s delay a bot breaks from a column — 70% crosses the gap, 30% baits an open peek then crosses. Head = instant kill (crit), body = chip damage. |
| **Duels** | A 1v1 peek-fight in one of five arenas (varying distance, height and cover). The enemy breaks cover at CS2 speed — peeking left/right, wide/close, holding, jiggling or retreating. Strafe + crouch behind your own box to trade. Head = instant kill, body = 2 shots. |
| **Range** | Stadium tracking. Bots ring you on a 90/180/360° arc and strafe left/right only (never toward you), reversing at random and tap-crouching. You may roam a 5×5 m box. Head = instant kill, body = 2 shots. |

### Movement (Source / CS2 model)

The player and every bot share one integrator
([`utils/SourceMovement.js`](src/utils/SourceMovement.js)) — a direct port of the
Source-engine `PM_Friction` / `PM_Accelerate` routines:

```
sv_maxspeed   250 u/s  (running)     crouch speed = 0.34 × run
sv_accelerate 5.5                    1 unit       = 0.0254 m
sv_friction   5.2                    stand eye    = 1.60 m
sv_stopspeed  80 u/s                 crouch eye   = 1.15 m
```

Bots strafe through a 1-D variant (`SourceMover1D`) with counter-strafe braking,
so their peeks ramp up and stop exactly like a player's. `PlayerController` owns
the camera *position* while the InputManager still owns *look*; movement-free
modes simply never enable it.

## Architecture

```
src/
├── main.js                  # composition root + game loop
├── style.css
├── core/
│   ├── Engine.js            # renderer, camera, loop, resolution/FOV
│   ├── InputManager.js      # pointer lock, raw deltas, sensitivity, movement keys
│   ├── PlayerController.js   # WASD + crouch via the shared Source mover
│   ├── SceneManager.js      # scenario lifecycle + run timer
│   └── SettingsManager.js   # settings + localStorage
├── components/
│   ├── Crosshair.js         # 2D canvas crosshair overlay
│   ├── UIOverlay.js         # menus, HUD, pause/results, leaderboards
│   └── Target.js            # base target (mesh, collision, lifecycle)
├── scenarios/
│   ├── BaseScenario.js      # abstract: metrics, timer, raycasting
│   ├── GridshotScenario.js
│   ├── ArenaScenario.js     # Crossfire
│   ├── DuelsScenario.js     # 5 arenas, peeking bot
│   └── RangeScenario.js     # stadium, strafing bots
└── utils/
    ├── MathUtils.js         # cm/360 → radians, FOV, easing
    ├── SourceMovement.js    # CS2/Source friction + accel (player & bots)
    └── Storage.js           # localStorage + leaderboard helpers
```

### Sensitivity math

```
Counts per 360  = cm360 * DPI * 0.393701   (DPI is counts/inch; 1 cm = 0.393701 in)
Radians / count = 2π / Counts per 360
```

Raw `movementX/Y` deltas under Pointer Lock are multiplied by *radians/count*
and applied directly to the camera's `YXZ` Euler angles. Pitch is clamped to
±89°.

### Resolution scaling

Fixed resolutions render at their exact backbuffer size
(`renderer.setSize(w, h, false)`) while CSS stretches the canvas to fill the
viewport. Horizontal FOV is held constant across aspect ratios.
