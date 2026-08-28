//! Finding the sync anchor in a transcript.
//!
//! A port of the site's `shared/comms/countdown.js`. That file is the
//! specification and its test vectors are the acceptance criteria: the two
//! implementations must agree, because the recorder writes the anchor and the
//! viewer re-derives candidates from the same transcript when the recorder
//! could not find one. If they disagreed, a file would sync differently
//! depending on which half you asked.
//!
//! The protocol: during round 1's freeze time the recording user says
//!
//! ```text
//! record, three, two, one
//! ```
//!
//! with "three" on the freeze clock's 3, "two" on 2, "one" on 1. One second
//! after "one" the round goes live, and that instant is a tick the demo knows.
//!
//! Three numbers rather than one because each gives an independent estimate of
//! the same instant. The MEDIAN of the three survives one bad word alignment,
//! which a single word cannot, and their spread is a free quality signal.
//!
//! The cue word carries the weight of avoiding false positives: players count
//! down constantly ("three, two, one, flash"), so an uncued countdown is only
//! ever offered as a candidate, never taken automatically.

use unicode_normalization::UnicodeNormalization;

/// Freeze-end is this long after the word "one" is spoken.
pub const ONE_TO_LIVE_MS: i64 = 1000;
/// Nominal gap between spoken numbers.
pub const STEP_MS: i64 = 1000;
/// A countdown paced outside this window is not a countdown.
pub const MIN_SPAN_MS: i64 = 1200;
pub const MAX_SPAN_MS: i64 = 3600;
/// How far the cue word may sit before "three".
pub const MAX_CUE_GAP_MS: i64 = 3000;
/// Estimates disagreeing by more than this drop the confidence hard.
pub const SPREAD_TOLERANCE_MS: f64 = 400.0;

/// One word with the time it starts, as Whisper reports it.
#[derive(Debug, Clone)]
pub struct Word {
    pub word: String,
    pub start_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// Freeze-end in recording time: what the site anchors against.
    pub anchor_ms: i64,
    /// Where the countdown itself starts, which is what a UI should show.
    pub at_ms: i64,
    pub cued: bool,
    pub confidence: f64,
    pub spread_ms: i64,
    pub text: String,
}

/// Number words per language, plus the English fallback that is always allowed.
///
/// Several spellings per number on purpose: Norwegian "one" is en / én / ett
/// depending on gender and speaker, and Whisper produces whichever it hears.
/// Digits are included because a spoken countdown is often transcribed "3, 2, 1".
fn number_words(lang: &str, n: u8) -> Vec<&'static str> {
    let table: &[(&str, [&[&str]; 3])] = &[
        ("en", [&["three", "3"], &["two", "2"], &["one", "1"]]),
        ("no", [&["tre", "3"], &["to", "2"], &["en", "én", "ett", "1"]]),
        ("da", [&["tre", "3"], &["to", "2"], &["en", "én", "et", "1"]]),
        ("sv", [&["tre", "3"], &["tva", "två", "2"], &["ett", "en", "1"]]),
        ("fi", [&["kolme", "3"], &["kaksi", "2"], &["yksi", "1"]]),
        ("ru", [&["три", "3"], &["два", "2"], &["один", "раз", "1"]]),
        ("uk", [&["три", "3"], &["два", "2"], &["один", "1"]]),
        ("pl", [&["trzy", "3"], &["dwa", "2"], &["jeden", "1"]]),
        ("ro", [&["trei", "3"], &["doi", "2"], &["unu", "unul", "un", "1"]]),
        ("fr", [&["trois", "3"], &["deux", "2"], &["un", "une", "1"]]),
        ("es", [&["tres", "3"], &["dos", "2"], &["uno", "un", "1"]]),
        ("pt", [&["tres", "três", "3"], &["dois", "duas", "2"], &["um", "uma", "1"]]),
        ("zh", [&["三", "3"], &["二", "两", "2"], &["一", "1"]]),
    ];
    let idx = (3 - n) as usize; // n = 3 -> 0, 2 -> 1, 1 -> 2
    let mut out: Vec<&'static str> = table
        .iter()
        .find(|(code, _)| *code == lang)
        .map(|(_, sets)| sets[idx].to_vec())
        .unwrap_or_default();
    // A team calling in Norwegian still says "three two one" often enough that
    // refusing the English words would fail the anchor for no good reason.
    let english = table[0].1[idx];
    for w in english {
        if !out.contains(w) {
            out.push(w);
        }
    }
    out
}

/// Cue words, always including the English original.
///
/// The instruction a user follows says "record", and a Russian or Chinese
/// speaker reading it aloud still says "record" — which Whisper then renders
/// in the session language's script, hence the transliterations.
fn cue_words(lang: &str) -> Vec<&'static str> {
    let table: &[(&str, &[&str])] = &[
        ("en", &["record", "recording"]),
        ("no", &["record", "opptak"]),
        ("da", &["record", "optagelse"]),
        ("sv", &["record", "inspelning"]),
        ("fi", &["record", "nauhoitus"]),
        ("ru", &["record", "рекорд", "рекорт", "запись"]),
        ("uk", &["record", "рекорд", "запис"]),
        ("pl", &["record", "nagranie", "nagrywanie"]),
        ("ro", &["record", "inregistrare", "înregistrare"]),
        ("fr", &["record", "enregistrement"]),
        ("es", &["record", "grabacion", "grabación", "grabando"]),
        ("pt", &["record", "gravacao", "gravação", "gravando"]),
        ("zh", &["record", "录制", "录音", "记录"]),
    ];
    let mut out: Vec<&'static str> = table
        .iter()
        .find(|(code, _)| *code == lang)
        .map(|(_, w)| w.to_vec())
        .unwrap_or_default();
    for w in ["record", "recording"] {
        if !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// Fold a token down to what matching cares about.
///
/// Diacritics go because Whisper is inconsistent about them; punctuation goes
/// because a spoken countdown arrives with commas and periods glued on
/// ("three," "two." "one!").
pub fn normalize_word(word: &str) -> String {
    word.to_lowercase()
        .nfd()
        // Strip combining marks, the same range the JavaScript removes.
        .filter(|c| !matches!(*c as u32, 0x0300..=0x036f))
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn matches_any(norm: &str, set: &[&str]) -> bool {
    set.iter().any(|w| normalize_word(w) == norm)
}

/// Index of the next word in `set` within `slack` words, or None.
fn next_match(words: &[(String, i64, String)], from: usize, set: &[&str], slack: usize) -> Option<usize> {
    let end = (from + slack).min(words.len().saturating_sub(1));
    (from..=end).find(|&k| k < words.len() && matches_any(&words[k].2, set))
}

fn median3(mut v: [f64; 3]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[1]
}

/// Every "three, two, one" in a word stream, cued or not, in time order.
///
/// `words` is Whisper's word timings for ONE track: the recording user's own.
pub fn find_countdowns(words: &[Word], lang: &str) -> Vec<Candidate> {
    let mut list: Vec<(String, i64, String)> = words
        .iter()
        .map(|w| (w.word.clone(), w.start_ms, normalize_word(&w.word)))
        .filter(|(_, _, norm)| !norm.is_empty())
        .collect();
    list.sort_by_key(|(_, start, _)| *start);

    let threes = number_words(lang, 3);
    let twos = number_words(lang, 2);
    let ones = number_words(lang, 1);
    let cues = cue_words(lang);

    let mut out = Vec::new();
    let mut i = 0usize;
    while i < list.len() {
        if !matches_any(&list[i].2, &threes) {
            i += 1;
            continue;
        }
        // "two" and "one" must follow soon, allowing a filler word between
        // ("three... uh... two") but not a whole sentence.
        let two = match next_match(&list, i + 1, &twos, 2) {
            Some(k) => k,
            None => {
                i += 1;
                continue;
            }
        };
        let one = match next_match(&list, two + 1, &ones, 2) {
            Some(k) => k,
            None => {
                i += 1;
                continue;
            }
        };

        let span = list[one].1 - list[i].1;
        if !(MIN_SPAN_MS..=MAX_SPAN_MS).contains(&span) {
            i += 1;
            continue;
        }

        // Three independent reads of the same freeze-end instant.
        let estimates = [
            (list[i].1 + 3 * STEP_MS) as f64,
            (list[two].1 + 2 * STEP_MS) as f64,
            (list[one].1 + ONE_TO_LIVE_MS) as f64,
        ];
        let anchor = median3(estimates);
        let spread = estimates.iter().cloned().fold(f64::MIN, f64::max)
            - estimates.iter().cloned().fold(f64::MAX, f64::min);

        // Look back a few words for the cue.
        let mut cued = false;
        let mut k = i;
        while k > 0 && i - k < 4 {
            k -= 1;
            if list[i].1 - list[k].1 > MAX_CUE_GAP_MS {
                break;
            }
            if matches_any(&list[k].2, &cues) {
                cued = true;
                break;
            }
        }

        // Pacing and agreement separate a countdown from three numbers in a
        // sentence; the cue separates "sync me" from a flash count.
        let tightness = (1.0 - spread / (SPREAD_TOLERANCE_MS * 2.0)).max(0.0);
        let pacing = (1.0 - ((span - 2 * STEP_MS) as f64).abs() / (2.0 * STEP_MS as f64)).max(0.0);
        let confidence =
            ((if cued { 0.6 } else { 0.25 }) + 0.25 * tightness + 0.15 * pacing).min(1.0);

        out.push(Candidate {
            anchor_ms: anchor.round() as i64,
            at_ms: list[i].1,
            cued,
            confidence: (confidence * 1000.0).round() / 1000.0,
            spread_ms: spread.round() as i64,
            text: format!("{} {} {}", list[i].0, list[two].0, list[one].0),
        });

        i = one + 1; // one countdown cannot start inside another
    }

    out
}

#[derive(Debug, Clone)]
pub struct Anchor {
    pub chosen: Candidate,
    /// True when a CUED countdown was found, meaning it can be used as-is.
    pub detected: bool,
    pub candidates: Vec<Candidate>,
}

/// Pick the anchor for a session.
///
/// First cued countdown wins. The instruction is to say it once at the start
/// of round 1, so anything later is a different round or a coincidence, and
/// "first" is a rule a user can hold in their head where "highest confidence"
/// is not.
pub fn pick_anchor(words: &[Word], lang: &str) -> Option<Anchor> {
    let candidates = find_countdowns(words, lang);
    let first = candidates.first()?.clone();
    match candidates.iter().find(|c| c.cued) {
        Some(cued) => Some(Anchor {
            chosen: cued.clone(),
            detected: true,
            candidates,
        }),
        None => Some(Anchor {
            chosen: first,
            detected: false,
            candidates,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A word stream on an exact one-second grid, like the JS test helper.
    fn words(script: &[&str], start_ms: i64) -> Vec<Word> {
        script
            .iter()
            .enumerate()
            .map(|(i, w)| Word {
                word: (*w).to_string(),
                start_ms: start_ms + i as i64 * 1000,
            })
            .collect()
    }

    #[test]
    fn normalizes_the_way_the_site_does() {
        assert_eq!(normalize_word("Två,"), "tva");
        assert_eq!(normalize_word("one!"), "one");
        assert_eq!(normalize_word("  Три. "), "три");
        assert_eq!(normalize_word("três"), "tres");
    }

    #[test]
    fn finds_a_cued_countdown_and_anchors_one_second_after_one() {
        let found = find_countdowns(&words(&["record", "three", "two", "one"], 10_000), "en");
        assert_eq!(found.len(), 1);
        assert!(found[0].cued);
        assert_eq!(found[0].anchor_ms, 14_000);
        assert_eq!(found[0].spread_ms, 0);
        assert!(found[0].confidence > 0.9);
    }

    /// The same table the JavaScript test walks, so both halves agree that
    /// every supported language can anchor on its own number words.
    #[test]
    fn every_language_anchors() {
        let scripts: &[(&str, [&str; 4])] = &[
            ("no", ["record", "tre", "to", "en"]),
            ("da", ["record", "tre", "to", "et"]),
            ("sv", ["record", "tre", "två", "ett"]),
            ("fi", ["record", "kolme", "kaksi", "yksi"]),
            ("ru", ["record", "три", "два", "один"]),
            ("uk", ["record", "три", "два", "один"]),
            ("pl", ["record", "trzy", "dwa", "jeden"]),
            ("ro", ["record", "trei", "doi", "unu"]),
            ("fr", ["record", "trois", "deux", "un"]),
            ("es", ["record", "tres", "dos", "uno"]),
            ("pt", ["record", "três", "dois", "um"]),
            ("zh", ["record", "三", "二", "一"]),
            ("en", ["record", "3", "2", "1"]),
        ];
        for (lang, script) in scripts {
            let found = find_countdowns(&words(script, 10_000), lang);
            assert_eq!(found.len(), 1, "{lang}: countdown found");
            assert!(found[0].cued, "{lang}: cue matched");
            assert_eq!(found[0].anchor_ms, 14_000, "{lang}: anchor at freeze end");
        }
    }

    #[test]
    fn transliterated_cue_counts() {
        let found = find_countdowns(&words(&["рекорд", "три", "два", "один"], 10_000), "ru");
        assert!(found[0].cued);
    }

    #[test]
    fn one_bad_alignment_does_not_move_the_anchor() {
        let stream = vec![
            Word { word: "record".into(), start_ms: 10_000 },
            Word { word: "three".into(), start_ms: 11_000 },
            Word { word: "two".into(), start_ms: 12_000 },
            // Whisper drifted this one.
            Word { word: "one".into(), start_ms: 13_350 },
        ];
        let found = find_countdowns(&stream, "en");
        assert_eq!(found[0].anchor_ms, 14_000, "the median ignores the outlier");
        assert!(found[0].spread_ms > 0, "but the disagreement is reported");
        assert!(found[0].confidence < 0.95, "and it lowers confidence");
    }

    #[test]
    fn an_uncued_countdown_is_a_candidate_not_an_anchor() {
        let stream = words(&["flash", "three", "two", "one"], 10_000);
        let found = find_countdowns(&stream, "en");
        assert_eq!(found.len(), 1);
        assert!(!found[0].cued);
        assert!(found[0].confidence < 0.7);

        let picked = pick_anchor(&stream, "en").expect("a candidate");
        assert!(!picked.detected, "the user has to confirm it");
    }

    #[test]
    fn numbers_scattered_through_a_sentence_are_not_a_countdown() {
        let slow = vec![
            Word { word: "three".into(), start_ms: 10_000 },
            Word { word: "two".into(), start_ms: 30_000 },
            Word { word: "one".into(), start_ms: 60_000 },
        ];
        assert!(find_countdowns(&slow, "en").is_empty(), "pacing rules it out");
    }

    #[test]
    fn the_first_cued_countdown_wins() {
        let mut stream = words(&["record", "three", "two", "one"], 10_000);
        stream.extend(words(&["record", "three", "two", "one"], 600_000));
        let picked = pick_anchor(&stream, "en").expect("an anchor");
        assert_eq!(picked.chosen.anchor_ms, 14_000);
        assert_eq!(picked.candidates.len(), 2, "the later one stays available");
    }

    #[test]
    fn silence_has_no_anchor() {
        assert!(pick_anchor(&[], "en").is_none());
    }
}
