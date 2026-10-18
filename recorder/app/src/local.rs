//! aim4 from a checkout on this PC, instead of aim4.io.
//!
//! When `aim4-local.json` sits next to the .exe, the double-click path starts
//! that checkout's server with no console window, waits until it answers, and
//! points the window at it:
//!
//! ```json
//! { "repo": "D:\\Dev\\claude\\aim-trainer", "port": 3784 }
//! ```
//!
//! The server it starts is `server/run-account.js`: local mode off, signing in
//! through the site's own accounts, listening on 127.0.0.1 only. So the window
//! asks you to sign in, rather than making whoever opens it the local owner.
//!
//! Without the file nothing changes, which is what keeps the build aim4
//! publishes pointed at aim4.io. `node` is found on PATH unless `"node"` names
//! it; `"script"` picks another entry point. The server's output goes to
//! `<settings>/local-server.log`, and it is stopped when this process ends,
//! however it ends (a Windows job object holds it).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const CONFIG_FILE: &str = "aim4-local.json";
const DEFAULT_PORT: u16 = 3784;
const DEFAULT_SCRIPT: &str = "server/run-account.js";
/// First start builds the stats store from the demo library, which takes a while on a big one.
const START_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(serde::Deserialize)]
pub struct Config {
    pub repo: PathBuf,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub script: Option<String>,
}

/// The config next to the .exe, or None when there is none (the aim4.io path).
pub fn config() -> Result<Option<Config>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("could not find this program's path: {e}"))?;
    let path = exe.with_file_name(CONFIG_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("{} is not valid: {e}", path.display()))
}

/// The server pack built into this .exe (empty when none was built): Node, the
/// server and the site, so offline works on any PC (server/run-pack.js).
static PACK: &[u8] = include_bytes!(env!("AIM4_PACK"));
/// The pack's port: fixed, because the sign-in lives in this origin's storage.
const PACK_PORT: u16 = 37840;

/// The built-in pack as a local server to start, unpacked on first run and after an update.
/// Its folder is kept between versions: the library and the offline queue live in it (server/data).
pub fn pack_config() -> Result<Option<Config>, String> {
    if PACK.is_empty() {
        return Ok(None);
    }
    let dir = crate::settings_dir().join("pack");
    let marker = dir.join(".version");
    let version = env!("CARGO_PKG_VERSION");
    if std::fs::read_to_string(&marker).ok().as_deref() != Some(version) {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(PACK)).map_err(|e| format!("the built-in server is damaged: {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = entry.enclosed_name() else { continue };
            let out = dir.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut f = std::fs::File::create(&out).map_err(|e| format!("could not write {}: {e}", out.display()))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
        std::fs::write(&marker, version).map_err(|e| e.to_string())?;
    }
    Ok(Some(Config { node: Some(dir.join("node.exe").display().to_string()), repo: dir, port: Some(PACK_PORT), script: Some("server/run-pack.js".into()) }))
}

/// The running local server: the address the window opens, and the process if this run started it.
pub struct Host {
    pub base: String,
    _child: Option<Child>,
}

/// What a server already on the port is: signed-in aim4, the local-owner aim4, or nothing.
enum Running {
    Accounts,
    Owner,
}

fn running(port: u16) -> Option<Running> {
    let resp = ureq::get(&format!("http://127.0.0.1:{port}/api/me"))
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?;
    let body: serde_json::Value = resp.into_json().ok()?;
    // The local-owner server answers every request as the owner, provider "local".
    Some(if body["account"]["provider"] == "local" { Running::Owner } else { Running::Accounts })
}

/// Start the checkout's server (or reuse a signed-in one already running) and wait until it answers.
pub fn start(cfg: &Config) -> Result<Host, String> {
    let port = cfg.port.unwrap_or(DEFAULT_PORT);
    let base = format!("http://localhost:{port}");
    match running(port) {
        Some(Running::Accounts) => return Ok(Host { base, _child: None }),
        Some(Running::Owner) => {
            return Err(format!(
                "port {port} already has aim4 running in local-owner mode (no sign-in). Stop that server, then open aim4 again."
            ))
        }
        None => {}
    }

    let script = cfg.script.as_deref().unwrap_or(DEFAULT_SCRIPT);
    if !cfg.repo.join(script).exists() {
        return Err(format!("{} has no {script}. Point \"repo\" in {CONFIG_FILE} at the aim4 checkout.", cfg.repo.display()));
    }
    let dir = crate::settings_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let log_path = dir.join("local-server.log");
    let log = std::fs::File::create(&log_path).map_err(|e| format!("could not write {}: {e}", log_path.display()))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(cfg.node.as_deref().unwrap_or("node"));
    cmd.arg(script)
        .current_dir(&cfg.repo)
        .env("AIM4_API_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: node is a console program; without this a console window opens with it.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start Node.js ({e}). Is Node.js installed and on PATH?"))?;
    tie_to_this_process(&child);

    let started = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the aim4 server stopped while starting ({status}). See {}.", log_path.display()));
        }
        if running(port).is_some() {
            return Ok(Host { base, _child: Some(child) });
        }
        if started.elapsed() > START_TIMEOUT {
            let _ = child.kill();
            return Err(format!("the aim4 server did not answer within {}s. See {}.", START_TIMEOUT.as_secs(), log_path.display()));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Put the server in a job that dies with this process. The window's event loop
/// ends the process directly, so nothing after it would get a chance to stop it.
#[cfg(windows)]
fn tie_to_this_process(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // SAFETY: plain Win32 calls on a handle this process owns. The job handle is
    // left open on purpose: Windows closes it when this process exits, and that
    // is what kills the server.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        AssignProcessToJobObject(job, child.as_raw_handle() as _);
    }
}

#[cfg(not(windows))]
fn tie_to_this_process(_child: &Child) {}

/// Tell the user something went wrong. A release build on Windows has no console to print to.
pub fn alert(message: &str) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (text, caption) = (wide(message), wide("aim4"));
        // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call.
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_OK | MB_ICONERROR);
        }
    }
    eprintln!("{message}");
}
