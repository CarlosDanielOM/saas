//! Dashboard insights over the existing bounded, privacy-projected sources.
//! No collection/index creation, event payloads, chat text, or follower IDs.
use std::{collections::HashMap, time::Duration};

use futures_util::TryStreamExt;
use garde::Validate;
use icu_collator::{Collator, CollatorBorrowed};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc, oid::ObjectId},
    options::ReturnDocument,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub(crate) use crate::utils::bson_compat::{
    js_number as bson_number, normalize_document as normalize_payload_numbers,
};
use crate::utils::{js_compat::trim as js_trim, utc_time::inclusive_day_start};

pub type Result<T> = std::result::Result<T, &'static str>;
pub const SESSION_LIMIT: usize = 500;
pub const SNAPSHOT_LIMIT: usize = 20_000;
pub const RAID_LIMIT: usize = 10_000;
pub const FOLLOW_LIMIT: usize = 100_000;
pub(crate) const DAY_MS: i64 = 86_400_000;
const HOUR_MS: f64 = 3_600_000.0;

/// Inclusive UTC calendar-day ranges, matching Date.UTC (also before epoch).
pub fn dashboard_range_start(days: u32, now: DateTime) -> DateTime {
    inclusive_day_start(days, now)
}

/// JS strings can contain a lone surrogate after String.slice. Keep those code
/// units as the grouping/identity value; BSON writes their replacement encoding.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct JsText(pub Vec<u16>);
impl JsText {
    pub(crate) fn sliced(value: &str, limit: usize) -> Self {
        Self(value.encode_utf16().take(limit).collect())
    }
    pub(crate) fn bson_text(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Exactly JSON.stringify on a JS string, including well-formed lone-surrogate
/// escapes, literal Unicode and the short control-character escape spellings.
pub(crate) fn js_json_string(units: &[u16]) -> String {
    use std::fmt::Write as _;
    let mut result = String::from("\"");
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => result.push_str("\\\""),
            0x5c => result.push_str("\\\\"),
            0x08 => result.push_str("\\b"),
            0x09 => result.push_str("\\t"),
            0x0a => result.push_str("\\n"),
            0x0c => result.push_str("\\f"),
            0x0d => result.push_str("\\r"),
            0..=0x1f => {
                let _ = write!(result, "\\u{unit:04x}");
            }
            0xd800..=0xdbff
                if units
                    .get(index + 1)
                    .is_some_and(|next| (0xdc00..=0xdfff).contains(next)) =>
            {
                let next = units[index + 1];
                index += 1;
                let scalar =
                    0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(next) - 0xdc00);
                result.push(char::from_u32(scalar).expect("paired surrogate"));
            }
            0xd800..=0xdfff => {
                let _ = write!(result, "\\u{unit:04x}");
            }
            _ => result.push(char::from_u32(u32::from(unit)).expect("non-surrogate UTF16")),
        }
        index += 1;
    }
    result.push('"');
    result
}
impl Serialize for JsText {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let raw = serde_json::value::RawValue::from_string(js_json_string(&self.0))
            .map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for JsText {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let text = raw.get();
        let inner = text
            .strip_prefix('"')
            .and_then(|text| text.strip_suffix('"'))
            .ok_or_else(|| serde::de::Error::custom("Expected JSON string"))?;
        let mut units = Vec::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                continue;
            }
            let c = chars
                .next()
                .ok_or_else(|| serde::de::Error::custom("Invalid JSON escape"))?;
            let unit = match c {
                '"' => 0x22,
                '\\' => 0x5c,
                '/' => 0x2f,
                'b' => 0x08,
                'f' => 0x0c,
                'n' => 0x0a,
                'r' => 0x0d,
                't' => 0x09,
                'u' => {
                    let mut unit = 0;
                    for _ in 0..4 {
                        let digit = chars
                            .next()
                            .and_then(|c| c.to_digit(16))
                            .ok_or_else(|| serde::de::Error::custom("Invalid Unicode escape"))?;
                        unit = (unit << 4) | (digit as u16);
                    }
                    unit
                }
                _ => return Err(serde::de::Error::custom("Invalid JSON escape")),
            };
            units.push(unit);
        }
        Ok(Self(units))
    }
}

#[derive(Clone, Debug, Deserialize, Validate)]
pub struct InsightSession {
    #[serde(rename = "_id")]
    #[garde(skip)]
    pub id: ObjectId,
    #[garde(skip)]
    pub started_at: DateTime,
    #[serde(default)]
    #[garde(skip)]
    pub ended_at: Option<DateTime>,
    #[garde(length(min = 1))]
    pub status: String,
    #[serde(default)]
    #[garde(skip)]
    pub follows: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct InsightSnapshot {
    pub session_id: ObjectId,
    pub captured_at: DateTime,
    #[serde(default)]
    pub viewers: Option<f64>,
    #[serde(default)]
    pub game_name: Option<String>,
}

#[derive(Clone, Debug)]
pub struct InsightInterval {
    pub from: i64,
    pub to: i64,
    pub session: ObjectId,
    game: JsText,
    pub viewers: f64,
    pub follows: f64,
    prior_end: i64,
}

fn scalar(value: Option<f64>) -> f64 {
    value
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(0.0)
}
fn rounded(value: f64) -> f64 {
    // All quantities here are nonnegative; this is JS Math.round, including
    // halfway cases (Rust's ties-away rule happens to agree in this domain).
    (value * 100.0).round() / 100.0
}

/// Do not interpolate missing starts, offline time, or gaps over ten minutes.
pub fn insight_intervals(
    sessions: &[InsightSession],
    snapshots: &[InsightSnapshot],
) -> Vec<InsightInterval> {
    let by_session: HashMap<_, _> = sessions.iter().map(|row| (row.id, row)).collect();
    let mut grouped: Vec<(ObjectId, Vec<&InsightSnapshot>)> = Vec::new();
    let mut positions = HashMap::new();
    for row in snapshots {
        let Some(session) = by_session.get(&row.session_id) else {
            continue;
        };
        let Some(end) = session.ended_at else {
            continue;
        };
        if row.captured_at < session.started_at || row.captured_at >= end {
            continue;
        }
        let position = *positions.entry(row.session_id).or_insert_with(|| {
            grouped.push((row.session_id, Vec::new()));
            grouped.len() - 1
        });
        grouped[position].1.push(row);
    }
    let mut result = Vec::new();
    for (id, mut rows) in grouped {
        rows.sort_by_key(|row| row.captured_at);
        for (index, row) in rows.iter().enumerate() {
            let from = row.captured_at.timestamp_millis();
            let to = rows
                .get(index + 1)
                .map(|row| row.captured_at)
                .unwrap_or_else(|| {
                    by_session[&id]
                        .ended_at
                        .expect("group has completed session")
                })
                .timestamp_millis();
            if to <= from || to - from > 600_000 {
                continue;
            }
            result.push(InsightInterval {
                from,
                to,
                session: id,
                game: JsText::sliced(js_trim(row.game_name.as_deref().unwrap_or("")), 128),
                viewers: scalar(row.viewers),
                follows: 0.0,
                prior_end: 0,
            });
        }
    }
    // Stable order preserves JS Array.sort / Map insertion order on exact ties.
    result.sort_by_key(|row| (row.from, row.to));
    let mut prior_end = 0;
    for row in &mut result {
        row.prior_end = prior_end;
        prior_end = prior_end.max(row.to);
    }
    result
}

/// At most one unambiguous observed interval receives each timestamp.
pub fn assign_insight_follow(intervals: &mut [InsightInterval], at: DateTime) {
    let at = at.timestamp_millis();
    let index = intervals.partition_point(|row| row.from <= at);
    if let Some(row) = index
        .checked_sub(1)
        .and_then(|index| intervals.get_mut(index))
        && at < row.to
        && !(row.prior_end != 0 && row.prior_end > at)
    {
        row.follows += 1.0;
    }
}

#[derive(Default)]
struct Weekday {
    weekday: i32,
    streams: f64,
    hours: f64,
    follows: f64,
    sampled_hours: f64,
    viewer_hours: f64,
}
struct Game {
    name: JsText,
    sessions: Vec<ObjectId>,
    sampled_hours: f64,
    viewer_hours: f64,
    follows: f64,
}

fn weekday(at: DateTime) -> i32 {
    (at.timestamp_millis().div_euclid(DAY_MS) + 4).rem_euclid(7) as i32
}

/// The default ICU root collation is the English standard collation used by
/// Node's default en-US localeCompare. Preserve tertiary case/accent ordering,
/// canonical-equivalence ties and stable insertion order; never byte-sort names.
fn game_collator() -> Result<CollatorBorrowed<'static>> {
    Collator::try_new(Default::default(), Default::default())
        .map_err(|_| "Cannot initialize dashboard game collation")
}

#[allow(clippy::too_many_arguments)]
pub fn calculate_insights(
    sessions: &[InsightSession],
    intervals: &[InsightInterval],
    raids: &[DateTime],
    days: u32,
    exclude_raids: bool,
    now: DateTime,
    truncated: bool,
) -> Result<Document> {
    let from = dashboard_range_start(days, now);
    let completed: Vec<_> = sessions
        .iter()
        .filter(|row| {
            row.status == "offline"
                && row.started_at >= from
                && row
                    .ended_at
                    .is_some_and(|end| end <= now && end > row.started_at)
        })
        .collect();
    let excluded: Vec<_> = completed
        .iter()
        .filter(|row| {
            raids
                .iter()
                .any(|&at| at >= row.started_at && at < row.ended_at.expect("completed"))
        })
        .map(|row| row.id)
        .collect();
    let selected: Vec<_> = completed
        .into_iter()
        .filter(|row| !exclude_raids || !excluded.contains(&row.id))
        .collect();
    let selected_by_id: HashMap<_, _> = selected.iter().map(|row| (row.id, *row)).collect();
    let mut weekdays: Vec<_> = (0..7)
        .map(|index| Weekday {
            weekday: (index + 1) % 7,
            ..Weekday::default()
        })
        .collect();
    for row in &selected {
        let day = &mut weekdays[((weekday(row.started_at) + 6) % 7) as usize];
        day.streams += 1.0;
        day.hours += (row.ended_at.expect("completed").timestamp_millis()
            - row.started_at.timestamp_millis()) as f64
            / HOUR_MS;
        day.follows += scalar(row.follows);
    }
    let mut games: Vec<Game> = Vec::new();
    let mut game_positions = HashMap::new();
    for row in intervals {
        let Some(session) = selected_by_id.get(&row.session) else {
            continue;
        };
        let hours = (row.to - row.from) as f64 / HOUR_MS;
        let day = &mut weekdays[((weekday(session.started_at) + 6) % 7) as usize];
        day.sampled_hours += hours;
        day.viewer_hours += row.viewers * hours;
        if row.game.is_empty() {
            continue;
        }
        let index = *game_positions.entry(row.game.clone()).or_insert_with(|| {
            games.push(Game {
                name: row.game.clone(),
                sessions: Vec::new(),
                sampled_hours: 0.0,
                viewer_hours: 0.0,
                follows: 0.0,
            });
            games.len() - 1
        });
        let game = &mut games[index];
        if !game.sessions.contains(&row.session) {
            game.sessions.push(row.session);
        }
        game.sampled_hours += hours;
        game.viewer_hours += row.viewers * hours;
        game.follows += row.follows;
    }
    let day_eligible = |day: &Weekday| {
        !truncated && day.streams >= 3.0 && day.hours >= 2.0 && day.sampled_hours / day.hours >= 0.8
    };
    let game_eligible =
        |game: &Game| !truncated && game.sessions.len() >= 3 && game.sampled_hours >= 2.0;
    let mut eligible_days: Vec<_> = weekdays.iter().filter(|row| day_eligible(row)).collect();
    // JS ranks the already rounded payload metrics, rather than raw ratios.
    eligible_days.sort_by(|a, b| {
        rounded(b.follows / b.streams)
            .total_cmp(&rounded(a.follows / a.streams))
            .then(a.weekday.cmp(&b.weekday))
    });
    let best_day = if eligible_days.len() >= 2 {
        eligible_days
            .into_iter()
            .find(|row| row.follows > 0.0)
            .map_or(Bson::Null, |row| Bson::Int32(row.weekday))
    } else {
        Bson::Null
    };
    let collator = game_collator()?;
    let mut eligible_games: Vec<_> = games.iter().filter(|row| game_eligible(row)).collect();
    eligible_games.sort_by(|a, b| {
        rounded(b.follows / b.sampled_hours)
            .total_cmp(&rounded(a.follows / a.sampled_hours))
            .then_with(|| collator.compare_utf16(&a.name.0, &b.name.0))
    });
    let best_growth_game = if eligible_games.len() >= 2 {
        eligible_games
            .into_iter()
            .find(|row| row.follows > 0.0)
            .map_or(Bson::Null, |row| Bson::String(row.name.bson_text()))
    } else {
        Bson::Null
    };
    games.sort_by(|a, b| {
        rounded(b.viewer_hours)
            .total_cmp(&rounded(a.viewer_hours))
            .then_with(|| collator.compare_utf16(&a.name.0, &b.name.0))
    });
    let day_rows: Vec<_> = weekdays.iter().map(|row| Bson::Document(doc! {
        "weekday":row.weekday, "streams":row.streams, "hours":rounded(row.hours), "follows":row.follows,
        "followsPerStream":if row.streams > 0.0 { Bson::Double(rounded(row.follows / row.streams)) } else { Bson::Null },
        "followsPerHour":if row.hours > 0.0 { Bson::Double(rounded(row.follows / row.hours)) } else { Bson::Null },
        "averageViewers":if row.sampled_hours > 0.0 { Bson::Double(rounded(row.viewer_hours / row.sampled_hours)) } else { Bson::Null },
        "coverage":if row.hours > 0.0 { Bson::Double(rounded((row.sampled_hours / row.hours).min(1.0))) } else { Bson::Null },
        "eligible":day_eligible(row)
    })).collect();
    let game_count = games.len();
    let game_rows: Vec<_> = games.iter().take(5).map(|row| Bson::Document(doc! {
        "game":row.name.bson_text(), "streams":row.sessions.len() as f64,
        "hours":rounded(row.sampled_hours), "viewerHours":rounded(row.viewer_hours),
        "averageViewers":rounded(row.viewer_hours / row.sampled_hours),
        "follows":if truncated { Bson::Null } else { Bson::Double(row.follows) },
        "followsPerHour":if truncated { Bson::Null } else { Bson::Double(rounded(row.follows / row.sampled_hours)) },
        "eligible":game_eligible(row)
    })).collect();
    let mut payload = doc! { "days":days as i32, "from":from, "to":now, "timeZone":"UTC", "excludeRaids":exclude_raids,
    "streams":selected.len() as f64, "excludedStreams":if exclude_raids { excluded.len() as f64 } else { 0.0 },
    "weekdays":day_rows, "games":game_rows, "gameCount":game_count as f64,
    "bestDay":best_day, "bestGrowthGame":best_growth_game, "limited":truncated,
    "sampledHours":rounded(weekdays.iter().map(|row| row.sampled_hours).sum()),
    "hours":rounded(weekdays.iter().map(|row| row.hours).sum()), "minimumStreams":3.0, "minimumHours":2.0 };
    normalize_payload_numbers(&mut payload);
    Ok(payload)
}

#[derive(Deserialize)]
struct Timestamp {
    #[serde(rename = "occurredAt")]
    at: DateTime,
}

pub(crate) fn insights_due(now: DateTime) -> Document {
    doc! { "nextRefreshAt":{"$lte":now}, "leaseUntil":{"$lte":now}, "expiresAt":{"$gt":now} }
}
pub(crate) fn owned(id: &str, owner: &str) -> Document {
    doc! { "_id":id, "owner":owner, "leaseUntil":{"$gt":DateTime::now()} }
}

/// Refresh at most one nonexpired due channel, preserving the existing cache
/// schema and both include/exclude-raid period keys. Uses only business MongoDB.
pub async fn refresh_dashboard_insights_once(database: &Database) -> Result<bool> {
    let now = DateTime::now();
    let owner = ObjectId::new().to_hex();
    let summaries = database.collection::<Document>("dashboard_insights");
    let state = summaries.find_one_and_update(insights_due(now), doc! {
        "$set":{"owner":&owner,"leaseUntil":DateTime::from_millis(now.timestamp_millis()+60_000)}
    }).sort(doc! {"nextRefreshAt":1}).return_document(ReturnDocument::After)
        .await.map_err(|_| "Dashboard insights claim failed")?;
    let Some(state) = state else { return Ok(false) };
    let channel = state
        .get_str("_id")
        .map_err(|_| "Invalid dashboard insights channel")?;
    let result = build_insights(database, channel, now).await;
    let result = match result {
        Ok(payload) => summaries.update_one(owned(channel, &owner), doc! {
            "$set":{"payload":payload,"updatedAt":now,"error":false,
                "nextRefreshAt":DateTime::from_millis(DateTime::now().timestamp_millis()+300_000)}
        }).await.map_err(|_| "Dashboard insights publish failed").and_then(|result| {
            if result.matched_count == 0 { Err("Dashboard insights lease lost") } else { Ok(()) }
        }),
        Err(message) => Err(message),
    };
    if result.is_err() {
        // A fenced error marker never overwrites a replacement owner's work.
        let _ = summaries.update_one(owned(channel, &owner), doc! {"$set":{
            "error":true, "nextRefreshAt":DateTime::from_millis(DateTime::now().timestamp_millis()+30_000)
        }}).await;
    }
    let released = summaries
        .update_one(
            doc! {"_id":channel,"owner":&owner},
            doc! {"$set":{"leaseUntil":DateTime::from_millis(0)}},
        )
        .await
        .map_err(|_| "Dashboard insights release failed");
    result?;
    released?;
    Ok(true)
}

async fn build_insights(database: &Database, channel: &str, now: DateTime) -> Result<Document> {
    let from = dashboard_range_start(30, now);
    let sessions: Vec<InsightSession> = database
        .collection("streamsessions")
        .find(doc! {
            "channelID":channel, "started_at":{"$gte":from,"$lte":now}, "status":"offline",
            "ended_at":{"$lte":now,"$ne":Bson::Null}
        })
        .sort(doc! {"started_at":-1})
        .limit((SESSION_LIMIT + 1) as i64)
        .projection(doc! {"_id":1,"started_at":1,"ended_at":1,"status":1,"follows":1})
        .max_time(Duration::from_secs(3))
        .await
        .map_err(|_| "Dashboard insights session lookup failed")?
        .try_collect()
        .await
        .map_err(|_| "Invalid dashboard insights session data")?;
    let session_overflow = sessions.len() > SESSION_LIMIT;
    let selected: Vec<_> = sessions.into_iter().take(SESSION_LIMIT).collect();
    for row in &selected {
        row.validate()
            .map_err(|_| "Invalid dashboard insights session data")?;
    }
    let ids: Vec<_> = selected.iter().map(|row| row.id).collect();
    let snapshots =
        async {
            database.collection::<InsightSnapshot>("streamviewersnapshots").find(doc! {
            "channelID":channel,"session_id":{"$in":ids},"captured_at":{"$gte":from,"$lte":now}
        }).sort(doc! {"captured_at":1}).limit((SNAPSHOT_LIMIT+1) as i64)
            .projection(doc! {"_id":0,"session_id":1,"captured_at":1,"viewers":1,"game_name":1})
            .max_time(Duration::from_secs(3)).await
            .map_err(|_| "Dashboard insights snapshot lookup failed")?
            .try_collect::<Vec<_>>().await.map_err(|_| "Invalid dashboard insights snapshot data")
        };
    let raids = async {
        database
            .collection::<Timestamp>("domain_events")
            .find(doc! {
                "channelID":channel,"source":"twitch-eventsub","type":"channel.raid.received",
                "occurredAt":{"$gte":from,"$lte":now},"expiresAt":{"$gt":now}
            })
            .sort(doc! {"occurredAt":1})
            .limit((RAID_LIMIT + 1) as i64)
            .projection(doc! {"_id":0,"occurredAt":1})
            .max_time(Duration::from_secs(3))
            .await
            .map_err(|_| "Dashboard insights raid lookup failed")?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|_| "Invalid dashboard insights raid timestamp")
    };
    let (snapshots, raids) = tokio::try_join!(snapshots, raids)?;
    let mut intervals =
        insight_intervals(&selected, &snapshots[..snapshots.len().min(SNAPSHOT_LIMIT)]);
    let mut follows = 0;
    if !intervals.is_empty() {
        // Bounded streaming timestamps only: never hydrate identity/payload.
        let mut cursor = database
            .collection::<Timestamp>("domain_events")
            .find(doc! {
                "channelID":channel,"source":"twitch-eventsub","type":"channel.follow.received",
                "occurredAt":{"$gte":from,"$lte":now},"expiresAt":{"$gt":now}
            })
            .sort(doc! {"occurredAt":1})
            .limit((FOLLOW_LIMIT + 1) as i64)
            .projection(doc! {"_id":0,"occurredAt":1})
            .batch_size(500)
            .max_time(Duration::from_secs(10))
            .await
            .map_err(|_| "Dashboard insights follow lookup failed")?;
        while let Some(row) = cursor
            .try_next()
            .await
            .map_err(|_| "Invalid dashboard insights follow timestamp")?
        {
            follows += 1;
            if follows > FOLLOW_LIMIT {
                break;
            }
            assign_insight_follow(&mut intervals, row.at);
        }
        // Dropping a Mongo cursor requests killCursors, including truncation or
        // errors; its async cleanup does not retain hydrated event payloads.
    }
    let truncated = session_overflow
        || snapshots.len() > SNAPSHOT_LIMIT
        || raids.len() > RAID_LIMIT
        || follows > FOLLOW_LIMIT;
    let raids: Vec<_> = raids
        .into_iter()
        .take(RAID_LIMIT)
        .map(|row| row.at)
        .collect();
    let mut payload = Document::new();
    for days in [7, 30] {
        for exclude in [false, true] {
            payload.insert(
                format!("{days}:{}", if exclude { "exclude" } else { "include" }),
                calculate_insights(&selected, &intervals, &raids, days, exclude, now, truncated)?,
            );
        }
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bson_numbers_match_node_boundaries_and_safe_long_promotion() {
        for number in [0.0, f64::from(i32::MIN), f64::from(i32::MAX)] {
            assert_eq!(bson_number(number), Bson::Int32(number as i32));
        }
        for number in [
            f64::from(i32::MIN) - 1.0,
            f64::from(i32::MAX) + 1.0,
            1.5,
            f64::INFINITY,
        ] {
            assert_eq!(bson_number(number), Bson::Double(number));
        }
        assert!(matches!(bson_number(-0.0), Bson::Double(value) if value.is_sign_negative()));
        assert!(matches!(bson_number(f64::NAN), Bson::Double(value) if value.is_nan()));
        let date = DateTime::from_millis(123);
        let mut payload = doc! {
            "small":Bson::Int64(7),"negative":Bson::Int64(-7),
            "nested":[{"count":Bson::Int64(i64::from(i32::MAX)+1),"date":date}],
            "edge":Bson::Int64(9_007_199_254_740_992),
            "negativeEdge":Bson::Int64(-9_007_199_254_740_992),
            "long":Bson::Int64(9_007_199_254_740_993),
            "negativeLong":Bson::Int64(-9_007_199_254_740_993),
        };
        normalize_payload_numbers(&mut payload);
        assert_eq!(payload.get("small"), Some(&Bson::Int32(7)));
        assert_eq!(payload.get("negative"), Some(&Bson::Int32(-7)));
        let nested = payload.get_array("nested").unwrap()[0]
            .as_document()
            .unwrap();
        assert_eq!(
            nested.get("count"),
            Some(&Bson::Double(f64::from(i32::MAX) + 1.0))
        );
        assert_eq!(nested.get("date"), Some(&Bson::DateTime(date)));
        assert_eq!(
            payload.get("edge"),
            Some(&Bson::Double(9_007_199_254_740_992.0))
        );
        assert_eq!(
            payload.get("negativeEdge"),
            Some(&Bson::Double(-9_007_199_254_740_992.0))
        );
        assert_eq!(
            payload.get("long"),
            Some(&Bson::Int64(9_007_199_254_740_993))
        );
        assert_eq!(
            payload.get("negativeLong"),
            Some(&Bson::Int64(-9_007_199_254_740_993))
        );
    }
    #[test]
    fn ranges_use_inclusive_utc_days_and_js_string_rules() {
        assert_eq!(
            dashboard_range_start(7, DateTime::from_millis(-1)).timestamp_millis(),
            -7 * DAY_MS
        );
        assert_eq!(
            JsText::sliced(&format!("{}😀", "x".repeat(99)), 100)
                .0
                .last(),
            Some(&0xd83d)
        );
        assert!(
            JsText::sliced(&format!("{}😀", "x".repeat(99)), 100)
                .bson_text()
                .ends_with('\u{fffd}')
        );
        assert_eq!(js_trim("\u{feff} café \u{feff}"), "café");
        assert_eq!(js_trim("\u{85}café\u{85}"), "\u{85}café\u{85}");
    }
    #[test]
    fn locale_game_ties_use_case_and_accents_with_stable_canonical_ties() {
        let collator = game_collator().unwrap();
        let mut names = vec!["Zebra", "Éclair", "eclair", "Apple", "apple", "éclair"];
        names.sort_by(|a, b| collator.compare(a, b));
        assert_eq!(
            names,
            vec!["apple", "Apple", "eclair", "éclair", "Éclair", "Zebra"]
        );
        assert_eq!(collator.compare("é", "e\u{301}"), std::cmp::Ordering::Equal);
    }
    #[test]
    fn follow_assignment_rejects_overlap_and_endpoints_and_gaps_over_ten_minutes() {
        let first = ObjectId::new();
        let second = ObjectId::new();
        let make = |id, start, end| InsightSession {
            id,
            started_at: DateTime::from_millis(start),
            ended_at: Some(DateTime::from_millis(end)),
            status: "offline".into(),
            follows: Some(0.0),
        };
        let sessions = vec![make(first, 1_000, 601_000), make(second, 301_000, 901_000)];
        let snapshots = vec![
            InsightSnapshot {
                session_id: first,
                captured_at: DateTime::from_millis(1_000),
                viewers: Some(1.0),
                game_name: Some("A".into()),
            },
            InsightSnapshot {
                session_id: second,
                captured_at: DateTime::from_millis(301_000),
                viewers: Some(1.0),
                game_name: Some("B".into()),
            },
        ];
        let mut intervals = insight_intervals(&sessions, &snapshots);
        for at in [1_000, 301_000, 601_000, 901_000] {
            assign_insight_follow(&mut intervals, DateTime::from_millis(at));
        }
        assert_eq!(
            intervals.iter().map(|row| row.follows).collect::<Vec<_>>(),
            vec![1.0, 1.0]
        );
        let sessions = vec![make(first, 1_000, 601_001)];
        assert!(insight_intervals(&sessions, &snapshots[..1]).is_empty());
    }
}
