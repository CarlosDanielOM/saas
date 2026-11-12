//! Production raid scheduling, follow-window comparison and period helpers.
use super::raid_analytics::{malformed, raid_range_start};
use crate::Error;
use bson::{Bson, DateTime, Document, doc};
use serde::{Deserialize, Serialize};
type Result<T> = std::result::Result<T, Error>;
const REPAIR_MS: i64 = 900_000;
#[derive(Deserialize)]
pub(super) struct State {
    #[serde(rename = "_id")]
    pub(super) id: String,
    #[serde(default, rename = "dirtyAt")]
    pub(super) dirty_at: Option<DateTime>,
    #[serde(default, rename = "nextRefreshAt")]
    pub(super) next_refresh_at: Option<DateTime>,
    #[serde(default)]
    pub(super) payload: Option<Document>,
    #[serde(default, rename = "rustRefresh")]
    pub(super) refresh: Option<RefreshState>,
    #[serde(default, rename = "rustPending")]
    pub(super) pending: bool,
    #[serde(default)]
    pub(super) error: bool,
}

/// Private scheduling metadata in the existing summary document. Nothing is
/// added to the dashboard payload or the immutable domain-event journal.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RefreshState {
    pub(super) version: i32,
    pub(super) fingerprint: String,
    pub(super) next_source_at: Option<DateTime>,
    pub(super) next_repair_at: Option<DateTime>,
    pub(super) next_open_at: Option<DateTime>,
    pub(super) dirty_at: Option<DateTime>,
    pub(super) has_follow_windows: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FollowRow {
    #[serde(rename = "_id")]
    pub(super) id: String,
    pub(super) occurred_at: DateTime,
    #[serde(default)]
    pub(super) follows_after: Option<Bson>,
    #[serde(default)]
    pub(super) follow_window_end: Option<DateTime>,
    #[serde(default)]
    pub(super) follows_computed_at: Option<DateTime>,
}

#[derive(Default)]
pub(super) struct FollowRefresh {
    pub(super) changed: bool,
    pub(super) pending: bool,
    pub(super) next_open_at: Option<DateTime>,
}

pub(super) struct SourceState {
    pub(super) fingerprint: String,
    pub(super) next_source_at: Option<DateTime>,
    pub(super) has_follow_windows: bool,
}

pub(super) fn needs_source_check(
    state: &State,
    previous: Option<&RefreshState>,
    follows_changed: bool,
    now: DateTime,
) -> bool {
    state.pending || state.error || follows_changed
        || previous.is_none_or(|refresh| {
            refresh.dirty_at != state.dirty_at
                || refresh.next_source_at.is_some_and(|at| at <= now)
        })
        // TS queueRaidSummary writes the same timestamp to both fields. A
        // producer can queue two different raids within one millisecond, so
        // equal remembered dirtyAt alone is insufficient to detect its write.
        || state.dirty_at.is_some_and(|at| state.next_refresh_at == Some(at))
}

pub(super) fn earliest(current: &mut Option<DateTime>, candidate: Option<DateTime>) {
    if let Some(candidate) = candidate {
        *current = Some(current.map_or(candidate, |current| current.min(candidate)));
    }
}

pub(super) fn next_refresh_at(
    refresh: &RefreshState,
    pending: bool,
    now: DateTime,
) -> Option<DateTime> {
    if pending {
        return Some(now);
    }
    let mut next = refresh.next_source_at;
    earliest(&mut next, refresh.next_repair_at);
    earliest(&mut next, refresh.next_open_at);
    next
}

pub(super) fn follow_due_filter(channel: &str, now: DateTime) -> Document {
    doc! {
        "channelID": channel, "direction": "incoming",
        "occurredAt": { "$gte": raid_range_start(30, now), "$lte": now },
        "expiresAt": { "$gt": now },
        "$or": [
            { "followsComputedAt": Bson::Null },
            { "followsComputedAt": { "$lte": DateTime::from_millis(now.timestamp_millis() - REPAIR_MS) } },
        ],
    }
}

fn same_count(value: Option<&Bson>, count: u64) -> bool {
    match value {
        Some(Bson::Int32(value)) => *value >= 0 && *value as u64 == count,
        Some(Bson::Int64(value)) => *value >= 0 && *value as u64 == count,
        Some(Bson::Double(value)) => *value == count as f64,
        _ => false,
    }
}

pub(super) fn follow_values(
    row: &FollowRow,
    count: u64,
    end: DateTime,
    computed: DateTime,
) -> (Document, bool) {
    let count_changed = !same_count(row.follows_after.as_ref(), count);
    let finalized = computed.timestamp_millis() != 0;
    // Moving open-window time is not fresh source data. Retain the last
    // evaluated end until a count changes or the exact final end is known.
    let end_changed = (count_changed || finalized) && row.follow_window_end != Some(end);
    let mut values = Document::new();
    if count_changed {
        // Match Mongoose Number's int32-or-JS-double serialization.
        values.insert(
            "followsAfter",
            i32::try_from(count).map_or_else(|_| Bson::Double(count as f64), Bson::Int32),
        );
    }
    if end_changed {
        values.insert("followWindowEnd", end);
    }
    if row.follows_computed_at != Some(computed) {
        // Closed checks advance only this scheduling field when unchanged;
        // open checks with no data change perform no history write at all.
        values.insert("followsComputedAt", computed);
    }
    (values, count_changed || end_changed)
}

pub(super) fn same_payload(old: &Document, candidate: &Document) -> bool {
    fn stable(payload: &Document) -> Document {
        let mut payload = payload.clone();
        for key in ["7", "30"] {
            if let Ok(period) = payload.get_document_mut(key) {
                period.remove("to");
                // $group does not promise direction order. The recent/top
                // arrays are explicitly ordered and must remain untouched.
                if let Ok(totals) = period.get_array_mut("totals") {
                    totals.sort_by(|left, right| {
                        let left = left
                            .as_document()
                            .and_then(|row| row.get_str("_id").ok())
                            .unwrap_or("");
                        let right = right
                            .as_document()
                            .and_then(|row| row.get_str("_id").ok())
                            .unwrap_or("");
                        left.cmp(right)
                    });
                }
            }
        }
        payload
    }
    stable(old) == stable(candidate)
}

pub(super) fn period_peers(data: &Document) -> Result<Vec<Bson>> {
    let mut peers = Vec::with_capacity(10);
    for (key, field) in [("incoming", "peerID"), ("topIncoming", "_id")] {
        for row in data.get_array(key).map_err(|_| malformed())? {
            let row = row.as_document().ok_or_else(malformed)?;
            let peer = row.get(field).cloned().unwrap_or(Bson::Null);
            if !peers.contains(&peer) {
                peers.push(peer);
            }
        }
    }
    Ok(peers)
}

pub(super) fn attach_outgoing(data: &mut Document, outgoing: &[Document]) -> Result<()> {
    for (key, field) in [("incoming", "peerID"), ("topIncoming", "_id")] {
        for row in data.get_array_mut(key).map_err(|_| malformed())? {
            let row = row.as_document_mut().ok_or_else(malformed)?;
            let last = outgoing
                .iter()
                .find(|sent| sent.get("_id") == row.get(field))
                .and_then(|sent| sent.get("lastAt"))
                .cloned()
                .unwrap_or(Bson::Null);
            row.insert("lastOutgoingAt", last);
        }
    }
    Ok(())
}

pub(super) fn period_payload(data: Document, days: u32, now: DateTime) -> Document {
    let mut period = doc! { "days": days as i32, "from": raid_range_start(days, now), "to": now };
    period.extend(data);
    period
}
