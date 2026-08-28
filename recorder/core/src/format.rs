//! The `.aim4comms` container.
//!
//! The site's `shared/comms/format.js` is the source of truth for this layout;
//! this is the writing half. Anything changed here has to be changed there,
//! and `../aim4/tools/comms/verify.mjs` is what proves the two still agree.
//!
//! ```text
//! magic     4 bytes   "A4C1"
//! version   2 bytes   little-endian, currently 1
//! flags     2 bytes   reserved, 0
//! jsonLen   4 bytes   little-endian byte length of the gzipped manifest
//! manifest  jsonLen   gzip(JSON)
//! audio     rest      per-speaker Ogg/Opus streams, back to back
//! ```
//!
//! Audio is indexed by byte range rather than inlined, because base64 in the
//! JSON would add a third again to the bytes the packer spends its entire size
//! budget on.

use std::io::Write;

use flate2::{write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};

pub const MAGIC: &[u8; 4] = b"A4C1";
pub const VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 12;

/// What the packer aims at. Not a hard limit: a very chatty session at the
/// codec's floor may land a little over, and cutting speech to hit a number
/// would be the wrong trade.
pub const TARGET_BYTES: usize = 2 * 1024 * 1024;
/// What the site refuses outright.
pub const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

/// Only one anchor kind exists: round 1 going live.
pub const SYNC_FREEZE_END_R1: &str = "freeze-end-r1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Speaker {
    /// TeamSpeak identity UID. Stable across nickname changes, which is what
    /// lets the site remember who this person is on the roster.
    pub uid: String,
    pub nickname: String,
    #[serde(rename = "talkMs")]
    pub talk_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Utterance {
    /// Index into `Manifest::speakers`, not a uid: repeating the uid on every
    /// line would be the largest thing in the file after the words themselves.
    pub speaker: usize,
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conf: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrack {
    pub speaker: usize,
    #[serde(rename = "byteOff")]
    pub byte_off: usize,
    #[serde(rename = "byteLen")]
    pub byte_len: usize,
    #[serde(rename = "startMs", default)]
    pub start_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioIndex {
    pub codec: String,
    pub bitrate: u32,
    pub tracks: Vec<AudioTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sync {
    /// Recording millisecond that is round 1's freeze end, or None when the
    /// countdown was not found and the user will have to point at it.
    #[serde(rename = "anchorMs")]
    pub anchor_ms: Option<u64>,
    pub kind: String,
    pub detected: bool,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u16,
    pub name: String,
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    pub lang: String,
    pub model: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub sync: Sync,
    pub speakers: Vec<Speaker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioIndex>,
    pub utterances: Vec<Utterance>,
}

#[derive(Debug)]
pub enum PackError {
    Io(std::io::Error),
    Json(serde_json::Error),
    /// The manifest describes audio that is not in the blob handed over.
    AudioIndexOutOfRange,
    TooLarge(usize),
}

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PackError::Io(e) => write!(f, "io error: {e}"),
            PackError::Json(e) => write!(f, "manifest could not be serialized: {e}"),
            PackError::AudioIndexOutOfRange => {
                write!(f, "an audio track points past the end of the audio blob")
            }
            PackError::TooLarge(n) => write!(f, "packed file is {n} bytes, over the limit"),
        }
    }
}

impl std::error::Error for PackError {}

impl From<std::io::Error> for PackError {
    fn from(e: std::io::Error) -> Self {
        PackError::Io(e)
    }
}

impl From<serde_json::Error> for PackError {
    fn from(e: serde_json::Error) -> Self {
        PackError::Json(e)
    }
}

/// Frame a manifest and its audio into a finished container.
///
/// The index is checked against the blob before anything is written: a file
/// whose byte ranges do not line up would be accepted by the site's decoder
/// and then hand the viewer silence, which is far harder to notice than a
/// failure here.
pub fn pack(manifest: &Manifest, audio: &[u8]) -> Result<Vec<u8>, PackError> {
    if let Some(index) = &manifest.audio {
        for track in &index.tracks {
            if track
                .byte_off
                .checked_add(track.byte_len)
                .map_or(true, |end| end > audio.len())
            {
                return Err(PackError::AudioIndexOutOfRange);
            }
        }
    }

    let json = serde_json::to_vec(manifest)?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(&json)?;
    let manifest_gz = encoder.finish()?;

    let mut out = Vec::with_capacity(HEADER_BYTES + manifest_gz.len() + audio.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&(manifest_gz.len() as u32).to_le_bytes());
    out.extend_from_slice(&manifest_gz);
    out.extend_from_slice(audio);

    if out.len() > MAX_FILE_BYTES {
        return Err(PackError::TooLarge(out.len()));
    }
    Ok(out)
}

/// Split a container back into its parts. Used to re-read our own output in
/// tests, and to re-transcribe a session later without recording it again.
pub fn read_header(bytes: &[u8]) -> Result<(u16, &[u8], &[u8]), PackError> {
    if bytes.len() < HEADER_BYTES {
        return Err(PackError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "not a comms file: too short",
        )));
    }
    if &bytes[0..4] != MAGIC {
        return Err(PackError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not a comms file: wrong magic",
        )));
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    let json_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let end = HEADER_BYTES + json_len;
    if end > bytes.len() {
        return Err(PackError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "comms file is truncated",
        )));
    }
    Ok((version, &bytes[HEADER_BYTES..end], &bytes[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            version: VERSION,
            name: "scrim".into(),
            recorded_at: "2026-08-27T19:30:00Z".into(),
            lang: "no".into(),
            model: "faster-whisper-large-v3-turbo".into(),
            duration_ms: 2_400_000,
            sync: Sync {
                anchor_ms: Some(13_000),
                kind: SYNC_FREEZE_END_R1.into(),
                detected: true,
                confidence: 0.94,
            },
            speakers: vec![Speaker {
                uid: "uid-a".into(),
                nickname: "playerA".into(),
                talk_ms: 400_000,
            }],
            audio: None,
            utterances: vec![Utterance {
                speaker: 0,
                start_ms: 20_000,
                end_ms: 22_000,
                text: "de pusher banana".into(),
                conf: Some(0.83),
            }],
        }
    }

    #[test]
    fn writes_a_header_the_site_can_read() {
        let bytes = pack(&manifest(), &[]).expect("packs");
        assert_eq!(&bytes[0..4], MAGIC);
        let (version, gz, audio) = read_header(&bytes).expect("reads back");
        assert_eq!(version, VERSION);
        assert!(!gz.is_empty());
        assert!(audio.is_empty());
    }

    #[test]
    fn audio_rides_behind_the_manifest_unchanged() {
        let mut m = manifest();
        let audio = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        m.audio = Some(AudioIndex {
            codec: "opus".into(),
            bitrate: 8000,
            tracks: vec![AudioTrack {
                speaker: 0,
                byte_off: 0,
                byte_len: 8,
                start_ms: 0,
            }],
        });
        let bytes = pack(&m, &audio).expect("packs");
        let (_, _, tail) = read_header(&bytes).expect("reads back");
        assert_eq!(tail, &audio[..]);
    }

    #[test]
    fn refuses_an_index_that_points_past_the_audio() {
        let mut m = manifest();
        m.audio = Some(AudioIndex {
            codec: "opus".into(),
            bitrate: 8000,
            tracks: vec![AudioTrack {
                speaker: 0,
                byte_off: 4,
                byte_len: 99,
                start_ms: 0,
            }],
        });
        assert!(matches!(
            pack(&m, &[1, 2, 3, 4]),
            Err(PackError::AudioIndexOutOfRange)
        ));
    }

    #[test]
    fn rejects_files_that_are_not_ours() {
        assert!(read_header(b"nope").is_err());
        assert!(read_header(&[0u8; 20]).is_err());
    }
}
