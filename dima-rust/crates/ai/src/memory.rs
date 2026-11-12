//! Pure memory extraction and access policy. Storage and model calls belong to callers.
//!
//! Noise minimum 12 counts Unicode scalars (our text eligibility rule). Confidence and
//! relevance scores remain doubles without rounding. Timestamp inputs are epoch seconds;
//! expiry and ObjectId fallback inputs are epoch milliseconds, supplied by the caller.
//! Quirks preserved: preference detection wins over boundary detection ("no me gusta");
//! substring matching can classify unrelated words, and an explicit zero timestamp uses now.
use crate::prompts::collapse_space;
use regex::Regex;
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    Preference,
    Boundary,
    ChannelLore,
    RunningJoke,
    KnownUserFact,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Channel,
    User,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Streamer,
    Mod,
    Chat,
}
#[derive(Debug, Default, Deserialize)]
pub struct Badge {
    pub set_id: Option<String>,
    pub id: Option<String>,
}
pub fn infer_memory_source_type(channel: &str, user: &str, badges: &[Badge]) -> Source {
    if !user.is_empty() && channel == user {
        return Source::Streamer;
    }
    if badges.iter().any(|b| {
        ["moderator", "lead_mod", "lead_moderator", "mod"].contains(
            &b.set_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .or(b.id.as_deref())
                .unwrap_or("")
                .to_lowercase()
                .as_str(),
        )
    }) {
        Source::Mod
    } else {
        Source::Chat
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractInput {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "userID")]
    pub user_id: String,
    pub username: String,
    pub message: String,
    #[serde(default)]
    pub badges: Vec<Badge>,
    pub timestamp: Option<f64>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct Subject {
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(rename = "userID", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Candidate {
    #[serde(rename = "type")]
    pub kind: MemoryType,
    pub risk: Risk,
    pub confidence: f64,
    pub content: String,
    pub summary: String,
    pub subject: Subject,
    pub source: Source,
    pub timestamp: f64,
}
fn matches(pattern: &str, s: &str) -> bool {
    Regex::new(pattern).is_ok_and(|r| r.is_match(s))
}
pub fn extract_memory_candidate(i: &ExtractInput, now_unix_seconds: f64) -> Option<Candidate> {
    let message = collapse_space(&i.message);
    if message.is_empty()
        || message.starts_with('!')
        || message.chars().count() < 12
        || matches(r"(?i)https?://|^[@#][a-z0-9_]", &message)
    {
        return None;
    }
    let source = infer_memory_source_type(&i.channel_id, &i.user_id, &i.badges);
    let boost: f64 = match source {
        Source::Streamer => 0.1,
        Source::Mod => 0.05,
        Source::Chat => 0.0,
    };
    let (kind, risk, confidence, summary, scope) = if matches(
        r"(?i)(my favorite|i love|i like|i prefer|me encanta|me gusta|prefiero|mi favorito|odio|i hate)",
        &message,
    ) {
        (
            MemoryType::Preference,
            Risk::Low,
            if matches(r"(?i)(my favorite|mi favorito)", &message) {
                0.88
            } else {
                0.78
            },
            format!("{} preference: {message}", i.username),
            Scope::User,
        )
    } else if matches(
        r"(?i)(don'?t|do not|stop|never|no quiero|no me gusta|no hables|no menciones|prohibido)",
        &message,
    ) {
        (
            MemoryType::Boundary,
            Risk::Medium,
            0.74,
            format!("Boundary request from {}: {message}", i.username),
            Scope::User,
        )
    } else if matches(
        r"(?i)(in this channel|en este canal|aqui siempre|here we always|as we always|como siempre)",
        &message,
    ) {
        (
            MemoryType::ChannelLore,
            Risk::Low,
            0.8,
            format!("Channel lore note: {message}"),
            Scope::Channel,
        )
    } else if matches(
        r"(?i)(jaj+a+|lol+|lmao+|xd+|inside joke|meme del canal|joke of the day)",
        &message,
    ) {
        (
            MemoryType::RunningJoke,
            Risk::Low,
            0.7,
            format!("Potential running joke: {message}"),
            Scope::Channel,
        )
    } else if matches(
        r"(?i)^(i am|i'm|soy|me llamo|my name is)[\s\u{feff}]+",
        &message,
    ) {
        (
            MemoryType::KnownUserFact,
            Risk::Medium,
            0.73,
            format!("Known user fact from {}: {message}", i.username),
            Scope::User,
        )
    } else {
        return None;
    };
    Some(Candidate {
        kind,
        risk,
        confidence: (confidence + boost).clamp(0.0, 0.99),
        content: message,
        summary,
        subject: Subject {
            scope,
            username: (scope == Scope::User).then(|| dima_text::trim(&i.username).into()),
            user_id: (scope == Scope::User).then(|| dima_text::trim(&i.user_id).into()),
        },
        source,
        timestamp: i
            .timestamp
            .filter(|t| *t != 0.0 && !t.is_nan())
            .unwrap_or(now_unix_seconds.floor()),
    })
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub allow_sensitive_memories: bool,
    pub allow_user_preference_memories: bool,
    pub allow_running_jokes: bool,
}
pub fn get_memory_policy_violation(
    kind: MemoryType,
    risk: Risk,
    scope: Scope,
    p: &Policy,
) -> Option<&'static str> {
    if risk != Risk::Low && !p.allow_sensitive_memories {
        Some("Sensitive memories are disabled for this channel")
    } else if kind == MemoryType::RunningJoke && !p.allow_running_jokes {
        Some("Running joke memories are disabled for this channel")
    } else if (kind == MemoryType::KnownUserFact || scope == Scope::User)
        && !p.allow_user_preference_memories
    {
        Some("User memories are disabled for this channel")
    } else {
        None
    }
}
pub fn resolve_chat_memory_subject(
    kind: MemoryType,
    requested: &str,
    triggering_username: &str,
    triggering_id: &str,
) -> Result<Subject, &'static str> {
    let requested = dima_text::trim(requested);
    let username = dima_text::trim(triggering_username);
    let id = dima_text::trim(triggering_id);
    if kind != MemoryType::KnownUserFact && requested.is_empty() {
        return Ok(Subject {
            scope: Scope::Channel,
            username: Some(String::new()),
            user_id: Some(String::new()),
        });
    }
    if username.is_empty() || id.is_empty() {
        return Err("A stable Twitch user identity is required for user-scoped memories");
    }
    if !requested.is_empty() && dima_text::to_lower(requested) != dima_text::to_lower(username) {
        return Err("Chat users can only create memories about themselves");
    }
    Ok(Subject {
        scope: Scope::User,
        username: Some(username.into()),
        user_id: Some(id.into()),
    })
}
/// Reference relevance implementation is already shared with Qdrant.
pub use crate::qdrant::is_passive_memory_relevant;
pub const PASSIVE_CANDIDATE_SCORE: f64 = 0.45;
pub fn memory_unix_seconds(date_ms: Option<i64>, object_id_timestamp_ms: i64) -> i64 {
    date_ms.unwrap_or(object_id_timestamp_ms).div_euclid(1000)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRecord {
    #[serde(rename = "memoryID")]
    pub memory_id: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
    pub status: String,
    #[serde(rename = "type")]
    pub kind: MemoryType,
    pub risk: Risk,
    pub subject_scope: Scope,
    pub subject_username: Option<String>,
    pub summary: String,
    /// Integration converts Date to milliseconds; missing/null both mean no expiry.
    pub expires_at: Option<i64>,
}
#[derive(Debug, Deserialize)]
pub struct ScoredMemory {
    pub memory_id: String,
    pub score: f64,
}
#[derive(Debug, Serialize)]
pub struct ValidatedMemory {
    pub memory_id: String,
    pub memory_type: MemoryType,
    pub risk: Risk,
    pub summary: String,
    #[serde(rename = "subjectUsername", skip_serializing_if = "Option::is_none")]
    pub subject_username: Option<String>,
    pub score: f64,
}
fn allowed(r: &ValidationRecord, channel: &str, p: &Policy, now_ms: i64) -> bool {
    r.channel_id == channel
        && r.status == "confirmed"
        && r.expires_at.is_none_or(|e| e > now_ms)
        && get_memory_policy_violation(r.kind, r.risk, r.subject_scope, p).is_none()
}
pub fn select_validated_channel_memories(
    channel: &str,
    candidates: &[ScoredMemory],
    records: &[ValidationRecord],
    policy: &Policy,
    limit: usize,
    now_ms: i64,
) -> Vec<ValidatedMemory> {
    candidates
        .iter()
        .filter_map(|c| {
            records
                .iter()
                .rev()
                .find(|r| r.memory_id == c.memory_id)
                .filter(|r| allowed(r, channel, policy, now_ms))
                .map(|r| ValidatedMemory {
                    memory_id: r.memory_id.clone(),
                    memory_type: r.kind,
                    risk: r.risk,
                    summary: r.summary.clone(),
                    subject_username: if r.subject_scope == Scope::User {
                        r.subject_username.clone()
                    } else {
                        None
                    },
                    score: c.score,
                })
        })
        .take(limit)
        .collect()
}
/// Preserve application-owned fields (such as full content) during explicit recall.
pub trait PolicyRecord {
    fn validation_record(&self) -> &ValidationRecord;
}
impl PolicyRecord for ValidationRecord {
    fn validation_record(&self) -> &ValidationRecord {
        self
    }
}
pub fn select_validated_recall_memories<'a, T: PolicyRecord>(
    channel: &str,
    records: &'a [T],
    policy: &Policy,
    limit: usize,
    now_ms: i64,
) -> Vec<&'a T> {
    records
        .iter()
        .filter(|r| allowed(r.validation_record(), channel, policy, now_ms))
        .take(limit)
        .collect()
}
