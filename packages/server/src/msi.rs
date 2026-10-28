//! The MSI's machine check, as a custom action (FR-20.13, AC 14): a machine that cannot run a master
//! is refused before anything is installed, and the person installing is told why in words.
//!
//! `wix/main.wxs` carries this DLL in its Binary table and runs `Preflight` as an IMMEDIATE action
//! before `InstallInitialize`: a refused machine has nothing to roll back, no file, no service, no
//! registration. The checks are the supervisor's own (`preflight.rs`, compiled in here as it is),
//! less the VC++ runtime, which the package carries.
//!
//! The reason goes through the installer itself (`MsiProcessMessage`): a message box when there is a
//! UI, and the MSI's log either way (`msiexec /l*v`), where every check is written whatever its
//! verdict. ⚠ An EXE custom action could do neither: its failure is the installer's generic
//! "a program run as part of the setup did not finish as expected".
#![cfg(windows)]

#[allow(dead_code)]
#[path = "preflight.rs"]
mod preflight;

use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
    MsiCloseHandle, MsiCreateRecord, MsiProcessMessage, MsiRecordSetStringW, INSTALLMESSAGE, INSTALLMESSAGE_ERROR, INSTALLMESSAGE_INFO,
    MSIHANDLE,
};

const ERROR_SUCCESS: u32 = 0;
const ERROR_INSTALL_FAILURE: u32 = 1603;
/// `MB_ICONERROR`, which the installer passes to its message box with the error.
const MB_ICONERROR: INSTALLMESSAGE = 0x10;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// One message through the installer: always logged, and shown when it is an error and there is a UI.
///
/// ⚠ The text goes in field 1, behind a `[1]` template, never as the template itself: in a template
/// square brackets are property references, and a path or a detail may carry some.
fn say(install: MSIHANDLE, kind: INSTALLMESSAGE, text: &str) {
    unsafe {
        let record = MsiCreateRecord(1);
        if record == 0 {
            return;
        }
        let (template, text) = (wide("[1]"), wide(text));
        MsiRecordSetStringW(record, 0, template.as_ptr());
        MsiRecordSetStringW(record, 1, text.as_ptr());
        MsiProcessMessage(install, kind, record);
        MsiCloseHandle(record);
    }
}

/// What the person installing reads when the machine is refused: every failed check, in words. The
/// .deb's `packaging/linux/preinst` says the same.
fn refusal(checks: &[preflight::Check]) -> Option<String> {
    let failed: Vec<String> = checks.iter().filter(|c| !c.ok).map(|c| format!("  - {}", c.detail)).collect();
    if failed.is_empty() {
        return None;
    }
    Some(format!("LGR Server cannot run on this machine, so nothing was installed:\n{}", failed.join("\n")))
}

fn check(install: MSIHANDLE) -> u32 {
    let data = preflight::default_data_dir();
    let checks = preflight::machine(&data);
    for c in &checks {
        say(install, INSTALLMESSAGE_INFO, &format!("LGR Server preflight: {} {} {}", if c.ok { "ok" } else { "FAIL" }, c.name, c.detail));
    }
    match refusal(&checks) {
        None => ERROR_SUCCESS,
        Some(text) => {
            say(install, INSTALLMESSAGE_ERROR | MB_ICONERROR, &text);
            ERROR_INSTALL_FAILURE
        }
    }
}

/// `DllEntry="Preflight"`. ⚠ A panic must not unwind into msiexec: it is caught, and refuses.
#[allow(non_snake_case)]
#[no_mangle]
pub extern "system" fn Preflight(install: MSIHANDLE) -> u32 {
    std::panic::catch_unwind(|| check(install)).unwrap_or_else(|_| {
        say(install, INSTALLMESSAGE_ERROR | MB_ICONERROR, "LGR Server could not check this machine, so nothing was installed.");
        ERROR_INSTALL_FAILURE
    })
}
