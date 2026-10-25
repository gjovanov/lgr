//! FR-20.28 (plan step P1-6d) — finding LGR Servers on the shop's network.
//!
//! The onboarding's "on this network" list is what `_lgr-server._tcp` answers (`packages/server/src/
//! advert.rs`), and a paired desktop finds its master again after DHCP moves it, by the fingerprint it
//! pinned: "by identity, not by address".
//!
//! ⚠ **Nothing found here is trusted.** An advert is anyone's to send. The address it names is probed
//! and pinned exactly as a typed one is (`trust.rs`), so a forged advert leads to a refused pairing
//! or a failed pinned connection, never to trust. What an advert CAN do is fail a check: a server
//! whose certificate is not the one it advertised is refused.
//!
//! On Windows through the OS's own DNS-SD (`DnsServiceBrowse`, `DnsServiceResolve`): a per-user app
//! cannot open the firewall for a multicast listener of its own (FR-20.28). Elsewhere `mdns-sd`.
//! Multicast is often blocked (trap 9), so an address can always be typed instead.

use std::net::Ipv4Addr;
use std::time::Duration;

/// The service type the master advertises.
pub const SERVICE: &str = "_lgr-server._tcp";

/// A server found on the network, as its advert describes it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// What a person reads: the master's machine name.
    pub name: String,
    /// `https://<address>:<port>`, ready for the onboarding's address field.
    pub url: String,
    pub node: String,
    /// ⚠ As the advert CLAIMS it. Checked against the server's own certificate before it counts.
    pub fingerprint: String,
}

/// What one advert said, before it is judged.
#[derive(Debug, Clone, Default)]
struct Answer {
    instance: String,
    ip: Option<Ipv4Addr>,
    port: u16,
    txt: Vec<(String, String)>,
}

/// An advert as a `Found`, when it is one: version 1, a node id, a fingerprint, and an address no
/// public CA could certify (`trust::may_pin`, the only kind a master is paired by).
fn judge(a: &Answer) -> Option<Found> {
    let get = |k: &str| a.txt.iter().find(|(key, _)| key.eq_ignore_ascii_case(k)).map(|(_, v)| v.trim());
    if get("v") != Some("1") || a.port == 0 {
        return None;
    }
    let fingerprint = get("fp").filter(|f| crate::trust::is_fingerprint(f))?.to_string();
    let node = get("node").filter(|n| n.starts_with("master-") && n.len() <= 64)?.to_string();
    // ⚠ The advert's own `ip` first: the machine's name resolves to whichever interface answered,
    // and on a master with a VPN or an overlay that is an address no till can reach (measured).
    let ip = get("ip").and_then(|s| s.parse::<Ipv4Addr>().ok()).or(a.ip)?;
    let url = format!("https://{ip}:{}", a.port);
    if !crate::trust::may_pin(&url) {
        return None;
    }
    let name = get("name").filter(|n| !n.is_empty()).unwrap_or(a.instance.as_str());
    let name: String = name.chars().filter(|c| !c.is_control()).take(63).collect();
    Some(Found { name, url, node, fingerprint })
}

/// Listen for `window` and say what answered: each server once, in the order found.
pub fn browse(window: Duration) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    for answer in imp::browse(window) {
        if let Some(f) = judge(&answer) {
            if !out.iter().any(|o| o.url == f.url) {
                out.push(f);
            }
        }
    }
    out
}

/// The addresses at which something on the network CLAIMS to be `fingerprint`'s server.
fn find(fingerprint: &str, window: Duration) -> Vec<String> {
    browse(window).into_iter().filter(|f| f.fingerprint == fingerprint).map(|f| f.url).collect()
}

/// FR-20.28 — where the master `pin` was paired with answers now, other than `old`: found by its
/// fingerprint, and PROVEN by the pin. A candidate is pinned and asked; one whose certificate the pin
/// does not name fails the handshake, is forgotten again, and the next is tried.
pub fn locate(pin: &crate::trust::MasterPin, old: &str, window: Duration) -> Option<String> {
    for url in find(&pin.fingerprint, window) {
        if url == old || !crate::trust::set_pin(&url, Some(pin.clone())) {
            continue;
        }
        if crate::presence::probe(&url) {
            return Some(url);
        }
        crate::trust::set_pin(&url, None);
    }
    None
}

#[cfg(windows)]
mod imp {
    use super::{Answer, SERVICE};
    use std::ffi::c_void;
    use std::net::Ipv4Addr;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::DNS_REQUEST_PENDING;
    use windows_sys::Win32::NetworkManagement::Dns::{
        DnsFree, DnsFreeRecordList, DnsServiceBrowse, DnsServiceBrowseCancel, DnsServiceFreeInstance,
        DnsServiceResolve, DnsServiceResolveCancel, DNS_QUERY_REQUEST_VERSION1, DNS_RECORDW,
        DNS_SERVICE_BROWSE_REQUEST, DNS_SERVICE_BROWSE_REQUEST_0, DNS_SERVICE_CANCEL, DNS_SERVICE_INSTANCE,
        DNS_SERVICE_RESOLVE_REQUEST, DNS_TYPE_PTR,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// # Safety
    /// `p` is null or a NUL-terminated UTF-16 string.
    unsafe fn from_wide(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0;
        // SAFETY: NUL-terminated, per the contract.
        while unsafe { *p.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` units were just read.
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
    }

    /// ⚠ After a cancel the OS may still call back once: whatever it is handed must outlive us. A
    /// few bytes leaked per browse, against a callback into freed memory.
    fn leak<T>(ctx: &Arc<T>) {
        std::mem::forget(ctx.clone());
    }

    #[derive(Default)]
    struct Browsing {
        names: Mutex<Vec<String>>,
    }

    unsafe extern "system" fn browsed(_status: u32, context: *const c_void, record: *const DNS_RECORDW) {
        // SAFETY: `context` is a `Browsing` that is never freed while the OS may call (see `leak`).
        let ctx = unsafe { &*(context as *const Browsing) };
        let mut r = record;
        while !r.is_null() {
            // SAFETY: a record list the OS handed us, walked to its end.
            let rec = unsafe { &*r };
            if rec.wType == DNS_TYPE_PTR {
                // SAFETY: a PTR record's data is a PTR.
                let name = unsafe { from_wide(rec.Data.PTR.pNameHost) };
                if !name.is_empty() {
                    let mut names = ctx.names.lock().unwrap_or_else(|p| p.into_inner());
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
            r = rec.pNext;
        }
        if !record.is_null() {
            // SAFETY: the callback owns the list it is handed.
            unsafe { DnsFree(record as *const c_void, DnsFreeRecordList) };
        }
    }

    #[derive(Default)]
    struct Resolving {
        done: Mutex<Option<Option<Answer>>>,
        ready: Condvar,
    }

    /// # Safety
    /// `i` is an instance the OS handed us.
    unsafe fn read(i: &DNS_SERVICE_INSTANCE) -> Answer {
        let mut txt = Vec::new();
        for n in 0..i.dwPropertyCount as usize {
            // SAFETY: `dwPropertyCount` entries in each array.
            let (k, v) = unsafe { (*i.keys.add(n), *i.values.add(n)) };
            // SAFETY: NUL-terminated strings from the OS.
            txt.push(unsafe { (from_wide(k), from_wide(v)) });
        }
        // SAFETY: as above.
        let instance = unsafe { from_wide(i.pszInstanceName) };
        let ip = (!i.ip4Address.is_null()).then(|| {
            // SAFETY: non-null, and an IP4_ADDRESS is the address's bytes in network order.
            Ipv4Addr::from(unsafe { *i.ip4Address }.to_ne_bytes())
        });
        Answer { instance: instance.split('.').next().unwrap_or_default().to_string(), ip, port: i.wPort, txt }
    }

    unsafe extern "system" fn resolved(status: u32, context: *const c_void, instance: *const DNS_SERVICE_INSTANCE) {
        // SAFETY: `context` is a `Resolving` kept alive while the OS may call (see `leak`).
        let ctx = unsafe { &*(context as *const Resolving) };
        // SAFETY: an instance the OS handed us, or null.
        let answer = (status == 0 && !instance.is_null()).then(|| unsafe { read(&*instance) });
        *ctx.done.lock().unwrap_or_else(|p| p.into_inner()) = Some(answer);
        ctx.ready.notify_all();
        if !instance.is_null() {
            // SAFETY: the callback frees the instance it is handed.
            unsafe { DnsServiceFreeInstance(instance) };
        }
    }

    fn resolve(name: &str) -> Option<Answer> {
        let ctx = Arc::new(Resolving::default());
        let mut query = wide(name);
        let request = DNS_SERVICE_RESOLVE_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1,
            InterfaceIndex: 0,
            QueryName: query.as_mut_ptr(),
            pResolveCompletionCallback: Some(resolved),
            pQueryContext: Arc::as_ptr(&ctx) as *mut c_void,
        };
        let mut cancel = DNS_SERVICE_CANCEL { reserved: std::ptr::null_mut() };
        // SAFETY: the request and its context outlive the call (the context is leaked if it may not).
        if unsafe { DnsServiceResolve(&request, &mut cancel) } != DNS_REQUEST_PENDING {
            return None;
        }
        let guard = ctx.done.lock().unwrap_or_else(|p| p.into_inner());
        let (mut guard, timeout) = ctx
            .ready
            .wait_timeout_while(guard, Duration::from_secs(3), |d| d.is_none())
            .unwrap_or_else(|p| p.into_inner());
        if timeout.timed_out() {
            drop(guard);
            // SAFETY: the handle the resolve gave us.
            unsafe { DnsServiceResolveCancel(&cancel) };
            leak(&ctx);
            return None;
        }
        guard.take().flatten()
    }

    pub fn browse(window: Duration) -> Vec<Answer> {
        let ctx = Arc::new(Browsing::default());
        let query = wide(&format!("{SERVICE}.local"));
        let request = DNS_SERVICE_BROWSE_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1,
            InterfaceIndex: 0,
            QueryName: query.as_ptr(),
            Anonymous: DNS_SERVICE_BROWSE_REQUEST_0 { pBrowseCallback: Some(browsed) },
            pQueryContext: Arc::as_ptr(&ctx) as *mut c_void,
        };
        let mut cancel = DNS_SERVICE_CANCEL { reserved: std::ptr::null_mut() };
        // SAFETY: the request and its context outlive the browse (the context is leaked below).
        if unsafe { DnsServiceBrowse(&request, &mut cancel) } != DNS_REQUEST_PENDING {
            return Vec::new();
        }
        std::thread::sleep(window);
        // SAFETY: the handle the browse gave us.
        unsafe { DnsServiceBrowseCancel(&cancel) };
        leak(&ctx);
        let names = ctx.names.lock().unwrap_or_else(|p| p.into_inner()).clone();
        names.iter().filter_map(|n| resolve(n)).collect()
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Answer, SERVICE};
    use std::time::{Duration, Instant};

    pub fn browse(window: Duration) -> Vec<Answer> {
        let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
        let Ok(events) = daemon.browse(&format!("{SERVICE}.local.")) else {
            let _ = daemon.shutdown();
            return Vec::new();
        };
        let deadline = Instant::now() + window;
        let mut out = Vec::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match events.recv_timeout(left) {
                Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                    let txt = ["v", "node", "fp", "name", "ip"]
                        .iter()
                        .filter_map(|k| info.get_property_val_str(k).map(|v| (k.to_string(), v.to_string())))
                        .collect();
                    let instance = info.get_fullname().split('.').next().unwrap_or_default().to_string();
                    for ip in info.get_addresses_v4() {
                        out.push(Answer { instance: instance.clone(), ip: Some(*ip), port: info.get_port(), txt: Vec::clone(&txt) });
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = daemon.shutdown();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k";

    fn answer(ip: [u8; 4], txt: &[(&str, &str)]) -> Answer {
        Answer {
            instance: "KASA-1".into(),
            ip: Some(Ipv4Addr::from(ip)),
            port: 4443,
            txt: txt.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    const GOOD: &[(&str, &str)] = &[("v", "1"), ("node", "master-abcdefghijklmnop"), ("fp", FP), ("name", "KASA-1")];

    #[test]
    fn an_advert_names_a_server_to_probe() {
        let f = judge(&answer([192, 168, 1, 10], GOOD)).unwrap();
        assert_eq!(f, Found {
            name: "KASA-1".into(),
            url: "https://192.168.1.10:4443".into(),
            node: "master-abcdefghijklmnop".into(),
            fingerprint: FP.into(),
        });
    }

    #[test]
    fn what_is_not_an_lgr_server_is_left_out() {
        let without = |key: &str| GOOD.iter().copied().filter(|(k, _)| *k != key).collect::<Vec<_>>();
        assert!(judge(&answer([192, 168, 1, 10], &without("fp"))).is_none());
        assert!(judge(&answer([192, 168, 1, 10], &without("node"))).is_none());
        assert!(judge(&answer([192, 168, 1, 10], &without("v"))).is_none());
        let mut v2 = GOOD.to_vec();
        v2[0] = ("v", "2");
        assert!(judge(&answer([192, 168, 1, 10], &v2)).is_none(), "a version this build does not know");
        let mut bad_fp = GOOD.to_vec();
        bad_fp[2] = ("fp", "sha256:short");
        assert!(judge(&answer([192, 168, 1, 10], &bad_fp)).is_none());
        // ⚠ A public address is never offered: a master is paired by a name no public CA certifies.
        assert!(judge(&answer([8, 8, 8, 8], GOOD)).is_none());
        let mut no_ip = answer([192, 168, 1, 10], GOOD);
        no_ip.ip = None;
        assert!(judge(&no_ip).is_none());
    }

    #[test]
    fn a_name_is_shown_as_text() {
        let mut odd = GOOD.to_vec();
        odd[3] = ("name", "KASA\u{7}-1\n");
        assert_eq!(judge(&answer([10, 0, 0, 2], &odd)).unwrap().name, "KASA-1");
        odd[3] = ("name", "");
        assert_eq!(judge(&answer([10, 0, 0, 2], &odd)).unwrap().name, "KASA-1", "the instance when no name");
    }

    #[test]
    fn the_advert_names_its_own_address_first() {
        // ⚠ Measured: the machine's name resolved to its WireGuard address, not the shop's LAN.
        let mut with_ip = GOOD.to_vec();
        with_ip.push(("ip", "192.168.8.115"));
        assert_eq!(judge(&answer([100, 65, 0, 5], &with_ip)).unwrap().url, "https://192.168.8.115:4443");
        // No usable `ip`: the resolved address.
        let mut junk = GOOD.to_vec();
        junk.push(("ip", "not-an-address"));
        assert_eq!(judge(&answer([192, 168, 1, 10], &junk)).unwrap().url, "https://192.168.1.10:4443");
        // A public `ip` is refused, whatever resolved.
        let mut public = GOOD.to_vec();
        public.push(("ip", "8.8.8.8"));
        assert!(judge(&answer([192, 168, 1, 10], &public)).is_none());
    }

    /// Against a real master advertising on this machine's network (`LGR_TEST_MASTER_FP` = its CA's
    /// fingerprint). `cargo test -- --ignored a_real_master_is_found`.
    #[test]
    #[ignore]
    fn a_real_master_is_found() {
        let fp = std::env::var("LGR_TEST_MASTER_FP").expect("LGR_TEST_MASTER_FP");
        let found = browse(Duration::from_secs(4));
        assert!(found.iter().any(|f| f.fingerprint == fp), "not among {found:?}");
        let at = find(&fp, Duration::from_secs(4));
        assert!(!at.is_empty() && at.iter().all(|u| u.starts_with("https://")), "{at:?}");
        println!("found: {found:?}");
    }

    /// DHCP moved the master (FR-20.28): a desktop paired at an address nobody answers any more
    /// locates it again by its CA, and only through the pin. Same variable as above.
    #[test]
    #[ignore]
    fn a_moved_master_is_located() {
        let fp = std::env::var("LGR_TEST_MASTER_FP").expect("LGR_TEST_MASTER_FP");
        let real = browse(Duration::from_secs(4))
            .into_iter()
            .find(|f| f.fingerprint == fp)
            .expect("the master advertises")
            .url;
        let crate::trust::ServerKind::Master { ca_pem, .. } = crate::trust::probe(&real).unwrap() else {
            panic!("{real} is not a master")
        };
        let pin = crate::trust::MasterPin::new(&ca_pem, &fp).unwrap();
        // Paired where DHCP has since put nobody.
        let stale = "https://192.168.255.254:4443";
        assert_eq!(locate(&pin, stale, Duration::from_secs(4)).as_deref(), Some(real.as_str()));
        assert!(crate::trust::pin_for(&real).is_some(), "the address it moved to is pinned");
        // Asked for its own old address, it does not "find" it: it looks for somewhere ELSE.
        assert_eq!(locate(&pin, &real, Duration::from_secs(4)), None);
    }
}

