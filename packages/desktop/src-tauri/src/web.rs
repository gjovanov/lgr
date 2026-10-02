//! C10 — the `lgr-web` window (FR-14.13, FR-14.15–14.17).
//!
//! One window that shows the cloud app, plus the things a browser does for free and a webview
//! does not.
//!
//! ⚠ **No auth handover, ever.** The user signs in inside this window with the portal's normal
//! login and the session lives in the webview's profile. No JWT, cookie or code passes from the
//! shell into the page — not in a URL, not in a header, not through `postMessage`. That is
//! S-05's lesson (FR-14.24), and every shortcut here re-creates it.
//!
//! ⚠ **No IPC.** `lgr-web` appears in no capability (`capabilities/default.json` lists only
//! `main`), so an `invoke` from the cloud app is refused by the ACL rather than by anything in
//! this file. Nothing here may weaken that.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// The window label. One window, reused — opening twice focuses the first.
pub const WEB_LABEL: &str = "lgr-web";

/// What should happen to a navigation the window attempted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDecision {
    /// Inside the app: let the window follow it.
    Allow,
    /// Outside the app, or something the OS should own: hand it to the system browser.
    External,
    /// Neither: a scheme a web page has no business navigating a desktop app to.
    Block,
    /// The bundled unreachable page asking the shell to do something (FR-14.17).
    Shell(ShellAction),
}

/// The two things the unreachable page offers.
///
/// ⚠ This exists so that page can have buttons WITHOUT `lgr-web` gaining IPC. The window is in
/// no capability — that is what refuses the cloud app (FR-14.9) — so a navigation to a scheme
/// the shell recognises is the channel, and the caller still checks that the local page is the
/// one on screen before acting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellAction {
    RetryNow,
    Diagnostics,
}

/// The scheme the bundled page uses to talk back.
const SHELL_SCHEME: &str = "lgr-shell";

/// Is this the hook C12 will take over?
///
/// ⚠ OAuth is SAME-ORIGIN, so it has to be decided before the same-origin allow or it never
/// gets a chance. C10 routes it to the system browser unconditionally; C12 adds PKCE and the
/// `lgr://login` redeem. Keeping the hook here — rather than letting C12 add a special case to
/// a rule that already said "allow" — is what makes that a change of behaviour and not a
/// change of structure.
pub fn is_oauth_start(url: &Url) -> bool {
    let p = url.path();
    p == "/api/oauth" || p.starts_with("/api/oauth/")
}

/// Add `desktop=` and the S256 challenge to an OAuth start URL (FR-14.14).
///
/// ⚠ Pure, so the one URL the system browser is handed can be asserted without launching one.
///
/// ⚠ Existing parameters are PRESERVED. `/api/oauth/google?org_slug=acme` is how the page starts
/// the flow, and dropping `org_slug` makes the server answer 400 for every login — a failure
/// that looks like "Google is broken" rather than "we rebuilt the URL badly".
pub fn oauth_browser_url(url: &Url, desktop_id: &str, challenge: &str) -> String {
    let mut out = url.clone();
    {
        let mut q = out.query_pairs_mut();
        q.clear();
        for (k, v) in url.query_pairs() {
            // Never let a page smuggle its own values past us.
            if k == "desktop" || k == "code_challenge" {
                continue;
            }
            q.append_pair(&k, &v);
        }
        q.append_pair("desktop", desktop_id);
        q.append_pair("code_challenge", challenge);
    }
    out.to_string()
}

/// Where the shell sends `lgr-web` to finish a desktop sign-in (FR-14.14).
///
/// ⚠ The verifier rides in the FRAGMENT. A fragment is never sent to a server and never appears
/// in an access log, which is the whole reason it is not a query parameter. The page clears it
/// with `history.replaceState` after reading, so it does not survive into a bookmark either.
pub fn redeem_url(server_url: &str, code: &str, verifier: &str) -> Option<String> {
    let base = crate::validate::resolve_in_origin(server_url, "/auth/desktop-redeem")?;
    Some(format!(
        "{base}#code={}&verifier={}",
        urlencoding(code),
        urlencoding(verifier)
    ))
}

/// Percent-encode for a fragment. Small and local: the values are base64url, so only `=` and a
/// handful of separators can appear, but encoding them is what keeps the parse unambiguous.
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// The containment rule (FR-14.15).
///
/// ⚠ `origin` is the registered server origin, already normalised by `validate`. Comparing
/// `Url::origin()` rather than string prefixes is deliberate: `https://lgrai.app.evil.example`
/// has `https://lgrai.app` as a prefix and is a different site.
/// Is this URL the shell's OWN bundle, as the platform webview serves it?
///
/// ⚠ Exact hosts, never a suffix test. `tauri.localhost.evil.example` ends with nothing that
/// matters here, but `evil-tauri.localhost` would pass a `contains` and `tauri.localhost.evil` a
/// naive `starts_with` — and either would make a remote site look like the shell's own bundle.
fn is_bundled_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("tauri.localhost") | Some("asset.localhost"))
}

pub fn decide_navigation(origin: &str, url: &Url) -> NavDecision {
    // The bundled page's channel, before anything else — it is not an http(s) navigation and
    // must not fall through to the "exotic scheme" block below.
    if url.scheme() == SHELL_SCHEME {
        // `lgr-shell://retry` parses with "retry" as the HOST, not the path.
        let what = url.host_str().unwrap_or("").to_ascii_lowercase();
        return match what.as_str() {
            "retry" => NavDecision::Shell(ShellAction::RetryNow),
            "diagnostics" => NavDecision::Shell(ShellAction::Diagnostics),
            _ => NavDecision::Block,
        };
    }

    // The webview's own internals. Blocking these breaks downloads and `about:blank` targets
    // that the page legitimately uses before navigating.
    match url.scheme() {
        "about" | "blob" | "data" => return NavDecision::Allow,
        // What the shell itself serves: the bundled unreachable page lives here.
        "tauri" | "asset" | "http+tauri" | "https+tauri" => return NavDecision::Allow,
        "http" | "https" => {}
        // `file:`, `javascript:`, `lgr:` and anything else a page invents.
        _ => return NavDecision::Block,
    }

    // ⚠ **On Windows the bundle is served over plain `http`, on the host `tauri.localhost`** — not
    // through a `tauri:` scheme. So the branch above never matched it, the origin comparison below
    // called the shell's OWN page a different site, and `unreachable.html` was handed to the SYSTEM
    // BROWSER: the `lgr-web` window stayed blank and the OS was asked to open a URL that means
    // nothing outside a webview. FR-14.17 exists so a till operator sees a retry page instead of a
    // browser error, and on Windows they saw neither.
    //
    // ⚠ Allowing it opens nothing. These hosts are servable only by this process's own webview —
    // they are not reachable over the network — and the bundle loaded in `lgr-web` still holds no
    // capability, because `lgr-web` is in none (FR-14.9). What it costs to block is the one page
    // the feature is about.
    if is_bundled_host(url) {
        return NavDecision::Allow;
    }

    let Ok(server) = Url::parse(origin) else {
        // No usable origin configured: nothing is "inside", so nothing is allowed in.
        return NavDecision::Block;
    };

    if url.origin() != server.origin() {
        return NavDecision::External;
    }

    // Same origin from here on.
    if is_oauth_start(url) {
        return NavDecision::External;
    }

    NavDecision::Allow
}

/// Where **Open LGR** lands: the registered origin plus the assignment's `startPath`
/// (FR-14.16), falling back to `/`.
///
/// ⚠ Re-validated through `resolve_in_origin` even though the assignment comes from the server.
/// `//evil.example` and `/pos/?token=…` are refused by that validator, and defence in depth at
/// the navigation boundary costs two lines (C10's trap).
pub fn target_url(server_url: &str, start_path: Option<&str>) -> Option<String> {
    let path = start_path.unwrap_or("/");
    crate::validate::resolve_in_origin(server_url, path)
        .or_else(|| crate::validate::resolve_in_origin(server_url, "/"))
}

/// Where the bundled unreachable page lives inside the app bundle.
fn unreachable_url(wait_secs: u64, lang: &str) -> WebviewUrl {
    WebviewUrl::App(format!("unreachable.html?wait={wait_secs}&lang={lang}").into())
}

/// Open or focus `lgr-web`.
///
/// ⚠ Probes FIRST. Loading the cloud URL into a webview that cannot reach it shows the
/// WEBVIEW'S error page — a browser chrome error inside an app window, in whatever language the
/// system webview feels like, with no retry and no diagnostics. FR-14.17 exists because that is
/// what a till operator would otherwise be looking at.
pub fn open(app: &AppHandle, server_url: &str, start_path: Option<&str>) -> Result<(), String> {
    let target = target_url(server_url, start_path)
        .ok_or_else(|| "the configured server address is not usable".to_string())?;

    if let Some(existing) = app.get_webview_window(WEB_LABEL) {
        // Already open: focus it rather than stacking a second copy of the till's screen.
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let reachable = crate::presence::probe(server_url);
    if !reachable {
        log(app, &format!("lgr-web: server-unreachable url={target}"));
        return open_unreachable(app, server_url, start_path);
    }

    let url = Url::parse(&target).map_err(|e| e.to_string())?;
    let origin = server_url.to_string();
    let log_app = app.clone();
    let nav_app = app.clone();

    WebviewWindowBuilder::new(app, WEB_LABEL, WebviewUrl::External(url))
        .title("LGR")
        .inner_size(1280.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .resizable(true)
        .on_navigation(move |url| handle_navigation(&nav_app, &origin, url))
        .on_download(move |_webview, event| {
            // FR-14.15 — a browser does this for free. The exports go through blob URLs and
            // `a.download` (`ui-shared/composables/useInvoicingExport.ts`), which a webview
            // otherwise drops on the floor.
            if let tauri::webview::DownloadEvent::Requested { url, destination } = event {
                if save_as(&log_app, &url, destination) {
                    log(&log_app, &format!("lgr-web: download-accepted url={url}"));
                } else {
                    log(&log_app, &format!("lgr-web: download-cancelled url={url}"));
                    return false;
                }
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    log(app, &format!("lgr-web: opened url={target}"));
    Ok(())
}

/// Ask the OS where to put a download, defaulting to the suggested file name.
///
/// Returns false when the person cancelled, which `on_download` turns into "do not download".
fn save_as(app: &AppHandle, url: &Url, destination: &mut std::path::PathBuf) -> bool {
    use tauri_plugin_dialog::DialogExt;

    // The name the server suggested, else the last path segment, else something typable.
    let suggested = destination
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .or_else(|| {
            url.path_segments()
                .and_then(|mut s| s.next_back())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "download".to_string());

    // ⚠ Blocking on purpose. `on_download` must answer before the webview proceeds, and a
    // non-blocking picker would return "yes" with a destination nobody has chosen yet.
    let chosen = app
        .dialog()
        .file()
        .set_file_name(&suggested)
        .blocking_save_file();

    match chosen.and_then(|p| p.into_path().ok()) {
        Some(path) => {
            *destination = path;
            true
        }
        None => false,
    }
}

/// Show the bundled page and start the retry loop (FR-14.17).
fn open_unreachable(app: &AppHandle, server_url: &str, start_path: Option<&str>) -> Result<(), String> {
    let lang = crate::settings::load(app).locale;
    let lang = if lang.is_empty() { "en".to_string() } else { lang };

    if let Some(existing) = app.get_webview_window(WEB_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
    } else {
        let origin = server_url.to_string();
        let nav_app = app.clone();
        WebviewWindowBuilder::new(app, WEB_LABEL, unreachable_url(1, &lang))
            .title("LGR")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .on_navigation(move |url| handle_navigation(&nav_app, &origin, url))
            .build()
            .map_err(|e| e.to_string())?;
    }

    start_retry_loop(app, server_url.to_string(), start_path.map(|s| s.to_string()));
    Ok(())
}

/// Probe on a 1 s → 60 s backoff and return to `startPath` by itself when the server answers.
///
/// ⚠ One loop at a time. Pressing **Retry now** three times must not start three threads that
/// each navigate the window; the flag is what makes the button a nudge to the existing loop
/// (`LinkState::nudge`) rather than a new one.
fn start_retry_loop(app: &AppHandle, server_url: String, start_path: Option<String>) {
    use std::sync::atomic::Ordering;

    let state = app.state::<crate::AppState>();
    if state.retrying.swap(true, Ordering::SeqCst) {
        state.link.nudge();
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let mut attempt = 0u32;
        loop {
            // The window going away ends the loop — nobody is looking at the page any more.
            if app.get_webview_window(WEB_LABEL).is_none() {
                break;
            }
            if crate::presence::probe(&server_url) {
                if let (Some(w), Some(target)) = (
                    app.get_webview_window(WEB_LABEL),
                    target_url(&server_url, start_path.as_deref()),
                ) {
                    if let Ok(url) = Url::parse(&target) {
                        log(&app, &format!("lgr-web: server-returned url={target}"));
                        app.state::<crate::AppState>().link.set(crate::presence::Link::Connected);
                        let _ = w.navigate(url);
                    }
                }
                break;
            }

            app.state::<crate::AppState>().link.set(crate::presence::Link::Unreachable);
            attempt = attempt.saturating_add(1);
            let wait = crate::presence::backoff_secs(attempt);
            // Sleep in slices so **Retry now** does not have to wait out a 60 s backoff.
            for _ in 0..(wait * 10) {
                if app.state::<crate::AppState>().link.take_nudge_public() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        app.state::<crate::AppState>().retrying.store(false, Ordering::SeqCst);
    });
}

/// The navigation handler, shared by both ways the window gets built.
fn handle_navigation(app: &AppHandle, origin: &str, url: &Url) -> bool {
    match decide_navigation(origin, url) {
        NavDecision::Allow => true,
        NavDecision::External if is_oauth_start(url) => {
            // FR-14.14 — Google refuses sign-in inside embedded webviews it detects, and WHICH
            // ones it detects changes without notice. The handshake runs in the system browser,
            // carrying a challenge whose verifier stays here.
            start_desktop_oauth(app, url);
            false
        }
        NavDecision::External => {
            // ⚠ A structured line, because neither a browser launch nor a print dialog is
            // observable from CDP — C15 asserts on exactly these.
            log(app, &format!("lgr-web: external-navigation url={url}"));
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            false
        }
        NavDecision::Shell(action) => {
            act_on_shell_request(app, action);
            false
        }
        NavDecision::Block => {
            log(app, &format!("lgr-web: blocked-navigation url={url}"));
            false
        }
    }
}

/// Hand an OAuth start URL to the system browser, keeping the verifier (FR-14.14).
fn start_desktop_oauth(app: &AppHandle, url: &Url) {
    let Ok(dir) = crate::keystore::secure_dir() else { return };
    let stored = crate::keystore::load(&dir);
    if stored.desktop_id.is_empty() {
        // ⚠ Without a desktop identity there is nothing to bind a code to, so a code minted
        // here could be redeemed by anyone holding it. Fall back to a plain external open: the
        // user signs in in their browser, and nothing comes back over `lgr://`.
        log(app, "oauth: not registered, opening without a desktop binding");
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
        return;
    }

    let pkce = crate::identity::Pkce::generate();
    let browser_url = oauth_browser_url(url, &stored.desktop_id, &pkce.challenge);

    // ⚠ The VERIFIER is kept in memory only, and the log line carries neither it nor the URL's
    // query — C12's trap 3 is that it is easy to log a whole URL, and this one ends in a
    // credential's other half.
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(mut slot) = state.oauth_verifier.lock() {
            *slot = Some(pkce.verifier);
        }
    }
    log(app, "oauth: handshake handed to the system browser");
    let _ = tauri_plugin_opener::open_url(&browser_url, None::<&str>);
}

/// `lgr://login?code=…` came back from the system browser (FR-14.14).
///
/// ⚠ The code is useless on its own, which is why it is safe to receive over a scheme any
/// program can claim. This takes the verifier that was kept here and sends both to the page
/// through a fragment.
pub fn finish_desktop_oauth(app: &AppHandle, code: &str) {
    let verifier = app
        .try_state::<crate::AppState>()
        .and_then(|s| s.oauth_verifier.lock().ok().and_then(|mut v| v.take()));

    let Some(verifier) = verifier else {
        // ⚠ No verifier means THIS shell did not start the flow — so this is somebody else's
        // code arriving over a scheme anyone can send to. Refuse it rather than trying.
        log(app, "oauth: a login code arrived with no flow in progress; ignored");
        return;
    };

    let server_url = crate::settings::load(app).server_url;
    let Some(url) = redeem_url(&server_url, code, &verifier) else {
        log(app, "oauth: cannot build the redeem URL");
        return;
    };

    if let Some(w) = app.get_webview_window(WEB_LABEL) {
        if let Ok(parsed) = Url::parse(&url) {
            // ⚠ Logged WITHOUT the fragment: that is where the verifier is.
            log(app, "oauth: redeeming in lgr-web");
            let _ = w.navigate(parsed);
            let _ = w.set_focus();
        }
    } else {
        log(app, "oauth: lgr-web is not open; cannot redeem");
    }
}

/// ⚠ Only while the BUNDLED page is the one on screen. The scheme is reachable from any page in
/// the window, including the cloud app, so the guard is what stops a remote page spamming
/// diagnostics bundles. Retry is harmless either way; this keeps both honest.
fn act_on_shell_request(app: &AppHandle, action: ShellAction) {
    let showing_local = app
        .get_webview_window(WEB_LABEL)
        .and_then(|w| w.url().ok())
        .map(|u| u.scheme() != "http" && u.scheme() != "https")
        .unwrap_or(false);

    if !showing_local {
        log(app, "lgr-web: shell-action refused (not the bundled page)");
        return;
    }

    match action {
        ShellAction::RetryNow => {
            log(app, "lgr-web: retry-requested");
            app.state::<crate::AppState>().link.nudge();
        }
        ShellAction::Diagnostics => {
            log(app, "lgr-web: diagnostics-requested");
            match crate::create_diagnostics_bundle(app.clone()) {
                Ok(path) => log(app, &format!("lgr-web: diagnostics-written path={path}")),
                Err(e) => log(app, &format!("lgr-web: diagnostics-failed {e}")),
            }
        }
    }
}

/// Close `lgr-web` if it exists. A hidden signed-in webview would show the previous shift's
/// user (C10's trap), so it is destroyed rather than hidden.
pub fn close(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WEB_LABEL) {
        let _ = w.destroy();
    }
}

fn log(app: &AppHandle, msg: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.logger.info(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://lgrai.app";

    fn decide(raw: &str) -> NavDecision {
        decide_navigation(ORIGIN, &Url::parse(raw).unwrap())
    }

    #[test]
    fn same_origin_pages_stay_in_the_window() {
        assert_eq!(decide("https://lgrai.app/"), NavDecision::Allow);
        assert_eq!(decide("https://lgrai.app/pos/"), NavDecision::Allow);
        assert_eq!(decide("https://lgrai.app/invoicing/invoices?page=2"), NavDecision::Allow);
    }

    #[test]
    fn another_site_goes_to_the_system_browser() {
        assert_eq!(decide("https://example.com/"), NavDecision::External);
        assert_eq!(decide("https://docs.lgrai.app/help"), NavDecision::External);
    }

    #[test]
    fn a_lookalike_host_is_not_the_app() {
        // ⚠ A prefix comparison would call this one "inside" and hand it the session.
        assert_eq!(decide("https://lgrai.app.evil.example/pos/"), NavDecision::External);
        assert_eq!(decide("https://lgrai.app.evil.example/"), NavDecision::External);
    }

    #[test]
    fn http_on_the_same_host_is_a_different_origin() {
        // Downgrade attempts leave the window.
        assert_eq!(decide("http://lgrai.app/pos/"), NavDecision::External);
    }

    #[test]
    fn oauth_leaves_the_window_even_though_it_is_same_origin() {
        // The C12 hook. Unconditional here; PKCE and the redeem land there.
        assert_eq!(decide("https://lgrai.app/api/oauth/google"), NavDecision::External);
        assert_eq!(decide("https://lgrai.app/api/oauth/google?org_slug=x"), NavDecision::External);
        assert!(is_oauth_start(&Url::parse("https://lgrai.app/api/oauth/microsoft").unwrap()));
    }

    #[test]
    fn a_path_that_merely_starts_with_the_oauth_text_is_not_oauth() {
        assert!(!is_oauth_start(&Url::parse("https://lgrai.app/api/oauthx/evil").unwrap()));
        assert_eq!(decide("https://lgrai.app/api/oauthx/evil"), NavDecision::Allow);
    }

    #[test]
    fn webview_internals_are_allowed() {
        for raw in ["about:blank", "blob:https://lgrai.app/abc", "data:text/plain,x"] {
            assert_eq!(decide(raw), NavDecision::Allow, "{raw}");
        }
    }

    #[test]
    fn the_shells_own_bundle_is_internal_however_the_platform_serves_it() {
        // ⚠ The regression this exists for: on Windows the bundle is served over plain `http` on
        // `tauri.localhost`, so the shell's OWN unreachable page was classified External and handed
        // to the system browser. The `lgr-web` window stayed blank and the OS was asked to open a
        // URL that means nothing outside a webview — FR-14.17's entire purpose, lost on the one
        // platform the tills run.
        for raw in [
            "http://tauri.localhost/unreachable.html?wait=1&lang=en",
            "https://tauri.localhost/index.html",
            "http://asset.localhost/icon.png",
            // The other platforms' spelling, which already worked.
            "tauri://localhost/unreachable.html",
        ] {
            assert_eq!(decide(raw), NavDecision::Allow, "{raw}");
        }
    }

    #[test]
    fn a_host_that_merely_resembles_the_bundle_is_still_outside() {
        // ⚠ Exact hosts, never a suffix or substring test — otherwise a remote site could dress
        // itself up as the shell's own bundle and be loaded into `lgr-web` as "internal".
        for raw in [
            "https://tauri.localhost.evil.example/x",
            "https://evil-tauri.localhost/x",
            "https://asset.localhost.evil.example/x",
        ] {
            assert_eq!(decide(raw), NavDecision::External, "{raw}");
        }
    }

    #[test]
    fn exotic_schemes_are_blocked_outright() {
        for raw in ["file:///etc/passwd", "javascript:alert(1)", "lgr://enroll?code=X"] {
            assert_eq!(decide(raw), NavDecision::Block, "{raw}");
        }
    }

    #[test]
    fn the_bundled_pages_buttons_are_recognised() {
        // ⚠ This scheme is how the unreachable page acts WITHOUT `lgr-web` gaining IPC. If it
        // ever falls through to `Block`, the page's buttons silently stop working and the only
        // symptom is an operator saying "nothing happens".
        assert_eq!(decide("lgr-shell://retry"), NavDecision::Shell(ShellAction::RetryNow));
        assert_eq!(decide("lgr-shell://diagnostics"), NavDecision::Shell(ShellAction::Diagnostics));
        // Case folding, because a webview may normalise the host.
        assert_eq!(decide("lgr-shell://RETRY"), NavDecision::Shell(ShellAction::RetryNow));
    }

    #[test]
    fn an_unknown_shell_action_is_blocked_rather_than_guessed() {
        assert_eq!(decide("lgr-shell://wipe"), NavDecision::Block);
        assert_eq!(decide("lgr-shell://"), NavDecision::Block);
    }

    #[test]
    fn the_shell_scheme_is_decided_before_the_exotic_scheme_block() {
        // Ordering regression: `lgr-shell:` is not http(s), so a rule that checked the scheme
        // list first would reject it as exotic. The two tests above only pass while the shell
        // check comes first, and this names why.
        let u = Url::parse("lgr-shell://retry").unwrap();
        assert_ne!(decide_navigation(ORIGIN, &u), NavDecision::Block);
        // ...and it is still refused when no origin is configured, because it is not a
        // navigation into the app at all.
        assert_eq!(decide_navigation("", &u), NavDecision::Shell(ShellAction::RetryNow));
    }

    #[test]
    fn nothing_is_inside_when_no_origin_is_configured() {
        let u = Url::parse("https://lgrai.app/").unwrap();
        assert_eq!(decide_navigation("", &u), NavDecision::Block);
        assert_eq!(decide_navigation("not a url", &u), NavDecision::Block);
    }

    #[test]
    fn target_url_uses_the_assignment_and_falls_back_to_root() {
        assert_eq!(target_url(ORIGIN, Some("/pos/")).unwrap(), "https://lgrai.app/pos/");
        assert_eq!(target_url(ORIGIN, None).unwrap(), "https://lgrai.app/");
    }

    #[test]
    fn a_hostile_start_path_falls_back_rather_than_escaping() {
        // ⚠ The assignment comes from the server, and is still re-validated: `//evil.example`
        // is a protocol-relative URL, not a path.
        let got = target_url(ORIGIN, Some("//evil.example")).unwrap();
        assert!(got.starts_with("https://lgrai.app/"), "escaped the origin: {got}");
    }

    #[test]
    fn a_start_path_carrying_a_token_falls_back() {
        // FR-14.24: a `?token=` never reaches a page from the shell.
        let got = target_url(ORIGIN, Some("/pos/?token=abc")).unwrap();
        assert!(!got.contains("token"), "token survived into the target: {got}");
    }
}
