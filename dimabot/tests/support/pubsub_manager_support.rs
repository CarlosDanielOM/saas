//! Fixtures for `tests/pubsub_manager.rs`.
//!
//! Two independent pieces:
//!
//! * the reader for the externally written source oracle
//!   (`tests/fixtures/pubsub_manager_reference.cjs`), which verifies the fixture
//!   digest, the fixture's own provenance digest and the recorded oracle digest;
//! * a private, task-owned Redis probe and channel namespace for the adapter
//!   suites. Nothing here connects unless a test calls it, and no endpoint is
//!   ever read from an implicit default.
//!
//! The probe is an independent subscriber: it uses the real driver, subscribes
//! to one task-owned channel, and forwards raw payload strings to the test. It
//! exists so a test can prove that the manager's `PUBLISH` really reached a
//! subscriber, and so a test can inject a payload the manager would never
//! produce (malformed JSON).
//!
//! Cleanup is read-only by design: a Pub/Sub channel holds no data, so the
//! guard only lists the channels under its own random prefix and reports any
//! that are still subscribed. Every task-owned socket is closed by dropping the
//! probe or the manager under test.

#![allow(dead_code)]

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use redis::aio::ConnectionManager;
use serde_json::Value;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, timeout},
};

#[path = "sha256.rs"]
mod digest;

pub const FILE: &str = "pubsub-manager-reference.json";
pub const ORACLE: &str = "tests/fixtures/pubsub_manager_reference.cjs";

/// Loads the externally written oracle and verifies both digests: the one the
/// harness supplies for the fixture itself, and the oracle writer recorded in
/// the fixture's provenance.
pub fn fixture() -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .canonicalize()
        .expect("manifest directory");
    let workspace = root.parent().expect("workspace root").to_path_buf();
    let directory = PathBuf::from(
        std::env::var_os("DIMA_PUBSUB_MANAGER_FIXTURE_DIR")
            .expect("external fixture directory"),
    );
    assert!(
        directory.is_absolute(),
        "fixture directory must be absolute"
    );
    assert_eq!(
        directory.canonicalize().expect("fixture directory"),
        directory
    );
    assert!(
        !directory.starts_with(&workspace),
        "fixture must live outside the workspace"
    );
    let expected =
        std::env::var("DIMA_PUBSUB_MANAGER_FIXTURE_SHA256").expect("fixture digest");
    assert!(
        expected.len() == 64
            && expected
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "fixture digest must be lowercase hex"
    );
    let file = directory.join(FILE);
    assert!(
        std::fs::symlink_metadata(&file)
            .expect("fixture metadata")
            .file_type()
            .is_file(),
        "fixture must be a regular file"
    );
    let bytes = std::fs::read(&file).expect("fixture bytes");
    assert_eq!(
        digest::sha256_hex(&bytes),
        expected,
        "fixture digest mismatch"
    );
    let fixture: Value = serde_json::from_slice(&bytes).expect("fixture JSON");
    let recorded = fixture["provenance"]["oracleSha256"]
        .as_str()
        .expect("oracle digest");
    assert_eq!(
        digest::sha256_hex(&std::fs::read(root.join(ORACLE)).expect("oracle source")),
        recorded,
        "the oracle writer changed after the fixture was recorded"
    );
    fixture
}

pub fn fixture_case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("fixture case {name}"))
}

pub fn fixture_case_names(fixture: &Value) -> Vec<String> {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .map(|case| case["name"].as_str().expect("case name").to_owned())
        .collect()
}

/// Every case the native side can replay, in recorded order.
pub fn native_cases<'a>(fixture: &'a Value) -> Vec<&'a Value> {
    fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .filter(|case| case["replay"].as_str() == Some("native"))
        .collect()
}

/// Case input as the recorded JSON string, so property order survives.
pub fn input_json(case: &Value, key: &str) -> &str {
    case["input"][key]
        .as_str()
        .unwrap_or_else(|| panic!("case {} input.{key} must be a string", case["name"]))
}

/// Explicit disposable Redis endpoint. No default host, port or database.
pub fn fixture_url() -> String {
    assert_eq!(
        std::env::var("DIMA_RUST_TEST_RESOURCE_OWNER").as_deref(),
        Ok("dimabot-migration"),
        "the fixture must be acknowledged as task-owned"
    );
    let url = std::env::var("DIMA_TEST_REDIS_URL").expect("explicit disposable fixture URL");
    let _ = parse_fixture_url(&url);
    url
}

/// Strict parsed allowlist; no credentials, TLS, query, fragment, or database.
pub fn parse_fixture_url(url: &str) -> (String, u16) {
    let authority = url
        .strip_prefix("redis://")
        .expect("plain redis scheme")
        .strip_suffix('/')
        .unwrap_or_else(|| url.strip_prefix("redis://").unwrap());
    let (host, port) = authority.rsplit_once(':').expect("explicit host:port");
    assert!(
        [
            "keyword-redis",
            "redis-fixture",
            "pubsub-redis",
            "127.0.0.1",
            "localhost",
            "[::1]"
        ]
        .contains(&host),
        "fixture host required"
    );
    assert!(!port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()));
    let port: u16 = port.parse().unwrap();
    assert_ne!(port, 0);
    (host.trim_matches(['[', ']']).into(), port)
}

/// A random per-run namespace. Channels are ephemeral, so isolation is a unique
/// name plus a read-only leak check; nothing is ever deleted or flushed.
pub struct Channels {
    url: String,
    token: String,
}

impl Channels {
    pub fn new() -> Self {
        let url = fixture_url();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        Self {
            url,
            token: format!("dima:test:pubsub:{}:{nanos:x}", std::process::id()),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// `dima:test:pubsub:<run>:<name>`, unique for this run.
    pub fn channel(&self, name: &str) -> String {
        format!("{}:{name}", self.token)
    }

    /// Read-only check that no subscription from this run is still attached.
    pub async fn assert_released(&self, manager: &ConnectionManager) {
        let pattern = format!("{}:*", self.token);
        let mut connection = manager.clone();
        let channels: Vec<String> = redis::cmd("PUBSUB")
            .arg("CHANNELS")
            .arg(&pattern)
            .query_async(&mut connection)
            .await
            .expect("PUBSUB CHANNELS");
        assert!(
            channels.is_empty(),
            "task-owned channels still subscribed: {channels:?}"
        );
    }
}

/// An independent subscriber used to observe and inject raw payloads.
pub struct Probe {
    channel: String,
    messages: mpsc::UnboundedReceiver<String>,
    task: Option<JoinHandle<()>>,
}

impl Probe {
    pub async fn new(url: &str, channel: &str) -> Self {
        let client = redis::Client::open(url).expect("fixture client");
        let mut pubsub = client.get_async_pubsub().await.expect("probe subscriber");
        pubsub.subscribe(channel).await.expect("probe subscribe");
        let (sender, messages) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut stream = pubsub.into_on_message();
            while let Some(message) = stream.next().await {
                let Ok(payload) = message.get_payload::<String>() else {
                    break;
                };
                if sender.send(payload).is_err() {
                    break;
                }
            }
        });
        Self {
            channel: channel.to_owned(),
            messages,
            task: Some(task),
        }
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    /// Waits for one payload, bounded by `limit`.
    pub async fn next(&mut self, limit: Duration) -> Option<String> {
        timeout(limit, self.messages.recv())
            .await
            .ok()
            .flatten()
    }

    pub async fn shutdown(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Publishes a raw payload from an independent connection and returns the
/// receiver count reported by Redis.
pub async fn raw_publish(url: &str, channel: &str, payload: &str) -> i64 {
    let mut connection = raw_connection(url).await;
    redis::cmd("PUBLISH")
        .arg(channel)
        .arg(payload)
        .query_async(&mut connection)
        .await
        .expect("raw publish")
}

pub async fn raw_connection(url: &str) -> ConnectionManager {
    redis::Client::open(url)
        .expect("fixture client")
        .get_connection_manager()
        .await
        .expect("fixture connection manager")
}

/// Bounded wait for a condition that the fixture server, not a local loop,
/// satisfies. Used instead of a fixed sleep so a slow fixture cannot fail a
/// test and an idle fixture cannot spin.
pub async fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let mut remaining = 50;
    while remaining > 0 {
        if condition() {
            return true;
        }
        remaining -= 1;
        sleep(Duration::from_millis(20)).await;
    }
    condition()
}

/// Counter shared with a handler closure.
#[derive(Clone, Default)]
pub struct Counted(Arc<AtomicUsize>);

impl Counted {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    pub fn value(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}
