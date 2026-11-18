//! The hub's socket as the presence and bridge loops read it (lgr#811).
//!
//! Both loops have to wake a few times a second whether the hub says anything or not: to see
//! `stop`, to send a heartbeat or a ping, to give a silent link up. They used to get that from a
//! receive timeout on the socket (`set_read_timeout`), reading again each time it ran out.
//!
//! ⚠ **On Windows that loses data.** A blocking receive whose timeout runs out as data arrives fails
//! with error 997 (`WSA_IO_PENDING`), and the data that was arriving is gone: the next receive
//! returns what came after it. Microsoft says so of `SO_RCVTIMEO`: "If a blocking receive call
//! times out, the connection is in an indeterminate state and should be closed." Rust has no error
//! kind for 997, so the loops took it for a broken link and dropped the socket, and under TLS the
//! lost record would have broken the stream on the next one anyway. For the bridge the frame that
//! arrives after a quiet spell is a sale's first command: the hub saw the socket close with that
//! command pending, and the sale was saved without its receipt. One sale in about 18,000 in the
//! soak lanes, and every desktop since 0.1.4 read this way.
//!
//! So a socket is **never read again after a receive timed out**, because no receive is ever left
//! to time out: the socket is non-blocking, and the wait is `WSAPoll` (`poll` off Windows) on the
//! socket itself, which gives up without touching what is in flight.
//!
//! ⚠ **Read before waiting.** tungstenite reads the stream in chunks, and the TLS under it decrypts
//! whole records, so each may already hold a frame the socket no longer shows as readable. A loop
//! that waited first would sit on that frame until something else arrived. `read` asks for what is
//! already here, and only then waits.
//!
//! ⚠ **Sends stay blocking**, as they always were: the socket goes back to blocking for the write
//! and to non-blocking after it. A write that would block is the one case the three TLS backends
//! (SChannel, OpenSSL, Secure Transport) and rustls each handle their own way, and nothing sent
//! here is ever big enough to fill a send buffer. `STUCK_AFTER` bounds a send that does block.

use std::io;
use std::net::TcpStream;
use std::time::Duration;

use tungstenite::protocol::CloseFrame;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error, Message};

use crate::trust::Socket;

/// A send that has made no progress for this long has a dead peer under it: the link is given up.
///
/// ⚠ These are the socket's send and receive timeouts, and they only ever apply while it is
/// blocking, which is during a send. The receive one is for a TLS layer that reads inside a write
/// (finishing a handshake message). Either firing ends the link, which is the one thing Windows
/// allows after a timeout.
const STUCK_AFTER: Duration = Duration::from_secs(15);

/// The hub's WebSocket, read without a receive timeout.
///
/// Every `Err` is the link's end, and its text is what the log says ended it.
pub struct HubSocket {
    socket: Socket,
    /// The socket could not be put back to non-blocking. Nothing may read it again: a read would
    /// block, and `stop` and a revocation could no longer end the loop that holds a till's port.
    broken: bool,
}

impl HubSocket {
    /// Take over a connected socket (`trust::ws_connect`).
    ///
    /// ⚠ Fails for a transport it cannot wait on. `MaybeTlsStream` is `non_exhaustive`: a new
    /// transport read some other way would be a loop blocked in `read` for ever, in silence.
    pub fn new(socket: Socket) -> io::Result<Self> {
        let tcp = tcp_of(&socket)?;
        tcp.set_read_timeout(Some(STUCK_AFTER))?;
        tcp.set_write_timeout(Some(STUCK_AFTER))?;
        tcp.set_nonblocking(true)?;
        Ok(Self { socket, broken: false })
    }

    /// The next message, waiting `wait` at most for the hub to say something.
    ///
    /// `Ok(None)` is "nothing yet", and the caller looks at its clock and its flags. That includes
    /// a frame that has only arrived in part: what did arrive is kept, and the next call goes on
    /// from it.
    pub fn read(&mut self, wait: Duration) -> Result<Option<Message>, String> {
        self.usable()?;
        if let Some(message) = self.take()? {
            return Ok(Some(message));
        }
        let tcp = tcp_of(&self.socket).map_err(|e| e.to_string())?;
        if !readable(tcp, wait).map_err(|e| format!("waiting for the socket failed: {e}"))? {
            return Ok(None);
        }
        self.take()
    }

    /// What is here without waiting: a whole message, or nothing.
    fn take(&mut self) -> Result<Option<Message>, String> {
        match self.socket.read() {
            Ok(message) => Ok(Some(message)),
            Err(Error::Io(e)) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Send a message and flush it.
    pub fn send(&mut self, message: Message) -> Result<(), String> {
        self.usable()?;
        self.blocking(true)?;
        let sent = self.socket.send(message).map_err(|e| e.to_string());
        // Back to non-blocking whether it went out or not, and the send's own error first.
        let back = self.blocking(false);
        sent.and(back)
    }

    /// Say goodbye with a close frame, as far as that goes: the link is given up either way.
    pub fn close(mut self) {
        if !self.broken && self.blocking(true).is_ok() {
            let _ = self.socket.close(None);
        }
    }

    fn usable(&self) -> Result<(), String> {
        if self.broken {
            return Err("the socket was left blocking, so it is not read again".into());
        }
        Ok(())
    }

    fn blocking(&mut self, on: bool) -> Result<(), String> {
        let done = tcp_of(&self.socket).and_then(|tcp| tcp.set_nonblocking(!on));
        if done.is_err() {
            self.broken = true;
        }
        done.map_err(|e| format!("the socket's mode could not be changed: {e}"))
    }
}

/// A close frame as a log line carries it: ` (1001: restarting)`, ` (1000)`, or nothing for a frame
/// that named no code. The text is the peer's, so it is cut short and kept to one line.
pub fn close_note(frame: &Option<CloseFrame<'_>>) -> String {
    let Some(frame) = frame else { return String::new() };
    let reason: String = frame.reason.chars().filter(|c| !c.is_control()).take(80).collect();
    if reason.is_empty() {
        format!(" ({})", frame.code)
    } else {
        format!(" ({}: {reason})", frame.code)
    }
}

/// The TCP stream under the socket, whichever TLS it runs over: the OS store's (native-tls) for
/// lgrai.app, a master's pin (rustls), or none on a dev hub.
fn tcp_of(socket: &Socket) -> io::Result<&TcpStream> {
    match socket.get_ref() {
        MaybeTlsStream::Plain(s) => Ok(s),
        MaybeTlsStream::NativeTls(s) => Ok(s.get_ref()),
        MaybeTlsStream::Rustls(s) => Ok(s.get_ref()),
        _ => Err(io::Error::other("a transport this build cannot wait on")),
    }
}

/// A wait as the OS takes it: whole milliseconds, and never 0 for a wait that was asked for.
fn millis(wait: Duration) -> i32 {
    let ms = wait.as_millis().min(i32::MAX as u128) as i32;
    if ms == 0 && !wait.is_zero() {
        1
    } else {
        ms
    }
}

/// Wait until `tcp` has something to read, `wait` at most. Also true once the peer closed or the
/// connection failed: the read that follows says which.
#[cfg(windows)]
fn readable(tcp: &TcpStream, wait: Duration) -> io::Result<bool> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{WSAGetLastError, WSAPoll, POLLRDNORM, WSAPOLLFD};

    let mut fd = WSAPOLLFD { fd: tcp.as_raw_socket() as _, events: POLLRDNORM, revents: 0 };
    // SAFETY: one WSAPOLLFD that lives across the call, for a socket `tcp` keeps open.
    match unsafe { WSAPoll(&mut fd, 1, millis(wait)) } {
        0 => Ok(false),
        n if n > 0 => Ok(true),
        // SAFETY: reads this thread's last Winsock error, nothing else.
        _ => Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() })),
    }
}

#[cfg(unix)]
fn readable(tcp: &TcpStream, wait: Duration) -> io::Result<bool> {
    use std::os::fd::AsRawFd;

    let mut fd = libc::pollfd { fd: tcp.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    // SAFETY: one pollfd that lives across the call, for a socket `tcp` keeps open.
    match unsafe { libc::poll(&mut fd, 1, millis(wait)) } {
        0 => Ok(false),
        n if n > 0 => Ok(true),
        _ => {
            let e = io::Error::last_os_error();
            // A signal (a logout ends the app with SIGTERM, `quit_on_signals`): nothing yet, and the
            // caller looks at its flags.
            if e.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Arc;
    use std::time::Instant;

    /// What a test tells its hub to do next.
    enum Do {
        /// Write these bytes to the stream under the WebSocket.
        Raw(Vec<u8>),
        /// Read one message and send it back.
        Echo,
        /// Send a close frame.
        Close,
        /// Drop the connection where it stands.
        Drop,
    }

    /// One unmasked text frame, as a server writes it.
    fn frame(text: &str) -> Vec<u8> {
        let payload = text.as_bytes();
        let mut f = vec![0x81];
        match payload.len() {
            n if n < 126 => f.push(n as u8),
            n => {
                assert!(n < 65_536, "a test frame of {n} bytes");
                f.push(126);
                f.extend_from_slice(&(n as u16).to_be_bytes());
            }
        }
        f.extend_from_slice(payload);
        f
    }

    /// A hub of one connection: it accepts the upgrade on `stream`, then does what it is told.
    fn serve<S: Read + Write>(stream: S, script: Receiver<Do>) {
        let Ok(mut ws) = tungstenite::accept(stream) else { return };
        for step in script {
            match step {
                Do::Raw(bytes) => {
                    let s = ws.get_mut();
                    if s.write_all(&bytes).is_err() || s.flush().is_err() {
                        return;
                    }
                }
                Do::Echo => match ws.read() {
                    Ok(m) => {
                        if ws.send(m).is_err() {
                            return;
                        }
                    }
                    Err(_) => return,
                },
                Do::Close => {
                    let _ = ws.close(None);
                }
                Do::Drop => return,
            }
        }
    }

    /// A stream that sends a few bytes at a time, so that whatever is written through it, a frame
    /// or a TLS record, reaches the other side in pieces.
    struct Trickle(TcpStream);

    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for Trickle {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let n = buf.len().min(61);
            self.0.write_all(&buf[..n])?;
            std::thread::sleep(Duration::from_millis(1));
            Ok(n)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    /// The three ways the shell reaches a hub.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Transport {
        /// A dev hub: no TLS.
        Plain,
        /// A paired master: rustls, trusting the pinned CA alone (`trust::ws_connect`).
        Pinned,
        /// lgrai.app: the platform's TLS (SChannel, OpenSSL, Secure Transport) through native-tls.
        Native,
    }

    const TRANSPORTS: [Transport; 3] = [Transport::Plain, Transport::Pinned, Transport::Native];

    /// A CA made here, and a server configuration for 127.0.0.1 signed by it.
    fn test_pki() -> (String, Arc<rustls::ServerConfig>) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
        ca.distinguished_name.push(rcgen::DnType::CommonName, "socket test CA");
        ca.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::DigitalSignature];
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let issuer = rcgen::Issuer::new(ca, &ca_key);
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let mut leaf = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap();
        leaf.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let leaf_cert = leaf.signed_by(&leaf_key, &issuer).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf_cert.der().clone()],
                rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()),
            )
            .unwrap();
        (ca_cert.pem(), Arc::new(config))
    }

    fn tls<S: Read + Write>(config: Arc<rustls::ServerConfig>, stream: S) -> rustls::StreamOwned<rustls::ServerConnection, S> {
        rustls::StreamOwned::new(rustls::ServerConnection::new(config).unwrap(), stream)
    }

    /// A hub on 127.0.0.1 and this side's connected socket to it, over `transport`. With `trickle`
    /// the hub sends a few bytes at a time.
    fn connect(transport: Transport, trickle: bool) -> (Socket, Sender<Do>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = channel();
        let (ca_pem, config) = test_pki();
        std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else { return };
            let _ = stream.set_nodelay(true);
            match (transport, trickle) {
                (Transport::Plain, false) => serve(stream, rx),
                (Transport::Plain, true) => serve(Trickle(stream), rx),
                (_, false) => serve(tls(config, stream), rx),
                (_, true) => serve(tls(config, Trickle(stream)), rx),
            }
        });

        let socket = match transport {
            Transport::Plain => {
                let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
                tungstenite::client(format!("ws://127.0.0.1:{port}/ws"), MaybeTlsStream::Plain(tcp)).unwrap().0
            }
            Transport::Pinned => {
                let origin = format!("https://127.0.0.1:{port}");
                let fingerprint = crate::trust::fingerprint_of_pem(&ca_pem).unwrap();
                let pin = crate::trust::MasterPin::new(&ca_pem, &fingerprint).unwrap();
                assert!(crate::trust::set_pin(&origin, Some(pin)));
                let socket = crate::trust::ws_connect(&format!("wss://127.0.0.1:{port}/ws"), "test.desktop.token").unwrap();
                crate::trust::set_pin(&origin, None);
                socket
            }
            Transport::Native => {
                // ⚠ The certificate is not checked: the OS store cannot be taught a test CA. What is
                // under test is how the platform's TLS hands out what it read, and that does not
                // depend on who signed the certificate.
                let connector = native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).build().unwrap();
                let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
                tungstenite::client_tls_with_config(
                    format!("wss://127.0.0.1:{port}/ws"),
                    tcp,
                    None,
                    Some(tungstenite::Connector::NativeTls(connector)),
                )
                .unwrap()
                .0
            }
        };
        match (transport, socket.get_ref()) {
            (Transport::Plain, MaybeTlsStream::Plain(_))
            | (Transport::Pinned, MaybeTlsStream::Rustls(_))
            | (Transport::Native, MaybeTlsStream::NativeTls(_)) => {}
            _ => panic!("{transport:?} did not give the stream it is named for"),
        }
        (socket, tx)
    }

    fn pair(transport: Transport) -> (HubSocket, Sender<Do>) {
        let (socket, hub) = connect(transport, false);
        (HubSocket::new(socket).unwrap(), hub)
    }

    /// Read until a message comes, `within` at most, with `wait` per read.
    fn next(socket: &mut HubSocket, wait: Duration, within: Duration) -> Option<Message> {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Some(message) = socket.read(wait).expect("the link holds") {
                return Some(message);
            }
        }
        None
    }

    fn text(message: Option<Message>) -> String {
        match message {
            Some(Message::Text(t)) => t,
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn a_quiet_socket_gives_nothing_after_its_wait_and_then_the_frame_that_comes() {
        for transport in TRANSPORTS {
            let (mut socket, hub) = pair(transport);
            let started = Instant::now();
            assert!(socket.read(Duration::from_millis(300)).unwrap().is_none(), "{transport:?}");
            let waited = started.elapsed();
            assert!(waited >= Duration::from_millis(250), "{transport:?}: gave up after {waited:?}, before its wait was over");
            assert!(waited < 5 * SECOND, "{transport:?}: {waited:?} for a wait of 300 ms");

            hub.send(Do::Raw(frame("hello"))).unwrap();
            assert_eq!(text(next(&mut socket, SECOND, 10 * SECOND)), "hello", "{transport:?}");
        }
    }

    #[test]
    fn a_wait_that_ran_out_many_times_loses_nothing_that_follows() {
        // What the loops do all day: wait, find nothing, wait again. Each frame is the first after a
        // quiet spell, which is where the frame of lgr#811 was lost.
        for transport in TRANSPORTS {
            let (mut socket, hub) = pair(transport);
            for n in 0..20 {
                for _ in 0..3 {
                    assert!(socket.read(Duration::from_millis(20)).unwrap().is_none(), "{transport:?}");
                }
                hub.send(Do::Raw(frame(&format!("command {n}")))).unwrap();
                assert_eq!(text(next(&mut socket, Duration::from_millis(20), 10 * SECOND)), format!("command {n}"), "{transport:?}");
            }
        }
    }

    #[test]
    fn frames_that_came_together_are_read_without_waiting_on_the_socket() {
        // Two frames in one write. tungstenite reads 4 KB at a time: two small frames both end up in
        // its own buffer, and of two big ones the tail of the second stays in the TLS layer, which
        // decrypts a whole record. Either way the socket has nothing more to show for the second
        // frame, and a loop that waited before reading would sit out its wait on a command that is
        // already here.
        for transport in TRANSPORTS {
            for size in [1_000, 3_000] {
                let (mut socket, hub) = pair(transport);
                let (first, second) = ("a".repeat(size), "b".repeat(size));
                let mut both = frame(&first);
                both.extend(frame(&second));
                hub.send(Do::Raw(both)).unwrap();

                assert_eq!(text(next(&mut socket, SECOND, 10 * SECOND)), first, "{transport:?} {size}");
                // Let anything still on its way arrive, so that the second read has nothing to wait for.
                std::thread::sleep(Duration::from_millis(300));
                let started = Instant::now();
                assert_eq!(text(socket.read(30 * SECOND).unwrap()), second, "{transport:?} {size}");
                let took = started.elapsed();
                assert!(took < 5 * SECOND, "{transport:?} {size}: the frame that was already here took {took:?}");
            }
        }
    }

    #[test]
    fn a_frame_that_arrives_in_two_parts_is_read_whole() {
        for transport in TRANSPORTS {
            let (mut socket, hub) = pair(transport);
            let whole = frame(&"c".repeat(500));
            let (head, tail) = whole.split_at(200);
            hub.send(Do::Raw(head.to_vec())).unwrap();
            // Its first part is here and the rest is not: nothing yet, and no error.
            let started = Instant::now();
            while started.elapsed() < Duration::from_millis(400) {
                assert!(socket.read(Duration::from_millis(50)).unwrap().is_none(), "{transport:?}");
            }
            hub.send(Do::Raw(tail.to_vec())).unwrap();
            assert_eq!(text(next(&mut socket, Duration::from_millis(50), 10 * SECOND)), "c".repeat(500), "{transport:?}");
        }
    }

    #[test]
    fn frames_and_tls_records_that_arrive_a_few_bytes_at_a_time_are_read_whole() {
        // The hub's side sends 61 bytes at a time, so every read below finds part of a TLS record,
        // part of a frame, or nothing, and each layer has to keep what it was given.
        for transport in TRANSPORTS {
            let (socket, hub) = connect(transport, true);
            let mut socket = HubSocket::new(socket).unwrap();
            let sent: Vec<String> = (0..12).map(|n| format!("{n}:{}", "d".repeat(150 + 31 * n))).collect();
            for frame_text in &sent {
                hub.send(Do::Raw(frame(frame_text))).unwrap();
            }
            for frame_text in &sent {
                assert_eq!(&text(next(&mut socket, Duration::from_millis(3), 30 * SECOND)), frame_text, "{transport:?}");
            }
        }
    }

    #[test]
    fn a_send_goes_out_and_the_socket_is_read_as_before() {
        for transport in TRANSPORTS {
            let (mut socket, hub) = pair(transport);
            for n in 0..3 {
                hub.send(Do::Echo).unwrap();
                socket.send(Message::Text(format!("ping {n}"))).unwrap();
                assert_eq!(text(next(&mut socket, SECOND, 10 * SECOND)), format!("ping {n}"), "{transport:?}");
                // ⚠ Back to non-blocking after the send: a read of a quiet socket still ends with its
                // wait. Left blocking it would sit there for `STUCK_AFTER` and then fail.
                let started = Instant::now();
                assert!(socket.read(Duration::from_millis(100)).unwrap().is_none(), "{transport:?}");
                assert!(started.elapsed() < 5 * SECOND, "{transport:?}: {:?} for a wait of 100 ms", started.elapsed());
            }
        }
    }

    #[test]
    fn the_stream_is_never_left_to_block_in_a_receive() {
        // The property the fix rests on. A receive on this socket answers at once, data or none, so
        // there is no receive that could time out with data arriving under it.
        let (mut socket, _hub) = pair(Transport::Plain);
        let MaybeTlsStream::Plain(tcp) = socket.socket.get_mut() else { panic!("plain") };
        let started = Instant::now();
        let err = tcp.read(&mut [0u8; 1]).expect_err("nothing was sent");
        assert_eq!(err.kind(), io::ErrorKind::WouldBlock);
        assert!(started.elapsed() < SECOND, "the receive waited {:?}", started.elapsed());
    }

    #[test]
    fn a_close_frame_is_a_message_and_a_dropped_connection_an_error() {
        for transport in TRANSPORTS {
            let (mut socket, hub) = pair(transport);
            hub.send(Do::Close).unwrap();
            assert!(matches!(next(&mut socket, SECOND, 10 * SECOND), Some(Message::Close(_))), "{transport:?}");

            let (mut socket, hub) = pair(transport);
            hub.send(Do::Drop).unwrap();
            let started = Instant::now();
            let ended = loop {
                match socket.read(SECOND) {
                    Ok(Some(message)) => panic!("{transport:?}: a message from a dropped connection: {message:?}"),
                    Ok(None) if started.elapsed() < 10 * SECOND => {}
                    Ok(None) => panic!("{transport:?}: the dropped connection was never noticed"),
                    Err(e) => break e,
                }
            };
            assert!(!ended.is_empty(), "{transport:?}: the log is told what ended the link");
        }
    }

    #[test]
    fn a_socket_left_blocking_is_never_read_again() {
        let (mut socket, _hub) = pair(Transport::Plain);
        socket.broken = true;
        assert!(socket.read(Duration::from_millis(10)).is_err());
        assert!(socket.send(Message::Text("x".into())).is_err());
    }

    #[test]
    fn a_close_frame_is_noted_in_one_short_line() {
        use tungstenite::protocol::frame::coding::CloseCode;
        let frame = |code: CloseCode, reason: &str| Some(CloseFrame { code, reason: reason.to_string().into() });
        assert_eq!(close_note(&None), "");
        assert_eq!(close_note(&frame(CloseCode::Normal, "")), " (1000)");
        assert_eq!(close_note(&frame(CloseCode::Away, "restarting")), " (1001: restarting)");
        // The text is the peer's: it cannot start a line of its own in the log, or fill it.
        let noted = close_note(&frame(CloseCode::Away, &format!("a\nb\r\n{}", "x".repeat(500))));
        assert!(!noted.contains('\n') && !noted.contains('\r'), "{noted:?}");
        assert!(noted.len() < 100, "{} characters", noted.len());
    }

    #[test]
    fn a_wait_is_whole_milliseconds_and_never_none_when_one_was_asked_for() {
        assert_eq!(millis(Duration::ZERO), 0);
        assert_eq!(millis(Duration::from_micros(10)), 1, "a wait of 0 would turn the loop into a spin");
        assert_eq!(millis(Duration::from_millis(500)), 500);
        assert_eq!(millis(Duration::from_secs(5)), 5_000);
        assert_eq!(millis(Duration::MAX), i32::MAX);
    }

    /// How the loops read up to desktop 0.1.13: a receive timeout on the socket, and the read tried
    /// again when it ran out. Kept only so that the race test below can show what it is a test of.
    struct OldWay(Socket);

    impl OldWay {
        fn new(socket: Socket, wait: Duration) -> Self {
            tcp_of(&socket).unwrap().set_read_timeout(Some(wait)).unwrap();
            Self(socket)
        }

        fn read(&mut self) -> Result<Option<Message>, String> {
            match self.0.read() {
                Ok(message) => Ok(Some(message)),
                // Unix says WouldBlock and Windows TimedOut for a receive that ran out of time.
                Err(Error::Io(e)) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    enum Reader {
        New(HubSocket),
        Old(OldWay),
    }

    /// The race itself, at volume: every frame is sent so that it arrives about when its reader's
    /// wait runs out, on many connections at once.
    ///
    /// Not part of a normal run, because it takes as long as it is told to:
    /// `LGR_RACE_SECONDS=150 LGR_RACE_CONNECTIONS=128 cargo test -- --ignored --nocapture frames_that_race`
    ///
    /// With `LGR_RACE_OLD_WAY=1` the frames are read the way they were up to desktop 0.1.13, and on
    /// Windows this test then FAILS, which is what it is for. On Windows 11, 128 connections for
    /// 150 s: read the old way, 16 frames of 37,480 were lost (each a receive that failed with
    /// os error 997, and then the next frame but one); read through [`HubSocket`], none of 37,478.
    #[test]
    #[ignore]
    fn frames_that_race_the_end_of_a_wait_all_arrive() {
        let number = |name: &str, default: u64| std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(default);
        let seconds = number("LGR_RACE_SECONDS", 30);
        let connections = number("LGR_RACE_CONNECTIONS", 32) as usize;
        let old_way = std::env::var("LGR_RACE_OLD_WAY").is_ok_and(|v| v == "1");
        let wait = Duration::from_millis(500);
        let until = Instant::now() + Duration::from_secs(seconds);

        let readers: Vec<_> = (0..connections)
            .map(|idx| {
                std::thread::spawn(move || {
                    let (socket, hub) = connect(Transport::Plain, false);
                    let mut reader = if old_way { Reader::Old(OldWay::new(socket, wait)) } else { Reader::New(HubSocket::new(socket).unwrap()) };
                    // A sender of its own, so that a frame can arrive while the reader is in its wait.
                    let sender = std::thread::spawn(move || {
                        let mut seed = 0x9E37_79B9_7F4A_7C15u64 ^ (1234 + idx as u64);
                        let mut sent = 0u64;
                        while Instant::now() < until {
                            sent += 1;
                            if hub.send(Do::Raw(frame(&sent.to_string()))).is_err() {
                                break;
                            }
                            seed ^= seed << 13;
                            seed ^= seed >> 7;
                            seed ^= seed << 17;
                            tick_sleep(Duration::from_millis(488 + seed % 36));
                        }
                        (sent, hub)
                    });
                    let mut expect = 1u64;
                    let mut problems = Vec::new();
                    // Read on a little past the last send, so that the last frame is in.
                    while Instant::now() < until + 4 * wait && problems.len() < 5 {
                        let read = match &mut reader {
                            Reader::New(socket) => socket.read(wait),
                            Reader::Old(socket) => socket.read(),
                        };
                        match read {
                            Ok(Some(Message::Text(t))) => {
                                let got: u64 = t.parse().unwrap();
                                if got != expect {
                                    problems.push(format!("connection {idx}: wanted frame {expect}, got {got}"));
                                }
                                expect = got + 1;
                            }
                            Ok(Some(other)) => problems.push(format!("connection {idx}: {other:?}")),
                            Ok(None) => {}
                            Err(e) => problems.push(format!("connection {idx}, after frame {}: {e}", expect - 1)),
                        }
                    }
                    let (sent, _hub) = sender.join().unwrap();
                    if expect - 1 != sent {
                        problems.push(format!("connection {idx}: {sent} sent, {} read", expect - 1));
                    }
                    (sent, problems)
                })
            })
            .collect();

        let mut total = 0;
        let mut problems = Vec::new();
        for reader in readers {
            let (sent, mut found) = reader.join().unwrap();
            total += sent;
            problems.append(&mut found);
        }
        println!(
            "{total} frames on {connections} connections in {seconds} s, read {}: {} problems",
            if old_way { "the old way" } else { "through HubSocket" },
            problems.len()
        );
        assert!(problems.is_empty(), "{} problems in {total} frames: {problems:#?}", problems.len());
        assert!(total as usize >= connections * 2, "only {total} frames were sent");
    }

    /// Sleep the coarse way, to the next clock tick after `time`: a parked thread wakes on a tick,
    /// where std's `sleep` is a high-resolution timer on Windows. A hub's frame and the reader's
    /// wait then end on the same tick far more often than chance would have it, and that is what
    /// makes the race findable: with `sleep` the old way lost nothing in 38,017 frames.
    fn tick_sleep(time: Duration) {
        let until = Instant::now() + time;
        // A park can end early, so it is asked again until the time is up.
        while let Some(left) = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
            std::thread::park_timeout(left);
        }
    }
}
