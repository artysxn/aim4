// ---------------------------------------------------------------------------
// replays/eye/eyeStrategyNotes.js
// The stratbook notes for a round, written by aim4 eye from what the rules
// measured, when the user's own model is running (the aim4 desktop app).
//
// The rules (strategy/roundNarrative.js) are good at measuring and bad at writing: a
// column reads as every event they matched, in their words, and a player whose
// round matched none of them reads as nothing. The model gets the same facts
// (each player's walk, holds, grenades, where the call ended) plus the rules'
// own draft, and writes the note a coach would: what that player does, in
// order, and nothing else.
//
// What the model writes is checked against the facts before it is kept, one
// column at a time:
//
//   grenade tags   <Window smoke><!g2> must be one of that player's own
//                  throws; the tag is swapped for the archive id, and any
//                  other markup becomes plain text
//   clocks         every time it prints must be a time in the facts, give or
//                  take a few seconds: an invented timing is worse than none
//   names          no player of the other team: a stratbook says what we do
//
// A column that fails keeps the rules' note, so the model can only make a
// strategy better than the rules would have, never emptier.
//
// The model runs through the same relay as the eye chat (POST /api/eye/chat).
// DOM-free apart from the two network calls, which are injectable for tests.
// ---------------------------------------------------------------------------

import { accessToken } from '../api.js';
import { MAPS } from '../shared/roundId.js';
import { clockAt } from '../strategy/roundNarrative.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

/** A clock the model prints may be this far off one in the facts. */
export const CLOCK_SLACK_SECONDS = 3;
/**
 * How far a note may step back up the clock. Two grenades "at 1:41-1:42" are
 * one moment; 1:21, 1:23, 1:25, 1:28 is a list written backwards, and so is
 * "molo site 1:29, smoke tree 1:32" (passed at 4, 22 Oct).
 */
const ORDER_SLACK_SECONDS = 2;
/** A sentence about dying, however it is put, is not part of a strategy. */
const DEATH_WORDS = /\b(dies|died|dying|death|killed|gets? (?:picked|traded)|part ends)\b/i;
/** Room for one note, inside the server's cap with the player's name in front. */
export const EYE_NOTE_CHARS = 420;
/**
 * Past this a note is a log, not a coach's line (his are a median 57
 * characters, 90% under 111): it is kept, but the repair round is asked to
 * shorten it.
 */
const NOTE_LONG_CHARS = 240;
const DESCRIPTION_CHARS = 300;
/** The whole answer is about 5 notes; past this the model has lost the format. */
const MAX_REPLY_TOKENS = 3000;
/** Giving up on the model, after which the rules' notes are saved. */
export const EYE_TIMEOUT_MS = 180_000;

/**
 * The sampling Qwen asks for when it thinks, and the effort the eye chat uses
 * (eyeAgent.js SAMPLING, REASONING_EFFORT). The app's llama-server ends the
 * reasoning itself at its budget, so a reply always gets written.
 */
const SAMPLING = {
  thinking: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
  plain: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 }
};
const REASONING_EFFORT = 'low';

/**
 * What the model is told. The style half is measured, not guessed: the
 * coach's own stratbook (tools/eye/gold/stratbook-notes.json, measured by
 * tools/eye/stratbook-style.mjs) writes a note in a median 57 characters and
 * two sentences, times only 11% of them, and opens pistol and eco rows with the
 * buy. The examples are his notes with their times written 1:45 (his 1.45) and
 * his lineup numbers taken out: here the grenade links do that job.
 */
export const STRATEGY_NOTES_PROMPT = `You write a Counter-Strike 2 team's stratbook. A strategy was taken from a recorded round, and the facts below were measured from that round. Write one note per column: that player's job when the team runs this strategy, the way the team's coach writes it.

How the coach writes:
- Short: one or two sentences, about 60 to 120 characters, never over 220. His job, not a log of every step.
- Plain orders: "Go palace.", "Smoke window, go ramp and be ready to entry.", "Molo boiler, come mid, check boiler from mid."
- A grenade is named by where it lands ("smoke window", "molo car", "flash over A") and linked with its tag: <window smoke><!g2>. Link every grenade he throws; his are the ones listed under his column. A teammate's grenade he goes in on is named with the teammate, unlinked ("go out on ropz's flash").
- On a gun round times are rare: nine in ten of the coach's notes have none. Give one only where the timing is the order (the execute's smoke or flash, when he leaves his spot to go in): "smoke jungle 1:41".
- On a pistol round time the moves: a hold he leaves gets when it ends ("hold con the first 5-10 sec", "hold A main until 1:30") and what he does next, and a push gets when ("around 1:26 push B main").
- The clock counts down from 1:55, so an earlier moment has a higher time; keep times in order. "insta" means thrown straight off spawn. "walking" in his route means he shift-walked it ("slowly shift right side water towards con").
- The coach's words for a job: go, take, hold, control, search, spot, peek, lurk, entry, refrag, trade, line up, boost, jumpspot, rush, slow, default, take bomb, plant, hold flash for, on flash, drop smoke to a teammate. "Drop" only ever means handing a grenade to a teammate.
- The team is "we": "come B with us", "go out on our flash".
- When his facts give a buy, the note opens with it exactly as given: "SFF.", "K.", "SF+P250.", then his freezetime drop as given ("Drop p250 to khaN.").
- Never write how fights went (kills, deaths, damage, who won), standing in or shooting at smokes, what the other team did, anything after his part ends, or "if" branches the round did not show. Never make up a grenade, a place or a time: use only his facts and the call's.
- A player with little in his facts still gets a note: where he plays and what he holds ("Go B. Stay B aps, be ready to search.").
- Do not start with his name or his column.

Notes from the coach's stratbook, from other rounds and maps. Copy how they are written, never their places, times or grenades:
- Go lower, search. Entry out mid on 2 flashes and commit mid to B.
- SFF. Jumpspot mid push then smoke door 1:45. Come down with us 1:35, pick up smoke and do mid to B at 1:14, then lurk short solo.
- SF+P250, drop p250 to AWP. Go lower. Come through lower to short and drop smoke for mid to B on catwalk.
- Smoke window, go ramp and be ready to entry. Path under balc.
- Hold under, line up 3 flashes. Entryflash short then 2 followups above left side.
- Take bomb. Hold bedroom from bridge until 1:30. Go out on first flash, rush long to CT to B.
- Smoke con. Pick up smoke. Come B. Do heaven smoke, molo site and 2x right flashes.
- K. Start B and peek tunnels from behind xbox. Play from behind xbox or backplat.
- Molotov and flash B tunnels, then smoke and play long range after.
- Molo off 2nd mid wall 1:45, stay close long ready to fight.
- Smoke stairs 1:40. Control B main from backsite.
- Start ruins insta holding flash. Do deep retake smoke + molo + flash after.
- K. Take p250. Stay m0NESY and hold con/mid peek first 5-10 sec. Then shift right side water towards con.
- K. Lurk outside of B Main. Around 1:26, push B Main and be ready to support.

Under each column, "Rules wrote" is what fixed rules made of the same facts: noisy and too long. Write the coach's note, not a copy.

Reply with exactly one line per column and then one description line, nothing else:
1: <note>
2: <note>
Description: <one sentence: the idea of the strategy and when to call it, naming places only as the facts name them>`;

const WHY_ENDED = {
  plant: 'the bomb was planted',
  site: 'two attackers were on the site',
  deaths: 'a side was down to two players'
};

const lower = (s) => String(s || '').toLowerCase();

/** "Smoke" + "Window" -> "smoke landing Window". */
const nadeWords = (n) => [lower(n.word), n.spot ? `landing ${n.spot}` : ''].filter(Boolean).join(' ');

/**
 * The facts as text for the model, plus what its answer is checked against.
 *
 * @param {object} args
 * @param {object} args.facts      readRoundNotes(...).facts
 * @param {string[]} args.columns  stratbook column names, one per seat
 * @param {string[]} args.seats    player id per column ('' for an empty one)
 * @param {string} args.mapCode
 * @param {string} [args.name]     the strategy's name
 * @param {string} [args.category]
 * @param {string} [args.economy]
 * @returns {{ text: string, tags: Map<string, { player: string, name: string, throwId: string, word: string, spot: string }>, clocks: Map<string, number[]> }}
 */
export function strategyFactSheet({ facts, columns, seats, mapCode, name = '', category = '', economy = '' }) {
  const players = facts?.players || new Map();
  const nameOf = (id) => players.get(id)?.name || '';
  const end = facts?.cutoff?.sec ?? facts?.window?.to ?? 115;
  /** Times anyone may write: the call's own, and every grenade of the side. */
  const shared = [facts?.window?.from ?? 0, end];

  // Tags in throw order across the side, so "g3" reads the same in every column.
  const tags = new Map();
  const tagOf = new Map();
  const all = [];
  for (const id of seats) {
    for (const n of players.get(id)?.nades || []) all.push({ id, n });
  }
  all.sort((a, b) => a.n.sec - b.n.sec);
  all.forEach(({ id, n }, i) => {
    const tag = `g${i + 1}`;
    tags.set(tag, { player: id, name: nameOf(id), throwId: n.throwId || '', word: n.word || '', spot: n.spot || '' });
    tagOf.set(n, tag);
    shared.push(n.sec);
  });

  const lines = [];
  const map = MAPS[String(mapCode || '').toUpperCase()]?.name || mapCode || '';
  const head = [name ? `Strategy "${name}"` : 'Strategy', `${map}, ${facts?.side || ''} side`, economy, category].filter(Boolean).join(', ');
  lines.push(`${head}.`);
  const callFrom = clockAt(facts?.window?.from ?? 0);
  lines.push(
    `The call runs from ${callFrom} to ${clockAt(end)}${facts?.cutoff ? `, where it ends because ${WHY_ENDED[facts.cutoff.why] || 'the round broke open'}` : ''}.`
  );
  if (facts?.exec) {
    lines.push(`The execute (the burst of utility) is ${clockAt(facts.exec.from)} to ${clockAt(facts.exec.to)}.`);
    shared.push(facts.exec.from, facts.exec.to);
  }
  if (facts?.plant && facts.plant.sec <= end + 0.5) {
    const by = nameOf(facts.plant.player);
    lines.push(`The bomb is planted on ${facts.plant.site || 'the site'} at ${clockAt(facts.plant.sec)}${by ? ` by ${by}` : ''}.`);
    shared.push(facts.plant.sec);
  }
  if (facts?.firstIn && nameOf(facts.firstIn.id)) {
    lines.push(`First onto the site: ${nameOf(facts.firstIn.id)} at ${clockAt(facts.firstIn.sec)}${facts.firstIn.zone ? ` (${facts.firstIn.zone})` : ''}.`);
    shared.push(facts.firstIn.sec);
  }

  const clocks = new Map();
  seats.forEach((id, i) => {
    lines.push('');
    const p = players.get(id);
    if (!id || !p) {
      lines.push(`${i + 1}. ${columns[i] || `Column ${i + 1}`}: nobody`);
      return;
    }
    const own = [];
    lines.push(`${i + 1}. ${columns[i] || `Column ${i + 1}`}: ${p.name}`);
    if (p.buy) lines.push(`  Buy: ${p.buy}`);
    if (p.handed?.length) lines.push(`  Freezetime: ${p.handed.join(' ')}`);
    if (p.route.length) {
      const walk = (r) => (r.walkFrom == null ? '' : r.walkFrom - r.from < 2 ? ' walking' : `, walking from ${clockAt(r.walkFrom)}`);
      const step = (r) => `${r.zone}${r.position && r.position !== r.zone ? ` (${r.position})` : ''} ${clockAt(r.from)}${walk(r)}`;
      lines.push(`  Route: ${p.route.map(step).join('; ')}`);
      for (const r of p.route) own.push(r.from, r.to, ...(r.walkFrom == null ? [] : [r.walkFrom]));
    }
    if (p.holds.length) {
      lines.push(`  Holds: ${p.holds.map((h) => `${h.position} ${clockAt(h.from)} to ${clockAt(h.to)}${h.aim ? `, watching ${h.aim}` : ''}`).join('; ')}`);
      for (const h of p.holds) own.push(h.from, h.to);
    }
    if (p.nades.length) {
      const said = p.nades.map((n) => {
        const bits = [`${tagOf.get(n)} ${nadeWords(n)}`, `thrown ${n.insta ? 'insta' : clockAt(n.sec)}`];
        if (n.from) bits.push(`from ${n.from}`);
        if (n.lineup) bits.push(`lined up on ${n.lineup}`);
        if (n.synced) bits.push(n.synced);
        return bits.join(', ');
      });
      lines.push(`  Grenades: ${said.join('; ')}`);
    }
    const jobs = [];
    if (p.bomb) jobs.push('carries the bomb out of spawn');
    if (facts?.plant && facts.plant.player === id && facts.plant.sec <= end + 0.5) jobs.push(`plants on ${facts.plant.site || 'the site'} at ${clockAt(facts.plant.sec)}`);
    if (jobs.length) lines.push(`  Job: ${jobs.join(', ')}`);
    if (p.died != null && p.died < end) {
      lines.push(`  His facts stop at ${clockAt(p.died)}, where he died: write nothing after it, and do not mention it`);
      own.push(p.died);
    }
    // The rules' draft, with archive ids swapped for this sheet's tags.
    const draft = String(p.note || '').replace(/<!([A-Za-z0-9]{4})>/g, (whole, throwId) => {
      const hit = p.nades.find((n) => n.throwId === throwId);
      return hit ? `<!${tagOf.get(hit)}>` : whole;
    });
    lines.push(`  Rules wrote: ${draft || '(nothing)'}`);
    // Every clock the draft printed is a measured one too ("Stay Chair until 1:21").
    for (const m of draft.matchAll(/\b(\d):(\d\d)\b/g)) own.push(115 - (Number(m[1]) * 60 + Number(m[2])));
    clocks.set(id, [...own, ...shared]);
  });

  return { text: lines.join('\n'), tags, clocks };
}

/**
 * The model's lines, by column number, and its description.
 *
 * Read loosely: "1:", "1.", "Column 1 -", bullets and bold all happen. The
 * note itself is whatever follows, minus a column or name it was told not to
 * repeat.
 *
 * @returns {{ byColumn: Map<number, string>, description: string }}
 */
export function parseEyeNotes(reply, columnCount) {
  const byColumn = new Map();
  let description = '';
  for (const raw of String(reply || '').split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^[\s\-*•]+/, '').trim();
    if (!line) continue;
    const d = /^description\s*[:.-]\s*(.+)$/i.exec(line);
    if (d) {
      description = d[1].trim();
      continue;
    }
    // "1: …" but not a clock: "1:45 smoke …" is a note that lost its number.
    const m = /^(?:column\s*)?(\d{1,2})\s*(?:[:.)]|-|–)(?!\d\d)\s*(.*)$/i.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > columnCount || byColumn.has(n)) continue;
    byColumn.set(n, m[2].trim());
  }
  return { byColumn, description };
}

/**
 * One column's note, made safe and checked, or the reason it is not kept.
 *
 * @param {string} raw
 * @param {object} args
 * @param {string} args.playerId
 * @param {string} args.name          the player's name, which opens a stratbook note
 * @param {string} [args.column]      the column name, stripped if the model repeated it
 * @param {Map<string, { player: string, name: string, throwId: string, word?: string, spot?: string }>} args.tags
 * @param {number[]} args.clocks      seconds the note may print, give or take the slack
 * @param {string[]} [args.enemyNames]
 * @param {string} [args.buy]         his buy in stratbook letters, or '' when the note opens with none
 * @param {string[]} [args.handed]    his freezetime drops, as the rules word them ("Drop p250 to khaN.")
 * @param {boolean} [args.timed]      a pistol round where he held and moved on: the note needs its times
 * @returns {{ ok: boolean, text: string, why: string, linked: number, missing: string[], long?: boolean }}
 *   `missing` lists his grenades the note never linked ("g7 smoke landing Kitchen"),
 *   and `long` marks a note past a coach's length: the note is still good, and
 *   the repair round is asked to fix both
 */
export function finishEyeNote(raw, { playerId, name, column = '', tags, clocks, enemyNames = [], buy = '', handed = [], timed = false }) {
  let text = String(raw || '')
    .trim()
    // The coach writes his times 1.42; here they are 1:42, and checked as such.
    .replace(/\b([01])\.([0-5]\d)\b/g, '$1:$2')
    // His lineup numbers ("(ID 110)", "ID 117 118", "(97, 98)") belong to his
    // archive, not this team's: the links are what point at a throw here.
    .replace(/\s*\(\s*(?:IDs?\s*)?\d+(?:\s*(?:[+,&]|and)\s*\d+)*\s*\)/gi, '')
    .replace(/\s*\bIDs?\s*\d+(?:\s*(?:[+,&]|and)?\s*\d+)*/gi, '');
  // A column or a name it was told not to repeat: "A Lurk (ropz): …", "ropz: …".
  for (const lead of [column && name ? `${column} (${name})` : '', name, column].filter(Boolean)) {
    const esc = escapeRe(lead);
    text = text.replace(new RegExp(`^${esc}\\s*[:\\-–]\\s*`, 'i'), '');
  }
  // The buy that opens a note is his loadout's, never the model's: without
  // thinking it wrote "SFF." on every column of a full buy (22 Oct). Wrong is
  // replaced, made up is removed, and a missing one is put back.
  const opener = BUY_OPENER.exec(text);
  if (opener) text = text.slice(opener[0].length);
  if (buy && text) text = `${buy}. ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  // His freezetime drop is a fact like his buy: if the model left it out, it
  // goes straight after the buy ("SF+P250. Drop p250 to khaN. …").
  const unsaid = handed.filter((h) => {
    const [verb, item] = h.split(/\s+/);
    return !new RegExp(`\\b${escapeRe(verb)}\\s+(?:the\\s+|his\\s+|a\\s+)?${escapeRe(item)}\\b`, 'i').test(text);
  });
  if (unsaid.length && text) {
    text = buy ? `${buy}. ${unsaid.join(' ')} ${text.slice(buy.length + 2)}` : `${unsaid.join(' ')} ${text}`;
  }
  if (!text) return { ok: false, text: '', why: 'no note', linked: 0, missing: [] };

  let foreign = 0;
  // Links first, each to that player's own throw, parked out of the way; then
  // every other bit of markup becomes its text, and a bare <!id> goes, so no
  // note can link a throw the archive does not hold for him.
  const kept = [];
  const linkedIds = new Set();
  const park = (label, throwId) => {
    kept.push(`<${label.trim()}><!${throwId}>`);
    linkedIds.add(throwId);
    return `\u0000${kept.length - 1}\u0000`;
  };
  // A label never starts with "!": "<!g6><!g6>" is two bare tags, not a link.
  text = text.replace(/<([^<>!][^<>]*)><!([A-Za-z0-9_-]+)>/g, (whole, label, tag, at, all) => {
    const hit = tags.get(tag);
    if (!hit || hit.player !== playerId) {
      // A teammate's grenade is fine to go in behind ("on <Con flash><!g4> from
      // ropz"), never to throw: one named without its thrower nearby was given
      // to the wrong man.
      const near = all.slice(Math.max(0, at - 40), at + whole.length + 40).toLowerCase();
      if (hit && !(hit.name && near.includes(hit.name.toLowerCase()))) foreign++;
      return label;
    }
    return hit.throwId ? park(label, hit.throwId) : label;
  });
  text = text.replace(/<![^<>]*>/g, '').replace(/<([^<>]*)>/g, '$1').replace(/[<>]/g, '');

  // His grenades named in plain words ("smoke Kitchen", "the Kitchen smoke")
  // are linked here: a stratbook link is the click that shows the lineup.
  const own = [...tags.entries()].filter(([, t]) => t.player === playerId && t.throwId);
  for (const [, t] of own) {
    if (linkedIds.has(t.throwId) || !t.spot || !NADE_SAID[t.word]) continue;
    const kind = NADE_SAID[t.word];
    const spot = escapeRe(t.spot);
    const said = new RegExp(`\\b(?:${kind})\\s+(?:on\\s+|into\\s+|to\\s+|at\\s+)?${spot}\\b|\\b${spot}\\s+(?:${kind})\\b`, 'i');
    text = text.replace(said, (words) => park(words, t.throwId));
  }
  // A death said another way ("Part ends at 1:22", "dies in Jungle") is not
  // an instruction: the sentence goes, the rest of the note stays.
  text = text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !DEATH_WORDS.test(s))
    .join(' ')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, '-');
  // The links that are still in the note after all that, then the note itself.
  const left = [...text.matchAll(/\u0000(\d+)\u0000/g)].map((m) => kept[Number(m[1])]);
  const linkedNow = new Set(left.map((l) => /<!([A-Za-z0-9]+)>$/.exec(l)?.[1]));
  text = text
    .replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)])
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .trim();
  const linked = left.length;
  const said = [];
  const named = new Set();
  for (const [tag, t] of own) {
    if (linkedNow.has(t.throwId) || named.has(t.throwId)) continue;
    named.add(t.throwId);
    said.push(`${tag} ${lower(t.word)}${t.spot ? ` landing ${t.spot}` : ''}`);
  }
  const refuse = (why) => ({ ok: false, text, why, linked, missing: said });
  if (!text) return { ok: false, text: '', why: 'no note', linked: 0, missing: [] };
  if (foreign) return refuse('a grenade another player throws');

  let latest = -Infinity;
  let latestClock = '';
  for (const m of text.matchAll(/\b(\d):(\d\d)\b/g)) {
    const sec = 115 - (Number(m[1]) * 60 + Number(m[2]));
    if (!clocks.some((c) => Math.abs(c - sec) <= CLOCK_SLACK_SECONDS)) return refuse(`${m[0]} is not a time in his facts`);
    // The clock counts down: a note read in order never climbs back up it.
    if (sec < latest - ORDER_SLACK_SECONDS) return refuse(`the times go backwards (${latestClock} before ${m[0]})`);
    if (sec > latest) {
      latest = sec;
      latestClock = m[0];
    }
  }
  for (const enemy of enemyNames) {
    const who = String(enemy || '').trim();
    if (who.length < 2) continue;
    // Short names only as written: "jL" is a player, "JL" could be anything.
    if (new RegExp(`(^|[^\\w])${escapeRe(who)}($|[^\\w])`, who.length < 4 ? '' : 'i').test(text)) return refuse('names the other team');
  }

  const long = text.length > NOTE_LONG_CHARS;
  // A pistol column with holds and no time at all is the note the coach sent back: "pistol rounds require timings".
  const untimed = timed && !/\b\d:\d\d\b/.test(text);
  if (text.length > EYE_NOTE_CHARS) text = `${text.slice(0, EYE_NOTE_CHARS - 1).trimEnd()}…`;
  return { ok: true, text: name ? `${name}: ${text}` : text, why: '', linked, missing: said, long, untimed };
}

/** A buy in stratbook letters at the start of a note: "SFF. ", "K+HE. ", "KSF+Tec9, ". */
const BUY_OPENER = /^(?:[KSMDF]{1,6}(?:\+(?:HE|P250|Tec9))*|(?:HE|P250|Tec9)(?:\+(?:HE|P250|Tec9))*)(?:[.,:]\s+|[.,:]$)/;

/** How a note may name each grenade type in plain words. */
const NADE_SAID = {
  Smoke: 'smokes?',
  Flash: 'flash(?:bang)?(?:es)?|pop ?flash(?:es)?',
  Molo: 'molos?|molotovs?|incendiar(?:y|ies)|incs?',
  Nade: 'nades?|HEs?|grenades?'
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "aim4 eye: 2 of 5 notes…" while the answer streams in. */
function progressText(soFar, columnCount) {
  const done = parseEyeNotes(soFar, columnCount).byColumn.size;
  return done ? `aim4 eye is writing the notes: ${Math.min(done, columnCount)} of ${columnCount}…` : 'aim4 eye is reading the round…';
}

/**
 * Write the stratbook notes with aim4 eye.
 *
 * @param {object} args
 * @param {object} args.facts      readRoundNotes(...).facts
 * @param {Map<string, string>} args.notes  the rules' notes, the fallback per column
 * @param {string[]} args.seats
 * @param {string[]} args.columns
 * @param {object} args.meta       round meta, for the other team's names
 * @param {string} args.mapCode
 * @param {string} [args.name]
 * @param {string} [args.category]
 * @param {string} [args.economy]
 * @param {(text: string) => void} [args.onStatus]
 * @param {AbortSignal} [args.signal]
 * @param {typeof askEye} [args.ask]
 * @returns {Promise<{ notes: Map<string, string>, description: string, fromEye: number, fellBack: Array<{ column: string, why: string }>, linked: number }>}
 */
export async function writeNotesWithEye({
  facts,
  notes,
  seats,
  columns = [],
  meta,
  mapCode,
  name = '',
  category = '',
  economy = '',
  onStatus = () => {},
  signal,
  ask = askEye
}) {
  const sheet = strategyFactSheet({ facts, columns, seats, mapCode, name, category, economy });
  const ours = new Set(seats.filter(Boolean));
  for (const id of facts?.players?.keys?.() || []) ours.add(id);
  const enemyNames = (meta?.players || []).filter((p) => !ours.has(p.id) && sideOf(meta, p) !== facts?.side).map((p) => p.name || '');

  onStatus('aim4 eye is reading the round…');
  const messages = [
    { role: 'system', content: STRATEGY_NOTES_PROMPT },
    { role: 'user', content: sheet.text }
  ];
  let reply = await ask(messages, { signal, onText: (soFar) => onStatus(progressText(soFar, seats.length)) });
  let parsed = parseEyeNotes(reply, seats.length);
  // A reply that spent everything on thinking and wrote nothing (one in eight
  // on 22 Oct, at the app's reasoning budget) is asked again without it.
  if (!parsed.byColumn.size) {
    onStatus('aim4 eye is writing the notes again…');
    reply = await ask(messages, { signal, thinking: false, onText: (soFar) => onStatus(progressText(soFar, seats.length)) });
    parsed = parseEyeNotes(reply, seats.length);
  }
  if (!parsed.byColumn.size) throw new Error('aim4 eye did not write the notes in the shape asked for.');

  const check = (i, raw) =>
    finishEyeNote(raw, {
      playerId: seats[i],
      name: facts?.players?.get(seats[i])?.name || '',
      column: columns[i] || '',
      tags: sheet.tags,
      clocks: sheet.clocks.get(seats[i]) || [],
      enemyNames,
      buy: facts?.players?.get(seats[i])?.buy || '',
      handed: facts?.players?.get(seats[i])?.handed || [],
      timed: economy === 'Pistol' && (facts?.players?.get(seats[i])?.holds || []).length > 0
    });
  const results = seats.map((id, i) => (id ? check(i, parsed.byColumn.get(i + 1) || '') : null));

  // One quick repair. The lines that failed a check, left some of his grenades
  // unlinked or ran long, go back with what was wrong, and only those are asked
  // for again, without thinking: the facts are already read, and a slip like a
  // backwards list is a mechanical fix. A note that failed and fails again
  // keeps the rules' note; one that was only short of links or too long keeps
  // the better of its two versions.
  const broken = results.map((r, i) => (r && (!r.ok || r.missing.length || r.long || r.untimed) ? i : -1)).filter((i) => i >= 0);
  if (broken.length) {
    onStatus(`aim4 eye is fixing ${broken.length === 1 ? 'one note' : `${broken.length} notes`}…`);
    const problems = broken
      .map((i) => {
        const r = results[i];
        const asks = [];
        if (!r.ok) asks.push(`${r.why}. ${fixHint(r.why)}`);
        if (r.missing.length) asks.push(`Link every grenade he throws with its tag: ${r.missing.join(', ')}.`);
        if (r.long) asks.push('Too long: keep it to one or two short sentences, about 60 to 120 characters, still linking his grenades.');
        if (r.untimed) asks.push('Pistol round: time it. Say when each hold ends and when he moves on, with the times in his facts ("hold krimz until 1:29, then shift to water").');
        return `${i + 1}: ${asks.join(' ')}`;
      })
      .join('\n');
    try {
      const again = await ask(
        [
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: `These lines need fixing:\n${problems}\nWrite only those lines again, in the same format, and nothing else.` }
        ],
        { signal, thinking: false }
      );
      const fixed = parseEyeNotes(again, seats.length);
      for (const i of broken) {
        const raw = fixed.byColumn.get(i + 1);
        if (!raw) continue;
        const was = results[i];
        const r = check(i, raw);
        // Better means: it passes where the first did not, or it links more of
        // his grenades, or it links as many and is no longer too long or untimed.
        const better =
          r.ok &&
          (!was.ok ||
            r.missing.length < was.missing.length ||
            (r.missing.length === was.missing.length && ((was.long && !r.long) || (was.untimed && !r.untimed))));
        if (better) results[i] = r;
        else if (!was.ok) results[i] = { ...was, why: `${was.why}, twice` };
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }

  const out = new Map();
  const fellBack = [];
  let fromEye = 0;
  let linked = 0;
  seats.forEach((id, i) => {
    if (!id) return;
    const done = results[i];
    if (done.ok) {
      out.set(id, done.text);
      fromEye++;
      linked += done.linked;
    } else {
      out.set(id, notes.get(id) || '');
      fellBack.push({ column: columns[i] || `Column ${i + 1}`, why: done.why });
    }
  });
  const description = parsed.description
    .replace(/<![^<>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/[—–]/g, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { notes: out, description: description.slice(0, DESCRIPTION_CHARS), fromEye, fellBack, linked };
}

/** What to do about a failed check, said to the model in the repair round. */
function fixHint(why) {
  if (/backwards/.test(why)) return 'Keep time order: the clock counts down, so each time you write is lower than the one before.';
  if (/not a time/.test(why)) return 'Use only times from his facts, or leave the time out.';
  if (/another player/.test(why)) return 'Link only his own grenades; a teammate\'s is named with the teammate, unlinked.';
  if (/other team/.test(why)) return "Do not name the other team's players.";
  return 'Write his note from his facts.';
}

function sideOf(meta, p) {
  const side1 = meta?.team1Side === 'CT' ? 'CT' : 'T';
  const side2 = meta?.team2Side === 'CT' || meta?.team2Side === 'T' ? meta.team2Side : side1 === 'CT' ? 'T' : 'CT';
  return p.team === 1 ? side1 : p.team === 2 ? side2 : '';
}

// ---- the network ------------------------------------------------------------

async function authHeaders() {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Is aim4 eye up for this account: the desktop app connected and its model
 * loaded? Asked with a short timeout, because the answer decides who writes
 * the notes and a slow "no" should not hold up the save.
 *
 * `usable` counts a model that is busy answering a chat: the app's server
 * takes one request at a time and queues the next, so the notes wait their
 * turn instead of falling back to the rules.
 *
 * @returns {Promise<{ ready: boolean, usable: boolean, state: string }>}
 */
export async function eyeReady({ timeoutMs = 2500 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/eye/status`, { headers: await authHeaders(), signal: ctrl.signal });
    if (!res.ok) return { ready: false, usable: false, state: '' };
    const s = await res.json();
    const busy = (s.devices || []).some((d) => d.state === 'busy');
    return { ready: Boolean(s.ready), usable: Boolean(s.ready) || busy, state: String(s.devices?.[0]?.state || (s.online ? 'online' : 'offline')) };
  } catch {
    return { ready: false, usable: false, state: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One answer from the model, streamed through the relay, no tools.
 *
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ signal?: AbortSignal, onText?: (soFar: string) => void, timeoutMs?: number, thinking?: boolean }} [opts]
 *   `thinking: false` for a mechanical fix, where planning first only costs time
 * @returns {Promise<string>} the answer's text
 */
export async function askEye(messages, { signal, onText, timeoutMs = EYE_TIMEOUT_MS, thinking = true } = {}) {
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (signal?.aborted) inner.abort();
  else signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/eye/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        messages,
        ...(thinking ? SAMPLING.thinking : SAMPLING.plain),
        max_tokens: MAX_REPLY_TOKENS,
        chat_template_kwargs: { enable_thinking: thinking, ...(thinking ? { reasoning_effort: REASONING_EFFORT } : {}) }
      }),
      signal: inner.signal
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `aim4 eye could not answer (${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let type = 'message';
        let data = '';
        for (const line of event.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data || data === '[DONE]') continue;
        if (type === 'error') throw new Error(JSON.parse(data).error || 'aim4 eye failed.');
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) {
          content += text;
          onText?.(content);
        }
      }
    }
    return content;
  } catch (err) {
    if (inner.signal.aborted && !signal?.aborted) throw new Error('aim4 eye took too long.');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
