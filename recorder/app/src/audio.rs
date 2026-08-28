//! Turning captured TeamSpeak Opus into the two things the pipeline needs:
//! PCM for Whisper, and small Ogg/Opus tracks for the `.aim4comms` file.
//!
//! Three jobs, all offline after the recording has stopped:
//!
//!   decode    captured frames -> 48 kHz mono PCM. TeamSpeak sends Opus voice
//!             (codec 4, mono) or Opus music (codec 5, stereo, downmixed).
//!   resample  48 kHz -> 16 kHz f32, which is the one input Whisper accepts.
//!   encode    PCM -> a self-contained Ogg/Opus stream at the budget bitrate.
//!             One stream per segment: each is an independent byte range in
//!             the container, which is exactly what the site's audio index
//!             addresses, and silence between utterances costs zero bytes
//!             because it is simply not there.
//!
//! Transcription always reads the decoded ORIGINAL frames, never the
//! re-encode, so the bitrate the budget picks can never cost accuracy.

use audiopus::coder::{Decoder, Encoder};
use audiopus::{Application, Bitrate, Channels, SampleRate};
use ogg::writing::{PacketWriteEndInfo, PacketWriter};

/// Everything TeamSpeak sends is 48 kHz.
pub const SAMPLE_RATE: usize = 48_000;
/// What Whisper expects.
pub const WHISPER_RATE: usize = 16_000;
/// The 20 ms frame the re-encode uses. TeamSpeak sends 20 ms frames too.
pub const FRAME_SAMPLES: usize = 960;
/// The largest frame Opus allows, 120 ms — sizing for anything smaller would
/// make a hostile or buggy segment file a crash instead of an error.
const MAX_FRAME_SAMPLES: usize = 5760;

/// TeamSpeak codec ids as they appear in the captured segments.
pub const CODEC_OPUS_VOICE: u8 = 4;
pub const CODEC_OPUS_MUSIC: u8 = 5;

#[derive(Debug)]
pub enum AudioError {
    /// Speex and CELT (codecs 0–3) predate every server this will meet; a
    /// segment carrying them is reported, not silently dropped.
    UnsupportedCodec(u8),
    Opus(audiopus::Error),
    Io(std::io::Error),
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioError::UnsupportedCodec(c) => write!(f, "unsupported voice codec {c}"),
            AudioError::Opus(e) => write!(f, "opus: {e}"),
            AudioError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for AudioError {}

impl From<audiopus::Error> for AudioError {
    fn from(e: audiopus::Error) -> Self {
        AudioError::Opus(e)
    }
}

impl From<std::io::Error> for AudioError {
    fn from(e: std::io::Error) -> Self {
        AudioError::Io(e)
    }
}

/// Decode one captured segment's frames to 48 kHz mono PCM.
///
/// One decoder per segment, fed every frame in order: Opus decoders carry
/// state between frames, and a fresh decoder per frame would click and warble.
pub fn decode_frames(codec: u8, frames: &[Vec<u8>]) -> Result<Vec<i16>, AudioError> {
    let channels = match codec {
        CODEC_OPUS_VOICE => Channels::Mono,
        CODEC_OPUS_MUSIC => Channels::Stereo,
        other => return Err(AudioError::UnsupportedCodec(other)),
    };
    let mut decoder = Decoder::new(SampleRate::Hz48000, channels)?;
    let per_channel = MAX_FRAME_SAMPLES;
    let mut buf = vec![0i16; per_channel * 2];
    let mut out = Vec::with_capacity(frames.len() * FRAME_SAMPLES);

    for frame in frames {
        if frame.is_empty() {
            continue;
        }
        let samples = match decoder.decode(Some(frame.as_slice()), &mut buf[..], false) {
            Ok(n) => n,
            // One corrupt frame is a lost packet's worth of audio, not a lost
            // recording. Skip it and let the decoder resync on the next one.
            Err(_) => continue,
        };
        match channels {
            Channels::Mono => out.extend_from_slice(&buf[..samples]),
            _ => {
                // Interleaved stereo -> mono by averaging. Music codec is what
                // TeamSpeak uses for higher-quality channels; voices in it are
                // centered, so the average IS the voice.
                for i in 0..samples {
                    let l = buf[i * 2] as i32;
                    let r = buf[i * 2 + 1] as i32;
                    out.push(((l + r) / 2) as i16);
                }
            }
        }
    }
    Ok(out)
}

/// 48 kHz i16 -> 16 kHz f32 for Whisper: low-pass, then every third sample.
///
/// The filter matters: bare decimation folds everything above 8 kHz back into
/// the speech band as noise Whisper then has to transcribe through. A 45-tap
/// windowed sinc at 7 kHz is flat where voices live and ~60 dB down where the
/// aliases would come from.
pub fn resample_to_16k(pcm48: &[i16]) -> Vec<f32> {
    const TAPS: usize = 45;
    const CUTOFF: f64 = 7_000.0 / 48_000.0;
    let mid = (TAPS / 2) as isize;

    // Windowed sinc, normalized to unity gain at DC.
    let mut taps = [0f64; TAPS];
    let mut sum = 0f64;
    for (k, tap) in taps.iter_mut().enumerate() {
        let n = k as isize - mid;
        let sinc = if n == 0 {
            2.0 * CUTOFF
        } else {
            let x = std::f64::consts::PI * n as f64;
            (2.0 * CUTOFF * x).sin() / x
        };
        let hamming = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * k as f64 / (TAPS - 1) as f64).cos();
        *tap = sinc * hamming;
        sum += *tap;
    }
    for tap in taps.iter_mut() {
        *tap /= sum;
    }

    let mut out = Vec::with_capacity(pcm48.len() / 3 + 1);
    let mut at = 0usize;
    while at < pcm48.len() {
        let mut acc = 0f64;
        for (k, tap) in taps.iter().enumerate() {
            let idx = at as isize + (k as isize - mid);
            if idx >= 0 && (idx as usize) < pcm48.len() {
                acc += tap * pcm48[idx as usize] as f64;
            }
        }
        out.push((acc / 32768.0) as f32);
        at += 3;
    }
    out
}

/// Encode mono 48 kHz PCM into one complete Ogg/Opus stream.
///
/// Self-contained on purpose: every track in the container must decode alone,
/// because the site hands the browser one byte range at a time. The ~95 bytes
/// of OpusHead/OpusTags per track is the price of that, and the budget's
/// framing estimate accounts for it.
pub fn encode_ogg_opus(pcm: &[i16], bitrate: u32, serial: u32) -> Result<Vec<u8>, AudioError> {
    let mut encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)?;
    encoder.set_bitrate(Bitrate::BitsPerSecond(bitrate as i32))?;
    // The encoder's own delay. Written into OpusHead so players drop exactly
    // that many samples and playback starts where the speech does.
    let pre_skip = encoder.lookahead()? as u64;

    let mut out = Vec::with_capacity(pcm.len() / 8);
    let mut writer = PacketWriter::new(&mut out);
    writer.write_packet(opus_head(pre_skip as u16), serial, PacketWriteEndInfo::EndPage, 0)?;
    writer.write_packet(opus_tags(), serial, PacketWriteEndInfo::EndPage, 0)?;

    let mut packet = [0u8; 4000];
    let mut frame = [0i16; FRAME_SAMPLES];
    let mut done = 0usize;
    while done < pcm.len() {
        let n = (pcm.len() - done).min(FRAME_SAMPLES);
        frame[..n].copy_from_slice(&pcm[done..done + n]);
        // The tail is zero-padded to a whole frame; the final granule position
        // counts only real samples, which is Ogg's way of trimming the pad.
        frame[n..].fill(0);
        let bytes = encoder.encode(&frame, &mut packet)?;
        done += n;
        let end = done >= pcm.len();
        writer.write_packet(
            packet[..bytes].to_vec(),
            serial,
            if end { PacketWriteEndInfo::EndStream } else { PacketWriteEndInfo::NormalPacket },
            pre_skip + done as u64,
        )?;
    }
    drop(writer);
    Ok(out)
}

/// RFC 7845 identification header: mono, 48 kHz, mapping family 0.
fn opus_head(pre_skip: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(1); // channels
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain
    h.push(0); // channel mapping family
    h
}

/// The smallest legal comment header. Every byte here is paid per track.
fn opus_tags() -> Vec<u8> {
    let vendor = b"aim4";
    let mut t = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor);
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use ogg::reading::PacketReader;

    fn sine(hz: f64, ms: usize, rate: usize) -> Vec<i16> {
        (0..rate * ms / 1000)
            .map(|i| {
                let t = i as f64 / rate as f64;
                ((t * hz * 2.0 * std::f64::consts::PI).sin() * 12_000.0) as i16
            })
            .collect()
    }

    fn zero_crossings(samples: &[f32]) -> usize {
        samples.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count()
    }

    #[test]
    fn the_resampler_keeps_the_voice_band() {
        // A 1 kHz tone crosses zero 2000 times a second at any sample rate; if
        // the resampler shifts or mangles the band Whisper listens to, this is
        // where it shows.
        let out = resample_to_16k(&sine(1_000.0, 1000, SAMPLE_RATE));
        assert_eq!(out.len(), WHISPER_RATE, "3:1 decimation, sample for sample");
        let crossings = zero_crossings(&out);
        assert!((1900..=2100).contains(&crossings), "1 kHz stayed 1 kHz: {crossings}");
    }

    #[test]
    fn the_resampler_removes_what_would_alias() {
        // 10 kHz cannot be represented at 16 kHz; without the filter it would
        // fold back to 6 kHz as loud garbage right in the speech band.
        let clean = resample_to_16k(&sine(1_000.0, 500, SAMPLE_RATE));
        let folded = resample_to_16k(&sine(10_000.0, 500, SAMPLE_RATE));
        let rms = |s: &[f32]| (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt();
        assert!(
            rms(&folded) < rms(&clean) / 10.0,
            "aliasing energy survived: {} vs {}",
            rms(&folded),
            rms(&clean)
        );
    }

    /// The whole loop TeamSpeak capture feeds into: encode 20 ms frames the
    /// way a client would, decode them the way the pipeline does.
    #[test]
    fn captured_frames_decode_back_to_continuous_audio() {
        let pcm = sine(440.0, 500, SAMPLE_RATE);
        let mut enc = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip).unwrap();
        enc.set_bitrate(Bitrate::BitsPerSecond(32_000)).unwrap();
        let mut frames = Vec::new();
        let mut buf = [0u8; 4000];
        for chunk in pcm.chunks_exact(FRAME_SAMPLES) {
            let n = enc.encode(chunk, &mut buf).unwrap();
            frames.push(buf[..n].to_vec());
        }

        let out = decode_frames(CODEC_OPUS_VOICE, &frames).unwrap();
        assert_eq!(out.len(), frames.len() * FRAME_SAMPLES, "every frame came back");
        // The decode is lossy but the tone must survive it recognizably.
        let f32s: Vec<f32> = out.iter().map(|s| *s as f32 / 32768.0).collect();
        let per_second = zero_crossings(&f32s[FRAME_SAMPLES..]) as f64
            / ((f32s.len() - FRAME_SAMPLES) as f64 / SAMPLE_RATE as f64);
        assert!((760.0..=1000.0).contains(&per_second), "440 Hz survived: {per_second}");
    }

    #[test]
    fn speex_era_codecs_are_an_error_not_a_crash() {
        assert!(matches!(
            decode_frames(0, &[vec![1, 2, 3]]),
            Err(AudioError::UnsupportedCodec(0))
        ));
    }

    #[test]
    fn corrupt_frames_are_skipped_not_fatal() {
        let pcm = sine(440.0, 100, SAMPLE_RATE);
        let enc = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip).unwrap();
        let mut buf = [0u8; 4000];
        let n = enc.encode(&pcm[..FRAME_SAMPLES], &mut buf).unwrap();
        let good = buf[..n].to_vec();
        let garbage = vec![0xff; 300];
        let out = decode_frames(CODEC_OPUS_VOICE, &[good.clone(), garbage, good]).unwrap();
        assert_eq!(out.len(), 2 * FRAME_SAMPLES, "both good frames, no crash between");
    }

    /// The track the site stores must be a decodable, correctly-lengthed
    /// Ogg/Opus stream — checked by actually reading it back, not by trusting
    /// the writer.
    #[test]
    fn an_encoded_track_reads_back_as_valid_ogg_opus() {
        // 1030 ms on purpose: a partial final frame proves the end-trim.
        let pcm = sine(440.0, 1030, SAMPLE_RATE);
        let track = encode_ogg_opus(&pcm, 16_000, 7).unwrap();
        assert_eq!(&track[..4], b"OggS", "it is an Ogg stream");

        let mut reader = PacketReader::new(std::io::Cursor::new(&track));
        let head = reader.read_packet_expected().unwrap();
        assert_eq!(&head.data[..8], b"OpusHead");
        let pre_skip = u16::from_le_bytes([head.data[10], head.data[11]]) as u64;
        let tags = reader.read_packet_expected().unwrap();
        assert_eq!(&tags.data[..8], b"OpusTags");

        let mut decoder = Decoder::new(SampleRate::Hz48000, Channels::Mono).unwrap();
        let mut buf = vec![0i16; MAX_FRAME_SAMPLES];
        let mut samples = 0u64;
        let mut last_granule = 0u64;
        while let Some(packet) = reader.read_packet().unwrap() {
            samples += decoder
                .decode(Some(packet.data.as_slice()), &mut buf[..], false)
                .unwrap() as u64;
            last_granule = packet.absgp_page();
        }

        // Whole frames decoded, final granule trims the pad to the real length.
        assert_eq!(samples % FRAME_SAMPLES as u64, 0);
        assert_eq!(last_granule, pre_skip + pcm.len() as u64, "granule = real samples");
        assert!(samples >= pcm.len() as u64, "nothing was lost");
    }

    #[test]
    fn track_size_is_near_the_bitrate_it_asked_for() {
        // 10 s at 16 kbps is 20 KB of audio; headers and paging add a little.
        // If this drifts far, the budget's arithmetic no longer describes what
        // the encoder actually produces.
        let pcm = sine(300.0, 10_000, SAMPLE_RATE);
        let track = encode_ogg_opus(&pcm, 16_000, 1).unwrap();
        let audio_bytes = 10.0 * 16_000.0 / 8.0;
        let ratio = track.len() as f64 / audio_bytes;
        assert!((0.5..=1.25).contains(&ratio), "10s @ 16k = {} bytes", track.len());
    }
}
