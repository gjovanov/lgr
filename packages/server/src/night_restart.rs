//! The night restart (gjovanov/lgr#370): a library the server runs on was replaced, and the server
//! restarts itself in its maintenance window, so the fix takes effect without a restart in the
//! middle of a sale.
//!
//! On Ubuntu, unattended-upgrades installs security updates every morning, and needrestart restarts
//! every service still running the replaced code. The .deb tells it never to restart this one
//! (`/etc/needrestart/conf.d/lgr-server.conf`), so the supervisor looks for itself:
//! - **What:** an executable mapping of a deleted file under `/usr`, `/lib` or `/lib64` (dpkg renames
//!   a new library over the old one), in the supervisor or any process under it: the API, mongod,
//!   Chrome. The server's own `/opt/lgr-server` tree never changes under a running version, and data
//!   files (the locale archive, fonts) are not code.
//! - **When:** inside `UPDATE_WINDOW` (22:00–06:00 by default, the machine's own clock and zone), with
//!   no till session open and no fiscal command in flight by the API's own account (the update gate's
//!   rule), not while the update helper watches a switch or an update installs, and once a night at
//!   most.
//! - **How:** with no privilege, because the unit runs as `lgr`, which may not ask systemd for a
//!   restart. The children stop exactly as a service stop stops them (the API finishes a receipt in
//!   flight), and the supervisor re-executes ITSELF, in place: `/proc/self/exe`, the version that
//!   runs. The main PID stays, so systemd sees no restart and the update helper's crash count
//!   (`NRestarts`, #369) never moves.
//!   - ⚠ Never `current`. A version a package switched to runs from the service's next START, where
//!     the update helper (pulled in by the unit's `Wants=`) watches it; re-executed into, it would
//!     run unwatched.
//! - `NIGHT_RESTART=off` (`config/api.env`) turns it off. The status still says what waits.

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::collections::BTreeMap;

/// What `run_supervisor_blocking` returns when the supervisor stopped to start again in place.
/// Never an exit code (it is negative): the caller re-executes ([`run_or_reexec`]).
pub const REEXEC: i32 = -2;

/// Where the libraries a security update replaces live.
pub const SYSTEM_LIBRARIES: [&str; 3] = ["/usr/", "/lib/", "/lib64/"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    /// `NIGHT_RESTART`, on unless the operator turned it off.
    pub enabled: bool,
    /// `UPDATE_WINDOW`: minutes since local midnight, [start, end), wrapping when end <= start.
    pub window: (u32, u32),
}

impl Settings {
    pub fn from_operator(operator: &BTreeMap<String, String>) -> anyhow::Result<Self> {
        let enabled = match operator.get("NIGHT_RESTART").map(|v| v.trim().to_ascii_lowercase()) {
            None => true,
            Some(v) if ["on", "true", "1", "yes", ""].contains(&v.as_str()) => true,
            Some(v) if ["off", "false", "0", "no"].contains(&v.as_str()) => false,
            Some(v) => anyhow::bail!("NIGHT_RESTART={v} is neither on nor off"),
        };
        Ok(Self { enabled, window: crate::updates::window_from_operator(operator)? })
    }
}

/// `22:00-06:00`.
pub fn window_text((start, end): (u32, u32)) -> String {
    format!("{:02}:{:02}-{:02}:{:02}", start / 60, start % 60, end / 60, end % 60)
}

/// The libraries one process's `/proc/<pid>/maps` shows replaced: executable mappings of a deleted
/// file under one of `prefixes`. Sorted, each once.
pub fn stale_in_maps(maps: &str, prefixes: &[&str]) -> Vec<String> {
    let mut found: Vec<String> = maps
        .lines()
        .filter_map(|line| {
            // address, perms, offset, device, inode, then the path, which may hold spaces.
            let mut rest = line;
            let mut fields = [""; 5];
            for field in fields.iter_mut() {
                rest = rest.trim_start();
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                *field = &rest[..end];
                rest = &rest[end..];
            }
            let path = rest.trim_start().strip_suffix(" (deleted)")?;
            (fields[1].contains('x') && prefixes.iter().any(|p| path.starts_with(p))).then(|| path.to_string())
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

/// `(pid, ppid)` from a `/proc/<pid>/stat` line. The command name may hold spaces and parentheses:
/// it ends at the LAST `)`.
pub fn parse_stat(stat: &str) -> Option<(u32, u32)> {
    let pid = stat[..stat.find(" (")?].trim().parse().ok()?;
    let mut after = stat[stat.rfind(')')? + 1..].split_whitespace();
    let _state = after.next()?;
    Some((pid, after.next()?.parse().ok()?))
}

/// `root` and every process under it, from every process's `(pid, ppid)`.
pub fn descendants(processes: &[(u32, u32)], root: u32) -> Vec<u32> {
    let mut tree = vec![root];
    let mut next = 0;
    while next < tree.len() {
        let parent = tree[next];
        for &(pid, ppid) in processes {
            if ppid == parent && !tree.contains(&pid) {
                tree.push(pid);
            }
        }
        next += 1;
    }
    tree
}

/// What a look decides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Nothing was replaced.
    Nothing,
    /// Something was, and the restart waits: why, for the status.
    Wait(String),
    /// Now: stop the children and start again in place.
    Restart,
}

/// What a look knows.
pub struct Facts<'a> {
    pub settings: Settings,
    /// The replaced libraries.
    pub stale: &'a [String],
    /// The night the window is in now (the date it began), if it is open.
    pub tonight: Option<&'a str>,
    /// The night the last restart for libraries was taken in.
    pub last_night: Option<&'a str>,
    /// The version the update helper watches (`attempting`), if any.
    pub watching: Option<&'a str>,
    /// The update gate opened tonight: the helper's switch restarts the service anyway.
    pub update_installing: bool,
    /// `/proc/self/exe` was removed: there is nothing to re-execute.
    pub binary_gone: bool,
    /// By the API's own account; `None` when it cannot say.
    pub pos_open: Option<u64>,
    pub fiscal_in_flight: Option<u64>,
}

pub fn decide(f: &Facts) -> Decision {
    if f.stale.is_empty() {
        return Decision::Nothing;
    }
    let wait = |why: &str| Decision::Wait(why.to_string());
    if !f.settings.enabled {
        return wait("NIGHT_RESTART=off: restart the service to run the new libraries");
    }
    let Some(tonight) = f.tonight else {
        return Decision::Wait(format!("waits for the maintenance window, {}", window_text(f.settings.window)));
    };
    if f.last_night == Some(tonight) {
        return wait("restarted for libraries tonight already: waits for the next night");
    }
    if let Some(v) = f.watching {
        return Decision::Wait(format!("waits while the update helper watches the switch to {v}"));
    }
    if f.update_installing {
        return wait("waits: an update installs tonight, and its restart runs the new libraries");
    }
    if f.binary_gone {
        return wait("waits: the running version's files were removed, so the service's next start runs the new libraries");
    }
    match f.pos_open {
        None => return wait("waits: the API cannot say whether a till is open"),
        Some(n) if n > 0 => return Decision::Wait(format!("waits: {n} POS session(s) open")),
        _ => {}
    }
    match f.fiscal_in_flight {
        None => wait("waits: the API cannot say whether a fiscal command is in flight"),
        Some(n) if n > 0 => wait("waits: a fiscal command is in flight"),
        _ => Decision::Restart,
    }
}

/// The last restart for libraries (`state/night-restart.json`), written before it is taken: once a
/// night, whatever the next start finds.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Last {
    /// The night it was taken in: the date the window began.
    pub night: String,
    /// RFC 3339, UTC.
    pub at: String,
    pub libraries: Vec<String>,
}

/// Run the supervisor (`run`), and when it stopped to start again in place, re-execute it. Returns
/// the code to exit with otherwise.
pub fn run_or_reexec(mut run: impl FnMut() -> i32) -> i32 {
    loop {
        let code = run();
        if code != REEXEC {
            return code;
        }
        #[cfg(target_os = "linux")]
        {
            let e = linux::reexec();
            // Only if exec failed: the supervisor starts again in this process instead. Its children
            // are fresh; it keeps its own old libraries until the service's next start.
            tracing::error!(error = %e, "the supervisor could not re-execute itself: it starts again in this process");
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::run;

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::install::{Root, UpdateState};
    use crate::supervisor::Supervisor;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    /// The first look, once the children have started, and every one after it.
    const FIRST_LOOK: Duration = Duration::from_secs(2 * 60);
    const EVERY: Duration = Duration::from_secs(10 * 60);

    /// What a look found: the replaced libraries, and the processes still running them.
    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    pub struct Found {
        pub libraries: Vec<String>,
        pub processes: Vec<String>,
    }

    /// The replaced libraries `root` and every process under it still run.
    pub fn scan(root: u32, prefixes: &[&str]) -> Found {
        let mut all = vec![];
        if let Ok(dir) = std::fs::read_dir("/proc") {
            for entry in dir.flatten() {
                if !entry.file_name().to_str().is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
                    continue;
                }
                if let Some(p) = std::fs::read_to_string(entry.path().join("stat")).ok().as_deref().and_then(parse_stat) {
                    all.push(p);
                }
            }
        }
        let mut found = Found::default();
        for pid in descendants(&all, root) {
            // Ended meanwhile, or not this account's to read (Chrome's sandbox): skipped.
            let Ok(maps) = std::fs::read_to_string(format!("/proc/{pid}/maps")) else { continue };
            let stale = stale_in_maps(&maps, prefixes);
            if stale.is_empty() {
                continue;
            }
            let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|c| c.trim().to_string()).unwrap_or_else(|_| pid.to_string());
            found.processes.push(name);
            found.libraries.extend(stale);
        }
        for list in [&mut found.libraries, &mut found.processes] {
            list.sort();
            list.dedup();
        }
        found
    }

    /// `/proc/self/exe` names a file that was removed.
    pub fn binary_gone() -> bool {
        std::fs::read_link("/proc/self/exe").is_ok_and(|p| p.to_string_lossy().ends_with(" (deleted)"))
    }

    /// Every descriptor from `first` up, close-on-exec. Rust and tokio open theirs that way already
    /// (the listeners, the control socket); this is for whatever a library opened, so nothing this
    /// process held is still held by the one it becomes.
    pub fn mark_cloexec_from(first: i32) {
        let Ok(dir) = std::fs::read_dir("/proc/self/fd") else { return };
        let fds: Vec<i32> = dir.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).filter(|&fd| fd >= first).collect();
        for fd in fds {
            // SAFETY: fcntl on a descriptor number. One that closed since (the directory's own)
            // answers EBADF, which is ignored.
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                    libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
                }
            }
        }
    }

    /// Become a fresh supervisor: the binary that runs (`/proc/self/exe`, never `current`), with the
    /// same arguments and environment, as the same process. Returns only if exec failed.
    pub fn reexec() -> std::io::Error {
        use std::os::unix::process::CommandExt;
        mark_cloexec_from(3);
        let mut args = std::env::args_os();
        let argv0 = args.next().unwrap_or_else(|| "lgr-server".into());
        std::process::Command::new("/proc/self/exe").arg0(argv0).args(args).exec()
    }

    fn now() -> String {
        time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
    }

    fn read_last(file: &Path) -> Option<Last> {
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok())
    }

    /// The API's tills and fiscal commands, by its own account; `None` when it cannot say in 2 s.
    async fn api_facts(api: Option<(PathBuf, String)>) -> (Option<u64>, Option<u64>) {
        let Some((socket, secret)) = api else { return (None, None) };
        match crate::control::call(&socket, &secret, "GET", "/status", Duration::from_secs(2)).await {
            Ok((200, body)) => {
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                (v["posOpen"].as_u64(), v["fiscalInFlight"].as_u64())
            }
            _ => (None, None),
        }
    }

    /// Look every ten minutes for as long as the supervisor runs, keep the status current, and when
    /// it is time, record the restart and ask the supervisor to start again in place.
    pub async fn run(sup: Arc<Supervisor>, settings: Settings, root: Option<Root>, file: PathBuf) {
        let status = sup.night_restart_status();
        let last = read_last(&file);
        let mut since: Option<String> = None;
        let mut seen: Vec<String> = vec![];
        tokio::time::sleep(FIRST_LOOK).await;
        loop {
            let me = std::process::id();
            let found = tokio::task::spawn_blocking(move || scan(me, &SYSTEM_LIBRARIES)).await.unwrap_or_default();
            let at = now();
            if found.libraries != seen {
                if found.libraries.is_empty() {
                    since = None;
                } else {
                    since.get_or_insert_with(|| at.clone());
                    tracing::warn!(
                        libraries = ?found.libraries,
                        processes = ?found.processes,
                        window = %window_text(settings.window),
                        "libraries this server runs on were replaced: it restarts itself in its maintenance window"
                    );
                }
                seen = found.libraries.clone();
            }
            let tonight = crate::updates::local_now().and_then(|(date, minutes)| crate::updates::window_day(date, minutes, settings.window)).map(|d| d.to_string());
            // The API is asked only when its answer can matter.
            let (pos_open, fiscal_in_flight) = match (&tonight, found.libraries.is_empty()) {
                (Some(_), false) => api_facts(sup.api_control()).await,
                _ => (None, None),
            };
            let watching = root.as_ref().and_then(|r| UpdateState::load(r).ok()).and_then(|s| s.attempting).map(|a| a.version);
            let decision = decide(&Facts {
                settings,
                stale: &found.libraries,
                tonight: tonight.as_deref(),
                last_night: last.as_ref().map(|l| l.night.as_str()),
                watching: watching.as_deref(),
                update_installing: sup.status()["update"]["state"] == "installing",
                binary_gone: binary_gone(),
                pos_open,
                fiscal_in_flight,
            });
            *status.lock().unwrap_or_else(|p| p.into_inner()) = serde_json::json!({
                "enabled": settings.enabled,
                "window": window_text(settings.window),
                "pending": !found.libraries.is_empty(),
                "libraries": found.libraries,
                "processes": found.processes,
                "since": since,
                "waiting": match &decision {
                    Decision::Wait(why) => Some(why.as_str()),
                    Decision::Restart => Some("restarting now"),
                    Decision::Nothing => None,
                },
                "last": last,
                "checkedAt": at,
            });
            if decision == Decision::Restart {
                let record = Last { night: tonight.unwrap_or_default(), at, libraries: found.libraries.clone() };
                // Recorded first, so a restart that finds the same libraries again cannot repeat tonight.
                let recorded = serde_json::to_vec_pretty(&record).map_err(anyhow::Error::from).and_then(|bytes| crate::config::write_durable(&file, &bytes, 0o644));
                match recorded {
                    Err(e) => tracing::error!(error = %format!("{e:#}"), file = %file.display(), "the night restart could not be recorded, so it is not taken"),
                    Ok(()) => {
                        tracing::warn!(
                            libraries = ?record.libraries,
                            processes = ?found.processes,
                            "restarting in place for the replaced libraries: the children stop as on a service stop, and the supervisor starts again as the same process"
                        );
                        sup.request_reexec();
                        return;
                    }
                }
            }
            tokio::time::sleep(EVERY).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn stale_libraries_are_deleted_code_under_the_system_trees() {
        let maps = "\
55d0c0a00000-55d0c0a28000 r--p 00000000 08:01 1311                       /opt/lgr-server/versions/0.1.4/mongod/bin/mongod
55d0c0a28000-55d0c3a28000 r-xp 00028000 08:01 1311                       /opt/lgr-server/versions/0.1.4/mongod/bin/mongod (deleted)
7f2c3a000000-7f2c3a028000 r--p 00000000 08:01 1835153                    /usr/lib/x86_64-linux-gnu/libssl.so.3 (deleted)
7f2c3a028000-7f2c3a1c2000 r-xp 00028000 08:01 1835153                    /usr/lib/x86_64-linux-gnu/libssl.so.3 (deleted)
7f2c3a1c2000-7f2c3a21a000 r--p 001c2000 08:01 1835153                    /usr/lib/x86_64-linux-gnu/libssl.so.3 (deleted)
7f2c3b028000-7f2c3b1c2000 r-xp 00028000 08:01 1835160                    /usr/lib/x86_64-linux-gnu/libc.so.6
7f2c3c000000-7f2c3c100000 r--p 00000000 08:01 1835170                    /usr/lib/locale/locale-archive (deleted)
7f2c3d000000-7f2c3d001000 r-xp 00000000 00:01 2048                       /memfd:jit (deleted)
7f2c3e000000-7f2c3e001000 rw-s 00000000 00:19 4096                       /dev/shm/x (deleted)
7f2c3f028000-7f2c3f1c2000 r-xp 00028000 08:01 1835199                    /lib64/ld-linux-x86-64.so.2 (deleted)
7f2c40028000-7f2c401c2000 r-xp 00028000 08:01 1835200                    /usr/lib/x86_64-linux-gnu/odd name.so (deleted)
7f2c41000000-7f2c41021000 rw-p 00000000 00:00 0                          [heap]
7ffd12345000-7ffd12347000 r-xp 00000000 00:00 0                          [vdso]
7f2c42000000-7f2c42001000 ---p 00000000 00:00 0
";
        assert_eq!(
            stale_in_maps(maps, &SYSTEM_LIBRARIES),
            vec!["/lib64/ld-linux-x86-64.so.2", "/usr/lib/x86_64-linux-gnu/libssl.so.3", "/usr/lib/x86_64-linux-gnu/odd name.so"],
            "code only (not the locale archive), each library once, never the server's own tree, memfd or shm"
        );
        assert!(stale_in_maps("", &SYSTEM_LIBRARIES).is_empty());
        assert!(stale_in_maps("garbage\n\n   \n", &SYSTEM_LIBRARIES).is_empty());
    }

    #[test]
    fn a_stat_line_is_read_past_any_command_name() {
        assert_eq!(parse_stat("1234 (bun) S 1 1234 1234 0 -1 4194560 2337"), Some((1234, 1)));
        assert_eq!(parse_stat("77 (my (odd) name) R 76 77 77 0"), Some((77, 76)));
        assert_eq!(parse_stat("88 (a) b) S 5 88"), Some((88, 5)), "a command name ending in ') ' is still read to its last ')'");
        assert_eq!(parse_stat("not a stat line"), None);
        assert_eq!(parse_stat("12 (x)"), None);
    }

    #[test]
    fn the_server_is_its_supervisor_and_everything_under_it() {
        let all = [(1, 0), (100, 1), (101, 100), (102, 100), (103, 101), (200, 1), (201, 200), (300, 103)];
        let mut tree = descendants(&all, 100);
        tree.sort();
        assert_eq!(tree, vec![100, 101, 102, 103, 300], "children and grandchildren (Chrome under the API), never a neighbour");
        assert_eq!(descendants(&[], 42), vec![42]);
    }

    #[test]
    fn settings_reuse_the_update_window_and_refuse_nonsense() {
        assert_eq!(Settings::from_operator(&op(&[])).unwrap(), Settings { enabled: true, window: (22 * 60, 6 * 60) });
        assert_eq!(
            Settings::from_operator(&op(&[("NIGHT_RESTART", "off"), ("UPDATE_WINDOW", "01:30-04:00")])).unwrap(),
            Settings { enabled: false, window: (90, 240) }
        );
        assert!(Settings::from_operator(&op(&[("NIGHT_RESTART", " On ")])).unwrap().enabled);
        assert!(Settings::from_operator(&op(&[("NIGHT_RESTART", "sometimes")])).is_err());
        assert!(Settings::from_operator(&op(&[("UPDATE_WINDOW", "22:00")])).is_err());
        assert_eq!(window_text((22 * 60, 6 * 60)), "22:00-06:00");
        assert_eq!(window_text((90, 1439)), "01:30-23:59");
    }

    fn facts(stale: &[String]) -> Facts<'_> {
        Facts {
            settings: Settings { enabled: true, window: (22 * 60, 6 * 60) },
            stale,
            tonight: Some("2026-10-29"),
            last_night: Some("2026-10-28"),
            watching: None,
            update_installing: false,
            binary_gone: false,
            pos_open: Some(0),
            fiscal_in_flight: Some(0),
        }
    }

    #[test]
    fn it_restarts_only_at_night_with_every_till_closed_and_once() {
        let libs = vec!["/usr/lib/x86_64-linux-gnu/libssl.so.3".to_string()];
        assert_eq!(decide(&facts(&libs)), Decision::Restart);
        assert_eq!(decide(&facts(&[])), Decision::Nothing, "nothing replaced, nothing to do, whatever the hour");
        let waits = [
            (Facts { settings: Settings { enabled: false, window: (22 * 60, 6 * 60) }, ..facts(&libs) }, "NIGHT_RESTART=off"),
            (Facts { tonight: None, ..facts(&libs) }, "maintenance window, 22:00-06:00"),
            (Facts { last_night: Some("2026-10-29"), ..facts(&libs) }, "tonight already"),
            (Facts { watching: Some("0.1.5"), ..facts(&libs) }, "watches the switch to 0.1.5"),
            (Facts { update_installing: true, ..facts(&libs) }, "an update installs tonight"),
            (Facts { binary_gone: true, ..facts(&libs) }, "files were removed"),
            (Facts { pos_open: Some(2), ..facts(&libs) }, "2 POS session(s) open"),
            (Facts { pos_open: None, ..facts(&libs) }, "cannot say whether a till is open"),
            (Facts { fiscal_in_flight: Some(1), ..facts(&libs) }, "a fiscal command is in flight"),
            (Facts { fiscal_in_flight: None, ..facts(&libs) }, "cannot say whether a fiscal command"),
        ];
        for (f, why) in waits {
            match decide(&f) {
                Decision::Wait(w) => assert!(w.contains(why), "{w:?} should say {why:?}"),
                other => panic!("{other:?} where it should wait: {why}"),
            }
        }
    }

    #[test]
    fn a_code_other_than_reexec_is_returned_as_it_is() {
        let mut runs = 0;
        assert_eq!(
            run_or_reexec(|| {
                runs += 1;
                crate::backoff::EXIT_CONFIG
            }),
            crate::backoff::EXIT_CONFIG
        );
        assert_eq!(runs, 1);
    }

    #[test]
    fn the_package_tells_needrestart_never_to_restart_the_server() {
        let nfpm = include_str!("../packaging/nfpm.yaml").replace("\r\n", "\n");
        assert!(
            nfpm.contains(
                "  - src: packages/server/packaging/linux/needrestart.conf\n    dst: /etc/needrestart/conf.d/lgr-server.conf\n    type: config|noreplace\n"
            ),
            "the .deb carries the override, as a conffile"
        );
        let conf = include_str!("../packaging/linux/needrestart.conf");
        assert!(conf.lines().any(|l| l == "$nrconf{override_rc}{qr(^lgr-server)} = 0;"));
    }

    /// needrestart reads a conf.d file by `eval`, and matches every unit against each `override_rc`
    /// key as a pattern. Run that on the file, where there is a Perl (CI's Linux runners).
    #[test]
    fn needrestart_reads_the_override_as_meant() {
        const NEEDRESTART: &str = r#"
            my %nrconf;
            my $cfg = do { local $/; <STDIN> };
            eval $cfg;
            die "Error parsing: $@" if ($@);
            sub restarts {
                my $unit = shift;
                foreach my $re (keys %{$nrconf{override_rc}}) {
                    next unless ($unit =~ /$re/);
                    return $nrconf{override_rc}->{$re};
                }
                return 1;
            }
            die "lgr-server.service would be restarted\n" if restarts("lgr-server.service");
            die "lgr-server-update.service would be restarted\n" if restarts("lgr-server-update.service");
            die "postgresql.service would not be restarted\n" unless restarts("postgresql.service");
            die "my-lgr-server.service would not be restarted\n" unless restarts("my-lgr-server.service");
            print "ok\n";
        "#;
        use std::io::Write;
        let child = std::process::Command::new("perl")
            .args(["-e", NEEDRESTART])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let Ok(mut child) = child else {
            eprintln!("no perl here: skipped");
            return;
        };
        child.stdin.take().unwrap().write_all(include_bytes!("../packaging/linux/needrestart.conf")).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }

    #[cfg(target_os = "linux")]
    mod on_linux {
        use super::super::linux::*;

        /// The kernel's own account: a file mapped executable and then deleted reads ` (deleted)` in
        /// `/proc/self/maps`, and the scan finds it under this process.
        #[test]
        fn a_deleted_executable_mapping_is_found_in_this_process() {
            // Beside the test binary: a file system that allows executable mappings (/tmp may not).
            let dir = tempfile::tempdir_in(std::env::current_exe().unwrap().parent().unwrap()).unwrap();
            let lib = dir.path().join("libstale.so");
            std::fs::write(&lib, vec![0u8; 4096]).unwrap();
            let file = std::fs::File::open(&lib).unwrap();
            // SAFETY: a private, read-only and executable mapping of a 4 KiB file this test owns,
            // unmapped below and never touched.
            let mapped = unsafe {
                use std::os::fd::AsRawFd;
                libc::mmap(std::ptr::null_mut(), 4096, libc::PROT_READ | libc::PROT_EXEC, libc::MAP_PRIVATE, file.as_raw_fd(), 0)
            };
            assert_ne!(mapped, libc::MAP_FAILED, "{}", std::io::Error::last_os_error());
            drop(file);
            let prefix = format!("{}/", dir.path().display());
            assert!(scan(std::process::id(), &[&prefix]).libraries.is_empty(), "not replaced yet");
            std::fs::remove_file(&lib).unwrap();
            let found = scan(std::process::id(), &[&prefix]);
            // SAFETY: the mapping made above.
            unsafe { libc::munmap(mapped, 4096) };
            assert_eq!(found.libraries, vec![lib.display().to_string()]);
            // Another test's child, forked and not yet exec'd, may show the mapping too: only this
            // process is certain to.
            let me = std::fs::read_to_string("/proc/self/comm").unwrap().trim().to_string();
            assert!(found.processes.contains(&me), "{me} in {:?}", found.processes);
            assert!(!binary_gone(), "the test binary is where it was");
        }

        /// The real thing, in a child: a process that re-executes itself is the same process (PID),
        /// running the same binary again with the same arguments and its environment.
        #[test]
        fn a_reexec_is_the_same_process_starting_again() {
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "night_restart::tests::on_linux::child_reexecs", "--ignored", "--nocapture", "--test-threads=1"])
                .env("LGR_SERVER_TEST_REEXEC", "1")
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            assert!(out.status.success(), "{text}{}", String::from_utf8_lossy(&out.stderr));
            // The harness prints `test <name> ... ` before a test's own output, on the same line.
            let pid = |stage: &str| text.lines().find_map(|l| l.split(&format!("reexec-{stage} pid=")).nth(1).map(|p| p.trim().to_string()));
            assert!(pid("before").is_some() && pid("after").is_some(), "{text}");
            assert_eq!(pid("before"), pid("after"), "the same process");
        }

        #[test]
        #[ignore = "the child of the re-exec test, not a test"]
        fn child_reexecs() {
            use std::io::Write;
            match std::env::var("LGR_SERVER_TEST_REEXEC").as_deref() {
                Ok("1") => {
                    // What the next image reads: it was re-executed with this process's environment.
                    std::env::set_var("LGR_SERVER_TEST_REEXEC", "2");
                    println!("reexec-before pid={}", std::process::id());
                    std::io::stdout().flush().unwrap();
                    let e = reexec();
                    panic!("exec failed: {e}");
                }
                Ok("2") => println!("reexec-after pid={}", std::process::id()),
                _ => {}
            }
        }

        #[test]
        fn an_inherited_descriptor_is_closed_on_exec() {
            let path = std::ffi::CString::new("/proc/self/stat").unwrap();
            // SAFETY: open and close a descriptor this test owns, without O_CLOEXEC on purpose
            // (Rust's own files always have it).
            let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY) };
            assert!(fd >= 0);
            assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
            mark_cloexec_from(fd);
            assert_ne!(unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
            unsafe { libc::close(fd) };
        }
    }
}
