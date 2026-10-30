//! Decision identifiers and durable semantic-decision waiting.
//!
use crate::utils::{
    bson_json::{compiler_bson_json, json_bson},
    js_string::JsString,
    lossless_json::JsonValue,
    moderation::{
        advanced_policy::{DECISION_POLICY_VERSION, MODERATION_RETENTION_DAYS, SEMANTIC_MODEL},
        variations::{CompiledVariationValue, compile_rule_variation_entries_value},
    },
};
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
    options::ReturnDocument,
};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// SHA-256 of JavaScript JSON.stringify([channelID, messageID, ruleID]).
/// JsString preserves lone UTF-16 surrogates until JSON escaping has happened.
pub fn moderation_decision_id(channel: &JsString, message: &JsString, rule: &JsString) -> String {
    let serialized = format!(
        "[{},{},{}]",
        channel.to_json_string(),
        message.to_json_string(),
        rule.to_json_string()
    );
    format!("{:x}", Sha256::digest(serialized.as_bytes()))
}

pub trait DecisionClock: Send + Sync {
    fn now_ms(&self) -> i64;
}
pub struct SystemDecisionClock;
impl DecisionClock for SystemDecisionClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis().min(i64::MAX as u128) as i64,
            Err(e) => -(e.duration().as_millis().min(i64::MAX as u128) as i64),
        }
    }
}

#[derive(Debug)]
pub enum DecisionError {
    Input(String),
    Mongo(mongodb::error::Error),
}
impl fmt::Display for DecisionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(e) => f.write_str(e),
            Self::Mongo(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for DecisionError {}
impl From<mongodb::error::Error> for DecisionError {
    fn from(error: mongodb::error::Error) -> Self {
        Self::Mongo(error)
    }
}
fn input_error(message: impl fmt::Display) -> DecisionError {
    DecisionError::Input(message.to_string())
}
fn id_field(input: &Document, name: &str) -> Result<JsString, DecisionError> {
    input.get_str(name).map(JsString::from).map_err(input_error)
}
fn json_id<'a>(input: &'a JsonValue, name: &str) -> Result<&'a JsString, DecisionError> {
    match input.get(name) {
        Some(JsonValue::String(s)) => Ok(s),
        _ => Err(input_error(format!("{name} must be a string"))),
    }
}

// Identity from the variation compiler is significant: Shared means the
// source created a replacement object, even if its JSON values compare equal.
// Unknown BSON values and NaN must not be compared to decide whether it changed.
fn compiled_entries(
    view: &JsonValue,
) -> Result<Option<Vec<CompiledVariationValue<'_>>>, DecisionError> {
    compile_rule_variation_entries_value(view).map_err(input_error)
}

// Preserve the authoritative Mixed BSON and patch only fields created by the
// variation compiler. Undefined here is an own JavaScript property sentinel;
// the storage boundary below writes the Node driver's default BSON null.
fn patch_rule(raw: &mut Document, view: &JsonValue) -> Result<(), DecisionError> {
    let Some(entries) = compiled_entries(view)? else {
        return Ok(());
    };
    let target = raw
        .get_document_mut("variations")
        .map_err(input_error)?
        .get_array_mut("entries")
        .map_err(input_error)?;
    if target.len() != entries.len() {
        return Err(input_error("variation entry count changed"));
    }
    for (raw_entry, compiled) in target.iter_mut().zip(entries) {
        let CompiledVariationValue::Shared(new) = compiled else {
            continue;
        };
        let doc = raw_entry
            .as_document_mut()
            .ok_or_else(|| input_error("invalid variation entry"))?;
        let spaces = new
            .get("allowSpaces")
            .ok_or_else(|| input_error("missing compiled allowSpaces"))?;
        doc.insert("allowSpaces", json_bson(spaces));
        doc.insert(
            "symbolVersion",
            new.get("symbolVersion")
                .map(json_bson)
                .unwrap_or(Bson::Undefined),
        );
        let source = new
            .get("pattern")
            .and_then(|p| p.get("source"))
            .ok_or_else(|| input_error("missing compiled pattern source"))?;
        doc.get_document_mut("pattern")
            .map_err(input_error)?
            .insert("source", json_bson(source));
    }
    Ok(())
}

/// Cast the source update using the schema and apply the Node MongoDB driver's
/// default `ignoreUndefined=false` policy only to compiler-created undefined
/// properties. Unknown authoritative BSON, including existing BSON Undefined,
/// stays untouched. URI overrides are not inferred from the native Mongo client.
pub fn prepare_creation_for_storage(
    filter: &Document,
    insert: &Document,
    created: DateTime,
    original_rule: &JsonValue,
) -> Result<Document, DecisionError> {
    let mut update = crate::schemas::moderation_decision::schema()
        .cast_flat_set_on_insert(filter, insert, created)
        .map_err(input_error)?;
    let Some(entries) = compiled_entries(original_rule)? else {
        return Ok(update);
    };
    let target = update
        .get_document_mut("rule")
        .map_err(input_error)?
        .get_document_mut("variations")
        .map_err(input_error)?
        .get_array_mut("entries")
        .map_err(input_error)?;
    if target.len() != entries.len() {
        return Err(input_error("variation entry count changed"));
    }
    for (raw_entry, compiled) in target.iter_mut().zip(entries) {
        if let CompiledVariationValue::Shared(new) = compiled
            && new.get("symbolVersion").is_none()
        {
            raw_entry
                .as_document_mut()
                .ok_or_else(|| input_error("invalid variation entry"))?
                .insert("symbolVersion", Bson::Null);
        }
    }
    Ok(update)
}
fn semantic_default(rule: &mut Document) {
    // Object-spread of a nullish semantic property creates an empty object.
    let value = rule.get("semantic").cloned();
    let mut semantic = match value {
        Some(Bson::Document(doc)) => doc,
        Some(Bson::Array(items)) => items
            .into_iter()
            .enumerate()
            .map(|(i, value)| (i.to_string(), value))
            .collect(),
        Some(Bson::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                (
                    i.to_string(),
                    Bson::String(JsString::from_units(vec![unit]).to_utf8_lossy()),
                )
            })
            .collect(),
        _ => Document::new(),
    };
    if semantic
        .get("thresholdPercent")
        .is_none_or(|v| matches!(v, Bson::Null | Bson::Undefined))
    {
        semantic.insert("thresholdPercent", 85);
    }
    rule.insert("semantic", semantic);
}

/// The source operation immediately before Mongoose casts the update. Exposed
/// for source-oracle comparison; durable creation always continues through the
/// schema repository and atomic Mongo findOneAndUpdate.
pub fn prepare_creation(
    mut input: Document,
    channel: JsString,
    message: JsString,
    rule_id: JsString,
    raw_rule: Bson,
    view: JsonValue,
    clock: &dyn DecisionClock,
) -> Result<(Document, Document, DateTime), DecisionError> {
    let id = moderation_decision_id(&channel, &message, &rule_id);
    if matches!(raw_rule, Bson::Null | Bson::Undefined) {
        return Err(input_error("rule is null or undefined"));
    }
    let mut rule = raw_rule
        .as_document()
        .cloned()
        .ok_or_else(|| input_error("rule must be an object"))?;
    patch_rule(&mut rule, &view)?;
    let semantic = input.get_str("mode").ok() == Some("semantic");
    if semantic {
        semantic_default(&mut rule);
    }
    input.insert("_id", &id);
    input.insert("rule", rule);
    input.insert("state", if semantic { "pending" } else { "completed" });
    input.insert("verdict", if semantic { "uncertain" } else { "violation" });
    input.insert("status", if semantic { "pending" } else { "matched" });
    input.insert("model", if semantic { SEMANTIC_MODEL } else { "" });
    input.insert("decisionPolicyVersion", DECISION_POLICY_VERSION);
    let created = clock.now_ms();
    input.insert("createdAt", DateTime::from_millis(created));
    let expires = clock
        .now_ms()
        .saturating_add(i64::from(MODERATION_RETENTION_DAYS) * 86_400_000);
    input.insert("expiresAt", DateTime::from_millis(expires));
    Ok((doc! {"_id":id}, input, DateTime::from_millis(created)))
}

/// Thin Mongo owner. Collection selection and index metadata are shared with
/// the native schema rather than inventing a separate persistence boundary.
pub struct ModerationDecisions {
    database: Database,
    clock: Arc<dyn DecisionClock>,
}
impl ModerationDecisions {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            clock: Arc::new(SystemDecisionClock),
        }
    }
    pub fn with_clock(mut self, clock: Arc<dyn DecisionClock>) -> Self {
        self.clock = clock;
        self
    }

    /// Persist using the original BSON rule as authority. A duplicate ID returns
    /// the existing durable document, including unknown fields. No application
    /// retry is performed after an uncertain write.
    pub async fn create(&self, input: Document) -> Result<Option<Document>, DecisionError> {
        let channel = id_field(&input, "channelID")?;
        let message = id_field(&input, "messageID")?;
        let rule_id = id_field(&input, "ruleID")?;
        let raw_rule = input
            .get("rule")
            .cloned()
            .ok_or_else(|| input_error("missing rule"))?;
        let view = compiler_bson_json(&raw_rule);
        self.create_inner(input, channel, message, rule_id, raw_rule, view)
            .await
    }
    /// Preserve UTF-16 identifier and rule strings through source compilation.
    /// BSON storage applies its normal UTF-8 boundary only after hashing.
    /// The deadline is supplied as a BSON Date rather than a JSON string.
    pub async fn create_lossless(
        &self,
        input: &JsonValue,
        deadline: DateTime,
    ) -> Result<Option<Document>, DecisionError> {
        let channel = json_id(input, "channelID")?.clone();
        let message = json_id(input, "messageID")?.clone();
        let rule_id = json_id(input, "ruleID")?.clone();
        let rule = input
            .get("rule")
            .cloned()
            .ok_or_else(|| input_error("missing rule"))?;
        let mut bson = json_bson(input)
            .as_document()
            .cloned()
            .ok_or_else(|| input_error("input must be an object"))?;
        bson.insert("deadline", deadline);
        let raw_rule = json_bson(&rule);
        self.create_inner(bson, channel, message, rule_id, raw_rule, rule)
            .await
    }
    async fn create_inner(
        &self,
        input: Document,
        channel: JsString,
        message: JsString,
        rule_id: JsString,
        raw_rule: Bson,
        view: JsonValue,
    ) -> Result<Option<Document>, DecisionError> {
        let (filter, insert, created) = prepare_creation(
            input,
            channel,
            message,
            rule_id,
            raw_rule,
            view.clone(),
            self.clock.as_ref(),
        )?;
        let schema = crate::schemas::moderation_decision::schema();
        let update = prepare_creation_for_storage(&filter, &insert, created, &view)?;
        Ok(schema
            .repository(&self.database)
            .collection
            .find_one_and_update(filter, doc! {"$setOnInsert":update})
            .upsert(true)
            .return_document(ReturnDocument::After)
            .await?)
    }

    /// Polls the durable row; a completed result is returned immediately.
    /// A missing row stays pending until deadline, just as the source does.
    /// At the deadline the pending/processing compare-and-set prevents a late
    /// worker from replacing the timeout, provided it also uses its state fence.
    /// Cancellation drops the future; it does not schedule a background write.
    pub async fn await_semantic_decision(
        &self,
        id: Bson,
        deadline: DateTime,
    ) -> mongodb::error::Result<Option<Document>> {
        let collection =
            crate::schemas::moderation_decision::get_moderation_decision_model(&self.database)
                .collection;
        let deadline_ms = deadline.timestamp_millis();
        while self.clock.now_ms() < deadline_ms {
            let current = collection.find_one(doc! {"_id": id.clone()}).await?;
            if current.as_ref().and_then(|d| d.get_str("state").ok()) == Some("completed") {
                return Ok(current);
            }
            let remaining = deadline_ms.saturating_sub(self.clock.now_ms());
            if remaining > 0 {
                tokio::time::sleep(Duration::from_millis((remaining as u64).min(80))).await;
            }
        }
        collection.update_one(
            doc! {"_id": id.clone(), "state": {"$in": ["pending", "processing"]}},
            doc! {"$set": {"state": "completed", "verdict": "uncertain", "status": "timeout", "consequence.status": "allowed_fallback"}},
        ).await?;
        collection.find_one(doc! {"_id": id}).await
    }
}
