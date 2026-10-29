//! Where a master keeps things, and how its API is started (FR-20 plan step P1-1).
//!
//! | what | default | override |
//! |---|---|---|
//! | home (the install) | the directory holding `lgr-server` | `LGR_SERVER_HOME` |
//! | the server package (`build:server`) | `<home>/package` | `LGR_SERVER_PACKAGE` |
//! | the Bun that runs it | `<home>/bin/bun[.exe]`, else `bun` on `PATH` | `LGR_SERVER_BUN` |
//! | the Chrome that prints PDFs (FR-20.25) | `<home>/chrome/chrome-headless-shell[.exe]` | `LGR_SERVER_CHROME`, or `PUPPETEER_EXECUTABLE_PATH` in api.env |
//! | data (FR-20.14) | `%ProgramData%\LGR`, `/var/lib/lgr`, `/Library/Application Support/LGR` | `LGR_SERVER_DATA` |
//!
//! Under data: `config/api.env` (operator settings, `KEY=VALUE`), `keys/api-secrets.env` (the
//! API's own signing keys, generated on first boot), `uploads/` and `logs/`.
//!
//! ⚠ The Chrome is the package's own (`scripts/fetch-pdf-browser.ts`, pinned by
//! `pdf-browser.lock.json`), never the machine's Edge or Chrome. A Windows browser with an update
//! pending relaunches itself on start: puppeteer reports "Code: 0" and the relaunched headless
//! browser runs on with nobody to close it, three per PDF.
//!
//! ⚠ The API gets an environment built HERE, never the supervisor's own: a service's environment is
//! whatever the machine had, and a stray `NODE_ENV=development` would switch every production guard
//! off. A master never boots with the cloud's secrets (D-12): its keys are its own.

use anyhow::{Context, Result};
use base64::Engine;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::child::ChildSpec;

#[derive(Debug, Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub package: PathBuf,
    pub data: PathBuf,
    pub bun: PathBuf,
    /// `None`: no Chrome in the package and none named. The master runs, and prints no PDF.
    pub chrome: Option<PathBuf>,
}

/// The package's `chrome/` (where `scripts/fetch-pdf-browser.ts` puts it), if it is there.
pub fn packaged_chrome(home: &Path) -> Option<PathBuf> {
    let exe = home.join("chrome").join(if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" });
    exe.exists().then_some(exe)
}

impl Paths {
    pub fn resolve() -> Result<Self> {
        let home = match std::env::var_os("LGR_SERVER_HOME") {
            Some(h) => PathBuf::from(h),
            None => std::env::current_exe()
                .context("locating lgr-server")?
                .parent()
                .map(Path::to_path_buf)
                .context("lgr-server has no directory")?,
        };
        let package = std::env::var_os("LGR_SERVER_PACKAGE").map(PathBuf::from).unwrap_or_else(|| home.join("package"));
        let data = std::env::var_os("LGR_SERVER_DATA").map(PathBuf::from).unwrap_or_else(crate::preflight::default_data_dir);
        let bun = match std::env::var_os("LGR_SERVER_BUN") {
            Some(b) => PathBuf::from(b),
            None => {
                let bundled = home.join("bin").join(if cfg!(windows) { "bun.exe" } else { "bun" });
                if bundled.exists() { bundled } else { PathBuf::from(if cfg!(windows) { "bun.exe" } else { "bun" }) }
            }
        };
        let chrome = std::env::var_os("LGR_SERVER_CHROME").map(PathBuf::from).or_else(|| packaged_chrome(&home));
        Ok(Self { home, package, data, bun, chrome })
    }
}

/// The browser the API prints PDFs with: the operator's `PUPPETEER_EXECUTABLE_PATH` (a Linux ARM
/// master, which Chrome for Testing has no build for, names its distribution's), else the package's.
pub fn pdf_browser(paths: &Paths, operator: &BTreeMap<String, String>) -> Option<PathBuf> {
    operator.get("PUPPETEER_EXECUTABLE_PATH").map(PathBuf::from).or_else(|| paths.chrome.clone())
}

/// `KEY=VALUE` lines. Blank lines and `#` comments are skipped; values are taken as written.
pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

fn random_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The API's own signing keys, made once and kept in `keys/api-secrets.env`.
///
/// ⚠ Made on first boot and NEVER rotated here: every session and desktop token is signed with
/// them, and a new key signs everyone out and unpairs every till.
pub fn api_secrets(data: &Path) -> Result<BTreeMap<String, String>> {
    let dir = data.join("keys");
    let file = dir.join("api-secrets.env");
    if file.exists() {
        let found = parse_env(&std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?);
        if found.contains_key("JWT_SECRET") && found.contains_key("DESKTOP_TOKEN_SECRET") {
            return Ok(found);
        }
        anyhow::bail!("{} is incomplete: it must hold JWT_SECRET and DESKTOP_TOKEN_SECRET", file.display());
    }
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let secrets = BTreeMap::from([("JWT_SECRET".to_string(), random_key()), ("DESKTOP_TOKEN_SECRET".to_string(), random_key())]);
    let text: String = secrets.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
    write_private(&file, &text)?;
    tracing::info!(file = %file.display(), "generated the API's signing keys");
    Ok(secrets)
}

/// Write `text` to `file`, readable by its owner only on Unix (Windows: the data directory's ACL,
/// set by the installer, P1-7), and durably (`write_durable`).
pub(crate) fn write_private(file: &Path, text: &str) -> Result<()> {
    write_durable(file, text.as_bytes(), 0o600)
}

/// Write `bytes` to `file` so that a power cut leaves the old file or the new one, never a renamed
/// file whose bytes never reached the disk: a temporary file beside it, flushed, renamed over it,
/// and on Unix the directory flushed as well, which is what makes the rename itself survive.
///
/// ⚠ A rename alone is not enough. ext4 (delayed allocation) and NTFS both put the rename on disk
/// well before the data, so a cut in the seconds after a FIRST start could leave an empty
/// `state/node.json`, a half `keys/api-secrets.env` or an empty CA key, and the master then refused
/// to start for good (exit 7, "restore it from a backup"). `mongod.rs` always wrote
/// `keys/mongo.env` like this; everything in `state/` and `keys/` the supervisor writes does now.
///
/// `mode` is the file's permission bits on Unix (0o600 for anything secret). Writers of one file
/// must not race: the temporary file is `<name>.tmp`, so a crash's leftover is replaced next time.
pub(crate) fn write_durable(file: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let name = file.file_name().with_context(|| format!("{} names no file", file.display()))?;
    let dir = file.parent().filter(|d| !d.as_os_str().is_empty());
    if let Some(dir) = dir {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let mut tmp_name = name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = file.with_file_name(tmp_name);
    let _ = std::fs::remove_file(&tmp);
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
        #[cfg(not(unix))]
        let _ = mode;
        let mut f = options.open(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        // Exactly `mode`, whatever the umask: a file the API reads must not come out 0600 because
        // the update helper ran with a stricter one.
        #[cfg(unix)]
        f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(mode)).with_context(|| format!("setting the mode of {}", tmp.display()))?;
        std::io::Write::write_all(&mut f, bytes).with_context(|| format!("writing {}", tmp.display()))?;
        f.sync_all().with_context(|| format!("flushing {}", tmp.display()))?;
    }
    std::fs::rename(&tmp, file).with_context(|| format!("writing {}", file.display()))?;
    if let Some(dir) = dir {
        sync_dir(dir)?;
    }
    Ok(())
}

/// Flush a directory, so a rename or a new link in it survives a power cut. A no-op on Windows,
/// where NTFS journals the rename and a directory cannot be opened as a file.
pub(crate) fn sync_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    std::fs::File::open(dir).and_then(|d| d.sync_all()).with_context(|| format!("flushing {}", dir.display()))?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// The variables a child needs from the OS to run at all: nothing that changes what LGR does.
fn os_env() -> BTreeMap<String, String> {
    const KEEP: &[&str] = &["PATH", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "TZ"];
    KEEP.iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
}

/// The settings this master runs with: what setup chose (`state/setup.json`, FR-20.18), with what
/// the operator set in `<data>/config/api.env` over it. Empty when there is neither.
///
/// ⚠ The operator's file always wins, and setup never writes it: a hand-made `LAN_INGRESS=off`
/// stays off whatever setup chose, and a comment or a secret in that file is never rewritten by a
/// page. Setup's own file belongs to the service account, which `config/` may not.
pub fn operator_env(paths: &Paths) -> Result<BTreeMap<String, String>> {
    let mut env = crate::setup::env(&crate::setup::load(&paths.data));
    match std::fs::read_to_string(paths.data.join("config").join("api.env")) {
        Ok(text) => env.extend(parse_env(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("reading config/api.env"),
    }
    Ok(env)
}

/// How long the API waits, once asked to stop, for a receipt and the requests in flight (its own
/// `LGR_STOP_WAIT_MS`, 25 s by default): the supervisor's grace for it must be longer.
fn api_stop_wait(operator: &BTreeMap<String, String>) -> std::time::Duration {
    let ms = operator.get("LGR_STOP_WAIT_MS").and_then(|v| v.parse::<u64>().ok()).filter(|&ms| ms > 0).unwrap_or(25_000);
    std::time::Duration::from_millis(ms)
}

/// The API child: `bun <package>/app/server.js` with the environment a master runs it in.
/// `mongo_uri` is the supervised database's (from its bootstrap); without one, the operator's
/// `MONGODB_URI` is used.
///
/// With a `front` (the supervisor's, FR-20.16) the API listens on its loopback port only, answers
/// the front secret only, and stops through its control socket. Without one (`run-script`, which
/// borrows the environment and serves nothing) it gets none of them.
pub fn api_spec(paths: &Paths, mongo_uri: Option<&str>, front: Option<&crate::front::Front>) -> Result<ChildSpec> {
    let entry = paths.package.join("app").join("server.js");
    if !entry.exists() {
        anyhow::bail!("no server package at {} (expected app/server.js; `bun run build:server` makes one)", paths.package.display());
    }
    let mut operator = operator_env(paths)?;
    if let Some(uri) = mongo_uri {
        operator.insert("MONGODB_URI".to_string(), uri.to_string());
    }
    let wait = api_stop_wait(&operator);
    let mut env = os_env();
    // A master's defaults, then what the operator set, then what nobody may override.
    env.extend([
        ("HOST".to_string(), "127.0.0.1".to_string()),
        ("PORT".to_string(), "4001".to_string()),
        ("MIGRATIONS_AUTO".to_string(), "true".to_string()),
        ("UPLOAD_DIR".to_string(), paths.data.join("uploads").to_string_lossy().into_owned()),
    ]);
    if let Some(chrome) = &paths.chrome {
        env.insert("PUPPETEER_EXECUTABLE_PATH".to_string(), chrome.to_string_lossy().into_owned());
    }
    env.extend(operator);
    env.extend(api_secrets(&paths.data)?);
    env.extend([
        ("NODE_ENV".to_string(), "production".to_string()),
        ("LGR_NODE_ROLE".to_string(), "master".to_string()),
        // FR-20.5: who this master is. Every org it is home of names it, and without it the API can
        // write none of them. Scripts get it too: they write under the same home rule.
        ("LGR_NODE_ID".to_string(), crate::front::node_id(&paths.data)?),
        ("LGR_UI_ROOT".to_string(), paths.package.join("ui").to_string_lossy().into_owned()),
        // FR-20.56: the desktop release the supervisor keeps; the tills are served from it.
        ("LGR_DESKTOP_RELEASES_DIR".to_string(), crate::desktop_releases::root(&paths.data).to_string_lossy().into_owned()),
        // FR-20.55: the licences the supervisor keeps, which the API verifies and enforces.
        ("LGR_LICENCE_DIR".to_string(), crate::licence::dir(&paths.data).to_string_lossy().into_owned()),
        // FR-20.86: the node token the API's outbox presents to global's relay.
        ("LGR_NODE_TOKEN_FILE".to_string(), crate::node_token::file(&paths.data).to_string_lossy().into_owned()),
        // FR-20.54, FR-20.61: the registration, whose link level turns the API's capture on at Full.
        ("LGR_REGISTRATION_FILE".to_string(), crate::register::registration_file(&paths.data).to_string_lossy().into_owned()),
        // FR-20.40: where the API puts its seal key's public half, which the node key then vouches for.
        ("LGR_NODE_SEAL_PUB_FILE".to_string(), crate::node_token::seal_pub_file(&paths.data).to_string_lossy().into_owned()),
    ]);
    if let Some(created) = crate::front::node_created_at(&paths.data) {
        env.insert("LGR_NODE_CREATED_AT".to_string(), created.to_string());
    }
    let stop = match front {
        Some(f) => {
            // FR-20.16: one listener, on loopback, on the front's port, answering the front secret.
            env.extend([
                ("HOST".to_string(), "127.0.0.1".to_string()),
                ("PORT".to_string(), f.port.to_string()),
                ("LGR_FRONT_SECRET".to_string(), f.secret.clone()),
                ("LGR_FRONT_HOSTS".to_string(), f.hosts.join(",")),
                ("LGR_CONTROL_SOCKET".to_string(), f.socket.to_string_lossy().into_owned()),
                // FR-20.53: no direct internet call. Out through the egress proxy, which applies the
                // machine's proxy rules; loopback stays direct.
                ("HTTPS_PROXY".to_string(), crate::egress::proxy_url(f.egress_port, &f.egress_secret)),
                ("HTTP_PROXY".to_string(), crate::egress::proxy_url(f.egress_port, &f.egress_secret)),
                ("NO_PROXY".to_string(), "localhost,127.0.0.1,::1".to_string()),
            ]);
            if let Some(roots) = &f.roots {
                env.insert("NODE_EXTRA_CA_CERTS".to_string(), roots.to_string_lossy().into_owned());
            }
            // FR-20.29: what a pairing code names and pins, when the LAN ingress is open.
            if let (Some(url), Some(fp)) = (&f.lan_url, &f.lan_fingerprint) {
                env.insert("LGR_LAN_URL".to_string(), url.clone());
                env.insert("LGR_LAN_CA_FINGERPRINT".to_string(), fp.clone());
                // FR-20.30: the same two, kept current by the supervisor (a rotation, a DHCP move).
                if let Some(state) = &f.lan_state {
                    env.insert("LGR_LAN_STATE_FILE".to_string(), state.to_string_lossy().into_owned());
                }
            }
            crate::child::Stop::Control { socket: f.socket.clone(), secret: f.secret.clone() }
        }
        None => crate::child::Stop::Signal,
    };
    Ok(ChildSpec {
        name: "api".to_string(),
        program: paths.bun.clone(),
        args: vec![entry.to_string_lossy().into_owned()],
        cwd: paths.package.clone(),
        env,
        log: Some(paths.data.join("logs").join("api.log")),
        stop,
        // Its own wait, and the time to disconnect the devices and close the database after it.
        grace: wait + std::time::Duration::from_secs(15),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("package");
        std::fs::create_dir_all(package.join("app")).unwrap();
        std::fs::write(package.join("app").join("server.js"), "").unwrap();
        let paths = Paths { home: dir.path().to_path_buf(), package, data: dir.path().join("data"), bun: PathBuf::from("bun"), chrome: None };
        (dir, paths)
    }

    #[test]
    fn a_durable_write_replaces_the_file_and_leaves_no_temporary_one() {
        let dir = tempfile::tempdir().unwrap();
        // A directory that does not exist yet, as `state/` on a first start.
        let file = dir.path().join("state").join("node.json");
        write_private(&file, "{\"nodeId\":\"one\"}").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"nodeId\":\"one\"}");
        // A crash's leftover temporary file is replaced, never refused or renamed in.
        std::fs::write(dir.path().join("state").join("node.json.tmp"), "half").unwrap();
        write_durable(&file, b"{\"nodeId\":\"two\"}", 0o644).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\"nodeId\":\"two\"}");
        let left: Vec<String> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec!["node.json".to_string()]);
        // Two files whose names differ only after the dot get two temporary files, not one.
        let key = dir.path().join("keys").join("lan-ca.key");
        write_private(&key, "key").unwrap();
        write_private(&key.with_extension("pem"), "pem").unwrap();
        assert_eq!(std::fs::read_to_string(&key).unwrap(), "key");
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_its_owner_s_alone_and_a_public_one_is_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("api-secrets.env");
        write_private(&secret, "JWT_SECRET=x\n").unwrap();
        assert_eq!(std::fs::metadata(&secret).unwrap().permissions().mode() & 0o777, 0o600);
        let state = dir.path().join("lan.json");
        write_durable(&state, b"{}", 0o644).unwrap();
        assert_eq!(std::fs::metadata(&state).unwrap().permissions().mode() & 0o777, 0o644);
    }

    #[test]
    fn pdfs_print_with_the_package_s_chrome_unless_the_operator_names_another() {
        let (dir, mut paths) = layout();
        // No Chrome in the package: the API is told none, and finds none.
        assert_eq!(packaged_chrome(dir.path()), None);
        assert!(!api_spec(&paths, None, None).unwrap().env.contains_key("PUPPETEER_EXECUTABLE_PATH"));
        assert_eq!(pdf_browser(&paths, &BTreeMap::new()), None);

        let exe = dir.path().join("chrome").join(if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" });
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "").unwrap();
        assert_eq!(packaged_chrome(dir.path()), Some(exe.clone()));
        paths.chrome = packaged_chrome(dir.path());
        let spec = api_spec(&paths, None, None).unwrap();
        assert_eq!(spec.env["PUPPETEER_EXECUTABLE_PATH"], exe.to_string_lossy());
        assert_eq!(pdf_browser(&paths, &BTreeMap::new()), Some(exe));

        std::fs::create_dir_all(paths.data.join("config")).unwrap();
        std::fs::write(paths.data.join("config").join("api.env"), "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium\n").unwrap();
        assert_eq!(api_spec(&paths, None, None).unwrap().env["PUPPETEER_EXECUTABLE_PATH"], "/usr/bin/chromium");
        assert_eq!(pdf_browser(&paths, &operator_env(&paths).unwrap()), Some(PathBuf::from("/usr/bin/chromium")));
    }

    #[test]
    fn env_files_are_key_value_lines() {
        let env = parse_env("# a comment\n\nPORT=4100\n  MONGODB_URI = mongodb://127.0.0.1:27100/lgr?replicaSet=rs0\nnot a pair\n=no-key\n");
        assert_eq!(env.get("PORT").unwrap(), "4100");
        assert_eq!(env.get("MONGODB_URI").unwrap(), "mongodb://127.0.0.1:27100/lgr?replicaSet=rs0");
        assert_eq!(env.len(), 2);
    }

    #[test]
    fn the_api_keys_are_made_once_and_kept() {
        let (_dir, paths) = layout();
        let first = api_secrets(&paths.data).unwrap();
        let again = api_secrets(&paths.data).unwrap();
        assert_eq!(first, again);
        assert!(first["JWT_SECRET"].len() >= 64);
        assert_ne!(first["JWT_SECRET"], first["DESKTOP_TOKEN_SECRET"]);
    }

    #[test]
    fn what_setup_chose_reaches_the_api_under_what_the_operator_wrote() {
        let (_dir, paths) = layout();
        let chosen = crate::setup::Choices {
            link: Some("airgapped".into()),
            lan: Some(crate::setup::Lan { on: true, port: 4443 }),
            backup: Some(crate::setup::Backup { local_path: Some("/media/usb".into()) }),
            sys_admins: vec!["owner@shop.example".into()],
            settings_at: Some(1),
        };
        crate::setup::save(&paths.data, &chosen).unwrap();
        let env = api_spec(&paths, None, None).unwrap().env;
        assert_eq!(env["BACKUP_SYS_ADMINS"], "owner@shop.example");
        assert_eq!(env["BACKUP_LOCAL_PATH"], "/media/usb");
        assert_eq!(operator_env(&paths).unwrap()["LAN_INGRESS"], "on");
        // The operator's own line wins, whatever setup chose; the rest of setup's choices stay.
        std::fs::create_dir_all(paths.data.join("config")).unwrap();
        std::fs::write(paths.data.join("config").join("api.env"), "LAN_INGRESS=off\nBACKUP_LOCAL_PATH=/mnt/nas\n").unwrap();
        let operator = operator_env(&paths).unwrap();
        assert_eq!(operator["LAN_INGRESS"], "off");
        assert_eq!(operator["BACKUP_LOCAL_PATH"], "/mnt/nas");
        assert_eq!(operator["BACKUP_SYS_ADMINS"], "owner@shop.example");
    }

    #[test]
    fn the_api_runs_as_a_production_master_whatever_the_operator_writes() {
        let (_dir, paths) = layout();
        std::fs::create_dir_all(paths.data.join("config")).unwrap();
        std::fs::write(paths.data.join("config").join("api.env"), "PORT=4100\nNODE_ENV=development\nLGR_NODE_ROLE=global\n").unwrap();
        let spec = api_spec(&paths, None, None).unwrap();
        assert_eq!(spec.env["PORT"], "4100");
        assert_eq!(spec.env["NODE_ENV"], "production");
        assert_eq!(spec.env["LGR_NODE_ROLE"], "master");
        // Its identity, made once, the same on every start, whatever api.env says.
        let id = spec.env["LGR_NODE_ID"].clone();
        assert!(id.starts_with("master-") && id.len() == "master-".len() + 16, "{id}");
        std::fs::write(paths.data.join("config").join("api.env"), "LGR_NODE_ID=someone-else\n").unwrap();
        assert_eq!(api_spec(&paths, None, None).unwrap().env["LGR_NODE_ID"], id);
        assert!(spec.env.contains_key("JWT_SECRET"));
        assert!(spec.args[0].ends_with("server.js"));
    }

    #[test]
    fn behind_the_front_the_api_listens_on_loopback_on_its_port_whatever_the_operator_writes() {
        let (_dir, paths) = layout();
        std::fs::create_dir_all(paths.data.join("config")).unwrap();
        std::fs::write(paths.data.join("config").join("api.env"), "HOST=0.0.0.0\nPORT=4100\nLGR_FRONT_SECRET=mine\nLGR_STOP_WAIT_MS=40000\n").unwrap();
        let front = crate::front::Front {
            secret: "the-front-secret".into(),
            port: 51234,
            socket: paths.data.join("run").join("api.sock"),
            hosts: vec!["kasa-1".into(), "kasa-1.local".into()],
            setup_port: 4480,
            egress_port: 51235,
            egress_secret: "the-egress-secret".into(),
            roots: Some(paths.data.join("run").join("os-roots.pem")),
            lan_url: Some("https://192.168.1.10:4443".into()),
            lan_fingerprint: Some("sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k".into()),
            lan_state: Some(paths.data.join("state").join("lan.json")),
        };
        let spec = api_spec(&paths, None, Some(&front)).unwrap();
        assert_eq!(spec.env["HOST"], "127.0.0.1");
        assert_eq!(spec.env["PORT"], "51234");
        assert_eq!(spec.env["LGR_FRONT_SECRET"], "the-front-secret");
        assert_eq!(spec.env["LGR_FRONT_HOSTS"], "kasa-1,kasa-1.local");
        assert!(spec.env["LGR_CONTROL_SOCKET"].ends_with("api.sock"));
        assert_eq!(spec.env["HTTPS_PROXY"], "http://lgr:the-egress-secret@127.0.0.1:51235");
        assert_eq!(spec.env["NO_PROXY"], "localhost,127.0.0.1,::1");
        assert!(spec.env["NODE_EXTRA_CA_CERTS"].ends_with("os-roots.pem"));
        assert_eq!(spec.env["LGR_LAN_URL"], "https://192.168.1.10:4443");
        assert!(spec.env["LGR_LAN_STATE_FILE"].ends_with("lan.json"), "{}", spec.env["LGR_LAN_STATE_FILE"]);
        assert_eq!(spec.env["LGR_LAN_CA_FINGERPRINT"], "sha256:J4_WvnqzMeCTJR5MsUknM6BG3BhVB2WJ7UdM0ERAY5k");
        assert_eq!(spec.stop, crate::child::Stop::Control { socket: front.socket.clone(), secret: front.secret.clone() });
        // The operator's longer wait for a receipt, plus the time to close down after it.
        assert_eq!(spec.grace, std::time::Duration::from_secs(55));
        // Without a front (`run-script`) there is nothing to answer, so none of it.
        let bare = api_spec(&paths, None, None).unwrap();
        assert_eq!(bare.stop, crate::child::Stop::Signal);
        assert!(!bare.env.contains_key("HTTPS_PROXY"));
        assert_eq!(bare.env["PORT"], "4100");
    }

    #[test]
    fn no_package_is_a_clear_refusal() {
        let (_dir, mut paths) = layout();
        paths.package = paths.home.join("nowhere");
        let err = api_spec(&paths, None, None).unwrap_err().to_string();
        assert!(err.contains("no server package"), "{err}");
    }
}
