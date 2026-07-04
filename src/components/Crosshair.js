import { getResolutionSpec } from '../core/SettingsManager.js';
import { shotSpreadRad } from '../utils/shotAccuracy.js';
import { degToRad } from '../utils/MathUtils.js';

// ---------------------------------------------------------------------------
// Crosshair.js
// Dynamic crosshair drawn on a dedicated 2D canvas overlay, perfectly centered
// over the 3D viewport. The crosshair is rasterised pixel-by-pixel at the
// configured game resolution, then nearest-neighbour scaled to the window so
// stretching matches in-game pixel scaling (not simulated gap/length scaling).
// ---------------------------------------------------------------------------

function parseColor(hex, alpha = 1) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padStart(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [255, 255, 255, Math.round(alpha * 255)];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(Math.max(0, Math.min(1, alpha)) * 255)];
}

export class Crosshair {
  constructor(settings) {
    this.settings = settings;
    this.canvas = document.getElementById('crosshair-canvas');
    this.ctx = this.canvas.getContext('2d');
    this._offscreen = document.createElement('canvas');
    this._offCtx = this._offscreen.getContext('2d', { alpha: true });
    this.visible = false;
    this._hitFlashUntil = 0;
    this._trackProgress = 0;
    this._dynGapPx = 0;

    window.addEventListener('resize', () => this.draw());
    settings.onChange(() => {
      this.draw();
      this.drawPreview();
    });
    settings.onDraftChange(() => this.drawPreview());
    this.setVisible(false);
  }

  setVisible(v) {
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
    if (v) this.draw();
  }

  setTrackProgress(p) {
    this._trackProgress = Math.max(0, Math.min(1, p));
    if (this.visible) this.draw();
  }

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

  hit() {
    if (this.settings.data.crosshair.hitmarker === false) return;
    this._hitFlashUntil = performance.now() + 120;
    this.draw();
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => this.draw(), 140);
  }

  drawPreview(showHitmarker = false) {
    const canvas = document.getElementById('xh-preview-canvas');
    if (!canvas) return;
    const w = canvas.clientWidth || 216;
    const h = canvas.clientHeight || 216;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const crosshair = this.settings.activeSettings().crosshair;
    const refW = 1920;
    const refH = 1080;
    const img = this._rasterCrosshair(refW, refH, {
      crosshair,
      dynGap: 0,
      trackProgress: 0,
      hitFlash: showHitmarker || (
        crosshair.hitmarker !== false &&
        performance.now() < this._hitFlashUntil
      )
    });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, refW, refH, 0, 0, w, h);
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
    const refW = Math.max(1, res?.size?.[0] || 1920);
    const refH = Math.max(1, res?.size?.[1] || 1080);
    const dynGapRef = Math.round(this._dynGapPx * (refH / Math.max(1, h)));

    const img = this._rasterCrosshair(refW, refH, {
      dynGap: dynGapRef,
      trackProgress: this._trackProgress,
      hitFlash: this.settings.data.crosshair.hitmarker !== false &&
        performance.now() < this._hitFlashUntil
    });

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, refW, refH, 0, 0, w, h);
  }

  /** Rasterise the crosshair at 1:1 reference pixels; returns an HTMLCanvasElement. */
  _rasterCrosshair(refW, refH, { crosshair, dynGap = 0, trackProgress = 0, hitFlash = false } = {}) {
    const xh = crosshair ?? this.settings.data.crosshair;
    this._offscreen.width = refW;
    this._offscreen.height = refH;

    const img = this._offCtx.createImageData(refW, refH);
    const mask = new Uint8Array(refW * refH);
    const cx = Math.floor(refW / 2);
    const cy = Math.floor(refH / 2);
    const gap = Math.round(xh.innerGap + dynGap);
    const len = Math.round(xh.length);
    const thick = Math.max(1, Math.round(xh.thickness));
    const half = Math.floor(thick / 2);
    const [cr, cg, cb, ca] = parseColor(xh.color);

    const fillRect = (x0, y0, x1, y1) => {
      const xa = Math.max(0, Math.min(x0, x1));
      const xb = Math.min(refW - 1, Math.max(x0, x1));
      const ya = Math.max(0, Math.min(y0, y1));
      const yb = Math.min(refH - 1, Math.max(y0, y1));
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const i = (y * refW + x) * 4;
          img.data[i] = cr;
          img.data[i + 1] = cg;
          img.data[i + 2] = cb;
          img.data[i + 3] = ca;
          mask[y * refW + x] = 1;
        }
      }
    };

    // Vertical arms
    fillRect(cx - half, cy - gap - len, cx + half, cy - gap);
    fillRect(cx - half, cy + gap, cx + half, cy + gap + len);
    // Horizontal arms
    fillRect(cx - gap - len, cy - half, cx - gap, cy + half);
    fillRect(cx + gap, cy - half, cx + gap + len, cy + half);

    if (trackProgress > 0) {
      const barW = 56;
      const barH = 3;
      const barY = cy + gap + len + 10;
      fillRect(cx - barW / 2, barY, cx - barW / 2 + barW * trackProgress, barY + barH - 1);
    }

    if (xh.dotPercentage > 0) {
      const r = Math.max(1, Math.round((xh.dotPercentage / 100) * 5));
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= r * r) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= refW || y >= refH) continue;
            const i = (y * refW + x) * 4;
            img.data[i] = cr;
            img.data[i + 1] = cg;
            img.data[i + 2] = cb;
            img.data[i + 3] = ca;
            mask[y * refW + x] = 1;
          }
        }
      }
    }

    if (hitFlash) {
      const g = gap + 3;
      const l = 7;
      const flash = [255, 255, 255, 255];
      const setFlash = (x, y) => {
        if (x < 0 || y < 0 || x >= refW || y >= refH) return;
        const i = (y * refW + x) * 4;
        img.data[i] = flash[0];
        img.data[i + 1] = flash[1];
        img.data[i + 2] = flash[2];
        img.data[i + 3] = flash[3];
        mask[y * refW + x] = 1;
      };
      const line = (x0, y0, x1, y1) => {
        const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let s = 0; s <= steps; s++) {
          const t = steps ? s / steps : 0;
          setFlash(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
        }
      };
      line(cx - g, cy - g, cx - g - l, cy - g - l);
      line(cx + g, cy - g, cx + g + l, cy - g - l);
      line(cx - g, cy + g, cx - g - l, cy + g + l);
      line(cx + g, cy + g, cx + g + l, cy + g + l);
    }

    if (xh.outline) {
      const [or, og, ob, oa] = parseColor(xh.outlineColor, xh.outlineOpacity ?? 1);
      const out = img.data.slice();
      for (let y = 0; y < refH; y++) {
        for (let x = 0; x < refW; x++) {
          if (mask[y * refW + x]) continue;
          let edge = false;
          for (let dy = -1; dy <= 1 && !edge; dy++) {
            for (let dx = -1; dx <= 1 && !edge; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < refW && ny < refH && mask[ny * refW + nx]) edge = true;
            }
          }
          if (!edge) continue;
          const i = (y * refW + x) * 4;
          out[i] = or;
          out[i + 1] = og;
          out[i + 2] = ob;
          out[i + 3] = oa;
        }
      }
      img.data.set(out);
    }

    this._offCtx.putImageData(img, 0, 0);
    return this._offscreen;
  }
}
