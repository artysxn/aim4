import { RESOLUTIONS } from '../core/SettingsManager.js';

// ---------------------------------------------------------------------------
// Crosshair.js
// Dynamic crosshair drawn on a dedicated 2D canvas overlay, perfectly centered
// over the 3D viewport. Driven purely by config (color, innerGap, length,
// thickness, dotPercentage). Drawing on a separate canvas keeps it out of the
// WebGL scene graph so it never adds frametime to the 3D render.
// ---------------------------------------------------------------------------

export class Crosshair {
  constructor(settings) {
    this.settings = settings;
    this.canvas = document.getElementById('crosshair-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.visible = false;
    this._hitFlashUntil = 0;
    this._trackProgress = 0;

    window.addEventListener('resize', () => this.draw());
    settings.onChange(() => this.draw());
    this.setVisible(false);
  }

  setVisible(v) {
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
    if (v) this.draw();
  }

  /** Tracking fill for gridshot (0 = hidden, 1 = ready). */
  setTrackProgress(p) {
    this._trackProgress = Math.max(0, Math.min(1, p));
    if (this.visible) this.draw();
  }

  /** Flash a brief hitmarker. */
  hit() {
    if (this.settings.data.crosshair.hitmarker === false) return;
    this._hitFlashUntil = performance.now() + 120;
    this.draw();
    // Schedule one redraw to clear the marker after it expires.
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => this.draw(), 140);
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.visible) return;

    const { color, innerGap: rawGap, length: rawLen, thickness: rawThick, dotPercentage } = this.settings.data.crosshair;
    const cx = Math.round(w / 2);
    const cy = Math.round(h / 2);

    // Scale crosshair to match the render resolution so it stays proportional
    // when the game runs at a lower backbuffer size stretched to fill the viewport.
    const res = RESOLUTIONS[this.settings.data.resolution];
    const scale = (res && res.size) ? h / res.size[1] : 1;
    const innerGap = rawGap * scale;
    const length   = rawLen  * scale;
    const thickness = Math.max(1, rawThick * scale);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'butt';

    ctx.beginPath();
    // Top
    ctx.moveTo(cx, cy - innerGap);
    ctx.lineTo(cx, cy - innerGap - length);
    // Bottom
    ctx.moveTo(cx, cy + innerGap);
    ctx.lineTo(cx, cy + innerGap + length);
    // Left
    ctx.moveTo(cx - innerGap, cy);
    ctx.lineTo(cx - innerGap - length, cy);
    // Right
    ctx.moveTo(cx + innerGap, cy);
    ctx.lineTo(cx + innerGap + length, cy);
    ctx.stroke();

    if (this._trackProgress > 0) {
      const barW = 56 * scale;
      const barH = Math.max(2, 2.5 * scale);
      const barY = cy + innerGap + length + 10 * scale;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(cx - barW / 2, barY, barW, barH);
      ctx.fillStyle = color;
      ctx.fillRect(cx - barW / 2, barY, barW * this._trackProgress, barH);
    }

    // Center dot — radius scales with dotPercentage (0–100 -> 0–5px).
    if (dotPercentage > 0) {
      const r = (dotPercentage / 100) * 5;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }

    // Hitmarker flash.
    if (this.settings.data.crosshair.hitmarker !== false && performance.now() < this._hitFlashUntil) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      const g = innerGap + 3;
      const l = 7;
      ctx.beginPath();
      ctx.moveTo(cx - g, cy - g);
      ctx.lineTo(cx - g - l, cy - g - l);
      ctx.moveTo(cx + g, cy - g);
      ctx.lineTo(cx + g + l, cy - g - l);
      ctx.moveTo(cx - g, cy + g);
      ctx.lineTo(cx - g - l, cy + g + l);
      ctx.moveTo(cx + g, cy + g);
      ctx.lineTo(cx + g + l, cy + g + l);
      ctx.stroke();
    }
  }
}
