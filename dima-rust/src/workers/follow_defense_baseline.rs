//! Follow-defense cache projector over the existing ledger, streams and attacks.
//! MongoDB is read-only; Redis keys and scheduling match the TypeScript worker.

use std::{collections::HashSet, time::Duration};

use futures_util::TryStreamExt;
use garde::Validate;
use mongodb::{
    Collection, Database,
    bson::{Bson, DateTime, Document, doc},
};
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};

use crate::utils::redis::get_redis_client;

const DAY_MS: i64 = 86_400_000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
pub const DUE: &str = "follow:defense:baseline:due";

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefenseBaseline {
    pub calculated_at: i64,
    pub average_daily: f64,
    pub average_stream: f64,
    pub sample_days: usize,
    pub stream_count: f64,
    pub excluded_days: usize,
    // Deliberately serialize absent thresholds as JSON null, never omit them.
    pub attack_threshold: Option<f64>,
}

#[derive(Deserialize, Validate)]
struct DayRow {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    day: String,
    #[garde(skip)]
    follows: f64,
}

#[derive(Deserialize, Validate)]
struct StreamRow {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    day: String,
    #[garde(skip)]
    follows: f64,
    #[garde(skip)]
    count: f64,
}

#[derive(Deserialize, Validate)]
struct AttackRow {
    #[serde(rename = "_id")]
    #[garde(length(min = 1))]
    day: String,
}

/// Complete UTC days only: today's midnight is the exclusive upper bound.
fn baseline_range(now: DateTime) -> (DateTime, DateTime) {
    let end = now.timestamp_millis().div_euclid(DAY_MS) * DAY_MS;
    (
        DateTime::from_millis(end - 30 * DAY_MS),
        DateTime::from_millis(end),
    )
}

fn calculate_baseline(
    days: &[DayRow],
    streams: &[StreamRow],
    excluded: &[String],
    now: DateTime,
) -> DefenseBaseline {
    let blocked: HashSet<&str> = excluded.iter().map(String::as_str).collect();
    let clean_days = days
        .iter()
        .filter(|row| !blocked.contains(row.day.as_str()));
    let clean_streams = streams
        .iter()
        .filter(|row| !blocked.contains(row.day.as_str()));
    let mut sample_days = HashSet::new();
    let mut daily_follows = 0.0;
    for row in clean_days {
        sample_days.insert(row.day.as_str());
        daily_follows += row.follows;
    }
    let mut stream_count = 0.0;
    let mut stream_follows = 0.0;
    for row in clean_streams {
        sample_days.insert(row.day.as_str());
        stream_count += row.count;
        stream_follows += row.follows;
    }
    let average_daily =
        daily_follows.max(stream_follows) / 30_usize.saturating_sub(blocked.len()).max(1) as f64;
    let average_stream = if stream_count != 0.0 {
        stream_follows / stream_count
    } else {
        0.0
    };
    DefenseBaseline {
        calculated_at: now.timestamp_millis(),
        average_daily,
        average_stream,
        sample_days: sample_days.len(),
        stream_count,
        excluded_days: blocked.len(),
        attack_threshold: (sample_days.len() >= 7 && stream_count >= 3.0).then(|| {
            500.0_f64
                .max(2.0 * average_daily)
                .max(2.0 * average_stream)
                .ceil()
        }),
    }
}

fn date_group(field: &str) -> Document {
    doc! { "$dateToString": { "format": "%Y-%m-%d", "date": field, "timezone": "UTC" } }
}

fn excluded_days(attacks: Vec<AttackRow>, end: DateTime) -> Result<Vec<String>> {
    let end_day = end
        .try_to_rfc3339_string()
        .map_err(|_| "Invalid baseline UTC range")?;
    let mut excluded = Vec::new();
    for attack in attacks {
        attack
            .validate()
            .map_err(|_| "Invalid baseline aggregate data")?;
        // Same exclusion as TS: today's attack cannot exclude a complete day.
        if attack.day.as_str() < &end_day[..10] {
            excluded.push(attack.day);
        }
    }
    Ok(excluded)
}

fn pipelines(channel: &str, now: DateTime) -> [Vec<Document>; 3] {
    let (start, end) = baseline_range(now);
    [
        vec![
            doc! { "$match": { "followed_id": channel, "followed_at": { "$gte": start, "$lt": end } } },
            doc! { "$group": { "_id": date_group("$followed_at"), "follows": { "$sum": 1 } } },
        ],
        vec![
            doc! { "$match": { "channelID": channel, "status": "offline", "started_at": { "$gte": start, "$lt": end }, "ended_at": { "$lte": end, "$ne": Bson::Null }, "duration_minutes": { "$gt": 0 } } },
            doc! { "$group": { "_id": date_group("$started_at"), "follows": { "$sum": "$follows" }, "count": { "$sum": 1 } } },
        ],
        vec![
            doc! { "$match": { "targetChannelID": channel, "modeTriggered": "attack", "createdAt": { "$gte": start, "$lt": now } } },
            doc! { "$group": { "_id": date_group("$createdAt") } },
        ],
    ]
}

/// One supervisor owns the canonical queue. No collection or index creation.
pub struct FollowDefenseBaselineProjector {
    ledger: Collection<DayRow>,
    streams: Collection<StreamRow>,
    attacks: Collection<AttackRow>,
}

impl FollowDefenseBaselineProjector {
    pub fn new(database: Database) -> Self {
        Self {
            ledger: database.collection("follow_relationship_ledgers"),
            streams: database.collection("streamsessions"),
            attacks: database.collection("follow_attack_logs"),
        }
    }

    /// Zero means idle, one means fully refreshed. Failed ticks preserve any
    /// existing cache and the receipt established before querying MongoDB.
    pub async fn project_once(&self) -> Result<usize> {
        let mut cache = get_redis_client()
            .await
            .map_err(|_| "Cannot initialize Redis client")?;
        let next: Vec<(String, f64)> = redis::cmd("ZRANGE")
            .arg(DUE)
            .arg(0)
            .arg(0)
            .arg("WITHSCORES")
            .query_async(&mut cache)
            .await
            .map_err(|_| "Cannot read baseline due queue")?;
        let Some((channel, score)) = next.into_iter().next() else {
            return Ok(0);
        };
        if score > DateTime::now().timestamp_millis() as f64 {
            return Ok(0);
        }
        // Do not remove the member: a crash/query error keeps a retry receipt.
        rescore(&mut cache, &channel, 60_000).await?;
        let baseline = self.calculate_at(&channel, DateTime::now()).await?;
        let payload = serde_json::to_string(&baseline).map_err(|_| "Cannot serialize baseline")?;
        let _: () = redis::cmd("SET")
            .arg(format!("follow:defense:baseline:{channel}"))
            .arg(payload)
            .arg("EX")
            .arg(604_800)
            .query_async(&mut cache)
            .await
            .map_err(|_| "Cannot publish baseline cache")?;
        // A fresh post-query clock is essential for a full hour until refresh.
        rescore(&mut cache, &channel, 3_600_000).await?;
        Ok(1)
    }

    async fn calculate_at(&self, channel: &str, now: DateTime) -> Result<DefenseBaseline> {
        let [days_pipeline, streams_pipeline, attacks_pipeline] = pipelines(channel, now);
        // Exactly three concurrent read-only aggregates, each with maxTimeMS.
        let days = async {
            self.ledger
                .aggregate(days_pipeline)
                .max_time(QUERY_TIMEOUT)
                .with_type::<DayRow>()
                .await?
                .try_collect::<Vec<DayRow>>()
                .await
        };
        let streams = async {
            self.streams
                .aggregate(streams_pipeline)
                .max_time(QUERY_TIMEOUT)
                .with_type::<StreamRow>()
                .await?
                .try_collect::<Vec<StreamRow>>()
                .await
        };
        let attacks = async {
            self.attacks
                .aggregate(attacks_pipeline)
                .max_time(QUERY_TIMEOUT)
                .with_type::<AttackRow>()
                .await?
                .try_collect::<Vec<AttackRow>>()
                .await
        };
        let (days, streams, attacks) = tokio::try_join!(days, streams, attacks)
            .map_err(|_| "Baseline aggregate failed; channel retained for retry")?;
        for day in &days {
            day.validate()
                .map_err(|_| "Invalid baseline aggregate data")?;
            if !day.follows.is_finite() {
                return Err("Invalid baseline aggregate data");
            }
        }
        for stream in &streams {
            stream
                .validate()
                .map_err(|_| "Invalid baseline aggregate data")?;
            if !stream.follows.is_finite() || !stream.count.is_finite() {
                return Err("Invalid baseline aggregate data");
            }
        }
        let (_, end) = baseline_range(now);
        let excluded = excluded_days(attacks, end)?;
        Ok(calculate_baseline(&days, &streams, &excluded, now))
    }
}

async fn rescore(cache: &mut ConnectionManager, channel: &str, delay_ms: i64) -> Result<()> {
    let _: i64 = redis::cmd("ZADD")
        .arg(DUE)
        .arg(DateTime::now().timestamp_millis() + delay_ms)
        .arg(channel)
        .query_async(cache)
        .await
        .map_err(|_| "Cannot reschedule baseline channel")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days(count: usize, follows: f64) -> Vec<DayRow> {
        (0..count)
            .map(|index| DayRow {
                day: format!("2026-09-{:02}", index + 1),
                follows,
            })
            .collect()
    }

    fn streams(count: usize, follows: f64) -> Vec<StreamRow> {
        days(count, follows)
            .into_iter()
            .map(|day| StreamRow {
                day: day.day,
                follows,
                count: 1.0,
            })
            .collect()
    }

    #[test]
    fn sparse_history_serializes_explicit_null_and_all_contract_fields() {
        for (days, streams) in [
            (days(6, 20_000.0), streams(6, 20_000.0)),
            (days(30, 20_000.0), streams(2, 20_000.0)),
            (vec![], vec![]),
        ] {
            let baseline = calculate_baseline(&days, &streams, &[], DateTime::from_millis(123));
            let payload = serde_json::to_value(baseline).unwrap();
            assert_eq!(payload.as_object().unwrap().len(), 7);
            assert!(payload["attackThreshold"].is_null());
            assert_eq!(payload["calculatedAt"], 123);
        }
    }

    #[test]
    fn small_channels_keep_floor_and_fractional_thresholds_round_up() {
        let baseline = calculate_baseline(
            &days(30, 1.0),
            &streams(30, 1.0),
            &[],
            DateTime::from_millis(1),
        );
        assert_eq!(baseline.attack_threshold, Some(500.0));
        let baseline = calculate_baseline(
            &days(30, 250.25),
            &streams(3, 0.0),
            &[],
            DateTime::from_millis(1),
        );
        assert_eq!(baseline.attack_threshold, Some(501.0));
    }

    #[test]
    fn daily_and_stream_averages_use_distinct_denominators_and_larger_numerator() {
        let baseline = calculate_baseline(
            &days(30, 20_000.0),
            &streams(30, 20_000.0),
            &[],
            DateTime::from_millis(123),
        );
        assert_eq!(baseline.average_daily, 20_000.0);
        assert_eq!(baseline.attack_threshold, Some(40_000.0));
        let baseline = calculate_baseline(
            &days(30, 1_000.0),
            &streams(3, 20_000.0),
            &[],
            DateTime::from_millis(123),
        );
        assert_eq!(baseline.average_daily, 2_000.0);
        assert_eq!(baseline.average_stream, 20_000.0);
        assert_eq!(baseline.attack_threshold, Some(40_000.0));
        let baseline = calculate_baseline(
            &days(7, 1.0),
            &[StreamRow {
                day: "2026-09-01".into(),
                follows: 1_501.0,
                count: 3.0,
            }],
            &[],
            DateTime::from_millis(123),
        );
        assert_eq!(baseline.stream_count, 3.0);
        assert_eq!(baseline.attack_threshold, Some(1_001.0));
    }

    #[test]
    fn excluded_days_are_unique_remove_both_sources_and_do_not_reduce_samples_twice() {
        let mut days = days(30, 20_000.0);
        days[29].follows = 10_000_000.0;
        let excluded = vec!["2026-09-30".into(), "2026-09-30".into()];
        let baseline = calculate_baseline(
            &days,
            &streams(30, 20_000.0),
            &excluded,
            DateTime::from_millis(123),
        );
        assert_eq!(baseline.average_daily, 20_000.0);
        assert_eq!(baseline.average_stream, 20_000.0);
        assert_eq!(baseline.excluded_days, 1);
        assert_eq!(baseline.sample_days, 29);
        assert_eq!(baseline.stream_count, 29.0);
        assert_eq!(baseline.attack_threshold, Some(40_000.0));
        let baseline = calculate_baseline(
            &days[..6],
            &[StreamRow {
                day: "2026-10-01".into(),
                follows: 1.0,
                count: 3.0,
            }],
            &[],
            DateTime::from_millis(123),
        );
        assert_eq!(baseline.sample_days, 7);
        assert!(baseline.attack_threshold.is_some());
    }

    #[test]
    fn range_and_pipelines_keep_complete_utc_days_and_original_filters() {
        let now = DateTime::parse_rfc3339_str("2026-10-21T23:45:00Z").unwrap();
        let end = DateTime::parse_rfc3339_str("2026-10-21T00:00:00Z").unwrap();
        let start = DateTime::parse_rfc3339_str("2026-09-21T00:00:00Z").unwrap();
        assert_eq!(baseline_range(now), (start, end));
        assert_eq!(
            baseline_range(DateTime::from_millis(-1))
                .1
                .timestamp_millis(),
            -DAY_MS
        );
        let [ledger, streams, attacks] = pipelines("channel", now);
        assert_eq!(
            ledger[0],
            doc! { "$match": { "followed_id": "channel", "followed_at": { "$gte": start, "$lt": end } } }
        );
        assert_eq!(
            streams[0],
            doc! { "$match": { "channelID": "channel", "status": "offline", "started_at": { "$gte": start, "$lt": end }, "ended_at": { "$lte": end, "$ne": Bson::Null }, "duration_minutes": { "$gt": 0 } } }
        );
        assert_eq!(
            attacks[0],
            doc! { "$match": { "targetChannelID": "channel", "modeTriggered": "attack", "createdAt": { "$gte": start, "$lt": now } } }
        );
        assert_eq!(
            ledger[1],
            doc! { "$group": { "_id": { "$dateToString": { "format": "%Y-%m-%d", "date": "$followed_at", "timezone": "UTC" } }, "follows": { "$sum": 1 } } }
        );
        assert_eq!(DUE, "follow:defense:baseline:due");
        assert_eq!(
            excluded_days(
                vec![
                    AttackRow {
                        day: "2026-10-20".into()
                    },
                    AttackRow {
                        day: "2026-10-21".into()
                    }
                ],
                end
            )
            .unwrap(),
            vec!["2026-10-20"]
        );
    }

    #[test]
    fn aggregate_rows_accept_mongodb_integer_and_double_sums() {
        for follows in [Bson::Int32(12), Bson::Int64(12), Bson::Double(12.5)] {
            let row: StreamRow = mongodb::bson::deserialize_from_document(
                doc! { "_id": "2026-10-20", "follows": follows, "count": 3_i32 },
            )
            .unwrap();
            assert!(row.follows >= 12.0);
            assert_eq!(row.count, 3.0);
        }
    }
}
