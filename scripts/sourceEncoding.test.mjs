// Run: node scripts/sourceEncoding.test.mjs
//
// Every source file is UTF-8, and none of them is DOUBLE-encoded.
//
// The second half is the one that bit: `src/components/UIOverlay.js` and
// `src/replays/viewer/radarRenderer.js` were committed with 177 runs of text
// that had been read as cp1252 and written back as UTF-8. Every em dash in
// the trainer's UI rendered as a three-character run starting with a
// circumflex A; the degree sign, the multiplication sign in the replay scrub
// bar's speed buttons, the bullets in the replay HUD and the pause glyph all
// did the same. (Examples are described rather than quoted here, because a
// literal one would be flagged by this very test.)
//
// It is worth a test rather than a fix alone for two reasons: it is invisible
// in a diff (the file is still valid UTF-8, just of the wrong characters), and
// it comes back the moment anything opens one of these files with a
// locale-default reader — which is what did it. A `git grep` for one bad
// glyph would not generalise; the byte pattern does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXTS = ['.js', '.mjs', '.html', '.css', '.md', '.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'vrf', 'sampledemos', 'simdata']);

/**
 * A UTF-8 lead byte as cp1252 renders it, followed by a continuation byte's
 * rendering. A mangled degree sign or em dash matches; a well-formed one does
 * not, because a lone accented letter is never followed by a C1 character.
 *
 * Built from code points rather than written literally, so this file cannot
 * itself be the thing that breaks — and so it does not trip its own check.
 */
const LEAD = 'Â-ßà-ïð-ô';
const CONT =
  '- -¿' +
  '€‚ƒ„…†‡ˆ‰Š‹' +
  'ŒŽ‘’“”•–—˜™' +
  'š›œžŸ';
const MOJIBAKE = new RegExp(`[${LEAD}][${CONT}]`, 'u');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (EXTS.includes(path.extname(e.name))) {
      yield path.join(dir, e.name);
    }
  }
}

let failures = 0;
let scanned = 0;
const report = (file, line, msg) => {
  failures++;
  console.error(`  FAIL ${path.relative(ROOT, file)}:${line} ${msg}`);
};

for (const file of walk(ROOT)) {
  const buf = fs.readFileSync(file);
  scanned++;

  // 1. Valid UTF-8 at all. `fatal` so a lone 0x80 is an error, not U+FFFD.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    report(file, 1, 'is not valid UTF-8');
    continue;
  }

  // 2. Not double-encoded.
  const text = buf.toString('utf8');
  if (!MOJIBAKE.test(text)) continue;
  const lines = text.split('\n');
  let shown = 0;
  for (let i = 0; i < lines.length && shown < 3; i++) {
    const m = lines[i].match(MOJIBAKE);
    if (!m) continue;
    shown++;
    const at = lines[i].indexOf(m[0]);
    const ctx = lines[i].slice(Math.max(0, at - 30), at + 20).trim();
    report(file, i + 1, `double-encoded UTF-8 ${JSON.stringify(m[0])} in ${JSON.stringify(ctx)}`);
  }
}

if (failures) {
  console.error(
    `sourceEncoding.test.mjs: ${failures} problem(s) in ${scanned} files.\n` +
      '  A file was read as cp1252 and written back as UTF-8. The repair is exact:\n' +
      "  for each run of non-ASCII characters, `run.encode('cp1252').decode('utf-8')`\n" +
      '  (falling back to the code point for anything in U+0080..U+009F, which cp1252\n' +
      '  leaves unmapped). Check the diff before committing it.'
  );
  process.exit(1);
}
console.log(`sourceEncoding.test.mjs: ok (${scanned} files)`);
