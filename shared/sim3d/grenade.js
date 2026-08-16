// ---------------------------------------------------------------------------
// shared/sim3d/grenade.js
// Grenade flight: ballistics under scaled gravity, bounces against the world,
// fuse timers per type. Source frame, f32, same trace interface as motion.js.
//
// What makes grenades the cleanest system to get exact WITHOUT the game
// installed: unlike the player, a grenade in flight has no inputs. Release
// state fully determines the path, and every demo records the whole path
// (GrenadeEvent.path) plus throw and detonate ticks — a dense witness for
// every constant in this file. The oracle fits gravity from pre-bounce arcs
// (and checks the horizontal component stays linear: a drag term would bend
// it), fuse times from detonate−throw histograms, and — later — elasticity
// from bounce-to-bounce speed ratios once the BVH world can find the wall.
//
// The throw itself (eye offset, pitch remap, base speed, how much of the
// thrower's velocity the grenade inherits — the jumpthrow question) is a
// separate model, fitted by the oracle from path[0] against the thrower's
// tick state. It lands here as THROW constants once fitted; until then the
// sim only flies grenades from a known release state.
// ---------------------------------------------------------------------------

import { fr, fmul, v3, v3set, v3copy, v3dot, v3mulAdd, v3len } from './fp.js';
import { GRAVITY, TICK_DT } from './constants.js';

/**
 * [fitted → oracle] Grenades fall under a fraction of sv_gravity. CSGO lineage
 * says 0.4; the oracle measures the CS2 value from every recorded arc.
 */
export const GRENADE_GRAVITY_SCALE = fr(0.4);

/** [guessed] Bounce: velocity kept along the surface / restituted off it. */
export const GRENADE_ELASTICITY = fr(0.45);

/** Grenades trace as a point in Source (the hull is negligible). */
export const GRENADE_RADIUS = fr(2);

/** Below this speed after a bounce on walkable ground, the grenade rests. */
export const REST_SPEED = fr(20);

/**
 * Fuse seconds per type, throw → detonate.
 *
 * [measured] he and flashbang: 1.625s (104 ticks) with ZERO spread across
 * 56k throws in the corpus — the two hard-fused types. The rest are
 * event-fused and carry their corpus distribution as bounds instead:
 * smoke pops on rest (median 3.0s, long tail), molotov/incendiary on
 * impact (median ~1.5–1.6s, p90 2.0s — the 2s airtime cap is visible),
 * decoy expires long after landing.
 */
export const FUSE = {
  he: 104 / 64,
  flashbang: 104 / 64,
  smoke: null,
  molotov: null,
  incendiary: null,
  decoy: null
};

export function createGrenade(pos, vel) {
  return {
    pos: v3(pos.x, pos.y, pos.z),
    vel: v3(vel.x, vel.y, vel.z),
    resting: false,
    bounces: 0
  };
}

const _end = v3();
const _g = v3();

/**
 * One tick of flight. Gravity is applied leapfrog like the player's — half
 * before the move, half after — so a pure arc integrates identically to the
 * player's airborne tick and the oracle can share its parabola math.
 */
export function stepGrenade(g, world, dt = TICK_DT) {
  if (g.resting) return g;
  const grav = fmul(GRAVITY, GRENADE_GRAVITY_SCALE);

  g.vel.z = fr(g.vel.z - fmul(grav, fmul(0.5, dt)));
  v3mulAdd(_end, g.pos, g.vel, dt);
  const t = world.traceHull(g.pos, _end, GRENADE_RADIUS, GRENADE_RADIUS);
  v3copy(g.pos, t.endpos);

  if (t.fraction < 1 && t.normal) {
    bounce(g, t.normal);
  }

  g.vel.z = fr(g.vel.z - fmul(grav, fmul(0.5, dt)));
  return g;
}

/**
 * Reflect off the plane, damped by elasticity; slow bounces on walkable
 * ground become rest. The exact Source bounce (separate surface friction and
 * restitution, spin ignored) is [guessed] until the oracle can see bounces —
 * that needs the BVH world to know where the wall was.
 */
function bounce(g, normal) {
  const into = v3dot(g.vel, normal);
  if (into < 0) {
    const k = fmul(fr(1 + GRENADE_ELASTICITY), into);
    g.vel.x = fr(g.vel.x - fmul(normal.x, k));
    g.vel.y = fr(g.vel.y - fmul(normal.y, k));
    g.vel.z = fr(g.vel.z - fmul(normal.z, k));
    g.vel.x = fmul(g.vel.x, GRENADE_ELASTICITY);
    g.vel.y = fmul(g.vel.y, GRENADE_ELASTICITY);
    g.vel.z = fmul(g.vel.z, GRENADE_ELASTICITY);
  }
  g.bounces += 1;
  if (normal.z >= 0.7 && v3len(g.vel) < REST_SPEED) {
    v3set(g.vel, 0, 0, 0);
    g.resting = true;
  }
}
