// ---------------------------------------------------------------------------
// scripts/i18n-locale.mjs
// Create, fill and measure the per-language catalogues.
//
//   node scripts/i18n-locale.mjs --init            create any missing locale file
//   node scripts/i18n-locale.mjs --status          coverage per language, per surface
//   node scripts/i18n-locale.mjs --status ru       one language, broken down
//   node scripts/i18n-locale.mjs --todo ru demos   the untranslated slice, as JSON
//   node scripts/i18n-locale.mjs --merge ru f.json fold a batch of translations in
//   node scripts/i18n-locale.mjs --prune           drop entries the source no longer has
//
// A locale file holds only what has been translated. Anything missing falls
// back to English at render time, so a half-finished language is a site that is
// half in that language and half in English, never a site with holes in it.
// That is what makes the work shippable in slices.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOGUE = path.join(ROOT, 'src', 'i18n', 'catalogue.en.json');
const LOCALES = path.join(ROOT, 'src', 'i18n', 'locales');

const { LANGS } = await import(pathToFileURL(path.join(ROOT, 'src/i18n/langs.js')).href);
const { ENUM_SETS } = await import(pathToFileURL(path.join(ROOT, 'src/i18n/enums.js')).href);

const TARGETS = LANGS.filter((l) => l.id !== 'en');

function readCatalogue() {
  if (!fs.existsSync(CATALOGUE)) {
    console.error('src/i18n/catalogue.en.json is missing. Run: node scripts/i18n-extract.mjs');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
}

function localePath(id) {
  return path.join(LOCALES, `${id}.json`);
}

function readLocale(id) {
  const file = localePath(id);
  if (!fs.existsSync(file)) return { lang: id, enums: {}, exact: {}, patterns: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    lang: raw.lang || id,
    enums: raw.enums || {},
    exact: raw.exact || {},
    patterns: raw.patterns || {}
  };
}

/** Sorted, so a merge produces a diff of what changed and nothing else. */
function writeLocale(id, data) {
  const sortObj = (o) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const out = {
    lang: id,
    enums: Object.fromEntries(
      Object.entries(data.enums)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortObj(v)])
    ),
    exact: sortObj(data.exact),
    patterns: sortObj(data.patterns)
  };
  fs.mkdirSync(LOCALES, { recursive: true });
  fs.writeFileSync(localePath(id), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

function counts(cat, loc) {
  const perSurface = new Map();
  const bump = (surface, field, done) => {
    if (!perSurface.has(surface)) perSurface.set(surface, { total: 0, done: 0 });
    const row = perSurface.get(surface);
    row.total++;
    if (done) row.done++;
    void field;
  };
  for (const [text, surface] of Object.entries(cat.exact)) {
    bump(surface, 'exact', typeof loc.exact[text] === 'string');
  }
  for (const [tpl, surface] of Object.entries(cat.patterns)) {
    bump(surface, 'patterns', loc.patterns[tpl] != null);
  }
  return perSurface;
}

const argv = process.argv.slice(2);
const flag = argv[0];

if (flag === '--init') {
  const cat = readCatalogue();
  void cat;
  let made = 0;
  for (const lang of TARGETS) {
    if (fs.existsSync(localePath(lang.id))) continue;
    writeLocale(lang.id, { enums: {}, exact: {}, patterns: {} });
    made++;
  }
  console.log(`${made} locale file(s) created, ${TARGETS.length} total.`);
} else if (flag === '--status') {
  const cat = readCatalogue();
  const one = argv[1];
  const total = Object.keys(cat.exact).length + Object.keys(cat.patterns).length;
  if (one) {
    const loc = readLocale(one);
    const per = counts(cat, loc);
    console.log(`${one}: ${[...per.values()].reduce((a, r) => a + r.done, 0)} / ${total}`);
    console.log('surface'.padEnd(12), 'done'.padStart(6), 'total'.padStart(7), '  %');
    for (const [surface, row] of per) {
      const pct = row.total ? Math.round((row.done / row.total) * 100) : 100;
      console.log(surface.padEnd(12), String(row.done).padStart(6), String(row.total).padStart(7), `  ${pct}%`);
    }
    const missingEnums = [];
    for (const [name, def] of Object.entries(ENUM_SETS)) {
      for (const member of def.members) {
        if (typeof loc.enums[name]?.[member] !== 'string') missingEnums.push(`${name}.${member}`);
      }
    }
    if (missingEnums.length) console.log(`missing enum members: ${missingEnums.join(', ')}`);
  } else {
    console.log('lang'.padEnd(6), 'done'.padStart(7), 'total'.padStart(7), '  %');
    for (const lang of TARGETS) {
      const loc = readLocale(lang.id);
      const done = [...counts(cat, loc).values()].reduce((a, r) => a + r.done, 0);
      const pct = total ? Math.round((done / total) * 100) : 0;
      console.log(lang.id.padEnd(6), String(done).padStart(7), String(total).padStart(7), `  ${pct}%`);
    }
  }
} else if (flag === '--todo') {
  const [, id, surface] = argv;
  if (!id) {
    console.error('usage: --todo <lang> [surface]');
    process.exit(1);
  }
  const cat = readCatalogue();
  const loc = readLocale(id);
  const exact = [];
  const patterns = [];
  for (const [text, s] of Object.entries(cat.exact)) {
    if (surface && s !== surface) continue;
    if (typeof loc.exact[text] !== 'string') exact.push(text);
  }
  for (const [tpl, s] of Object.entries(cat.patterns)) {
    if (surface && s !== surface) continue;
    if (loc.patterns[tpl] == null) patterns.push(tpl);
  }
  process.stdout.write(`${JSON.stringify({ lang: id, surface: surface || 'all', exact, patterns }, null, 2)}\n`);
} else if (flag === '--merge') {
  const [, id, file] = argv;
  if (!id || !file) {
    console.error('usage: --merge <lang> <batch.json>');
    process.exit(1);
  }
  const cat = readCatalogue();
  const loc = readLocale(id);
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  let added = 0;
  let unknown = 0;
  let replaced = 0;

  for (const [set, table] of Object.entries(batch.enums || {})) {
    if (!ENUM_SETS[set]) {
      unknown++;
      continue;
    }
    loc.enums[set] = { ...(loc.enums[set] || {}) };
    for (const [member, value] of Object.entries(table)) {
      if (!ENUM_SETS[set].members.includes(member)) {
        unknown++;
        continue;
      }
      if (typeof value !== 'string' || !value.trim()) continue;
      if (loc.enums[set][member] != null) replaced++;
      else added++;
      loc.enums[set][member] = value;
    }
  }

  for (const [text, value] of Object.entries(batch.exact || {})) {
    if (!(text in cat.exact)) {
      unknown++;
      continue;
    }
    if (typeof value !== 'string') continue;
    // An empty translation is meaningful, but only for a short fragment. Prose
    // in this catalogue is split at inline tags, so an English sentence can
    // hand over a bare "The" or "a" that most target languages simply do not
    // write. Blanking those is the correct translation. Blanking a whole
    // sentence never is, so anything longer than a few words must have text.
    if (!value.trim() && text.trim().split(/\s+/).length > 4) continue;
    if (loc.exact[text] != null) replaced++;
    else added++;
    loc.exact[text] = value;
  }

  for (const [tpl, value] of Object.entries(batch.patterns || {})) {
    if (!(tpl in cat.patterns)) {
      unknown++;
      continue;
    }
    const ok =
      (typeof value === 'string' && value.trim()) ||
      (value && typeof value === 'object' && Object.values(value).some((v) => typeof v === 'string'));
    if (!ok) continue;
    if (loc.patterns[tpl] != null) replaced++;
    else added++;
    loc.patterns[tpl] = value;
  }

  writeLocale(id, loc);
  console.log(
    `${id}: +${added} new, ${replaced} replaced${unknown ? `, ${unknown} skipped (not in the source catalogue)` : ''}`
  );
} else if (flag === '--prune') {
  const cat = readCatalogue();
  for (const lang of TARGETS) {
    if (!fs.existsSync(localePath(lang.id))) continue;
    const loc = readLocale(lang.id);
    let dropped = 0;
    for (const key of Object.keys(loc.exact)) {
      if (!(key in cat.exact)) {
        delete loc.exact[key];
        dropped++;
      }
    }
    for (const key of Object.keys(loc.patterns)) {
      if (!(key in cat.patterns)) {
        delete loc.patterns[key];
        dropped++;
      }
    }
    writeLocale(lang.id, loc);
    if (dropped) console.log(`${lang.id}: dropped ${dropped} entr${dropped === 1 ? 'y' : 'ies'} the source no longer has`);
  }
  console.log('pruned.');
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n'));
}
