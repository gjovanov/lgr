//! Starting a child the supervisor can always take down whole (FR-20 plan step P1-1).
//!
//! The API spawns Chrome for every PDF, and Chrome spawns its helpers. Killing only the process we
//! started would orphan them (2026-10-23: 54 zombies in the pod after nine renders). So a child runs
//! in its own group, and stopping it stops the group:
//! - Windows: a Job Object with KILL_ON_JOB_CLOSE. Closing the job, or the supervisor dying, ends
//!   every process in it; a graceful stop sends CTRL_BREAK to the child's console process group first.
//!   ⚠ A service has no console, so under the SCM the event cannot be sent at all, and the stop
//!   is the job, at once (waiting out a grace for a signal that never left only delayed it by
//!   15 s). The graceful path there is the API's own control socket (plan step P1-3).
//!   ⚠ The child is assigned to its job right after it starts: a process it
//!   spawned in that instant would escape, which the API (Chrome starts only for a PDF) never does.
//! - Unix: its own process group (`setsid`). A graceful stop is SIGTERM to the group, then SIGKILL.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::{Child, Command};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpec {
    /// `api`, later `mongod`: what the status and `restart` call it.
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The whole environment: nothing is inherited from the supervisor's own.
    pub env: BTreeMap<String, String>,
    /// Where its stdout and stderr go, appended. A service has no console: without this a child's
    /// own account of why it died would be lost.
    pub log: Option<PathBuf>,
    /// How it is asked to stop before the grace period runs out and its group is killed.
    pub stop: Stop,
    /// How long it has to stop once asked. The API's covers its own wait for a receipt in flight.
    pub grace: Duration,
}

/// How a child is asked to stop.
#[derive(Clone, PartialEq, Eq)]
pub enum Stop {
    /// SIGTERM to its group (Unix), CTRL_BREAK to its console group (Windows).
    Signal,
    /// mongod's own `shutdown` command, as its administrator: a clean stop on every OS, with no
    /// console needed (FR-20.23). A signal is the fallback.
    Mongo { port: u16, user: String, password: String },
    /// The API's control socket, `POST /stop` with the front secret (FR-20.23): it stops listening,
    /// lets a receipt in flight finish, disconnects the fiscal devices and exits 0. A signal is the
    /// fallback, and under the SCM the only other way, at once.
    Control { socket: PathBuf, secret: String },
}

/// Never a password or a secret: a spec printed in a log or a failed assertion must not carry one.
impl std::fmt::Debug for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stop::Signal => f.write_str("Signal"),
            Stop::Mongo { port, user, .. } => f.debug_struct("Mongo").field("port", port).field("user", user).finish_non_exhaustive(),
            Stop::Control { socket, .. } => f.debug_struct("Control").field("socket", socket).finish_non_exhaustive(),
        }
    }
}

/// A running child and what is needed to take it down whole.
pub struct Running {
    pub child: Child,
    #[cfg(windows)]
    job: job::Job,
}

/// A child's grace when nothing says otherwise: the tests' children. The real ones each carry
/// their own (`ChildSpec::grace`): the API's covers its wait for a receipt, mongod's its checkpoint.
#[cfg(test)]
pub const GRACE: Duration = Duration::from_secs(15);

pub fn spawn(spec: &ChildSpec) -> std::io::Result<Running> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = &spec.log {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        cmd.stdout(file.try_clone()?).stderr(file);
    }
    #[cfg(windows)]
    {
        // Its own console process group, so CTRL_BREAK reaches it and not the supervisor.
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            // Its own session and process group: `killpg` then reaches Chrome's helpers too.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    #[cfg(windows)]
    {
        let job = job::Job::new()?;
        if let Some(pid) = child.id() {
            job.assign(pid)?;
        }
        Ok(Running { child, job })
    }
    #[cfg(unix)]
    Ok(Running { child })
}

impl Running {
    /// Ask the child's group to stop, wait up to `grace`, then kill it. Returns its exit code.
    pub async fn stop(mut self, how: &Stop, grace: Duration) -> Option<i32> {
        let Some(pid) = self.child.id() else {
            return self.child.wait().await.ok().and_then(|s| s.code());
        };
        if let Stop::Mongo { port, user, password } = how {
            let asked = tokio::time::timeout(Duration::from_secs(5), crate::mongod::request_shutdown(*port, user, password)).await;
            if matches!(asked, Ok(Ok(()))) {
                if let Ok(Ok(status)) = tokio::time::timeout(grace, self.child.wait()).await {
                    self.kill_group(pid);
                    return status.code();
                }
            }
            tracing::warn!(?asked, "mongod did not stop on its shutdown command: signalling it");
        }
        if let Stop::Control { socket, secret } = how {
            match crate::control::call(socket, secret, "POST", "/stop", Duration::from_secs(5)).await {
                Ok((202, _)) => {
                    if let Ok(Ok(status)) = tokio::time::timeout(grace, self.child.wait()).await {
                        self.kill_group(pid);
                        return status.code();
                    }
                    tracing::warn!(?grace, "the API took the stop but did not exit within its grace: signalling it");
                }
                asked => tracing::warn!(?asked, "the API's control socket did not take the stop: signalling it"),
            }
        }
        #[cfg(unix)]
        unsafe {
            libc::killpg(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
            // Without a console (under the SCM) the event cannot be sent at all, and waiting out the
            // grace for a signal that never left would only delay the stop by 15 s: end it now.
            if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) } == 0 {
                self.kill_group(pid);
                return self.child.wait().await.ok().and_then(|s| s.code());
            }
        }
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(Ok(status)) => {
                self.kill_group(pid);
                status.code()
            }
            _ => {
                self.kill_group(pid);
                let _ = self.child.kill().await;
                self.child.wait().await.ok().and_then(|s| s.code())
            }
        }
    }

    /// Whatever is left of the group goes: helpers the child spawned and did not wait for.
    fn kill_group(&self, pid: u32) {
        #[cfg(unix)]
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = pid;
            self.job.terminate();
        }
    }
}

#[cfg(windows)]
mod job {
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// A Job Object whose processes all die when it closes: with the child, or with the supervisor.
    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let e = io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(e);
                }
                Ok(Job(handle))
            }
        }

        pub fn assign(&self, pid: u32) -> io::Result<()> {
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let ok = AssignProcessToJobObject(self.0, process);
                CloseHandle(process);
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
