//! The desktop release a master keeps for its tills (FR-20.56, plan step P2-7).
//!
//! Every 6 hours, and as soon as the master is registered, the supervisor asks global which desktop
//! release is current (`/api/node/v1/desktop-release`, with its node token). It downloads the files
//! it does not have yet through the public download endpoint, into
//! `<data>/desktop-releases/<version>/`, and writes that version's `release.json`. `current.json`
//! names the version only once every file of it is whole. The API (`release-cache.ts`) serves the
//! tills from there, so they stay current with the internet down, and the GitHub token never leaves
//! global.
//!
//! ⚠ Nothing here is a trust boundary. Each till verifies the updater signature against a key pinned
//! in its own binary, whoever served the file. What this module guards is the shop's disk: names,
//! sizes and paths are checked before anything is written.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::https::Https;
use crate::node_key::NodeKey;
use crate::register;
use crate::supervisor::Registrar;
use crate::uplink::Status;

/// No desktop release file is larger; one that is, is not a desktop release file.
const MAX_FILE: u64 = 512 << 20;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

pub fn root(data: &Path) -> PathBuf {
    data.join("desktop-releases")
}

fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_name(n: &str) -> bool {
    (1..=200).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) && n != "." && n != ".."
}

fn write_atomic(file: &Path, text: &str) -> Result<()> {
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, text).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, file).with_context(|| format!("writing {}", file.display()))
}

/// One look: `Some(version)` when that release is now whole on disk, `None` when global offers none.
pub async fn sync_once(data: &Path, client: &Https, server: &str, token: &str) -> Result<Option<String>> {
    let (status, release) = client.json("GET", &format!("{server}/api/node/v1/desktop-release"), Some(token), None).await?;
    if status == 204 {
        return Ok(None);
    }
    if status != 200 {
        bail!("global answered {status} for the desktop release");
    }
    let version = release["version"].as_str().unwrap_or_default().to_string();
    if !valid_version(&version) {
        bail!("global named no valid desktop version ({version:?})");
    }
    let mut files = vec![];
    for f in release["files"].as_array().into_iter().flatten() {
        let name = f["name"].as_str().unwrap_or_default();
        let size = f["size"].as_u64().unwrap_or(u64::MAX);
        if !valid_name(name) || size > MAX_FILE {
            bail!("global listed a file this master will not keep: {name:?} ({size} bytes)");
        }
        files.push((name.to_string(), size));
    }
    let base = root(data);
    let dir = base.join(&version);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    for (name, size) in &files {
        let dest = dir.join(name);
        if std::fs::metadata(&dest).map(|m| m.len()).ok() == Some(*size) {
            continue;
        }
        let got = client.download(&format!("{server}/api/desktop/download/{version}/{name}"), &dest, *size, DOWNLOAD_TIMEOUT).await?;
        if got != *size {
            let _ = std::fs::remove_file(&dest);
            bail!("{name} came as {got} bytes, not the {size} global listed");
        }
    }
    // The manifest of this version, then the switch: `current.json` names only a version that is whole.
    let manifest = serde_json::json!({
        "version": version,
        "notes": release["notes"],
        "minVersion": release["minVersion"],
        "files": files.iter().map(|(n, s)| serde_json::json!({ "name": n, "size": s })).collect::<Vec<_>>(),
        "updater": release["updater"],
        "fetchedAt": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
    });
    write_atomic(&dir.join("release.json"), &serde_json::to_string_pretty(&manifest)?)?;
    let current = base.join("current.json");
    let before = std::fs::read_to_string(&current).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();
    // The version this one replaces stays one round, for a till still downloading it.
    let previous = match before["version"].as_str() {
        Some(v) if v != version => Some(v.to_string()),
        _ => before["previous"].as_str().map(String::from),
    };
    write_atomic(&current, &serde_json::json!({ "version": version, "previous": previous }).to_string())?;
    prune(&base, &version, previous.as_deref());
    Ok(Some(version))
}

/// Keep the current version and the one before it; anything else in the directory goes.
fn prune(base: &Path, current: &str, previous: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(base) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if e.path().is_dir() && valid_version(&name) && name != current && Some(name.as_str()) != previous {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// For as long as the supervisor runs: a look every 6 hours, and as soon as a registration wakes it.
pub async fn run(registrar: Arc<Registrar>, status: Status, every: Duration) {
    loop {
        if let Some(reg) = register::current(&registrar.data) {
            let result = async {
                let key = NodeKey::load_or_create(&registrar.data)?;
                let token = register::fetch_token(&reg.server, &reg.node_id, &key, &registrar.client).await?;
                sync_once(&registrar.data, &registrar.client, &reg.server, &token).await
            }
            .await;
            let now = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
            let value = match result {
                Ok(Some(version)) => serde_json::json!({ "version": version, "checkedAt": now }),
                Ok(None) => serde_json::json!({ "version": null, "checkedAt": now, "note": "global offers no desktop release" }),
                Err(e) => {
                    tracing::warn!("the desktop release could not be fetched: {e:#}");
                    let mut v = status.lock().unwrap().clone();
                    v["error"] = format!("{e:#}").into();
                    v["checkedAt"] = now.into();
                    v
                }
            };
            *status.lock().unwrap() = value;
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = registrar.wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::https::testkit;

    #[test]
    fn names_and_versions_are_checked_before_anything_is_written() {
        assert!(valid_version("0.1.6") && valid_version("10.20.3000"));
        assert!(!valid_version("0.1") && !valid_version("0.1.6-beta") && !valid_version("../1.2"));
        assert!(valid_name("LGR.Desktop_0.1.6_x64-setup.exe") && valid_name("LGR.Desktop_0.1.6_x64-setup.exe.sig"));
        assert!(!valid_name("..") && !valid_name("a/b") && !valid_name("a\\b") && !valid_name(""));
    }

    fn release(version: &str, setup_size: u64) -> serde_json::Value {
        serde_json::json!({
            "version": version,
            "notes": "fixes",
            "minVersion": null,
            "files": [{ "name": format!("LGR.Desktop_{version}_x64-setup.exe"), "size": setup_size }, { "name": format!("LGR.Desktop_{version}_x64-setup.exe.sig"), "size": 4 }],
            "updater": { "windows-x86_64": { "file": format!("LGR.Desktop_{version}_x64-setup.exe"), "signature": "c2ln" } },
        })
    }

    #[tokio::test]
    async fn a_release_is_kept_whole_once_and_only_the_last_two_stay() {
        let dir = tempfile::tempdir().unwrap();
        let offered = Arc::new(std::sync::Mutex::new(release("1.2.3", 10)));
        let downloads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (o, d) = (offered.clone(), downloads.clone());
        let server = testkit::global(move |method, path| {
            if path == "/api/node/v1/desktop-release" {
                return (200, o.lock().unwrap().to_string().into_bytes());
            }
            if method == "GET" && path.starts_with("/api/desktop/download/") {
                d.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let n = if path.ends_with(".sig") { 4 } else { 10 };
                return (200, vec![b'x'; n]);
            }
            (404, b"{}".to_vec())
        })
        .await;
        let got = sync_once(dir.path(), &server.client, &server.url, "tok").await.unwrap();
        assert_eq!(got.as_deref(), Some("1.2.3"));
        let base = root(dir.path());
        assert_eq!(std::fs::metadata(base.join("1.2.3").join("LGR.Desktop_1.2.3_x64-setup.exe")).unwrap().len(), 10);
        let current: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(base.join("current.json")).unwrap()).unwrap();
        assert_eq!(current["version"], "1.2.3");
        let manifest: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(base.join("1.2.3").join("release.json")).unwrap()).unwrap();
        assert_eq!(manifest["updater"]["windows-x86_64"]["signature"], "c2ln");
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 2);

        // Nothing is fetched twice.
        sync_once(dir.path(), &server.client, &server.url, "tok").await.unwrap();
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 2);

        // Two newer versions: the oldest goes, the previous stays.
        *offered.lock().unwrap() = release("1.2.4", 10);
        sync_once(dir.path(), &server.client, &server.url, "tok").await.unwrap();
        *offered.lock().unwrap() = release("1.2.5", 10);
        sync_once(dir.path(), &server.client, &server.url, "tok").await.unwrap();
        let mut kept: Vec<String> = std::fs::read_dir(&base).unwrap().flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        kept.sort();
        assert_eq!(kept, vec!["1.2.4".to_string(), "1.2.5".to_string()]);
    }

    #[tokio::test]
    async fn a_file_that_does_not_match_its_size_never_becomes_current() {
        let dir = tempfile::tempdir().unwrap();
        let server = testkit::global(|_, path| {
            if path == "/api/node/v1/desktop-release" {
                // It claims 10 bytes and sends 11: more than the listed size is refused mid-stream.
                return (200, release("2.0.0", 10).to_string().into_bytes());
            }
            (200, vec![b'x'; 11])
        })
        .await;
        assert!(sync_once(dir.path(), &server.client, &server.url, "tok").await.is_err());
        assert!(!root(dir.path()).join("current.json").exists());
        assert!(!root(dir.path()).join("2.0.0").join("LGR.Desktop_2.0.0_x64-setup.exe").exists());
    }

    #[tokio::test]
    async fn no_release_offered_is_nothing_to_do() {
        let dir = tempfile::tempdir().unwrap();
        let server = testkit::global(|_, _| (204, vec![])).await;
        assert_eq!(sync_once(dir.path(), &server.client, &server.url, "tok").await.unwrap(), None);
    }
}
