//! C11 — the presence socket (FR-14.21) and the server link state C10's Overview reads.
//!
//! ⚠ **The credential is the FIRST MESSAGE, never the URL.** A URL ends up in ingress logs,
//! proxy logs and crash reports — that is what S-05 was, and `/ws/tasks` still does it with a
//! `?userId=` parameter, which this endpoint exists not to copy. The server closes a socket
//! that has not authenticated within 10 s.
//!
//! ⚠ **One background thread, blocking.** The shell has no async runtime since local mode was
//! retired, and adding one for a single socket that sends a message every 30 s would be a
//! dependency and a scheduler for nothing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tungstenite::Message;

use crate::enroll;

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
#[derive(Default)]
pub struct LinkState {
    link: Mutex<LinkInner>,
    /// Set when something wants the retry loop to stop waiting and probe now.
    nudge: AtomicBool,
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

    /// Ask the retry loop to probe immediately (the unreachable page's **Retry now**).
    pub fn nudge(&self) {
        self.nudge.store(true, Ordering::SeqCst);
    }

    fn take_nudge(&self) -> bool {
        self.nudge.swap(false, Ordering::SeqCst)
    }

    /// The retry loop in `web.rs` consumes the same nudge, so **Retry now** works whether the
    /// socket or the unreachable page is the thing waiting.
    pub fn take_nudge_public(&self) -> bool {
        self.take_nudge()
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

/// Is the server answering? A cheap, unauthenticated probe.
///
/// ⚠ Any HTTP answer counts, including 401 and 404. The question is "is there a server there",
/// not "does it like us" — a login page that returns 401 is a reachable server, and treating it
/// as down would strand a till behind a perfectly healthy hub.
pub fn probe(server_url: &str) -> bool {
    let url = format!("{}/api/health", server_url.trim_end_matches('/'));
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent(concat!("lgr-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
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
    Disconnected,
}

/// Run the presence socket until `stop` is set. Intended for a dedicated thread.
///
/// Reconnects with the same backoff as the retry loop; a socket that fails to authenticate is
/// closed by the server, and this treats that as `SignedOut` rather than retrying forever with a
/// credential the server has already refused.
pub fn run(
    server_url: String,
    state: Arc<LinkState>,
    stop: Arc<AtomicBool>,
    mut on_event: impl FnMut(Event),
) {
    let mut attempt = 0u32;

    while !stop.load(Ordering::SeqCst) {
        match connect_once(&server_url, &state, &stop, &mut on_event) {
            Outcome::Closed => {
                attempt = 0;
                on_event(Event::Disconnected);
            }
            Outcome::Unreachable => {
                state.set(Link::Unreachable);
                on_event(Event::Disconnected);
                attempt = attempt.saturating_add(1);
            }
            Outcome::Refused => {
                // ⚠ Do NOT retry in a tight loop with a credential the server refused. The row
                // is the revocation list; hammering it is noise in the audit log and nothing else.
                state.set(Link::SignedOut);
                on_event(Event::Disconnected);
                attempt = 6; // ~60 s between attempts from here on
            }
        }

        let wait = backoff_secs(attempt);
        for _ in 0..(wait * 10) {
            if stop.load(Ordering::SeqCst) || state.take_nudge() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

enum Outcome {
    Closed,
    Unreachable,
    Refused,
}

fn ws_url(server_url: &str) -> Option<String> {
    let base = server_url.trim_end_matches('/');
    let rest = base.strip_prefix("https://").map(|r| ("wss://", r))
        .or_else(|| base.strip_prefix("http://").map(|r| ("ws://", r)))?;
    Some(format!("{}{}/ws/desktop", rest.0, rest.1))
}

fn connect_once(
    server_url: &str,
    state: &Arc<LinkState>,
    stop: &Arc<AtomicBool>,
    on_event: &mut impl FnMut(Event),
) -> Outcome {
    // A token first: it is the socket's credential, and failing to mint one tells us which of
    // "unreachable" and "refused" this is before any socket exists.
    let token = match enroll::mint_token(server_url) {
        Ok(t) => t,
        Err(e) => {
            let msg = e.to_string();
            if msg == "desktop_revoked" {
                on_event(Event::Revoked(msg));
                return Outcome::Refused;
            }
            return if msg == "server_unreachable" || msg == "server_timeout" {
                Outcome::Unreachable
            } else {
                Outcome::Refused
            };
        }
    };

    let Some(url) = ws_url(server_url) else { return Outcome::Refused };
    let (mut socket, _) = match tungstenite::connect(&url) {
        Ok(pair) => pair,
        Err(_) => return Outcome::Unreachable,
    };

    // ⚠ FIRST message, within the server's 10 s deadline, and never in the URL.
    if socket
        .send(Message::Text(
            serde_json::json!({ "type": "desktop:auth", "token": token }).to_string(),
        ))
        .is_err()
    {
        return Outcome::Unreachable;
    }

    let mut last_beat = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            return Outcome::Closed;
        }

        // FR-14.21 — a 30 s heartbeat carrying this machine's wall clock, so the hub can record
        // `clockSkewMs` and an admin can SEE a till whose clock is wrong.
        if last_beat.elapsed() >= Duration::from_secs(30) {
            let now = chrono::Utc::now().to_rfc3339();
            if socket
                .send(Message::Text(
                    serde_json::json!({ "type": "desktop:heartbeat", "clientTime": now }).to_string(),
                ))
                .is_err()
            {
                return Outcome::Unreachable;
            }
            last_beat = Instant::now();
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                match classify(&text) {
                    Some(Incoming::Authenticated) => {
                        state.set(Link::Connected);
                        on_event(Event::Authenticated);
                    }
                    Some(Incoming::Revoked(msg)) => {
                        on_event(Event::Revoked(msg));
                        let _ = socket.close(None);
                        return Outcome::Refused;
                    }
                    Some(Incoming::Update) => on_event(Event::UpdateRequested),
                    Some(Incoming::Refused) => {
                        let _ = socket.close(None);
                        return Outcome::Refused;
                    }
                    Some(Incoming::HeartbeatAck) | None => {}
                }
            }
            Ok(Message::Close(_)) => return Outcome::Closed,
            Ok(_) => {}
            Err(_) => return Outcome::Unreachable,
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
    Refused,
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
        // ⚠ `desktop:error` with `unauthenticated` is the revocation path's quieter sibling: the
        // credential was refused, so retrying with it is pointless.
        "desktop:error" => Some(Incoming::Refused),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            classify(r#"{"type":"desktop:error","code":"unauthenticated"}"#),
            Some(Incoming::Refused)
        );
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
    fn a_nudge_is_consumed_once() {
        let s = LinkState::default();
        assert!(!s.take_nudge());
        s.nudge();
        assert!(s.take_nudge());
        assert!(!s.take_nudge(), "Retry now must not fire for ever");
    }
}
