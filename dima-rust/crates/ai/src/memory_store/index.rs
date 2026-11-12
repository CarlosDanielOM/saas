//! The Qdrant side: point ids, embedding, owner-checked upserts and deletes, and the repair.
//!
//! The upsert and the delete of one point are the crate's `qdrant::Client` calls (their owner
//! checks, payload shape and point ids are the reference's). The repair needs two calls that
//! client does not offer: a retrieve of many points and a scroll. **Seam:** they are sent here
//! with the same HTTP client and provider; the wanted change is `qdrant::Client` exposing
//! `retrieve_memory_points(ids)` and `scroll_memory_points(filter, offset, limit)`.

use super::{ErrorKind, MemoryError, MemoryStore, Step, StoredMemory, rules};
use crate::embeddings::Kind;
use crate::memory::memory_unix_seconds;
use crate::qdrant::{
    UpsertChannelMemoryParams, build_memory_embedding_input, generate_qdrant_point_id,
    qdrant_point_belongs_to_memory,
};
use bson::{Bson, doc, oid::ObjectId};
use dima_http::{Method, Path};
use dima_model::channel_ai_memories::{ChannelAiMemory, INFO, MemoryStatus};
use dima_store::mongo::number::js_number;
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const COLLISION_DELETE: &str =
    "Qdrant point ID collision detected; refusing to delete another memory";

/// What [`MemoryStore::repair`] found and did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepairReport {
    /// Documents examined.
    pub documents: u64,
    /// Points written again (missing or stale for a confirmed memory).
    pub points_written: u64,
    /// Points deleted for memories that are not confirmed.
    pub points_removed: u64,
    /// Points deleted that belong to no confirmed memory (ghosts).
    pub ghosts_removed: u64,
    /// Confirmed memories whose point id is held by another memory (cannot be indexed).
    pub collisions: u64,
    /// Points that could not be written or deleted (left for the next run).
    pub failures: u64,
}

/// Which memories a repair covers.
#[derive(Clone, Copy, Debug)]
pub enum RepairScope<'a> {
    /// One channel.
    Channel(&'a str),
    /// Every channel, and every point of the collection.
    All,
}

/// `resolveMemoryQdrantPointID`: the stored id when it is a non-negative integer, else derived
/// from the channel, the id and the creation second (the ObjectId's time when `createdAt` is
/// missing).
pub(crate) fn resolve_point_id(memory: &ChannelAiMemory) -> f64 {
    if let Some(stored) = memory.qdrant_point_id
        && stored.0.is_finite()
        && stored.0 >= 0.0
        && stored.0.fract() == 0.0
    {
        return stored.0;
    }
    f64::from(generate_qdrant_point_id(
        &memory.channel_id,
        &memory.id.to_hex(),
        created_secs(memory) as f64,
    ))
}

fn created_secs(memory: &ChannelAiMemory) -> i64 {
    memory_unix_seconds(
        memory.created_at.map(|d| d.0),
        memory.id.timestamp().timestamp_millis(),
    )
}

fn updated_secs(memory: &ChannelAiMemory) -> i64 {
    memory_unix_seconds(
        memory.updated_at.map(|d| d.0),
        memory.id.timestamp().timestamp_millis(),
    )
}

/// Whether the stored point id must be written (missing or not a usable id).
pub(crate) fn point_id_change(memory: &ChannelAiMemory) -> Option<(String, Bson)> {
    let resolved = resolve_point_id(memory);
    (memory.qdrant_point_id.map(|n| n.0) != Some(resolved))
        .then(|| ("qdrantPointID".to_owned(), js_number(resolved)))
}

/// The payload fields that must match the document (everything but the times: a usage count
/// moves `updatedAt` without changing what is recalled).
fn expected_payload(memory: &ChannelAiMemory) -> Value {
    json!({
        "memory_id": memory.id.to_hex(),
        "channel_id": memory.channel_id,
        "memory_type": memory.kind.as_str(),
        "status": memory.status.as_str(),
        "risk": memory.risk.as_str(),
        "confidence": memory.confidence.0,
        "subject_scope": memory.subject.scope.as_str(),
        "subject_username": memory.subject.username,
        "subject_user_id": memory.subject.user_id,
        "content": memory.content.expose(),
        "summary": memory.summary.expose(),
    })
}

fn payload_matches(payload: &Value, memory: &ChannelAiMemory) -> bool {
    let expected = expected_payload(memory);
    expected.as_object().is_some_and(|fields| {
        fields
            .iter()
            .all(|(key, value)| match (key.as_str(), value) {
                ("confidence", Value::Number(n)) => payload[key].as_f64() == n.as_f64(),
                _ => &payload[key] == value,
            })
    })
}

impl MemoryStore {
    /// One embedding of `text` under the embedding deadline.
    pub(crate) async fn embed(
        &self,
        text: &str,
        kind: Kind,
        channel_id: &str,
    ) -> Result<Vec<f64>, MemoryError> {
        let fail = |message: Option<String>| {
            self.observer.failed("memoryEmbedding");
            MemoryError::new(
                ErrorKind::Index,
                message.unwrap_or_else(|| "Failed to generate embedding".into()),
            )
        };
        if self.fault(Step::Embed).await.is_err() {
            return Err(fail(None));
        }
        let call = self.embeddings.generate_embedding(
            text,
            &self.config.embedding_model,
            kind,
            Some(channel_id),
        );
        match tokio::time::timeout(self.config.embedding_timeout, call).await {
            Ok(result) if !result.error => match result.embedding {
                Some(vector) => Ok(vector),
                None => Err(fail(None)),
            },
            Ok(result) => Err(fail(result.message)),
            Err(_) => Err(fail(None)),
        }
    }

    /// Writes the point of a stored confirmed memory (`upsertChannelMemoryEmbedding`): one
    /// embedding of `summary\ncontent`, then the owner-checked upsert.
    pub(crate) async fn write_point(&self, stored: &StoredMemory) -> Result<(), MemoryError> {
        let memory = stored
            .decode()
            .map_err(|_| MemoryError::new(ErrorKind::Store, "Unreadable memory"))?;
        let input = build_memory_embedding_input(memory.summary.expose(), memory.content.expose());
        if input.is_empty() {
            return Err(MemoryError::new(
                ErrorKind::Index,
                "Memory content is empty",
            ));
        }
        let vector = self
            .embed(&input, Kind::Document, &memory.channel_id)
            .await?;
        if self.fault(Step::QdrantUpsert).await.is_err() {
            self.observer.failed("upsertChannelMemoryEmbedding");
            return Err(MemoryError::new(
                ErrorKind::Index,
                "Failed to upsert channel memory embedding",
            ));
        }
        let params = UpsertChannelMemoryParams {
            qdrant_point_id: resolve_point_id(&memory),
            memory_id: memory.id.to_hex(),
            channel_id: memory.channel_id.clone(),
            memory_type: Some(memory.kind.as_str().to_owned()),
            status: Some(memory.status.as_str().to_owned()),
            risk: Some(memory.risk.as_str().to_owned()),
            confidence: Some(memory.confidence.0),
            subject_scope: Some(memory.subject.scope.as_str().to_owned()),
            subject_username: Some(memory.subject.username.clone()),
            subject_user_id: Some(memory.subject.user_id.clone()),
            content: memory.content.expose().clone(),
            summary: memory.summary.expose().clone(),
            created_at_unix: Some(created_secs(&memory) as f64),
            updated_at_unix: Some(updated_secs(&memory) as f64),
        };
        let call = self
            .qdrant
            .upsert_channel_memory_embedding(&params, &vector);
        match tokio::time::timeout(self.config.qdrant_timeout, call).await {
            Ok(result) if !result.error => Ok(()),
            Ok(result) => Err(MemoryError::new(
                ErrorKind::Index,
                result
                    .message
                    .unwrap_or_else(|| "Failed to sync memory to Qdrant".into()),
            )),
            Err(_) => {
                self.observer.failed("upsertChannelMemoryEmbedding");
                Err(MemoryError::new(
                    ErrorKind::Index,
                    "Failed to upsert channel memory embedding",
                ))
            }
        }
    }

    /// Deletes the point of memory `memory_id` of `channel_id` at `point_id`, always with the
    /// owner check. A point of another memory there is not ours: nothing to delete.
    pub(crate) async fn remove_point(
        &self,
        point_id: f64,
        channel_id: &str,
        memory_id: &ObjectId,
    ) -> Result<(), MemoryError> {
        let failed = || {
            self.observer.failed("deleteChannelMemoryEmbedding");
            MemoryError::new(
                ErrorKind::Index,
                "Failed to delete channel memory embedding",
            )
        };
        if self.fault(Step::QdrantDelete).await.is_err() {
            return Err(failed());
        }
        let id = memory_id.to_hex();
        let call = self
            .qdrant
            .delete_channel_memory_embedding(point_id, channel_id, Some(&id));
        match tokio::time::timeout(self.config.qdrant_timeout, call).await {
            Ok(result) if !result.error => Ok(()),
            Ok(result) if result.message.as_deref() == Some(COLLISION_DELETE) => Ok(()),
            Ok(result) => Err(MemoryError::new(
                ErrorKind::Index,
                result
                    .message
                    .unwrap_or_else(|| "Failed to remove memory from Qdrant".into()),
            )),
            Err(_) => Err(failed()),
        }
    }

    /// Deletes every point of a channel (`deleteChannelMemoryEmbeddingsByChannel`).
    pub(crate) async fn remove_channel_points(&self, channel_id: &str) -> Result<(), MemoryError> {
        let failed = |message: Option<String>| {
            self.observer
                .failed("deleteChannelMemoryEmbeddingsByChannel");
            MemoryError::new(
                ErrorKind::Index,
                message.unwrap_or_else(|| "Failed to delete channel memory embeddings".into()),
            )
        };
        if self.fault(Step::QdrantDelete).await == Err(()) {
            return Err(failed(None));
        }
        let call = self
            .qdrant
            .delete_channel_memory_embeddings_by_channel(channel_id);
        match tokio::time::timeout(self.config.qdrant_timeout, call).await {
            Ok(result) if !result.error => Ok(()),
            Ok(result) => Err(failed(result.message)),
            Err(_) => Err(failed(None)),
        }
    }

    /// `syncMemoryToQdrant` for one memory of a channel: assigns a missing point id, then writes
    /// the point of a confirmed memory or deletes the point of any other. The resync command of
    /// the operator CLI calls it; so does a retry.
    pub async fn sync_memory(
        &self,
        channel_id: &str,
        memory_id: &str,
    ) -> Result<StoredMemory, MemoryError> {
        let id = rules::parse_object_id(memory_id).ok_or_else(MemoryError::not_found)?;
        let stored = self.reread(id).await?;
        let memory = stored
            .decode()
            .map_err(|_| MemoryError::new(ErrorKind::Store, "Unreadable memory"))?;
        if memory.channel_id != channel_id {
            return Err(MemoryError::not_found());
        }
        // The point carries the memory as loaded (the reference's in-memory document): the
        // `updatedAt` that the point id update moves is not part of it.
        let assigned = self.assign_point_id(&memory, stored.clone()).await?;
        if memory.status == MemoryStatus::Confirmed {
            self.write_point(&stored).await?;
        } else {
            self.remove_point(resolve_point_id(&memory), &memory.channel_id, &memory.id)
                .await?;
        }
        Ok(assigned)
    }

    /// `updateOne({_id}, {$set: {qdrantPointID}})` when the stored id is missing.
    async fn assign_point_id(
        &self,
        memory: &ChannelAiMemory,
        stored: StoredMemory,
    ) -> Result<StoredMemory, MemoryError> {
        let Some((path, value)) = point_id_change(memory) else {
            return Ok(stored);
        };
        let mut ctx = self.ctx();
        let prepared = INFO
            .prepare_update(
                &doc! { "_id": memory.id },
                doc! { "$set": { path: value } },
                dima_store::mongo::update::UpdateOptions::default(),
                &mut ctx,
            )
            .map_err(|_| MemoryError::new(ErrorKind::Store, "Invalid point id update"))?;
        let mut writes = self.mongo.writes(INFO.name);
        self.mongo_call("assignPointId", writes.update_one(&prepared))
            .await?;
        self.reread(memory.id).await
    }

    async fn qdrant_raw(
        &self,
        path: &'static str,
        body: Value,
        wait: bool,
    ) -> Result<Value, MemoryError> {
        let failed = || MemoryError::new(ErrorKind::Index, "Qdrant request failed");
        let provider = self.qdrant_provider.as_ref().ok_or_else(failed)?;
        let path = Path::template(path, &[&self.qdrant.memory_collection]).map_err(|_| failed())?;
        let mut request = self
            .qdrant_http
            .request(provider, Method::POST, path)
            .json_js(&body);
        if wait {
            request = request.query(&[("wait", "true")]);
        }
        let call = request.send_json::<Value>();
        match tokio::time::timeout(self.config.qdrant_timeout, call).await {
            Ok(Ok(v)) => Ok(v["result"].clone()),
            _ => {
                self.observer.failed("memoryRepair");
                Err(failed())
            }
        }
    }

    /// Payloads of `ids` (seam: see the module docs).
    async fn point_payloads(&self, ids: &[f64]) -> Result<HashMap<u64, Value>, MemoryError> {
        let result = self
            .qdrant_raw(
                "/collections/{}/points",
                json!({"ids": ids, "with_payload": true, "with_vector": false}),
                false,
            )
            .await?;
        Ok(result
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p["id"].as_u64()?, p["payload"].clone())))
            .collect())
    }

    /// Restores the invariant for the memories of `scope`: every confirmed memory has its point
    /// with its current content, no other memory has one, and (for [`RepairScope::All`] or the
    /// channel's points) no point exists without a confirmed memory owning it. Bounded batches;
    /// a failure is counted and left for the next run.
    pub async fn repair(&self, scope: RepairScope<'_>) -> Result<RepairReport, MemoryError> {
        let mut report = RepairReport::default();
        let batch = i64::try_from(self.config.repair_batch.max(1)).unwrap_or(200);
        let mut after: Option<ObjectId> = None;
        loop {
            let mut filter = doc! {};
            if let RepairScope::Channel(channel) = scope {
                filter.insert("channelID", channel);
            }
            if let Some(last) = after {
                filter.insert("_id", doc! { "$gt": last });
            }
            let cursor = self
                .mongo_call(
                    "memoryRepair",
                    self.mongo
                        .documents(INFO.name)
                        .find(filter)
                        .sort(doc! { "_id": 1 })
                        .limit(batch),
                )
                .await?;
            let documents: Vec<_> = self
                .mongo_call("memoryRepair", cursor.try_collect::<Vec<_>>())
                .await?;
            let Some(last) = documents.last() else { break };
            after = last.get_object_id("_id").ok();
            let memories: Vec<(StoredMemory, ChannelAiMemory)> = documents
                .into_iter()
                .filter_map(|document| {
                    let stored = StoredMemory { document };
                    let memory = stored.decode().ok()?;
                    Some((stored, memory))
                })
                .collect();
            let ids: Vec<f64> = memories.iter().map(|(_, m)| resolve_point_id(m)).collect();
            let payloads = self.point_payloads(&ids).await?;
            for (stored, memory) in memories {
                report.documents += 1;
                let point = resolve_point_id(&memory);
                let payload = payloads.get(&(point as u64));
                let ours = payload.is_some_and(|p| {
                    qdrant_point_belongs_to_memory(Some(p), &memory.id.to_hex(), &memory.channel_id)
                });
                if memory.status == MemoryStatus::Confirmed {
                    if payload.is_some() && !ours {
                        report.collisions += 1;
                        continue;
                    }
                    if payload.is_some_and(|p| payload_matches(p, &memory))
                        && point_id_change(&memory).is_none()
                    {
                        continue;
                    }
                    let written = match self.assign_point_id(&memory, stored.clone()).await {
                        Ok(_) => self.write_point(&stored).await,
                        Err(e) => Err(e),
                    };
                    match written {
                        Ok(()) => report.points_written += 1,
                        Err(_) => report.failures += 1,
                    }
                } else if ours {
                    match self
                        .remove_point(point, &memory.channel_id, &memory.id)
                        .await
                    {
                        Ok(()) => report.points_removed += 1,
                        Err(_) => report.failures += 1,
                    }
                }
            }
        }
        self.remove_ghosts(scope, &mut report).await?;
        Ok(report)
    }

    /// Scrolls the points of `scope` and deletes those no confirmed memory owns.
    async fn remove_ghosts(
        &self,
        scope: RepairScope<'_>,
        report: &mut RepairReport,
    ) -> Result<(), MemoryError> {
        let mut offset = Value::Null;
        // Bounded: at most this many pages per run (each `repair_batch` points).
        for _ in 0..100_000 {
            let mut body = json!({"with_payload": true, "with_vector": false,
                "limit": self.config.repair_batch.max(1)});
            if let RepairScope::Channel(channel) = scope {
                body["filter"] = json!({"must":[{"key":"channel_id","match":{"value":channel}}]});
            }
            if !offset.is_null() {
                body["offset"] = offset.clone();
            }
            let page = self
                .qdrant_raw("/collections/{}/points/scroll", body, false)
                .await?;
            let points: Vec<(f64, Value)> = page["points"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| Some((p["id"].as_f64()?, p["payload"].clone())))
                .collect();
            let ids: Vec<ObjectId> = points
                .iter()
                .filter_map(|(_, p)| rules::parse_object_id(p["memory_id"].as_str()?))
                .collect();
            let cursor = self
                .mongo_call(
                    "memoryRepair",
                    self.mongo
                        .documents(INFO.name)
                        .find(doc! { "_id": { "$in": ids } }),
                )
                .await?;
            let owners: Vec<_> = self
                .mongo_call("memoryRepair", cursor.try_collect::<Vec<_>>())
                .await?;
            let valid: HashSet<(String, u64)> = owners
                .iter()
                .filter_map(|d| dima_model::decode_document::<ChannelAiMemory>(d).ok())
                .filter(|m| m.status == MemoryStatus::Confirmed)
                .map(|m| (m.id.to_hex(), resolve_point_id(&m) as u64))
                .collect();
            let ghosts: Vec<f64> = points
                .iter()
                .filter(|(id, payload)| {
                    let memory = payload["memory_id"].as_str().unwrap_or_default().to_owned();
                    !valid.contains(&(memory, *id as u64))
                })
                .map(|(id, _)| *id)
                .collect();
            if !ghosts.is_empty() {
                if self.fault(Step::QdrantDelete).await == Err(()) {
                    report.failures += ghosts.len() as u64;
                } else {
                    match self
                        .qdrant_raw(
                            "/collections/{}/points/delete",
                            json!({ "points": ghosts }),
                            true,
                        )
                        .await
                    {
                        Ok(_) => report.ghosts_removed += ghosts.len() as u64,
                        Err(_) => report.failures += ghosts.len() as u64,
                    }
                }
            }
            offset = page["next_page_offset"].clone();
            if offset.is_null() {
                break;
            }
        }
        Ok(())
    }
}
