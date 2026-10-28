//! Which server version is newer (FR-20.20, plan step P1-8b).
//!
//! ⚠ The same rules as the desktop's updater (`packages/desktop/src-tauri/src/update.rs`) and the
//! hub's `services/src/biz/desktop/version.ts`: strict `N.N.N[-pre][+build]`, semver precedence, no
//! downgrade, and an unreadable version on either side refused. A master and lgrai.app that read a
//! version differently either update in a loop or never update.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Empty for a release.
    pub pre: String,
}

/// `1.2.3`, `v1.2.3`, `1.2.3-beta.1`, `1.2.3+build`. `1.2` and `1.2.3.4` are refused, not coerced:
/// a tag `v1.2` read as `1.2.0` could ship as an "upgrade" over `1.2.9`.
pub fn parse(raw: &str) -> Option<Version> {
    let s = raw.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let s = s.split('+').next()?;
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    if let Some(p) = pre {
        if p.is_empty() || p.split('.').any(|id| id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
            return None;
        }
    }
    let pre = pre.unwrap_or_default().to_string();
    let mut parts = core.split('.');
    let num = |p: Option<&str>| -> Option<u64> {
        let p = p?;
        (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).then(|| p.parse().ok()).flatten()
    };
    let (major, minor, patch) = (num(parts.next())?, num(parts.next())?, num(parts.next())?);
    if parts.next().is_some() {
        return None;
    }
    Some(Version { major, minor, patch, pre })
}

fn cmp_pre(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }
    // A release outranks any prerelease of itself (semver §11.3).
    if a.is_empty() {
        return Ordering::Greater;
    }
    if b.is_empty() {
        return Ordering::Less;
    }
    let (mut ai, mut bi) = (a.split('.'), b.split('.'));
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<u64>().ok(), y.parse::<u64>().ok()) {
                    (Some(p), Some(q)) => p.cmp(&q),
                    // Numeric identifiers rank below alphanumeric ones (§11.4.3).
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

pub fn compare(a: &Version, b: &Version) -> Ordering {
    a.major.cmp(&b.major).then(a.minor.cmp(&b.minor)).then(a.patch.cmp(&b.patch)).then_with(|| cmp_pre(&a.pre, &b.pre))
}

/// Is `candidate` strictly newer than `current`? Equality is not an upgrade (reinstalling the
/// running version is how an updater loops), and an unreadable version on either side is refused.
pub fn is_upgrade(current: &str, candidate: &str) -> bool {
    match (parse(current), parse(candidate)) {
        (Some(cur), Some(next)) => compare(&next, &cur) == Ordering::Greater,
        _ => false,
    }
}

/// The versions in `names` that parse, newest first. What `versions/` holds, ordered.
pub fn newest_first<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut v: Vec<(Version, String)> = names.into_iter().filter_map(|n| parse(n).map(|p| (p, n.to_string()))).collect();
    v.sort_by(|a, b| compare(&b.0, &a.0));
    v.into_iter().map(|(_, n)| n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_a_release_tags_and_refuses_the_rest() {
        assert_eq!(parse("0.1.0").unwrap(), Version { major: 0, minor: 1, patch: 0, pre: String::new() });
        assert_eq!(parse("v1.2.3-rc.1+abc").unwrap().pre, "rc.1");
        for bad in ["", "1.2", "1.2.3.4", "1.2.x", "latest", "1..3", "-1.2.3", "1.2.3-", "1.2.3-rc..1", "1.2.3-rc!", "１.2.3"] {
            assert!(parse(bad).is_none(), "{bad:?} parsed");
        }
    }

    #[test]
    fn never_a_downgrade_and_never_the_same_version() {
        assert!(is_upgrade("0.1.0", "0.1.1"));
        assert!(is_upgrade("0.1.9", "0.2.0"));
        assert!(!is_upgrade("0.2.0", "0.1.9"));
        assert!(!is_upgrade("0.1.0", "0.1.0"));
        assert!(!is_upgrade("0.1.0", "v0.1.0+other-build"));
    }

    #[test]
    fn a_prerelease_sorts_before_its_release() {
        assert!(is_upgrade("0.2.0-rc.1", "0.2.0"));
        assert!(!is_upgrade("0.2.0", "0.2.0-rc.9"));
        assert!(is_upgrade("0.2.0-rc.2", "0.2.0-rc.10"), "numeric identifiers compare as numbers");
        assert!(is_upgrade("0.2.0-rc.1", "0.2.0-rc.a"), "numeric ranks below alphanumeric");
    }

    #[test]
    fn an_unreadable_version_on_either_side_installs_nothing() {
        assert!(!is_upgrade("dev", "0.1.0"));
        assert!(!is_upgrade("0.1.0", "0.2"));
    }

    #[test]
    fn versions_order_newest_first_and_skip_what_is_not_one() {
        assert_eq!(newest_first(["0.1.0", ".0.2.0.partial", "0.10.0", "0.2.0", "notes"]), ["0.10.0", "0.2.0", "0.1.0"]);
    }
}
