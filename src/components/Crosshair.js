import { getResolutionSpec } from '../core/SettingsManager.js';
import { shotSpreadRad } from '../utils/shotAccuracy.js';
import { degToRad } from '../utils/MathUtils.js';

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
    this._dynGapPx = 0; // extra gap (px) from movement spread when dynamicGap is on

    window.addEventListener('resize', () => this.draw());
    settings.onChange(() => {
      this.draw();
      this.drawPreview();
    });
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

  /**
   * Per-frame hook (from the game loop). When the dynamic-gap option is on, the
   * inner gap grows to show live bullet spread: movement inaccuracy plus weapon
   * bloom (sustain spray) in weapon scenarios. Redraws only when the pixel gap
   * actually changes.
   */
  frame(engine) {
    if (!this.visible || !this.settings.data.crosshair.dynamicGap) {
      if (this._dynGapPx !== 0) {
        this._dynGapPx = 0;
        this.draw();
      }
      return;
    }
    const player = engine.player;
    const state = player && player.enabled
      ? player.getAccuracyState()
      : { onGround: true, speedHoriz: 0 };

    const sc = engine.sceneManager?.current;
    const spread =
      sc?.usesWeapon && sc.running && engine.weapon
        ? engine.weapon.getBloomRad()
        : shotSpreadRad(state);

    // Project the spread half-angle to screen pixels: gap = cone radius at crosshair.
    const h = window.innerHeight;
    const focalPx = (h / 2) / Math.tan(degToRad(engine.camera.fov) / 2);
    const cap = Math.round(h * 0.45);
    const spreadPx = spread * focalPx;
    const px =
      spread <= 1e-7
        ? 0
        : Math.min(cap, Math.max(1, Math.round(spreadPx)));
    if (px !== this._dynGapPx) {
      this._dynGapPx = px;
      this.draw();
    }
  }

  /** Flash a brief hitmarker. */
  hit() {
    if (this.settings.data.crosshair.hitmarker === false) return;
    this._hitFlashUntil = performance.now() + 120;
    this.draw();
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => this.draw(), 140);
  }

  /** Live preview in Settings → Crosshair. */
  drawPreview(showHitmarker = false) {
    const canvas = document.getElementById('xh-preview-canvas');
    if (!canvas) return;
    const w = canvas.clientWidth || 180;
    const h = canvas.clientHeight || 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this._paint(ctx, w / 2, h / 2, {
      scale: 1,
      trackProgress: 0,
      hitFlash: showHitmarker || (
        this.settings.data.crosshair.hitmarker !== false &&
        performance.now() < this._hitFlashUntil
      )
    });
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

    const res = getResolutionSpec(this.settings.data);
    let scaleX = 1;
    let scaleY = 1;
    if (res && res.size) {
      scaleX = w / res.size[0];
      scaleY = h / res.size[1];
    }
    this._paint(ctx, Math.round(w / 2), Math.round(h / 2), {
      scaleX,
      scaleY,
      dynGap: this._dynGapPx,
      trackProgress: this._trackProgress,
      hitFlash: this.settings.data.crosshair.hitmarker !== false &&
        performance.now() < this._hitFlashUntil
    });
  }

  _paint(ctx, cx, cy, { scaleX, scaleY, trackProgress, hitFlash, dynGap = 0 }) {
    const { color, innerGap: rawGap, length: rawLen, thickness: rawThick, dotPercentage } =
      this.settings.data.crosshair;
    const innerGapX = rawGap * scaleX + dynGap;
    const innerGapY = rawGap * scaleY + dynGap;
    const lengthX = rawLen * scaleX;
    const lengthY = rawLen * scaleY;
    const thickness = Math.max(1, rawThick * Math.min(scaleX, scaleY));

    // An even-thickness line straddles the pixel boundary cleanly at the exact
    // centre; an odd-thickness line drawn there blurs across two pixels. So for
    // odd thickness, anchor the crosshair on the top-left of the centre four
    // pixels (half a pixel up-left) so every line falls on whole pixels.
    if (Math.round(thickness) % 2 === 1) {
      cx -= 0.5;
      cy -= 0.5;
    }

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'butt';

    ctx.beginPath();
    ctx.moveTo(cx, cy - innerGapY);
    ctx.lineTo(cx, cy - innerGapY - lengthY);
    ctx.moveTo(cx, cy + innerGapY);
    ctx.lineTo(cx, cy + innerGapY + lengthY);
    ctx.moveTo(cx - innerGapX, cy);
    ctx.lineTo(cx - innerGapX - lengthX, cy);
    ctx.moveTo(cx + innerGapX, cy);
    ctx.lineTo(cx + innerGapX + lengthX, cy);
    ctx.stroke();

    if (trackProgress > 0) {
      const barW = 56 * scaleX;
      const barH = Math.max(2, 2.5 * scaleY);
      const barY = cy + innerGapY + lengthY + 10 * scaleY;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(cx - barW / 2, barY, barW, barH);
      ctx.fillStyle = color;
      ctx.fillRect(cx - barW / 2, barY, barW * trackProgress, barH);
    }

    if (dotPercentage > 0) {
      const r = (dotPercentage / 100) * 5 * Math.min(scaleX, scaleY);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }

    if (hitFlash) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      const gX = innerGapX + 3;
      const gY = innerGapY + 3;
      const lX = 7 * scaleX;
      const lY = 7 * scaleY;
      ctx.beginPath();
      ctx.moveTo(cx - gX, cy - gY);
      ctx.lineTo(cx - gX - lX, cy - gY - lY);
      ctx.moveTo(cx + gX, cy - gY);
      ctx.lineTo(cx + gX + lX, cy - gY - lY);
      ctx.moveTo(cx - gX, cy + gY);
      ctx.lineTo(cx - gX - lX, cy + gY + lY);
      ctx.moveTo(cx + gX, cy + gY);
      ctx.lineTo(cx + gX + lX, cy + gY + lY);
      ctx.stroke();
    }
  }
}
