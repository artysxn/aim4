// ---------------------------------------------------------------------------
// comms/countdown.js — finding the sync anchor in a transcript
//
// A recording and a demo have no common clock, so the recording user gives
// them one out loud. During round 1's freeze time they say:
//
//     "record, three, two, one"
//
// timed so that "three" lands when the freeze clock reads 3 seconds, "two" at
// 2, and "one" at 1. One second after "one", the round goes live — and that
// instant is a tick the demo already knows. Match the two and the whole
// session is aligned.
//
// Why three number words and not just one: each word gives an independent
// estimate of the same freeze-end moment (start of "three" + 3s, "two" + 2s,
// "one" + 1s). Taking the MEDIAN of the three survives one bad word alignment,
// which a single word cannot, and their disagreement is a free quality signal:
// three estimates within a few tens of milliseconds is a countdown, three
// estimates half a second apart is someone talking about numbers.
//
// The cue word carries the weight of avoiding false positives. Players count
// down constantly ("three, two, one, flash"), so a bare countdown is only ever
// offered as a candidate for the user to confirm, never taken automatically.
//
// Everything here works on Whisper's word-level timestamps and is pure, so the
// recorder detects with it and the viewer re-runs it to list candidates.
// ---------------------------------------------------------------------------

/** Freeze-end is this long after the word "one" is spoken. */
export const ONE_TO_LIVE_MS = 1000;
/** Nominal gap between spoken numbers. */
export const STEP_MS = 1000;
/** A countdown paced outside this window is not a countdown. */
export const MIN_SPAN_MS = 1200;
export const MAX_SPAN_MS = 3600;
/** How far the cue word may sit before "three". */
export const MAX_CUE_GAP_MS = 3000;
/** Estimates disagreeing by more than this drop the confidence hard. */
export const SPREAD_TOLERANCE_MS = 400;

/**
 * Number words for the languages the recorder supports, plus the cue.
 *
 * Several entries per number on purpose: Norwegian "one" is en / én / ett
 * depending on gender and speaker, and Whisper will produce whichever it
 * hears. Digits are included because Whisper often transcribes a spoken
 * countdown as "3, 2, 1" rather than words.
 *
 * The cue lists the English "record" for every language: the instruction the
 * user is following says that word, and a Russian or Chinese speaker reading
 * it aloud still says "record" — which Whisper then renders in the session
 * language's script, hence the transliterations.
 */
export const NUMBER_WORDS = Object.freeze({
  en: { 3: ['three', '3'], 2: ['two', '2'], 1: ['one', '1'] },
  no: { 3: ['tre', '3'], 2: ['to', '2'], 1: ['en', 'én', 'ett', '1'] },
  da: { 3: ['tre', '3'], 2: ['to', '2'], 1: ['en', 'én', 'et', '1'] },
  sv: { 3: ['tre', '3'], 2: ['tva', 'två', '2'], 1: ['ett', 'en', '1'] },
  fi: { 3: ['kolme', '3'], 2: ['kaksi', '2'], 1: ['yksi', '1'] },
  ru: { 3: ['три', '3'], 2: ['два', '2'], 1: ['один', 'раз', '1'] },
  uk: { 3: ['три', '3'], 2: ['два', '2'], 1: ['один', '1'] },
  pl: { 3: ['trzy', '3'], 2: ['dwa', '2'], 1: ['jeden', '1'] },
  ro: { 3: ['trei', '3'], 2: ['doi', '2'], 1: ['unu', 'unul', 'un', '1'] },
  fr: { 3: ['trois', '3'], 2: ['deux', '2'], 1: ['un', 'une', '1'] },
  es: { 3: ['tres', '3'], 2: ['dos', '2'], 1: ['uno', 'un', '1'] },
  pt: { 3: ['tres', 'três', '3'], 2: ['dois', 'duas', '2'], 1: ['um', 'uma', '1'] },
  zh: { 3: ['三', '3'], 2: ['二', '两', '2'], 1: ['一', '1'] }
});

/** Cue words, by language, always including the English original. */
export const CUE_WORDS = Object.freeze({
  en: ['record', 'recording'],
  no: ['record', 'opptak'],
  da: ['record', 'optagelse'],
  sv: ['record', 'inspelning'],
  fi: ['record', 'nauhoitus'],
  ru: ['record', 'рекорд', 'рекорт', 'запись'],
  uk: ['record', 'рекорд', 'запис'],
  pl: ['record', 'nagranie', 'nagrywanie'],
  ro: ['record', 'inregistrare', 'înregistrare'],
  fr: ['record', 'enregistrement'],
  es: ['record', 'grabacion', 'grabación', 'grabando'],
  pt: ['record', 'gravacao', 'gravação', 'gravando'],
  zh: ['record', '录制', '录音', '记录']
});

/**
 * Fold a token down to what matching cares about.
 *
 * Diacritics go because Whisper is inconsistent about them ("tva" / "två"),
 * and punctuation goes because a spoken countdown is transcribed with commas
 * and periods glued to the words ("three," "two." "one!").
 */
export function normalizeWord(word) {
  return String(word ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
}

/** Every spelling of one number, across every language, for loose matching. */
function wordSet(lang, n) {
  const table = NUMBER_WORDS[lang] || NUMBER_WORDS.en;
  const set = new Set((table[n] || []).map(normalizeWord));
  // A team calling in Norwegian still says "three two one" often enough that
  // refusing the English words would fail the anchor for no good reason.
  for (const w of NUMBER_WORDS.en[n]) set.add(normalizeWord(w));
  return set;
}

function cueSet(lang) {
  const set = new Set((CUE_WORDS[lang] || CUE_WORDS.en).map(normalizeWord));
  for (const w of CUE_WORDS.en) set.add(normalizeWord(w));
  return set;
}

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Find every "three, two, one" in a word stream, cued or not.
 *
 * @param {Array<{word: string, startMs: number, endMs?: number}>} words
 *        Whisper word timestamps for ONE track: the recording user's own.
 * @param {string} lang
 * @returns {Array<{anchorMs: number, cued: boolean, confidence: number,
 *                  atMs: number, spreadMs: number, text: string}>}
 *        Candidates in time order. `anchorMs` is the freeze-end moment in
 *        recording time; `atMs` is where the countdown itself starts, which is
 *        what a UI should show the user.
 */
export function findCountdowns(words, lang = 'en') {
  const list = (Array.isArray(words) ? words : [])
    .map((w) => ({
      raw: String(w?.word ?? ''),
      norm: normalizeWord(w?.word),
      startMs: Number(w?.startMs),
      endMs: Number.isFinite(w?.endMs) ? w.endMs : Number(w?.startMs)
    }))
    .filter((w) => w.norm && Number.isFinite(w.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  const threes = wordSet(lang, 3);
  const twos = wordSet(lang, 2);
  const ones = wordSet(lang, 1);
  const cues = cueSet(lang);

  const out = [];

  for (let i = 0; i < list.length; i++) {
    if (!threes.has(list[i].norm)) continue;

    // "two" and "one" must be the next matching words, allowing a filler word
    // between them ("three... uh... two") but not a whole sentence.
    const two = nextMatch(list, i + 1, twos, 2);
    if (two < 0) continue;
    const one = nextMatch(list, two + 1, ones, 2);
    if (one < 0) continue;

    const span = list[one].startMs - list[i].startMs;
    if (span < MIN_SPAN_MS || span > MAX_SPAN_MS) continue;

    // Three independent reads of the same freeze-end instant.
    const estimates = [
      list[i].startMs + 3 * STEP_MS,
      list[two].startMs + 2 * STEP_MS,
      list[one].startMs + ONE_TO_LIVE_MS
    ];
    const anchorMs = median(estimates);
    const spreadMs = Math.max(...estimates) - Math.min(...estimates);

    // Look back a few words for the cue.
    let cued = false;
    for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
      if (list[i].startMs - list[k].startMs > MAX_CUE_GAP_MS) break;
      if (cues.has(list[k].norm)) {
        cued = true;
        break;
      }
    }

    // Pacing and agreement are what separate a countdown from three numbers in
    // a sentence; the cue is what separates "sync me" from a flash count.
    const tightness = Math.max(0, 1 - spreadMs / (SPREAD_TOLERANCE_MS * 2));
    const pacing = Math.max(0, 1 - Math.abs(span - 2 * STEP_MS) / (2 * STEP_MS));
    const confidence = Math.min(1, (cued ? 0.6 : 0.25) + 0.25 * tightness + 0.15 * pacing);

    out.push({
      anchorMs: Math.round(anchorMs),
      atMs: Math.round(list[i].startMs),
      cued,
      confidence: Number(confidence.toFixed(3)),
      spreadMs: Math.round(spreadMs),
      text: [list[i], list[two], list[one]].map((w) => w.raw).join(' ')
    });

    i = one; // one countdown cannot start inside another
  }

  return out;
}

/** Index of the next word in `set` within `slack` words, or -1. */
function nextMatch(list, from, set, slack) {
  for (let k = from; k < list.length && k <= from + slack; k++) {
    if (set.has(list[k].norm)) return k;
  }
  return -1;
}

/**
 * Pick the anchor for a session.
 *
 * First cued countdown wins. The user's instruction is to say it once at the
 * start of round 1, so anything later is a different round or a coincidence —
 * and "first" is a rule a user can hold in their head, which "highest
 * confidence" is not.
 *
 * @returns {{anchorMs, confidence, cued, atMs, candidates} | null}
 */
export function pickAnchor(words, lang = 'en') {
  const candidates = findCountdowns(words, lang);
  if (!candidates.length) return null;
  const chosen = candidates.find((c) => c.cued) || null;
  if (!chosen) return { ...candidates[0], detected: false, candidates };
  return { ...chosen, detected: true, candidates };
}
