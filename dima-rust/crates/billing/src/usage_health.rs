//! The health of the usage queues, and the two operations the flush of the first half left for
//! this package.
//!
//! - [`monitor_queues`]: `monitorAiUsageQueues` (`utils/ai_usage_queue_health.ts`), as the
//!   native worker runs it every 10 s: per queue (receipts, backfills) the pending, processing
//!   and dead counts, the age of the oldest job and of the current claim, the failures since
//!   the last check, the reasons that need attention, a snapshot (`{health}:snapshot`, 5 min)
//!   and at most one alert per 5 min (`{health}:alert`).
//! - [`dead_letter_report`] and [`resolve_dead_letter`]: the usage events Polar refused for
//!   good (`twitch:{channel}:ai:polarshevent:dead`, [`crate::polar::flush`]): counts, oldest
//!   entry, reasons and credits per channel and in total; settling or requeuing one entry is an
//!   explicit operation with an operation id, applied once, never automatic.
//! - [`QuietFlush`]: a channel's usage queue drains on its next use; a channel that has gone
//!   quiet would keep its queued usage (money) indefinitely. One tick finds queues with waiting
//!   events (bounded `SCAN` pages, resumed by a cursor the caller keeps) and flushes them.
//!
//! The scans walk the key space with `SCAN … MATCH` in pages of [`ScanBounds::count`] for at
//! most [`ScanBounds::pages`] pages a call: a report that stops early says so
//! ([`DeadLetterReport::complete`]) and gives the cursor to continue.

use crate::Observer;
use crate::polar::OperationId;
use crate::polar::flush::{Flush, FlushReport, dead_letter_key, queue_key};
use crate::usage_ledger::report::{iso, num};
use crate::usage_queue::QueueKeys;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{
    Dragonfly, DragonflyError, Script, SetCondition, SetExpiry, SetOptions, SetOutcome,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Duration;

static RESOLVE: Script = Script::new(
    "USAGE_DEAD_LETTER_RESOLVE",
    include_str!("usage_health/dead_letter_resolve.lua"),
);

/// The scripts, for the tests that check them.
pub fn scripts() -> [&'static Script; 1] {
    [&RESOLVE]
}

/// The thresholds of the health check (the reference's environment variables).
#[derive(Clone, Debug)]
pub struct HealthConfig {
    /// `AI_USAGE_QUEUE_MAX_AGE_SECONDS` (900).
    pub queue_max_age_seconds: f64,
    /// `AI_USAGE_PROCESSING_MAX_AGE_SECONDS` (900).
    pub processing_max_age_seconds: f64,
    /// `AI_USAGE_QUEUE_FAILURE_THRESHOLD` (3).
    pub failure_threshold: f64,
}

impl Default for HealthConfig {
    fn default() -> Self {
        Self {
            queue_max_age_seconds: 900.0,
            processing_max_age_seconds: 900.0,
            failure_threshold: 3.0,
        }
    }
}

/// One queue's health (`status` of the reference).
#[derive(Clone, Debug, PartialEq)]
pub struct QueueStatus {
    /// `queue`.
    pub queue: &'static str,
    /// `pending`.
    pub pending: i64,
    /// `processing`.
    pub processing: i64,
    /// `dead`.
    pub dead: i64,
    /// `oldestAgeSeconds`.
    pub oldest_age_seconds: f64,
    /// `processingAgeSeconds`.
    pub processing_age_seconds: f64,
    /// `failures`.
    pub failures: f64,
    /// `reasons`.
    pub reasons: Vec<&'static str>,
    /// `checkedAt` (ms).
    pub checked_at_ms: i64,
}

impl QueueStatus {
    /// The snapshot's JSON.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("queue".into(), Value::from(self.queue));
        map.insert("pending".into(), Value::from(self.pending));
        map.insert("processing".into(), Value::from(self.processing));
        map.insert("dead".into(), Value::from(self.dead));
        map.insert("oldestAgeSeconds".into(), num(self.oldest_age_seconds));
        map.insert(
            "processingAgeSeconds".into(),
            num(self.processing_age_seconds),
        );
        map.insert("failures".into(), num(self.failures));
        map.insert(
            "reasons".into(),
            Value::Array(self.reasons.iter().map(|r| Value::from(*r)).collect()),
        );
        map.insert("checkedAt".into(), Value::from(iso(self.checked_at_ms)));
        Value::Object(map)
    }
}

fn field(fields: &[(String, String)], key: &str) -> f64 {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

/// The text of a number as the native worker writes it to the health hash (`f64` `Display`).
fn number_text(value: f64) -> String {
    format!("{value}")
}

/// `monitorAiUsageQueues(cache, now)` over `queues`; the alert goes to `observer`.
pub async fn monitor_queues(
    dragonfly: &Dragonfly,
    queues: &[&QueueKeys],
    config: &HealthConfig,
    now_ms: i64,
    observer: &dyn Observer,
) -> Result<Vec<QueueStatus>, DragonflyError> {
    let mut statuses = Vec::with_capacity(queues.len());
    for keys in queues {
        let len = |key: &str| {
            let key = key.to_owned();
            async move { dragonfly.query::<i64>(redis::cmd("LLEN").arg(key)).await }
        };
        let pending = len(&keys.queue).await?;
        let processing = len(&keys.processing).await?;
        let dead = len(&keys.dead).await?;
        let oldest: Option<Vec<u8>> = reply::bytes_or_nil(
            dragonfly
                .query_value(redis::cmd("LINDEX").arg(&keys.queue).arg(0))
                .await?,
        )?;
        let previous = dragonfly.hgetall(&keys.health).await?;
        let queued_at = oldest
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            .and_then(|job| {
                let enqueued = job.get("enqueuedAt").filter(|v| crate::js::truthy(Some(v)));
                enqueued
                    .or_else(|| job.get("requestedAt"))
                    .and_then(Value::as_str)
                    .and_then(dima_text::parse_date)
            })
            .filter(|at| *at != 0);
        #[allow(clippy::cast_precision_loss)]
        let now = now_ms as f64;
        let pending_since = if pending > 0 {
            let since = field(&previous, "pendingSince");
            if since != 0.0 { since } else { now }
        } else {
            0.0
        };
        #[allow(clippy::cast_precision_loss)]
        let oldest_age = if pending > 0 {
            ((now - queued_at.map_or(pending_since, |at| at as f64)) / 1000.0).max(0.0)
        } else {
            0.0
        };
        let processing_since = field(&previous, "processingSince");
        let processing_age = if processing > 0 {
            ((now
                - if processing_since != 0.0 {
                    processing_since
                } else {
                    now
                })
                / 1000.0)
                .max(0.0)
        } else {
            0.0
        };
        let failures = field(&previous, "failures");
        let mut reasons = Vec::new();
        if oldest_age > config.queue_max_age_seconds {
            reasons.push("queue_age");
        }
        if processing_age > config.processing_max_age_seconds {
            reasons.push("processing_stalled");
        }
        if dead > 0 {
            reasons.push("dead_letters");
        }
        if failures - field(&previous, "observedFailures") >= config.failure_threshold {
            reasons.push("repeated_failures");
        }
        let status = QueueStatus {
            queue: keys.name,
            pending,
            processing,
            dead,
            oldest_age_seconds: oldest_age,
            processing_age_seconds: processing_age,
            failures,
            reasons,
            checked_at_ms: now_ms,
        };
        let snapshot = dima_text::to_js_json(&status.to_json());
        dragonfly
            .set(
                &keys.snapshot(),
                snapshot.as_bytes(),
                SetOptions {
                    condition: SetCondition::Always,
                    expiry: SetExpiry::Seconds(300),
                    get: false,
                },
            )
            .await?;
        let (since, observed) = (number_text(pending_since), number_text(failures));
        dragonfly
            .hset(
                &keys.health,
                &[
                    ("pendingSince", since.as_bytes()),
                    ("observedFailures", observed.as_bytes()),
                ],
            )
            .await?;
        if !status.reasons.is_empty()
            && dragonfly
                .set(
                    &keys.alert(),
                    b"1",
                    SetOptions {
                        condition: SetCondition::IfMissing,
                        expiry: SetExpiry::Seconds(300),
                        get: false,
                    },
                )
                .await?
                == SetOutcome::Written
        {
            observer.error(
                "ai_usage_receipts",
                &format!("AI usage queue requires attention: {snapshot}"),
            );
        }
        statuses.push(status);
    }
    Ok(statuses)
}

/// Bounds of a key-space walk.
#[derive(Clone, Debug)]
pub struct ScanBounds {
    /// The `MATCH` pattern.
    pub pattern: String,
    /// The `COUNT` hint (500).
    pub count: u32,
    /// Pages a call walks at most (200).
    pub pages: u32,
}

impl ScanBounds {
    /// Every channel's usage keys (`twitch:*:ai:polarshevent*`).
    pub fn usage_keys() -> Self {
        Self {
            pattern: "twitch:*:ai:polarshevent*".into(),
            count: 500,
            pages: 200,
        }
    }
}

/// One `SCAN` page: the next cursor (`None` when the walk is complete) and the keys.
async fn scan_page(
    dragonfly: &Dragonfly,
    cursor: &str,
    bounds: &ScanBounds,
) -> Result<(Option<String>, Vec<String>), DragonflyError> {
    let value = dragonfly
        .query_value(
            redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(&bounds.pattern)
                .arg("COUNT")
                .arg(bounds.count),
        )
        .await?;
    let mut parts = reply::array(value)?.into_iter();
    let (Some(next), Some(keys), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(DragonflyError::Reply("SCAN returned an unexpected shape"));
    };
    let next = reply::text(next)?;
    let keys = reply::array(keys)?
        .into_iter()
        .map(reply::text)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(((next != "0").then_some(next), keys))
}

/// The channel of a usage key, and which list it is.
fn usage_key(key: &str) -> Option<(&str, UsageList)> {
    let rest = key.strip_prefix("twitch:")?;
    for (suffix, list) in [
        (":ai:polarshevent:processing", UsageList::Processing),
        (":ai:polarshevent:dead", UsageList::Dead),
        (":ai:polarshevent", UsageList::Queue),
    ] {
        if let Some(channel) = rest.strip_suffix(suffix)
            && !channel.is_empty()
        {
            return Some((channel, list));
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageList {
    Queue,
    Processing,
    Dead,
}

/// One channel's dead letters.
#[derive(Clone, Debug, PartialEq)]
pub struct ChannelDeadLetters {
    /// The channel.
    pub channel_id: String,
    /// Entries (the list's length).
    pub count: i64,
    /// When the oldest entry was set aside (ms).
    pub oldest_at_ms: Option<i64>,
    /// Entries per reason, over the entries read.
    pub reasons: BTreeMap<String, i64>,
    /// Credits of the entries read (what the channel used and Polar never counted).
    pub credits: f64,
    /// Every entry was read (at most [`MAX_ENTRIES_READ`] are).
    pub complete: bool,
}

/// The dead-letter report.
#[derive(Clone, Debug, PartialEq)]
pub struct DeadLetterReport {
    /// Per channel, in key order.
    pub channels: Vec<ChannelDeadLetters>,
    /// Entries in total.
    pub total_count: i64,
    /// Credits in total (of the entries read).
    pub total_credits: f64,
    /// Entries per reason in total.
    pub reasons: BTreeMap<String, i64>,
    /// The walk covered the whole key space.
    pub complete: bool,
    /// Where to continue when it did not.
    pub next_cursor: Option<String>,
}

/// Entries of one channel's list the report reads at most.
pub const MAX_ENTRIES_READ: i64 = 1000;

/// An entry's header and event: `({"reason","at"}, the event's JSON)`.
fn entry_parts(entry: &[u8]) -> (Option<Value>, Option<Value>) {
    let split = entry.iter().position(|b| *b == b'\n');
    let (head, body) = match split {
        Some(at) => (entry.get(..at), entry.get(at + 1..)),
        None => (None, Some(entry)),
    };
    let parse = |bytes: Option<&[u8]>| bytes.and_then(|b| serde_json::from_slice::<Value>(b).ok());
    (parse(head), parse(body))
}

/// Reads the usage dead-letter lists (see the module docs), starting at `cursor` (`"0"` for
/// the beginning).
pub async fn dead_letter_report(
    dragonfly: &Dragonfly,
    bounds: &ScanBounds,
    cursor: &str,
) -> Result<DeadLetterReport, DragonflyError> {
    let mut report = DeadLetterReport {
        channels: Vec::new(),
        total_count: 0,
        total_credits: 0.0,
        reasons: BTreeMap::new(),
        complete: false,
        next_cursor: None,
    };
    let mut cursor = cursor.to_owned();
    let mut seen: Vec<String> = Vec::new();
    for _ in 0..bounds.pages.max(1) {
        let (next, keys) = scan_page(dragonfly, &cursor, bounds).await?;
        for key in keys {
            let Some((channel, UsageList::Dead)) = usage_key(&key) else {
                continue;
            };
            if seen.iter().any(|c| c == channel) {
                continue;
            }
            seen.push(channel.to_owned());
            let count = dragonfly.query::<i64>(redis::cmd("LLEN").arg(&key)).await?;
            let entries: Vec<Vec<u8>> = dragonfly
                .query(
                    redis::cmd("LRANGE")
                        .arg(&key)
                        .arg(0)
                        .arg(MAX_ENTRIES_READ - 1),
                )
                .await?;
            let mut channel_report = ChannelDeadLetters {
                channel_id: channel.to_owned(),
                count,
                oldest_at_ms: None,
                reasons: BTreeMap::new(),
                credits: 0.0,
                complete: count <= MAX_ENTRIES_READ,
            };
            for (index, entry) in entries.iter().enumerate() {
                let (head, event) = entry_parts(entry);
                let reason = head
                    .as_ref()
                    .and_then(|h| h.get("reason"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                if index == 0 {
                    channel_report.oldest_at_ms = head
                        .as_ref()
                        .and_then(|h| h.get("at"))
                        .and_then(Value::as_i64);
                }
                let credits = event
                    .as_ref()
                    .and_then(|e| e.get("metadata"))
                    .and_then(|m| m.get("credits"))
                    .and_then(Value::as_f64)
                    .filter(|c| c.is_finite())
                    .unwrap_or(0.0);
                channel_report.credits += credits;
                *channel_report.reasons.entry(reason.clone()).or_default() += 1;
                *report.reasons.entry(reason).or_default() += 1;
            }
            report.total_count += count;
            report.total_credits += channel_report.credits;
            report.channels.push(channel_report);
        }
        match next {
            Some(next) => cursor = next,
            None => {
                report.complete = true;
                return Ok(report);
            }
        }
    }
    report.next_cursor = Some(cursor);
    Ok(report)
}

/// What an operator does with a dead letter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolve {
    /// Drop it: the operator credited the channel or decided it is not owed.
    Settle,
    /// Send it again: its bytes after the header go back to the usage queue.
    Requeue,
}

/// What [`resolve_dead_letter`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    /// `settled`, `requeued`, `missing` (no such entry) or `conflict` (the operation id was
    /// used for another entry or action).
    pub outcome: String,
    /// The operation had already run: nothing changed now.
    pub repeated: bool,
}

/// How long an operation's record is kept (30 days): a repeat within it is a no-op.
pub const RESOLUTION_RECORD_SECONDS: u64 = 30 * 24 * 60 * 60;

/// `billing:usage-dead-letter:op:{operation id}`.
pub fn resolution_key(operation: &OperationId) -> String {
    format!("billing:usage-dead-letter:op:{operation}")
}

/// Settles or requeues one dead-letter entry of `channel` (its exact bytes, as the report or
/// an `LRANGE` gave them), once per `operation`: the operation's record makes a repeat (a retry
/// after a lost reply, a second click) answer the first outcome and change nothing.
///
/// The entry holds its event's debit against Polar's figure, and the hold goes with it (item 3 of
/// P2-BILLING-02c, [`crate::plans::balance`]): a requeued event is held by the queue (once), a
/// settled one is released at once.
pub async fn resolve_dead_letter(
    dragonfly: &Dragonfly,
    channel: &str,
    entry: &[u8],
    operation: &OperationId,
    action: Resolve,
) -> Result<Resolution, DragonflyError> {
    let hash = hex::encode(Sha256::digest(entry));
    let action_text = match action {
        Resolve::Settle => "settle",
        Resolve::Requeue => "requeue",
    };
    let ttl = RESOLUTION_RECORD_SECONDS.to_string();
    let keys = [
        dead_letter_key(channel),
        queue_key(channel),
        resolution_key(operation),
    ];
    let value = RESOLVE
        .run_value(
            dragonfly,
            &[keys[0].as_bytes(), keys[1].as_bytes(), keys[2].as_bytes()],
            &[
                entry,
                action_text.as_bytes(),
                hash.as_bytes(),
                ttl.as_bytes(),
            ],
        )
        .await?;
    let mut parts = reply::array(value)?.into_iter();
    let (Some(repeated), Some(outcome), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(DragonflyError::Reply("unexpected resolution reply"));
    };
    Ok(Resolution {
        repeated: reply::int(repeated)? == 1,
        outcome: reply::text(outcome)?,
    })
}

/// The quiet flush's settings.
#[derive(Clone, Debug)]
pub struct QuietFlushConfig {
    /// The walk (`twitch:*:ai:polarshevent*`).
    pub scan: ScanBounds,
    /// A queue whose oldest event is younger than this is left to its channel's own flush
    /// (60 s).
    pub quiet_after_ms: i64,
    /// Channels one tick flushes at most (20).
    pub max_channels: usize,
    /// After this long a tick starts no more flushes (60 s).
    pub tick_deadline: Duration,
}

impl Default for QuietFlushConfig {
    fn default() -> Self {
        Self {
            scan: ScanBounds {
                pages: 20,
                ..ScanBounds::usage_keys()
            },
            quiet_after_ms: 60_000,
            max_channels: 20,
            tick_deadline: Duration::from_secs(60),
        }
    }
}

/// What one tick did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuietFlushReport {
    /// The channels flushed, with what each flush did.
    pub flushed: Vec<(String, FlushReport)>,
    /// Channels whose lease another flush held (left to it).
    pub busy: usize,
    /// The cursor of the next tick (`"0"`: the walk starts again).
    pub next_cursor: String,
}

/// The periodic flush of channels that have gone quiet.
#[derive(Clone, Copy)]
pub struct QuietFlush<'a> {
    /// The flush.
    pub flush: Flush<'a>,
    /// Dragonfly.
    pub dragonfly: &'a Dragonfly,
    /// Settings.
    pub config: &'a QuietFlushConfig,
}

impl std::fmt::Debug for QuietFlush<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("QuietFlush")
    }
}

impl QuietFlush<'_> {
    /// Whether `channel`'s queue needs a flush now: an unfinished batch (its processing list),
    /// or a queue whose oldest event waited [`QuietFlushConfig::quiet_after_ms`].
    async fn waiting(&self, channel: &str, now_ms: i64) -> Result<bool, DragonflyError> {
        let processing = crate::polar::flush::processing_key(channel);
        if self
            .dragonfly
            .query::<i64>(redis::cmd("LLEN").arg(&processing))
            .await?
            > 0
        {
            return Ok(true);
        }
        let head: Option<Vec<u8>> = reply::bytes_or_nil(
            self.dragonfly
                .query_value(redis::cmd("LINDEX").arg(queue_key(channel)).arg(0))
                .await?,
        )?;
        let Some(head) = head else {
            return Ok(false);
        };
        let queued_at = serde_json::from_slice::<Value>(&head)
            .ok()
            .and_then(|event| event.get("queuedAt").and_then(Value::as_i64));
        // An event without `queuedAt` cannot be dated: it is flushed.
        Ok(queued_at.is_none_or(|at| now_ms - at >= self.config.quiet_after_ms))
    }

    /// One tick from `cursor` (`"0"` to start): walks at most the configured pages and flushes
    /// at most the configured channels, each under its lease taken without waiting.
    pub async fn tick(&self, cursor: &str) -> Result<QuietFlushReport, DragonflyError> {
        let started = tokio::time::Instant::now();
        let now = self.flush.clock.now_ms();
        let mut report = QuietFlushReport {
            flushed: Vec::new(),
            busy: 0,
            next_cursor: "0".into(),
        };
        let mut cursor = cursor.to_owned();
        let mut seen: Vec<String> = Vec::new();
        for _ in 0..self.config.scan.pages.max(1) {
            let (next, keys) = scan_page(self.dragonfly, &cursor, &self.config.scan).await?;
            for key in keys {
                let Some((channel, list)) = usage_key(&key) else {
                    continue;
                };
                if list == UsageList::Dead || seen.iter().any(|c| c == channel) {
                    continue;
                }
                seen.push(channel.to_owned());
                if report.flushed.len() >= self.config.max_channels
                    || started.elapsed() >= self.config.tick_deadline
                {
                    // Start the next tick here: this page is walked again.
                    report.next_cursor = cursor;
                    return Ok(report);
                }
                if !self.waiting(channel, now).await? {
                    continue;
                }
                match self.flush.try_acquire(channel).await? {
                    None => report.busy += 1,
                    Some(lease) => {
                        let flushed = self.flush.run(channel, &lease).await;
                        self.flush.release(channel, &lease).await;
                        report.flushed.push((channel.to_owned(), flushed));
                    }
                }
            }
            match next {
                Some(next) => cursor = next,
                None => return Ok(report),
            }
        }
        report.next_cursor = cursor;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_keys_name_their_channel_and_list() {
        assert_eq!(
            usage_key("twitch:12:ai:polarshevent"),
            Some(("12", UsageList::Queue))
        );
        assert_eq!(
            usage_key("twitch:12:ai:polarshevent:processing"),
            Some(("12", UsageList::Processing))
        );
        assert_eq!(
            usage_key("twitch:12:ai:polarshevent:dead"),
            Some(("12", UsageList::Dead))
        );
        assert_eq!(usage_key("twitch::ai:polarshevent"), None);
        assert_eq!(usage_key("twitch:12:ai:polarshevent:other"), None);
        for script in scripts() {
            assert!(script.check().is_ok());
        }
        assert_eq!(number_text(1_794_355_200_000.0), "1794355200000");
    }
}
