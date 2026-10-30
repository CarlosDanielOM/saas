//! Request-scoped semantic decision and maintenance passes. Construction has no I/O.
//! Mongo BSON remains authoritative; JSON projections are used only for policy
//! and provider inputs, never written back to the stored Mixed fields.
use crate::utils::{
    ai_credit_projection::{AiCreditProjection, PlanTier},
    ai_credit_reader::{AiCreditReader, CreditOwner},
    bson_compat::js_number,
    bson_js_json::bson_js_json,
    bson_json::{compiler_bson_json, json_bson},
    js_string::JsString,
    lossless_json::JsonValue,
    moderation::{
        advanced_policy::{SEMANTIC_MODEL, paid_moderation_owned},
        semantic::{
            SemanticClock, SemanticProvider, TypedSemanticResult, fallback_result,
            moderation_model_for_account, semantic_price,
        },
        spam::{is_spam_decision_value, semantic_policy_active_value},
        spam_categories::SPAM_CLASSIFIER_MODEL,
    },
    polar_cache_usage::{CacheUsageOptions, LlmMetadata, LlmUsage, PolarCacheUsage},
};
use futures_util::TryStreamExt;
use mongodb::{
    Database,
    bson::{Bson, DateTime, Document, doc},
    options::ReturnDocument,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Caller must supply the same application database and shared Redis-backed
/// concrete services used by the rest of the application.
#[derive(Clone)]
pub struct SemanticWorker {
    db: Database,
    projection: AiCreditProjection,
    reader: AiCreditReader,
    provider: SemanticProvider,
    usage: PolarCacheUsage,
}

pub struct SystemSemanticClock;
impl SemanticClock for SystemSemanticClock {
    fn now_ms(&self) -> f64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(v) => v.as_millis() as f64,
            Err(e) => -(e.duration().as_millis() as f64),
        }
    }
}
fn date(clock: &impl SemanticClock) -> DateTime {
    DateTime::from_millis(clock.now_ms() as i64)
}
fn text(d: &Document, key: &str) -> String {
    d.get_str(key).unwrap_or("").to_owned()
}
fn number(d: &Document, key: &str) -> f64 {
    match d.get(key) {
        Some(Bson::Double(v)) => *v,
        Some(Bson::Int32(v)) => f64::from(*v),
        Some(Bson::Int64(v)) => *v as f64,
        _ => 0.0,
    }
}
fn projected(d: &Document, keys: &[&str]) -> JsonValue {
    let fields = keys
        .iter()
        .filter_map(|k| {
            d.get(*k)
                .map(|v| (JsString::from(*k), compiler_bson_json(v)))
        })
        .collect();
    JsonValue::Object(fields)
}
fn json_string(v: Option<&JsonValue>, expected: &str) -> bool {
    matches!(v, Some(JsonValue::String(s)) if s.as_str() == Some(expected))
}
fn result_fields(r: &TypedSemanticResult) -> Document {
    let mut d = match json_bson(&r.to_json_value()) {
        Bson::Document(d) => d,
        _ => unreachable!(),
    };
    // Mongo can contain a literal BSON null for absent scores; no unrelated
    // fields are ever reconstructed from this projection.
    d.insert("latencyMs", 0.0);
    d
}
fn tier(v: Option<&JsonValue>) -> Option<PlanTier> {
    match v {
        Some(JsonValue::String(v)) => match v.as_str() {
            Some("premium") => Some(PlanTier::Premium),
            Some("pro") => Some(PlanTier::Pro),
            Some("free") => Some(PlanTier::Free),
            _ => None,
        },
        Some(JsonValue::Null) => Some(PlanTier::Null),
        _ => None,
    }
}
impl SemanticWorker {
    pub fn new(
        db: Database,
        projection: AiCreditProjection,
        reader: AiCreditReader,
        provider: SemanticProvider,
        usage: PolarCacheUsage,
    ) -> Self {
        // AbortSignal.timeout(750) belongs only to the provider inside the
        // reader, not to the full Redis/Mongo credit read.
        let reader = reader
            .with_provider_timeout(Duration::from_millis(750))
            .expect("nonzero timeout");
        Self {
            db,
            projection,
            reader,
            provider,
            usage,
        }
    }
    pub async fn process_next(&self) -> Result<bool, String> {
        self.process_next_with_clock(&SystemSemanticClock).await
    }
    pub async fn process_next_with_clock(
        &self,
        clock: &impl SemanticClock,
    ) -> Result<bool, String> {
        let decisions = self.db.collection::<Document>("moderation_decisions");
        let decision = decisions
            .find_one_and_update(
                doc! {"state":"pending", "deadline":{"$gt":date(clock)}},
                doc! {"$set":{"state":"processing"}},
            )
            .sort(doc! {"createdAt":1})
            .return_document(ReturnDocument::After)
            .await
            .map_err(|e| e.to_string())?;
        let Some(decision) = decision else {
            return Ok(false);
        };
        let started = clock.now_ms();
        let id = decision.get("_id").cloned().unwrap_or(Bson::Null);
        if self
            .process_claim(&decision, &id, started, clock)
            .await
            .is_err()
        {
            decisions.update_one(doc! {"_id":id, "state":"processing"}, doc! {"$set":{"state":"completed", "verdict":"uncertain", "status":"unavailable", "latencyMs":js_number(clock.now_ms()-started)}}).await.map_err(|e| e.to_string())?;
        }
        Ok(true)
    }
    async fn process_claim(
        &self,
        d: &Document,
        id: &Bson,
        started: f64,
        clock: &impl SemanticClock,
    ) -> Result<(), String> {
        let decisions = self.db.collection::<Document>("moderation_decisions");
        let raw = projected(d, &["ruleID", "reviewSource", "settingsVersion"]);
        let spam = is_spam_decision_value(&raw).map_err(str::to_owned)?;
        let channel = text(d, "channelID");
        let owner = self
            .db
            .collection::<Document>("users")
            .find_one(doc! {"accounts":{"$elemMatch":{"type":"twitch", "id":&channel}}})
            .projection(doc! {"plan_tier":1,"polar_sh_customer_id":1})
            .await
            .map_err(|e| e.to_string())?;
        let settings = self
            .db
            .collection::<Document>("channel_moderation_settings")
            .find_one(doc! {"channelID":&channel})
            .await
            .map_err(|e| e.to_string())?;
        let settings_view = settings.as_ref().map(|v| {
            projected(
                v,
                &["settingsVersion", "spamProtection", "enabled", "rules"],
            )
        });
        let owner_view = owner
            .as_ref()
            .map(|v| projected(v, &["plan_tier", "polar_sh_customer_id"]));
        let plan = owner_view.as_ref().and_then(|v| v.get("plan_tier"));
        let mut result = fallback_result(&"policy_changed".into(), None);
        let mut customer = String::new();
        let mut model = SEMANTIC_MODEL;
        let mut credits = false;
        let mut credit_status = "credits_unavailable";
        if semantic_policy_active_value(settings_view.as_ref(), &raw).map_err(str::to_owned)? {
            if !spam && !paid_moderation_owned(plan) {
                result = fallback_result(&"plan_required".into(), None);
            } else {
                let customer_id = owner
                    .as_ref()
                    .map(|v| text(v, "polar_sh_customer_id"))
                    .unwrap_or_default();
                if owner.is_some() && paid_moderation_owned(plan) && !customer_id.is_empty() {
                    match self
                        .projection
                        .is_ai_credits_exhausted(&channel.as_str().into())
                        .await
                    {
                        Ok(true) => credit_status = "quota_exhausted",
                        Ok(false) => {
                            let owner = CreditOwner {
                                tier: tier(plan),
                                customer_id: Some(customer_id.clone()),
                            };
                            if let Ok(value) =
                                self.reader.get_ai_credits(&owner, &channel, true).await
                            {
                                credits = matches!(
                                    value.get("available"),
                                    Some(JsonValue::Bool(true))
                                ) && json_string(value.get("status"), "available")
                                    && matches!(value.get("balance"), Some(JsonValue::Number(n)) if *n > 0.0);
                                if json_string(value.get("status"), "exhausted") {
                                    credit_status = "quota_exhausted";
                                }
                            }
                        }
                        Err(_) => {}
                    }
                }
                model = if spam {
                    moderation_model_for_account(plan, credits)
                } else {
                    SEMANTIC_MODEL
                };
                if credits {
                    customer = customer_id;
                }
                result = if !spam && !credits {
                    fallback_result(&credit_status.into(), None)
                } else {
                    // Do not project unrelated Mongo Mixed fields. The source
                    // accesses these only after policy and credit checks.
                    let mut semantic = Document::new();
                    for key in ["messageText", "username", "context", "matches", "channelID"] {
                        if let Some(value) = d.get(key) {
                            semantic.insert(key, value.clone());
                        }
                    }
                    if let Some(rule) = d.get("rule") {
                        let rule = if let Bson::Document(rule) = rule {
                            let mut selected = Document::new();
                            if let Some(id) = rule.get("id") {
                                selected.insert("id", id.clone());
                            }
                            if let Some(policy) = rule.get("semantic") {
                                let policy = if let Bson::Document(policy) = policy {
                                    let mut fields = Document::new();
                                    for key in [
                                        "categories",
                                        "broadcasterInvitation",
                                        "examples",
                                        "policy",
                                        "thresholdPercent",
                                    ] {
                                        if let Some(value) = policy.get(key) {
                                            fields.insert(key, value.clone());
                                        }
                                    }
                                    Bson::Document(fields)
                                } else {
                                    policy.clone()
                                };
                                selected.insert("semantic", policy);
                            }
                            Bson::Document(selected)
                        } else {
                            rule.clone()
                        };
                        semantic.insert("rule", rule);
                    }
                    let mut input =
                        bson_js_json(&Bson::Document(semantic)).map_err(|e| e.to_string())?;
                    if let JsonValue::Object(ref mut fields) = input
                        && let Some(Bson::DateTime(deadline)) = d.get("deadline")
                    {
                        fields.push((
                            "deadline".into(),
                            JsonValue::Number(deadline.timestamp_millis() as f64),
                        ));
                    }
                    self.provider
                        .evaluate_value_with_clock(&input, Some(&model.into()), clock)
                        .await
                        .map_err(|e| e.to_string())?
                };
            }
        }
        let billable = credits
            && (model == SPAM_CLASSIFIER_MODEL || !spam)
            && matches!(result.status.as_str(), Some("completed" | "uncertain"));
        let price = semantic_price(if billable { result.input_tokens } else { 0.0 });
        let fence_time = date(clock);
        let mut fields = result_fields(&result);
        fields.insert("state", "completed");
        fields.insert("latencyMs", js_number(clock.now_ms() - started));
        let external = match id {
            Bson::String(v) => v.clone(),
            _ => id.to_string(),
        };
        fields.insert("charge", doc! {"billableCostUSD":js_number(price.billable_cost_usd),"credits":js_number(price.credits),"pricingVersion":price.pricing_version,"usdPerMillionInputTokens":js_number(price.usd_per_million_input_tokens),"status":if price.credits > 0.0 {"pending"} else {"none"},"externalID":format!("moderation:{external}"),"customerID":customer});
        let updated = decisions
            .update_one(
                doc! {"_id":id.clone(),"state":"processing","deadline":{"$gt":fence_time}},
                doc! {"$set":fields},
            )
            .await
            .map_err(|e| e.to_string())?;
        if updated.modified_count == 0 {
            let mut audit = result_fields(&result);
            audit.remove("verdict");
            audit.remove("status");
            audit.insert("latencyMs", js_number(clock.now_ms() - started));
            decisions
                .update_one(doc! {"_id":id.clone()}, doc! {"$set":audit})
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub async fn maintain(&self) -> Result<(), String> {
        self.maintain_with_clock(&SystemSemanticClock).await
    }
    pub async fn maintain_with_clock(&self, clock: &impl SemanticClock) -> Result<(), String> {
        let decisions = self.db.collection::<Document>("moderation_decisions");
        decisions.update_many(doc! {"state":{"$in":["pending","processing"]},"deadline":{"$lte":date(clock)}}, doc! {"$set":{"state":"completed","verdict":"uncertain","status":"timeout","consequence.status":"allowed_fallback"}}).await.map_err(|e| e.to_string())?;
        let cursor = decisions.find(doc! {"charge.status":"pending","consequence.status":{"$in":["allowed","allowed_fallback","scheduled","executed"]}}).sort(doc! {"createdAt":1}).limit(10).await.map_err(|e| e.to_string())?;
        // Mongoose lean() resolves the entire query before the first ingest.
        let billable: Vec<Document> = cursor.try_collect().await.map_err(|e| e.to_string())?;
        for d in billable {
            let charge = d.get_document("charge").map_err(|e| e.to_string())?;
            let id = d.get("_id").cloned().unwrap_or(Bson::Null);
            let request = compiler_bson_json(&id);
            let usage = JsonValue::Object(vec![
                ("requestId".into(), request),
                (
                    "operation".into(),
                    JsonValue::String("contextual_moderation".into()),
                ),
                ("category".into(), JsonValue::String("other".into())),
                ("source".into(), JsonValue::String("moderation".into())),
                ("provider".into(), JsonValue::String("openrouter".into())),
                (
                    "resourceType".into(),
                    JsonValue::String("llm_generation".into()),
                ),
                (
                    "resourceId".into(),
                    compiler_bson_json(d.get("messageID").unwrap_or(&Bson::Null)),
                ),
            ]);
            let tokens = number(&d, "inputTokens");
            let options = CacheUsageOptions {
                customer_id: text(charge, "customerID").into(),
                channel_id: text(&d, "channelID").into(),
                external_id: Some(text(charge, "externalID").into()),
                cost: number(charge, "billableCostUSD"),
                reason: "contextual_moderation".into(),
                llm: Some(LlmMetadata {
                    model: text(&d, "model").into(),
                    usage: LlmUsage {
                        prompt_tokens: tokens,
                        completion_tokens: 0.0,
                        total_tokens: tokens,
                    },
                }),
                polar_cost: None,
                characters: None,
                usage,
            };
            if !self.usage.ingest(&options).await.error {
                decisions
                    .update_one(doc! {"_id":id}, doc! {"$set":{"charge.status":"recorded"}})
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}
