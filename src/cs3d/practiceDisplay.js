// ---------------------------------------------------------------------------
// src/cs3d/practiceDisplay.js
// Practice maps share the trainer's stored resolution: native window, a 4:3
// preset stretched to the viewport, or a custom backbuffer.
// ---------------------------------------------------------------------------

import { getResolutionSpec } from '../core/SettingsManager.js';

/**
 * @param {object} data  settings.activeSettings()
 * @param {number} displayW
 * @param {number} displayH
 * @param {number} [dpr]
 * @returns {{ width: number, height: number, pixelRatio: number }}
 */
export function practiceBackbuffer(data, displayW, displayH, dpr = 1) {
  const res = getResolutionSpec(data);
  if (res && res.size) {
    return { width: res.size[0], height: res.size[1], pixelRatio: 1 };
  }
  return {
    width: displayW,
    height: displayH,
    pixelRatio: Math.min(Number(dpr) || 1, 2)
  };
}
