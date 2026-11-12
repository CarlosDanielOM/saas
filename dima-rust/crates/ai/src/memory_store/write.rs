//! Create (with dedupe), status changes, edits and deletes. The order of the two writes of each
//! operation is in the table of the module docs.

use super::index::{point_id_change, resolve_point_id};
use super::rules::{
    LearningSettings, clamp_confidence, fingerprint, normalize_summary, normalize_text,
    parse_object_id, policy_kind, policy_risk, policy_scope, stored_policy_violation,
};
use super::{ErrorKind, MemoryError, MemoryStore, Private, Step, StoredMemory};
use crate::memory::get_memory_policy_violation;
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_model::channel_ai_memories::{
    ChannelAiMemory, INFO, MemoryRisk, MemorySource, MemoryStatus, MemoryType, NewChannelAiMemory,
    NewMemoryActor, NewMemoryEvidence, NewMemorySubject, SubjectScope,
};
use dima_model::enums::{Open, StrEnum};
use dima_model::loaded::LoadedForSave;
use dima_store::mongo::date::JsDate;
use dima_store::mongo::number::{JsNumber, js_number};
use dima_store::mongo::save::Change;
use dima_store::mongo::write::SaveOutcome;

const CREATE_FAILED: &str = "Failed to create or update memory";
const STATUS_FAILED: &str = "Failed to update memory status";
const UPDATE_FAILED: &str = "Failed to update memory";
const DELETE_FAILED: &str = "Failed to permanently delete memory";

/// Who a memory is about (`subject`).
#[derive(Clone, Debug, Default)]
pub struct SubjectInput {
    /// `user` makes it a viewer memory; anything else is the channel.
    pub scope: Option<SubjectScope>,
    /// The viewer's login.
    pub username: Option<String>,
    /// The viewer's Twitch id (required for a viewer memory).
    pub user_id: Option<String>,
}

/// Who created or reviewed a memory.
#[derive(Clone, Debug, Default)]
pub struct ActorInput {
    /// Where it came from (default `system`).
    pub source: Option<MemorySource>,
    /// Login.
    pub username: Option<String>,
    /// Twitch id.
    pub user_id: Option<String>,
}

/// One message a memory was learned from.
#[derive(Clone, Debug, Default)]
pub struct EvidenceInput {
    /// Where it came from (default `chat`).
    pub source: Option<MemorySource>,
    /// The author's login.
    pub username: Option<String>,
    /// The author's Twitch id.
    pub user_id: Option<String>,
    /// The message.
    pub message: Option<Private<String>>,
    /// The message id.
    pub message_id: Option<String>,
    /// Epoch seconds (missing, 0 or not a number: now).
    pub timestamp: Option<f64>,
}

/// `createOrUpdateChannelMemory` input.
#[derive(Clone, Debug)]
pub struct CreateMemory {
    /// The channel the memory belongs to (the caller's authorised channel).
    pub channel_id: String,
    /// The channel's login (looked up when empty).
    pub channel_name: Option<String>,
    /// The kind of memory.
    pub kind: MemoryType,
    /// Risk (default low).
    pub risk: Option<MemoryRisk>,
    /// Confidence (missing or not finite: 0.5).
    pub confidence: Option<f64>,
    /// Who it is about.
    pub subject: Option<SubjectInput>,
    /// The memory.
    pub content: Private<String>,
    /// Its summary (default: the content, cut).
    pub summary: Option<Private<String>>,
    /// What it was learned from (the last 25 are kept).
    pub evidence: Vec<EvidenceInput>,
    /// Who created it.
    pub created_by: Option<ActorInput>,
    /// A status that overrides the auto-confirm rule.
    pub force_status: Option<MemoryStatus>,
    /// Create even when the channel's learning is disabled.
    pub bypass_learning_config: bool,
    /// Create even when the channel's memory policy refuses the kind.
    pub bypass_memory_policy: bool,
    /// An existing confirmed duplicate is returned untouched.
    pub preserve_confirmed: bool,
}

impl CreateMemory {
    /// A memory of `kind` with every option at its default.
    pub fn new(
        channel_id: impl Into<String>,
        kind: MemoryType,
        content: impl Into<String>,
    ) -> Self {
        Self {
            channel_id: channel_id.into(),
            channel_name: None,
            kind,
            risk: None,
            confidence: None,
            subject: None,
            content: Private::new(content.into()),
            summary: None,
            evidence: Vec::new(),
            created_by: None,
            force_status: None,
            bypass_learning_config: false,
            bypass_memory_policy: false,
            preserve_confirmed: false,
        }
    }
}

/// What a create did.
#[derive(Clone, Debug)]
pub enum CreateOutcome {
    /// A new memory.
    Created(StoredMemory),
    /// A memory with the same fingerprint was updated (dedupe).
    Updated(StoredMemory),
    /// A confirmed duplicate kept untouched (`preserve_confirmed`).
    Kept(StoredMemory),
    /// Learning is disabled for the channel: nothing written (`error: false` in the reference).
    LearningDisabled,
}

impl CreateOutcome {
    /// The memory, when there is one.
    pub fn memory(&self) -> Option<&StoredMemory> {
        match self {
            Self::Created(m) | Self::Updated(m) | Self::Kept(m) => Some(m),
            Self::LearningDisabled => None,
        }
    }
}

/// `setChannelMemoryStatus` input.
#[derive(Clone, Debug)]
pub struct SetStatus {
    /// The caller's authorised channel.
    pub channel_id: String,
    /// The memory (`_id` text).
    pub memory_id: String,
    /// The new status.
    pub status: MemoryStatus,
    /// Why.
    pub review_reason: Option<String>,
    /// Who (missing: `reviewedBy` is removed).
    pub reviewer: Option<ActorInput>,
}

/// `updateChannelMemory` input: each `Some` field replaces the stored one.
#[derive(Clone, Debug, Default)]
pub struct UpdateMemory {
    /// The caller's authorised channel.
    pub channel_id: String,
    /// The memory (`_id` text).
    pub memory_id: String,
    /// New kind.
    pub kind: Option<MemoryType>,
    /// New risk.
    pub risk: Option<MemoryRisk>,
    /// New confidence (clamped; not finite: 0.5).
    pub confidence: Option<f64>,
    /// New content (trimmed; empty is refused by the schema).
    pub content: Option<Private<String>>,
    /// New summary (empty: from the content).
    pub summary: Option<Private<String>>,
    /// New subject.
    pub subject: Option<SubjectInput>,
}

fn too_large(field: &'static str) -> MemoryError {
    MemoryError::new(
        ErrorKind::TooLarge,
        format!("Memory {field} exceeds the allowed size"),
    )
}

fn chars(text: Option<&str>) -> usize {
    text.map_or(0, |t| t.chars().count())
}

fn subject_doc(scope: SubjectScope, username: &str, user_id: &str) -> Document {
    doc! { "scope": scope.as_str(), "username": username, "userID": user_id }
}

fn actor_doc(actor: &ActorInput) -> Document {
    doc! {
        "source": actor.source.unwrap_or(MemorySource::System).as_str(),
        "username": normalize_text(actor.username.as_deref()),
        "userID": normalize_text(actor.user_id.as_deref()),
    }
}

/// `Number(item.timestamp || Math.floor(Date.now() / 1000))`.
fn evidence_time(timestamp: Option<f64>, now_secs: i64) -> f64 {
    match timestamp {
        Some(t) if t != 0.0 && !t.is_nan() => t,
        _ => now_secs as f64,
    }
}

impl MemoryStore {
    fn check_actor(&self, actor: Option<&ActorInput>) -> Result<(), MemoryError> {
        let max = self.config.max_name_chars;
        if let Some(a) = actor
            && (chars(a.username.as_deref()) > max || chars(a.user_id.as_deref()) > max)
        {
            return Err(too_large("actor"));
        }
        Ok(())
    }

    fn check_subject(&self, subject: Option<&SubjectInput>) -> Result<(), MemoryError> {
        let max = self.config.max_name_chars;
        if let Some(s) = subject
            && (chars(s.username.as_deref()) > max || chars(s.user_id.as_deref()) > max)
        {
            return Err(too_large("subject"));
        }
        Ok(())
    }

    /// The size bounds of [`super::Config`], before anything is read, written or embedded.
    fn check_create_bounds(&self, input: &CreateMemory) -> Result<(), MemoryError> {
        let c = &self.config;
        let from_chat = input
            .created_by
            .as_ref()
            .is_some_and(|a| a.source == Some(MemorySource::Chat));
        let max_content = if from_chat {
            c.max_chat_content_chars
        } else {
            c.max_content_chars
        };
        if chars(Some(input.content.expose())) > max_content {
            return Err(too_large("content"));
        }
        if chars(input.summary.as_ref().map(|s| s.expose().as_str())) > c.max_summary_chars {
            return Err(too_large("summary"));
        }
        if chars(Some(&input.channel_id)) > c.max_name_chars
            || chars(input.channel_name.as_deref()) > c.max_name_chars
        {
            return Err(too_large("channel"));
        }
        self.check_subject(input.subject.as_ref())?;
        self.check_actor(input.created_by.as_ref())?;
        // Only the last 25 are kept: the bound applies to those.
        let kept = input.evidence.len().saturating_sub(25);
        for e in input.evidence.iter().skip(kept) {
            if chars(e.message.as_ref().map(|m| m.expose().as_str())) > c.max_evidence_message_chars
                || chars(e.username.as_deref()) > c.max_name_chars
                || chars(e.user_id.as_deref()) > c.max_name_chars
                || chars(e.message_id.as_deref()) > c.max_name_chars
            {
                return Err(too_large("evidence"));
            }
        }
        Ok(())
    }

    /// Loads a memory of a channel whole, for a save.
    async fn load(
        &self,
        filter: Document,
        operation: &'static str,
    ) -> Result<Option<(LoadedForSave, ChannelAiMemory)>, MemoryError> {
        let mut ctx = self.ctx();
        let loaded = self
            .mongo_call(
                operation,
                INFO.load_for_save(&self.mongo, &filter, &mut ctx),
            )
            .await?;
        let Some(loaded) = loaded else {
            return Ok(None);
        };
        let memory = loaded.decode::<ChannelAiMemory>().map_err(|_| {
            self.observer.failed(operation);
            MemoryError::new(ErrorKind::Store, "Unreadable memory")
        })?;
        Ok(Some((loaded, memory)))
    }

    /// Validates the save first (nothing is written when Mongoose would refuse it), then runs
    /// `before` (the Qdrant delete of an operation that shrinks recall), then the save.
    async fn save(
        &self,
        loaded: &LoadedForSave,
        changes: &[Change],
        now_ms: i64,
        operation: &'static str,
    ) -> Result<(), MemoryError> {
        let mut ctx = dima_store::mongo::WriteContext::new(now_ms);
        let prepared = INFO
            .prepare_save(loaded, changes, &mut ctx)
            .map_err(|_| MemoryError::new(ErrorKind::Invalid, "Memory validation failed"))?;
        if self.fault(Step::MongoSave).await.is_err() {
            self.observer.failed(operation);
            return Err(MemoryError::new(ErrorKind::Store, "MongoDB call failed"));
        }
        let mut writes = self.mongo.writes(INFO.name);
        match self.mongo_call(operation, writes.save(&prepared)).await? {
            SaveOutcome::Saved | SaveOutcome::Unchanged => Ok(()),
            SaveOutcome::Conflict => Err(MemoryError::new(ErrorKind::Store, "Memory changed")),
        }
    }

    fn validate_save(&self, loaded: &LoadedForSave, changes: &[Change], now_ms: i64) -> bool {
        let mut ctx = dima_store::mongo::WriteContext::new(now_ms);
        INFO.prepare_save(loaded, changes, &mut ctx).is_ok()
    }

    async fn count(&self, channel_id: &str, status: MemoryStatus) -> Result<u64, MemoryError> {
        self.mongo_call(
            "memoryCount",
            self.mongo
                .documents(INFO.name)
                .count_documents(doc! { "channelID": channel_id, "status": status.as_str() }),
        )
        .await
    }

    /// `createOrUpdateChannelMemory`.
    pub async fn create_or_update(
        &self,
        input: CreateMemory,
    ) -> Result<CreateOutcome, MemoryError> {
        self.check_create_bounds(&input)?;
        let channel_id = normalize_text(Some(&input.channel_id));
        let content = normalize_text(Some(input.content.expose()));
        let confidence = clamp_confidence(input.confidence);
        let summary = normalize_summary(
            &content,
            input.summary.as_ref().map(|s| s.expose().as_str()),
        );
        if channel_id.is_empty() || content.is_empty() {
            return Err(MemoryError::new(
                ErrorKind::Invalid,
                "channelID and content are required",
            ));
        }
        let subject = input.subject.clone().unwrap_or_default();
        let scope = if subject.scope == Some(SubjectScope::User) {
            SubjectScope::User
        } else {
            SubjectScope::Channel
        };
        let username = normalize_text(subject.username.as_deref());
        let user_id = normalize_text(subject.user_id.as_deref());
        if (scope == SubjectScope::User || input.kind == MemoryType::KnownUserFact)
            && user_id.is_empty()
        {
            return Err(MemoryError::new(
                ErrorKind::Invalid,
                "User-scoped memories require a stable Twitch user ID",
            ));
        }
        if input.kind == MemoryType::KnownUserFact && scope != SubjectScope::User {
            return Err(MemoryError::new(
                ErrorKind::Invalid,
                "Known user facts require a user subject",
            ));
        }
        let fp = fingerprint(
            &channel_id,
            input.kind.as_str(),
            scope.as_str(),
            &username,
            &summary,
        );
        let (settings, policy) = self
            .settings(&channel_id)
            .await
            .map_err(|e| e.generic(CREATE_FAILED))?;
        if !settings.enabled && !input.bypass_learning_config {
            return Ok(CreateOutcome::LearningDisabled);
        }
        let risk = input.risk.unwrap_or(MemoryRisk::Low);
        if let Some(violation) = get_memory_policy_violation(
            policy_kind(input.kind),
            policy_risk(risk),
            policy_scope(scope),
            &policy,
        ) && !input.bypass_memory_policy
        {
            return Err(MemoryError::new(ErrorKind::Policy, violation));
        }
        let target = input.force_status.unwrap_or_else(|| {
            if settings.should_auto_confirm(risk, confidence) {
                MemoryStatus::Confirmed
            } else {
                MemoryStatus::PendingReview
            }
        });
        let prepared = Prepared {
            channel_id,
            content,
            summary,
            confidence,
            scope,
            username,
            user_id,
            fingerprint: fp,
            target,
            settings,
        };
        // A duplicate fingerprint on insert means an identical create won a race: once more,
        // through the dedupe update. An insert that found the limit passed by a concurrent
        // create removed itself: it tries again after a jittered pause (at most
        // `LIMIT_RETRIES` times), so a race near the limit does not refuse every racer.
        let mut duplicates = 0;
        let mut raced = 0;
        loop {
            let existing = self
                .load(
                    doc! { "channelID": &prepared.channel_id, "fingerprint": &prepared.fingerprint },
                    "createOrUpdateChannelMemory",
                )
                .await
                .map_err(|e| e.generic(CREATE_FAILED))?;
            if let Some((loaded, memory)) = existing {
                return self
                    .update_duplicate(&input, &prepared, loaded, memory)
                    .await
                    .map_err(|e| e.generic(CREATE_FAILED));
            }
            match self.insert_new(&input, &prepared).await {
                Err(Inserted::Duplicate) if duplicates == 0 => duplicates += 1,
                Err(Inserted::Duplicate) => {
                    return Err(MemoryError::new(ErrorKind::Store, CREATE_FAILED));
                }
                Err(Inserted::Raced { message, jitter_ms }) => {
                    raced += 1;
                    if raced > LIMIT_RETRIES {
                        return Err(MemoryError::new(ErrorKind::Limit, message));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(jitter_ms * raced)).await;
                }
                Err(Inserted::Failed(e)) => return Err(e.generic(CREATE_FAILED)),
                Ok(stored) => return Ok(CreateOutcome::Created(stored)),
            }
        }
    }

    async fn update_duplicate(
        &self,
        input: &CreateMemory,
        p: &Prepared,
        loaded: LoadedForSave,
        existing: ChannelAiMemory,
    ) -> Result<CreateOutcome, MemoryError> {
        let id = existing.id;
        if input.preserve_confirmed && existing.status == MemoryStatus::Confirmed {
            return Ok(CreateOutcome::Kept(StoredMemory {
                document: loaded.document().clone(),
            }));
        }
        let existing_confidence = if existing.confidence.0.is_nan() {
            0.0
        } else {
            existing.confidence.0
        };
        let confidence = existing_confidence.max(p.confidence);
        let next_status: Open<MemoryStatus> = if input.force_status.is_some() {
            p.target.into()
        } else if existing.status != MemoryStatus::Confirmed {
            // `input.risk || existing.risk`: a stored risk the schema no longer lists is not low.
            let risk = input.risk.or_else(|| existing.risk.known());
            if risk.is_some_and(|r| p.settings.should_auto_confirm(r, confidence)) {
                MemoryStatus::Confirmed.into()
            } else {
                p.target.into()
            }
        } else {
            existing.status.clone()
        };
        let confirmed = next_status == MemoryStatus::Confirmed;
        let now_ms = self.clock.now_ms();
        let mut changes = Vec::new();
        if let Some((path, value)) = point_id_change(&existing) {
            changes.push(Change::Set(path, value));
        }
        changes.push(Change::set("content", p.content.as_str()));
        changes.push(Change::set("summary", p.summary.as_str()));
        changes.push(Change::set(
            "risk",
            input.risk.map_or_else(
                || existing.risk.as_str().to_owned(),
                |r| r.as_str().to_owned(),
            ),
        ));
        changes.push(Change::set("confidence", js_number(confidence)));
        changes.push(Change::set("type", input.kind.as_str()));
        changes.push(Change::set(
            "subject",
            subject_doc(p.scope, &p.username, &p.user_id),
        ));
        changes.push(Change::set("status", next_status.as_str()));
        changes.push(Change::set(
            "reviewReason",
            if confirmed {
                "auto_confirm_threshold_met"
            } else if input.force_status.is_some() {
                "manual_status_set"
            } else {
                "awaiting_review"
            },
        ));
        if !input.evidence.is_empty() {
            let now_secs = now_ms.div_euclid(1000);
            let mut all: Vec<Bson> = existing
                .source_evidence
                .expose()
                .iter()
                .map(|e| {
                    Bson::Document(doc! {
                        "source": if e.source.as_str().is_empty() { "chat" } else { e.source.as_str() },
                        "username": dima_text::trim(&e.username),
                        "userID": dima_text::trim(&e.user_id),
                        "message": dima_text::trim(&e.message),
                        "messageId": dima_text::trim(&e.message_id),
                        "timestamp": js_number(evidence_time(e.timestamp.map(|t| t.0), now_secs)),
                    })
                })
                .collect();
            all.extend(
                input
                    .evidence
                    .iter()
                    .map(|e| Bson::Document(evidence_doc(e, now_secs))),
            );
            let keep = all.len().saturating_sub(25);
            changes.push(Change::set(
                "sourceEvidence",
                Bson::Array(all.into_iter().skip(keep).collect()),
            ));
        }
        changes.push(Change::set("updatedAt", JsDate(now_ms).to_bson()));
        if !self.validate_save(&loaded, &changes, now_ms) {
            return Err(MemoryError::new(ErrorKind::Invalid, CREATE_FAILED));
        }
        // Shrink first: whatever the new status, the old point goes before the save.
        if existing.status == MemoryStatus::Confirmed || !confirmed {
            self.remove_point(resolve_point_id(&existing), &existing.channel_id, &id)
                .await?;
        }
        self.save(&loaded, &changes, now_ms, "createOrUpdateChannelMemory")
            .await?;
        let stored = self.reread(id).await?;
        if confirmed {
            self.write_point(&stored).await?;
        }
        Ok(CreateOutcome::Updated(stored))
    }

    async fn insert_new(
        &self,
        input: &CreateMemory,
        p: &Prepared,
    ) -> Result<StoredMemory, Inserted> {
        let limit = match p.target {
            MemoryStatus::PendingReview => Some((
                p.settings.max_pending_memories,
                "Pending memory limit reached for this channel",
            )),
            MemoryStatus::Confirmed => Some((
                p.settings.max_confirmed_memories,
                "Confirmed memory limit reached for this channel",
            )),
            _ => None,
        }
        // `if (limit <= 0) return true`: a limit that is not a number refuses every create.
        .filter(|(max, _)| max.is_nan() || *max > 0.0);
        if let Some((max, message)) = limit {
            let count = self.count(&p.channel_id, p.target).await?;
            if (count as f64).partial_cmp(&max) != Some(std::cmp::Ordering::Less) {
                return Err(MemoryError::new(ErrorKind::Limit, message).into());
            }
        }
        let mut channel_name = normalize_text(input.channel_name.as_deref());
        if channel_name.is_empty() {
            channel_name = self
                .names
                .channel_name(&p.channel_id)
                .await
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "Unknown".into());
        }
        let now_ms = self.clock.now_ms();
        let now_secs = now_ms.div_euclid(1000);
        let id = self.ids.object_id(now_ms);
        let point_id =
            crate::qdrant::generate_qdrant_point_id(&p.channel_id, &id.to_hex(), now_secs as f64);
        let kept = input.evidence.len().saturating_sub(25);
        let creator = input.created_by.clone().unwrap_or_default();
        let new = NewChannelAiMemory {
            id,
            qdrant_point_id: JsNumber(f64::from(point_id)),
            channel_id: p.channel_id.clone(),
            channel: channel_name,
            kind: input.kind,
            status: p.target,
            risk: input.risk.unwrap_or(MemoryRisk::Low),
            confidence: JsNumber(p.confidence),
            subject: NewMemorySubject {
                scope: p.scope,
                username: p.username.clone(),
                user_id: p.user_id.clone(),
            },
            content: Private::new(p.content.clone()),
            summary: Private::new(p.summary.clone()),
            fingerprint: p.fingerprint.clone(),
            source_evidence: Private::new(
                input
                    .evidence
                    .iter()
                    .skip(kept)
                    .map(|e| NewMemoryEvidence {
                        source: e.source.unwrap_or(MemorySource::Chat),
                        username: normalize_text(e.username.as_deref()),
                        user_id: normalize_text(e.user_id.as_deref()),
                        message: normalize_text(e.message.as_ref().map(|m| m.expose().as_str())),
                        message_id: normalize_text(e.message_id.as_deref()),
                        timestamp: JsNumber(evidence_time(e.timestamp, now_secs)),
                    })
                    .collect(),
            ),
            created_by: NewMemoryActor {
                source: creator.source.unwrap_or(MemorySource::System),
                username: normalize_text(creator.username.as_deref()),
                user_id: normalize_text(creator.user_id.as_deref()),
            },
            review_reason: if input.force_status.is_some() {
                "manual_status_set"
            } else if p.target == MemoryStatus::Confirmed {
                "auto_confirm_threshold_met"
            } else {
                "awaiting_review"
            }
            .into(),
            created_at: JsDate(now_ms),
            updated_at: JsDate(now_ms),
        };
        let mut ctx = dima_store::mongo::WriteContext::new(now_ms);
        let prepared = new
            .prepare(&mut ctx)
            .map_err(|_| MemoryError::new(ErrorKind::Invalid, CREATE_FAILED))?;
        if self.fault(Step::MongoInsert).await.is_err() {
            self.observer.failed("createOrUpdateChannelMemory");
            return Err(MemoryError::new(ErrorKind::Store, CREATE_FAILED).into());
        }
        let mut writes = self.mongo.writes(INFO.name);
        let inserted =
            tokio::time::timeout(self.config.store_timeout, writes.insert_one(&prepared)).await;
        match inserted {
            Ok(Ok(())) => {}
            Ok(Err(dima_store::mongo::write::WriteError::Driver(e)))
                if dima_store::mongo::error::duplicate_key(&e)
                    .and_then(|d| d.index)
                    .is_some_and(|i| i.contains("fingerprint")) =>
            {
                return Err(Inserted::Duplicate);
            }
            _ => {
                self.observer.failed("createOrUpdateChannelMemory");
                return Err(MemoryError::new(ErrorKind::Store, CREATE_FAILED).into());
            }
        }
        if let Some((max, message)) = limit {
            let over = match self.fault(Step::LimitRecount).await {
                Ok(()) => self
                    .count(&p.channel_id, p.target)
                    .await
                    .map(|n| n as f64 > max),
                Err(()) => Err(MemoryError::new(ErrorKind::Store, CREATE_FAILED)),
            };
            match over {
                Ok(false) => {}
                Ok(true) => {
                    self.remove_document(&id, &p.channel_id).await?;
                    // The pause comes from the id's random bytes (the injected id source).
                    let bytes = id.bytes();
                    let jitter_ms =
                        20 + u64::from(u16::from_be_bytes([bytes[10], bytes[11]]) % 230);
                    return Err(Inserted::Raced { message, jitter_ms });
                }
                Err(e) => {
                    // Unknown count: undo rather than risk passing the limit.
                    let _ = self.remove_document(&id, &p.channel_id).await;
                    return Err(e.into());
                }
            }
        }
        let stored = self.reread(id).await?;
        if p.target == MemoryStatus::Confirmed
            && let Err(e) = self.write_point(&stored).await
        {
            // The reference's rollback: no memory without its point when the create fails.
            let _ = self.remove_document(&id, &p.channel_id).await;
            return Err(e.into());
        }
        Ok(stored)
    }

    async fn remove_document(&self, id: &ObjectId, channel_id: &str) -> Result<u64, MemoryError> {
        if self.fault(Step::MongoDelete).await.is_err() {
            return Err(MemoryError::new(ErrorKind::Store, "MongoDB call failed"));
        }
        let result = self
            .mongo_call(
                "deleteChannelMemory",
                self.mongo
                    .documents(INFO.name)
                    .delete_one(doc! { "_id": id, "channelID": channel_id }),
            )
            .await?;
        Ok(result.deleted_count)
    }

    /// `setChannelMemoryStatus`.
    pub async fn set_status(&self, params: SetStatus) -> Result<StoredMemory, MemoryError> {
        let max = self.config.max_name_chars;
        if chars(params.review_reason.as_deref()) > max {
            return Err(too_large("review reason"));
        }
        self.check_actor(params.reviewer.as_ref())?;
        let id = parse_object_id(&params.memory_id)
            .ok_or_else(|| MemoryError::new(ErrorKind::Store, STATUS_FAILED))?;
        let (loaded, memory) = self
            .load(
                doc! { "_id": id, "channelID": &params.channel_id },
                "setChannelMemoryStatus",
            )
            .await
            .map_err(|e| e.generic(STATUS_FAILED))?
            .ok_or_else(MemoryError::not_found)?;
        let confirm = params.status == MemoryStatus::Confirmed;
        if confirm {
            if memory.kind == MemoryType::KnownUserFact
                && (memory.subject.scope != SubjectScope::User
                    || dima_text::trim(&memory.subject.user_id).is_empty())
            {
                return Err(MemoryError::new(
                    ErrorKind::Invalid,
                    "Known user facts require a verified Twitch user ID before confirmation",
                ));
            }
            let (_, policy) = self
                .settings(&params.channel_id)
                .await
                .map_err(|e| e.generic(STATUS_FAILED))?;
            if let Some(v) =
                stored_policy_violation(&memory.kind, &memory.risk, &memory.subject.scope, &policy)
            {
                return Err(MemoryError::new(ErrorKind::Policy, v));
            }
        }
        let now_ms = self.clock.now_ms();
        let mut changes = Vec::new();
        if let Some((path, value)) = point_id_change(&memory) {
            changes.push(Change::Set(path, value));
        }
        changes.push(Change::set("status", params.status.as_str()));
        changes.push(Change::set(
            "reviewReason",
            normalize_text(params.review_reason.as_deref()),
        ));
        changes.push(Change::set("reviewedAt", JsDate(now_ms).to_bson()));
        changes.push(match &params.reviewer {
            Some(r) => Change::set("reviewedBy", actor_doc(r)),
            None => Change::unset("reviewedBy"),
        });
        changes.push(Change::set("updatedAt", JsDate(now_ms).to_bson()));
        if !self.validate_save(&loaded, &changes, now_ms) {
            return Err(MemoryError::new(ErrorKind::Invalid, STATUS_FAILED));
        }
        if !confirm {
            // The reference returns the delete's own message here.
            self.remove_point(resolve_point_id(&memory), &memory.channel_id, &id)
                .await?;
        }
        self.save(&loaded, &changes, now_ms, "setChannelMemoryStatus")
            .await
            .map_err(|e| e.generic(STATUS_FAILED))?;
        let stored = self
            .reread(id)
            .await
            .map_err(|e| e.generic(STATUS_FAILED))?;
        if confirm {
            self.write_point(&stored)
                .await
                .map_err(|e| e.generic(STATUS_FAILED))?;
        }
        Ok(stored)
    }

    /// `updateChannelMemory`.
    pub async fn update(&self, params: UpdateMemory) -> Result<StoredMemory, MemoryError> {
        let c = &self.config;
        if chars(params.content.as_ref().map(|s| s.expose().as_str())) > c.max_content_chars {
            return Err(too_large("content"));
        }
        if chars(params.summary.as_ref().map(|s| s.expose().as_str())) > c.max_summary_chars {
            return Err(too_large("summary"));
        }
        self.check_subject(params.subject.as_ref())?;
        let id = parse_object_id(&params.memory_id)
            .ok_or_else(|| MemoryError::new(ErrorKind::Store, UPDATE_FAILED))?;
        let (loaded, memory) = self
            .load(
                doc! { "_id": id, "channelID": &params.channel_id },
                "updateChannelMemory",
            )
            .await
            .map_err(|e| e.generic(UPDATE_FAILED))?
            .ok_or_else(MemoryError::not_found)?;
        let next_kind: Open<MemoryType> =
            params.kind.map_or_else(|| memory.kind.clone(), Open::from);
        let next_risk: Open<MemoryRisk> =
            params.risk.map_or_else(|| memory.risk.clone(), Open::from);
        let (scope, username, user_id): (Open<SubjectScope>, String, String) = match &params.subject
        {
            Some(s) => (
                if s.scope == Some(SubjectScope::User) {
                    SubjectScope::User
                } else {
                    SubjectScope::Channel
                }
                .into(),
                normalize_text(s.username.as_deref()),
                normalize_text(s.user_id.as_deref()),
            ),
            None => (
                memory.subject.scope.clone(),
                memory.subject.username.clone(),
                memory.subject.user_id.clone(),
            ),
        };
        if (scope == SubjectScope::User || next_kind == MemoryType::KnownUserFact)
            && user_id.is_empty()
        {
            return Err(MemoryError::new(
                ErrorKind::Invalid,
                "User-scoped memories require a stable Twitch user ID",
            ));
        }
        if next_kind == MemoryType::KnownUserFact && scope != SubjectScope::User {
            return Err(MemoryError::new(
                ErrorKind::Invalid,
                "Known user facts require a user subject",
            ));
        }
        let (_, policy) = self
            .settings(&params.channel_id)
            .await
            .map_err(|e| e.generic(UPDATE_FAILED))?;
        if let Some(v) = stored_policy_violation(&next_kind, &next_risk, &scope, &policy) {
            return Err(MemoryError::new(ErrorKind::Policy, v));
        }
        let now_ms = self.clock.now_ms();
        let confirmed = memory.status == MemoryStatus::Confirmed;
        let mut changes = Vec::new();
        if let Some((path, value)) = point_id_change(&memory) {
            changes.push(Change::Set(path, value));
        }
        if let Some(kind) = params.kind {
            changes.push(Change::set("type", kind.as_str()));
        }
        if let Some(risk) = params.risk {
            changes.push(Change::set("risk", risk.as_str()));
        }
        if let Some(confidence) = params.confidence {
            changes.push(Change::set(
                "confidence",
                js_number(clamp_confidence(Some(confidence))),
            ));
        }
        let mut content = memory.content.expose().clone();
        if let Some(c) = &params.content {
            content = normalize_text(Some(c.expose()));
            changes.push(Change::set("content", content.as_str()));
        }
        let mut summary = memory.summary.expose().clone();
        if let Some(s) = &params.summary {
            summary = normalize_summary(&content, Some(s.expose()));
            changes.push(Change::set("summary", summary.as_str()));
        }
        if params.subject.is_some() {
            changes.push(Change::set(
                "subject",
                doc! { "scope": scope.as_str(), "username": &username, "userID": &user_id },
            ));
        }
        if !content.is_empty() && summary.is_empty() {
            summary = normalize_summary(&content, None);
            changes.push(Change::set("summary", summary.as_str()));
        }
        let fp = fingerprint(
            &params.channel_id,
            next_kind.as_str(),
            scope.as_str(),
            &username,
            &summary,
        );
        changes.push(Change::set("fingerprint", fp.as_str()));
        changes.push(Change::set("updatedAt", JsDate(now_ms).to_bson()));
        if !self.validate_save(&loaded, &changes, now_ms) {
            return Err(MemoryError::new(ErrorKind::Invalid, UPDATE_FAILED));
        }
        // An edit that would collide with another memory's fingerprint fails before any write.
        let clash = self
            .mongo_call(
                "updateChannelMemory",
                self.mongo.documents(INFO.name).count_documents(
                    doc! { "channelID": &params.channel_id, "fingerprint": &fp, "_id": { "$ne": id } },
                ),
            )
            .await
            .map_err(|e| e.generic(UPDATE_FAILED))?;
        if clash > 0 {
            return Err(MemoryError::new(ErrorKind::Store, UPDATE_FAILED));
        }
        // Unconfirmed: the reference removes a stale point (its own message on failure).
        // Confirmed: the point goes first and is written again after the save.
        self.remove_point(resolve_point_id(&memory), &memory.channel_id, &id)
            .await
            .map_err(|e| {
                if confirmed {
                    e.generic(UPDATE_FAILED)
                } else {
                    e
                }
            })?;
        self.save(&loaded, &changes, now_ms, "updateChannelMemory")
            .await
            .map_err(|e| e.generic(UPDATE_FAILED))?;
        let stored = self
            .reread(id)
            .await
            .map_err(|e| e.generic(UPDATE_FAILED))?;
        if confirmed {
            self.write_point(&stored)
                .await
                .map_err(|e| e.generic(UPDATE_FAILED))?;
        }
        Ok(stored)
    }

    /// `deleteChannelMemoryPermanently`: the point (owner-checked), then the document. The
    /// memory must belong to `channel_id`: there is no id-less form.
    pub async fn delete(&self, channel_id: &str, memory_id: &str) -> Result<(), MemoryError> {
        let id = parse_object_id(memory_id)
            .ok_or_else(|| MemoryError::new(ErrorKind::Store, DELETE_FAILED))?;
        let found = self
            .mongo_call(
                "deleteChannelMemoryPermanently",
                self.mongo
                    .documents(INFO.name)
                    .find_one(doc! { "_id": id, "channelID": channel_id }),
            )
            .await
            .map_err(|e| e.generic(DELETE_FAILED))?
            .ok_or_else(MemoryError::not_found)?;
        let memory: ChannelAiMemory = dima_model::decode_document(&found)
            .map_err(|_| MemoryError::new(ErrorKind::Store, DELETE_FAILED))?;
        self.remove_point(resolve_point_id(&memory), channel_id, &id)
            .await?;
        self.remove_document(&id, channel_id)
            .await
            .map_err(|e| e.generic(DELETE_FAILED))?;
        Ok(())
    }

    /// Every memory of a channel (account deletion): the channel's points, the documents, then
    /// the points again (a memory confirmed in between leaves no ghost). Returns the documents
    /// deleted.
    pub async fn delete_all_channel_memories(&self, channel_id: &str) -> Result<u64, MemoryError> {
        if channel_id.is_empty() {
            return Err(MemoryError::new(ErrorKind::Invalid, "Missing channelID"));
        }
        self.remove_channel_points(channel_id).await?;
        if self.fault(Step::MongoDeleteMany).await.is_err() {
            return Err(MemoryError::new(ErrorKind::Store, "MongoDB call failed"));
        }
        let deleted = self
            .mongo_call(
                "deleteChannelMemories",
                self.mongo
                    .documents(INFO.name)
                    .delete_many(doc! { "channelID": channel_id }),
            )
            .await?
            .deleted_count;
        self.remove_channel_points(channel_id).await?;
        Ok(deleted)
    }
}

fn evidence_doc(e: &EvidenceInput, now_secs: i64) -> Document {
    doc! {
        "source": e.source.unwrap_or(MemorySource::Chat).as_str(),
        "username": normalize_text(e.username.as_deref()),
        "userID": normalize_text(e.user_id.as_deref()),
        "message": normalize_text(e.message.as_ref().map(|m| m.expose().as_str())),
        "messageId": normalize_text(e.message_id.as_deref()),
        "timestamp": js_number(evidence_time(e.timestamp, now_secs)),
    }
}

/// The normalised values of a create.
struct Prepared {
    channel_id: String,
    content: String,
    summary: String,
    confidence: f64,
    scope: SubjectScope,
    username: String,
    user_id: String,
    fingerprint: String,
    target: MemoryStatus,
    settings: LearningSettings,
}

/// Retries of a create that found the limit passed by a concurrent create.
const LIMIT_RETRIES: u64 = 3;

enum Inserted {
    Duplicate,
    Raced {
        message: &'static str,
        jitter_ms: u64,
    },
    Failed(MemoryError),
}

impl From<MemoryError> for Inserted {
    fn from(e: MemoryError) -> Self {
        Self::Failed(e)
    }
}
