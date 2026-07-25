// ---------------------------------------------------------------------------
// replays/viewer/radarRenderer.js
// Draws one moment of a round onto a canvas: the map overview, a droplet per
// player (tip = facing), an HP pill above the name, live utility, the bomb,
// and gunfire.
//
// The renderer is stateless about time. It is handed already-interpolated
// player states for a tick and draws them, so the same code serves the
// timeline viewer, the macro grid, and any future scrubbing UI.
// ---------------------------------------------------------------------------

import { CALIBRATION, RADAR_SIZE, isLowerLevel, worldToRadar } from './mapCalibration.js';
import { radarImage } from '../shared/roundId.js';
import {
  FLAG_DEFUSING,
  FLAG_HAS_BOMB,
  FLAG_SCOPED
} from '../shared/tickFormat.js';
import { isGrenade, isKnife, loadEquipmentIcon, normalizeGrenadeType } from './equipmentIcons.js';

/** Roster team colors (fallback when a tick has no side byte). */
export const TEAM_COLORS = {
  1: { base: '#38a3e8', bright: '#7cc7f5', dim: '#1d5b82' },
  2: { base: '#e8913c', bright: '#f5bb7c', dim: '#8a5420' }
};

/** Live T / CT colors — preferred when the tick buffer carries side. */
export const SIDE_COLORS = {
  T: { base: '#e8b84a', bright: '#f5d27a', dim: '#8a6a20' },
  CT: { base: '#5b9fd4', bright: '#8fc4ef', dim: '#2a5578' }
};

export function colorsForState(state, rosterTeam) {
  if (state?.side === 'T' || state?.side === 'CT') return SIDE_COLORS[state.side];
  return TEAM_COLORS[rosterTeam] || TEAM_COLORS[1];
}

const SMOKE_SECONDS = 18;
const FIRE_SECONDS = 7;
const FLASH_SECONDS = 2.4;
const HE_SECONDS = 0.85;
/** HE punch-through: hole stays open, then smoke fades back in. */
const HE_SMOKE_MASK_HOLD = 1;
const HE_SMOKE_MASK_FADE = 2.5;
/** World-unit radius of the HE smoke clear (≈ CS smoke punch). */
const HE_SMOKE_CLEAR_UNITS = 130;
const SMOKE_RADIUS_UNITS = 144;
const FIRE_RADIUS_UNITS = 120;
const TRACER_SECONDS = 0.25;
const DEATH_MARK_SECONDS = 6;

const imageCache = new Map();

/** Radar images are static assets; one load per map for the whole session. */
export function loadRadar(mapCode) {
  if (imageCache.has(mapCode)) return imageCache.get(mapCode);
  const src = radarImage(mapCode);
  const promise = new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error(`No radar image for map ${mapCode}`));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
  imageCache.set(mapCode, promise);
  return promise;
}

export class RadarRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.mapCode = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.showNames = true;
    this.showWeapons = true;
    this.showTrails = false;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this._pt = { x: 0, y: 0 };
    /** @type {number[]} previous health per slot, for damage flash */
    this._prevHealth = new Array(10).fill(-1);
    /** Demo tick when each slot last took damage (for 5-tick red fade). */
    this._damageTick = new Array(10).fill(-1);
    /** Previous flash remaining, to detect a new blind. */
    this._prevFlash = new Array(10).fill(0);
    /** Optional redraw hook when an equipment SVG finishes loading. */
    this.onIconLoad = null;
    /** Scratch canvas for tinting white equipment SVGs. */
    this._tintCanvas = null;
  }

  async setMap(mapCode) {
    if (this.mapCode === mapCode && this.image) return;
    this.mapCode = mapCode;
    try {
      this.image = await loadRadar(mapCode);
    } catch {
      this.image = null;
    }
    this._prevHealth.fill(-1);
    this._damageTick.fill(-1);
    this._prevFlash.fill(0);
  }

  /** Match the backing store to the element's CSS size. */
  resize() {
    const { canvas } = this;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  /**
   * Radar pixels -> canvas pixels. Default (zoom=1) fits the full square map
   * centered in the panel (letterbox), never cropping edges.
   */
  viewTransform(w, h) {
    const fit = Math.min(w, h) / RADAR_SIZE;
    const scale = fit * this.zoom;
    return {
      scale,
      ox: (w - RADAR_SIZE * scale) / 2 + this.panX * this.dpr,
      oy: (h - RADAR_SIZE * scale) / 2 + this.panY * this.dpr
    };
  }

  project(t, worldX, worldY, out = this._pt) {
    worldToRadar(this.mapCode, worldX, worldY, out);
    out.x = out.x * t.scale + t.ox;
    out.y = out.y * t.scale + t.oy;
    return out;
  }

  /**
   * @param {object} frame
   * @param {number} frame.tick
   * @param {number} frame.tickRate
   * @param {Array}  frame.states
   * @param {Array}  frame.players
   * @param {object} frame.events
   * @param {string[]} [frame.weapons]  weapon dictionary for the round
   * @param {string} [frame.highlight]
   * @param {boolean} [frame.compact]
   */
  render(frame) {
    const { w, h } = this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);

    const t = this.viewTransform(w, h);

    if (this.image) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.image, t.ox, t.oy, RADAR_SIZE * t.scale, RADAR_SIZE * t.scale);
      ctx.restore();
    }

    const compact = Boolean(frame.compact);
    this.drawUtility(ctx, t, frame, compact);
    this.drawBomb(ctx, t, frame, compact);
    this.drawTracers(ctx, t, frame, compact);
    this.drawDeaths(ctx, t, frame, compact);
    this.drawPlayers(ctx, t, frame, compact);
  }

  // ---- players -------------------------------------------------------------

  drawPlayers(ctx, t, frame, compact) {
    const { states, players, highlight, weapons = [], tick = 0 } = frame;
    const r = (compact ? 3.6 : 7.5) * this.dpr;

    for (const p of players) {
      const s = states[p.slot];
      if (!s) continue;
      const colors = colorsForState(s, p.team);
      const pt = this.project(t, s.x, s.y);
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;

      if (!s.alive) {
        this._prevHealth[p.slot] = 0;
        this._prevFlash[p.slot] = 0;
        continue;
      }

      const prev = this._prevHealth[p.slot];
      if (prev >= 0 && s.health < prev) this._damageTick[p.slot] = tick;
      this._prevHealth[p.slot] = s.health;

      const damageAge = this._damageTick[p.slot] < 0 ? 99 : tick - this._damageTick[p.slot];
      const damageFlash = damageAge >= 0 && damageAge < 5 ? 1 - damageAge / 5 : 0;

      const prevFlash = this._prevFlash[p.slot] || 0;
      this._prevFlash[p.slot] = s.flash || 0;
      // Peak white on the tick blindness jumps up; otherwise track remaining blind.
      const flashAmt = Math.max(0, s.flash || 0);
      const flashPeak = flashAmt > prevFlash + 0.05 ? 1 : Math.min(1, flashAmt / 2.5);

      const lower = isLowerLevel(this.mapCode, s.z);
      ctx.save();
      ctx.globalAlpha = lower ? 0.45 : 1;

      // Tip points in facing direction. Local tip is "up"; rotate so up = yaw.
      const yaw = (-s.yaw * Math.PI) / 180;
      ctx.translate(pt.x, pt.y);
      ctx.rotate(yaw + Math.PI / 2);

      const tip = -r * 1.55;
      const bot = r * 1.05;
      const halfW = r * 0.95;
      const hp = Math.max(0, Math.min(100, s.health)) / 100;

      // Solid team droplet — HP lives in the name pill above.
      pathDroplet(ctx, tip, bot, halfW);
      ctx.fillStyle = colors.base;
      ctx.fill();

      if (damageFlash > 0) {
        pathDroplet(ctx, tip, bot, halfW);
        ctx.fillStyle = `rgba(255, 48, 48, ${0.55 * damageFlash})`;
        ctx.fill();
      }

      if (flashPeak > 0.02) {
        pathDroplet(ctx, tip, bot, halfW);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.75 * flashPeak})`;
        ctx.fill();
      }

      pathDroplet(ctx, tip, bot, halfW);
      ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
      ctx.strokeStyle = highlight === p.id ? '#ffffff' : '#0b0d10';
      ctx.stroke();

      // Inner ring (reads like the 2D viewers' concentric droplet).
      ctx.beginPath();
      ctx.arc(0, bot * 0.05, r * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, bot * 0.05, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = colors.base;
      ctx.fill();

      if (s.flags & FLAG_HAS_BOMB) {
        ctx.beginPath();
        ctx.arc(halfW * 0.55, tip + r * 0.35, r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = '#f2d024';
        ctx.fill();
      }

      ctx.restore();

      // Labels / held util in screen space (not rotated with the droplet).
      ctx.save();
      ctx.globalAlpha = lower ? 0.45 : 1;
      if (s.flags & FLAG_DEFUSING && !compact) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 6 * this.dpr, 0, Math.PI * 2);
        ctx.strokeStyle = '#5ad17a';
        ctx.lineWidth = 2 * this.dpr;
        ctx.stroke();
      }
      if (s.flags & FLAG_SCOPED && !compact) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 3 * this.dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `${colors.bright}88`;
        ctx.lineWidth = 1.2 * this.dpr;
        ctx.stroke();
      }

      if (!compact) {
        const rawW = weapons[s.weapon] || '';
        const holdingNade = rawW && isGrenade(rawW);

        if (holdingNade) {
          this.drawHeldGrenadeBadge(ctx, pt.x, pt.y, r, rawW, colors);
        }

        // Stack above the droplet: weapon → name pill → droplet.
        const pillH = 14 * this.dpr;
        const pillBy = pt.y - r * 1.7 - pillH;

        if (this.showWeapons && rawW && !holdingNade && !isKnife(rawW)) {
          const img = loadEquipmentIcon(rawW, () => this.onIconLoad?.());
          if (img?.complete && img.naturalWidth > 0) {
            const maxW = 36 * this.dpr;
            const maxH = 14 * this.dpr;
            const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
            const iw = img.naturalWidth * scale;
            const ih = img.naturalHeight * scale;
            const gap = 3 * this.dpr;
            const wy = pillBy - gap - ih;
            ctx.save();
            ctx.globalAlpha = lower ? 0.45 : 0.95;
            ctx.drawImage(img, pt.x - iw / 2, wy, iw, ih);
            ctx.restore();
          }
        }

        if (this.showNames) {
          const name = p.name || p.id;
          if (name) {
            ctx.font = `600 ${10 * this.dpr}px "Host Grotesk", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const padX = 6 * this.dpr;
            const radius = pillH / 2;
            const textW = ctx.measureText(name).width;
            const pillW = Math.max(textW + padX * 2, pillH * 1.8);
            const bx = pt.x - pillW / 2;
            const by = pillBy;

            roundPill(ctx, bx, by, pillW, pillH, radius);
            ctx.fillStyle = 'rgba(8,10,13,0.88)';
            ctx.fill();

            if (hp > 0) {
              ctx.save();
              roundPill(ctx, bx, by, pillW, pillH, radius);
              ctx.clip();
              ctx.fillStyle = colors.base;
              ctx.fillRect(bx, by, Math.max(this.dpr, pillW * hp), pillH);
              ctx.restore();
            }

            ctx.fillStyle = '#0b0d10';
            ctx.fillText(name, pt.x, by + pillH / 2 + 0.5 * this.dpr);
          }
        }
      }
      ctx.restore();
    }
  }

  /**
   * Grenade SVG on the droplet's top-right: larger, +15° clockwise, team-colored
   * with a 1px black drop-shadow duplicate (no circle chrome).
   */
  drawHeldGrenadeBadge(ctx, x, y, r, weaponName, colors) {
    const img = loadEquipmentIcon(weaponName, () => this.onIconLoad?.());
    if (!img?.complete || img.naturalWidth <= 0) return;
    const size = 16 * this.dpr;
    const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight) * 1.15;
    const iw = img.naturalWidth * scale;
    const ih = img.naturalHeight * scale;
    const cx = x + r * 0.95;
    const cy = y - r * 1.05;
    const rot = (15 * Math.PI) / 180;
    const tint = colors?.base || '#5b9fd4';
    const px = this.dpr;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    // Black outline duplicate, 1px down-right, under the colored icon.
    this.drawTintedIcon(ctx, img, -iw / 2 + px, -ih / 2 + px, iw, ih, '#000000');
    this.drawTintedIcon(ctx, img, -iw / 2, -ih / 2, iw, ih, tint);
    ctx.restore();
  }

  /** Draw a (typically white) SVG icon recolored to `tint`. */
  drawTintedIcon(ctx, img, x, y, w, h, tint) {
    if (!this._tintCanvas) this._tintCanvas = document.createElement('canvas');
    const c = this._tintCanvas;
    const tw = Math.max(1, Math.ceil(w));
    const th = Math.max(1, Math.ceil(h));
    if (c.width !== tw || c.height !== th) {
      c.width = tw;
      c.height = th;
    }
    const tctx = c.getContext('2d');
    tctx.clearRect(0, 0, tw, th);
    tctx.drawImage(img, 0, 0, tw, th);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = tint;
    tctx.fillRect(0, 0, tw, th);
    tctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(c, x, y, w, h);
  }

  // ---- deaths --------------------------------------------------------------

  drawDeaths(ctx, t, frame, compact) {
    const { events, tick, tickRate, states, players } = frame;
    if (!events?.kills) return;
    const window = DEATH_MARK_SECONDS * tickRate;
    const bySlot = new Map(players.map((p) => [p.id, p.slot]));

    for (const k of events.kills) {
      if (k.tick > tick || tick - k.tick > window) continue;
      const slot = bySlot.get(k.victim);
      if (slot === undefined) continue;
      const s = states[slot];
      if (!s) continue;
      const pt = this.project(t, s.x, s.y);
      const age = (tick - k.tick) / window;
      const size = (compact ? 3 : 5) * this.dpr;
      ctx.save();
      ctx.globalAlpha = 0.7 * (1 - age);
      ctx.strokeStyle = '#c8ccd4';
      ctx.lineWidth = Math.max(1, 1.6 * this.dpr);
      ctx.beginPath();
      ctx.moveTo(pt.x - size, pt.y - size);
      ctx.lineTo(pt.x + size, pt.y + size);
      ctx.moveTo(pt.x + size, pt.y - size);
      ctx.lineTo(pt.x - size, pt.y + size);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- shots ---------------------------------------------------------------

  drawTracers(ctx, t, frame, compact) {
    const { events, tick, tickRate } = frame;
    if (!events?.shots || compact) return;
    const window = TRACER_SECONDS * tickRate;
    ctx.save();
    ctx.lineWidth = Math.max(1, 1.2 * this.dpr);
    for (const shot of events.shots) {
      if (shot.tick > tick || tick - shot.tick > window) continue;
      const from = this.project(t, shot.x, shot.y, { x: 0, y: 0 });
      const a = (-shot.yaw * Math.PI) / 180;
      const len = 60 * this.dpr;
      ctx.globalAlpha = 0.5 * (1 - (tick - shot.tick) / window);
      ctx.strokeStyle = '#fff3c4';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(from.x + Math.cos(a) * len, from.y + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- utility -------------------------------------------------------------

  drawUtility(ctx, t, frame, compact) {
    const { events, tick, tickRate, players = [], states = [] } = frame;
    if (!events?.grenades?.length) return;

    const scale = this.mapScale() || 5;
    const worldR = (units) => (units / scale) * t.scale;
    const sideOf = (playerId) => {
      const p = players.find((x) => x.id === playerId);
      if (!p) return '';
      const st = states[p.slot];
      return st?.side || '';
    };

    // Active HE detonations that can punch holes in smokes.
    const heHoles = [];
    for (const g of events.grenades) {
      const type = normalizeGrenadeType(g.type);
      if (type !== 'hegrenade' || !g.at) continue;
      const det = Number(g.detonateTick ?? g.throwTick);
      if (!Number.isFinite(det) || tick < det) continue;
      const age = (tick - det) / tickRate;
      const strength = heSmokeMaskStrength(age);
      if (strength <= 0) continue;
      heHoles.push({
        x: g.at.x,
        y: g.at.y,
        age,
        strength,
        clearR: HE_SMOKE_CLEAR_UNITS * (0.55 + 0.45 * strength)
      });
    }

    for (const g of events.grenades) {
      const type = normalizeGrenadeType(g.type);
      const throwTick = Number(g.throwTick);
      const det = Number(g.detonateTick ?? g.throwTick);
      if (!Number.isFinite(throwTick)) continue;

      // In flight (inclusive end so single-sample throws still render).
      if (tick >= throwTick && tick <= det) {
        const pos = grenadePosAt(g, tick);
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          const pt = this.project(t, pos.x, pos.y, { x: 0, y: 0 });
          this.drawFlyingGrenade(ctx, pt, type, sideOf(g.player), compact);
        }
        // Instant nades still get their detonation VFX below on the same tick.
        if (tick < det) continue;
      }

      if (tick < det || !g.at) continue;
      const age = (tick - det) / tickRate;
      const pt = this.project(t, g.at.x, g.at.y, { x: 0, y: 0 });

      if (type === 'smokegrenade') {
        if (age > SMOKE_SECONDS) continue;
        this.drawSmoke(ctx, t, pt, age, worldR(SMOKE_RADIUS_UNITS), heHoles, g.at, compact);
      } else if (type === 'molotov' || type === 'incgrenade') {
        if (age > FIRE_SECONDS) continue;
        this.drawFire(ctx, pt, age, worldR(FIRE_RADIUS_UNITS), sideOf(g.player), compact);
      } else if (type === 'flashbang') {
        if (age > FLASH_SECONDS) continue;
        ctx.save();
        ctx.globalAlpha = 0.85 * (1 - age / FLASH_SECONDS);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * this.dpr;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (6 + age * 28) * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (type === 'hegrenade') {
        if (age > HE_SECONDS) continue;
        ctx.save();
        const boom = 1 - age / HE_SECONDS;
        ctx.globalAlpha = 0.9 * boom;
        ctx.strokeStyle = '#7dff6a';
        ctx.lineWidth = (2.2 + boom * 1.5) * this.dpr;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (8 + age * 70) * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.22 * boom;
        ctx.fillStyle = '#6dff5a';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, worldR(HE_SMOKE_CLEAR_UNITS) * boom, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (type === 'decoy') {
        if (age > 15) continue;
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = '#e8c84a';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5 * this.dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  drawFlyingGrenade(ctx, pt, type, side, compact) {
    const img = loadEquipmentIcon(type, () => this.onIconLoad?.());
    const size = (compact ? 9 : 14) * this.dpr;
    const tint = side === 'T' ? SIDE_COLORS.T.base : side === 'CT' ? SIDE_COLORS.CT.base : '#e6e8ec';
    ctx.save();
    if (img?.complete && img.naturalWidth > 0) {
      const scale = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      const iw = img.naturalWidth * scale;
      const ih = img.naturalHeight * scale;
      const px = this.dpr;
      this.drawTintedIcon(ctx, img, pt.x - iw / 2 + px, pt.y - ih / 2 + px, iw, ih, '#000000');
      this.drawTintedIcon(ctx, img, pt.x - iw / 2, pt.y - ih / 2, iw, ih, tint);
    } else {
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Smoke disc (pic 3): grey fill, orange remaining-time ring, countdown.
   * Nearby HE detonations punch a hole for 1s, then the smoke fades back.
   */
  drawSmoke(ctx, t, pt, age, radius, heHoles, worldAt, compact) {
    const fade = age > SMOKE_SECONDS - 2 ? (SMOKE_SECONDS - age) / 2 : 1;
    const left = Math.max(0, Math.ceil(SMOKE_SECONDS - age));
    const progress = 1 - age / SMOKE_SECONDS;

    // Holes that overlap this smoke (world space).
    const holes = [];
    for (const h of heHoles) {
      const dx = h.x - worldAt.x;
      const dy = h.y - worldAt.y;
      const dist = Math.hypot(dx, dy);
      if (dist > SMOKE_RADIUS_UNITS + h.clearR) continue;
      const hp = this.project(t, h.x, h.y, { x: 0, y: 0 });
      const hr = ((h.clearR / (this.mapScale() || 5)) * t.scale) * h.strength;
      if (hr > 1) holes.push({ x: hp.x, y: hp.y, r: hr });
    }

    ctx.save();
    ctx.globalAlpha = 0.55 * fade;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    for (const h of holes) {
      ctx.moveTo(h.x + h.r, h.y);
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2, true);
    }
    ctx.fillStyle = 'rgba(160, 168, 180, 0.92)';
    ctx.fill('evenodd');

    // Orange progress ring (remaining life).
    ctx.globalAlpha = 0.95 * fade;
    ctx.strokeStyle = '#e8913c';
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();

    if (!compact) {
      ctx.globalAlpha = 0.75 * fade;
      ctx.fillStyle = 'rgba(210, 216, 224, 0.95)';
      ctx.font = `600 ${Math.max(11, Math.round(radius * 0.28))}px "Host Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(left), pt.x, pt.y + 0.5 * this.dpr);
    }
    ctx.restore();
  }

  /** Molotov / incendiary AOE (pic 4): red disc, team border, flame + timer. */
  drawFire(ctx, pt, age, radius, side, compact) {
    const left = Math.max(0, Math.ceil(FIRE_SECONDS - age));
    const border =
      side === 'T' ? SIDE_COLORS.T.base : side === 'CT' ? SIDE_COLORS.CT.base : '#e2622a';
    const fade = 1 - age / FIRE_SECONDS;

    ctx.save();
    ctx.globalAlpha = 0.38 * fade;
    ctx.fillStyle = '#e24e2c';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.95 * fade;
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (!compact) {
      const img = loadEquipmentIcon(side === 'CT' ? 'incgrenade' : 'molotov', () =>
        this.onIconLoad?.()
      );
      const iconR = Math.min(14 * this.dpr, radius * 0.35);
      if (img?.complete && img.naturalWidth > 0) {
        const scale = Math.min((iconR * 1.6) / img.naturalWidth, (iconR * 1.6) / img.naturalHeight);
        const iw = img.naturalWidth * scale;
        const ih = img.naturalHeight * scale;
        ctx.globalAlpha = 0.95 * fade;
        ctx.drawImage(img, pt.x - iw / 2, pt.y - ih / 2 - 2 * this.dpr, iw, ih);
      } else {
        // Fallback flame blob.
        ctx.globalAlpha = 0.95 * fade;
        ctx.fillStyle = '#ff6a2a';
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y - iconR);
        ctx.quadraticCurveTo(pt.x + iconR, pt.y, pt.x, pt.y + iconR * 0.7);
        ctx.quadraticCurveTo(pt.x - iconR, pt.y, pt.x, pt.y - iconR);
        ctx.fill();
      }
      ctx.globalAlpha = 0.95 * fade;
      ctx.fillStyle = '#1a0c08';
      ctx.font = `700 ${Math.max(10, Math.round(iconR * 0.95))}px "Host Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(left), pt.x, pt.y + 1 * this.dpr);
    }
    ctx.restore();
  }

  mapScale() {
    return CALIBRATION[this.mapCode]?.scale ?? 5;
  }

  // ---- bomb ----------------------------------------------------------------

  drawBomb(ctx, t, frame, compact) {
    const { events, tick } = frame;
    const planted = events?.bomb?.find((b) => b.type === 'planted' && b.tick <= tick);
    if (!planted) return;
    const defused = events.bomb.find((b) => b.type === 'defused' && b.tick <= tick);
    const pt = this.project(t, planted.x, planted.y, { x: 0, y: 0 });
    const r = (compact ? 3 : 5) * this.dpr;
    ctx.save();
    ctx.fillStyle = defused ? '#5ad17a' : '#f2d024';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (!defused) {
      const pulse = 0.5 + 0.5 * Math.sin(tick / 6);
      ctx.globalAlpha = 0.35 + 0.35 * pulse;
      ctx.strokeStyle = '#f2d024';
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r + (3 + pulse * 4) * this.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function roundPill(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Droplet path in local space: tip at `tip` (negative Y), round body toward `bot`. */
function pathDroplet(ctx, tip, bot, halfW) {
  const mid = (tip + bot) * 0.35;
  ctx.beginPath();
  ctx.moveTo(0, tip);
  ctx.bezierCurveTo(halfW * 0.55, tip + (bot - tip) * 0.28, halfW, mid, halfW * 0.92, bot * 0.35);
  ctx.quadraticCurveTo(halfW * 0.75, bot, 0, bot);
  ctx.quadraticCurveTo(-halfW * 0.75, bot, -halfW * 0.92, bot * 0.35);
  ctx.bezierCurveTo(-halfW, mid, -halfW * 0.55, tip + (bot - tip) * 0.28, 0, tip);
  ctx.closePath();
}

/** 1 while the HE hole is fully open, then eases to 0 as smoke returns. */
function heSmokeMaskStrength(ageSeconds) {
  if (ageSeconds < 0) return 0;
  if (ageSeconds <= HE_SMOKE_MASK_HOLD) return 1;
  const t = (ageSeconds - HE_SMOKE_MASK_HOLD) / HE_SMOKE_MASK_FADE;
  if (t >= 1) return 0;
  // Smoothstep ease-out so the smoke "bleeds" back in.
  return 1 - t * t * (3 - 2 * t);
}

/** Position along a recorded grenade path at a tick. */
function pointAt(path, tick) {
  if (!path?.length) return null;
  if (tick <= path[0].tick) return path[0];
  for (let i = 1; i < path.length; i++) {
    if (path[i].tick >= tick) {
      const a = path[i - 1];
      const b = path[i];
      const span = b.tick - a.tick || 1;
      const f = (tick - a.tick) / span;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  return path[path.length - 1];
}

function grenadePosAt(g, tick) {
  const along = pointAt(g.path, tick);
  if (along && Number.isFinite(along.x) && Number.isFinite(along.y)) return along;
  const from = g.from;
  const at = g.at;
  const throwTick = Number(g.throwTick);
  const det = Number(g.detonateTick ?? g.throwTick);
  if (from && at && Number.isFinite(throwTick) && det > throwTick) {
    const f = Math.max(0, Math.min(1, (tick - throwTick) / (det - throwTick)));
    return {
      x: from.x + (at.x - from.x) * f,
      y: from.y + (at.y - from.y) * f,
      z: (from.z ?? 0) + ((at.z ?? 0) - (from.z ?? 0)) * f
    };
  }
  return from || at || null;
}
