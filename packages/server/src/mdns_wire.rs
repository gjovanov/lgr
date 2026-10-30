//! #380: the other copy's advert, read off the wire. A copy of this server's disk that DHCP gave this
//! machine's own address answers DNS-SD from that address, and the kernel drops every such packet as
//! a martian (a local source arriving from the wire, `accept_local=0`) before `advert::browse` can
//! hear it. `arp.rs` reads them on a packet socket, ahead of that check, and this module makes
//! `advert::Heard` of them, as `advert::browse` would.
//!
//! - Only what a probable clone needs: `_lgr-server._tcp` instances, with their SRV port, their TXT
//!   pairs and the A record of their target. Everything else in a message is skipped.
//! - ⚠ Off the wire, from anyone: every length is checked, a name is at most 255 bytes and follows at
//!   most 16 compression pointers, a message is read for at most 64 records and yields at most 8
//!   adverts. Nothing here panics on what it is given.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::net::Ipv4Addr;

use crate::advert::{Heard, SERVICE};

/// mDNS's port (RFC 6762).
pub const MDNS_PORT: u16 = 5353;
const MAX_RECORDS: usize = 64;
const MAX_ADVERTS: usize = 8;
const MAX_JUMPS: usize = 16;

/// A name, label by label.
type Name = Vec<String>;
/// A TXT record's pairs.
type Pairs = Vec<(String, String)>;

const TYPE_A: u16 = 1;
const TYPE_TXT: u16 = 16;
const TYPE_SRV: u16 = 33;

/// The UDP payload of an IPv4 packet to port 5353, and the packet's source address. None for anything
/// else: another version, protocol or port, a fragment (a part of a message at most), a length that
/// does not fit.
pub fn mdns_payload(ip: &[u8]) -> Option<(Ipv4Addr, &[u8])> {
    if ip.len() < 20 || ip[0] >> 4 != 4 {
        return None;
    }
    let ihl = usize::from(ip[0] & 0x0f) * 4;
    let total = usize::from(u16::from_be_bytes([ip[2], ip[3]]));
    if ihl < 20 || total < ihl + 8 || total > ip.len() || ip[9] != 17 {
        return None;
    }
    // More fragments, or an offset: never a whole message.
    if u16::from_be_bytes([ip[6], ip[7]]) & 0x3fff != 0 {
        return None;
    }
    let udp = &ip[ihl..total];
    let len = usize::from(u16::from_be_bytes([udp[4], udp[5]]));
    if u16::from_be_bytes([udp[2], udp[3]]) != MDNS_PORT || len < 8 || len > udp.len() {
        return None;
    }
    Some((Ipv4Addr::new(ip[12], ip[13], ip[14], ip[15]), &udp[8..len]))
}

/// The name at `at` in `msg`, label by label, and where the record goes on after it: past its root
/// label, or past the first pointer it followed.
fn name(msg: &[u8], mut at: usize) -> Option<(Name, usize)> {
    let mut labels = Vec::new();
    let (mut next, mut jumps, mut len) = (None, 0usize, 0usize);
    loop {
        let n = usize::from(*msg.get(at)?);
        match n & 0xc0 {
            0x00 if n == 0 => return Some((labels, next.unwrap_or(at + 1))),
            0x00 => {
                len += n + 1;
                if len > 255 {
                    return None;
                }
                labels.push(String::from_utf8_lossy(msg.get(at + 1..at + 1 + n)?).into_owned());
                at += 1 + n;
            }
            0xc0 => {
                jumps += 1;
                if jumps > MAX_JUMPS {
                    return None;
                }
                next.get_or_insert(at + 2);
                at = ((n & 0x3f) << 8) | usize::from(*msg.get(at + 1)?);
            }
            // 0x40 and 0x80 are reserved (RFC 6891 retired the extended labels).
            _ => return None,
        }
    }
}

fn same(a: &[String], b: &[&str]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
}

/// The labels of `SERVICE.local`: `_lgr-server`, `_tcp`, `local`.
fn service_labels() -> Vec<&'static str> {
    SERVICE.split('.').chain(std::iter::once("local")).collect()
}

/// The instance an owner name names (`<instance>._lgr-server._tcp.local`), or None.
fn instance_of(owner: &[String]) -> Option<String> {
    let service = service_labels();
    let n = owner.len().checked_sub(service.len()).filter(|&n| n > 0)?;
    same(&owner[n..], &service).then(|| owner[..n].join("."))
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

/// TXT's character strings, as `key=value` pairs (a string without `=` is a key with no value).
fn txt_pairs(rdata: &[u8]) -> Pairs {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(&n) = rdata.get(at) {
        let Some(s) = rdata.get(at + 1..at + 1 + usize::from(n)) else { break };
        at += 1 + usize::from(n);
        if s.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(s);
        let (k, v) = s.split_once('=').unwrap_or((&*s, ""));
        out.push((k.to_string(), v.to_string()));
    }
    out
}

/// Every `_lgr-server._tcp` advert in one mDNS response, as `advert::browse` reports one: an instance
/// with TXT pairs, its SRV port (0 without one) and the A record of its SRV target (None without one).
/// Nothing for a query, or for a message that does not parse.
pub fn adverts(msg: &[u8]) -> Vec<Heard> {
    parse(msg).unwrap_or_default()
}

fn parse(msg: &[u8]) -> Option<Vec<Heard>> {
    // A response (QR), a standard one (opcode 0).
    let flags = u16_at(msg, 2)?;
    if flags & 0x8000 == 0 || (flags >> 11) & 0xf != 0 {
        return Some(vec![]);
    }
    let count = |at| u16_at(msg, at).map(usize::from);
    let (questions, records) = (count(4)?, count(6)? + count(8)? + count(10)?);
    let mut at = 12;
    for _ in 0..questions {
        at = name(msg, at)?.1 + 4;
    }
    // owner → (port, target); owner → pairs; host → address.
    let mut srv: Vec<(Name, u16, Name)> = Vec::new();
    let mut txt: Vec<(Name, Pairs)> = Vec::new();
    let mut a: Vec<(Name, Ipv4Addr)> = Vec::new();
    for _ in 0..records.min(MAX_RECORDS) {
        let (owner, after) = name(msg, at)?;
        let rtype = u16_at(msg, after)?;
        let rdlen = usize::from(u16_at(msg, after + 8)?);
        let start = after + 10;
        let rdata = msg.get(start..start + rdlen)?;
        at = start + rdlen;
        // A PTR is skipped: it names an instance whose SRV and TXT come in the same message or not at
        // all, and the instance is read off their owners.
        match rtype {
            TYPE_SRV if rdata.len() >= 7 => {
                let target = name(msg, start + 6).map(|(t, _)| t).unwrap_or_default();
                srv.push((owner, u16_at(rdata, 4)?, target));
            }
            TYPE_TXT => txt.push((owner, txt_pairs(rdata))),
            TYPE_A if rdata.len() == 4 => a.push((owner, Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]))),
            _ => {}
        }
    }
    let mut out: Vec<Heard> = Vec::new();
    for (owner, pairs) in txt {
        let Some(instance) = instance_of(&owner) else { continue };
        let found = srv.iter().find(|(o, ..)| o.len() == owner.len() && o.iter().zip(&owner).all(|(x, y)| x.eq_ignore_ascii_case(y)));
        let (port, ip) = match found {
            Some((_, port, target)) => {
                let target: Vec<&str> = target.iter().map(String::as_str).collect();
                (*port, a.iter().find(|(host, _)| same(host, &target)).map(|(_, ip)| *ip))
            }
            None => (0, None),
        };
        let heard = Heard { instance, ip, port, txt: pairs };
        if !out.contains(&heard) {
            out.push(heard);
        }
        if out.len() == MAX_ADVERTS {
            break;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TYPE_PTR: u16 = 12;

    /// A name as uncompressed labels.
    fn enc(name: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for l in name.split('.').filter(|l| !l.is_empty()) {
            out.push(l.len() as u8);
            out.extend_from_slice(l.as_bytes());
        }
        out.push(0);
        out
    }

    fn record(owner: &[u8], rtype: u16, rdata: &[u8]) -> Vec<u8> {
        let mut out = owner.to_vec();
        out.extend_from_slice(&rtype.to_be_bytes());
        // Class IN with the cache-flush bit, as a responder sends its unique records.
        out.extend_from_slice(&0x8001u16.to_be_bytes());
        out.extend_from_slice(&120u32.to_be_bytes());
        out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        out.extend_from_slice(rdata);
        out
    }

    fn message(flags: u16, questions: &[Vec<u8>], answers: &[Vec<u8>], additional: &[Vec<u8>]) -> Vec<u8> {
        let mut out = vec![0, 0];
        out.extend_from_slice(&flags.to_be_bytes());
        for n in [questions.len(), answers.len(), 0, additional.len()] {
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        for part in questions.iter().chain(answers).chain(additional) {
            out.extend_from_slice(part);
        }
        out
    }

    fn txt_rdata(pairs: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (k, v) in pairs {
            let s = format!("{k}={v}");
            out.push(s.len() as u8);
            out.extend_from_slice(s.as_bytes());
        }
        out
    }

    fn srv_rdata(port: u16, target: &str) -> Vec<u8> {
        let mut out = vec![0, 0, 0, 0];
        out.extend_from_slice(&port.to_be_bytes());
        out.extend_from_slice(&enc(target));
        out
    }

    const TXT: [(&str, &str); 6] = [("v", "1"), ("node", "n-1"), ("boot", "b-2"), ("fp", "sha256:AAA"), ("name", "Shop PC"), ("ip", "10.0.0.5")];

    /// What a responder announces: the PTR, then SRV, TXT and A.
    fn announcement() -> Vec<u8> {
        let instance = enc("Shop PC._lgr-server._tcp.local");
        message(
            0x8400,
            &[],
            &[
                record(&enc("_lgr-server._tcp.local"), TYPE_PTR, &instance),
                record(&instance, TYPE_SRV, &srv_rdata(4443, "shop-pc.local")),
                record(&instance, TYPE_TXT, &txt_rdata(&TXT)),
                record(&enc("shop-pc.local"), TYPE_A, &[10, 0, 0, 5]),
            ],
            &[],
        )
    }

    fn expected() -> Heard {
        Heard { instance: "Shop PC".into(), ip: Some(Ipv4Addr::new(10, 0, 0, 5)), port: 4443, txt: TXT.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn an_announcement_is_heard_as_browse_hears_it() {
        assert_eq!(adverts(&announcement()), vec![expected()]);
    }

    /// The announcement mdns-sd's responder sent for `advert::register` (a capture on a veth, 2026-10-30):
    /// a whole IPv4 packet, its records compressed against each other.
    const CAPTURED: &str = "4500 \
        00d2 8151 4000 ff11 04f2 0ad5 0907 e000 \
        00fb 14e9 14e9 00be f5a6 0000 8400 0000 \
        0004 0000 0000 0b5f 6c67 722d 7365 7276 \
        6572 045f 7463 7005 6c6f 6361 6c00 000c \
        0001 0000 1194 0007 0443 6f70 79c0 0cc0 \
        2e00 2180 0100 0000 7800 1100 0000 0011 \
        5b08 6c67 722d 636f 7079 c01d c02e 0010 \
        8001 0000 1194 0048 0376 3d31 0d6e 6f64 \
        653d 6e6f 6465 2d33 3830 0e62 6f6f 743d \
        626f 6f74 2d63 6f70 790e 6670 3d73 6861 \
        3235 363a 636f 7079 096e 616d 653d 436f \
        7079 0d69 703d 3130 2e32 3133 2e39 2e37 \
        c047 0001 8001 0000 0078 0004 0ad5 0907";

    #[test]
    fn mdns_sds_own_announcement_parses() {
        let hex: String = CAPTURED.chars().filter(char::is_ascii_hexdigit).collect();
        let packet: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let (source, payload) = mdns_payload(&packet).expect("a whole IPv4 UDP datagram to 5353");
        assert_eq!(source, Ipv4Addr::new(10, 213, 9, 7));
        let txt = [("v", "1"), ("node", "node-380"), ("boot", "boot-copy"), ("fp", "sha256:copy"), ("name", "Copy"), ("ip", "10.213.9.7")];
        let heard = Heard { instance: "Copy".into(), ip: Some(Ipv4Addr::new(10, 213, 9, 7)), port: 4443, txt: txt.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() };
        assert_eq!(adverts(payload), vec![heard]);
    }

    #[test]
    fn the_records_may_come_as_additional_ones_and_compressed() {
        // The instance's records in the additional section, every name after the first a pointer.
        let mut msg = message(0x8400, &[], &[], &[]);
        let service_at = msg.len();
        let mut ptr = enc("_lgr-server._tcp.local");
        ptr.extend_from_slice(&TYPE_PTR.to_be_bytes());
        ptr.extend_from_slice(&[0, 1, 0, 0, 0, 120]);
        // The instance: one label, then a pointer to the service name.
        let instance_at = service_at + ptr.len() + 2;
        let mut instance = vec![7];
        instance.extend_from_slice(b"Shop PC");
        instance.extend_from_slice(&[0xc0, service_at as u8]);
        ptr.extend_from_slice(&(instance.len() as u16).to_be_bytes());
        ptr.extend_from_slice(&instance);
        msg.extend_from_slice(&ptr);
        let to_instance = [0xc0, instance_at as u8];
        let host_at = msg.len() + 2 + 10 + 6;
        let mut srv = srv_rdata(4443, "shop-pc.local");
        srv.truncate(6);
        srv.extend_from_slice(&enc("shop-pc"));
        srv.pop();
        // `shop-pc` then a pointer to `local` (the service name's last label).
        srv.extend_from_slice(&[0xc0, (service_at + "_lgr-server".len() + 1 + "_tcp".len() + 1) as u8]);
        msg.extend_from_slice(&record(&to_instance, TYPE_SRV, &srv));
        msg.extend_from_slice(&record(&to_instance, TYPE_TXT, &txt_rdata(&TXT)));
        msg.extend_from_slice(&record(&[0xc0, host_at as u8], TYPE_A, &[10, 0, 0, 5]));
        msg[7] = 1;
        msg[11] = 3;
        assert_eq!(adverts(&msg), vec![expected()]);
    }

    #[test]
    fn a_query_another_service_or_a_bare_txt_is_no_advert_of_ours() {
        let mut query = announcement();
        query[2] = 0;
        assert!(adverts(&query).is_empty(), "a query, not a response");
        let other = message(0x8400, &[], &[record(&enc("Printer._ipp._tcp.local"), TYPE_TXT, &txt_rdata(&[("rp", "ipp")]))], &[]);
        assert!(adverts(&other).is_empty());
        // TXT alone (a cache's partial answer): heard, with no port and no address, which
        // `lan_clone::at_my_address` refuses.
        let bare = message(0x8400, &[], &[record(&enc("Shop PC._lgr-server._tcp.local"), TYPE_TXT, &txt_rdata(&TXT))], &[]);
        assert_eq!(adverts(&bare), vec![Heard { port: 0, ip: None, ..expected() }]);
    }

    #[test]
    fn names_compare_without_case() {
        let instance = enc("Shop PC._LGR-Server._TCP.Local");
        let msg = message(0x8400, &[], &[record(&instance, TYPE_SRV, &srv_rdata(4443, "SHOP-PC.local")), record(&instance, TYPE_TXT, &txt_rdata(&TXT)), record(&enc("shop-pc.LOCAL"), TYPE_A, &[10, 0, 0, 5])], &[]);
        assert_eq!(adverts(&msg), vec![expected()]);
    }

    #[test]
    fn anything_malformed_is_nothing_and_never_a_panic() {
        let good = announcement();
        for cut in 0..good.len() {
            let _ = adverts(&good[..cut]);
        }
        // A pointer to itself, and two pointing at each other.
        let mut looped = message(0x8400, &[], &[], &[]);
        looped[7] = 1;
        looped.extend_from_slice(&[0xc0, 12]);
        assert!(adverts(&looped).is_empty());
        let mut pair = message(0x8400, &[], &[], &[]);
        pair[7] = 1;
        pair.extend_from_slice(&[0xc0, 14, 0xc0, 12]);
        assert!(adverts(&pair).is_empty());
        // A name longer than 255 bytes.
        let long = enc(&vec!["a".repeat(63); 5].join("."));
        let msg = message(0x8400, &[], &[record(&long, TYPE_A, &[1, 2, 3, 4])], &[]);
        assert!(adverts(&msg).is_empty());
        // Counts far past what the message holds, and a reserved label type.
        let mut counts = announcement();
        counts[6..12].copy_from_slice(&[0xff; 6]);
        assert!(adverts(&counts).is_empty());
        let mut reserved = announcement();
        reserved[12] = 0x40;
        assert!(adverts(&reserved).is_empty());
        // Every byte of a good message flipped in turn: nothing panics.
        for i in 0..good.len() {
            let mut bad = good.clone();
            bad[i] ^= 0xff;
            let _ = adverts(&bad);
        }
    }

    #[test]
    fn at_most_eight_adverts_from_one_message() {
        let mut answers = Vec::new();
        for i in 0..20 {
            let instance = enc(&format!("PC{i}._lgr-server._tcp.local"));
            answers.push(record(&instance, TYPE_SRV, &srv_rdata(4443, &format!("pc{i}.local"))));
            answers.push(record(&instance, TYPE_TXT, &txt_rdata(&TXT)));
        }
        assert_eq!(adverts(&message(0x8400, &[], &answers, &[])).len(), MAX_ADVERTS);
    }

    /// An IPv4 packet carrying `payload` from `src` to 224.0.0.251:`port`.
    fn ipv4(src: [u8; 4], port: u16, payload: &[u8]) -> Vec<u8> {
        let total = 20 + 8 + payload.len();
        let mut p = vec![0x45, 0, 0, 0, 0, 0, 0x40, 0, 255, 17, 0, 0];
        p[2..4].copy_from_slice(&(total as u16).to_be_bytes());
        p.extend_from_slice(&src);
        p.extend_from_slice(&[224, 0, 0, 251]);
        p.extend_from_slice(&MDNS_PORT.to_be_bytes());
        p.extend_from_slice(&port.to_be_bytes());
        p.extend_from_slice(&((8 + payload.len()) as u16).to_be_bytes());
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(payload);
        p
    }

    #[test]
    fn the_payload_of_a_whole_ipv4_packet_to_5353_only() {
        let payload = announcement();
        let p = ipv4([10, 0, 0, 5], MDNS_PORT, &payload);
        assert_eq!(mdns_payload(&p), Some((Ipv4Addr::new(10, 0, 0, 5), &payload[..])));
        // Ethernet pads a short frame: the IPv4 length, not the frame's, says where it ends.
        let mut padded = p.clone();
        padded.extend_from_slice(&[0; 16]);
        assert_eq!(mdns_payload(&padded), Some((Ipv4Addr::new(10, 0, 0, 5), &payload[..])));
        assert!(mdns_payload(&ipv4([10, 0, 0, 5], 53, &payload)).is_none(), "another port");
        let mut tcp = p.clone();
        tcp[9] = 6;
        assert!(mdns_payload(&tcp).is_none(), "not UDP");
        let mut more = p.clone();
        more[6] = 0x20;
        assert!(mdns_payload(&more).is_none(), "more fragments follow");
        let mut offset = p.clone();
        offset[7] = 1;
        assert!(mdns_payload(&offset).is_none(), "a later fragment");
        let mut v6 = p.clone();
        v6[0] = 0x60;
        assert!(mdns_payload(&v6).is_none());
        assert!(mdns_payload(&p[..p.len() - 1]).is_none(), "shorter than it says");
        let mut udp_long = p.clone();
        udp_long[25] = 0xff;
        assert!(mdns_payload(&udp_long).is_none(), "a UDP length past the packet");
        // Options: a 24-byte header.
        let mut opts = vec![0x46, 0, 0, 0, 0, 0, 0x40, 0, 255, 17, 0, 0, 10, 0, 0, 5, 224, 0, 0, 251, 1, 1, 1, 0];
        let udp = &p[20..];
        opts[2..4].copy_from_slice(&((24 + udp.len()) as u16).to_be_bytes());
        opts.extend_from_slice(udp);
        assert_eq!(mdns_payload(&opts), Some((Ipv4Addr::new(10, 0, 0, 5), &payload[..])));
        for cut in 0..p.len() {
            let _ = mdns_payload(&p[..cut]);
        }
    }
}
