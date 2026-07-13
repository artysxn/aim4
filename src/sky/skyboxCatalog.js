// ---------------------------------------------------------------------------
// skyboxCatalog.js — discover bundled cubemap skyboxes under src/sky/.
// Each entry is a folder with px/nx/py/ny/pz/nz faces (see cubemap_layout.png).
// ---------------------------------------------------------------------------

const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const faceModules = import.meta.glob('./**/*_cubemap_2k/{px,nx,py,ny,pz,nz}.png', {
  eager: true,
  query: '?url',
  import: 'default'
});

function formatLabel(id) {
  const m = id.match(/(?:^|\/)(sky_(\d+))_2k\/\1_cubemap_2k$/i);
  const skyLabel = m ? `Sky ${m[2]}` : id.split('/').pop().replace(/_cubemap_2k$/, '');
  const folder = id.includes('/') ? id.split('/')[0] : null;
  return folder ? `${folder} — ${skyLabel}` : skyLabel;
}

function buildCatalog() {
  const groups = new Map();

  for (const [path, url] of Object.entries(faceModules)) {
    const match = path.match(/\/([^/]+_cubemap_2k)\/(px|nx|py|ny|pz|nz)\.png$/i);
    if (!match) continue;
    const dir = path.slice(0, path.lastIndexOf('/')).replace(/^\.\//, '');
    const face = match[2].toLowerCase();
    if (!groups.has(dir)) groups.set(dir, {});
    groups.get(dir)[face] = url;
  }

  const entries = [];
  for (const [id, faces] of groups) {
    if (!FACE_ORDER.every((f) => faces[f])) continue;
    entries.push({
      id,
      label: formatLabel(id),
      urls: FACE_ORDER.map((f) => faces[f])
    });
  }

  entries.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return entries;
}

export const SKYBOX_CATALOG = buildCatalog();

export function skyboxById(id) {
  return SKYBOX_CATALOG.find((e) => e.id === id) ?? null;
}

export function defaultSkyboxId() {
  return SKYBOX_CATALOG[0]?.id ?? '';
}
