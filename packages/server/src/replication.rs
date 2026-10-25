//! The mirror's sender, the supervisor's side (FR-20.64, FR-20.67, plan step P3-2b, Part A.6.4).
//!
//! On the bulk socket, a registered master linked at Full sends every org it is home of to
//! lgrai.app's mirror, page by page:
//! - **The API builds each page** over its control socket (`POST /replication/page`), from where
//!   global said the mirror stands. The supervisor sends the bytes as one binary frame and never reads
//!   them: nothing it says decides what a page holds.
//! - **One page in flight per org.** Global answers `page-ack` (the new watermark and chain hash, and
//!   documents to resend after a collision), `page-refused` (why, and where the mirror stands), or
//!   `page-error`. An answer that never comes is given up after a minute and the page built again
//!   from the last acknowledged point: global acknowledges what it already holds.
//! - **Refusals by kind.** Behind or ahead of the mirror: again, from where global says. Another
//!   history (a restore, a revert, a clone), another journal or instance epoch, or a chain this master
//!   never built: that org stops, loudly, because a re-seed or a reconcile (P3-7) is a person's call.
//!   Anything else waits ten minutes.
//! - Nothing to send: look again in two seconds.

use anyhow::{anyhow, Result};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::control;
use crate::uplink::{now_iso, Status};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the API answers for a page.
#[derive(Debug, PartialEq, Eq)]
pub enum Built {
    Page { bytes: Vec<u8>, to_seq: u64 },
    Empty,
    Refused { reason: String, detail: String },
}

/// Where pages come from and resends go: the API, over its control socket.
pub trait PageSource: Send + Sync {
    fn page<'a>(&'a self, org: &'a str, after: u64, after_hash: &'a str) -> BoxFut<'a, Result<Built>>;
    /// Global's resend, passed through as it came: the ids are EJSON, typed, and stay unread here.
    fn resend<'a>(&'a self, ask: serde_json::Value) -> BoxFut<'a, Result<()>>;
}

/// A page decodes to at most 20 MB, and is smaller on the wire.
const PAGE_MAX: usize = 24 << 20;
/// A page of 1,000 documents is read in one snapshot; the API allows a minute for it.
const PAGE_WAIT: Duration = Duration::from_secs(75);

/// The API's control socket.
pub struct ApiPages {
    socket: PathBuf,
    secret: String,
}

impl ApiPages {
    pub fn new(socket: PathBuf, secret: String) -> Self {
        Self { socket, secret }
    }
}

impl PageSource for ApiPages {
    fn page<'a>(&'a self, org: &'a str, after: u64, after_hash: &'a str) -> BoxFut<'a, Result<Built>> {
        Box::pin(async move {
            let ask = serde_json::json!({ "orgId": org, "after": after, "afterHash": after_hash }).to_string();
            let r = control::call_with(&self.socket, &self.secret, "POST", "/replication/page", Some(ask.as_bytes()), PAGE_WAIT, PAGE_MAX).await?;
            match r.code {
                200 => {
                    let to_seq = r.header("x-lgr-page-to").and_then(|v| v.parse::<u64>().ok()).ok_or_else(|| anyhow!("the API sent a page without where it ends"))?;
                    Ok(Built::Page { bytes: r.body, to_seq })
                }
                204 => Ok(Built::Empty),
                409 => {
                    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap_or_default();
                    Ok(Built::Refused { reason: v["refused"].as_str().unwrap_or("refused").into(), detail: v["detail"].as_str().unwrap_or("").into() })
                }
                code => Err(anyhow!("the API answered {code} for a page: {}", String::from_utf8_lossy(&r.body).chars().take(200).collect::<String>())),
            }
        })
    }

    fn resend<'a>(&'a self, ask: serde_json::Value) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            let body = ask.to_string();
            let r = control::call_with(&self.socket, &self.secret, "POST", "/replication/resend", Some(body.as_bytes()), Duration::from_secs(30), control::JSON_MAX).await?;
            if r.code == 200 {
                Ok(())
            } else {
                Err(anyhow!("the API answered {} for a resend: {}", r.code, String::from_utf8_lossy(&r.body).chars().take(200).collect::<String>()))
            }
        })
    }
}

/// Where one org starts: global's watermark and the chain hash it holds there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Start {
    pub org: String,
    pub after: u64,
    pub after_hash: String,
}

/// The orgs this master sends, from global's bulk `welcome`: those it is home of, linked at Full, in
/// a state its home still writes in, from where each mirror stands (FR-20.67).
pub fn starts(orgs: &serde_json::Value, node_id: &str) -> Vec<Start> {
    orgs.as_array()
        .into_iter()
        .flatten()
        .filter(|o| o["home"].as_str() == Some(node_id) && o["linkLevel"].as_str() == Some("full"))
        .filter(|o| matches!(o["state"].as_str(), None | Some("active" | "freezing" | "frozen")))
        .filter_map(|o| {
            let org = o["orgId"].as_str()?.to_string();
            let hash = o["mirror"]["chainHash"].as_str().unwrap_or("").to_string();
            // A watermark without its hash cannot be continued: from the start, and global will say.
            let after = if hash.is_empty() { 0 } else { o["mirror"]["watermark"].as_u64().unwrap_or(0) };
            Some(Start { org, after, after_hash: if after == 0 { String::new() } else { hash } })
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct PumpTiming {
    /// Nothing to send: look again after this.
    pub idle: Duration,
    /// The API unreachable, or global's own error: again after this.
    pub retry: Duration,
    /// The org's journal not whole yet (its seeding runs).
    pub not_ready: Duration,
    /// Refused for a reason that a resend will not change.
    pub pause: Duration,
    /// No answer for a page: built again from the last acknowledged point.
    pub ack_timeout: Duration,
}

impl Default for PumpTiming {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(2),
            retry: Duration::from_secs(5),
            not_ready: Duration::from_secs(10),
            pause: Duration::from_secs(600),
            ack_timeout: Duration::from_secs(60),
        }
    }
}

/// Refusals a resend will never change: another history or epoch. The org waits for a person (P3-7).
const STOPPING: &[&str] = &["diverged", "instance_changed", "stale_journal", "reconcile_required", "epoch_changed", "chain_unknown"];

struct Org {
    id: String,
    after: u64,
    hash: String,
    in_flight: Option<(u64, Instant)>,
    next: Instant,
    stopped: Option<String>,
    sent: u64,
    acked_at: Option<String>,
    last_refusal: Option<String>,
}

fn stop(o: &mut Org, reason: &str, detail: &str) {
    tracing::error!(org = %o.id, reason, detail, "the mirror cannot continue this org's history; it waits for a re-seed or a reconcile (an administrator's decision)");
    o.stopped = Some(reason.to_string());
    o.in_flight = None;
}

fn report(orgs: &[Org], status: &Status) {
    let v: serde_json::Map<String, serde_json::Value> = orgs
        .iter()
        .map(|o| {
            (o.id.clone(), serde_json::json!({
                "watermark": o.after,
                "inFlight": o.in_flight.map(|(s, _)| s),
                "sent": o.sent,
                "lastAckAt": o.acked_at,
                "lastRefusal": o.last_refusal,
                "stopped": o.stopped,
            }))
        })
        .collect();
    crate::uplink::patch(status, "bulk", "replication", serde_json::Value::Object(v));
}

/// What global answered for a page: the watermarks move, or the org waits.
async fn answer(orgs: &mut [Org], v: &serde_json::Value, source: &dyn PageSource, t: PumpTiming) {
    let Some(id) = v["orgId"].as_str() else {
        tracing::warn!(detail = v["detail"].as_str().unwrap_or(""), "global could not read a page");
        return;
    };
    let Some(o) = orgs.iter_mut().find(|o| o.id == id) else { return };
    let now = Instant::now();
    match v["t"].as_str() {
        Some("page-ack") => {
            if let (Some(w), Some(h)) = (v["watermark"].as_u64(), v["chainHash"].as_str()) {
                o.after = w;
                o.hash = h.to_string();
            }
            o.in_flight = None;
            o.next = now;
            o.acked_at = Some(now_iso());
            o.last_refusal = None;
            for r in v["resend"].as_array().into_iter().flatten() {
                let ask = serde_json::json!({ "orgId": id, "coll": r["coll"], "ids": r["ids"] });
                if let Err(e) = source.resend(ask).await {
                    tracing::warn!(org = id, error = %format!("{e:#}"), "a document global asked for again was not journaled; the next collision asks again");
                }
            }
        }
        Some("page-refused") => {
            o.in_flight = None;
            let reason = v["reason"].as_str().unwrap_or("refused");
            o.last_refusal = Some(reason.to_string());
            match reason {
                // The mirror is elsewhere than this master thought: from there.
                "behind" | "gap" => {
                    if let (Some(w), Some(h)) = (v["watermark"].as_u64(), v["chainHash"].as_str()) {
                        o.after = w;
                        o.hash = h.to_string();
                    }
                    o.next = now;
                }
                r if STOPPING.contains(&r) => stop(o, r, v["detail"].as_str().unwrap_or("")),
                r => {
                    tracing::warn!(org = id, reason = r, detail = v["detail"].as_str().unwrap_or(""), "global refused a page; this org waits {} s", t.pause.as_secs());
                    o.next = now + t.pause;
                }
            }
        }
        Some("page-error") => {
            o.in_flight = None;
            o.next = now + t.retry;
        }
        _ => {}
    }
}

/// Send the orgs' pages until the socket ends: `out` is the session's, `answers` global's frames.
pub async fn pump(starts: Vec<Start>, source: Arc<dyn PageSource>, out: mpsc::Sender<Vec<u8>>, mut answers: mpsc::UnboundedReceiver<serde_json::Value>, status: Status, t: PumpTiming) {
    let now = Instant::now();
    let mut orgs: Vec<Org> = starts
        .into_iter()
        .map(|s| Org { id: s.org, after: s.after, hash: s.after_hash, in_flight: None, next: now, stopped: None, sent: 0, acked_at: None, last_refusal: None })
        .collect();
    loop {
        // Global's answers move the watermarks before anything is built from them.
        loop {
            match answers.try_recv() {
                Ok(v) => answer(&mut orgs, &v, &*source, t).await,
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return,
            }
        }
        let now = Instant::now();
        for o in orgs.iter_mut() {
            if let Some((to, sent)) = o.in_flight {
                if now.duration_since(sent) >= t.ack_timeout {
                    tracing::warn!(org = %o.id, to_seq = to, "no answer for a page within {} s; it is built again", t.ack_timeout.as_secs());
                    o.in_flight = None;
                    o.next = now;
                }
            }
        }
        report(&orgs, &status);

        if let Some(i) = orgs.iter().position(|o| o.stopped.is_none() && o.in_flight.is_none() && o.next <= now) {
            let (id, after, hash) = (orgs[i].id.clone(), orgs[i].after, orgs[i].hash.clone());
            match source.page(&id, after, &hash).await {
                Ok(Built::Page { bytes, to_seq }) => {
                    if out.send(bytes).await.is_err() {
                        return; // the socket is gone; the next session starts from what global says
                    }
                    orgs[i].in_flight = Some((to_seq, Instant::now()));
                    orgs[i].sent += 1;
                }
                Ok(Built::Empty) => orgs[i].next = Instant::now() + t.idle,
                Ok(Built::Refused { reason, detail }) => {
                    if STOPPING.contains(&reason.as_str()) {
                        stop(&mut orgs[i], &reason, &detail);
                    } else {
                        let wait = if reason == "not_ready" { t.not_ready } else { t.pause };
                        if reason != "not_ready" {
                            tracing::warn!(org = %id, reason, detail, "the API built no page; this org waits {} s", wait.as_secs());
                        }
                        orgs[i].next = Instant::now() + wait;
                    }
                }
                Err(e) => {
                    tracing::warn!(org = %id, error = %format!("{e:#}"), "no page from the API; again in {} s", t.retry.as_secs());
                    orgs[i].next = Instant::now() + t.retry;
                }
            }
            continue;
        }

        // Nothing due: an answer, or the first org that comes due, whichever is first.
        let wake = orgs
            .iter()
            .filter(|o| o.stopped.is_none())
            .map(|o| match o.in_flight {
                Some((_, sent)) => sent + t.ack_timeout,
                None => o.next,
            })
            .min();
        match wake {
            Some(at) => {
                tokio::select! {
                    a = answers.recv() => match a {
                        Some(v) => answer(&mut orgs, &v, &*source, t).await,
                        None => return,
                    },
                    _ = tokio::time::sleep_until(at.into()) => {}
                }
            }
            // Every org stopped: only the end of the socket matters now.
            None => match answers.recv().await {
                Some(v) => answer(&mut orgs, &v, &*source, t).await,
                None => return,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The API, scripted: each ask takes the next answer, and every ask and resend is kept.
    struct Script {
        answers: Mutex<Vec<Built>>,
        asked: Mutex<Vec<(String, u64, String)>>,
        resent: Mutex<Vec<serde_json::Value>>,
    }

    impl Script {
        fn new(answers: Vec<Built>) -> Arc<Self> {
            Arc::new(Self { answers: Mutex::new(answers.into_iter().rev().collect()), asked: Mutex::new(vec![]), resent: Mutex::new(vec![]) })
        }
    }

    impl PageSource for Script {
        fn page<'a>(&'a self, org: &'a str, after: u64, after_hash: &'a str) -> BoxFut<'a, Result<Built>> {
            Box::pin(async move {
                self.asked.lock().unwrap().push((org.to_string(), after, after_hash.to_string()));
                Ok(self.answers.lock().unwrap().pop().unwrap_or(Built::Empty))
            })
        }
        fn resend<'a>(&'a self, ask: serde_json::Value) -> BoxFut<'a, Result<()>> {
            Box::pin(async move {
                self.resent.lock().unwrap().push(ask);
                Ok(())
            })
        }
    }

    fn quick() -> PumpTiming {
        PumpTiming { idle: Duration::from_millis(30), retry: Duration::from_millis(30), not_ready: Duration::from_millis(30), pause: Duration::from_secs(600), ack_timeout: Duration::from_millis(400) }
    }

    fn page(bytes: &[u8], to_seq: u64) -> Built {
        Built::Page { bytes: bytes.to_vec(), to_seq }
    }

    fn status() -> Status {
        Arc::new(Mutex::new(serde_json::json!({ "bulk": { "state": "connected" } })))
    }

    struct Harness {
        out: mpsc::Receiver<Vec<u8>>,
        answers: mpsc::UnboundedSender<serde_json::Value>,
        task: tokio::task::JoinHandle<()>,
        status: Status,
    }

    fn start(starts: Vec<Start>, script: Arc<Script>) -> Harness {
        let (out_tx, out) = mpsc::channel(1);
        let (answers, ans_rx) = mpsc::unbounded_channel();
        let status = status();
        let task = tokio::spawn(pump(starts, script, out_tx, ans_rx, status.clone(), quick()));
        Harness { out, answers, task, status }
    }

    async fn sent(h: &mut Harness) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(3), h.out.recv()).await.expect("a page in time").expect("the pump is running")
    }

    fn org(id: &str) -> Start {
        Start { org: id.into(), after: 0, after_hash: String::new() }
    }

    #[test]
    fn only_orgs_homed_here_and_linked_at_full_are_sent_from_where_the_mirror_stands() {
        let welcome = serde_json::json!([
            { "orgId": "a", "home": "master-me", "linkLevel": "full", "state": "active", "mirror": { "watermark": 12, "chainHash": "h12" } },
            { "orgId": "b", "home": "master-me", "linkLevel": "control", "state": "active", "mirror": { "watermark": 0, "chainHash": "" } },
            { "orgId": "c", "home": "global", "linkLevel": "full", "state": "active" },
            { "orgId": "d", "home": "master-me", "linkLevel": "full", "state": "fenced" },
            { "orgId": "e", "home": "master-me", "linkLevel": "full", "state": "frozen", "mirror": { "watermark": 7, "chainHash": "" } },
        ]);
        assert_eq!(
            starts(&welcome, "master-me"),
            vec![
                Start { org: "a".into(), after: 12, after_hash: "h12".into() },
                // Its watermark came without a hash: from the start, and global says where it is.
                Start { org: "e".into(), after: 0, after_hash: String::new() },
            ]
        );
    }

    #[tokio::test]
    async fn a_page_goes_out_and_the_next_is_built_from_what_global_acknowledged() {
        let script = Script::new(vec![page(b"p1", 5), page(b"p2", 9)]);
        let mut h = start(vec![org("a")], script.clone());
        assert_eq!(sent(&mut h).await, b"p1");
        h.answers.send(serde_json::json!({ "t": "page-ack", "orgId": "a", "toSeq": 5, "watermark": 5, "chainHash": "h5", "resend": [] })).unwrap();
        assert_eq!(sent(&mut h).await, b"p2");
        let asked = script.asked.lock().unwrap().clone();
        assert_eq!(asked[..2], [("a".into(), 0, String::new()), ("a".into(), 5, "h5".into())]);
        let s = h.status.lock().unwrap()["bulk"]["replication"]["a"].clone();
        assert_eq!((s["watermark"].as_u64(), s["inFlight"].as_u64(), s["sent"].as_u64()), (Some(5), Some(9), Some(2)), "{s}");
        h.task.abort();
    }

    #[tokio::test]
    async fn one_page_in_flight_per_org_and_nothing_to_send_is_looked_at_again() {
        let script = Script::new(vec![page(b"a1", 3), Built::Empty, Built::Empty, page(b"b1", 4)]);
        let mut h = start(vec![org("a"), org("b")], script.clone());
        assert_eq!(sent(&mut h).await, b"a1");
        // b had nothing twice, then a page: a's is still unanswered, so nothing more is built for a.
        assert_eq!(sent(&mut h).await, b"b1");
        let asked: Vec<String> = script.asked.lock().unwrap().iter().map(|(o, ..)| o.clone()).collect();
        assert_eq!(asked, vec!["a", "b", "b", "b"]);
        h.task.abort();
    }

    #[tokio::test]
    async fn behind_or_ahead_starts_again_from_where_global_says() {
        let script = Script::new(vec![page(b"old", 4), page(b"new", 30)]);
        let mut h = start(vec![org("a")], script.clone());
        assert_eq!(sent(&mut h).await, b"old");
        h.answers.send(serde_json::json!({ "t": "page-refused", "orgId": "a", "reason": "behind", "watermark": 20, "chainHash": "h20" })).unwrap();
        assert_eq!(sent(&mut h).await, b"new");
        assert_eq!(script.asked.lock().unwrap()[1], ("a".into(), 20, "h20".into()));
        h.task.abort();
    }

    #[tokio::test]
    async fn another_history_stops_that_org_alone_and_the_status_says_so() {
        let script = Script::new(vec![page(b"a1", 3), page(b"b1", 3), page(b"b2", 6)]);
        let mut h = start(vec![org("a"), org("b")], script.clone());
        assert_eq!(sent(&mut h).await, b"a1");
        assert_eq!(sent(&mut h).await, b"b1");
        h.answers.send(serde_json::json!({ "t": "page-refused", "orgId": "a", "reason": "diverged", "detail": "another chain", "watermark": 9, "chainHash": "x" })).unwrap();
        h.answers.send(serde_json::json!({ "t": "page-ack", "orgId": "b", "watermark": 3, "chainHash": "hb3" })).unwrap();
        assert_eq!(sent(&mut h).await, b"b2");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let asked: Vec<String> = script.asked.lock().unwrap().iter().map(|(o, ..)| o.clone()).collect();
        assert_eq!(asked.iter().filter(|o| *o == "a").count(), 1, "a is never asked for again: {asked:?}");
        let s = h.status.lock().unwrap()["bulk"]["replication"].clone();
        assert_eq!(s["a"]["stopped"].as_str(), Some("diverged"), "{s}");
        assert!(s["b"]["stopped"].is_null());
        h.task.abort();
    }

    #[tokio::test]
    async fn a_resend_is_passed_to_the_api_untouched_and_an_unanswered_page_is_built_again() {
        let script = Script::new(vec![page(b"p1", 5), page(b"p2", 8), page(b"p2-again", 8)]);
        let mut h = start(vec![org("a")], script.clone());
        assert_eq!(sent(&mut h).await, b"p1");
        let ids = serde_json::json!([{ "$oid": "6ade5353186e43aac3da598c" }]);
        h.answers.send(serde_json::json!({ "t": "page-ack", "orgId": "a", "watermark": 5, "chainHash": "h5", "resend": [{ "coll": "accounts", "ids": ids }] })).unwrap();
        assert_eq!(sent(&mut h).await, b"p2");
        assert_eq!(script.resent.lock().unwrap().clone(), vec![serde_json::json!({ "orgId": "a", "coll": "accounts", "ids": ids })]);
        // No answer for p2: after the timeout it is built again, from the last acknowledged point.
        assert_eq!(sent(&mut h).await, b"p2-again");
        assert_eq!(script.asked.lock().unwrap()[2], ("a".into(), 5, "h5".into()));
        h.task.abort();
    }

    #[tokio::test]
    async fn a_chain_the_api_never_built_stops_the_org_and_the_end_of_the_socket_ends_the_pump() {
        let script = Script::new(vec![Built::Refused { reason: "chain_unknown".into(), detail: "no such page".into() }]);
        let h = start(vec![org("a")], script.clone());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(h.status.lock().unwrap()["bulk"]["replication"]["a"]["stopped"].as_str(), Some("chain_unknown"));
        assert_eq!(script.asked.lock().unwrap().len(), 1);
        drop(h.answers);
        tokio::time::timeout(Duration::from_secs(2), h.task).await.expect("the pump ends with its socket").unwrap();
    }

}
