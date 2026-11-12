//! Normal follow rate: complete UTC days, the preceding 30 days, excluding attack days.
//!
//! The aggregation intentionally has no platform/status filter on ledger rows: ended edges
//! contribute too. Stream totals can dominate ledger totals. Sparse history (fewer than seven
//! observed days or three completed streams) publishes an explicit null threshold. JSON field
//! names/types also read the value published by the deployed old Rust baseline worker.
//!
//! Old Rust and TypeScript use the same aggregates, calculation, keys, 7-day TTL, 60-second
//! crash receipt and post-query 1-hour reschedule. Old Rust validates nonfinite aggregate data;
//! TypeScript would propagate it and JSON.stringify writes null. This module refuses malformed
//! aggregate rows (the stored model types and production copy contain finite values). The old
//! executable's burst-of-eight/1-second cooldown, 1–5-second idle backoff and 30-second watchdog
//! belong to the future worker. This library processes one due channel per call.
//!
//! Reading values older than one day requests an earlier refresh with SET NX EX 60 and ZADD
//! LT; up to two days old still reads, beyond that returns None. Query failure keeps the due
//! member at its 60-second receipt and never overwrites an older baseline. Cache families are
//! rebuilt in Rust's database 1 at cutover; database 0 stays untouched for rollback.
//!
//! Aggregates return at most 30 daily rows (31 attack rows, including today) and stream with a
//! 32-row driver batch. Mongo maxTimeMS is the reference's 10 seconds; wall deadline defaults
//! to 30 seconds per aggregate and 5 seconds per cache command. Clock/configuration injected.
use crate::{Error, bounded};
use bson::{Bson, DateTime, Document, doc};
use dima_core::Clock;
use dima_store::{
    dragonfly::{Dragonfly, SetOptions, SetOutcome},
    mongo::MongoStore,
};
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc, time::Duration};
pub const DAY: i64 = 86_400_000;
pub const DUE: &str = "follow:defense:baseline:due";
pub fn key(channel: &str) -> String {
    format!("follow:defense:baseline:{channel}")
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefenseBaseline {
    pub calculated_at: i64,
    pub average_daily: f64,
    pub average_stream: f64,
    pub sample_days: usize,
    pub stream_count: f64,
    pub excluded_days: usize,
    pub attack_threshold: Option<f64>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Day {
    #[serde(alias = "_id")]
    pub day: String,
    pub follows: f64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Stream {
    #[serde(alias = "_id")]
    pub day: String,
    pub follows: f64,
    pub count: f64,
}
pub fn calculate_defense_baseline(
    days: &[Day],
    streams: &[Stream],
    excluded: &[String],
    now: i64,
) -> DefenseBaseline {
    let blocked: HashSet<&str> = excluded.iter().map(String::as_str).collect();
    let mut sample_days = HashSet::new();
    let mut daily = 0.0;
    let mut stream_follows = 0.0;
    let mut stream_count = 0.0;
    for day in days.iter().filter(|d| !blocked.contains(d.day.as_str())) {
        sample_days.insert(day.day.as_str());
        daily += day.follows;
    }
    for stream in streams.iter().filter(|d| !blocked.contains(d.day.as_str())) {
        sample_days.insert(stream.day.as_str());
        stream_follows += stream.follows;
        stream_count += stream.count;
    }
    let average_daily =
        daily.max(stream_follows) / 30_usize.saturating_sub(blocked.len()).max(1) as f64;
    let average_stream = if stream_count != 0.0 {
        stream_follows / stream_count
    } else {
        0.0
    };
    DefenseBaseline {
        calculated_at: now,
        average_daily,
        average_stream,
        sample_days: sample_days.len(),
        stream_count,
        excluded_days: blocked.len(),
        attack_threshold: (sample_days.len() >= 7 && stream_count >= 3.0).then(|| {
            500_f64
                .max(2.0 * average_daily)
                .max(2.0 * average_stream)
                .ceil()
        }),
    }
}
fn date(field: &str) -> Document {
    doc! { "$dateToString": { "format":"%Y-%m-%d", "date":field, "timezone":"UTC" } }
}
pub fn pipelines(channel: &str, now: i64) -> [Vec<Document>; 3] {
    let end = DateTime::from_millis(now.div_euclid(DAY) * DAY);
    let start = DateTime::from_millis(end.timestamp_millis() - 30 * DAY);
    [
        vec![
            doc! { "$match": { "followed_id":channel, "followed_at": { "$gte":start,"$lt":end } } },
            doc! { "$group": { "_id":date("$followed_at"), "follows": { "$sum":1 } } },
        ],
        vec![
            doc! { "$match": { "channelID":channel,"status":"offline","started_at": { "$gte":start,"$lt":end },"ended_at": { "$lte":end,"$ne":Bson::Null },"duration_minutes": { "$gt":0 } } },
            doc! { "$group": { "_id":date("$started_at"),"follows": { "$sum":"$follows" },"count": { "$sum":1 } } },
        ],
        vec![
            doc! { "$match": { "targetChannelID":channel,"modeTriggered":"attack","createdAt": { "$gte":start,"$lt":DateTime::from_millis(now) } } },
            doc! { "$group": { "_id":date("$createdAt") } },
        ],
    ]
}
#[derive(Clone, Debug)]
pub struct Config {
    pub mongo_deadline: Duration,
    pub cache_deadline: Duration,
    pub key_prefix: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            mongo_deadline: Duration::from_secs(30),
            cache_deadline: Duration::from_secs(5),
            key_prefix: String::new(),
        }
    }
}
#[derive(Clone)]
pub struct Baselines {
    store: MongoStore,
    cache: Dragonfly,
    clock: Arc<dyn Clock>,
    config: Config,
}
impl Baselines {
    pub fn new(store: MongoStore, cache: Dragonfly, clock: Arc<dyn Clock>, config: Config) -> Self {
        Self {
            store,
            cache,
            clock,
            config,
        }
    }
    fn key(&self, key: &str) -> String {
        format!("{}{key}", self.config.key_prefix)
    }
    pub async fn calculate_at(&self, channel: &str, now: i64) -> Result<DefenseBaseline, Error> {
        let [days, streams, attacks] = pipelines(channel, now);
        let (days, streams, attacks) = tokio::try_join!(
            self.aggregate("follow_relationship_ledgers", days, 30),
            self.aggregate("streamsessions", streams, 30),
            self.aggregate("follow_attack_logs", attacks, 31)
        )?;
        let days: Vec<Day> = days
            .into_iter()
            .map(bson::deserialize_from_document)
            .collect::<Result<_, _>>()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let streams: Vec<Stream> = streams
            .into_iter()
            .map(bson::deserialize_from_document)
            .collect::<Result<_, _>>()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        if days.iter().any(|d| !d.follows.is_finite())
            || streams
                .iter()
                .any(|s| !s.follows.is_finite() || !s.count.is_finite())
        {
            return Err(Error::Invalid("invalid baseline aggregate data".into()));
        }
        let end = dima_text::to_iso_string(now.div_euclid(DAY) * DAY)
            .and_then(|s| s.split('T').next().map(str::to_owned))
            .ok_or_else(|| Error::Invalid("invalid clock".into()))?;
        let excluded: Vec<String> = attacks
            .into_iter()
            .filter_map(|d| d.get_str("_id").ok().map(str::to_owned))
            .filter(|d| d < &end)
            .collect();
        Ok(calculate_defense_baseline(&days, &streams, &excluded, now))
    }
    async fn aggregate(
        &self,
        collection: &str,
        pipeline: Vec<Document>,
        limit: usize,
    ) -> Result<Vec<Document>, Error> {
        bounded(self.config.mongo_deadline, async {
            let mut cursor = self
                .store
                .documents(collection)
                .aggregate(pipeline)
                .max_time(Duration::from_secs(10))
                .batch_size(32)
                .await?;
            let mut rows = Vec::new();
            while let Some(row) = cursor.try_next().await? {
                if rows.len() == limit {
                    return Err(Error::Invalid(
                        "baseline aggregate row limit exceeded".into(),
                    ));
                }
                rows.push(row);
            }
            Ok::<_, Error>(rows)
        })
        .await
    }
    pub async fn refresh_defense_baseline(
        &self,
        channel: &str,
        now: i64,
    ) -> Result<DefenseBaseline, Error> {
        let value = self.calculate_at(channel, now).await?;
        bounded(
            self.config.cache_deadline,
            self.cache.set(
                &self.key(&key(channel)),
                &serde_json::to_vec(&value)?,
                SetOptions::ex(604_800),
            ),
        )
        .await?;
        Ok(value)
    }
    pub async fn get_defense_baseline(
        &self,
        channel: &str,
    ) -> Result<Option<DefenseBaseline>, Error> {
        let raw = bounded(
            self.config.cache_deadline,
            self.cache.get(&self.key(&key(channel))),
        )
        .await?;
        let value = raw
            .as_deref()
            .and_then(|s| serde_json::from_slice::<DefenseBaseline>(s).ok());
        let now = self.clock.now_ms();
        if value
            .as_ref()
            .is_none_or(|v| i128::from(now) - i128::from(v.calculated_at) > i128::from(DAY))
            && matches!(
                bounded(
                    self.config.cache_deadline,
                    self.cache.set(
                        &self.key(&format!("{}:requested", key(channel))),
                        b"1",
                        SetOptions::if_missing_ex(60)
                    )
                )
                .await?,
                SetOutcome::Written
            )
        {
            // Shared zadd has no LT option: use its typed command entry point.
            let mut command = redis::cmd("ZADD");
            command.arg(self.key(DUE)).arg("LT").arg(now).arg(channel);
            bounded(
                self.config.cache_deadline,
                self.cache.query::<i64>(&command),
            )
            .await?;
        }
        Ok(value.filter(|v| i128::from(now) - i128::from(v.calculated_at) <= i128::from(2 * DAY)))
    }
    pub async fn process_defense_baseline(&self) -> Result<bool, Error> {
        let next = bounded(
            self.config.cache_deadline,
            self.cache.zrange_with_scores(&self.key(DUE), 0, 0),
        )
        .await?;
        let Some((channel, score)) = next.into_iter().next() else {
            return Ok(false);
        };
        if score > self.clock.now_ms() as f64 {
            return Ok(false);
        }
        let channel = String::from_utf8(channel).map_err(|e| Error::Invalid(e.to_string()))?;
        self.rescore(&channel, 60_000).await?;
        self.refresh_defense_baseline(&channel, self.clock.now_ms())
            .await?;
        self.rescore(&channel, 3_600_000).await?;
        Ok(true)
    }
    async fn rescore(&self, channel: &str, delay: i64) -> Result<(), Error> {
        bounded(
            self.config.cache_deadline,
            self.cache.zadd(
                &self.key(DUE),
                &[((self.clock.now_ms() + delay) as f64, channel.as_bytes())],
            ),
        )
        .await?;
        Ok(())
    }
}
