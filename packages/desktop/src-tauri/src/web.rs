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

/// FR-20.39 (plan step P2-4b): a master's "Sign in with LGR", heading for lgrai.app's authorize page.
///
/// ⚠ The page started it with its own PKCE pair and a loopback redirect, and neither survives the
/// trip: the system browser has neither the tab's verifier nor the loopback proxy's launch cookie.
/// So the shell takes the flow over, as it does an OAuth start (FR-14.14).
pub fn is_idp_authorize(url: &Url) -> bool {
    url.path() == "/idp/authorize" && url.query_pairs().any(|(k, _)| k == "client_id") && url.query_pairs().any(|(k, _)| k == "state")
}

/// The authorize URL the system browser gets: the page's `client_id` and `state` kept, the redirect
/// `lgr://login` and the challenge the shell's. Pure, like `oauth_browser_url`.
///
/// ⚠ The page's `redirect_uri` and `code_challenge` are dropped, never merged: a page cannot smuggle
/// its own past the shell.
pub fn idp_browser_url(url: &Url, challenge: &str) -> String {
    let mut out = url.clone();
    {
        let mut q = out.query_pairs_mut();
        q.clear();
        for (k, v) in url.query_pairs() {
            if matches!(k.as_ref(), "redirect_uri" | "code_challenge" | "code_challenge_method") {
                continue;
            }
            q.append_pair(&k, &v);
        }
        q.append_pair("redirect_uri", "lgr://login");
        q.append_pair("code_challenge", challenge);
        q.append_pair("code_challenge_method", "S256");
    }
    out.to_string()
}

/// Where the shell sends `lgr-web` to finish a master's "Sign in with LGR": the code and the
/// verifier in the FRAGMENT, as `redeem_url` does for an OAuth sign-in.
///
/// ⚠ On the origin the window is ON, never the master's own address: a paired master's window lives
/// on the loopback proxy (FR-20.32), and the master's address is one the webview does not trust.
pub fn idp_redeem_url(window_origin: &str, code: &str, verifier: &str) -> Option<String> {
    let base = crate::validate::resolve_in_origin(window_origin, "/auth/idp/desktop")?;
    Some(format!("{base}#code={}&verifier={}", urlencoding(code), urlencoding(verifier)))
}

/// The origin a redeem may be sent to: the server's page the window shows, never the bundled one.
fn redeem_origin(window_url: &Url) -> Option<String> {
    if !matches!(window_url.scheme(), "http" | "https") || is_bundled_host(window_url) {
        return None;
    }
    Some(window_url.origin().ascii_serialization())
}

/// Whether `url` is on `server`'s origin. A server that does not parse matches nothing.
fn same_origin(url: &Url, server: &str) -> bool {
    Url::parse(server).is_ok_and(|s| s.origin() == url.origin())
}

/// Where the master in `server_url` sends its people to sign in with LGR, as the master itself says
/// (`GET /api/auth/idp/config`). Blocking: called off the webview's thread.
fn master_idp_server(server_url: &str) -> Result<String, String> {
    let url = crate::validate::resolve_in_origin(server_url, "/api/auth/idp/config").ok_or("bad_server_url")?;
    let token = crate::enroll::mint_token(server_url).map_err(|e| e.to_string())?;
    let client = crate::trust::client_for(server_url, std::time::Duration::from_secs(15))?;
    let res = crate::trust::desktop_headers(client.get(url), server_url, &token)
        .send()
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("status {}", res.status().as_u16()));
    }
    let body: serde_json::Value = res.json().map_err(|_| "bad_answer".to_string())?;
    match (body.get("enabled").and_then(|v| v.as_bool()), body.get("server").and_then(|v| v.as_str())) {
        (Some(true), Some(server)) => Ok(server.to_string()),
        _ => Err("not_linked".into()),
    }
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

/// Where the window goes for `server_url`, and the origin it may stay on (FR-14.15).
///
/// lgrai.app is loaded directly. A paired master goes through the loopback proxy (FR-20.32): the
/// window enters at its boot page, which hands it the launch secret, and stays on the proxy's
/// origin. The master's own address is one the webview does not trust.
fn route(app: &AppHandle, server_url: &str, start_path: Option<&str>) -> Result<(String, String), String> {
    let target = target_url(server_url, start_path)
        .ok_or_else(|| "the configured server address is not usable".to_string())?;
    let path = Url::parse(&target).map(|u| u.path().to_string()).unwrap_or_else(|_| "/".into());
    Ok(match crate::proxy_route(app, server_url, &path)? {
        Some((origin, boot)) => (boot, origin),
        None => (target, server_url.to_string()),
    })
}

/// A URL as the log may show it. ⚠ Never the fragment: a master's boot URL carries the launch
/// secret there.
fn loggable(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

/// FR-20.32 — before the window shows `server_url`, clear what another server's session left in
/// its storage, and record whose session it now holds.
///
/// ⚠ An install from before this was recorded clears nothing: its window holds the session of the
/// server it has always shown, and wiping it on an update would sign out every till at once.
fn prepare_storage(app: &AppHandle, window: &tauri::WebviewWindow, server_url: &str) {
    let mut cfg = crate::settings::load(app);
    if cfg.web_server == server_url {
        return;
    }
    if !cfg.web_server.is_empty() {
        match window.clear_all_browsing_data() {
            Ok(()) => log(app, &format!("lgr-web: storage cleared (was {}, now {server_url})", cfg.web_server)),
            Err(e) => log(app, &format!("lgr-web: storage NOT cleared: {e}")),
        }
    }
    cfg.web_server = server_url.to_string();
    let _ = crate::settings::save(app, &cfg);
}

/// Where the bundled unreachable page lives inside the app bundle. For a master it names the server
/// and, if the outage lasts, the paper book (FR-20.33).
fn unreachable_url(wait_secs: u64, lang: &str, master: Option<&str>) -> WebviewUrl {
    let mut page = format!("unreachable.html?wait={wait_secs}&lang={lang}");
    if let Some(server) = master {
        let server: String = url::form_urlencoded::byte_serialize(server.as_bytes()).collect();
        page.push_str(&format!("&kind=master&server={server}"));
    }
    WebviewUrl::App(page.into())
}

/// The name the unreachable page gives a master: its address as paired.
fn master_name(server_url: &str) -> Option<String> {
    crate::trust::pin_for(server_url)?;
    Url::parse(server_url).ok().map(|u| crate::proxy::host_header(&u))
}

/// Open or focus `lgr-web`.
///
/// ⚠ Probes FIRST. Loading the cloud URL into a webview that cannot reach it shows the
/// WEBVIEW'S error page — a browser chrome error inside an app window, in whatever language the
/// system webview feels like, with no retry and no diagnostics. FR-14.17 exists because that is
/// what a till operator would otherwise be looking at.
pub fn open(app: &AppHandle, server_url: &str, start_path: Option<&str>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(WEB_LABEL) {
        // Already open: focus it rather than stacking a second copy of the till's screen.
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let reachable = crate::presence::probe(server_url);

    // ⚠ **Record what the probe just learned, in BOTH directions.**
    //
    // This line was missing, and the bug it left was a lie on the Overview. The retry loop sets
    // `Unreachable` and clears it to `Connected` only on ITS OWN recovery path, so a successful
    // open — this path — left a stale `Unreachable` behind. Observed: a desktop pointed at a dead
    // server, re-pointed at a live one, opened it successfully (`lgr-web: opened url=…` in the
    // log) and still showed **"The server cannot be reached"**.
    //
    // ⚠ Nothing else would have corrected it. The presence socket is the other writer of this
    // state, and it does not start at all for an unregistered or revoked desktop — which is
    // exactly when somebody is most likely to be staring at this screen trying to work out why.
    //
    // It costs an hour of somebody checking a firewall while the app is, on the next window,
    // displaying the very server it claims it cannot reach.
    app.state::<crate::AppState>().link.set(if reachable {
        crate::presence::Link::Connected
    } else {
        crate::presence::Link::Unreachable
    });

    if !reachable {
        let target = target_url(server_url, start_path).unwrap_or_default();
        log(app, &format!("lgr-web: server-unreachable url={target}"));
        return open_unreachable(app, server_url, start_path);
    }

    let (target, origin) = route(app, server_url, start_path)?;
    let url = Url::parse(&target).map_err(|e| e.to_string())?;
    let log_app = app.clone();
    let nav_app = app.clone();

    // ⚠ A window that must clear another server's storage is built on `about:blank` and pointed at
    // the server only after `prepare_storage`: no page of the new server may load over it.
    let cfg = crate::settings::load(app);
    let must_clear = !cfg.web_server.is_empty() && cfg.web_server != server_url;
    let first = if must_clear {
        WebviewUrl::External("about:blank".parse().expect("a URL"))
    } else {
        WebviewUrl::External(url.clone())
    };
    let window = WebviewWindowBuilder::new(app, WEB_LABEL, first)
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
    prepare_storage(app, &window, server_url);
    if must_clear {
        let _ = window.navigate(url);
    }

    log(app, &format!("lgr-web: opened url={}", loggable(&target)));
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
        // The origin the window may stay on once the server answers: the proxy's, for a master.
        let origin = match crate::trust::pin_for(server_url) {
            Some(_) => route(app, server_url, start_path)?.1,
            None => server_url.to_string(),
        };
        let nav_app = app.clone();
        let window = WebviewWindowBuilder::new(app, WEB_LABEL, unreachable_url(1, &lang, master_name(server_url).as_deref()))
            .title("LGR")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .on_navigation(move |url| handle_navigation(&nav_app, &origin, url))
            .build()
            .map_err(|e| e.to_string())?;
        // On the bundled page, before any page of the server: clearing here is safe.
        prepare_storage(app, &window, server_url);
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
                if let (Some(w), Ok((target, _))) = (
                    app.get_webview_window(WEB_LABEL),
                    route(&app, &server_url, start_path.as_deref()),
                ) {
                    if let Ok(url) = Url::parse(&target) {
                        log(&app, &format!("lgr-web: server-returned url={}", loggable(&target)));
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
        NavDecision::External if is_idp_authorize(url) => {
            start_master_idp(app, url);
            false
        }
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

/// Hand a master's "Sign in with LGR" to the system browser, keeping the verifier and the state
/// (FR-20.39, P2-4b).
///
/// ⚠ **Only the authorize page of the global the master is linked to arms a flow.** Any page in the
/// window can navigate to a URL of this shape, a link in a document included. Armed for another
/// site, the shell would hand that site its challenge, and the site could send back a code for ITS
/// OWN account: the window would then be signed in as someone else (a login CSRF). Anything else
/// opens in the system browser as an ordinary external link, unarmed.
fn start_master_idp(app: &AppHandle, url: &Url) {
    let Some(state) = url.query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.into_owned()) else { return };
    let (app, url) = (app.clone(), url.clone());
    std::thread::spawn(move || {
        let server_url = crate::settings::load(&app).server_url;
        // Unverified is unarmed: the link opens the way any external link does, and a code that
        // comes back for it finds no flow here.
        let why = match master_idp_server(&server_url) {
            Ok(global) if same_origin(&url, &global) => None,
            Ok(_) => Some("not this server's sign-in page".to_string()),
            Err(e) => Some(format!("cannot ask the server where it signs in ({e})")),
        };
        if let Some(why) = why {
            log(&app, &format!("idp: {why}; opened as an ordinary link"));
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            return;
        }
        let pkce = crate::identity::Pkce::generate();
        let browser_url = idp_browser_url(&url, &pkce.challenge);
        if let Some(st) = app.try_state::<crate::AppState>() {
            if let Ok(mut slot) = st.idp_flow.lock() {
                *slot = Some((state, pkce.verifier));
            }
        }
        // ⚠ Neither the verifier nor the URL is logged: the URL carries the state.
        log(&app, "idp: Sign in with LGR handed to the system browser");
        let _ = tauri_plugin_opener::open_url(&browser_url, None::<&str>);
    });
}

/// `lgr://login?code=…&state=…` for a "Sign in with LGR" this shell started. False when it is not
/// one (no flow, or another state): the caller then treats it as an OAuth sign-in's.
pub fn finish_master_idp(app: &AppHandle, code: &str, state: &str) -> bool {
    let Some(st) = app.try_state::<crate::AppState>() else { return false };
    let flow = {
        let Ok(mut slot) = st.idp_flow.lock() else { return false };
        match slot.as_ref() {
            Some((s, _)) if s == state => slot.take(),
            _ => None,
        }
    };
    let Some((_, verifier)) = flow else { return false };
    let Some(w) = app.get_webview_window(WEB_LABEL) else {
        log(app, "idp: lgr-web is not open; cannot redeem");
        return true;
    };
    let target = w
        .url()
        .ok()
        .and_then(|u| redeem_origin(&u))
        .and_then(|origin| idp_redeem_url(&origin, code, &verifier))
        .and_then(|u| Url::parse(&u).ok());
    match target {
        Some(parsed) => {
            log(app, "idp: redeeming in lgr-web");
            let _ = w.navigate(parsed);
            let _ = w.set_focus();
        }
        None => log(app, "idp: lgr-web is not showing the server; cannot redeem"),
    }
    true
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
    // ⚠ The bundled page is served over plain `http` on `tauri.localhost` on Windows (see
    // `decide_navigation`), so "not http(s)" alone called the shell's own page remote there and
    // refused its Retry and Diagnostics buttons.
    let showing_local = app
        .get_webview_window(WEB_LABEL)
        .and_then(|w| w.url().ok())
        .map(|u| is_bundled_host(&u) || (u.scheme() != "http" && u.scheme() != "https"))
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
    fn a_masters_sign_in_with_lgr_is_taken_over_with_the_shells_own_pkce() {
        let page = Url::parse("https://lgrai.app/idp/authorize?client_id=master-abcdefghijklmnop&redirect_uri=http%3A%2F%2F127.0.0.1%3A47123%2Fauth%2Fidp%2Fcallback&state=s-1&code_challenge=PAGES&code_challenge_method=plain").unwrap();
        assert!(is_idp_authorize(&page));
        assert!(!is_idp_authorize(&Url::parse("https://lgrai.app/idp/authorize").unwrap()));
        let out = Url::parse(&idp_browser_url(&page, "SHELLS")).unwrap();
        let q: std::collections::HashMap<_, _> = out.query_pairs().into_owned().collect();
        assert_eq!(q.get("client_id").map(String::as_str), Some("master-abcdefghijklmnop"));
        assert_eq!(q.get("state").map(String::as_str), Some("s-1"));
        assert_eq!(q.get("redirect_uri").map(String::as_str), Some("lgr://login"));
        assert_eq!(q.get("code_challenge").map(String::as_str), Some("SHELLS"));
        assert_eq!(q.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(out.query_pairs().filter(|(k, _)| k == "code_challenge").count(), 1, "the page's challenge is dropped, not merged");
        let redeem = idp_redeem_url("http://127.0.0.1:47123", "the-code", "the-verifier").unwrap();
        assert_eq!(redeem, "http://127.0.0.1:47123/auth/idp/desktop#code=the-code&verifier=the-verifier");

        // Only the global the master names arms a flow.
        assert!(same_origin(&page, "https://lgrai.app"));
        assert!(same_origin(&page, "https://lgrai.app/"));
        assert!(!same_origin(&page, "https://evil.example"));
        assert!(!same_origin(&page, "http://lgrai.app"));
        assert!(!same_origin(&page, "not a url"));

        // The redeem goes to the page the window shows, on the proxy's origin, never the bundled page.
        let on_proxy = Url::parse("http://127.0.0.1:47123/auth/login?x=1").unwrap();
        assert_eq!(redeem_origin(&on_proxy).as_deref(), Some("http://127.0.0.1:47123"));
        assert_eq!(redeem_origin(&Url::parse("http://tauri.localhost/unreachable.html").unwrap()), None);
        assert_eq!(redeem_origin(&Url::parse("tauri://localhost/index.html").unwrap()), None);
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
