//! #356 (FR-20.51, AC 50): another machine claiming this server's LAN address. RFC 5227 address
//! conflict detection, on Linux.
//!
//! - **The clone `lan_clone` cannot see.** A copy of an Ubuntu master's disk keeps `/etc/machine-id`;
//!   systemd-networkd derives its DHCP client id from it, and a router that leases by client id
//!   (dnsmasq, most shop routers) gives the copy the original's own address. Its advert then names this
//!   node, from another start, at THIS machine's address, which is exactly what this machine's own
//!   record from before a restart looks like: `lan_clone` skips it by design. No TLS probe tells them
//!   apart either, since a connection to its own address never leaves this machine.
//! - **ARP does.** The supervisor probes its address (sender IP 0.0.0.0, RFC 5227 §2.1.1) three times
//!   once the address is known, then every two minutes, and reads every ARP packet on that interface.
//!   One whose sender IP is this server's address and whose sender MAC is none of this machine's is
//!   another machine claiming it (§2.4). A machine that holds an address answers a probe for it, so a
//!   quiet one is found as well.
//! - ⚠ **Detection, never defence.** Nothing is ever announced: two copies defending one address would
//!   flap every till's ARP cache from one to the other.
//! - ⚠ **CAP_NET_RAW is a FILE capability of this binary**, `cap_net_raw=p`, written by root as it
//!   installs a version (`grant_file_capability`: `update install-bundle`, the update helper's
//!   installs, `service install`). Never the unit's: an ambient capability reaches every child, and a
//!   version that never drops it (a rollback to one from before this check) would hand it to the API
//!   and mongod. A file capability reaches this binary alone. Bun, mongod and the PDF browser are other
//!   files, and the inheritable and ambient sets stay empty, so a child gets nothing even while the
//!   supervisor holds it. A version installed before this check carries none: a rollback to it runs no
//!   watch, and nothing wider. The #370 restart in place (`exec` of `/proc/self/exe`) gets it again from
//!   the file.
//! - ⚠ **Permitted only, never `+ep`.** With the effective flag the kernel refuses to EXECUTE the binary
//!   wherever CAP_NET_RAW is outside the bounding set (a restricted pod that drops ALL, `--cap-drop
//!   NET_RAW`, a `CapabilityBoundingSet=` drop-in), so the server would not start at all. Without it the
//!   binary runs there with no capability, and no watch. So the supervisor raises the capability to
//!   effective itself, opens the socket before the async runtime starts a thread, and drops it from
//!   every set right there (`open_before_threads`, once per process, the socket kept for every start
//!   in it). Without the capability (none on the file yet, `NoNewPrivileges=`, a nosuid mount, a
//!   container that drops it) the watch is off and the status says why. It is never a reason not to
//!   start.
//! - **A conflict** is a warning in the log, `state/address-conflict.json` and the status. Never
//!   `clone.json`: that one locks legal numbering (`series-lock.service#lanCloneTick`), and only a
//!   machine proven to hold this server's keys may lock it. An advert naming this node from another
//!   start at the same address makes it a PROBABLE clone, still not a proven one (an advert proves
//!   nothing, and this machine's own stale record looks the same), so still no lock.
//! - ⚠ **That advert never reaches `advert::browse` (#380).** The other copy sends it from this
//!   machine's own address, and the kernel drops such a packet as a martian (`accept_local=0`) before
//!   any socket of the IP stack sees it. So the watch reads mDNS on a second packet socket too, ahead
//!   of that check: IPv4 UDP to 5353 only (a BPF filter in the kernel), kept when it came from this
//!   address and from the MAC that claims it over ARP (`mdns_wire.rs` reads it). The browse stays: its
//!   query makes this machine's own responder answer on the wire, which is what the other copy reads.
//! - **A router that answers for every address** (proxy ARP, as some client-isolating networks do)
//!   would look like a conflict: an answer from the default gateway's MAC is not one.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;

/// ARP's ethertype.
pub const ETH_P_ARP: u16 = 0x0806;
const HTYPE_ETHERNET: u16 = 1;
const PTYPE_IPV4: u16 = 0x0800;
const OP_REQUEST: u16 = 1;

/// RFC 5227 §2.1.1: three probes, one to two seconds apart, once the address is known.
pub const PROBES: u32 = 3;
pub const PROBE_GAP: Duration = Duration::from_millis(1500);
/// Then a probe every two minutes: a machine that holds the address answers it, however quiet.
pub const EVERY: Duration = Duration::from_secs(120);
/// How often the address is looked up again: DHCP may move it.
const LOOK: Duration = Duration::from_secs(30);
/// A conflict that goes on is written at most once a minute, and looked into (does an advert name this
/// node at that address?) at most every five minutes, whichever machine it is: several copies of one
/// disk take turns. Each machine is warned of once an hour, and no two warnings come within ten
/// seconds, so a flood of made-up senders cannot fill the log.
const WRITE_EVERY: Duration = Duration::from_secs(60);
const CLONE_LOOK_EVERY: Duration = Duration::from_secs(300);
const WARN_EVERY: Duration = Duration::from_secs(3600);
const WARN_GAP: Duration = Duration::from_secs(10);

/// An Ethernet/IPv4 ARP packet, as it is after the link-layer header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Arp {
    pub op: u16,
    pub sender_mac: [u8; 6],
    pub sender_ip: Ipv4Addr,
    pub target_mac: [u8; 6],
    pub target_ip: Ipv4Addr,
}

/// An RFC 5227 probe for `target`, from `mac`: a request whose sender IP is 0.0.0.0, so no cache that
/// hears it learns anything from it.
pub fn probe(mac: [u8; 6], target: Ipv4Addr) -> [u8; 28] {
    let mut p = [0u8; 28];
    p[0..2].copy_from_slice(&HTYPE_ETHERNET.to_be_bytes());
    p[2..4].copy_from_slice(&PTYPE_IPV4.to_be_bytes());
    p[4] = 6;
    p[5] = 4;
    p[6..8].copy_from_slice(&OP_REQUEST.to_be_bytes());
    p[8..14].copy_from_slice(&mac);
    // 14..18, the sender IP, stays 0.0.0.0; 18..24, the target MAC, is what is asked.
    p[24..28].copy_from_slice(&target.octets());
    p
}

/// An ARP packet off the wire (a padded frame included), or None for anything but Ethernet/IPv4 ARP.
pub fn parse(b: &[u8]) -> Option<Arp> {
    if b.len() < 28 || u16::from_be_bytes([b[0], b[1]]) != HTYPE_ETHERNET || u16::from_be_bytes([b[2], b[3]]) != PTYPE_IPV4 || b[4] != 6 || b[5] != 4 {
        return None;
    }
    let mac = |at: usize| [b[at], b[at + 1], b[at + 2], b[at + 3], b[at + 4], b[at + 5]];
    let ip = |at: usize| Ipv4Addr::new(b[at], b[at + 1], b[at + 2], b[at + 3]);
    Some(Arp { op: u16::from_be_bytes([b[6], b[7]]), sender_mac: mac(8), sender_ip: ip(14), target_mac: mac(18), target_ip: ip(24) })
}

/// Whether `p` is another machine claiming `ours` (RFC 5227 §2.4): its sender IP is ours, and its
/// sender MAC is none of this machine's. A probe (sender 0.0.0.0) claims nothing, and neither does a
/// sender MAC no machine has (zeros, or a group address).
pub fn claims(p: &Arp, ours: Ipv4Addr, our_macs: &[[u8; 6]]) -> bool {
    !ours.is_unspecified() && p.sender_ip == ours && p.sender_mac != [0; 6] && p.sender_mac[0] & 1 == 0 && !our_macs.contains(&p.sender_mac)
}

pub fn mac_text(m: &[u8; 6]) -> String {
    m.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

/// `52:54:00:12:34:56`, as `/sys/class/net/<if>/address` and `/proc/net/arp` write one.
pub fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let bytes: Vec<u8> = s.trim().split(':').map(|h| if h.len() == 2 { u8::from_str_radix(h, 16).ok() } else { None }).collect::<Option<_>>()?;
    bytes.try_into().ok()
}

/// The default route's gateway on `interface`, from `/proc/net/route`. Its addresses are the wire's
/// four bytes printed as one native word, so `to_ne_bytes` gives them back on any machine.
pub fn default_gateway(route: &str, interface: &str) -> Option<Ipv4Addr> {
    route.lines().skip(1).find_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let (iface, dest, gw, flags) = (*f.first()?, *f.get(1)?, *f.get(2)?, *f.get(3)?);
        // RTF_UP | RTF_GATEWAY.
        if iface != interface || dest != "00000000" || u32::from_str_radix(flags, 16).ok()? & 0x3 != 0x3 {
            return None;
        }
        Some(Ipv4Addr::from(u32::from_str_radix(gw, 16).ok()?.to_ne_bytes()))
    })
}

/// What `/proc/net/arp` says `ip` is at, on `interface`: None while it is not resolved.
pub fn arp_entry(table: &str, ip: Ipv4Addr, interface: &str) -> Option<[u8; 6]> {
    table.lines().skip(1).find_map(|line| {
        // IP address, HW type, Flags (0x2: complete), HW address, Mask, Device.
        let f: Vec<&str> = line.split_whitespace().collect();
        let complete = u32::from_str_radix(f.get(2)?.trim_start_matches("0x"), 16).ok()? & 0x2 != 0;
        if f.first()?.parse::<Ipv4Addr>().ok()? != ip || *f.get(5)? != interface || !complete {
            return None;
        }
        parse_mac(f.get(3)?)
    })
}

/// When to probe: `PROBES` at `PROBE_GAP` from a new address on, then every `EVERY`.
#[derive(Debug, Clone, Copy)]
pub struct Probes {
    left: u32,
    next: Instant,
}

impl Probes {
    pub fn new(now: Instant) -> Self {
        Self { left: PROBES, next: now }
    }

    /// Whether one is due at `now`. When it is, the next one is scheduled.
    pub fn due(&mut self, now: Instant) -> bool {
        if now < self.next {
            return false;
        }
        self.left = self.left.saturating_sub(1);
        self.next = now + if self.left > 0 { PROBE_GAP } else { EVERY };
        true
    }

    pub fn next(&self) -> Instant {
        self.next
    }
}

/// Another machine claiming this server's address, as it is recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub address: Ipv4Addr,
    pub other_mac: [u8; 6],
    pub interface: String,
    /// An advert names this node from another start at that address too.
    pub probable_clone: bool,
}

/// Write `state/address-conflict.json` and say what it holds. The first sighting of the same machine
/// at the same address stays (when it began is what a person asks first), and so does "probable
/// clone": the advert that made it one is not heard at every look.
pub fn record(file: &Path, c: &Conflict, now: SystemTime) -> Result<serde_json::Value> {
    let at = time::OffsetDateTime::from(now).format(&time::format_description::well_known::Rfc3339)?;
    let (address, other) = (c.address.to_string(), mac_text(&c.other_mac));
    let before = load(file).filter(|v| v["address"].as_str() == Some(address.as_str()) && v["otherMac"].as_str() == Some(other.as_str()));
    let first = before.as_ref().and_then(|v| v["firstSeen"].as_str().map(str::to_string)).unwrap_or_else(|| at.clone());
    let probable = c.probable_clone || before.as_ref().and_then(|v| v["probableClone"].as_bool()) == Some(true);
    let v = serde_json::json!({ "at": at, "firstSeen": first, "address": address, "otherMac": other, "interface": c.interface, "probableClone": probable });
    crate::config::write_durable(file, v.to_string().as_bytes(), 0o644)?;
    Ok(v)
}

pub fn load(file: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

/// What `Supervisor::status` says of the watch: null where it never runs (Windows, macOS).
static STATUS: Mutex<serde_json::Value> = Mutex::new(serde_json::Value::Null);

pub fn status() -> serde_json::Value {
    STATUS.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn set_status(v: serde_json::Value) {
    *STATUS.lock().unwrap_or_else(|p| p.into_inner()) = v;
}

/// CAP_NET_RAW, as the kernel numbers it.
pub const CAP_NET_RAW: u32 = 13;

/// The `security.capability` value that gives a binary `cap_net_raw=p`: `vfs_cap_data` revision 2,
/// what `setcap` writes outside a user namespace. Little-endian: the magic, WITHOUT the effective flag
/// (see the module's note on `+ep`), then permitted and inheritable for capabilities 0-31, then 32-63.
pub fn file_capability() -> [u8; 20] {
    const VFS_CAP_REVISION_2: u32 = 0x0200_0000;
    let mut v = [0u8; 20];
    v[0..4].copy_from_slice(&VFS_CAP_REVISION_2.to_le_bytes());
    v[4..8].copy_from_slice(&(1u32 << CAP_NET_RAW).to_le_bytes());
    v
}

/// Give the supervisor binary `exe` its CAP_NET_RAW, as root installs a version or a home (FR-20.20,
/// `service install`). Best effort: a filesystem without extended attributes leaves that version
/// without the watch, and says so; it never fails an install. Off Linux, and when not root (a test),
/// nothing. ⚠ Written last: a write to the file, or a chown, clears it.
pub fn grant_file_capability(exe: &Path) {
    #[cfg(target_os = "linux")]
    linux::grant(exe);
    #[cfg(not(target_os = "linux"))]
    let _ = exe;
}

/// Why this process could not open the ARP socket: whether its binary carries the file capability,
/// and what its `/proc/self/status` says (`NoNewPrivs`, the bounding set `CapBnd`).
pub fn why_not(has_file_capability: bool, status: &str) -> String {
    let field = |name: &str| status.lines().find_map(|l| l.strip_prefix(name)?.strip_prefix(':')).map(str::trim);
    let bounded = field("CapBnd").and_then(|v| u64::from_str_radix(v, 16).ok()).is_some_and(|b| b & (1 << CAP_NET_RAW) != 0);
    if !has_file_capability {
        "this binary carries no CAP_NET_RAW file capability (installed by a version before this check, copied by hand, or on a filesystem without extended attributes): the next install or update gives it one".into()
    } else if field("NoNewPrivs") == Some("1") {
        "NoNewPrivileges= is set, and it ignores file capabilities".into()
    } else if !bounded {
        "CAP_NET_RAW is outside this process's bounding set: the container or the unit drops it".into()
    } else {
        "this binary's file capability was not granted (a filesystem mounted nosuid, or a user namespace that does not honour it)".into()
    }
}

/// Open the ARP socket with the CAP_NET_RAW this binary's file capability gives, then drop it from
/// every set. Once per process, for every start it makes (`run`): #376 starts again in the same
/// process, and so does #370 when its `exec` fails, both long after there is anything to open it
/// with. ⚠ Before the async runtime starts a thread (`run_supervisor_blocking`): capabilities are per
/// thread, and a drop made later leaves the runtime's workers holding it.
pub fn open_before_threads() {
    #[cfg(target_os = "linux")]
    linux::open_once();
}

/// The watch, for as long as the supervisor runs. With this node's id and this start's nonce it can
/// tell a probable clone from another machine; without them it reports conflicts alone.
pub async fn run(node: Option<String>, boot: Option<String>, file: PathBuf) {
    #[cfg(target_os = "linux")]
    linux::watch_with(linux::socket(), linux::mdns_socket(), node, boot, file, linux::here_now).await;
    #[cfg(not(target_os = "linux"))]
    let _ = (node, boot, file);
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::ffi::CString;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::sync::OnceLock;

    const CAP_VERSION_3: u32 = 0x2008_0522;
    const PACKET_OUTGOING: u8 = 4;

    /// The process's one ARP socket, or why there is none. It lives as long as the process: every
    /// start in it borrows it (`Borrowed`), and none closes it.
    static SOCKET: OnceLock<std::result::Result<OwnedFd, String>> = OnceLock::new();
    /// The process's mDNS packet socket (#380), opened with the ARP one, or none.
    static MDNS: OnceLock<Option<OwnedFd>> = OnceLock::new();

    pub fn open_once() {
        SOCKET.get_or_init(|| {
            // Root has it effective already; the service user has it, from the file, permitted only.
            if let Err(e) = raise_net_raw() {
                tracing::debug!(error = %e, "CAP_NET_RAW could not be raised");
            }
            let opened = open().map_err(|e| match e.raw_os_error() {
                Some(libc::EPERM) | Some(libc::EACCES) => why_not(file_capability_on(Path::new("/proc/self/exe")), &std::fs::read_to_string("/proc/self/status").unwrap_or_default()),
                _ => format!("the ARP socket cannot be opened: {e}"),
            });
            // Without it the watch still finds a conflict; it only cannot read the other copy's advert.
            let _ = MDNS.set(match open_mdns() {
                Ok(fd) => Some(fd),
                Err(e) => {
                    if opened.is_ok() {
                        tracing::warn!(error = %e, "the mDNS packet socket cannot be opened: a copy of this server at its own address is reported as a conflict, never as a probable clone");
                    }
                    None
                }
            });
            match drop_net_raw().and_then(|()| holds_net_raw()) {
                Ok(false) => {}
                Ok(true) => tracing::error!("CAP_NET_RAW is still held after dropping it"),
                Err(e) => tracing::error!(error = %e, "CAP_NET_RAW could not be dropped"),
            }
            opened
        });
    }

    /// The process's socket, or why there is none.
    pub fn socket() -> std::result::Result<RawFd, String> {
        match SOCKET.get() {
            Some(Ok(fd)) => Ok(fd.as_raw_fd()),
            Some(Err(reason)) => Err(reason.clone()),
            None => Err("the ARP socket was not opened before the supervisor started".into()),
        }
    }

    /// The process's mDNS packet socket, if it has one.
    pub fn mdns_socket() -> Option<RawFd> {
        MDNS.get().and_then(Option::as_ref).map(AsRawFd::as_raw_fd)
    }

    /// The socket a start watches, borrowed from `SOCKET`: registered again by every start, closed by
    /// none.
    struct Borrowed(RawFd);

    impl AsRawFd for Borrowed {
        fn as_raw_fd(&self) -> RawFd {
            self.0
        }
    }

    /// `security.capability` on `exe` (followed through `/proc/self/exe`), with CAP_NET_RAW permitted.
    /// A revision 3 value (24 bytes, from inside a user namespace) keeps the same permitted word.
    pub fn file_capability_on(exe: &Path) -> bool {
        let Ok(path) = CString::new(exe.as_os_str().as_bytes()) else { return false };
        let mut v = [0u8; 24];
        // SAFETY: the path and the buffer outlive the call, and the length is the buffer's.
        let n = unsafe { libc::getxattr(path.as_ptr(), c"security.capability".as_ptr(), v.as_mut_ptr().cast(), v.len()) };
        n >= 20 && u32::from_le_bytes([v[4], v[5], v[6], v[7]]) & (1 << CAP_NET_RAW) != 0
    }

    pub fn grant(exe: &Path) {
        // SAFETY: geteuid(2) cannot fail.
        if unsafe { libc::geteuid() } != 0 {
            tracing::debug!(exe = %exe.display(), "not root: no file capability written");
            return;
        }
        let value = file_capability();
        let written = CString::new(exe.as_os_str().as_bytes()).map_err(io::Error::from).and_then(|path| {
            // SAFETY: the path and the value outlive the call, and the length is the value's.
            if unsafe { libc::setxattr(path.as_ptr(), c"security.capability".as_ptr(), value.as_ptr().cast(), value.len(), 0) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
        match written {
            Ok(()) => tracing::info!(exe = %exe.display(), "the supervisor binary carries CAP_NET_RAW, for its address conflict watch"),
            Err(e) => tracing::warn!(exe = %exe.display(), error = %e, "the supervisor binary could not be given CAP_NET_RAW: this version runs without its address conflict watch"),
        }
    }

    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: libc::c_int,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CapData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }

    /// An AF_PACKET socket for ARP on every interface, the link-layer header stripped (SOCK_DGRAM).
    pub fn open() -> io::Result<OwnedFd> {
        // SAFETY: socket(2) with constant arguments; the descriptor is owned at once.
        let fd = unsafe { libc::socket(libc::AF_PACKET, libc::SOCK_DGRAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, i32::from(ETH_P_ARP.to_be())) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh descriptor that nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    const fn bpf(code: u16, jt: u8, jf: u8, k: u32) -> libc::sock_filter {
        libc::sock_filter { code, jt, jf, k }
    }

    /// Classic BPF over what a SOCK_DGRAM packet socket sees, from the IP header on: a whole IPv4 UDP
    /// datagram to 5353 is kept, everything else is dropped in the kernel. A jump goes `jt`/`jf`
    /// instructions past the next one; the last is the drop. ⚠ A `static`: the kernel reads it through
    /// a pointer, and a `const` is a fresh temporary wherever it is named.
    static MDNS_FILTER: [libc::sock_filter; 12] = [
        bpf(0x30, 0, 0, 0),           // A = the version and header length byte
        bpf(0x54, 0, 0, 0xf0),        // A &= 0xf0
        bpf(0x15, 0, 8, 0x40),        // IPv4, or drop
        bpf(0x30, 0, 0, 9),           // A = the protocol
        bpf(0x15, 0, 6, 17),          // UDP, or drop
        bpf(0x28, 0, 0, 6),           // A = the flags and the fragment offset
        bpf(0x45, 4, 0, 0x3fff),      // a fragment (more to come, or an offset): drop
        bpf(0xb1, 0, 0, 0),           // X = the header's length
        bpf(0x48, 0, 0, 2),           // A = the UDP destination port
        bpf(0x15, 0, 1, crate::mdns_wire::MDNS_PORT as u32), // 5353, or drop
        bpf(0x06, 0, 0, 0xffff),      // keep it whole
        bpf(0x06, 0, 0, 0),           // drop
    ];

    /// #380: an AF_PACKET socket for the mDNS answers the IP stack drops as martians, on every
    /// interface. Made with no protocol, so nothing reaches it until the filter is on and it is bound
    /// to IPv4: it never holds anything but mDNS.
    pub fn open_mdns() -> io::Result<OwnedFd> {
        // SAFETY: socket(2) with constant arguments; the descriptor is owned at once.
        let fd = unsafe { libc::socket(libc::AF_PACKET, libc::SOCK_DGRAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a fresh descriptor that nothing else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let program = libc::sock_fprog { len: MDNS_FILTER.len() as u16, filter: MDNS_FILTER.as_ptr().cast_mut() };
        // SAFETY: the program and its instructions outlive the call, which copies them; the length is
        // the program's.
        let attached = unsafe {
            libc::setsockopt(fd.as_raw_fd(), libc::SOL_SOCKET, libc::SO_ATTACH_FILTER, (&program as *const libc::sock_fprog).cast(), std::mem::size_of::<libc::sock_fprog>() as libc::socklen_t)
        };
        if attached != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: all zeros is a valid sockaddr_ll.
        let mut at: libc::sockaddr_ll = unsafe { std::mem::zeroed() };
        at.sll_family = libc::AF_PACKET as u16;
        at.sll_protocol = (libc::ETH_P_IP as u16).to_be();
        // SAFETY: the address outlives the call, and the length is its own.
        if unsafe { libc::bind(fd.as_raw_fd(), (&at as *const libc::sockaddr_ll).cast(), std::mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(fd)
    }

    fn caps() -> io::Result<(CapHeader, [CapData; 2])> {
        let mut hdr = CapHeader { version: CAP_VERSION_3, pid: 0 };
        let mut data = [CapData::default(); 2];
        // SAFETY: capget(2) with a version 3 header and the two data words that version fills.
        if unsafe { libc::syscall(libc::SYS_capget, &mut hdr as *mut CapHeader, data.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((hdr, data))
    }

    /// Whether this thread holds CAP_NET_RAW in any set.
    pub fn holds_net_raw() -> io::Result<bool> {
        let (_, data) = caps()?;
        // SAFETY: prctl(2) with integer arguments; -1 (EINVAL) on a kernel without ambient capabilities.
        let ambient = unsafe { libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_IS_SET as libc::c_ulong, libc::c_ulong::from(CAP_NET_RAW), 0 as libc::c_ulong, 0 as libc::c_ulong) } == 1;
        Ok(ambient || (data[0].effective | data[0].permitted | data[0].inheritable) & (1 << CAP_NET_RAW) != 0)
    }

    fn set_caps(hdr: &CapHeader, data: &[CapData; 2]) -> io::Result<()> {
        // SAFETY: capset(2) with the header and the data words capget filled.
        if unsafe { libc::syscall(libc::SYS_capset, hdr as *const CapHeader, data.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Make CAP_NET_RAW effective, when it is permitted: the file capability gives it permitted only.
    pub fn raise_net_raw() -> io::Result<()> {
        let (hdr, mut data) = caps()?;
        let bit = 1u32 << CAP_NET_RAW;
        if data[0].permitted & bit == 0 || data[0].effective & bit != 0 {
            return Ok(());
        }
        data[0].effective |= bit;
        set_caps(&hdr, &data)
    }

    /// Drop CAP_NET_RAW from this thread's ambient, effective, permitted and inheritable sets. Lowering
    /// a capability needs none; one held nowhere is left as it is. The bounding set is left alone, so an
    /// `exec` of this binary (#370) gets it again from the file.
    pub fn drop_net_raw() -> io::Result<()> {
        // SAFETY: prctl(2) with integer arguments. EINVAL on a kernel without ambient capabilities
        // (before 4.3), which then has none to lower.
        unsafe { libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_LOWER as libc::c_ulong, libc::c_ulong::from(CAP_NET_RAW), 0 as libc::c_ulong, 0 as libc::c_ulong) };
        let (hdr, mut data) = caps()?;
        let bit = 1u32 << CAP_NET_RAW;
        if (data[0].effective | data[0].permitted | data[0].inheritable) & bit == 0 {
            return Ok(());
        }
        data[0].effective &= !bit;
        data[0].permitted &= !bit;
        data[0].inheritable &= !bit;
        set_caps(&hdr, &data)
    }

    /// One broadcast ARP packet out of `ifindex`.
    pub fn send(fd: RawFd, ifindex: i32, payload: &[u8]) -> io::Result<()> {
        // SAFETY: all zeros is a valid sockaddr_ll.
        let mut to: libc::sockaddr_ll = unsafe { std::mem::zeroed() };
        to.sll_family = libc::AF_PACKET as u16;
        to.sll_protocol = ETH_P_ARP.to_be();
        to.sll_ifindex = ifindex;
        to.sll_halen = 6;
        to.sll_addr[..6].copy_from_slice(&[0xff; 6]);
        // SAFETY: the payload and the address outlive the call, and the lengths are theirs.
        let n = unsafe { libc::sendto(fd, payload.as_ptr().cast(), payload.len(), 0, (&to as *const libc::sockaddr_ll).cast(), std::mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t) };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// A packet read: its length in the buffer, the interface it was seen on, how
    /// (`PACKET_OUTGOING`: this machine's own) and the MAC it came from.
    #[derive(Debug, Clone, Copy)]
    pub struct Got {
        pub len: usize,
        pub ifindex: i32,
        pub kind: u8,
        pub from: [u8; 6],
    }

    /// One packet, or None while none waits.
    pub fn recv(fd: RawFd, buf: &mut [u8]) -> io::Result<Option<Got>> {
        // SAFETY: all zeros is a valid sockaddr_ll.
        let mut from: libc::sockaddr_ll = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::sockaddr_ll>() as libc::socklen_t;
        // SAFETY: the buffer and the address outlive the call, and the lengths are theirs.
        let n = unsafe { libc::recvfrom(fd, buf.as_mut_ptr().cast(), buf.len(), 0, (&mut from as *mut libc::sockaddr_ll).cast(), &mut len) };
        if n < 0 {
            let e = io::Error::last_os_error();
            return if e.kind() == io::ErrorKind::WouldBlock { Ok(None) } else { Err(e) };
        }
        let mut mac = [0u8; 6];
        if from.sll_halen == 6 {
            mac.copy_from_slice(&from.sll_addr[..6]);
        }
        Ok(Some(Got { len: (n as usize).min(buf.len()), ifindex: from.sll_ifindex, kind: from.sll_pkttype, from: mac }))
    }

    /// The address watched, its interface, and every MAC this machine has.
    #[derive(Clone)]
    pub struct Here {
        pub ip: Ipv4Addr,
        pub interface: String,
        pub ifindex: i32,
        pub mac: [u8; 6],
        pub ours: Vec<[u8; 6]>,
    }

    pub fn sysfs_mac(interface: &str) -> Option<[u8; 6]> {
        parse_mac(&std::fs::read_to_string(format!("/sys/class/net/{interface}/address")).ok()?).filter(|m| *m != [0; 6])
    }

    fn local_macs() -> Vec<[u8; 6]> {
        std::fs::read_dir("/sys/class/net").into_iter().flatten().flatten().filter_map(|e| sysfs_mac(&e.file_name().to_string_lossy())).collect()
    }

    /// The address pairing codes and the advert name (`certs::lan_ip`), on an interface with ARP: none
    /// on a tunnel, which has no link-layer address.
    pub fn here_now() -> Option<Here> {
        let ip = crate::certs::lan_ip(&crate::certs::lan_addresses(), crate::certs::default_route_v4())?;
        let iface = if_addrs::get_if_addrs().ok()?.into_iter().find(|i| i.ip() == std::net::IpAddr::V4(ip))?;
        let ifindex = i32::try_from(iface.index?).ok()?;
        let mac = sysfs_mac(&iface.name)?;
        Some(Here { ip, interface: iface.name, ifindex, mac, ours: local_macs() })
    }

    /// The default gateway's MAC on `interface`, as this machine's ARP cache has it.
    fn gateway_mac(interface: &str) -> Option<[u8; 6]> {
        let gw = default_gateway(&std::fs::read_to_string("/proc/net/route").ok()?, interface)?;
        arp_entry(&std::fs::read_to_string("/proc/net/arp").ok()?, gw, interface)
    }

    /// What this start knows of the machines claiming the address: the one heard last, when each was
    /// warned of, and when anything was last warned of, written or looked into.
    #[derive(Default)]
    struct Seen {
        last: Option<Conflict>,
        warned: std::collections::HashMap<[u8; 6], Instant>,
        warned_any: Option<Instant>,
        written: Option<Instant>,
        looked: Option<Instant>,
        /// #380: adverts read on the mDNS packet socket that came from this address, each with the MAC
        /// that sent it. The newest `ADVERTS_KEPT`.
        adverts: Vec<([u8; 6], crate::advert::Heard)>,
        /// When this server's own advert was last asked to announce again (#380).
        announced: Option<Instant>,
    }

    const ADVERTS_KEPT: usize = 16;

    /// #380: every mDNS answer waiting on the packet socket, kept when it came from `h`'s address and
    /// from a machine that is not this one, with the MAC it came from.
    fn heard_on_the_wire(fd: RawFd, buf: &mut [u8], here: Option<&Here>, seen: &mut Seen) -> io::Result<()> {
        while let Some(got) = recv(fd, buf)? {
            let Some(h) = here else { continue };
            if got.kind == PACKET_OUTGOING || got.ifindex != h.ifindex || h.ours.contains(&got.from) {
                continue;
            }
            let Some((source, payload)) = crate::mdns_wire::mdns_payload(&buf[..got.len]) else { continue };
            if source != h.ip {
                continue;
            }
            for heard in crate::mdns_wire::adverts(payload) {
                if seen.adverts.iter().any(|(mac, known)| *mac == got.from && *known == heard) {
                    continue;
                }
                if seen.adverts.len() == ADVERTS_KEPT {
                    seen.adverts.remove(0);
                }
                seen.adverts.push((got.from, heard));
            }
        }
        Ok(())
    }

    fn published(on: bool, here: Option<&Here>, conflict: Option<&serde_json::Value>) -> serde_json::Value {
        serde_json::json!({ "on": on, "address": here.map(|h| h.ip.to_string()), "interface": here.map(|h| h.interface.clone()), "conflict": conflict })
    }

    /// The watch over `socket` (the process's, or a test's) and `mdns` (#380: the mDNS packet socket,
    /// when there is one), its address found by `find` (a test names a veth's).
    pub async fn watch_with(socket: std::result::Result<RawFd, String>, mdns: Option<RawFd>, node: Option<String>, boot: Option<String>, file: PathBuf, find: impl Fn() -> Option<Here>) {
        let mut shown = load(&file);
        let off = |reason: String, shown: Option<&serde_json::Value>| {
            set_status(serde_json::json!({ "on": false, "reason": reason, "conflict": shown }));
        };
        let fd = match socket {
            Ok(fd) => fd,
            Err(reason) => {
                tracing::warn!("{reason}: this server cannot tell when another machine takes its LAN address");
                return off(reason, shown.as_ref());
            }
        };
        // SAFETY: the descriptor is the process's socket (`SOCKET`, never closed) or a test's, which
        // outlives this call: open, and the same socket, for as long as this AsyncFd lives.
        let fd = match unsafe { tokio::io::unix::AsyncFd::register_with_interest(Borrowed(fd), tokio::io::Interest::READABLE) } {
            Ok(fd) => fd,
            Err(e) => {
                tracing::error!(error = %e, "the ARP socket cannot be watched");
                return off(format!("the ARP socket cannot be watched: {e}"), shown.as_ref());
            }
        };
        // SAFETY: as the ARP socket's: the process's (`MDNS`, never closed) or a test's, open for as long
        // as this AsyncFd lives.
        let mut wire = mdns.and_then(|m| match unsafe { tokio::io::unix::AsyncFd::register_with_interest(Borrowed(m), tokio::io::Interest::READABLE) } {
            Ok(m) => Some(m),
            Err(e) => {
                tracing::warn!(error = %e, "the mDNS packet socket cannot be watched: a copy of this server at its own address is reported as a conflict, never as a probable clone");
                None
            }
        });
        let mut here: Option<Here> = None;
        let mut probes = Probes::new(Instant::now());
        let mut next_look = Instant::now();
        let mut seen = Seen::default();
        let mut proxy_arp_told = false;
        let mut buf = [0u8; 128];
        // A whole mDNS message, as large as a jumbo frame carries one.
        let mut wire_buf = vec![0u8; 9216];
        set_status(published(true, None, shown.as_ref()));
        loop {
            let now = Instant::now();
            if now >= next_look {
                let found = find();
                if found.as_ref().map(|h| (h.ip, h.ifindex)) != here.as_ref().map(|h| (h.ip, h.ifindex)) {
                    match &found {
                        Some(h) => tracing::info!(address = %h.ip, interface = %h.interface, "watching for another machine that claims this address (RFC 5227)"),
                        None => tracing::info!("no LAN address on an interface with ARP: no address to watch for now"),
                    }
                    probes = Probes::new(now);
                }
                here = found;
                next_look = now + LOOK;
                set_status(published(true, here.as_ref(), shown.as_ref()));
            }
            if let Some(h) = &here {
                if probes.due(now) {
                    if let Err(e) = send(fd.get_ref().as_raw_fd(), h.ifindex, &probe(h.mac, h.ip)) {
                        tracing::debug!(error = %e, "an ARP probe could not be sent");
                    }
                }
            }
            let wake = if here.is_some() { next_look.min(probes.next()) } else { next_look };
            let mut wire_failed = false;
            tokio::select! {
                ready = fd.readable() => match ready {
                    Err(e) => {
                        tracing::error!(error = %e, "the ARP socket failed: no address conflict detection until the next start");
                        return off(format!("the ARP socket failed: {e}"), shown.as_ref());
                    }
                    Ok(mut guard) => loop {
                        match recv(guard.get_inner().as_raw_fd(), &mut buf) {
                            Ok(Some(got)) => {
                                let (Some(h), Some(p)) = (&here, parse(&buf[..got.len])) else { continue };
                                if got.kind == PACKET_OUTGOING || got.ifindex != h.ifindex || !claims(&p, h.ip, &h.ours) {
                                    continue;
                                }
                                if gateway_mac(&h.interface) == Some(p.sender_mac) {
                                    if !proxy_arp_told {
                                        tracing::info!(address = %h.ip, router = %mac_text(&p.sender_mac), "the router answers ARP for this server's address (proxy ARP): address conflicts cannot be told on this network");
                                        proxy_arp_told = true;
                                    }
                                    continue;
                                }
                                if let Some(v) = claimed(&mut seen, h, p.sender_mac, &file) {
                                    shown = Some(v);
                                    set_status(published(true, Some(h), shown.as_ref()));
                                }
                            }
                            Ok(None) => {
                                guard.clear_ready();
                                break;
                            }
                            Err(e) => {
                                tracing::debug!(error = %e, "reading the ARP socket failed");
                                guard.clear_ready();
                                break;
                            }
                        }
                    },
                },
                ready = async {
                    match &wire {
                        Some(w) => w.readable().await,
                        None => std::future::pending().await,
                    }
                } => match ready {
                    Err(e) => {
                        tracing::warn!(error = %e, "the mDNS packet socket failed: a copy of this server at its own address is reported as a conflict, never as a probable clone");
                        wire_failed = true;
                    }
                    Ok(mut guard) => {
                        if let Err(e) = heard_on_the_wire(guard.get_inner().as_raw_fd(), &mut wire_buf, here.as_ref(), &mut seen) {
                            tracing::debug!(error = %e, "reading the mDNS packet socket failed");
                        }
                        guard.clear_ready();
                    }
                },
                _ = tokio::time::sleep_until(wake.into()) => {}
            }
            if wire_failed {
                wire = None;
            }
            // Is it this server, at its own address? An advert naming this node from another start there:
            // first what the machine that claims the address sent from it (#380), then a browse, at most
            // every CLONE_LOOK_EVERY.
            let (Some(c), Some(node), Some(boot)) = (seen.last.as_mut(), node.as_ref(), boot.as_ref()) else { continue };
            if c.probable_clone {
                continue;
            }
            let me = crate::lan_clone::Me { node: node.clone(), boot: boot.clone(), ip: Some(c.address) };
            let sent: Vec<crate::advert::Heard> = seen.adverts.iter().filter(|(mac, _)| *mac == c.other_mac).map(|(_, h)| h.clone()).collect();
            let mut probable = crate::lan_clone::at_my_address(&me, &sent);
            if !probable && !seen.looked.is_some_and(|t| t.elapsed() < CLONE_LOOK_EVERY) {
                seen.looked = Some(Instant::now());
                let heard = tokio::task::spawn_blocking(|| crate::advert::browse(crate::lan_clone::LISTEN)).await.unwrap_or_default();
                probable = crate::lan_clone::at_my_address(&me, &heard);
            }
            if probable {
                c.probable_clone = true;
                tracing::error!(
                    address = %c.address,
                    other = %mac_text(&c.other_mac),
                    "PROBABLY A CLONE of this server: another machine claims its address, and an advert names this server there from another start. Two machines with one identity issue the same legal numbers. It is not proven, so legal numbering does not lock: find the other machine, and if it is a copy of this disk, install it again as a new server"
                );
                match record(&file, c, SystemTime::now()) {
                    Ok(v) => {
                        seen.written = Some(Instant::now());
                        shown = Some(v);
                        set_status(published(true, here.as_ref(), shown.as_ref()));
                    }
                    Err(e) => tracing::error!(error = %format!("{e:#}"), "the address conflict could not be recorded"),
                }
            }
        }
    }

    /// Another machine (`other`) claimed `h.ip`: warn of it (each machine hourly, never two warnings
    /// within `WARN_GAP`), and record it, at most every `WRITE_EVERY`. Says what was written, when it was.
    fn claimed(seen: &mut Seen, h: &Here, other: [u8; 6], file: &Path) -> Option<serde_json::Value> {
        let now = Instant::now();
        if !seen.last.as_ref().is_some_and(|c| c.address == h.ip && c.other_mac == other) {
            seen.last = Some(Conflict { address: h.ip, other_mac: other, interface: h.interface.clone(), probable_clone: false });
            // #380: a copy of this disk at this address hears this server's advert from an
            // announcement only. One, at most every CLONE_LOOK_EVERY, however the machines take turns.
            if seen.announced.is_none_or(|t| now.duration_since(t) >= CLONE_LOOK_EVERY) {
                seen.announced = Some(now);
                crate::advert::announce_again();
            }
        }
        // A flood of made-up senders must not grow this without end.
        if seen.warned.len() > 64 {
            seen.warned.clear();
        }
        if seen.warned.get(&other).is_none_or(|t| now.duration_since(*t) >= WARN_EVERY) && seen.warned_any.is_none_or(|t| now.duration_since(t) >= WARN_GAP) {
            tracing::warn!(
                address = %h.ip,
                other = %mac_text(&other),
                interface = %h.interface,
                "another machine claims this server's address: the tills reach one or the other. A copy of this server's disk needs a fresh /etc/machine-id (systemd-machine-id-setup), and to be installed again as a new server"
            );
            seen.warned.insert(other, now);
            seen.warned_any = Some(now);
        }
        if seen.written.is_some_and(|t| now.duration_since(t) < WRITE_EVERY) {
            return None;
        }
        match record(file, seen.last.as_ref()?, SystemTime::now()) {
            Ok(v) => {
                seen.written = Some(now);
                Some(v)
            }
            Err(e) => {
                tracing::error!(error = %format!("{e:#}"), "the address conflict could not be recorded");
                None
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn several_machines_taking_turns_are_written_once_a_minute_and_warned_of_apart() {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("state").join("address-conflict.json");
            let here = Here { ip: Ipv4Addr::new(10, 10, 120, 62), interface: "enp1s0".into(), ifindex: 2, mac: [2, 0, 0, 0, 0, 1], ours: vec![[2, 0, 0, 0, 0, 1]] };
            let (a, b) = ([2, 0, 0, 0, 0, 0xa], [2, 0, 0, 0, 0, 0xb]);
            let mut seen = Seen::default();
            let first = claimed(&mut seen, &here, a, &file).expect("the first sighting is written at once");
            assert_eq!(first["otherMac"].as_str(), Some("02:00:00:00:00:0a"));
            assert!(claimed(&mut seen, &here, b, &file).is_none(), "another copy right after: written within the minute, not now");
            assert_eq!(seen.last.as_ref().map(|c| c.other_mac), Some(b), "the one heard last is what the next write records");
            assert!(seen.warned.contains_key(&a) && !seen.warned.contains_key(&b), "never two warnings within WARN_GAP: b's comes later");
            // A flood of made-up senders.
            for i in 0..200u8 {
                seen.warned_any = None;
                claimed(&mut seen, &here, [2, 0, 0, 0, 1, i], &file);
            }
            assert!(seen.warned.len() <= 65);
        }

        #[test]
        fn dropping_a_capability_this_process_does_not_hold_is_nothing() {
            // CI runs unprivileged: nothing to drop, and nothing may fail.
            if holds_net_raw().unwrap() {
                return;
            }
            drop_net_raw().unwrap();
            assert!(!holds_net_raw().unwrap());
        }

        /// The file capability as root installs it, on a copy of this test binary run as a user. The copy
        /// holds CAP_NET_RAW (permitted only), opens the ARP socket with it, and a child it starts while it
        /// holds it (a plain copy, as the supervisor starts bun and mongod) holds nothing and cannot.
        /// ⚠ Root only (it writes `security.capability` and starts a user's process), so ignored by
        /// default: `sudo <binary> --ignored arp::linux::tests::` runs it with the veth tests.
        #[test]
        #[ignore]
        fn a_file_capability_reaches_this_binary_and_none_of_its_children() {
            use std::os::unix::fs::PermissionsExt;
            use std::os::unix::process::CommandExt;
            // SAFETY: geteuid(2) cannot fail.
            assert_eq!(unsafe { libc::geteuid() }, 0, "run as root (see above)");
            // Not /tmp: a nosuid tmpfs there would honour no file capability.
            let dir = tempfile::Builder::new().prefix("lgr-arp-cap").tempdir_in("/var/tmp").unwrap();
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
            let (capable, plain) = (dir.path().join("capable"), dir.path().join("plain"));
            for f in [&capable, &plain] {
                std::fs::copy(std::env::current_exe().unwrap(), f).unwrap();
                std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            grant(&capable);
            assert!(file_capability_on(&capable) && !file_capability_on(&plain));
            // libcap reads the value as the one `setcap cap_net_raw+p` writes.
            if let Ok(out) = std::process::Command::new("getcap").arg(&capable).output() {
                let said = String::from_utf8_lossy(&out.stdout);
                assert!(said.trim_end().ends_with("cap_net_raw=p"), "getcap: {said}");
            }
            let id = |name: &str| std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(65534);
            let status = std::process::Command::new(&capable)
                .args(["--ignored", "--exact", "arp::linux::tests::cap_probe", "--nocapture"])
                .env("LGR_ARP_CAP_PROBE", "capable")
                .env("LGR_ARP_CAP_CHILD", &plain)
                .uid(id("SUDO_UID"))
                .gid(id("SUDO_GID"))
                .status()
                .unwrap();
            assert!(status.success(), "the capable copy's probe failed");
        }

        /// What the test above runs its copies as. Nothing without `LGR_ARP_CAP_PROBE`.
        #[test]
        #[ignore]
        fn cap_probe() {
            let Ok(role) = std::env::var("LGR_ARP_CAP_PROBE") else { return };
            // SAFETY: geteuid(2) cannot fail.
            assert_ne!(unsafe { libc::geteuid() }, 0, "a user's process, not root's");
            let bit = 1u32 << CAP_NET_RAW;
            match role.as_str() {
                "capable" => {
                    let (_, data) = caps().unwrap();
                    assert_ne!(data[0].permitted & bit, 0, "permitted, from the file");
                    assert_eq!(data[0].effective & bit, 0, "never effective at exec: the file carries no effective flag");
                    assert_eq!(data[0].inheritable & bit, 0);
                    raise_net_raw().unwrap();
                    let socket = open().expect("the file capability opens the ARP socket");
                    // A child, started while this process holds it effective: another file, with nothing.
                    let child = std::env::var("LGR_ARP_CAP_CHILD").unwrap();
                    let ok = std::process::Command::new(&child).args(["--ignored", "--exact", "arp::linux::tests::cap_probe", "--nocapture"]).env("LGR_ARP_CAP_PROBE", "child").status().unwrap().success();
                    assert!(ok, "the child held something, or opened the socket");
                    drop_net_raw().unwrap();
                    assert!(!holds_net_raw().unwrap());
                    assert!(recv(socket.as_raw_fd(), &mut [0u8; 64]).is_ok(), "the socket outlives the capability");
                }
                "child" => {
                    assert!(!holds_net_raw().unwrap(), "a child of the capable binary holds nothing");
                    assert_eq!(open().expect_err("a child cannot open it").raw_os_error(), Some(libc::EPERM));
                    let why = why_not(file_capability_on(Path::new("/proc/self/exe")), &std::fs::read_to_string("/proc/self/status").unwrap());
                    assert!(why.contains("no CAP_NET_RAW file capability"), "{why}");
                }
                other => panic!("LGR_ARP_CAP_PROBE={other}"),
            }
        }

        /// Two ends of a veth pair with ONE address, the far end in a namespace of its own: what two
        /// copies of a disk that DHCP gave one address look like to each other. ⚠ Root only.
        struct Pair {
            ns: String,
            near: String,
            ifindex: i32,
            near_mac: [u8; 6],
            far_mac: [u8; 6],
            address: Ipv4Addr,
        }

        impl Pair {
            fn new(name: char, address: Ipv4Addr) -> Self {
                let tag = std::process::id() % 10_000;
                let (ns, near, far) = (format!("lgrarp{tag}{name}"), format!("lgra{tag}{name}"), format!("lgrb{tag}{name}"));
                let ip = |args: &[&str]| assert!(std::process::Command::new("ip").args(args).status().unwrap().success(), "ip {args:?}");
                ip(&["netns", "add", &ns]);
                let mut pair = Pair { ns: ns.clone(), near: near.clone(), ifindex: 0, near_mac: [0; 6], far_mac: [0; 6], address };
                let cidr = format!("{address}/24");
                ip(&["link", "add", &near, "type", "veth", "peer", "name", &far, "netns", &ns]);
                ip(&["addr", "add", &cidr, "dev", &near]);
                ip(&["link", "set", &near, "up"]);
                ip(&["netns", "exec", &ns, "ip", "addr", "add", &cidr, "dev", &far]);
                ip(&["netns", "exec", &ns, "ip", "link", "set", &far, "up"]);
                // As on any machine: mdns-sd's daemon binds its signal socket on 127.0.0.1, and with a
                // fresh namespace's loopback down it does not start at all.
                ip(&["netns", "exec", &ns, "ip", "link", "set", "lo", "up"]);
                let out = std::process::Command::new("ip").args(["netns", "exec", &ns, "cat", &format!("/sys/class/net/{far}/address")]).output().unwrap();
                pair.far_mac = parse_mac(&String::from_utf8_lossy(&out.stdout)).unwrap();
                pair.near_mac = sysfs_mac(&near).unwrap();
                pair.ifindex = i32::try_from(if_addrs::get_if_addrs().unwrap().into_iter().find(|i| i.name == near).unwrap().index.unwrap()).unwrap();
                pair
            }

            fn here(&self) -> Here {
                Here { ip: self.address, interface: self.near.clone(), ifindex: self.ifindex, mac: self.near_mac, ours: vec![self.near_mac] }
            }
        }

        impl Drop for Pair {
            fn drop(&mut self) {
                // The namespace takes the far end with it, and a veth pair dies with either end.
                let _ = std::process::Command::new("ip").args(["netns", "del", &self.ns]).status();
            }
        }

        /// A machine that holds this address answers the probe, and is found. ⚠ Needs root
        /// (namespaces and the raw socket), so it is ignored by default:
        /// `sudo <binary> --ignored --test-threads=1 arp::linux::tests::` runs them all.
        #[test]
        #[ignore]
        fn a_machine_that_holds_this_address_is_found() {
            let pair = Pair::new('p', Ipv4Addr::new(10, 213, 0, 7));
            let socket = open().unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut found = None;
            let mut buf = [0u8; 128];
            while found.is_none() && Instant::now() < deadline {
                send(socket.as_raw_fd(), pair.ifindex, &probe(pair.near_mac, pair.address)).unwrap();
                std::thread::sleep(Duration::from_millis(300));
                while let Some(got) = recv(socket.as_raw_fd(), &mut buf).unwrap() {
                    if let Some(p) = parse(&buf[..got.len]) {
                        if got.kind != PACKET_OUTGOING && got.ifindex == pair.ifindex && claims(&p, pair.address, &[pair.near_mac]) {
                            found = Some(p.sender_mac);
                        }
                    }
                }
            }
            assert_eq!(found, Some(pair.far_mac), "the far end answers the probe for the address both ends hold");
        }

        /// The watch tests below share the process's one status: one at a time.
        static ONE_WATCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        /// The whole watch, as the supervisor runs it: it probes, hears the answer, records the other
        /// machine and says so in the status. ⚠ Root only, like the one above.
        #[tokio::test]
        #[ignore]
        async fn the_watch_records_the_machine_that_holds_its_address() {
            let _one = ONE_WATCH.lock().await;
            let pair = Pair::new('w', Ipv4Addr::new(10, 213, 1, 7));
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("state").join("address-conflict.json");
            let here = pair.here();
            let find = move || Some(here.clone());
            let socket = open().unwrap();
            let _ = tokio::time::timeout(Duration::from_secs(6), watch_with(Ok(socket.as_raw_fd()), None, None, None, file.clone(), find)).await;
            let v = load(&file).expect("the conflict is recorded");
            assert_eq!((v["address"].as_str(), v["otherMac"].as_str()), (Some("10.213.1.7"), Some(mac_text(&pair.far_mac).as_str())));
            assert_eq!(v["probableClone"].as_bool(), Some(false), "no advert, no node to compare: a conflict, not a clone");
            let s = status();
            assert_eq!((s["on"].as_bool(), s["address"].as_str()), (Some(true), Some("10.213.1.7")));
            assert_eq!(s["conflict"], v);
        }

        /// #380: the far end, a copy of this disk at this machine's own address, advertises this node
        /// from another start. Its answers never reach a socket of the IP stack here (martians), so only
        /// the mDNS packet socket hears them, and the watch makes the conflict a probable clone. The far
        /// end's responder is the real one (`advert::register`), run in its namespace by this test
        /// binary (`advertise_as_a_copy`). ⚠ Root only, like the ones above.
        #[tokio::test]
        #[ignore]
        async fn a_copy_that_advertises_this_node_at_this_address_is_a_probable_clone() {
            let _one = ONE_WATCH.lock().await;
            let pair = Pair::new('c', Ipv4Addr::new(10, 213, 2, 7));
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("state").join("address-conflict.json");
            // Both open before the copy starts: its first announcement waits on the socket.
            let (socket, mdns) = (open().unwrap(), open_mdns().unwrap());
            let mut copy = std::process::Command::new("ip")
                .args(["netns", "exec", &pair.ns])
                .arg(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "arp::linux::tests::advertise_as_a_copy", "--nocapture"])
                .env("LGR_ARP_COPY", format!("node-380 boot-copy {}", pair.address))
                .spawn()
                .unwrap();
            let here = pair.here();
            let find = move || Some(here.clone());
            let watch = watch_with(Ok(socket.as_raw_fd()), Some(mdns.as_raw_fd()), Some("node-380".into()), Some("boot-original".into()), file.clone(), find);
            let _ = tokio::time::timeout(Duration::from_secs(15), watch).await;
            let _ = copy.kill();
            let _ = copy.wait();
            let v = load(&file).expect("the conflict is recorded");
            assert_eq!(v["otherMac"].as_str(), Some(mac_text(&pair.far_mac).as_str()));
            assert_eq!(v["probableClone"].as_bool(), Some(true), "the copy's advert, read on the packet socket, names this node from another start at this address");
        }

        /// The mDNS packet socket alone: the kernel's filter keeps the far end's real announcement, and it
        /// reads as the far end's, from its MAC, at the address both ends hold. ⚠ Root only.
        #[test]
        #[ignore]
        fn the_mdns_socket_reads_the_copys_announcement() {
            let pair = Pair::new('m', Ipv4Addr::new(10, 213, 3, 7));
            let mdns = open_mdns().unwrap();
            let mut copy = std::process::Command::new("ip")
                .args(["netns", "exec", &pair.ns])
                .arg(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "arp::linux::tests::advertise_as_a_copy", "--nocapture"])
                .env("LGR_ARP_COPY", format!("node-380 boot-copy {}", pair.address))
                .spawn()
                .unwrap();
            let mut buf = vec![0u8; 9216];
            let (mut frames, mut heard) = (vec![], vec![]);
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline && heard.is_empty() {
                while let Some(got) = recv(mdns.as_raw_fd(), &mut buf).unwrap() {
                    let payload = crate::mdns_wire::mdns_payload(&buf[..got.len]);
                    frames.push(format!("{} bytes on {} kind {} from {} source {:?}", got.len, got.ifindex, got.kind, mac_text(&got.from), payload.map(|p| p.0)));
                    if let Some((source, payload)) = payload {
                        for h in crate::mdns_wire::adverts(payload) {
                            heard.push((source, got.from, got.ifindex, h));
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = copy.kill();
            let _ = copy.wait();
            assert!(!frames.is_empty(), "the socket read nothing at all");
            let ok = heard.iter().any(|(source, from, at, h)| *source == pair.address && *from == pair.far_mac && *at == pair.ifindex && h.port == 4443);
            assert!(ok, "frames: {frames:#?}\nheard: {heard:#?}");
        }

        /// What the tests above run in the far end's namespace: this node's advert from another start, at
        /// the address both ends hold, for twenty seconds. Nothing without `LGR_ARP_COPY`.
        #[test]
        #[ignore]
        fn advertise_as_a_copy() {
            let Ok(spec) = std::env::var("LGR_ARP_COPY") else { return };
            let f: Vec<&str> = spec.split_whitespace().collect();
            let advert = crate::advert::Advert {
                instance: "Copy".into(),
                host: "lgr-copy".into(),
                ip: f[2].parse().unwrap(),
                port: 4443,
                node: f[0].into(),
                fingerprint: "sha256:copy".into(),
                boot: f[1].into(),
            };
            let _registration = crate::advert::register(&advert).unwrap();
            std::thread::sleep(Duration::from_secs(20));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS: [u8; 6] = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
    const THEIRS: [u8; 6] = [0x52, 0x54, 0x00, 0xab, 0xcd, 0xef];

    #[test]
    fn the_file_capability_is_cap_net_raw_permitted_and_nothing_else() {
        // What `setcap cap_net_raw+p` writes: revision 2 without the effective flag (with it the kernel
        // refuses to run the binary wherever CAP_NET_RAW is outside the bounding set), permitted bit 13,
        // and nothing inheritable.
        assert_eq!(file_capability(), [0, 0, 0, 2, 0, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn the_status_says_why_the_watch_is_off() {
        let status = |nnp: u8, bounding: &str| format!("Name:\tlgr-server\nNoNewPrivs:\t{nnp}\nCapBnd:\t{bounding}\n");
        let all = "000001ffffffffff";
        // The same with bit 13 cleared: a container or a unit that drops CAP_NET_RAW.
        let dropped = "000001ffffffdfff";
        assert!(why_not(false, &status(0, all)).contains("no CAP_NET_RAW file capability"));
        assert!(why_not(false, &status(1, dropped)).contains("no CAP_NET_RAW file capability"), "the missing file capability comes first");
        assert!(why_not(true, &status(1, all)).contains("NoNewPrivileges"));
        assert!(why_not(true, &status(0, dropped)).contains("bounding set"));
        assert!(why_not(true, &status(0, all)).contains("nosuid"));
        assert!(why_not(true, "").contains("bounding set"), "nothing known of the bounding set: it is not taken to hold it");
    }

    #[test]
    fn a_probe_asks_for_the_address_and_tells_nothing() {
        let p = probe(OURS, Ipv4Addr::new(192, 168, 1, 10));
        assert_eq!(&p[..8], &[0, 1, 8, 0, 6, 4, 0, 1], "Ethernet, IPv4, a request");
        assert_eq!(&p[8..14], &OURS);
        assert_eq!(&p[14..18], &[0, 0, 0, 0], "the sender IP is 0.0.0.0: no cache learns from a probe");
        assert_eq!(&p[18..24], &[0; 6]);
        assert_eq!(&p[24..28], &[192, 168, 1, 10]);
        assert_eq!(parse(&p), Some(Arp { op: 1, sender_mac: OURS, sender_ip: Ipv4Addr::UNSPECIFIED, target_mac: [0; 6], target_ip: Ipv4Addr::new(192, 168, 1, 10) }));
    }

    fn reply(from: [u8; 6], ip: Ipv4Addr) -> [u8; 28] {
        let mut p = probe(from, Ipv4Addr::new(192, 168, 1, 99));
        p[6..8].copy_from_slice(&2u16.to_be_bytes());
        p[14..18].copy_from_slice(&ip.octets());
        p
    }

    #[test]
    fn only_ethernet_ipv4_arp_parses() {
        let good = reply(THEIRS, Ipv4Addr::new(192, 168, 1, 10));
        // A minimum-size Ethernet frame pads the payload to 46 bytes.
        let mut padded = good.to_vec();
        padded.resize(46, 0);
        assert_eq!(parse(&padded), parse(&good));
        assert!(parse(&good[..27]).is_none(), "too short");
        let mut token_ring = good;
        token_ring[1] = 6;
        assert!(parse(&token_ring).is_none());
        let mut ipv6ish = good;
        ipv6ish[2..4].copy_from_slice(&0x86ddu16.to_be_bytes());
        assert!(parse(&ipv6ish).is_none());
        let mut long_addresses = good;
        long_addresses[4] = 8;
        assert!(parse(&long_addresses).is_none());
    }

    #[test]
    fn another_machine_claims_the_address_when_it_names_it_as_its_own() {
        let ours = Ipv4Addr::new(192, 168, 1, 10);
        let mine = [OURS, [0x02, 0, 0, 0, 0, 0x01]];
        let p = |mac, ip| parse(&reply(mac, ip)).unwrap();
        assert!(claims(&p(THEIRS, ours), ours, &mine), "a reply from another MAC for our address");
        assert!(!claims(&p(OURS, ours), ours, &mine), "our own");
        assert!(!claims(&p([0x02, 0, 0, 0, 0, 0x01], ours), ours, &mine), "another interface of this machine (ARP flux)");
        assert!(!claims(&p(THEIRS, Ipv4Addr::new(192, 168, 1, 11)), ours, &mine), "another address");
        assert!(!claims(&parse(&probe(THEIRS, ours)).unwrap(), ours, &mine), "a probe for our address claims nothing: its sender is 0.0.0.0");
        assert!(!claims(&p([0; 6], ours), ours, &mine), "no MAC");
        assert!(!claims(&p([0xff; 6], ours), ours, &mine), "broadcast");
        assert!(!claims(&p([0x01, 0, 0x5e, 0, 0, 1], ours), ours, &mine), "multicast");
        assert!(!claims(&p(THEIRS, Ipv4Addr::UNSPECIFIED), Ipv4Addr::UNSPECIFIED, &mine), "no address yet");
    }

    #[test]
    fn macs_read_as_the_kernel_writes_them() {
        assert_eq!(parse_mac("52:54:00:12:34:56\n"), Some(OURS));
        assert_eq!(mac_text(&OURS), "52:54:00:12:34:56");
        assert_eq!(parse_mac(&mac_text(&THEIRS)), Some(THEIRS));
        for bad in ["", "52:54:00:12:34", "52:54:00:12:34:56:78", "52:54:00:12:34:zz", "5:54:00:12:34:56", "525:4:00:12:34:56"] {
            assert_eq!(parse_mac(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_gateway_and_its_mac_come_from_the_kernels_tables() {
        let route = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
                     docker0\t00000000\t010011AC\t0003\t0\t0\t200\t00000000\t0\t0\t0\n\
                     enp1s0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n\
                     enp1s0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n";
        assert_eq!(default_gateway(route, "enp1s0"), Some(Ipv4Addr::new(192, 168, 0, 1)));
        assert_eq!(default_gateway(route, "docker0"), Some(Ipv4Addr::new(172, 17, 0, 1)));
        assert_eq!(default_gateway(route, "wlan0"), None);
        assert_eq!(default_gateway("Iface\tDestination\tGateway\tFlags\nenp1s0\t00000000\t0100A8C0\t0001\n", "enp1s0"), None, "a route that is not via a gateway");
        let arp = "IP address       HW type     Flags       HW address            Mask     Device\n\
                   192.168.0.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *        enp1s0\n\
                   192.168.0.7      0x1         0x0         00:00:00:00:00:00     *        enp1s0\n\
                   192.168.0.1      0x1         0x2         11:22:33:44:55:66     *        wlan0\n";
        assert_eq!(arp_entry(arp, Ipv4Addr::new(192, 168, 0, 1), "enp1s0"), Some([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
        assert_eq!(arp_entry(arp, Ipv4Addr::new(192, 168, 0, 1), "wlan0"), Some([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]));
        assert_eq!(arp_entry(arp, Ipv4Addr::new(192, 168, 0, 7), "enp1s0"), None, "not resolved");
        assert_eq!(arp_entry(arp, Ipv4Addr::new(192, 168, 0, 9), "enp1s0"), None);
    }

    #[test]
    fn three_probes_a_moment_apart_then_one_every_two_minutes() {
        let t0 = Instant::now();
        let mut p = Probes::new(t0);
        assert!(p.due(t0));
        assert!(!p.due(t0 + Duration::from_millis(100)));
        assert!(p.due(t0 + PROBE_GAP));
        assert!(p.due(t0 + PROBE_GAP * 2));
        assert_eq!(p.next(), t0 + PROBE_GAP * 2 + EVERY);
        assert!(!p.due(t0 + PROBE_GAP * 2 + EVERY - Duration::from_secs(1)));
        assert!(p.due(t0 + PROBE_GAP * 2 + EVERY));
        assert_eq!(p.next(), t0 + PROBE_GAP * 2 + EVERY * 2);
    }

    #[test]
    fn a_conflict_keeps_when_it_began_and_stays_a_probable_clone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state").join("address-conflict.json");
        let mut c = Conflict { address: Ipv4Addr::new(10, 10, 120, 62), other_mac: THEIRS, interface: "enp1s0".into(), probable_clone: false };
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        record(&file, &c, t0).unwrap();
        c.probable_clone = true;
        record(&file, &c, t0 + Duration::from_secs(60)).unwrap();
        c.probable_clone = false;
        let v = record(&file, &c, t0 + Duration::from_secs(120)).unwrap();
        assert_eq!(v, load(&file).unwrap());
        assert_eq!((v["firstSeen"].as_str(), v["at"].as_str()), (Some("2027-01-15T08:00:00Z"), Some("2027-01-15T08:02:00Z")));
        assert_eq!((v["address"].as_str(), v["otherMac"].as_str(), v["interface"].as_str()), (Some("10.10.120.62"), Some("52:54:00:ab:cd:ef"), Some("enp1s0")));
        assert_eq!(v["probableClone"].as_bool(), Some(true), "the advert that made it one is not heard at every look");
        // Another machine at the address: its own beginning, and nothing inherited.
        let other = Conflict { other_mac: OURS, ..c };
        let v = record(&file, &other, t0 + Duration::from_secs(180)).unwrap();
        assert_eq!((v["firstSeen"].as_str(), v["probableClone"].as_bool()), (Some("2027-01-15T08:03:00Z"), Some(false)));
    }
}
