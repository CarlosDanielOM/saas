//! Dashboard reads from `utils/stream_analytics.ts`. Session history is unbounded within the
//! requested UTC window; the live session is always appended, even outside it. Trend averages
//! weight streams equally and use rounded history points. No collector or environment access.
use crate::{Error, bounded};
use bson::{Document, doc};
use dima_core::Clock;
use dima_store::mongo::MongoStore;
use futures_util::TryStreamExt;
use serde::{Serialize, Serializer};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
fn number<S: Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
    dima_text::js_number_value(*n).serialize(s)
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStreamHistoryPoint {
    pub date: String,
    #[serde(serialize_with = "number")]
    pub viewers: f64,
    #[serde(serialize_with = "number")]
    pub hours: f64,
    #[serde(serialize_with = "number")]
    pub bits: f64,
    #[serde(serialize_with = "number")]
    pub donations: f64,
    #[serde(serialize_with = "number")]
    pub follows: f64,
    #[serde(serialize_with = "number")]
    pub subs: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardTrendPoint {
    pub date: String,
    #[serde(serialize_with = "number")]
    pub viewers: f64,
    #[serde(serialize_with = "number")]
    pub hours: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardKpis {
    #[serde(serialize_with = "number")]
    pub active_viewers: f64,
    #[serde(serialize_with = "number")]
    pub average_viewers: f64,
    #[serde(serialize_with = "number")]
    pub monthly_average_viewers: f64,
    #[serde(serialize_with = "number")]
    pub average_hours_per_stream: f64,
    #[serde(serialize_with = "number")]
    pub total_bits: f64,
    #[serde(serialize_with = "number")]
    pub total_streams: f64,
    #[serde(serialize_with = "number")]
    pub total_donations: f64,
    #[serde(serialize_with = "number")]
    pub active_follows: f64,
    #[serde(serialize_with = "number")]
    pub active_subs: f64,
    #[serde(serialize_with = "number")]
    pub monthly_goal_subs: f64,
    #[serde(serialize_with = "number")]
    pub subs_progress_pct: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionMetrics {
    pub is_live: bool,
    pub started_at: Option<String>,
    #[serde(serialize_with = "number")]
    pub duration_minutes: f64,
    #[serde(serialize_with = "number")]
    pub average_viewers: f64,
    #[serde(serialize_with = "number")]
    pub peak_viewers: f64,
    #[serde(serialize_with = "number")]
    pub current_viewers: f64,
    #[serde(serialize_with = "number")]
    pub follows: f64,
    #[serde(serialize_with = "number")]
    pub subs: f64,
    #[serde(serialize_with = "number")]
    pub bits: f64,
    #[serde(serialize_with = "number")]
    pub donations: f64,
    #[serde(serialize_with = "number")]
    pub messages: f64,
    #[serde(serialize_with = "number")]
    pub commands: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardAnalyticsResult {
    pub kpis: DashboardKpis,
    pub trend: Vec<DashboardTrendPoint>,
    pub stream_history: Vec<DashboardStreamHistoryPoint>,
}
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
#[derive(Clone)]
pub struct DashboardAnalytics {
    store: MongoStore,
    clock: Arc<dyn Clock>,
    config: Config,
}
impl DashboardAnalytics {
    pub fn new(store: MongoStore, clock: Arc<dyn Clock>, config: Config) -> Result<Self, Error> {
        if config.store_deadline.is_zero() {
            return Err(Error::Invalid("zero store deadline".into()));
        }
        Ok(Self {
            store,
            clock,
            config,
        })
    }
    async fn live(&self, channel: &str) -> Result<Option<Document>, Error> {
        bounded(
            self.config.store_deadline,
            self.store
                .documents("streamsessions")
                .find_one(doc! {"channelID":channel,"status":"live","ended_at":bson::Bson::Null}),
        )
        .await
    }
    async fn snapshot(&self, channel: &str, live: Option<&Document>) -> Result<f64, Error> {
        let Some(id) = live.and_then(|d| d.get("_id")) else {
            return Ok(0.0);
        };
        let row = bounded(
            self.config.store_deadline,
            self.store
                .documents("streamviewersnapshots")
                .find_one(doc! {"channelID":channel,"session_id":id})
                .sort(doc! {"captured_at":-1})
                .projection(doc! {"viewers":1}),
        )
        .await?;
        Ok(row.as_ref().map_or(0.0, |d| n(d, "viewers")))
    }
    /// Returns null on lookup failure, as the reference does. None selects snapshot viewers.
    pub async fn get_live_session_metrics(
        &self,
        channel: &str,
        current_viewers: Option<f64>,
    ) -> Option<LiveSessionMetrics> {
        self.live_metrics(channel, current_viewers)
            .await
            .ok()
            .flatten()
    }
    async fn live_metrics(
        &self,
        channel: &str,
        current: Option<f64>,
    ) -> Result<Option<LiveSessionMetrics>, Error> {
        let Some(live) = self.live(channel).await? else {
            return Ok(None);
        };
        let snapshot = self.snapshot(channel, Some(&live)).await?;
        let start = date(&live, "started_at")?;
        let current = current.unwrap_or(snapshot);
        Ok(Some(LiveSessionMetrics {
            is_live: true,
            started_at: Some(iso(start)?),
            duration_minutes: dima_text::math_round((self.clock.now_ms() - start) as f64 / 60000.0),
            average_viewers: n(&live, "average_viewers"),
            peak_viewers: n(&live, "peak_viewers"),
            current_viewers: if current.is_nan() {
                0.0
            } else {
                current.max(0.0)
            },
            follows: n(&live, "follows"),
            subs: n(&live, "subs"),
            bits: n(&live, "bits"),
            donations: n(&live, "donations"),
            messages: n(&live, "messages"),
            commands: n(&live, "commands"),
        }))
    }
    /// None means 30 days; finite values below 1 clamp to 1. NaN and positive infinity reject the read,
    /// matching Mongoose. Fractional days follow UTC setDate truncation, with no added cap.
    pub async fn get_dashboard_analytics(
        &self,
        channel: &str,
        days: Option<f64>,
    ) -> Result<DashboardAnalyticsResult, Error> {
        let now = self.clock.now_ms();
        let since = since(now, days.unwrap_or(30.0))?;
        let sessions:Vec<Document>=bounded(self.config.store_deadline,async{self.store.documents("streamsessions").find(doc!{"channelID":channel,"started_at":{"$gte":bson::DateTime::from_millis(since)},"status":{"$in":["offline","orphaned"]}}).sort(doc!{"started_at":1}).await?.try_collect().await}).await?;
        let mut history = Vec::with_capacity(sessions.len() + 1);
        for s in sessions {
            let start = date(&s, "started_at")?;
            let end = s
                .get_datetime("ended_at")
                .map_or(now, |d| d.timestamp_millis());
            let minutes = if n(&s, "duration_minutes") > 0.0 {
                n(&s, "duration_minutes")
            } else {
                duration(start, end)
            };
            history.push(point(&s, start, minutes)?);
        }
        let live = self.live(channel).await?;
        if let Some(s) = &live {
            history.push(point(s, now, duration(date(s, "started_at")?, now))?);
        }
        let mut buckets = BTreeMap::<i64, (f64, f64, f64)>::new();
        let (mut viewers, mut hours, mut bits, mut donations, mut follows, mut subs) =
            (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for p in &history {
            let ms = dima_text::parse_date(&p.date)
                .ok_or_else(|| Error::Invalid("invalid history date".into()))?;
            let b = buckets
                .entry(ms.div_euclid(86400000) * 86400000)
                .or_default();
            b.0 += p.viewers;
            b.1 += 1.0;
            b.2 += p.hours;
            viewers += p.viewers;
            hours += p.hours;
            bits += p.bits;
            donations += p.donations;
            follows += p.follows;
            subs += p.subs;
        }
        let trend = buckets
            .into_iter()
            .map(|(day, (v, c, h))| {
                Ok(DashboardTrendPoint {
                    date: iso(day)?,
                    viewers: dima_text::math_round(v / c),
                    hours: fixed(h, 1),
                })
            })
            .collect::<Result<_, Error>>()?;
        let count = history.len() as f64;
        let average = if count > 0.0 {
            dima_text::math_round(viewers / count)
        } else {
            0.0
        };
        Ok(DashboardAnalyticsResult {
            kpis: DashboardKpis {
                active_viewers: dima_text::math_round(self.snapshot(channel, live.as_ref()).await?),
                average_viewers: average,
                monthly_average_viewers: average,
                average_hours_per_stream: if count > 0.0 {
                    fixed(hours / count, 1)
                } else {
                    0.0
                },
                total_bits: dima_text::math_round(bits),
                total_streams: count,
                total_donations: fixed(donations, 2),
                active_follows: dima_text::math_round(follows),
                active_subs: dima_text::math_round(subs),
                monthly_goal_subs: 1000.0,
                subs_progress_pct: dima_text::math_round(subs / 1000.0 * 100.0).min(100.0),
            },
            trend,
            stream_history: history,
        })
    }
}
fn n(d: &Document, key: &str) -> f64 {
    match d.get(key) {
        Some(bson::Bson::Int32(n)) => f64::from(*n),
        Some(bson::Bson::Int64(n)) => *n as f64,
        Some(bson::Bson::Double(n)) if !n.is_nan() => *n,
        _ => 0.0,
    }
}
fn date(d: &Document, key: &str) -> Result<i64, Error> {
    d.get_datetime(key)
        .map(|d| d.timestamp_millis())
        .map_err(|_| Error::Invalid(format!("missing session date {key}")))
}
fn iso(ms: i64) -> Result<String, Error> {
    dima_text::to_iso_string(ms).ok_or_else(|| Error::Invalid("invalid date".into()))
}
fn fixed(n: f64, d: u8) -> f64 {
    dima_text::parse_number(&dima_text::to_fixed(n, d))
}
fn duration(start: i64, end: i64) -> f64 {
    fixed((end - start).max(0) as f64 / 60000.0, 1)
}
fn point(s: &Document, at: i64, duration: f64) -> Result<DashboardStreamHistoryPoint, Error> {
    Ok(DashboardStreamHistoryPoint {
        date: iso(at)?,
        viewers: dima_text::math_round(n(s, "average_viewers")),
        hours: fixed(duration / 60.0, 1),
        bits: dima_text::math_round(n(s, "bits")),
        donations: fixed(n(s, "donations"), 2),
        follows: dima_text::math_round(n(s, "follows")),
        subs: dima_text::math_round(n(s, "subs")),
    })
}
fn since(now: i64, days: f64) -> Result<i64, Error> {
    if days.is_nan() || days == f64::INFINITY {
        return Err(Error::Invalid("invalid dashboard days".into()));
    }
    let f = dima_text::utc_fields(now).ok_or_else(|| Error::Invalid("invalid clock".into()))?;
    let target = (f64::from(f.day) - (days.max(1.0) - 1.0)).trunc();
    let month = now.div_euclid(86400000) * 86400000 - (i64::from(f.day) - 1) * 86400000;
    let ms = month as f64 + (target - 1.0) * 86400000.0;
    if ms.abs() > dima_text::MAX_TIME_MS as f64 {
        return Err(Error::Invalid("invalid dashboard days".into()));
    }
    Ok(ms as i64)
}
