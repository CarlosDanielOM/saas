//! Disposable MongoDB and Redis fixture for the ignored OAuth API flow.
//!
//! Callers pass loopback or named fixture addresses. This module never calls
//! `get_mongo_client` or `get_redis_client`, never flushes a database, and
//! deletes only `oauth:*` keys created after the empty precheck.

use redis::aio::ConnectionManager;
use std::sync::atomic::{AtomicBool, Ordering};

const SCAN_PAGES: u32 = 64;
const SCAN_COUNT: u32 = 200;

/// Task-owned empty database and a Redis connection whose `oauth:*` keyspace
/// was empty when [`OauthFixture::connect`] returned.
pub struct OauthFixture {
    client: mongodb::Client,
    database_name: String,
    redis: ConnectionManager,
    armed: AtomicBool,
}

impl OauthFixture {
    /// Requires `OAUTH_API_FIXTURE_ACK=disposable`, a credential-free URI on an
    /// allowed host, and `OAUTH_API_FIXTURE_DATABASE` matching
    /// `oauth_api_fixture_[a-z0-9]{8,40}`.
    pub async fn connect() -> Self {
        assert_eq!(
            std::env::var("OAUTH_API_FIXTURE_ACK").as_deref(),
            Ok("disposable"),
            "OAUTH_API_FIXTURE_ACK=disposable is required"
        );
        let mongo_uri = allowed_uri("OAUTH_API_FIXTURE_MONGO_URI");
        let redis_url = allowed_uri("OAUTH_API_FIXTURE_REDIS_URL");
        let database_name = fixture_database_name();
        let client = mongodb::Client::with_uri_str(&mongo_uri)
            .await
            .unwrap_or_else(|_| panic!("fixture MongoDB client was rejected"));
        let database = client.database(&database_name);
        let names = database
            .list_collection_names()
            .await
            .unwrap_or_else(|_| panic!("fixture database could not be listed"));
        assert!(names.is_empty(), "fixture database must have no collections");
        let redis_client = redis::Client::open(redis_url)
            .unwrap_or_else(|_| panic!("fixture Redis URL was rejected"));
        let redis = ConnectionManager::new(redis_client)
            .await
            .unwrap_or_else(|_| panic!("fixture Redis connection was rejected"));
        let existing = scan_oauth_keys(&redis)
            .await
            .unwrap_or_else(|_| panic!("fixture Redis oauth key scan failed"));
        assert!(existing.is_empty(), "fixture Redis must have no oauth:* keys");
        Self {
            client,
            database_name,
            redis,
            armed: AtomicBool::new(true),
        }
    }

    pub fn database(&self) -> mongodb::Database {
        self.client.database(&self.database_name)
    }

    pub fn redis(&self) -> ConnectionManager {
        self.redis.clone()
    }

    /// Drops only this fixture database and deletes `oauth:*` keys. A fixture
    /// that never armed leaves both stores untouched.
    pub async fn cleanup(&self) {
        if !self.armed.load(Ordering::SeqCst) {
            return;
        }
        let dropped = self.client.database(&self.database_name).drop().await;
        let deleted = delete_oauth_keys(&self.redis).await;
        dropped.unwrap_or_else(|_| panic!("fixture database drop failed"));
        deleted.unwrap_or_else(|_| panic!("fixture oauth key delete failed"));
    }
}

fn allowed_uri(name: &str) -> String {
    let raw = std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"));
    let url = reqwest::Url::parse(&raw)
        .unwrap_or_else(|_| panic!("{name} must be a parseable credential-free URL"));
    assert!(
        url.username().is_empty() && url.password().is_none(),
        "{name} must not carry credentials"
    );
    assert!(
        matches!(
            url.host_str(),
            Some(
                "127.0.0.1"
                    | "localhost"
                    | "[::1]"
                    | "::1"
                    | "oauth-api-mongo"
                    | "oauth-api-redis"
                    | "mongo-fixture"
                    | "redis-fixture"
            )
        ),
        "{name} host must be loopback or a named oauth fixture host"
    );
    raw
}

fn fixture_database_name() -> String {
    let name = std::env::var("OAUTH_API_FIXTURE_DATABASE")
        .unwrap_or_else(|_| panic!("OAUTH_API_FIXTURE_DATABASE is required"));
    let Some(suffix) = name.strip_prefix("oauth_api_fixture_") else {
        panic!("OAUTH_API_FIXTURE_DATABASE must start with oauth_api_fixture_");
    };
    assert!(
        (8..=40).contains(&suffix.len()) && suffix.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()),
        "OAUTH_API_FIXTURE_DATABASE suffix must match [a-z0-9]{{8,40}}"
    );
    name
}

async fn scan_oauth_keys(redis: &ConnectionManager) -> redis::RedisResult<Vec<String>> {
    let mut connection = redis.clone();
    let mut cursor = 0_u64;
    let mut keys = Vec::new();
    for _ in 0..SCAN_PAGES {
        let (next, found): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("oauth:*")
            .arg("COUNT")
            .arg(SCAN_COUNT)
            .query_async(&mut connection)
            .await?;
        keys.extend(found);
        cursor = next;
        if cursor == 0 {
            return Ok(keys);
        }
    }
    Err(redis::RedisError::from((
        redis::ErrorKind::Client,
        "oauth fixture SCAN exceeded its page bound",
    )))
}

async fn delete_oauth_keys(redis: &ConnectionManager) -> redis::RedisResult<()> {
    let mut connection = redis.clone();
    let mut cursor = 0_u64;
    for _ in 0..SCAN_PAGES {
        let (next, found): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("oauth:*")
            .arg("COUNT")
            .arg(SCAN_COUNT)
            .query_async(&mut connection)
            .await?;
        if !found.is_empty() {
            let _: i64 = redis::cmd("DEL").arg(found).query_async(&mut connection).await?;
        }
        cursor = next;
        if cursor == 0 {
            return Ok(());
        }
    }
    Err(redis::RedisError::from((
        redis::ErrorKind::Client,
        "oauth fixture SCAN exceeded its page bound",
    )))
}
