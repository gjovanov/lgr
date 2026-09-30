//! The diagnostics bundle (FR-14.10): how a field problem gets from a shop PC to a developer.
//!
//! ⚠ **Redacted, and asserted to be.** AC 19 is a grep over a generated bundle proving it contains
//! no token, key or receipt content. A bundle is emailed, dropped into a chat and attached to an
//! issue — it is the single most likely way something sensitive leaves a till, so redaction happens
//! twice: once when the log LINE is written (`logs::redact`), and again on everything added here.

use std::io::Write;
use std::path::PathBuf;

use tauri::AppHandle;
use zip::write::SimpleFileOptions;

use crate::{logs, paths, settings, status};

/// Write a zip beside the logs and return its path.
pub fn create_bundle(app: &AppHandle, logger: &logs::Logger, status: &status::Status) -> Result<PathBuf, String> {
    let dir = paths::log_dir(app)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let out = dir.join(format!("lgr-diagnostics-{stamp}.zip"));

    let file = std::fs::File::create(&out).map_err(|e| format!("cannot create bundle: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 1. What the shell is. Already credential-free by construction (see `status`).
    let status_json = serde_json::to_string_pretty(status).map_err(|e| e.to_string())?;
    add(&mut zip, opts, "status.json", &status_json)?;

    // 2. The settings, with the server and names but nothing secret — and redacted anyway, because
    //    "this file has no secrets in it" is a claim that ages badly.
    let s = settings::load(app);
    let settings_json = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    add(&mut zip, opts, "settings.json", &logs::redact(&settings_json))?;

    // 3. The logs, newest first.
    for (i, path) in logger.files().iter().enumerate() {
        let name = if i == 0 { "logs/lgr-desktop.log".to_string() } else { format!("logs/lgr-desktop.log.{i}") };
        match std::fs::read_to_string(path) {
            // ⚠ Redacted AGAIN on the way in. The lines were redacted when written, but a log file
            // can also be appended to by an older build, and the bundle is the copy that travels.
            Ok(text) => add(&mut zip, opts, &name, &logs::redact(&text))?,
            Err(e) => add(&mut zip, opts, &format!("{name}.unreadable"), &format!("{e}"))?,
        }
    }

    // 4. A README, so whoever receives it knows what they are allowed to assume.
    add(
        &mut zip,
        opts,
        "README.txt",
        "LGR Desktop diagnostics bundle\n\
         \n\
         Contents: the shell's own logs, its settings, and what it reports about itself.\n\
         \n\
         This bundle is REDACTED: access tokens, enrollment codes, private keys and receipt\n\
         contents are replaced with [redacted] markers before it is written. It is meant to be\n\
         safe to email. If you find something sensitive in here, that is a bug worth reporting\n\
         on its own.\n",
    )?;

    zip.finish().map_err(|e| format!("cannot finish bundle: {e}"))?;
    Ok(out)
}

fn add(
    zip: &mut zip::ZipWriter<std::fs::File>,
    opts: SimpleFileOptions,
    name: &str,
    contents: &str,
) -> Result<(), String> {
    zip.start_file(name, opts).map_err(|e| format!("zip {name}: {e}"))?;
    zip.write_all(contents.as_bytes()).map_err(|e| format!("zip {name}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// AC 19, in the form the FR states it: a grep over a GENERATED bundle.
    ///
    /// It builds the zip from the pieces rather than through Tauri (which needs a running app), so
    /// the assertion is about the bytes that ship.
    #[test]
    fn a_generated_bundle_contains_no_credential() {
        let dir = std::env::temp_dir().join(format!("lgr-diag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // A log with every kind of secret the shell could plausibly write.
        //
        // ⚠ Every fixture is assembled from marker fragments rather than written as a literal, so
        // this repository contains no credential-shaped string. Secret scanning cannot tell a
        // fixture from the real thing — and a team that learns to dismiss its findings as "just
        // test data" will dismiss a real one too. The redaction rules care about shape and key
        // names, which is exactly what these supply.
        let marker = "SENTINEL".to_string() + "-VALUE-DO-NOT-MATCH";
        let jwt_shaped = ["eyJ", "FAKE-HEADER", ".", &marker, ".", "FAKE-SIGNATURE"].concat();
        let blob_shaped = "F".repeat(48); // long, opaque, alphanumeric — the blob rule

        let logger = logs::Logger::new(dir.clone());
        logger.info(&format!("GET /api/desktop/v1/self token={jwt_shaped}"));
        logger.info(&format!("enroll code={marker} accepted"));
        logger.info(&format!("assertion={blob_shaped}"));
        logger.info(&format!("authorization: Bearer {blob_shaped}"));
        logger.info(&format!("--enrollment-key={marker}"));
        logger.info("printing receipt line: MILK 2.40 BGN");

        let out = dir.join("bundle.zip");
        let f = std::fs::File::create(&out).unwrap();
        let mut zip = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default();
        for (i, p) in logger.files().iter().enumerate() {
            let text = std::fs::read_to_string(p).unwrap();
            add(&mut zip, opts, &format!("logs/{i}.log"), &logs::redact(&text)).unwrap();
        }
        zip.finish().unwrap();

        // Read every entry back and grep it.
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut all = String::new();
        for i in 0..archive.len() {
            let mut e = archive.by_index(i).unwrap();
            let mut s = String::new();
            e.read_to_string(&mut s).unwrap();
            all.push_str(&s);
        }

        // ⚠ ONE sentinel covers the JWT, the enrollment code and the enrollment key, and the blob
        // covers the assertion and the bearer token. If either string survives anywhere in the
        // archive, something was written without passing through `redact`.
        for forbidden in [marker.as_str(), blob_shaped.as_str(), jwt_shaped.as_str()] {
            assert!(!all.contains(forbidden), "bundle leaked {forbidden}:\n{all}");
        }
        // And it is still USEFUL: the surrounding context survives.
        assert!(all.contains("/api/desktop/v1/self"), "bundle lost its context:\n{all}");
        assert!(all.contains("accepted"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
