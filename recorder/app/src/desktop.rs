//! The aim4 desktop window: the whole site, in the system webview.
//!
//! Everything aim4 does — the trainer, the demo library, the database, the
//! analysis — is the website, so the window IS the website (aim4.io, or
//! `AIM4_BASE_URL` for a local host). What only the desktop can do rides on a
//! small bridge (`desktop_bridge.js`): the comms recorder opens from the site
//! as its own window (this same file run with `--recorder`), and aim4 eye runs
//! in the background, linked to the account signed in here.
//!
//! The webview is WebView2 on Windows (part of Windows 11 and every updated
//! Windows 10) and WebKit on macOS. wry is used on its own, without Tauri,
//! which keeps the app one self-replacing file.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::{WebContext, WebViewBuilder};

use crate::{eye, signin, update};

enum UserEvent {
    /// A message the page posted to the bridge.
    Ipc(String),
    /// Something changed that the page should hear about.
    Push,
    /// A link that wants a new window: same site, so load it here.
    Navigate(String),
}

pub fn base_url() -> String {
    std::env::var("AIM4_BASE_URL")
        .ok()
        .filter(|u| u.starts_with("http"))
        .unwrap_or_else(|| update::DEFAULT_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Open a URL in the user's own browser.
fn open_external(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, or `cmd` flashes a console window on every link opened.
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).creation_flags(0x0800_0000).spawn();
    }
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

/// The recorder is this program in its other mode, in its own window.
fn open_recorder() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).arg("--recorder").spawn();
    }
}

fn same_site(url: &str, base: &str) -> bool {
    url == base || url.starts_with(&format!("{base}/")) || url.starts_with(&format!("{base}?"))
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let base = base_url();
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy: EventLoopProxy<UserEvent> = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title("aim4")
        .with_inner_size(tao::dpi::LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(900.0, 600.0))
        .build(&event_loop)?;

    let push_proxy = Mutex::new(proxy.clone());
    let eye = eye::Service::start(
        &base,
        Box::new(move || {
            let _ = push_proxy.lock().unwrap().send_event(UserEvent::Push);
        }),
    );

    // Updates: checked once at start, applied when the page asks.
    let update_found: Arc<Mutex<Option<update::Manifest>>> = Arc::new(Mutex::new(None));
    {
        let found = update_found.clone();
        let base = base.clone();
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            if let Ok(Some(m)) = update::check(&base, env!("CARGO_PKG_VERSION")) {
                *found.lock().unwrap() = Some(m);
                let _ = proxy.send_event(UserEvent::Push);
            }
        });
    }

    // Sign-ins and site data persist between runs, like a browser profile.
    let mut context = WebContext::new(Some(crate::settings_dir().join("webview")));
    let bridge = include_str!("desktop_bridge.js")
        .replace("__VERSION__", env!("CARGO_PKG_VERSION"))
        .replace("__PLATFORM__", std::env::consts::OS);

    let ipc_proxy = Mutex::new(proxy.clone());
    let ipc_base = base.clone();
    let nav_proxy = Mutex::new(proxy.clone());
    let nav_base = base.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(format!("{base}/"))
        .with_initialization_script(&bridge)
        .with_ipc_handler(move |req: wry::http::Request<String>| {
            // Only the site itself may drive the bridge.
            let from = req.uri().to_string();
            if same_site(&from, &ipc_base) {
                let _ = ipc_proxy.lock().unwrap().send_event(UserEvent::Ipc(req.body().clone()));
            }
        })
        .with_new_window_req_handler(move |url: String, _features| {
            if same_site(&url, &nav_base) {
                let _ = nav_proxy.lock().unwrap().send_event(UserEvent::Navigate(url));
            } else {
                open_external(&url);
            }
            wry::NewWindowResponse::Deny
        })
        .with_navigation_handler({
            let base = base.clone();
            let landing_proxy = Mutex::new(proxy.clone());
            move |url: String| {
                // A sign-in Supabase sent back to aim4.io finishes on this window's own host.
                if let Some(local) = signin::local_landing(&url, &base) {
                    let _ = landing_proxy.lock().unwrap().send_event(UserEvent::Navigate(local));
                    return false;
                }
                // The window stays on the site and in its sign-in pages; anything else goes to the browser.
                if same_site(&url, &base)
                    || signin::is_sign_in_page(&url)
                    || url.starts_with("about:")
                    || url.starts_with("blob:")
                    || url.starts_with("data:")
                {
                    true
                } else {
                    open_external(&url);
                    false
                }
            }
        })
        .build(&window)?;

    let info = {
        let eye = eye.clone();
        let update_found = update_found.clone();
        move || -> String {
            let st = eye.state();
            let update = update_found.lock().unwrap().as_ref().map(|m| json!({ "version": m.version, "notes": m.notes }));
            json!({
                "type": "info",
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "deviceName": eye.device_name(),
                "eyeLinked": eye.linked(),
                "eyeConnected": eye.connected(),
                "eye": st,
                "update": update,
            })
            .to_string()
        }
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Push) => {
                let _ = webview.evaluate_script(&format!("window.__aim4DesktopPush && window.__aim4DesktopPush({})", info()));
            }
            Event::UserEvent(UserEvent::Navigate(url)) => {
                let _ = webview.load_url(&url);
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                if cfg!(debug_assertions) {
                    eprintln!("bridge: {body}");
                }
                let Ok(msg) = serde_json::from_str::<Value>(&body) else { return };
                match msg["type"].as_str() {
                    Some("get-info") => {}
                    Some("eye-link") => eye.set_token(msg["token"].as_str().map(str::to_string)),
                    Some("eye-unlink") => eye.set_token(None),
                    // A sign-in started inside a tab: the window itself goes to the provider.
                    Some("navigate") => {
                        let url = msg["url"].as_str().unwrap_or("");
                        if signin::is_sign_in_page(url) || same_site(url, &base) {
                            let _ = webview.load_url(url);
                        }
                    }
                    Some("open-recorder") => open_recorder(),
                    Some("open-external") => open_external(msg["url"].as_str().unwrap_or("")),
                    Some("apply-update") => {
                        let manifest = update_found.lock().unwrap().clone();
                        if let Some(m) = manifest {
                            let base = base.clone();
                            std::thread::spawn(move || {
                                if let Ok(bytes) = update::download(&base, &m) {
                                    if update::apply(&bytes, false).is_ok() {
                                        if let Ok(exe) = std::env::current_exe() {
                                            let _ = std::process::Command::new(exe).spawn();
                                        }
                                        std::process::exit(0);
                                    }
                                }
                            });
                        }
                    }
                    _ => {}
                }
                let _ = webview.evaluate_script(&format!("window.__aim4DesktopPush && window.__aim4DesktopPush({})", info()));
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                eye.shutdown();
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
