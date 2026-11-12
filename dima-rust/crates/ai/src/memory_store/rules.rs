//! Pure rules of `memory.service.ts`: text normalisation, the summary cut, the dedupe
//! fingerprint, the learning configuration and the auto-confirm decision, and the conversions
//! between the stored vocabulary (`dima_model`) and the policy vocabulary (`crate::memory`).
//!
//! Text classification (MIGRATION.md section 4): the summary cut (180 UTF-16 units, cut at 177
//! plus `...`) feeds the fingerprint, an identity, so it keeps the reference's position with
//! `dima_text::truncate_utf16_budget` (never inside a character: where JavaScript would leave a
//! lone surrogate, the cut lands one unit earlier). Lower-casing for the fingerprint uses
//! `dima_text::to_lower`. Size bounds of this module (`Config::max_*`) count Unicode scalars.

use crate::memory::{self, Policy};
use dima_model::channel_ai_memories::{MemoryRisk, MemoryType, SubjectScope};
use dima_model::channel_ai_personalities::{LearningConfig, MemoryPolicy};
use dima_model::enums::Open;
use dima_text::{to_lower, trim, truncate_utf16_budget, utf16_len};

/// `String(value ?? '').trim()`.
pub(crate) fn normalize_text(value: Option<&str>) -> String {
    trim(value.unwrap_or("")).to_owned()
}

/// `clampConfidence`: a non-finite value (missing included) is 0.5, then clamped to 0..1.
pub(crate) fn clamp_confidence(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0),
        _ => 0.5,
    }
}

/// `normalizeSummary(content, summary)`: the trimmed summary, else the trimmed content; longer
/// than 180 UTF-16 units: the first 177 units and `...`.
pub(crate) fn normalize_summary(content: &str, summary: Option<&str>) -> String {
    let summary = trim(summary.unwrap_or(""));
    let source = if summary.is_empty() {
        trim(content)
    } else {
        summary
    };
    if utf16_len(source) <= 180 {
        source.to_owned()
    } else {
        format!("{}...", truncate_utf16_budget(source, 177))
    }
}

/// `buildFingerprint`: SHA-256 (hex) of `channel|type|scope|username|summary`, the last three
/// lower-cased, every part trimmed, an empty scope read as `channel`.
pub(crate) fn fingerprint(
    channel_id: &str,
    kind: &str,
    scope: &str,
    username: &str,
    summary: &str,
) -> String {
    let scope = if scope.is_empty() { "channel" } else { scope };
    let input = [
        trim(channel_id).to_owned(),
        trim(kind).to_owned(),
        to_lower(trim(scope)),
        to_lower(trim(username)),
        to_lower(trim(summary)),
    ]
    .join("|");
    dima_core::crypto::sha256(input.as_bytes()).hex()
}

/// `resolveLearningConfig` and `getChannelLearningConfig`, read from the stored personality.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LearningSettings {
    /// `enabled` (default true).
    pub enabled: bool,
    /// `autoConfirmEnabled` (default true).
    pub auto_confirm_enabled: bool,
    /// `autoConfirmThreshold` (default 0.82).
    pub auto_confirm_threshold: f64,
    /// `maxPendingMemories` (default 250; 0 or less: no limit, as the reference).
    pub max_pending_memories: f64,
    /// `maxConfirmedMemories` (default 2000; 0 or less: no limit).
    pub max_confirmed_memories: f64,
    /// `createMinConfidence` (default 0.72), read by the AI's `create_memory` tool.
    pub create_min_confidence: f64,
}

impl LearningSettings {
    pub(crate) fn from_stored(config: Option<&LearningConfig>) -> Self {
        let defaults = LearningConfig::default();
        let c = config.unwrap_or(&defaults);
        Self {
            enabled: c.enabled,
            auto_confirm_enabled: c.auto_confirm_enabled,
            auto_confirm_threshold: c.auto_confirm_threshold.0,
            max_pending_memories: c.max_pending_memories.0,
            max_confirmed_memories: c.max_confirmed_memories.0,
            create_min_confidence: c.create_min_confidence.0,
        }
    }

    /// `shouldAutoConfirm`: enabled, low risk, and confidence at or above the threshold.
    pub(crate) fn should_auto_confirm(&self, risk: MemoryRisk, confidence: f64) -> bool {
        self.auto_confirm_enabled
            && risk == MemoryRisk::Low
            && confidence >= self.auto_confirm_threshold
    }
}

/// `resolveMemoryPolicy`.
pub(crate) fn policy_from_stored(stored: Option<&MemoryPolicy>) -> Policy {
    let defaults = MemoryPolicy::default();
    let p = stored.unwrap_or(&defaults);
    Policy {
        allow_sensitive_memories: p.allow_sensitive_memories,
        allow_user_preference_memories: p.allow_user_preference_memories,
        allow_running_jokes: p.allow_running_jokes,
    }
}

pub(crate) fn policy_kind(kind: MemoryType) -> memory::MemoryType {
    match kind {
        MemoryType::Preference => memory::MemoryType::Preference,
        MemoryType::RunningJoke => memory::MemoryType::RunningJoke,
        MemoryType::KnownUserFact => memory::MemoryType::KnownUserFact,
        MemoryType::ChannelLore => memory::MemoryType::ChannelLore,
        MemoryType::Boundary => memory::MemoryType::Boundary,
    }
}

pub(crate) fn policy_risk(risk: MemoryRisk) -> memory::Risk {
    match risk {
        MemoryRisk::Low => memory::Risk::Low,
        MemoryRisk::Medium => memory::Risk::Medium,
        MemoryRisk::High => memory::Risk::High,
    }
}

pub(crate) fn policy_scope(scope: SubjectScope) -> memory::Scope {
    match scope {
        SubjectScope::Channel => memory::Scope::Channel,
        SubjectScope::User => memory::Scope::User,
    }
}

/// `getMemoryPolicyViolation` over stored values. A stored value the schema no longer lists
/// compares as the reference compares strings: a risk other than `low` is sensitive, a type that
/// is neither `running_joke` nor `known_user_fact` is neutral, a scope other than `user` is the
/// channel.
pub(crate) fn stored_policy_violation(
    kind: &Open<MemoryType>,
    risk: &Open<MemoryRisk>,
    scope: &Open<SubjectScope>,
    policy: &Policy,
) -> Option<&'static str> {
    let kind = kind
        .known()
        .map_or(memory::MemoryType::ChannelLore, policy_kind);
    let risk = risk.known().map_or(memory::Risk::High, policy_risk);
    let scope = scope.known().map_or(memory::Scope::Channel, policy_scope);
    memory::get_memory_policy_violation(kind, risk, scope, policy)
}

/// `Types.ObjectId.isValid` / Mongoose's cast of an id string: 24 hexadecimal digits, either case.
pub(crate) fn parse_object_id(text: &str) -> Option<bson::oid::ObjectId> {
    if text.len() == 24 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        bson::oid::ObjectId::parse_str(text).ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_cut_keeps_the_utf16_position_and_never_splits_a_character() {
        assert_eq!(normalize_summary("  body  ", Some("   ")), "body");
        let long = "a".repeat(181);
        assert_eq!(
            normalize_summary(&long, None),
            format!("{}...", "a".repeat(177))
        );
        // 176 units, then an astral character (2 units): JavaScript cuts inside it; Rust before it.
        let astral = format!("{}😀{}", "b".repeat(176), "c".repeat(10));
        assert_eq!(
            normalize_summary("", Some(&astral)),
            format!("{}...", "b".repeat(176))
        );
        assert_eq!(normalize_summary(&"é".repeat(180), None), "é".repeat(180));
    }

    #[test]
    fn fingerprint_is_sha256_of_the_normalised_parts() {
        let a = fingerprint(" 1 ", "preference", "", " Bob ", " Likes TEA ");
        let b = fingerprint("1", "preference", "channel", "bob", "likes tea");
        assert_eq!(a, b);
        assert_eq!(
            b,
            dima_core::crypto::sha256(b"1|preference|channel|bob|likes tea").hex()
        );
    }

    #[test]
    fn confidence_clamps_like_the_reference() {
        assert_eq!(clamp_confidence(None), 0.5);
        assert_eq!(clamp_confidence(Some(f64::NAN)), 0.5);
        assert_eq!(clamp_confidence(Some(f64::INFINITY)), 0.5);
        assert_eq!(clamp_confidence(Some(-1.0)), 0.0);
        assert_eq!(clamp_confidence(Some(1.5)), 1.0);
        assert_eq!(clamp_confidence(Some(0.7)), 0.7);
    }

    #[test]
    fn object_ids_are_24_hex_digits() {
        assert!(parse_object_id("0123456789ABCDEF01234567").is_some());
        assert!(parse_object_id("abcdefghijkl").is_none());
        assert!(parse_object_id("").is_none());
    }
}
