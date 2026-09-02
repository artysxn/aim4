// ---------------------------------------------------------------------------
// scripts/i18n-extract.mjs
// Harvest every English string the site shows, and file it as something that
// can be translated.
//
//   node scripts/i18n-extract.mjs           rewrite src/i18n/catalogue.en.json
//   node scripts/i18n-extract.mjs --check   exit 1 if it would change
//   node scripts/i18n-extract.mjs --report  print what it found, write nothing
//   node scripts/i18n-extract.mjs --surface shell   just one slice
//
// The same shape as scripts/sync-plan-capabilities.mjs: one canonical source in
// code, one generated artifact, and a --check that fails the build when the two
// have drifted. It is in `npm test` for that reason.
//
// Two kinds of entry come out:
//
//   exact     a fixed string, translated whole
//   patterns  a sentence that was built from data, with the data replaced by
//             typed slots so it can be recognised again at render time
//
// And one list that is deliberately *not* translated: `keep`. CS teams call the
// same corner "Banana" in every language, so map callouts, position names, the
// round library's call names, map names, weapons and ranks are pulled out of
// the data modules that define them and excluded by name. That rule is the
// reason the whole approach works: what passes through a pattern untouched is
// then only ever a proper noun or a number, and neither inflects.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanLiterals } from './lib/jsStrings.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'src', 'i18n', 'catalogue.en.json');

// ---------------------------------------------------------------------------
// Surfaces. The order is the order of work: a slice is translated as a unit, so
// a stage can ship without waiting for the ones after it.
// ---------------------------------------------------------------------------

const SURFACES = [
  ['shell', ['index.html', 'src/site/site.js', 'src/site/homeView.js', 'src/i18n/picker.js', 'src/site/mobileMode.js', 'src/site/notify.js', 'src/site/profileModal.js', 'src/site/ingestReminder.js']],
  ['account', ['src/site/account', 'src/site/upgradeGate.js', 'src/site/integrity.js', 'shared/entitlements/catalogue.js']],
  ['pages', ['src/site/docsView.js', 'src/site/changelogData.js', 'src/site/changelogView.js', 'src/site/contactView.js', 'src/site/legalView.js', 'src/site/playerProfileView.js']],
  ['training', ['src/site/trainingView.js', 'src/site/routinesView.js', 'src/site/leaderboardsView.js', 'src/site/mapPracticeView.js', 'src/site/activityCalendarView.js', 'src/lib/gamemodeCatalog.js', 'src/lib/routines.js', 'src/lib/aim4Ratings.js', 'src/lib/coachNotes.js', 'src/lib/spinner.js', 'src/lib/accountStats.js']],
  ['demos', ['src/site/replaysView.js', 'src/site/replayViewerView.js', 'src/replays/api.js', 'src/replays/viewer', 'src/replays/stats', 'src/replays/charts', 'src/replays/performance', 'src/replays/creator', 'src/replays/shared', 'src/replays/rounds', 'src/replays/duels', 'src/replays/models']],
  ['team', ['src/site/teamView.js', 'src/site/docsEditor.js', 'src/site/docEmbeds.js', 'src/site/drawingBoard.js', 'src/site/utilityArchive.js', 'src/site/strategyCreatorView.js', 'src/site/teamComms', 'src/site/stratNoteLinks.js']],
  ['coach', ['src/replays/coach', 'src/replays/analytics', 'src/replays/strategy', 'src/replays/roles']],
  ['trainer', ['src/components', 'src/cs3d', 'src/scenarios', 'train.html']],
  ['server', ['server/entitlements', 'server/support', 'server/account', 'server/replays/routes.js', 'server/replays/identity.js', 'server/billing/routes.js']]
];

/** Staff-only, and never translated. Listed so the report can say so. */
const EXCLUDED = ['src/site/admin', 'src/site/simView.js', 'src/site/simApi.js', 'src/tools', 'src/site/pitch'];

// ---------------------------------------------------------------------------
// The keep list: strings that are shown but must stay English.
// ---------------------------------------------------------------------------

async function buildKeepList() {
  const keep = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) keep.add(v.trim());
  };
  const load = async (rel) => {
    try {
      return await import(pathToFileURL(path.join(ROOT, rel)).href);
    } catch (err) {
      console.warn(`  ! could not read ${rel} for the keep list: ${err.message}`);
      return null;
    }
  };

  /**
   * Collect one named field from anywhere in a nested structure. Used for
   * `label`, which is the name of a call or a position everywhere it appears,
   * while the `how` and `desc` fields beside it are explanations and are
   * ordinary prose that should be translated.
   */
  const collectField = (node, field, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (typeof node[field] === 'string') add(node[field]);
    for (const v of Object.values(node)) collectField(v, field, seen);
  };

  /** Every string in a structure, for tables that are nothing but names. */
  const collectStrings = (node, seen = new Set()) => {
    if (typeof node === 'string') return add(node);
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const v of Object.values(node)) collectStrings(v, seen);
  };

  // Map callouts and position names.
  const regions = await load('src/replays/roles/regionKeys.js');
  for (const group of ['T_POSITIONS', 'CT_POSITIONS', 'T_TACTICAL', 'CT_TACTICAL']) {
    collectField(regions?.[group], 'label');
    collectField(regions?.[group], 'tactical');
  }

  // teamPositions is a map of map code to a list of position names, nothing else.
  const positions = await load('src/replays/roles/teamPositions.js');
  collectStrings(positions?.POSITIONS);

  // Round library call names stay English; their descriptions do not.
  const library = await load('src/replays/analytics/roundLibrary.js');
  collectField(library?.ROUND_LIBRARY, 'label');

  // The callouts themselves. These are written as bare strings inside the
  // library's conditions rather than as a labelled field, so they are read back
  // through the accessor the library exposes for exactly this: everything a map
  // needs a region drawn for. "A Heaven" and "Banana" are what a Russian team
  // says out loud, and translating them would make the site less usable, not
  // more.
  for (const map of Object.keys(library?.ROUND_LIBRARY || {})) {
    for (const name of library?.requiredRegionNames?.(map) || []) add(name);
    for (const name of library?.requiredUtilityNames?.(map) || []) add(name);
    for (const group of library?.requiredRegionGroups?.(map) || []) {
      if (Array.isArray(group)) group.forEach(add);
    }
  }

  // Map names.
  const roundId = await load('src/replays/shared/roundId.js');
  collectField(roundId?.MAPS, 'name');

  // Deliberately NOT kept: the pace vocabulary in patternDefs.js (Rush, Pop,
  // Contact, Full exec, Default). Those describe how a round was played rather
  // than naming a place on a map, and teams do say them in their own language
  // where they say "Banana" in English. Keeping them would also have taken the
  // footer's Contact link down with them, since the keep list matches on the
  // string and cannot tell a pace call from a nav label.

  // Ranks are a ladder name, not a word.
  const ranks = await load('src/lib/aimRanks.js');
  collectField(ranks?.RANKS, 'name');

  // Weapons, brands, and the handful of things that are simply names.
  for (const s of [
    'AIM4', 'AIM4.io', 'CS2', 'CS:GO', 'Counter-Strike', 'Steam', 'Google', 'Discord', 'Paddle',
    'HLTV', 'FACEIT', 'Valve', 'Three.js', 'TeamSpeak', 'Vercel', 'Supabase', 'X',
    'AK-47', 'M4A4', 'M4A1-S', 'AWP', 'Desert Eagle', 'Glock-18', 'USP-S', 'P250', 'Five-SeveN',
    'Tec-9', 'CZ75-Auto', 'R8 Revolver', 'Dual Berettas', 'MAG-7', 'Nova', 'XM1014', 'Sawed-Off',
    'MAC-10', 'MP9', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon', 'Galil AR', 'FAMAS', 'SG 553',
    'AUG', 'SSG 08', 'G3SG1', 'SCAR-20', 'M249', 'Negev', 'Zeus x27', 'Kevlar', 'Helmet',
    'T', 'CT', 'A', 'B', 'MVP', 'HS', 'ADR', 'KAST', 'HLTV 2.0', 'Elo', 'FPS', 'ms', 'Hz'
  ]) add(s);

  return keep;
}

// ---------------------------------------------------------------------------
// Deciding what is copy
// ---------------------------------------------------------------------------

/**
 * A space-separated list of class names, e.g. "btn btn-sm" or "center lb-hint".
 *
 * The obvious test, "every word is lowercase", is wrong and was: it also
 * matches "without an account", "drag and drop" and "username and password",
 * all of which are ordinary English sitting inside a <strong> in the docs page.
 * Requiring at least one hyphenated token is what actually separates the two,
 * because this codebase's class names are kebab-cased with a module prefix and
 * English prose is not.
 */
function looksLikeClassList(t) {
  if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)+$/.test(t)) return false;
  return t.split(' ').some((w) => w.includes('-'));
}
const SLOT = /\{(?:name|n|pct|clock|money|enum:[a-z0-9_-]+)(?:#\d+)?\}/g;

function looksTechnical(t) {
  if (/^(https?:|\/\/|\/[a-z]|\.\/|\.\.\/|data:|blob:|mailto:|#[a-z-]+$)/i.test(t)) return true;
  if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(t)) return true; // mime types
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(t)) return true; // CONSTANT_CASE
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t)) return true; // camelCase identifier
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(t)) return true; // kebab / snake id
  if (looksLikeClassList(t)) return true;
  if (/^\d[\d\s.,:%+-]*$/.test(t)) return true; // pure numbers
  if (/^\s*(?:px|em|rem|vh|vw|fr|deg)\b/.test(t)) return true;

  // CSS, which arrives in bulk: selectors, selector lists, custom properties,
  // media queries and colour functions all read as words to the filters above.
  if (/^--[a-z]/i.test(t)) return true;
  if (/^[.#][A-Za-z][\w-]*(?:[[:.\s,]|$)/.test(t)) return true;
  if (/(?:^|,\s*)[.#][A-Za-z][\w-]*/.test(t)) return true;
  if (/\[[a-z-]+(?:[~^|*$]?=|\])/i.test(t)) return true; // [data-nav], [data-slot="x"]
  if (/^\(\s*(?:max|min)-(?:width|height|resolution)/i.test(t)) return true;
  if (/^(?:var|rgba?|hsla?|calc|clamp|url|translate|scale|rotate)\(/i.test(t)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return true;
  if (/^:{1,2}[a-z-]+/i.test(t)) return true; // :hover, ::before

  // HTML entities and query-string fragments.
  if (/^&(?:[a-z]+|#\d+);?$/i.test(t)) return true;
  if (/^[&?][a-z-]+=/i.test(t)) return true;
  if (/^[a-z-]+=[^\s]*$/i.test(t) && !/\s/.test(t)) return true;

  // A bare file name or extension list.
  if (/^\.[a-z0-9]{2,5}(?:\s*[,/]\s*\.[a-z0-9]{2,5})*$/i.test(t)) return true;
  // A Supabase select list, and anything addressing an endpoint.
  if (/^[a-z_]+(?:\s*,\s*[a-z_]+)+$/.test(t)) return true;
  if (/\/api\//.test(t)) return true;
  // A single token with no space is an id, a key or a selector, not copy. This
  // catches the dotted event names (`account.delete.cancel`), the short test
  // ids (`aca1`, `ack1`) and the bare selectors (`a.st-link`) that the relaxed
  // class-list rule above would otherwise let through.
  if (!/\s/.test(t) && /^[a-z][A-Za-z0-9._-]*$/.test(t)) return true;
  // A canvas font shorthand, or a regex written as a string.
  if (/var\(--/.test(t)) return true;
  if (/\[[A-Za-z0-9-]+\](?:\{\d|\+|\*|\?)/.test(t)) return true;
  if (/^[a-z_]+ \[[0-9|]+\]/i.test(t)) return true; // console-var help lines

  // Console output. These reach a developer tools pane, never a person reading
  // the site, and they arrive in bulk: 47 of them, carrying most of the em
  // dashes in the catalogue, each one dutifully copied through by eleven
  // translators. The prefix is the giveaway, because that is how every module
  // here labels its own logging.
  if (/^(?:cs3d|doors|deathmatch|sim|trainer|replay|comms|football|zones|maps|bots|agents|net|audio|perf):\s/.test(t)) return true;
  // A keyboard event code. Displayed key names ("Ctrl", "Caps") are single
  // words and stay; these are the DOM constants.
  if (/^(?:Alt|Control|Shift|Meta|Arrow|Bracket|Digit|Key|Numpad|Page|Caps|Os|Intl|Audio|Media|Launch|Browser)[A-Z0-9]/.test(t)) return true;
  // A canvas font shorthand: "600 11px system-ui, sans-serif".
  if (/^\d+(?:\.\d+)?\s+\d+(?:px|em|rem)\s/.test(t)) return true;
  if (/^\d+(?:px|em|rem)\s+[\w"']/.test(t)) return true;
  // A hex id or hash that happens to spell letters.
  if (/^[0-9a-f]{6,}$/i.test(t)) return true;
  // A comma-separated list of HTTP header names.
  if (/^[A-Z][A-Za-z]*(?:-[A-Za-z]+)+(?:\s*,\s*[A-Z][A-Za-z-]+)+$/.test(t)) return true;
  // A list of HTTP methods, for a CORS header.
  if (/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)(?:\s*,\s*(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD))+$/.test(t)) return true;
  // PascalCase with no space: a three.js material, an error class, a symbol.
  // Displayed labels are spaced ("Demo Manager"); these never are.
  if (!/\s/.test(t) && /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(t)) return true;
  // A formula written out for a tooltip, e.g. "1.00 + OPKD/100 + Swing/8".
  if (/[+*]\s*\w+\s*[+/*]|\w+\/\d+\s*[+*]/.test(t)) return true;
  // HTTP header names, and Supabase select strings.
  if (/^[A-Z][a-z]+(?:-[A-Za-z]+)+$/.test(t)) return true;
  if (/[(:,]/.test(t) && !/\s/.test(t) && t.length > 8) return true;
  // A character set written out, e.g. the code-generation alphabet.
  if (!/\s/.test(t) && t.length > 20 && /^[A-Za-z0-9]+$/.test(t)) return true;
  if (/^<[a-z]/i.test(t)) return true; // a lone opening tag
  return false;
}

/** Would a person read this on the screen? */
function isCopy(text) {
  const t = String(text).trim();
  if (t.length < 2 || t.length > 900) return false;
  const bare = t.replace(SLOT, '').trim();
  if (!/\p{L}\p{L}/u.test(bare)) return false;
  if (looksTechnical(t)) return false;
  // A single lowercase word with no slots is almost always an id or a value.
  if (!/\s/.test(bare) && /^[a-z]+$/.test(bare)) return false;
  return true;
}

/**
 * Enough fixed text that the pattern cannot match something it should not.
 *
 * A flat letter count was too blunt. What makes a pattern dangerous is not how
 * short its fixed text is, but whether it *starts* with a slot: "{name} {n}"
 * can match almost any line on the page, while "Drop {name}" can only match a
 * line that begins with the word Drop.
 *
 * That distinction matters because the strategy notes are built almost entirely
 * out of a short imperative plus a callout, which is the point of them:
 * "Drop {name}", "Lurk {name}", "Go {name}, hold {name#2}". A flat threshold of
 * eight letters threw every one of those away, and left the strategy import
 * reading in English on an otherwise translated page.
 */
function specificEnough(template) {
  const literal = template.replace(SLOT, ' ').trim();
  const letters = (literal.match(/\p{L}/gu) || []).length;
  // Anchored by a real word at the front, so a much lower bar is safe. Two
  // letters is enough of a word: "Go {name}, hold {name#2}" is the commonest
  // shape in the strategy notes and cannot match anything not starting "Go".
  if (/^\p{L}{2,}/u.test(template.trim())) return letters >= 4;
  return letters >= 8;
}

// ---------------------------------------------------------------------------
// Slot typing
// ---------------------------------------------------------------------------

const NUMERIC_EXPR =
  /\.length\b|\bMath\.(?:round|floor|ceil|abs|min|max)\b|\bNumber\(|\.toFixed\(|\bcount\b|\brounds?\b|\bkills?\b|\bdeaths?\b|\bseconds?\b|\bsecs?\b|\bindex\b|\bsize\b|\btotal\b|\bhp\b|\bdamage\b|\+ ?1\b|\bi\b/i;
const PCT_EXPR = /\bpct\b|\bpercent|\bshare\b|\bwinrate\b|\bwr\b/i;
const CLOCK_EXPR = /\bclock|\bmmss\b|\btimeText\b|\bclockAt\b|\bwhen\b/i;

function slotFor(expr, nextLiteral) {
  const e = String(expr);
  if (/^\s*$/.test(e)) return '{name}';
  if (nextLiteral.startsWith('%')) return '{pct}';
  if (PCT_EXPR.test(e)) return '{pct}';
  if (CLOCK_EXPR.test(e)) return '{clock}';
  if (NUMERIC_EXPR.test(e)) return '{n}';
  return '{name}';
}

/** How the coach's own placeholder vocabulary maps onto ours. */
const COACH_SLOTS = Object.freeze({
  player: '{name}', enemy: '{name}', teammate: '{name}', zone: '{name}',
  n: '{n}', m: '{n}', hp: '{n}', seconds: '{n}', shots: '{n}', deg: '{n}',
  speed: '{n}', missed: '{n}', hits: '{n}', delta: '{n}',
  win: '{pct}', duel: '{pct}', was: '{pct}', is: '{pct}', share: '{pct}',
  item: '{enum:item}',
  site: '{enum:site}',
  // `${Math.round(stillFar)} units` arrives as one value with the noun baked
  // in, so the noun is lifted back out into the pattern where it can be
  // translated like any other word.
  distance: '{n} units'
});

function rewriteCoachPlaceholders(text) {
  return text.replace(/\{(\w+)\}/g, (whole, key) => COACH_SLOTS[key] ?? whole);
}

// ---------------------------------------------------------------------------
// Pulling copy out of one file
// ---------------------------------------------------------------------------

const ATTR_RE = /\b(?:title|placeholder|aria-label|alt)\s*=\s*"([^"]*)"/g;
const TEXT_RE = />([^<>]{2,400})</g;

/** A template literal, with its `${…}` turned into typed slots. */
function slotted(parts, exprs) {
  let out = parts[0];
  for (let i = 0; i < exprs.length; i++) {
    out += slotFor(exprs[i], parts[i + 1] || '');
    out += parts[i + 1] ?? '';
  }
  return out;
}

/** Number repeated slot types so a translation can reorder them. */
function numberSlots(template) {
  const seen = new Map();
  return template.replace(SLOT, (tok) => {
    const inner = tok.slice(1, -1).split('#')[0];
    const k = (seen.get(inner) || 0) + 1;
    seen.set(inner, k);
    return k === 1 ? `{${inner}}` : `{${inner}#${k}}`;
  });
}

function harvestHtml(source, sink) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source))) sink(m[1]);
  TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(source))) sink(m[1]);
}

function harvestFile(file, rel, sink) {
  const src = fs.readFileSync(file, 'utf8');

  if (rel.endsWith('.html')) {
    harvestHtml(src, sink);
    return;
  }

  const isCoachCatalogue = rel.endsWith('coachMessages.js');
  for (const lit of scanLiterals(src)) {
    const raw = lit.kind === 'string' ? lit.value : slotted(lit.parts, lit.exprs);
    if (!raw) continue;
    if (raw.includes('<') && raw.includes('>')) {
      harvestHtml(raw, sink);
      // A template can be markup *and* carry a bare sentence outside any tag;
      // the text-node sweep above catches the wrapped half only.
      continue;
    }
    sink(isCoachCatalogue ? rewriteCoachPlaceholders(raw) : raw);
  }
}

// ---------------------------------------------------------------------------

function filesUnder(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
        continue;
      }
      if (!/\.(?:js|mjs|html)$/.test(e.name)) continue;
      if (/\.test\./.test(e.name)) continue;
      out.push(path.relative(ROOT, p));
    }
  })(abs);
  return out;
}

async function extract({ only } = {}) {
  const keep = await buildKeepList();
  const keepLower = new Set([...keep].map((k) => k.toLowerCase()));
  /** @type {Map<string, string>} text -> surface */
  const exact = new Map();
  /** @type {Map<string, string>} template -> surface */
  const patterns = new Map();
  const dropped = { keep: 0, vague: 0, technical: 0 };
  const seenFiles = new Set();

  for (const [surface, roots] of SURFACES) {
    if (only && surface !== only) continue;
    for (const root of roots) {
      for (const rel of filesUnder(root)) {
        if (seenFiles.has(rel)) continue;
        if (EXCLUDED.some((x) => rel.startsWith(x))) continue;
        seenFiles.add(rel);
        harvestFile(path.join(ROOT, rel), rel, (raw) => {
          const text = numberSlots(String(raw).replace(/\s+/g, ' ').trim());
          if (!text) return;
          if (!isCopy(text)) {
            dropped.technical++;
            return;
          }
          // Case-insensitively: the round library writes "A Site" and the
          // zone matchers write "a site", and both are the same callout.
          if (keep.has(text) || keepLower.has(text.toLowerCase())) {
            dropped.keep++;
            return;
          }
          if (SLOT.test(text)) {
            SLOT.lastIndex = 0;
            if (!specificEnough(text)) {
              dropped.vague++;
              return;
            }
            if (!patterns.has(text)) patterns.set(text, surface);
          } else if (!exact.has(text)) {
            exact.set(text, surface);
          }
          SLOT.lastIndex = 0;
        });
      }
    }
  }

  return { exact, patterns, keep, dropped, files: seenFiles.size };
}

function render({ exact, patterns, keep }) {
  const bySurface = (map) =>
    Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify(
    {
      _: 'GENERATED FILE. Do not edit by hand. Regenerate: node scripts/i18n-extract.mjs',
      exact: bySurface(exact),
      patterns: bySurface(patterns),
      keep: [...keep].sort()
    },
    null,
    2
  )}\n`;
}

const argv = process.argv.slice(2);
const only = argv.includes('--surface') ? argv[argv.indexOf('--surface') + 1] : null;
const result = await extract({ only });
const next = render(result);

if (argv.includes('--report')) {
  const count = (map) => {
    const per = new Map();
    for (const s of map.values()) per.set(s, (per.get(s) || 0) + 1);
    return per;
  };
  const ex = count(result.exact);
  const pa = count(result.patterns);
  console.log(`files scanned: ${result.files}`);
  console.log('surface'.padEnd(12), 'exact'.padStart(7), 'patterns'.padStart(9));
  for (const [surface] of SURFACES) {
    if (only && surface !== only) continue;
    console.log(surface.padEnd(12), String(ex.get(surface) || 0).padStart(7), String(pa.get(surface) || 0).padStart(9));
  }
  console.log('-'.repeat(30));
  console.log('total'.padEnd(12), String(result.exact.size).padStart(7), String(result.patterns.size).padStart(9));
  console.log(`kept English (callouts, names, weapons): ${result.keep.size} terms, ${result.dropped.keep} hits`);
  console.log(`dropped: ${result.dropped.technical} technical, ${result.dropped.vague} too vague to be a safe pattern`);
} else if (argv.includes('--check')) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (current !== next) {
    console.error('src/i18n/catalogue.en.json is out of date. Run: node scripts/i18n-extract.mjs');
    process.exit(1);
  }
  console.log('i18n catalogue is up to date.');
} else {
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, next);
  console.log(
    `wrote ${path.relative(ROOT, TARGET)}: ${result.exact.size} exact, ${result.patterns.size} patterns, ${result.keep.size} kept English`
  );
}
