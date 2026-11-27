//! What the OS is configured to start the server's service with (#965): one variable of its
//! environment, read from the service's own configuration, never from the running service.
//!
//! The update helper runs from a unit of its own, so it never had the CA an administrator names in
//! the server service's environment (`LGR_SERVER_EXTRA_CA`, `https.rs`). Behind a TLS-inspecting
//! middlebox the supervisor then reached global and the helper did not: its calls take the same way
//! out (the supervisor's egress), and their handshake failed on the middlebox's certificate.
//!
//! - **Linux:** `lgr-server.service` as systemd reports it: `Environment=`, drop-ins included, a later
//!   assignment winning, then each `EnvironmentFile=` in order, which systemd lets override it.
//! - **Windows:** the `LGRServer` service's `Environment` value (`REG_MULTI_SZ`), which the service
//!   control manager adds to the service's environment.
//!
//! ⚠ Both are the OS's configuration, which only an administrator writes. The running supervisor is
//! the service account's (its environment, `/proc/<pid>/environ`, anything it answers): whatever it
//! says is never read here.

use anyhow::Result;
#[cfg(target_os = "linux")]
use std::path::Path;

/// A variable's value, and where the configuration names it (for the log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setting {
    pub value: String,
    pub named_by: String,
}

/// What the server's service is configured to start with for `key`, or `None` when its
/// configuration does not name it.
pub fn configured(key: &str) -> Result<Option<Setting>> {
    platform::configured(key)
}

/// The words of a string-list property as `systemctl show` prints it (`Environment=`): separated by
/// spaces, and a word that needs it in double quotes, with `"`, `` ` `` and `$` escaped (systemd 255,
/// measured: `PLAIN=/etc/x.pem "SPACED=/etc/a b.pem" "DOLLAR=a\$b"`). A systemd older than the
/// quoting printed every word bare, which reads the same for a word with no space in it. An entry
/// starts with its variable's name, never with a quote, so a word that starts with one was quoted.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn show_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut chars = value.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let Some(&first) = chars.peek() else { break };
        let mut word = String::new();
        if first == '"' {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    // A backslash before anything else is itself, as in the shell's double quotes.
                    '\\' => match chars.next_if(|n| matches!(n, '"' | '\\' | '`' | '$')) {
                        Some(n) => word.push(n),
                        None => word.push('\\'),
                    },
                    c => word.push(c),
                }
            }
        }
        while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
            word.push(c);
        }
        words.push(word);
    }
    words
}

/// The value the last `key=…` of `entries` gives `key`: a later assignment wins, as in the
/// environment the service starts with. `ignore_case` on Windows, whose variable names are.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
pub fn assigned<'a>(entries: impl IntoIterator<Item = &'a str>, key: &str, ignore_case: bool) -> Option<&'a str> {
    entries
        .into_iter()
        .filter_map(|e| {
            let (k, v) = e.split_once('=')?;
            (if ignore_case { k.eq_ignore_ascii_case(key) } else { k == key }).then_some(v)
        })
        .last()
}

/// The files `systemctl show`'s `EnvironmentFiles=` lines name, in order, each with whether a
/// missing one is ignored (`EnvironmentFile=-…`). systemd 255 prints one line per file,
/// `EnvironmentFiles=/etc/a b.env (ignore_errors=no)`, the path bare.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn environment_files(show: &str) -> Vec<(String, bool)> {
    show.lines()
        .filter_map(|l| l.strip_prefix("EnvironmentFiles="))
        .filter_map(|rest| {
            let (path, flag) = rest.trim_end().rsplit_once(" (ignore_errors=")?;
            Some((path.to_string(), flag == "yes)"))
        })
        .collect()
}

/// The value an environment file's last assignment of `key` gives it, read as systemd reads one: a
/// line `KEY=value`, blank lines and comments (`#`, `;`) skipped, and the value single-quoted
/// (literal), double-quoted (`\"`, `\\`, `` \` `` and `\$` escaped, any other backslash kept) or bare
/// (a backslash escapes the next character, trailing blanks dropped). A value continued on the next
/// line is not read: a path needs none.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn env_file_value(text: &str, key: &str) -> Option<String> {
    let mut found = None;
    for line in text.lines() {
        let line = line.trim_start();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim_end() == key {
            found = Some(env_file_word(v.trim_start()));
        }
    }
    found
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn env_file_word(v: &str) -> String {
    let mut out = String::new();
    let mut chars = v.chars();
    match v.chars().next() {
        Some('\'') => {
            chars.next();
            out.extend(chars.take_while(|&c| c != '\''));
        }
        Some('"') => {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => match chars.next() {
                        Some(n @ ('"' | '\\' | '`' | '$')) => out.push(n),
                        Some(n) => {
                            out.push('\\');
                            out.push(n);
                        }
                        None => {}
                    },
                    c => out.push(c),
                }
            }
        }
        _ => {
            while let Some(c) = chars.next() {
                match c {
                    '\\' => out.extend(chars.next()),
                    c => out.push(c),
                }
            }
            out.truncate(out.trim_end().len());
        }
    }
    out
}

/// The largest environment file read: one larger is not an administrator's few lines.
#[cfg(target_os = "linux")]
const MAX_ENV_FILE: u64 = 1 << 20;

/// What `systemctl show --property=Environment,EnvironmentFiles` of `unit` says the service starts
/// with for `key`: `Environment=` first, then each environment file in order, read by `read`. A file
/// that cannot be read, or a wildcard (which systemd expands and this does not), is skipped with a
/// warning: systemd refuses to start a service whose file is missing unless `-` says it may be.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn from_show(unit: &str, show: &str, key: &str, read: impl Fn(&str) -> std::io::Result<String>) -> Option<Setting> {
    let words = show.lines().find_map(|l| l.strip_prefix("Environment=")).map(show_words).unwrap_or_default();
    let mut found = assigned(words.iter().map(String::as_str), key, false).map(|v| Setting { value: v.to_string(), named_by: format!("{unit}'s Environment=") });
    for (file, optional) in environment_files(show) {
        if file.contains(['*', '?', '[']) {
            tracing::warn!(unit = %unit, file = %file, "an EnvironmentFile= with a wildcard is not read for {key}: name it with Environment= in a drop-in");
            continue;
        }
        match read(&file) {
            Ok(text) => {
                if let Some(v) = env_file_value(&text, key) {
                    found = Some(Setting { value: v, named_by: format!("{unit}'s EnvironmentFile={file}") });
                }
            }
            Err(e) if optional && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!(unit = %unit, file = %file, error = %e, "an EnvironmentFile= could not be read for {key}"),
        }
    }
    found
}

/// An environment file's text, if it is a regular file of an administrator's size.
#[cfg(target_os = "linux")]
fn read_env_file(file: &str) -> std::io::Result<String> {
    use std::io::Read;
    let path = Path::new(file);
    if !std::fs::metadata(path)?.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let mut text = String::new();
    std::fs::File::open(path)?.take(MAX_ENV_FILE).read_to_string(&mut text)?;
    Ok(text)
}

/// The strings of a `REG_MULTI_SZ`: each ends with a NUL, and an empty one ends the list.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn multi_sz(buf: &[u16]) -> Vec<String> {
    buf.split(|&c| c == 0).take_while(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn configured(key: &str) -> Result<Option<Setting>> {
        let unit = crate::pointer::UNIT;
        let show = crate::pointer::systemctl(&["show", unit, "--property=Environment,EnvironmentFiles"])?;
        Ok(from_show(unit, &show, key, read_env_file))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use anyhow::bail;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_LOCAL_MACHINE, RRF_RT_REG_MULTI_SZ};

    pub fn configured(key: &str) -> Result<Option<Setting>> {
        let name = crate::service::NAME;
        let Some(entries) = multi_sz_value(HKEY_LOCAL_MACHINE, &format!(r"SYSTEM\CurrentControlSet\Services\{name}"), "Environment")? else {
            return Ok(None);
        };
        Ok(assigned(entries.iter().map(String::as_str), key, true).map(|v| Setting { value: v.to_string(), named_by: format!("the {name} service's Environment value") }))
    }

    /// A `REG_MULTI_SZ` value's strings, or `None` when the key or the value does not exist.
    pub fn multi_sz_value(root: HKEY, subkey: &str, value: &str) -> Result<Option<Vec<String>>> {
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (subkey_w, value_w) = (wide(subkey), wide(value));
        // The value may grow between asking its size and reading it: asked again, a few times.
        for _ in 0..4 {
            let mut size: u32 = 0;
            // SAFETY: both names are NUL-terminated; a null buffer asks the size only.
            let rc = unsafe { RegGetValueW(root, subkey_w.as_ptr(), value_w.as_ptr(), RRF_RT_REG_MULTI_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
            if rc == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if rc != ERROR_SUCCESS {
                bail!("reading {subkey}\\{value}: Windows error {rc}");
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
            let mut got = u32::try_from(buf.len() * 2)?;
            // SAFETY: `buf` holds `got` bytes, and RegGetValueW writes at most that many.
            let rc = unsafe { RegGetValueW(root, subkey_w.as_ptr(), value_w.as_ptr(), RRF_RT_REG_MULTI_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut got) };
            match rc {
                ERROR_SUCCESS => return Ok(Some(multi_sz(&buf[..(got as usize / 2).min(buf.len())]))),
                ERROR_MORE_DATA => continue,
                ERROR_FILE_NOT_FOUND => return Ok(None),
                rc => bail!("reading {subkey}\\{value}: Windows error {rc}"),
            }
        }
        bail!("reading {subkey}\\{value}: it kept growing while it was read")
    }
}

/// No service configuration to read here: the helper only updates a master systemd or Windows runs.
#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use super::*;

    pub fn configured(_key: &str) -> Result<Option<Setting>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemctl_show_s_words_are_read_quoted_and_bare() {
        // systemd 255's own answer for these assignments (measured).
        let show = r#"PLAIN=/etc/x.pem "SPACED=/etc/a b.pem" "DOLLAR=a\$b" "BS=a\b" EMPTY= "QUOTED=say \"hi\"""#;
        assert_eq!(show_words(show), ["PLAIN=/etc/x.pem", "SPACED=/etc/a b.pem", "DOLLAR=a$b", r"BS=a\b", "EMPTY=", r#"QUOTED=say "hi""#]);
        assert_eq!(show_words(r#""BS=a\\b""#), [r"BS=a\b"], "an escaped backslash is one");
        assert_eq!(show_words("  A=1   B=2  "), ["A=1", "B=2"]);
        assert!(show_words("").is_empty());
    }

    #[test]
    fn the_last_assignment_of_a_variable_wins() {
        let words = show_words("LGR_SERVER_DATA=/var/lib/lgr LGR_SERVER_EXTRA_CA=/etc/a.pem LGR_SERVER_EXTRA_CA_X=/no LGR_SERVER_EXTRA_CA=/etc/b.pem");
        assert_eq!(assigned(words.iter().map(String::as_str), "LGR_SERVER_EXTRA_CA", false), Some("/etc/b.pem"));
        // A prefix of another variable's name is not it, and Linux's names have a case.
        assert_eq!(assigned(["LGR_SERVER_EXTRA_CA_X=/no"], "LGR_SERVER_EXTRA_CA", false), None);
        assert_eq!(assigned(["lgr_server_extra_ca=/etc/a.pem"], "LGR_SERVER_EXTRA_CA", false), None);
        assert_eq!(assigned(["lgr_server_extra_ca=/etc/a.pem"], "LGR_SERVER_EXTRA_CA", true), Some("/etc/a.pem"));
        // Emptied by a later assignment: what the service starts with is the empty value.
        assert_eq!(assigned(["LGR_SERVER_EXTRA_CA=/etc/a.pem", "LGR_SERVER_EXTRA_CA="], "LGR_SERVER_EXTRA_CA", false), Some(""));
    }

    #[test]
    fn environment_files_are_listed_in_order_with_their_dash() {
        // systemd 255's own answer (measured), and the Environment= line beside it.
        let show = "Environment=A=1\nEnvironmentFiles=/etc/nonexistent-lgr.env (ignore_errors=yes)\nEnvironmentFiles=/etc/also missing.env (ignore_errors=no)\n";
        assert_eq!(environment_files(show), [("/etc/nonexistent-lgr.env".to_string(), true), ("/etc/also missing.env".to_string(), false)]);
        assert!(environment_files("Environment=A=1\n").is_empty());
    }

    #[test]
    fn an_environment_file_is_read_as_systemd_reads_one() {
        let text = "# the proxy\n; and its CA\n\nOTHER=x\n  LGR_SERVER_EXTRA_CA = /etc/first.pem\nLGR_SERVER_EXTRA_CA=/etc/ssl/corp-ca.pem   \nnot a line\n";
        assert_eq!(env_file_value(text, "LGR_SERVER_EXTRA_CA").as_deref(), Some("/etc/ssl/corp-ca.pem"));
        assert_eq!(env_file_value("LGR_SERVER_EXTRA_CA=\"/etc/a b.pem\"\n", "LGR_SERVER_EXTRA_CA").as_deref(), Some("/etc/a b.pem"));
        assert_eq!(env_file_value("LGR_SERVER_EXTRA_CA='/etc/a $b.pem'\n", "LGR_SERVER_EXTRA_CA").as_deref(), Some("/etc/a $b.pem"));
        assert_eq!(env_file_value(r#"K="a\"b\\c\d""#, "K").as_deref(), Some(r#"a"b\c\d"#));
        assert_eq!(env_file_value(r"K=a\ b\\c", "K").as_deref(), Some(r"a b\c"));
        assert_eq!(env_file_value("#LGR_SERVER_EXTRA_CA=/etc/commented.pem\n", "LGR_SERVER_EXTRA_CA"), None);
        assert_eq!(env_file_value("LGR_SERVER_EXTRA_CA_X=/no\n", "LGR_SERVER_EXTRA_CA"), None);
        assert_eq!(env_file_value("LGR_SERVER_EXTRA_CA=\n", "LGR_SERVER_EXTRA_CA").as_deref(), Some(""));
    }

    #[test]
    fn the_unit_s_environment_is_read_then_its_files_which_override_it() {
        const KEY: &str = "LGR_SERVER_EXTRA_CA";
        let unit = "lgr-server.service";
        let files = |name: &str| -> std::io::Result<String> {
            match name {
                "/etc/lgr/proxy.env" => Ok("HTTPS_PROXY=x\nLGR_SERVER_EXTRA_CA=/etc/lgr/from-file.pem\n".into()),
                "/etc/lgr/other.env" => Ok("OTHER=1\n".into()),
                _ => Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
            }
        };
        // The lane's drop-in: Environment= alone.
        let show = "Environment=LGR_SERVER_DATA=/var/lib/lgr LGR_SERVER_EXTRA_CA=/etc/lgr-vmtest/global-eph-ca.pem\n";
        assert_eq!(
            from_show(unit, show, KEY, files),
            Some(Setting { value: "/etc/lgr-vmtest/global-eph-ca.pem".into(), named_by: "lgr-server.service's Environment=".into() })
        );
        // The package's unit alone names none.
        assert_eq!(from_show(unit, "Environment=LGR_SERVER_DATA=/var/lib/lgr\n", KEY, files), None);
        // A file that names it overrides Environment=, as systemd's order has it; one that names
        // something else, or is missing with `-`, changes nothing.
        let show = "Environment=LGR_SERVER_EXTRA_CA=/etc/from-unit.pem\nEnvironmentFiles=/etc/lgr/proxy.env (ignore_errors=no)\nEnvironmentFiles=/etc/lgr/other.env (ignore_errors=no)\nEnvironmentFiles=/etc/lgr/gone.env (ignore_errors=yes)\n";
        assert_eq!(
            from_show(unit, show, KEY, files),
            Some(Setting { value: "/etc/lgr/from-file.pem".into(), named_by: "lgr-server.service's EnvironmentFile=/etc/lgr/proxy.env".into() })
        );
        // A wildcard is not expanded, nor read as a name.
        let show = "Environment=LGR_SERVER_EXTRA_CA=/etc/from-unit.pem\nEnvironmentFiles=/etc/lgr/*.env (ignore_errors=no)\n";
        assert_eq!(from_show(unit, show, KEY, |_| panic!("a wildcard is never opened")).map(|s| s.value).as_deref(), Some("/etc/from-unit.pem"));
    }

    #[test]
    fn a_multi_sz_is_read_to_its_empty_string() {
        let w = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        let mut buf = w("A=1\0LGR_SERVER_EXTRA_CA=C:\\ProgramData\\corp-ca.pem\0\0");
        assert_eq!(multi_sz(&buf), ["A=1", r"LGR_SERVER_EXTRA_CA=C:\ProgramData\corp-ca.pem"]);
        // Without its final NUL (a value written carelessly), and empty.
        buf.truncate(buf.len() - 2);
        assert_eq!(multi_sz(&buf).len(), 2);
        assert!(multi_sz(&w("\0")).is_empty());
        assert!(multi_sz(&[]).is_empty());
    }

    /// The registry read itself, on a key of the test's own under the current user's hive.
    #[cfg(windows)]
    #[test]
    fn a_multi_sz_value_is_read_from_the_registry_and_a_missing_one_is_none() {
        use windows_sys::Win32::System::Registry::{RegDeleteTreeW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_MULTI_SZ};
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let subkey = format!(r"Software\lgr-server-test-{}", std::process::id());
        let data = wide("A=1\0LGR_SERVER_EXTRA_CA=C:\\corp ca.pem\0");
        let (k, v) = (wide(&subkey), wide("Environment"));
        // SAFETY: NUL-terminated names; `data` is a REG_MULTI_SZ of `data.len() * 2` bytes.
        let rc = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), v.as_ptr(), REG_MULTI_SZ, data.as_ptr().cast(), u32::try_from(data.len() * 2).unwrap()) };
        assert_eq!(rc, 0, "the test's key could not be written");
        let read = platform::multi_sz_value(HKEY_CURRENT_USER, &subkey, "Environment");
        let missing = platform::multi_sz_value(HKEY_CURRENT_USER, &subkey, "NotThere");
        // SAFETY: a NUL-terminated name, of the test's own key.
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, k.as_ptr()) };
        let entries = read.unwrap().unwrap();
        assert_eq!(assigned(entries.iter().map(String::as_str), "lgr_server_extra_ca", true), Some(r"C:\corp ca.pem"));
        assert_eq!(missing.unwrap(), None);
        assert_eq!(platform::multi_sz_value(HKEY_CURRENT_USER, r"Software\lgr-server-test-no-such-key", "Environment").unwrap(), None);
    }
}
