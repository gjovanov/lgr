//! The supervisor proper (FR-20 plan step P1-1): keep every child running, answer the control
//! channel, and take everything down cleanly when told to.
//!
//! Each child has a keeper task that owns it: start, wait, react ([`crate::backoff`]), and obey a
//! restart or a shutdown. The keepers publish their state; the control channel reads it. Nothing
//! else touches a child.

use crate::backoff::{Policy, Reaction};
use crate::child::{self, ChildSpec};
use crate::ipc::{self, Call, Request, Response};
use serde::Serialize;
use std::path::PathBuf;
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
                        let code = running.stop(&spec.stop, spec.grace).await;
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
    /// The ways in (FR-20.16): closed first on a stop, before any child is asked to stop.
    ingresses: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// The API's control socket and the secret it answers, once the API is started behind a front.
    api_control: Mutex<Option<(PathBuf, String)>>,
    /// FR-20.20: when an update installs (`updates.rs`). None until registered and started.
    updates: Mutex<Option<std::sync::Arc<crate::updates::Updates>>>,
    /// The front as the status shows it (never its secret).
    front: Mutex<serde_json::Value>,
    /// What the children use (the egress proxy): stopped last, after every child.
    services: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// The LAN identity, once its ingress is open: what `ca-rotate` announces on, and what the
    /// status says of the CA in force (FR-20.30).
    lan: Mutex<Option<std::sync::Arc<Mutex<crate::certs::LanIdentity>>>>,
    /// What `register` needs (FR-20.2): the data directory, and the client that reaches global.
    registrar: Mutex<Option<std::sync::Arc<Registrar>>>,
    /// Per uplink channel (FR-20.52): what the status shows of it.
    uplink: crate::uplink::Status,
    /// FR-20.56: the desktop release this master keeps for its tills.
    releases: crate::uplink::Status,
    /// #370: what the night restart says (`night_restart.rs`).
    night_restart: crate::uplink::Status,
    /// #370: asked to stop and start again in place.
    reexec: tokio::sync::Notify,
}

/// The data directory, whose `keys/node.key` and `state/` a registration reads and writes, and the
/// client that reaches global through the machine's proxy rules.
pub struct Registrar {
    pub data: PathBuf,
    pub client: crate::https::Https,
    /// A registration wakes the uplink, so it connects at once instead of on its next look.
    pub wake: tokio::sync::Notify,
}

impl Supervisor {
    pub fn new(policy: Policy) -> Self {
        Self { started: Instant::now(), policy, children: Mutex::new(vec![]), ingresses: Mutex::new(vec![]), api_control: Mutex::new(None), updates: Mutex::new(None), front: Mutex::new(serde_json::Value::Null), services: Mutex::new(vec![]), lan: Mutex::new(None), registrar: Mutex::new(None), uplink: std::sync::Arc::new(Mutex::new(serde_json::json!({}))), releases: std::sync::Arc::new(Mutex::new(serde_json::Value::Null)), night_restart: std::sync::Arc::new(Mutex::new(serde_json::Value::Null)), reexec: tokio::sync::Notify::new() }
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

    /// Keep `task`, an ingress, so a stop closes it before anything else.
    pub fn add_ingress(&self, task: tokio::task::JoinHandle<()>) {
        self.ingresses.lock().unwrap().push(task);
    }

    /// Keep `task`, a service the children use, so a stop ends it after them.
    pub fn add_service(&self, task: tokio::task::JoinHandle<()>) {
        self.services.lock().unwrap().push(task);
    }

    /// What the status says about the front: its port, socket, names and console. Never its secret.
    pub fn set_front_info(&self, info: serde_json::Value) {
        *self.front.lock().unwrap() = info;
    }

    /// The LAN identity the ingress serves, so a rotation can be announced and reported.
    pub fn set_lan(&self, lan: std::sync::Arc<Mutex<crate::certs::LanIdentity>>) {
        *self.lan.lock().unwrap() = Some(lan);
    }

    /// Announce a rotation of the LAN CA, `lead_secs` ahead (a week when absent).
    pub fn rotate_ca(&self, lead_secs: Option<i64>) -> Response {
        let Some(lan) = self.lan.lock().unwrap().clone() else {
            return Response::error("the LAN ingress is not open: there is no LAN CA to rotate");
        };
        let lead = match lead_secs {
            None => crate::certs::ROTATION_LEAD,
            Some(s) if s >= 0 => time::Duration::seconds(s),
            Some(_) => return Response::error("--in is a number of seconds, not negative"),
        };
        let mut id = lan.lock().unwrap_or_else(|p| p.into_inner());
        match id.announce_rotation(time::OffsetDateTime::now_utc(), lead) {
            Ok(r) => Response::status(serde_json::to_value(&r).unwrap_or_default()),
            Err(e) => Response::error(format!("{e:#}")),
        }
    }

    pub fn set_registrar(&self, registrar: std::sync::Arc<Registrar>) {
        *self.registrar.lock().unwrap() = Some(registrar);
    }

    pub fn uplink_status(&self) -> crate::uplink::Status {
        self.uplink.clone()
    }

    pub fn releases_status(&self) -> crate::uplink::Status {
        self.releases.clone()
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn night_restart_status(&self) -> crate::uplink::Status {
        self.night_restart.clone()
    }

    /// #370: stop everything as a service stop does, and start again in place (`serve` returns
    /// [`crate::night_restart::REEXEC`]).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn request_reexec(&self) {
        self.reexec.notify_one();
    }

    /// FR-20.55: keep a licence an operator imported, for this master, as one from global is kept.
    pub fn import_licence(&self, jws: &str) -> Response {
        let Some(registrar) = self.registrar.lock().unwrap().clone() else {
            return Response::error("this server takes a licence once it has started");
        };
        let kept = crate::front::node_id(&registrar.data).and_then(|node| crate::licence::keep(&registrar.data, jws, &node));
        match kept {
            Ok(k) => {
                tracing::info!(org = %k.licence.org, plan = %k.licence.plan, paid_through = %k.licence.paid_through, "a licence was imported");
                Response::status(serde_json::to_value(&k).unwrap_or_default())
            }
            Err(e) => Response::error(format!("{e:#}")),
        }
    }

    /// Where the API's own status is: its control socket, behind the front.
    pub fn set_updates(&self, updates: std::sync::Arc<crate::updates::Updates>) {
        *self.updates.lock().unwrap() = Some(updates);
    }

    /// The API's control socket and its secret, once the API is started.
    pub fn api_control(&self) -> Option<(PathBuf, String)> {
        self.api_control.lock().unwrap().clone()
    }

    pub fn set_api_control(&self, socket: PathBuf, secret: String) {
        *self.api_control.lock().unwrap() = Some((socket, secret));
    }

    /// The status, with the API's own account of itself (schedulers, a receipt in flight, open POS
    /// sessions) when it can give one within 2 s.
    pub async fn status_with_api(&self) -> serde_json::Value {
        let mut status = self.status();
        let control = self.api_control.lock().unwrap().clone();
        if let Some((socket, secret)) = control {
            status["api"] = match crate::control::call(&socket, &secret, "GET", "/status", Duration::from_secs(2)).await {
                Ok((200, body)) => serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
                Ok((code, _)) => serde_json::json!({ "error": format!("its control socket answered {code}") }),
                Err(e) => serde_json::json!({ "error": format!("{e:#}") }),
            };
        }
        status
    }

    pub fn status(&self) -> serde_json::Value {
        let children: Vec<_> = self.children.lock().unwrap().iter().map(|k| k.status.lock().unwrap().json()).collect();
        serde_json::json!({
            "service": "lgr-server",
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "uptimeSecs": self.started.elapsed().as_secs(),
            "front": self.front_now(),
            "registration": self.registrar.lock().unwrap().as_ref().and_then(|r| crate::register::current(&r.data)),
            "uplink": self.uplink.lock().unwrap().clone(),
            "desktopReleases": self.releases.lock().unwrap().clone(),
            "children": children,
            "licences": self.registrar.lock().unwrap().as_ref().map(|r| crate::licence::list(&r.data)),
            "update": self.updates.lock().unwrap().as_ref().map(|u| u.status.lock().unwrap_or_else(|p| p.into_inner()).clone()),
            "nightRestart": self.night_restart.lock().unwrap().clone(),
            // #356: another machine claiming this server's LAN address (null off Linux).
            "addressCheck": crate::arp::status(),
        })
    }

    /// The front as it is now: the LAN CA read live, so a switch or an announcement shows at once.
    fn front_now(&self) -> serde_json::Value {
        let mut front = self.front.lock().unwrap().clone();
        let lan = self.lan.lock().unwrap().clone();
        if let (Some(lan), Some(obj)) = (lan, front.get_mut("lan").and_then(|l| l.as_object_mut())) {
            let id = lan.lock().unwrap_or_else(|p| p.into_inner());
            obj.insert("caFingerprint".into(), id.fingerprint.clone().into());
            obj.insert("names".into(), serde_json::json!(id.names));
            obj.insert("rotation".into(), id.next.as_ref().map(|n| serde_json::to_value(&n.rotation).unwrap_or_default()).unwrap_or_default());
        }
        front
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
        // The ways in close first: nothing new arrives while the API finishes what it has.
        let ingresses: Vec<_> = std::mem::take(&mut *self.ingresses.lock().unwrap());
        if !ingresses.is_empty() {
            for i in &ingresses {
                i.abort();
            }
            tracing::info!(count = ingresses.len(), "closed the ingresses");
        }
        let kept: Vec<Kept> = std::mem::take(&mut *self.children.lock().unwrap());
        for k in kept.into_iter().rev() {
            if let Some(tx) = &k.ctl {
                let _ = tx.send(Ctl::Shutdown).await;
            }
            if let Some(keeper) = k.keeper {
                let _ = keeper.await;
            }
        }
        // Last: the API may still need the egress while it finishes what it was doing.
        for s in std::mem::take(&mut *self.services.lock().unwrap()) {
            s.abort();
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
                        Request::Status => { let _ = reply.send(Response::status(self.status_with_api().await)); }
                        Request::Restart { child } => { let _ = reply.send(self.restart(&child).await); }
                        Request::CaRotate { lead_secs } => { let _ = reply.send(self.rotate_ca(lead_secs)); }
                        // Network calls, so off this loop: a stop or a status never waits behind one.
                        Request::Register { server, code, link_level, name } => {
                            let registrar = self.registrar.lock().unwrap().clone();
                            match registrar {
                                None => { let _ = reply.send(Response::error("this server registers once it has started")); }
                                Some(r) => {
                                    tokio::spawn(async move {
                                        let ask = crate::register::Ask { server, code, link_level, name };
                                        let answer = match crate::register::register(&r.data, &r.client, &ask).await {
                                            Ok(done) => {
                                                r.wake.notify_waiters();
                                                Response::status(serde_json::to_value(done).unwrap_or_default())
                                            }
                                            Err(e) => Response::error(format!("{e:#}")),
                                        };
                                        let _ = reply.send(answer);
                                    });
                                }
                            }
                        }
                        Request::LicenceImport { jws } => { let _ = reply.send(self.import_licence(&jws)); }
                        // FR-20.20: the API backs every home org up, which can take minutes: off this loop.
                        Request::BackupNow => {
                            match self.api_control() {
                                None => { let _ = reply.send(Response::error("the API is not running: no backup can be taken")); }
                                Some((socket, secret)) => {
                                    tokio::spawn(async move {
                                        let answer = match crate::control::call(&socket, &secret, "POST", "/backup", Duration::from_secs(2 * 3600)).await {
                                            Ok((200, body)) => Response::status(serde_json::from_str(&body).unwrap_or_default()),
                                            Ok((code, body)) => Response::error(format!("the backup failed ({code}): {}", body.chars().take(2000).collect::<String>())),
                                            Err(e) => Response::error(format!("{e:#}")),
                                        };
                                        let _ = reply.send(answer);
                                    });
                                }
                            }
                        }
                        // A network call (a node token) and the API's status: off this loop too.
                        Request::UpdateContext => {
                            let updates = self.updates.lock().unwrap().clone();
                            let api = self.api_control();
                            match updates {
                                Some(u) => {
                                    tokio::spawn(async move {
                                        let _ = reply.send(u.context(api).await);
                                    });
                                }
                                None => { let _ = reply.send(Response::error("this server takes no updates until it is registered and started")); }
                            }
                        }
                        Request::Stop => {
                            let _ = reply.send(Response::ok());
                            return 0;
                        }
                    }
                }
                _ = &mut shutdown => return 0,
                // #370: a library was replaced, and it is the night to take it.
                _ = self.reexec.notified() => return crate::night_restart::REEXEC,
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
    let mut shutdown = std::pin::pin!(shutdown);
    let mut code = supervisor.serve(calls_rx, shutdown.as_mut(), &mut starting).await;
    starting.abort();
    if code == crate::night_restart::REEXEC {
        tracing::info!("stopping, to start again in place");
        // #370: a stop asked for while the children stop (systemd's SIGTERM, a machine going down)
        // wins. Started again into it, the new image would only be killed when the stop times out.
        let mut down = std::pin::pin!(supervisor.shutdown());
        let mut stop_asked = false;
        loop {
            tokio::select! {
                _ = &mut down => break,
                _ = shutdown.as_mut(), if !stop_asked => stop_asked = true,
            }
        }
        if stop_asked {
            tracing::info!("a stop was asked for while restarting in place: stopping instead");
            code = 0;
        }
    } else {
        tracing::info!("shutting down");
        supervisor.shutdown().await;
    }
    listening.abort();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::child::GRACE;
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
        ChildSpec { name: name.into(), program, args, cwd: std::env::temp_dir(), env, log: None, stop: crate::child::Stop::Signal, grace: GRACE }
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

    /// #370: the night restart's request stops everything as a service stop does, and the supervisor
    /// says it stopped to start again in place, never with an exit code.
    #[tokio::test]
    async fn a_request_to_start_again_in_place_stops_everything_first() {
        #[cfg(windows)]
        let endpoint = format!(r"\\.\pipe\lgr-server-test-reexec-{}", std::process::id());
        #[cfg(unix)]
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let endpoint = dir.path().join("control.sock").display().to_string();
        let kept: Arc<Mutex<Option<Arc<Supervisor>>>> = Arc::new(Mutex::new(None));
        let keep = kept.clone();
        let code = run(endpoint, FAST, std::future::pending::<()>(), move |sup| async move {
            sup.add(sleeper("api"));
            wait_for(&sup, |s| s["children"][0]["state"] == "running").await;
            *keep.lock().unwrap() = Some(sup.clone());
            sup.request_reexec();
            Ok(())
        })
        .await;
        assert_eq!(code, crate::night_restart::REEXEC);
        let sup = kept.lock().unwrap().clone().unwrap();
        assert_eq!(sup.status()["children"].as_array().map(|c| c.len()), Some(0), "every child was stopped before it returned");
    }

    /// #370: systemd's SIGTERM, arriving while the children stop for a restart in place, is a stop:
    /// the supervisor exits instead of starting again into a machine going down.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_stop_asked_for_while_restarting_in_place_wins() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = dir.path().join("control.sock").display().to_string();
        let stop = Arc::new(tokio::sync::Notify::new());
        let asked = stop.clone();
        let code = run(endpoint, FAST, async move { asked.notified().await }, move |sup| async move {
            // It ignores SIGTERM, so its stop waits out the grace: the window the stop lands in.
            let mut stubborn = shell("api", "trap '' TERM; sleep 30");
            stubborn.grace = Duration::from_secs(2);
            sup.add(stubborn);
            wait_for(&sup, |s| s["children"][0]["state"] == "running").await;
            // Its own task: the start is aborted once the restart is asked for.
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                stop.notify_one();
            });
            sup.request_reexec();
            Ok(())
        })
        .await;
        assert_eq!(code, 0);
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
