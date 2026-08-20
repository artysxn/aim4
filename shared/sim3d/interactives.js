// ---------------------------------------------------------------------------
// shared/sim3d/interactives.js
// Doors that swing and props that break. Headless, like the rest of
// shared/sim3d: no three.js, no DOM, so the same state machine runs in the
// renderer and in a Node test.
//
// The data comes from scripts/cs3d-interactives.mjs, which reads it out of the
// map's entity lump and the prop models rather than fitting anything. See
// CS3D-INTERACTIVES-PLAN.md; the two facts that shape this file are:
//
//   A door is specified, not guessed. `distance` degrees of swing at `speed`
//   degrees a second, both per-door, both from the lump. A Nuke door is 89 at
//   200, so it takes 0.445 s, and nothing here invents a constant.
//
//   Fire is not a damage type. `scripts/propdata.vdata` defines exactly three
//   (`bullets`, `club`, `explosive`) and the string `dmg.fire` occurs nowhere
//   in it. That is the whole reason a molotov burning on a Nuke vent does
//   nothing while an HE breaks it instantly — verified in game — and it is why
//   `applyDamage` has no fire case rather than a fire case that multiplies by
//   zero.
//
// A door is BOTH things. Its model carries prop_data like any breakable —
// `metal_door_001_br` names `Door.Standard` and a break piece worth 100 hit
// points — so an HE destroys a Nuke door rather than swinging it. What a door
// does not take is bullets: those shove it instead, which is the mechanic that
// lets a shut doorway be creeped open with rifle fire (see nudgeDoor).
// ---------------------------------------------------------------------------

/** Damage types a prop can take. Fire is deliberately absent; see the header. */
export const DAMAGE_TYPES = Object.freeze(['bullets', 'club', 'explosive']);

/**
 * [docs] How far an HE has to be to stop mattering, as a fraction of its blast
 * radius, and how the damage falls off across it. Source's blast falls off
 * linearly to zero at the radius; the grenade's own radius comes from
 * weapons.vdata (`m_flRange` = 350 on the hegrenade).
 */
export function blastFalloff(distance, radius) {
  if (!(radius > 0)) return 0;
  const t = 1 - distance / radius;
  return t > 0 ? t : 0;
}

/**
 * Door state. `closed` and `open` are rest states; `opening` and `closing` are
 * the swing, and `frac` runs 0..1 across it.
 */
export const DOOR = Object.freeze({ CLOSED: 'closed', OPENING: 'opening', OPEN: 'open', CLOSING: 'closing' });

/**
 * @param {object} row  one entry from interactives.json
 */
export function createInteractive(row) {
  const o = {
    id: row.id,
    role: row.role,
    class: row.class,
    name: row.name || '',
    origin: row.origin ? [...row.origin] : [0, 0, 0],
    angles: row.angles ? [...row.angles] : [0, 0, 0],
    model: row.model || '',
    /** Set by link(): the other door that moves with this one. */
    linked: null,
    /**
     * The box the split script measured around this thing's drawn geometry,
     * relative to the entity origin and already in world axes at the closed
     * pose — so a door needs no extra yaw applied, only its swing.
     * `{min:[x,y,z], max:[x,y,z]}` in Source units, or null before the pack
     * has been split (scripts/cs3d-split-interactives.mjs).
     */
    bounds: row.bounds || null,
    /** The collision hull the map already had for it, when there is one. */
    phys: row.phys || null,
    /**
     * Half-open triangle range in the map's merged collision mesh, filled in
     * by the renderer once it has matched this to a hull. Breaking the thing
     * is then a fill over that range of `collider.mask`.
     */
    tris: null
  };
  // A door is breakable as well as movable, so it carries both blocks. Its
  // model says so: `metal_door_001_br` has prop_data with `base =
  // "Door.Standard"` and a break piece worth 100 hit points.
  if (row.role === 'door' || row.role === 'breakable') {
    const b = row.break || {};
    o.health = Number.isFinite(b.health) && b.health > 0 ? b.health : row.role === 'door' ? 0 : 1;
    o.maxHealth = o.health;
    o.mult = { bullets: 1, club: 1, explosive: 1, ...(b.mult || {}) };
    o.pieces = b.pieces || [];
    o.broken = false;
    /** The tick it broke, for gib timing. Null until it does. */
    o.brokenAt = null;
  }
  if (row.role === 'door') {
    const d = row.door || {};
    o.door = {
      distance: Number.isFinite(d.distance) ? d.distance : 90,
      speed: Number.isFinite(d.speed) ? d.speed : 100,
      openDir: d.openDir || 0,
      forceClosed: !!d.forceClosed,
      slave: d.slave || '',
      /** +1 / −1, picked when the door starts opening. Both-ways uses the player. */
      swingDir: d.openDir === 1 ? -1 : 1
    };
    o.state = DOOR.CLOSED;
    /** 0 at closed, 1 at fully open. */
    o.frac = 0;
    /**
     * Whether the packed geometry was measured with this leaf OPEN, which is
     * how a Source map stores a door. See poseAngle.
     */
    o.bakedOpen = row.bakedOpen !== false;
    o.sounds = row.sounds || null;
  } else if (row.role === 'prop' || row.role === 'inert') {
    o.health = 0;
    o.mult = {};
    o.pieces = [];
    o.broken = false;
    o.brokenAt = null;
  }
  return o;
}

/**
 * Wire up master/slave doors so they swing together.
 *
 * The lump only records the link one way — `door_02` names `door_01` as its
 * slave — so this resolves it in both directions. Without it a double door
 * opens one leaf.
 */
export function linkDoors(list) {
  const byName = new Map();
  for (const o of list) if (o.name) byName.set(o.name, o);
  for (const o of list) {
    if (o.role !== 'door' || !o.door.slave) continue;
    const other = byName.get(o.door.slave);
    if (!other || other === o) continue;
    o.linked = other;
    other.linked = o;
  }
  return list;
}

/** How far this door has swung from SHUT, in degrees. */
export function doorAngle(o) {
  if (o.role !== 'door') return 0;
  return o.frac * o.door.distance * (o.door.swingDir || 1);
}

/**
 * How far the GEOMETRY has to be turned, in degrees.
 *
 * Not the same thing as `doorAngle`, and the difference is the whole reason a
 * freshly loaded map had every door standing open. The split
 * (scripts/cs3d-split-interactives.mjs) measured each leaf exactly where the
 * map has it standing, and a Source map stores its doors OPEN — so the baked
 * vertices are the fully-open pose, not the shut one, and turning them by
 * `doorAngle` leaves a shut door drawn wide open.
 *
 * So the pose runs BACKWARDS from the baked one: `frac = 1` (open) turns the
 * geometry by nothing, and `frac = 0` (shut) turns it the full swing into the
 * doorway. Everything drawn AND everything collided goes through here, so the
 * two cannot drift apart.
 *
 * The sign is the part that has to be right rather than merely consistent.
 * Getting it backwards still lands a shut door 89 degrees off the baked pose,
 * but on the wrong side — swung out past open and flat against the wall, which
 * looks like neither state and is 178 degrees from where it belongs.
 */
export function poseAngle(o) {
  if (o.role !== 'door') return 0;
  if (o.bakedOpen === false) return doorAngle(o);
  const bakeDir = o.door.openDir === 1 ? -1 : 1;
  return o.door.distance * bakeDir - doorAngle(o);
}

/**
 * How long a full swing takes, seconds. Straight from the lump: 89 degrees at
 * 200 degrees a second is 0.445 s.
 */
export function doorSwingSeconds(o) {
  const d = o.door;
  return d.speed > 0 ? Math.abs(d.distance) / d.speed : 0;
}

/**
 * Start a door opening. Returns false when it is already open or moving, so a
 * caller can tell a no-op from a real use.
 *
 * `spread` stops a slave door recursing back into its master.
 */
/**
 * Which way a both-ways door should swing so the leaf moves away from `from`.
 *
 * `prop_door_rotating` `opendir` 0 is "both directions": the activator's side
 * of the closed leaf picks the sign. 1 is forward only, 2 is back only.
 */
export function swingDirFromPlayer(o, from) {
  if (!from || !o.bounds) return o.door.swingDir || 1;
  const c = boxCorners(o);
  if (!c) return o.door.swingDir || 1;
  let lx = 0;
  let ly = 0;
  for (let i = 0; i < 8; i++) {
    lx += c[i * 3];
    ly += c[i * 3 + 1];
  }
  lx = lx / 8 - o.origin[0];
  ly = ly / 8 - o.origin[1];
  const px = from.x - o.origin[0];
  const py = from.y - o.origin[1];
  // Leaf × player in XY. Positive means the player is on the CCW side of the
  // leaf, so opening CCW would swing into them — go the other way.
  return lx * py - ly * px > 0 ? -1 : 1;
}

function pickSwingDir(o, from) {
  const d = o.door;
  if (d.openDir === 1) d.swingDir = -1;
  else if (d.openDir === 2) d.swingDir = 1;
  else if (from) d.swingDir = swingDirFromPlayer(o, from);
}

export function openDoor(o, spread = true, from = null) {
  if (o.role !== 'door' || o.broken) return false;
  if (o.state === DOOR.OPEN || o.state === DOOR.OPENING) return false;
  if (o.state === DOOR.CLOSED) pickSwingDir(o, from);
  o.state = DOOR.OPENING;
  if (spread && o.linked) openDoor(o.linked, false, from);
  return true;
}

export function closeDoor(o, spread = true) {
  if (o.role !== 'door' || o.broken) return false;
  if (o.state === DOOR.CLOSED || o.state === DOOR.CLOSING) return false;
  o.state = DOOR.CLOSING;
  if (spread && o.linked) closeDoor(o.linked, false);
  return true;
}

// ---------------------------------------------------------------------------
// Shooting a door out.
//
// Bullets do not swing a door and they do not delete it: they CARVE it. Rounds
// into one spot open a hole that grows with the damage put through it, until
// the leaf is a frame you can see and shoot through but never an empty doorway
// — the border always survives, however long you keep firing.
//
// It happens in STAGES, not smoothly, and the thresholds below are [measured]
// — counted in game across six weapons whose damage spans 35 to 234 a shot:
//
//   weapon    per shot        to stage 1   predicted   counted
//   p2000     35 x 1  =  35        420/35 = 12.00        12
//   AK-47     36 x 1  =  36        420/36 = 11.67        12
//   M4A1      33 x 1  =  33        420/33 = 12.73        13
//   Deagle    53 x 1  =  53        420/53 =  7.92         8
//   AWP      115 x 1  = 115        420/115=  3.65         4
//   Nova      26 x 9  = 234        420/234=  1.79         2
//
// Six weapons, six exact hits, including the two that round the wrong way if
// the threshold is moved by 20 either direction. Stage 2 and stage 3 then cost
// 210 each: 6 more rounds from the p2000 (210/35 = 6) and the AK (210/36 =
// 5.83), and 4 more from the Deagle (210/53 = 3.96) — half of its 8, which is
// exactly what was counted.
//
// PENETRATION DOES NOT COME INTO IT. It looks like it should — the AWP is 2.5
// and the p2000 is 1 — but plain damage explains all six counts on its own, and
// nothing is left over for penetration to explain. Pellet count DOES: a shotgun
// is two shots because its nine pellets are 234 damage a trigger pull.
//
// What is still [guessed] is only the SHAPE: that the hole is round, where each
// stage's radius sits, and that it stops short of the edges. Those are a
// reading of the damage in game, not a number out of a file.
// ---------------------------------------------------------------------------

/**
 * [measured] Cumulative bullet damage at which each stage of the hole opens.
 * See the counts above.
 */
export const DOOR_HOLE_STAGES = Object.freeze([420, 630, 840]);

/**
 * [guessed] Each stage's hole, as a fraction of the biggest one. The last is
 * the whole thing by definition.
 */
export const DOOR_STAGE_RADIUS = Object.freeze([0.35, 0.65, 1]);

/**
 * [guessed] How much of the leaf's half-width the biggest hole eats.
 *
 * Below 1 by design and that is the whole point of the number: at 0.82 a
 * 60-wide door keeps a border of about five units all the way round, so a door
 * shot to pieces is a hole in a frame rather than a missing door.
 */
export const DOOR_HOLE_MAX = 0.82;

/** Which stage of hole this door is at: 0 (intact) to 3 (shot right through). */
export function holeStage(o) {
  if (o.role !== 'door' || !o.hole) return 0;
  let stage = 0;
  for (let i = 0; i < DOOR_HOLE_STAGES.length; i++) if (o.hole.damage >= DOOR_HOLE_STAGES[i]) stage = i + 1;
  return stage;
}

/** How far the hole has opened, in units. Zero until the first stage lands. */
export function holeRadius(o) {
  const stage = holeStage(o);
  if (!stage || !o.bounds) return 0;
  const halfWide = Math.min(o.bounds.max[0] - o.bounds.min[0], o.bounds.max[2] - o.bounds.min[2]) / 2;
  return halfWide * DOOR_HOLE_MAX * DOOR_STAGE_RADIUS[stage - 1];
}

/**
 * Put a bullet through a door.
 *
 * @param {object} o
 * @param {number} damage  what the bullet had left when it arrived
 * @param {number} u  where it hit across the leaf, local units (its width axis)
 * @param {number} v  ...and up it (its height axis)
 * @returns {boolean} true if the hole changed
 */
export function carveDoor(o, damage, u = 0, v = 0) {
  if (o.role !== 'door' || o.broken || !(o.health > 0) || !(damage > 0)) return false;
  if (!o.hole) o.hole = { damage: 0, u, v };
  const before = holeStage(o);
  // The centre is the damage-weighted average of every round put through it, so
  // holding on one spot carves one hole and walking the spray drags it.
  const total = o.hole.damage + damage;
  o.hole.u = (o.hole.u * o.hole.damage + u * damage) / total;
  o.hole.v = (o.hole.v * o.hole.damage + v * damage) / total;
  o.hole.damage = total;
  // Only a stage change is worth reporting: the hole does not creep between
  // them, and the renderer has no reason to touch the material until it moves.
  return holeStage(o) !== before;
}

/** Is this point on the leaf inside the hole that has been shot in it? */
export function inHole(o, u, v) {
  const r = holeRadius(o);
  if (!(r > 0)) return false;
  return Math.hypot(u - o.hole.u, v - o.hole.v) < r;
}

/** Open if closed, close if open. What `+E` does. `from` is the activator. */
export function toggleDoor(o, from = null) {
  return o.state === DOOR.CLOSED || o.state === DOOR.CLOSING ? openDoor(o, true, from) : closeDoor(o);
}

/**
 * Advance a door's swing. Breakables do not tick.
 *
 * A door stays where it was put. `forceclosed` used to start a timer here and
 * that was a misreading: on a `prop_door_rotating` it means "shut even if
 * something is in the way", not "shut yourself after a while". The symptom was
 * Nuke's two forceclosed doors reversing themselves a second or two after
 * every use.
 */
export function stepInteractive(o, dt) {
  if (o.role !== 'door') return o;
  const swing = doorSwingSeconds(o);
  const step = swing > 0 ? dt / swing : 1;
  if (o.state === DOOR.OPENING) {
    o.frac += step;
    if (o.frac >= 1) {
      o.frac = 1;
      o.state = DOOR.OPEN;
    }
  } else if (o.state === DOOR.CLOSING) {
    o.frac -= step;
    if (o.frac <= 0) {
      o.frac = 0;
      o.state = DOOR.CLOSED;
    }
  }
  return o;
}

/**
 * Damage one thing.
 *
 * @param {object} o
 * @param {number} amount  raw damage before the material multiplier
 * @param {'bullets'|'club'|'explosive'} type
 * @returns {boolean} true on the call that broke it (never true twice)
 */
export function applyDamage(o, amount, type) {
  if (o.broken || !(o.health > 0)) return false;
  // Bullets do not damage a door, they SHOVE it (see nudgeDoor). Everything
  // else that can hurt one does: an HE destroys a Nuke door outright, which is
  // what its 100 hit points and its 1.5 explosive multiplier work out to.
  if (o.role === 'door' && type === 'bullets') return false;
  const mult = o.mult[type];
  // An unknown damage type does nothing. Fire arrives here as `undefined` and
  // that is correct: propdata has no fire column, so fire cannot hurt a prop.
  if (!Number.isFinite(mult)) return false;
  const dealt = amount * mult;
  if (!(dealt > 0)) return false;
  o.health -= dealt;
  if (o.health > 0) return false;
  o.health = 0;
  o.broken = true;
  return true;
}

/**
 * What one HE detonation does to everything on the map: damage to breakables,
 * an opening shove to doors.
 *
 * @param {object[]} list
 * @param {{x,y,z}} at        Source frame
 * @param {number} radius     the grenade's blast radius
 * @param {number} damage     its maximum damage
 * @returns {{broken: object[], opened: object[]}}
 */
export function applyBlast(list, at, radius, damage) {
  const broken = [];
  const opened = [];
  for (const o of list) {
    const dx = o.origin[0] - at.x;
    const dy = o.origin[1] - at.y;
    const dz = o.origin[2] - at.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const f = blastFalloff(dist, radius);
    if (f <= 0) continue;
    if (applyDamage(o, damage * f, 'explosive')) broken.push(o);
  }
  return { broken, opened };
}

// ---------------------------------------------------------------------------
// Where a thing physically is. A door that has swung 89 degrees is no longer
// where the map's baked collision says it is, so the renderer takes its static
// hull out of the world (mapLoader's per-triangle mask) and feeds the tracer
// this box instead, at whatever angle the door has reached this frame.
// ---------------------------------------------------------------------------

/** [guessed] How far a player can reach to open a door. CS2 does not say. */
export const USE_RANGE = 80;

/**
 * How far from the hinge a door leaf's geometry may sit.
 *
 * Measured on Nuke: the leaf reaches 107 units. 110 cut the top corners off.
 * 256, which the split used next, is a corridor: Mirage's static apartment and
 * palace doors share the swinging door's model, sit 150–250 units away, and
 * got claimed, cut out of the world, and rotated with the wrong hinge. The
 * hole through the building is those doors, gone.
 */
export const DOOR_LEAF_RADIUS = 140;
/**
 * Longest edge of a single door leaf's AABB. A Nuke leaf is ~60×12×110. A
 * claim larger than this ate a wall, a neighbouring door, or both.
 */
export const DOOR_LEAF_SPAN = 168;

/**
 * The eight corners of an interactive's box in the SOURCE frame, at its
 * current pose. `bounds` is already in world axes at the closed position, so a
 * closed door yields exactly the box the split measured and only the swing
 * rotates it — about the entity origin, which for a `prop_door_rotating` IS
 * the hinge.
 *
 * @param {object} o
 * @param {number[]} [out] 24 numbers, xyz per corner
 */
export function boxCorners(o, out = []) {
  if (!o.bounds) return null;
  const { min, max } = o.bounds;
  const a = o.role === 'door' ? (poseAngle(o) * Math.PI) / 180 : 0;
  const cs = Math.cos(a);
  const sn = Math.sin(a);
  const [ox, oy, oz] = o.origin;
  out.length = 0;
  for (let i = 0; i < 8; i++) {
    const lx = i & 1 ? max[0] : min[0];
    const ly = i & 2 ? max[1] : min[1];
    const lz = i & 4 ? max[2] : min[2];
    out.push(ox + lx * cs - ly * sn, oy + lx * sn + ly * cs, oz + lz);
  }
  return out;
}

/** Corner index for (x,y,z) picked from min/max, matching boxCorners' bit order. */
const C = (x, y, z) => x | (y << 1) | (z << 2);
/** The six faces as corner index quads, wound consistently. */
const FACES = [
  [C(0, 0, 0), C(1, 0, 0), C(1, 1, 0), C(0, 1, 0)], // bottom
  [C(0, 0, 1), C(1, 0, 1), C(1, 1, 1), C(0, 1, 1)], // top
  [C(0, 0, 0), C(1, 0, 0), C(1, 0, 1), C(0, 0, 1)], // −y
  [C(0, 1, 0), C(1, 1, 0), C(1, 1, 1), C(0, 1, 1)], // +y
  [C(0, 0, 0), C(0, 1, 0), C(0, 1, 1), C(0, 0, 1)], // −x
  [C(1, 0, 0), C(1, 1, 0), C(1, 1, 1), C(1, 0, 1)] //  +x
];

const _corners = [];

/**
 * The same box as 12 triangles in the SCENE frame (x, z, −y), which is the
 * frame shared/sim3d/hullTrace.js queries in.
 *
 * @returns {number[]} 108 numbers, or an empty array when it has no bounds
 */
export function boxTriangles(o, out = []) {
  out.length = 0;
  if (!boxCorners(o, _corners)) return out;
  // Source (x, y, z) → scene (x, z, −y).
  const px = (i) => _corners[i * 3];
  const py = (i) => _corners[i * 3 + 2];
  const pz = (i) => -_corners[i * 3 + 1];
  const push = (i) => out.push(px(i), py(i), pz(i));
  for (const [a, b, c, d] of FACES) {
    push(a);
    push(b);
    push(c);
    push(a);
    push(c);
    push(d);
  }
  return out;
}

/** Scene-frame bounds of the current pose, for a cheap reject before boxTriangles. */
export function boxBounds(o, out = { min: [0, 0, 0], max: [0, 0, 0] }) {
  if (!boxCorners(o, _corners)) return null;
  out.min[0] = out.min[1] = out.min[2] = Infinity;
  out.max[0] = out.max[1] = out.max[2] = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = [_corners[i * 3], _corners[i * 3 + 2], -_corners[i * 3 + 1]];
    for (let k = 0; k < 3; k++) {
      if (p[k] < out.min[k]) out.min[k] = p[k];
      if (p[k] > out.max[k]) out.max[k] = p[k];
    }
  }
  return out;
}

/**
 * How much of its speed a grenade keeps when it smashes through something
 * breakable, by what that thing is made of.
 *
 * GLASS IS [measured], off the Nuke demo, and it is a small loss — the grenade
 * staggers rather than stops.
 *
 * A demo does not say "this grenade broke a window", so a pass-through has to
 * be recognised: a tick where the grenade kept its heading (a wall bounce
 * reverses it), lost real speed, and was in free flight on the tick before.
 * That last condition is what keeps grenades already sliding to a stop — which
 * shed speed smoothly tick after tick — out of the sample. Free flight reads
 * 1.000 under it, so a loss shows.
 *
 * Across one Nuke match: 235,797 in-flight samples over 303 projectiles, 381
 * clean flight paths, 138 samples inside a breakable's collision hull, and two
 * pass-throughs, both glass:
 *
 *   881 -> 816 u/s   kept 0.926   turn  2.4 deg   inside the hull   molotov
 *   688 -> 420 u/s   kept 0.610   turn 17.6 deg   2u outside it     flashbang
 *
 * The first is the clean one and 0.93 is taken from it: dead centre of a
 * `nuke_window_84x68`, travelling straight on. The second turned 17.6 degrees
 * and was outside the box, which is what a clip on the frame looks like, so it
 * is reported and not used. A 65 u/s drop is far outside the noise — position
 * quantisation is worth about 2 u/s and one tick of grenade gravity about 5.
 *
 * That only 2 of 138 samples inside a hull show any loss at all is itself the
 * expected shape: those windows get shot out early in a round, and a grenade
 * through a hole that is already there loses nothing.
 *
 * METAL IS STILL [guessed]. No grenade in the corpus went through a vent. What
 * IS real is the split: which surface a thing is comes from its collision hull
 * in phys.glb (`glass`, `metal`, `metal_ventslat` on Nuke).
 */
export const GRENADE_BREAK_KEEP = Object.freeze({
  /** [measured] 0.926 on the one clean observation; see above. */
  glass: 0.93,
  /** [guessed] Vents, slats, sheet metal: heavier, so more of the throw goes. */
  default: 0.75
});

/** What a grenade keeps after going through this particular thing. */
export function breakKeep(o) {
  const s = String(o?.surface || o?.phys?.surface || '').toLowerCase();
  return GRENADE_BREAK_KEEP[s] ?? GRENADE_BREAK_KEEP.default;
}

/**
 * A grenade hits something breakable.
 *
 * Two things happen and they are separate: the thing breaks, and the grenade
 * carries on through at a fraction of its speed rather than bouncing off. The
 * caller supplies the velocity the grenade had going IN, because the bounce has
 * already been resolved against the pane by the time anyone notices what it hit.
 *
 * @param {object} o        the breakable
 * @param {{x,y,z}} velIn   its velocity before the impact
 * @returns {{x,y,z}|null}  what the velocity should be instead, or null if the
 *   thing did not break and the bounce stands
 */
export function grenadeThrough(o, velIn) {
  if (o.role !== 'breakable' || o.broken) return null;
  // A grenade is not a bullet and not an explosion — propdata has no fourth
  // damage type for a thrown object — and what it lands on is a pane or a vent
  // slat either way, so the impact simply breaks it.
  o.health = 0;
  o.broken = true;
  const keep = breakKeep(o);
  return { x: velIn.x * keep, y: velIn.y * keep, z: velIn.z * keep };
}

/**
 * A molotov, for the avoidance of doubt.
 *
 * It exists so the absence is deliberate and testable rather than an omission
 * somebody later "fixes". Fire has no column in propdata: it cannot damage a
 * prop, and it cannot open a door either.
 */
export function applyFire() {
  return { broken: [], opened: [] };
}
