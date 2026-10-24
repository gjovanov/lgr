//! Where a master keeps things, and how its API is started (FR-20 plan step P1-1).
//!
//! | what | default | override |
//! |---|---|---|
//! | home (the install) | the directory holding `lgr-server` | `LGR_SERVER_HOME` |
//! | the server package (`build:server`) | `<home>/package` | `LGR_SERVER_PACKAGE` |
//! | the Bun that runs it | `<home>/bin/bun[.exe]`, else `bun` on `PATH` | `LGR_SERVER_BUN` |
//! | data (FR-20.14) | `%ProgramData%\LGR`, `/var/lib/lgr`, `/Library/Application Support/LGR` | `LGR_SERVER_DATA` |
//!
//! Under data: `config/api.env` (operator settings, `KEY=VALUE`), `keys/api-secrets.env` (the
//! API's own signing keys, generated on first boot), `uploads/` and `logs/`.
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
}

fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("LGR")
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/Library/Application Support/LGR")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        PathBuf::from("/var/lib/lgr")
    }
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
        let data = std::env::var_os("LGR_SERVER_DATA").map(PathBuf::from).unwrap_or_else(default_data_dir);
        let bun = match std::env::var_os("LGR_SERVER_BUN") {
            Some(b) => PathBuf::from(b),
            None => {
                let bundled = home.join("bin").join(if cfg!(windows) { "bun.exe" } else { "bun" });
                if bundled.exists() { bundled } else { PathBuf::from(if cfg!(windows) { "bun.exe" } else { "bun" }) }
            }
        };
        Ok(Self { home, package, data, bun })
    }
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

/// Write `text` to `file`, readable by its owner only on Unix. (Windows: the data directory's ACL,
/// set by the installer, P1-7.)
fn write_private(file: &Path, text: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(file)
            .with_context(|| format!("creating {}", file.display()))?;
        f.write_all(text.as_bytes())?;
        Ok(())
    }
    #[cfg(windows)]
    {
        std::fs::write(file, text).with_context(|| format!("writing {}", file.display()))
    }
}

/// The variables a child needs from the OS to run at all: nothing that changes what LGR does.
fn os_env() -> BTreeMap<String, String> {
    const KEEP: &[&str] = &["PATH", "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "TZ"];
    KEEP.iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
}

/// What the operator set in `<data>/config/api.env`: empty when there is no such file.
pub fn operator_env(paths: &Paths) -> Result<BTreeMap<String, String>> {
    match std::fs::read_to_string(paths.data.join("config").join("api.env")) {
        Ok(text) => Ok(parse_env(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e).context("reading config/api.env"),
    }
}

/// The API child: `bun <package>/app/server.js` with the environment a master runs it in.
/// `mongo_uri` is the supervised database's (from its bootstrap); without one, the operator's
/// `MONGODB_URI` is used.
pub fn api_spec(paths: &Paths, mongo_uri: Option<&str>) -> Result<ChildSpec> {
    let entry = paths.package.join("app").join("server.js");
    if !entry.exists() {
        anyhow::bail!("no server package at {} (expected app/server.js; `bun run build:server` makes one)", paths.package.display());
    }
    let mut operator = operator_env(paths)?;
    if let Some(uri) = mongo_uri {
        operator.insert("MONGODB_URI".to_string(), uri.to_string());
    }
    let mut env = os_env();
    // A master's defaults, then what the operator set, then what nobody may override.
    env.extend([
        ("HOST".to_string(), "127.0.0.1".to_string()),
        ("PORT".to_string(), "4001".to_string()),
        ("MIGRATIONS_AUTO".to_string(), "true".to_string()),
        ("UPLOAD_DIR".to_string(), paths.data.join("uploads").to_string_lossy().into_owned()),
    ]);
    env.extend(operator);
    env.extend(api_secrets(&paths.data)?);
    env.extend([
        ("NODE_ENV".to_string(), "production".to_string()),
        ("LGR_NODE_ROLE".to_string(), "master".to_string()),
        ("LGR_UI_ROOT".to_string(), paths.package.join("ui").to_string_lossy().into_owned()),
    ]);
    Ok(ChildSpec {
        name: "api".to_string(),
        program: paths.bun.clone(),
        args: vec![entry.to_string_lossy().into_owned()],
        cwd: paths.package.clone(),
        env,
        log: Some(paths.data.join("logs").join("api.log")),
        // The API stops on SIGTERM; under a Windows service, through its control socket (P1-3).
        stop: crate::child::Stop::Signal,
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
        let paths = Paths { home: dir.path().to_path_buf(), package, data: dir.path().join("data"), bun: PathBuf::from("bun") };
        (dir, paths)
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
    fn the_api_runs_as_a_production_master_whatever_the_operator_writes() {
        let (_dir, paths) = layout();
        std::fs::create_dir_all(paths.data.join("config")).unwrap();
        std::fs::write(paths.data.join("config").join("api.env"), "PORT=4100\nNODE_ENV=development\nLGR_NODE_ROLE=global\n").unwrap();
        let spec = api_spec(&paths, None).unwrap();
        assert_eq!(spec.env["PORT"], "4100");
        assert_eq!(spec.env["NODE_ENV"], "production");
        assert_eq!(spec.env["LGR_NODE_ROLE"], "master");
        assert!(spec.env.contains_key("JWT_SECRET"));
        assert!(spec.args[0].ends_with("server.js"));
    }

    #[test]
    fn no_package_is_a_clear_refusal() {
        let (_dir, mut paths) = layout();
        paths.package = paths.home.join("nowhere");
        let err = api_spec(&paths, None).unwrap_err().to_string();
        assert!(err.contains("no server package"), "{err}");
    }
}
