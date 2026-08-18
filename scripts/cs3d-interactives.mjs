// ---------------------------------------------------------------------------
// scripts/cs3d-interactives.mjs
// The parts of a map that move and break: doors, vents, glass, breakables.
//
//   node scripts/cs3d-interactives.mjs [--map slug] [--game <csgo dir>] [--force]
//
// Writes server/data/cs3d/pack/<slug>/interactives.json. That file is ADDITIVE:
// nothing bumps PACK_VERSION, a pack without it simply has no interactives, and
// the renderer treats it as optional. Re-running this does not require the 17 GB
// world re-pack that scripts/cs3d-pack.mjs does — the entity lump and the prop
// models are small and come straight out of the VPKs.
//
// See CS3D-INTERACTIVES-PLAN.md for why each number is where it is. The short
// version: a demo records nothing about doors or breakables, so unlike the
// grenade work there is no oracle and no fitting. Everything here is READ, out
// of two places:
//
//   the map's entity lump   per-entity: origin, angles, model, and for a door
//                           its `distance` (degrees of swing) and `speed`
//                           (degrees a second) and its slave link
//   the prop's model        health, the break pieces, and a `base` naming a
//                           class in scripts/propdata.vdata
//
// The damage model is the part worth reading twice. A model writes
// `dmg.bullets = -1.0` and friends, and -1 means "no override", NOT "immune":
// the real multipliers come from the propdata class the model's `base` names.
// propdata carries exactly three damage types — bullets, club, explosive — and
// the string `dmg.fire` occurs nowhere in it, which is why a molotov burning on
// a Nuke vent does nothing at all and an HE breaks it instantly.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT, fail, findVrf, findGameDir, runVrf } from './lib/vrf.mjs';
import { parseKv3, resolveBase } from './lib/kv3.mjs';
import { parseEnts } from './lib/ents.mjs';
import { CS3D_MAPS, cs3dMap } from '../shared/cs3d/maps.js';

const TAG = 'cs3d-interactives';
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack');
const MAP_VPK_DIR = path.join(ROOT, 'cs3d', 'maps');
const CACHE_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'interactives');

/** The format of interactives.json. Bump when the shape changes. */
export const INTERACTIVES_VERSION = 1;

// ---- CLI --------------------------------------------------------------------

const args = process.argv.slice(2);
let only = '';
let gameDir = '';
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--map') only = args[++i];
  else if (args[i] === '--game') gameDir = args[++i];
  else if (args[i] === '--force') force = true;
}

// ---- what counts as interactive ---------------------------------------------

/**
 * How each class behaves. `door` swings, `breakable` takes damage and shatters,
 * `prop` is a model that MAY be breakable depending on what its model says, and
 * `inert` is recorded for completeness and does nothing.
 *
 * `prop_physics_multiplayer` is deliberately inert: it needs a rigid-body solver
 * with stacking and friction, which is a physics engine rather than a feature,
 * and the tactical value is nil. See the plan, section 2.3.
 */
const CLASSES = {
  prop_door_rotating: 'door',
  func_door_rotating: 'door',
  func_door: 'door',
  func_movelinear: 'door',
  func_breakable: 'breakable',
  func_breakable_surf: 'breakable',
  prop_dynamic: 'prop',
  prop_dynamic_override: 'prop',
  prop_physics_multiplayer: 'inert',
  prop_physics: 'inert'
};

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const vec3 = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v.map(Number) : d);
const round = (v, k = 100) => Math.round(v * k) / k;

// ---- the prop damage table --------------------------------------------------

/**
 * `scripts/propdata.vdata`, `_base` chains resolved.
 *
 * Every class carries `dmg.bullets`, `dmg.club`, `dmg.explosive` and `health`.
 * Nothing carries `dmg.fire`; fire is not a damage type a prop can take.
 */
async function readPropData(vrf, pak) {
  const cached = path.join(CACHE_DIR, 'propdata.vdata.txt');
  if (force || !fs.existsSync(cached)) {
    const txt = await runVrf(vrf, ['-i', pak, '-f', 'scripts/propdata.vdata_c', '-b', 'DATA'], 'prop damage table', {
      capture: true
    });
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(cached, txt);
  }
  const txt = await fsp.readFile(cached, 'utf8');
  const start = txt.indexOf('<!-- kv3');
  const doc = parseKv3(txt.slice(start < 0 ? 0 : start));
  const out = {};
  for (const [key, entry] of Object.entries(doc)) {
    if (!entry || typeof entry !== 'object' || key === 'generic_data_type') continue;
    out[key] = resolveBase(doc, entry);
  }
  return out;
}

// ---- one model's break data -------------------------------------------------

/**
 * A model's `prop_data` game keys and its break pieces.
 *
 * Returns null for a model with neither, which is most of them: a door has no
 * prop_data at all, which is exactly why a door cannot be destroyed.
 */
async function readModel(vrf, pak, mapVpk, modelPath) {
  const rel = modelPath.replace(/\.vmdl$/, '') + '.vmdl';
  const safe = rel.replace(/[^a-z0-9]+/gi, '_');
  const cached = path.join(CACHE_DIR, `${safe}.txt`);
  if (force || !fs.existsSync(cached)) {
    // `-f <path> -b DATA` is what the weapon table uses and it does NOT work for
    // a model: VRF answers with the package listing instead of the file, which
    // reads as "this model has no prop_data" and quietly turns every breakable
    // into scenery. Dumping to a directory does work.
    const scratch = path.join(CACHE_DIR, '.dump');
    await fsp.rm(scratch, { recursive: true, force: true });
    let txt = '';
    // Map-local entity models (brush geometry) live in the map VPK; everything
    // else is in pak01. Try the likelier source first.
    for (const src of rel.startsWith('maps/') ? [mapVpk, pak] : [pak, mapVpk]) {
      try {
        await runVrf(vrf, ['-i', src, '--vpk_filepath', `${rel}_c`, '-o', scratch, '-d'], `model ${path.basename(rel)}`, {
          quiet: true
        });
      } catch {
        /* try the next source */
      }
      const out = path.join(scratch, ...rel.split('/'));
      if (fs.existsSync(out)) {
        txt = await fsp.readFile(out, 'utf8');
        break;
      }
    }
    await fsp.rm(scratch, { recursive: true, force: true });
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(cached, txt || '');
  }
  const txt = await fsp.readFile(cached, 'utf8');
  if (!txt.trim()) return null;

  // The decompiled model is kv3 with a nested _class tree. The two things we
  // want are small and unambiguous, so they are read with targeted regex rather
  // than by walking a tree whose shape varies by model version.
  const keys = {};
  const gk = txt.match(/game_keys\s*=\s*\{([\s\S]*?)\n\s*\}/);
  if (gk) {
    for (const line of gk[1].split('\n')) {
      const m = /^\s*([A-Za-z_.]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].replace(/^"|"$/g, '');
      if (v === 'true' || v === 'false') v = v === 'true';
      else if (/^-?[\d.]+$/.test(v)) v = Number(v);
      keys[m[1]] = v;
    }
  }
  const pieces = [];
  for (const m of txt.matchAll(/_class\s*=\s*"BreakPieceExternal"([\s\S]*?)\n\s*\}/g)) {
    const body = m[1];
    const model = /model\s*=\s*resource:"([^"]+)"/.exec(body);
    if (!model) continue;
    pieces.push({
      model: model[1],
      fade: num(/fadetime\s*=\s*([\d.]+)/.exec(body)?.[1], 4),
      chance: num(/random_spawn_chance\s*=\s*([\d.]+)/.exec(body)?.[1], 1),
      group: (/collision_group_override\s*=\s*"([^"]*)"/.exec(body)?.[1] || 'debris'),
      // A break piece may state the health the whole prop is worth. On the Nuke
      // door this is the only number in the game that matches what the door
      // actually does; see the door branch in doMap.
      health: num(/health_override\s*=\s*(-?[\d.]+)/.exec(body)?.[1], 0)
    });
  }
  if (!Object.keys(keys).length && !pieces.length) return null;
  return { keys, pieces };
}

/** The first break piece that states a health, or 0. */
function pieceHealth(pieces) {
  for (const p of pieces || []) if (p.health > 0) return p.health;
  return 0;
}

/**
 * The effective damage profile for a model: health, and one multiplier per
 * damage type the game actually has.
 *
 * -1 in a model's game_keys means "no override" — it is written on every damage
 * type including bullets, and a prop immune to bullets could not be broken at
 * all. So -1 falls through to the propdata class named by `base`.
 */
function damageProfile(model, propData) {
  if (!model) return null;
  const base = propData[String(model.keys.base || '')] || {};
  const pick = (k) => {
    const own = model.keys[k];
    if (Number.isFinite(own) && own >= 0) return own;
    const inherited = base[k];
    return Number.isFinite(inherited) ? inherited : 1;
  };
  const ownHealth = Number.isFinite(model.keys.health) ? model.keys.health : null;
  const health = ownHealth !== null && ownHealth > 0 ? ownHealth : num(base.health, 0);
  return {
    health,
    base: String(model.keys.base || ''),
    // Three damage types, because that is all propdata defines. Fire is absent
    // from the table entirely, so a burning molotov cannot damage a prop.
    mult: { bullets: pick('dmg.bullets'), club: pick('dmg.club'), explosive: pick('dmg.explosive') },
    pieces: model.pieces
  };
}

// ---- per map ----------------------------------------------------------------

async function doMap(vrf, pak, entry) {
  const mapVpk = path.join(MAP_VPK_DIR, `${entry.file}.vpk`);
  if (!fs.existsSync(mapVpk)) {
    console.log(`  ${entry.slug}: no ${entry.file}.vpk in cs3d/maps, skipped`);
    return null;
  }
  const dump = path.join(CACHE_DIR, entry.slug);
  const ventsFile = path.join(dump, 'maps', entry.file, 'entities', 'default_ents.vents');
  if (force || !fs.existsSync(ventsFile)) {
    await runVrf(
      vrf,
      ['-i', mapVpk, '--vpk_filepath', `maps/${entry.file}/entities/default_ents.vents_c`, '-o', dump, '-d'],
      `${entry.slug} entities`,
      { quiet: true }
    );
  }
  if (!fs.existsSync(ventsFile)) fail(TAG, `${entry.slug}: no entity lump came out of ${entry.file}.vpk`);

  const ents = parseEnts(await fsp.readFile(ventsFile, 'utf8'));
  const propData = await readPropData(vrf, pak);

  // Unique models first, so each is decompiled once however many entities use it.
  const wanted = ents.filter((e) => CLASSES[e.classname]);
  const models = new Map();
  for (const e of wanted) {
    const m = String(e.model || '');
    if (m && !models.has(m)) models.set(m, await readModel(vrf, pak, mapVpk, m));
  }

  const out = [];
  const counts = {};
  for (const e of wanted) {
    const kind = CLASSES[e.classname];
    const model = models.get(String(e.model || '')) || null;
    const dmg = damageProfile(model, propData);
    // A `prop` is only interesting if its model says it can break.
    const breakable = !!dmg && dmg.health > 0;
    const role = kind === 'prop' ? (breakable ? 'breakable' : 'inert') : kind;
    counts[role] = (counts[role] || 0) + 1;
    if (role === 'inert') continue;

    const row = {
      id: `${entry.slug}:${role}:${out.length}`,
      class: e.classname,
      role,
      origin: vec3(e.origin).map((v) => round(v)),
      angles: vec3(e.angles).map((v) => round(v)),
      model: String(e.model || '').replace(/\.vmdl$/, ''),
      name: e.targetname ? String(e.targetname) : undefined
    };
    if (role === 'door') {
      row.door = {
        // Degrees of swing and degrees a second, straight out of the lump.
        // A Nuke door is 89 at 200, so it takes 0.445 s.
        distance: num(e.distance, 90),
        speed: num(e.speed, 100),
        openDir: num(e.opendir, 0),
        forceClosed: e.forceclosed === true,
        spawnflags: num(e.spawnflags, 0),
        slave: e.slavename ? String(e.slavename) : undefined
      };
      if (e.soundopenoverride || e.soundunlockedoverride) {
        row.sounds = {
          open: e.soundopenoverride ? String(e.soundopenoverride) : undefined,
          unlock: e.soundunlockedoverride ? String(e.soundunlockedoverride) : undefined
        };
      }
      // A door is breakable too, and its model says so as loudly as a vent's
      // does: `metal_door_001_br` carries prop_data with `base =
      // "Door.Standard"` (health 1000, bullets 1.0, club 1.25, explosive 1.5)
      // and a BreakPieceList. It was missed the first time round because this
      // branch only ever wrote the swing.
      //
      // The health is the awkward part, because the game states it three times
      // and not consistently: the entity says 0, `Door.Standard` says 1000, and
      // the model's own break piece says `health_override = 100`. 100 is the
      // one that matches the game — one HE destroys a Nuke door — so that is
      // the order of preference, and it is recorded rather than assumed.
      if (dmg) {
        const entHealth = num(e.health, 0);
        row.break = {
          health: entHealth > 0 ? entHealth : pieceHealth(dmg.pieces) || dmg.health || 1,
          mult: dmg.mult,
          base: dmg.base,
          pieces: dmg.pieces
        };
      }
    }
    if (role === 'breakable') {
      // The entity's own health wins when it has one (func_breakable writes it);
      // otherwise the model's, resolved through propdata.
      const entHealth = num(e.health, 0);
      row.break = {
        health: entHealth > 0 ? entHealth : dmg ? dmg.health : 1,
        mult: dmg ? dmg.mult : { bullets: 1, club: 1, explosive: 1 },
        base: dmg ? dmg.base : '',
        pieces: dmg ? dmg.pieces : []
      };
    }
    out.push(row);
  }

  const doc = {
    version: INTERACTIVES_VERSION,
    map: entry.slug,
    generated: new Date().toISOString(),
    // Fire is not in propdata at all; recorded here so the runtime does not have
    // to rediscover it, and so a future CS2 update adding one is visible.
    damageTypes: ['bullets', 'club', 'explosive'],
    interactives: out
  };
  const dest = path.join(PACK_DIR, entry.slug);
  await fsp.mkdir(dest, { recursive: true });
  // scripts/cs3d-split-interactives.mjs writes back into this same file: the
  // measured `bounds` of each thing's drawn geometry, the collision hull it was
  // matched to, and the triangle count. None of that is knowable from the
  // entity lump, and the runtime cannot swing a door without it — so carry it
  // across a re-extraction rather than silently dropping it. (It was dropped
  // once, and the symptom was every door on the map going rigid.)
  const prevFile = path.join(dest, 'interactives.json');
  if (fs.existsSync(prevFile)) {
    try {
      const prev = JSON.parse(await fsp.readFile(prevFile, 'utf8'));
      const byId = new Map((prev.interactives || []).map((r) => [r.id, r]));
      let kept = 0;
      for (const row of out) {
        const old = byId.get(row.id);
        if (!old?.bounds) continue;
        row.bounds = old.bounds;
        if (old.phys) row.phys = old.phys;
        if (old.triangles !== undefined) row.triangles = old.triangles;
        kept++;
      }
      if (prev.geometry) doc.geometry = prev.geometry;
      if (kept) console.log(`  ${entry.slug.padEnd(8)} carried split geometry for ${kept} of ${out.length}`);
    } catch {
      /* an unreadable previous file just means nothing to carry */
    }
  }
  await fsp.writeFile(prevFile, JSON.stringify(doc, null, 1));
  const summary = Object.entries(counts)
    .sort()
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  console.log(`  ${entry.slug.padEnd(8)} ${String(out.length).padStart(3)} kept  (${summary})`);
  return doc;
}

// ---- run --------------------------------------------------------------------

const vrf = findVrf(TAG);
const pak = path.join(findGameDir(TAG, gameDir), 'pak01_dir.vpk');
const maps = only ? [cs3dMap(only)].filter(Boolean) : CS3D_MAPS;
if (!maps.length) fail(TAG, `unknown map "${only}"`);
console.log(`${TAG}: ${maps.length} map(s)`);

const all = [];
for (const entry of maps) {
  const doc = await doMap(vrf, pak, entry);
  if (doc) all.push(doc);
}

// A roll-up of what the whole corpus contains, because a class that appears on
// one map and nowhere else is exactly the thing that breaks a schema later.
const classes = {};
for (const d of all) for (const i of d.interactives) classes[i.class] = (classes[i.class] || 0) + 1;
console.log(`\n${all.length} map(s) written. Classes kept across all of them:`);
for (const [k, v] of Object.entries(classes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
