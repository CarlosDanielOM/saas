//! Reads: the dashboard list, the pending count, recall from Qdrant, the MongoDB validation of
//! recalled ids, a viewer's known facts, and usage counts. The channel is always the caller's
//! `channel_id` argument, put into every MongoDB and Qdrant filter here; no caller passes a
//! filter object of its own.

use super::rules::parse_object_id;
use super::{ErrorKind, MemoryError, MemoryStore, Private, StoredMemory};
use crate::embeddings::Kind;
use crate::memory::{
    Policy, ScoredMemory, ValidatedMemory, ValidationRecord, select_validated_channel_memories,
};
use crate::qdrant::{
    MemoryRetrievalMode, MemorySubjectScope, RetrieveMemoryContextParams, RetrievedMemoryItem,
};
use super::rules::{policy_kind, policy_risk, policy_scope};
use bson::{Bson, doc, oid::ObjectId};
use dima_model::channel_ai_memories::{ChannelAiMemory, INFO};
use dima_store::mongo::date::JsDate;
use futures_util::TryStreamExt;
use serde::Serialize;

/// `listChannelMemories` input.
#[derive(Clone, Debug, Default)]
pub struct ListMemories {
    /// The caller's authorised channel.
    pub channel_id: String,
    /// Statuses to include (empty: all). Unknown values match nothing.
    pub statuses: Vec<String>,
    /// One type (unknown values match nothing).
    pub kind: Option<String>,
    /// Page size (`Number(limit || 50)` clamped to 1..200).
    pub limit: Option<f64>,
    /// Documents to skip (`Number(skip || 0)`, at least 0).
    pub skip: Option<f64>,
}

/// A page of memories, newest update first.
#[derive(Clone, Debug)]
pub struct ListedMemories {
    /// The page.
    pub items: Vec<StoredMemory>,
    /// Every match.
    pub total: u64,
}

/// `getKnownUserMemoryContext` input.
#[derive(Clone, Debug)]
pub struct KnownUserQuery {
    /// The channel.
    pub channel_id: String,
    /// The viewer.
    pub user_id: String,
    /// At most (1 to 10).
    pub limit: usize,
    /// Include medium and high risk facts.
    pub allow_sensitive_memories: bool,
}

/// One confirmed fact about a viewer.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct KnownUserFact {
    /// `_id`.
    pub memory_id: String,
    /// Its type.
    pub memory_type: String,
    /// Its risk.
    pub risk: String,
    /// Confidence.
    pub confidence: f64,
    /// Summary (private).
    #[serde(serialize_with = "expose")]
    pub summary: Private<String>,
    /// Last update, epoch seconds (0 when missing).
    pub updated_at: i64,
}

fn expose<S: serde::Serializer>(value: &Private<String>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(value.expose())
}

/// A recalled id and its score, to validate against MongoDB.
#[derive(Clone, Debug)]
pub struct ScoredCandidate {
    /// `memory_id` from the point.
    pub memory_id: String,
    /// Its score.
    pub score: f64,
}

/// `retrieveChannelMemoryContext` input.
#[derive(Clone, Debug)]
pub struct RecallQuery {
    /// The caller's channel: the only channel whose points can come back.
    pub channel_id: String,
    /// What to recall (private; cut to `Config::max_query_chars` before embedding).
    pub query: Private<String>,
    /// At most this many items.
    pub limit: usize,
    /// Score threshold (default: 0.55 explicit, 0.45 passive with the relevance rule).
    pub min_score: Option<f64>,
    /// Passive (chat context) or explicit (the recall tool).
    pub mode: MemoryRetrievalMode,
    /// Channel memories only, or viewer memories too.
    pub subject_scope: MemorySubjectScope,
}

fn js_limit(value: Option<f64>, default: f64, max: f64) -> Option<i64> {
    // `Math.max(1, Math.min(max, Number(value || default)))`; NaN stays NaN, which Mongoose
    // sends as no limit at all.
    let v = match value {
        Some(v) if v != 0.0 && !v.is_nan() => v,
        Some(v) if v.is_nan() => return None,
        _ => default,
    };
    Some(v.min(max).max(1.0) as i64)
}

impl MemoryStore {
    /// `listChannelMemories`: filtered by status and type, `updatedAt` descending.
    pub async fn list(&self, params: &ListMemories) -> Result<ListedMemories, MemoryError> {
        const FAILED: &str = "Failed to list memories";
        let mut filter = doc! { "channelID": &params.channel_id };
        if !params.statuses.is_empty() {
            filter.insert("status", doc! { "$in": &params.statuses });
        }
        if let Some(kind) = &params.kind {
            filter.insert("type", kind);
        }
        let limit = js_limit(params.limit, 50.0, 200.0);
        let skip = match params.skip {
            Some(v) if v.is_nan() => None,
            Some(v) if v != 0.0 => Some(v.max(0.0) as u64),
            _ => Some(0),
        };
        let collection = self.mongo.documents(INFO.name);
        let mut find = collection.find(filter.clone()).sort(doc! { "updatedAt": -1 });
        if let Some(skip) = skip.filter(|s| *s > 0) {
            find = find.skip(skip);
        }
        if let Some(limit) = limit {
            find = find.limit(limit);
        }
        let page = async {
            let cursor = find.await?;
            cursor.try_collect::<Vec<_>>().await
        };
        let total = collection.count_documents(filter);
        let (items, total) = self
            .mongo_call("listChannelMemories", async {
                tokio::try_join!(page, async { total.await })
            })
            .await
            .map_err(|e| e.generic(FAILED))?;
        Ok(ListedMemories {
            items: items
                .into_iter()
                .map(|document| StoredMemory { document })
                .collect(),
            total,
        })
    }

    /// `getChannelMemoryPendingCount` (0 on failure, as the reference).
    pub async fn pending_count(&self, channel_id: &str) -> u64 {
        self.mongo_call(
            "getChannelMemoryPendingCount",
            self.mongo
                .documents(INFO.name)
                .count_documents(doc! { "channelID": channel_id, "status": "pending_review" }),
        )
        .await
        .unwrap_or(0)
    }

    /// `getKnownUserMemoryContext`: confirmed, unexpired `known_user_fact`s about one viewer,
    /// by confidence, last use and update (empty on failure, as the reference).
    pub async fn known_user_facts(&self, q: &KnownUserQuery) -> Vec<KnownUserFact> {
        let channel_id = dima_text::trim(&q.channel_id);
        let user_id = dima_text::trim(&q.user_id);
        if channel_id.is_empty() || user_id.is_empty() {
            return Vec::new();
        }
        let limit = i64::try_from(q.limit.clamp(1, 10)).unwrap_or(1);
        let now = JsDate(self.clock.now_ms()).to_bson();
        let mut filter = doc! {
            "channelID": channel_id,
            "status": "confirmed",
            "type": "known_user_fact",
            "subject.scope": "user",
            "subject.userID": user_id,
            "$and": [{ "$or": [
                { "expiresAt": { "$exists": false } },
                { "expiresAt": Bson::Null },
                { "expiresAt": { "$gt": now } },
            ] }],
        };
        if !q.allow_sensitive_memories {
            filter.insert("risk", "low");
        }
        let read = async {
            let cursor = self
                .mongo
                .documents(INFO.name)
                .find(filter)
                .sort(doc! { "confidence": -1, "lastUsedAt": -1, "updatedAt": -1 })
                .limit(limit)
                .projection(doc! { "_id": 1, "type": 1, "risk": 1, "confidence": 1, "summary": 1, "updatedAt": 1 })
                .await?;
            cursor.try_collect::<Vec<_>>().await
        };
        let Ok(found) = self.mongo_call("getKnownUserMemoryContext", read).await else {
            return Vec::new();
        };
        found
            .iter()
            .map(|d| KnownUserFact {
                memory_id: d.get_object_id("_id").map(|i| i.to_hex()).unwrap_or_default(),
                memory_type: d.get_str("type").unwrap_or_default().to_owned(),
                risk: d.get_str("risk").unwrap_or_default().to_owned(),
                confidence: d
                    .get("confidence")
                    .and_then(dima_store::mongo::number::JsNumber::from_bson)
                    .map(|n| n.0)
                    .filter(|n| !n.is_nan())
                    .unwrap_or(0.0),
                summary: Private::new(d.get_str("summary").unwrap_or_default().to_owned()),
                updated_at: match d.get("updatedAt") {
                    Some(Bson::DateTime(t)) => t.timestamp_millis().div_euclid(1000),
                    _ => 0,
                },
            })
            .collect()
    }

    /// `validateChannelMemoryContext`: keeps the recalled ids that are confirmed, unexpired
    /// memories of `channel_id` allowed by `policy`, in candidate order, at most `limit`.
    /// Empty on failure, as the reference.
    pub async fn validate_context(
        &self,
        channel_id: &str,
        candidates: &[ScoredCandidate],
        limit: usize,
        policy: &Policy,
    ) -> Vec<ValidatedMemory> {
        let candidates: Vec<ScoredMemory> = candidates
            .iter()
            .filter(|c| parse_object_id(&c.memory_id).is_some())
            .map(|c| ScoredMemory {
                memory_id: c.memory_id.clone(),
                score: c.score,
            })
            .collect();
        if channel_id.is_empty() || candidates.is_empty() || limit == 0 {
            return Vec::new();
        }
        let ids: Vec<ObjectId> = candidates
            .iter()
            .filter_map(|c| parse_object_id(&c.memory_id))
            .collect();
        let read = async {
            let cursor = self
                .mongo
                .documents(INFO.name)
                .find(doc! { "_id": { "$in": ids }, "channelID": channel_id })
                .await?;
            cursor.try_collect::<Vec<_>>().await
        };
        let Ok(found) = self.mongo_call("validateChannelMemoryContext", read).await else {
            return Vec::new();
        };
        let records: Vec<ValidationRecord> = found
            .iter()
            .filter_map(|d| dima_model::decode_document::<ChannelAiMemory>(d).ok())
            .filter_map(|m| {
                Some(ValidationRecord {
                    memory_id: m.id.to_hex(),
                    channel_id: m.channel_id,
                    status: m.status.as_str().to_owned(),
                    kind: policy_kind(m.kind.known()?),
                    risk: policy_risk(m.risk.known()?),
                    subject_scope: policy_scope(m.subject.scope.known()?),
                    subject_username: Some(m.subject.username),
                    summary: m.summary.into_inner(),
                    expires_at: m.expires_at.map(|d| d.0),
                })
            })
            .collect();
        select_validated_channel_memories(
            channel_id,
            &candidates,
            &records,
            policy,
            limit,
            self.clock.now_ms(),
        )
    }

    /// `recordChannelMemoryUsage`: `useCount + 1`, `lastUsedAt` and `updatedAt` now, for the
    /// memories of `channel_id` among `memory_ids`. Ids that are not ObjectIds are skipped (the
    /// reference's cast error dropped the whole update). Failures are reported, not returned.
    pub async fn record_usage(&self, channel_id: &str, memory_ids: &[String]) {
        let ids: Vec<ObjectId> = memory_ids.iter().filter_map(|i| parse_object_id(i)).collect();
        if channel_id.is_empty() || ids.is_empty() {
            return;
        }
        let mut ctx = self.ctx();
        let now = JsDate(ctx.now_ms()).to_bson();
        let Ok(prepared) = INFO.prepare_update(
            &doc! { "channelID": channel_id, "_id": { "$in": ids } },
            doc! { "$inc": { "useCount": 1 }, "$set": { "lastUsedAt": now.clone(), "updatedAt": now } },
            dima_store::mongo::update::UpdateOptions::default(),
            &mut ctx,
        ) else {
            self.observer.failed("recordChannelMemoryUsage");
            return;
        };
        let mut writes = self.mongo.writes(INFO.name);
        let _ = self
            .mongo_call("recordChannelMemoryUsage", writes.update_many(&prepared))
            .await;
    }

    /// `retrieveChannelMemoryContext`: one embedding of the query, then the crate's Qdrant
    /// recall, whose filter is always this channel and `confirmed`.
    pub async fn recall(&self, q: &RecallQuery) -> Result<Vec<RetrievedMemoryItem>, MemoryError> {
        let query: String = q
            .query
            .expose()
            .chars()
            .take(self.config.max_query_chars)
            .collect();
        if q.channel_id.is_empty() || query.is_empty() || q.limit == 0 {
            return Err(MemoryError::new(
                ErrorKind::Invalid,
                "Missing required parameters",
            ));
        }
        let vector = self.embed(&query, Kind::Query, &q.channel_id).await?;
        let params = RetrieveMemoryContextParams {
            channel_id: q.channel_id.clone(),
            query,
            limit: q.limit,
            min_score: q.min_score,
            mode: q.mode,
            subject_scope: q.subject_scope,
        };
        let call = self.qdrant.retrieve_channel_memory_context(&params, &vector);
        let result = tokio::time::timeout(self.config.qdrant_timeout, call)
            .await
            .map_err(|_| {
                MemoryError::new(ErrorKind::Index, "Failed to retrieve channel memory context")
            })?;
        if result.error {
            return Err(MemoryError::new(
                ErrorKind::Index,
                result
                    .message
                    .unwrap_or_else(|| "Failed to retrieve channel memory context".into()),
            ));
        }
        // The crate's recall already keeps only this channel's points; checked again here.
        Ok(result
            .items
            .into_iter()
            .filter(|i| i.channel_id == q.channel_id)
            .collect())
    }
}
