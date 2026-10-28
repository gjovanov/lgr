//! C11 — enrollment and access tokens (FR-14.19, FR-14.20).
//!
//! ⚠ **The HTTP client is `trust.rs`'s, never one of its own** (FR-20.31). For lgrai.app that is the
//! system proxy and the OS trust store (C09's note, C19's `proxy-tls` check). `native-tls` is
//! schannel on Windows, Secure Transport on macOS and OpenSSL on Linux, so a TLS-inspecting
//! corporate middlebox whose root arrives by GPO just works — with rustls and a bundled root store
//! it would not, and a corporate machine could not enroll at all. `reqwest`'s default proxy
//! resolution reads the system settings, PAC included. For a paired master it is the CA it was
//! paired with, and no proxy.
//!
//! ⚠ **Blocking, on purpose.** These calls happen from a Tauri command the setup screen is
//! waiting on, and the shell has no async runtime of its own since local mode was retired.

use std::time::Duration;

use crate::identity::{self, ClockOffset, Identity};
use crate::keystore::{self, Stored};

/// Every failure the screen can show. ⚠ Codes, not sentences: the UI translates them, and a
/// server message is not something to put in front of a till operator verbatim.
#[derive(Debug)]
pub struct EnrollError(pub String);

impl std::fmt::Display for EnrollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<reqwest::Error> for EnrollError {
    fn from(e: reqwest::Error) -> Self {
        // A DNS failure, a refused connection and a TLS error are all "we could not reach it",
        // which is the only distinction the person in front of the machine can act on.
        EnrollError(if e.is_timeout() { "server_timeout".into() } else { "server_unreachable".into() })
    }
}

fn client(server_url: &str) -> Result<reqwest::blocking::Client, EnrollError> {
    client_within(server_url, Duration::from_secs(20))
}

fn client_within(server_url: &str, timeout: Duration) -> Result<reqwest::blocking::Client, EnrollError> {
    crate::trust::client_for(server_url, timeout).map_err(EnrollError)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse an RFC 3339 `serverTime` into epoch milliseconds.
pub fn parse_server_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollResponse {
    desktop_id: String,
    org_id: String,
    #[serde(default)]
    org_name: String,
    #[serde(default)]
    assignment: AssignmentResponse,
    /// #328 — enrolled with a key: unregister on a clean shutdown (FR-14.19).
    #[serde(default)]
    ephemeral: bool,
    #[serde(default)]
    server_time: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AssignmentResponse {
    #[serde(default)]
    fiscal_device_ids: Vec<String>,
    #[serde(default)]
    start_path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    server_time: String,
}

#[derive(serde::Deserialize)]
struct ErrorResponse {
    #[serde(default)]
    code: String,
}

/// Normalise what a human typed, exactly as the server's `normalizeEnrollmentCode` does.
///
/// ⚠ The alias folding is not cosmetic. Crockford base32 omits `I`, `L`, `O` and `U`, so a code
/// containing `0` read aloud as "oh" and typed as `O` must still work — without this the user
/// sees "invalid code" and goes back to the admin for a new one rather than to the keyboard.
pub fn normalize_code(input: &str) -> String {
    input
        .to_uppercase()
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '-' | '_'))
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect()
}

/// An enrollment KEY's length: 32 random bytes in base64url (`generateEnrollmentKey`).
pub const ENROLLMENT_KEY_LENGTH: usize = 43;

/// Is this an enrollment KEY rather than an admin's one-time code (FR-14.19, #328)?
///
/// A key is exactly 43 characters of base64url, case-sensitive; a code is `XXXX-XXXX`. ⚠ A key never
/// goes through `normalize_code`, which would uppercase it, fold `O`→`0` and `I`/`L`→`1`, and drop its
/// `-` and `_`: the server would hash something else, and the shell could never redeem one.
pub fn is_enrollment_key(input: &str) -> bool {
    let key = input.trim();
    key.len() == ENROLLMENT_KEY_LENGTH && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The field a credential goes in, and its value as the server hashes it.
fn credential_field(input: &str) -> (&'static str, String) {
    if is_enrollment_key(input) {
        ("enrollmentKey", input.trim().to_string())
    } else {
        ("code", normalize_code(input))
    }
}

/// Exchange a code (or an enrollment key) for this desktop's identity (FR-14.19).
///
/// Order matters: the keypair is generated and the server is called FIRST, and only a successful
/// response causes anything to be written. A key stored before the exchange would leave a
/// machine that looks registered to itself and is unknown to the server.
pub fn enroll(
    server_url: &str,
    code: &str,
    name: &str,
    app_version: &str,
) -> Result<Stored, EnrollError> {
    let dir = keystore::secure_dir().map_err(|_| EnrollError("no_secure_storage".into()))?;
    let mut stored = keystore::load(&dir);

    // ⚠ Reused across re-enrollments. The server revives the revoked row for a known
    // `installationId` instead of creating a second one for the same machine (C06).
    if stored.installation_id.is_empty() {
        stored.installation_id = identity::new_installation_id();
    }

    let id = Identity::generate();
    let hostname = crate::settings::hostname();
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let (field, credential) = credential_field(code);
    let mut body = serde_json::json!({
        "installationId": stored.installation_id,
        "machineId": identity::machine_id(&hostname, platform, arch),
        "name": name,
        "os": { "platform": platform, "arch": arch },
        "hostname": hostname,
        "appVersion": app_version,
        // ⚠ The PUBLIC half only. The private key never leaves this process except into the
        // OS-sealed file below, which is what makes a copied config worthless (AC 10).
        "publicKey": id.public_key_b64(),
    });
    body[field] = serde_json::Value::String(credential);

    let url = format!("{}/api/desktop/v1/enroll", server_url.trim_end_matches('/'));
    let res = client(server_url)?.post(&url).json(&body).send()?;

    if !res.status().is_success() {
        let code = res.json::<ErrorResponse>().map(|e| e.code).unwrap_or_default();
        return Err(EnrollError(if code.is_empty() { "enroll_failed".into() } else { code }));
    }

    let parsed: EnrollResponse = res.json().map_err(|_| EnrollError("bad_response".into()))?;

    stored.desktop_id = parsed.desktop_id;
    stored.org_id = parsed.org_id;
    stored.org_name = parsed.org_name;
    stored.start_path = parsed.assignment.start_path;
    stored.fiscal_device_ids = parsed.assignment.fiscal_device_ids;
    // A hub from before #328 does not say; it makes every key-enrolled desktop ephemeral all the same.
    stored.ephemeral = parsed.ephemeral || field == "enrollmentKey";
    stored.revoked = false;
    if let Some(server_ms) = parse_server_time(&parsed.server_time) {
        stored.clock_offset_ms = ClockOffset::learn(server_ms, now_ms()).millis;
    }

    // The key first: a record without a key reads as "not registered" (see `registration_status`),
    // which is recoverable. A key without a record is an orphan nothing will ever use.
    keystore::store_secret(&dir, &id.secret_bytes())
        .map_err(|_| EnrollError("cannot_store_key".into()))?;
    keystore::save(&dir, &stored).map_err(|_| EnrollError("cannot_store_record".into()))?;

    Ok(stored)
}

/// Mint a 15-minute access token from a signed client assertion (FR-14.20).
///
/// ⚠ `aud` is the token URL itself — the server computes the same string from the request and
/// compares. That is what stops an assertion minted for this endpoint being replayed at another.
pub fn mint_token(server_url: &str) -> Result<String, EnrollError> {
    mint_token_within(server_url, Duration::from_secs(20))
}

/// `mint_token` on a deadline of the caller's: a machine shutting down has seconds, not twenty.
pub fn mint_token_within(server_url: &str, timeout: Duration) -> Result<String, EnrollError> {
    let dir = keystore::secure_dir().map_err(|_| EnrollError("no_secure_storage".into()))?;
    let mut stored = keystore::load(&dir);
    if stored.desktop_id.is_empty() {
        return Err(EnrollError("not_registered".into()));
    }
    let secret = keystore::load_secret(&dir).ok_or_else(|| EnrollError("no_key".into()))?;
    let id = Identity::from_secret_bytes(&secret).ok_or_else(|| EnrollError("bad_key".into()))?;

    let base = server_url.trim_end_matches('/');
    let audience = format!("{base}/api/desktop/v1/token");
    // ⚠ The CORRECTED clock. A machine 3 h fast would otherwise mint an assertion the server
    // tolerates only once; the system clock is never touched, because a till's clock drives
    // fiscal device time sync.
    let offset = ClockOffset { millis: stored.clock_offset_ms };
    let assertion = id.sign_assertion(
        &stored.desktop_id,
        &audience,
        offset.now_sec(now_ms()),
        &identity::new_jti(),
    );

    let res = client_within(server_url, timeout)?
        .post(&audience)
        .json(&serde_json::json!({ "assertion": assertion }))
        .send()?;

    let status = res.status();
    if !status.is_success() {
        let code = res.json::<ErrorResponse>().map(|e| e.code).unwrap_or_default();
        // FR-14.22 — the row is the revocation list, and this is how the machine learns.
        if status.as_u16() == 401 && code == "desktop_revoked" {
            mark_revoked(&dir, &mut stored);
            return Err(EnrollError("desktop_revoked".into()));
        }
        // FR-14.29 — below `DESKTOP_MIN_VERSION`.
        //
        // ⚠ Recorded, not just returned. The machine cannot mint a token until it updates, so
        // nothing on the next launch would rediscover this; the Overview's banner has to be able
        // to say why the bridge is down after a restart. ⚠ And the registration is LEFT ALONE —
        // this is "the build is too old", not "you are not welcome", and deleting the key here
        // would turn an update into a re-enrollment.
        if status.as_u16() == 426 {
            stored.update_required = true;
            let _ = keystore::save(&dir, &stored);
            return Err(EnrollError("desktop_outdated".into()));
        }
        return Err(EnrollError(if code.is_empty() { "token_failed".into() } else { code }));
    }

    let parsed: TokenResponse = res.json().map_err(|_| EnrollError("bad_response".into()))?;
    let learned = parse_server_time(&parsed.server_time)
        .map(|server_ms| ClockOffset::learn(server_ms, now_ms()).millis);
    // A successful mint is the proof that the build is acceptable again, so the banner clears
    // itself when the update lands rather than needing anyone to dismiss it.
    if learned.is_some() || stored.update_required {
        if let Some(ms) = learned {
            stored.clock_offset_ms = ms;
        }
        stored.update_required = false;
        let _ = keystore::save(&dir, &stored);
    }
    Ok(parsed.access_token)
}

/// Report what this machine is, so the Desktops page is not guessing (FR-14.21).
///
/// ⚠ Sent on start and on change, never on a timer. The fields only move when the app is
/// updated or hardware is plugged in, and a periodic PUT would be write traffic from every till
/// in the estate to say nothing changed.
///
/// ⚠ `appVersion` is the field `DESKTOP_MIN_VERSION` is enforced against (FR-14.29), so a
/// desktop that never reports one cannot satisfy a configured floor. That makes this call part
/// of staying connected, not telemetry.
///
/// ⚠ #328: and the answer carries what an admin has assigned to this desktop NOW, which it used to
/// learn only at enrollment (a one-time code carries no start path at all). Returns the new start
/// path when it moved (`""`: none, Open LGR goes to `/`).
pub fn report_self(server_url: &str, app_version: &str, serial_ports: &[String]) -> Result<Option<String>, EnrollError> {
    let token = mint_token(server_url)?;
    let url = format!("{}/api/desktop/v1/self", server_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "appVersion": app_version,
        "hostname": crate::settings::hostname(),
        "os": { "platform": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "capabilities": {
            // FR-14.26 — true since C18: this build can accept a fiscal command and relay it to a
            // serial port.
            //
            // ⚠ It says the BUILD is capable, not that a device is assigned or that a port opened.
            // The Desktops page uses it to decide whether to offer the assignment control at all;
            // whether a given device is actually bridged is `status.bridge.fiscal[].state`, which
            // is the only thing that can distinguish "no port configured" from "cannot open it".
            "fiscalBridge": true,
            "serialPorts": serial_ports,
        },
        // The hub records the skew from this so an admin can SEE a till whose clock is wrong.
        "clientTime": chrono::Utc::now().to_rfc3339(),
    });

    let res = crate::trust::desktop_headers(client(server_url)?.put(&url), server_url, &token).json(&body).send()?;
    if !res.status().is_success() {
        return Err(EnrollError("report_failed".into()));
    }

    // A hub from before #328 sends no assignment, and the record is left as it is.
    let Some(assignment) = res.json::<SelfResponse>().ok().and_then(|r| r.assignment) else {
        return Ok(None);
    };
    let dir = keystore::secure_dir().map_err(|_| EnrollError("no_secure_storage".into()))?;
    let mut stored = keystore::load(&dir);
    let (changed, moved) = refresh_assignment(&mut stored, assignment);
    if changed {
        keystore::save(&dir, &stored).map_err(|_| EnrollError("cannot_store_record".into()))?;
    }
    Ok(moved)
}

/// What `PUT /self` answers (#328).
#[derive(serde::Deserialize)]
struct SelfResponse {
    #[serde(default)]
    assignment: Option<AssignmentResponse>,
}

/// The hub's assignment into the record: whether anything changed, and the new start path if that
/// is what moved. The fiscal device ids are what the Overview lists; the bridge reads the devices
/// themselves from the hub on every connection.
fn refresh_assignment(stored: &mut Stored, assignment: AssignmentResponse) -> (bool, Option<String>) {
    let moved = stored.start_path != assignment.start_path;
    let changed = moved || stored.fiscal_device_ids != assignment.fiscal_device_ids;
    stored.start_path = assignment.start_path;
    stored.fiscal_device_ids = assignment.fiscal_device_ids;
    (changed, moved.then(|| stored.start_path.clone()))
}

/// An ephemeral desktop leaving on a clean shutdown (FR-14.19, #328): `DELETE /self`, then the record
/// and the key go, so the next start is a fresh machine rather than one minting tokens for a row
/// that no longer exists.
///
/// ⚠ On a deadline: Windows gives an app a few seconds once the session ends. A desktop that cannot
/// reach its hub in time keeps its registration, and the hub's reaper removes the row after
/// `ephemeralTtlSec` (FR-14.19's backstop).
pub fn unregister_self(server_url: &str, timeout: Duration) -> Result<(), EnrollError> {
    let token = mint_token_within(server_url, timeout)?;
    let url = format!("{}/api/desktop/v1/self", server_url.trim_end_matches('/'));
    let res = crate::trust::desktop_headers(client_within(server_url, timeout)?.delete(&url), server_url, &token).send()?;
    if !res.status().is_success() {
        let code = res.json::<ErrorResponse>().map(|e| e.code).unwrap_or_default();
        return Err(EnrollError(if code.is_empty() { "unregister_failed".into() } else { code }));
    }
    let dir = keystore::secure_dir().map_err(|_| EnrollError("no_secure_storage".into()))?;
    forget(&dir);
    Ok(())
}

/// The registration gone from this machine: no desktop and no key. The installation id stays, so
/// the hub can still tell a reinstalled machine from a new one (C06).
fn forget(dir: &std::path::Path) {
    let installation_id = keystore::load(dir).installation_id;
    let _ = keystore::save(dir, &Stored { installation_id, ..Stored::default() });
    let _ = keystore::delete_secret(dir);
}

/// The hub's update manifest for this desktop (FR-14.28).
///
/// ⚠ Fetched THROUGH the hub, not from a release CDN: a shop whose firewall allows only the hub
/// still updates, and an operator can withhold a version from the fleet without unpublishing it.
///
/// ⚠ The manifest is NOT a trust boundary. Its signature anchors are pinned in the binary, so a
/// compromised hub can withhold an update or offer an old one — which `is_upgrade` refuses —
/// but it cannot make this machine install anything.
pub fn fetch_manifest(server_url: &str) -> Result<(Option<String>, Option<String>), EnrollError> {
    let token = mint_token(server_url)?;
    let url = format!("{}/api/desktop/v1/latest-release", server_url.trim_end_matches('/'));
    let res = crate::trust::desktop_headers(client(server_url)?.get(&url), server_url, &token).send()?;
    if !res.status().is_success() {
        return Err(EnrollError("manifest_failed".into()));
    }
    let v: serde_json::Value = res.json().map_err(|_| EnrollError("bad_response".into()))?;

    let min_version = v.get("minVersion").and_then(|x| x.as_str()).map(|s| s.to_string());
    let offered = v
        .get("release")
        .and_then(|r| r.get("version"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok((offered, min_version))
}

/// Revocation, on the machine (FR-14.22): say so, stop the bridge, delete the key — in that
/// order, each logged.
///
/// ⚠ The record is KEPT with `revoked: true` so the Overview can explain what happened. Deleting
/// it would leave a machine that merely looks unregistered, and the operator with no idea why.
pub fn mark_revoked(dir: &std::path::Path, stored: &mut Stored) {
    stored.revoked = true;
    let _ = keystore::save(dir, stored);
    // C18 fills the bridge stop path; the call site exists now so that chunk has one place to
    // put it rather than having to find every revocation route.
    stop_bridge();
    let _ = keystore::delete_secret(dir);
}

/// Let go of every fiscal device's serial port (FR-14.26, C18).
///
/// ⚠ Called BEFORE the key is deleted, and that order is the point: once the key is gone the
/// bridge threads cannot mint a token to notice anything, so a port they still held would be held
/// until the process exits. The hub drops the socket from its side too
/// (`stopDesktopBridges`) — neither side trusts the other to do it.
fn stop_bridge() {
    crate::bridge::halt();
}

/// Replace this desktop's keypair (FR-14.32). The server bumps `keyEpoch`, which invalidates
/// every outstanding token.
pub fn rotate_key(server_url: &str, app_version: &str) -> Result<(), EnrollError> {
    let dir = keystore::secure_dir().map_err(|_| EnrollError("no_secure_storage".into()))?;
    let stored = keystore::load(&dir);
    if stored.desktop_id.is_empty() {
        return Err(EnrollError("not_registered".into()));
    }
    // ⚠ Rotation needs an authenticated route the server does not expose yet: `rotateDesktopKey`
    // is admin-side (`desktop.service.ts`), reached from the Desktops page. Until a desktop-side
    // route exists this refuses rather than silently replacing a key the server still trusts —
    // which would lock the machine out of its own registration.
    let _ = (server_url, app_version);
    Err(EnrollError("rotate_not_supported_by_server".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_normalisation_matches_the_servers() {
        // Pinned against `normalizeEnrollmentCode`: upper case, strip separators, O→0, I/L→1.
        assert_eq!(normalize_code("abcd-efgh"), "ABCD2FGH".replace('2', "E"));
        assert_eq!(normalize_code("ABCD-EFGH"), "ABCDEFGH");
        assert_eq!(normalize_code("abcd efgh"), "ABCDEFGH");
        assert_eq!(normalize_code("ab_cd-ef gh"), "ABCDEFGH");
    }

    #[test]
    fn crockford_aliases_are_folded_the_way_a_human_reads_them() {
        // ⚠ Without this a perfectly good code is refused for anyone who reads 0 as "oh".
        assert_eq!(normalize_code("O123-4567"), "01234567");
        assert_eq!(normalize_code("I123-4567"), "11234567");
        assert_eq!(normalize_code("L123-4567"), "11234567");
        assert_eq!(normalize_code("oil0-0000"), "0110" .to_string() + "0000");
    }

    #[test]
    fn server_time_parses_as_the_server_sends_it() {
        // ⚠ The exact shape `new Date().toISOString()` produces — RFC 3339, milliseconds, `Z`.
        // Asserted against chrono's own parse rather than a hand-computed constant, because a
        // wrong constant here would "prove" a wrong parser.
        let expected = chrono::DateTime::parse_from_rfc3339("2026-09-30T12:34:56.789Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(parse_server_time("2026-09-30T12:34:56.789Z"), Some(expected));
        // Milliseconds must survive: dropping them would put the offset out by up to a second
        // on every refresh.
        assert_eq!(expected % 1000, 789);

        assert!(parse_server_time("not a time").is_none());
        assert!(parse_server_time("").is_none());
        // A naive timestamp with no zone is NOT acceptable — it would be read as local time and
        // silently shift the offset by the machine's own error, which is what we are measuring.
        assert!(parse_server_time("2026-09-30T12:34:56").is_none());
    }

    #[test]
    fn an_offset_round_trips_through_the_stored_record() {
        let local = now_ms();
        let server = local + 90_000;
        let off = ClockOffset::learn(server, local);
        let stored = Stored { clock_offset_ms: off.millis, ..Default::default() };
        let back = ClockOffset { millis: stored.clock_offset_ms };
        assert_eq!(back.now_sec(local), server / 1000);
    }

    /// #328 — a key went through `normalize_code` (uppercased, `O`→`0`, `-`/`_` dropped), so the
    /// server hashed something else and no shell could redeem one.
    #[test]
    fn an_enrollment_key_is_sent_as_it_is_and_a_code_is_normalised() {
        let key = "Ab0_-cdEFghijklmnopqrstuvwxyz0123456789ABCD";
        assert_eq!(key.len(), ENROLLMENT_KEY_LENGTH);
        assert!(is_enrollment_key(key));
        assert!(is_enrollment_key(&format!("  {key}\n")), "pasted with whitespace around it");
        assert_eq!(credential_field(&format!(" {key} ")), ("enrollmentKey", key.to_string()));

        assert!(!is_enrollment_key("ABCD-EF12"));
        assert!(!is_enrollment_key(&key[1..]), "42 characters is not a key");
        assert!(!is_enrollment_key(&format!("{}+", &key[1..])), "base64 is not base64url");
        assert_eq!(credential_field("abcd-ef1o"), ("code", "ABCDEF10".to_string()));
    }

    /// #328 — the start path was learned only at enrollment; an admin's later assignment, and any
    /// assignment at all for a desktop enrolled with a code, never reached the till.
    #[test]
    fn the_hubs_assignment_replaces_the_one_from_enrollment() {
        let mut stored = Stored { start_path: "/".into(), fiscal_device_ids: vec!["a".into()], ..Default::default() };
        let same = AssignmentResponse { start_path: "/".into(), fiscal_device_ids: vec!["a".into()] };
        assert_eq!(refresh_assignment(&mut stored, same), (false, None), "nothing to save");

        let pos = AssignmentResponse { start_path: "/pos/terminal".into(), fiscal_device_ids: vec!["a".into()] };
        assert_eq!(refresh_assignment(&mut stored, pos), (true, Some("/pos/terminal".into())));
        assert_eq!(stored.start_path, "/pos/terminal");

        let devices = AssignmentResponse { start_path: "/pos/terminal".into(), fiscal_device_ids: vec![] };
        assert_eq!(refresh_assignment(&mut stored, devices), (true, None), "devices moved, the start path did not");
        assert!(stored.fiscal_device_ids.is_empty());

        // An admin clearing it is a change too: Open LGR goes back to `/`.
        let cleared = AssignmentResponse::default();
        assert_eq!(refresh_assignment(&mut stored, cleared), (true, Some(String::new())));
    }

    #[test]
    fn a_hub_from_before_328_sends_no_assignment_and_nothing_moves() {
        let old: SelfResponse = serde_json::from_str(r#"{"ok":true,"serverTime":"x"}"#).unwrap();
        assert!(old.assignment.is_none());
        let new: SelfResponse =
            serde_json::from_str(r#"{"ok":true,"assignment":{"fiscalDeviceIds":["d1"],"startPath":"/pos"}}"#).unwrap();
        let a = new.assignment.unwrap();
        assert_eq!((a.start_path.as_str(), a.fiscal_device_ids), ("/pos", vec!["d1".to_string()]));
    }
}
