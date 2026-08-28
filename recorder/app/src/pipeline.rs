//! From a recorded session directory to a finished `.aim4comms` file.
//!
//! A session on disk is a folder of `.a4sg` segment files plus one
//! `session.json` naming the speakers — written when recording stops, so a
//! session can be packed now, re-packed later in another language, or packed
//! on a different machine, without the TeamSpeak server in the room.
//!
//! Packing runs the whole tail of the plan in order:
//!
//!   transcribe   every segment through Whisper, against the ORIGINAL frames
//!   anchor       find "record, three, two, one" in the words
//!   budget       pick a bitrate that should fit 2 MB
//!   encode       every segment to its own Ogg/Opus track
//!   measure      and step down the ladder if the real file disagrees
//!   pack         manifest + audio into the container the site verifies
//!
//! The measure step is what makes the budget honest: the estimate only picks
//! where to start, and the actual bytes decide whether to stop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aim4_recorder_core::budget::{choose_bitrate, BITRATE_LADDER, TARGET_BYTES};
use aim4_recorder_core::capture::read_segment;
use aim4_recorder_core::countdown::{pick_anchor, Word};
use aim4_recorder_core::format::{
    pack, AudioIndex, AudioTrack, Manifest, Speaker, Sync, Utterance, SYNC_FREEZE_END_R1, VERSION,
};
use serde::{Deserialize, Serialize};

use crate::audio;
use crate::transcribe::Transcriber;

pub const SESSION_FILE: &str = "session.json";

/// The site slices anything past these; the recorder respects them up front
/// so nothing is silently dropped on the other side.
const MAX_SPEAKERS: usize = 16;
const MAX_UTTERANCES: usize = 40_000;
const MAX_TEXT_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSpeaker {
    pub id: u16,
    pub uid: String,
    pub nickname: String,
    #[serde(rename = "talkMs")]
    pub talk_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSegment {
    pub speaker: u16,
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "endMs")]
    pub end_ms: i64,
    /// File name inside the session directory, never a path: the folder must
    /// survive being moved or copied to another machine.
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionFile {
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    pub speakers: Vec<SessionSpeaker>,
    pub segments: Vec<SessionSegment>,
}

pub fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

/// Write `session.json` for a finished TeamSpeak recording.
///
/// Speakers land most-talkative first: the site shows them in manifest order,
/// and the in-game leader at the top is almost always right.
pub fn save_session(result: &crate::teamspeak::SessionResult) -> std::io::Result<PathBuf> {
    let mut speakers: Vec<SessionSpeaker> = result
        .speakers
        .iter()
        .map(|(id, s)| SessionSpeaker {
            id: *id,
            uid: s.uid.clone(),
            nickname: s.nickname.clone(),
            talk_ms: s.talk_ms,
        })
        .collect();
    speakers.sort_by(|a, b| b.talk_ms.cmp(&a.talk_ms).then(a.id.cmp(&b.id)));

    let session = SessionFile {
        recorded_at: now_rfc3339(),
        duration_ms: result.duration_ms,
        speakers,
        segments: result
            .segments
            .iter()
            .filter_map(|seg| {
                Some(SessionSegment {
                    speaker: seg.speaker,
                    start_ms: seg.start_ms,
                    end_ms: seg.end_ms,
                    file: seg.file.file_name()?.to_str()?.to_string(),
                })
            })
            .collect(),
    };
    let path = result.dir.join(SESSION_FILE);
    std::fs::write(&path, serde_json::to_vec_pretty(&session)?)?;
    Ok(path)
}

pub fn load_session(dir: &Path) -> std::io::Result<SessionFile> {
    let bytes = std::fs::read(dir.join(SESSION_FILE))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[derive(Debug, Clone)]
pub struct PackOptions {
    pub lang: String,
    pub name: String,
    /// Defaults to the session directory itself.
    pub out_dir: Option<PathBuf>,
}

/// What the caller gets to show while packing runs. Coarse on purpose — a
/// per-segment tick and a bitrate announcement are all a progress bar needs.
#[derive(Debug, Clone, Copy)]
pub enum Progress {
    Transcribing { done: usize, total: usize },
    Encoding { bitrate: u32 },
    Writing,
}

#[derive(Debug)]
pub struct PackReport {
    pub path: PathBuf,
    pub bytes: usize,
    pub bitrate: u32,
    pub over_budget: bool,
    pub utterances: usize,
    pub speech_ms: i64,
    /// `(anchor_ms, cued)` when a countdown was found.
    pub anchor: Option<(i64, bool)>,
    /// Segment files that were missing or undecodable, not counting empties.
    pub skipped: usize,
}

struct LoadedSegment {
    speaker_idx: usize,
    start_ms: i64,
    end_ms: i64,
    codec: u8,
    frames: Vec<Vec<u8>>,
}

/// Transcribe and pack one session into a `.aim4comms` file.
pub fn pack_session(
    dir: &Path,
    model_path: &Path,
    opts: &PackOptions,
    progress: &mut dyn FnMut(Progress),
) -> Result<PackReport, Box<dyn std::error::Error>> {
    let session = load_session(dir)?;

    let speaker_index: HashMap<u16, usize> = session
        .speakers
        .iter()
        .take(MAX_SPEAKERS)
        .enumerate()
        .map(|(i, s)| (s.id, i))
        .collect();

    // Load every segment's frames up front. The frames stay in memory for the
    // whole pack — they are the compressed capture, a few MB for a full map —
    // and get decoded on demand, once for Whisper and once per encode pass.
    let mut segments: Vec<LoadedSegment> = Vec::new();
    let mut skipped = 0usize;
    for seg in &session.segments {
        let Some(&speaker_idx) = speaker_index.get(&seg.speaker) else {
            skipped += 1;
            continue;
        };
        match read_segment(dir.join(&seg.file)) {
            Ok((codec, start_ms, frames)) if !frames.is_empty() => {
                segments.push(LoadedSegment {
                    speaker_idx,
                    // Trust the file header over session.json: the file is
                    // what a crash recovery has, session.json is a convenience.
                    start_ms,
                    end_ms: seg.end_ms.max(start_ms),
                    codec,
                    frames,
                });
            }
            Ok(_) => {}
            Err(_) => skipped += 1,
        }
    }
    segments.sort_by_key(|s| s.start_ms);

    if segments.is_empty() {
        return Err("no usable audio segments in this session".into());
    }

    // --- transcription, against the original full-quality frames -----------
    let mut transcriber = Transcriber::load(model_path)?;
    let mut utterances: Vec<Utterance> = Vec::new();
    let total = segments.len();
    for (i, seg) in segments.iter().enumerate() {
        progress(Progress::Transcribing { done: i, total });
        let pcm48 = match audio::decode_frames(seg.codec, &seg.frames) {
            // Every frame corrupt decodes to nothing; treat it like the
            // unreadable file it effectively is.
            Ok(p) if !p.is_empty() => p,
            Ok(_) | Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let pcm16 = audio::resample_to_16k(&pcm48);
        for line in transcriber.transcribe(&pcm16, &opts.lang)? {
            let start = seg.start_ms + line.start_ms.max(0);
            // Whisper may time into the silence padding; the utterance cannot
            // outlive its segment plus a breath.
            let end = (seg.start_ms + line.end_ms).min(seg.end_ms + 500).max(start + 1);
            let mut text = line.text;
            if text.chars().count() > MAX_TEXT_CHARS {
                text = text.chars().take(MAX_TEXT_CHARS).collect();
            }
            utterances.push(Utterance {
                speaker: seg.speaker_idx,
                start_ms: start.max(0) as u64,
                end_ms: end.max(0) as u64,
                text,
                conf: Some(line.conf),
            });
        }
        if utterances.len() >= MAX_UTTERANCES {
            break;
        }
    }
    progress(Progress::Transcribing { done: total, total });
    utterances.sort_by_key(|u| u.start_ms);
    utterances.truncate(MAX_UTTERANCES);

    // --- the sync anchor ----------------------------------------------------
    // Words spread evenly across each utterance, the same reconstruction the
    // site performs when it re-derives candidates: both halves must find the
    // same countdowns in the same transcript.
    let mut words: Vec<Word> = Vec::new();
    for u in &utterances {
        let parts: Vec<&str> = u.text.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let step = (u.end_ms - u.start_ms) as f64 / parts.len() as f64;
        for (i, w) in parts.iter().enumerate() {
            words.push(Word {
                word: (*w).to_string(),
                start_ms: u.start_ms as i64 + (i as f64 * step) as i64,
            });
        }
    }
    let anchor = pick_anchor(&words, &opts.lang);
    let sync = match &anchor {
        Some(a) => Sync {
            anchor_ms: Some(a.chosen.anchor_ms.max(0) as u64),
            kind: SYNC_FREEZE_END_R1.into(),
            detected: a.detected,
            confidence: a.chosen.confidence as f32,
        },
        None => Sync {
            anchor_ms: None,
            kind: SYNC_FREEZE_END_R1.into(),
            detected: false,
            confidence: 0.0,
        },
    };

    // --- encode to budget, measure, step down if the measurement disagrees --
    let speech_ms: i64 = segments.iter().map(|s| (s.end_ms - s.start_ms).max(0)).sum();
    let first_choice = choose_bitrate(speech_ms, TARGET_BYTES as u64);
    let start_rung = BITRATE_LADDER
        .iter()
        .position(|b| *b == first_choice.bitrate)
        .unwrap_or(0);

    let manifest_base = Manifest {
        version: VERSION,
        name: opts.name.clone(),
        recorded_at: session.recorded_at.clone(),
        lang: opts.lang.clone(),
        model: model_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("whisper")
            .to_string(),
        duration_ms: session.duration_ms.max(0) as u64,
        sync,
        speakers: session
            .speakers
            .iter()
            .take(MAX_SPEAKERS)
            .map(|s| Speaker {
                uid: s.uid.clone(),
                nickname: s.nickname.clone(),
                talk_ms: s.talk_ms.max(0) as u64,
            })
            .collect(),
        audio: None,
        utterances,
    };

    let mut packed: Option<(Vec<u8>, u32)> = None;
    for &bitrate in &BITRATE_LADDER[start_rung..] {
        progress(Progress::Encoding { bitrate });
        let mut blob: Vec<u8> = Vec::new();
        let mut tracks: Vec<AudioTrack> = Vec::new();
        for (i, seg) in segments.iter().enumerate() {
            let Ok(pcm48) = audio::decode_frames(seg.codec, &seg.frames) else { continue };
            if pcm48.is_empty() {
                // A headers-only Ogg stream is a track a browser cannot
                // decode; better no track than a broken one.
                continue;
            }
            let track = audio::encode_ogg_opus(&pcm48, bitrate, i as u32)?;
            tracks.push(AudioTrack {
                speaker: seg.speaker_idx,
                byte_off: blob.len(),
                byte_len: track.len(),
                start_ms: seg.start_ms.max(0) as u64,
            });
            blob.extend_from_slice(&track);
        }

        let mut manifest = manifest_base.clone();
        manifest.audio = Some(AudioIndex {
            codec: "opus".into(),
            bitrate,
            tracks,
        });
        let bytes = pack(&manifest, &blob)?;
        let fits = bytes.len() as u64 <= TARGET_BYTES;
        packed = Some((bytes, bitrate));
        if fits {
            break;
        }
    }
    let (bytes, bitrate) = packed.expect("the ladder is never empty");
    let over_budget = bytes.len() as u64 > TARGET_BYTES;

    // --- write ---------------------------------------------------------------
    progress(Progress::Writing);
    let out_dir = opts.out_dir.clone().unwrap_or_else(|| dir.to_path_buf());
    std::fs::create_dir_all(&out_dir)?;
    let path = out_dir.join(format!("{}.aim4comms", sanitize_name(&opts.name)));
    std::fs::write(&path, &bytes)?;

    Ok(PackReport {
        path,
        bytes: bytes.len(),
        bitrate,
        over_budget,
        utterances: manifest_base.utterances.len(),
        speech_ms,
        anchor: anchor.map(|a| (a.chosen.anchor_ms, a.detected)),
        skipped,
    })
}

/// A file name that survives Windows, macOS, and a browser download header.
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "comms".into() } else { trimmed }
}

// --- dev tool: build a session from wav files -------------------------------

/// Encode a 48 kHz mono PCM16 wav into the session as one spoken segment,
/// exactly as if TeamSpeak had delivered it.
///
/// This is the developer's stand-in for a server: `say` (or any recording)
/// becomes a segment, and the whole transcribe/anchor/pack pipeline runs for
/// real. It is also the honest way to demo the recorder without five people.
pub fn ingest_wav(
    dir: &Path,
    speaker: u16,
    start_ms: i64,
    wav_path: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    use aim4_recorder_core::capture::SegmentWriter;
    use audiopus::coder::Encoder;
    use audiopus::{Application, Bitrate, Channels, SampleRate};

    let pcm = read_wav_48k_mono(wav_path)?;
    let mut encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)?;
    // What TeamSpeak's own voice quality slider lands near.
    encoder.set_bitrate(Bitrate::BitsPerSecond(32_000))?;

    let mut writer = SegmentWriter::new(dir)?;
    let mut buf = [0u8; 4000];
    let mut frame = [0i16; audio::FRAME_SAMPLES];
    let mut at = 0usize;
    let mut now = start_ms;
    while at < pcm.len() {
        let n = (pcm.len() - at).min(audio::FRAME_SAMPLES);
        frame[..n].copy_from_slice(&pcm[at..at + n]);
        frame[n..].fill(0);
        let bytes = encoder.encode(&frame, &mut buf)?;
        writer.push(speaker, audio::CODEC_OPUS_VOICE, &buf[..bytes], now)?;
        at += n;
        now += 20;
    }
    let segments = writer.finish(now)?;
    let end_ms = segments.iter().map(|s| s.end_ms).max().unwrap_or(now);

    // Fold the new segment into session.json, creating it on first use.
    let mut session = load_session(dir).unwrap_or(SessionFile {
        recorded_at: now_rfc3339(),
        duration_ms: 0,
        speakers: Vec::new(),
        segments: Vec::new(),
    });
    if !session.speakers.iter().any(|s| s.id == speaker) {
        session.speakers.push(SessionSpeaker {
            id: speaker,
            uid: format!("synth-{speaker}"),
            nickname: format!("speaker {speaker}"),
            talk_ms: 0,
        });
    }
    for seg in &segments {
        session.segments.push(SessionSegment {
            speaker: seg.speaker,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
            file: seg
                .file
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or_default()
                .to_string(),
        });
        if let Some(sp) = session.speakers.iter_mut().find(|s| s.id == seg.speaker) {
            sp.talk_ms += seg.duration_ms();
        }
    }
    session.duration_ms = session.duration_ms.max(end_ms);
    let path = dir.join(SESSION_FILE);
    std::fs::write(&path, serde_json::to_vec_pretty(&session)?)?;
    Ok(path)
}

/// The smallest wav reader that can be honest about what it refuses.
fn read_wav_48k_mono(path: &Path) -> Result<Vec<i16>, Box<dyn std::error::Error>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a wav file".into());
    }
    let mut at = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // format, channels, rate, bits
    let mut data: Option<&[u8]> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into()?) as usize;
        let body_end = (at + 8 + len).min(bytes.len());
        let body = &bytes[at + 8..body_end];
        match id {
            b"fmt " if body.len() >= 16 => {
                fmt = Some((
                    u16::from_le_bytes(body[0..2].try_into()?),
                    u16::from_le_bytes(body[2..4].try_into()?),
                    u32::from_le_bytes(body[4..8].try_into()?),
                    u16::from_le_bytes(body[14..16].try_into()?),
                ));
            }
            b"data" => data = Some(body),
            _ => {}
        }
        at = at + 8 + len + (len & 1);
    }
    let (format, channels, rate, bits) = fmt.ok_or("wav has no fmt chunk")?;
    let data = data.ok_or("wav has no data chunk")?;
    if format != 1 || bits != 16 || rate != 48_000 || !(1..=2).contains(&channels) {
        return Err(format!(
            "need 48 kHz 16-bit PCM mono (got format {format}, {channels}ch, {rate} Hz, {bits}-bit) \
             — convert with: afconvert -f WAVE -d LEI16@48000 -c 1 in out.wav"
        )
        .into());
    }
    let mut out = Vec::with_capacity(data.len() / 2 / channels as usize);
    match channels {
        1 => {
            for pair in data.chunks_exact(2) {
                out.push(i16::from_le_bytes([pair[0], pair[1]]));
            }
        }
        _ => {
            for quad in data.chunks_exact(4) {
                let l = i16::from_le_bytes([quad[0], quad[1]]) as i32;
                let r = i16::from_le_bytes([quad[2], quad[3]]) as i32;
                out.push(((l + r) / 2) as i16);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_come_out_safe_for_every_filesystem() {
        assert_eq!(sanitize_name("navi vs faze | mirage"), "navi vs faze - mirage");
        // The dots that survive are harmless: every '/' became '-', so the
        // name cannot traverse anywhere.
        assert_eq!(sanitize_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(sanitize_name(""), "comms");
        assert_eq!(sanitize_name("   "), "comms");
        assert_eq!(sanitize_name("scrim 2026-08-27"), "scrim 2026-08-27");
    }

    #[test]
    fn a_wav_round_trips_through_ingest_shape() {
        // Build a tiny valid wav in memory, write it, read it back.
        let samples: Vec<i16> = (0..960).map(|i| (i % 100) as i16).collect();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // pcm
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&(48_000u32 * 2).to_le_bytes()); // byte rate
        wav.extend_from_slice(&2u16.to_le_bytes()); // block align
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for s in &samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }

        let dir = std::env::temp_dir().join(format!("aim4-wav-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.wav");
        std::fs::write(&path, &wav).unwrap();
        let back = read_wav_48k_mono(&path).unwrap();
        assert_eq!(back, samples);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_wrong_wav_is_refused_with_directions() {
        let dir = std::env::temp_dir().join(format!("aim4-wav44-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF\0\0\0\0WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&44_100u32.to_le_bytes());
        wav.extend_from_slice(&(44_100u32 * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&0u32.to_le_bytes());
        let path = dir.join("t.wav");
        std::fs::write(&path, &wav).unwrap();
        let err = read_wav_48k_mono(&path).unwrap_err().to_string();
        assert!(err.contains("afconvert"), "tells the user how to fix it: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
