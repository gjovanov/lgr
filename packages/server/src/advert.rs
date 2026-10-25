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
//!
//! On Windows it goes through the OS's own mDNS (`DnsServiceRegister`), which already has the
//! firewall's leave to answer the LAN; a responder of our own would need a rule nothing installs yet
//! (P1-7). Elsewhere it is `mdns-sd`, a pure-Rust responder.

use std::net::Ipv4Addr;

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
}

impl Advert {
    /// The TXT record, in its one order. `ip` is the address the pairing code names, which a desktop
    /// prefers to whatever the machine's name resolves to (a VPN's, an overlay's).
    pub fn txt(&self) -> Vec<(String, String)> {
        vec![
            ("v".into(), "1".into()),
            ("node".into(), self.node.clone()),
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
}

#[cfg(not(windows))]
mod imp {
    use super::{Advert, SERVICE};
    use anyhow::{Context, Result};

    pub struct Registration {
        daemon: mdns_sd::ServiceDaemon,
        fullname: String,
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
        daemon.register(info).context("registering the advert")?;
        Ok(Registration { daemon, fullname })
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
        };
        let txt = a.txt();
        let get = |k: &str| txt.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("v"), Some("1"));
        assert_eq!(get("node"), Some("master-abcdefghijklmnop"));
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
