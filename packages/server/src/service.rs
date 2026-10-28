//! Registering the supervisor with the OS (FR-20 plan step P1-1): `lgr-server service install`,
//! `uninstall`, and `run` (what the OS starts).
//!
//! - **Windows:** the service `LGRServer`, as the virtual account `NT SERVICE\LGRServer`, automatic,
//!   with recovery 5 s / 30 s / 60 s and a 24 h reset (roomler `win_service/mod.rs`), on crashes and
//!   on non-crash failures. The data directory is readable by the service, SYSTEM and the
//!   administrators alone (FR-20.14), and the service may modify it.
//! - **Linux:** `lgr-server.service`, `User=lgr`, `Restart=always`, and `RestartPreventExitStatus=7 8`:
//!   a configuration error or a deliberate refusal is not retried by systemd either.
//! - **macOS:** the LaunchDaemon `ai.lgrai.server`, as `_lgrserver`.
//!
//! The MSI (plan step P1-7) calls `service install --no-start` from a deferred custom action and
//! starts the service itself afterwards (roomler's `wix-perMachine`: a service started inside the
//! action fails the install with error 87). Installing again, as an upgrade does, updates the
//! service in place. Uninstalling leaves the data where it is: the database and the keys outlive a
//! reinstall. The Linux packages carry `packaging/linux/lgr-server.service`, the unit
//! `systemd_unit` writes, and never start anything themselves.

use anyhow::Result;
use std::path::Path;

#[cfg_attr(not(windows), allow(dead_code))]
pub const NAME: &str = "LGRServer";
pub const DISPLAY_NAME: &str = "LGR Server";
#[cfg_attr(not(windows), allow(dead_code))]
pub const DESCRIPTION: &str = "LGR on-premises master: the API, its database, and the link to lgrai.app";

/// The systemd unit for `exe`, run as `user`.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn systemd_unit(exe: &Path, user: &str, data: &Path) -> String {
    format!(
        "[Unit]\n\
         Description={DISPLAY_NAME}\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         # FR-20.20: every start pulls in the update helper, which watches a new version run, and\n\
         # goes back to the previous one by itself if it does not. It exits at once otherwise.\n\
         Wants=lgr-server-update.service\n\
         # And the path unit the service wakes it by (P1-8c): the service user may touch the file it\n\
         # watches, and that only starts the helper, which reads nothing from it.\n\
         Wants=lgr-server-update.path\n\
         \n\
         [Service]\n\
         Type=simple\n\
         User={user}\n\
         Group={user}\n\
         ExecStart={exe} service run\n\
         Environment=LGR_SERVER_DATA={data}\n\
         # /run/lgr-server, owned by the service user: where the control socket lives.\n\
         RuntimeDirectory=lgr-server\n\
         RuntimeDirectoryMode=0750\n\
         Restart=always\n\
         RestartSec=5\n\
         # 7: the configuration is wrong. 8: it refused to start on purpose. Neither is fixed by a retry.\n\
         RestartPreventExitStatus=7 8\n\
         KillMode=mixed\n\
         TimeoutStopSec=30\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        exe = exe.display(),
        data = data.display(),
    )
}

/// The LaunchDaemon for `exe`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn launchd_plist(exe: &Path, user: &str, data: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.lgrai.server</string>
  <key>ProgramArguments</key>
  <array><string>{exe}</string><string>service</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>LGR_SERVER_DATA</key><string>{data}</string></dict>
  <key>UserName</key><string>{user}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
"#,
        exe = exe.display(),
        data = data.display(),
    )
}

#[cfg(windows)]
pub mod platform {
    use super::*;
    use anyhow::Context;
    use std::ffi::OsString;
    use std::time::Duration;
    use windows_service::service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl,
        ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState,
        ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
    use windows_service::{define_windows_service, service_dispatcher};

    const ACCOUNT: &str = r"NT SERVICE\LGRServer";

    /// Grant `who` the `rights` icacls spells, on `path`.
    fn icacls(path: &Path, args: &[&str]) -> Result<()> {
        let out = std::process::Command::new("icacls").arg(path).args(args).output().context("running icacls")?;
        if !out.status.success() {
            anyhow::bail!("icacls {} {:?}: {}", path.display(), args, String::from_utf8_lossy(&out.stdout));
        }
        Ok(())
    }

    pub fn install(data: &Path, start: bool) -> Result<()> {
        install_at(&std::env::current_exe()?, data, start, true)
    }

    /// Register the service, or point it, at `exe`. `secure_data`: set the data directory's ACL too
    /// (a first install, `service install` by hand). A switch between versions leaves it alone:
    /// rewriting an inheritable ACL walks every file of the database and the uploads.
    pub fn install_at(exe: &Path, data: &Path, start: bool, secure_data: bool) -> Result<()> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)
            .context("opening the service manager (run as an administrator)")?;
        let info = ServiceInfo {
            name: OsString::from(NAME),
            display_name: OsString::from(DISPLAY_NAME),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: exe.to_path_buf(),
            launch_arguments: vec![OsString::from("service"), OsString::from("run")],
            dependencies: vec![],
            account_name: Some(OsString::from(ACCOUNT)),
            account_password: None,
        };
        // An upgrade installs again over the same service: it is brought up to date, not refused.
        let service = match manager.create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START) {
            Ok(s) => s,
            // ERROR_SERVICE_EXISTS
            Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1073) => {
                let s = manager.open_service(NAME, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START).context("opening the service")?;
                s.change_config(&info).context("updating the service")?;
                s
            }
            Err(e) => return Err(anyhow::Error::from(e).context("creating the service")),
        };
        service.set_description(DESCRIPTION)?;
        service.update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 3600)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![
                ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(5) },
                ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(30) },
                ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(60) },
            ]),
        })?;
        service.set_failure_actions_on_non_crash_failures(true)?;

        // FR-20.14: readable only by the service account and administrators. ProgramData's own ACL
        // lets every user read, so the data directory does not inherit it: the service, SYSTEM
        // (S-1-5-18) and Administrators (S-1-5-32-544), named by SID so a localized Windows agrees.
        // ⚠ Only when asked: the update helper points the service at a version without ever writing
        // under the data directory, which the service account may change (AC 59).
        if secure_data {
            let keys = data.join("keys");
            std::fs::create_dir_all(&keys)?;
            for (dir, rights) in [(data, "M"), (keys.as_path(), "F")] {
                let service = format!("{ACCOUNT}:(OI)(CI){rights}");
                icacls(dir, &["/inheritance:r", "/grant:r", &service, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"])?;
            }
        }
        if start {
            service.start::<&str>(&[]).context("starting the service")?;
        }
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
        let service = match manager.open_service(NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE) {
            Ok(s) => s,
            // ERROR_SERVICE_DOES_NOT_EXIST: nothing to do.
            Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1060) => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        if service.query_status()?.current_state != ServiceState::Stopped {
            let _ = service.stop();
            for _ in 0..60 {
                std::thread::sleep(Duration::from_millis(500));
                if service.query_status()?.current_state == ServiceState::Stopped {
                    break;
                }
            }
        }
        service.delete()?;
        Ok(())
    }

    /// What the service reports when it stops, which the event log renders.
    ///
    /// ⚠ A service-specific code is shown with the SYSTEM message of the same number: exit 7 read
    /// "The storage control blocks were destroyed" (Win32 error 7) on the first clean Windows a master
    /// met (vmtest, 2026-10-28). The two deliberate refusals carry a Win32 error whose text is true;
    /// `logs\lgr-server.log` says the rest.
    fn exit_code(code: u32) -> ServiceExitCode {
        use windows_sys::Win32::Foundation::{ERROR_BAD_ENVIRONMENT, ERROR_INVALID_STATE};
        match code as i32 {
            0 => ServiceExitCode::Win32(0),
            // "The environment is incorrect."
            crate::backoff::EXIT_CONFIG => ServiceExitCode::Win32(ERROR_BAD_ENVIRONMENT),
            // "The group or resource is not in the correct state to perform the requested operation."
            crate::backoff::EXIT_REFUSED => ServiceExitCode::Win32(ERROR_INVALID_STATE),
            _ => ServiceExitCode::ServiceSpecific(code),
        }
    }

    #[cfg(test)]
    #[test]
    fn a_refusal_reads_true_in_the_event_log() {
        assert_eq!(exit_code(0), ServiceExitCode::Win32(0));
        assert_eq!(exit_code(7), ServiceExitCode::Win32(10));
        assert_eq!(exit_code(8), ServiceExitCode::Win32(5023));
        assert_eq!(exit_code(3), ServiceExitCode::ServiceSpecific(3));
    }

    define_windows_service!(ffi_service_main, service_main);

    /// What the SCM starts (`lgr-server service run`).
    pub fn run() -> Result<()> {
        service_dispatcher::start(NAME, ffi_service_main).context("connecting to the service manager (was this started by it?)")?;
        Ok(())
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = run_service() {
            tracing::error!(error = %e, "the service failed");
        }
    }

    fn run_service() -> Result<()> {
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let stop_tx = std::sync::Mutex::new(Some(stop_tx));
        let handle = service_control_handler::register(NAME, move |event| match event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                if let Some(tx) = stop_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })?;
        let status = |state, code: u32, wait: Duration| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running { ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN } else { ServiceControlAccept::empty() },
            exit_code: exit_code(code),
            checkpoint: 0,
            wait_hint: wait,
            process_id: None,
        };
        handle.set_service_status(status(ServiceState::Running, 0, Duration::ZERO))?;
        let code = crate::run_supervisor_blocking(async move {
            let _ = stop_rx.await;
        });
        handle.set_service_status(status(ServiceState::Stopped, code as u32, Duration::ZERO))?;
        Ok(())
    }
}

#[cfg(unix)]
pub mod platform {
    use super::*;
    use anyhow::Context;

    #[cfg(target_os = "macos")]
    const USER: &str = "_lgrserver";
    #[cfg(not(target_os = "macos"))]
    const USER: &str = "lgr";

    fn sh(program: &str, args: &[&str]) -> Result<()> {
        let status = std::process::Command::new(program).args(args).status().with_context(|| format!("running {program}"))?;
        if !status.success() {
            anyhow::bail!("{program} {args:?} failed ({status})");
        }
        Ok(())
    }

    fn user_exists(user: &str) -> bool {
        std::process::Command::new("id").arg(user).output().map(|o| o.status.success()).unwrap_or(false)
    }

    pub fn install(data: &Path, start: bool) -> Result<()> {
        let exe = std::env::current_exe()?;
        if !user_exists(USER) {
            #[cfg(target_os = "macos")]
            anyhow::bail!("the service user {USER} does not exist: the installer creates it (plan step P1-7)");
            #[cfg(not(target_os = "macos"))]
            sh("useradd", &["--system", "--home-dir", &data.to_string_lossy(), "--shell", "/usr/sbin/nologin", USER])?;
        }
        std::fs::create_dir_all(data.join("keys"))?;
        sh("chown", &["-R", &format!("{USER}:{USER}"), &data.to_string_lossy()])?;
        sh("chmod", &["0750", &data.to_string_lossy()])?;
        sh("chmod", &["0700", &data.join("keys").to_string_lossy()])?;
        #[cfg(target_os = "macos")]
        {
            let plist = "/Library/LaunchDaemons/ai.lgrai.server.plist";
            std::fs::write(plist, launchd_plist(&exe, USER, data))?;
            sh("launchctl", &["bootstrap", "system", plist])?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            std::fs::write("/etc/systemd/system/lgr-server.service", systemd_unit(&exe, USER, data))?;
            sh("systemctl", &["daemon-reload"])?;
            sh("systemctl", &[if start { "--now" } else { "--no-block" }, "enable", "lgr-server.service"])?;
        }
        Ok(())
    }

    pub fn uninstall() -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            let _ = sh("launchctl", &["bootout", "system/ai.lgrai.server"]);
            let _ = std::fs::remove_file("/Library/LaunchDaemons/ai.lgrai.server.plist");
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = sh("systemctl", &["disable", "--now", "lgr-server.service"]);
            let _ = std::fs::remove_file("/etc/systemd/system/lgr-server.service");
            let _ = sh("systemctl", &["daemon-reload"]);
        }
        Ok(())
    }

    /// What systemd or launchd starts: the supervisor in the foreground, stopped by SIGTERM.
    pub fn run() -> Result<()> {
        let code = crate::run_supervisor_blocking(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
        });
        std::process::exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_packaged_unit_is_the_one_install_writes() {
        // packaging/linux/lgr-server.service ships in the .deb; it must not drift from this.
        let packaged = include_str!("../packaging/linux/lgr-server.service").replace("\r\n", "\n");
        assert_eq!(packaged, systemd_unit(&PathBuf::from("/opt/lgr-server/current/lgr-server"), "lgr", &PathBuf::from("/var/lib/lgr")));
    }

    #[test]
    fn systemd_does_not_retry_what_a_retry_cannot_fix() {
        let unit = systemd_unit(&PathBuf::from("/opt/lgr-server/current/lgr-server"), "lgr", &PathBuf::from("/var/lib/lgr"));
        assert!(unit.contains("ExecStart=/opt/lgr-server/current/lgr-server service run\n"));
        assert!(unit.contains("Wants=lgr-server-update.service\n"), "a new version is watched from its first start");
        assert!(unit.contains("Wants=lgr-server-update.path\n"), "the service can wake the helper");
        assert!(unit.contains("User=lgr\n"));
        assert!(unit.contains("Restart=always\n"));
        assert!(unit.contains("RuntimeDirectory=lgr-server\n"), "the non-root user cannot create /run/lgr-server itself");
        assert!(unit.contains("RestartPreventExitStatus=7 8\n"));
        assert!(unit.contains("Environment=LGR_SERVER_DATA=/var/lib/lgr\n"));
        assert!(!unit.contains("User=root"));
    }

    #[test]
    fn launchd_keeps_it_alive_as_its_own_user() {
        let plist = launchd_plist(&PathBuf::from("/Applications/LGR Server/lgr-server"), "_lgrserver", &PathBuf::from("/Library/Application Support/LGR"));
        assert!(plist.contains("<key>KeepAlive</key><true/>"));
        assert!(plist.contains("<key>UserName</key><string>_lgrserver</string>"));
        assert!(plist.contains("<string>service</string><string>run</string>"));
    }
}
