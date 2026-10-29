//! Which version the service runs, and which the helper runs (FR-20.20, plan step P1-8b): the two
//! pointers of a versioned install, moved only by SYSTEM or root.
//!
//! - **Windows:** the pointers ARE the services' configuration. `LGRServer`'s image is
//!   `versions\<v>\lgr-server.exe service run`; `LGRServerUpdate` (the helper, LocalSystem, delayed
//!   automatic start) runs `versions\<lkg>\lgr-server.exe update-helper`. Moving one is one
//!   `ChangeServiceConfig`. The service account may START the helper and nothing else (its DACL):
//!   it asks for an update, it never names one.
//! - **Linux:** `current` and `lkg` are symlinks under the root, renamed over atomically; the units
//!   the package ships name them (`/opt/lgr-server/current/lgr-server service run`).
//! - **The firewall rule** "LGR Server (LAN)" follows the service's image on Windows (FR-20.92): a
//!   rule naming a program path would otherwise admit the tills to the first version only.

use crate::install::Root;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// What the service is doing, as the OS reports it.
///
/// ⚠ A restart is not a crash. An administrator restarts the service, and on Ubuntu so does
/// needrestart after every library upgrade unattended-upgrades installs (the first update lane
/// saw it three times in a minute and a half, and the helper took a good version back for good).
/// So the helper counts only what the OS says was a crash, never a new process as such.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Observed {
    pub running: bool,
    pub pid: Option<u32>,
    /// Linux: how many times systemd started the service again by itself after its main process
    /// ended (`NRestarts`, the `Restart=` policy at work). A restart someone asks for does not move
    /// it, and an explicit start resets it. `None` where the OS keeps no such count (Windows).
    pub auto_restarts: Option<u32>,
    /// Windows: the service is being stopped in order (STOP_PENDING, or STOPPED with no error),
    /// which makes the next new process one someone asked for. A crash leaves the SCM's error.
    pub stopping: bool,
}

/// `systemctl show`'s answer, read (Linux; here so the tests run on every OS).
///
/// `NRestarts` exists since systemd 235 (2017). An older one leaves it out, and the helper then
/// counts every new process, as it always did: ⚠ never `ActiveState=deactivating` as "stopped in
/// order", which systemd also passes through while it clears a crashed process's children.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn observed_from_show(text: &str) -> Observed {
    let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).unwrap_or("").trim().to_string();
    let pid = get("MainPID").parse::<u32>().ok().filter(|&p| p != 0);
    let running = get("ActiveState") == "active" && get("SubState") == "running";
    Observed { running, pid, auto_restarts: get("NRestarts").parse::<u32>().ok(), stopping: false }
}

/// The service SID Windows gives `NT SERVICE\<name>`: `S-1-5-80-` and the SHA-1 of the upper-case
/// name in UTF-16LE, as five little-endian sub-authorities. Computed, so the helper's DACL can be
/// written whether or not the service exists yet.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn service_sid(name: &str) -> String {
    let utf16: Vec<u8> = name.to_uppercase().encode_utf16().flat_map(u16::to_le_bytes).collect();
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &utf16);
    let subs: Vec<String> = digest.as_ref().chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]).to_string()).collect();
    format!("S-1-5-80-{}", subs.join("-"))
}

/// The helper service's DACL: Windows' default for a service, plus START (and status) for the
/// service account. ⚠ Nothing more: not stop, not configure. The SACL is left as it is.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn helper_sddl(service_sid: &str) -> String {
    format!(
        "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;LCRP;;;{service_sid})"
    )
}

/// The version a service command line runs, if it is one of `root`'s.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn version_in(command_line: &str, root: &Root) -> Option<String> {
    let exe = match command_line.trim().strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => command_line.split_whitespace().next()?,
    };
    let exe = PathBuf::from(exe);
    let dir = exe.parent()?;
    let versions = root.versions();
    let same = |a: &Path, b: &Path| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy());
    (dir.parent().is_some_and(|p| same(p, &versions)) && exe.file_name().is_some_and(|n| n.eq_ignore_ascii_case(crate::install::exe_name())))
        .then(|| dir.file_name().map(|v| v.to_string_lossy().into_owned()))
        .flatten()
}

#[cfg(windows)]
pub use self::windows::*;
#[cfg(unix)]
pub use self::unix::*;

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::OsString;
    use std::time::Duration;
    use windows_service::service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType};
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    pub const HELPER: &str = "LGRServerUpdate";
    pub const HELPER_DISPLAY: &str = "LGR Server Update";
    const HELPER_DESCRIPTION: &str = "Installs LGR Server updates, and switches back to the last version that ran if one fails";
    pub const FIREWALL_RULE: &str = "LGR Server (LAN)";

    fn manager() -> Result<ServiceManager> {
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)
            .context("opening the service manager (as an administrator)")
    }

    /// Point `LGRServer` at `version` (creating it on a first install, with its data directory's ACL).
    pub fn point_service(root: &Root, version: &str, data: &Path, first: bool) -> Result<()> {
        crate::service::platform::install_at(&root.exe_of(version), data, false, first)?;
        firewall(&root.exe_of(version))
    }

    /// Point the helper at `version`, the last known good.
    pub fn point_helper(root: &Root, version: &str) -> Result<()> {
        let m = manager()?;
        let info = ServiceInfo {
            name: OsString::from(HELPER),
            display_name: OsString::from(HELPER_DISPLAY),
            service_type: ServiceType::OWN_PROCESS,
            // Delayed automatic: at every boot it finishes an update a power cut interrupted.
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: root.exe_of(version),
            launch_arguments: vec![OsString::from("update-helper")],
            dependencies: vec![],
            // LocalSystem: it switches the service and writes Program Files.
            account_name: None,
            account_password: None,
        };
        let service = match m.create_service(&info, ServiceAccess::ALL_ACCESS) {
            Ok(s) => s,
            // ERROR_SERVICE_EXISTS
            Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1073) => {
                let s = m.open_service(HELPER, ServiceAccess::ALL_ACCESS).context("opening the helper service")?;
                s.change_config(&info).context("pointing the helper at its version")?;
                s
            }
            Err(e) => return Err(anyhow::Error::from(e).context("creating the helper service")),
        };
        service.set_description(HELPER_DESCRIPTION)?;
        service.set_delayed_auto_start(true)?;
        set_dacl(&service, &helper_sddl(&service_sid(crate::service::NAME)))
    }

    fn set_dacl(service: &windows_service::service::Service, sddl: &str) -> Result<()> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
        use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
        use windows_sys::Win32::System::Services::SetServiceObjectSecurity;
        let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated; `sd` is freed with LocalFree once used.
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(wide.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
                return Err(std::io::Error::last_os_error()).context("reading the helper's security descriptor");
            }
            // windows-service is on an older windows-sys, whose SC_HANDLE is an isize.
            let ok = SetServiceObjectSecurity(service.raw_handle() as *mut std::ffi::c_void, DACL_SECURITY_INFORMATION, sd);
            let err = std::io::Error::last_os_error();
            LocalFree(sd as _);
            if ok == 0 {
                return Err(err).context("letting the service start the helper");
            }
        }
        Ok(())
    }

    /// The inbound rule for the LAN ingress, on `exe`: from the local subnet, on every profile
    /// (FR-20.92: Windows calls a new network Public). Replaced, so it never names an old version.
    pub fn firewall(exe: &Path) -> Result<()> {
        use std::os::windows::process::CommandExt;
        let netsh = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("netsh.exe");
        // "No rules match": there was none to replace.
        let _ = std::process::Command::new(&netsh).raw_arg(format!("advfirewall firewall delete rule name=\"{FIREWALL_RULE}\"")).output();
        let out = std::process::Command::new(&netsh)
            .raw_arg(format!(
                "advfirewall firewall add rule name=\"{FIREWALL_RULE}\" dir=in action=allow enable=yes profile=any remoteip=localsubnet program=\"{}\"",
                exe.display()
            ))
            .output()
            .context("running netsh")?;
        if !out.status.success() {
            anyhow::bail!("netsh could not add the firewall rule: {}", String::from_utf8_lossy(&out.stdout).trim());
        }
        Ok(())
    }

    pub fn remove_firewall() {
        use std::os::windows::process::CommandExt;
        let netsh = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("netsh.exe");
        let _ = std::process::Command::new(netsh).raw_arg(format!("advfirewall firewall delete rule name=\"{FIREWALL_RULE}\"")).output();
    }

    /// The version `LGRServer` is configured to run, read from the service itself.
    pub fn service_version(root: &Root) -> Option<String> {
        let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
        let s = m.open_service(crate::service::NAME, ServiceAccess::QUERY_CONFIG).ok()?;
        let config = s.query_config().ok()?;
        version_in(&config.executable_path.to_string_lossy(), root)
    }

    pub fn observe() -> Result<Observed> {
        let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
        let s = m.open_service(crate::service::NAME, ServiceAccess::QUERY_STATUS)?;
        let st = s.query_status()?;
        // Our own stop reports STOPPED with no error (`service::exit_code(0)`); a process that died
        // leaves the SCM's error, and a refusal its own code.
        let stopping = st.current_state == ServiceState::StopPending
            || (st.current_state == ServiceState::Stopped && st.exit_code == windows_service::service::ServiceExitCode::Win32(0));
        Ok(Observed { running: st.current_state == ServiceState::Running, pid: st.process_id, auto_restarts: None, stopping })
    }

    /// Stop the service, and start it again: what makes a pointer change take effect.
    pub fn restart() -> Result<()> {
        let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
        let s = m.open_service(crate::service::NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::START)?;
        let status = s.query_status()?;
        if status.current_state != ServiceState::Stopped {
            let _ = s.stop();
            // The API's own stop waits up to 25 s for a receipt; the database then shuts down cleanly.
            let mut stopped = false;
            for _ in 0..240 {
                std::thread::sleep(Duration::from_millis(500));
                if s.query_status()?.current_state == ServiceState::Stopped {
                    stopped = true;
                    break;
                }
            }
            if !stopped {
                if let Some(pid) = s.query_status()?.process_id {
                    tracing::warn!(pid, "the service did not stop in two minutes: ending it");
                    terminate(pid);
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
        s.start::<&str>(&[]).context("starting the service")?;
        Ok(())
    }

    fn terminate(pid: u32) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        // SAFETY: a handle opened here is closed here.
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }

    /// Start the helper if it is not running already.
    pub fn start_helper() -> Result<()> {
        let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
        let s = m.open_service(HELPER, ServiceAccess::QUERY_STATUS | ServiceAccess::START)?;
        if s.query_status()?.current_state == ServiceState::Stopped {
            s.start::<&str>(&[])?;
        }
        Ok(())
    }

    /// Wake the helper, as the service account may (its DACL): it asks the supervisor itself what to do.
    pub fn wake_helper(_data: &Path) -> Result<()> {
        start_helper()
    }

    /// Remove the helper service (the package's removal).
    pub fn remove_helper() -> Result<()> {
        let m = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
        let s = match m.open_service(HELPER, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE) {
            Ok(s) => s,
            Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1060) => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if s.query_status()?.current_state != ServiceState::Stopped {
            let _ = s.stop();
            for _ in 0..60 {
                std::thread::sleep(Duration::from_millis(500));
                if s.query_status()?.current_state == ServiceState::Stopped {
                    break;
                }
            }
        }
        s.delete()?;
        Ok(())
    }
}

#[cfg(unix)]
mod unix {
    use super::*;

    pub const UNIT: &str = "lgr-server.service";
    pub const HELPER_UNIT: &str = "lgr-server-update.service";

    /// Point `<root>/<name>` at `versions/<version>`: a new link renamed over the old one.
    fn relink(root: &Root, name: &str, version: &str) -> Result<()> {
        let link = root.0.join(name);
        let tmp = root.0.join(format!(".{name}.tmp"));
        let _ = std::fs::remove_file(&tmp);
        std::os::unix::fs::symlink(Path::new(crate::install::VERSIONS_DIR).join(version), &tmp).with_context(|| format!("linking {}", tmp.display()))?;
        std::fs::rename(&tmp, &link).with_context(|| format!("pointing {} at {version}", link.display()))?;
        // The switch is the rename: flushed, a power cut after it cannot point back.
        crate::config::sync_dir(&root.0)
    }

    pub fn point_service(root: &Root, version: &str, _data: &Path, _first: bool) -> Result<()> {
        relink(root, "current", version)
    }

    pub fn point_helper(root: &Root, version: &str) -> Result<()> {
        relink(root, "lkg", version)
    }

    pub fn service_version(root: &Root) -> Option<String> {
        let target = std::fs::read_link(root.0.join("current")).ok()?;
        (target.parent()? == Path::new(crate::install::VERSIONS_DIR)).then(|| target.file_name().map(|v| v.to_string_lossy().into_owned())).flatten()
    }

    fn systemctl(args: &[&str]) -> Result<String> {
        let out = std::process::Command::new("systemctl").args(args).output().context("running systemctl")?;
        if !out.status.success() {
            anyhow::bail!("systemctl {args:?}: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Is systemd running this machine? A container may have none: nothing then watches a switch.
    pub fn has_systemd() -> bool {
        Path::new("/run/systemd/system").is_dir()
    }

    pub fn observe() -> Result<Observed> {
        let text = systemctl(&["show", UNIT, "--property=ActiveState,SubState,MainPID,NRestarts"])?;
        Ok(super::observed_from_show(&text))
    }

    /// ⚠ `--no-block`: the unit pulls the helper in (Wants=), and the helper is what asks. Waiting for
    /// the restart's jobs would be the helper waiting for itself.
    pub fn restart() -> Result<()> {
        systemctl(&["--no-block", "restart", UNIT]).map(|_| ())
    }

    pub fn start_helper() -> Result<()> {
        systemctl(&["--no-block", "start", HELPER_UNIT]).map(|_| ())
    }

    pub fn remove_helper() -> Result<()> {
        let _ = systemctl(&["stop", HELPER_UNIT]);
        Ok(())
    }

    /// The file `lgr-server-update.path` watches: the service user may touch it, and that only wakes
    /// the helper, which reads nothing from it.
    pub fn wake_file(data: &Path) -> PathBuf {
        data.join("run").join("update-wake")
    }

    /// Wake the helper: touch the file its path unit watches.
    pub fn wake_helper(data: &Path) -> Result<()> {
        let f = wake_file(data);
        if let Some(dir) = f.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&f, crate::install::now_secs().to_string()).with_context(|| format!("writing {}", f.display()))
    }

    /// No firewall rule of ours on Linux: the distribution's firewall is the operator's.
    pub fn remove_firewall() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_service_sid_is_the_one_windows_computes() {
        // `sc showsid TrustedInstaller`: the same algorithm for every service.
        assert_eq!(service_sid("TrustedInstaller"), "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
        assert_eq!(service_sid("trustedinstaller"), service_sid("TrustedInstaller"), "the name is upper-cased first");
    }

    #[test]
    fn the_service_account_may_start_the_helper_and_nothing_more() {
        let sddl = helper_sddl("S-1-5-80-1-2-3-4-5");
        assert!(sddl.ends_with("(A;;LCRP;;;S-1-5-80-1-2-3-4-5)"));
        // Only SYSTEM and the administrators may stop, reconfigure or delete it.
        let stoppers: Vec<_> = sddl.split(")(").filter(|ace| ace.contains("WP")).collect();
        assert_eq!(stoppers.len(), 2);
        assert!(stoppers.iter().all(|a| a.ends_with(";;;SY") || a.ends_with(";;;BA")));
    }

    #[test]
    fn the_running_version_is_read_off_the_service_command_line() {
        let root = Root(PathBuf::from(if cfg!(windows) { r"C:\Program Files\LGR Server" } else { "/opt/lgr-server" }));
        let exe = root.exe_of("0.2.0");
        assert_eq!(version_in(&format!("\"{}\" service run", exe.display()), &root).as_deref(), Some("0.2.0"));
        // Another root, another program, a development build: not one of this root's versions.
        assert_eq!(version_in(&format!("\"{}\" service run", Root(PathBuf::from("/elsewhere")).exe_of("0.2.0").display()), &root), None);
        assert_eq!(version_in("\"C:\\tools\\other.exe\" run", &root), None);
    }
}
