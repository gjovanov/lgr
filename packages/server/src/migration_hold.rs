//! #980: the contract migrations a master's API holds while its update is watched, and their release.
//!
//! A master's update runs, in one start, every migration of the releases the master skipped, and goes
//! back to the version before if the update fails its confirmation. A contract step
//! (`packages/migrations/src/registry.ts#CONTRACT`) removes what an earlier release reads, so it must
//! not run while the update can still be gone back from. The update helper decides that, and it runs
//! the previous version's code (`helper.rs`), so it cannot be taught anything by the release that
//! needs it. The API cannot read the helper's state either: Bun opens every file without
//! FILE_SHARE_DELETE on Windows, and a read that overlaps the helper's save fails its rename over the
//! file. So the supervisor, which is this version's code and reads the state with std (which shares
//! delete), decides:
//!
//! - at the API's spec ([`decide`], `config.rs#update_env`): hold while this version is the attempt,
//!   or while the state cannot be read; otherwise run them, and one that fails waits (`try`). Either
//!   way the API applies again what a version that failed its confirmation applied;
//! - here ([`run`]), once the update is confirmed: ask the API to run what it holds
//!   (`POST /migrations/release`, `migrations/start.ts#releaseHeld`), once for each start of the API,
//!   because a respawned API is given the same environment and holds again.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;

use crate::install::{Root, UpdateState};

/// `hold` or `try` (`migrations/start.ts#startModeFromEnv`).
pub const CONTRACT_ENV: &str = "LGR_MIGRATIONS_CONTRACT";
/// The versions that failed their confirmation, comma-separated.
pub const FAILED_ENV: &str = "LGR_MIGRATIONS_FAILED_VERSIONS";

/// How often the state is read for the confirmation, and the API's starts looked at after it.
pub const EVERY: Duration = Duration::from_secs(5);

/// The API answers a release at once: the run goes on in the background, and is asked about again.
const ASK: Duration = Duration::from_secs(10);

/// What a start does with the contract steps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    /// Held until the update is confirmed.
    pub hold: bool,
    /// The versions that failed their confirmation, this one aside: what they applied is applied again.
    pub failed: Vec<String>,
}

impl Decision {
    /// What [`CONTRACT_ENV`] says.
    pub fn contract(&self) -> &'static str {
        if self.hold {
            "hold"
        } else {
            "try"
        }
    }
}

/// What a start of `version` does, by the helper's state. A state that cannot be read holds: a held
/// contract step costs nothing the new code reads, and one applied under a watch is what this prevents.
pub fn decide(state: &anyhow::Result<UpdateState>, version: &str) -> Decision {
    match state {
        Err(_) => Decision { hold: true, failed: vec![] },
        Ok(s) => Decision {
            hold: watched(s, version),
            // A version that runs is not one gone back from, whatever an old record says: its own steps
            // would otherwise be applied again at every start.
            failed: s.failed.iter().map(|f| f.version.clone()).filter(|v| !v.is_empty() && v != version).collect(),
        },
    }
}

/// The API's environment holds the contract steps: the version it runs, which [`run`] releases.
pub fn held_by(env: &std::collections::BTreeMap<String, String>) -> Option<String> {
    (env.get(CONTRACT_ENV).map(String::as_str) == Some("hold")).then(|| env.get("LGR_SERVER_VERSION").cloned().unwrap_or_default())
}

/// This version is the switch the helper watches.
fn watched(s: &UpdateState, version: &str) -> bool {
    s.attempting.as_ref().is_some_and(|a| a.version == version)
}

/// This version ran cleanly through its confirmation.
fn confirmed(s: &UpdateState, version: &str) -> bool {
    !watched(s, version) && s.last_known_good == version
}

/// Gone back from: the helper stops this server for the switch.
fn gone_back(s: &UpdateState, version: &str) -> bool {
    !watched(s, version) && s.failed.iter().any(|f| f.version == version)
}

/// The API's answer to a release: whether nothing waits for the confirmation any more, and what
/// contract steps are still not applied (one failed, and waits for a later start with those after it).
fn answer(body: &str) -> Option<(bool, Vec<String>)> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let held = v["held"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    Some((v["released"].as_bool()?, held))
}

/// Once `version` is confirmed, asks the API to run what it held, once for each of its starts. Gone
/// back from, it never asks. Kept for the round, as a service is (`Supervisor::add_service`).
pub async fn run(sup: Arc<crate::supervisor::Supervisor>, root: Root, version: String) {
    let control = sup.clone();
    release_when_confirmed(&root, &version, EVERY, move || sup.starts("api"), move || {
        let api = control.api_control();
        async move {
            let (socket, secret) = api.context("the API has no control socket")?;
            crate::control::call(&socket, &secret, "POST", "/migrations/release", ASK).await
        }
    })
    .await
}

/// [`run`], with what it needs of the supervisor passed in: the API's starts, and a release.
pub async fn release_when_confirmed<S, R, F>(root: &Root, version: &str, every: Duration, starts: S, release: R)
where
    S: Fn() -> Option<u32>,
    R: Fn() -> F,
    F: Future<Output = anyhow::Result<(u16, String)>>,
{
    let mut said: Option<String> = None;
    loop {
        match UpdateState::load(root) {
            Ok(s) if confirmed(&s, version) => break,
            Ok(s) if gone_back(&s, version) => {
                tracing::warn!(%version, "the update was gone back from: the contract migrations it held never run in this version");
                return;
            }
            Ok(_) => {}
            Err(e) => {
                let e = format!("{e:#}");
                if said.as_ref() != Some(&e) {
                    tracing::warn!(error = %e, "the update state cannot be read: the API's contract migrations stay held until it can");
                    said = Some(e);
                }
            }
        }
        tokio::time::sleep(every).await;
    }
    tracing::info!(%version, "the update is confirmed: the API runs the contract migrations it held");
    let mut done: Option<u32> = None;
    let mut said: Option<String> = None;
    loop {
        if let Some(start) = starts().filter(|&n| n > 0 && done != Some(n)) {
            let problem = match release().await {
                Ok((200, body)) => match answer(&body) {
                    Some((true, held)) => {
                        done = Some(start);
                        if held.is_empty() {
                            tracing::info!(start, "the API applied the contract migrations it held");
                        } else {
                            tracing::warn!(start, held = %held.join(", "), "the API applied the contract migrations it held, but for some that failed: they wait for a later start (its status says why)");
                        }
                        None
                    }
                    Some((false, _)) => None,
                    None => Some(format!("its answer is not one: {}", body.chars().take(200).collect::<String>())),
                },
                Ok((code, body)) => Some(format!("its control socket answered {code}: {}", body.chars().take(200).collect::<String>())),
                // Starting, or between two starts: asked again on the next turn.
                Err(e) => {
                    tracing::debug!(error = %format!("{e:#}"), "the API did not take the release yet");
                    None
                }
            };
            if let Some(p) = problem.filter(|p| said.as_ref() != Some(p)) {
                tracing::warn!(problem = %p, "the API did not take the release of its contract migrations: asked again");
                said = Some(p);
            }
        }
        tokio::time::sleep(every).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{Attempt, Failure};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    fn state(current: &str, lkg: &str, attempting: Option<&str>, failed: &[&str]) -> UpdateState {
        UpdateState {
            current: current.into(),
            last_known_good: lkg.into(),
            previous: String::new(),
            attempting: attempting.map(|v| Attempt { version: v.into(), from: lkg.into(), at: 1, by: "helper".into() }),
            failed: failed.iter().map(|v| Failure { version: (*v).into(), at: 1, reason: "it did not run cleanly".into() }).collect(),
        }
    }

    #[test]
    fn a_start_holds_while_it_is_the_switch_watched_or_the_state_cannot_be_read() {
        let watched = decide(&Ok(state("0.1.14", "0.1.12", Some("0.1.14"), &[])), "0.1.14");
        assert_eq!((watched.hold, watched.contract()), (true, "hold"));
        let confirmed = decide(&Ok(state("0.1.14", "0.1.14", None, &[])), "0.1.14");
        assert_eq!((confirmed.hold, confirmed.contract()), (false, "try"));
        // Nothing switched to yet (a first install), or a newer package waiting for the next start.
        assert!(!decide(&Ok(UpdateState::default()), "0.1.14").hold);
        assert!(!decide(&Ok(state("0.1.14", "0.1.14", Some("0.1.15"), &[])), "0.1.14").hold);
        let unreadable = decide(&Err(anyhow::anyhow!("state.json is damaged")), "0.1.14");
        assert_eq!(unreadable, Decision { hold: true, failed: vec![] });
    }

    #[test]
    fn the_versions_that_failed_are_named_but_never_the_one_that_runs() {
        let d = decide(&Ok(state("0.1.15", "0.1.15", None, &["0.1.13", "0.1.15", "", "0.1.14"])), "0.1.15");
        assert_eq!(d.failed, ["0.1.13", "0.1.14"]);
    }

    #[test]
    fn only_a_hold_is_released_and_the_version_comes_with_it() {
        let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(held_by(&env(&[(CONTRACT_ENV, "hold"), ("LGR_SERVER_VERSION", "0.1.14")])), Some("0.1.14".into()));
        assert_eq!(held_by(&env(&[(CONTRACT_ENV, "try"), ("LGR_SERVER_VERSION", "0.1.14")])), None);
        assert_eq!(held_by(&env(&[("LGR_SERVER_VERSION", "0.1.14")])), None);
    }

    #[test]
    fn the_apis_answer_is_read_for_released_and_what_still_waits() {
        assert_eq!(answer(r#"{"released":true,"releasing":false,"held":[]}"#), Some((true, vec![])));
        assert_eq!(answer(r#"{"released":true,"releasing":false,"held":["0019-drop"]}"#), Some((true, vec!["0019-drop".to_string()])));
        assert_eq!(answer(r#"{"released":false,"releasing":true,"held":["0017-a"]}"#), Some((false, vec!["0017-a".to_string()])));
        assert_eq!(answer("<html>"), None);
        assert_eq!(answer(r#"{"held":[]}"#), None);
    }

    /// The loop against a state on disk and a counted API: what it asked, and when.
    struct Fake {
        starts: AtomicU32,
        asked: Mutex<Vec<u32>>,
        /// Answers `released: false` this many times, then `true`.
        busy: AtomicU32,
    }

    fn spawn_loop(root: &Root, version: &str, fake: Arc<Fake>) -> tokio::task::JoinHandle<()> {
        let (root, version) = (root.clone(), version.to_string());
        tokio::spawn(async move {
            let (s, r) = (fake.clone(), fake.clone());
            release_when_confirmed(&root, &version, Duration::from_millis(10), move || Some(s.starts.load(Ordering::SeqCst)), move || {
                let f = r.clone();
                async move {
                    let start = f.starts.load(Ordering::SeqCst);
                    f.asked.lock().unwrap().push(start);
                    let released = f.busy.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |b| b.checked_sub(1)).is_err();
                    Ok((200, format!(r#"{{"released":{released},"releasing":{},"held":[]}}"#, !released)))
                }
            })
            .await
        })
    }

    async fn until(what: &str, ok: impl Fn() -> bool) {
        for _ in 0..500 {
            if ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting: {what}");
    }

    #[tokio::test]
    async fn a_confirmed_update_releases_what_each_start_of_the_api_held() {
        let dir = tempfile::tempdir().unwrap();
        let root = Root(dir.path().to_path_buf());
        state("0.1.14", "0.1.12", Some("0.1.14"), &[]).save(&root).unwrap();
        let fake = Arc::new(Fake { starts: AtomicU32::new(1), asked: Mutex::new(vec![]), busy: AtomicU32::new(2) });
        let task = spawn_loop(&root, "0.1.14", fake.clone());

        // Watched: nothing is asked.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(fake.asked.lock().unwrap().is_empty());

        // Confirmed: asked until the API says released (twice busy, then done), then not again.
        state("0.1.14", "0.1.14", None, &[]).save(&root).unwrap();
        until("the first start released", || fake.asked.lock().unwrap().len() == 3).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(*fake.asked.lock().unwrap(), [1, 1, 1]);

        // A respawned API holds again (the same environment): asked again, once it answers released.
        fake.starts.store(2, Ordering::SeqCst);
        until("the second start released", || fake.asked.lock().unwrap().len() == 4).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(*fake.asked.lock().unwrap(), [1, 1, 1, 2]);
        task.abort();
    }

    #[tokio::test]
    async fn an_update_gone_back_from_never_releases() {
        let dir = tempfile::tempdir().unwrap();
        let root = Root(dir.path().to_path_buf());
        state("0.1.14", "0.1.12", Some("0.1.14"), &[]).save(&root).unwrap();
        let fake = Arc::new(Fake { starts: AtomicU32::new(1), asked: Mutex::new(vec![]), busy: AtomicU32::new(0) });
        let task = spawn_loop(&root, "0.1.14", fake.clone());
        state("0.1.12", "0.1.12", None, &["0.1.14"]).save(&root).unwrap();
        until("the loop ended", || task.is_finished()).await;
        assert!(fake.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_state_that_cannot_be_read_keeps_them_held_until_it_can() {
        let dir = tempfile::tempdir().unwrap();
        let root = Root(dir.path().to_path_buf());
        std::fs::create_dir_all(root.update()).unwrap();
        std::fs::write(root.state_file(), "{ \"current\": \"0.1.1").unwrap();
        let fake = Arc::new(Fake { starts: AtomicU32::new(1), asked: Mutex::new(vec![]), busy: AtomicU32::new(0) });
        let task = spawn_loop(&root, "0.1.14", fake.clone());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(fake.asked.lock().unwrap().is_empty());
        state("0.1.14", "0.1.14", None, &[]).save(&root).unwrap();
        until("released once readable", || fake.asked.lock().unwrap().len() == 1).await;
        task.abort();
    }

    /// Why the supervisor reads the state and the API never does: a reader that shares delete (std's
    /// default, on Windows too) never fails the helper's save, which renames over the file it reads.
    #[test]
    fn reading_the_state_never_fails_the_helpers_save() {
        let dir = tempfile::tempdir().unwrap();
        let root = Arc::new(Root(dir.path().to_path_buf()));
        state("0.1.14", "0.1.12", Some("0.1.14"), &[]).save(&root).unwrap();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (root, stop) = (root.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut reads = 0u32;
                while !stop.load(Ordering::SeqCst) {
                    UpdateState::load(&root).expect("a read never meets a half-written state");
                    reads += 1;
                }
                reads
            })
        };
        let mut failed = 0;
        for i in 0..300 {
            let lkg = if i % 2 == 0 { "0.1.14" } else { "0.1.12" };
            if state("0.1.14", lkg, None, &[]).save(&root).is_err() {
                failed += 1;
            }
        }
        stop.store(true, Ordering::SeqCst);
        let reads = reader.join().unwrap();
        assert_eq!(failed, 0, "saves failed while the state was read ({reads} reads)");
        assert!(reads > 0);
    }
}
