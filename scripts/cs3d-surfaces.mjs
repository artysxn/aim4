// ---------------------------------------------------------------------------
// scripts/cs3d-surfaces.mjs
// The game's surface table: what a bullet does to concrete, what it does to a
// metal grate, and which surfaces a player can climb.
//
//   node scripts/cs3d-surfaces.mjs [--game <csgo dir>]
//
// Writes shared/sim3d/surfaces.js — a generated module rather than a pack
// asset, because it is one small table for the whole game (78 surfaces), the
// same on every map, and shared/sim3d has to be able to read it in Node with
// no fetch. Everything in it is READ out of the game; nothing is fitted.
//
// It comes from two files that have to be merged:
//
//   surfaceproperties/surfaceproperties.vsurf   density, elasticity, friction,
//                                               thickness, and the `base` chain
//   scripts/surfaceproperties_game.txt          gamematerial, the two bullet
//                                               penetration modifiers,
//                                               climbable, jumpfactor,
//                                               maxspeedfactor,
//                                               allowsmokethrough
//
// The game file inherits without saying so: `metal` writes only
// `bulletPenetrationDistanceModifier = 0.4` and takes its gamematerial and its
// damage modifier from `solidmetal`, which it names as its base in the OTHER
// file. So the chain is resolved from the .vsurf and applied to both.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT, fail, findVrf, findGameDir, runVrf } from './lib/vrf.mjs';
import { parseKv3 } from './lib/kv3.mjs';

const TAG = 'cs3d-surfaces';
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'surfaces');
const OUT = path.join(ROOT, 'shared', 'sim3d', 'surfaces.js');

const args = process.argv.slice(2);
let gameDir = '';
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game') gameDir = args[++i];
  else if (args[i] === '--force') force = true;
}

const FILES = {
  physics: 'surfaceproperties/surfaceproperties.vsurf_c',
  game: 'scripts/surfaceproperties_game.txt'
};

/** Pull one file out of the VPK, cached. */
async function dump(vrf, pak, res) {
  const rel = res.replace(/_c$/, '');
  const out = path.join(RAW_DIR, ...rel.split('/'));
  if (!force && fs.existsSync(out)) return fsp.readFile(out, 'utf8');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await runVrf(vrf, ['-i', pak, '-f', res, '-o', RAW_DIR, '-d'], `dump ${rel}`, { quiet: true });
  if (!fs.existsSync(out)) fail(TAG, `VRF wrote nothing for ${res}`);
  return fsp.readFile(out, 'utf8');
}

/** `SurfacePropertiesList` as a map keyed by lower-cased name. */
function readList(text) {
  const doc = parseKv3(text);
  const list = doc.SurfacePropertiesList || [];
  const out = new Map();
  for (const row of list) {
    const name = String(row.surfacePropertyName || '').toLowerCase();
    if (name) out.set(name, row);
  }
  return out;
}

/**
 * Read a field off a surface, walking the `base` chain when it does not have
 * one of its own. The chain lives in the .vsurf even for the game file's
 * fields, which is the whole reason this function exists.
 */
function inherited(phys, game, name, key, seen = new Set()) {
  const n = String(name || '').toLowerCase();
  if (!n || seen.has(n)) return undefined;
  seen.add(n);
  const g = game.get(n);
  if (g && g[key] !== undefined) return g[key];
  const p = phys.get(n);
  if (p && p[key] !== undefined) return p[key];
  const base = p?.base || g?.base;
  return base ? inherited(phys, game, base, key, seen) : undefined;
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);

async function main() {
  const vrf = findVrf(TAG);
  const dir = findGameDir(TAG, gameDir);
  const pak = path.join(dir, 'pak01_dir.vpk');
  await fsp.mkdir(RAW_DIR, { recursive: true });

  const phys = readList(await dump(vrf, pak, FILES.physics));
  const game = readList(await dump(vrf, pak, FILES.game));

  const names = [...new Set([...phys.keys(), ...game.keys()])].sort();
  const rows = [];
  for (const n of names) {
    const p = phys.get(n) || {};
    rows.push({
      name: n,
      // The one-letter class CS uses to special-case a surface. 'G' is a
      // grate and 'Y' is glass; both are the reason a bullet goes straight
      // through a fence without losing much.
      material: String(inherited(phys, game, n, 'gamematerial') ?? '') || '',
      // How much of a bullet's penetration budget this surface eats, and how
      // much damage survives it. 1 is transparent, 0 is a full stop.
      penetration: num(inherited(phys, game, n, 'bulletPenetrationDistanceModifier'), 0.5),
      damage: num(inherited(phys, game, n, 'bulletPenetrationDamageModifier'), 0.5),
      climbable: !!inherited(phys, game, n, 'climbable'),
      jump: num(inherited(phys, game, n, 'jumpfactor'), 1),
      speed: num(inherited(phys, game, n, 'maxspeedfactor'), 1),
      smoke: !!inherited(phys, game, n, 'allowsmokethrough'),
      // Physics, for completeness — a grenade's bounce comes from its own
      // elasticity, not the floor's, so nothing reads these yet.
      density: num(p.physics?.density, 2000),
      elasticity: num(p.physics?.elasticity, 0.25),
      friction: num(p.physics?.friction, 0.8),
      thickness: num(p.physics?.thickness, -1)
    });
  }

  const climbable = rows.filter((r) => r.climbable).map((r) => r.name);
  const body = rows
    .map(
      (r) =>
        `  ${JSON.stringify(r.name)}: { material: ${JSON.stringify(r.material)}, penetration: ${r.penetration}, ` +
        `damage: ${r.damage}, climbable: ${r.climbable}, jump: ${r.jump}, speed: ${r.speed}, smoke: ${r.smoke}, ` +
        `density: ${r.density}, elasticity: ${r.elasticity}, friction: ${r.friction}, thickness: ${r.thickness} }`
    )
    .join(',\n');

  const src = `// ---------------------------------------------------------------------------
// shared/sim3d/surfaces.js
// GENERATED by scripts/cs3d-surfaces.mjs — do not edit by hand.
//
// The game's own surface table, merged out of
// surfaceproperties/surfaceproperties.vsurf and
// scripts/surfaceproperties_game.txt with the \`base\` chains resolved, so every
// row below is complete rather than a diff against its parent.
//
// Fields, and who reads them:
//
//   material     [docs] the one-letter game material. 'G' grate, 'Y' glass,
//                'M' solid metal, 'C' concrete, ... CS special-cases the first
//                two when a bullet hits them (shared/sim3d/penetration.js).
//   penetration  [docs] bulletPenetrationDistanceModifier — how much of a
//                bullet's penetration budget this surface costs. Higher is
//                easier to shoot through: metalgrate 0.95, solidmetal 0.27.
//   damage       [docs] bulletPenetrationDamageModifier — the share of damage
//                that survives the wall.
//   climbable    [docs] whether a player can climb it. This is the ladder flag
//                (shared/sim3d/motion.js).
//   jump/speed   [docs] jumpfactor / maxspeedfactor.
//   smoke        [docs] allowsmokethrough.
//   density/elasticity/friction/thickness  [docs] the physics block. Nothing
//                reads these yet — a grenade's bounce comes from its own
//                m_flElasticity, measured in shared/sim3d/grenade.js.
//
// A map's collision carries a surface name per triangle (mapLoader's
// \`collider.surfaceOf\`), which is the key into this table.
// ---------------------------------------------------------------------------

/** ${rows.length} surfaces, keyed by their lower-cased name. */
export const SURFACES = Object.freeze({
${body}
});

/** What an unknown surface behaves like. */
export const DEFAULT_SURFACE = SURFACES.default;

/** Look one up, never null. */
export function surface(name) {
  return SURFACES[String(name || '').toLowerCase()] || DEFAULT_SURFACE;
}

/** [docs] Game materials CS treats as see-through-and-shoot-through. */
export const MAT_GRATE = 'G';
export const MAT_GLASS = 'Y';
export const MAT_METAL = 'M';

/** The ${climbable.length} surfaces the game marks climbable. */
export const CLIMBABLE = Object.freeze([${climbable.map((n) => JSON.stringify(n)).join(', ')}]);
`;
  await fsp.writeFile(OUT, src);
  console.log(`${TAG}: ${rows.length} surfaces -> ${path.relative(ROOT, OUT)}`);
  console.log(`  climbable: ${climbable.join(', ') || '(none)'}`);
  const soft = rows.filter((r) => r.penetration >= 0.9).map((r) => r.name);
  const hard = rows.filter((r) => r.penetration <= 0.3).map((r) => r.name);
  console.log(`  easiest to shoot through: ${soft.slice(0, 8).join(', ')}`);
  console.log(`  hardest: ${hard.slice(0, 8).join(', ')}`);
}

await main();
