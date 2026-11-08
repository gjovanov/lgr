//! C11 — non-roaming storage for the desktop key and `installationId` (FR-14.20).
//!
//! This is what makes a desktop **revocable**: until the key exists in per-machine storage and
//! the server reads the row on every request, "revoke" is a button that does nothing to the
//! machine.
//!
//! ⚠ **NON-ROAMING is the whole requirement**, and the obvious implementation gets it wrong.
//! The `keyring` crate's Windows default is `CRED_PERSIST_ENTERPRISE`, which **roams with the
//! user profile** — every PC that user signs into would receive the same desktop key, so one
//! revocation would be needed per machine and a key copied by Windows itself would be a
//! credential on hardware nobody enrolled (C11's trap 10). So this does not use it. On Windows
//! the key is DPAPI-sealed under `%LOCALAPPDATA%`, which the chunk names as the alternative and
//! which cannot roam by construction: `LOCALAPPDATA` is the non-roaming half of the profile.
//!
//! ⚠ **Nothing credential-bearing lives in `app_data_dir()`** (§1.2 #5) and nothing goes in
//! `settings.json` — that file is what gets copied when somebody clones a PC, and
//! `settings.rs`'s own test fails if a key-shaped field ever appears in it. A copied config must
//! yield no credential (AC 10).

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// Where the key ended up, which the Overview turns into a banner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStorage {
    /// No key: this desktop is not registered.
    None,
    /// An OS secret store (DPAPI on Windows, Keychain on macOS, Secret Service on Linux).
    Keystore,
    /// A `0600` file, because this system has no secret store. **Warned about** (FR-14.30).
    File,
}

impl KeyStorage {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyStorage::None => "none",
            KeyStorage::Keystore => "keystore",
            KeyStorage::File => "file",
        }
    }
}

/// What this machine holds about its registration.
///
/// ⚠ The secret is NOT here. `Stored` is the readable half — ids and the public key — and the
/// private bytes are fetched separately, so a log line or a debug print of this struct cannot
/// leak the credential.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Stored {
    pub installation_id: String,
    pub desktop_id: String,
    pub org_id: String,
    pub org_name: String,
    pub start_path: String,
    pub fiscal_device_ids: Vec<String>,
    /// Set when the server told this machine it is no longer welcome (FR-14.22).
    pub revoked: bool,
    /// FR-14.19, #328 — enrolled with an enrollment KEY: it unregisters itself on a clean shutdown
    /// (`enroll::unregister_self`), and the hub's reaper is the backstop.
    pub ephemeral: bool,
    /// server − local, in milliseconds, learned from `serverTime`.
    pub clock_offset_ms: i64,
    /**
     * FR-14.29 — set when the hub answered **426 `desktop_outdated`**.
     *
     * ⚠ Persisted, because the banner has to survive a restart: a desktop below the floor cannot
     * mint a token, so nothing on the next launch would otherwise rediscover the fact until
     * something tried and failed again. Cleared by a successful mint.
     */
    pub update_required: bool,
}

/// The non-roaming directory for credential-bearing files.
///
/// ⚠ Deliberately NOT `app_data_dir()`. On Windows that is `%APPDATA%`, which **roams**; this is
/// `%LOCALAPPDATA%`, which does not. On macOS and Linux the distinction does not exist in the
/// same form, and the platform's own local data directory is already per-machine.
pub fn secure_dir() -> io::Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is not set"))?
    } else {
        dirs_local_data()?
    };
    let dir = base.join("com.lgr.desktop").join("identity");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn dirs_local_data() -> io::Result<PathBuf> {
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        if cfg!(target_os = "macos") {
            return Ok(home.join("Library").join("Application Support"));
        }
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(xdg));
        }
        return Ok(home.join(".local").join("share"));
    }
    Err(io::Error::new(io::ErrorKind::NotFound, "no home directory"))
}

fn record_path(dir: &Path) -> PathBuf {
    dir.join("registration.json")
}

fn secret_path(dir: &Path) -> PathBuf {
    dir.join("desktop.key")
}

/// Read the readable half. Absent or corrupt is "not registered", never a failure to start.
///
/// No lock: every write replaces the file whole ([`write_atomically`]), so a read at any moment
/// finds the record before a write or after it.
pub fn load(dir: &Path) -> Stored {
    std::fs::read_to_string(record_path(dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Every write of the record in this process, one at a time (lgr#587).
///
/// ⚠ Held across a whole read-change-write ([`update`]), and never across a request to a server:
/// presence and the bridge each mint a token at every start, a mint writes back what it learned
/// (the clock's offset, `update_required`), and two writes that each began from their own read
/// lost one another's change.
static RECORD: Mutex<()> = Mutex::new(());

fn record_lock() -> MutexGuard<'static, ()> {
    // A thread that panicked while holding it left no half-written record behind (the write is
    // atomic), so the lock is simply taken again instead of failing every later write.
    RECORD.lock().unwrap_or_else(|e| e.into_inner())
}

/// Write the readable half, whole. For a change to what is stored, [`update`].
pub fn save(dir: &Path, stored: &Stored) -> io::Result<()> {
    let _held = record_lock();
    write_record(dir, stored)
}

/// Read the record, change it, and write it back, with no other write of it in between. Returns
/// the record as it now is. Nothing is written when the change changed nothing.
///
/// ⚠ The way to change the record. A `load` then a `save` loses whatever another thread wrote in
/// between, and a mint can be that other thread at any time.
pub fn update(dir: &Path, change: impl FnOnce(&mut Stored)) -> io::Result<Stored> {
    let _held = record_lock();
    let mut stored = load(dir);
    let before = serde_json::to_string(&stored)?;
    change(&mut stored);
    if serde_json::to_string(&stored)? != before {
        write_record(dir, &stored)?;
    }
    Ok(stored)
}

fn write_record(dir: &Path, stored: &Stored) -> io::Result<()> {
    let text = serde_json::to_string_pretty(stored)?;
    write_atomically(&record_path(dir), text.as_bytes())
}

/// `path` replaced by `bytes`, so that a reader finds the old file or the new one and never a short
/// or empty one (lgr#587). The bytes go to a file beside it, are flushed to the disk, and that file
/// is renamed over `path`.
///
/// ⚠ `std::fs::write` truncated the record and then wrote it. A read in between, the bridge's mint
/// at a start while presence's mint was writing, found it empty and took the machine for
/// unregistered: `not_registered`, which the bridge treats as final, so the till held no fiscal
/// device until LGR Desktop was restarted by hand.
///
/// `std::fs::rename` replaces the target in one step: `rename(2)` on Unix; on Windows
/// `SetFileInformationByHandle` (`FileRenameInfoEx`, POSIX semantics) where the OS has it, else
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`. A reader that has the old file open keeps reading
/// the old file: std opens files with `FILE_SHARE_DELETE`.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    replace(&tmp, path)
}

/// The rename, asked a few times more when refused. ⚠ On Windows a file another process holds open
/// without `FILE_SHARE_DELETE` (an antivirus scanning it, a backup tool) cannot be replaced, and the
/// refusal says "access denied" at once rather than waiting for the handle to close.
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    let mut tries = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && tries < 5 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Seal the 32 secret bytes with whatever this OS offers, and report which it was.
pub fn store_secret(dir: &Path, secret: &[u8; 32]) -> io::Result<KeyStorage> {
    let (blob, kind) = seal(secret)?;
    let path = secret_path(dir);
    std::fs::write(&path, blob)?;
    restrict(&path)?;
    Ok(kind)
}

/// Read the secret back, or `None` when this machine holds none.
pub fn load_secret(dir: &Path) -> Option<[u8; 32]> {
    let blob = std::fs::read(secret_path(dir)).ok()?;
    let open = unseal(&blob)?;
    open.try_into().ok()
}

/// Delete the key. Part of revocation (FR-14.22) and of uninstall.
///
/// ⚠ Returns Ok when there was nothing to delete: "the key is gone" is the desired state, and a
/// revocation that fails because it already happened would leave the Overview lying.
pub fn delete_secret(dir: &Path) -> io::Result<()> {
    match std::fs::remove_file(secret_path(dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// What the Overview shows: where the key is, if there is one.
pub fn key_storage(dir: &Path) -> KeyStorage {
    if !secret_path(dir).exists() {
        return KeyStorage::None;
    }
    if cfg!(windows) { KeyStorage::Keystore } else { KeyStorage::File }
}

// ── Platform sealing ────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn seal(secret: &[u8; 32]) -> io::Result<(Vec<u8>, KeyStorage)> {
    // DPAPI with the default (per-user, per-machine) scope: the blob is readable only by this
    // user ON THIS MACHINE, so copying the file to another PC yields nothing. That is exactly
    // AC 10, and it is a property of DPAPI rather than of file permissions.
    Ok((dpapi::protect(secret)?, KeyStorage::Keystore))
}

#[cfg(not(windows))]
fn seal(secret: &[u8; 32]) -> io::Result<(Vec<u8>, KeyStorage)> {
    // ⚠ The honest fallback. macOS Keychain and Linux Secret Service need a dependency and a
    // running session bus respectively; until C11's follow-up wires them, the key is a `0600`
    // file and the Overview SAYS SO (FR-14.30's `key-in-file` banner). A silent file would be
    // the same risk without the warning, which is the part that matters.
    Ok((secret.to_vec(), KeyStorage::File))
}

#[cfg(windows)]
fn unseal(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi::unprotect(blob).ok()
}

#[cfg(not(windows))]
fn unseal(blob: &[u8]) -> Option<Vec<u8>> {
    Some(blob.to_vec())
}

/// Owner-only permissions. On Windows DPAPI already binds the blob to the user; elsewhere this
/// is the only thing standing between the key and every other account on the box.
#[cfg(unix)]
fn restrict(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
mod dpapi {
    use std::io;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            optional_entropy: *const DataBlob,
            reserved: *mut core::ffi::c_void,
            prompt: *mut core::ffi::c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            optional_entropy: *const DataBlob,
            reserved: *mut core::ffi::c_void,
            prompt: *mut core::ffi::c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }

    #[repr(C)]
    struct DataBlob {
        cb: u32,
        pb: *mut u8,
    }

    /// ⚠ Not `CRYPTPROTECT_LOCAL_MACHINE`. That flag would let ANY account on the box unseal
    /// the key; the default scope binds it to this user on this machine, which is what the
    /// non-roaming requirement is about.
    const NO_FLAGS: u32 = 0;

    fn blob(data: &[u8]) -> DataBlob {
        DataBlob { cb: data.len() as u32, pb: data.as_ptr() as *mut u8 }
    }

    fn take(out: DataBlob) -> Vec<u8> {
        let slice = unsafe { std::slice::from_raw_parts(out.pb, out.cb as usize) }.to_vec();
        unsafe { LocalFree(out.pb as *mut core::ffi::c_void) };
        slice
    }

    pub fn protect(data: &[u8]) -> io::Result<Vec<u8>> {
        let input = blob(data);
        let mut out = DataBlob { cb: 0, pb: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                NO_FLAGS,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(take(out))
    }

    pub fn unprotect(data: &[u8]) -> io::Result<Vec<u8>> {
        let input = blob(data);
        let mut out = DataBlob { cb: 0, pb: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                NO_FLAGS,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(take(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lgr-keystore-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_secret_survives_a_round_trip() {
        let dir = temp_dir("roundtrip");
        let secret = [7u8; 32];
        let kind = store_secret(&dir, &secret).unwrap();
        assert_ne!(kind, KeyStorage::None);
        assert_eq!(load_secret(&dir).unwrap(), secret);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn the_sealed_blob_is_not_the_secret() {
        // ⚠ The whole point of DPAPI here: the bytes on disk must not BE the key. If this ever
        // passes trivially, sealing has silently become a copy.
        let dir = temp_dir("sealed");
        let secret = [9u8; 32];
        store_secret(&dir, &secret).unwrap();
        let on_disk = std::fs::read(dir.join("desktop.key")).unwrap();
        assert_ne!(on_disk, secret.to_vec(), "the key is stored in clear");
        assert!(on_disk.len() > 32, "a DPAPI blob carries its own header");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_key_means_not_registered() {
        let dir = temp_dir("empty");
        assert_eq!(key_storage(&dir), KeyStorage::None);
        assert!(load_secret(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_a_key_that_is_already_gone_is_success() {
        // Revocation must not fail because it already happened; the Overview would then say the
        // machine still holds a key it does not have.
        let dir = temp_dir("delete");
        assert!(delete_secret(&dir).is_ok());
        store_secret(&dir, &[1u8; 32]).unwrap();
        assert!(delete_secret(&dir).is_ok());
        assert_eq!(key_storage(&dir), KeyStorage::None);
        assert!(delete_secret(&dir).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_readable_record_carries_no_secret() {
        // ⚠ Structural, like `settings.rs`'s. `registration.json` is the other file a cloned PC
        // would carry; if a key ever lands in it, AC 10 has failed whatever else works.
        let stored = Stored {
            installation_id: "abc".into(),
            desktop_id: "d1".into(),
            org_id: "o1".into(),
            org_name: "Acme".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&stored).unwrap().to_ascii_lowercase();
        for forbidden in ["secret", "privatekey", "\"key\"", "token", "password", "assertion"] {
            assert!(!json.contains(forbidden), "registration record must not carry {forbidden}: {json}");
        }
    }

    #[test]
    fn a_reader_never_finds_the_record_half_written() {
        // ⚠ lgr#587. Presence and the bridge each mint at every start, and a mint writes the
        // record back. `std::fs::write` truncated it first, so the other thread could read it
        // empty, take the machine for unregistered, and the bridge gave its fiscal device up for
        // good. Two records of very different sizes, written in turn while another thread reads.
        let dir = temp_dir("torn");
        let a = Stored { desktop_id: "d1".into(), org_name: "short".into(), ..Default::default() };
        let b = Stored {
            desktop_id: "d2".into(),
            org_name: "x".repeat(4096),
            fiscal_device_ids: (0..64).map(|i| format!("device-{i}")).collect(),
            ..Default::default()
        };
        save(&dir, &a).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let writes = Arc::new(AtomicU32::new(0));
        let writer = {
            let (dir, stop, writes) = (dir.clone(), stop.clone(), writes.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let n = writes.load(Ordering::SeqCst);
                    save(&dir, if n.is_multiple_of(2) { &b } else { &a }).unwrap();
                    writes.fetch_add(1, Ordering::SeqCst);
                }
            })
        };
        // ⚠ Bounded by writes AND by time: every write is flushed to the disk (`sync_all`), which a
        // busy disk takes most of a second over, so a fixed two seconds proved nothing there.
        let deadline = Instant::now() + Duration::from_secs(10);
        let (mut reads, mut empty, mut seen_a, mut seen_b) = (0u32, 0u32, 0u32, 0u32);
        while Instant::now() < deadline && !(writes.load(Ordering::SeqCst) >= 20 && reads >= 1000) {
            match load(&dir).desktop_id.as_str() {
                "" => empty += 1,
                "d1" => seen_a += 1,
                _ => seen_b += 1,
            }
            reads += 1;
        }
        stop.store(true, Ordering::SeqCst);
        writer.join().unwrap();
        let writes = writes.load(Ordering::SeqCst);
        let _ = std::fs::remove_dir_all(&dir);
        // The reads met the writes: both records were read, so the file changed under the reader.
        assert!(seen_a > 0 && seen_b > 0, "no race happened: {writes} writes, {reads} reads ({seen_a} of d1, {seen_b} of d2)");
        assert_eq!(empty, 0, "{empty} of {reads} reads found no registration while {writes} writes ran");
    }

    #[test]
    fn two_threads_changing_the_record_at_once_lose_neither_change() {
        // ⚠ lgr#587, the other half: a mint's write began from its own read, so the change another
        // thread wrote in between was lost. `update` holds the record through the whole change.
        let dir = temp_dir("update");
        save(&dir, &Stored { desktop_id: "d1".into(), ..Default::default() }).unwrap();
        const N: i64 = 100;
        let offsets = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                for _ in 0..N {
                    update(&dir, |s| s.clock_offset_ms += 1).unwrap();
                }
            })
        };
        let devices = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                for i in 0..N {
                    update(&dir, |s| s.fiscal_device_ids.push(format!("device-{i}"))).unwrap();
                }
            })
        };
        offsets.join().unwrap();
        devices.join().unwrap();
        let s = load(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(s.desktop_id, "d1");
        assert_eq!(s.clock_offset_ms, N, "a change one thread wrote was lost to the other's write");
        assert_eq!(s.fiscal_device_ids.len() as i64, N, "a change one thread wrote was lost to the other's write");
    }

    #[test]
    fn an_update_that_changes_nothing_writes_nothing() {
        // The record is written only when it changes: no needless writes behind every mint.
        let dir = temp_dir("noop");
        save(&dir, &Stored { desktop_id: "d1".into(), ..Default::default() }).unwrap();
        // A folder in place of the record's temporary file: any write would fail on it.
        std::fs::create_dir_all(dir.join("registration.json.tmp")).unwrap();
        let s = update(&dir, |s| s.desktop_id = "d1".into()).unwrap();
        assert_eq!(s.desktop_id, "d1");
        assert!(update(&dir, |s| s.org_name = "changed".into()).is_err(), "a real change must write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_record_reads_as_not_registered() {
        let dir = temp_dir("corrupt");
        std::fs::write(dir.join("registration.json"), "not json").unwrap();
        let s = load(&dir);
        assert!(s.desktop_id.is_empty(), "a corrupt file must not stop the app starting");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_secure_directory_is_the_non_roaming_one() {
        // ⚠ On Windows this must be LOCALAPPDATA, never APPDATA. APPDATA roams with the user
        // profile, which would hand every PC that user signs into the same desktop key.
        let dir = secure_dir().unwrap();
        let s = dir.to_string_lossy().to_ascii_lowercase();
        if cfg!(windows) {
            assert!(!s.contains("\\roaming\\"), "the key directory roams: {s}");
            assert!(s.contains("local"), "expected LOCALAPPDATA: {s}");
        }
        assert!(s.contains("com.lgr.desktop"));
    }
}
