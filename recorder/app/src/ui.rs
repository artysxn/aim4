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

// The site's tokens (src/site/site.css), so this window reads as part of aim4.
const SURFACE: egui::Color32 = egui::Color32::from_rgb(0x0c, 0x0c, 0x0c);
const FIELD: egui::Color32 = egui::Color32::from_rgb(0x05, 0x05, 0x05);
const TEXT: egui::Color32 = egui::Color32::from_rgb(0xf2, 0xf2, 0xf2);
const MUTED: egui::Color32 = egui::Color32::from_rgb(0x9c, 0x9c, 0xa2);
const ACCENT: egui::Color32 = egui::Color32::from_rgb(0xe6, 0x06, 0x11);
const ACCENT_DOWN: egui::Color32 = egui::Color32::from_rgb(0xc4, 0x05, 0x0e);
const OK: egui::Color32 = egui::Color32::from_rgb(0x58, 0xc0, 0x8a);

/// Flat fields with no outline, segment-style buttons, the site's text colors.
/// Fields are 8px round and 32px high; buttons are 6px (see the control rules).
pub fn apply_theme(ctx: &egui::Context) {
    use egui::{CornerRadius, FontId, Stroke, TextStyle};
    let mut v = egui::Visuals::dark();
    v.panel_fill = SURFACE;
    v.window_fill = SURFACE;
    v.extreme_bg_color = FIELD;
    v.faint_bg_color = egui::Color32::from_white_alpha(6);
    v.override_text_color = None;
    v.selection.bg_fill = egui::Color32::from_white_alpha(46);
    v.selection.stroke = Stroke::NONE;
    v.hyperlink_color = TEXT;
    let field_radius = CornerRadius::same(8);
    for (w, fill, fg) in [
        (&mut v.widgets.noninteractive, SURFACE, MUTED),
        (&mut v.widgets.inactive, egui::Color32::from_white_alpha(8), MUTED),
        (&mut v.widgets.hovered, egui::Color32::from_white_alpha(10), TEXT),
        (&mut v.widgets.active, egui::Color32::from_white_alpha(26), TEXT),
        (&mut v.widgets.open, egui::Color32::from_white_alpha(26), TEXT),
    ] {
        w.bg_fill = fill;
        w.weak_bg_fill = fill;
        w.bg_stroke = Stroke::NONE;
        w.fg_stroke = Stroke::new(1.0, fg);
        w.corner_radius = field_radius;
        w.expansion = 0.0;
    }
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, egui::Color32::from_rgb(0x18, 0x18, 0x18));
    // The site is dark only; do not follow a light system theme.
    ctx.set_theme(egui::ThemePreference::Dark);
    ctx.set_visuals(v);
    ctx.all_styles_mut(|s| {
        s.spacing.item_spacing = egui::vec2(8.0, 8.0);
        s.spacing.button_padding = egui::vec2(14.0, 7.0);
        s.spacing.interact_size.y = 32.0;
        s.text_styles.insert(TextStyle::Heading, FontId::proportional(19.0));
        s.text_styles.insert(TextStyle::Body, FontId::proportional(13.5));
        s.text_styles.insert(TextStyle::Button, FontId::proportional(13.5));
        s.text_styles.insert(TextStyle::Small, FontId::proportional(12.0));
    });
}

/// A flat 32px field with its hint inside; no label above it.
fn field(ui: &mut egui::Ui, value: &mut String, hint: &str, password: bool) {
    ui.add(
        egui::TextEdit::singleline(value)
            .hint_text(egui::RichText::new(hint).color(egui::Color32::from_rgb(0x5c, 0x5c, 0x62)))
            .password(password)
            .margin(egui::Margin::symmetric(10, 8))
            .desired_width(ui.available_width()),
    );
}

/// A button in the analyzer control theme. `primary` is the filled one.
fn button(ui: &mut egui::Ui, text: &str, primary: bool, enabled: bool) -> egui::Response {
    let rich = egui::RichText::new(text).strong().color(if primary { TEXT } else { MUTED });
    let mut b = egui::Button::new(rich).corner_radius(6.0).min_size(egui::vec2(0.0, 32.0));
    if primary {
        b = b.fill(egui::Color32::from_white_alpha(26));
    }
    ui.add_enabled(enabled, b)
}

/// The red record button: the site's accent, since it starts something that cannot be undone.
fn record_button(ui: &mut egui::Ui, enabled: bool) -> egui::Response {
    let b = egui::Button::new(egui::RichText::new("Record").strong().color(egui::Color32::WHITE))
        .fill(ACCENT_DOWN)
        .corner_radius(6.0)
        .min_size(egui::vec2(ui.available_width(), 36.0));
    ui.add_enabled(enabled, b)
}

/// A flat card, the window's equivalent of `.an-card`.
fn card<R>(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::new()
        .fill(FIELD)
        .corner_radius(8.0)
        .inner_margin(egui::Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .inner
}

fn muted(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text.into()).color(MUTED)
}

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
        Box::new(|cc| {
            apply_theme(&cc.egui_ctx);
            Ok(Box::new(App::new()))
        }),
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
                        format!("possible anchor at {}, no cue word, the viewer will ask", mmss(ms))
                    }
                    None => "no countdown found, the viewer will ask for the anchor".into(),
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
                            "recording saved: {}. The session ended on its own ({why}); \
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
            ctx.request_repaint_after(std::time::Duration::from_millis(120));
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
            ui.horizontal(|ui| {
                ui.heading(egui::RichText::new("aim4 comms").strong().color(TEXT));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(muted(format!("v{}", env!("CARGO_PKG_VERSION"))));
                });
            });
            self.update_banner(ui);
            ui.add_space(4.0);

            match &self.busy {
                Busy::Recording { .. } => self.recording_panel(ui),
                Busy::Packing { .. } => self.packing_panel(ui),
                Busy::Idle => self.idle_panels(ui),
            }

            if let Some(err) = self.error.clone() {
                card(ui, |ui| {
                    ui.horizontal(|ui| {
                        dot(ui, egui::Color32::from_rgb(0xe0, 0x6c, 0x6c), 1.0);
                        ui.add(egui::Label::new(egui::RichText::new(err).color(egui::Color32::from_rgb(0xe0, 0x6c, 0x6c))).wrap());
                    });
                });
            }
            if let Some(notice) = self.notice.clone() {
                card(ui, |ui| {
                    ui.horizontal(|ui| {
                        dot(ui, OK, 1.0);
                        ui.add(egui::Label::new(notice).wrap());
                    });
                    if let Some(path) = self.last_packed.clone() {
                        if path.exists() && button(ui, "Show the file", false, true).clicked() {
                            reveal(&path);
                        }
                    }
                });
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
            card(ui, |ui| {
                ui.horizontal(|ui| {
                    dot(ui, OK, 1.0);
                    ui.label(format!("Updated to {v}. Close and reopen the app to use it."));
                });
            });
            return;
        }
        if let Ok(UpdateState::Failed(why)) = self.update.lock().as_deref() {
            // Small and grey on purpose: a dead network must never look like
            // a problem with recording.
            ui.label(egui::RichText::new(format!("Update check failed: {why}")).small().color(MUTED));
            return;
        }
        if installing {
            card(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spinner();
                    ui.label("Installing the update");
                });
            });
            return;
        }
        if let Ok(Some((version, size))) = state {
            card(ui, |ui| {
              ui.horizontal(|ui| {
                ui.label(format!("Update {version} available ({:.1} MB)", size as f64 / 1024.0 / 1024.0));
                // Never mid-recording: the update swaps the running exe.
                let recording = matches!(self.busy, Busy::Recording { .. });
                if button(ui, "Install", true, !recording).clicked() {
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
            });
        }
    }

    fn idle_panels(&mut self, ui: &mut egui::Ui) {
        field(ui, &mut self.settings.server, "TeamSpeak server", false);
        field(ui, &mut self.settings.channel, "Channel (empty for the default)", false);
        field(ui, &mut self.settings.nickname, "Bot name", false);
        egui::CollapsingHeader::new(muted("Passwords"))
            .default_open(false)
            .show(ui, |ui| {
                field(ui, &mut self.server_password, "Server password", true);
                field(ui, &mut self.channel_password, "Channel password", true);
                ui.label(egui::RichText::new("Used for this session only, never saved.").small().color(MUTED));
            });
        let can_record = !self.settings.server.trim().is_empty();
        if record_button(ui, can_record).clicked() {
            self.start_recording();
        }
        if !can_record {
            ui.label(egui::RichText::new("Enter the TeamSpeak server address first.").small().color(MUTED));
        }
        ui.label(
            egui::RichText::new("In round 1, say \"record, three, two, one\" on the freeze-time clock's 3, 2, 1.")
                .small()
                .color(MUTED),
        );

        ui.add_space(8.0);
        ui.separator();
        ui.add_space(4.0);
        ui.label(egui::RichText::new("Recordings").strong().color(TEXT));

        if self.sessions.is_empty() {
            ui.label(muted("No recordings yet."));
            return;
        }

        let width = ui.available_width();
        let selected = self
            .sessions
            .get(self.selected_session)
            .and_then(|p| p.file_name())
            .and_then(|f| f.to_str())
            .unwrap_or("none")
            .to_string();
        egui::ComboBox::from_id_salt("session")
            .selected_text(selected)
            .width(width)
            .show_ui(ui, |ui| {
                for (i, s) in self.sessions.iter().enumerate() {
                    let label = s.file_name().and_then(|f| f.to_str()).unwrap_or("none");
                    ui.selectable_value(&mut self.selected_session, i, label);
                }
            });

        let lang_label = LANGUAGES
            .iter()
            .find(|(code, _)| *code == self.settings.lang)
            .map(|(_, name)| *name)
            .unwrap_or("English");
        let model_label = MODELS
            .iter()
            .find(|m| m.key == self.settings.model)
            .map(|m| m.label)
            .unwrap_or("none");
        ui.horizontal(|ui| {
            let half = (ui.available_width() - ui.spacing().item_spacing.x) / 2.0;
            egui::ComboBox::from_id_salt("lang")
                .selected_text(format!("Language: {lang_label}"))
                .width(half)
                .show_ui(ui, |ui| {
                    for (code, name) in LANGUAGES {
                        ui.selectable_value(&mut self.settings.lang, code.to_string(), *name);
                    }
                });
            egui::ComboBox::from_id_salt("model")
                .selected_text(format!("Model: {model_label}"))
                .width(half)
                .show_ui(ui, |ui| {
                    for m in MODELS {
                        ui.selectable_value(
                            &mut self.settings.model,
                            m.key.to_string(),
                            format!("{}  (~{} MB)", m.label, m.approx_mb),
                        );
                    }
                });
        });
        field(ui, &mut self.pack_name, "File name (defaults to the recording's name)", false);

        let model_missing = transcribe::model_spec(&self.settings.model)
            .map(|m| !crate::settings_dir().join("models").join(m.file).exists())
            .unwrap_or(false);
        if button(ui, "Transcribe and pack", true, true).clicked() {
            self.start_packing();
        }
        if model_missing {
            if let Some(m) = transcribe::model_spec(&self.settings.model) {
                ui.label(
                    egui::RichText::new(format!("First run downloads the model once (~{} MB).", m.approx_mb))
                        .small()
                        .color(MUTED),
                );
            }
        }
    }

    fn recording_panel(&mut self, ui: &mut egui::Ui) {
        let Busy::Recording { stop, live, started, .. } = &self.busy else { return };
        let elapsed = started.elapsed().as_secs();
        let status = live.lock().map(|l| l.clone()).unwrap_or_default();
        let t = ui.ctx().input(|i| i.time) as f32;

        card(ui, |ui| {
            ui.horizontal(|ui| {
                // The dot breathes while connected and holds steady while it connects.
                let pulse = if status.connected { 0.55 + 0.45 * (t * 3.0).sin().abs() } else { 0.35 };
                dot(ui, ACCENT, pulse);
                ui.label(egui::RichText::new(if status.connected { "Recording" } else { "Connecting" }).strong().color(TEXT));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        egui::RichText::new(format!("{:02}:{:02}", elapsed / 60, elapsed % 60))
                            .size(22.0)
                            .monospace()
                            .color(TEXT),
                    );
                });
            });
        });

        if status.speakers.is_empty() {
            ui.label(muted("Nobody has spoken yet."));
        } else {
            let top = status.speakers.iter().map(|(_, ms)| *ms).max().unwrap_or(1).max(1) as f32;
            card(ui, |ui| {
                for (name, talk) in &status.speakers {
                    ui.horizontal(|ui| {
                        ui.add_sized([140.0, 18.0], egui::Label::new(name.as_str()).truncate());
                        ui.add(
                            egui::ProgressBar::new(*talk as f32 / top)
                                .desired_height(4.0)
                                .desired_width((ui.available_width() - 56.0).max(40.0))
                                .fill(egui::Color32::from_gray(225))
                                .corner_radius(2.0),
                        );
                        ui.label(muted(mmss(*talk)));
                    });
                }
                ui.label(egui::RichText::new(format!("Total speech {}", mmss(status.total_talk_ms))).small().color(MUTED));
            });
        }
        if button(ui, "Stop", true, true).clicked() {
            stop.store(true, Ordering::Relaxed);
        }
        ui.label(
            egui::RichText::new("Say \"record, three, two, one\" on round 1's freeze-time clock if you haven't.")
                .small()
                .color(MUTED),
        );
    }

    fn packing_panel(&mut self, ui: &mut egui::Ui) {
        let Busy::Packing { status, .. } = &self.busy else { return };
        let line = status.lock().map(|s| s.clone()).unwrap_or_default();
        card(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label(egui::RichText::new("Packing").strong().color(TEXT));
            });
            ui.add(egui::Label::new(muted(line)).wrap());
        });
    }
}

/// A small filled circle, `alpha` 0..=1.
fn dot(ui: &mut egui::Ui, color: egui::Color32, alpha: f32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
    ui.painter().circle_filled(rect.center(), 4.5, color.gamma_multiply(alpha.clamp(0.0, 1.0)));
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
