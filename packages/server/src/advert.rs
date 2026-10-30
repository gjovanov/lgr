//! FR-20.28 (plan step P1-6d) — the master on the shop's network: its LAN ingress advertised as
//! `_lgr-server._tcp`.
//!
//! What the TXT record carries, for a desktop's "a server on this network" list and for a paired
//! desktop finding its master again after a DHCP change:
//! - `fp`: the CA fingerprint desktops pin (FR-20.29). ⚠ An advert proves nothing: anyone on the LAN
//!   can send one. It is how a desktop FINDS its master. The pinned TLS is still what proves it, so a
//!   forged advert leads to a connection that fails.
//! - `ip`: the address the pairing code names. The SRV record points at the machine's own name, which
//!   is the only name Windows answers for, and which it answers with any interface's address.
//! - `node`: the node id (`state/node.json`); `name`: the machine, as a person knows it; `v`: 1.
//! - `boot`: this start's nonce, the one the uplink says hello with (FR-20.51, P3-7): another machine
//!   advertising this node with another nonce is a clone candidate (`lan_clone.rs`).
//!
//! It is also BROWSED here (`browse`), for the clone watch: on Windows through the OS's DNS-SD
//! (`DnsServiceBrowse`, `DnsServiceResolve`), elsewhere `mdns-sd`, as the desktop finds its master.
//!
//! On Windows it goes through the OS's own mDNS (`DnsServiceRegister`), which already has the
//! firewall's leave to answer the LAN; a responder of our own would need a rule nothing installs yet
//! (P1-7). Elsewhere it is `mdns-sd`, a pure-Rust responder.

use std::net::Ipv4Addr;
use std::time::Duration;

/// The service type.
pub const SERVICE: &str = "_lgr-server._tcp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advert {
    /// The instance name a person sees: the machine's.
    pub instance: String,
    /// `<host>.local`, the name the advert points at.
    pub host: String,
    pub ip: Ipv4Addr,
    pub port: u16,
    pub node: String,
    pub fingerprint: String,
    /// This start's nonce (FR-20.51): what tells this machine's advert from a clone's.
    pub boot: String,
}

impl Advert {
    /// The TXT record, in its one order. `ip` is the address the pairing code names, which a desktop
    /// prefers to whatever the machine's name resolves to (a VPN's, an overlay's).
    pub fn txt(&self) -> Vec<(String, String)> {
        vec![
            ("v".into(), "1".into()),
            ("node".into(), self.node.clone()),
            ("boot".into(), self.boot.clone()),
            ("fp".into(), self.fingerprint.clone()),
            ("name".into(), self.instance.clone()),
            ("ip".into(), self.ip.to_string()),
        ]
    }
}

/// An advert on the network, withdrawn when this is dropped.
pub struct Registration {
    _inner: imp::Registration,
}

/// Put `advert` on the network. Blocking: it waits for the OS (or the responder) to take it.
pub fn register(advert: &Advert) -> anyhow::Result<Registration> {
    imp::register(advert).map(|inner| Registration { _inner: inner })
}

impl Registration {
    /// Announce the advert again, as it was first announced (#380).
    pub fn announce(&self) {
        self._inner.announce();
    }
}

/// #380: what the address watch (`arp.rs`) asks for when another machine claims this server's address.
/// A copy of this disk there never hears a query from this machine (its kernel drops one from its own
/// address as a martian), so it never hears an answer to one either: only an announcement tells it
/// this server's advert. Asked any number of times before `advertise` (main.rs) wakes, it is one.
static ANNOUNCE: std::sync::LazyLock<tokio::sync::Notify> = std::sync::LazyLock::new(tokio::sync::Notify::new);

/// Asked by the address watch, which runs on Linux only.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn announce_again() {
    ANNOUNCE.notify_one();
}

/// What `advertise` waits on beside its minute.
pub async fn announce_wanted() {
    ANNOUNCE.notified().await;
}

/// An advert heard on the network, before anything is concluded from it: anyone can send one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Heard {
    pub instance: String,
    /// The address the name resolved to; the TXT record's `ip` is preferred where it says one.
    pub ip: Option<Ipv4Addr>,
    pub port: u16,
    pub txt: Vec<(String, String)>,
}

/// Listen for `window` and say what answered as `_lgr-server._tcp`, this machine's own advert included.
/// Blocking. Nothing found means nothing heard: multicast is often blocked.
pub fn browse(window: Duration) -> Vec<Heard> {
    imp::browse(window)
}

/// A DNS-SD instance label: what a person reads, within the 63 bytes a label may hold, and without
/// the dots that would split it.
pub fn instance_label(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c == '.' || c.is_control() { '-' } else { c }).collect();
    let mut out = String::new();
    for c in cleaned.trim().chars() {
        if out.len() + c.len_utf8() > 63 {
            break;
        }
        out.push(c);
    }
    if out.is_empty() {
        "LGR Server".into()
    } else {
        out
    }
}

#[cfg(windows)]
mod imp {
    use super::{Advert, SERVICE};
    use anyhow::{bail, Result};
    use std::ffi::c_void;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::DNS_REQUEST_PENDING;
    use windows_sys::Win32::NetworkManagement::Dns::{
        DnsServiceConstructInstance, DnsServiceDeRegister, DnsServiceFreeInstance, DnsServiceRegister,
        DNS_QUERY_REQUEST_VERSION1, DNS_SERVICE_INSTANCE, DNS_SERVICE_REGISTER_REQUEST,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The status the OS answered with, once it has.
    type Done = (Mutex<Option<u32>>, Condvar);

    unsafe extern "system" fn answered(status: u32, context: *const c_void, instance: *const DNS_SERVICE_INSTANCE) {
        // SAFETY: `context` is a `Done` kept alive for as long as the OS may call back (see `leak`).
        let done = unsafe { &*(context as *const Done) };
        *done.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(status);
        done.1.notify_all();
        if !instance.is_null() {
            // SAFETY: the OS hands the callback its own copy, which the callback frees.
            unsafe { DnsServiceFreeInstance(instance) };
        }
    }

    fn wait(done: &Done, timeout: Duration) -> Option<u32> {
        let guard = done.0.lock().unwrap_or_else(|p| p.into_inner());
        let (guard, _) = done.1.wait_timeout_while(guard, timeout, |s| s.is_none()).unwrap_or_else(|p| p.into_inner());
        *guard
    }

    /// ⚠ When the OS has not answered, it still may: its context must then outlive us. A few bytes
    /// leaked once, against a callback into freed memory.
    fn leak(done: &Arc<Done>) {
        std::mem::forget(done.clone());
    }

    pub struct Registration {
        /// From `Box::into_raw`: freed in `drop` once the OS is done with it, leaked if it may not be.
        request: *mut DNS_SERVICE_REGISTER_REQUEST,
        instance: *mut DNS_SERVICE_INSTANCE,
        done: Arc<Done>,
    }

    // SAFETY: the pointers are the OS's and ours alone, used only by `drop`, which waits for the OS.
    unsafe impl Send for Registration {}

    pub fn register(a: &Advert) -> Result<Registration> {
        let name = wide(&format!("{}.{SERVICE}.local", a.instance));
        let host = wide(&format!("{}.local", a.host));
        let txt = a.txt();
        let keys: Vec<Vec<u16>> = txt.iter().map(|(k, _)| wide(k)).collect();
        let values: Vec<Vec<u16>> = txt.iter().map(|(_, v)| wide(v)).collect();
        let key_ptrs: Vec<*const u16> = keys.iter().map(|k| k.as_ptr()).collect();
        let value_ptrs: Vec<*const u16> = values.iter().map(|v| v.as_ptr()).collect();
        // An IP4_ADDRESS is the address's bytes in network order.
        let ip4 = u32::from_ne_bytes(a.ip.octets());
        // SAFETY: every pointer is valid for the call, and the instance it returns owns copies.
        let instance = unsafe {
            DnsServiceConstructInstance(
                name.as_ptr(),
                host.as_ptr(),
                &ip4,
                std::ptr::null(),
                a.port,
                0,
                0,
                txt.len() as u32,
                key_ptrs.as_ptr(),
                value_ptrs.as_ptr(),
            )
        };
        if instance.is_null() {
            bail!("DnsServiceConstructInstance refused the advert");
        }
        let done: Arc<Done> = Arc::new((Mutex::new(None), Condvar::new()));
        let request = Box::into_raw(Box::new(DNS_SERVICE_REGISTER_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1,
            InterfaceIndex: 0,
            pServiceInstance: instance,
            pRegisterCompletionCallback: Some(answered),
            pQueryContext: Arc::as_ptr(&done) as *mut c_void,
            hCredentials: std::ptr::null_mut(),
            unicastEnabled: 0,
        }));
        // SAFETY: `request` and `instance` live in the returned `Registration` until it deregisters.
        let status = unsafe { DnsServiceRegister(request, std::ptr::null_mut()) };
        if status != DNS_REQUEST_PENDING as u32 {
            // SAFETY: nothing is pending, so nothing else holds either.
            unsafe {
                DnsServiceFreeInstance(instance);
                drop(Box::from_raw(request));
            }
            bail!("DnsServiceRegister answered {status}");
        }
        match wait(&done, Duration::from_secs(10)) {
            Some(0) => Ok(Registration { request, instance, done }),
            answer => {
                let reg = Registration { request, instance, done };
                drop(reg);
                bail!("the OS did not take the advert (status {answer:?})")
            }
        }
    }

    impl Registration {
        /// Nothing: no address watch asks for it off Linux.
        pub fn announce(&self) {}
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            *self.done.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
            // SAFETY: the same request the registration was made with.
            let status = unsafe { DnsServiceDeRegister(self.request, std::ptr::null_mut()) };
            let finished = status != DNS_REQUEST_PENDING as u32 || wait(&self.done, Duration::from_secs(5)).is_some();
            if finished {
                // SAFETY: deregistered, so the OS is done with both.
                unsafe {
                    DnsServiceFreeInstance(self.instance);
                    drop(Box::from_raw(self.request));
                }
            } else {
                // Still pending: the OS may yet use the request, the instance and the context.
                leak(&self.done);
            }
        }
    }

    // ── Browsing (FR-20.51, P3-7: the clone watch), as the desktop finds its master ──────────────

    use super::Heard;
    use std::net::Ipv4Addr;
    use windows_sys::Win32::NetworkManagement::Dns::{
        DnsFree, DnsFreeRecordList, DnsServiceBrowse, DnsServiceBrowseCancel, DnsServiceResolve, DnsServiceResolveCancel,
        DNS_RECORDW, DNS_SERVICE_BROWSE_REQUEST, DNS_SERVICE_BROWSE_REQUEST_0, DNS_SERVICE_CANCEL, DNS_SERVICE_RESOLVE_REQUEST,
        DNS_TYPE_PTR,
    };

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
        done: Mutex<Option<Option<Heard>>>,
        ready: Condvar,
    }

    /// # Safety
    /// `i` is an instance the OS handed us.
    unsafe fn read(i: &DNS_SERVICE_INSTANCE) -> Heard {
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
        Heard { instance: instance.split('.').next().unwrap_or_default().to_string(), ip, port: i.wPort, txt }
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

    fn resolve(name: &str) -> Option<Heard> {
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
        let (mut guard, timeout) = ctx.ready.wait_timeout_while(guard, Duration::from_secs(3), |d| d.is_none()).unwrap_or_else(|p| p.into_inner());
        if timeout.timed_out() {
            drop(guard);
            // SAFETY: the handle the resolve gave us.
            unsafe { DnsServiceResolveCancel(&cancel) };
            std::mem::forget(ctx.clone());
            return None;
        }
        guard.take().flatten()
    }

    pub fn browse(window: Duration) -> Vec<Heard> {
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
        // ⚠ After a cancel the OS may still call back once: its context must outlive us.
        std::mem::forget(ctx.clone());
        let names = ctx.names.lock().unwrap_or_else(|p| p.into_inner()).clone();
        names.iter().filter_map(|n| resolve(n)).collect()
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Advert, Heard, SERVICE};
    use anyhow::{Context, Result};
    use std::time::{Duration, Instant};

    pub fn browse(window: Duration) -> Vec<Heard> {
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
                    let txt: Vec<(String, String)> = ["v", "node", "boot", "fp", "name", "ip"]
                        .iter()
                        .filter_map(|k| info.get_property_val_str(k).map(|v| (k.to_string(), v.to_string())))
                        .collect();
                    let instance = info.get_fullname().split('.').next().unwrap_or_default().to_string();
                    for ip in info.get_addresses_v4() {
                        out.push(Heard { instance: instance.clone(), ip: Some(*ip), port: info.get_port(), txt: txt.clone() });
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = daemon.shutdown();
        out
    }

    pub struct Registration {
        daemon: mdns_sd::ServiceDaemon,
        fullname: String,
        info: mdns_sd::ServiceInfo,
    }

    pub fn register(a: &Advert) -> Result<Registration> {
        let daemon = mdns_sd::ServiceDaemon::new().context("starting the mDNS responder")?;
        let txt = a.txt();
        let props: Vec<(&str, &str)> = txt.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let info = mdns_sd::ServiceInfo::new(
            &format!("{SERVICE}.local."),
            &a.instance,
            &format!("{}.local.", a.host),
            a.ip.to_string().as_str(),
            a.port,
            &props[..],
        )
        .context("describing the advert")?;
        let fullname = info.get_fullname().to_string();
        daemon.register(info.clone()).context("registering the advert")?;
        Ok(Registration { daemon, fullname, info })
    }

    impl Registration {
        /// mdns-sd announces a service registered again exactly as the first time (no withdrawal in
        /// between, so no cache on the LAN forgets it).
        pub fn announce(&self) {
            if let Err(e) = self.daemon.register(self.info.clone()) {
                tracing::debug!(error = %e, "the advert could not be announced again");
            }
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            if let Ok(rx) = self.daemon.unregister(&self.fullname) {
                let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
            }
            let _ = self.daemon.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_txt_record_carries_what_a_desktop_needs() {
        let a = Advert {
            instance: "KASA-1".into(),
            host: "kasa-1".into(),
            ip: Ipv4Addr::new(192, 168, 1, 10),
            port: 4443,
            node: "master-abcdefghijklmnop".into(),
            fingerprint: "sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k".into(),
            boot: "0123456789abcdef0123456789abcdef".into(),
        };
        let txt = a.txt();
        let get = |k: &str| txt.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("v"), Some("1"));
        assert_eq!(get("node"), Some("master-abcdefghijklmnop"));
        assert_eq!(get("boot"), Some("0123456789abcdef0123456789abcdef"), "this start: what tells it from a clone");
        assert_eq!(get("fp"), Some("sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k"));
        assert_eq!(get("name"), Some("KASA-1"));
        assert_eq!(get("ip"), Some("192.168.1.10"), "the address the pairing code names");
        // Each `key=value` is one TXT string, at most 255 bytes.
        assert!(txt.iter().all(|(k, v)| k.len() + 1 + v.len() <= 255));
    }

    #[test]
    fn an_instance_label_is_one_readable_label() {
        assert_eq!(instance_label("KASA-1"), "KASA-1");
        assert_eq!(instance_label("shop.server.local"), "shop-server-local", "no dots: they split a label");
        assert_eq!(instance_label("  "), "LGR Server");
        assert!(instance_label(&"Ж".repeat(100)).len() <= 63, "63 bytes, never a split character");
    }
}
