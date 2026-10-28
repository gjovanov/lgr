//! Versioned installs (FR-20.20, plan step P1-8b): every version of the server in its own directory,
//! and the service pointed at one of them.
//!
//! ```text
//! <root>/                  C:\Program Files\LGR Server\  ·  /opt/lgr-server/
//!   installer/             the package's own (MSI, .deb): the bootstrap lgr-server and the bundle it delivered
//!   versions/<v>/          one complete home per version, made only by `update install-bundle`
//!   update/                the helper's: state.json, helper.log, staging/
//!   current -> versions/v  Linux: what the service runs (Windows: the service's ImagePath)
//!   lkg -> versions/v      Linux: what the helper runs (Windows: the helper service's ImagePath)
//! ```
//!
//! - **A version is installed from a bundle**, the package's or a downloaded one, by the same code:
//!   extracted beside `versions/`, checked against its own `HOME.json` (name, target, version, and
//!   every file and byte it says it carries), and renamed into place. A directory under `versions/`
//!   is therefore complete, or it is not there.
//! - **The package never owns a version.** A package upgrade replaces `installer/` and hands its
//!   bundle to `install-bundle`; the version that ran before stays on disk, which is what a failed
//!   update goes back to, offline (FR-20.20). dpkg and Windows Installer never delete one.
//! - **Switching is a pointer change and a restart** (FR-20.20): no file is replaced under a running
//!   service, and a failed install leaves the running version untouched.
//! - **The helper runs the last known good version, never the attempt.** A new build that cannot
//!   start must not be what decides to roll itself back.
//! - `update/` is SYSTEM's or root's alone to write: the service account reads `state.json` (its
//!   status shows it) and can change nothing there. Nothing the helper acts on is read from a place
//!   the service can write (AC 59).

use crate::version;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The update state's file under `update/`.
pub const STATE_FILE: &str = "state.json";
/// What the package installs the bootstrap and its bundle into.
pub const INSTALLER_DIR: &str = "installer";
pub const VERSIONS_DIR: &str = "versions";
pub const UPDATE_DIR: &str = "update";
/// The package's bundle, under `installer/` (a fixed name: the version is read from inside it).
pub const PACKAGE_BUNDLE: &str = if cfg!(windows) { "lgr-server-bundle.zip" } else { "lgr-server-bundle.tar.gz" };
/// Failed versions remembered (never switched to again); the oldest are forgotten.
const FAILED_KEPT: usize = 10;

/// This machine's target, as `scripts/assemble-server-home.ts` names it in `HOME.json`.
pub fn this_target() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-arm64"
    } else {
        "unsupported"
    }
}

pub fn exe_name() -> &'static str {
    if cfg!(windows) {
        "lgr-server.exe"
    } else {
        "lgr-server"
    }
}

/// A versioned install's root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root(pub PathBuf);

impl Root {
    pub fn versions(&self) -> PathBuf {
        self.0.join(VERSIONS_DIR)
    }
    pub fn version_dir(&self, v: &str) -> PathBuf {
        self.versions().join(v)
    }
    pub fn exe_of(&self, v: &str) -> PathBuf {
        self.version_dir(v).join(exe_name())
    }
    pub fn update(&self) -> PathBuf {
        self.0.join(UPDATE_DIR)
    }
    pub fn state_file(&self) -> PathBuf {
        self.update().join(STATE_FILE)
    }
    pub fn installer(&self) -> PathBuf {
        self.0.join(INSTALLER_DIR)
    }
    /// Where an update is copied before anything reads it: SYSTEM's or root's to write, so nothing
    /// can change it between its signatures being checked and its being unpacked.
    pub fn staging(&self) -> PathBuf {
        self.update().join("staging")
    }

    /// The root `exe` belongs to: `<root>/versions/<v>/lgr-server` or `<root>/installer/lgr-server`.
    /// `None` for anything else (a development build, a hand-unpacked home).
    pub fn of_exe(exe: &Path) -> Option<Root> {
        let dir = exe.parent()?;
        let parent = dir.parent()?;
        if dir.file_name()? == INSTALLER_DIR {
            return Some(Root(parent.to_path_buf()));
        }
        if parent.file_name()? == VERSIONS_DIR && version::parse(&dir.file_name()?.to_string_lossy()).is_some() {
            return parent.parent().map(|r| Root(r.to_path_buf()));
        }
        None
    }

    /// The root this process runs from, or `LGR_SERVER_ROOT` (tests, a second install).
    pub fn here() -> Option<Root> {
        if let Some(r) = std::env::var_os("LGR_SERVER_ROOT") {
            return Some(Root(PathBuf::from(r)));
        }
        Root::of_exe(&std::env::current_exe().ok()?)
    }

    /// The version directories that are complete installs, newest first.
    pub fn installed(&self) -> Vec<String> {
        let names: Vec<String> = std::fs::read_dir(self.versions())
            .map(|d| d.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        version::newest_first(names.iter().map(String::as_str))
    }
}

/// The `bin` whose `mongod` a home runs, for the preflight's runtime check. Run from the installer's
/// copy (`installer/`, which has no `bin/`: how an operator runs `lgr-server preflight`), that is
/// the newest version installed beside it.
pub fn runtime_bin(home: &Path) -> PathBuf {
    let bin = home.join("bin");
    if !bin.is_dir() && home.file_name().is_some_and(|n| n == INSTALLER_DIR) {
        if let Some(root) = home.parent().map(|p| Root(p.to_path_buf())) {
            if let Some(newest) = root.installed().first() {
                return root.version_dir(newest).join("bin");
            }
        }
    }
    bin
}

/// `HOME.json`: what a home is (`scripts/assemble-server-home.ts`). Its `files` counts itself; its
/// `bytes` are everything else's.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HomeManifest {
    pub name: String,
    pub version: String,
    pub target: String,
    #[serde(default)]
    pub commit: Option<String>,
    /// FR-20.50 (P3-8c): the SUPTO version the home implements; none in a home from before it.
    #[serde(default)]
    pub supto: Option<String>,
    pub files: u64,
    pub bytes: u64,
}

pub const MANIFEST: &str = "HOME.json";

impl HomeManifest {
    pub fn read(home: &Path) -> Result<Self> {
        let file = home.join(MANIFEST);
        let text = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
        serde_json::from_str(&text).with_context(|| format!("{} is not a home manifest", file.display()))
    }

    /// Is this a home this machine can run? The version is the one the package names in its own
    /// signed bytes (FR-20.20), and nothing outside the bundle decides it.
    pub fn check(&self) -> Result<()> {
        if self.name != "lgr-server" {
            anyhow::bail!("this is not an LGR Server home: it calls itself {:?}", self.name);
        }
        if self.target != this_target() {
            anyhow::bail!("this home is for {}, and this machine is {}", self.target, this_target());
        }
        if version::parse(&self.version).is_none() {
            anyhow::bail!("this home's version {:?} is not one", self.version);
        }
        Ok(())
    }
}

/// Count what `dir` holds the way the assembler counted it (`sizeOf`): every entry that is not a
/// directory is a file, a link counted with what it points at, and every file's size but the
/// manifest's. ⚠ A link that leaves the directory refuses the whole tree: a version is everything it
/// runs, inside it.
pub fn measure(dir: &Path) -> Result<(u64, u64)> {
    fn walk(top: &Path, dir: &Path, files: &mut u64, bytes: &mut u64) -> Result<()> {
        for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
            let entry = entry?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            let size = if is_link(&meta) {
                let target = std::fs::canonicalize(&path).with_context(|| format!("{} is a dangling link", path.display()))?;
                if !target.starts_with(std::fs::canonicalize(top)?) {
                    anyhow::bail!("{} links outside the version ({})", path.display(), target.display());
                }
                std::fs::metadata(&path)?.len()
            } else if meta.is_dir() {
                walk(top, &path, files, bytes)?;
                continue;
            } else {
                meta.len()
            };
            *files += 1;
            if entry.file_name() != MANIFEST || dir != top {
                *bytes += size;
            }
        }
        Ok(())
    }
    let (mut files, mut bytes) = (0, 0);
    walk(dir, dir, &mut files, &mut bytes)?;
    Ok((files, bytes))
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT: a symlink, a junction or a mount point. None belongs in a home.
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// Is `dir` the complete home its manifest describes? The manifest, the files, the bytes.
pub fn verify_home(dir: &Path) -> Result<HomeManifest> {
    let m = HomeManifest::read(dir)?;
    m.check()?;
    if cfg!(windows) {
        // Windows: no link of any kind in a home (it was built without any).
        refuse_reparse_points(dir)?;
    }
    let (files, bytes) = measure(dir)?;
    if (files, bytes) != (m.files, m.bytes) {
        anyhow::bail!(
            "{} is incomplete: its manifest says {} files and {} bytes, and it holds {} files and {} bytes",
            dir.display(),
            m.files,
            m.bytes,
            files,
            bytes
        );
    }
    if !dir.join(exe_name()).is_file() {
        anyhow::bail!("{} has no {}", dir.display(), exe_name());
    }
    Ok(m)
}

fn refuse_reparse_points(dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = std::fs::symlink_metadata(entry.path())?;
        if is_link(&meta) {
            anyhow::bail!("{} is a link: a Windows home has none", entry.path().display());
        }
        if meta.is_dir() {
            refuse_reparse_points(&entry.path())?;
        }
    }
    Ok(())
}

/// The OS's own tar, by absolute path: never one found on `PATH`, which the account running the
/// package's action or the helper does not decide. Windows 10 1803+ and Server 2019+ carry bsdtar,
/// which reads the zip; every Linux this ships to has GNU tar.
fn system_tar() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let tar = root.join("System32").join("tar.exe");
        if tar.is_file() {
            return Ok(tar);
        }
        anyhow::bail!("{} is missing: this Windows is older than LGR Server supports", tar.display())
    }
    #[cfg(not(windows))]
    {
        for t in ["/usr/bin/tar", "/bin/tar"] {
            if Path::new(t).is_file() {
                return Ok(PathBuf::from(t));
            }
        }
        anyhow::bail!("no tar in /usr/bin or /bin")
    }
}

/// Unpack `bundle` into `into` (a fresh directory). GNU tar and bsdtar both refuse a member that is
/// absolute or climbs out with `..`; what they let through is checked by [`verify_home`] anyway.
fn unpack(bundle: &Path, into: &Path) -> Result<()> {
    let tar = system_tar()?;
    let mut cmd = std::process::Command::new(&tar);
    cmd.arg("-x");
    // ⚠ The modes the release gave it (-p), never the umask of whoever runs this: a root umask of 077
    // would leave the service user unable to run its own binaries. The owner is the archive's too
    // (0:0) when root unpacks it.
    #[cfg(not(windows))]
    cmd.arg("-z").arg("-p");
    cmd.arg("-f").arg(bundle).arg("-C").arg(into);
    let out = cmd.output().with_context(|| format!("running {}", tar.display()))?;
    if !out.status.success() {
        anyhow::bail!("unpacking {} failed ({}): {}", bundle.display(), out.status, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// A directory the service account may read and never write: 0755 on Unix whatever the umask (a
/// root umask of 077 would hide the update state from the service's own status); on Windows it
/// inherits Program Files' ACL, which lets users read and only administrators and SYSTEM write.
fn readable_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// What installing a bundle did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Installed {
    /// A new version directory.
    New(String),
    /// That version was installed and complete already (a repair, the same package again).
    Already(String),
}

impl Installed {
    pub fn version(&self) -> &str {
        match self {
            Installed::New(v) | Installed::Already(v) => v,
        }
    }
}

/// Install `bundle` as a version under `root`: unpacked beside `versions/`, checked, and renamed
/// into place. Switches nothing.
pub fn install_bundle(root: &Root, bundle: &Path) -> Result<Installed> {
    install_bundle_checked(root, bundle, &|_| Ok(()))
}

/// [`install_bundle`], with `check` run on the unpacked home before it is renamed into place: what
/// an update's platform signature is checked by (an exe's Authenticode is read off the unpacked file).
pub fn install_bundle_checked(root: &Root, bundle: &Path, check: &dyn Fn(&Path) -> Result<()>) -> Result<Installed> {
    let versions = root.versions();
    readable_dir(&versions)?;
    // Room for it unpacked, with margin: a bundle unpacks to about three times its size.
    let size = std::fs::metadata(bundle).with_context(|| format!("reading {}", bundle.display()))?.len();
    if let Some(free) = crate::preflight::free_disk(&versions) {
        if free < size.saturating_mul(4) {
            anyhow::bail!("{} has {} MB free, and this bundle needs about {} MB", versions.display(), free / 1_000_000, size * 4 / 1_000_000);
        }
    }
    let incoming = versions.join(format!(".incoming-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&incoming);
    std::fs::create_dir_all(&incoming)?;
    let result = (|| {
        unpack(bundle, &incoming)?;
        // One directory at the top, named for the bundle.
        let tops: Vec<_> = std::fs::read_dir(&incoming)?.filter_map(|e| e.ok()).collect();
        if tops.len() != 1 || !tops[0].path().is_dir() {
            anyhow::bail!("{} does not hold one home at its top ({} entries)", bundle.display(), tops.len());
        }
        let home = tops[0].path();
        let m = verify_home(&home).with_context(|| format!("{} is not a complete home", bundle.display()))?;
        check(&home)?;
        let dest = root.version_dir(&m.version);
        if dest.exists() {
            if verify_home(&dest).is_ok() {
                return Ok(Installed::Already(m.version));
            }
            // Damaged (a disk error, an antivirus): replaced by the copy just checked.
            tracing::warn!(dir = %dest.display(), "an installed version is damaged: replacing it");
            remove_tree(&dest)?;
        }
        std::fs::rename(&home, &dest).with_context(|| format!("moving the new version into {}", dest.display()))?;
        Ok(Installed::New(m.version))
    })();
    let _ = remove_tree(&incoming);
    result
}

/// Remove a directory tree, clearing read-only attributes on Windows (the MSI's files carry none,
/// a zip's may).
pub fn remove_tree(dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(first) => {
            #[cfg(windows)]
            {
                let _ = first;
                fn writable(dir: &Path) {
                    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                        let p = e.path();
                        if let Ok(meta) = std::fs::symlink_metadata(&p) {
                            let mut perm = meta.permissions();
                            #[allow(clippy::permissions_set_readonly_false)]
                            perm.set_readonly(false);
                            let _ = std::fs::set_permissions(&p, perm);
                            if meta.is_dir() {
                                writable(&p);
                            }
                        }
                    }
                }
                writable(dir);
                std::fs::remove_dir_all(dir).with_context(|| format!("removing {}", dir.display()))
            }
            #[cfg(not(windows))]
            {
                Err(first).with_context(|| format!("removing {}", dir.display()))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The update state

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateState {
    /// What the service is pointed at.
    pub current: String,
    /// The newest version that ran cleanly through its confirmation: what a failed update goes back
    /// to, and what the helper runs.
    pub last_known_good: String,
    /// The known good version before it: the second of the two versions FR-20.20 keeps.
    pub previous: String,
    /// A switch not yet confirmed. Written BEFORE the pointer moves (FR-20.20: the attempt is
    /// marked before it is made), so a power cut mid-switch still knows where to go back to.
    pub attempting: Option<Attempt>,
    /// Versions that failed their confirmation, newest last: never switched to again.
    pub failed: Vec<Failure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub version: String,
    /// What it goes back to.
    pub from: String,
    /// Unix seconds.
    pub at: i64,
    /// `package` or `helper`.
    pub by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub version: String,
    pub at: i64,
    pub reason: String,
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl UpdateState {
    pub fn load(root: &Root) -> Result<Self> {
        match std::fs::read_to_string(root.state_file()) {
            Ok(t) => serde_json::from_str(&t).with_context(|| format!("{} is damaged", root.state_file().display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("reading {}", root.state_file().display())),
        }
    }

    /// Written beside the file, flushed and renamed over it: a crash or a power cut leaves the old
    /// state or the new one (`config::write_durable`), never a renamed file the next start finds
    /// "damaged" in the middle of a switch.
    pub fn save(&self, root: &Root) -> Result<()> {
        readable_dir(&root.update())?;
        crate::config::write_durable(&root.state_file(), (serde_json::to_string_pretty(self)? + "\n").as_bytes(), 0o644)
    }

    #[cfg(test)]
    pub fn has_failed(&self, v: &str) -> bool {
        self.failed.iter().any(|f| f.version == v)
    }

    pub fn record_failure(&mut self, v: &str, reason: &str) {
        self.failed.retain(|f| f.version != v);
        self.failed.push(Failure { version: v.to_string(), at: now_secs(), reason: reason.to_string() });
        let excess = self.failed.len().saturating_sub(FAILED_KEPT);
        self.failed.drain(..excess);
    }

    /// The versions that must stay on disk: what runs, what it goes back to, and the one before.
    pub fn keep(&self) -> Vec<String> {
        let mut keep = vec![self.current.clone(), self.last_known_good.clone(), self.previous.clone()];
        if let Some(a) = &self.attempting {
            keep.push(a.version.clone());
            keep.push(a.from.clone());
        }
        keep.retain(|v| !v.is_empty());
        keep.sort();
        keep.dedup();
        keep
    }
}

/// What a switch to `candidate` will be. Who restarts the service is the caller's business: the MSI
/// does (its upgrade stops the service anyway), the .deb never does (an upgrade must not bounce a
/// till mid-sale: the new version runs from the next start), the helper does in its window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Nothing ran here before: it is current and known good at once (nothing to go back to).
    First,
    /// An update: the pointer moves, the helper watches it run, and it is confirmed or switched
    /// back to `from`.
    Attempt { from: String },
    /// It is current already: pointed at again (a repair), nothing else.
    Same,
    /// Never switched to: why.
    Refused(String),
}

/// Decide a switch. `current_exists`: whether the current version is still on disk (a damaged
/// install with nothing to run is treated as a first one).
pub fn plan(state: &UpdateState, candidate: &str, current_exists: bool) -> Plan {
    if version::parse(candidate).is_none() {
        return Plan::Refused(format!("{candidate:?} is not a version"));
    }
    if state.current.is_empty() || !current_exists {
        return Plan::First;
    }
    if candidate == state.current {
        return Plan::Same;
    }
    if let Some(f) = state.failed.iter().find(|f| f.version == candidate) {
        return Plan::Refused(format!("{candidate} failed its confirmation before ({}): it is not switched to again", f.reason));
    }
    // ⚠ Measured against the newest of what runs and what is known good: an update in flight is not
    // a floor a package may install under, and never a version a package may go below either.
    let floor = if version::is_upgrade(&state.current, &state.last_known_good) { &state.last_known_good } else { &state.current };
    if !version::is_upgrade(floor, candidate) {
        return Plan::Refused(format!("{candidate} is not newer than {floor}: an update is never a downgrade"));
    }
    Plan::Attempt {
        // ⚠ Back to the last version KNOWN good, not to an attempt still being watched.
        from: if state.last_known_good.is_empty() { state.current.clone() } else { state.last_known_good.clone() },
    }
}

/// The state after a plan is carried out (the pointer moves right after this is saved).
pub fn apply(state: &UpdateState, candidate: &str, plan: &Plan, by: &str) -> UpdateState {
    let mut s = state.clone();
    match plan {
        Plan::First => {
            s.current = candidate.to_string();
            s.last_known_good = candidate.to_string();
            s.attempting = None;
        }
        Plan::Attempt { from } => {
            s.attempting = Some(Attempt { version: candidate.to_string(), from: from.clone(), at: now_secs(), by: by.to_string() });
            s.current = candidate.to_string();
        }
        Plan::Same | Plan::Refused(_) => {}
    }
    s
}

/// The attempt ran cleanly: it is the known good version now, and the one it replaced is kept as
/// the previous.
pub fn confirmed(state: &UpdateState, attempt: &Attempt) -> UpdateState {
    let mut s = state.clone();
    if s.attempting.as_ref() == Some(attempt) {
        s.previous = attempt.from.clone();
        s.last_known_good = attempt.version.clone();
        s.attempting = None;
    }
    s
}

/// The attempt failed: the service goes back to `from`, and the attempt is never made again.
pub fn rolled_back(state: &UpdateState, attempt: &Attempt, reason: &str) -> UpdateState {
    let mut s = state.clone();
    if s.attempting.as_ref() == Some(attempt) {
        s.current = attempt.from.clone();
        s.attempting = None;
        s.record_failure(&attempt.version, reason);
    }
    s
}

/// The version directories to remove: everything the state does not keep, and nothing it does.
/// ⚠ Nothing at all while the state names no current version (lost, or never written): an empty
/// keep list would otherwise remove the version that runs.
pub fn to_prune(installed: &[String], state: &UpdateState) -> Vec<String> {
    if state.current.is_empty() {
        return Vec::new();
    }
    let keep = state.keep();
    installed.iter().filter(|v| !keep.contains(v)).cloned().collect()
}

// ---------------------------------------------------------------------------------------------
// One at a time

/// Held while a version is installed or switched: the package's action, the helper and an operator
/// never interleave. An OS lock, released if the holder dies.
pub struct Lock(#[allow(dead_code)] std::fs::File);

impl Lock {
    pub fn take(root: &Root, wait: std::time::Duration) -> Result<Lock> {
        readable_dir(&root.update())?;
        let path = root.update().join("lock");
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path).with_context(|| format!("opening {}", path.display()))?;
        let until = std::time::Instant::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Lock(file)),
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(250)),
                Err(std::fs::TryLockError::WouldBlock) => anyhow::bail!("another update is in progress ({} is held)", path.display()),
                Err(std::fs::TryLockError::Error(e)) => return Err(e).with_context(|| format!("locking {}", path.display())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(current: &str, lkg: &str) -> UpdateState {
        UpdateState { current: current.into(), last_known_good: lkg.into(), ..Default::default() }
    }

    /// `installer/lgr-server preflight`: the installer's copy has no `bin/`, the version that runs
    /// mongod does.
    #[test]
    fn the_installers_copy_answers_for_the_newest_installed_version() {
        let t = tempfile::tempdir().unwrap();
        let installer = t.path().join(INSTALLER_DIR);
        std::fs::create_dir_all(&installer).unwrap();
        for v in ["0.1.0", "0.1.1"] {
            std::fs::create_dir_all(t.path().join(VERSIONS_DIR).join(v).join("bin")).unwrap();
        }
        assert_eq!(runtime_bin(&installer), t.path().join(VERSIONS_DIR).join("0.1.1").join("bin"));
        // A version's own home answers for itself, whatever else is installed.
        let old = t.path().join(VERSIONS_DIR).join("0.1.0");
        assert_eq!(runtime_bin(&old), old.join("bin"));
    }

    #[test]
    fn a_root_is_found_from_where_its_executables_live() {
        let r = PathBuf::from(if cfg!(windows) { r"C:\Program Files\LGR Server" } else { "/opt/lgr-server" });
        assert_eq!(Root::of_exe(&r.join("versions").join("0.2.0").join(exe_name())), Some(Root(r.clone())));
        assert_eq!(Root::of_exe(&r.join("installer").join(exe_name())), Some(Root(r.clone())));
        // A development build, a hand-unpacked home, a directory that only looks like one.
        assert_eq!(Root::of_exe(&r.join("target").join("release").join(exe_name())), None);
        assert_eq!(Root::of_exe(&r.join("versions").join("latest").join(exe_name())), None);
    }

    #[test]
    fn the_first_install_is_current_and_known_good_at_once() {
        let s = UpdateState::default();
        assert_eq!(plan(&s, "0.1.0", false), Plan::First);
        let s = apply(&s, "0.1.0", &Plan::First, "package");
        assert_eq!((s.current.as_str(), s.last_known_good.as_str(), s.attempting.is_none()), ("0.1.0", "0.1.0", true));
    }

    #[test]
    fn an_update_is_an_attempt_that_goes_back_to_the_known_good_version() {
        let s = state("0.1.0", "0.1.0");
        let p = plan(&s, "0.2.0", true);
        assert_eq!(p, Plan::Attempt { from: "0.1.0".into() });
        let s = apply(&s, "0.2.0", &p, "package");
        assert_eq!(s.current, "0.2.0");
        assert_eq!(s.last_known_good, "0.1.0", "known good moves only on confirmation");
        let attempt = s.attempting.clone().unwrap();
        assert_eq!((attempt.version.as_str(), attempt.from.as_str()), ("0.2.0", "0.1.0"));

        // A newer package while 0.2.0 is still being watched goes back to 0.1.0, never to 0.2.0.
        assert_eq!(plan(&s, "0.3.0", true), Plan::Attempt { from: "0.1.0".into() });

        let good = confirmed(&s, &attempt);
        assert_eq!((good.current.as_str(), good.last_known_good.as_str(), good.previous.as_str()), ("0.2.0", "0.2.0", "0.1.0"));
        assert!(good.attempting.is_none());

        let back = rolled_back(&s, &attempt, "crashed");
        assert_eq!((back.current.as_str(), back.last_known_good.as_str()), ("0.1.0", "0.1.0"));
        assert!(back.has_failed("0.2.0") && back.attempting.is_none());
    }

    #[test]
    fn a_verdict_on_an_attempt_that_was_replaced_changes_nothing() {
        // The MSI installed 0.3.0 while the helper watched 0.2.0: its verdict on 0.2.0 is stale.
        let s = apply(&state("0.1.0", "0.1.0"), "0.2.0", &Plan::Attempt { from: "0.1.0".into() }, "helper");
        let old = s.attempting.clone().unwrap();
        let s = apply(&s, "0.3.0", &Plan::Attempt { from: "0.1.0".into() }, "package");
        assert_eq!(confirmed(&s, &old), s);
        assert_eq!(rolled_back(&s, &old, "x"), s);
    }

    #[test]
    fn never_a_downgrade_and_never_a_version_that_failed() {
        let mut s = state("0.2.0", "0.2.0");
        assert!(matches!(plan(&s, "0.1.0", true), Plan::Refused(_)));
        assert_eq!(plan(&s, "0.2.0", true), Plan::Same);
        s.record_failure("0.3.0", "crashed 3 times in 10 minutes");
        assert!(matches!(plan(&s, "0.3.0", true), Plan::Refused(r) if r.contains("failed")));
        assert_eq!(plan(&s, "0.3.1", true), Plan::Attempt { from: "0.2.0".into() });
        assert!(matches!(plan(&s, "latest", true), Plan::Refused(_)));
    }

    #[test]
    fn a_package_may_not_install_under_a_newer_known_good_version() {
        // Rolled back from 0.3.0 to 0.2.0 by hand while 0.4.0 is known good: hypothetical, refused.
        let s = state("0.2.0", "0.4.0");
        assert!(matches!(plan(&s, "0.3.0", true), Plan::Refused(_)));
    }

    #[test]
    fn nothing_kept_is_pruned_and_everything_else_is() {
        let mut s = state("0.3.0", "0.2.0");
        s.previous = "0.1.5".into();
        s.attempting = Some(Attempt { version: "0.3.0".into(), from: "0.2.0".into(), at: 0, by: "helper".into() });
        let installed = ["0.4.0", "0.3.0", "0.2.0", "0.1.5", "0.1.0"].map(String::from);
        assert_eq!(to_prune(&installed, &s), ["0.4.0", "0.1.0"]);
        // Confirmed: the attempt and the version it replaced stay, nothing older.
        let s = confirmed(&s, &s.attempting.clone().unwrap());
        assert_eq!(to_prune(&installed, &s), ["0.4.0", "0.1.5", "0.1.0"]);
        assert!(to_prune(&installed, &UpdateState::default()).is_empty(), "a lost state prunes nothing");
    }

    #[test]
    fn failures_are_remembered_and_the_oldest_forgotten() {
        let mut s = UpdateState::default();
        for i in 0..15 {
            s.record_failure(&format!("0.{i}.0"), "x");
        }
        assert_eq!(s.failed.len(), FAILED_KEPT);
        assert!(!s.has_failed("0.0.0") && s.has_failed("0.14.0"));
    }

    fn home(dir: &Path, version: &str, files: &[(&str, &[u8])]) {
        for (name, body) in files {
            let p = dir.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let bytes: u64 = files.iter().map(|(_, b)| b.len() as u64).sum();
        let m = HomeManifest { name: "lgr-server".into(), version: version.into(), target: this_target().into(), commit: None, supto: None, files: files.len() as u64 + 1, bytes };
        std::fs::write(dir.join(MANIFEST), serde_json::to_string(&m).unwrap()).unwrap();
    }

    #[test]
    fn a_home_is_complete_or_refused() {
        let t = tempfile::tempdir().unwrap();
        let exe = exe_name();
        home(t.path(), "0.1.0", &[(exe, b"exe"), ("bin/bun", b"bun!"), ("package/app/server.js", b"js")]);
        assert_eq!(verify_home(t.path()).unwrap().version, "0.1.0");

        // A file missing, a file truncated, one too many: each refuses the home.
        std::fs::write(t.path().join("package/app/server.js"), b"j").unwrap();
        assert!(verify_home(t.path()).unwrap_err().to_string().contains("incomplete"));
        std::fs::write(t.path().join("package/app/server.js"), b"js").unwrap();
        std::fs::write(t.path().join("extra"), b"").unwrap();
        assert!(verify_home(t.path()).is_err());
        std::fs::remove_file(t.path().join("extra")).unwrap();
        assert!(verify_home(t.path()).is_ok());

        // Another machine's home, or something that is not one.
        let m = HomeManifest::read(t.path()).unwrap();
        let other = HomeManifest { target: "linux-arm64-or-windows".into(), ..m.clone() };
        assert!(other.check().is_err());
        assert!(HomeManifest { name: "something".into(), ..m }.check().is_err());
    }

    /// The real thing: a bundle made with the OS's tar, as the release makes it, installed twice.
    #[test]
    fn a_bundle_installs_into_its_version_and_a_second_time_changes_nothing() {
        let t = tempfile::tempdir().unwrap();
        let stage = t.path().join("stage");
        let top = stage.join("lgr-server-0.2.0-test");
        std::fs::create_dir_all(&top).unwrap();
        home(&top, "0.2.0", &[(exe_name(), b"exe"), ("bin/bun", b"bun!"), ("package/server-manifest.json", b"{}")]);
        let bundle = t.path().join(if cfg!(windows) { "b.zip" } else { "b.tar.gz" });
        let tar = system_tar().unwrap();
        let mut cmd = std::process::Command::new(tar);
        if cfg!(windows) {
            cmd.arg("-a");
        } else {
            cmd.arg("-z");
        }
        assert!(cmd.arg("-c").arg("-f").arg(&bundle).arg("-C").arg(&stage).arg("lgr-server-0.2.0-test").status().unwrap().success());

        let root = Root(t.path().join("root"));
        assert_eq!(install_bundle(&root, &bundle).unwrap(), Installed::New("0.2.0".into()));
        assert!(verify_home(&root.version_dir("0.2.0")).is_ok());
        assert_eq!(install_bundle(&root, &bundle).unwrap(), Installed::Already("0.2.0".into()));
        assert_eq!(root.installed(), ["0.2.0"]);
        // Nothing of the unpacking is left beside the versions.
        let left: Vec<_> = std::fs::read_dir(root.versions()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(left, ["0.2.0"]);

        // A damaged version is replaced by the bundle's copy.
        std::fs::remove_file(root.version_dir("0.2.0").join("bin").join("bun")).unwrap();
        assert_eq!(install_bundle(&root, &bundle).unwrap(), Installed::New("0.2.0".into()));
        assert!(verify_home(&root.version_dir("0.2.0")).is_ok());
    }

    #[test]
    fn a_bundle_that_is_not_one_complete_home_installs_nothing() {
        let t = tempfile::tempdir().unwrap();
        let stage = t.path().join("stage");
        let top = stage.join("h");
        std::fs::create_dir_all(&top).unwrap();
        home(&top, "0.2.0", &[(exe_name(), b"exe")]);
        std::fs::write(top.join("smuggled"), b"not in the manifest").unwrap();
        let bundle = t.path().join(if cfg!(windows) { "b.zip" } else { "b.tar.gz" });
        let mut cmd = std::process::Command::new(system_tar().unwrap());
        cmd.arg(if cfg!(windows) { "-a" } else { "-z" });
        assert!(cmd.arg("-c").arg("-f").arg(&bundle).arg("-C").arg(&stage).arg("h").status().unwrap().success());
        let root = Root(t.path().join("root"));
        assert!(install_bundle(&root, &bundle).is_err());
        assert!(root.installed().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_version_refuses_it() {
        let t = tempfile::tempdir().unwrap();
        home(t.path(), "0.1.0", &[(exe_name(), b"exe")]);
        std::os::unix::fs::symlink("/etc/passwd", t.path().join("passwd")).unwrap();
        assert!(verify_home(t.path()).unwrap_err().to_string().contains("outside"));
    }

    #[test]
    fn two_updates_never_interleave() {
        let t = tempfile::tempdir().unwrap();
        let root = Root(t.path().to_path_buf());
        let held = Lock::take(&root, std::time::Duration::ZERO).unwrap();
        assert!(Lock::take(&root, std::time::Duration::from_millis(300)).is_err());
        drop(held);
        assert!(Lock::take(&root, std::time::Duration::ZERO).is_ok());
    }
}
