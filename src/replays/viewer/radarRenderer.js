// ---------------------------------------------------------------------------
// replays/viewer/radarRenderer.js
// Draws one moment of a round onto a canvas: the map overview, a droplet per
// player with its view cone, live utility, the bomb, and recent gunfire.
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

export const TEAM_COLORS = {
  1: { base: '#38a3e8', bright: '#7cc7f5', dim: '#1d5b82' },
  2: { base: '#e8913c', bright: '#f5bb7c', dim: '#8a5420' }
};

const SMOKE_SECONDS = 18;
const FIRE_SECONDS = 7;
const FLASH_SECONDS = 2.4;
const HE_SECONDS = 0.6;
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
    this.showTrails = false;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this._pt = { x: 0, y: 0 };
  }

  async setMap(mapCode) {
    if (this.mapCode === mapCode && this.image) return;
    this.mapCode = mapCode;
    try {
      this.image = await loadRadar(mapCode);
    } catch {
      this.image = null;
    }
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

  /** Radar pixels -> canvas pixels, fitting the square map into the box. */
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
   * @param {number} frame.tick           current demo tick
   * @param {number} frame.tickRate
   * @param {Array}  frame.states         10 interpolated player states
   * @param {Array}  frame.players        roster (id, name, team, slot)
   * @param {object} frame.events         round events
   * @param {string} [frame.highlight]    player id to emphasize
   * @param {boolean} [frame.compact]     macro tiles: smaller marks, no names
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
    const { states, players, tick, highlight } = frame;
    const r = (compact ? 3.4 : 7) * this.dpr;

    for (const p of players) {
      const s = states[p.slot];
      if (!s) continue;
      const colors = TEAM_COLORS[p.team] || TEAM_COLORS[1];
      const pt = this.project(t, s.x, s.y);
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;

      if (!s.alive) continue; // death marks are drawn separately, and fade

      const lower = isLowerLevel(this.mapCode, s.z);
      ctx.save();
      ctx.globalAlpha = lower ? 0.45 : 1;

      // View cone. Drawn under the droplet so it reads as direction, not size.
      if (!compact) {
        const spread = (s.flags & FLAG_SCOPED ? 12 : 42) * (Math.PI / 180);
        const len = r * (s.flags & FLAG_SCOPED ? 9 : 5);
        const a = (-s.yaw * Math.PI) / 180; // world yaw is CCW, canvas Y is down
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.arc(pt.x, pt.y, len, a - spread / 2, a + spread / 2);
        ctx.closePath();
        const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, len);
        grad.addColorStop(0, `${colors.base}66`);
        grad.addColorStop(1, `${colors.base}00`);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Droplet.
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colors.base;
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
      ctx.strokeStyle = highlight === p.id ? '#ffffff' : '#0b0d10';
      ctx.stroke();

      // Health ring: the arc shrinks as the player is worn down.
      if (!compact && s.health > 0 && s.health < 100) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 2.5 * this.dpr, -Math.PI / 2, -Math.PI / 2 + (s.health / 100) * Math.PI * 2);
        ctx.strokeStyle = colors.bright;
        ctx.lineWidth = 2 * this.dpr;
        ctx.stroke();
      }

      if (s.flash > 0.4 && !compact) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 4 * this.dpr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.8, s.flash / 3)})`;
        ctx.lineWidth = 2 * this.dpr;
        ctx.stroke();
      }

      if (s.flags & FLAG_HAS_BOMB) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = '#f2d024';
        ctx.fill();
      }
      if (s.flags & FLAG_DEFUSING) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 6 * this.dpr, 0, Math.PI * 2);
        ctx.strokeStyle = '#5ad17a';
        ctx.lineWidth = 2 * this.dpr;
        ctx.stroke();
      }

      if (this.showNames && !compact) {
        const label = p.name || p.id;
        ctx.font = `${11 * this.dpr}px "Host Grotesk", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const y = pt.y - r - 4 * this.dpr;
        const wTxt = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(8,10,13,0.75)';
        ctx.fillRect(pt.x - wTxt / 2 - 3 * this.dpr, y - 12 * this.dpr, wTxt + 6 * this.dpr, 14 * this.dpr);
        ctx.fillStyle = colors.bright;
        ctx.fillText(label, pt.x, y);
      }
      ctx.restore();
    }
    void tick;
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
      // The victim's last position is wherever the tick data froze them.
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
    const { events, tick, tickRate } = frame;
    if (!events?.grenades) return;

    for (const g of events.grenades) {
      const det = g.detonateTick ?? g.throwTick;

      // In flight: a small dot along the recorded trajectory.
      if (tick >= g.throwTick && tick < det) {
        const pos = pointAt(g.path, tick) || g.from;
        if (pos) {
          const pt = this.project(t, pos.x, pos.y, { x: 0, y: 0 });
          ctx.save();
          ctx.fillStyle = '#e6e8ec';
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, (compact ? 1.4 : 2.2) * this.dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        continue;
      }

      if (tick < det || !g.at) continue;
      const age = (tick - det) / tickRate;
      const pt = this.project(t, g.at.x, g.at.y, { x: 0, y: 0 });
      ctx.save();

      if (g.type === 'smokegrenade') {
        if (age > SMOKE_SECONDS) {
          ctx.restore();
          continue;
        }
        const fade = age > SMOKE_SECONDS - 2 ? (SMOKE_SECONDS - age) / 2 : 1;
        const radius = 144 / (this.mapScale() || 5) * t.scale;
        ctx.globalAlpha = 0.5 * fade;
        ctx.fillStyle = '#c9ced8';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else if (g.type === 'molotov' || g.type === 'incgrenade') {
        if (age > FIRE_SECONDS) {
          ctx.restore();
          continue;
        }
        const radius = 130 / (this.mapScale() || 5) * t.scale;
        ctx.globalAlpha = 0.45 * (1 - age / FIRE_SECONDS);
        ctx.fillStyle = '#e2622a';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();
      } else if (g.type === 'flashbang') {
        if (age > FLASH_SECONDS) {
          ctx.restore();
          continue;
        }
        ctx.globalAlpha = 0.8 * (1 - age / FLASH_SECONDS);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 * this.dpr;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (6 + age * 26) * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
      } else if (g.type === 'hegrenade') {
        if (age > HE_SECONDS) {
          ctx.restore();
          continue;
        }
        ctx.globalAlpha = 0.85 * (1 - age / HE_SECONDS);
        ctx.strokeStyle = '#ffb648';
        ctx.lineWidth = 2.5 * this.dpr;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, (5 + age * 60) * this.dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  mapScale() {
    // World units per radar pixel for the active map, used to size smoke and
    // fire in real world radius rather than a fixed pixel blob.
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
      // Pulse so a planted bomb is findable at a glance on a busy map.
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
