//! Validation for everything that arrives from outside the shell (FR-14.5, FR-14.12).
//!
//! ⚠ A deep link is attacker-controlled input. `lgr://` is registered with the OS, so ANY process
//! or web page on the machine can hand this app a URL and have it acted on. So is `--view`, which
//! reaches a router.
//!
//! This module is deliberately free of Tauri types so every rule below is unit-testable with
//! `cargo test`, which is where the sharp edges are.

use url::Url;

// ── `--view=<name>` ─────────────────────────────────────────────────────────────────────────

/// The shell's own pages. Anything else is refused rather than passed through to the router.
pub const VIEWS: [&str; 5] = ["overview", "settings", "onboarding", "logs", "diagnostics"];

/// Validate a `--view` value (FR-14.5).
///
/// ⚠ ASCII alphanumerics only, then matched against a fixed list. This value ends up in a
/// front-end route, so neither a path fragment nor a script-ish string may survive it — and an
/// allow-list is the only form of that check which cannot be outsmarted.
pub fn parse_view(raw: &str) -> Option<&'static str> {
    if raw.is_empty() || raw.len() > 20 || !raw.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    VIEWS.iter().copied().find(|v| *v == lower)
}

// ── `startPath` and deep-link paths ─────────────────────────────────────────────────────────

/// Is this a path that may be resolved against the server origin?
///
/// ⚠ **This is a deliberate copy of `START_PATH_PATTERN` in
/// `packages/services/src/biz/desktop/desktop-crypto.ts`.** Rust cannot import the TypeScript
/// constant, so the rule exists twice — and two validators that disagree about `//` is the same
/// bug in a second place. If you change one, change the other; the TS side has the unit tests that
/// caught the original mistake.
///
/// Four things must be refused, and the obvious pattern refuses only one:
///
/// * `//evil.example` — starts with `/` too, and resolves to **another origin**. This is the trap
///   FR-14.12 names by hand, and the first version of the server-side rule let it through;
/// * `/pos/../admin`, `/../etc` — `.` and `/` are both legal path characters, so a plain
///   character class permits traversal;
/// * `?` — `/pos/?token=<JWT>` would sign the till into someone else's account (FR-14.24);
/// * `#` — a fragment hides whatever follows it from any check that looks at the path.
///
/// The empty string is allowed and means "no assigned start path": the app hub.
pub fn is_valid_path(path: &str) -> bool {
    if path.len() > 200 {
        return false;
    }
    if path.is_empty() {
        return true;
    }
    let bytes = path.as_bytes();
    if bytes[0] != b'/' {
        return false;
    }
    // Refuse a protocol-relative path.
    if bytes.len() > 1 && bytes[1] == b'/' {
        return false;
    }
    if path.contains("..") {
        return false;
    }
    path.bytes().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'~' | b'-')
    })
}

/// Resolve a path against the registered server origin, re-checking the result.
///
/// ⚠ Both checks are load-bearing. `is_valid_path` rules out the shapes that escape an origin, and
/// this **re-checks the resolved URL** — because a rule that only inspects the input is a rule that
/// has to be perfect, and this one is cheap. FR-14.12 asks for exactly this pair.
pub fn resolve_in_origin(server: &str, path: &str) -> Option<String> {
    if !is_valid_path(path) {
        return None;
    }
    let base = Url::parse(server).ok()?;
    let joined = base.join(path).ok()?;
    // Same scheme, host and port as the server, or nothing.
    if joined.origin() != base.origin() {
        return None;
    }
    Some(joined.to_string())
}

// ── The server URL itself ───────────────────────────────────────────────────────────────────

/// Normalise the server URL an operator types during onboarding (FR-14.11).
///
/// `http://` is upgraded to `https://` **except for loopback**, so a developer can point at a
/// local server while nobody can be talked into running a shop over plaintext.
pub fn normalize_server_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // ⚠ Do NOT strip trailing slashes before this test. Doing so turned `"https://"` into
    // `"https:"`, which no longer contains `"://"`, so the branch below prefixed it into
    // `"https://https:"` — a URL that parses cleanly with the host `https` and was accepted.
    // The unit test caught it. Trailing slashes are removed at the end instead, from the output.
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    // `Url::parse` already refuses an empty host ("https://" → Err "empty host"), so there is no
    // separate host check to write here.
    let mut url = Url::parse(&with_scheme).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let is_loopback = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("::1"));
    if url.scheme() == "http" && !is_loopback {
        url.set_scheme("https").ok()?;
    }
    // Keep only the origin: a server URL with a path, query or fragment would make every path
    // this shell resolves relative to something the operator did not mean.
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.as_str().trim_end_matches('/').to_string())
}

// ── Deep links ──────────────────────────────────────────────────────────────────────────────

/// A `lgr://` link the shell recognises. Nothing acts on one without confirmation except `open`.
#[derive(Debug, PartialEq, Eq)]
pub enum DeepLink {
    /// ⚠ Pre-fills onboarding and ASKS. It never registers silently (FR-14.12).
    Enroll { server: String, code: String },
    /// Opens `lgr-web` at a path inside the server origin.
    Open { path: String },
    /// The one-time code from the system-browser OAuth round trip (FR-14.14, C12).
    Login { code: String },
}

/// An enrollment code as a human may type or paste it: 8 Crockford characters, any separators.
fn is_plausible_code(code: &str) -> bool {
    let stripped: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
        .collect();
    stripped.len() == 8 && stripped.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A one-time login code: opaque, base64url-ish, bounded.
fn is_plausible_login_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 200
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Parse a `lgr://` URL. Returns `None` for anything not understood — silence, not a guess.
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "lgr" {
        return None;
    }
    // `lgr://enroll?...` parses with "enroll" as the HOST, while `lgr:enroll?...` puts it in the
    // path. Accept either spelling rather than depending on which form the OS hands over.
    let action = url
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .or_else(|| {
            let p = url.path().trim_start_matches('/');
            (!p.is_empty()).then(|| p.to_ascii_lowercase())
        })?;

    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    match action.as_str() {
        "enroll" => {
            let server = normalize_server_url(q.get("server")?)?;
            let code = q.get("code")?.trim().to_string();
            if !is_plausible_code(&code) {
                return None;
            }
            Some(DeepLink::Enroll { server, code })
        }
        "open" => {
            let path = q.get("path").cloned().unwrap_or_else(|| "/".to_string());
            if !is_valid_path(&path) {
                return None;
            }
            Some(DeepLink::Open { path })
        }
        "login" => {
            let code = q.get("code")?.to_string();
            if !is_plausible_login_code(&code) {
                return None;
            }
            Some(DeepLink::Login { code })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn views_are_an_allow_list() {
        assert_eq!(parse_view("overview"), Some("overview"));
        assert_eq!(parse_view("OVERVIEW"), Some("overview"));
        assert_eq!(parse_view("diagnostics"), Some("diagnostics"));
        // Not a view, not a path, not a script.
        for bad in [
            "", "nope", "over view", "overview/", "../overview", "overview;rm",
            "<script>", "overview\u{0}", "ovérview", &"a".repeat(21),
        ] {
            assert_eq!(parse_view(bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn paths_accept_real_ones() {
        for p in ["", "/", "/pos/", "/invoicing/invoices", "/a-b_c.d~e/"] {
            assert!(is_valid_path(p), "should accept {p:?}");
        }
    }

    #[test]
    fn paths_refuse_protocol_relative() {
        // ⚠ The FR-14.12 trap: starts with `/` too, resolves to another origin.
        for p in ["//evil.example", "///x", "//"] {
            assert!(!is_valid_path(p), "should refuse {p:?}");
        }
    }

    #[test]
    fn paths_refuse_traversal_query_and_fragment() {
        for p in [
            "/pos/../admin", "/../etc", "/..",
            "/pos/?token=x", "/pos?a=b", "/pos/#f",
            "https://evil.example", "pos", "/a\\b",
        ] {
            assert!(!is_valid_path(p), "should refuse {p:?}");
        }
    }

    #[test]
    fn paths_are_bounded() {
        assert!(!is_valid_path(&format!("/{}", "a".repeat(300))));
    }

    #[test]
    fn resolution_stays_in_the_origin() {
        let s = "https://lgrai.app";
        assert_eq!(resolve_in_origin(s, "/pos/"), Some("https://lgrai.app/pos/".into()));
        // ⚠ Even if a path slipped past the first check, the resolved origin is re-checked.
        assert_eq!(resolve_in_origin(s, "//evil.example"), None);
        assert_eq!(resolve_in_origin(s, "https://evil.example/"), None);
        assert_eq!(resolve_in_origin("not a url", "/pos/"), None);
    }

    #[test]
    fn server_urls_upgrade_to_https_except_loopback() {
        assert_eq!(normalize_server_url("lgrai.app").as_deref(), Some("https://lgrai.app"));
        assert_eq!(normalize_server_url("http://lgrai.app").as_deref(), Some("https://lgrai.app"));
        assert_eq!(normalize_server_url("https://lgrai.app/").as_deref(), Some("https://lgrai.app"));
        // Loopback keeps http so a developer can point at a local server.
        assert_eq!(normalize_server_url("http://localhost:4001").as_deref(), Some("http://localhost:4001"));
        assert_eq!(normalize_server_url("http://127.0.0.1:4001").as_deref(), Some("http://127.0.0.1:4001"));
        // A path, query or fragment on the SERVER url would misdirect every path resolved against it.
        assert_eq!(normalize_server_url("https://lgrai.app/x?y=1#z").as_deref(), Some("https://lgrai.app"));
        for bad in ["", "   ", "file:///etc/passwd", "javascript:alert(1)", "https://"] {
            assert_eq!(normalize_server_url(bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn enroll_links_need_a_plausible_code_and_a_real_server() {
        let ok = parse_deep_link("lgr://enroll?server=https%3A%2F%2Flgrai.app&code=ABCD-1234");
        assert_eq!(
            ok,
            Some(DeepLink::Enroll { server: "https://lgrai.app".into(), code: "ABCD-1234".into() })
        );
        for bad in [
            "lgr://enroll?server=https%3A%2F%2Flgrai.app",            // no code
            "lgr://enroll?code=ABCD-1234",                            // no server
            "lgr://enroll?server=javascript%3Aalert(1)&code=ABCD-1234",
            "lgr://enroll?server=https%3A%2F%2Flgrai.app&code=short",
            "lgr://enroll?server=https%3A%2F%2Flgrai.app&code=TOOLONGCODE123",
        ] {
            assert_eq!(parse_deep_link(bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn open_links_are_path_checked() {
        assert_eq!(parse_deep_link("lgr://open?path=/pos/"), Some(DeepLink::Open { path: "/pos/".into() }));
        // Defaults to the app hub when no path is given.
        assert_eq!(parse_deep_link("lgr://open"), Some(DeepLink::Open { path: "/".into() }));
        // ⚠ The two payloads FR-14's acceptance criterion 5 names explicitly.
        assert_eq!(parse_deep_link("lgr://open?path=//evil.example"), None);
        assert_eq!(parse_deep_link("lgr://open?path=/pos/%3Ftoken%3Deyphony"), None);
    }

    #[test]
    fn login_links_carry_only_an_opaque_code() {
        assert!(matches!(parse_deep_link("lgr://login?code=abc-123_XY"), Some(DeepLink::Login { .. })));
        for bad in ["lgr://login", "lgr://login?code=", "lgr://login?code=has%20space"] {
            assert_eq!(parse_deep_link(bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn other_schemes_and_actions_are_ignored() {
        for bad in [
            "https://lgrai.app/", "file:///etc/passwd", "lgr://unknown?x=1",
            "lgr://", "not a url",
        ] {
            assert_eq!(parse_deep_link(bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn both_deep_link_spellings_parse() {
        // Depending on the OS, the action arrives as the host or as the path.
        assert!(parse_deep_link("lgr://open?path=/pos/").is_some());
        assert!(parse_deep_link("lgr:open?path=/pos/").is_some());
    }
}
