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

function outlineRgba(xh) {
  const hex = xh.outlineColor || '#000000';
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padStart(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  const a = Math.max(0, Math.min(1, xh.outlineOpacity ?? 1));
  if (!Number.isFinite(n)) return `rgba(0,0,0,${a})`;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function outlineThickness(xh) {
  let t = Number(xh?.outlineThickness);
  if (!Number.isFinite(t) && xh?.outline) t = 1;
  if (!Number.isFinite(t)) t = 0;
  return Math.max(0, t);
}

export class Crosshair {
  constructor(settings) {
    this.settings = settings;
    this.canvas = document.getElementById('crosshair-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.visible = false;
    this._hitFlashUntil = 0;
    this._trackProgress = 0;
    this._dynGapPx = 0;
    this._scopeLevel = 0; // sniper: >0 replaces the crosshair with the scope overlay
    this._scopeBlur = 0; // px of hairline blur (inaccurate: just-scoped / moving)

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

  /** Live scope state: from the weapon during a run, from the replay when watching. */
  _scopeState(engine) {
    const rp = engine.replayPlayer;
    if (rp?.active) return { level: rp.scopeLevel || 0, blur: rp.scopeBlur || 0 };
    const weapon = engine.weapon;
    const sc = engine.sceneManager?.current;
    if (weapon?.scopeLevel > 0 && sc?.usesWeapon && !sc._dead) {
      // Map the live bloom cone to hairline blur so "inaccurate" is visible:
      // freshly scoped or moving above the accuracy threshold ⇒ blurry lines.
      const bloomDeg = (weapon.getBloomRad() * 180) / Math.PI;
      const blur = Math.max(0, Math.min(10, (bloomDeg - 0.05) * 3.2));
      return { level: weapon.scopeLevel, blur };
    }
    return { level: 0, blur: 0 };
  }

  frame(engine) {
    if (this.visible) {
      const scope = this._scopeState(engine);
      if (
        scope.level !== this._scopeLevel ||
        Math.abs(scope.blur - this._scopeBlur) > 0.25
      ) {
        this._scopeLevel = scope.level;
        this._scopeBlur = scope.blur;
        this.draw();
      }
      if (this._scopeLevel > 0) return; // dynamic gap is hipfire-only
    }
    if (!this.visible || !this.settings.activeSettings().crosshair.dynamicGap) {
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
    if (this.settings.activeSettings().crosshair.hitmarker === false) return;
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
    this._paint(ctx, w / 2, h / 2, {
      scale: 1,
      crosshair,
      trackProgress: 0,
      hitFlash: showHitmarker || (
        crosshair.hitmarker !== false &&
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

    const res = getResolutionSpec(this.settings.activeSettings());
    let scaleX = 1;
    let scaleY = 1;
    let lw = w;
    let lh = h;
    if (res && res.size) {
      scaleX = w / res.size[0];
      scaleY = h / res.size[1];
      lw = res.size[0];
      lh = res.size[1];
    }

    // Scoped: the crosshair is hidden — draw the scope overlay instead.
    if (this._scopeLevel > 0) {
      ctx.save();
      ctx.scale(scaleX, scaleY);
      this._paintScope(ctx, lw, lh, Math.min(scaleX, scaleY));
      ctx.restore();
      return;
    }

    this._paint(ctx, Math.round(w / 2), Math.round(h / 2), {
      scaleX,
      scaleY,
      dynGap: this._dynGapPx,
      trackProgress: this._trackProgress,
      hitFlash: this.settings.activeSettings().crosshair.hitmarker !== false &&
        performance.now() < this._hitFlashUntil
    });
  }

  /** CS-style scope: black vignette circle + full hairlines that blur when inaccurate. */
  _paintScope(ctx, w, h, lineScale = 1) {
    const s = this.settings.activeSettings();
    const th = Math.max(1, Number(s.sniper?.lineThickness) || 2) * lineScale;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.485;
    const blur = this._scopeBlur || 0;

    // Hairlines first (clipped to the lens), blurred while inaccurate.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    if (blur > 0.25) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    ctx.fillStyle = 'rgba(0,0,0,0.94)';
    ctx.fillRect(cx - th / 2, cy - R, th, R * 2);
    ctx.fillRect(cx - R, cy - th / 2, R * 2, th);
    ctx.restore();

    // Black vignette outside the lens circle.
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(0,0,0,0.97)';
    ctx.fill();

    // Soft rim so the lens edge reads as glass.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, R * 0.012);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.stroke();

    // Hold-to-shoot progress (Sniper Tracking) under the centre.
    if (this._trackProgress > 0) {
      const barW = 64;
      const barH = 3;
      const barY = cy + 26;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(cx - barW / 2, barY, barW, barH);
      ctx.fillStyle = this.settings.activeSettings().crosshair.color || '#f52525';
      ctx.fillRect(cx - barW / 2, barY, barW * this._trackProgress, barH);
    }
  }

  _paint(ctx, cx, cy, { scaleX, scaleY, scale, trackProgress, hitFlash, dynGap = 0, crosshair } = {}) {
    const xh = crosshair ?? this.settings.activeSettings().crosshair;
    const { color, innerGap: rawGap, length: rawLen, thickness: rawThick, dotPercentage } = xh;
    if (scale != null) {
      scaleX = scale;
      scaleY = scale;
    }
    const innerGapX = rawGap * scaleX + dynGap;
    const innerGapY = rawGap * scaleY + dynGap;
    const lengthX = rawLen * scaleX;
    const lengthY = rawLen * scaleY;
    const thickness = Math.max(1, rawThick * Math.min(scaleX, scaleY));
    const outline = outlineThickness(xh);

    if (Math.round(thickness) % 2 === 1) {
      cx -= 0.5;
      cy -= 0.5;
    }

    ctx.lineCap = 'butt';

    const armPath = () => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - innerGapY);
      ctx.lineTo(cx, cy - innerGapY - lengthY);
      ctx.moveTo(cx, cy + innerGapY);
      ctx.lineTo(cx, cy + innerGapY + lengthY);
      ctx.moveTo(cx - innerGapX, cy);
      ctx.lineTo(cx - innerGapX - lengthX, cy);
      ctx.moveTo(cx + innerGapX, cy);
      ctx.lineTo(cx + innerGapX + lengthX, cy);
    };

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = thickness;
    armPath();
    ctx.stroke();

    if (outline > 0) {
      const outlineColor = outlineRgba(xh);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      if (outline === 0.5) {
        ctx.translate(1, 1);
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = Math.max(1, thickness);
        armPath();
        ctx.stroke();
      } else {
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = thickness + outline * 2;
        armPath();
        ctx.stroke();
      }
      ctx.restore();
    }

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
      const dotR = Math.max(0.5, r);
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (outline > 0) {
        const outlineColor = outlineRgba(xh);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        if (outline === 0.5) {
          ctx.translate(1, 1);
          ctx.beginPath();
          ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
          ctx.fillStyle = outlineColor;
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, dotR + outline, 0, Math.PI * 2);
          ctx.fillStyle = outlineColor;
          ctx.fill();
        }
        ctx.restore();
      }
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
