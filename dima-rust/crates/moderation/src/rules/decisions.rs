//! Moderation decisions (reference `utils/moderation/decisions.ts`): the audit record of a
//! rule that fired, created once per (channel, message, rule), and the bounded wait for a
//! semantic verdict.
//!
//! Both write `moderation_decisions` through the model's prepared writes. The semantic worker
//! that completes a pending decision is P4-MOD-RUN.

use std::time::Duration;

use bson::{Bson, Document, doc};
use dima_model::moderation_decisions;
use dima_store::mongo::WriteContext;
use dima_store::mongo::update::{Returned, UpdateOptions};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::advanced::{
    DECISION_POLICY_VERSION, MODERATION_RETENTION_DAYS, ModerationMatch, SEMANTIC_MODEL,
};
use super::engine::DecisionMode;
use super::spam::ReviewSource;
use super::store::{RulesStore, StoreError};
use super::variations::{ModerationVariations, compile_rule_variations};

/// How often the wait reads the decision (`setTimeout(resolve, 80)`).
pub const SEMANTIC_POLL_INTERVAL: Duration = Duration::from_millis(80);

/// `moderationDecisionID`: SHA-256 of `JSON.stringify([channelID, messageID, ruleID])`, the
/// decision's `_id` (a stored identity: one decision per message and rule).
pub fn moderation_decision_id(channel_id: &str, message_id: &str, rule_id: &str) -> String {
    let json = dima_text::to_js_json(&json!([channel_id, message_id, rule_id]));
    hex::encode(Sha256::digest(json.as_bytes()))
}

/// What the handler passes to `createModerationDecision`.
#[derive(Debug, Clone)]
pub struct NewDecision {
    /// `channelID`.
    pub channel_id: String,
    /// `userID`.
    pub user_id: String,
    /// `username`.
    pub username: String,
    /// `messageID`.
    pub message_id: String,
    /// `messageText`.
    pub message_text: String,
    /// `ruleID`.
    pub rule_id: String,
    /// The rule as stored in the settings (raw), or the spam rule ([`super::spam`]).
    pub rule: Document,
    /// `settingsVersion`.
    pub settings_version: f64,
    /// `matches`.
    pub matches: Vec<ModerationMatch>,
    /// `context` (the preceding chat, built by the handler).
    pub context: Vec<Document>,
    /// `mode`.
    pub mode: DecisionMode,
    /// `deadline`, epoch milliseconds.
    pub deadline_ms: i64,
    /// `reviewSource`; `None` for a rule's decision (the schema default `rule` applies).
    pub review_source: Option<ReviewSource>,
}

/// A JavaScript number as Node stores it.
fn number(value: f64) -> Bson {
    dima_store::mongo::number::JsNumber(value).to_bson()
}

/// The rule as the decision stores it: variations compiled for the rule
/// (`compileRuleVariations`) and, for a semantic decision, the threshold defaulted to 85.
pub fn decision_rule(rule: &Document, semantic: bool) -> Result<Document, StoreError> {
    let mut rule = rule.clone();
    if let Some(raw) = rule
        .get("variations")
        .filter(|raw| !matches!(raw, Bson::Null))
    {
        let variations: ModerationVariations = bson::deserialize_from_bson(raw.clone())
            .map_err(|_| StoreError::Reply("rule.variations"))?;
        let compiled = compile_rule_variations(Some(&variations))
            .map_err(|_| StoreError::Reply("rule.variations"))?;
        if let Some(compiled) = compiled.filter(|compiled| !compiled.is_off()) {
            let value = bson::serialize_to_bson(&compiled)
                .map_err(|_| StoreError::Reply("rule.variations"))?;
            rule.insert("variations", value);
        }
    }
    if semantic {
        let mut policy = rule.get_document("semantic").cloned().unwrap_or_default();
        if matches!(policy.get("thresholdPercent"), None | Some(Bson::Null)) {
            policy.insert("thresholdPercent", 85);
        }
        rule.insert("semantic", policy);
    }
    Ok(rule)
}

fn mongo_error(operation: &'static str, error: impl std::fmt::Display) -> StoreError {
    StoreError::Mongo {
        operation,
        message: error.to_string(),
    }
}

impl RulesStore {
    /// `createModerationDecision`: inserts the decision once (`$setOnInsert`, upsert) and
    /// returns it as stored, also when a concurrent delivery created it first.
    pub async fn create_moderation_decision(
        &self,
        input: &NewDecision,
    ) -> Result<Document, StoreError> {
        let id = moderation_decision_id(&input.channel_id, &input.message_id, &input.rule_id);
        let semantic = input.mode == DecisionMode::Semantic;
        let now = self.clock.now_ms();
        let matches: Vec<Bson> = input
            .matches
            .iter()
            .map(|m| {
                Bson::Document(doc! {
                    "matcherID": &m.matcher_id, "text": &m.text,
                    "start": number(m.start as f64), "end": number(m.end as f64),
                })
            })
            .collect();
        let mut insert = doc! {
            "channelID": &input.channel_id,
            "userID": &input.user_id,
            "username": &input.username,
            "messageID": &input.message_id,
            "messageText": &input.message_text,
            "ruleID": &input.rule_id,
            "rule": decision_rule(&input.rule, semantic)?,
            "settingsVersion": number(input.settings_version),
            "matches": matches,
            "context": input.context.iter().cloned().map(Bson::Document).collect::<Vec<_>>(),
            "mode": input.mode.as_str(),
        };
        if let Some(source) = input.review_source {
            insert.insert("reviewSource", source.as_str());
        }
        insert.insert("deadline", bson::DateTime::from_millis(input.deadline_ms));
        insert.insert("_id", &id);
        insert.insert("state", if semantic { "pending" } else { "completed" });
        insert.insert("verdict", if semantic { "uncertain" } else { "violation" });
        insert.insert("status", if semantic { "pending" } else { "matched" });
        insert.insert("model", if semantic { SEMANTIC_MODEL } else { "" });
        insert.insert("decisionPolicyVersion", DECISION_POLICY_VERSION);
        insert.insert("createdAt", bson::DateTime::from_millis(now));
        insert.insert(
            "expiresAt",
            bson::DateTime::from_millis(now + MODERATION_RETENTION_DAYS * 86_400_000),
        );
        let mut ctx = WriteContext::new(now);
        let mut options = UpdateOptions::upsert();
        options.set_defaults_on_insert = true;
        let prepared = moderation_decisions::INFO
            .prepare_find_one_and_update(
                &doc! { "_id": &id },
                doc! { "$setOnInsert": insert },
                options,
                Returned::After,
                &mut ctx,
            )
            .map_err(|error| mongo_error("moderation_decisions.findOneAndUpdate", error))?;
        let mut writes = self.mongo.writes(moderation_decisions::COLLECTION);
        self.mongo_call(
            "moderation_decisions.findOneAndUpdate",
            writes.find_one_and_update(&prepared),
        )
        .await?
        .ok_or(StoreError::Reply("moderation_decisions.findOneAndUpdate"))
    }

    async fn find_decision(&self, id: &str) -> Result<Option<Document>, StoreError> {
        let collection = self.mongo.documents(moderation_decisions::COLLECTION);
        self.mongo_call(
            "moderation_decisions.findById",
            collection.find_one(doc! { "_id": id }),
        )
        .await
    }

    /// `awaitSemanticDecision`: reads the decision every 80 ms until the worker completes it
    /// or its deadline passes; then fences late results with a compare-and-set to
    /// `timeout` / `allowed_fallback` and returns what is stored.
    pub async fn await_semantic_decision(
        &self,
        id: &str,
        deadline_ms: i64,
    ) -> Result<Option<Document>, StoreError> {
        while self.clock.now_ms() < deadline_ms {
            let current = self.find_decision(id).await?;
            if current
                .as_ref()
                .is_some_and(|d| d.get_str("state").is_ok_and(|state| state == "completed"))
            {
                return Ok(current);
            }
            tokio::time::sleep(SEMANTIC_POLL_INTERVAL).await;
        }
        let mut ctx = WriteContext::new(self.clock.now_ms());
        let prepared = moderation_decisions::INFO
            .prepare_update(
                &doc! { "_id": id, "state": { "$in": ["pending", "processing"] } },
                doc! { "$set": {
                    "state": "completed", "verdict": "uncertain", "status": "timeout",
                    "consequence.status": "allowed_fallback",
                } },
                UpdateOptions::default(),
                &mut ctx,
            )
            .map_err(|error| mongo_error("moderation_decisions.updateOne", error))?;
        let mut writes = self.mongo.writes(moderation_decisions::COLLECTION);
        self.mongo_call(
            "moderation_decisions.updateOne",
            writes.update_one(&prepared),
        )
        .await?;
        self.find_decision(id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_ids_hash_the_json_array() {
        assert_eq!(
            moderation_decision_id("c", "m", "r"),
            hex::encode(Sha256::digest(br#"["c","m","r"]"#))
        );
    }

    #[test]
    fn semantic_rules_get_a_threshold() {
        let rule = doc! { "id": "r", "semantic": { "enabled": true, "policy": "p" } };
        let stored = decision_rule(&rule, true).unwrap();
        assert_eq!(
            stored
                .get_document("semantic")
                .unwrap()
                .get("thresholdPercent"),
            Some(&Bson::Int32(85))
        );
        assert_eq!(decision_rule(&rule, false).unwrap(), rule);
    }
}
