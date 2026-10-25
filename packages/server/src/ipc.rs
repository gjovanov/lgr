//! The supervisor's control channel (FR-20 plan step P1-1): one JSON object per line, request then
//! answer, over a named pipe on Windows and a unix socket elsewhere. `lgr-server status --json`,
//! and later the desktop and the setup wizard, talk to a running service through it.
//!
//! Who may talk:
//! - Windows: the pipe gets the default DACL of the service account that creates it. Write access
//!   (needed to send a request) is SYSTEM's, the administrators' and the service's own; everyone
//!   else may only read, so cannot ask anything.
//! - Unix: the socket is `0600`, owned by the service user.
//!
//! The first pipe instance is created with `first_pipe_instance(true)`, so a pipe someone else
//! created first (squatting the name to impersonate the service) makes the supervisor refuse to
//! start rather than talk past it. A second supervisor is refused the same way.

use serde::{Deserialize, Serialize};
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

/// A request line. `{"cmd":"status"}`, `{"cmd":"stop"}`, `{"cmd":"restart","child":"api"}`,
/// `{"cmd":"ca-rotate","leadSecs":604800}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
pub enum Request {
    Status,
    Stop,
    Restart { child: String },
    /// Announce a rotation of the LAN CA (FR-20.30, plan step P1-4), taking effect after
    /// `lead_secs` (a week when absent). Announcing again returns the one announced.
    #[serde(rename_all = "camelCase")]
    CaRotate { lead_secs: Option<i64> },
}

/// An answer line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok() -> Self {
        Self { ok: true, status: None, error: None }
    }
    pub fn status(value: serde_json::Value) -> Self {
        Self { ok: true, status: Some(value), error: None }
    }
    pub fn error(message: impl Into<String>) -> Self {
        Self { ok: false, status: None, error: Some(message.into()) }
    }
}

/// What the server hands the supervisor: a request and where to send the answer.
pub type Call = (Request, oneshot::Sender<Response>);

/// A request line longer than this is refused and the connection closed: nothing legitimate is.
const MAX_LINE: usize = 64 * 1024;

/// Listening instances kept open at once, so a few clients can connect without "pipe busy".
#[cfg(windows)]
const PIPE_POOL: usize = 4;

/// The default endpoint. `LGR_SERVER_PIPE` / `LGR_SERVER_SOCKET` override it (tests, a second
/// install side by side).
pub fn default_endpoint() -> String {
    #[cfg(windows)]
    {
        std::env::var("LGR_SERVER_PIPE").unwrap_or_else(|_| r"\\.\pipe\lgr-server".to_string())
    }
    // Linux: /run/lgr-server, which systemd creates for the service user (RuntimeDirectory=).
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var("LGR_SERVER_SOCKET").unwrap_or_else(|_| "/run/lgr-server/control.sock".to_string())
    }
    // macOS has no /run, and /var/run is root's: the socket sits beside the data the service user owns.
    #[cfg(target_os = "macos")]
    {
        std::env::var("LGR_SERVER_SOCKET").unwrap_or_else(|_| "/Library/Application Support/LGR/control.sock".to_string())
    }
}

/// Answer requests on one connection until it closes. A line that is not a request is answered
/// with an error and the connection stays usable; one that is too long ends it.
pub async fn serve_connection<S>(stream: S, calls: mpsc::Sender<Call>) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut lines = BufReader::new(read);
    let mut line = String::new();
    loop {
        line.clear();
        let n = (&mut lines).take((MAX_LINE + 1) as u64).read_line(&mut line).await?;
        if n == 0 {
            return Ok(());
        }
        if n > MAX_LINE {
            let mut answer = serde_json::to_string(&Response::error("request too long"))?;
            answer.push('\n');
            write.write_all(answer.as_bytes()).await?;
            return Ok(());
        }
        let answer = match serde_json::from_str::<Request>(line.trim()) {
            Ok(request) => {
                let (reply, wait) = oneshot::channel();
                if calls.send((request, reply)).await.is_err() {
                    Response::error("the supervisor is shutting down")
                } else {
                    wait.await.unwrap_or_else(|_| Response::error("the supervisor dropped the request"))
                }
            }
            Err(e) => Response::error(format!("not a request: {e}")),
        };
        let mut out = serde_json::to_string(&answer)?;
        out.push('\n');
        write.write_all(out.as_bytes()).await?;
        write.flush().await?;
    }
}

/// Listen on `endpoint` until the process ends, handing every request to `calls`.
#[cfg(windows)]
pub async fn serve(endpoint: &str, calls: mpsc::Sender<Call>) -> io::Result<()> {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    async fn accept_loop(name: String, mut instance: NamedPipeServer, calls: mpsc::Sender<Call>) -> io::Result<()> {
        loop {
            instance.connect().await?;
            let connected = instance;
            // The next instance exists before this connection is served, so the name never lapses.
            instance = ServerOptions::new().create(&name)?;
            let calls = calls.clone();
            tokio::spawn(async move {
                if let Err(e) = serve_connection(connected, calls).await {
                    tracing::debug!(error = %e, "control connection ended");
                }
            });
        }
    }

    let first = ServerOptions::new().first_pipe_instance(true).create(endpoint).map_err(|e| {
        io::Error::new(e.kind(), format!("{endpoint} is already taken (another supervisor, or something squatting the name): {e}"))
    })?;
    let mut loops = tokio::task::JoinSet::new();
    loops.spawn(accept_loop(endpoint.to_string(), first, calls.clone()));
    for _ in 1..PIPE_POOL {
        let instance = ServerOptions::new().create(endpoint)?;
        loops.spawn(accept_loop(endpoint.to_string(), instance, calls.clone()));
    }
    while let Some(done) = loops.join_next().await {
        done.map_err(io::Error::other)??;
    }
    Ok(())
}

#[cfg(unix)]
pub async fn serve(endpoint: &str, calls: mpsc::Sender<Call>) -> io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use tokio::net::UnixListener;

    let path = std::path::Path::new(endpoint);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A socket left by a supervisor that died is removed; anything else at that path is not ours.
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_socket() {
            if tokio::net::UnixStream::connect(path).await.is_ok() {
                return Err(io::Error::new(io::ErrorKind::AddrInUse, format!("{endpoint}: another supervisor is running")));
            }
            std::fs::remove_file(path)?;
        } else {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{endpoint} exists and is not a socket")));
        }
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let calls = calls.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_connection(stream, calls).await {
                tracing::debug!(error = %e, "control connection ended");
            }
        });
    }
}

/// Send one request to a running supervisor and read its answer.
pub async fn request(endpoint: &str, req: &Request) -> io::Result<Response> {
    #[cfg(windows)]
    let stream = {
        use tokio::net::windows::named_pipe::ClientOptions;
        // ERROR_PIPE_BUSY: every instance is serving someone. They come back within milliseconds.
        const ERROR_PIPE_BUSY: i32 = 231;
        let mut attempts = 0;
        loop {
            match ClientOptions::new().open(endpoint) {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempts < 50 => {
                    attempts += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
                Err(e) => return Err(e),
            }
        }
    };
    #[cfg(unix)]
    let stream = tokio::net::UnixStream::connect(endpoint).await?;

    let (read, mut write) = tokio::io::split(stream);
    let mut line = serde_json::to_string(req)?;
    line.push('\n');
    write.write_all(line.as_bytes()).await?;
    write.flush().await?;
    let mut answer = String::new();
    BufReader::new(read).take(MAX_LINE as u64).read_line(&mut answer).await?;
    serde_json::from_str(answer.trim()).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_one_tagged_object_per_line() {
        assert_eq!(serde_json::to_string(&Request::Status).unwrap(), r#"{"cmd":"status"}"#);
        assert_eq!(
            serde_json::from_str::<Request>(r#"{"cmd":"restart","child":"api"}"#).unwrap(),
            Request::Restart { child: "api".into() }
        );
        assert_eq!(serde_json::to_string(&Request::CaRotate { lead_secs: Some(3600) }).unwrap(), r#"{"cmd":"ca-rotate","leadSecs":3600}"#);
        assert_eq!(serde_json::from_str::<Request>(r#"{"cmd":"ca-rotate"}"#).unwrap(), Request::CaRotate { lead_secs: None });
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"format-disk"}"#).is_err());
    }

    /// A connection answers, survives a garbage line, and closes on an over-long one.
    #[tokio::test]
    async fn a_connection_answers_and_recovers_from_garbage() {
        let (client, server) = tokio::io::duplex(256 * 1024);
        let (calls, mut inbox) = mpsc::channel::<Call>(4);
        tokio::spawn(async move {
            while let Some((req, reply)) = inbox.recv().await {
                let _ = reply.send(match req {
                    Request::Status => Response::status(serde_json::json!({ "children": [] })),
                    _ => Response::ok(),
                });
            }
        });
        tokio::spawn(serve_connection(server, calls));

        let (read, mut write) = tokio::io::split(client);
        let mut answers = BufReader::new(read).lines();
        write.write_all(b"{\"cmd\":\"status\"}\nnot json\n{\"cmd\":\"stop\"}\n").await.unwrap();
        let first: Response = serde_json::from_str(&answers.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(first.status, Some(serde_json::json!({ "children": [] })));
        let garbage: Response = serde_json::from_str(&answers.next_line().await.unwrap().unwrap()).unwrap();
        assert!(!garbage.ok && garbage.error.unwrap().starts_with("not a request"));
        let stop: Response = serde_json::from_str(&answers.next_line().await.unwrap().unwrap()).unwrap();
        assert!(stop.ok);

        write.write_all(&vec![b'x'; MAX_LINE + 10]).await.unwrap();
        write.write_all(b"\n").await.unwrap();
        let refused: Response = serde_json::from_str(&answers.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(refused.error.as_deref(), Some("request too long"));
        assert!(answers.next_line().await.unwrap().is_none());
    }

    /// The real endpoint, end to end: a named pipe on Windows, a unix socket elsewhere.
    #[tokio::test]
    async fn a_client_round_trips_over_the_os_endpoint() {
        #[cfg(windows)]
        let endpoint = format!(r"\\.\pipe\lgr-server-test-{}", std::process::id());
        #[cfg(unix)]
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let endpoint = dir.path().join("control.sock").to_string_lossy().into_owned();

        let (calls, mut inbox) = mpsc::channel::<Call>(4);
        tokio::spawn(async move {
            while let Some((_, reply)) = inbox.recv().await {
                let _ = reply.send(Response::status(serde_json::json!({ "up": true })));
            }
        });
        let server_endpoint = endpoint.clone();
        tokio::spawn(async move { serve(&server_endpoint, calls).await });
        // Wait for it to listen.
        let mut answer = None;
        for _ in 0..100 {
            if let Ok(a) = request(&endpoint, &Request::Status).await {
                answer = Some(a);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(answer.unwrap().status, Some(serde_json::json!({ "up": true })));

        // Several clients at once: the pool answers them all.
        let mut many = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let e = endpoint.clone();
            many.spawn(async move { request(&e, &Request::Status).await.unwrap().ok });
        }
        while let Some(ok) = many.join_next().await {
            assert!(ok.unwrap());
        }

        // A second server on the same endpoint is refused.
        let (calls2, _inbox2) = mpsc::channel::<Call>(1);
        let second = tokio::time::timeout(std::time::Duration::from_secs(2), serve(&endpoint, calls2)).await;
        assert!(matches!(second, Ok(Err(_))), "a second supervisor must be refused, got {second:?}");
    }
}
