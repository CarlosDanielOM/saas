#![cfg(feature = "plan-cache")]

use dima_rust::utils::plan_cache_fence::*;
#[path = "fixtures/plan_cache_fence_source.rs"]
mod source;

#[test]
fn five_lua_scripts_match_the_actual_typescript_sources() {
    let actual = [
        ("WRITE_PLAN_ACCOUNT_SCRIPT", WRITE_PLAN_ACCOUNT_SCRIPT),
        ("CHECK_PLAN_ACCOUNTS_SCRIPT", CHECK_PLAN_ACCOUNTS_SCRIPT),
        ("ACCEPT_PLAN_CREDITS_SCRIPT", ACCEPT_PLAN_CREDITS_SCRIPT),
        ("INVALIDATE_PLAN_SCRIPT", INVALIDATE_PLAN_SCRIPT),
        ("SYNC_CREDITS_SCRIPT", SYNC_CREDITS_SCRIPT),
    ];
    assert_eq!(actual.as_slice(), source::SOURCE_SCRIPTS);
    assert_eq!(PLAN_CACHE_VERSION_FIELD, source::SOURCE_VERSION_FIELD);
}

#[test]
fn version_and_key_helpers_match_the_typescript_oracle() {
    for &(at, key, expected) in source::VERSION_CASES {
        assert_eq!(
            plan_cache_version(at, key).unwrap(),
            expected,
            "{at:?}/{key:?}"
        );
    }
    for &(id, expected) in source::KEY_CASES {
        assert_eq!(plan_cache_fence_key(id), expected);
    }
    // Deliberate typed boundary: do not reproduce invalid JS Date's NaN version.
    assert_eq!(
        plan_cache_version(Some(i64::MAX), Some("event")),
        Err(FenceError::InvalidDate)
    );
    assert_eq!(
        plan_cache_version(Some(i64::MAX), Some("")),
        Ok(String::new())
    );
}
