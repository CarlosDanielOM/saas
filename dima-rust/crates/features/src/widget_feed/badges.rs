//! Badge refreshes: channel overrides global, 6h/1h freshness, 60s retry on failure.
use super::model::{BadgeLookup, FeedError, bound_bytes, string};
use dima_core::Clock;
use dima_http::guard::BoxFuture;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
/// Later Twitch wiring supplies a bounded Helix badge response; no environment or auth here.
pub trait BadgeSource: Send + Sync {
    /// `None` is the global badge set; `Some(channel)` is channel-specific.
    fn fetch<'a>(&'a self, channel: Option<&'a str>) -> BoxFuture<'a, Result<Value, String>>;
}
/// What chat publication needs. An injected cache or a deterministic recording may implement it.
pub trait Badges: Send + Sync {
    /// Resolve channel overrides; a failure must not poison future deliveries.
    fn lookup<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<BadgeLookup, FeedError>>;
}
struct Entry {
    value: BadgeLookup,
    expires: i64,
    used: u64,
}
struct State {
    entries: BTreeMap<String, Entry>,
    counter: u64,
}
/// At most 500 channel sets plus global. One owned refresh at a time, all calls have a deadline.
pub struct BadgeCache {
    source: Arc<dyn BadgeSource>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}
impl BadgeCache {
    /// Create an empty cache, with clock supplied by startup.
    pub fn new(source: Arc<dyn BadgeSource>, clock: Arc<dyn Clock>) -> Self {
        Self {
            source,
            clock,
            state: Mutex::new(State {
                entries: BTreeMap::new(),
                counter: 0,
            }),
        }
    }
    async fn read(&self, channel: Option<&str>) -> Result<BadgeLookup, FeedError> {
        let key = channel.unwrap_or("").to_owned();
        let mut state = tokio::time::timeout(Duration::from_secs(10), self.state.lock())
            .await
            .map_err(|_| FeedError("widget_badge_busy"))?;
        state.counter = state.counter.wrapping_add(1);
        let used = state.counter;
        let now = self.clock.now_ms();
        if let Some(e) = state.entries.get_mut(&key) {
            e.used = used;
            if e.expires > now {
                return Ok(e.value.clone());
            }
        }
        let response =
            tokio::time::timeout(Duration::from_secs(5), self.source.fetch(channel)).await;
        let decoded = match response {
            Ok(Ok(v)) => decode(&v),
            _ => Err(FeedError("widget_badge_fetch_failed")),
        };
        let (value, ttl) = match decoded {
            Ok(v) => (v, if channel.is_none() { 21600000 } else { 3600000 }),
            Err(_) => (
                state
                    .entries
                    .get(&key)
                    .map(|e| e.value.clone())
                    .unwrap_or_default(),
                60000,
            ),
        };
        if !state.entries.contains_key(&key)
            && !key.is_empty()
            && state.entries.keys().filter(|k| !k.is_empty()).count() >= 500
            && let Some(old) = state
                .entries
                .iter()
                .filter(|(k, _)| !k.is_empty())
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone())
        {
            state.entries.remove(&old);
        }
        state.entries.insert(
            key,
            Entry {
                value: value.clone(),
                expires: now.saturating_add(ttl),
                used,
            },
        );
        Ok(value)
    }
}
impl Badges for BadgeCache {
    fn lookup<'a>(&'a self, channel: &'a str) -> BoxFuture<'a, Result<BadgeLookup, FeedError>> {
        Box::pin(async move {
            super::model::id(channel)?;
            let mut global = self.read(None).await?;
            global.extend(self.read(Some(channel)).await?);
            Ok(global)
        })
    }
}
/// Validate and shape a Helix response, bounded at 2,048 badge versions and 4 MiB.
pub fn decode(body: &Value) -> Result<BadgeLookup, FeedError> {
    bound_bytes(body, 4 * 1024 * 1024)?;
    let rows = body["data"]
        .as_array()
        .ok_or(FeedError("invalid_widget_badges"))?;
    let mut out = BadgeLookup::new();
    for set in rows {
        if !set["set_id"].is_string() {
            return Err(FeedError("invalid_widget_badges"));
        }
        for b in set["versions"]
            .as_array()
            .ok_or(FeedError("invalid_widget_badges"))?
        {
            if [
                "id",
                "title",
                "image_url_1x",
                "image_url_2x",
                "image_url_4x",
            ]
            .iter()
            .any(|key| !b[key].is_string())
            {
                return Err(FeedError("invalid_widget_badges"));
            }
            let key = format!("{}/{}", string(&set["set_id"]), string(&b["id"]));
            let title = string(&b["title"]);
            if key.len() > 257 || title.chars().count() > 256 || out.len() >= 2048 {
                return Err(FeedError("widget_badge_limit"));
            }
            for key in ["image_url_1x", "image_url_2x", "image_url_4x"] {
                if string(&b[key]).chars().count() > 2048 {
                    return Err(FeedError("widget_badge_url_limit"));
                }
            }
            out.insert(key,serde_json::json!({"title":title,"images":{"1x":b["image_url_1x"],"2x":b["image_url_2x"],"4x":b["image_url_4x"]}}));
        }
    }
    Ok(out)
}
