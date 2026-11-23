//! C11 — the presence socket (FR-14.21) and the server link state C10's Overview reads.
//!
//! ⚠ **The credential is the FIRST MESSAGE, never the URL.** A URL ends up in ingress logs,
//! proxy logs and crash reports — that is what S-05 was. `/ws/tasks` carried a `?userId=` until
//! #158 moved it to this same first-message pattern. The server closes a socket that has not
//! authenticated within 10 s.
//!
//! ⚠ **One background thread, blocking.** The shell has no async runtime since local mode was
//! retired, and adding one for a single socket that sends a message every 30 s would be a
//! dependency and a scheduler for nothing.
//!
//! ⚠ **The shell keeps its own clock** (#328). Its reads used to block until the server said
//! something, so the 30 s heartbeat went out only when a message happened to arrive, and a dead
//! link was never noticed: the first field lane cut a till's link for four minutes and this loop
//! sat in `read()` the whole time, logging nothing. Reads now wait at most `READ_SLICE`, the
//! heartbeat keeps its own time, and a link silent for `SILENT_AFTER` is dead (`next`).
//!
//! ⚠ **That wait is on the socket, never a receive timeout** (`socket.rs`, lgr#811). From #328 to
//! desktop 0.1.13 it was a receive timeout, read again each time it ran out, and on Windows a
//! receive that times out as a frame arrives loses the frame and fails with an error that is no
//! timeout: the link dropped with the server up. The bridge read the same way, and there the lost
//! frame was a sale's first command.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tungstenite::Message;

use crate::enroll;
use crate::socket::HubSocket;
use crate::wake::Wake;

/// What the Overview's connection chip shows (FR-14.17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    /// Nothing has tried yet. ⚠ Not the same as `Unreachable`, and must never be rendered as it.
    Unknown,
    Connected,
    Unreachable,
    /// The desktop credential was refused — revoked, or a key the server no longer knows.
    SignedOut,
}

impl Link {
    pub fn as_str(self) -> &'static str {
        match self {
            Link::Unknown => "unknown",
            Link::Connected => "connected",
            Link::Unreachable => "unreachable",
            Link::SignedOut => "signed_out",
        }
    }
}

/// Shared with the rest of the shell. Small enough that a mutex is simpler than channels.
///
/// ⚠ What wakes the loops that wait for the server is not here any more. It was one flag
/// (`nudge`) that whichever loop looked first cleared, so **Retry now** woke one loop of two
/// (#767). It is `wake::Wake` now, a generation every waiter sees.
#[derive(Default)]
pub struct LinkState {
    link: Mutex<LinkInner>,
}

struct LinkInner {
    link: Link,
    last_change: Option<Instant>,
}

impl Default for LinkInner {
    fn default() -> Self {
        Self { link: Link::Unknown, last_change: None }
    }
}

impl LinkState {
    pub fn get(&self) -> Link {
        self.link.lock().map(|l| l.link).unwrap_or(Link::Unknown)
    }

    pub fn set(&self, next: Link) -> bool {
        let mut guard = match self.link.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if guard.link == next {
            return false;
        }
        guard.link = next;
        guard.last_change = Some(Instant::now());
        true
    }
}

/// Backoff for the unreachable retry loop (FR-14.17): 1 s doubling to 60 s.
///
/// ⚠ Pure and tested. A backoff that silently stops growing hammers a down server from every
/// till in the estate, and one that grows without a ceiling means a server that came back five
/// minutes ago is still not noticed.
pub fn backoff_secs(attempt: u32) -> u64 {
    const MAX: u64 = 60;
    if attempt == 0 {
        return 1;
    }
    1u64.checked_shl(attempt.min(10)).unwrap_or(MAX).min(MAX)
}

/// FR-14.21 — the heartbeat, on the shell's own clock.
pub const HEARTBEAT: Duration = Duration::from_secs(30);
/// How long one read waits for the server before the loop looks at its clock again.
const READ_SLICE: Duration = Duration::from_secs(5);
/// A link that has said NOTHING for this long is dead: two heartbeats gone unanswered, and the
/// hub's own tick (every 15 s) missed five times over.
pub const SILENT_AFTER: Duration = Duration::from_secs(75);

/// What the presence loop does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Next {
    /// Wait for the server (one `READ_SLICE` at most).
    Listen,
    /// Send the heartbeat that is due.
    Beat,
    /// The link went silent: end the session, and the backoff reconnects.
    Dead,
}

/// The loop's decision, from how long ago the server was last heard and the last heartbeat went.
///
/// ⚠ Pure and tested, like `backoff_secs`. Dead wins over a heartbeat: a beat into a link that has
/// said nothing for 75 s goes nowhere, and only a new connection can tell whether the hub is back.
pub fn next(since_heard: Duration, since_beat: Duration) -> Next {
    if since_heard >= SILENT_AFTER {
        Next::Dead
    } else if since_beat >= HEARTBEAT {
        Next::Beat
    } else {
        Next::Listen
    }
}

/// Is the server answering? A cheap, unauthenticated probe.
///
/// ⚠ Any HTTP answer counts, including 401 and 404. The question is "is there a server there",
/// not "does it like us" — a login page that returns 401 is a reachable server, and treating it
/// as down would strand a till behind a perfectly healthy hub.
///
/// ⚠ Through `trust.rs` like every other call (FR-20.31). With a client of its own it trusted the OS
/// store only, so a till paired with a master would have called a perfectly healthy master down.
pub fn probe(server_url: &str) -> bool {
    let url = format!("{}/api/health", server_url.trim_end_matches('/'));
    let Ok(client) = crate::trust::client_for(server_url, Duration::from_secs(5)) else { return false };
    match client.get(&url).send() {
        Ok(_) => true,
        // Fall back to the origin itself: a deployment without /api/health still serves `/`.
        Err(_) => client.get(server_url).send().is_ok(),
    }
}

/// Messages the socket can hand back to the shell.
pub enum Event {
    Authenticated,
    /// FR-14.22 — stop the bridge, delete the key, say so.
    Revoked(String),
    /// FR-14.28 — an admin asked this desktop to update. C13 acts on it.
    UpdateRequested,
    /// FR-20.82 — the org moved to its own server: the signed instruction, and the server's name.
    /// Only `repoint::verify` decides whether it is believed.
    Repoint { instruction: String, name: String },
    /// FR-20.82 — the org moved, and lgrai.app cannot say where it answers.
    Moved { name: String },
    /// ⚠ **Carries WHY.** It used to be a bare variant, so the three outcomes below all arrived
    /// at the handler indistinguishable - and the handler logged nothing at all, which made a
    /// desktop that could not reach its hub completely silent: app running, hub showing it
    /// offline, log empty. "The server is down" and "the server refused my credential" need
    /// different actions from whoever is reading that log.
    ///
    /// And WHAT HAPPENED, as far as it is known (lgr#811): the error a read or a send failed with,
    /// the code a token was refused with, what a close frame said. "The server did not answer" was
    /// one line for a reset, a TLS failure, a `502` and a lost frame. Empty when the reason says
    /// it all.
    Disconnected(DisconnectReason, String),
}

/// Why the presence socket is not up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisconnectReason {
    /// Connected, then the socket closed. Normal; reconnects immediately.
    Closed,
    /// The server did not answer at all.
    Unreachable,
    /// #328 — the socket was up and the server stopped saying anything for `SILENT_AFTER`: a dead
    /// link (a pulled cable, a NAT that forgot the connection, a VPN rerouting under it). A dead TCP
    /// connection never errors by itself, which is why this has to be noticed rather than awaited.
    Silent,
    /// The server answered and refused the credential. Backs off hard - see `Outcome::Refused`.
    Refused,
    /// ⚠ **This machine never got as far as asking.** Minting the socket's credential fails
    /// locally - not registered, no secure storage, no key, a key that will not parse - and that
    /// is neither "the server is down" nor "the server refused me". It used to report `Refused`,
    /// whose own doc comment says *the server answered*, so the log claimed a conversation that
    /// never happened and pointed support at the hub instead of at the till.
    NotConfigured,
}

impl DisconnectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DisconnectReason::Closed => "closed",
            DisconnectReason::Unreachable => "unreachable",
            DisconnectReason::Silent => "silent",
            DisconnectReason::Refused => "refused",
            DisconnectReason::NotConfigured => "not_configured",
        }
    }
}

/// Run the presence socket until `stop` is set. Intended for a dedicated thread.
///
/// Reconnects with the same backoff as the retry loop; a socket that fails to authenticate is
/// closed by the server, and this treats that as `SignedOut` rather than retrying forever with a
/// credential the server has already refused.
///
/// #767: its wait ends early on a ring of `wake` (**Retry now**, or the window or the bridge finding
/// the server), and it rings `wake` itself once the server authenticates it, so the other two loops
/// do not sit out their own backoff with the server back.
pub fn run(
    server_url: String,
    state: Arc<LinkState>,
    wake: Arc<Wake>,
    stop: Arc<AtomicBool>,
    mut on_event: impl FnMut(Event),
) {
    let mut attempt = 0u32;

    while !stop.load(Ordering::SeqCst) {
        // A ring must come after this to cut the wait below short: one from before this try began
        // is old news (`wake.rs`).
        let mut seen = wake.current();
        // Whether this session got as far as the server's `desktop:authenticated`, seen in front of
        // the caller's handler: a link that worked starts the backoff over (`next_attempt`, #741).
        let mut authenticated = false;
        let (outcome, why) = connect_once(&server_url, &state, &stop, &mut |event| {
            if matches!(event, Event::Authenticated) {
                authenticated = true;
                // The server is back: the window's probe and the bridge try now too.
                wake.ring();
            }
            on_event(event)
        });
        if authenticated {
            // ⚠ A session that worked may have lasted hours, and what rang during it (its own ring
            // above, a bridge reconnecting) is stale by now: the wait after it is a whole one.
            seen = wake.current();
        }
        match outcome {
            Outcome::Closed => on_event(Event::Disconnected(DisconnectReason::Closed, why)),
            Outcome::Unreachable => {
                state.set(Link::Unreachable);
                on_event(Event::Disconnected(DisconnectReason::Unreachable, why));
            }
            Outcome::Silent => {
                // The Overview and the bridge stop showing a link that is not there.
                state.set(Link::Unreachable);
                on_event(Event::Disconnected(DisconnectReason::Silent, why));
            }
            Outcome::Refused => {
                // ⚠ Do NOT retry in a tight loop with a credential the server refused. The row
                // is the revocation list; hammering it is noise in the audit log and nothing else.
                state.set(Link::SignedOut);
                on_event(Event::Disconnected(DisconnectReason::Refused, why));
            }
            Outcome::NotConfigured => {
                // Same chip and same slow retry as `Refused` - re-enrolment is the remedy for
                // both, and a locked keystore may well come back - but the REASON is the truth.
                state.set(Link::SignedOut);
                on_event(Event::Disconnected(DisconnectReason::NotConfigured, why));
            }
        }
        attempt = next_attempt(attempt, outcome, authenticated);

        // ⚠ The stop flag ends this wait within a slice, rung or not: that is how `restart_presence`
        // takes the old run out of its sleep, without ringing the window's loop for nothing.
        wake.sleep(backoff_secs(attempt), seen, || stop.load(Ordering::SeqCst));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Closed,
    Unreachable,
    Silent,
    Refused,
    NotConfigured,
}

/// The backoff step after a session ended, from the step before it.
///
/// ⚠ **A session that authenticated starts the count over, whatever ended it (#741).** The count used
/// to go back to 0 only on `Closed`, and a server that stops or restarts reaches a till as a read
/// error, never as a Close frame. A link that had worked for hours kept the step the outage before
/// it had left, so the wait before the FIRST retry grew with every outage the app had seen: 2 s, 4,
/// 8, 16, 32, then a minute for good, however short the server's restart. A lane that restarts its
/// master many times read 2.6 s, 7.6 s and 8.1 s on three restarts in a row, and 60 s on a later one
/// that its fiscal bridge was over in 2.6 s.
///
/// ⚠ Pure and tested, like `backoff_secs`.
fn next_attempt(attempt: u32, outcome: Outcome, authenticated: bool) -> u32 {
    let attempt = if authenticated { 0 } else { attempt };
    match outcome {
        Outcome::Closed => 0,
        Outcome::Unreachable | Outcome::Silent => attempt.saturating_add(1),
        // ~60 s between attempts from here on, a link that worked before it or not.
        Outcome::Refused | Outcome::NotConfigured => 6,
    }
}

/// What a failure to mint the socket's credential means, from `enroll`'s error code.
///
/// ⚠ **Pure, and tested as such.** The mapping used to live inline in `connect_once`, where the
/// only way to exercise it was to run the loop against a dead server - which reads the real
/// machine's keystore, so the test passed on a developer's enrolled laptop and failed on a clean
/// CI runner, for the same reason the mapping itself was wrong.
///
/// ⚠ **The default is `NotConfigured`, not `Refused`.** Everything `mint_token` can fail with
/// before it has an HTTP response is local; only a code the server itself returned means refused.
///
/// ⚠ **An answer with no code is not the server's refusal (#735).** The API names a code on every
/// refusal of a token. `token_failed` is an error that carried none, and `bad_response` a success
/// that was not a token: both are something answering in the API's place. A master's ingress says
/// `502` in plain text while its API starts, and a reverse proxy or a middlebox may answer for a
/// server the same way. Read as a refusal, each restart of the server left the till on the
/// once-a-minute retry meant for a credential that was turned down, with "Signed out" on its
/// Overview for that minute. The bridge has read these as worth retrying since #567.
fn classify_mint_error(msg: &str) -> Outcome {
    match msg {
        // Reached the server, and it answered with its reason.
        "desktop_revoked" | "desktop_outdated" => Outcome::Refused,
        // Never left the machine, or never reached the API: tried again on the backoff.
        "server_unreachable" | "server_timeout" | "token_failed" | "bad_response" => Outcome::Unreachable,
        "not_registered" | "no_secure_storage" | "no_key" | "bad_key" | "client_build_failed" => {
            Outcome::NotConfigured
        }
        // An unrecognised code is a code the SERVER sent (`mint_token` forwards `e.code`
        // verbatim), so it belongs with the answers, not with the local failures.
        _ => Outcome::Refused,
    }
}

fn ws_url(server_url: &str) -> Option<String> {
    let base = server_url.trim_end_matches('/');
    let rest = base.strip_prefix("https://").map(|r| ("wss://", r))
        .or_else(|| base.strip_prefix("http://").map(|r| ("ws://", r)))?;
    Some(format!("{}{}/ws/desktop", rest.0, rest.1))
}

/// One session, to its end: how it ended, and what happened, for the log (`Event::Disconnected`).
fn connect_once(
    server_url: &str,
    state: &Arc<LinkState>,
    stop: &Arc<AtomicBool>,
    on_event: &mut impl FnMut(Event),
) -> (Outcome, String) {
    // A token first: it is the socket's credential, and failing to mint one tells us which of
    // "unreachable" and "refused" this is before any socket exists.
    let token = match enroll::mint_token(server_url) {
        Ok(t) => t,
        Err(e) => {
            let msg = e.to_string();
            if msg == "desktop_revoked" {
                on_event(Event::Revoked(msg.clone()));
                return (Outcome::Refused, msg);
            }
            return (classify_mint_error(&msg), format!("no credential: {msg}"));
        }
    };

    let Some(url) = ws_url(server_url) else {
        return (Outcome::Refused, "the server address is neither http nor https".into());
    };
    // A master's LAN ingress also wants the credential on the upgrade itself (FR-20.32): `ws_connect`
    // adds it there as a header, which never lands in a URL or a log line.
    //
    // ⚠ Read through `HubSocket`, whose wait is on the socket and never a receive timeout (lgr#811).
    let mut socket = match crate::trust::ws_connect(&url, &token).and_then(|s| HubSocket::new(s).map_err(|e| e.to_string())) {
        Ok(socket) => socket,
        Err(e) => return (Outcome::Unreachable, e),
    };

    // ⚠ FIRST message, within the server's 10 s deadline, and never in the URL.
    if let Err(e) = socket.send(Message::Text(serde_json::json!({ "type": "desktop:auth", "token": token }).to_string())) {
        return (Outcome::Unreachable, format!("the credential could not be sent: {e}"));
    }

    // #328: a read never waits longer than READ_SLICE, so the clock below is the loop's own.
    let mut last_beat = Instant::now();
    let mut last_heard = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            socket.close();
            return (Outcome::Closed, "told to stop".into());
        }

        match next(last_heard.elapsed(), last_beat.elapsed()) {
            Next::Dead => return (Outcome::Silent, String::new()),
            // FR-14.21 — a 30 s heartbeat carrying this machine's wall clock, so the hub can record
            // `clockSkewMs` and an admin can SEE a till whose clock is wrong.
            Next::Beat => {
                let now = chrono::Utc::now().to_rfc3339();
                if let Err(e) = socket.send(Message::Text(
                    serde_json::json!({ "type": "desktop:heartbeat", "clientTime": now }).to_string(),
                )) {
                    return (Outcome::Unreachable, format!("the heartbeat could not be sent: {e}"));
                }
                last_beat = Instant::now();
            }
            Next::Listen => {}
        }

        let message = match socket.read(READ_SLICE) {
            Ok(Some(m)) => {
                // Anything at all is the link alive: an ack, the hub's tick, a ping.
                last_heard = Instant::now();
                m
            }
            // Nothing yet: back to `stop` and the clock.
            Ok(None) => continue,
            Err(e) => return (Outcome::Unreachable, e),
        };
        match message {
            Message::Text(text) => {
                match classify(&text) {
                    Some(Incoming::Authenticated) => {
                        state.set(Link::Connected);
                        on_event(Event::Authenticated);
                    }
                    Some(Incoming::Revoked(msg)) => {
                        on_event(Event::Revoked(msg));
                        socket.close();
                        return (Outcome::Refused, "revoked".into());
                    }
                    Some(Incoming::Update) => on_event(Event::UpdateRequested),
                    // FR-20.82: the refusal (`org_moved`) and the close follow; the loop ends there.
                    Some(Incoming::Repoint { instruction, name }) => on_event(Event::Repoint { instruction, name }),
                    Some(Incoming::Moved { name }) => on_event(Event::Moved { name }),
                    Some(Incoming::Refused(code)) => {
                        socket.close();
                        return (Outcome::Refused, code);
                    }
                    // The ack, the hub's `desktop:tick` and anything newer than this build: the
                    // link is alive, which `last_heard` already recorded.
                    Some(Incoming::HeartbeatAck) | None => {}
                }
            }
            Message::Close(frame) => {
                return (Outcome::Closed, format!("closed by the server{}", crate::socket::close_note(&frame)));
            }
            _ => {}
        }
    }
}

/// What the server said. Pure, so the protocol mapping is testable without a socket.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Authenticated,
    HeartbeatAck,
    Revoked(String),
    Update,
    /// The server turned the credential down, with the code it gave (for the log).
    Refused(String),
    Repoint { instruction: String, name: String },
    Moved { name: String },
}

pub fn classify(text: &str) -> Option<Incoming> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("type")?.as_str()? {
        "desktop:authenticated" => Some(Incoming::Authenticated),
        "desktop:heartbeat:ack" => Some(Incoming::HeartbeatAck),
        "desktop:revoked" => Some(Incoming::Revoked(
            v.get("message").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
        )),
        "desktop:update" => Some(Incoming::Update),
        "desktop:repoint" => Some(Incoming::Repoint {
            instruction: v.get("instruction")?.as_str()?.to_string(),
            name: v.get("name").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
        }),
        "desktop:moved" => Some(Incoming::Moved {
            name: v.get("name").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
        }),
        // ⚠ `desktop:error` with `unauthenticated` is the revocation path's quieter sibling: the
        // credential was refused, so retrying with it is pointless.
        "desktop:error" => Some(Incoming::Refused(
            v.get("code").and_then(|c| c.as_str()).unwrap_or("desktop:error").to_string(),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_to_mint_says_which_failure_it_was() {
        // ⚠ **The REASON.** `Event::Disconnected` used to be a bare variant, so a handler could
        // not tell a server that never answered from one that refused the credential - and the
        // handler logged nothing, which is why a till that could not reach its hub was completely
        // silent. This pins the mapping from `enroll`'s error code to what the shell is told.
        //
        // ⚠ This assertion used to live inside the dead-server test below, which could only reach
        // the mapping on a machine that was already enrolled: `mint_token` returns
        // `not_registered` before it opens a socket, so on a clean runner the loop never contacted
        // 127.0.0.1:1 at all. It passed on a developer's laptop and failed in CI - and the thing
        // it failed on was a real bug, not the environment.
        for code in ["server_unreachable", "server_timeout"] {
            assert_eq!(classify_mint_error(code), Outcome::Unreachable, "{code}");
        }
        for code in ["not_registered", "no_secure_storage", "no_key", "bad_key", "client_build_failed"] {
            assert_eq!(
                classify_mint_error(code),
                Outcome::NotConfigured,
                "{code} happens before any request, so it can never mean the server refused us",
            );
        }
        for code in ["desktop_revoked", "desktop_outdated", "whatever_the_hub_sent"] {
            assert_eq!(classify_mint_error(code), Outcome::Refused, "{code}");
        }
    }

    #[test]
    fn an_answer_without_a_code_is_a_server_that_is_not_there_yet() {
        // #735. A master's ingress answers `502` in plain text while its API starts, which mints as
        // `token_failed`. Taken for a refusal, every restart of the server put presence on the
        // once-a-minute retry and the Overview on "Signed out". A 2 h soak that updated its master
        // saw both tills' presence back 65 s after the stop, and their bridges after 8 s.
        for code in ["token_failed", "bad_response"] {
            assert_eq!(
                classify_mint_error(code),
                Outcome::Unreachable,
                "{code} carries no reason from the API, so it is tried again on the backoff",
            );
        }
        // What that buys: the next tries come seconds apart, not a minute.
        assert!(backoff_secs(1) + backoff_secs(2) < backoff_secs(6));
    }

    #[test]
    fn the_stop_flag_ends_the_run() {
        // ⚠ **The STOP.** `restart_presence` works by setting this run's own flag. If the loop did
        // not exit promptly on it, a re-pointed desktop would end up with two presence threads -
        // exactly what the `started` latch exists to prevent.
        //
        // ⚠ **Nothing rings here** (#767). `restart_presence` used to nudge the shared flag as
        // well, and the window's loop could take that nudge in presence's place. The stop flag alone
        // takes the run out of its wait (a minute on a clean runner: `NotConfigured`), and the
        // generation the other loops wait on does not move.
        //
        // ⚠ It does NOT assert which reason arrives: `run` reads this machine's real keystore
        // (`secure_dir()` is driven by `LOCALAPPDATA`/`HOME`), so an enrolled machine gets as far
        // as the socket and a clean one does not. The mapping is the test above's job.
        use std::sync::atomic::AtomicBool;

        // Port 1 is privileged and nothing listens: the connect fails without a timeout wait.
        let state = Arc::new(LinkState::default());
        let wake = Arc::new(Wake::default());
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));

        let stop_cb = stop.clone();
        let seen_cb = seen.clone();
        let state_cb = state.clone();
        let wake_cb = wake.clone();
        let handle = std::thread::spawn(move || {
            run(
                "http://127.0.0.1:1".to_string(),
                state_cb,
                wake_cb,
                stop_cb.clone(),
                move |event| {
                    if let Event::Disconnected(reason, _) = event {
                        seen_cb.lock().unwrap().push(reason);
                        // End the run from inside the callback, the way a restart does.
                        stop_cb.store(true, Ordering::SeqCst);
                    }
                },
            );
        });

        // ⚠ A JOIN, not a sleep: a test that merely slept would pass against a loop that never
        // stops, which is the failure mode worth catching here.
        let joined = {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                if handle.is_finished() {
                    break true;
                }
                if std::time::Instant::now() > deadline {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        assert!(joined, "the run did not exit after its stop flag was set");
        handle.join().unwrap();
        assert_eq!(wake.current(), 0, "a run that never authenticated rings nobody, and a stop is no ring");

        let reasons = seen.lock().unwrap().clone();
        assert!(
            !reasons.is_empty(),
            "the run must report WHY it is not up, whatever the reason is on this machine",
        );
        assert_ne!(
            state.get(),
            Link::Unknown,
            "`unknown` means nothing has tried yet and must never survive an attempt",
        );
    }

    #[test]
    fn every_disconnect_reason_has_a_distinct_label() {
        // The labels go into the log a support call is read from, so a duplicate would make two
        // different situations indistinguishable there - the very bug this set was added to fix.
        let all = [
            DisconnectReason::Closed,
            DisconnectReason::Unreachable,
            DisconnectReason::Silent,
            DisconnectReason::Refused,
            DisconnectReason::NotConfigured,
        ];
        let labels: Vec<&str> = all.iter().map(|r| r.as_str()).collect();
        let mut uniq = labels.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), labels.len(), "duplicate label in {labels:?}");
        assert!(labels.iter().all(|l| !l.is_empty()));
    }

    /// #328 — the first field lane cut a till's link for four minutes and the shell never noticed.
    #[test]
    fn a_link_that_says_nothing_for_75_seconds_is_dead() {
        let s = Duration::from_secs;
        assert_eq!(next(s(0), s(0)), Next::Listen);
        assert_eq!(next(s(29), s(29)), Next::Listen);
        assert_eq!(next(s(5), s(30)), Next::Beat, "the heartbeat keeps its own time, whatever arrives");
        assert_eq!(next(s(74), s(10)), Next::Listen, "a missed ack is not yet a dead link");
        assert_eq!(next(s(75), s(10)), Next::Dead);
        assert_eq!(next(s(90), s(30)), Next::Dead, "dead wins over a beat that would go nowhere");
    }

    #[test]
    fn the_clock_allows_two_unanswered_heartbeats_and_reads_often_enough_to_keep_it() {
        assert!(SILENT_AFTER > HEARTBEAT * 2, "one lost ack must never end a session");
        assert!(READ_SLICE < HEARTBEAT, "a read must not outwait the heartbeat");
        assert!(READ_SLICE <= Duration::from_secs(5), "a quitting app waits for at most one read");
    }

    #[test]
    fn a_link_that_worked_starts_the_backoff_over() {
        // #741. The step went back to 0 only on a Close frame, and a server that restarts reaches a
        // till as a read error. A lane that restarts its master many times saw the wait before the
        // first retry double from one restart to the next, each after a good connection, and a
        // minute's wait on a restart its fiscal bridge was over in 2.6 s.
        let mut attempt = 0;
        for outage in 1..=8 {
            attempt = next_attempt(attempt, Outcome::Unreachable, true);
            assert_eq!(backoff_secs(attempt), 2, "outage {outage}: the first retry after a link that worked");
        }
        // Tries that never got as far as the server's word still back off, to the ceiling.
        let mut attempt = 0;
        let waits: Vec<u64> = (0..7)
            .map(|_| {
                attempt = next_attempt(attempt, Outcome::Unreachable, false);
                backoff_secs(attempt)
            })
            .collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60]);
        // A link that went silent is counted the same way.
        assert_eq!(next_attempt(4, Outcome::Silent, false), 5);
        assert_eq!(next_attempt(4, Outcome::Silent, true), 1);
        // A clean close starts over, as it always did.
        assert_eq!(next_attempt(5, Outcome::Closed, false), 0);
        // A refusal stays on the slow retry, a link that worked before it or not: a desktop revoked
        // in the middle of a session must not come back hammering.
        for authenticated in [false, true] {
            assert_eq!(backoff_secs(next_attempt(0, Outcome::Refused, authenticated)), 60);
            assert_eq!(backoff_secs(next_attempt(0, Outcome::NotConfigured, authenticated)), 60);
        }
    }

    #[test]
    fn backoff_starts_at_one_second_and_stops_at_sixty() {
        assert_eq!(backoff_secs(0), 1);
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(2), 4);
        assert_eq!(backoff_secs(5), 32);
        assert_eq!(backoff_secs(6), 60, "capped, not 64");
        for n in 6..40 {
            assert_eq!(backoff_secs(n), 60, "must never exceed the ceiling at {n}");
        }
    }

    #[test]
    fn the_socket_url_follows_the_scheme_of_the_server() {
        assert_eq!(ws_url("https://lgrai.app").unwrap(), "wss://lgrai.app/ws/desktop");
        assert_eq!(ws_url("https://lgrai.app/").unwrap(), "wss://lgrai.app/ws/desktop");
        // ⚠ A dev hub on loopback is plain http, and must not be upgraded to wss — nothing is
        // listening there, and the symptom would be a desktop that can enroll but never appears
        // online.
        assert_eq!(ws_url("http://127.0.0.1:4001").unwrap(), "ws://127.0.0.1:4001/ws/desktop");
        assert!(ws_url("ftp://x").is_none());
        assert!(ws_url("lgrai.app").is_none());
    }

    #[test]
    fn the_credential_is_never_in_the_socket_url() {
        // ⚠ Structural. A token in a URL lands in ingress and proxy logs; it goes in the first
        // message instead. If anyone ever appends a query string here, this fails.
        let url = ws_url("https://lgrai.app").unwrap();
        for forbidden in ["token", "?", "assertion", "desktopId"] {
            assert!(!url.contains(forbidden), "{forbidden} must not appear in {url}");
        }
    }

    #[test]
    fn server_messages_map_to_what_the_shell_does_about_them() {
        assert_eq!(
            classify(r#"{"type":"desktop:authenticated","desktopId":"d1"}"#),
            Some(Incoming::Authenticated)
        );
        assert_eq!(
            classify(r#"{"type":"desktop:heartbeat:ack","serverTime":"x"}"#),
            Some(Incoming::HeartbeatAck)
        );
        assert_eq!(
            classify(r#"{"type":"desktop:revoked","message":"removed"}"#),
            Some(Incoming::Revoked("removed".into()))
        );
        assert_eq!(classify(r#"{"type":"desktop:update"}"#), Some(Incoming::Update));
        assert_eq!(
            classify(r#"{"type":"desktop:repoint","instruction":"a.b.c","node":"master-x","name":"Kasa"}"#),
            Some(Incoming::Repoint { instruction: "a.b.c".into(), name: "Kasa".into() })
        );
        assert_eq!(classify(r#"{"type":"desktop:moved","node":"master-x","name":"Kasa"}"#), Some(Incoming::Moved { name: "Kasa".into() }));
        // A re-point with no instruction is nothing to follow.
        assert_eq!(classify(r#"{"type":"desktop:repoint","name":"Kasa"}"#), None);
        assert_eq!(
            classify(r#"{"type":"desktop:error","code":"unauthenticated"}"#),
            Some(Incoming::Refused("unauthenticated".into()))
        );
        // The code is for the log only: an error that names none is as much of a refusal.
        assert_eq!(classify(r#"{"type":"desktop:error"}"#), Some(Incoming::Refused("desktop:error".into())));
    }

    #[test]
    fn a_revocation_without_a_message_still_revokes() {
        // The shell must not require a field to act on the one notice that matters.
        assert_eq!(classify(r#"{"type":"desktop:revoked"}"#), Some(Incoming::Revoked(String::new())));
    }

    #[test]
    fn rubbish_is_ignored_rather_than_crashing_the_socket() {
        assert!(classify("not json").is_none());
        assert!(classify("{}").is_none());
        assert!(classify(r#"{"type":"something:else"}"#).is_none());
        assert!(classify(r#"{"type":123}"#).is_none());
    }

    #[test]
    fn unknown_is_not_unreachable() {
        // ⚠ The Overview renders these differently and an operator reads them out loud. "Not
        // checked yet" and "unreachable" are different answers to "is the server up?".
        let s = LinkState::default();
        assert_eq!(s.get(), Link::Unknown);
        assert_eq!(Link::Unknown.as_str(), "unknown");
        assert_ne!(Link::Unknown.as_str(), Link::Unreachable.as_str());
    }

    #[test]
    fn setting_the_same_link_twice_reports_no_change() {
        let s = LinkState::default();
        assert!(s.set(Link::Connected));
        assert!(!s.set(Link::Connected), "a repeat must not look like a transition");
        assert!(s.set(Link::Unreachable));
    }

    #[test]
    fn a_ring_takes_the_run_out_of_its_wait() {
        // #767. Retry now, or the window's probe or the bridge finding the server, ends presence's
        // wait: it used to take a flag that the window's loop could take first, and nothing at all
        // woke it when another loop found the server (12 s behind the window in a CI smoke, 25 to
        // 55 s behind the bridge on the shop lanes). What `a_nudge_is_consumed_once` held, that a
        // ring wakes each waiter once and not for ever, is `wake::tests` now.
        //
        // On a clean runner the first try fails `NotConfigured` and the wait is a minute, so a run
        // that missed the ring fails the 20 s below. On an enrolled machine it fails `Unreachable`
        // and waits 2 s, and the test proves less there.
        use std::sync::atomic::AtomicBool;
        use std::sync::mpsc;

        let state = Arc::new(LinkState::default());
        let wake = Arc::new(Wake::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let handle = {
            let (state, wake, stop) = (state.clone(), wake.clone(), stop.clone());
            std::thread::spawn(move || {
                run("http://127.0.0.1:1".to_string(), state, wake, stop, move |event| {
                    if let Event::Disconnected(..) = event {
                        let _ = tx.send(Instant::now());
                    }
                })
            })
        };

        rx.recv_timeout(Duration::from_secs(20)).expect("the first try ends");
        // Now in its wait.
        std::thread::sleep(Duration::from_millis(300));
        let rung = Instant::now();
        wake.ring();
        let again = rx.recv_timeout(Duration::from_secs(20)).expect("tried again after the ring, not after its minute");
        assert!(again.duration_since(rung) < Duration::from_secs(10), "tried again {:?} after the ring", again.duration_since(rung));

        stop.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(20);
        while !handle.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(handle.is_finished(), "the run did not exit after its stop flag was set");
        handle.join().unwrap();
    }
}
