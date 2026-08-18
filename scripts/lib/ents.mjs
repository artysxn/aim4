// ---------------------------------------------------------------------------
// scripts/lib/ents.mjs
// The map's entity lump (.vents text): "====N====" blocks of "key   value".
//
// Shared by scripts/cs3d-pack.mjs (which reads spawns, bomb sites, fog and the
// sun out of it) and scripts/cs3d-interactives.mjs (which reads the doors and
// breakables). One parser, because the two disagreeing about what a value looks
// like would be a bug nobody would find by reading either file.
// ---------------------------------------------------------------------------

export function parseEnts(text) {
  const ents = [];
  for (const block of text.split(/^====\d+====\s*$/m)) {
    const e = {};
    for (const raw of block.split('\n')) {
      const line = raw.replace(/\r$/, '');
      const m = line.match(/^(\S+)\s+(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (/^resource_name:/.test(v)) v = v.replace(/^resource_name:/, '');
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      v = v.replace(/^\[PR#\]/, '');
      if (/^\[.*\]$/.test(v)) {
        v = v
          .slice(1, -1)
          .split(',')
          .map((s) => Number(s.trim()));
      } else if (v === 'true' || v === 'false') v = v === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      // The skybox lump writes vectors as "x y z" strings.
      else if (/^-?[\d.]+ -?[\d.]+ -?[\d.]+$/.test(v)) v = v.split(' ').map(Number);
      e[m[1]] = v;
    }
    if (e.classname) ents.push(e);
  }
  return ents;
}
