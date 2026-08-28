//! The window: what opens when someone double-clicks the exe.
//!
//! One screen, top to bottom in the order things happen: update banner,
//! connect-and-record, then transcribe-and-pack. No wizard, no tabs — a
//! person mid-scrim gets exactly two buttons that matter, Record and Stop,
//! and after the game one more, Pack.
//!
//! Threading: egui repaints on its own clock and must never block, so the
//! recording and packing both run on plain threads that report back through
//! shared state and an mpsc channel. The UI thread only ever try_recv()s.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use eframe::egui;
use serde::{Deserialize, Serialize};

use crate::teamspeak::{self, LiveStatus};
use crate::transcribe::{self, MODELS};
use crate::{pipeline, update};

/// The site's languages, with names a dropdown can show. Codes must stay a
/// subset of shared/comms/format.js LANGUAGES or the site rejects the file.
const LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("da", "Danish"),
    ("es", "Spanish"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("no", "Norwegian"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sv", "Swedish"),
    ("uk", "Ukrainian"),
    ("zh", "Chinese"),
];

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([540.0, 600.0])
            .with_min_inner_size([460.0, 480.0]),
        ..Default::default()
    };
    eframe::run_native(
        "aim4 comms recorder",
        options,
        Box::new(|_cc| Ok(Box::new(App::new()))),
    )
    .map_err(|e| format!("{e}").into())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    server: String,
    channel: String,
    nickname: String,
    lang: String,
    model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: String::new(),
            channel: String::new(),
            nickname: "aim4 recorder".into(),
            lang: "en".into(),
            model: transcribe::DEFAULT_MODEL.into(),
        }
    }
}

/// What the background threads are doing, if anything.
enum Busy {
    Idle,
    Recording {
        stop: Arc<AtomicBool>,
        live: Arc<Mutex<LiveStatus>>,
        started: Instant,
        done: Receiver<Result<(PathBuf, Option<String>), String>>,
    },
    Packing {
        status: Arc<Mutex<String>>,
        done: Receiver<Result<(String, PathBuf), String>>,
    },
}

/// The update check's answer, filled in by a thread after launch.
enum UpdateState {
    Checking,
    UpToDate,
    Available(update::Manifest),
    Installing,
    Installed(String),
    Failed(String),
}

pub struct App {
    settings: Settings,
    busy: Busy,
    /// Session folders under the recordings root, newest first.
    sessions: Vec<PathBuf>,
    selected_session: usize,
    pack_name: String,
    /// Passwords are asked for, used, and forgotten: they are never written
    /// to settings.json, because that file is plain text on disk.
    server_password: String,
    channel_password: String,
    notice: Option<String>,
    error: Option<String>,
    update: Arc<Mutex<UpdateState>>,
    last_packed: Option<PathBuf>,
    /// Read by the update installer at the moment it swaps the exe. A shared
    /// flag rather than the UI's own state because the install runs on a
    /// thread: the user can click Install, then start recording while the
    /// download is still going, and the swap must see THAT, not the state
    /// from when the button was clicked.
    recording_now: Arc<AtomicBool>,
}

impl App {
    fn new() -> Self {
        let settings = load_settings();
        let update = Arc::new(Mutex::new(UpdateState::Checking));
        {
            let update = update.clone();
            std::thread::spawn(move || {
                let state = match update::check(update::DEFAULT_BASE_URL, env!("CARGO_PKG_VERSION")) {
                    Ok(Some(m)) => UpdateState::Available(m),
                    Ok(None) => UpdateState::UpToDate,
                    // An update check failing must never get in the way of
                    // recording; it becomes a quiet line, not a dialog.
                    Err(e) => UpdateState::Failed(e.to_string()),
                };
                if let Ok(mut u) = update.lock() {
                    *u = state;
                }
            });
        }
        let mut app = Self {
            settings,
            busy: Busy::Idle,
            sessions: Vec::new(),
            selected_session: 0,
            pack_name: String::new(),
            server_password: String::new(),
            channel_password: String::new(),
            notice: None,
            error: None,
            update,
            last_packed: None,
            recording_now: Arc::new(AtomicBool::new(false)),
        };
        app.rescan_sessions();
        app
    }

    fn rescan_sessions(&mut self) {
        self.sessions = list_sessions(&recordings_root());
        if self.selected_session >= self.sessions.len() {
            self.selected_session = 0;
        }
    }

    fn start_recording(&mut self) {
        save_settings(&self.settings);
        self.error = None;
        self.notice = None;

        let dir = recordings_root().join(session_name());
        let stop = Arc::new(AtomicBool::new(false));
        let live = Arc::new(Mutex::new(LiveStatus::default()));
        let (tx, rx) = std::sync::mpsc::channel();

        let cfg_stop = stop.clone();
        let cfg_live = live.clone();
        let cfg = teamspeak::SessionConfig {
            address: self.settings.server.trim().to_string(),
            nickname: if self.settings.nickname.trim().is_empty() {
                "aim4 recorder".into()
            } else {
                self.settings.nickname.trim().to_string()
            },
            channel: none_if_empty(&self.settings.channel),
            server_password: none_if_empty(&self.server_password),
            channel_password: none_if_empty(&self.channel_password),
            identity: match teamspeak::load_or_create_identity(crate::settings_dir().join("identity.txt")) {
                Ok(id) => id,
                Err(e) => {
                    self.error = Some(format!("could not load an identity: {e}"));
                    return;
                }
            },
        };

        self.recording_now.store(true, Ordering::Relaxed);
        std::thread::spawn(move || {
            let result = (|| -> Result<(PathBuf, Option<String>), String> {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| e.to_string())?;
                let result = runtime
                    .block_on(teamspeak::record(cfg, &dir, cfg_stop, Some(cfg_live)))
                    .map_err(|e| e.to_string())?;
                pipeline::save_session(&result).map_err(|e| e.to_string())?;
                Ok((result.dir, result.interrupted))
            })();
            tx.send(result).ok();
        });

        self.busy = Busy::Recording {
            stop,
            live,
            started: Instant::now(),
            done: rx,
        };
    }

    fn start_packing(&mut self) {
        save_settings(&self.settings);
        self.error = None;
        self.notice = None;
        let Some(dir) = self.sessions.get(self.selected_session).cloned() else {
            self.error = Some("no recording selected".into());
            return;
        };
        let name = if self.pack_name.trim().is_empty() {
            dir.file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("comms")
                .to_string()
        } else {
            self.pack_name.trim().to_string()
        };
        let lang = self.settings.lang.clone();
        let model = self.settings.model.clone();

        let status = Arc::new(Mutex::new("starting".to_string()));
        let (tx, rx) = std::sync::mpsc::channel();
        let status_bg = status.clone();

        std::thread::spawn(move || {
            let set = |s: String| {
                if let Ok(mut st) = status_bg.lock() {
                    *st = s;
                }
            };
            let result = (|| -> Result<(String, PathBuf), String> {
                let models_dir = crate::settings_dir().join("models");
                let model_path = transcribe::ensure_model(&model, &models_dir, &mut |done, total| {
                    if total > 0 {
                        set(format!("downloading model  {}%", done * 100 / total));
                    }
                })
                .map_err(|e| e.to_string())?;

                let opts = pipeline::PackOptions { lang, name, out_dir: None };
                let report = pipeline::pack_session(&dir, &model_path, &opts, &mut |p| {
                    set(match p {
                        pipeline::Progress::Transcribing { done, total } => {
                            format!("transcribing  {done}/{total}")
                        }
                        pipeline::Progress::Encoding { bitrate } => {
                            format!("encoding at {} kbps", bitrate / 1000)
                        }
                        pipeline::Progress::Writing => "writing".into(),
                    })
                })
                .map_err(|e| e.to_string())?;

                let mut lines = vec![format!(
                    "{}  ({:.2} MB at {} kbps)",
                    report.path.display(),
                    report.bytes as f64 / 1024.0 / 1024.0,
                    report.bitrate / 1000
                )];
                lines.push(match report.anchor {
                    Some((ms, true)) => format!("sync anchor found at {}", mmss(ms)),
                    Some((ms, false)) => {
                        format!("possible anchor at {} — no cue word, the viewer will ask", mmss(ms))
                    }
                    None => "no countdown found — the viewer will ask for the anchor".into(),
                });
                if report.over_budget {
                    lines.push("over the 2 MB target even at the floor bitrate; still fine to upload".into());
                }
                if report.skipped > 0 {
                    lines.push(format!("{} segment file(s) were unreadable", report.skipped));
                }
                Ok((lines.join("\n"), report.path))
            })();
            tx.send(result).ok();
        });

        self.busy = Busy::Packing { status, done: rx };
    }
}

impl eframe::App for App {
    /// State only — eframe 0.36 splits the frame into `logic` (may not paint)
    /// and `ui` (paints). Collecting finished background work here means the
    /// paint pass below always draws a settled state.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let mut next_busy: Option<Busy> = None;
        match &self.busy {
            Busy::Recording { done, .. } => match done.try_recv() {
                Ok(Ok((dir, interrupted))) => {
                    self.notice = Some(match interrupted {
                        Some(why) => format!(
                            "recording saved: {} — the session ended on its own ({why}); \
                             everything up to that point is in it",
                            dir.display()
                        ),
                        None => format!("recording saved: {}", dir.display()),
                    });
                    self.rescan_sessions();
                    if let Some(i) = self.sessions.iter().position(|s| *s == dir) {
                        self.selected_session = i;
                    }
                    next_busy = Some(Busy::Idle);
                }
                Ok(Err(e)) => {
                    self.error = Some(format!("recording failed: {e}"));
                    next_busy = Some(Busy::Idle);
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.error = Some("the recording thread vanished".into());
                    next_busy = Some(Busy::Idle);
                }
            },
            Busy::Packing { done, .. } => match done.try_recv() {
                Ok(Ok((summary, path))) => {
                    self.last_packed = Some(path);
                    self.notice = Some(summary);
                    next_busy = Some(Busy::Idle);
                }
                Ok(Err(e)) => {
                    self.error = Some(format!("packing failed: {e}"));
                    next_busy = Some(Busy::Idle);
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.error = Some("the packing thread vanished".into());
                    next_busy = Some(Busy::Idle);
                }
            },
            Busy::Idle => {}
        }
        if let Some(b) = next_busy {
            self.busy = b;
        }
        // Kept in sync every frame so the update installer always reads the
        // truth, however the recording state changed.
        self.recording_now
            .store(matches!(self.busy, Busy::Recording { .. }), Ordering::Relaxed);

        if !matches!(self.busy, Busy::Idle) {
            ctx.request_repaint_after(std::time::Duration::from_millis(250));
        }
    }

    /// Closing the window mid-recording must not lose the session: signal
    /// Stop and give the capture thread a moment to close its segments and
    /// write session.json, exactly as if the button had been pressed.
    fn on_exit(&mut self) {
        if let Busy::Recording { stop, done, .. } = &self.busy {
            stop.store(true, Ordering::Relaxed);
            done.recv_timeout(std::time::Duration::from_secs(5)).ok();
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // The bare root Ui has no margins or background; this is 0.36's
        // replacement for wrapping everything in a CentralPanel.
        egui::Frame::central_panel(ui.style().as_ref()).show(ui, |ui| {
            ui.heading("aim4 comms recorder");
            ui.label(format!("v{}", env!("CARGO_PKG_VERSION")));
            self.update_banner(ui);
            ui.separator();

            match &self.busy {
                Busy::Recording { .. } => self.recording_panel(ui),
                Busy::Packing { .. } => self.packing_panel(ui),
                Busy::Idle => self.idle_panels(ui),
            }

            if let Some(err) = &self.error {
                ui.add_space(8.0);
                ui.colored_label(egui::Color32::from_rgb(220, 80, 80), err);
            }
            if let Some(notice) = self.notice.clone() {
                ui.add_space(8.0);
                ui.label(notice);
                if let Some(path) = self.last_packed.clone() {
                    if path.exists() && ui.button("Show the file").clicked() {
                        reveal(&path);
                    }
                }
            }
        });
    }
}

impl App {
    fn update_banner(&mut self, ui: &mut egui::Ui) {
        let state = self.update.lock().map(|u| match &*u {
            UpdateState::Available(m) => Some((m.version.clone(), m.size_bytes)),
            _ => None,
        });
        let installing = matches!(self.update.lock().as_deref(), Ok(UpdateState::Installing));
        let installed = match self.update.lock().as_deref() {
            Ok(UpdateState::Installed(v)) => Some(v.clone()),
            _ => None,
        };

        if let Some(v) = installed {
            ui.colored_label(
                egui::Color32::from_rgb(120, 190, 120),
                format!("updated to {v} — close and reopen the app to use it"),
            );
            return;
        }
        if let Ok(UpdateState::Failed(why)) = self.update.lock().as_deref() {
            // Small and grey on purpose: a dead network must never look like
            // a problem with recording.
            ui.small(format!("update check failed: {why}"));
            return;
        }
        if installing {
            ui.label("installing the update…");
            return;
        }
        if let Ok(Some((version, size))) = state {
            ui.horizontal(|ui| {
                ui.label(format!("update {version} available ({:.1} MB)", size as f64 / 1024.0 / 1024.0));
                // Never mid-recording: the update swaps the running exe.
                let recording = matches!(self.busy, Busy::Recording { .. });
                if ui.add_enabled(!recording, egui::Button::new("Install")).clicked() {
                    let update = self.update.clone();
                    let recording_now = self.recording_now.clone();
                    if let Ok(mut u) = update.lock() {
                        *u = UpdateState::Installing;
                    }
                    std::thread::spawn(move || {
                        let done = (|| -> Result<String, String> {
                            let m = update::check(update::DEFAULT_BASE_URL, env!("CARGO_PKG_VERSION"))
                                .map_err(|e| e.to_string())?
                                .ok_or("nothing to update")?;
                            let bytes = update::download(update::DEFAULT_BASE_URL, &m)
                                .map_err(|e| e.to_string())?;
                            // Read at swap time, not click time: the user may
                            // have started recording while the download ran,
                            // and apply() refuses to replace a busy exe.
                            update::apply(&bytes, recording_now.load(Ordering::Relaxed))
                                .map_err(|e| e.to_string())?;
                            Ok(m.version)
                        })();
                        if let Ok(mut u) = update.lock() {
                            *u = match done {
                                Ok(v) => UpdateState::Installed(v),
                                Err(e) => UpdateState::Failed(e),
                            };
                        }
                    });
                }
            });
        }
    }

    fn idle_panels(&mut self, ui: &mut egui::Ui) {
        ui.strong("Record a TeamSpeak channel");
        ui.add_space(4.0);
        egui::Grid::new("connect").num_columns(2).spacing([8.0, 6.0]).show(ui, |ui| {
            ui.label("Server");
            ui.add(
                egui::TextEdit::singleline(&mut self.settings.server)
                    .hint_text("ts.example.com")
                    .desired_width(260.0),
            );
            ui.end_row();
            ui.label("Channel");
            ui.add(
                egui::TextEdit::singleline(&mut self.settings.channel)
                    .hint_text("leave empty for the default channel")
                    .desired_width(260.0),
            );
            ui.end_row();
            ui.label("Bot name");
            ui.add(egui::TextEdit::singleline(&mut self.settings.nickname).desired_width(260.0));
            ui.end_row();
        });
        ui.collapsing("Passwords (if the server needs them)", |ui| {
            egui::Grid::new("pw").num_columns(2).spacing([8.0, 6.0]).show(ui, |ui| {
                ui.label("Server");
                ui.add(egui::TextEdit::singleline(&mut self.server_password).password(true).desired_width(220.0));
                ui.end_row();
                ui.label("Channel");
                ui.add(egui::TextEdit::singleline(&mut self.channel_password).password(true).desired_width(220.0));
                ui.end_row();
            });
            ui.small("used for this session only, never saved");
        });
        ui.add_space(6.0);
        let can_record = !self.settings.server.trim().is_empty();
        if ui
            .add_enabled(can_record, egui::Button::new("●  Record").min_size([120.0, 28.0].into()))
            .clicked()
        {
            self.start_recording();
        }
        if !can_record {
            ui.small("enter the TeamSpeak server address first");
        }
        ui.small("in round 1, say \"record, three, two, one\" on the freeze-time clock's 3, 2, 1");

        ui.add_space(10.0);
        ui.separator();
        ui.strong("Transcribe and pack a recording");
        ui.add_space(4.0);

        if self.sessions.is_empty() {
            ui.label("no recordings yet — they appear here after the first one");
            return;
        }

        egui::Grid::new("pack").num_columns(2).spacing([8.0, 6.0]).show(ui, |ui| {
            ui.label("Recording");
            let selected = self
                .sessions
                .get(self.selected_session)
                .and_then(|p| p.file_name())
                .and_then(|f| f.to_str())
                .unwrap_or("—")
                .to_string();
            egui::ComboBox::from_id_salt("session")
                .selected_text(selected)
                .width(260.0)
                .show_ui(ui, |ui| {
                    for (i, s) in self.sessions.iter().enumerate() {
                        let label = s.file_name().and_then(|f| f.to_str()).unwrap_or("—");
                        ui.selectable_value(&mut self.selected_session, i, label);
                    }
                });
            ui.end_row();

            ui.label("Language");
            let lang_label = LANGUAGES
                .iter()
                .find(|(code, _)| *code == self.settings.lang)
                .map(|(_, name)| *name)
                .unwrap_or("English");
            egui::ComboBox::from_id_salt("lang")
                .selected_text(lang_label)
                .width(260.0)
                .show_ui(ui, |ui| {
                    for (code, name) in LANGUAGES {
                        ui.selectable_value(&mut self.settings.lang, code.to_string(), *name);
                    }
                });
            ui.end_row();

            ui.label("Model");
            let model_label = MODELS
                .iter()
                .find(|m| m.key == self.settings.model)
                .map(|m| m.label)
                .unwrap_or("—");
            egui::ComboBox::from_id_salt("model")
                .selected_text(model_label)
                .width(260.0)
                .show_ui(ui, |ui| {
                    for m in MODELS {
                        ui.selectable_value(
                            &mut self.settings.model,
                            m.key.to_string(),
                            format!("{}  (~{} MB)", m.label, m.approx_mb),
                        );
                    }
                });
            ui.end_row();

            ui.label("File name");
            ui.add(
                egui::TextEdit::singleline(&mut self.pack_name)
                    .hint_text("defaults to the recording's name")
                    .desired_width(260.0),
            );
            ui.end_row();
        });

        let model_missing = transcribe::model_spec(&self.settings.model)
            .map(|m| !crate::settings_dir().join("models").join(m.file).exists())
            .unwrap_or(false);
        ui.add_space(6.0);
        if ui.button("Transcribe & pack").clicked() {
            self.start_packing();
        }
        if model_missing {
            if let Some(m) = transcribe::model_spec(&self.settings.model) {
                ui.small(format!("first run downloads the model once (~{} MB)", m.approx_mb));
            }
        }
        ui.small("then upload the .aim4comms file with the mic button in the aim4 viewer");
    }

    fn recording_panel(&mut self, ui: &mut egui::Ui) {
        let Busy::Recording { stop, live, started, .. } = &self.busy else { return };
        let elapsed = started.elapsed().as_secs();
        let status = live.lock().map(|l| l.clone()).unwrap_or_default();

        ui.horizontal(|ui| {
            ui.colored_label(egui::Color32::from_rgb(220, 80, 80), "●");
            ui.strong(if status.connected { "recording" } else { "connecting…" });
            ui.label(format!("{:02}:{:02}", elapsed / 60, elapsed % 60));
        });
        ui.add_space(4.0);
        if status.speakers.is_empty() {
            ui.label("nobody has spoken yet");
        } else {
            for (name, talk) in &status.speakers {
                ui.label(format!("{}  {}", name, mmss(*talk)));
            }
            ui.small(format!("total speech {}", mmss(status.total_talk_ms)));
        }
        ui.add_space(8.0);
        if ui.button("■  Stop").clicked() {
            stop.store(true, Ordering::Relaxed);
        }
        ui.small("say \"record, three, two, one\" on round 1's freeze-time clock if you haven't");
    }

    fn packing_panel(&mut self, ui: &mut egui::Ui) {
        let Busy::Packing { status, .. } = &self.busy else { return };
        let line = status.lock().map(|s| s.clone()).unwrap_or_default();
        ui.horizontal(|ui| {
            ui.spinner();
            ui.strong("packing");
        });
        ui.label(line);
        ui.small("transcription runs on your machine; nothing is uploaded");
    }
}

// --- the small helpers -------------------------------------------------------

fn none_if_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

fn mmss(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

fn settings_path() -> PathBuf {
    crate::settings_dir().join("settings.json")
}

fn load_settings() -> Settings {
    let mut s: Settings = std::fs::read(settings_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // A settings.json written by an older build can name a model or language
    // that no longer exists; falling back beats a Pack button that can only
    // fail with "unknown model".
    if transcribe::model_spec(&s.model).is_none() {
        s.model = transcribe::DEFAULT_MODEL.into();
    }
    if !LANGUAGES.iter().any(|(code, _)| *code == s.lang) {
        s.lang = "en".into();
    }
    s
}

fn save_settings(settings: &Settings) {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(settings) {
        std::fs::write(path, bytes).ok();
    }
}

/// Where recordings land: a folder a person can find without being told.
fn recordings_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Documents").join("aim4-recordings")
}

/// Session folders, newest first, recognized by their session.json.
fn list_sessions(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join(pipeline::SESSION_FILE).exists())
        .collect();
    dirs.sort();
    dirs.reverse();
    dirs
}

fn session_name() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// Open the file's folder with the file selected, best effort per platform.
fn reveal(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(path).spawn().ok();
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .ok();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open").arg(dir).spawn().ok();
    }
}
