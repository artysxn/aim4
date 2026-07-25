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

/** The T holding the C4 wears this instead of the side color. */
const BOMB_CARRIER_COLOR = '#e2532b';

const SMOKE_SECONDS = 22;
/** Smoke stays full strength until this age, then fades out by SMOKE_SECONDS. */
const SMOKE_FADE_START = 20;
const FIRE_SECONDS = 7;
const FLASH_SECONDS = 0.8;
const HE_SECONDS = 0.85;
/** Area utility (molotov) holds full strength, then clears in this long. */
const UTIL_FADE_SECONDS = 0.8;
const DECOY_SECONDS = 15;
/** How long a thrown grenade's trajectory lingers after it goes off. */
const TRAIL_FADE_SECONDS = 1.4;
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
    /** CSS-pixel margins the fitted map keeps clear of (chrome overlays). */
    this.viewInset = { top: 0, right: 0, bottom: 0, left: 0 };
    this.showNames = true;
    this.showWeapons = true;
    this.showTrails = false;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this._pt = { x: 0, y: 0 };
    /** @type {number[]} previous health per slot, for damage flash */
    this._prevHealth = new Array(10).fill(-1);
    /** Demo tick when each slot last took damage (for 5-tick red fade). */
    this._damageTick = new Array(10).fill(-1);
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
   * Radar pixels -> canvas pixels. Default (zoom=1) fits the whole square map
   * inside the panel minus `viewInset` (letterbox), never cropping edges. The
   * inset is how the timeline keeps the map clear of the transport bar, which
   * floats over the bottom of the stage.
   */
  viewTransform(w, h) {
    const top = (this.viewInset.top || 0) * this.dpr;
    const right = (this.viewInset.right || 0) * this.dpr;
    const bottom = (this.viewInset.bottom || 0) * this.dpr;
    const left = (this.viewInset.left || 0) * this.dpr;
    const boxW = Math.max(1, w - left - right);
    const boxH = Math.max(1, h - top - bottom);
    const scale = (Math.min(boxW, boxH) / RADAR_SIZE) * this.zoom;
    return {
      scale,
      ox: left + (boxW - RADAR_SIZE * scale) / 2 + this.panX * this.dpr,
      oy: top + (boxH - RADAR_SIZE * scale) / 2 + this.panY * this.dpr
    };
  }

  /**
   * A pointer position -> radar pixels, the inverse of the view transform.
   * Annotation is stored in that space, so this is where a mouse event becomes
   * a point on the map rather than a point on the screen.
   */
  radarFromClient(clientX, clientY, out = {}) {
    const rect = this.canvas.getBoundingClientRect();
    const { w, h } = this.resize();
    const t = this.viewTransform(w, h);
    const cx = rect.width ? ((clientX - rect.left) / rect.width) * w : 0;
    const cy = rect.height ? ((clientY - rect.top) / rect.height) * h : 0;
    out.x = (cx - t.ox) / t.scale;
    out.y = (cy - t.oy) / t.scale;
    /** CSS pixels per radar pixel, so hit tests can be sized in screen terms. */
    out.scale = t.scale / this.dpr;
    return out;
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
    if (frame.drawings?.length) this.drawStrokes(ctx, t, frame.drawings);
  }

  /**
   * Hand-drawn annotation, on top of everything. Points arrive in radar space
   * and are projected here, which is what makes the drawing move with the map
   * when the view is zoomed or panned. Width stays in screen pixels: a line
   * that thickened with the zoom would swallow the map it is pointing at.
   */
  drawStrokes(ctx, t, strokes) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      const pts = stroke?.pts;
      if (!pts?.length) continue;
      const w = (stroke.width || 2.6) * this.dpr;
      const x0 = pts[0].x * t.scale + t.ox;
      const y0 = pts[0].y * t.scale + t.oy;

      if (pts.length === 1) {
        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        ctx.arc(x0, y0, w / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const path = () => {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * t.scale + t.ox, pts[i].y * t.scale + t.oy);
        }
      };
      // Dark backing so a pale pen still reads over a pale part of the radar.
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = 'rgba(6, 8, 11, 0.9)';
      ctx.lineWidth = w + 2 * this.dpr;
      path();
      ctx.stroke();

      ctx.globalAlpha = 1;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = w;
      path();
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- players -------------------------------------------------------------

  drawPlayers(ctx, t, frame, compact) {
    const { states, players, highlight, weapons = [], tick = 0, tickRate = 64 } = frame;
    const r = (compact ? 3.6 : 7.5) * this.dpr;
    const bombCarrier = bombCarrierAt(frame.events, tick);
    const pops = flashPops(frame.events);

    for (const p of players) {
      const s = states[p.slot];
      if (!s) continue;
      const colors = colorsForState(s, p.team);
      const pt = this.project(t, s.x, s.y);
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;

      if (!s.alive) {
        this._prevHealth[p.slot] = 0;
        continue;
      }

      const prev = this._prevHealth[p.slot];
      if (prev >= 0 && s.health < prev) this._damageTick[p.slot] = tick;
      this._prevHealth[p.slot] = s.health;

      const damageAge = this._damageTick[p.slot] < 0 ? 99 : tick - this._damageTick[p.slot];
      const damageFlash = damageAge >= 0 && damageAge < 5 ? 1 - damageAge / 5 : 0;

      const blind = blindnessAt(pops, s, tick, tickRate);

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
      const hasBomb = bombCarrier === p.id || (s.flags & FLAG_HAS_BOMB) !== 0;

      // The marker is a white droplet with a solid dot in the middle: the
      // point shows facing, the dot carries the side color. Canvas shadow
      // offsets ignore the current transform, so the shadow keeps falling
      // straight down however the player is turned.
      if (!compact) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = 3 * this.dpr;
        ctx.shadowOffsetY = 2 * this.dpr;
      }
      pathDroplet(ctx, tip, bot, halfW);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      if (highlight === p.id) {
        pathDroplet(ctx, tip, bot, halfW);
        ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
        ctx.strokeStyle = '#ffd66b';
        ctx.stroke();
      }

      // Inset far enough that the white reads as a rim on every side.
      const dotR = r * 0.72;
      const dotY = bot * 0.1;
      const dot = (fill) => {
        ctx.beginPath();
        ctx.arc(0, dotY, dotR, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
      };

      dot(hasBomb ? BOMB_CARRIER_COLOR : colors.base);
      if (damageFlash > 0) dot(`rgba(255, 48, 48, ${0.75 * damageFlash})`);
      if (blind > 0) dot(`rgba(255, 255, 255, ${0.25 + 0.65 * blind})`);

      ctx.restore();

      // Labels / held util in screen space (not rotated with the droplet).
      ctx.save();
      ctx.globalAlpha = lower ? 0.45 : 1;
      // Blind: the dot washes out and a white halo sits around the marker for
      // as long as the flash has left to run.
      if (blind > 0) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + (compact ? 2 : 4.5) * this.dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.35 + 0.55 * blind})`;
        ctx.lineWidth = (compact ? 1 : 1.8) * this.dpr;
        ctx.stroke();
      }
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

            // The whole pill is the side color and the missing HP is that same
            // color darkened, rather than a near-black gap. The name is dark,
            // so a black remainder made half of it unreadable.
            roundPill(ctx, bx, by, pillW, pillH, radius);
            ctx.fillStyle = colors.base;
            ctx.fill();

            if (hp < 1) {
              ctx.save();
              roundPill(ctx, bx, by, pillW, pillH, radius);
              ctx.clip();
              ctx.fillStyle = 'rgba(10, 12, 15, 0.34)';
              const lost = bx + pillW * hp;
              ctx.fillRect(lost, by, bx + pillW - lost, pillH);
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

  /**
   * Utility is drawn in layers rather than one grenade at a time: area effects
   * (smoke, fire) are big translucent discs and have to sit under the
   * trajectories, which in turn sit under the grenades still in the air.
   */
  drawUtility(ctx, t, frame, compact) {
    const { events, tick, tickRate, players = [], states = [] } = frame;
    if (!events?.grenades?.length) return;

    const scale = this.mapScale() || 5;
    const worldR = (units) => (units / scale) * t.scale;
    // Which side a thrower was on, from the round's fixed roster-to-side map
    // rather than from their tick record. A player's live side byte goes blank
    // once they are dead, which used to repaint their smoke or molotov neutral
    // halfway through burning. The tick record is only a fallback for callers
    // that do not pass the map.
    const teamSides = frame.teamSides || {};
    const sideOf = (playerId) => {
      const p = players.find((x) => x.id === playerId);
      if (!p) return '';
      return teamSides[p.team] || states[p.slot]?.side || '';
    };

    // Everything on screen right now, resolved once.
    const live = [];
    for (const g of events.grenades) {
      // Rounds parsed before grenades were read correctly carry entries whose
      // type is a player name and whose positions are all zero. Drop anything
      // that is not a grenade rather than drawing junk at the map origin.
      if (!isGrenade(g.type)) continue;
      const throwTick = Number(g.throwTick);
      if (!Number.isFinite(throwTick) || tick < throwTick) continue;
      const det = Number(g.detonateTick ?? throwTick);
      const type = normalizeGrenadeType(g.type);
      const age = (tick - det) / tickRate;
      // The icon hands over to the detonation on the exact tick it goes off.
      live.push({ g, type, throwTick, det, age, flying: tick < det, side: sideOf(g.player) });
    }
    if (!live.length) return;

    // Active HE detonations punch holes in any smoke they overlap.
    const heHoles = [];
    for (const it of live) {
      if (it.type !== 'hegrenade' || it.flying || !it.g.at) continue;
      const strength = heSmokeMaskStrength(it.age);
      if (strength <= 0) continue;
      heHoles.push({
        x: it.g.at.x,
        y: it.g.at.y,
        strength,
        clearR: HE_SMOKE_CLEAR_UNITS * (0.55 + 0.45 * strength)
      });
    }

    // ---- layer 1: area effects
    for (const { g, type, age, flying, side } of live) {
      if (flying || !g.at) continue;
      const pt = this.project(t, g.at.x, g.at.y, { x: 0, y: 0 });
      if (type === 'smokegrenade') {
        if (age > SMOKE_SECONDS) continue;
        this.drawSmoke(ctx, t, pt, age, worldR(SMOKE_RADIUS_UNITS), heHoles, g.at, compact);
      } else if (type === 'molotov' || type === 'incgrenade') {
        if (age > FIRE_SECONDS) continue;
        this.drawFire(ctx, pt, age, worldR(FIRE_RADIUS_UNITS), side, compact);
      }
    }

    // ---- layer 2: trajectories
    if (!compact) {
      for (const it of live) {
        if (it.age > TRAIL_FADE_SECONDS) continue;
        this.drawTrajectory(ctx, t, it, tick);
      }
    }

    // ---- layer 3: detonation bursts
    for (const { g, type, age, flying } of live) {
      if (flying || !g.at) continue;
      const pt = this.project(t, g.at.x, g.at.y, { x: 0, y: 0 });
      if (type === 'flashbang') {
        if (age > FLASH_SECONDS) continue;
        this.drawFlashPop(ctx, pt, age);
      } else if (type === 'hegrenade') {
        if (age > HE_SECONDS) continue;
        const boom = 1 - age / HE_SECONDS;
        ctx.save();
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
        if (age > DECOY_SECONDS) continue;
        this.drawDecoy(ctx, pt, age, compact);
      }
    }

    // ---- layer 4: grenades still in the air
    for (const { g, type, flying, side } of live) {
      if (!flying) continue;
      const pos = grenadePosAt(g, tick);
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      const pt = this.project(t, pos.x, pos.y, { x: 0, y: 0 });
      this.drawFlyingGrenade(ctx, pt, type, side, compact);
    }
  }

  /**
   * The flight path, drawn as far as the grenade has actually travelled and
   * held for a moment after it lands. Recorded trajectories bounce off walls;
   * a grenade rebuilt from throw + detonation alone is a straight line, which
   * is the best that can be said about it.
   */
  drawTrajectory(ctx, t, { g, side, det, age }, tick) {
    const pts = trailPoints(g, Math.min(tick, det));
    if (pts.length < 2) return;

    const fade = age <= 0 ? 1 : Math.max(0, 1 - age / TRAIL_FADE_SECONDS);
    const colors = side === 'T' ? SIDE_COLORS.T : side === 'CT' ? SIDE_COLORS.CT : null;
    const tint = colors ? colors.bright : '#d8dce4';

    const path = () => {
      ctx.beginPath();
      const p0 = this.project(t, pts[0].x, pts[0].y, { x: 0, y: 0 });
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = this.project(t, pts[i].x, pts[i].y, { x: 0, y: 0 });
        ctx.lineTo(p.x, p.y);
      }
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Dark underlay so the dashes read over pale parts of the radar.
    ctx.globalAlpha = 0.5 * fade;
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(6, 8, 11, 0.9)';
    ctx.lineWidth = 3.4 * this.dpr;
    path();
    ctx.stroke();

    ctx.globalAlpha = 0.9 * fade;
    ctx.strokeStyle = tint;
    ctx.lineWidth = 1.7 * this.dpr;
    ctx.setLineDash([5 * this.dpr, 4 * this.dpr]);
    path();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Flashbang pop: a hot core at full size almost immediately, then a ring
   * that races outward and is gone. Both use an ease-out on the radius and a
   * squared falloff on alpha, so the whole thing reads as a snap rather than a
   * bloom.
   */
  drawFlashPop(ctx, pt, age) {
    const life = Math.min(1, age / FLASH_SECONDS);
    const ease = 1 - (1 - life) * (1 - life) * (1 - life);
    const burst = Math.max(0, 1 - age / 0.18);

    ctx.save();
    if (burst > 0) {
      const r = (10 + (1 - burst) * 16) * this.dpr;
      const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
      grad.addColorStop(0, `rgba(255, 255, 255, ${burst})`);
      grad.addColorStop(0.5, `rgba(255, 252, 226, ${0.75 * burst})`);
      grad.addColorStop(1, 'rgba(255, 250, 210, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const out = 1 - life;
    ctx.globalAlpha = 0.9 * out * out;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1 * this.dpr, (3.2 - 2.4 * ease) * this.dpr);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, (5 + ease * 30) * this.dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Decoy: a dashed ring that ticks down, so it is not mistaken for a smoke. */
  drawDecoy(ctx, pt, age, compact) {
    const left = Math.max(0, Math.ceil(DECOY_SECONDS - age));
    const fade = age > DECOY_SECONDS - 2 ? (DECOY_SECONDS - age) / 2 : 1;
    const r = (compact ? 5 : 11) * this.dpr;
    ctx.save();
    ctx.globalAlpha = 0.85 * fade;
    ctx.strokeStyle = '#e8c84a';
    ctx.lineWidth = 1.6 * this.dpr;
    ctx.setLineDash([3 * this.dpr, 3 * this.dpr]);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!compact) {
      ctx.fillStyle = '#e8c84a';
      ctx.font = `600 ${9 * this.dpr}px "Host Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(left), pt.x, pt.y);
    }
    ctx.restore();
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
    const fade = smokeFade(age);
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
    // Clip to the smoke disc so evenodd holes can't paint outside it.
    // (Without this, the HE circle's exterior is filled as an odd region.)
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.globalAlpha = 0.55 * fade;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    for (const h of holes) {
      ctx.moveTo(h.x + h.r, h.y);
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2, true);
    }
    ctx.fillStyle = 'rgba(160, 168, 180, 0.92)';
    ctx.fill('evenodd');
    ctx.restore();

    // Orange progress ring (remaining life) — drawn unclipped.
    ctx.save();
    ctx.globalAlpha = 0.95 * fade;
    ctx.strokeStyle = '#e8913c';
    ctx.lineWidth = Math.max(0.75, 1 * this.dpr);
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

  /**
   * Molotov / incendiary AOE, built like the smoke disc: red fill, a ring that
   * unwinds with the time left, and a bright countdown. The flame icon sits
   * above the number so the two do not sit on top of each other.
   */
  drawFire(ctx, pt, age, radius, side, compact) {
    const left = Math.max(0, Math.ceil(FIRE_SECONDS - age));
    const progress = Math.max(0, 1 - age / FIRE_SECONDS);
    const border =
      side === 'T' ? SIDE_COLORS.T.base : side === 'CT' ? SIDE_COLORS.CT.base : '#e2622a';
    const fade = utilFade(age, FIRE_SECONDS);

    ctx.save();
    ctx.globalAlpha = 0.4 * fade;
    ctx.fillStyle = '#e24e2c';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.95 * fade;
    ctx.strokeStyle = border;
    ctx.lineWidth = Math.max(0.75, 1 * this.dpr);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();

    if (!compact) {
      const img = loadEquipmentIcon(side === 'CT' ? 'incgrenade' : 'molotov', () =>
        this.onIconLoad?.()
      );
      const iconR = Math.min(11 * this.dpr, radius * 0.3);
      const iconY = pt.y - radius * 0.3;
      ctx.globalAlpha = 0.95 * fade;
      if (img?.complete && img.naturalWidth > 0) {
        const scale = Math.min((iconR * 1.7) / img.naturalWidth, (iconR * 1.7) / img.naturalHeight);
        const iw = img.naturalWidth * scale;
        const ih = img.naturalHeight * scale;
        ctx.drawImage(img, pt.x - iw / 2, iconY - ih / 2, iw, ih);
      } else {
        // Fallback flame blob.
        ctx.fillStyle = '#ff6a2a';
        ctx.beginPath();
        ctx.moveTo(pt.x, iconY - iconR);
        ctx.quadraticCurveTo(pt.x + iconR, iconY, pt.x, iconY + iconR * 0.7);
        ctx.quadraticCurveTo(pt.x - iconR, iconY, pt.x, iconY - iconR);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255, 236, 224, 0.95)';
      ctx.font = `600 ${Math.max(11, Math.round(radius * 0.28))}px "Host Grotesk", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(left), pt.x, pt.y + radius * 0.26);
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

/**
 * Which player is holding the C4 at this tick, by player id.
 *
 * The per-tick bomb flag is inferred from the active weapon, so it only fires
 * in the second a player actually pulls the bomb out. The pickup/drop chain is
 * the real answer. Rounds parsed before those events were stored have no
 * chain, and fall back to the flag at the call site.
 */
function bombCarrierAt(events, tick) {
  let latest = null;
  for (const b of events?.bomb || []) {
    if (b.tick > tick) continue;
    if (b.type !== 'pickup' && b.type !== 'dropped' && b.type !== 'planted') continue;
    if (!latest || b.tick >= latest.tick) latest = b;
  }
  return latest?.type === 'pickup' ? latest.player || '' : '';
}

function flashPops(events) {
  const out = [];
  for (const g of events?.grenades || []) {
    if (normalizeGrenadeType(g.type) !== 'flashbang') continue;
    const det = Number(g.detonateTick ?? g.throwTick);
    if (Number.isFinite(det)) out.push(det);
  }
  return out;
}

/**
 * How blind a player is right now, 1 (just flashed) to 0 (clear).
 *
 * `flash_duration` is the *total* length of the blind, fixed at the moment the
 * flash goes off — it does not count down. So the remaining time is that total
 * minus however long ago the flash actually popped, which is the most recent
 * flashbang detonation that is still inside the player's window. Deriving it
 * from the tick rather than from the previous frame is what makes it survive
 * scrubbing and jumping between rounds.
 */
function blindnessAt(pops, state, tick, tickRate) {
  const total = Math.max(0, state?.flash || 0);
  if (total <= 0 || !pops.length) return 0;
  const window = total * tickRate;
  let popped = -1;
  for (const det of pops) {
    if (det > tick || tick - det >= window) continue;
    if (det > popped) popped = det;
  }
  if (popped < 0) return 0;
  return Math.max(0, Math.min(1, 1 - (tick - popped) / window));
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

/**
 * Full strength for the whole life of a fire, then out in UTIL_FADE_SECONDS.
 * Dimming from the moment it lands made a burning molotov look half spent.
 */
function utilFade(age, life) {
  const left = life - age;
  if (left >= UTIL_FADE_SECONDS) return 1;
  return Math.max(0, left / UTIL_FADE_SECONDS);
}

/** Smoke: opaque until SMOKE_FADE_START, then linear out by SMOKE_SECONDS. */
function smokeFade(age) {
  if (age >= SMOKE_SECONDS) return 0;
  if (age <= SMOKE_FADE_START) return 1;
  return (SMOKE_SECONDS - age) / (SMOKE_SECONDS - SMOKE_FADE_START);
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

/**
 * The part of a flight that has already happened, ending at exactly where the
 * grenade is now so the line grows out of the thrower rather than popping in
 * whole. Falls back to throw -> landing when the parse carried no samples.
 */
function trailPoints(g, tick) {
  const path = g.path;
  if (path?.length) {
    const out = [];
    for (const p of path) {
      if (p.tick > tick) break;
      out.push(p);
    }
    const head = pointAt(path, tick);
    const last = out[out.length - 1];
    if (head && (!last || last.x !== head.x || last.y !== head.y)) out.push(head);
    return out;
  }
  const from = g.from;
  const at = grenadePosAt(g, tick);
  if (!from || !at) return [];
  return [from, at];
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
