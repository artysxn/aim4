//! Choosing an audio bitrate that fits the file inside its size budget.
//!
//! The `.aim4comms` file targets **2 MB per map**, and the packer works
//! backwards from that rather than picking a bitrate and hoping.
//!
//! The reason a 2 MB target is realistic at all: TeamSpeak transmits nothing
//! while nobody is talking, so only speech is ever encoded. A 40 minute map
//! with five players is roughly 45–60 minutes of actual speech across all of
//! them, not five times the wall clock.
//!
//! Bitrates are tried highest-first and the first that fits wins, because
//! there is no reason to spend a smaller number than the budget allows. Below
//! the floor the packer stops shrinking and accepts going over: a file that is
//! 2.5 MB is a mild annoyance, and one that is unintelligible is useless.
//!
//! Transcription always runs against the full-quality captured segments, never
//! against this re-encode, so the bitrate chosen here can never cost accuracy.

/// Bitrates the packer will consider, best first. Mono Opus in voip mode.
///
/// 16 kbps is clean wideband speech; 6 kbps is Opus's practical floor, muffled
/// but understandable. Below that the codec stops being speech.
pub const BITRATE_LADDER: [u32; 5] = [16_000, 12_000, 10_000, 8_000, 6_000];

/// What the site is happy to store per game.
pub const TARGET_BYTES: u64 = 2 * 1024 * 1024;

/// Room left for the transcript and the container header.
///
/// Measured: a 23 round session of 128 lines gzips to 2 KB, so a full map of
/// ~3,000 utterances lands well under 100 KB. 160 KB is comfortable headroom
/// without pretending the transcript is bigger than it is — every byte
/// reserved here is a byte the audio cannot spend.
pub const MANIFEST_RESERVE_BYTES: u64 = 160 * 1024;

/// Speech that fits the target at the floor bitrate, about 38 minutes.
///
/// Worth stating plainly because it is the honest limit of the 2 MB goal: past
/// this much talking, no intelligible bitrate fits and the file runs over.
/// That is a soft failure — the server accepts far larger — but it is a
/// promise the packer cannot keep, so it reports it rather than hiding it.
pub const SPEECH_MS_THAT_FITS: i64 = 38 * 60_000;

/// Ogg framing overhead per second of speech, in bytes.
///
/// Derived from what `encode_ogg_opus` actually writes, not guessed:
///
///   50   one lacing byte per 20 ms packet (every packet at these bitrates
///        is under 255 bytes, so exactly one each)
///   ~10  a 27 byte page header per ~255 packets, plus early flushes
///   ~30  95 bytes of OpusHead/OpusTags per track at the ~3 s utterances
///        real comms produce (each utterance is its own self-contained
///        stream so the site can hand the browser one byte range at a time)
///
/// A flat per-second figure, because that is how the cost actually scales:
/// framing is per *packet*, so its share grows as the bitrate shrinks —
/// exactly what a percentage multiplier used to get wrong at the floor.
const FRAMING_BYTES_PER_SEC: f64 = 90.0;

/// Bytes one stretch of speech takes at a given bitrate, framing included.
///
/// An estimate for picking the starting rung; the packer then measures the
/// real output and walks down the ladder if the measurement disagrees.
pub fn estimate_bytes(speech_ms: i64, bitrate: u32) -> u64 {
    if speech_ms <= 0 {
        return 0;
    }
    let seconds = speech_ms as f64 / 1000.0;
    (seconds * (bitrate as f64 / 8.0 + FRAMING_BYTES_PER_SEC)).ceil() as u64
}

#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub bitrate: u32,
    pub estimated_bytes: u64,
    /// True when even the floor does not fit and the file will run over.
    pub over_budget: bool,
}

/// Pick the best bitrate whose estimate fits the budget.
///
/// `total_speech_ms` is the sum across every speaker, which is exactly what
/// `SegmentWriter::total_talk_ms` reports.
pub fn choose_bitrate(total_speech_ms: i64, target_bytes: u64) -> Choice {
    let available = target_bytes.saturating_sub(MANIFEST_RESERVE_BYTES);

    for bitrate in BITRATE_LADDER {
        let bytes = estimate_bytes(total_speech_ms, bitrate);
        if bytes <= available {
            return Choice {
                bitrate,
                estimated_bytes: bytes,
                over_budget: false,
            };
        }
    }

    // Nothing fits. Take the floor and go over rather than encoding speech
    // nobody can make out, and say so, so the caller can tell the user.
    let bitrate = *BITRATE_LADDER.last().expect("ladder is not empty");
    Choice {
        bitrate,
        estimated_bytes: estimate_bytes(total_speech_ms, bitrate),
        over_budget: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60_000;

    #[test]
    fn a_normal_map_fits() {
        // Five players over 40 minutes, each actually talking maybe 15% of the
        // time, is around 30 speech-minutes. That fits with room to spare.
        let choice = choose_bitrate(30 * MINUTE, TARGET_BYTES);
        assert!(!choice.over_budget);
        assert!(choice.estimated_bytes <= TARGET_BYTES - MANIFEST_RESERVE_BYTES);
    }

    #[test]
    fn the_documented_limit_is_where_it_actually_is() {
        // The 2 MB goal holds up to about 40 speech-minutes and not beyond,
        // which is worth pinning: the size story in the docs is derived from
        // this number, and a table that drifts from the arithmetic is worse
        // than no table.
        let fits = choose_bitrate(SPEECH_MS_THAT_FITS - MINUTE, TARGET_BYTES);
        assert!(!fits.over_budget, "just under the limit still fits");

        let does_not = choose_bitrate(SPEECH_MS_THAT_FITS + 5 * MINUTE, TARGET_BYTES);
        assert!(does_not.over_budget, "and past it, nothing intelligible does");
        assert_eq!(does_not.bitrate, 6_000, "at the floor, not below it");
    }

    #[test]
    fn going_over_is_mild_rather_than_alarming() {
        // A very chatty map should land a few hundred KB over, not multiples
        // over: the server cap is 32 MB, so this is a broken promise, not a
        // broken feature.
        let choice = choose_bitrate(50 * MINUTE, TARGET_BYTES);
        assert!(choice.over_budget);
        assert!(
            choice.estimated_bytes < 3 * 1024 * 1024,
            "50 speech-minutes is {:.2} MB",
            choice.estimated_bytes as f64 / 1024.0 / 1024.0
        );
    }

    #[test]
    fn a_quiet_session_gets_the_best_quality_going() {
        // Ten minutes of speech has room to spare, so there is no reason to
        // spend less than the top of the ladder.
        let choice = choose_bitrate(10 * MINUTE, TARGET_BYTES);
        assert_eq!(choice.bitrate, BITRATE_LADDER[0]);
        assert!(!choice.over_budget);
    }

    #[test]
    fn more_speech_means_a_lower_bitrate() {
        let quiet = choose_bitrate(10 * MINUTE, TARGET_BYTES);
        let busy = choose_bitrate(35 * MINUTE, TARGET_BYTES);
        assert!(
            busy.bitrate < quiet.bitrate,
            "{} vs {}",
            busy.bitrate,
            quiet.bitrate
        );
        assert!(!busy.over_budget);
    }

    #[test]
    fn the_floor_is_a_floor_and_going_over_is_reported() {
        // Four hours of solid speech cannot fit in 2 MB at any intelligible
        // bitrate. The packer must say so rather than silently mangling it.
        let choice = choose_bitrate(240 * MINUTE, TARGET_BYTES);
        assert_eq!(choice.bitrate, 6_000, "stops at the floor");
        assert!(choice.over_budget, "and admits it will run over");
        assert!(choice.estimated_bytes > TARGET_BYTES);
    }

    #[test]
    fn silence_costs_nothing() {
        assert_eq!(estimate_bytes(0, 16_000), 0);
        assert_eq!(estimate_bytes(-5, 16_000), 0);
        let choice = choose_bitrate(0, TARGET_BYTES);
        assert_eq!(choice.estimated_bytes, 0);
        assert!(!choice.over_budget);
    }

    /// The exact table printed in the README.
    ///
    /// Pinned so the documented size story cannot drift from the arithmetic.
    /// If this fails, the README is now wrong and needs the new numbers, not a
    /// looser assertion.
    #[test]
    fn the_readme_table_is_what_the_code_returns() {
        let table: &[(i64, u32, &str, bool)] = &[
            (10, 16_000, "1.20", false),
            (20, 12_000, "1.82", false),
            (25, 8_000, "1.56", false),
            (30, 6_000, "1.44", false),
            (38, 6_000, "1.83", false),
            (40, 6_000, "1.92", true),
            (60, 6_000, "2.88", true),
        ];
        for (minutes, bitrate, size_mb, over) in table {
            let choice = choose_bitrate(minutes * MINUTE, TARGET_BYTES);
            assert_eq!(choice.bitrate, *bitrate, "{minutes} min: bitrate");
            assert_eq!(choice.over_budget, *over, "{minutes} min: over budget");
            let mb = format!("{:.2}", choice.estimated_bytes as f64 / 1024.0 / 1024.0);
            assert_eq!(&mb, size_mb, "{minutes} min: size");
        }
    }

    #[test]
    fn the_estimate_tracks_the_documented_table() {
        // The plan's table: 45 speech-minutes at 8 kbps is about 2.7 MB, and
        // at 16 kbps about 5.4 MB. If these drift, the size story in the docs
        // is wrong and so is every budget decision made from it.
        let at_8k = estimate_bytes(45 * MINUTE, 8_000) as f64 / 1024.0 / 1024.0;
        let at_16k = estimate_bytes(45 * MINUTE, 16_000) as f64 / 1024.0 / 1024.0;
        assert!((at_8k - 2.7).abs() < 0.2, "45min @ 8k = {at_8k:.2} MB");
        assert!((at_16k - 5.4).abs() < 0.4, "45min @ 16k = {at_16k:.2} MB");
    }

    #[test]
    fn the_manifest_always_has_room() {
        // Whatever the audio choice, the transcript must still fit under the
        // target, or the file the site accepts would be the one thing missing.
        for minutes in [5, 20, 45, 60, 90] {
            let choice = choose_bitrate(minutes * MINUTE, TARGET_BYTES);
            if !choice.over_budget {
                assert!(
                    choice.estimated_bytes + MANIFEST_RESERVE_BYTES <= TARGET_BYTES,
                    "{minutes} speech-minutes leaves room for the transcript"
                );
            }
        }
    }
}
