// ---------------------------------------------------------------------------
// CircleScenario.js  ("Circle")
//
// Box's sibling: the dot cycles along an ellipse instead of a rectangle. Same
// rules — random 100–200 u/s per dot, 2 s continuous hold to arm, click to
// kill, 0.5 s respawn. The canvas is an elliptical board sized exactly to the
// dot's travel path.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BoxScenario } from './BoxScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

const WALL_DISTANCE = 10;

export class CircleScenario extends BoxScenario {
  get name() {
    return 'circle';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return CircleScenario.configKeyFor(this.settings, this.variant);
  }

  /** Elliptical board covering exactly the path (path radii + dot radius). */
  _canvasMesh(colors) {
    const pad = this.targetSize + 0.05;
    const board = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshStandardMaterial({ color: colors.cover, roughness: 0.95, metalness: 0 })
    );
    board.scale.set(this.sizeX / 2 + pad, this.sizeY / 2 + pad, 1);
    board.position.set(0, this.centerY, -WALL_DISTANCE);
    return board;
  }

  // Path param s is the ellipse angle (radians) here, not arc length.
  _pathLength() {
    return Math.PI * 2;
  }

  _pathPos(s) {
    return {
      x: (this.sizeX / 2) * Math.cos(s),
      y: (this.sizeY / 2) * Math.sin(s)
    };
  }

  /** Advance by `dist` metres of arc: dθ = dist / local radius of travel. */
  _advancePath(dot, dist) {
    const rx = this.sizeX / 2;
    const ry = this.sizeY / 2;
    const local = Math.max(
      0.05,
      Math.hypot(rx * Math.sin(dot.s), ry * Math.cos(dot.s))
    );
    dot.s += dist / local;
  }
}
