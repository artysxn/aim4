//! Speech to text, locally, with whisper.cpp compiled into the binary.
//!
//! The model is the one thing that cannot ship inside the exe — the smallest
//! usable multilingual model is bigger than the program by two orders of
//! magnitude — so it is downloaded once on first use and kept beside the
//! settings. Hugging Face hosts the official whisper.cpp conversions and is
//! where whisper.cpp's own download script points.
//!
//! Transcription runs per captured segment, not over a stitched-together
//! session: each segment is one person saying one thing, so the segment
//! boundaries are utterance boundaries, timestamps come from the recording
//! rather than from Whisper's drifting clock, and thirteen languages work the
//! same because no language-specific splitting is ever needed.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Once;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

/// Models the recorder offers. Key, file, size, and who it is for.
///
/// All multilingual: the site's thirteen languages include Chinese, Ukrainian
/// and Finnish, which the English-only variants simply do not have.
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        key: "large-v3-turbo-q5",
        file: "ggml-large-v3-turbo-q5_0.bin",
        approx_mb: 574,
        label: "Best — strong in all 13 languages",
    },
    ModelSpec {
        key: "small-q5",
        file: "ggml-small-q5_1.bin",
        approx_mb: 190,
        label: "Fast — fine for English, weaker for zh/uk/fi",
    },
    ModelSpec {
        key: "tiny",
        file: "ggml-tiny.bin",
        approx_mb: 75,
        label: "Testing only — do not trust the words",
    },
];

pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5";

#[derive(Debug, Clone)]
pub struct ModelSpec {
    pub key: &'static str,
    pub file: &'static str,
    pub approx_mb: u64,
    pub label: &'static str,
}

pub fn model_spec(key: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.key == key)
}

/// One transcribed line: times are relative to the audio handed in.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// 1 − no-speech probability: a rough grip on how sure Whisper was that
    /// this was words at all, which is the failure mode that matters here.
    pub conf: f32,
}

/// Download the model if it is not already on disk, reporting progress.
///
/// Atomic on purpose: the download lands in a `.part` file and is renamed only
/// when complete, so a killed download can never leave a truncated model that
/// whisper.cpp would fail to load with an unhelpful error forever after.
pub fn ensure_model(
    key: &str,
    dir: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let spec = model_spec(key).ok_or_else(|| format!("unknown model '{key}'"))?;
    let path = dir.join(spec.file);
    if path.exists() && std::fs::metadata(&path)?.len() > 1024 * 1024 {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)?;

    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        spec.file
    );
    let resp = ureq::get(&url).call()?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(spec.approx_mb * 1024 * 1024);

    let part = dir.join(format!("{}.part", spec.file));
    let mut out = std::fs::File::create(&part)?;
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    // On any failure, take the half-written .part with us: it can never
    // become the model, so leaving it behind is just disk spent on nothing.
    let streamed = (|| -> std::io::Result<()> {
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            out.write_all(&buf[..n])?;
            done += n as u64;
            progress(done, total);
        }
    })();
    out.flush().ok();
    drop(out);
    if let Err(e) = streamed {
        std::fs::remove_file(&part).ok();
        return Err(e.into());
    }

    // A model a tenth of its published size is a failed download that happened
    // to end cleanly (a proxy error page, a dropped connection ureq saw as
    // EOF). Refuse it: whisper.cpp's own error for a truncated model is far
    // more confusing than this one.
    if done < spec.approx_mb * 1024 * 1024 / 10 {
        std::fs::remove_file(&part).ok();
        return Err(format!("model download was truncated ({done} bytes)").into());
    }
    std::fs::rename(&part, &path)?;
    Ok(path)
}

pub struct Transcriber {
    _ctx: WhisperContext,
    state: WhisperState,
    threads: i32,
}

impl Transcriber {
    pub fn load(model_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        // Route whisper.cpp's chatty stderr through the (absent) log crate
        // exactly once, or every segment prints a page of tensor names.
        static QUIET: Once = Once::new();
        QUIET.call_once(whisper_rs::install_logging_hooks);

        let ctx = WhisperContext::new_with_params(
            model_path.to_str().ok_or("model path is not valid UTF-8")?,
            WhisperContextParameters::default(),
        )?;
        let state = ctx.create_state()?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8) as i32)
            .unwrap_or(4);
        Ok(Self { _ctx: ctx, state, threads })
    }

    /// Transcribe one utterance of 16 kHz mono f32 audio.
    ///
    /// `lang` is one of the site's language codes, which are Whisper's codes
    /// for all thirteen. Fixed rather than auto-detected: the user already
    /// told us the team's language, and auto-detection on a two-second clip
    /// is a coin toss that would scramble words the sync anchor depends on.
    pub fn transcribe(&mut self, pcm16k: &[f32], lang: &str) -> Result<Vec<Line>, Box<dyn std::error::Error>> {
        // whisper.cpp refuses input under a second; a short "yes" from a
        // teammate is still worth transcribing, so pad with silence.
        const MIN_SAMPLES: usize = (crate::audio::WHISPER_RATE * 12) / 10;
        let padded;
        let samples = if pcm16k.len() < MIN_SAMPLES {
            padded = {
                let mut v = pcm16k.to_vec();
                v.resize(MIN_SAMPLES, 0.0);
                v
            };
            &padded[..]
        } else {
            pcm16k
        };

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(lang));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_n_threads(self.threads);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        // Non-speech tokens — the "(sighs)" and "[Music]" family — are noise
        // in a comms transcript even when they are right.
        params.set_suppress_nst(true);

        self.state.full(params, samples)?;

        let mut lines = Vec::new();
        for i in 0..self.state.full_n_segments() {
            let Some(segment) = self.state.get_segment(i) else { continue };
            let text = segment.to_str_lossy().unwrap_or_default().trim().to_string();
            let no_speech = segment.no_speech_probability();
            if no_speech > 0.75 || is_junk(&text) {
                continue;
            }
            lines.push(Line {
                // Whisper timestamps are centiseconds.
                start_ms: segment.start_timestamp() * 10,
                end_ms: segment.end_timestamp() * 10,
                text,
                conf: (1.0 - no_speech).clamp(0.0, 1.0),
            });
        }
        Ok(lines)
    }
}

/// Whisper's silence hallucinations, filtered by shape rather than by list.
///
/// A list of known phantom phrases would need maintaining in thirteen
/// languages; the shapes are the same in all of them: nothing, bracketed
/// stage directions, or music notation.
pub fn is_junk(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return true;
    }
    if (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) {
        return true;
    }
    if t.chars().all(|c| !c.is_alphanumeric()) {
        return true;
    }
    t.contains('♪') || t.contains('♫')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_shapes_are_dropped_in_any_language() {
        assert!(is_junk(""));
        assert!(is_junk("   "));
        assert!(is_junk("[BLANK_AUDIO]"));
        assert!(is_junk("[Музыка]"));
        assert!(is_junk("(applåder)"));
        assert!(is_junk("♪ ♪ ♪"));
        assert!(is_junk("..."));
    }

    #[test]
    fn real_speech_is_not_junk() {
        assert!(!is_junk("rotate to B"));
        assert!(!is_junk("осталось двое"));
        assert!(!is_junk("de pusher banana!"));
        assert!(!is_junk("他们在A点"));
        // Brackets inside a sentence are fine; only fully-bracketed lines go.
        assert!(!is_junk("push [now] please"));
    }

    #[test]
    fn every_site_language_is_a_whisper_language() {
        // The site's codes are handed to set_language verbatim; if one is not
        // a code Whisper knows, that language silently transcribes as wrong.
        // Whisper's own list (whisper.cpp g_lang) contains all of these.
        const WHISPER_KNOWS: &[&str] = &[
            "da", "en", "es", "fi", "fr", "no", "pl", "pt", "ro", "ru", "sv", "uk", "zh",
        ];
        for lang in WHISPER_KNOWS {
            assert!(
                whisper_rs::get_lang_id(lang).is_some(),
                "whisper does not know '{lang}'"
            );
        }
    }

    #[test]
    fn the_default_model_exists_in_the_table() {
        assert!(model_spec(DEFAULT_MODEL).is_some());
        for m in MODELS {
            assert!(m.file.starts_with("ggml-"), "official naming: {}", m.file);
        }
    }
}
