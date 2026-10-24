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
    /// Listed, not started: it waits for another child (the API for its database).
    Pending,
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
                        let code = running.stop(&spec.stop, GRACE).await;
                        tracing::info!(child = %spec.name, ?code, "stopped");
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

/// A child as the supervisor holds it: its published state, and, once it has one, its keeper and
/// the channel that gives the keeper its orders. A child waiting on another (the API on its
/// database) is listed before it has a keeper, so the status says what it waits for.
struct Kept {
    status: Arc<Mutex<ChildStatus>>,
    ctl: Option<mpsc::Sender<Ctl>>,
    keeper: Option<tokio::task::JoinHandle<()>>,
}

pub struct Supervisor {
    started: Instant,
    policy: Policy,
    children: Mutex<Vec<Kept>>,
}

impl Supervisor {
    pub fn new(policy: Policy) -> Self {
        Self { started: Instant::now(), policy, children: Mutex::new(vec![]) }
    }

    /// A supervisor already keeping `specs`.
    #[cfg(test)]
    pub fn start(specs: Vec<ChildSpec>, policy: Policy) -> Self {
        let s = Self::new(policy);
        for spec in specs {
            s.add(spec);
        }
        s
    }

    /// List `name` as waiting for something, without starting it.
    pub fn pending(&self, name: &str, reason: &str) {
        let mut status = ChildStatus::new(name);
        status.state = State::Pending;
        status.reason = Some(reason.to_string());
        self.children.lock().unwrap().push(Kept { status: Arc::new(Mutex::new(status)), ctl: None, keeper: None });
    }

    /// Start keeping `spec`: a child listed as pending under its name, or a new one.
    pub fn add(&self, spec: ChildSpec) {
        let mut children = self.children.lock().unwrap();
        let index = match children.iter().position(|k| k.status.lock().unwrap().name == spec.name) {
            Some(i) => i,
            None => {
                children.push(Kept { status: Arc::new(Mutex::new(ChildStatus::new(&spec.name))), ctl: None, keeper: None });
                children.len() - 1
            }
        };
        let kept = &mut children[index];
        let (tx, rx) = mpsc::channel(4);
        kept.keeper = Some(tokio::spawn(keep(spec, kept.status.clone(), rx, self.policy)));
        kept.ctl = Some(tx);
    }

    pub fn status(&self) -> serde_json::Value {
        let children: Vec<_> = self.children.lock().unwrap().iter().map(|k| k.status.lock().unwrap().json()).collect();
        serde_json::json!({
            "service": "lgr-server",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "uptimeSecs": self.started.elapsed().as_secs(),
            "children": children,
        })
    }

    pub async fn restart(&self, name: &str) -> Response {
        // The sender is cloned out: the lock is never held across an await.
        let found = self.children.lock().unwrap().iter().find(|k| k.status.lock().unwrap().name == name).map(|k| k.ctl.clone());
        match found {
            None => Response::error(format!("no child called {name}")),
            Some(None) => Response::error(format!("{name} has not started yet")),
            Some(Some(tx)) => match tx.send(Ctl::Restart).await {
                Ok(()) => Response::ok(),
                Err(_) => Response::error(format!("{name} is shutting down")),
            },
        }
    }

    /// Stop every child, the last started first, each fully before the next: the API stops while
    /// its database still answers, and mongod stops last and cleanly (FR-20.23). Stopping them all
    /// at once let mongod go first, under the API's last writes.
    pub async fn shutdown(&self) {
        let kept: Vec<Kept> = std::mem::take(&mut *self.children.lock().unwrap());
        for k in kept.into_iter().rev() {
            if let Some(tx) = &k.ctl {
                let _ = tx.send(Ctl::Shutdown).await;
            }
            if let Some(keeper) = k.keeper {
                let _ = keeper.await;
            }
        }
    }

    /// Answer the control channel until a `stop` request, `shutdown`, or a startup that gives up
    /// with an exit code. Returns the code the supervisor exits with.
    pub async fn serve(
        &self,
        mut calls: mpsc::Receiver<Call>,
        shutdown: impl std::future::Future<Output = ()>,
        starting: &mut tokio::task::JoinHandle<Result<(), i32>>,
    ) -> i32 {
        tokio::pin!(shutdown);
        let mut started = false;
        loop {
            tokio::select! {
                call = calls.recv() => {
                    let Some((request, reply)) = call else { return 0 };
                    match request {
                        Request::Status => { let _ = reply.send(Response::status(self.status())); }
                        Request::Restart { child } => { let _ = reply.send(self.restart(&child).await); }
                        Request::Stop => {
                            let _ = reply.send(Response::ok());
                            return 0;
                        }
                    }
                }
                _ = &mut shutdown => return 0,
                done = &mut *starting, if !started => {
                    started = true;
                    if let Ok(Err(code)) = done {
                        tracing::error!(code, "startup gave up");
                        return code;
                    }
                }
            }
        }
    }
}

/// The whole supervisor until stopped: bind the control channel, run `start` (which adds the
/// children, in order), answer requests, then take everything down. Returns the exit code.
pub async fn run<F, Fut>(endpoint: String, policy: Policy, shutdown: impl std::future::Future<Output = ()>, start: F) -> i32
where
    F: FnOnce(Arc<Supervisor>) -> Fut,
    Fut: std::future::Future<Output = Result<(), i32>> + Send + 'static,
{
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
    let supervisor = Arc::new(Supervisor::new(policy));
    let mut starting = tokio::spawn(start(supervisor.clone()));
    let code = supervisor.serve(calls_rx, shutdown, &mut starting).await;
    tracing::info!("shutting down");
    starting.abort();
    supervisor.shutdown().await;
    listening.abort();
    code
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
        ChildSpec { name: name.into(), program, args, cwd: std::env::temp_dir(), env, log: None, stop: crate::child::Stop::Signal }
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
