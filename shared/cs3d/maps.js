// ---------------------------------------------------------------------------
// shared/cs3d/maps.js
// The 3D map roster: one entry per map the operator dropped as a .vpk. The
// slug is the URL (aim4.io/<slug>) and the pack folder name; `file` is the
// game's map name; `code` is the 2D product's map code where one exists
// (roundId.js MAPS), so radar calibration and nav data can be joined later.
//
// The roster is the active-duty pool. Overpass, Train and Vertigo were dropped
// (2026-08-16) along with their packs and raw imports; re-adding one means a
// .vpk, `cs3d:build`, an entry here and a line in vercel.json's two rewrites.
//
// `bareRoute: false` exists for a map whose slug collides with a page the site
// already owns — de_train did, because `/train` is the trainer. No current map
// needs it; such a map is reached as /de_<name>, which every map answers to.
// ---------------------------------------------------------------------------

export const CS3D_MAPS = [
  { slug: 'dust2', file: 'de_dust2', name: 'Dust 2', code: 'DD2' },
  { slug: 'mirage', file: 'de_mirage', name: 'Mirage', code: 'MIR' },
  { slug: 'inferno', file: 'de_inferno', name: 'Inferno', code: 'INF' },
  { slug: 'nuke', file: 'de_nuke', name: 'Nuke', code: 'NUK' },
  { slug: 'ancient', file: 'de_ancient', name: 'Ancient', code: 'ANC' },
  { slug: 'anubis', file: 'de_anubis', name: 'Anubis', code: 'ANU' },
  { slug: 'cache', file: 'de_cache', name: 'Cache', code: 'CCH' }
];

/** Slugs that own a bare /<slug> route (see bareRoute above). */
export const CS3D_BARE_ROUTES = CS3D_MAPS.filter((m) => m.bareRoute !== false).map((m) => m.slug);

const BY_SLUG = new Map(CS3D_MAPS.map((m) => [m.slug, m]));
const BY_FILE = new Map(CS3D_MAPS.map((m) => [m.file, m]));

/** Resolve "dust2", "de_dust2" or "DD2" to a roster entry, or null. */
export function cs3dMap(key) {
  const k = String(key || '').toLowerCase();
  return (
    BY_SLUG.get(k) ||
    BY_FILE.get(k) ||
    CS3D_MAPS.find((m) => m.code && m.code.toLowerCase() === k) ||
    null
  );
}

/** Roster entry for a URL path like "/dust2" or "/de_train", or null. */
export function cs3dMapForPath(pathname) {
  const seg = String(pathname || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')[0]
    .toLowerCase();
  if (!seg) return null;
  const m = cs3dMap(seg);
  if (!m) return null;
  // Bare slug only counts when the map owns that route; de_<name> always works.
  if (seg === m.slug && m.bareRoute === false) return null;
  return m;
}
