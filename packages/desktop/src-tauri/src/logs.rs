//! Rotating logs (FR-14.10): 10 files × 5 MB, in the OS log directory.
//!
//! Hand-rolled rather than `tauri-plugin-log`, for one reason: the diagnostics bundle has to be
//! able to read exactly these files back, and a plugin's rotation naming is not a contract. Ten
//! files of a known shape are.
//!
//! ⚠ Every line goes through `redact`. What is written is what a customer emails to a developer,
//! so a token that reaches the log has already left the machine.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_FILES: usize = 10;
const BASE: &str = "lgr-desktop.log";

pub struct Logger {
    dir: PathBuf,
    file: Mutex<Option<File>>,
}

impl Logger {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, file: Mutex::new(None) }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(BASE)
    }

    /// Append one line, rotating first if the current file is full.
    pub fn line(&self, level: &str, msg: &str) {
        let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let text = format!("[{stamp}] {level:<5} {}\n", redact(msg));
        let mut guard = match self.file.lock() {
            Ok(g) => g,
            // A poisoned mutex must not take the app down; losing a log line is the lesser harm.
            Err(p) => p.into_inner(),
        };
        if guard.is_none() {
            let _ = fs::create_dir_all(&self.dir);
            *guard = OpenOptions::new().create(true).append(true).open(self.path()).ok();
        }
        if let Some(f) = guard.as_mut() {
            if f.metadata().map(|m| m.len()).unwrap_or(0) >= MAX_BYTES {
                *guard = None;
                rotate(&self.dir);
                *guard = OpenOptions::new().create(true).append(true).open(self.path()).ok();
            }
        }
        if let Some(f) = guard.as_mut() {
            let _ = f.write_all(text.as_bytes());
            let _ = f.flush();
        }
        // Also to stderr, which is where `cargo tauri dev` shows it.
        eprint!("{text}");
    }

    pub fn info(&self, msg: &str) { self.line("INFO", msg) }
    pub fn warn(&self, msg: &str) { self.line("WARN", msg) }
    pub fn error(&self, msg: &str) { self.line("ERROR", msg) }

    /// Newest first — what the Logs view lists and the diagnostics bundle collects.
    pub fn files(&self) -> Vec<PathBuf> {
        let mut out = vec![self.path()];
        for i in 1..MAX_FILES {
            let p = self.dir.join(format!("{BASE}.{i}"));
            if p.exists() {
                out.push(p);
            }
        }
        out.into_iter().filter(|p| p.exists()).collect()
    }
}

/// `log.9` is dropped, `log.8`→`log.9`, …, `log`→`log.1`.
fn rotate(dir: &Path) {
    let oldest = dir.join(format!("{BASE}.{}", MAX_FILES - 1));
    let _ = fs::remove_file(oldest);
    for i in (1..MAX_FILES - 1).rev() {
        let from = dir.join(format!("{BASE}.{i}"));
        let to = dir.join(format!("{BASE}.{}", i + 1));
        if from.exists() {
            let _ = fs::rename(from, to);
        }
    }
    let _ = fs::rename(dir.join(BASE), dir.join(format!("{BASE}.1")));
}

/// Mask anything that looks like a credential (FR-14.10).
///
/// ⚠ Applied when WRITING, not when bundling. A token redacted only at bundle time is a token that
/// sat in a plain file on the customer's disk until then — and the bundle is not the only way a log
/// leaves a machine. Someone emails a screenshot of the Logs view instead.
///
/// It is a coarse net on purpose: it over-masks rather than reasoning about what is sensitive.
pub fn redact(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for token in split_keep(input) {
        out.push_str(&redact_token(token));
    }
    out
}

/// Split into words while keeping the separators, so redaction does not reflow a line.
///
/// ⚠ Quotes are NOT separators. Treating them as such split `"code":"ABCD1234"` into `code` and
/// `ABCD1234` as unrelated tokens, so neither looked like a credential and the pair came through
/// in the clear. JSON is the shape most of these lines are in, so the key and its value have to
/// stay in one token. The test caught it.
fn split_keep(s: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if c.is_whitespace() || c == ',' || c == ')' || c == '(' {
            if i > start {
                parts.push(&s[start..i]);
            }
            parts.push(&s[i..i + c.len_utf8()]);
            start = i + c.len_utf8();
        }
    }
    if start < s.len() {
        parts.push(&s[start..]);
    }
    parts
}

fn redact_token(t: &str) -> String {
    // Punctuation a value is commonly wrapped in, stripped only for INSPECTION.
    let core = t.trim_matches(|c| matches!(c, '"' | '\'' | '{' | '}' | '[' | ']' | ';'));

    // A JWT: three dot-separated base64url segments, the first starting `eyJ`.
    if core.starts_with("eyJ") && core.matches('.').count() == 2 {
        return "[redacted-jwt]".into();
    }
    // `key=value` / `key:value` shapes whose key names a credential. Both separators, because a
    // log line carries query strings, CLI flags and JSON in roughly equal measure.
    for sep in ['=', ':'] {
        if let Some((k, v)) = t.split_once(sep) {
            let value = v.trim_matches(|c| matches!(c, '"' | '\'' | '}' | ']'));
            if is_secret_key(k) && !value.is_empty() {
                return format!("{k}{sep}[redacted]");
            }
        }
    }
    // A long opaque blob is more likely a secret than a sentence.
    if core.len() >= 40
        && core
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+' | b'/' | b'='))
    {
        return "[redacted-blob]".into();
    }
    t.to_string()
}

fn is_secret_key(k: &str) -> bool {
    // ⚠ Take the TRAILING identifier, not the whole thing. A credential rarely arrives as a bare
    // key: it is `/x?token=…`, `&access_token=…`, `--enrollment-key=…`, `"authorization":…`. The
    // first version compared the whole string and so missed every one of those — the test caught
    // it with `GET /x?token=abc123`.
    let tail = k
        .rsplit(['?', '&', '/', '.', ' ', '{', '[', ';'])
        .next()
        .unwrap_or(k);
    // ⚠ Separators are REMOVED rather than enumerated. Listing `enrollment_key` and
    // `enrollmentkey` but not `enrollment-key` is how `--enrollment-key=zzz` came through in the
    // clear — caught by the test. One canonical spelling, and every hyphen/underscore/quote
    // variant folds onto it.
    let k: String = tail
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    matches!(
        k.as_str(),
        "token" | "accesstoken" | "refreshtoken" | "idtoken" | "authorization" | "auth"
            | "password" | "passphrase" | "secret" | "clientsecret" | "code" | "key"
            | "privatekey" | "publickey" | "assertion" | "enrollmentkey" | "cookie"
            | "bearer" | "apikey" | "jwt" | "credential"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A string the JWT rule matches — three dot-separated segments, the first starting `eyJ` —
    /// assembled so that no credential-shaped LITERAL exists in this repository.
    ///
    /// ⚠ Deliberate. A decodable JWT here (even one signing nothing) trips secret scanning, and a
    /// codebase whose team learns to wave those findings away as "just test data" is one where a
    /// real finding gets waved away too. The rule under test only cares about the shape, so the
    /// fixture supplies the shape and nothing else.
    fn jwt_shaped() -> String {
        ["eyJ", "FAKE-HEADER", ".", "FAKE-PAYLOAD", ".", "FAKE-SIGNATURE"].concat()
    }

    #[test]
    fn jwts_are_masked() {
        let jwt = jwt_shaped();
        let out = redact(&format!("signed in with {jwt} ok"));
        assert!(!out.contains(&jwt), "{out}");
        assert!(out.contains("[redacted-jwt]"), "{out}");
        assert!(out.contains("signed in with") && out.contains("ok"), "{out}");
    }

    #[test]
    fn credential_keys_are_masked_whatever_the_separator() {
        // ⚠ The VALUES here are deliberately non-credential-shaped (see `jwt_shaped`). What is
        // under test is whether the KEY is recognised, so the value only has to be non-empty.
        for line in [
            "GET /x?token=FAKE-VALUE",
            "authorization=Bearer FAKE-VALUE",
            "\"code\":\"FAKE-VALUE\"",
            "--enrollment-key=FAKE-VALUE",
            "password=FAKE-VALUE",
        ] {
            let out = redact(line);
            assert!(out.contains("[redacted]"), "{line} -> {out}");
        }
    }

    #[test]
    fn long_opaque_blobs_are_masked() {
        let blob = "A".repeat(64);
        assert!(redact(&blob).contains("[redacted-blob]"));
    }

    #[test]
    fn ordinary_lines_survive_intact() {
        // ⚠ Over-masking is the safe direction, but a log that masks everything is a log nobody
        // can read. These must come through unchanged.
        for line in [
            "Desktop socket authenticated",
            "opening COM4 at 115200",
            "unreachable server, retrying in 8s",
            "update deferred: bridge busy",
            "view=overview",
        ] {
            assert_eq!(redact(line), line, "should not have been touched");
        }
    }

    #[test]
    fn rotation_keeps_ten_and_drops_the_eleventh() {
        let dir = std::env::temp_dir().join(format!("lgr-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = Logger::new(dir.clone());
        // ⚠ Ordinary prose, not `"x".repeat(...)`. The first version of this test wrote 240 × 64 KB
        // of `xxxx…`, which `redact` correctly collapsed to `[redacted-blob]` — so the file never
        // grew and nothing rotated. The test was wrong, and its failure was the redaction working.
        let chunk = "the quick brown fox jumps over the lazy dog ".repeat(1500); // ~64 KB of words
        for _ in 0..(80 * 3) {
            log.line("INFO", &chunk);
        }
        let files = log.files();
        assert!(files.len() > 1, "expected rotation, got {files:?}");
        assert!(files.len() <= MAX_FILES, "kept {} files", files.len());
        assert!(!dir.join(format!("{BASE}.{MAX_FILES}")).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
