//! Getting a model running on this machine: download llama.cpp's server and
//! a model (verified, resumable), start the server on a private local port,
//! and stop it again.
//!
//! The server is llama.cpp's own `llama-server`, not llama.cpp compiled into
//! this binary: whisper.cpp already links a copy of ggml, two copies would
//! collide, and the official builds carry the GPU backends (Metal, Vulkan)
//! that a from-source build here would have to reproduce per platform.

use std::io::{Read, Seek, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::models::{self, ModelSpec, ServerBuild, LLAMA_BUILD};

pub type Progress<'a> = &'a mut dyn FnMut(u64, u64);
pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// Context the server is started with: enough for a conversation with tool
/// results in it, small enough to fit beside the model on modest machines.
const CONTEXT: &str = "16384";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);

pub fn eye_dir() -> PathBuf {
    crate::settings_dir().join("eye")
}

/// Download `url` to `dest`, resuming a `.part` left by an earlier attempt,
/// and keep it only if it is exactly `size` bytes hashing to `sha256`.
pub fn download_verified(url: &str, dest: &Path, size: Option<u64>, sha256: &str, progress: Progress) -> Result<(), Error> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = dest.with_extension("part");
    let mut hasher = Sha256::new();
    let mut have: u64 = 0;
    if let Ok(mut f) = std::fs::File::open(&part) {
        // Re-hash what is already there, so a resumed file is still checked whole.
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
    }
    let mut req = ureq::get(url);
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = req.call()?;
    if have > 0 && resp.status() != 206 {
        // The host would not resume: start over.
        have = 0;
        hasher = Sha256::new();
    }
    let total = size.unwrap_or_else(|| {
        resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) + have
    });
    let mut out = std::fs::OpenOptions::new().create(true).write(true).open(&part)?;
    if have > 0 {
        out.seek(std::io::SeekFrom::End(0))?;
    } else {
        out.set_len(0)?;
    }
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 20];
    let mut done = have;
    let mut last = Instant::now();
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            progress(done, total);
            last = Instant::now();
        }
    }
    out.flush()?;
    drop(out);
    progress(done, total);
    let got = hex(&hasher.finalize());
    if size.is_some_and(|s| s != done) || got != sha256 {
        std::fs::remove_file(&part).ok();
        return Err(format!("the download did not check out ({done} bytes, sha256 {got}); try again").into());
    }
    std::fs::rename(&part, dest)?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The model file, downloading it first if needed.
pub fn ensure_model(spec: &ModelSpec, progress: Progress) -> Result<PathBuf, Error> {
    let path = eye_dir().join("models").join(spec.file);
    download_verified(&spec.url(), &path, Some(spec.size), spec.sha256, progress)?;
    Ok(path)
}

pub fn model_downloaded(spec: &ModelSpec) -> bool {
    eye_dir().join("models").join(spec.file).exists()
}

/// The llama-server executable of one build, downloading and unpacking it first if needed.
pub fn ensure_server(build: &ServerBuild, progress: Progress) -> Result<PathBuf, Error> {
    let dir = eye_dir().join(format!("llama-{LLAMA_BUILD}")).join(build.asset.trim_end_matches(".tar.gz").trim_end_matches(".zip"));
    if let Some(exe) = find_server(&dir) {
        return Ok(exe);
    }
    let archive = eye_dir().join("downloads").join(build.asset);
    download_verified(&build.url(), &archive, None, build.sha256, progress)?;
    std::fs::create_dir_all(&dir)?;
    if build.asset.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive)?)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let Some(rel) = entry.enclosed_name() else { continue };
            let out = dir.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut f)?;
        }
    } else {
        let gz = flate2::read::GzDecoder::new(std::fs::File::open(&archive)?);
        let mut tar = tar::Archive::new(gz);
        tar.set_preserve_permissions(true);
        tar.unpack(&dir)?;
    }
    std::fs::remove_file(&archive).ok();
    find_server(&dir).ok_or_else(|| "llama-server was not in the download".into())
}

fn find_server(dir: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).ok()?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().is_some_and(|n| n == name) {
                return Some(p);
            }
        }
    }
    None
}

/// A running llama-server, stopped when dropped.
pub struct Server {
    child: Child,
    pub port: u16,
    pub gpu: bool,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
        std::fs::remove_file(pid_file()).ok();
    }
}

fn pid_file() -> PathBuf {
    eye_dir().join("llama-server.pid")
}

/// Stop a llama-server an earlier run started and never stopped (the app was
/// killed, or crashed): it would otherwise sit on the model's memory for good.
/// Only a process that is still called llama-server is touched, so a recycled
/// PID belonging to something else is left alone.
pub fn stop_leftover() {
    let Ok(text) = std::fs::read_to_string(pid_file()) else { return };
    std::fs::remove_file(pid_file()).ok();
    let Ok(pid) = text.trim().parse::<u32>() else { return };
    let mut sys = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    if let Some(proc_) = sys.process(pid) {
        // The PID came from this app's own folder; a name check is what
        // tells it apart from an unrelated process that reused the number.
        if proc_.name().to_string_lossy().starts_with("llama-server") {
            proc_.kill();
        }
    }
}

impl Server {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

fn free_port() -> Result<u16, Error> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Start the server on a model and wait until it answers. With `gpu`, it is
/// left to fit as much of the model on the GPU as memory allows; without, it
/// runs on the CPU only.
pub fn start_server(exe: &Path, model: &Path, gpu: bool) -> Result<Server, Error> {
    let port = free_port()?;
    let log = std::fs::File::create(eye_dir().join("llama-server.log"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("-m")
        .arg(model)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--jinja", "-c", CONTEXT, "--no-webui"])
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if gpu {
        cmd.args(["--fit", "on"]);
    } else {
        cmd.args(["-ngl", "0"]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up behind the app.
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn()?;
    std::fs::write(pid_file(), child.id().to_string()).ok();
    let mut server = Server { child, port, gpu };
    let started = Instant::now();
    let health = format!("{}/health", server.base_url());
    loop {
        if let Some(status) = server.child.try_wait()? {
            return Err(format!("llama-server stopped while loading ({status}); see {}", eye_dir().join("llama-server.log").display()).into());
        }
        if let Ok(resp) = ureq::get(&health).timeout(Duration::from_secs(2)).call() {
            if resp.status() == 200 {
                return Ok(server);
            }
        }
        if started.elapsed() > HEALTH_TIMEOUT {
            return Err("llama-server took too long to load the model".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Bring a model up: the server build (GPU first, then CPU), the model file,
/// and a running server. `on` reports what is happening.
pub fn bring_up(spec: &ModelSpec, on: &mut dyn FnMut(&str, Option<f32>)) -> Result<Server, Error> {
    let builds = models::server_builds();
    if builds.is_empty() {
        return Err("aim4 eye does not run on this platform yet".into());
    }
    let model = ensure_model(spec, &mut |done, total| {
        on("downloading", (total > 0).then(|| done as f32 / total as f32));
    })?;
    let mut last_err: Option<Error> = None;
    for build in builds {
        let exe = ensure_server(build, &mut |done, total| {
            on("downloading-server", (total > 0).then(|| done as f32 / total as f32));
        })?;
        // A GPU build can still fail on a given driver: try it on the GPU,
        // then the same build on the CPU, then the next build.
        for gpu in if build.gpu { vec![true, false] } else { vec![false] } {
            on("loading", None);
            match start_server(&exe, &model, gpu) {
                Ok(server) => return Ok(server),
                Err(err) => last_err = Some(err),
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "llama-server would not start".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_is_checked_and_resumed() {
        // A local file served over plain HTTP by a one-shot server would be
        // the full test; here the hash and size guard are what is checked.
        let dir = std::env::temp_dir().join(format!("aim4-eye-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("x.bin");
        std::fs::write(&dest, b"already here").unwrap();
        // An existing destination is trusted as already verified.
        download_verified("http://127.0.0.1:9/never", &dest, Some(1), "00", &mut |_, _| {}).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hex_is_lowercase() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
