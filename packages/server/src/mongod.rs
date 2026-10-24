//! `mongod` under the supervisor (FR-20.15, plan step P1-2): private to the server, a single-node
//! replica set, sized for a shop PC, and set up on its first boot without anyone typing a password.
//!
//! - **Private:** bound to 127.0.0.1 only, with authentication on: a keyfile for the replica set
//!   (`keys/mongo.keyfile`) and generated users (`keys/mongo.env`). Never on the LAN.
//! - **A single-node replica set, `rs0`:** transactions and change streams need one.
//! - **Sized for a shop PC:** the WiredTiger cache is capped (0.5 GB below 8 GB of RAM, the
//!   2026-10-08 OOM lesson), and the oplog starts at 2 GB.
//!
//! The first boot ([`bootstrap`]) is idempotent and crash-safe, because a till can lose power at
//! any instant:
//! 1. the passwords are written to `keys/mongo.env` BEFORE the users exist (never overwritten);
//! 2. connected without credentials, which `mongod` allows from localhost until the first user
//!    exists: `replSetInitiate` if needed, then the administrator user;
//! 3. as the administrator: the API's own user, if it is missing.
//!
//! A crash at any step is finished on the next boot. One state cannot be: users exist and
//! `keys/mongo.env` does not open them (it was lost or replaced). That is a refusal (exit 8), not a
//! reset: the data is still there, and only the keys restore it.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use mongodb::bson::{doc, Document};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::child::ChildSpec;
use crate::config::{parse_env, Paths};

pub const REPLICA_SET: &str = "rs0";
/// Not 27017: a master may share the machine with another MongoDB, and must not answer for it.
pub const DEFAULT_PORT: u16 = 27118;
pub const DEFAULT_OPLOG_MB: u64 = 2048;
const ADMIN_USER: &str = "lgr-admin";
const APP_USER: &str = "lgr";
const APP_DB: &str = "lgr";

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub binary: PathBuf,
    pub port: u16,
    pub dbpath: PathBuf,
    pub keyfile: PathBuf,
    pub secrets: PathBuf,
    pub log: PathBuf,
    pub cache_gb: f64,
    pub oplog_mb: u64,
}

/// The WiredTiger cache for a machine with `ram` bytes: a shop PC also runs the API, Chrome for
/// every PDF, and often the till. mongod's own default (half of RAM, less 1 GB) is for a database
/// server that owns the machine.
pub fn cache_gb_for(ram: Option<u64>) -> f64 {
    const GB: u64 = 1 << 30;
    match ram {
        Some(r) if r >= 16 * GB => 2.0,
        Some(r) if r >= 8 * GB => 1.0,
        _ => 0.5,
    }
}

/// Where `mongod` is: `LGR_SERVER_MONGOD`, else `<home>/bin/mongod[.exe]`.
fn binary(paths: &Paths) -> PathBuf {
    std::env::var_os("LGR_SERVER_MONGOD")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.home.join("bin").join(if cfg!(windows) { "mongod.exe" } else { "mongod" }))
}

/// The supervisor's `mongod`, or `None` when the operator points the API at a database of their own
/// (`MONGODB_URI` in `config/api.env`).
pub fn plan(paths: &Paths, operator: &BTreeMap<String, String>) -> Result<Option<Plan>> {
    if operator.contains_key("MONGODB_URI") {
        return Ok(None);
    }
    let binary = binary(paths);
    if !binary.exists() {
        bail!("no mongod at {} (the package carries one in bin/; LGR_SERVER_MONGOD points elsewhere)", binary.display());
    }
    let port = match operator.get("MONGOD_PORT") {
        Some(p) => p.parse().with_context(|| format!("MONGOD_PORT={p} is not a port"))?,
        None => DEFAULT_PORT,
    };
    let cache_gb = match operator.get("MONGOD_CACHE_GB") {
        Some(c) => c.parse().with_context(|| format!("MONGOD_CACHE_GB={c} is not a number"))?,
        None => cache_gb_for(crate::preflight::total_ram()),
    };
    Ok(Some(Plan {
        binary,
        port,
        dbpath: paths.data.join("db"),
        keyfile: paths.data.join("keys").join("mongo.keyfile"),
        secrets: paths.data.join("keys").join("mongo.env"),
        log: paths.data.join("logs").join("mongod.log"),
        cache_gb,
        oplog_mb: DEFAULT_OPLOG_MB,
    }))
}

fn random(bytes: usize) -> String {
    use rand::RngCore;
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::STANDARD.encode(b)
}

/// A password that needs no escaping in a connection string.
fn password() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Write `text` to `path` for its owner only, through a temporary file and a rename, so a power cut
/// leaves the old file or the new one and never half of either.
fn write_secret(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::OpenOptions::new();
        f.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut f, 0o600);
        let mut f = f.open(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        std::io::Write::write_all(&mut f, text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Wait up to `within` for nothing to listen on 127.0.0.1:`port`.
///
/// ⚠ Checked before mongod starts, because whatever already answers there is not ours, and the
/// bootstrap must never initiate, or add users to, someone else's database. A mongod of ours that
/// is still exiting (the supervisor restarted) is given the time to let go of it.
pub async fn wait_for_free_port(port: u16, within: Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return true;
        }
        if start.elapsed() >= within {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// The replica set's shared key: base64 (mongod's alphabet), at most 1024 characters, readable by
/// its owner alone on Unix (mongod refuses a group- or world-readable one).
pub fn ensure_keyfile(path: &Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    write_secret(path, &random(756))?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o400))?;
    Ok(())
}

pub fn spec(plan: &Plan) -> Result<ChildSpec> {
    std::fs::create_dir_all(&plan.dbpath).with_context(|| format!("creating {}", plan.dbpath.display()))?;
    // ⚠ mongod exits 1 at once when its log's directory is missing, and says so only on its console.
    if let Some(dir) = plan.log.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    ensure_keyfile(&plan.keyfile)?;
    let s = |p: &Path| p.to_string_lossy().into_owned();
    let mut env = BTreeMap::new();
    for k in ["PATH", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "TMPDIR"] {
        if let Ok(v) = std::env::var(k) {
            env.insert(k.to_string(), v);
        }
    }
    Ok(ChildSpec {
        name: "mongod".to_string(),
        program: plan.binary.clone(),
        args: vec![
            "--dbpath".into(), s(&plan.dbpath),
            "--port".into(), plan.port.to_string(),
            "--bind_ip".into(), "127.0.0.1".into(),
            "--replSet".into(), REPLICA_SET.into(),
            "--keyFile".into(), s(&plan.keyfile),
            "--wiredTigerCacheSizeGB".into(), plan.cache_gb.to_string(),
            "--oplogSize".into(), plan.oplog_mb.to_string(),
            "--logpath".into(), s(&plan.log),
            "--logappend".into(),
        ],
        cwd: plan.dbpath.clone(),
        env,
        // mongod writes its own log (--logpath). What it says before that log is open (a bad
        // option, a dbpath it cannot lock) goes to its console: kept here, or it is lost.
        log: plan.log.parent().map(|d| d.join("mongod.console.log")),
        // A clean stop on every OS, console or not (FR-20.23). The password exists before the user
        // does (bootstrap step 1); until the user does, the command fails and a signal stops it.
        stop: crate::child::Stop::Mongo { port: plan.port, user: ADMIN_USER.to_string(), password: secrets(plan)?.admin },
    })
}

/// The two generated passwords, made once and kept in `keys/mongo.env`.
struct Secrets {
    admin: String,
    app: String,
}

fn secrets(plan: &Plan) -> Result<Secrets> {
    if plan.secrets.exists() {
        let env = parse_env(&std::fs::read_to_string(&plan.secrets)?);
        let get = |k: &str| env.get(k).cloned().ok_or_else(|| anyhow!("{} has no {k}", plan.secrets.display()));
        return Ok(Secrets { admin: get("MONGO_ADMIN_PASSWORD")?, app: get("MONGO_APP_PASSWORD")? });
    }
    let s = Secrets { admin: password(), app: password() };
    // Written BEFORE either user exists: a crash after createUser must not leave users nobody knows.
    write_secret(&plan.secrets, &format!("MONGO_ADMIN_PASSWORD={}\nMONGO_APP_PASSWORD={}\n", s.admin, s.app))?;
    Ok(s)
}

/// What the API connects with.
pub fn app_uri(plan: &Plan, app_password: &str) -> String {
    format!("mongodb://{APP_USER}:{app_password}@127.0.0.1:{}/{APP_DB}?replicaSet={REPLICA_SET}&authSource=admin", plan.port)
}

/// Ask mongod to shut itself down cleanly, as its administrator. `force`: a single-node set has no
/// secondary to wait for, and without it a primary may refuse to stop. Answers once the command
/// was sent; mongod closing the connection under it is how it says yes.
pub async fn request_shutdown(port: u16, user: &str, password: &str) -> Result<()> {
    let uri = format!("mongodb://{user}:{password}@127.0.0.1:{port}/?directConnection=true&authSource=admin&serverSelectionTimeoutMS=2000");
    let c = mongodb::Client::with_uri_str(uri).await?;
    match c.database("admin").run_command(doc! { "shutdown": 1, "force": true }).await {
        Ok(_) => Ok(()),
        Err(e) if is_going_down(&e) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Whether a failed `shutdown` is the shutdown happening: the connection dropped under the command,
/// or the server answered that it is already going down (InterruptedAtShutdown, ShutdownInProgress).
/// Told by the error's kind, never by its words: anything else (refused credentials, nothing
/// listening) means the command did not stop it, and the signal must follow at once.
fn is_going_down(e: &mongodb::error::Error) -> bool {
    use mongodb::error::ErrorKind;
    match e.kind.as_ref() {
        ErrorKind::Io(_) | ErrorKind::ConnectionPoolCleared { .. } => true,
        ErrorKind::Command(c) => matches!(c.code, 11600 | 91),
        _ => false,
    }
}

/// The API's URI as `keys/mongo.env` gives it, without touching the database: what `run-script`
/// hands a script, so it reaches the database the API does.
pub fn known_app_uri(plan: &Plan) -> Option<String> {
    let env = parse_env(&std::fs::read_to_string(&plan.secrets).ok()?);
    env.get("MONGO_APP_PASSWORD").map(|pw| app_uri(plan, pw))
}

async fn client(plan: &Plan, credentials: Option<(&str, &str)>) -> Result<mongodb::Client> {
    let uri = match credentials {
        Some((user, pw)) => format!("mongodb://{user}:{pw}@127.0.0.1:{}/?directConnection=true&authSource=admin&serverSelectionTimeoutMS=3000", plan.port),
        None => format!("mongodb://127.0.0.1:{}/?directConnection=true&serverSelectionTimeoutMS=3000", plan.port),
    };
    Ok(mongodb::Client::with_uri_str(uri).await?)
}

async fn hello(c: &mongodb::Client) -> Result<Document> {
    Ok(c.database("admin").run_command(doc! { "hello": 1 }).await?)
}

fn is_auth_error(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        let s = c.to_string();
        s.contains("Authentication failed") || s.contains("AuthenticationFailed") || s.contains("auth error") || s.contains("SCRAM")
    })
}

/// Until it answers at all: the child may still be starting.
async fn wait_until_up(plan: &Plan, deadline: Duration) -> Result<()> {
    let start = std::time::Instant::now();
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", plan.port)).await.is_ok() {
            return Ok(());
        }
        if start.elapsed() > deadline {
            bail!("mongod did not listen on 127.0.0.1:{} within {deadline:?}", plan.port);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_for_primary(c: &mongodb::Client) -> Result<()> {
    for _ in 0..150 {
        if hello(c).await?.get_bool("isWritablePrimary").unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    bail!("the replica set did not elect a primary within 30 s")
}

async fn ensure_app_user(admin: &mongodb::Client, s: &Secrets) -> Result<()> {
    let db = admin.database("admin");
    let found = db.run_command(doc! { "usersInfo": APP_USER }).await?;
    let exists = found.get_array("users").map(|u| !u.is_empty()).unwrap_or(false);
    if !exists {
        db.run_command(doc! {
            "createUser": APP_USER,
            "pwd": &s.app,
            // dbAdmin: the API creates its collections and indexes, and enables pre-images on them.
            "roles": [ { "role": "readWrite", "db": APP_DB }, { "role": "dbAdmin", "db": APP_DB } ],
        })
        .await
        .context("creating the API's user")?;
        tracing::info!("created the API's database user");
    }
    Ok(())
}

/// Make the database ready for the API, whatever state the last boot left it in. Returns the URI
/// the API connects with.
pub async fn bootstrap(plan: &Plan) -> Result<String> {
    wait_until_up(plan, Duration::from_secs(60)).await?;
    let s = secrets(plan)?;

    // The usual case: everything exists, and the administrator's password opens it.
    let as_admin = async {
        let c = client(plan, Some((ADMIN_USER, &s.admin))).await?;
        hello(&c).await?;
        c.database("admin").run_command(doc! { "connectionStatus": 1 }).await?;
        Ok::<_, anyhow::Error>(c)
    }
    .await;
    // Whether the administrator's password was REFUSED, as opposed to the login failing for some
    // other reason (mongod still starting, a dropped connection). Only a refusal may end in "the
    // keys do not open this database": exit 8 stops the service for good (systemd's
    // RestartPreventExitStatus), so a transient error read as one would take the shop down.
    let password_refused = match as_admin {
        Ok(c) => {
            wait_for_primary(&c).await?;
            ensure_app_user(&c, &s).await?;
            return Ok(app_uri(plan, &s.app));
        }
        Err(e) => {
            let refused = is_auth_error(&e);
            tracing::debug!(error = %format!("{e:#}"), refused, "the administrator login did not work");
            refused
        }
    };
    // Users exist (the open path below was refused), so the localhost exception is closed.
    let users_exist = |what: &str, e: anyhow::Error| -> anyhow::Error {
        if password_refused {
            anyhow::Error::new(Refused(format!(
                "the database at {} has users that {} does not open: it was lost or replaced. Restore it; nothing was reset",
                plan.dbpath.display(),
                plan.secrets.display()
            )))
        } else {
            e.context(format!("{what}: the database has users, and the administrator login failed for another reason; retrying"))
        }
    };
    let needs_a_user = |e: &anyhow::Error| {
        let s = e.to_string();
        s.contains("requires authentication") || s.contains("Unauthorized") || s.contains("already exists")
    };

    // First boot (or one a crash interrupted): no users yet, so localhost may set things up.
    let open = client(plan, None).await?;
    let h = hello(&open).await?;
    if h.get_str("setName").is_err() {
        let init = open
            .database("admin")
            .run_command(doc! { "replSetInitiate": { "_id": REPLICA_SET, "members": [ { "_id": 0, "host": format!("127.0.0.1:{}", plan.port) } ] } })
            .await;
        if let Err(e) = init {
            let e = anyhow::Error::from(e);
            if needs_a_user(&e) {
                return Err(users_exist("initiating the replica set", e));
            }
            return Err(e.context("initiating the replica set"));
        }
        tracing::info!("initiated the replica set {REPLICA_SET}");
    }
    wait_for_primary(&open).await?;
    match open
        .database("admin")
        .run_command(doc! { "createUser": ADMIN_USER, "pwd": &s.admin, "roles": [ { "role": "root", "db": "admin" } ] })
        .await
    {
        Ok(_) => tracing::info!("created the database administrator"),
        Err(e) => {
            let e = anyhow::Error::from(e);
            if needs_a_user(&e) {
                return Err(users_exist("creating the database administrator", e));
            }
            return Err(e.context("creating the database administrator"));
        }
    }
    let admin = client(plan, Some((ADMIN_USER, &s.admin))).await?;
    ensure_app_user(&admin, &s).await?;
    Ok(app_uri(plan, &s.app))
}

/// A bootstrap that must not be retried: an operator has to act. The supervisor exits 8.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_port_someone_else_holds_is_never_taken_for_ours() {
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        assert!(!wait_for_free_port(port, Duration::from_millis(600)).await);
        drop(held);
        assert!(wait_for_free_port(port, Duration::from_secs(2)).await);
    }

    #[test]
    fn the_cache_is_sized_for_a_shop_pc() {
        const GB: u64 = 1 << 30;
        assert_eq!(cache_gb_for(Some(4 * GB)), 0.5);
        assert_eq!(cache_gb_for(Some(8 * GB - 1)), 0.5);
        assert_eq!(cache_gb_for(Some(8 * GB)), 1.0);
        assert_eq!(cache_gb_for(Some(32 * GB)), 2.0);
        assert_eq!(cache_gb_for(None), 0.5);
    }

    #[test]
    fn an_operator_database_means_no_supervised_mongod() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths { home: dir.path().into(), package: dir.path().join("package"), data: dir.path().join("data"), bun: "bun".into() };
        let operator = BTreeMap::from([("MONGODB_URI".to_string(), "mongodb://elsewhere/lgr".to_string())]);
        assert_eq!(plan(&paths, &operator).unwrap(), None);
        // And without one, a missing binary is a configuration error that says where it looked.
        std::env::remove_var("LGR_SERVER_MONGOD");
        let err = plan(&paths, &BTreeMap::new()).unwrap_err().to_string();
        assert!(err.contains("no mongod at"), "{err}");
    }

    #[test]
    fn mongod_is_private_to_the_machine_and_sized() {
        let dir = tempfile::tempdir().unwrap();
        let plan = Plan {
            binary: "mongod".into(),
            port: 27118,
            dbpath: dir.path().join("db"),
            keyfile: dir.path().join("keys").join("mongo.keyfile"),
            secrets: dir.path().join("keys").join("mongo.env"),
            log: dir.path().join("logs").join("mongod.log"),
            cache_gb: 0.5,
            oplog_mb: 2048,
        };
        let spec = spec(&plan).unwrap();
        let args = spec.args.join(" ");
        assert!(args.contains("--bind_ip 127.0.0.1"));
        assert!(!args.contains("0.0.0.0"));
        assert!(args.contains("--replSet rs0"));
        assert!(args.contains("--keyFile"));
        assert!(args.contains("--wiredTigerCacheSizeGB 0.5"));
        assert!(args.contains("--oplogSize 2048"));
        let key = std::fs::read_to_string(&plan.keyfile).unwrap();
        assert!(key.len() <= 1024 && key.len() >= 6, "mongod takes 6 to 1024 base64 characters, got {}", key.len());
        // Made once: a second plan keeps the key the data was written with.
        spec_again_keeps_the_key(&plan, &key);
    }

    /// Nothing listening is not a stop: the supervisor would wait out a grace for an exit that the
    /// command never caused, instead of signalling at once.
    #[tokio::test]
    async fn a_shutdown_request_to_nothing_is_an_error() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let asked = request_shutdown(port, ADMIN_USER, "no-one-listens").await;
        assert!(asked.is_err(), "{asked:?}");
    }

    fn spec_again_keeps_the_key(plan: &Plan, key: &str) {
        spec(plan).unwrap();
        assert_eq!(std::fs::read_to_string(&plan.keyfile).unwrap(), key);
    }

    /// The real thing: a `mongod` binary (`LGR_SERVER_TEST_MONGOD`, which CI and a developer machine
    /// both have from mongodb-memory-server's cache), started, bootstrapped twice, and opened with
    /// what the API gets. Skipped without one.
    #[tokio::test]
    async fn a_first_boot_and_a_reboot_against_a_real_mongod() {
        // ⚠ Empty is unset: a CI step that exported what `ls` found exported "" when it found nothing.
        let Some(binary) = std::env::var_os("LGR_SERVER_TEST_MONGOD").filter(|v| !v.is_empty()).map(PathBuf::from) else {
            eprintln!("LGR_SERVER_TEST_MONGOD not set: skipped");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let plan = Plan {
            binary,
            port,
            dbpath: dir.path().join("db"),
            keyfile: dir.path().join("keys").join("mongo.keyfile"),
            secrets: dir.path().join("keys").join("mongo.env"),
            log: dir.path().join("logs").join("mongod.log"),
            cache_gb: 0.25,
            oplog_mb: 64,
        };
        // No logs/ made here: spec() must make it, or mongod exits 1 (it did, under the supervisor).
        let spec = spec(&plan).unwrap();

        let first = crate::child::spawn(&spec).unwrap();
        let uri = bootstrap(&plan).await.unwrap();
        // What the API gets works: it can write to its database...
        let app = mongodb::Client::with_uri_str(&uri).await.unwrap();
        app.database("lgr").collection::<Document>("probe").insert_one(doc! { "at": 1 }).await.unwrap();
        // ...and nobody gets in without a password.
        let anonymous = client(&plan, None).await.unwrap();
        let refused = anonymous.database("lgr").collection::<Document>("probe").find_one(doc! {}).await;
        assert!(refused.is_err(), "an unauthenticated read must be refused");
        drop(app);
        drop(anonymous);
        // Stopped by its own shutdown command, so cleanly: exit 0, and mongod says how it went (a
        // signal stops it cleanly too on Unix, so the exit code alone would not tell).
        let by_command = || std::fs::read_to_string(&plan.log).unwrap().matches("Terminating via shutdown command").count();
        assert_eq!(first.stop(&spec.stop, Duration::from_secs(10)).await, Some(0));
        assert_eq!(by_command(), 1);

        // A reboot: the same keys, the same users, no reset.
        let second = crate::child::spawn(&spec).unwrap();
        let again = bootstrap(&plan).await.unwrap();
        assert_eq!(again, uri);
        let app = mongodb::Client::with_uri_str(&again).await.unwrap();
        let n = app.database("lgr").collection::<Document>("probe").count_documents(doc! {}).await.unwrap();
        assert_eq!(n, 1);
        drop(app);

        // Keys lost: refused, never reset.
        std::fs::remove_file(&plan.secrets).unwrap();
        let err = bootstrap(&plan).await.unwrap_err();
        assert!(err.downcast_ref::<Refused>().is_some(), "{err:#}");
        // What a supervisor started after the loss knows is the new, wrong password: the shutdown
        // command is refused, and the signal stops it instead, without waiting out a grace first.
        let after_loss = super::spec(&plan).unwrap();
        assert_ne!(after_loss.stop, spec.stop);
        let started = std::time::Instant::now();
        assert!(second.stop(&after_loss.stop, Duration::from_secs(10)).await.is_some());
        assert!(started.elapsed() < Duration::from_secs(8), "took {:?}", started.elapsed());
        assert_eq!(by_command(), 1, "the refused command must not have stopped it");
    }
}
