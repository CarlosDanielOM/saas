//! Shared helpers for the `dragonfly_*` tests: the local Dragonfly from `DIMA_TEST_DRAGONFLY`,
//! logical databases 8 to 11 only (the range these tests own on the shared server), a unique key
//! prefix per test, and clean-up of what it made. With `DIMA_TEST_REQUIRE_STORES=1` (set by
//! `tools/test-env`, `MIGRATION.md` section 8) a missing server fails the test instead of skipping.
#![allow(dead_code)]

use anyhow::{Context, Result};
use dima_store::dragonfly::{Dragonfly, DragonflyConfig, Hooks};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// `DIMA_TEST_REQUIRE_STORES=1`: a test that needs the server must fail when it is missing.
pub fn stores_required() -> bool {
    std::env::var("DIMA_TEST_REQUIRE_STORES").is_ok_and(|value| value == "1")
}

/// Settings for logical database `db` (8 to 11), or `None` (with a message) when
/// `DIMA_TEST_DRAGONFLY` is not set. Panics (fails the test) instead when stores are required.
pub fn config(db: u8) -> Option<DragonflyConfig> {
    assert!(
        (8..=11).contains(&db),
        "tests use logical databases 8 to 11 only"
    );
    let Ok(address) = std::env::var("DIMA_TEST_DRAGONFLY") else {
        assert!(
            !stores_required(),
            "DIMA_TEST_DRAGONFLY is not set but DIMA_TEST_REQUIRE_STORES=1: a missing store fails the test"
        );
        eprintln!("skipped: DIMA_TEST_DRAGONFLY is not set (eval \"$(dima-rust/tools/test-env)\")");
        return None;
    };
    let (host, port) = address.rsplit_once(':')?;
    // The port carries the database path, as the test rig does: redis://host:port/db.
    Some(DragonflyConfig::from_env_values(
        Some(host),
        Some(&format!("{port}/{db}")),
        "dima-store-test",
    ))
}

/// Connects to database `db`, or `None` when the store is not configured.
pub async fn connect(db: u8) -> Result<Option<Dragonfly>> {
    let Some(config) = config(db) else {
        return Ok(None);
    };
    Ok(Some(
        Dragonfly::connect(config, Hooks::default())
            .await
            .context("connect to the local Dragonfly")?,
    ))
}

/// A key prefix no other test run uses: `dima-test:<name>:<nanos>-<pid>-<n>:`.
pub fn prefix(name: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "dima-test:{name}:{nanos}-{}-{}:",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Deletes every key under `prefix` (SCAN + DEL; never FLUSH).
pub async fn cleanup(dragonfly: &Dragonfly, prefix: &str) -> Result<()> {
    let mut scan = dragonfly.scan(&format!("{prefix}*"), Some(1000));
    let mut keys = Vec::new();
    while let Some(page) = scan.next_page().await? {
        keys.extend(page);
    }
    for key in keys {
        let _: i64 = dragonfly.query(redis::cmd("DEL").arg(key)).await?;
    }
    Ok(())
}

/// Queue payloads with the text the brief requires: emoji (with a ZWJ sequence and a flag),
/// combining marks, right-to-left text, embedded quotes, backslashes and newlines, a slash,
/// U+2028, a control character.
pub const AWKWARD_TEXT: &[&str] = &[
    "plain",
    "emoji 🎉 👩‍👩‍👧 🇲🇽 ❤️",
    "combining e\u{301} n\u{303} a\u{30a}\u{301}",
    "rtl مرحبا بالعالم שלום",
    "quotes \"double\" 'single' `back` \\ backslash",
    "lines\nsecond\r\nthird\ttab",
    "slash / and \u{2028} separator \u{7}",
    "",
];
