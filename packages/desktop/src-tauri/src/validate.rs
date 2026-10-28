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
///
/// ⚠ **One rule with `desktop-ui/src/server-url.ts`** (FR-20.31), held to the same table of cases
/// (`server-url.cases.json`) by both test suites. The two used to disagree about loopback: this side
/// compared `host_str()` with `"::1"`, which the url crate spells `[::1]`, and knew `127.0.0.1` but
/// not the rest of 127/8, so the page and the shell stored different addresses for the same input.
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
    // Decided on the parsed host, never on the string: `localhost.evil.example` is not loopback.
    let is_loopback = match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
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
    ///
    /// `fp` is a master's CA fingerprint (FR-20.29): the first connection to that server is pinned
    /// to it. ⚠ Only ever on a server a pin may apply to (`trust::may_pin`): a link that tries to pin
    /// a public name such as lgrai.app is an attack, and is refused whole.
    Enroll { server: String, code: String, fp: Option<String> },
    /// Opens `lgr-web` at a path inside the server origin.
    Open { path: String },
    /// The one-time code from the system-browser OAuth round trip (FR-14.14, C12), or from a
    /// master's "Sign in with LGR" (FR-20.39), which also carries the `state` the shell kept.
    Login { code: String, state: Option<String> },
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
            // #328: an enrollment KEY rides in `key`, or in `code` by its shape (FR-14.19). It is
            // carried as it is: a key is case-sensitive, and only `enroll` decides what it is.
            let code = q.get("key").or_else(|| q.get("code"))?.trim().to_string();
            if !is_plausible_code(&code) && !crate::enroll::is_enrollment_key(&code) {
                return None;
            }
            // ⚠ A malformed `fp` refuses the link rather than dropping the pin: a link that meant to
            // pin and silently does not would pair through the OS store, which is not what was asked.
            let fp = match q.get("fp").map(|f| f.trim()) {
                None | Some("") => None,
                Some(f) if crate::trust::is_fingerprint(f) && crate::trust::may_pin(&server) => Some(f.to_string()),
                Some(_) => return None,
            };
            Some(DeepLink::Enroll { server, code, fp })
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
            // A state that is present must be plausible too: a malformed one refuses the link.
            let state = match q.get("state") {
                None => None,
                Some(s) if is_plausible_login_code(s) && s.len() <= 128 => Some(s.clone()),
                Some(_) => return None,
            };
            Some(DeepLink::Login { code, state })
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
            Some(DeepLink::Enroll { server: "https://lgrai.app".into(), code: "ABCD-1234".into(), fp: None })
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
    fn a_masters_link_pins_its_ca() {
        const FP: &str = "sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k";
        // As the master's Desktops page mints it (`mintEnrollmentCode`), `fp` encoded or not.
        for link in [
            format!("lgr://enroll?server=https%3A%2F%2F192.168.1.10%3A4443&code=ABCD-1234&fp={FP}"),
            format!("lgr://enroll?server=https://192.168.1.10:4443&code=ABCD-1234&fp={}", FP.replace(':', "%3A")),
        ] {
            assert_eq!(
                parse_deep_link(&link),
                Some(DeepLink::Enroll {
                    server: "https://192.168.1.10:4443".into(),
                    code: "ABCD-1234".into(),
                    fp: Some(FP.into()),
                }),
                "{link}",
            );
        }
        // An empty `fp` is no pin at all.
        assert!(matches!(
            parse_deep_link("lgr://enroll?server=https%3A%2F%2Flgrai.app&code=ABCD-1234&fp="),
            Some(DeepLink::Enroll { fp: None, .. })
        ));
        for bad in [
            // ⚠ The attack the rule is for: the cloud's own name, pinned by a link.
            format!("lgr://enroll?server=https%3A%2F%2Flgrai.app&code=ABCD-1234&fp={FP}"),
            format!("lgr://enroll?server=https%3A%2F%2Fexample.com%3A4443&code=ABCD-1234&fp={FP}"),
            // A broken fingerprint is a broken link, not a link without a pin.
            "lgr://enroll?server=https%3A%2F%2F192.168.1.10%3A4443&code=ABCD-1234&fp=sha256:short".into(),
            "lgr://enroll?server=https%3A%2F%2F192.168.1.10%3A4443&code=ABCD-1234&fp=md5:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k".into(),
        ] {
            assert_eq!(parse_deep_link(&bad), None, "should refuse {bad:?}");
        }
    }

    #[test]
    fn the_url_rule_is_the_pages_rule() {
        // ⚠ The same table `packages/tests/src/unit/desktop-server-url.test.ts` runs the page's
        // `normaliseServerUrl` against. A case one side fails is a disagreement, whichever side.
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../desktop-ui/src/server-url.cases.json")).unwrap();
        assert!(cases.len() > 20);
        for c in cases {
            let input = c["in"].as_str().unwrap();
            let want = c["out"].as_str();
            assert_eq!(normalize_server_url(input).as_deref(), want, "{input:?}");
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
        // FR-20.39: a master's Sign in with LGR comes back with its state.
        assert_eq!(parse_deep_link("lgr://login?code=abc&state=s-1_x"), Some(DeepLink::Login { code: "abc".into(), state: Some("s-1_x".into()) }));
        assert_eq!(parse_deep_link("lgr://login?code=abc&state=bad%20state"), None);
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

    /// #328 — an enrollment KEY (43 base64url characters) pre-fills as it is, in `key` or in `code`.
    #[test]
    fn an_enroll_link_carries_a_key_as_it_is() {
        let key = "Ab0_-cdEFghijklmnopqrstuvwxyz0123456789ABCD";
        assert_eq!(key.len(), 43);
        for link in [
            format!("lgr://enroll?server=https://lgrai.app&key={key}"),
            format!("lgr://enroll?server=https://lgrai.app&code={key}"),
        ] {
            match parse_deep_link(&link) {
                Some(DeepLink::Enroll { code, .. }) => assert_eq!(code, key, "case and `-`/`_` kept: {link}"),
                other => panic!("{link} parsed as {other:?}"),
            }
        }
        // One character short is neither a key nor a code.
        assert_eq!(parse_deep_link(&format!("lgr://enroll?server=https://lgrai.app&key={}", &key[1..])), None);
    }
}
