//! `lgr-server`: the supervisor an on-premises master runs (FR-20, plan step P1-1).
//!
//! It runs the master's processes (the API today; `mongod` from P1-2), keeps them up with backoff,
//! answers a local control channel, and registers itself with the OS. Everything a shop's server
//! does goes through it: the API never runs on its own on a master.

mod backoff;
mod child;
mod config;
mod ipc;
mod mongod;
mod preflight;
mod service;
mod supervisor;

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
    /// Print the one-time token that opens the setup console (plan step P1-3).
    SetupToken,
    /// Apply a staged update (plan step P1-8).
    UpdateHelper,
}

#[derive(Subcommand)]
enum ServiceAction {
    Install,
    Uninstall,
    /// What the OS starts. Not for people.
    Run,
}

#[derive(Subcommand)]
enum BackupAction {
    Now,
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
        let plan = match config::operator_env(&paths).and_then(|op| mongod::plan(&paths, &op)) {
            Ok(p) => p,
            Err(e) => return config_error(e),
        };
        supervisor::run(ipc::default_endpoint(), backoff::Policy::default(), shutdown, move |sup| async move {
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
            let api = config::api_spec(&paths, mongo_uri.as_deref()).map_err(config_error)?;
            sup.add(api);
            Ok(())
        })
        .await
    })
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

fn main() {
    let cli = Cli::parse();
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
                ServiceAction::Install => {
                    init_logging(None);
                    service::platform::install(&paths.data)?;
                    println!("Installed and started {}.", service::DISPLAY_NAME);
                    Ok(0)
                }
                ServiceAction::Uninstall => {
                    init_logging(None);
                    service::platform::uninstall()?;
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
        Command::Diagnostics => {
            let paths = config::Paths::resolve()?;
            let status = ask(ipc::Request::Status).ok().and_then(|a| a.status);
            let report = serde_json::json!({
                "lgrServer": env!("CARGO_PKG_VERSION"),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "paths": { "home": paths.home, "package": paths.package, "data": paths.data, "bun": paths.bun },
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
        Command::SetupToken => not_yet("P1-3"),
        Command::UpdateHelper => not_yet("P1-8"),
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
    let api = config::api_spec(&paths, uri.as_deref())?;
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
