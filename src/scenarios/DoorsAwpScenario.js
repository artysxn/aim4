// ---------------------------------------------------------------------------
// DoorsAwpScenario.js  ("Doors (AWP)")
//
// The mid-doors hold on the real Dust2. You stand at T spawn with the AWP,
// boxed into the top-of-mid area, and real CT rounds from the replay library
// play back against you: the AWPer, the B rotation and the B anchor of a pro
// team walk their recorded round — movement, utility, shooting — while the A
// players stay undrawn. One shot decides each round: kill a CT and the point
// is yours, miss and the round is gone. Either way the CTs are deleted, the
// utility is wiped and the next round starts instantly. R restarts you and
// the current round from scratch; J plants a crouching T teammate at your
// feet, K removes them (the map practice mode's dummy, on your side of the
// map). Which rounds arrive is the Settings' choice: a typed team, or three
// full-buy-AWP rounds from the latest Dust2 game of every VRS top-10 team.
// ---------------------------------------------------------------------------

import { BaseScenario, beep } from './BaseScenario.js';
import { buildBotTargetFromSettings } from '../bots/buildBotTarget.js';
import { AgentBotModel } from '../bots/AgentBotModel.js';
import { CSBotModel } from '../bots/CSBotModel.js';
import { sharedAgentModels } from '../agents/agentModels.js';
import { sharedWeaponAssets, weaponNameFor } from '../agents/weaponAssets.js';
import { resolveShot, wasWallbang, GRAZE_DAMAGE, FALLBACK_WEAPONS } from '../weapons/wallbang.js';
import { markBulletDecalSurface } from '../utils/bulletImpact.js';
import { simWorldFor } from '../utils/simWorld.js';
import { DUST2_MAP_DATA } from '../maps/dust2MapData.js';
import { loadMeshMap } from '../maps/meshMap.js';
import { UNIT_M, DEG, cameraYawFromSource } from '../../shared/sim3d/units.js';
import { HULL_HALF_WIDE, HULL_DUCK } from '../../shared/sim3d/constants.js';
import { boxTriangles } from '../../shared/sim3d/hullTrace.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS, resolveModeDuration } from '../core/SettingsManager.js';
import { rankNameKey } from '../replays/shared/vrsRanks.js';
import {
  fetchDemos,
  fetchRoundMeta,
  fetchRoundTicks,
  fetchVrsRanks,
  findRounds
} from '../replays/api.js';
import { selectDoorsRounds, pickDoorsCts } from './doorsRounds.js';
import { RoundTicks, DoorsCtPlayback, sourceToTrainer, botYawFromSource } from './doorsPlayback.js';

// The hold, verbatim from the console:
//   setpos -469.088542 -787.989583 104.119792; setang 22.256583 84.793333 0
const SPAWN_POS = [-469.088542 * UNIT_M, 104.119792 * UNIT_M, 787.989583 * UNIT_M];
const SPAWN_YAW = cameraYawFromSource(84.793333);
const SPAWN_PITCH = -22.256583 * DEG;

// The box the player may move in, Source (-750, -750) to (-100, -250) on the
// ground plane. The spawn itself sits a metre behind its south edge, so that
// edge is pushed out to include it rather than yanking the player off the
// exact spot the mode promises.
const PLAYER_BOUNDS = {
  minX: -750 * UNIT_M,
  maxX: -100 * UNIT_M,
  minZ: 250 * UNIT_M,
  maxZ: Math.max(750 * UNIT_M, SPAWN_POS[2] + 0.05)
};
/**
 * The only slab of dust2 this mode draws, Source x.
 *
 * The hold is fixed and the box is a few metres across, so everything outside
 * this band — A site, long, B site, both spawns, the skybox buildings behind
 * them — is a million triangles nobody in this gamemode can see. They are cut
 * out of the vertex buffer at load (src/maps/meshMap.js `sliceGeometryX`)
 * rather than clipped in the shader, so nothing about them is transformed each
 * frame.
 *
 * COLLISION IS NOT CUT. The hull still covers the whole map: it is a tree, so
 * carrying it costs traversal depth rather than per-frame work, and it is what
 * the player stands on and what a bullet is solved against.
 */
const DRAW_MIN_X = -800;
const DRAW_MAX_X = 400;

/** The teammate's crouched hull, in metres, for the boost and the fall guard. */
const MATE_HEIGHT_M = HULL_DUCK * UNIT_M;

/**
 * Frames drawn with the finished world before the clock starts.
 *
 * Two, not one: the frame that first draws the map is the one that compiles
 * its shader and uploads its buffers, and it is not a frame anybody played.
 */
const READY_FRAMES = 2;

export class DoorsAwpScenario extends BaseScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.infiniteAmmo = true;
    this.weaponBloom = true;
    this.viewmodelRecoil = true;
    this.showViewmodel = true;
    this.weaponTracers = true;

    const preset = this.competitive ? competitivePresetFor('doorsawp') : null;
    const s = {
      ...DEFAULTS.doorsawp,
      ...((this.competitive ? {} : this.settings.data.doorsawp) ?? {})
    };
    this.team = this.competitive ? '' : String(this.config.team ?? s.team ?? '').trim();
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 60)
      : resolveModeDuration(s, this.settings.data.runDuration).value;

    this.mapHandle = null;
    this.mapError = null;
    this.colliders = null;
    this.coverMeshes = [];
    this.floorY = DUST2_MAP_DATA.bounds.minY - 2;

    this._playlist = null;
    this._playlistError = null;
    this._roundIx = 0;
    this._roundGen = 0;
    this._roundLoading = false;
    this._badRounds = 0;
    this._playback = null;
    this._round = null;
    /** file → Promise<ArrayBuffer>; the next round's ticks arrive early. */
    this._ticksCache = new Map();
    this._mate = null;
    /** Scratch for the teammate's collision box; rebuilt per query, not per frame. */
    this._mateTris = [];
    this._shotResult = null;
    /** Frames drawn with the world complete; see `ready`. */
    this._readyFrames = 0;

    // The teammate is T-side, which the shared pack does not carry by default.
    sharedAgentModels().ensureSide?.('T');

    this._onKeyDown = (e) => this._handleKey(e);
    document.addEventListener('keydown', this._onKeyDown);

    void this._loadMap();
    void this._loadPlaylist();
  }

  get name() {
    return 'doorsawp';
  }

  get mapReady() {
    return !!this.mapHandle;
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.doorsawp ?? DEFAULTS.doorsawp;
    const team = rankNameKey(c.team || '').replace(/[^a-z0-9]/g, '').slice(0, 16) || 'top10';
    return `t${team}_d${resolveModeDuration(c, settings.data.runDuration).value}`;
  }

  configKey() {
    return DoorsAwpScenario.configKeyFor(this.settings, this.variant);
  }

  tracerRaycastExtras() {
    return this.coverMeshes.slice();
  }

  applyLiveSettings() {
    super.applyLiveSettings();
    this.mapHandle?.setCoverTint(this.settings.activeSettings?.().colors?.cover
      ?? this.settings.data.colors?.cover);
  }

  // ---- boot -----------------------------------------------------------------

  async _loadMap() {
    try {
      const handle = await loadMeshMap(DUST2_MAP_DATA);
      if (this._disposed) {
        handle.detach();
        return;
      }
      this.mapHandle = handle;
      this.colliders = handle.collider;
      this.floorY = handle.floorY;
      handle.setCoverTint(this.settings.data.colors?.cover);
      const slice = handle.setRenderSliceX(DRAW_MIN_X, DRAW_MAX_X);
      console.log(
        `doors: drawing ${slice.kept.toLocaleString()} of ${slice.total.toLocaleString()} triangles`
        + ` (x ${DRAW_MIN_X}..${DRAW_MAX_X})`
      );
      this.root.add(handle.mesh);
      this.coverMeshes.push(handle.mesh);
      markBulletDecalSurface(handle.mesh);
      const nades = this.engine.nades;
      if (nades) {
        nades.clear();
        nades.refill();
        nades.setWorld(simWorldFor(this.colliders, { floorY: this.floorY, extent: 4096 }));
      }
      // Not gated on `running`: the world exists now, so put the player in it
      // whether the run has been started yet or not. Waiting for the run would
      // leave a started one with no body to move — which is exactly what being
      // unable to move during a load was.
      this._respawnPlayer();
      this._maybeBegin();
    } catch (e) {
      this.mapError = e;
      console.warn('doors: could not load dust2 —', e.message || e);
    }
  }

  async _loadPlaylist() {
    try {
      const api = { fetchVrsRanks, fetchDemos, findRounds, fetchRoundMeta };
      this._playlist = await selectDoorsRounds({ team: this.team, api });
      if (this._disposed) return;
      this._roundIx = 0;
      this._maybeBegin();
    } catch (e) {
      this._playlistError = e;
      console.warn('doors: could not build the round list —', e.message || e);
    }
  }

  onStart() {
    if (!this.mapReady) return;
    // You are a T here; the CTs are the ones crossing. Cosmetic, but the first
    // thing on screen every run is your own hands.
    this.engine.viewmodel?.agent?.setSide?.('T');
    this._respawnPlayer();
    this._maybeBegin();
  }

  /**
   * Arm the next round when there is one to arm.
   *
   * Deliberately NOT gated on `running`: a round is fetched and its bots are
   * placed before the run starts, so the clock does not begin against an empty
   * map while a megabyte of ticks is still on the wire. Nothing moves until
   * `update` runs, and that only happens once the run is going.
   */
  _maybeBegin() {
    if (!this.mapReady) return;
    if (this._playback || this._roundLoading) return;
    if (!this._playlist?.rounds?.length) return;
    void this._beginRound();
  }

  /**
   * Whether the run is allowed to start counting.
   *
   * Everything the first shot needs has to be here: the map in the scene, a
   * round's bots placed, and at least one frame drawn with both — a ported
   * dust2 is 7.5 MB and its first frame compiles shaders over a million
   * triangles, and a clock that started before any of that spent the run on a
   * grey screen. A world that failed outright never becomes ready; the status
   * line says so and the run can be quit rather than burnt.
   */
  get ready() {
    return this.mapReady && this._roundsSettled && this._readyFrames >= READY_FRAMES;
  }

  /** True once the round list has produced whatever it is going to produce. */
  get _roundsSettled() {
    if (this._playlistError) return true;
    if (!this._playlist) return false;
    if (!this._playlist.rounds.length) return true;
    return !!this._playback;
  }

  // ---- the player -----------------------------------------------------------

  _respawnPlayer() {
    this.engine.player.spawn({
      pos: SPAWN_POS,
      yaw: SPAWN_YAW,
      bounds: PLAYER_BOUNDS,
      colliders: this.colliders,
      floorY: this.floorY,
      world: this._playerWorld()
    });
    const input = this.engine.player.input;
    if (input) input.pitch = SPAWN_PITCH;
    this.camera.rotation.x = SPAWN_PITCH;
    this.engine.weapon?.reset();
  }

  /**
   * The map, plus the teammate if one is planted.
   *
   * Rebuilt whenever the teammate appears or goes, and never cached onto the
   * shared map collider — see PlayerController.spawn's `world`. The emitter is
   * the same contract the map explorer's dummies use
   * (src/cs3d/practiceBots.js `emitWalk`): scene-frame triangles, Source units,
   * culled against the query box before any are built.
   */
  _playerWorld() {
    return simWorldFor(this.colliders, {
      floorY: this.floorY,
      movers: this._mate ? { emit: (...a) => this._emitMate(...a) } : null
    });
  }

  /** The teammate's crouched hull as triangles, when the query box reaches it. */
  _emitMate(minX, minY, minZ, maxX, maxY, maxZ, visit) {
    const o = this._mate?.origin;
    if (!o) return;
    const mins = [o.x - HULL_HALF_WIDE, o.y - HULL_HALF_WIDE, o.z];
    const maxs = [o.x + HULL_HALF_WIDE, o.y + HULL_HALF_WIDE, o.z + HULL_DUCK];
    // Source (x, y, z) → the tracer's scene frame (x, z, −y).
    if (maxs[0] < minX || mins[0] > maxX) return;
    if (maxs[2] < minY || mins[2] > maxY) return;
    if (-mins[1] < minZ || -maxs[1] > maxZ) return;
    const tris = this._mateTris;
    tris.length = 0;
    boxTriangles(mins, maxs, tris);
    for (let i = 0; i < tris.length; i += 9) {
      visit(
        tris[i], tris[i + 1], tris[i + 2],
        tris[i + 3], tris[i + 4], tris[i + 5],
        tris[i + 6], tris[i + 7], tris[i + 8]
      );
    }
  }

  // ---- rounds ---------------------------------------------------------------

  _ticksFor(file) {
    let p = this._ticksCache.get(file);
    if (!p) {
      p = fetchRoundTicks(file, 1);
      this._ticksCache.set(file, p);
      p.catch(() => this._ticksCache.delete(file));
      // Rounds cycle fast and a buffer is ~1 MB decoded; keep only a handful.
      if (this._ticksCache.size > 6) {
        const oldest = this._ticksCache.keys().next().value;
        if (oldest !== file) this._ticksCache.delete(oldest);
      }
    }
    return p;
  }

  async _beginRound() {
    const list = this._playlist?.rounds || [];
    const round = list[this._roundIx];
    if (!round) return;
    const gen = ++this._roundGen;
    this._roundLoading = true;
    try {
      const buf = await this._ticksFor(round.file);
      if (gen !== this._roundGen || this._disposed) return;
      const ticks = new RoundTicks(buf);
      const drawn = pickDoorsCts(round.meta, ticks);
      if (!drawn.length) throw new Error('no CTs to draw');
      await this._preloadWeapons(drawn);
      if (gen !== this._roundGen || this._disposed) return;

      const actors = drawn.map((d) => ({ ...d, dead: false, target: this._spawnCt(d, ticks, round.meta) }));
      this._playback = new DoorsCtPlayback({
        root: this.root,
        meta: round.meta,
        ticks,
        actors,
        nades: this.engine.nades,
        audio: this.engine.audio,
        viewmodel: this.engine.viewmodel,
        walls: this.coverMeshes
      });
      this._round = round;
      this._badRounds = 0;

      const next = list[(this._roundIx + 1) % list.length];
      if (next && next !== round) void this._ticksFor(next.file).catch(() => {});
    } catch (e) {
      console.warn(`doors: round ${round.file} unusable —`, e.message || e);
      this._badRounds++;
      if (this._badRounds < list.length) {
        this._roundIx = (this._roundIx + 1) % list.length;
        this._roundLoading = false;
        this._maybeBegin();
        return;
      }
      this._playlistError = e;
    } finally {
      if (gen === this._roundGen) this._roundLoading = false;
    }
  }

  async _preloadWeapons(drawn) {
    const guns = sharedWeaponAssets();
    if (!guns.ready) return; // a cold pack arms later rounds instead of stalling this one
    await Promise.all(drawn.map((d) => guns.model(d.weapon).catch(() => null)));
  }

  _spawnCt(d, ticks, meta) {
    const target = buildBotTargetFromSettings(this.settings, this.variant, {
      colors: this.settings.data.colors,
      bodyPoints: 50,
      headPoints: 100,
      side: 'CT',
      weapon: d.weapon,
      instant: true
    });
    this.addTarget(target);
    const s = ticks.state(ticks.rowFor(meta.freezeEndTick), d.slot);
    const [x, y, z] = sourceToTrainer(s.x, s.y, s.z);
    target.object.position.set(x, y, z);
    target.model.setYaw?.(botYawFromSource(s.yaw));
    return target;
  }

  /** Delete the CT bots and wipe the round's utility. A corpse mid-fall stays. */
  _clearRound() {
    this._roundGen++;
    this._roundLoading = false;
    if (this._playback) {
      for (const a of this._playback.actors) {
        if (a.target.state === 'dying') continue;
        const i = this.targets.indexOf(a.target);
        if (i >= 0) this._removeTargetAt(i);
      }
      this._playback.dispose();
      this._playback = null;
    }
    this._round = null;
    this.engine.nades?.clear();
  }

  _nextRound() {
    const len = this._playlist?.rounds?.length || 0;
    this._clearRound();
    if (!len) return;
    this._roundIx = (this._roundIx + 1) % len;
    this._maybeBegin();
  }

  /** R: you, the round and the box, from scratch. The teammate goes too. */
  _fullReset() {
    this._clearTeammate();
    this._clearRound();
    this._respawnPlayer();
    this._maybeBegin();
  }

  // ---- the teammate (J / K) -------------------------------------------------

  /**
   * Plant a crouching teammate where you stand, then stand on his head.
   *
   * The boost is the point of the key, so it happens in one press rather than
   * two: the body takes the feet you were on, and you are lifted its crouched
   * height, exactly as the map explorer's H does (src/cs3d/practiceBots.js
   * `boostFeet`). Your look is kept — a boost that snapped your view flat
   * would undo the angle you planted it to hold.
   */
  _placeTeammate() {
    this._clearTeammate();
    const player = this.engine.player;
    if (!player?.enabled) return;
    const models = sharedAgentModels();
    const model = models.ready && models.models.T
      ? new AgentBotModel({ models, side: 'T', weapon: sharedWeaponAssets().cloneModel('ak47') })
      : new CSBotModel({ bodyColor: 0x4a86ff, headColor: 0xd9e6ff });
    const feetY = player.footY;
    model.root.position.set(player.pos.x, feetY, player.pos.z);
    model.setYaw?.(player.input.yaw + Math.PI);
    this.root.add(model.root);
    this._mate = {
      model,
      // Source units, the frame the collision emitter works in.
      origin: {
        x: player.pos.x / UNIT_M,
        y: -player.pos.z / UNIT_M,
        z: feetY / UNIT_M
      }
    };

    // Onto his head, keeping the look you had.
    const yaw = player.input.yaw;
    const pitch = player.input.pitch;
    player.spawn({
      pos: [player.pos.x, feetY + MATE_HEIGHT_M, player.pos.z],
      yaw,
      bounds: PLAYER_BOUNDS,
      colliders: this.colliders,
      floorY: this.floorY,
      world: this._playerWorld()
    });
    player.input.pitch = pitch;
    this.camera.rotation.x = pitch;
  }

  _clearTeammate() {
    if (!this._mate) return;
    this._mate.model.root.removeFromParent();
    this._mate.model.dispose();
    this._mate = null;
    // Back to the bare map, or the hull he left behind stays solid under you.
    const player = this.engine.player;
    if (player?.enabled) player.world = this._playerWorld();
  }

  _handleKey(e) {
    if (!this.running || !this.engine.player?.input?.locked) return;
    switch (e.code) {
      case 'KeyJ':
        this._placeTeammate();
        break;
      case 'KeyK':
        this._clearTeammate();
        break;
      case 'KeyR':
        this._fullReset();
        break;
      default:
        break;
    }
  }

  // ---- the frame ------------------------------------------------------------

  /**
   * Hold the run until the world is up.
   *
   * `super.update` is what advances `elapsed`, and `elapsed` is the run clock,
   * the pace bar and the end of the run. Skipping it while the map and the
   * first round are still arriving is what makes the timer start when the mode
   * does. The player still ticks, so a body that already has a world to stand
   * in can look around and settle instead of being frozen mid-air.
   */
  update(dt) {
    if (!this.running) return;
    if (!this.ready) {
      if (this.mapReady && this._roundsSettled) this._readyFrames++;
      this.engine.player?.update(dt);
      return;
    }
    super.update(dt);
  }

  onUpdate(dt) {
    if (!this.mapReady) return;
    if (this._mate) this._mate.model.update(dt, { crouch: 1, onGround: true });
    if (this._playback) {
      const alive = this._playback.update(dt);
      // The round ran out on its own — nobody left to cross, or the demo's
      // round was decided. Not a miss; just the next one.
      if (!alive) this._nextRound();
    }
  }

  // ---- shooting -------------------------------------------------------------

  _bulletWeapon() {
    const name = weaponNameFor(this.weaponId) || 'awp';
    return sharedWeaponAssets().stats?.(name) || FALLBACK_WEAPONS[name] || FALLBACK_WEAPONS.ak47;
  }

  /** Same penetration walk as Deathmatch on a ported map: the tracer's end and
   *  the bullet's verdict are one answer, wallbangs included. */
  _resolveBulletImpact() {
    const world = this.mapHandle?.rayWorld;
    if (!world) return super._resolveBulletImpact();
    const ray = this._shotRaycaster().ray;
    const res = resolveShot({
      origin: ray.origin,
      direction: ray.direction,
      world,
      weapon: this._bulletWeapon(),
      colliders: this.activeColliders()
    });
    this._shotResult = res;
    this._lastImpact.copy(res.end);
    const n = res.hit ? null : res.impacts[res.impacts.length - 1]?.normal;
    if (n) this._lastImpactNormal.set(n.x, n.z, -n.y);
    else this._lastImpactNormal.set(0, 1, 0);
    if (res.hit) return { object: res.hit.object, point: res.end };
    if (res.impacts.length) return { object: this.mapHandle.mesh, point: res.end };
    return null;
  }

  onShoot() {
    const res = this._shotResult;
    this._shotResult = null;
    const playback = this._playback;
    if (!playback || playback.done) return;

    const tgt = res?.hit?.object?.userData?.target;
    const actor = tgt ? playback.actorFor(tgt) : null;
    if (actor && !actor.dead && res.damage >= GRAZE_DAMAGE) {
      this.hits++;
      this.kills++;
      if (res.hit.object.userData.zone === 'head') this.headshots++;
      this.score += res.hit.object.userData.points;
      this.crosshair?.hit();
      beep(1000, 0.05, 'square', 0.05);
      if (wasWallbang(res)) beep(700, 0.04, 'square', 0.04);
      playback.drop(actor);
      tgt.startDying(0x35e06a);
      this._nextRound();
      return;
    }

    // One shot per round: anything that did not take a CT down ends it.
    this.misses++;
    beep(240, 0.07, 'sawtooth', 0.05);
    this._nextRound();
  }

  // ---- HUD ------------------------------------------------------------------

  /** One line for the in-run status element (UIOverlay). */
  statusText() {
    if (this.mapError) return 'dust2 failed to load';
    if (!this.mapReady) return 'loading dust2';
    if (this._playlistError) return 'rounds unavailable';
    if (!this._playlist) {
      return this.team ? `finding ${this.team} rounds` : 'finding VRS top 10 rounds';
    }
    const list = this._playlist.rounds || [];
    if (!list.length) return this._playlist.problem || 'no rounds found';
    if (!this._playback) return 'loading round';
    const round = this._round || list[this._roundIx];
    if (!round) return '';
    const n = `${(this._roundIx % list.length) + 1}/${list.length}`;
    return `${round.teamName} CT vs ${round.opponent} · round ${n}`;
  }

  results() {
    const base = super.results();
    return { ...base, score: Math.round(this.kills) };
  }

  dispose() {
    this._disposed = true;
    document.removeEventListener('keydown', this._onKeyDown);
    this.engine.viewmodel?.agent?.setSide?.('CT');
    this._clearTeammate();
    if (this._playback) {
      this._playback.dispose();
      this._playback = null;
    }
    const nades = this.engine.nades;
    if (nades) {
      nades.clear();
      nades.setWorld(null);
    }
    this._ticksCache.clear();
    this.mapHandle?.detach();
    this.mapHandle = null;
    this.colliders = null;
    this.coverMeshes = [];
    super.dispose();
  }
}
