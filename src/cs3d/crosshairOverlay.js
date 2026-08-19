// ---------------------------------------------------------------------------
// src/cs3d/crosshairOverlay.js
// Trainer crosshair (src/components/Crosshair.js) over Map Practice and the
// timeline 3D canvas. Same gap / length / color / dot as the aim trainer.
// ---------------------------------------------------------------------------

import { Crosshair } from '../components/Crosshair.js';
import { SettingsManager } from '../core/SettingsManager.js';

/**
 * @param {HTMLElement} parent
 * @param {{ settings?: import('../core/SettingsManager.js').SettingsManager, scaleToResolution?: boolean }} [opts]
 * @returns {{ canvas: HTMLCanvasElement, crosshair: import('../components/Crosshair.js').Crosshair }}
 */
export function mountCrosshair(parent, { settings, scaleToResolution = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'c3-crosshair-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  parent.appendChild(canvas);
  const xh = new Crosshair(settings || new SettingsManager(), canvas, {
    fillParent: true,
    scaleToResolution
  });
  xh.setVisible(true);
  return { canvas, crosshair: xh };
}
