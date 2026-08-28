//! Turning a stream of voice packets into per-speaker segments on disk.
//!
//! Deliberately knows nothing about TeamSpeak: it takes `(speaker, codec,
//! frame, now_ms)` and writes files. That is what lets the whole segmentation
//! and framing story be tested without a server in the room, which matters
//! because the server is the one thing that cannot be checked in here.
//!
//! ## Why frames are length-prefixed
//!
//! Opus frames concatenated back to back are NOT decodable: the codec has no
//! self-delimiting framing, so a decoder cannot tell where one frame ends. The
//! obvious "just append the payloads" recorder produces a file that looks fine
//! and is unrecoverable. Each frame therefore carries its length:
//!
//! ```text
//! magic    4 bytes   "A4SG"
//! version  1 byte    SEGMENT_VERSION
//! codec    1 byte    TeamSpeak codec id, as received
//! reserved 2 bytes   0
//! startMs  8 bytes   little-endian, recording time of the first frame
//! frames   rest      repeated: u16 little-endian length, then that many bytes
//! ```
//!
//! ## Why segments at all
//!
//! TeamSpeak only transmits while someone is talking, and marks the end of a
//! run of speech with an EMPTY audio frame. So the packet stream is already
//! cut into utterances by the client that produced it, and a segment is just
//! that: one continuous run of speech from one person, with the time it began.
//! No voice-activity detection, and utterance timestamps for free.
//!
//! Nothing is decoded here. Frames are appended exactly as they arrived, so
//! recording costs I/O and nothing else while a game is running.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub const SEGMENT_MAGIC: &[u8; 4] = b"A4SG";
pub const SEGMENT_VERSION: u8 = 1;
pub const SEGMENT_HEADER_BYTES: usize = 16;

/// A run of speech is considered over after this long without a frame, in case
/// the closing empty frame is lost. TeamSpeak sends voice every 20ms, so this
/// is many missed packets, not a pause in a sentence.
pub const SILENCE_GAP_MS: i64 = 300;

/// Frames larger than this are not voice and are refused rather than written.
const MAX_FRAME_BYTES: usize = 8 * 1024;

/// One finished run of speech from one speaker.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub speaker: u16,
    pub start_ms: i64,
    pub end_ms: i64,
    pub frames: u32,
    pub bytes: u64,
    pub file: PathBuf,
}

impl Segment {
    pub fn duration_ms(&self) -> i64 {
        (self.end_ms - self.start_ms).max(0)
    }
}

struct OpenSegment {
    writer: BufWriter<File>,
    file: PathBuf,
    start_ms: i64,
    last_ms: i64,
    frames: u32,
    bytes: u64,
}

/// Writes per-speaker segments into a directory.
pub struct SegmentWriter {
    dir: PathBuf,
    open: HashMap<u16, OpenSegment>,
    finished: Vec<Segment>,
    /// Total speech time per speaker, which is what the size budget is spent
    /// against later.
    talk_ms: HashMap<u16, i64>,
}

impl SegmentWriter {
    pub fn new(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            open: HashMap::new(),
            finished: Vec::new(),
            talk_ms: HashMap::new(),
        })
    }

    /// Feed one voice packet.
    ///
    /// An EMPTY frame is TeamSpeak saying "that speaker stopped", and closes
    /// the segment rather than being written into it.
    pub fn push(
        &mut self,
        speaker: u16,
        codec: u8,
        frame: &[u8],
        now_ms: i64,
    ) -> std::io::Result<()> {
        if frame.is_empty() {
            self.close_speaker(speaker, now_ms)?;
            return Ok(());
        }
        if frame.len() > MAX_FRAME_BYTES {
            return Ok(());
        }

        // A long gap means the closing frame never arrived; start fresh rather
        // than gluing two utterances into one with a hole in the middle.
        if let Some(seg) = self.open.get(&speaker) {
            if now_ms - seg.last_ms > SILENCE_GAP_MS {
                self.close_speaker(speaker, seg.last_ms)?;
            }
        }

        if !self.open.contains_key(&speaker) {
            let file = self.dir.join(format!("{speaker}-{now_ms}.a4sg"));
            let mut writer = BufWriter::new(File::create(&file)?);
            writer.write_all(SEGMENT_MAGIC)?;
            writer.write_all(&[SEGMENT_VERSION, codec, 0, 0])?;
            writer.write_all(&now_ms.to_le_bytes())?;
            self.open.insert(
                speaker,
                OpenSegment {
                    writer,
                    file,
                    start_ms: now_ms,
                    last_ms: now_ms,
                    frames: 0,
                    bytes: 0,
                },
            );
        }

        let seg = self.open.get_mut(&speaker).expect("just inserted");
        seg.writer.write_all(&(frame.len() as u16).to_le_bytes())?;
        seg.writer.write_all(frame)?;
        seg.frames += 1;
        seg.bytes += frame.len() as u64;
        seg.last_ms = now_ms;
        Ok(())
    }

    /// Close one speaker's open segment, if any.
    pub fn close_speaker(&mut self, speaker: u16, now_ms: i64) -> std::io::Result<()> {
        let Some(mut seg) = self.open.remove(&speaker) else {
            return Ok(());
        };
        seg.writer.flush()?;
        let end_ms = now_ms.max(seg.start_ms);
        *self.talk_ms.entry(speaker).or_insert(0) += end_ms - seg.start_ms;
        self.finished.push(Segment {
            speaker,
            start_ms: seg.start_ms,
            end_ms,
            frames: seg.frames,
            bytes: seg.bytes,
            file: seg.file,
        });
        Ok(())
    }

    /// Close everything still open. Called on stop, and on the way out of a
    /// crash-recovery path: a segment is only lost if it was never flushed.
    pub fn finish(&mut self, now_ms: i64) -> std::io::Result<Vec<Segment>> {
        let speakers: Vec<u16> = self.open.keys().copied().collect();
        for speaker in speakers {
            self.close_speaker(speaker, now_ms)?;
        }
        self.finished.sort_by_key(|s| (s.start_ms, s.speaker));
        Ok(self.finished.clone())
    }

    /// Segments closed so far, for a status readout mid-recording.
    pub fn segments(&self) -> &[Segment] {
        &self.finished
    }

    /// Speech time per speaker so far, in milliseconds.
    pub fn talk_ms(&self, speaker: u16) -> i64 {
        let open = self
            .open
            .get(&speaker)
            .map(|s| s.last_ms - s.start_ms)
            .unwrap_or(0);
        self.talk_ms.get(&speaker).copied().unwrap_or(0) + open
    }

    /// Total speech across every speaker, which is what the audio budget is
    /// sized against.
    pub fn total_talk_ms(&self) -> i64 {
        let speakers: Vec<u16> = self
            .talk_ms
            .keys()
            .chain(self.open.keys())
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        speakers.iter().map(|s| self.talk_ms(*s)).sum()
    }
}

/// Read a segment file back into its frames.
///
/// Used by the packing step, and by a re-transcribe of a session whose audio
/// is still on disk.
pub fn read_segment(path: impl AsRef<Path>) -> std::io::Result<(u8, i64, Vec<Vec<u8>>)> {
    let bytes = std::fs::read(path)?;
    if bytes.len() < SEGMENT_HEADER_BYTES || &bytes[0..4] != SEGMENT_MAGIC {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not a segment file",
        ));
    }
    if bytes[4] != SEGMENT_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unsupported segment version",
        ));
    }
    let codec = bytes[5];
    let start_ms = i64::from_le_bytes(bytes[8..16].try_into().expect("8 bytes"));

    let mut frames = Vec::new();
    let mut at = SEGMENT_HEADER_BYTES;
    while at + 2 <= bytes.len() {
        let len = u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize;
        at += 2;
        if len == 0 || at + len > bytes.len() {
            // A truncated tail is what a crash mid-write looks like. Keep the
            // frames that are whole rather than throwing the segment away.
            break;
        }
        frames.push(bytes[at..at + len].to_vec());
        at += len;
    }
    Ok((codec, start_ms, frames))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aim4-capture-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn an_empty_frame_ends_a_run_of_speech() {
        let dir = tmpdir("empty-frame");
        let mut w = SegmentWriter::new(&dir).unwrap();
        w.push(7, 5, &[1, 2, 3], 1000).unwrap();
        w.push(7, 5, &[4, 5, 6], 1020).unwrap();
        // TeamSpeak's own end-of-talking marker.
        w.push(7, 5, &[], 1040).unwrap();
        w.push(7, 5, &[9], 5000).unwrap();
        let segments = w.finish(5020).unwrap();

        assert_eq!(segments.len(), 2, "two separate utterances");
        assert_eq!(segments[0].frames, 2);
        assert_eq!(segments[0].start_ms, 1000);
        assert_eq!(segments[0].end_ms, 1040);
        assert_eq!(segments[1].start_ms, 5000);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_long_gap_also_ends_one_if_the_marker_was_lost() {
        let dir = tmpdir("gap");
        let mut w = SegmentWriter::new(&dir).unwrap();
        w.push(1, 5, &[1], 0).unwrap();
        w.push(1, 5, &[2], 20).unwrap();
        // No empty frame; just silence for well over the gap.
        w.push(1, 5, &[3], 20 + SILENCE_GAP_MS + 100).unwrap();
        let segments = w.finish(2000).unwrap();
        assert_eq!(segments.len(), 2, "the gap split them");
        assert_eq!(segments[0].end_ms, 20, "the first ends at its last frame");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn speakers_are_kept_apart_even_talking_over_each_other() {
        let dir = tmpdir("overlap");
        let mut w = SegmentWriter::new(&dir).unwrap();
        w.push(1, 5, &[0xaa], 0).unwrap();
        w.push(2, 5, &[0xbb], 10).unwrap();
        w.push(1, 5, &[0xaa], 20).unwrap();
        w.push(2, 5, &[0xbb], 30).unwrap();
        let segments = w.finish(50).unwrap();

        assert_eq!(segments.len(), 2, "one segment each, not one interleaved");
        let one = segments.iter().find(|s| s.speaker == 1).unwrap();
        let two = segments.iter().find(|s| s.speaker == 2).unwrap();
        assert_eq!(one.frames, 2);
        assert_eq!(two.frames, 2);

        let (_, _, frames) = read_segment(&one.file).unwrap();
        assert!(frames.iter().all(|f| f == &[0xaa]), "no cross-contamination");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn frames_survive_the_round_trip_exactly() {
        let dir = tmpdir("roundtrip");
        let mut w = SegmentWriter::new(&dir).unwrap();
        // Deliberately varied lengths: fixed-size framing would corrupt these.
        let sent: Vec<Vec<u8>> = vec![vec![1], vec![2; 60], vec![3; 7], vec![4; 300]];
        for (i, f) in sent.iter().enumerate() {
            w.push(3, 5, f, i as i64 * 20).unwrap();
        }
        let segments = w.finish(100).unwrap();

        let (codec, start_ms, frames) = read_segment(&segments[0].file).unwrap();
        assert_eq!(codec, 5);
        assert_eq!(start_ms, 0);
        assert_eq!(frames, sent, "every frame comes back byte for byte");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_truncated_segment_keeps_the_frames_that_are_whole() {
        let dir = tmpdir("truncated");
        let mut w = SegmentWriter::new(&dir).unwrap();
        w.push(1, 5, &[1; 40], 0).unwrap();
        w.push(1, 5, &[2; 40], 20).unwrap();
        let segments = w.finish(40).unwrap();

        // Lop off the tail, which is what a crash mid-write leaves behind.
        let mut bytes = std::fs::read(&segments[0].file).unwrap();
        bytes.truncate(bytes.len() - 25);
        std::fs::write(&segments[0].file, &bytes).unwrap();

        let (_, _, frames) = read_segment(&segments[0].file).unwrap();
        assert_eq!(frames.len(), 1, "the intact frame is still readable");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn talk_time_is_what_the_size_budget_gets_spent_against() {
        let dir = tmpdir("talk");
        let mut w = SegmentWriter::new(&dir).unwrap();
        // TeamSpeak sends voice every 20ms while a key is held, so continuous
        // speech is a dense run of frames. One second of talking, then silence.
        for t in (0..=1000).step_by(20) {
            w.push(1, 5, &[1], t).unwrap();
        }
        w.push(1, 5, &[], 1000).unwrap();
        for t in (0..=500).step_by(20) {
            w.push(2, 5, &[1], t).unwrap();
        }
        w.finish(500).unwrap();

        assert_eq!(w.talk_ms(1), 1000);
        assert_eq!(w.talk_ms(2), 500);
        assert_eq!(
            w.total_talk_ms(),
            1500,
            "the silence between them is never counted, which is why a 40 minute \
             map costs 45 speech-minutes and not 200"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pause_between_sentences_is_not_a_new_utterance() {
        // 200ms is a breath, not a gap: splitting there would chop sentences
        // into fragments and give Whisper nothing to work with.
        let dir = tmpdir("breath");
        let mut w = SegmentWriter::new(&dir).unwrap();
        w.push(1, 5, &[1], 0).unwrap();
        w.push(1, 5, &[1], 200).unwrap();
        let segments = w.finish(220).unwrap();
        assert_eq!(segments.len(), 1, "one utterance, not two");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_files_that_are_not_segments() {
        let dir = tmpdir("bad");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("nope.a4sg");
        std::fs::write(&p, b"hello there").unwrap();
        assert!(read_segment(&p).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
