//! #592: a master's logs are capped. All of them were opened append-only, and nothing rotated, capped
//! or deleted them: a shop's PC runs for years, and its logs grew past what a person can open when
//! something goes wrong, onto the disk its backups also need (soak-t2: 8.2 MB a day with one till
//! trading, `mongod.log` alone on its way to 855 MB a year).
//!
//! Each log keeps up to `keep` older files beside it, the newest `.1`, and past `max_bytes` starts
//! over:
//! - **the supervisor's own** (`lgr-server.log`, and the update helper's `helper.log`): [`Rotating`],
//!   its writer, starts a new file itself. Only its own process writes the file.
//! - **a child's** (`api.log`, `mongod.console.log`): the child holds it open as its stdout and
//!   stderr, so it is never renamed under it, or the child would go on writing into the renamed
//!   file. [`run`] copies it to `.1` and empties it in place ([`rotate_held`]), and the child's next
//!   line lands at the new end: it writes in append mode (`child::spawn`), which puts every write at
//!   the end of the file, wherever that is now.
//!   ⚠ What the child writes between the copy and the emptying is lost: a line or two, once per
//!   rotation, as logrotate's `copytruncate` also accepts.
//! - **mongod's** (`mongod.log`): its own `logRotate` renames it `mongod.log.<time>` and opens a new
//!   one; the oldest of those past `keep` are deleted ([`prune_mongod`]).

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How often the children's logs and mongod's are looked at. The supervisor's own is checked at
/// every line it writes.
pub const EVERY: Duration = Duration::from_secs(600);

/// How big a log grows before it starts over, and how many older ones it keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_bytes: u64,
    pub keep: usize,
}

impl Default for Limits {
    /// 20 MB, five kept: at most about 120 MB a log, and any one of them opens in an editor.
    fn default() -> Self {
        Self { max_bytes: 20 << 20, keep: 5 }
    }
}

impl Limits {
    /// `LOG_MAX_MB` and `LOG_KEEP` in `config/api.env`, each within reason. A wrong one keeps its
    /// default and is said in the second value, for the caller to log: a log setting never stops a
    /// shop.
    pub fn from_operator(operator: &BTreeMap<String, String>) -> (Self, Vec<String>) {
        let mut limits = Self::default();
        let mut wrong = Vec::new();
        if let Some(v) = operator.get("LOG_MAX_MB") {
            match v.trim().parse::<u64>() {
                Ok(mb @ 1..=1024) => limits.max_bytes = mb << 20,
                _ => wrong.push(format!("LOG_MAX_MB={v} is not a size from 1 to 1024 (MB): logs start over at 20 MB")),
            }
        }
        if let Some(v) = operator.get("LOG_KEEP") {
            match v.trim().parse::<usize>() {
                Ok(n @ 1..=50) => limits.keep = n,
                _ => wrong.push(format!("LOG_KEEP={v} is not a count from 1 to 50: five older logs are kept")),
            }
        }
        (limits, wrong)
    }
}

/// `<path>.<n>`: `api.log.1` is the newest of the older ones.
fn numbered(path: &Path, n: usize) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".{n}"));
    PathBuf::from(s)
}

/// Make room for a new `.1`: `.1` … `.<keep-1>` move one up, and `.<keep>`, the oldest, goes.
fn shift(path: &Path, keep: usize) {
    let _ = std::fs::remove_file(numbered(path, keep));
    for n in (1..keep).rev() {
        let from = numbered(path, n);
        if from.exists() {
            let _ = std::fs::rename(&from, numbered(path, n + 1));
        }
    }
}

fn append(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// A log its own process writes: appended, and once a line would take it past `max_bytes`, renamed
/// `.1` (the older ones shifted, the oldest past `keep` gone) and started again.
///
/// ⚠ Never fails its writer for a rotation: a file that cannot be renamed (another program holding it
/// without delete sharing) is written on, and tried again only after another `max_bytes`. A log that
/// stops is worse than one that grows.
pub struct Rotating {
    path: PathBuf,
    limits: Limits,
    file: Option<File>,
    len: u64,
}

impl Rotating {
    pub fn open(path: &Path, limits: Limits) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = append(path)?;
        let len = file.metadata()?.len();
        Ok(Self { path: path.to_path_buf(), limits, file: Some(file), len })
    }

    fn rotate(&mut self) {
        // Closed first: Windows renames a file only when every handle to it allows that.
        self.file = None;
        shift(&self.path, self.limits.keep);
        let renamed = std::fs::rename(&self.path, numbered(&self.path, 1));
        self.file = append(&self.path).ok();
        self.len = 0;
        if let (Err(e), Some(f)) = (renamed, self.file.as_mut()) {
            // Said in the log itself: `tracing` cannot be called from inside its own writer.
            let _ = writeln!(f, "this log could not start over ({e}); it grows until it can");
        }
    }
}

impl Write for Rotating {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // A whole event per write (the formatter writes each line at once), so a line is never
        // split across two files. A single line larger than the limit goes where it is.
        if self.len > 0 && self.len + buf.len() as u64 > self.limits.max_bytes {
            self.rotate();
        }
        match self.file.as_mut() {
            Some(f) => {
                let n = f.write(buf)?;
                self.len += n as u64;
                Ok(n)
            }
            // Nowhere to write after a failed reopen: dropped, never an error to the caller. The next
            // rotation tries to open it again.
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), |f| f.flush())
    }
}

/// A log another process holds open in append mode (a child's stdout and stderr): once past
/// `max_bytes`, copied to `.1` (the older ones shifted) and emptied in place. `Ok(false)` when it
/// was not past it, or is not there.
///
/// ⚠ Emptied, never replaced or renamed: the child's handle is to THIS file. ⚠ Copied through a
/// plain read, not the OS's file copy: on Windows that may ask for sharing a file open for writing
/// does not give, and std's own open shares read, write and delete.
pub fn rotate_held(path: &Path, limits: Limits) -> io::Result<bool> {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if len <= limits.max_bytes {
        return Ok(false);
    }
    shift(path, limits.keep);
    {
        let mut from = File::open(path)?;
        let mut to = File::create(numbered(path, 1))?;
        io::copy(&mut from, &mut to)?;
        to.flush()?;
    }
    OpenOptions::new().write(true).open(path)?.set_len(0)?;
    Ok(true)
}

/// Whether `name` is one of mongod's own rotated logs of `log`: `mongod.log.2026-11-09T15-04-05`
/// (`logRotate`'s rename). Anything else in the folder is never touched.
fn is_rotated_mongod(name: &str, log: &str) -> bool {
    let Some(stamp) = name.strip_prefix(log).and_then(|r| r.strip_prefix('.')) else { return false };
    let b = stamp.as_bytes();
    // YYYY-MM-DDTHH-MM-SS, and anything mongod adds after it (a counter, on the same second).
    b.len() >= 19
        && b[..19].iter().enumerate().all(|(i, c)| match i {
            4 | 7 | 13 | 16 => *c == b'-',
            10 => *c == b'T',
            _ => c.is_ascii_digit(),
        })
}

/// Delete mongod's rotated logs of `log` but the newest `keep` (their names sort by time).
pub fn prune_mongod(log: &Path, keep: usize) -> io::Result<usize> {
    let (Some(dir), Some(base)) = (log.parent(), log.file_name().and_then(|n| n.to_str())) else { return Ok(0) };
    let mut rotated: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| is_rotated_mongod(n, base))
        .collect();
    rotated.sort();
    let gone = rotated.len().saturating_sub(keep);
    for name in &rotated[..gone] {
        std::fs::remove_file(dir.join(name))?;
    }
    Ok(gone)
}

fn len(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}

/// Keep the children's logs (`held`) and mongod's (`mongod`, when the supervisor runs it) within
/// `limits`, every `every`, for as long as the supervisor runs.
pub async fn run(held: Vec<PathBuf>, mongod: Option<crate::mongod::Plan>, limits: Limits, every: Duration) {
    loop {
        for path in &held {
            // Files, possibly large ones the first time (a log from before this release): off the
            // runtime's threads.
            let p = path.clone();
            match tokio::task::spawn_blocking(move || rotate_held(&p, limits)).await {
                Ok(Ok(true)) => tracing::info!(log = %path.display(), "the log started over; the old one is beside it as .1"),
                Ok(Ok(false)) => {}
                Ok(Err(e)) => tracing::warn!(log = %path.display(), error = %e, "the log could not start over: it grows until it can"),
                Err(e) => tracing::warn!(log = %path.display(), error = %e, "the log's rotation did not finish"),
            }
        }
        if let Some(plan) = &mongod {
            if len(&plan.log) > limits.max_bytes {
                match crate::mongod::rotate_log(plan).await {
                    Ok(()) => tracing::info!(log = %plan.log.display(), "mongod started its log over"),
                    Err(e) => tracing::warn!(log = %plan.log.display(), error = %format!("{e:#}"), "mongod's log could not start over: it grows until it can"),
                }
            }
            let log = plan.log.clone();
            match tokio::task::spawn_blocking(move || prune_mongod(&log, limits.keep)).await {
                Ok(Ok(0)) => {}
                Ok(Ok(n)) => tracing::info!(deleted = n, "mongod's oldest logs deleted"),
                Ok(Err(e)) => tracing::warn!(error = %e, "mongod's old logs could not be deleted"),
                Err(_) => {}
            }
        }
        tokio::time::sleep(every).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: Limits = Limits { max_bytes: 100, keep: 3 };

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn the_supervisors_log_starts_over_past_its_limit_and_keeps_its_last_few() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("logs").join("lgr-server.log");
        let mut w = Rotating::open(&log, SMALL).unwrap();
        // Lines of 39 bytes: two fit in 100, the third starts a new file.
        let line = |i: usize| format!("line {i:02} {}\n", ".".repeat(30));
        for i in 0..20 {
            w.write_all(line(i).as_bytes()).unwrap();
        }
        w.flush().unwrap();
        assert!(read(&log).len() <= 100, "the current log stays within its limit: {}", read(&log).len());
        assert!(read(&log).contains("line 19"), "the newest line is in the current log");
        assert!(read(&numbered(&log, 1)).contains("line 17"), "the newest older one is .1");
        assert!(numbered(&log, 3).exists());
        assert!(!numbered(&log, 4).exists(), "no more than `keep` older ones");
        // Every line is whole, in one file, and none is lost from the kept ones.
        for f in [log.clone(), numbered(&log, 1), numbered(&log, 2), numbered(&log, 3)] {
            assert!(read(&f).lines().all(|l| l.starts_with("line ") && l.len() + 1 == line(0).len()), "{f:?}: {}", read(&f));
            assert_eq!(read(&f).lines().count(), 2, "{f:?}: two lines a file");
        }
    }

    #[test]
    fn a_line_larger_than_the_limit_is_written_and_nothing_loops() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("lgr-server.log");
        let mut w = Rotating::open(&log, SMALL).unwrap();
        let big = "x".repeat(500);
        w.write_all(big.as_bytes()).unwrap();
        w.write_all(b"after\n").unwrap();
        assert_eq!(read(&numbered(&log, 1)), big);
        assert_eq!(read(&log), "after\n");
    }

    #[test]
    fn a_log_from_before_this_release_starts_over_at_its_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("lgr-server.log");
        std::fs::write(&log, "y".repeat(1000)).unwrap();
        let mut w = Rotating::open(&log, SMALL).unwrap();
        w.write_all(b"first\n").unwrap();
        assert_eq!(read(&numbered(&log, 1)).len(), 1000, "kept whole, once");
        assert_eq!(read(&log), "first\n");
    }

    /// The child's side, as `child::spawn` gives it: a handle in append mode, held across the
    /// rotation. ⚠ What this proves is the OS's: after the file is emptied under it, the child's next
    /// write lands at the new end, not at its old offset (which would leave the file a hole of zeros
    /// as long as the old log).
    #[test]
    fn a_childs_log_is_copied_and_emptied_under_the_childs_own_handle() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("api.log");
        let mut child = OpenOptions::new().create(true).append(true).open(&log).unwrap();
        let old = "old line ......................................\n".repeat(4);
        child.write_all(old.as_bytes()).unwrap();
        child.flush().unwrap();

        assert!(rotate_held(&log, SMALL).unwrap(), "past its limit: rotated");
        assert_eq!(read(&numbered(&log, 1)), old, "the copy is the old log, whole");
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0, "emptied in place");

        child.write_all(b"new line\n").unwrap();
        child.flush().unwrap();
        let bytes = std::fs::read(&log).unwrap();
        assert_eq!(bytes, b"new line\n", "the child's next line is at the start, with no zeros before it");
    }

    #[test]
    fn a_childs_log_within_its_limit_or_not_there_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("api.log");
        assert!(!rotate_held(&log, SMALL).unwrap(), "not there");
        std::fs::write(&log, "short\n").unwrap();
        assert!(!rotate_held(&log, SMALL).unwrap());
        assert_eq!(read(&log), "short\n");
        assert!(!numbered(&log, 1).exists());
    }

    #[test]
    fn a_childs_older_logs_shift_and_the_oldest_goes() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("api.log");
        for round in 1..=5 {
            std::fs::write(&log, format!("{round}").repeat(150)).unwrap();
            assert!(rotate_held(&log, SMALL).unwrap());
        }
        assert!(read(&numbered(&log, 1)).starts_with('5'));
        assert!(read(&numbered(&log, 3)).starts_with('3'));
        assert!(!numbered(&log, 4).exists(), "rounds 1 and 2 are gone: three are kept");
    }

    #[test]
    fn only_mongods_own_rotated_logs_are_pruned_the_newest_kept() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("mongod.log");
        let stamps = ["2026-11-01T00-00-01", "2026-11-02T00-00-01", "2026-11-03T00-00-01", "2026-11-04T00-00-01", "2026-11-04T00-00-01.1"];
        for s in stamps {
            std::fs::write(dir.path().join(format!("mongod.log.{s}")), s).unwrap();
        }
        for other in ["mongod.log", "mongod.console.log", "mongod.console.log.1", "api.log.1", "mongod.log.old", "mongod.log.2026-11-0"] {
            std::fs::write(dir.path().join(other), "keep me").unwrap();
        }
        assert_eq!(prune_mongod(&log, 2).unwrap(), 3);
        let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(
            left,
            [
                "api.log.1",
                "mongod.console.log",
                "mongod.console.log.1",
                "mongod.log",
                "mongod.log.2026-11-0",
                "mongod.log.2026-11-04T00-00-01",
                "mongod.log.2026-11-04T00-00-01.1",
                "mongod.log.old",
            ]
        );
        assert_eq!(prune_mongod(&log, 2).unwrap(), 0, "nothing more to delete");
    }

    #[test]
    fn the_operator_may_set_the_limits_within_reason() {
        let op = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();
        assert_eq!(Limits::from_operator(&op(&[])), (Limits::default(), vec![]));
        let (l, wrong) = Limits::from_operator(&op(&[("LOG_MAX_MB", "1"), ("LOG_KEEP", "2")]));
        assert_eq!((l, wrong.len()), (Limits { max_bytes: 1 << 20, keep: 2 }, 0));
        for bad in ["0", "2000", "ten", "-5"] {
            let (l, wrong) = Limits::from_operator(&op(&[("LOG_MAX_MB", bad), ("LOG_KEEP", bad)]));
            assert_eq!(l, Limits::default(), "{bad} keeps the defaults");
            assert_eq!(wrong.len(), 2, "{bad}: both said");
        }
    }
}
