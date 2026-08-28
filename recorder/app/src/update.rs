//! Self-update.
//!
//! The recorder ships as ONE .exe. There is no installer, no zip, and no
//! folder: the user downloads a file, runs it, and it keeps itself current by
//! replacing its own executable in place.
//!
//! The feed is aim4 itself (`/api/recorder/latest`), because that is the only
//! server there is. Publishing a new build is an upload to that server, not a
//! site deploy, so shipping a recorder update never touches the website.
//!
//! Two rules make in-place replacement safe:
//!
//!   1. **Verify before swapping.** The manifest carries a SHA-256 of the exact
//!      bytes the download serves. A truncated download that still got a 200
//!      would otherwise overwrite a working app with a corrupt one, and the
//!      user's only recovery would be finding the download page again.
//!   2. **Never swap mid-recording.** A running session holds open segment
//!      files and the TeamSpeak connection. The check is allowed to run, but
//!      the swap waits for idle: losing a scrim's comms to an update would be
//!      a far worse bug than being one version behind for an hour.
//!
//! Windows will not let a running .exe be deleted, but it does allow it to be
//! RENAMED. So: rename self to `*.old`, write the new bytes at the real path,
//! and delete the leftover on next launch. This is what the `self-replace`
//! crate does, and doing it by hand here would only be a worse copy of it.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Where the feed lives. Overridable for testing against a local host.
pub const DEFAULT_BASE_URL: &str = "https://aim4.io";

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub sha256: String,
    /// Path on the same host, e.g. `/api/recorder/download/1.2.0`.
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct LatestResponse {
    latest: Option<Manifest>,
}

#[derive(Debug)]
pub enum UpdateError {
    Network(String),
    /// The download did not hash to what the manifest promised.
    Corrupt { expected: String, got: String },
    Io(std::io::Error),
    /// A recording is in progress; the caller should try again when it ends.
    Busy,
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpdateError::Network(e) => write!(f, "could not reach the update server: {e}"),
            UpdateError::Corrupt { expected, got } => write!(
                f,
                "the download did not match its checksum (expected {expected}, got {got})"
            ),
            UpdateError::Io(e) => write!(f, "io error: {e}"),
            UpdateError::Busy => write!(f, "a recording is in progress"),
        }
    }
}

impl std::error::Error for UpdateError {}

impl From<std::io::Error> for UpdateError {
    fn from(e: std::io::Error) -> Self {
        UpdateError::Io(e)
    }
}

/// Is `remote` newer than `local`? Both are `major.minor.patch`.
///
/// Anything unparseable counts as older, so a malformed manifest can never
/// talk a working install into replacing itself.
pub fn is_newer(remote: &str, local: &str) -> bool {
    fn parts(v: &str) -> Vec<i64> {
        v.split('.')
            .map(|n| n.parse::<i64>().unwrap_or(-1))
            .collect()
    }
    let (r, l) = (parts(remote), parts(local));
    if r.iter().any(|n| *n < 0) {
        return false;
    }
    for i in 0..r.len().max(l.len()) {
        let a = r.get(i).copied().unwrap_or(0);
        let b = l.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

/// The leftover a previous in-place update renamed itself to.
///
/// Cleared on launch rather than at swap time, because at swap time it is the
/// very file that is executing and Windows will not delete it.
pub fn clean_previous(exe: &Path) {
    let old = old_path(exe);
    if old.exists() {
        let _ = std::fs::remove_file(old);
    }
}

fn old_path(exe: &Path) -> PathBuf {
    let mut p = exe.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "aim4-recorder.exe".into());
    p.set_file_name(format!("{name}.old"));
    p
}

/// Hex SHA-256, the same digest the server publishes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Check the feed. `None` means "already current", not "failed".
pub fn check(base_url: &str, current_version: &str) -> Result<Option<Manifest>, UpdateError> {
    let url = format!("{}/api/recorder/latest", base_url.trim_end_matches('/'));
    let body = ureq::get(&url)
        .call()
        .map_err(|e| UpdateError::Network(e.to_string()))?
        .into_string()
        .map_err(|e| UpdateError::Network(e.to_string()))?;
    let parsed: LatestResponse =
        serde_json::from_str(&body).map_err(|e| UpdateError::Network(e.to_string()))?;
    match parsed.latest {
        Some(m) if is_newer(&m.version, current_version) => Ok(Some(m)),
        _ => Ok(None),
    }
}

/// The largest build the updater will even consider. The real exe is around
/// 10 MB; this is the line between "a big release" and "a stream that never
/// ends filling memory".
const MAX_BUILD_BYTES: u64 = 256 * 1024 * 1024;

/// Download a build and verify it against the manifest. Nothing is written to
/// the install path here: this only produces bytes known to be the right ones.
pub fn download(base_url: &str, manifest: &Manifest) -> Result<Vec<u8>, UpdateError> {
    // The manifest's size is a limit, not a hint: without it, read_to_end
    // trusts whatever is on the other end to stop, and a wrong-sized body is
    // wrong before it is worth hashing.
    if manifest.size_bytes == 0 || manifest.size_bytes > MAX_BUILD_BYTES {
        return Err(UpdateError::Network(format!(
            "the manifest declares an implausible build size ({} bytes)",
            manifest.size_bytes
        )));
    }

    let url = format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        if manifest.url.starts_with('/') {
            manifest.url.clone()
        } else {
            format!("/{}", manifest.url)
        }
    );
    let resp = ureq::get(&url)
        .call()
        .map_err(|e| UpdateError::Network(e.to_string()))?;

    let mut bytes = Vec::with_capacity(manifest.size_bytes as usize);
    resp.into_reader()
        .take(manifest.size_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(UpdateError::Io)?;

    if bytes.len() as u64 != manifest.size_bytes {
        return Err(UpdateError::Corrupt {
            expected: format!("{} bytes", manifest.size_bytes),
            got: format!("{} bytes", bytes.len()),
        });
    }

    let got = sha256_hex(&bytes);
    if got != manifest.sha256 {
        return Err(UpdateError::Corrupt {
            expected: manifest.sha256.clone(),
            got,
        });
    }
    Ok(bytes)
}

/// Replace this executable with `bytes`, taking effect on next launch.
///
/// `recording` is the guard from rule 2 above; the caller passes whether a
/// session is open rather than this module reaching for global state.
///
/// The bytes go to a temporary file first because `self_replace` works on a
/// path, and the temp file is written beside the executable rather than in the
/// system temp directory: those are often on a different filesystem, and the
/// swap wants a rename rather than a cross-device copy of the whole binary.
pub fn apply(bytes: &[u8], recording: bool) -> Result<(), UpdateError> {
    if recording {
        return Err(UpdateError::Busy);
    }
    let exe = std::env::current_exe()?;
    let staged = exe.with_extension(format!("new-{}", std::process::id()));
    std::fs::write(&staged, bytes)?;

    // On Unix the staged file has to be executable before it can take over.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }

    let result = self_replace::self_replace(&staged).map_err(UpdateError::Io);
    // Best effort: a leftover staged file is clutter, not a failure, and the
    // swap has already either happened or not by this point.
    let _ = std::fs::remove_file(&staged);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_moves_forward() {
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("1.10.0", "1.9.9"), "10 is newer than 9");
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.9", "1.0.0"), "never downgrade");
    }

    #[test]
    fn a_malformed_manifest_cannot_trigger_an_update() {
        assert!(!is_newer("", "0.1.0"));
        assert!(!is_newer("latest", "0.1.0"));
        assert!(!is_newer("9.9.x", "0.1.0"));
    }

    #[test]
    fn refuses_to_swap_mid_recording() {
        assert!(matches!(apply(b"MZ", true), Err(UpdateError::Busy)));
    }

    #[test]
    fn digest_matches_the_servers() {
        // Same value `shasum -a 256` prints for an empty input, which is what
        // the server hashes with too.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
