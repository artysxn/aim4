//! aim4 comms recorder.
//!
//! Records a TeamSpeak channel with one track per speaker, transcribes it
//! locally after the user stops, and writes a `.aim4comms` file they upload to
//! a game in the aim4 viewer.
//!
//! Ships as ONE .exe. No installer, no zip, no folder: the user downloads a
//! file, runs it, and it replaces itself whenever aim4 publishes a new build.
//!
//! Build order, and where each piece stands:
//!
//!   1. container writer      done — `core::format`, matches the site
//!   2. self-update           done — `update`, verified end to end
//!   3. anchor detection      done — `core::countdown`, ported from the JS
//!   4. segment capture       done — `core::capture`, framing and splitting
//!   5. size budget           done — `core::budget`
//!   6. TeamSpeak capture     built — `teamspeak`; compiles against the real
//!                            protocol library, but only a real server can
//!                            prove it connects. `--record` is how.
//!   7. transcription         done — `transcribe`, whisper.cpp in-process
//!   8. packing to budget     done — `audio` + `pipeline`, measured not hoped
//!   9. egui window           done — `ui`, the no-arguments path

// The window, not a console, is what a double-click on Windows should open.
// The CLI still works there but prints nothing in release builds; use the
// window, or a debug build, when the text output matters.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod audio;
mod pipeline;
mod teamspeak;
mod transcribe;
mod ui;
mod update;

use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use aim4_recorder_core::format::{pack, Manifest, Speaker, Sync, Utterance, SYNC_FREEZE_END_R1, VERSION};

fn selftest(out: &str) -> Result<(), Box<dyn std::error::Error>> {
    let manifest = Manifest {
        version: VERSION,
        name: "selftest".into(),
        recorded_at: "2026-08-27T19:30:00Z".into(),
        lang: "en".into(),
        model: "selftest".into(),
        duration_ms: 30_000,
        sync: Sync {
            // 10s in, as if "record, three, two, one" had been found there.
            anchor_ms: Some(10_000),
            kind: SYNC_FREEZE_END_R1.into(),
            detected: true,
            confidence: 1.0,
        },
        speakers: vec![
            Speaker {
                uid: "selftest-uid-0".into(),
                nickname: "caller".into(),
                talk_ms: 4_500,
            },
            Speaker {
                uid: "selftest-uid-1".into(),
                nickname: "support".into(),
                talk_ms: 1_400,
            },
        ],
        audio: None,
        utterances: vec![
            Utterance {
                speaker: 0,
                start_ms: 6_000,
                end_ms: 9_500,
                text: "record three two one".into(),
                conf: Some(0.95),
            },
            Utterance {
                speaker: 0,
                start_ms: 12_000,
                end_ms: 13_000,
                text: "two banana".into(),
                conf: Some(0.86),
            },
            Utterance {
                speaker: 1,
                start_ms: 13_400,
                end_ms: 14_800,
                text: "rotate to B".into(),
                conf: Some(0.81),
            },
        ],
    };

    let bytes = pack(&manifest, &[])?;
    std::fs::write(out, &bytes)?;
    println!("wrote {out} ({} bytes)", bytes.len());
    println!("verify it with: node ../aim4/tools/comms/verify.mjs {out}");
    Ok(())
}

/// Ask the feed whether there is anything newer, and say so.
fn check_update(base: &str) -> ExitCode {
    match update::check(base, env!("CARGO_PKG_VERSION")) {
        Ok(None) => {
            println!("up to date ({})", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Some(m)) => {
            println!(
                "update available: {} -> {} ({} bytes)",
                env!("CARGO_PKG_VERSION"),
                m.version,
                m.size_bytes
            );
            if !m.notes.is_empty() {
                println!("  {}", m.notes);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("update check failed: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Check, download, verify, and replace this executable.
///
/// `recording` is hard-coded false here because the CLI path only runs when
/// nothing is being captured; once the window exists it passes the real
/// session state, which is what stops an update landing mid-scrim.
fn do_update(base: &str) -> ExitCode {
    let manifest = match update::check(base, env!("CARGO_PKG_VERSION")) {
        Ok(None) => {
            println!("already up to date ({})", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Ok(Some(m)) => m,
        Err(err) => {
            eprintln!("update check failed: {err}");
            return ExitCode::FAILURE;
        }
    };

    println!(
        "downloading {} -> {} ({} bytes)",
        env!("CARGO_PKG_VERSION"),
        manifest.version,
        manifest.size_bytes
    );
    let bytes = match update::download(base, &manifest) {
        Ok(b) => b,
        Err(err) => {
            // A checksum mismatch lands here, which is the whole point: the
            // running program is left alone rather than overwritten with a
            // truncated download that happened to return 200.
            eprintln!("download failed: {err}");
            return ExitCode::FAILURE;
        }
    };

    match update::apply(&bytes, false) {
        Ok(()) => {
            println!("updated to {}. Restart to run it.", manifest.version);
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("could not apply the update: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Join a channel and record it until Ctrl+C.
///
/// The command line is how this gets proved against a real server before the
/// window exists, and it stays afterwards: it is the fastest way to answer
/// "does it connect to *this* server" without any UI in the way.
fn record(address: &str, channel: Option<&str>, out: &str) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("could not start the runtime: {err}");
            return ExitCode::FAILURE;
        }
    };

    let identity_path = settings_dir().join("identity.txt");
    let identity = match teamspeak::load_or_create_identity(&identity_path) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("could not load an identity: {err}");
            return ExitCode::FAILURE;
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        // Ctrl+C is Stop. Setting the flag rather than aborting is what lets
        // the open segments close and the bot leave the channel cleanly.
        if let Err(err) = ctrl_c_handler(stop) {
            eprintln!("could not install the stop handler: {err}");
            return ExitCode::FAILURE;
        }
    }

    let cfg = teamspeak::SessionConfig {
        address: address.to_string(),
        nickname: "aim4 recorder".into(),
        channel: channel.map(str::to_string),
        server_password: std::env::var("AIM4_TS_PASSWORD").ok(),
        channel_password: std::env::var("AIM4_TS_CHANNEL_PASSWORD").ok(),
        identity,
    };

    println!("connecting to {address}...  (Ctrl+C to stop)");
    match runtime.block_on(teamspeak::record(cfg, out, stop, None)) {
        Ok(result) => {
            println!();
            if let Some(why) = &result.interrupted {
                println!("NOTE: the session ended on its own — {why}");
                println!("      everything captured up to that point is saved below.");
            }
            println!("recorded {} ms into {}", result.duration_ms, result.dir.display());
            println!("{} segments from {} speakers:", result.segments.len(), result.speakers.len());
            for (id, s) in &result.speakers {
                println!(
                    "  {:<24} {:>7} ms talking   uid {}",
                    if s.nickname.is_empty() { format!("client {id}") } else { s.nickname.clone() },
                    s.talk_ms,
                    if s.uid.is_empty() { "(unknown)" } else { &s.uid }
                );
            }
            match pipeline::save_session(&result) {
                Ok(path) => println!("session saved: {}", path.display()),
                Err(err) => eprintln!("could not save session.json: {err}"),
            }
            println!("pack it with: --pack {} <lang> [name]", result.dir.display());
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("recording failed: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Where settings and the TeamSpeak identity live.
fn settings_dir() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("aim4-recorder")
}

fn ctrl_c_handler(stop: Arc<AtomicBool>) -> std::io::Result<()> {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("a single-threaded runtime for the signal wait");
        rt.block_on(async {
            if tokio::signal::ctrl_c().await.is_ok() {
                println!("\nstopping...");
                stop.store(true, Ordering::Relaxed);
            }
        });
    });
    Ok(())
}

fn main() -> ExitCode {
    // Clear the leftover from a previous in-place update. Done here because at
    // swap time that file is the one executing and Windows will not delete it.
    if let Ok(exe) = std::env::current_exe() {
        update::clean_previous(&exe);
    }

    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--selftest") => {
            let out = args.get(2).map(String::as_str).unwrap_or("selftest.aim4comms");
            match selftest(out) {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    eprintln!("selftest failed: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("--check-update") => {
            let base = args.get(2).map(String::as_str).unwrap_or(update::DEFAULT_BASE_URL);
            check_update(base)
        }
        Some("--record") => {
            let Some(address) = args.get(2) else {
                eprintln!("usage: --record <server> [channel] [out-dir]");
                return ExitCode::FAILURE;
            };
            let channel = args.get(3).map(String::as_str).filter(|c| !c.is_empty());
            let out = args.get(4).map(String::as_str).unwrap_or("recording");
            record(address, channel, out)
        }
        Some("--update") => {
            let base = args.get(2).map(String::as_str).unwrap_or(update::DEFAULT_BASE_URL);
            do_update(base)
        }
        Some("--pack") => {
            let (Some(dir), Some(lang)) = (args.get(2), args.get(3)) else {
                eprintln!("usage: --pack <session-dir> <lang> [name] [model]");
                return ExitCode::FAILURE;
            };
            let name = args.get(4).cloned().unwrap_or_else(|| "comms".into());
            let model = args
                .get(5)
                .map(String::as_str)
                .unwrap_or(transcribe::DEFAULT_MODEL);
            pack_cmd(std::path::Path::new(dir), lang, &name, model)
        }
        Some("--ingest-wav") => {
            // Dev tool: turn any 48 kHz wav into a captured segment, so the
            // whole pipeline runs without a TeamSpeak server in the room.
            let (Some(dir), Some(speaker), Some(start), Some(wav)) =
                (args.get(2), args.get(3), args.get(4), args.get(5))
            else {
                eprintln!("usage: --ingest-wav <session-dir> <speaker-id> <start-ms> <file.wav>");
                return ExitCode::FAILURE;
            };
            let (Ok(speaker), Ok(start)) = (speaker.parse::<u16>(), start.parse::<i64>()) else {
                eprintln!("speaker-id and start-ms must be numbers");
                return ExitCode::FAILURE;
            };
            match pipeline::ingest_wav(
                std::path::Path::new(dir),
                speaker,
                start,
                std::path::Path::new(wav),
            ) {
                Ok(path) => {
                    println!("ingested into {}", path.display());
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("ingest failed: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("--help") | Some("-h") => {
            usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("unknown option {other}");
            usage();
            ExitCode::FAILURE
        }
        // No arguments is the double-click path: open the window.
        None => match ui::run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("could not open the window: {err}");
                usage();
                ExitCode::FAILURE
            }
        },
    }
}

fn usage() {
    eprintln!("aim4-recorder {}", env!("CARGO_PKG_VERSION"));
    eprintln!();
    eprintln!("Run without arguments to open the window. Command line:");
    eprintln!();
    eprintln!("  --record <server> [chan] [dir]        join a channel and record it");
    eprintln!("  --pack <dir> <lang> [name] [model]    transcribe a session and write .aim4comms");
    eprintln!("  --check-update [base-url]             ask aim4 for a newer build");
    eprintln!("  --update [base-url]                   download it and replace this file");
    eprintln!("  --selftest [out.aim4comms]            write a valid container and stop");
    eprintln!("  --ingest-wav <dir> <spk> <ms> <wav>   (dev) fake a captured segment from a wav");
}

/// Transcribe and pack a recorded session from the command line.
fn pack_cmd(dir: &std::path::Path, lang: &str, name: &str, model: &str) -> ExitCode {
    let models_dir = settings_dir().join("models");
    println!("model: {model}");
    let model_path = match transcribe::ensure_model(model, &models_dir, &mut |done, total| {
        if total > 0 {
            print!("\rdownloading model: {:>3}%", done * 100 / total);
            use std::io::Write;
            std::io::stdout().flush().ok();
        }
    }) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("could not get the model: {err}");
            return ExitCode::FAILURE;
        }
    };
    // End the \r progress line before normal printing resumes.
    println!();

    let opts = pipeline::PackOptions {
        lang: lang.to_string(),
        name: name.to_string(),
        out_dir: None,
    };
    let mut last_line = String::new();
    let report = pipeline::pack_session(dir, &model_path, &opts, &mut |p| {
        let line = match p {
            pipeline::Progress::Transcribing { done, total } => {
                format!("transcribing {done}/{total}")
            }
            pipeline::Progress::Encoding { bitrate } => format!("encoding at {} kbps", bitrate / 1000),
            pipeline::Progress::Writing => "writing".to_string(),
        };
        if line != last_line {
            println!("{line}");
            last_line = line;
        }
    });

    match report {
        Ok(r) => {
            println!();
            println!("wrote {} ({} bytes, {} kbps)", r.path.display(), r.bytes, r.bitrate / 1000);
            println!("  {} utterances from {} ms of speech", r.utterances, r.speech_ms);
            match r.anchor {
                Some((ms, true)) => println!("  sync anchor found at {ms} ms (cued)"),
                Some((ms, false)) => {
                    println!("  possible anchor at {ms} ms — no cue word, the viewer will ask")
                }
                None => println!("  no countdown found — the viewer will ask for the anchor"),
            }
            if r.over_budget {
                println!("  NOTE: over the 2 MB target even at the floor bitrate; still uploadable");
            }
            if r.skipped > 0 {
                println!("  {} segment file(s) were missing or unreadable", r.skipped);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("packing failed: {err}");
            ExitCode::FAILURE
        }
    }
}
