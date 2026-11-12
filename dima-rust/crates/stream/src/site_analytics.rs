//! Public site analytics (`utils/siteanalytics.ts`). Callers own scheduling and supply stores,
//! a clock and startup configuration. All calls have deadlines; this crate reads no environment.
//! Counter aliases retain their legacy mirror fields, including negative and unknown counters.
use crate::{Error, bounded};
use dima_core::Clock;
use dima_store::dragonfly::Dragonfly;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub const SITE_ANALYTICS_KEY: &str = "site:analytics:channels";
pub const LIVE_CHANNELS_KEY: &str = "site:analytics:live:channels";
pub const PROFILE_CACHE_PREFIX: &str = "site:analytics:profile:";
pub const START_KEY: &str = "site:analytics:start";

#[derive(Debug, Clone)]
pub struct Config {
    /// Empty in production; tests isolate keys with an owned prefix.
    pub key_prefix: String,
    /// No deadline in the reference. Thirty seconds bounds a hung store operation.
    pub store_deadline: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            key_prefix: String::new(),
            store_deadline: Duration::from_secs(30),
        }
    }
}
#[derive(Clone)]
pub struct SiteAnalytics {
    cache: Dragonfly,
    clock: Arc<dyn Clock>,
    config: Config,
}
fn field(filter: &str) -> &str {
    match filter {
        "registered" => "registered_users",
        "live" => "live_users",
        "active" => "authorized_accounts",
        _ => filter,
    }
}
fn mirror(filter: &str) -> Option<&str> {
    match filter {
        "registered_users" => Some("registered"),
        "live_users" => Some("live"),
        "authorized_accounts" => Some("active"),
        _ => None,
    }
}
impl SiteAnalytics {
    pub fn new(cache: Dragonfly, clock: Arc<dyn Clock>, config: Config) -> Self {
        Self {
            cache,
            clock,
            config,
        }
    }
    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.config.key_prefix)
    }
    /// A scalar string or null for a nonempty filter; an object of strings for absent/empty.
    pub async fn get_site_analytics(&self, filter: Option<&str>) -> Result<Value, Error> {
        let key = self.key(SITE_ANALYTICS_KEY);
        if let Some(filter) = filter.filter(|s| !s.is_empty()) {
            let value = bounded(
                self.config.store_deadline,
                self.cache.hget(&key, field(filter)),
            )
            .await?;
            return Ok(value
                .map(|v| json!(String::from_utf8_lossy(&v)))
                .unwrap_or(Value::Null));
        }
        let pairs = bounded(self.config.store_deadline, self.cache.hgetall(&key)).await?;
        Ok(Value::Object(
            pairs.into_iter().map(|(k, v)| (k, json!(v))).collect(),
        ))
    }
    pub async fn increment_site_analytics(&self, filter: &str, value: i64) -> Result<(), Error> {
        let field = field(filter);
        let key = self.key(SITE_ANALYTICS_KEY);
        let mut command = redis::cmd("HINCRBY");
        command.arg(&key).arg(field).arg(value);
        bounded(
            self.config.store_deadline,
            self.cache.query::<i64>(&command),
        )
        .await?;
        if let Some(legacy) = mirror(field) {
            let mut command = redis::cmd("HINCRBY");
            command.arg(&key).arg(legacy).arg(value);
            bounded(
                self.config.store_deadline,
                self.cache.query::<i64>(&command),
            )
            .await?;
        }
        Ok(())
    }
    pub async fn decrement_site_analytics(&self, filter: &str, value: i64) -> Result<(), Error> {
        let negative = value
            .checked_neg()
            .ok_or_else(|| Error::Invalid("counter amount out of range".into()))?;
        self.increment_site_analytics(filter, negative).await
    }
}
