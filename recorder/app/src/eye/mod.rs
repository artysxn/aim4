//! aim4 eye: the analyst model, run on this computer, reached from the site.
//!
//! The app dials OUT to aim4.io (`/eye/agent`) and keeps that socket open, so
//! nothing here listens for connections from the network. A chat typed on the
//! site — in a browser anywhere, or in this app's own window — reaches the
//! server, comes down the socket as an OpenAI-style request, is answered by
//! llama.cpp's server on a private local port, and streams back up.
//!
//! Messages are the ones `server/eye/relay.js` documents; the dev stand-in
//! `tools/eye/dev-agent.mjs` speaks the same protocol in a few lines of JS.
//!
//! Linking: the site, open in this app's window and signed in, asks the
//! server for a device token and hands it over through the window bridge
//! (`set_token`). The token lives in `eye/settings.json` beside the models.

pub mod models;
pub mod runtime;

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const RECONNECT: &str = "\u{0}reconnect";

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Settings {
    token: Option<String>,
    model: Option<String>,
}

fn settings_path() -> std::path::PathBuf {
    runtime::eye_dir().join("settings.json")
}

fn load_settings() -> Settings {
    std::fs::read(settings_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(s: &Settings) {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(s) {
        std::fs::write(path, bytes).ok();
    }
}

/// What the eye is doing, as the site and the window show it.
#[derive(Clone, Serialize)]
pub struct State {
    pub state: String,
    pub model: String,
    pub progress: Option<f32>,
    pub message: String,
    /// The running model can read pictures.
    pub vision: bool,
}

pub struct Hardware {
    pub ram_gb: u64,
    pub cpus: usize,
    pub host: String,
}

fn hardware() -> Hardware {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    Hardware {
        ram_gb: (sys.total_memory() as f64 / 1024f64.powi(3)).round() as u64,
        cpus: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        host: sysinfo::System::host_name().unwrap_or_else(|| "this computer".into()),
    }
}

struct Inner {
    base: String,
    hardware: Hardware,
    settings: Mutex<Settings>,
    state: Mutex<State>,
    server: Mutex<Option<runtime::Server>>,
    /// The live socket's outbox, when connected.
    out: Mutex<Option<UnboundedSender<String>>>,
    wake: Notify,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    bringing_up: AtomicBool,
    on_change: Box<dyn Fn() + Send + Sync>,
}

/// The running eye. Cheap to clone; every clone is the same service.
#[derive(Clone)]
pub struct Service {
    inner: Arc<Inner>,
}

impl Service {
    /// Start the relay connection (and the last used model, when it is on disk).
    /// `on_change` runs on any thread whenever the state or the link changes.
    pub fn start(base: &str, on_change: Box<dyn Fn() + Send + Sync>) -> Service {
        runtime::stop_leftover();
        let settings = load_settings();
        let svc = Service {
            inner: Arc::new(Inner {
                base: base.trim_end_matches('/').to_string(),
                hardware: hardware(),
                settings: Mutex::new(settings.clone()),
                state: Mutex::new(State { state: "idle".into(), model: String::new(), progress: None, message: String::new(), vision: false }),
                server: Mutex::new(None),
                out: Mutex::new(None),
                wake: Notify::new(),
                cancels: Mutex::new(HashMap::new()),
                bringing_up: AtomicBool::new(false),
                on_change,
            }),
        };
        let relay = svc.clone();
        std::thread::Builder::new()
            .name("eye-relay".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("eye runtime");
                rt.block_on(relay.relay_loop());
            })
            .expect("eye relay thread");
        // The model used last time comes back up on its own, if it is already here.
        if let Some(spec) = settings.model.as_deref().and_then(models::model) {
            if runtime::model_downloaded(spec) {
                svc.use_model(spec.id);
            }
        }
        svc
    }

    pub fn linked(&self) -> bool {
        self.inner.settings.lock().unwrap().token.is_some()
    }

    pub fn device_name(&self) -> String {
        self.inner.hardware.host.clone()
    }

    pub fn state(&self) -> State {
        self.inner.state.lock().unwrap().clone()
    }

    /// Link (Some) or unlink (None) this computer, and reconnect accordingly.
    pub fn set_token(&self, token: Option<String>) {
        {
            let mut s = self.inner.settings.lock().unwrap();
            s.token = token.filter(|t| t.starts_with("eye_"));
            save_settings(&s);
        }
        self.send_raw(RECONNECT.to_string());
        self.inner.wake.notify_one();
        (self.inner.on_change)();
    }

    /// Stop the model server (the app is closing), including one still
    /// loading: that one is not held yet, but its PID is on disk.
    pub fn shutdown(&self) {
        self.inner.server.lock().unwrap().take();
        runtime::stop_leftover();
    }

    fn set_state(&self, state: &str, model: Option<&str>, progress: Option<f32>, message: &str) {
        let snapshot = {
            let mut s = self.inner.state.lock().unwrap();
            s.state = state.into();
            if let Some(m) = model {
                s.model = m.into();
            }
            s.progress = progress;
            s.message = message.into();
            s.clone()
        };
        self.send_raw(json!({ "type": "status", "state": snapshot.state, "model": snapshot.model, "progress": snapshot.progress, "message": snapshot.message, "vision": snapshot.vision }).to_string());
        (self.inner.on_change)();
    }

    fn send_raw(&self, text: String) {
        if let Some(tx) = self.inner.out.lock().unwrap().as_ref() {
            tx.send(text).ok();
        }
    }

    fn hello(&self) -> String {
        let hw = &self.inner.hardware;
        let downloaded: Vec<Value> = models::MODELS
            .iter()
            .map(|m| json!({ "id": m.id, "downloaded": runtime::model_downloaded(m) }))
            .collect();
        json!({
            "type": "hello",
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "hardware": {
                "ramGb": hw.ram_gb,
                "cpus": hw.cpus,
                "recommended": models::recommended(hw.ram_gb).id,
                "models": downloaded,
            }
        })
        .to_string()
    }

    /// Download (if needed) and start a model, replacing the running one.
    pub fn use_model(&self, id: &str) {
        let Some(spec) = models::model(id) else {
            self.set_state("error", None, None, &format!("unknown model {id}"));
            return;
        };
        if self.inner.bringing_up.swap(true, Ordering::SeqCst) {
            return;
        }
        let svc = self.clone();
        std::thread::spawn(move || {
            svc.inner.server.lock().unwrap().take();
            svc.set_state("loading", Some(spec.id), None, "");
            let result = runtime::bring_up(spec, &mut |what, progress| {
                match what {
                    "downloading" => svc.set_state("downloading", Some(spec.id), progress, &format!("downloading {}", spec.label)),
                    "downloading-server" => svc.set_state("downloading", Some(spec.id), progress, "downloading the model runtime (llama.cpp)"),
                    "downloading-vision" => svc.set_state("downloading", Some(spec.id), progress, "downloading the vision add-on"),
                    other => svc.set_state(other, Some(spec.id), progress, ""),
                }
            });
            match result {
                Ok(server) => {
                    let note = if server.gpu { "" } else { "running on the CPU" };
                    svc.inner.state.lock().unwrap().vision = server.vision;
                    *svc.inner.server.lock().unwrap() = Some(server);
                    {
                        let mut s = svc.inner.settings.lock().unwrap();
                        s.model = Some(spec.id.into());
                        save_settings(&s);
                    }
                    svc.set_state("ready", Some(spec.id), None, note);
                }
                Err(err) => svc.set_state("error", Some(spec.id), None, &err.to_string()),
            }
            svc.inner.bringing_up.store(false, Ordering::SeqCst);
        });
    }

    fn unload(&self) {
        self.inner.server.lock().unwrap().take();
        self.set_state("idle", Some(""), None, "");
    }

    /// Answer one chat from the local server, streaming each delta up the socket.
    fn chat(&self, id: String, body: Value) {
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner.cancels.lock().unwrap().insert(id.clone(), cancel.clone());
        let svc = self.clone();
        std::thread::spawn(move || {
            let url = svc.inner.server.lock().unwrap().as_ref().map(|s| s.base_url());
            let model = svc.state().model;
            let result = (|| -> Result<(), runtime::Error> {
                let url = url.ok_or("no model is loaded in aim4 eye")?;
                svc.set_state("busy", None, None, "");
                let mut body = body;
                body["stream"] = Value::Bool(true);
                let resp = ureq::post(&format!("{url}/v1/chat/completions")).send_json(body)?;
                let reader = std::io::BufReader::new(resp.into_reader());
                for line in reader.lines() {
                    if cancel.load(Ordering::Relaxed) {
                        return Ok(());
                    }
                    let line = line?;
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim();
                    if data == "[DONE]" {
                        continue;
                    }
                    svc.send_raw(json!({ "type": "chunk", "id": id, "data": data }).to_string());
                }
                Ok(())
            })();
            svc.inner.cancels.lock().unwrap().remove(&id);
            match result {
                Ok(()) if !cancel.load(Ordering::Relaxed) => svc.send_raw(json!({ "type": "done", "id": id }).to_string()),
                Ok(()) => {}
                Err(err) => svc.send_raw(json!({ "type": "error", "id": id, "message": err.to_string() }).to_string()),
            }
            if svc.inner.server.lock().unwrap().is_some() {
                svc.set_state("ready", Some(&model), None, "");
            }
        });
    }

    fn on_message(&self, text: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        match msg["type"].as_str() {
            Some("chat") => {
                if let (Some(id), Some(body)) = (msg["id"].as_str(), msg.get("body")) {
                    self.chat(id.to_string(), body.clone());
                }
            }
            Some("cancel") => {
                if let Some(flag) = msg["id"].as_str().and_then(|id| self.inner.cancels.lock().unwrap().get(id).cloned()) {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            Some("command") => match msg["command"].as_str() {
                Some("use-model") => {
                    if let Some(id) = msg["args"]["model"].as_str() {
                        self.use_model(id);
                    }
                }
                Some("unload") => self.unload(),
                _ => {}
            },
            _ => {}
        }
    }

    fn agent_url(&self) -> String {
        let base = &self.inner.base;
        let ws = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            base.clone()
        };
        format!("{ws}/eye/agent")
    }

    async fn relay_loop(self) {
        let mut backoff = 1u64;
        loop {
            let token = self.inner.settings.lock().unwrap().token.clone();
            let Some(token) = token else {
                tokio::select! {
                    _ = self.inner.wake.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
                continue;
            };
            let mut req = match self.agent_url().into_client_request() {
                Ok(r) => r,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
            };
            if let Ok(v) = format!("Bearer {token}").parse() {
                req.headers_mut().insert("Authorization", v);
            }
            match tokio_tungstenite::connect_async(req).await {
                Ok((ws, _)) => {
                    backoff = 1;
                    self.run_connection(ws).await;
                }
                Err(tokio_tungstenite::tungstenite::Error::Http(resp)) if resp.status() == 401 => {
                    // Revoked from the site: forget the token rather than retry forever.
                    self.inner.settings.lock().unwrap().token = None;
                    save_settings(&self.inner.settings.lock().unwrap());
                    (self.inner.on_change)();
                    continue;
                }
                Err(_) => {}
            }
            tokio::select! {
                _ = self.inner.wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
            }
            backoff = (backoff * 2).min(30);
        }
    }

    async fn run_connection(&self, ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = unbounded_channel::<String>();
        *self.inner.out.lock().unwrap() = Some(tx);
        let hello = self.hello();
        let st = self.state();
        let status = json!({ "type": "status", "state": st.state, "model": st.model, "progress": st.progress, "message": st.message, "vision": st.vision }).to_string();
        if sink.send(Message::Text(hello.into())).await.is_err() || sink.send(Message::Text(status.into())).await.is_err() {
            *self.inner.out.lock().unwrap() = None;
            return;
        }
        (self.inner.on_change)();
        loop {
            tokio::select! {
                incoming = stream.next() => match incoming {
                    Some(Ok(Message::Text(text))) => self.on_message(text.as_str()),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                },
                outgoing = rx.recv() => match outgoing {
                    Some(text) if text == RECONNECT => break,
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
            }
        }
        *self.inner.out.lock().unwrap() = None;
        sink.close().await.ok();
        (self.inner.on_change)();
    }

    /// Connected to aim4.io right now.
    pub fn connected(&self) -> bool {
        self.inner.out.lock().unwrap().is_some()
    }
}
