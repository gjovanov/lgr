//! The mirror's sender, the supervisor's side (FR-20.64, FR-20.67, FR-20.69, plan steps P3-2b and
//! P3-3, Part A.6.4).
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
//!   history (a restore, a revert, a clone), another instance epoch, or a chain this master never
//!   built: that org stops, loudly, because a re-seed (P3-7d) is a person's call. A newer journal
//!   epoch is no refusal since P3-7f: global takes it, and the API reconciles the copy itself.
//!   Anything else waits ten minutes.
//! - **Paced** (FR-20.52, P3-2c): pages and chunks are asked for in pieces the shop's line sends in a
//!   moment, and spaced out by `pacing.rs`, which the interactive socket's round trips steer: what
//!   queues in front of a click on that line is what the mirror holds back for.
//! - Nothing to send: look again in two seconds.
//!
//! **The files** (FR-20.69, P3-3) travel behind the documents, on the same socket, for an org whose
//! welcome says `files: all` (an org that chose metadata only says `metadata`):
//! - When an org's pages are caught up, the supervisor asks `blob-sync`. Global answers `blob-want`:
//!   the files ITS rows of that org name and it does not hold, with where each one resumes. It never
//!   answers from anything the master lists, so an answer cannot say what another org holds.
//! - Each wanted file goes out in 1 MB chunks the API reads and frames (`POST /replication/blob`), one
//!   in flight per org, each answered `blob-ack` (where global stands, `ok` once the file is whole and
//!   hashes to its name) or `blob-refused` (with where to resume, or why not). A file this server
//!   cannot send is said so (`blob-unavailable`) and global asks again hours later.
//! - Pages first: a page is always asked for before a chunk, and while files wait every other turn is
//!   theirs, so neither starves the other. Asked again after pages bring new rows (at most every 10 s),
//!   and every 10 minutes regardless.

use anyhow::{anyhow, Result};
use std::collections::VecDeque;
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

/// What the API answers for a chunk of a file global asked for (FR-20.69).
#[derive(Debug, PartialEq, Eq)]
pub enum Chunk {
    /// The frame, sent as it is; `len` of the file's bytes are in it.
    Frame { bytes: Vec<u8>, len: u64 },
    /// This server cannot send it: no row of the org names those bytes here, the bytes are not what
    /// their row says, or global holds more of it than the file has. Global is told.
    Unavailable { reason: String },
    /// The API sends no files now (not linked at Full, not the org's home): the org's files wait.
    Refused { reason: String, detail: String },
}

/// Where pages and chunks come from and resends go: the API, over its control socket.
pub trait PageSource: Send + Sync {
    fn page<'a>(&'a self, org: &'a str, after: u64, after_hash: &'a str) -> BoxFut<'a, Result<Built>>;
    /// Global's resend, passed through as it came: the ids are EJSON, typed, and stay unread here.
    fn resend<'a>(&'a self, ask: serde_json::Value) -> BoxFut<'a, Result<()>>;
    /// The chunk of `sha256` of `org` at global's `offset`, framed by the API.
    fn chunk<'a>(&'a self, _org: &'a str, _sha256: &'a str, _offset: u64) -> BoxFut<'a, Result<Chunk>> {
        Box::pin(async { Err(anyhow!("this source sends no files")) })
    }
}

/// A frame for the bulk socket: a page or a chunk (binary), or a word to global (text).
#[derive(Debug, PartialEq, Eq)]
pub enum Out {
    Binary(Vec<u8>),
    Text(String),
}

/// A page decodes to at most 20 MB, and is smaller on the wire.
const PAGE_MAX: usize = 24 << 20;
/// A page of 1,000 documents is read in one snapshot; the API allows a minute for it.
const PAGE_WAIT: Duration = Duration::from_secs(75);
/// A chunk is at most 1 MB of the file, behind a header of at most 1 KB.
const CHUNK_MAX: usize = (1 << 20) + 4096;
/// The first chunk of a file is read after the whole file is hashed: an archive unit may be large.
const CHUNK_WAIT: Duration = Duration::from_secs(75);

/// The API's control socket.
pub struct ApiPages {
    socket: PathBuf,
    secret: String,
    /// FR-20.52: pages and chunks asked for in pieces the line sends in a moment.
    pacer: Option<Arc<crate::pacing::Pacer>>,
}

impl ApiPages {
    pub fn new(socket: PathBuf, secret: String, pacer: Option<Arc<crate::pacing::Pacer>>) -> Self {
        Self { socket, secret, pacer }
    }
}

impl PageSource for ApiPages {
    fn page<'a>(&'a self, org: &'a str, after: u64, after_hash: &'a str) -> BoxFut<'a, Result<Built>> {
        Box::pin(async move {
            let mut ask = serde_json::json!({ "orgId": org, "after": after, "afterHash": after_hash });
            // An API before P3-2c ignores it, and sends its pages whole.
            if let Some(p) = &self.pacer {
                ask["maxBytes"] = p.piece().into();
            }
            let ask = ask.to_string();
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

    fn chunk<'a>(&'a self, org: &'a str, sha256: &'a str, offset: u64) -> BoxFut<'a, Result<Chunk>> {
        Box::pin(async move {
            let mut ask = serde_json::json!({ "orgId": org, "sha256": sha256, "offset": offset });
            if let Some(p) = &self.pacer {
                ask["length"] = p.piece().into();
            }
            let ask = ask.to_string();
            let r = control::call_with(&self.socket, &self.secret, "POST", "/replication/blob", Some(ask.as_bytes()), CHUNK_WAIT, CHUNK_MAX).await?;
            match r.code {
                200 => {
                    let len = r.header("x-lgr-blob-length").and_then(|v| v.parse::<u64>().ok()).ok_or_else(|| anyhow!("the API sent a chunk without its length"))?;
                    Ok(Chunk::Frame { bytes: r.body, len })
                }
                404 => Ok(Chunk::Unavailable { reason: "missing".into() }),
                409 => {
                    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap_or_default();
                    let reason = v["refused"].as_str().unwrap_or("refused").to_string();
                    if matches!(reason.as_str(), "hash_mismatch" | "offset_beyond") {
                        Ok(Chunk::Unavailable { reason })
                    } else {
                        Ok(Chunk::Refused { reason, detail: v["detail"].as_str().unwrap_or("").into() })
                    }
                }
                code => Err(anyhow!("the API answered {code} for a chunk: {}", String::from_utf8_lossy(&r.body).chars().take(200).collect::<String>())),
            }
        })
    }
}

/// Where one org starts: global's watermark and the chain hash it holds there, and whether its
/// files travel too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Start {
    pub org: String,
    pub after: u64,
    pub after_hash: String,
    pub files: bool,
}

/// The orgs this master sends, from global's bulk `welcome`: those it is home of, linked at Full, in
/// a state its home still writes in, from where each mirror stands (FR-20.67). Files only where the
/// welcome says `files: all`: a global that does not say so takes none.
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
            let files = o["files"].as_str() == Some("all");
            Some(Start { org, after, after_hash: if after == 0 { String::new() } else { hash }, files })
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
    /// No answer for a page, a chunk or an ask: again from the last acknowledged point.
    pub ack_timeout: Duration,
    /// After pages brought new rows, the files are asked about again, at most this often.
    pub files_resync: Duration,
    /// And this often regardless (files global waits on, a transfer it gave up on for now).
    pub files_idle: Duration,
}

impl Default for PumpTiming {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(2),
            retry: Duration::from_secs(5),
            not_ready: Duration::from_secs(10),
            pause: Duration::from_secs(600),
            ack_timeout: Duration::from_secs(60),
            files_resync: Duration::from_secs(10),
            files_idle: Duration::from_secs(600),
        }
    }
}

/// Refusals a resend will never change: another history or epoch. The org waits for a person (P3-7d).
/// (`reconcile_required` is only ever said by a global before P3-7f, which reconciles by itself now.)
const STOPPING: &[&str] = &["diverged", "instance_changed", "stale_journal", "reconcile_required", "epoch_changed", "chain_unknown"];

/// Refusals of the API's own that pass by themselves within seconds: the org's seeding runs, or the
/// API has not yet seen what global's welcome says. ⚠ The API reads the link level and the home
/// through five-second caches, so right after a registration at Full it may still say `not_full`:
/// waiting the ten minutes of other refusals there stalled the mirror's first pages.
const LAGGING: &[&str] = &["not_ready", "not_full", "not_home"];

/// What an org has on the socket and waits an answer for: one thing at a time.
#[derive(Debug, Clone)]
enum InFlight {
    Page { to_seq: u64, sent: Instant },
    /// `blob-sync`: which of the org's files does the mirror lack?
    Sync { sent: Instant },
    Chunk { sha: String, sent: Instant },
}

impl InFlight {
    fn sent(&self) -> Instant {
        match self {
            InFlight::Page { sent, .. } | InFlight::Sync { sent } | InFlight::Chunk { sent, .. } => *sent,
        }
    }
}

/// A file global asked for, and where it resumes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Want {
    sha: String,
    offset: u64,
}

/// An org's files on this session.
#[derive(Debug, Default)]
struct Files {
    on: bool,
    queue: VecDeque<Want>,
    /// Global named some of what it lacks, not all: ask again once the queue is done.
    more: bool,
    synced: Option<Instant>,
    /// Pages brought rows since the last ask: they may name files.
    dirty: bool,
    /// The next turn is the files': pages arriving all the time cannot starve them.
    turn: bool,
    /// Nothing to send files with until then (the API or global said no for now).
    paused_until: Option<Instant>,
    chunks: u64,
    held: u64,
    unavailable: u64,
    last_sync_at: Option<String>,
    last_refusal: Option<String>,
}

impl Files {
    /// Whether this org has file work now: a queued file, or an ask that is due.
    fn due(&self, now: Instant, t: PumpTiming) -> bool {
        if !self.on || self.paused_until.is_some_and(|p| now < p) {
            return false;
        }
        if !self.queue.is_empty() {
            return true;
        }
        match self.synced {
            None => true,
            Some(at) => (self.more && now >= at + t.idle) || (self.dirty && now >= at + t.files_resync) || now >= at + t.files_idle,
        }
    }

    fn front(&mut self, sha: &str) -> Option<&mut Want> {
        self.queue.front_mut().filter(|w| w.sha == sha)
    }
}

fn sha_shaped(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

struct Org {
    id: String,
    after: u64,
    hash: String,
    in_flight: Option<InFlight>,
    next: Instant,
    stopped: Option<String>,
    sent: u64,
    acked_at: Option<String>,
    last_refusal: Option<String>,
    files: Files,
}

fn stop(o: &mut Org, reason: &str, detail: &str) {
    tracing::error!(org = %o.id, reason, detail, "the mirror cannot continue this org's history; it waits for a re-seed from lgrai.app's copy (an administrator's decision)");
    o.stopped = Some(reason.to_string());
    o.in_flight = None;
}

fn report(orgs: &[Org], status: &Status) {
    let v: serde_json::Map<String, serde_json::Value> = orgs
        .iter()
        .map(|o| {
            (o.id.clone(), serde_json::json!({
                "watermark": o.after,
                "inFlight": match &o.in_flight { Some(InFlight::Page { to_seq, .. }) => serde_json::json!(to_seq), _ => serde_json::Value::Null },
                "sent": o.sent,
                "lastAckAt": o.acked_at,
                "lastRefusal": o.last_refusal,
                "stopped": o.stopped,
                "files": {
                    "on": o.files.on,
                    "queued": o.files.queue.len(),
                    "more": o.files.more,
                    "sending": match &o.in_flight { Some(InFlight::Chunk { sha, .. }) => serde_json::json!(sha), _ => serde_json::Value::Null },
                    "chunks": o.files.chunks,
                    "held": o.files.held,
                    "unavailable": o.files.unavailable,
                    "lastSyncAt": o.files.last_sync_at,
                    "lastRefusal": o.files.last_refusal,
                },
            }))
        })
        .collect();
    crate::uplink::patch(status, "bulk", "replication", serde_json::Value::Object(v));
}

/// What global answered: the watermarks move, the files go on, or the org waits.
async fn answer(orgs: &mut [Org], v: &serde_json::Value, source: &dyn PageSource, t: PumpTiming) {
    let Some(id) = v["orgId"].as_str() else {
        tracing::warn!(t = v["t"].as_str().unwrap_or(""), detail = v["detail"].as_str().unwrap_or(""), "global could not read a frame");
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
            // New rows may name files; and files waiting get the next turn.
            o.files.dirty = true;
            o.files.turn = !o.files.queue.is_empty();
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
        Some("blob-want") => {
            if matches!(o.in_flight, Some(InFlight::Sync { .. })) {
                o.in_flight = None;
            }
            o.files.synced = Some(now);
            o.files.last_sync_at = Some(now_iso());
            o.files.dirty = false;
            o.files.last_refusal = None;
            if v["files"].as_str() == Some("metadata") {
                // The org chose metadata only since this socket was welcomed.
                o.files.on = false;
                o.files.queue.clear();
            } else {
                o.files.queue = v["want"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|w| {
                        let sha = w["sha256"].as_str().filter(|s| sha_shaped(s))?;
                        Some(Want { sha: sha.to_string(), offset: w["offset"].as_u64().unwrap_or(0) })
                    })
                    .collect();
                o.files.more = v["more"].as_bool().unwrap_or(false);
            }
            o.next = now;
        }
        Some("blob-ack") => {
            let sha = v["sha256"].as_str().unwrap_or("");
            if matches!(&o.in_flight, Some(InFlight::Chunk { sha: s, .. }) if s == sha) {
                o.in_flight = None;
            }
            if v["state"].as_str() == Some("ok") {
                if o.files.front(sha).is_some() {
                    o.files.queue.pop_front();
                    o.files.held += 1;
                }
            } else if let (Some(w), Some(off)) = (o.files.front(sha), v["offset"].as_u64()) {
                w.offset = off;
            }
            o.next = now;
        }
        Some("blob-refused") => {
            let sha = v["sha256"].as_str();
            let reason = v["reason"].as_str().unwrap_or("refused");
            match (&o.in_flight, sha) {
                (Some(InFlight::Chunk { sha: s, .. }), Some(x)) if s == x => o.in_flight = None,
                (Some(InFlight::Sync { .. }), None) => o.in_flight = None,
                _ => {}
            }
            o.files.last_refusal = Some(reason.to_string());
            match reason {
                // Not where global stands: from where it says.
                "offset" => {
                    if let (Some(w), Some(off)) = (sha.and_then(|s| o.files.front(s)), v["offset"].as_u64()) {
                        w.offset = off;
                    }
                }
                "metadata_only" => {
                    o.files.on = false;
                    o.files.queue.clear();
                }
                // That file, not now: global asks for it again when it wants it.
                "not_wanted" | "hash_mismatch" | "size_changed" | "quota" => {
                    if sha.and_then(|s| o.files.front(s)).is_some() {
                        o.files.queue.pop_front();
                    }
                }
                // This socket or this node: no file goes until that changes.
                r => {
                    tracing::warn!(org = id, reason = r, detail = v["detail"].as_str().unwrap_or(""), "global takes no files from this server for this org now; they wait {} s", t.pause.as_secs());
                    o.files.queue.clear();
                    o.files.paused_until = Some(now + t.pause);
                    // Asked afresh once the wait is over.
                    o.files.synced = None;
                }
            }
            o.next = now;
        }
        Some("blob-error") => {
            if matches!(o.in_flight, Some(InFlight::Sync { .. } | InFlight::Chunk { .. })) {
                o.in_flight = None;
            }
            o.next = now + t.retry;
        }
        _ => {}
    }
}

/// One step of an org's files: the next chunk of the file at the front, or the ask for what global
/// lacks. False when the socket is gone.
async fn files_step(o: &mut Org, source: &dyn PageSource, out: &mpsc::Sender<Out>, t: PumpTiming, pacer: Option<&crate::pacing::Pacer>) -> bool {
    let now = Instant::now();
    let Some(w) = o.files.queue.front().cloned() else {
        let ask = serde_json::json!({ "t": "blob-sync", "orgId": o.id }).to_string();
        if out.send(Out::Text(ask)).await.is_err() {
            return false;
        }
        o.in_flight = Some(InFlight::Sync { sent: Instant::now() });
        return true;
    };
    match source.chunk(&o.id, &w.sha, w.offset).await {
        Ok(Chunk::Frame { bytes, .. }) => {
            if let Some(p) = pacer {
                p.take(bytes.len()).await;
            }
            if out.send(Out::Binary(bytes)).await.is_err() {
                return false;
            }
            o.in_flight = Some(InFlight::Chunk { sha: w.sha, sent: Instant::now() });
            o.files.chunks += 1;
        }
        Ok(Chunk::Unavailable { reason }) => {
            tracing::warn!(org = %o.id, sha256 = %w.sha, reason, "global asked for a file this server cannot send; it is told");
            let word = serde_json::json!({ "t": "blob-unavailable", "orgId": o.id, "sha256": w.sha, "reason": reason }).to_string();
            if out.send(Out::Text(word)).await.is_err() {
                return false;
            }
            o.files.queue.pop_front();
            o.files.unavailable += 1;
            o.next = Instant::now();
        }
        Ok(Chunk::Refused { reason, detail }) => {
            let wait = if LAGGING.contains(&reason.as_str()) { t.not_ready } else { t.pause };
            tracing::warn!(org = %o.id, reason, detail, "the API sends no files now; this org's files wait {} s", wait.as_secs());
            o.files.queue.clear();
            o.files.last_refusal = Some(reason);
            o.files.paused_until = Some(now + wait);
            o.files.synced = None;
            o.next = now;
        }
        Err(e) => {
            tracing::warn!(org = %o.id, error = %format!("{e:#}"), "no chunk from the API; again in {} s", t.retry.as_secs());
            o.next = now + t.retry;
        }
    }
    true
}

/// Send the orgs' pages and files until the socket ends: `out` is the session's, `answers` global's frames.
pub async fn pump(starts: Vec<Start>, source: Arc<dyn PageSource>, out: mpsc::Sender<Out>, mut answers: mpsc::UnboundedReceiver<serde_json::Value>, status: Status, t: PumpTiming, pacer: Option<Arc<crate::pacing::Pacer>>) {
    let now = Instant::now();
    let mut orgs: Vec<Org> = starts
        .into_iter()
        .map(|s| Org {
            id: s.org,
            after: s.after,
            hash: s.after_hash,
            in_flight: None,
            next: now,
            stopped: None,
            sent: 0,
            acked_at: None,
            last_refusal: None,
            files: Files { on: s.files, ..Files::default() },
        })
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
            if let Some(f) = &o.in_flight {
                if now.duration_since(f.sent()) >= t.ack_timeout {
                    match f {
                        InFlight::Page { to_seq, .. } => tracing::warn!(org = %o.id, to_seq, "no answer for a page within {} s; it is built again", t.ack_timeout.as_secs()),
                        InFlight::Sync { .. } => tracing::warn!(org = %o.id, "global did not say which files it lacks within {} s; it is asked again", t.ack_timeout.as_secs()),
                        InFlight::Chunk { sha, .. } => tracing::warn!(org = %o.id, sha256 = %sha, "no answer for a chunk within {} s; it is sent again from where global stands", t.ack_timeout.as_secs()),
                    }
                    o.in_flight = None;
                    o.next = now;
                }
            }
        }
        report(&orgs, &status);

        if let Some(i) = orgs.iter().position(|o| o.stopped.is_none() && o.in_flight.is_none() && o.next <= now) {
            // While files wait, every other turn is theirs.
            if orgs[i].files.turn && orgs[i].files.due(now, t) && !orgs[i].files.queue.is_empty() {
                orgs[i].files.turn = false;
                if !files_step(&mut orgs[i], &*source, &out, t, pacer.as_deref()).await {
                    return;
                }
                continue;
            }
            let (id, after, hash) = (orgs[i].id.clone(), orgs[i].after, orgs[i].hash.clone());
            match source.page(&id, after, &hash).await {
                Ok(Built::Page { bytes, to_seq }) => {
                    // FR-20.52: the line's share, spaced out; the socket's loop never waits on it.
                    if let Some(p) = &pacer {
                        p.take(bytes.len()).await;
                    }
                    if out.send(Out::Binary(bytes)).await.is_err() {
                        return; // the socket is gone; the next session starts from what global says
                    }
                    orgs[i].in_flight = Some(InFlight::Page { to_seq, sent: Instant::now() });
                    orgs[i].sent += 1;
                }
                // Caught up: the files' turn, if they have one.
                Ok(Built::Empty) => {
                    if orgs[i].files.due(Instant::now(), t) {
                        if !files_step(&mut orgs[i], &*source, &out, t, pacer.as_deref()).await {
                            return;
                        }
                    } else {
                        orgs[i].next = Instant::now() + t.idle;
                    }
                }
                Ok(Built::Refused { reason, detail }) => {
                    if STOPPING.contains(&reason.as_str()) {
                        stop(&mut orgs[i], &reason, &detail);
                    } else {
                        let wait = if LAGGING.contains(&reason.as_str()) { t.not_ready } else { t.pause };
                        if wait == t.pause {
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
            .map(|o| match &o.in_flight {
                Some(f) => f.sent() + t.ack_timeout,
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
        chunks: Mutex<Vec<Chunk>>,
        chunk_asked: Mutex<Vec<(String, String, u64)>>,
    }

    impl Script {
        fn new(answers: Vec<Built>) -> Arc<Self> {
            Self::with_chunks(answers, vec![])
        }
        fn with_chunks(answers: Vec<Built>, chunks: Vec<Chunk>) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(answers.into_iter().rev().collect()),
                asked: Mutex::new(vec![]),
                resent: Mutex::new(vec![]),
                chunks: Mutex::new(chunks.into_iter().rev().collect()),
                chunk_asked: Mutex::new(vec![]),
            })
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
        fn chunk<'a>(&'a self, org: &'a str, sha256: &'a str, offset: u64) -> BoxFut<'a, Result<Chunk>> {
            Box::pin(async move {
                self.chunk_asked.lock().unwrap().push((org.to_string(), sha256.to_string(), offset));
                self.chunks.lock().unwrap().pop().ok_or_else(|| anyhow!("no chunk scripted"))
            })
        }
    }

    fn quick() -> PumpTiming {
        PumpTiming {
            idle: Duration::from_millis(30),
            retry: Duration::from_millis(30),
            not_ready: Duration::from_millis(30),
            pause: Duration::from_secs(600),
            ack_timeout: Duration::from_millis(400),
            files_resync: Duration::from_secs(600),
            files_idle: Duration::from_secs(600),
        }
    }

    fn page(bytes: &[u8], to_seq: u64) -> Built {
        Built::Page { bytes: bytes.to_vec(), to_seq }
    }

    fn status() -> Status {
        Arc::new(Mutex::new(serde_json::json!({ "bulk": { "state": "connected" } })))
    }

    struct Harness {
        out: mpsc::Receiver<Out>,
        answers: mpsc::UnboundedSender<serde_json::Value>,
        task: tokio::task::JoinHandle<()>,
        status: Status,
    }

    fn start(starts: Vec<Start>, script: Arc<Script>) -> Harness {
        let (out_tx, out) = mpsc::channel(1);
        let (answers, ans_rx) = mpsc::unbounded_channel();
        let status = status();
        let task = tokio::spawn(pump(starts, script, out_tx, ans_rx, status.clone(), quick(), None));
        Harness { out, answers, task, status }
    }

    async fn frame(h: &mut Harness) -> Out {
        tokio::time::timeout(Duration::from_secs(3), h.out.recv()).await.expect("a frame in time").expect("the pump is running")
    }

    async fn sent(h: &mut Harness) -> Vec<u8> {
        match frame(h).await {
            Out::Binary(b) => b,
            Out::Text(t) => panic!("a binary frame was expected, not {t}"),
        }
    }

    /// A word to global, read as JSON.
    async fn said(h: &mut Harness) -> serde_json::Value {
        match frame(h).await {
            Out::Text(t) => serde_json::from_str(&t).unwrap(),
            Out::Binary(b) => panic!("a word to global was expected, not {} bytes", b.len()),
        }
    }

    fn org(id: &str) -> Start {
        Start { org: id.into(), after: 0, after_hash: String::new(), files: false }
    }

    fn with_files(id: &str) -> Start {
        Start { files: true, ..org(id) }
    }

    fn chunk(bytes: &[u8]) -> Chunk {
        Chunk::Frame { bytes: bytes.to_vec(), len: bytes.len() as u64 }
    }

    const X: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const Y: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn only_orgs_homed_here_and_linked_at_full_are_sent_from_where_the_mirror_stands() {
        let welcome = serde_json::json!([
            { "orgId": "a", "home": "master-me", "linkLevel": "full", "state": "active", "mirror": { "watermark": 12, "chainHash": "h12" }, "files": "all" },
            { "orgId": "b", "home": "master-me", "linkLevel": "control", "state": "active", "mirror": { "watermark": 0, "chainHash": "" } },
            { "orgId": "c", "home": "global", "linkLevel": "full", "state": "active" },
            { "orgId": "d", "home": "master-me", "linkLevel": "full", "state": "fenced" },
            { "orgId": "e", "home": "master-me", "linkLevel": "full", "state": "frozen", "mirror": { "watermark": 7, "chainHash": "" }, "files": "metadata" },
            // A global that predates the files says nothing of them: none are sent.
            { "orgId": "f", "home": "master-me", "linkLevel": "full", "state": "active" },
        ]);
        assert_eq!(
            starts(&welcome, "master-me"),
            vec![
                Start { org: "a".into(), after: 12, after_hash: "h12".into(), files: true },
                // Its watermark came without a hash: from the start, and global says where it is.
                Start { org: "e".into(), after: 0, after_hash: String::new(), files: false },
                Start { org: "f".into(), after: 0, after_hash: String::new(), files: false },
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

    #[tokio::test]
    async fn an_api_that_has_not_yet_seen_the_link_at_full_is_asked_again_soon_not_in_ten_minutes() {
        let script = Script::new(vec![Built::Refused { reason: "not_full".into(), detail: "this master is not linked at Full".into() }, page(b"p1", 2)]);
        let mut h = start(vec![org("a")], script.clone());
        // `not_ready` is 30 ms in these timings, `pause` ten minutes.
        assert_eq!(sent(&mut h).await, b"p1");
        h.task.abort();
    }

    #[tokio::test]
    async fn files_go_behind_the_pages_chunk_by_chunk_from_where_global_stands() {
        let script = Script::with_chunks(vec![page(b"p1", 5)], vec![chunk(b"x-first"), chunk(b"x-rest")]);
        let mut h = start(vec![with_files("a")], script.clone());
        assert_eq!(sent(&mut h).await, b"p1");
        h.answers.send(serde_json::json!({ "t": "page-ack", "orgId": "a", "watermark": 5, "chainHash": "h5" })).unwrap();
        // Caught up: which files does the mirror lack?
        assert_eq!(said(&mut h).await, serde_json::json!({ "t": "blob-sync", "orgId": "a" }));
        h.answers.send(serde_json::json!({ "t": "blob-want", "orgId": "a", "files": "all", "want": [{ "sha256": X, "offset": 0 }], "more": false })).unwrap();
        assert_eq!(sent(&mut h).await, b"x-first");
        h.answers.send(serde_json::json!({ "t": "blob-ack", "orgId": "a", "sha256": X, "offset": 7, "state": "partial" })).unwrap();
        assert_eq!(sent(&mut h).await, b"x-rest");
        h.answers.send(serde_json::json!({ "t": "blob-ack", "orgId": "a", "sha256": X, "offset": 13, "state": "ok" })).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(script.chunk_asked.lock().unwrap().clone(), vec![("a".into(), X.into(), 0), ("a".into(), X.into(), 7)]);
        // A page was asked for before each chunk: pages first.
        assert!(script.asked.lock().unwrap().len() >= 3);
        let f = h.status.lock().unwrap()["bulk"]["replication"]["a"]["files"].clone();
        assert_eq!((f["held"].as_u64(), f["chunks"].as_u64(), f["queued"].as_u64()), (Some(1), Some(2), Some(0)), "{f}");
        // Nothing more to ask until pages bring rows or ten minutes pass.
        assert!(h.out.try_recv().is_err());
        h.task.abort();
    }

    #[tokio::test]
    async fn a_file_this_server_cannot_send_is_said_so_and_the_next_one_goes() {
        let script = Script::with_chunks(vec![], vec![Chunk::Unavailable { reason: "missing".into() }, chunk(b"y")]);
        let mut h = start(vec![with_files("a")], script.clone());
        assert_eq!(said(&mut h).await["t"], "blob-sync");
        h.answers.send(serde_json::json!({ "t": "blob-want", "orgId": "a", "files": "all", "want": [{ "sha256": X, "offset": 0 }, { "sha256": Y, "offset": 0 }], "more": false })).unwrap();
        assert_eq!(said(&mut h).await, serde_json::json!({ "t": "blob-unavailable", "orgId": "a", "sha256": X, "reason": "missing" }));
        assert_eq!(sent(&mut h).await, b"y");
        assert_eq!(h.status.lock().unwrap()["bulk"]["replication"]["a"]["files"]["unavailable"].as_u64(), Some(1));
        h.task.abort();
    }

    #[tokio::test]
    async fn a_refused_chunk_resumes_where_global_says_and_a_bad_file_is_left_to_global() {
        let script = Script::with_chunks(vec![], vec![chunk(b"x0"), chunk(b"x42"), chunk(b"y0")]);
        let mut h = start(vec![with_files("a")], script.clone());
        assert_eq!(said(&mut h).await["t"], "blob-sync");
        h.answers.send(serde_json::json!({ "t": "blob-want", "orgId": "a", "files": "all", "want": [{ "sha256": X, "offset": 0 }, { "sha256": Y, "offset": 0 }] })).unwrap();
        assert_eq!(sent(&mut h).await, b"x0");
        // Global already holds more of it (another pod, a crash): from there.
        h.answers.send(serde_json::json!({ "t": "blob-refused", "orgId": "a", "sha256": X, "reason": "offset", "offset": 42 })).unwrap();
        assert_eq!(sent(&mut h).await, b"x42");
        // Whole, it did not hash to its name: global drops it and asks again later; the next file goes.
        h.answers.send(serde_json::json!({ "t": "blob-refused", "orgId": "a", "sha256": X, "reason": "hash_mismatch", "offset": 0 })).unwrap();
        assert_eq!(sent(&mut h).await, b"y0");
        let asked: Vec<(String, u64)> = script.chunk_asked.lock().unwrap().iter().map(|(_, s, o)| (s[..1].to_string(), *o)).collect();
        assert_eq!(asked, vec![("1".to_string(), 0), ("1".to_string(), 42), ("2".to_string(), 0)]);
        h.task.abort();
    }

    #[tokio::test]
    async fn while_files_wait_every_other_turn_is_theirs_so_busy_pages_cannot_starve_them() {
        let script = Script::with_chunks(vec![Built::Empty, page(b"p1", 3), page(b"p2", 6)], vec![chunk(b"c1"), chunk(b"c2")]);
        let mut h = start(vec![with_files("a")], script.clone());
        assert_eq!(said(&mut h).await["t"], "blob-sync");
        h.answers.send(serde_json::json!({ "t": "blob-want", "orgId": "a", "files": "all", "want": [{ "sha256": X, "offset": 0 }] })).unwrap();
        // A page was ready by then: pages first.
        assert_eq!(sent(&mut h).await, b"p1");
        h.answers.send(serde_json::json!({ "t": "page-ack", "orgId": "a", "watermark": 3, "chainHash": "h3" })).unwrap();
        // p2 is ready too, but this turn is the file's.
        assert_eq!(sent(&mut h).await, b"c1");
        h.answers.send(serde_json::json!({ "t": "blob-ack", "orgId": "a", "sha256": X, "offset": 2, "state": "partial" })).unwrap();
        assert_eq!(sent(&mut h).await, b"p2");
        h.answers.send(serde_json::json!({ "t": "page-ack", "orgId": "a", "watermark": 6, "chainHash": "h6" })).unwrap();
        assert_eq!(sent(&mut h).await, b"c2");
        h.task.abort();
    }

    #[tokio::test]
    async fn an_org_that_mirrors_its_records_only_sends_no_files() {
        // Not in its welcome: never asked.
        let script = Script::with_chunks(vec![], vec![chunk(b"never")]);
        let h = start(vec![org("a")], script.clone());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(script.chunk_asked.lock().unwrap().is_empty());
        h.task.abort();
        // Chosen while connected: global says so, and the files stop.
        let script = Script::with_chunks(vec![], vec![chunk(b"never")]);
        let mut h = start(vec![with_files("a")], script.clone());
        assert_eq!(said(&mut h).await["t"], "blob-sync");
        h.answers.send(serde_json::json!({ "t": "blob-want", "orgId": "a", "files": "metadata", "want": [], "more": false })).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(h.out.try_recv().is_err());
        assert!(script.chunk_asked.lock().unwrap().is_empty());
        assert_eq!(h.status.lock().unwrap()["bulk"]["replication"]["a"]["files"]["on"], false);
        h.task.abort();
    }

    #[tokio::test]
    async fn global_refusing_this_node_files_pauses_them_and_the_pages_go_on() {
        let script = Script::with_chunks(vec![Built::Empty, page(b"p1", 2)], vec![]);
        let mut h = start(vec![with_files("a")], script.clone());
        assert_eq!(said(&mut h).await["t"], "blob-sync");
        h.answers.send(serde_json::json!({ "t": "blob-refused", "orgId": "a", "reason": "not_home" })).unwrap();
        assert_eq!(sent(&mut h).await, b"p1");
        let f = h.status.lock().unwrap()["bulk"]["replication"]["a"]["files"].clone();
        assert_eq!(f["lastRefusal"].as_str(), Some("not_home"), "{f}");
        h.task.abort();
    }

}
