//! `lgr-server`: the supervisor an on-premises master runs (FR-20, plan step P1-1).
//!
//! It runs the master's processes (the API today; `mongod` from P1-2), keeps them up with backoff,
//! answers a local control channel, and registers itself with the OS. Everything a shop's server
//! does goes through it: the API never runs on its own on a master.

mod advert;
mod backoff;
mod child;
mod certs;
mod config;
mod control;
mod desktop_releases;
mod egress;
mod front;
mod helper;
mod https;
mod ingress;
mod install;
mod ipc;
mod licence;
mod mongod;
mod node_key;
mod node_token;
mod pointer;
mod preflight;
mod register;
mod service;
mod supervisor;
mod uplink;
mod version;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::future::Future;

#[derive(Parser)]
#[command(name = "lgr-server", version, about = "LGR Server: the supervisor an on-premises master runs")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the supervisor in the foreground (development, containers). Ctrl+C stops it.
    Run,
    /// Register with the OS, or remove the registration, or run as the OS starts it.
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Ask the running supervisor how its children are.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Restart one child of the running supervisor (`api`).
    Restart { child: String },
    /// Stop the running supervisor and its children.
    Stop,
    /// What a support request needs: versions, paths, the machine check, and the supervisor's status.
    Diagnostics,
    /// Can this machine run a master? CPU, memory, disk, and where the data goes (FR-20.13).
    Preflight {
        #[arg(long)]
        json: bool,
    },
    /// Run a maintenance script the package carries (its manifest's `scripts`), with the API's environment.
    RunScript {
        name: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Take a backup now (plan step P1-9).
    Backup {
        #[command(subcommand)]
        action: BackupAction,
    },
    /// Print the link that opens the setup console, with its one-time token (FR-20.18).
    SetupToken,
    /// Register this master with global for an org (FR-20.2), with the code its admin minted on the
    /// Servers page. Run again with another org's code to add that org.
    Register {
        #[arg(long)]
        code: String,
        /// lgrai.app, or a test global.
        #[arg(long, default_value = register::DEFAULT_SERVER)]
        server: String,
        /// `control` (no business data leaves the building) or `full` (FR-20.54).
        #[arg(long, default_value = "control")]
        link: String,
        /// What the Servers page calls it; the machine's name when not given.
        #[arg(long)]
        name: Option<String>,
    },
    /// The master's LAN CA, which paired desktops pin (FR-20.30).
    Ca {
        #[command(subcommand)]
        action: CaAction,
    },
    /// This master's licences (FR-20.55). A linked master renews them over the uplink by itself.
    Licence {
        #[command(subcommand)]
        action: LicenceAction,
    },
    /// Versioned installs (FR-20.20): install a bundle, or say what runs and what is kept.
    Update {
        #[command(subcommand)]
        action: UpdateAction,
    },
    /// What the update helper service runs (FR-20.20). Not for people.
    UpdateHelper,
}

#[derive(Subcommand)]
enum UpdateAction {
    /// Install a server bundle as a version and switch to it as the rules allow: never a
    /// downgrade, never a version that failed. The MSI and the .deb run this with their own bundle.
    InstallBundle {
        /// The bundle (`installer/lgr-server-bundle.*` when not given).
        bundle: Option<std::path::PathBuf>,
        /// The install's root (the one this lgr-server lives in when not given).
        #[arg(long)]
        root: Option<std::path::PathBuf>,
        /// Restart the service on it now, and start the helper to watch it.
        #[arg(long)]
        start: bool,
        /// Keep what `update undo` needs (the MSI, whose rollback runs it).
        #[arg(long)]
        undoable: bool,
    },
    /// Windows Installer rolls an install back: put the state and the pointers back. Not for people.
    #[command(hide = true)]
    Undo,
    /// Windows Installer's install is final. Not for people.
    #[command(hide = true)]
    Commit,
    /// The version that runs, the last known good one, what is kept and what failed.
    Status {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ServiceAction {
    Install {
        /// Register it and leave it stopped: the MSI starts it once the install is done.
        #[arg(long)]
        no_start: bool,
    },
    Uninstall {
        /// The package's removal: the update helper, the firewall rule and every installed version
        /// go too. The data stays.
        #[arg(long)]
        purge: bool,
    },
    /// What the OS starts. Not for people.
    Run,
}

#[derive(Subcommand)]
enum CaAction {
    /// Announce a rotation to a new CA. Paired desktops add it to their pin through the TLS they
    /// trust, and the server certificate moves to it a week later (`--in` seconds, to choose).
    Rotate {
        #[arg(long = "in")]
        in_secs: Option<i64>,
    },
}

#[derive(Subcommand)]
enum BackupAction {
    Now,
}

#[derive(Subcommand)]
enum LicenceAction {
    /// Keep a licence file a sys-admin issued for this server: an air-gapped master's.
    Import { file: std::path::PathBuf },
}

fn init_logging(to_file: Option<&std::path::Path>) {
    let filter = tracing_subscriber::EnvFilter::try_from_env("LGR_SERVER_LOG").unwrap_or_else(|_| "info".into());
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_target(false);
    match to_file.and_then(|p| {
        std::fs::create_dir_all(p.parent()?).ok()?;
        std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
    }) {
        // A service has no console: its log is a file.
        Some(file) => builder.with_ansi(false).with_writer(std::sync::Mutex::new(file)).init(),
        None => builder.with_writer(std::io::stderr).init(),
    }
}

/// The supervisor until `shutdown` resolves: the API from the package, the control channel, the
/// backoff policy. Returns the exit code ([`backoff::EXIT_CONFIG`] when it cannot even start).
pub fn run_supervisor_blocking(shutdown: impl Future<Output = ()>) -> i32 {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "no async runtime");
            return 1;
        }
    };
    runtime.block_on(async {
        let config_error = |e: anyhow::Error| {
            tracing::error!(error = %format!("{e:#}"), "cannot start: the configuration is wrong");
            backoff::EXIT_CONFIG
        };
        let paths = match config::Paths::resolve() {
            Ok(p) => p,
            Err(e) => return config_error(e),
        };
        tracing::info!(home = %paths.home.display(), package = %paths.package.display(), data = %paths.data.display(), "starting");
        // FR-20.13: a machine that cannot run a master is told why, before anything starts.
        let failed: Vec<_> = preflight::run(&paths.data).into_iter().filter(|c| !c.ok).collect();
        if !failed.is_empty() {
            for c in &failed {
                tracing::error!(check = c.name, "{}", c.detail);
            }
            return backoff::EXIT_CONFIG;
        }
        let operator = match config::operator_env(&paths) {
            Ok(o) => o,
            Err(e) => return config_error(e),
        };
        // FR-20.25: loud, never fatal. Without its browser a master still sells and books; it
        // prints no invoice or report as a PDF.
        match config::pdf_browser(&paths, &operator) {
            Some(b) if b.exists() => tracing::info!(browser = %b.display(), "PDFs print with this browser"),
            Some(b) => tracing::warn!(browser = %b.display(), "the PDF browser is not there: no invoice or report prints as a PDF"),
            None => tracing::warn!(
                "no PDF browser: no invoice or report prints as a PDF (the package carries one in chrome/; LGR_SERVER_CHROME names another)"
            ),
        }
        let plan = match mongod::plan(&paths, &operator) {
            Ok(p) => p,
            Err(e) => return config_error(e),
        };
        // FR-20.16: this boot's front secret, the API's loopback port, its control socket.
        let mut front = match front::prepare(&paths, &operator) {
            Ok(f) => f,
            Err(e) => return config_error(e),
        };
        // FR-20.53: the machine's trust, for the API's outbound calls. Without it the API keeps
        // Bun's own bundle: a TLS-inspecting middlebox then fails its calls, and nothing else does.
        let roots = paths.data.join("run").join("os-roots.pem");
        match egress::export_os_roots(&roots) {
            Ok(n) => {
                tracing::info!(roots = n, "exported the OS's trusted roots for the API");
                front.roots = Some(roots);
            }
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "the OS's trusted roots could not be exported"),
        }
        let egress_rules = match egress::Rules::from_operator(&operator) {
            Ok(r) => std::sync::Arc::new(r),
            Err(e) => return config_error(e),
        };
        // FR-20.2: the supervisor's own calls to global (registration now, the uplink with P2-2), on
        // the machine's proxy rules and its trust store, as the API's are.
        let registrar = match https::Https::with_os_roots(egress_rules.clone()) {
            Ok(client) => Some(std::sync::Arc::new(supervisor::Registrar { data: paths.data.clone(), client, wake: tokio::sync::Notify::new() })),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "this server cannot reach global: it can run, and cannot register");
                None
            }
        };
        tracing::info!(port = front.port, socket = %front.socket.display(), hosts = ?front.hosts, "the API listens behind the front");
        // FR-20.16 / FR-20.30: the LAN ingress, on the master's own certificate. Off until setup (or
        // the operator) turns it on: a master with no desktops needs no port open on the LAN.
        let lan = match lan_settings(&operator) {
            Err(e) => return config_error(e),
            Ok(None) => None,
            Ok(Some(port)) => {
                let names = certs::wanted_names(&front.hosts, &certs::lan_addresses());
                match certs::LanIdentity::ensure(&paths.data.join("keys"), &names) {
                    Ok(identity) => {
                        // FR-20.29: the API names this address in every pairing code, and pins this CA.
                        let addresses = certs::lan_addresses();
                        front.lan_url = certs::lan_url(&addresses, certs::default_route_v4(), front::hostname().as_deref(), port);
                        front.lan_fingerprint = Some(identity.fingerprint.clone());
                        // FR-20.30: kept current while the supervisor runs, for the API to read.
                        let state = paths.data.join("state").join("lan.json");
                        if let Err(e) = publish_lan(&state, front.lan_url.as_deref(), &identity.fingerprint) {
                            tracing::warn!(error = %format!("{e:#}"), "the LAN state file cannot be written: pairing codes keep the address and CA of this start");
                        }
                        front.lan_state = Some(state);
                        Some((port, identity))
                    }
                    Err(e) => return config_error(e.context("the LAN certificate")),
                }
            }
        };
        supervisor::run(ipc::default_endpoint(), backoff::Policy::default(), shutdown, move |sup| async move {
            if let Some(r) = registrar {
                sup.set_registrar(r.clone());
                // FR-20.52: the uplink, one task per channel, for as long as the supervisor runs. It
                // waits while the master is not registered, and never stops the shop when refused.
                match uplink::boot_nonce() {
                    Ok(nonce) => {
                        // FR-20.57: health from the supervisor's status, the API's and the data volume.
                        let health: uplink::HealthFn = {
                            let (sup, data) = (sup.clone(), r.data.clone());
                            std::sync::Arc::new(move || {
                                let (sup, data) = (sup.clone(), data.clone());
                                Box::pin(async move { uplink::health_frame(&sup.status_with_api().await, preflight::free_disk(&data)) })
                            })
                        };
                        for ch in uplink::CHANNELS {
                            let h = (ch == "interactive").then(|| health.clone());
                            sup.add_service(tokio::spawn(uplink::run(r.clone(), ch, nonce.clone(), sup.uplink_status(), uplink::Timing::default(), h)));
                        }
                        // FR-20.56: the tills' desktop release, kept here so they update offline.
                        sup.add_service(tokio::spawn(desktop_releases::run(r.clone(), sup.releases_status(), desktop_releases::EVERY)));
                        // FR-20.86: a fresh node token for the API's outbox, never the node key.
                        sup.add_service(tokio::spawn(node_token::run(r.clone(), node_token::EVERY)));
                    }
                    Err(e) => tracing::error!(error = %format!("{e:#}"), "no uplink this start"),
                }
            }
            // The egress first: the API is given its address, and a CONNECT may come at once.
            match tokio::net::TcpListener::bind(("127.0.0.1", front.egress_port)).await {
                Ok(listener) => sup.add_service(tokio::spawn(egress::serve(listener, front.egress_secret.clone(), egress_rules))),
                Err(e) => {
                    // Taken between choosing it and binding it: a fresh start picks fresh ports.
                    tracing::error!(port = front.egress_port, error = %e, "the egress proxy cannot listen: starting again");
                    return Err(1);
                }
            }
            // The database first, ready before the API connects (FR-20.15).
            let mongo_uri = match plan {
                None => None,
                Some(plan) => {
                    if !mongod::wait_for_free_port(plan.port, std::time::Duration::from_secs(30)).await {
                        tracing::error!(
                            port = plan.port,
                            "127.0.0.1:{} is in use by another program (another MongoDB?): set MONGOD_PORT in config/api.env",
                            plan.port
                        );
                        return Err(backoff::EXIT_CONFIG);
                    }
                    let spec = mongod::spec(&plan).map_err(config_error)?;
                    sup.add(spec);
                    sup.pending("api", "waiting for the database");
                    let mut attempt = 0u32;
                    Some(loop {
                        match mongod::bootstrap(&plan).await {
                            Ok(uri) => break uri,
                            Err(e) if e.downcast_ref::<mongod::Refused>().is_some() => {
                                tracing::error!("{e:#}");
                                return Err(backoff::EXIT_REFUSED);
                            }
                            Err(e) => {
                                attempt += 1;
                                tracing::warn!(attempt, error = %format!("{e:#}"), "the database is not ready; retrying");
                                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                            }
                        }
                    })
                }
            };
            let api = config::api_spec(&paths, mongo_uri.as_deref(), Some(&front)).map_err(config_error)?;
            sup.add(api);
            sup.set_api_control(front.socket.clone(), front.secret.clone());

            // The ingresses last (FR-20.11): the console only while setup is not complete.
            let upstream = std::sync::Arc::new(ingress::Upstream { port: front.port, secret: front.secret.clone() });
            let console = !front::setup_complete(&paths.data);
            sup.set_front_info(serde_json::json!({
                "apiPort": front.port,
                "controlSocket": front.socket,
                "hosts": front.hosts,
                "console": console.then_some(front.setup_port),
                "lan": lan.as_ref().map(|(port, id)| serde_json::json!({ "port": port, "caFingerprint": id.fingerprint, "names": id.names })),
                "egress": { "port": front.egress_port, "osRoots": front.roots.is_some() },
            }));
            if let Some((port, identity)) = lan {
                let tls = identity.server_config();
                let opened_with = identity.fingerprint.clone();
                let identity = std::sync::Arc::new(std::sync::Mutex::new(identity));
                sup.set_lan(identity.clone());
                match tls {
                    Err(e) => tracing::error!(error = %format!("{e:#}"), "the LAN ingress has no TLS configuration: it stays closed"),
                    Ok(tls) => match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                        // Loud, not fatal: the console and the API stay up for whoever fixes it.
                        Err(e) => tracing::error!(port, error = %e, "the LAN ingress cannot listen (is LAN_PORT in use?)"),
                        Ok(listener) => {
                            tracing::info!(port, fingerprint = %opened_with, "the LAN ingress is open");
                            let up = upstream.clone();
                            // The CA a pairing desktop fetches and checks (FR-20.29), and what a paired
                            // one follows a rotation by (FR-20.30): read from the identity each time.
                            let served = identity.clone();
                            sup.add_ingress(tokio::spawn(ingress::serve_tls(listener, tls, move |req, peer| {
                                let (up, lan) = (up.clone(), served.clone());
                                async move {
                                    if let Some(answer) = ingress::lan_ca_answer(&req, &lan) {
                                        return answer;
                                    }
                                    ingress::forward(req, ingress::Source::Lan, peer, &up, true).await
                                }
                            })));
                            // FR-20.28 — found on the LAN by DNS-SD, and found again after a DHCP
                            // change: the advert follows the address the pairing code names.
                            match front::node_id(&paths.data) {
                                Err(e) => tracing::error!(error = %format!("{e:#}"), "no DNS-SD advert: the node id cannot be read"),
                                Ok(node) => {
                                    let machine = front::hostname().unwrap_or_else(|| "lgr-server".into());
                                    sup.add_ingress(tokio::spawn(advertise(machine, node, identity.clone(), port)));
                                }
                            }
                            // A new address (DHCP) means a new certificate, served from the next handshake.
                            // A rotation that is due takes effect here too (FR-20.30). Both change what a
                            // pairing code names or pins, so the state file follows.
                            let (hosts, state) = (front.hosts.clone(), front.lan_state.clone());
                            let lan = identity.clone();
                            sup.add_ingress(tokio::spawn(async move {
                                let machine = front::hostname();
                                loop {
                                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                                    let names = certs::wanted_names(&hosts, &certs::lan_addresses());
                                    let mut id = lan.lock().unwrap_or_else(|p| p.into_inner());
                                    match id.refresh(&names) {
                                        Ok(true) => tracing::info!(?names, "the LAN certificate was re-issued for new names"),
                                        Ok(false) => {}
                                        Err(e) => tracing::error!(error = %format!("{e:#}"), "re-issuing the LAN certificate failed: the old one is still served"),
                                    }
                                    match id.switch_if_due(time::OffsetDateTime::now_utc()) {
                                        Ok(true) => tracing::info!(fingerprint = %id.fingerprint, "the LAN CA rotation took effect: desktops that took the announcement keep their connections"),
                                        Ok(false) => {}
                                        Err(e) => tracing::error!(error = %format!("{e:#}"), "the LAN CA rotation could not take effect: the current CA is still served"),
                                    }
                                    let url = certs::lan_url(&certs::lan_addresses(), certs::default_route_v4(), machine.as_deref(), port);
                                    if let Some(state) = &state {
                                        if let Err(e) = publish_lan(state, url.as_deref(), &id.fingerprint) {
                                            tracing::warn!(error = %format!("{e:#}"), "the LAN state file cannot be written");
                                        }
                                    }
                                }
                            }));
                        }
                    },
                }
            }
            if !console {
                tracing::info!("setup is complete: no console");
            } else {
                let token = front::setup_token(&paths.data).map_err(config_error)?;
                let marker = paths.data.join("state").join("setup-complete");
                let console = std::sync::Arc::new(ingress::Console::new(front.setup_port, token, upstream.clone(), marker));
                sup.add_ingress(tokio::spawn(console.run()));
            }
            Ok(())
        })
        .await
    })
}

/// Keep this master's DNS-SD advert on the LAN (FR-20.28): registered for the address the pairing
/// code names (`certs::lan_ip`), and moved when DHCP moves it. A failed registration is tried again
/// a minute later, and is never fatal: an address can always be typed in. Withdrawn when the task
/// ends, with the ingresses (FR-20.23).
async fn advertise(machine: String, node: String, lan: std::sync::Arc<std::sync::Mutex<certs::LanIdentity>>, port: u16) {
    let mut current: Option<(std::net::Ipv4Addr, String, advert::Registration)> = None;
    loop {
        let ip = certs::lan_ip(&certs::lan_addresses(), certs::default_route_v4());
        // FR-20.30: after a rotation the advert names the new CA, which is the one desktops re-find by.
        let fingerprint = lan.lock().unwrap_or_else(|p| p.into_inner()).fingerprint.clone();
        if current.as_ref().map(|(at, fp, _)| (*at, fp.as_str())) != ip.map(|ip| (ip, fingerprint.as_str())) {
            if let Some((_, _, old)) = current.take() {
                // Blocking: the OS confirms a withdrawal.
                let _ = tokio::task::spawn_blocking(move || drop(old)).await;
            }
            if let Some(ip) = ip {
                let a = advert::Advert {
                    instance: advert::instance_label(&machine),
                    // ⚠ The machine's own name: Windows answers address queries for no other, so an
                    // advert pointing at a name of its own never resolves (measured: the resolve
                    // waited until cancelled). And it answers the machine's name with whichever
                    // interface the query came in on, so a master with a VPN or an overlay is found at
                    // an address no till can reach (measured: 100.65.0.5, its WireGuard address, not
                    // the LAN's 192.168.8.115). Hence `ip` in the TXT record, which desktops prefer.
                    host: machine.to_ascii_lowercase(),
                    ip,
                    port,
                    node: node.clone(),
                    fingerprint: fingerprint.clone(),
                };
                match tokio::task::spawn_blocking(move || advert::register(&a)).await {
                    Ok(Ok(registration)) => {
                        tracing::info!(%ip, port, "advertised on the LAN as {}", advert::SERVICE);
                        current = Some((ip, fingerprint.clone(), registration));
                    }
                    Ok(Err(e)) => tracing::warn!(error = %format!("{e:#}"), "the DNS-SD advert failed; desktops can still type the address"),
                    Err(e) => tracing::warn!(error = %e, "the DNS-SD advert could not run"),
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}

/// Publish what a pairing code names and pins (`state/lan.json`), for the API to read
/// (`LGR_LAN_STATE_FILE`). Written only when it changes, beside the file and renamed over it.
fn publish_lan(file: &std::path::Path, url: Option<&str>, fingerprint: &str) -> Result<()> {
    let text = serde_json::json!({ "url": url, "caFingerprint": fingerprint }).to_string();
    if std::fs::read_to_string(file).ok().as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, &text)?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

/// `LAN_INGRESS=on` (and `LAN_PORT`, 4443): the port the LAN ingress opens, or `None` while it is off.
fn lan_settings(operator: &std::collections::BTreeMap<String, String>) -> Result<Option<u16>> {
    let on = match operator.get("LAN_INGRESS").map(|v| v.trim().to_ascii_lowercase()) {
        None => false,
        Some(v) if ["on", "true", "1", "yes"].contains(&v.as_str()) => true,
        Some(v) if ["off", "false", "0", "no", ""].contains(&v.as_str()) => false,
        Some(v) => anyhow::bail!("LAN_INGRESS={v} is neither on nor off"),
    };
    if !on {
        return Ok(None);
    }
    Ok(Some(match operator.get("LAN_PORT") {
        Some(p) => p.parse().with_context(|| format!("LAN_PORT={p} is not a port"))?,
        None => 4443,
    }))
}

fn ask(request: ipc::Request) -> Result<ipc::Response> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    runtime
        .block_on(ipc::request(&ipc::default_endpoint(), &request))
        .context("the supervisor is not running, or this account may not talk to it")
}

fn not_yet(step: &str) -> Result<i32> {
    eprintln!("Not yet: this comes with plan step {step}.");
    Ok(2)
}

/// The package's own copy (`installer/`) runs what a package runs; anything else is handed to the
/// version the service runs, so `installer\lgr-server.exe status` on Windows is the current one's.
fn hand_to_current(cli: &Cli) -> Option<i32> {
    let exe = std::env::current_exe().ok()?;
    if exe.parent()?.file_name()? != install::INSTALLER_DIR {
        return None;
    }
    if matches!(cli.command, Command::Update { .. } | Command::UpdateHelper | Command::Service { action: ServiceAction::Uninstall { .. } }) {
        return None;
    }
    let root = install::Root::of_exe(&exe)?;
    let current = install::UpdateState::load(&root).ok().map(|s| s.current).filter(|c| !c.is_empty())?;
    let target = root.exe_of(&current);
    let status = std::process::Command::new(&target).args(std::env::args_os().skip(1)).status().ok()?;
    Some(status.code().unwrap_or(1))
}

fn main() {
    let cli = Cli::parse();
    if let Some(code) = hand_to_current(&cli) {
        std::process::exit(code);
    }
    let code = match real_main(cli) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("lgr-server: {e:#}");
            1
        }
    };
    std::process::exit(code);
}

fn real_main(cli: Cli) -> Result<i32> {
    match cli.command {
        Command::Run => {
            init_logging(None);
            Ok(run_supervisor_blocking(async {
                let _ = tokio::signal::ctrl_c().await;
            }))
        }
        Command::Service { action } => {
            let paths = config::Paths::resolve()?;
            match action {
                ServiceAction::Install { no_start } => {
                    init_logging(None);
                    service::platform::install(&paths.data, !no_start)?;
                    println!("Installed{} {}.", if no_start { "" } else { " and started" }, service::DISPLAY_NAME);
                    Ok(0)
                }
                ServiceAction::Uninstall { purge } => {
                    init_logging(None);
                    service::platform::uninstall()?;
                    if purge {
                        if let Some(root) = install::Root::here() {
                            pointer::remove_helper()?;
                            pointer::remove_firewall();
                            for dir in [root.versions(), root.update()] {
                                install::remove_tree(&dir)?;
                            }
                            for link in ["current", "lkg"] {
                                let _ = std::fs::remove_file(root.0.join(link));
                            }
                        }
                    }
                    println!("Removed {}. Its data stays in {}.", service::DISPLAY_NAME, paths.data.display());
                    Ok(0)
                }
                ServiceAction::Run => {
                    init_logging(Some(&paths.data.join("logs").join("lgr-server.log")));
                    service::platform::run()?;
                    Ok(0)
                }
            }
        }
        Command::Status { json } => {
            let answer = ask(ipc::Request::Status)?;
            let status = answer.status.unwrap_or_default();
            if json {
                println!("{}", serde_json::to_string_pretty(&status)?);
            } else {
                println!("lgr-server {} (pid {}), up {} s", status["version"].as_str().unwrap_or("?"), status["pid"], status["uptimeSecs"]);
                match status["registration"]["server"].as_str() {
                    Some(server) => println!(
                        "  registered with {server} for {}",
                        status["registration"]["orgs"].as_array().into_iter().flatten().filter_map(|o| o["slug"].as_str()).collect::<Vec<_>>().join(", ")
                    ),
                    None => println!("  not registered with lgrai.app"),
                }
                if let Some(up) = status["uplink"].as_object() {
                    for (ch, s) in up {
                        println!(
                            "  uplink {:<12} {}{}{}",
                            ch,
                            s["state"].as_str().unwrap_or("?"),
                            if s["suspended"].as_bool() == Some(true) { "  CLONE ALARM" } else { "" },
                            s["error"].as_str().map(|e| format!("  ({e})")).unwrap_or_default()
                        );
                    }
                }
                for l in status["licences"].as_array().into_iter().flatten() {
                    match l["error"].as_str() {
                        Some(e) => println!("  licence  {}  NOT USED: {e}", l["orgId"].as_str().unwrap_or("?")),
                        None => println!("  licence  {:<24} {} paid through {} (+{} days of grace)", l["org"].as_str().unwrap_or("?"), l["plan"].as_str().unwrap_or("?"), l["paidThrough"].as_str().unwrap_or("?"), l["graceDays"]),
                    }
                }
                for c in status["children"].as_array().into_iter().flatten() {
                    println!(
                        "  {:<8} {:<9} pid {:<7} starts {:<3} failures {:<3} {}",
                        c["name"].as_str().unwrap_or("?"),
                        c["state"].as_str().unwrap_or("?"),
                        c["pid"],
                        c["starts"],
                        c["failures"],
                        c["reason"].as_str().unwrap_or("")
                    );
                }
            }
            Ok(0)
        }
        Command::Restart { child } => {
            let answer = ask(ipc::Request::Restart { child })?;
            if !answer.ok {
                anyhow::bail!(answer.error.unwrap_or_default());
            }
            Ok(0)
        }
        Command::Stop => {
            let answer = ask(ipc::Request::Stop)?;
            Ok(if answer.ok { 0 } else { 1 })
        }
        Command::Register { code, server, link, name } => {
            let name = name.or_else(front::hostname).unwrap_or_else(|| "LGR Server".to_string());
            let answer = ask(ipc::Request::Register { server, code, link_level: link, name })?;
            if !answer.ok {
                anyhow::bail!(answer.error.unwrap_or_default());
            }
            let r = answer.status.unwrap_or_default();
            println!("Registered with {} as {} (link level {}).", r["server"].as_str().unwrap_or("?"), r["nodeId"].as_str().unwrap_or("?"), r["linkLevel"].as_str().unwrap_or("?"));
            for o in r["orgs"].as_array().into_iter().flatten() {
                println!("  {:<24} {}", o["slug"].as_str().unwrap_or("?"), o["name"].as_str().unwrap_or(""));
            }
            Ok(0)
        }
        Command::Licence { action: LicenceAction::Import { file } } => {
            let meta = std::fs::metadata(&file).with_context(|| format!("reading {}", file.display()))?;
            if meta.len() > 8192 {
                anyhow::bail!("{} is not a licence file: it is {} bytes", file.display(), meta.len());
            }
            let jws = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
            let answer = ask(ipc::Request::LicenceImport { jws })?;
            if !answer.ok {
                anyhow::bail!(answer.error.unwrap_or_default());
            }
            let k = answer.status.unwrap_or_default();
            let l = &k["licence"];
            println!(
                "{} for {} ({}), paid through {}, with {} days of grace.",
                if k["changed"].as_bool() == Some(false) { "This licence was already held" } else { "Licence kept" },
                l["org"].as_str().unwrap_or("?"),
                l["plan"].as_str().unwrap_or("?"),
                l["paidThrough"].as_str().unwrap_or("?"),
                l["graceDays"]
            );
            Ok(0)
        }
        Command::Ca { action: CaAction::Rotate { in_secs } } => {
            let answer = ask(ipc::Request::CaRotate { lead_secs: in_secs })?;
            if !answer.ok {
                anyhow::bail!(answer.error.unwrap_or_default());
            }
            let r = answer.status.unwrap_or_default();
            let at = r["switchAt"].as_i64().and_then(|s| time::OffsetDateTime::from_unix_timestamp(s).ok());
            println!("The LAN CA rotation is announced. Paired desktops take the next CA from now on.");
            println!("  next CA     {}", r["fingerprint"].as_str().unwrap_or("?"));
            println!("  takes effect {} (UTC)", at.map(|t| t.to_string()).unwrap_or_else(|| "?".into()));
            println!("A desktop that is not switched on before then has to be paired again.");
            Ok(0)
        }
        Command::Diagnostics => {
            let paths = config::Paths::resolve()?;
            let status = ask(ipc::Request::Status).ok().and_then(|a| a.status);
            let report = serde_json::json!({
                "lgrServer": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "paths": {
                    "home": paths.home, "package": paths.package, "data": paths.data, "bun": paths.bun,
                    "pdfBrowser": config::operator_env(&paths).ok().and_then(|o| config::pdf_browser(&paths, &o)),
                },
                "manifest": std::fs::read_to_string(paths.package.join("server-manifest.json")).ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .map(|m| serde_json::json!({ "commit": m["commit"], "commitDate": m["commitDate"], "dirty": m["dirty"], "bun": m["bun"] })),
                "preflight": preflight::run(&paths.data),
                "running": status.is_some(),
                "status": status,
            });
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(0)
        }
        Command::Preflight { json } => {
            let paths = config::Paths::resolve()?;
            let checks = preflight::run(&paths.data);
            if json {
                println!("{}", serde_json::to_string_pretty(&checks)?);
            } else {
                for c in &checks {
                    println!("{} {:<11} {}", if c.ok { "ok  " } else { "FAIL" }, c.name, c.detail);
                }
            }
            Ok(if checks.iter().all(|c| c.ok) { 0 } else { backoff::EXIT_CONFIG })
        }
        Command::RunScript { name, args } => run_script(&name, &args),
        Command::Backup { action: BackupAction::Now } => not_yet("P1-9"),
        Command::SetupToken => {
            let paths = config::Paths::resolve()?;
            if front::setup_complete(&paths.data) {
                println!("Setup is complete: the server has no setup console any more.");
                return Ok(0);
            }
            let operator = config::operator_env(&paths)?;
            let port = match operator.get("SETUP_PORT") {
                Some(p) => p.parse().with_context(|| format!("SETUP_PORT={p} is not a port"))?,
                None => front::DEFAULT_SETUP_PORT,
            };
            // Made here if the server has not started yet: the installer prints it before it does.
            let token = front::setup_token(&paths.data)?;
            println!("Open this on the server itself, in a browser:

  {}
", front::setup_url(port, &token));
            println!("It works on this machine only, and only until setup is complete.");
            Ok(0)
        }
        Command::Update { action: UpdateAction::InstallBundle { bundle, root, start, undoable } } => {
            init_logging(None);
            helper::install_bundle(root, bundle, start, undoable)
        }
        Command::Update { action: UpdateAction::Undo } => helper::undo(),
        Command::Update { action: UpdateAction::Commit } => helper::commit(),
        Command::Update { action: UpdateAction::Status { json } } => helper::status(json),
        Command::UpdateHelper => helper::entry(),
    }
}

/// `run-script <name>`: only a script the package's manifest lists (FR-20.26), with the API's own
/// environment, so it reaches the same database as the API with the same role.
fn run_script(name: &str, args: &[String]) -> Result<i32> {
    let paths = config::Paths::resolve()?;
    let manifest_path = paths.package.join("server-manifest.json");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest_path).with_context(|| format!("reading {}", manifest_path.display()))?,
    )?;
    let listed = manifest["scripts"].as_array().into_iter().flatten().any(|s| s.as_str() == Some(name));
    if !listed || name.contains(['/', '\\', '.']) {
        eprintln!("{name} is not a script this package carries. It carries: {}", manifest["scripts"]);
        return Ok(2);
    }
    let operator = config::operator_env(&paths)?;
    let uri = mongod::plan(&paths, &operator)?.and_then(|plan| mongod::known_app_uri(&plan));
    let api = config::api_spec(&paths, uri.as_deref(), None)?;
    let script = paths.package.join("app").join("scripts").join(format!("{name}.js"));
    let status = std::process::Command::new(&api.program)
        .arg(&script)
        .args(args)
        .current_dir(&api.cwd)
        .env_clear()
        .envs(&api.env)
        .status()
        .with_context(|| format!("running {}", script.display()))?;
    Ok(status.code().unwrap_or(1))
}
