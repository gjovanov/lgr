//! What kind of build this is: `config/src/build-kind.json`, embedded here as the API's bundle embeds
//! it (`services/biz/crypto/test-keys.ts`).
//!
//! FR-20 plan F.4.4: a TEST build is made only for the field lanes' throwaway global (global-eph),
//! which signs licences with keys made for one run. Such a build also trusts the licence keys an
//! operator names in `LGR_TEST_LICENCE_KEYS` (`config/api.env`, which the API reads too). Any other
//! build ignores them.
//!
//! ⚠ The committed file says false (a unit test of the API keeps it so), and every release path
//! refuses a test build: `scripts/check-package.ts`, the server release workflow and
//! `scripts/deploy-prod.sh`.

const FILE: &str = include_str!("../../config/src/build-kind.json");

/// True only in a build made from a tree whose `build-kind.json` says `"testKeys": true`.
pub fn test_keys() -> bool {
    from_json(FILE)
}

fn from_json(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|v| v["testKeys"] == serde_json::Value::Bool(true))
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_a_literal_true_makes_a_test_build() {
        assert!(super::from_json(r#"{"about": "x", "testKeys": true}"#));
        for text in [r#"{"testKeys": false}"#, r#"{"testKeys": "true"}"#, r#"{"testKeys": 1}"#, "{}", "[true]", "not json", ""] {
            assert!(!super::from_json(text), "{text}");
        }
    }

    #[test]
    fn this_tree_is_no_test_build() {
        assert!(!super::test_keys(), "config/src/build-kind.json says testKeys: a test build is never committed");
    }
}
