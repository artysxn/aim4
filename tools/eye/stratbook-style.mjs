#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/stratbook-style.mjs
// How the coach's stratbook notes are written, measured.
//
//   node tools/eye/stratbook-style.mjs [--json]
//
// The notes in gold/stratbook-notes.json are the style bar for the notes aim4
// eye writes from a round (src/replays/eye/eyeStrategyNotes.js). What its
// prompt says about style should be what this prints, not a guess: how long a
// note is, how a buy opens it, how times are written, which verbs and words a
// coach uses, how often the team is "we".
//
// A note written in all five columns is a team-wide call (spawn-based pistol
// rows) and is counted once, apart from the per-player notes.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS = path.join(here, 'gold', 'stratbook-notes.json');

/** The player's name a note opens with ("Kylar: K. …", "kyousuke. K. …"), when it does. */
const NAME_OPENER = /^([A-Za-z0-9][\w#-]{1,15})[:.]\s+(?=[A-Z0-9])/;
/** A buy written in stratbook letters: K, SFF, SM, SF+P250, S+HE+F, FF+Dualies, D2F. */
const BUY = /^(K|(?:[SFMD]|\d[SFMD]?|HE|P250|p250|Dualies|D)(?:\+?(?:[SFMD]|\d|HE|P250|p250|Dualies))*)(?=[.,:]\s|[.,:]?$)/;

/**
 * Every note, as { map, side, text, teamWide, name }.
 * @param {string} [file]
 */
export function readStratbookNotes(file = CORPUS) {
  const corpus = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const section of corpus.sections || []) {
    for (const row of section.strategies || []) {
      const cells = row.map((c) => String(c || '').trim());
      const filled = cells.filter(Boolean);
      const teamWide = filled.length > 1 && new Set(filled).size === 1;
      const seen = new Set();
      for (const text of cells) {
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const name = NAME_OPENER.exec(text)?.[1] || '';
        out.push({ map: section.map, side: section.side, text, teamWide, name: BUY.test(name) ? '' : name });
      }
    }
  }
  return out;
}

/** The note without its leading player name. */
export function noteBody(note) {
  return note.name ? note.text.replace(NAME_OPENER, '') : note.text;
}

const quantile = (xs, q) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0;
};

const TERMS = [
  'search', 'lurk', 'refrag', 'trade', 'entry', 'entryflash', 'antiflash', 'jumpspot', 'jiggle', 'swing', 'peek',
  'spam', 'contact', 'default', 'free role', 'exec', 'execute', 'split', 'fake', 'rush', 'slow', 'boost', 'line up',
  'pick up', 'drop', 'take bomb', 'bomb', 'hold flash', 'call', 'care', 'on flash', 'on timing', 'block', 'retake',
  'control', 'spot', 'info', 'wide', 'close', 'deep', 'break', 'resmoke', 'follow', 'followup', 'insta', 'instantly',
  'pressure', 'rotate', 'regroup', 'play for time', 'bait'
];

export function measure(notes) {
  const players = notes.filter((n) => !n.teamWide);
  const bodies = players.map(noteBody);
  const count = (re) => bodies.filter((b) => re.test(b)).length;
  const lengths = bodies.map((b) => b.length);
  const sentences = bodies.map((b) => b.split(/(?<=[.!?])\s+/).filter(Boolean).length);
  const buys = new Map();
  for (const b of bodies) {
    const m = BUY.exec(b);
    if (m) buys.set(m[1], (buys.get(m[1]) || 0) + 1);
  }
  const firstWords = new Map();
  for (const b of bodies) {
    const w = (BUY.test(b) ? b.replace(BUY, '').replace(/^[.,:]\s*/, '') : b).split(/[\s,.]+/)[0]?.toLowerCase();
    if (w) firstWords.set(w, (firstWords.get(w) || 0) + 1);
  }
  const terms = TERMS.map((t) => [t, count(new RegExp(`\\b${t.replace(/ /g, '\\s+')}`, 'i'))]).filter(([, n]) => n);
  const pct = (n) => `${Math.round((100 * n) / Math.max(1, bodies.length))}%`;
  return {
    notes: notes.length,
    perPlayer: players.length,
    teamWide: notes.length - players.length,
    named: players.filter((n) => n.name).length,
    chars: { median: quantile(lengths, 0.5), p90: quantile(lengths, 0.9), max: Math.max(...lengths) },
    sentences: { median: quantile(sentences, 0.5), p90: quantile(sentences, 0.9) },
    openWithBuy: pct([...buys.values()].reduce((a, b) => a + b, 0)),
    buys: [...buys.entries()].sort((a, b) => b[1] - a[1]),
    clocks: { dot: count(/\b[01]\.[0-5]\d\b/), colon: count(/\b[01]:[0-5]\d\b/), any: pct(count(/\b[01][.:][0-5]\d\b/)) },
    team: pct(count(/\b(we|us|our)\b/i)),
    conditional: pct(count(/\b(if|otherwise|either)\b/i)),
    lineupIds: pct(count(/\bID\s*\d+|\(\d+(?:\s*[+,&]\s*\d+)*\)/i)),
    firstWords: [...firstWords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25),
    terms: terms.sort((a, b) => b[1] - a[1])
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stats = measure(readStratbookNotes());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(stats, null, 1));
  } else {
    console.log(`${stats.notes} notes: ${stats.perPlayer} per player (${stats.named} open with the player's name), ${stats.teamWide} team-wide`);
    console.log(`length: median ${stats.chars.median} chars, 90% under ${stats.chars.p90}, longest ${stats.chars.max}; sentences median ${stats.sentences.median}, p90 ${stats.sentences.p90}`);
    console.log(`open with a buy: ${stats.openWithBuy}  ${stats.buys.map(([b, n]) => `${b} ${n}`).join(', ')}`);
    console.log(`times: in ${stats.clocks.any} of notes; ${stats.clocks.dot} notes write 1.42, ${stats.clocks.colon} write 1:42`);
    console.log(`team voice (we/us/our): ${stats.team}; if/otherwise: ${stats.conditional}; lineup ids: ${stats.lineupIds}`);
    console.log(`first words: ${stats.firstWords.map(([w, n]) => `${w} ${n}`).join(', ')}`);
    console.log(`terms: ${stats.terms.map(([w, n]) => `${w} ${n}`).join(', ')}`);
  }
}
