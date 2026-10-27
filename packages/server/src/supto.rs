//! A SUPTO version travels only once declared (FR-20.50, plan step P3-8c).
//!
//! Under Н-18 чл. 52в(3) and (3а) a change to Прил. 29 functionality or to the database structure is a
//! new SUPTO version, which the producer declares to НАП within 7 days; a build within a version is not
//! one. `config/src/supto.json` holds this source's version and the declared ones; lgrai.app's update
//! offer says, per release, which version it is, whether that is declared, and whether anything is
//! declared at all (`enforced`: until then LGR is not on НАП's list, and nothing waits).
//!
//! - **The supervisor** does not wake the helper for a release that waits, and says so in its status
//!   (`update.suptoWaiting`), which lgrai.app raises as an alarm.
//! - **The helper** asks the same of the offer before it downloads, and once it has the bytes it checks
//!   that the bundle's own `HOME.json` is the version the offer named: the offer is not a trust
//!   boundary, the signed bundle is.

/// `config/src/supto.json`, built into this binary.
const DATA: &str = include_str!("../../config/src/supto.json");

/// The SUPTO version this build implements.
pub fn this_build() -> String {
    serde_json::from_str::<serde_json::Value>(DATA).ok().and_then(|v| v["version"].as_str().map(String::from)).filter(|v| valid(v)).unwrap_or_else(|| "unknown".into())
}

/// What a SUPTO version may look like (`SUPTO_VERSION_RE` in `config/src/supto.ts`).
pub fn valid(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=20).contains(&b.len()) && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'.' || *c == b'-')
}

/// The SUPTO version a release waits for, or `None` when it may travel: nothing declared yet, a
/// declared version, or a build within the version that runs. `suptoWaits` in `config/src/supto.ts`
/// is the same rule. ⚠ An offer that names no version waits once enforced (an older global says
/// nothing of it, and then nothing is enforced either).
pub fn waits(offer: &serde_json::Value, running: Option<&str>) -> Option<String> {
    let s = &offer["supto"];
    if s["enforced"].as_bool() != Some(true) || s["declared"].as_bool() == Some(true) {
        return None;
    }
    match s["version"].as_str().filter(|v| valid(v)) {
        Some(v) if Some(v) == running => None,
        Some(v) => Some(v.to_string()),
        None => Some("unknown".into()),
    }
}

/// Once the bytes are here: the bundle is the SUPTO version the offer named. A bundle that names
/// none is from before P3-8c, and only an offer that names none may bring it.
pub fn bundle_is_offered(offer: &serde_json::Value, bundle: Option<&str>) -> anyhow::Result<()> {
    let offered = offer["supto"]["version"].as_str();
    if offered.is_some() && offered != bundle {
        anyhow::bail!("the bundle says it is SUPTO version {}, and the offer {}", bundle.unwrap_or("(none)"), offered.unwrap_or_default());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn offer(version: Option<&str>, declared: bool, enforced: bool) -> serde_json::Value {
        json!({ "version": "0.3.0", "supto": { "version": version, "declared": declared, "enforced": enforced } })
    }

    #[test]
    fn this_build_names_its_supto_version() {
        let v = this_build();
        assert!(valid(&v), "config/src/supto.json names no SUPTO version this build can use: {v}");
    }

    #[test]
    fn a_release_waits_only_for_an_undeclared_new_version_once_anything_is_declared() {
        // Nothing declared yet: LGR is not on НАП's list, nothing waits, whatever the version.
        assert_eq!(waits(&offer(Some("2"), false, false), Some("1")), None);
        // An older global says nothing of SUPTO: nothing is enforced.
        assert_eq!(waits(&json!({ "version": "0.3.0" }), Some("1")), None);
        // Declared: it travels.
        assert_eq!(waits(&offer(Some("2"), true, true), Some("1")), None);
        // A build within the version that runs: not a new SUPTO version.
        assert_eq!(waits(&offer(Some("1"), false, true), Some("1")), None);
        // A new version, undeclared: it waits, by its version.
        assert_eq!(waits(&offer(Some("2"), false, true), Some("1")), Some("2".into()));
        assert_eq!(waits(&offer(Some("2"), false, true), None), Some("2".into()));
        // A release that names none, or none that is one, cannot be shown to be declared.
        assert_eq!(waits(&offer(None, false, true), Some("1")), Some("unknown".into()));
        assert_eq!(waits(&offer(Some("../2"), false, true), Some("1")), Some("unknown".into()));
    }

    #[test]
    fn the_bundle_is_the_version_the_offer_named() {
        assert!(bundle_is_offered(&offer(Some("2"), true, true), Some("2")).is_ok());
        assert!(bundle_is_offered(&offer(Some("1"), false, true), Some("2")).is_err(), "a mislabelled release");
        assert!(bundle_is_offered(&offer(Some("2"), true, true), None).is_err(), "a bundle that names none");
        // An offer that names none (an older global): the bundle decides nothing more.
        assert!(bundle_is_offered(&json!({ "version": "0.3.0" }), Some("2")).is_ok());
        assert!(bundle_is_offered(&json!({ "version": "0.3.0" }), None).is_ok());
    }
}
