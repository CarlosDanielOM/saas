//! Subscription intervals from `utils/stream_analytics.ts` (start/end only).
//! Each call performs at most one atomic write, with a 10,000-key replay history.
//! Like the reference, a concurrent first start with a different key can fail with E11000;
//! callers must retry failed journal deliveries. Older events are deliberately ignored.
//! Global key lookup, equal-time end precedence and missing-key non-deduplication are retained.
use crate::{Error, bounded};
use bson::{Bson, DateTime, Document, doc};
use dima_core::Clock;
use dima_model::stream_subscription_ledgers::INFO;
use dima_store::mongo::{MongoStore, WriteContext, update::UpdateOptions};
#[cfg(feature = "test-util")]
use futures_util::future::BoxFuture;
use std::{sync::Arc, time::Duration};

#[derive(Clone, Debug)]
pub struct Config {
    pub store_deadline: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            store_deadline: Duration::from_secs(5),
        }
    }
}
/// Edge-normalized domain envelope values. Dates are parsed by the caller; absent dates use clock.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct Start {
    pub streamer_id: String,
    pub user_id: String,
    pub streamer_login: Option<String>,
    pub streamer_name: Option<String>,
    pub user_login: Option<String>,
    pub user_name: Option<String>,
    pub tier: Option<String>,
    pub is_gift: Option<bool>,
    pub subbed_at: Option<DateTime>,
    #[serde(rename = "eventKey")]
    pub event_key: Option<String>,
}
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct End {
    pub streamer_id: String,
    pub user_id: String,
    pub ended_at: Option<DateTime>,
    #[serde(rename = "eventKey")]
    pub event_key: Option<String>,
}
#[derive(Clone)]
pub struct SubscriptionLedger {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    config: Config,
    #[cfg(feature = "test-util")]
    hook: Option<Arc<dyn Fn(bool) -> BoxFuture<'static, ()> + Send + Sync>>,
}
impl SubscriptionLedger {
    pub fn new(store: MongoStore, clock: Arc<dyn Clock>, config: Config) -> Result<Self, Error> {
        if config.store_deadline.is_zero() {
            return Err(Error::Invalid("zero store deadline".into()));
        }
        Ok(Self {
            store,
            clock,
            config,
            #[cfg(feature = "test-util")]
            hook: None,
        })
    }
    /// Test hook: false immediately before the write, true immediately after acknowledgement.
    #[cfg(feature = "test-util")]
    pub fn with_write_hook(
        mut self,
        hook: Arc<dyn Fn(bool) -> BoxFuture<'static, ()> + Send + Sync>,
    ) -> Self {
        self.hook = Some(hook);
        self
    }
    async fn hook(&self, after: bool) {
        #[cfg(feature = "test-util")]
        if let Some(hook) = &self.hook {
            hook(after).await;
        }
        let _ = after;
    }
    async fn find(&self, filter: Document, latest: bool) -> Result<Option<Document>, Error> {
        let collection = self.store.documents(INFO.name);
        let mut query = collection.find_one(filter);
        if latest {
            query = query.sort(doc! {"last_event_at":-1});
        }
        bounded(self.config.store_deadline, query).await
    }
    async fn applied(&self, key: Option<&str>) -> Result<bool, Error> {
        match key {
            Some(k) => Ok(self
                .find(doc! {"applied_event_keys":k}, false)
                .await?
                .is_some()),
            None => Ok(false),
        }
    }
    pub async fn record_subscription_ledger_start(&self, input: &Start) -> Result<(), Error> {
        self.record(
            &input.streamer_id,
            &input.user_id,
            input.subbed_at,
            input.event_key.as_deref(),
            Some(input),
        )
        .await
    }
    pub async fn record_subscription_ledger_end(&self, input: &End) -> Result<(), Error> {
        self.record(
            &input.streamer_id,
            &input.user_id,
            input.ended_at,
            input.event_key.as_deref(),
            None,
        )
        .await
    }
    async fn record(
        &self,
        streamer: &str,
        user: &str,
        at: Option<DateTime>,
        key: Option<&str>,
        start: Option<&Start>,
    ) -> Result<(), Error> {
        let streamer = dima_text::trim(streamer);
        let user = dima_text::trim(user);
        if streamer.is_empty() || user.is_empty() {
            return Ok(());
        }
        let key = key.filter(|s| !s.is_empty());
        let at = at.unwrap_or_else(|| DateTime::from_millis(self.clock.now_ms()));
        if self.applied(key).await? {
            return Ok(());
        }
        let identity = doc! {"platform":"twitch","streamer_id":streamer,"user_id":user};
        let latest = self.find(identity.clone(), true).await?;
        if let Some(latest) = &latest {
            let last = latest
                .get_datetime("last_event_at")
                .ok()
                .copied()
                .unwrap_or(DateTime::from_millis(0));
            if last > at || (latest.get_str("status").ok() == Some("ended") && last >= at) {
                return Ok(());
            }
        }
        let existing = if start.is_some() {
            let mut filter = identity.clone();
            filter.insert("status", "active");
            self.find(filter, false).await?
        } else {
            latest
        };
        let mut set = doc! {"last_event_at":at};
        if let Some(key) = key {
            set.insert("event_key", key);
        }
        if let Some(s) = start {
            for (k, v) in [
                ("streamer_login", &s.streamer_login),
                ("streamer_name", &s.streamer_name),
                ("user_login", &s.user_login),
                ("user_name", &s.user_name),
            ] {
                set.insert(k, dima_text::trim(v.as_deref().unwrap_or("")));
            }
            let tier = dima_text::trim(s.tier.as_deref().unwrap_or("")).to_lowercase();
            let normalized = match tier.as_str() {
                "prime" | "1000" | "tier1" => "tier1",
                "2000" | "tier2" => "tier2",
                "3000" | "tier3" => "tier3",
                _ => "unknown",
            };
            set.extend(doc!{"sub_tier_raw":tier,"sub_tier_normalized":normalized,"is_gift":s.is_gift.unwrap_or(false),"status":"active","ended_at":Bson::Null});
        } else {
            set.extend(doc! {"status":"ended","ended_at":at});
        }
        let result = if let Some(existing) = existing {
            let mut filter = doc! {"_id":existing.get("_id").cloned().unwrap_or(Bson::Null),"last_event_at":{"$lte":at}};
            let mut update = doc! {"$set":set};
            if let Some(key) = key {
                filter.insert("applied_event_keys", doc! {"$ne":key});
                update.insert(
                    "$push",
                    doc! {"applied_event_keys":{"$each":[key],"$slice":-10000}},
                );
            }
            let prepared = INFO.prepare_update(
                &filter,
                update,
                UpdateOptions::default(),
                &mut WriteContext::new(self.clock.now_ms()),
            )?;
            self.hook(false).await;
            bounded(
                self.config.store_deadline,
                self.store.writes(INFO.name).update_one(&prepared),
            )
            .await
            .map(|_| ())
        } else {
            let mut document = identity;
            document.extend(set);
            document.insert("subbed_at", at);
            document.insert(
                "applied_event_keys",
                key.map_or_else(Vec::<Bson>::new, |k| vec![Bson::String(k.into())]),
            );
            let prepared =
                INFO.prepare_create(&document, &mut WriteContext::new(self.clock.now_ms()))?;
            self.hook(false).await;
            bounded(
                self.config.store_deadline,
                self.store.writes(INFO.name).insert_one(&prepared),
            )
            .await
            .map(|_| ())
        };
        self.hook(true).await;
        match result {
            Err(Error::Write(dima_store::mongo::write::WriteError::Driver(ref e)))
                if dima_store::mongo::error::is_duplicate_key(e) && key.is_some() =>
            {
                if self.applied(key).await? {
                    Ok(())
                } else {
                    result
                }
            }
            _ => result,
        }
    }
}
