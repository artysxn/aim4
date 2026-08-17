// ---------------------------------------------------------------------------
// src/cs3d/crosshairOverlay.js
// The same PNG sits in the middle of Map Practice and the timeline 3D canvas.
// ---------------------------------------------------------------------------

import url from '../crosshair.png';

export function mountCrosshair(parent) {
  const img = document.createElement('img');
  img.className = 'c3-crosshair';
  img.src = url;
  img.alt = '';
  img.draggable = false;
  parent.appendChild(img);
  return img;
}
