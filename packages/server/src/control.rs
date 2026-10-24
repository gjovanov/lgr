//! The supervisor's side of the API's control socket (FR-20.16, FR-20.23, plan step P1-3b).
//!
//! HTTP/1.1 over AF_UNIX, one request per connection, each carrying the per-boot front secret. The
//! API serves it with `Bun.serve({ unix })` (`portal-api/src/front/control-socket.ts`): `GET
//! /status` and `POST /stop`. It is not a TCP port, so no ingress can reach it.
//!
//! ⚠ AF_UNIX on Windows too. Bun serves HTTP on an AF_UNIX path there but not on a named pipe
//! (ENOENT, measured on 1.4.4), and tokio has no AF_UNIX client on Windows: so the request runs on
//! a blocking thread, through `std::os::unix::net` or `uds_windows`, which share one API.

use anyhow::{anyhow, Context, Result};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SECRET_HEADER: &str = "x-lgr-front";

/// `sun_path` is 108 bytes on Linux and Windows and 104 on macOS: a longer path cannot be bound.
pub const MAX_SOCKET_PATH: usize = 100;

/// One request to the API: its status code and its body.
pub async fn call(socket: &Path, secret: &str, method: &str, path: &str, timeout: Duration) -> Result<(u16, String)> {
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: lgr-api\r\n{SECRET_HEADER}: {secret}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .into_bytes();
    let socket: PathBuf = socket.to_path_buf();
    let exchange = tokio::task::spawn_blocking(move || exchange(&socket, &request, timeout));
    let raw = tokio::time::timeout(timeout + Duration::from_secs(1), exchange)
        .await
        .map_err(|_| anyhow!("the API's control socket did not answer within {timeout:?}"))???;
    parse(&raw)
}

fn exchange(socket: &Path, request: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    #[cfg(unix)]
    let mut s = std::os::unix::net::UnixStream::connect(socket).with_context(|| format!("connecting to {}", socket.display()))?;
    #[cfg(windows)]
    let mut s = uds_windows::UnixStream::connect(socket).with_context(|| format!("connecting to {}", socket.display()))?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    s.write_all(request)?;
    read_response(&mut s)
}

/// The whole response: up to the end of its headers, then its `Content-Length`, or to EOF when it
/// names none. Never waits on a connection the server keeps open once the answer is complete.
fn read_response(r: &mut impl Read) -> Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let mut wanted: Option<usize> = None;
    loop {
        if wanted.is_none() {
            if let Some(end) = find(&buf, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                wanted = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .map(|len| end + 4 + len);
            }
        }
        if let Some(total) = wanted {
            if buf.len() >= total {
                buf.truncate(total);
                return Ok(buf);
            }
        }
        let n = r.read(&mut chunk)?;
        if n == 0 {
            return Ok(buf);
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 1 << 20 {
            return Err(anyhow!("the control socket's answer is larger than 1 MB"));
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse(raw: &[u8]) -> Result<(u16, String)> {
    let end = find(raw, b"\r\n\r\n").context("the control socket's answer has no end of headers")?;
    let head = String::from_utf8_lossy(&raw[..end]);
    let code = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .context("the control socket's answer has no status code")?;
    Ok((code, String::from_utf8_lossy(&raw[end + 4..]).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-shot server on an AF_UNIX path: answers each connection with `answer`, and hands the
    /// request it read back to the test.
    fn serve_once(path: &Path, answer: &'static [u8]) -> std::thread::JoinHandle<String> {
        #[cfg(unix)]
        let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
        #[cfg(windows)]
        let listener = uds_windows::UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut got = Vec::new();
            let mut chunk = [0u8; 1024];
            while find(&got, b"\r\n\r\n").is_none() {
                let n = s.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&chunk[..n]);
            }
            s.write_all(answer).unwrap();
            // Held open: the client must stop at Content-Length, not wait for the close.
            std::thread::sleep(Duration::from_millis(1500));
            String::from_utf8_lossy(&got).into_owned()
        })
    }

    #[tokio::test]
    async fn a_request_carries_the_secret_and_reads_exactly_its_answer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("api.sock");
        let server = serve_once(&path, b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"stopping\":1}\n");
        let started = std::time::Instant::now();
        let (code, body) = call(&path, "s3cret", "POST", "/stop", Duration::from_secs(5)).await.unwrap();
        assert_eq!(code, 202);
        assert_eq!(body, "{\"stopping\":1}\n");
        assert!(started.elapsed() < Duration::from_millis(1200), "it waited for the close: {:?}", started.elapsed());
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /stop HTTP/1.1\r\n"), "{request}");
        assert!(request.contains("x-lgr-front: s3cret\r\n"), "{request}");
    }

    #[tokio::test]
    async fn nothing_listening_is_an_error_not_a_hang() {
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        assert!(call(&dir.path().join("none.sock"), "s", "GET", "/status", Duration::from_secs(5)).await.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn an_answer_without_a_length_is_read_to_its_end() {
        let raw = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}";
        let mut r: &[u8] = raw;
        assert_eq!(parse(&read_response(&mut r).unwrap()).unwrap(), (200, "{\"ok\":true}".to_string()));
    }
}
