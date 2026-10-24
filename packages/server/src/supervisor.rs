//! The supervisor proper (FR-20 plan step P1-1): keep every child running, answer the control
//! channel, and take everything down cleanly when told to.
//!
//! Each child has a keeper task that owns it: start, wait, react ([`crate::backoff`]), and obey a
//! restart or a shutdown. The keepers publish their state; the control channel reads it. Nothing
//! else touches a child.

use crate::backoff::{Policy, Reaction};
use crate::child::{self, ChildSpec, GRACE};
use crate::ipc::{self, Call, Request, Response};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Starting,
    Running,
    /// Waiting out a backoff before the next start.
    Waiting,
    /// Left stopped: it exited with a code that says restarting cannot help, or it was shut down.
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildStatus {
    pub name: String,
    pub state: State,
    pub pid: Option<u32>,
    /// Starts since the supervisor started, the first one included.
    pub starts: u32,
    /// Failures in a row: the rung of the backoff ladder.
    pub failures: u32,
    pub last_exit: Option<i32>,
    pub reason: Option<String>,
    #[serde(skip)]
    pub since: Option<Instant>,
    #[serde(skip)]
    pub next_start: Option<Instant>,
}

impl ChildStatus {
    fn new(name: &str) -> Self {
        Self { name: name.to_string(), state: State::Starting, pid: None, starts: 0, failures: 0, last_exit: None, reason: None, since: None, next_start: None }
    }

    fn json(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        let now = Instant::now();
        v["sinceSecs"] = self.since.map(|t| now.duration_since(t).as_secs()).into();
        v["nextStartInSecs"] = self.next_start.map(|t| t.saturating_duration_since(now).as_secs()).into();
        v
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ctl {
    Restart,
    Shutdown,
}

/// Keep `spec` running until shut down.
async fn keep(spec: ChildSpec, status: Arc<Mutex<ChildStatus>>, mut ctl: mpsc::Receiver<Ctl>, policy: Policy) {
    let set = |f: &dyn Fn(&mut ChildStatus)| f(&mut status.lock().unwrap());
    let mut failures = 0u32;
    'outer: loop {
        set(&|s| {
            s.state = State::Starting;
            s.next_start = None;
        });
        let started = Instant::now();
        let reaction = match child::spawn(&spec) {
            Err(e) => {
                tracing::error!(child = %spec.name, error = %e, "could not start");
                let (reaction, f) = policy.decide(None, Duration::ZERO, failures);
                failures = f;
                set(&|s| {
                    s.failures = failures;
                    s.reason = Some(format!("could not start: {e}"));
                });
                reaction
            }
            Ok(mut running) => {
                let pid = running.child.id();
                tracing::info!(child = %spec.name, pid, "started");
                set(&|s| {
                    s.state = State::Running;
                    s.pid = pid;
                    s.starts += 1;
                    s.since = Some(started);
                    s.reason = None;
                });
                tokio::select! {
                    exit = running.child.wait() => {
                        let code = exit.ok().and_then(|s| s.code());
                        let (reaction, f) = policy.decide(code, started.elapsed(), failures);
                        failures = f;
                        tracing::warn!(child = %spec.name, ?code, failures, ?reaction, "exited");
                        set(&|s| {
                            s.pid = None;
                            s.last_exit = code;
                            s.failures = failures;
                            s.reason = Some(match code {
                                Some(c) => format!("exited with {c}"),
                                None => "killed".to_string(),
                            });
                        });
                        reaction
                    }
                    cmd = ctl.recv() => {
                        let code = running.stop(GRACE).await;
                        set(&|s| { s.pid = None; s.last_exit = code; });
                        match cmd {
                            Some(Ctl::Restart) => {
                                failures = 0;
                                set(&|s| { s.failures = 0; s.reason = Some("restarted on request".into()); });
                                continue 'outer;
                            }
                            _ => break 'outer,
                        }
                    }
                }
            }
        };
        match reaction {
            Reaction::Respawn(delay) => {
                set(&|s| {
                    s.state = State::Waiting;
                    s.next_start = Some(Instant::now() + delay);
                });
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    cmd = ctl.recv() => match cmd {
                        Some(Ctl::Restart) => { failures = 0; set(&|s| s.failures = 0); }
                        _ => break 'outer,
                    },
                }
            }
            Reaction::Stop => {
                tracing::error!(child = %spec.name, "left stopped: restarting cannot help");
                set(&|s| s.state = State::Stopped);
                match ctl.recv().await {
                    Some(Ctl::Restart) => {
                        failures = 0;
                        set(&|s| s.failures = 0);
                    }
                    _ => break 'outer,
                }
            }
        }
    }
    set(&|s| {
        s.state = State::Stopped;
        s.pid = None;
        s.next_start = None;
        if s.reason.is_none() {
            s.reason = Some("shut down".into());
        }
    });
}

/// A child as the supervisor holds it: its published state, its keeper's orders, the keeper itself.
type Kept = (Arc<Mutex<ChildStatus>>, mpsc::Sender<Ctl>, tokio::task::JoinHandle<()>);

pub struct Supervisor {
    started: Instant,
    children: Vec<Kept>,
}

impl Supervisor {
    /// Start a keeper for every child.
    pub fn start(specs: Vec<ChildSpec>, policy: Policy) -> Self {
        let children = specs
            .into_iter()
            .map(|spec| {
                let status = Arc::new(Mutex::new(ChildStatus::new(&spec.name)));
                let (tx, rx) = mpsc::channel(4);
                let handle = tokio::spawn(keep(spec, status.clone(), rx, policy));
                (status, tx, handle)
            })
            .collect();
        Self { started: Instant::now(), children }
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "service": "lgr-server",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "uptimeSecs": self.started.elapsed().as_secs(),
            "children": self.children.iter().map(|(s, _, _)| s.lock().unwrap().json()).collect::<Vec<_>>(),
        })
    }

    async fn restart(&self, name: &str) -> Response {
        for (status, tx, _) in &self.children {
            if status.lock().unwrap().name == name {
                return match tx.send(Ctl::Restart).await {
                    Ok(()) => Response::ok(),
                    Err(_) => Response::error(format!("{name} is shutting down")),
                };
            }
        }
        Response::error(format!("no child called {name}"))
    }

    /// Stop every child (each with its grace period, all at once) and wait for them.
    pub async fn shutdown(self) {
        for (_, tx, _) in &self.children {
            let _ = tx.send(Ctl::Shutdown).await;
        }
        for (_, _, handle) in self.children {
            let _ = handle.await;
        }
    }

    /// Answer the control channel until a `stop` request or `shutdown` resolves, then shut down.
    pub async fn serve(self, mut calls: mpsc::Receiver<Call>, shutdown: impl std::future::Future<Output = ()>) {
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                call = calls.recv() => {
                    let Some((request, reply)) = call else { break };
                    match request {
                        Request::Status => { let _ = reply.send(Response::status(self.status())); }
                        Request::Restart { child } => { let _ = reply.send(self.restart(&child).await); }
                        Request::Stop => {
                            let _ = reply.send(Response::ok());
                            break;
                        }
                    }
                }
                _ = &mut shutdown => break,
            }
        }
        tracing::info!("shutting down");
        self.shutdown().await;
    }
}

/// The whole supervisor: children, control channel, until stopped. Returns the process exit code.
pub async fn run(specs: Vec<ChildSpec>, endpoint: String, policy: Policy, shutdown: impl std::future::Future<Output = ()>) -> i32 {
    let (calls_tx, calls_rx) = mpsc::channel::<Call>(16);
    // Bind the control channel first: a second supervisor (or a squatter) stops here, before it
    // starts children that would fight the first one's for the port and the database.
    let listening = {
        let endpoint = endpoint.clone();
        tokio::spawn(async move { ipc::serve(&endpoint, calls_tx).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    if listening.is_finished() {
        let err = listening.await.map(|r| r.err()).ok().flatten();
        tracing::error!(?err, %endpoint, "control channel unavailable: is another supervisor running?");
        return crate::backoff::EXIT_REFUSED;
    }
    let supervisor = Supervisor::start(specs, policy);
    supervisor.serve(calls_rx, shutdown).await;
    listening.abort();
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    const FAST: Policy = Policy { initial: Duration::from_millis(50), cap: Duration::from_millis(200), healthy: Duration::from_secs(30) };

    /// A child that runs `script` in the platform's shell.
    fn shell(name: &str, script: &str) -> ChildSpec {
        let mut env = BTreeMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".into(), path);
        }
        if let Ok(root) = std::env::var("SystemRoot") {
            env.insert("SystemRoot".into(), root);
        }
        #[cfg(windows)]
        let (program, args) = (PathBuf::from("cmd.exe"), vec!["/C".to_string(), script.to_string()]);
        #[cfg(unix)]
        let (program, args) = (PathBuf::from("/bin/sh"), vec!["-c".to_string(), script.to_string()]);
        ChildSpec { name: name.into(), program, args, cwd: std::env::temp_dir(), env, log: None }
    }

    /// A child that runs for 30 s and dies of an ordinary stop signal: this test binary, re-run as
    /// [`child_sleeps`]. ⚠ Not `ping`: on Windows it takes Ctrl+Break as "print statistics" and
    /// carries on, so every stop waited out the whole grace.
    fn sleeper(name: &str) -> ChildSpec {
        let mut spec = shell(name, "");
        spec.program = std::env::current_exe().unwrap();
        spec.args = vec!["--exact".into(), "supervisor::tests::child_sleeps".into(), "--ignored".into()];
        spec.env.insert("LGR_SERVER_TEST_SLEEP".into(), "1".into());
        spec
    }

    #[test]
    #[ignore = "a child process for the supervisor tests, not a test"]
    fn child_sleeps() {
        if std::env::var_os("LGR_SERVER_TEST_SLEEP").is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    async fn wait_for(sup: &Supervisor, mut ok: impl FnMut(&serde_json::Value) -> bool) -> serde_json::Value {
        for _ in 0..200 {
            let s = sup.status();
            if ok(&s) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("condition not reached: {}", sup.status());
    }

    #[tokio::test]
    async fn a_crashing_child_is_restarted_up_the_ladder() {
        let sup = Supervisor::start(vec![shell("crashy", "exit 3")], FAST);
        let s = wait_for(&sup, |s| s["children"][0]["starts"].as_u64() >= Some(3)).await;
        assert_eq!(s["children"][0]["lastExit"], 3);
        assert!(s["children"][0]["failures"].as_u64().unwrap() >= 2);
        sup.shutdown().await;
    }

    #[tokio::test]
    async fn a_child_that_exits_7_is_left_stopped_and_says_why() {
        let sup = Supervisor::start(vec![shell("misconfigured", "exit 7")], FAST);
        let s = wait_for(&sup, |s| s["children"][0]["state"] == "stopped").await;
        assert_eq!(s["children"][0]["starts"], 1);
        assert_eq!(s["children"][0]["reason"], "exited with 7");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(sup.status()["children"][0]["starts"], 1, "a configuration error must not be retried");
        sup.shutdown().await;
    }

    #[tokio::test]
    async fn restart_and_shutdown_reach_a_running_child() {
        let sup = Supervisor::start(vec![sleeper("api")], FAST);
        let first = wait_for(&sup, |s| s["children"][0]["state"] == "running").await;
        let pid = first["children"][0]["pid"].as_u64().unwrap();
        assert!(sup.restart("api").await.ok);
        assert!(!sup.restart("nonesuch").await.ok);
        let again = wait_for(&sup, |s| s["children"][0]["state"] == "running" && s["children"][0]["pid"].as_u64() != Some(pid)).await;
        assert_eq!(again["children"][0]["starts"], 2);
        let t0 = Instant::now();
        sup.shutdown().await;
        assert!(t0.elapsed() < GRACE + Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_child_that_cannot_start_is_retried_and_says_why() {
        let mut spec = shell("missing", "");
        spec.program = PathBuf::from("this-program-does-not-exist-lgr");
        let sup = Supervisor::start(vec![spec], FAST);
        let s = wait_for(&sup, |s| s["children"][0]["failures"].as_u64() >= Some(2)).await;
        assert!(s["children"][0]["reason"].as_str().unwrap().starts_with("could not start"));
        sup.shutdown().await;
    }
}
