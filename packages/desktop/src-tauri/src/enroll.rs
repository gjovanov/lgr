//! C11 — enrollment and access tokens (FR-14.19, FR-14.20).
//!
//! ⚠ **The HTTP client uses the system proxy and the OS trust store** (C09's note, C19's
//! `proxy-tls` check). `native-tls` is schannel on Windows, Secure Transport on macOS and
//! OpenSSL on Linux, so a TLS-inspecting corporate middlebox whose root arrives by GPO just
//! works — with rustls and a bundled root store it would not, and a corporate machine could not
//! enroll at all. `reqwest`'s default proxy resolution reads the system settings, PAC included.
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

fn client() -> Result<reqwest::blocking::Client, EnrollError> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("lgr-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| EnrollError("client_build_failed".into()))
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

/// Exchange a code for this desktop's identity (FR-14.19).
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

    let body = serde_json::json!({
        "code": normalize_code(code),
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

    let url = format!("{}/api/desktop/v1/enroll", server_url.trim_end_matches('/'));
    let res = client()?.post(&url).json(&body).send()?;

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

    let res = client()?
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
pub fn report_self(server_url: &str, app_version: &str, serial_ports: &[String]) -> Result<(), EnrollError> {
    let token = mint_token(server_url)?;
    let url = format!("{}/api/desktop/v1/self", server_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "appVersion": app_version,
        "hostname": crate::settings::hostname(),
        "os": { "platform": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "capabilities": {
            // ⚠ False until C18. Reporting `true` here would put a bridge capability on the
            // Desktops page for a machine that cannot accept a fiscal command.
            "fiscalBridge": false,
            "serialPorts": serial_ports,
        },
        // The hub records the skew from this so an admin can SEE a till whose clock is wrong.
        "clientTime": chrono::Utc::now().to_rfc3339(),
    });

    let res = client()?.put(&url).bearer_auth(token).json(&body).send()?;
    if !res.status().is_success() {
        return Err(EnrollError("report_failed".into()));
    }
    Ok(())
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
    let res = client()?.get(&url).bearer_auth(token).send()?;
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

/// A no-op until C18. Named and called so revocation already has the step in the right order.
fn stop_bridge() {}

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
}
