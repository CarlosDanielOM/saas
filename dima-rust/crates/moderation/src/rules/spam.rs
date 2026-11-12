//! Spam protection (reference `utils/moderation/spam.ts`): the built-in rule a model reviews a
//! chatter's first message (and, on paid plans, every message) against, its settings, and the
//! two pieces of state that gate the reviews.
//!
//! The reference has no repeat or flood counter (no "same message N times" or "N messages per
//! second" rule): spam is judged by the semantic review, and what bounds it is the review
//! budget below. Nothing of the kind is invented here.
//!
//! # State
//!
//! - `moderation:seen:{sha256(JSON [channel, user])}` (string `1`, 86,400 s): this chatter was
//!   already seen; spares the MongoDB upsert of `moderation_chatters` (whose unique `_id` is
//!   what makes "first message" atomic across processes). Rebuilt at cutover: the first
//!   message after it costs one upsert, which finds the existing document; nobody is reviewed
//!   twice as a first-time chatter.
//! - `moderation:spam-budget:channel:{channel}` and `moderation:spam-budget:global` (hash
//!   `window` = Unix minute, `count`; 120 s): at most 30 reviews per channel and 300 overall per
//!   minute, both checked and taken in one script (`lua/spam_review_budget.lua`, the
//!   reference's text, using the server's clock), so concurrent messages never overspend.
//!   A flood of chatters in one channel uses that channel's 30 and nothing more: messages past
//!   the budget are not reviewed (they pass, as in the reference). Two keys per channel that
//!   reviewed in the last two minutes. Rebuilt at cutover: a fresh minute.

use dima_commands::permissions::{CompiledPermission, UserIdentity};
use dima_model::channel_moderation_settings::ChannelModerationSettingsSpamProtection;
use dima_model::moderation_chatters;
use dima_store::dragonfly::commands::reply;
use dima_store::dragonfly::{Script, SetOptions};
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::UpdateOptions;
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

use super::advanced::paid_moderation;
use super::spam_categories::{
    DEFAULT_SPAM_CATEGORIES, DEFAULT_SPAM_EXEMPT_TAGS, DEFAULT_SPAM_THRESHOLD,
    INVITED_PROMOTION_POLICY, SPAM_RULE_POLICY,
};
use super::store::{RulesStore, StoreError};

/// `SPAM_RULE_ID`.
pub const SPAM_RULE_ID: &str = "builtin-spam-protection";
/// `SPAM_CHANNEL_REVIEWS_PER_MINUTE`.
pub const SPAM_CHANNEL_REVIEWS_PER_MINUTE: u32 = 30;
/// `SPAM_GLOBAL_REVIEWS_PER_MINUTE`.
pub const SPAM_GLOBAL_REVIEWS_PER_MINUTE: u32 = 300;
/// The first-message marker's lifetime.
pub const SEEN_MARKER_SECONDS: u64 = 86_400;

/// The reference's script, verbatim.
pub static SPAM_REVIEW_BUDGET: Script = Script::new(
    "claimSpamReviewBudget",
    include_str!("lua/spam_review_budget.lua"),
);

/// `spamRule`: the default blocked-word rule turned into the built-in spam rule (ban on every
/// offense, contextual review with the default categories), keys in the reference's order.
pub fn spam_rule() -> Value {
    json!({
        "enabled": true,
        "firstOffense": { "action": "ban", "timeoutSeconds": 60 },
        "secondOffense": { "action": "ban", "timeoutSeconds": 60 },
        "thirdOffense": { "action": "ban", "timeoutSeconds": 60 },
        "reason": "Selected unwanted chat behavior",
        "exemptUserLevel": 7,
        "capsThresholdMode": "count",
        "minCapsCount": 8,
        "maxCapsPercentage": 70,
        "minMessageLength": 10,
        "allowlistDomains": [],
        "maxEmoteCount": 10,
        "terms": [],
        "id": SPAM_RULE_ID,
        "type": "blacklist",
        "semantic": {
            "enabled": true,
            "categories": DEFAULT_SPAM_CATEGORIES,
            "thresholdPercent": 85,
            "policy": SPAM_RULE_POLICY,
            "examples": [
                { "message": "Want to buy more viewers? Visit viewerbuy . com!", "label": "violation" },
                { "message": "I sell cheap viewers and followers, DM me for prices", "label": "violation" },
                { "message": "Follow my channel at twitch.tv/mychannel for better content!", "label": "violation" },
                { "message": r#"Someone posted "buy viewers at viewerbuy.com". Is that a scam?"#, "label": "allow" },
                { "message": "Do not buy viewers; those sites are scams.", "label": "allow" },
                { "message": "I stream too, how do you set up your microphone?", "label": "allow" }
            ],
            "onUncertain": "allow_and_log"
        }
    })
}

/// One message of the preceding chat (`ModerationContextMessage`), as far as the rules read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextMessage {
    /// The text.
    pub message: String,
    /// Sent by the broadcaster (`isBroadcaster === true`).
    pub is_broadcaster: bool,
}

fn invitation_patterns() -> Option<&'static (Regex, Regex)> {
    static PATTERNS: OnceLock<Option<(Regex, Regex)>> = OnceLock::new();
    PATTERNS
        .get_or_init(|| {
            // `\b` is ASCII in the reference too (`/u` without `i` would make it so; with `iu`
            // JavaScript also counts `ſ` and the Kelvin sign as word characters, the only
            // difference, recorded in the report).
            let build = |source: &str| {
                RegexBuilder::new(&source.replace(r"\b", r"(?-u:\b)"))
                    .case_insensitive(true)
                    .build()
                    .ok()
            };
            let negation = build(r"\b(?:don't|dont|do not|never|stop|no|not|prohibido|prohibida|nunca)\b")?;
            let invitation = build(
                r"\b(?:share|post|drop)\s+(?:your\s+)?(?:channel|twitch|social)(?:\s+links?)?\b|\b(?:comparte|compartan|compartid|publica|publiquen|deja|dejen)\s+(?:(?:tu|tus|su|sus|vuestro|vuestros)\s+)?(?:canal|canales|redes|enlaces)\b",
            )?;
            Some((negation, invitation))
        })
        .as_ref()
}

/// `broadcasterInvitedPromotion`: a broadcaster message in the context asks chatters to share
/// their channels and says nothing negative.
pub fn broadcaster_invited_promotion(context: &[ContextMessage]) -> bool {
    let Some((negation, invitation)) = invitation_patterns() else {
        return false;
    };
    context.iter().any(|message| {
        message.is_broadcaster
            && !negation.is_match(&message.message)
            && invitation.is_match(&message.message)
    })
}

/// `spamProtectionSettings`: the stored settings with the reference's defaults applied.
#[derive(Debug, Clone, PartialEq)]
pub struct SpamProtection {
    /// `enabled !== false`.
    pub enabled: bool,
    /// `reviewAllMessages === true`.
    pub review_all_messages: bool,
    /// The categories reviewed.
    pub categories: Vec<String>,
    /// The confidence needed.
    pub threshold_percent: f64,
    /// The roles exempt from review.
    pub exempt_tags: Vec<String>,
}

impl Default for SpamProtection {
    fn default() -> Self {
        Self {
            enabled: true,
            review_all_messages: false,
            categories: DEFAULT_SPAM_CATEGORIES.map(str::to_owned).to_vec(),
            threshold_percent: DEFAULT_SPAM_THRESHOLD,
            exempt_tags: DEFAULT_SPAM_EXEMPT_TAGS.map(str::to_owned).to_vec(),
        }
    }
}

impl SpamProtection {
    /// From the stored sub-document (the model already applies the schema defaults when it is
    /// missing). A `null` inside a list is dropped (the reference would keep it and fail later).
    pub fn from_model(stored: &ChannelModerationSettingsSpamProtection) -> Self {
        Self {
            enabled: stored.enabled,
            review_all_messages: stored.review_all_messages,
            categories: stored.categories.iter().flatten().cloned().collect(),
            threshold_percent: stored.threshold_percent.0,
            exempt_tags: stored.exempt_tags.iter().flatten().cloned().collect(),
        }
    }

    /// `spamProtectionSettings(settings)` as the reference writes it (keys in its order).
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "reviewAllMessages": self.review_all_messages,
            "categories": self.categories,
            "thresholdPercent": json_number(self.threshold_percent),
            "exemptTags": self.exempt_tags
        })
    }

    /// Reviews happen at all.
    pub fn active(&self) -> bool {
        self.enabled && !self.categories.is_empty()
    }

    /// The exemption of `spamRuleForContext`: any listed role, or nobody when none is listed.
    pub fn exemption_expression(&self) -> Value {
        if self.exempt_tags.is_empty() {
            json!({ "not": { "role": "everyone" } })
        } else {
            json!({ "or": self.exempt_tags.iter().map(|role| json!({ "role": role })).collect::<Vec<_>>() })
        }
    }

    /// `ruleExempt(spamRuleForContext([], settings), identity)`.
    pub fn exempt(&self, identity: &UserIdentity) -> bool {
        let expression = self.exemption_expression();
        CompiledPermission::compile(Some(&expression), Some(&json!(7))).allowed(identity)
    }
}

/// `spamRuleForContext(context, settings)`: [`spam_rule`] with the channel's categories,
/// threshold and exemption, and the invitation policy when the broadcaster invited promotion.
pub fn spam_rule_for_context(context: &[ContextMessage], protection: &SpamProtection) -> Value {
    let invitation = broadcaster_invited_promotion(context);
    let mut rule = spam_rule();
    if let Some(semantic) = rule.get_mut("semantic").and_then(Value::as_object_mut) {
        semantic.insert("categories".into(), json!(protection.categories));
        semantic.insert(
            "thresholdPercent".into(),
            json_number(protection.threshold_percent),
        );
        semantic.insert(
            "policy".into(),
            Value::String(
                if invitation {
                    INVITED_PROMOTION_POLICY
                } else {
                    SPAM_RULE_POLICY
                }
                .to_owned(),
            ),
        );
        semantic.insert("broadcasterInvitation".into(), Value::Bool(invitation));
    }
    if let Some(object) = rule.as_object_mut() {
        object.insert("exemptExpression".into(), protection.exemption_expression());
    }
    rule
}

/// A number as JavaScript writes it in JSON (an integral value without a fraction).
fn json_number(value: f64) -> Value {
    dima_text::js_number_value(value)
}

/// Where a spam review comes from (`reviewSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewSource {
    /// A rule's contextual review.
    Rule,
    /// The chatter's first message.
    FirstMessage,
    /// Every message (paid plans with `reviewAllMessages`).
    SpamContinuous,
}

impl ReviewSource {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rule => "rule",
            Self::FirstMessage => "first_message",
            Self::SpamContinuous => "spam_continuous",
        }
    }
}

/// `spamReviewSource`: why this message is reviewed, or `None`.
pub fn spam_review_source(
    first_message: bool,
    protection: &SpamProtection,
    tier: Option<&str>,
) -> Option<ReviewSource> {
    if !protection.active() {
        return None;
    }
    if first_message {
        return Some(ReviewSource::FirstMessage);
    }
    (protection.review_all_messages && paid_moderation(tier))
        .then_some(ReviewSource::SpamContinuous)
}

/// `isSpamDecision`.
pub fn is_spam_decision(rule_id: Option<&str>, review_source: Option<&str>) -> bool {
    rule_id == Some(SPAM_RULE_ID)
        && matches!(review_source, Some("first_message" | "spam_continuous"))
}

/// What `semanticPolicyActive` reads of the current settings (`None` when the channel has none).
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentPolicy<'a> {
    /// `settingsVersion`.
    pub settings_version: f64,
    /// `enabled`.
    pub enabled: bool,
    /// Spam protection.
    pub protection: SpamProtection,
    /// `(rule.id, rule.enabled)` of every rule.
    pub rules: Vec<(&'a str, bool)>,
}

/// `semanticPolicyActive`: the policy a decision was made under still applies (same settings
/// version; spam protection still on for a spam decision, the rule still enabled otherwise).
pub fn semantic_policy_active(
    current: Option<&CurrentPolicy<'_>>,
    decision_settings_version: Option<f64>,
    decision_rule_id: Option<&str>,
    decision_review_source: Option<&str>,
) -> bool {
    let version = current.map_or(0.0, |current| current.settings_version);
    if Some(version) != decision_settings_version {
        return false;
    }
    if is_spam_decision(decision_rule_id, decision_review_source) {
        let protection = current
            .map(|current| current.protection.clone())
            .unwrap_or_default();
        return protection.active()
            && (decision_review_source == Some("first_message") || protection.review_all_messages);
    }
    current.is_some_and(|current| {
        current.enabled
            && current
                .rules
                .iter()
                .any(|(id, enabled)| Some(*id) == decision_rule_id && *enabled)
    })
}

/// `defaultSpamModerationSettings`: the settings of a channel without a document (version 0:
/// any save cancels a review made under them), as the JSON the handler caches.
pub fn default_spam_moderation_settings(channel_id: &str) -> Value {
    let protection = SpamProtection::default();
    json!({
        "enabled": false,
        "offenseWindowSeconds": 3600,
        "settingsVersion": 0,
        "channelID": channel_id,
        "channel": "",
        "rules": [],
        "spamProtection": {
            "enabled": protection.enabled,
            "reviewAllMessages": protection.review_all_messages,
            "categories": protection.categories,
            "thresholdPercent": 85,
            "exemptTags": protection.exempt_tags
        },
        "createdAt": "1970-01-01T00:00:00.000Z",
        "updatedAt": "1970-01-01T00:00:00.000Z"
    })
}

/// `chatterMarkerID`: SHA-256 of `JSON.stringify([channelID, userID])` (the stored `_id` of
/// `moderation_chatters`).
pub fn chatter_marker_id(channel_id: &str, user_id: &str) -> String {
    let json = dima_text::to_js_json(&json!([channel_id, user_id]));
    hex::encode(Sha256::digest(json.as_bytes()))
}

/// The first-message marker key.
pub fn seen_key(marker_id: &str) -> String {
    format!("moderation:seen:{marker_id}")
}

/// The budget keys: the channel's, then the global one.
pub fn spam_budget_keys(channel_id: &str) -> [String; 2] {
    [
        format!("moderation:spam-budget:channel:{channel_id}"),
        "moderation:spam-budget:global".to_owned(),
    ]
}

impl RulesStore {
    /// `claimFirstObservedMessage`: `true` exactly once per chatter and channel, across
    /// processes (the `moderation_chatters` upsert decides; a duplicate-key race loses).
    pub async fn claim_first_observed_message(
        &self,
        channel_id: &str,
        user_id: &str,
    ) -> Result<bool, StoreError> {
        let id = chatter_marker_id(channel_id, user_id);
        let key = self.key(&seen_key(&id));
        if self
            .dragonfly
            .get(&key)
            .await?
            .is_some_and(|value| !value.is_empty())
        {
            return Ok(false);
        }
        let now = self.clock.now_ms();
        let mut ctx = WriteContext::new(now);
        let prepared = moderation_chatters::INFO
            .prepare_update(
                &bson::doc! { "_id": &id },
                bson::doc! { "$setOnInsert": { "firstSeenAt": bson::DateTime::from_millis(now) } },
                UpdateOptions::upsert(),
                &mut ctx,
            )
            .map_err(|error| StoreError::Mongo {
                operation: "moderation_chatters.updateOne",
                message: error.to_string(),
            })?;
        let mut writes = self.mongo.writes(moderation_chatters::COLLECTION);
        let first = match self
            .mongo_call(
                "moderation_chatters.updateOne",
                writes.update_one(&prepared),
            )
            .await
        {
            Ok(outcome) => outcome.upserted_id.is_some(),
            Err(StoreError::Mongo { message, .. }) if message.contains("E11000") => false,
            Err(error) => return Err(error),
        };
        self.dragonfly
            .set(&key, b"1", SetOptions::ex(SEEN_MARKER_SECONDS))
            .await?;
        Ok(first)
    }

    /// `claimSpamReviewBudget`: takes one review from the channel's and the global per-minute
    /// budget, or none when either is spent.
    pub async fn claim_spam_review_budget(&self, channel_id: &str) -> Result<bool, StoreError> {
        let keys = spam_budget_keys(channel_id).map(|key| self.key(&key));
        let args = [
            SPAM_CHANNEL_REVIEWS_PER_MINUTE.to_string(),
            SPAM_GLOBAL_REVIEWS_PER_MINUTE.to_string(),
        ];
        let value = SPAM_REVIEW_BUDGET
            .run_value(&self.dragonfly, &keys, &args)
            .await?;
        Ok(reply::int(value).map_err(|_| StoreError::Reply("claimSpamReviewBudget"))? == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broadcaster(message: &str) -> ContextMessage {
        ContextMessage {
            message: message.to_owned(),
            is_broadcaster: true,
        }
    }

    #[test]
    fn invitation() {
        assert!(broadcaster_invited_promotion(&[broadcaster(
            "Share your channel links below!"
        )]));
        assert!(broadcaster_invited_promotion(&[broadcaster(
            "dejen sus redes"
        )]));
        assert!(!broadcaster_invited_promotion(&[broadcaster(
            "Do not share your channel"
        )]));
        assert!(!broadcaster_invited_promotion(&[ContextMessage {
            message: "share your channel".into(),
            is_broadcaster: false,
        }]));
        assert!(!broadcaster_invited_promotion(&[broadcaster(
            "sharechannel"
        )]));
    }

    #[test]
    fn review_source_and_policy() {
        let mut protection = SpamProtection::default();
        assert_eq!(
            spam_review_source(true, &protection, None),
            Some(ReviewSource::FirstMessage)
        );
        assert_eq!(spam_review_source(false, &protection, Some("pro")), None);
        protection.review_all_messages = true;
        assert_eq!(spam_review_source(false, &protection, Some("free")), None);
        assert_eq!(
            spam_review_source(false, &protection, Some("pro")),
            Some(ReviewSource::SpamContinuous)
        );
        protection.categories.clear();
        assert_eq!(spam_review_source(true, &protection, None), None);
        assert!(semantic_policy_active(
            None,
            Some(0.0),
            Some(SPAM_RULE_ID),
            Some("first_message")
        ));
        assert!(!semantic_policy_active(
            None,
            Some(0.0),
            Some(SPAM_RULE_ID),
            Some("spam_continuous")
        ));
        assert!(!semantic_policy_active(
            None,
            Some(1.0),
            Some(SPAM_RULE_ID),
            Some("first_message")
        ));
        let current = CurrentPolicy {
            settings_version: 3.0,
            enabled: true,
            protection: SpamProtection::default(),
            rules: vec![("r1", true), ("r2", false)],
        };
        assert!(semantic_policy_active(
            Some(&current),
            Some(3.0),
            Some("r1"),
            Some("rule")
        ));
        assert!(!semantic_policy_active(
            Some(&current),
            Some(3.0),
            Some("r2"),
            Some("rule")
        ));
        assert!(!semantic_policy_active(
            Some(&current),
            None,
            Some("r1"),
            Some("rule")
        ));
    }

    #[test]
    fn marker_ids_and_script() {
        // sha256('["1","2"]')
        assert_eq!(
            chatter_marker_id("1", "2"),
            hex::encode(Sha256::digest(br#"["1","2"]"#))
        );
        assert!(SPAM_REVIEW_BUDGET.check().is_ok());
    }
}
